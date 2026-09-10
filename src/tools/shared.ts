/**
 * REST 工具族共享基建：工具依赖、计费记账、成本回显与通用 render 辅助。
 * 每个工具文件只声明自己的参数 schema 与端点映射，网络与错误映射集中在 http.ts，
 * 目录与计价集中在 catalog.ts，账本集中在 billing.ts。
 * @module dsh-kenari-plugin/tools/shared
 */

import type { Context } from '@deepseek-ai/cordis'
import type { KenariHttpDeps } from '../http.js'
import type { Config } from '../index.js'
import type { KenariCatalog, KenariModel, KenariModality } from '../catalog.js'
import { priceLineOf, unitLabel } from '../catalog.js'
import type { BalanceMonitor, BillingLedger } from '../billing.js'
import { GLOBAL_SCOPE, formatRupiah } from '../billing.js'

export { formatRupiah, GLOBAL_SCOPE } from '../billing.js'

/** 端点 → 目录 modality：只有专用能力模型不在默认目录里。 */
function modalityOfEndpoint(endpoint: string): KenariModality | undefined {
  switch (endpoint) {
    case 'embeddings': return 'embedding'
    case 'rerank': return 'rerank'
    case 'moderations': return 'moderation'
    default: return undefined
  }
}

/** 工具族共享的运行时依赖：传输层 + 目录 + 账本 + 余额监控 + attachment（经 ctx）。 */
export interface ToolsDeps {
  readonly http: KenariHttpDeps
  readonly ctx: Context
  /** 实时配置视图：settings 提交后下一次操作即读到新值。 */
  readonly config: Config
  /** 模型目录（TTL 缓存，公开端点）。 */
  readonly catalog: KenariCatalog
  /** 计费账本（按会话累计）。 */
  readonly billing: BillingLedger
  /** 余额监控（MCP 入口，TTL 缓存）。 */
  readonly balance: BalanceMonitor
}

/** 单次调用的计费回显行；cost 缺失时不产生误导。 */
export function costLine(microIdr: number | undefined): string {
  return microIdr === undefined ? '' : `\n\n费用：${formatRupiah(microIdr)}（micro_idr ${microIdr}）`
}

/** 会话作用域：优先 dsh 的 SessionId，无 agent 的调用落到 global。 */
export function scopeOf(exec: { agent?: { id: string } } | undefined): string {
  return exec?.agent?.id ?? GLOBAL_SCOPE
}

/**
 * 花费前预检：会话预算已用尽就拒绝（抛 KenariBudgetError）。
 * 用在每个会产生费用的工具入口。
 */
export function spendGuard(deps: ToolsDeps, exec: { agent?: { id: string } } | undefined, tool: string): void {
  deps.billing.assertWithinBudget(scopeOf(exec), tool)
}

/** 一次花费的记账输入。 */
export interface SpendInput {
  tool: string
  model?: string
  /** 响应回显的实际扣费（micro-IDR）；有它就以它为准。 */
  costMicroIdr?: number
  /** 目录单价 × 数量推算的预估费用（micro-IDR）。 */
  estimateMicroIdr?: number
  /** 预估口径说明，例如「1 张 × Rp 175」。 */
  estimateNote?: string
  /** 明确的口径补充，例如「复用命中，本次免费」。 */
  note?: string
  /** 该调用是否计费；false 表示免费工具（如目录查询、token 计数）。 */
  billable?: boolean
}

/**
 * 记账并生成回显文本。实际值优先于预估值；两者都缺且声明计费时如实说明未计入，
 * 避免模型把「没写费用」当成「免费」。
 */
