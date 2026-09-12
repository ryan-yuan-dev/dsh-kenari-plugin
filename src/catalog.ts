/**
 * Kenari 模型目录：`GET /v1/models` 同步 + TTL 缓存 + dsh 模型元数据映射。
 *
 * Kenari 目录是**唯一**的模型事实来源（价格、上下文窗口、模态、推理档位、下线时间）。
 * 所有消费方（工具、设置卡片、LlmAdapter）都从这里取，避免各自解析 rc 期字段。
 * 端点与字段名变动只改本文件。
 * @module dsh-kenari-plugin/catalog
 */

import { kenariPublicGet, siteEndpoint } from './http.js'
import type { KenariHttpDeps } from './http.js'

/** 可当会话模型的端点（其余端点归为专用能力目录）。 */
const CHAT_ENDPOINT = 'chat'

/** 专用能力目录的 modality 取值（`GET /v1/models?modality=`）。 */
export type KenariModality = 'embedding' | 'rerank' | 'moderation'

/** 价格单位（Kenari 固定 micro-IDR per 1M tokens）。 */
const MICRO_PER_IDR = 1_000_000

/** `pricing` 块：token 计价（micro-IDR per 1M tokens）。 */
export interface KenariPricing {
  input?: number | null
  output?: number | null
  cache_read?: number | null
  cache_write?: number | null
  free?: boolean
  varies?: boolean
  currency?: string
  unit?: string
}

/** `pricing_lines` 行：按端点的计费明细（图像/秒/千字符/请求等非 token 单位）。 */
export interface KenariPricingLine {
  endpoint?: string
  billable?: string | null
  unit?: string
  variant?: string | null
  micro_idr?: number
}

/** 目录模型行（字段宽松解析，rc 期缺字段不报错）。 */
export interface KenariModel {
  id: string
  object?: string
  owned_by?: string
  name?: string
  /** epoch 秒；非空表示将下线（到期前仍正常服务）。 */
  sunset_at?: number | null
  context_length?: number
  modalities?: { input?: string[]; output?: string[] }
  reasoning?: boolean
  reasoning_options?: string[]
  reasoning_toggle?: boolean
  tool_call?: boolean
  pricing?: KenariPricing
  pricing_lines?: KenariPricingLine[]
  endpoints?: string[]
  modality?: string
  beta?: boolean
  voices?: string[]
  formats?: string[]
  max_input_chars?: number
  max_prompt_chars?: number
  max_lyrics_chars?: number
  max_duration_secs?: number
}

/** 解析后的模型条目：目录行 + 派生判断，消费方不再重复判定。 */
export interface ResolvedModel {
  model: KenariModel
  id: string
  /** 是否免费（`:free` 后缀或 `pricing.free`）。 */
  free: boolean
  /** 可用于会话（endpoints 含 chat）。 */
  chatCapable: boolean
  /** 别名列表（含 `kenari/<id>` 限定形式与配置别名）。 */
  aliases: string[]
  /** 需要提示的警告（beta、即将下线）。 */
  warnings: string[]
}

/** 目录解析失败时的可读原因（供工具与设置卡片展示）。 */
export class CatalogError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'CatalogError'
  }
}

/** 免费判定：`:free` 后缀或 `pricing.free`。 */
export function isFreeModel(model: KenariModel): boolean {
  return model.id.endsWith(':free') || model.pricing?.free === true
}

/** 会话可用判定：endpoints 含 `chat`；目录未给 endpoints 时按 modality 兜底。 */
export function isChatCapable(model: KenariModel): boolean {
  const endpoints = model.endpoints
  if (endpoints !== undefined && endpoints.length > 0) return endpoints.includes(CHAT_ENDPOINT)
  return model.modality === undefined && (model.modalities?.output ?? []).includes('text')
}

/** dsh 只声明 text/image 两种输入模态；Kenari 的 audio/video/pdf 输入不映射（避免过度声明）。 */
export function inputModalitiesOf(model: KenariModel): ('text' | 'image')[] {
  const declared = model.modalities?.input ?? []
  const out: ('text' | 'image')[] = ['text']
  if (declared.includes('image')) out.push('image')
  return out
}

/** 设置界面用来筛选与标注的能力标签；值就是标签文案本身。 */
export type CapabilityTag = 'image' | 'audio' | 'video' | 'pdf' | 'embedding'

