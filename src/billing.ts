/**
 * 计费账本与余额监控：把「本次调用花了多少」升级成「这个会话一共花了多少、还剩多少额度」。
 *
 * 两种口径分开记，绝不混为一谈：
 * - **实际**：响应体带 `cost_micro_idr` 时才写实际值；
 * - **预估**：目录 `pricing_lines` 单价 × 数量，标注「预估」并计入封顶判断。
 *
 * 会话作用域取自 `exec.agent.id`（dsh 的 SessionId）；无 agent 的调用（web provider、
 * 目录查询）落在 `global` 作用域，仍计入总额，只是不参与单会话封顶。
 * @module dsh-kenari-plugin/billing
 */

import { kenariMcpCall } from './http.js'
import type { KenariHttpDeps } from './http.js'

/** micro-IDR → 可读 Rupiah 字符串（整除则不带小数）。 */
export function formatRupiah(microIdr: number): string {
  const rp = microIdr / 1_000_000
  return `Rp ${Number.isInteger(rp) ? rp.toLocaleString('id-ID') : rp.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`
}

/** 无会话归属的调用落在该作用域。 */
export const GLOBAL_SCOPE = 'global'

/** 一次计费调用：estimated 为真表示按目录单价推算，而非响应回显。 */
export interface SpendRecord {
  tool: string
  model?: string
  microIdr: number
  estimated: boolean
  at: number
}

/** 一次模型调用的 token 计量（cached_tokens 命中率的原始数据）。 */
export interface UsageRecord {
  model?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  at: number
}

/** 作用域花费汇总。 */
export interface SpendTotals {
  calls: number
  microIdr: number
  estimatedMicroIdr: number
  actualMicroIdr: number
}

/** token 计量汇总；hitRate 无缓存数据时为 undefined（不冒充 0%）。 */
export interface UsageTotals {
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** 缓存命中率 = cacheRead / (input + cacheRead)。 */
  hitRate?: number
}

/** 预算封顶拒绝：带可执行建议，错误文本由工具原样透出给模型。 */
export class KenariBudgetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KenariBudgetError'
  }
}

/** 计费账本：按作用域（会话）累计花费与 token 用量。 */
export class BillingLedger {
  private readonly spends = new Map<string, SpendRecord[]>()
  private readonly usages = new Map<string, UsageRecord[]>()

  constructor(private readonly capMicroIdr?: number) {}

  /** 记录一次花费（实际或预估）。 */
  recordSpend(scope: string, record: Omit<SpendRecord, 'at'> & { at?: number }): void {
    const list = this.spends.get(scope) ?? []
    list.push({ ...record, at: record.at ?? Date.now() })
    this.spends.set(scope, list)
  }

  /** 记录一次模型 token 用量。 */
  recordUsage(scope: string, record: Omit<UsageRecord, 'at'> & { at?: number }): void {
    const list = this.usages.get(scope) ?? []
    list.push({ ...record, at: record.at ?? Date.now() })
    this.usages.set(scope, list)
  }

  /** 作用域花费汇总。 */
  spendTotals(scope: string): SpendTotals {
    const list = this.spends.get(scope) ?? []
    let microIdr = 0
    let estimatedMicroIdr = 0
    for (const item of list) {
      microIdr += item.microIdr
      if (item.estimated) estimatedMicroIdr += item.microIdr
    }
    return { calls: list.length, microIdr, estimatedMicroIdr, actualMicroIdr: microIdr - estimatedMicroIdr }
  }

  /** 全进程花费合计（含所有会话，web provider 的按次计费也在内）。 */
  globalSpendTotals(): SpendTotals {
    let calls = 0
    let microIdr = 0
    let estimatedMicroIdr = 0
    for (const scope of this.spends.keys()) {
      const totals = this.spendTotals(scope)
      calls += totals.calls
      microIdr += totals.microIdr
      estimatedMicroIdr += totals.estimatedMicroIdr
    }
    return { calls, microIdr, estimatedMicroIdr, actualMicroIdr: microIdr - estimatedMicroIdr }
  }

  /** 按工具聚合（金额降序）。 */
  byTool(scope: string): { key: string; totals: SpendTotals }[] {
    return this.aggregate(scope, (item) => item.tool)
  }

  /** 按模型聚合（金额降序）；无模型的调用归入 `(无模型)`。 */
  byModel(scope: string): { key: string; totals: SpendTotals }[] {
    return this.aggregate(scope, (item) => item.model ?? '(无模型)')
  }

  /** 作用域 token 汇总。 */
  usageTotals(scope: string): UsageTotals {
    const list = this.usages.get(scope) ?? []
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0
    let cacheWriteTokens = 0
    for (const item of list) {
      inputTokens += item.inputTokens
      outputTokens += item.outputTokens
      cacheReadTokens += item.cacheReadTokens ?? 0
      cacheWriteTokens += item.cacheWriteTokens ?? 0
    }
    const billableInput = inputTokens + cacheReadTokens
    return {
      calls: list.length,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      ...(billableInput > 0 && cacheReadTokens > 0
        ? { hitRate: cacheReadTokens / billableInput }
        : {}),
    }
  }