export async function billSpend(
  deps: ToolsDeps,
  exec: { agent?: { id: string } } | undefined,
  input: SpendInput,
): Promise<string> {
  const billable = input.billable ?? true
  const scope = scopeOf(exec)
  let head: string | undefined

  if (input.costMicroIdr !== undefined) {
    deps.billing.recordSpend(scope, {
      tool: input.tool,
      ...(input.model !== undefined ? { model: input.model } : {}),
      microIdr: input.costMicroIdr,
      estimated: false,
    })
    head = `费用：${formatRupiah(input.costMicroIdr)}（实际扣费${input.costMicroIdr === 0 ? '，复用命中免费' : ''}）`
  } else if (input.estimateMicroIdr !== undefined) {
    deps.billing.recordSpend(scope, {
      tool: input.tool,
      ...(input.model !== undefined ? { model: input.model } : {}),
      microIdr: input.estimateMicroIdr,
      estimated: true,
    })
    const per = input.estimateNote === undefined ? '' : `（${input.estimateNote}）`
    head = `费用：约 ${formatRupiah(input.estimateMicroIdr)}（按目录单价预估${per}，最终以账单为准）`
  } else if (billable) {
    head = '费用：本次调用既无回显也未查到单价，未计入累计'
  }

  if (head === undefined) return ''
  if (input.note !== undefined) head = `${head}；${input.note}`

  const totals = deps.billing.spendTotals(scope)
  const scopeLabel = scope === GLOBAL_SCOPE ? '本进程' : '本会话'
  const lines = [`${head}｜${scopeLabel}累计：${formatRupiah(totals.microIdr)}（${totals.calls} 次）`]

  const thresholdRp = deps.config.lowBalanceAlertRp ?? 0
  if (thresholdRp > 0) {
    const alert = await deps.balance.alertIfLow(thresholdRp)
    if (alert !== undefined) lines.push(alert)
  }
  return `\n\n${lines.join('\n')}`
}

/**
 * 非 token 单位按整单位上取。
 *
 * 实测（2026-09-10，mimo-v2-5-tts）：21 字符的 TTS 输入按 1 个「1k 字符」单位计费
 * Rp 250，而非 0.021 单位。所以 `image`/`second`/`1k_chars`/`song`/`request`/
 * `megapixel` 这类按件单位都要向上取整，否则预估会低一到两个数量级。
 * `token_1m` 是按 token 线性计价，保留小数才是正确口径。
 */
export function billedUnits(units: number, unit: string | undefined): { units: number; roundedUp: boolean } {
  if (unit === 'token_1m') return { units, roundedUp: false }
  const whole = Math.ceil(units)
  return { units: whole, roundedUp: whole !== units }
}

/**
 * 按目录计价行预估一次调用：`units` 必须以该行的计费单位表达
 * （图像=张、视频=秒、语音=千字符、token 类=百万 token）。
 * 找不到模型或该端点单价时返回空预估（不阻断调用）。
 */
export async function estimateByUnit(
  deps: ToolsDeps,
  modelId: string,
  endpoint: string,
  units: number,
  variant?: string,
): Promise<{ model?: KenariModel; microIdr?: number; note?: string }> {
  try {
    const resolved = await deps.catalog.resolve(modelId, modalityOfEndpoint(endpoint))
    if (resolved === undefined) return {}
    const line = priceLineOf(resolved.model, endpoint, variant)
    if (line?.micro_idr === undefined) return { model: resolved.model }
    const label = unitLabel(line.unit)
    const billed = billedUnits(units, line.unit)
    const unitPrice = line.micro_idr
    const parts = [
      `${Number.isInteger(billed.units) ? billed.units : billed.units.toFixed(6)} ${label}`,
      `× Rp ${(unitPrice / 1_000_000).toLocaleString('id-ID')}`,
    ]
    if (billed.roundedUp) parts.push(`（不足一单位按一单位计，输入量 ${units.toFixed(6)}）`)
    if (variant !== undefined) parts.push(`@ ${variant}`)
    return {
      model: resolved.model,
      microIdr: Math.round(unitPrice * billed.units),
      note: parts.join(' '),
    }
  } catch {
    // 目录不可用时预估失效，调用本身继续
    return {}
  }
}