/** 标签展示顺序（固定，避免每次渲染顺序漂移）。 */
export const CAPABILITY_TAGS: readonly CapabilityTag[] = ['image', 'audio', 'video', 'pdf', 'embedding']

/**
 * 目录行 → 能力标签。
 *
 * 判定用的是**输入**能力与端点两处事实，因为 Kenari 对同一件事只在一处给字段：
 * - 生成类（图像/视频/语音合成）只有 `endpoints`，`modalities.input` 仍是 text
 * - 理解类（看图/听音频/读 PDF）只有 `modalities.input`
 * - embedding 模型只在 `?modality=embedding` 目录里，带 `modality: 'embedding'`
 * 所以两个来源都要看，且都只看事实、不猜（缺字段就不打标签）。
 */
export function capabilityTagsOf(model: KenariModel): CapabilityTag[] {
  const input = model.modalities?.input ?? []
  const endpoints = model.endpoints ?? []
  const tags: CapabilityTag[] = []
  if (input.includes('image') || endpoints.includes('images')) tags.push('image')
  if (input.includes('audio') || endpoints.includes('audio_speech') || endpoints.includes('audio_transcription')) tags.push('audio')
  if (input.includes('video') || endpoints.includes('videos')) tags.push('video')
  if (input.includes('pdf')) tags.push('pdf')
  if (model.modality === 'embedding' || endpoints.includes('embeddings')) tags.push('embedding')
  return tags
}

/** dsh `ModelThinkingLevel` 的键集合：reasoningEfforts 里写别的键会让设置写入被拒。 */
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/**
 * Kenari `reasoning_options` → pi-ai `reasoningEfforts`。
 * Kenari 用 `none` 表示"支持但不发参数"，dsh 的对应键是 `off`；其余同名直通。
 * 两侧都不认识的取值直接丢弃——写进设置会让 schemastery 校验整节失败。
 */
export function reasoningEffortsOf(model: KenariModel): Record<string, string> | undefined {
  if (model.reasoning !== true) return undefined
  const efforts: Record<string, string> = {}
  for (const option of model.reasoning_options ?? []) {
    const level = option === 'none' ? 'off' : option
    if (THINKING_LEVELS.has(level)) efforts[level] = option
  }
  return Object.keys(efforts).length > 0 ? efforts : undefined
}

/**
 * slug 片段 → 展示名里的写法。查表优先，其次识别版本号与参数量后缀，最后首字母大写。
 * 表里只放**会读错**的词：缩写（`gpt`/`glm`/`tts`）与品牌大小写（`deepseek`/`mimo`/`minimax`）。
 */
const NAME_TOKENS: Record<string, string> = {
  gpt: 'GPT', glm: 'GLM', ai: 'AI', tts: 'TTS', asr: 'ASR', stt: 'STT', ocr: 'OCR', pdf: 'PDF',
  hd: 'HD', xs: 'XS', xl: 'XL', oss: 'OSS', api: 'API', llm: 'LLM', mcp: 'MCP', vlm: 'VLM', it: 'IT',
  deepseek: 'DeepSeek', mimo: 'MiMo', minimax: 'MiniMax', openai: 'OpenAI', kimi: 'Kimi', qwen: 'Qwen',
}

/** 一个 slug 片段的写法。 */
function spellNameToken(token: string): string {
  const known = NAME_TOKENS[token]
  if (known !== undefined) return known
  if (/^\d+(\.\d+)*$/.test(token)) return token
  if (/^v\d+(\.\d+)*$/.test(token)) return token
  if (/^[a-z]\d+[a-z]{0,3}$/.test(token)) return token.toUpperCase()
  if (/^\d+[a-z]{1,3}$/.test(token)) return token.toUpperCase()
  return token[0]!.toUpperCase() + token.slice(1)
}

/** `glm-5-3-flash` → `GLM 5.3 Flash`；版本号还原成点分，参数量后缀转大写。 */
function slugToDisplayName(id: string): string {
  const colon = id.indexOf(':')
  const base = colon === -1 ? id : id.slice(0, colon)
  const tokens = base.split(/[-_]/).filter((token) => token.length > 0)
  const merged: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (/^\d+$/.test(token)) {
      const run = [token]
      while (index + 1 < tokens.length && /^\d+$/.test(tokens[index + 1]!)) {
        index += 1
        run.push(tokens[index]!)
      }
      merged.push(run.join('.'))
      continue
    }
    // 版本前缀：单个字母 + 数字（`v2`、`m2`）把紧跟的数字并进同一个版本号（`v2-5` → `v2.5`）。
    const versioned = /^(v|[a-z])\d+$/.exec(token)
    if (versioned !== null) {
      const run = [token.slice(versioned[1]!.length)]
      while (index + 1 < tokens.length && /^\d+$/.test(tokens[index + 1]!)) {
        index += 1
        run.push(tokens[index]!)
      }
      merged.push(versioned[1]! + run.join('.'))
      continue
    }
    merged.push(token)
  }
  return merged.map(spellNameToken).join(' ')
}

