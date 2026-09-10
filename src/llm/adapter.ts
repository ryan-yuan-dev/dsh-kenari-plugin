/**
 * Kenari 原生 LlmAdapter（第 5 期，**可选**，默认关闭）。
 *
 * 为什么有它：`llm-pi-ai` 预设（第 3 期）已经能把 Kenari 当会话模型用，但它按通用
 * OpenAI 兼容语义处理线上字段，丢掉了几样 Kenari 特有的东西：
 *
 * 1. **真实价格进模型选择器**：目录里的 `pricing` 换算成 IDR/1M 写进 `description`
 * 2. **token 与费用进账本**：pi-ai 的 usage 到不了本插件，`kenari_billing` 的
 *    `cached_tokens` 命中率因此一直没有数据；本适配器逐次把 usage 记进同一本账
 * 3. **推理档位按目录原样暴露**：`reasoning_options` 的值就是线上 `reasoning_effort`
 *    的写法（含 `none`），不再需要 off/none 的键位翻译
 * 4. **reasoning 通道**：`reasoning_content` → `reasoning-delta`，与可见文本分开
 *
 * 不做的事：不回放思考块、不注入 `file-parser`（文件块投影成说明文本，读文档请用
 * `kenari_ocr` 工具）。这些在 README 里写明。
 *
 * 与预设路由**不同名**（默认 `kenari-direct`），所以两者可以并存、可以回退。
 * @module dsh-kenari-plugin/llm/adapter
 */

import { LlmAdapter, LlmError, attributionHeaders, isContextWindowExceededError } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  Message,
  StreamChunk,
  TokenUsage,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { KenariHttpDeps } from '../http.js'
import type { KenariCatalog, KenariModel } from '../catalog.js'
import { inputModalitiesOf, isFreeModel, microToIdrPerMillion, toResolvedModelInfo } from '../catalog.js'
import type { BillingLedger } from '../billing.js'
import { GLOBAL_SCOPE } from '../billing.js'
import { extractKenariErrorMessage } from '../errors.js'

/** 适配器依赖：传输层（含实时配置与 key 解析）、目录、账本。 */
export interface KenariAdapterDeps {
  readonly http: KenariHttpDeps
  readonly catalog: KenariCatalog
  readonly billing: BillingLedger
  readonly logger?: { warn(msg: string): void; info(msg: string): void }
}

/** 会话模型的价格摘要（进选择器 description；不确定的量不写）。 */
function describePricing(model: KenariModel): string {
  const bits: string[] = []
  if (isFreeModel(model)) {
    bits.push('免费')
  } else {
    const input = model.pricing?.input
    const output = model.pricing?.output
    if (typeof input === 'number' && typeof output === 'number') {
      bits.push(`入 ${microToIdrPerMillion(input)} / 出 ${microToIdrPerMillion(output)} IDR per 1M tokens`)
    } else if (model.pricing?.varies === true) {
      bits.push('价格浮动')
    }
  }
  if (typeof model.context_length === 'number') bits.push(`ctx ${model.context_length}`)
  if (inputModalitiesOf(model).includes('image')) bits.push('视觉')
  if ((model.reasoning_options ?? []).length > 0) bits.push(`推理 ${(model.reasoning_options ?? []).join('/')}`)
  return bits.join(' · ')
}

/** HTTP 状态 → dsh 的 provider-neutral 失败码（路由靠 code，不靠 message）。 */
function failureCodeFor(status: number, detail: string): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 402) return 'QUOTA'
  if (status === 429) return 'RATE_LIMIT'
  if (isContextWindowExceededError(detail)) return 'CONTEXT_WINDOW_EXCEEDED'
  return status >= 500 ? 'TRANSPORT' : 'INVALID_REQUEST'
}

/** 一个待发送的 [OI] 消息。 */
interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | unknown[] | null
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

/** 嵌套块 → 纯文本（工具结果、文件引用等只能以文本回传的情形）。 */
function textOfBlocks(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'reasoning') continue
    else if (block.type === 'tool-result') parts.push(textOfBlocks(block.content))
    else if (block.type === 'image') parts.push(`[图像 ${block.attachment.width}×${block.attachment.height}]`)
    else if (block.type === 'file') parts.push(`[文件 ${block.attachment.name}]`)
  }
  return parts.filter((part) => part.length > 0).join('\n')
}

