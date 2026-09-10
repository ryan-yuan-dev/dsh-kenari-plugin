/**
 * Kenari 模型目录：`GET /v1/models` 同步 + TTL 缓存 + dsh 模型元数据映射。
 *
 * Kenari 目录是**唯一**的模型事实来源（价格、上下文窗口、模态、推理档位、下线时间）。
 * 所有消费方（工具、设置卡片、LlmAdapter）都从这里取，避免各自解析 rc 期字段。
 * 端点与字段名变动只改本文件。
 * @module dsh-kenari-plugin/catalog
 */

import { kenariGet } from './http.js'
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
    const request = kenariGet<{ data?: KenariModel[] }>(this.deps, '/models', query, signal, { retries: 1 })
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