/**
 * 写进路由的模型名统一带的路由前缀。
 *
 * 只加在**路由条目**上（{@link toModelProfile} 的 `name`）：那是 dsh 印模型名的地方，
 * 而 dsh 只在 `/` 模型菜单里印所属 provider，composer 的模型按钮与会话头部只有展示名
 * 一个字段 —— Kenari 与官方 DeepSeek 存在同名模型（`deepseek-v4-1-flash` 两边都有），
 * 不写前缀就分不出当前用的是哪条路由。
 *
 * 插件自己那一页的模型表不加：它整页都在 Kenari 节里，每行再写一遍 Kenari 是噪音。
 */
export const DISPLAY_NAME_PREFIX = 'Kenari '

/**
 * 一个模型自己的名字：目录给了 `name` 就用它，否则按 id 还原。
 *
 * 目录里只有 8 个模型自带 `name`，而且**都不是会话模型**（语音、图像、视频那几个），
 * 所以会话模型的名字必须能从 id 还原。这里的推导不是猜：Kenari 给出 `name` 的那 8 个
 * 模型与本函数的输出**逐字一致**（Veo 3.1 Lite、MiniMax Speech 2.8 Turbo、
 * Nano Banana Pro…），`test/catalog-view.mjs` 用它们反测。
 *
 * 名字原样给：要写进路由时由 {@link toModelProfile} 加前缀，两处口径不同是故意的。
 */
export function displayNameOf(model: KenariModel): string {
  const named = typeof model.name === 'string' ? model.name.trim() : ''
  return named.length > 0 ? named : slugToDisplayName(model.id)
}

/**
 * 每请求最大输出 token 的推荐值。
 *
 * 目录里**没有**这个字段：对全部 76 行实测过，只有 `context_length`，没有
 * `max_output_tokens` / `max_completion_tokens` / `top_provider`。所以它是推出来的：
 *
 * - **窗口的 1/4**：一次回答最多占多少窗口的常见取法，给提示词留 3/4，请求才不会被
 *   自己的上限顶出窗口。厂商公开的比例落在 6%（Gemini 2.5 的 65k / 1M）到
 *   32%（Claude 的 64k / 200k）之间，取 1/4 偏宽——写代码时"被截断"比"留得多"更常见。
 * - **不设下限**：下限看着无害，其实会算错小窗口的模型。目录里 `bge-m3` 的窗口只有 8192，
 *   若按 8192 兜底就等于把整个窗口都推荐成输出。（全部会话模型的窗口都 ≥128K，所以
 *   真正的会话模型从来用不到下限。）
 * - **向下取整到 1K**：窗口不都是 2 的幂（有 128000、255976 这种），直接算会得到
 *   32000 / 63994 这类数字。向下取整同时保证推荐值不超过窗口的 1/4。
 * - **上限 65536**：主流厂商公开的单次输出上限最大就在这一档，再大不代表任何真实能力。
 *   实测网关自己不做这个校验（`max_tokens` 给到 262144 仍返回 200），dsh 也不会把它从
 *   输入预算里扣掉，所以这个上限是"别写没有意义的数"，不是"写了会出错"。
 *
 * 目录不公布窗口的模型（18 个，其中只有 `qwen3-8-max` 是会话模型）不写这个字段：
 * 没有窗口可依据时，任何数值都是编的，不如沿用 pi-ai 自己的默认值。
 */
export function recommendedMaxTokens(contextWindow: number | undefined): number | undefined {
  if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined
  const share = Math.floor(contextWindow / 4 / 1024) * 1024
  return Math.min(65536, Math.max(1024, share))
}