/** 图像引用 → data URI；没有 attachment 存储时返回 undefined（调用方降级为文本）。 */
async function imageDataUri(imageRef: ImageAttachmentRef, read: ReadImage | undefined): Promise<string | undefined> {
  if (read === undefined) return undefined
  try {
    const stored = await read(imageRef)
    return `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}`
  } catch {
    return undefined
  }
}

/** attachment 读取的最小形状（只用到 readImage）。 */
type ReadImage = (ref: ImageAttachmentRef) => Promise<{ ref: ImageAttachmentRef; data: Uint8Array }>

/** 一条 dsh 消息 → 一条或多条 [OI] 消息。 */
async function toWireMessages(message: Message, read: ReadImage | undefined): Promise<WireMessage[]> {
  // 工具结果：dsh 把它挂在一条 user 角色的消息上，线上要用 role=tool + tool_call_id
  if (message.source.kind === 'tool') {
    return [{ role: 'tool', tool_call_id: String(message.source.callId), content: textOfBlocks(message.content) }]
  }

  if (message.role === 'assistant') {
    const text = textOfBlocks(message.content)
    const calls = message.content
      .filter((block): block is Extract<ContentBlock, { type: 'tool-call' }> => block.type === 'tool-call')
      .map((block) => ({ id: String(block.id), type: 'function' as const, function: { name: block.name, arguments: block.arguments } }))
    return [{
      role: 'assistant',
      // content 为 null 表示「只有工具调用」，[OI] 接受这种组合
      content: text.length > 0 ? text : null,
      ...(calls.length > 0 ? { tool_calls: calls } : {}),
    }]
  }

  // user / plugin / system：文本 + 图像走 parts，纯文本走字符串（线上两种都收）
  const parts: unknown[] = []
  const texts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') {
      texts.push(block.text)
      parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'reasoning') {
      // 思考块不属于对话内容，不回放
    } else if (block.type === 'image') {
      const uri = await imageDataUri(block.attachment, read)
      if (uri === undefined) {
        texts.push('[图像：本部署没有可读的 attachment 存储，无法回传]')
        parts.push({ type: 'text', text: '[图像：本部署没有可读的 attachment 存储，无法回传]' })
      } else {
        parts.push({ type: 'image_url', image_url: { url: uri } })
      }
    } else if (block.type === 'file') {
      const note = `[文件 ${block.attachment.name}：本适配器不回传文件字节，读文档请用 kenari_ocr 工具]`
      texts.push(note)
      parts.push({ type: 'text', text: note })
    } else if (block.type === 'tool-result') {
      const nested = textOfBlocks(block.content)
      texts.push(nested)
      parts.push({ type: 'text', text: nested })
    }
  }
  const hasImage = parts.some((part) => (part as { type?: string }).type === 'image_url')
  return [{
    role: message.role === 'system' ? 'system' : 'user',
    content: hasImage ? parts : texts.join('\n'),
  }]
}

/** dsh ToolSchema → [OI] tools 条目。 */
function toWireTool(tool: ToolSchema): unknown {
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }
}

/** [OI] usage → dsh TokenUsage（dsh 要求各项**互斥**：inputTokens 是不含缓存的那部分）。 */
export function mapUsage(usage: {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
}): TokenUsage {
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0
  const prompt = usage.prompt_tokens ?? 0
  const mapped: TokenUsage = {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: usage.completion_tokens ?? 0,
  }
  if (cached > 0) mapped.cacheReadTokens = cached
  if (typeof usage.total_tokens === 'number') mapped.totalTokens = usage.total_tokens
  return mapped
}

/** 逐行切 SSE：`data: <payload>`，空行与注释行跳过。 */
async function* ssePayloads(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line.startsWith('data:')) yield line.slice(5).trim()
      newline = buffer.indexOf('\n')
    }
  }
  const tail = buffer.trim()
  if (tail.startsWith('data:')) yield tail.slice(5).trim()
}

/** [OI] 流式响应体（只声明用到的字段，rc 期字段变动不炸）。 */
interface StreamPayload {
  choices?: { delta?: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
}

/** Kenari [OI] 线的原生适配器。 */
export class KenariLlmAdapter extends LlmAdapter {
  constructor(
    private readonly deps: KenariAdapterDeps,
    /** 目录里读图像字节的入口（`ctx.attachments.readImage`）；缺失则图像降级为文本。 */
    private readonly readImage?: ReadImage,
  ) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Kenari（原生适配器）' }
  }