  /** 预算状态；未配置封顶时 capMicroIdr 为 undefined。 */
  capStatus(scope: string): { capMicroIdr?: number; spentMicroIdr: number; remainingMicroIdr?: number; exceeded: boolean } {
    const spentMicroIdr = this.spendTotals(scope).microIdr
    if (this.capMicroIdr === undefined) return { spentMicroIdr, exceeded: false }
    return {
      capMicroIdr: this.capMicroIdr,
      spentMicroIdr,
      remainingMicroIdr: this.capMicroIdr - spentMicroIdr,
      exceeded: spentMicroIdr >= this.capMicroIdr,
    }
  }

  /**
   * 花费前预检：已达封顶则拒绝并给出可执行建议。
   * 预检只能看已知花费，所以是「不新增花钱调用」而非「保证总额不超」。
   */
  assertWithinBudget(scope: string, tool: string): void {
    const status = this.capStatus(scope)
    if (!status.exceeded) return
    throw new KenariBudgetError(
      `本会话 Kenari 预算已用尽：上限 ${formatRupiah(status.capMicroIdr ?? 0)}，已记录 ${formatRupiah(status.spentMicroIdr)}，`
      + `因此拒绝 ${tool} 以不再产生费用。`
      + '可选：改用免费模型（目录中 id 带 :free，如 step-3-7-flash:free）、提高 cordis 配置里的 budgetCapRp、或等下次会话重新计算。',
    )
  }

  /** 有记录的会话作用域（诊断用）。 */
  scopes(): string[] {
    return [...new Set([...this.spends.keys(), ...this.usages.keys()])]
  }

  private aggregate(scope: string, keyOf: (item: SpendRecord) => string): { key: string; totals: SpendTotals }[] {
    const groups = new Map<string, SpendRecord[]>()
    for (const item of this.spends.get(scope) ?? []) {
      const key = keyOf(item)
      const list = groups.get(key) ?? []
      list.push(item)
      groups.set(key, list)
    }
    return [...groups.entries()]
      .map(([key, list]) => {
        let microIdr = 0
        let estimatedMicroIdr = 0
        for (const item of list) {
          microIdr += item.microIdr
          if (item.estimated) estimatedMicroIdr += item.microIdr
        }
        return { key, totals: { calls: list.length, microIdr, estimatedMicroIdr, actualMicroIdr: microIdr - estimatedMicroIdr } }
      })
      .sort((a, b) => b.totals.microIdr - a.totals.microIdr)
  }
}

/**
 * 余额监控：`kenari_balance` 只有 MCP 入口，故按 TTL 缓存，避免每次花费都打一次 MCP。
 * TTL 取自实时配置，设置页改完即生效。分享页 key 会 403 —— 取不到余额时静默降级
 * （告警是便利功能，不阻断调用）。
 */
export class BalanceMonitor {
  private cached: { rp: number; fetchedAt: number } | undefined

  constructor(private readonly deps: KenariHttpDeps) {}

  /** 当前余额（Rupiah）；取不到返回 undefined（不抛错）。 */
  async balanceRp(signal?: AbortSignal): Promise<number | undefined> {
    const ttlMs = this.deps.config.balanceCacheTtlMs ?? 300_000
    if (ttlMs > 0 && this.cached !== undefined && Date.now() - this.cached.fetchedAt < ttlMs) {
      return this.cached.rp
    }
    try {
      const text = await kenariMcpCall(this.deps, 'kenari_balance', {}, signal)
      const rp = parseRupiah(text)
      if (rp === undefined) return undefined
      this.cached = { rp, fetchedAt: Date.now() }
      return rp
    } catch (err) {
      this.deps.logger?.warn(`kenari: 余额查询失败（告警降级）：${String(err)}`)
      return undefined
    }
  }

  /** 余额低于阈值时返回告警文本，否则 undefined。 */
  async alertIfLow(thresholdRp: number, signal?: AbortSignal): Promise<string | undefined> {
    if (thresholdRp <= 0) return undefined
    const rp = await this.balanceRp(signal)
    if (rp === undefined || rp >= thresholdRp) return undefined
    return `⚠️ Kenari 余额偏低：Rp ${rp.toLocaleString('id-ID')}（阈值 Rp ${thresholdRp.toLocaleString('id-ID')}）。改用免费模型（id 带 :free）或充值（QRIS 最低 Rp 1.000）。`
  }

  /** 丢弃缓存（测试与充值后刷新用）。 */
  invalidate(): void {
    this.cached = undefined
  }
}

/** 从 `kenari_balance` 文本里解析 Rupiah 数额；识别印尼式千分点。 */
export function parseRupiah(text: string): number | undefined {
  const match = /(?:Rp|IDR)\s*([0-9][0-9.,]*)/i.exec(text)
  if (match === null) return undefined
  // 印尼写法：`.` 千分位、`,` 小数位
  const normalized = match[1].replace(/\./g, '').replace(/,/g, '.')
  const value = Number(normalized)
  return Number.isFinite(value) ? value : undefined
}