/**
 * 目录行 → pi-ai provider profile 的 model 条目。
 *
 * 这是「把目录里的模型加进 `llm-pi-ai` 路由」时写进用户设置的形状，
 * 字段必须逐个来自目录：pi-ai 的 schema 会拒绝多余或拼错的键。
 *
 * `name` 与 `maxTokens` 都写：前者是 dsh 模型目录里那个「显示名称」框（不写就空着），
 * 后者是每请求输出上限（不写则整条路由共用 pi-ai 的 defaultMaxTokens 32768，
 * 于是每个模型看到的都是同一个数）。两者的推导见上面两个函数。
 *
 * `name` 是**唯一**带路由前缀的地方：这条 profile 写进 `llm-pi-ai` 之后，就是 dsh 的
 * 模型按钮、会话头部与 `/` 菜单印出来的字符串。
 */
export function toModelProfile(model: KenariModel): {
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
  input?: ('text' | 'image')[]
  reasoningEfforts?: Record<string, string>
} {
  const efforts = reasoningEffortsOf(model)
  const contextWindow = typeof model.context_length === 'number' && model.context_length > 0
    ? model.context_length
    : undefined
  const maxTokens = recommendedMaxTokens(contextWindow)
  return {
    id: model.id,
    name: DISPLAY_NAME_PREFIX + displayNameOf(model),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    input: inputModalitiesOf(model),
    ...(efforts === undefined ? {} : { reasoningEfforts: efforts }),
  }
}

/** micro-IDR → IDR/1M tokens 的十进制字符串（整数不带小数点）。 */
export function microToIdrPerMillion(micro: number): string {
  const idr = micro / MICRO_PER_IDR
  return Number.isInteger(idr) ? idr.toLocaleString('id-ID') : idr.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
}

/** token 价格行：免费与浮动单列，缺失如实说"未公布"。 */
export function formatTokenPrice(model: KenariModel): string {
  const pricing = model.pricing
  if (pricing === undefined) return '价格：目录未公布'
  if (pricing.free === true) return '价格：免费'
  if (pricing.varies === true) return '价格：浮动'
  const parts: string[] = []
  if (typeof pricing.input === 'number') parts.push(`入 ${microToIdrPerMillion(pricing.input)}`)
  if (typeof pricing.output === 'number') parts.push(`出 ${microToIdrPerMillion(pricing.output)}`)
  if (typeof pricing.cache_read === 'number') parts.push(`缓存读 ${microToIdrPerMillion(pricing.cache_read)}`)
  if (typeof pricing.cache_write === 'number') parts.push(`缓存写 ${microToIdrPerMillion(pricing.cache_write)}`)
  if (parts.length === 0) return '价格：目录未公布'
  return `价格：${parts.join(' / ')} IDR per 1M tokens`
}

/** 非 token 端点单价行；无常驻行时返回空数组。 */
export function formatPricingLines(model: KenariModel): string[] {
  const lines = model.pricing_lines ?? []
  return lines
    .filter((line) => line.micro_idr !== undefined)
    .map((line) => {
      const idr = (line.micro_idr ?? 0) / MICRO_PER_IDR
      const unit = line.unit ?? 'request'
      const variant = line.variant === null || line.variant === undefined ? '' : ` ${line.variant}`
      const per = unit === 'token_1m' ? 'per 1M tokens' : unit === '1k_chars' ? 'per 1k 字符' : unit === 'second' ? 'per 秒' : unit === 'image' ? 'per 张' : unit === 'song' ? 'per 首' : unit === 'megapixel' ? 'per 百万像素' : 'per 次'
      return `${line.endpoint ?? '?'}${variant}：Rp ${idr.toLocaleString('id-ID')} ${per}`
    })
}

/** 端点 → 命中的计费行（variant 优先精确匹配，缺失取第一档）。 */
export function priceLineOf(model: KenariModel, endpoint: string, variant?: string): KenariPricingLine | undefined {
  const lines = (model.pricing_lines ?? []).filter((line) => line.endpoint === endpoint && line.micro_idr !== undefined)
  if (lines.length === 0) return undefined
  if (variant !== undefined) {
    const exact = lines.find((line) => line.variant === variant)
    if (exact !== undefined) return exact
  }
  return lines[0]
}

/** 端点 → 可读单价（micro-IDR）；variant 优先精确匹配，缺失取第一档。 */
export function unitPriceMicro(model: KenariModel, endpoint: string, variant?: string): number | undefined {
  return priceLineOf(model, endpoint, variant)?.micro_idr
}