  /** 目录即模型列表：价格与上下文随目录刷新，不再静态写死在配置里。 */
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await this.deps.catalog.chatModels()
    return models.map((model) => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      description: describePricing(model),
      inputModalities: inputModalitiesOf(model),
    }))
  }

  /** 逐模型元数据：上下文窗口、推理档位、输出上限都来自目录。 */
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const resolved = await this.deps.catalog.resolve(model)
    // 目录解析失败不拒绝请求（目录是建议性的），只给出最小元数据
    if (resolved === undefined) return { provider, id: model, name: model, inputModalities: ['text'] }
    return toResolvedModelInfo(resolved.model, provider) as LlmResolvedModelInfo
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.run(options)
  }

  private async *run(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const { deps } = this
    const config = deps.http.config
    const apiKey = await deps.http.resolveApiKey()
    if (apiKey === undefined || apiKey.length === 0) {
      throw new LlmError(
        `Kenari 凭据 ${config.apiKeyEnv ?? 'KENARI_API_KEY'} 未配置，无法发起模型请求`,
        'MISSING_CREDENTIAL',
      )
    }

    const wireMessages: WireMessage[] = []
    if (options.system !== undefined && options.system.length > 0) {
      wireMessages.push({ role: 'system', content: options.system })
    }
    for (const message of options.messages) {
      wireMessages.push(...await toWireMessages(message, this.readImage))
    }

    const base = (config.baseURL ?? 'https://kenari.id').replace(/\/+$/, '')
    const endpoint = `${base.endsWith('/v1') ? base : `${base}/v1`}/chat/completions`
    const body: Record<string, unknown> = {
      model: options.model,
      messages: wireMessages,
      stream: true,
      // 最后一帧带 usage：cached_tokens 计量的唯一来源
      stream_options: { include_usage: true },
    }
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
    if (options.temperature !== undefined) body.temperature = options.temperature
    if (options.stop !== undefined && options.stop.length > 0) body.stop = options.stop
    if (options.reasoningEffort !== undefined) body.reasoning_effort = String(options.reasoningEffort)
    if (options.tools !== undefined && options.tools.length > 0) body.tools = options.tools.map(toWireTool)

    const response = await fetch(endpoint, {
      method: 'POST',
      // 契约：每个 provider 请求都必须带 attribution 头
      headers: {
        ...attributionHeaders(),
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })

    if (!response.ok) {
      const raw = await response.text().catch(() => '')
      const detail = extractKenariErrorMessage(raw, response.status)
      deps.logger?.warn(`kenari: ${endpoint} → HTTP ${response.status}`)
      throw new LlmError(`kenari: ${detail}`, failureCodeFor(response.status, detail), { status: response.status })
    }
    if (response.body === null) throw new LlmError('kenari: 响应没有 body', 'TRANSPORT')

    let textIndex: number | undefined
    let reasoningIndex: number | undefined
    let nextIndex = 0
    let textBuffer = ''
    let reasoningBuffer = ''
    const toolStates = new Map<number, { index: number; id: string; name: string; args: string }>()
    let usage: TokenUsage | undefined
    let finishKind: FinishReason = { kind: 'stop' }
    let emitted = 0

    const closeText = function* (): Generator<StreamChunk> {
      if (textIndex === undefined) return
      yield { type: 'block-end', index: textIndex, block: { type: 'text', text: textBuffer } }
      textIndex = undefined
      textBuffer = ''
    }
    const closeReasoning = function* (): Generator<StreamChunk> {
      if (reasoningIndex === undefined) return
      yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoningBuffer } }
      reasoningIndex = undefined
      reasoningBuffer = ''
    }

    for await (const payload of ssePayloads(response.body)) {
      if (payload === '[DONE]') break
      let parsed: StreamPayload
      try {
        parsed = JSON.parse(payload) as StreamPayload
      } catch {
        continue
      }
      if (parsed.usage !== undefined) usage = mapUsage(parsed.usage)
      const choice = parsed.choices?.[0]
      const delta = choice?.delta
      if (delta !== undefined) {
        const reasoning = delta.reasoning_content ?? delta.reasoning
        if (typeof reasoning === 'string' && reasoning.length > 0) {
          yield* closeText()
          if (reasoningIndex === undefined) {
            reasoningIndex = nextIndex++
            yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
          }
          reasoningBuffer += reasoning
          emitted++
          yield { type: 'reasoning-delta', index: reasoningIndex, text: reasoning }
        }
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          yield* closeReasoning()
          if (textIndex === undefined) {
            textIndex = nextIndex++
            yield { type: 'block-start', index: textIndex, blockType: 'text' }
          }
          textBuffer += delta.content
          emitted++
          yield { type: 'text-delta', index: textIndex, text: delta.content }
        }
        for (const call of delta.tool_calls ?? []) {
          yield* closeText()
          yield* closeReasoning()
          const wireIndex = call.index ?? 0
          let state = toolStates.get(wireIndex)
          if (state === undefined) {
            state = { index: nextIndex++, id: call.id ?? `call_kenari_${wireIndex}_${Date.now()}`, name: '', args: '' }
            toolStates.set(wireIndex, state)
            yield { type: 'block-start', index: state.index, blockType: 'tool-call' }
          }
          if (call.id !== undefined) state.id = call.id
          const namePart = call.function?.name
          if (namePart !== undefined && namePart.length > 0) state.name += namePart
          const argsPart = call.function?.arguments ?? ''
          state.args += argsPart
          emitted++
          yield {
            type: 'tool-call-delta',
            index: state.index,
            id: state.id as never,
            ...(namePart !== undefined && namePart.length > 0 ? { name: namePart } : {}),
            argumentsDelta: argsPart,
          }
        }
      }
      if (choice?.finish_reason != null) {
        finishKind = choice.finish_reason === 'tool_calls' || choice.finish_reason === 'tool_call'
          ? { kind: 'tool-calls' }
          : choice.finish_reason === 'length'
            ? { kind: 'max-tokens' }
            : { kind: 'stop' }
      }
    }

    yield* closeText()
    yield* closeReasoning()
    for (const state of toolStates.values()) {
      yield {
        type: 'block-end',
        index: state.index,
        block: { type: 'tool-call', id: state.id as never, name: state.name, arguments: state.args },
      }
    }

    if (usage !== undefined) {
      yield { type: 'usage', usage }
      this.recordUsage(options, usage)
    }

    // 退化响应：一次空完成会让 turn 静默结束，按契约显式归类
    if (emitted === 0) {
      throw new LlmError('kenari: 模型返回了空响应（没有文本、思考或工具调用）', 'EMPTY_RESPONSE')
    }

    yield { type: 'finish', reason: finishKind }
  }

  /** usage 记进共享账本：命中率直接来自 `cached_tokens`，费用按目录单价预估。 */
  private recordUsage(options: GenerateOptions, usage: TokenUsage): void {
    const scope = options.sessionId === undefined ? GLOBAL_SCOPE : String(options.sessionId)
    this.deps.billing.recordUsage(scope, {
      model: options.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
      ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
      ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
    })
    void this.recordSpendEstimate(options, usage, scope)
  }

  private async recordSpendEstimate(options: GenerateOptions, usage: TokenUsage, scope: string): Promise<void> {
    try {
      const resolved = await this.deps.catalog.resolve(options.model)
      if (resolved === undefined || isFreeModel(resolved.model)) return
      const inputPrice = resolved.model.pricing?.input
      const outputPrice = resolved.model.pricing?.output
      if (typeof inputPrice !== 'number' || typeof outputPrice !== 'number') return
      // 缓存读有独立单价就按它算，否则退回输入价（宁可高估也不谎报）
      const cacheReadPrice = typeof resolved.model.pricing?.cache_read === 'number'
        ? resolved.model.pricing.cache_read
        : inputPrice
      // token_1m 单价 × 百万 token 数：token 类保留小数，不按整单位上取
      const microIdr = Math.round(
        (inputPrice * usage.inputTokens
          + cacheReadPrice * (usage.cacheReadTokens ?? 0)
          + outputPrice * usage.outputTokens) / 1_000_000,
      )
      this.deps.billing.recordSpend(scope, { tool: `chat:${options.model}`, model: options.model, microIdr, estimated: true })
    } catch {
      // 目录不可用时不计费，模型调用本身已完成
    }
  }
}