/** 计费单位的人读名称（回显口径用）。 */
export function unitLabel(unit: string | undefined): string {
  switch (unit) {
    case 'token_1m': return '1M tokens'
    case '1k_chars': return '1k 字符'
    case 'second': return '秒'
    case 'image': return '张'
    case 'song': return '首'
    case 'megapixel': return '百万像素'
    case 'request': return '次'
    default: return unit ?? '次'
  }
}

/** 需要的计费单位（用于按量预估）：单位与数量的语义由调用方声明。 */
export type BillingUnit = 'token_1m' | 'image' | 'second' | '1k_chars' | 'request' | 'megapixel' | 'song'

/** 按计费行单价 × 数量（数量以该行 unit 为单位）预估费用（micro-IDR）。 */
export function estimateMicro(model: KenariModel, endpoint: string, quantity: number, variant?: string): number | undefined {
  const unit = unitPriceMicro(model, endpoint, variant)
  return unit === undefined ? undefined : Math.round(unit * quantity)
}

/** epoch 秒 → `YYYY-MM-DD`（本地时区无关，仅作展示）。 */
function formatEpochSeconds(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10)
}

/** 模型体检：beta 标注与下线告警（到期前仍服务，故只提示不拒绝）。 */
export function warningsOf(model: KenariModel, now = Date.now()): string[] {
  const warnings: string[] = []
  if (model.beta === true) warnings.push('beta：实验性模型，接口与价格可能变动')
  const sunsetAt = model.sunset_at
  if (typeof sunsetAt === 'number' && sunsetAt > 0) {
    const days = Math.ceil((sunsetAt * 1000 - now) / 86_400_000)
    const when = formatEpochSeconds(sunsetAt)
    if (days <= 0) warnings.push(`已到下线时间 ${when}：随时可能停止服务`)
    else warnings.push(`将于 ${when} 下线（还剩 ${days} 天）：到期前仍正常服务，请尽早迁移`)
  }
  return warnings
}

/** 模型别名：`kenari/<id>` 限定形式 + 配置别名 + 去除限定后的裸 id。 */
export function aliasesOf(model: KenariModel, configured: Record<string, string>): string[] {
  const aliases = new Set<string>([model.id, `kenari/${model.id}`])
  for (const [alias, target] of Object.entries(configured)) {
    if (target === model.id) aliases.add(alias)
  }
  return [...aliases]
}

/** 别名归一：去掉 `kenari/` 或 `kenari:` 限定前缀，再查配置别名表。 */
export function normalizeModelId(raw: string, configured: Record<string, string>): string {
  const trimmed = raw.trim()
  const stripped = trimmed.startsWith('kenari/') || trimmed.startsWith('kenari:') ? trimmed.slice(7) : trimmed
  return configured[stripped] ?? configured[trimmed] ?? stripped
}

/**
 * 目录客户端：进程内 TTL 缓存（目录是公开端点，无需 key）。
 * 并发请求合并到同一次抓取，避免工具族同时冷启动打爆目录端点。
 */
export class KenariCatalog {
  private cache = new Map<string, { models: KenariModel[]; fetchedAt: number }>()
  private inflight = new Map<string, Promise<KenariModel[]>>()

  constructor(private readonly deps: KenariHttpDeps) {}

  /** 缓存有效期取自实时配置：设置页改完下一次读取即生效。 */
  private get ttlMs(): number {
    return this.deps.config.catalogCacheTtlMs ?? 3_600_000
  }

  /** 模型别名表取自实时配置。 */
  private get aliases(): Record<string, string> {
    return this.deps.config.modelAliases ?? {}
  }

  /** 目录抓取（公开端点）：TTL 内直接命中缓存。 */
  async list(modality?: KenariModality, signal?: AbortSignal): Promise<KenariModel[]> {
    const key = modality ?? 'chat'
    const cached = this.cache.get(key)
    const ttlMs = this.ttlMs
    if (ttlMs > 0 && cached !== undefined && Date.now() - cached.fetchedAt < ttlMs) {
      return cached.models
    }
    const pending = this.inflight.get(key)
    if (pending !== undefined) return pending
    const query: Record<string, string> | undefined = modality === undefined ? undefined : { modality }
    // 目录无需 key（实测：带 key 与不带 key 的响应逐字节相同），所以走公开 GET：
    // 没配 key 的部署也能列出模型——设置页正是用户还没有 key 时最需要它的地方。
    const qs = query === undefined ? '' : `?${new URLSearchParams(query).toString()}`
    const request = kenariPublicGet<{ data?: KenariModel[] }>(
      this.deps,
      `${siteEndpoint(this.deps.config.baseURL, '/v1/models')}${qs}`,
      signal,
      { retries: 1 },
    )
      .then((payload) => {
        const models = (payload.data ?? []).filter((model): model is KenariModel => typeof model?.id === 'string')
        this.cache.set(key, { models, fetchedAt: Date.now() })
        return models
      })
      .finally(() => {
        this.inflight.delete(key)
      })
    this.inflight.set(key, request)
    return request
  }

  /** 会话模型目录（endpoints 含 chat），缓存与 list 共用。 */
  async chatModels(signal?: AbortSignal): Promise<KenariModel[]> {
    return (await this.list(undefined, signal)).filter(isChatCapable)
  }

  /**
   * 目录解析：别名归一 → 精确匹配 → 大小写不敏感兜底。
   *
   * 默认（无 modality）目录只含 chat 与生成类模型；embedding / rerank /
   * moderation 只在 `?modality=` 目录里。给了 modality 就只多查那一本，
   * 没给则三本都查（各自的响应都走 TTL 缓存，故代价一次性）。
   */
  async resolve(rawId: string, modality?: KenariModality, signal?: AbortSignal): Promise<ResolvedModel | undefined> {
    const target = normalizeModelId(rawId, this.aliases)
    const search = (models: KenariModel[]): KenariModel | undefined =>
      models.find((row) => row.id === target) ?? models.find((row) => row.id.toLowerCase() === target.toLowerCase())

    const direct = search(await this.list(undefined, signal))
    if (direct !== undefined) return this.describe(direct)

    const modalities: KenariModality[] = modality === undefined ? ['embedding', 'rerank', 'moderation'] : [modality]
    for (const candidate of modalities) {
      const found = search(await this.list(candidate, signal))
      if (found !== undefined) return this.describe(found)
    }
    return undefined
  }

  /** 目录行 → 解析后条目。 */
  describe(model: KenariModel): ResolvedModel {
    return {
      model,
      id: model.id,
      free: isFreeModel(model),
      chatCapable: isChatCapable(model),
      aliases: aliasesOf(model, this.aliases),
      warnings: warningsOf(model),
    }
  }

  /** 免费会话模型（`新账户默认 step-3-7-flash:free` 的选型依据）。 */
  async freeModels(signal?: AbortSignal): Promise<KenariModel[]> {
    return (await this.chatModels(signal)).filter(isFreeModel)
  }

  /** 清空缓存（测试与强制刷新用）。 */
  invalidate(): void {
    this.cache.clear()
  }
}

/** 目录行 → dsh `LlmModelInfo` 形状（adapter 的 listModels 与设置卡片共用）。 */
export function toLlmModelInfo(model: KenariModel, provider: string): {
  provider: string
  id: string
  name: string
  description?: string
  inputModalities: ('text' | 'image')[]
} {
  const annotations: string[] = []
  if (isFreeModel(model)) annotations.push('免费')
  if (model.beta === true) annotations.push('beta')
  const description = annotations.length > 0 ? annotations.join(' · ') : undefined
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...(description !== undefined ? { description } : {}),
    inputModalities: inputModalitiesOf(model),
  }
}

/**
 * 目录行 → dsh `LlmResolvedModelInfo` 形状：上下文窗口 + reasoning 档位 + 默认输出上限。
 * `reasoning_options` 的每个值既是 dsh 的 effort id 也是 Kenari 线上的写法，故一一对应。
 */
export function toResolvedModelInfo(model: KenariModel, provider: string): {
  provider: string
  id: string
  name: string
  description?: string
  inputModalities: ('text' | 'image')[]
  context?: { contextWindow: number }
  reasoning?: { efforts: { id: string; name: string }[]; defaultEffort?: string }
} {
  const base = toLlmModelInfo(model, provider)
  const context = typeof model.context_length === 'number' && model.context_length > 0
    ? { contextWindow: model.context_length }
    : undefined
  const options = model.reasoning === true ? (model.reasoning_options ?? []) : []
  const reasoning = options.length > 0
    ? {
        efforts: options.map((effort) => ({ id: effort, name: effort })),
        ...(options.includes('medium') ? { defaultEffort: 'medium' } : {}),
      }
    : undefined
  return {
    ...base,
    ...(context !== undefined ? { context } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
  }
}
