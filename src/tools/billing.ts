/**
 * 计费总览工具：一个地方看全「这个会话花了多少、还剩多少、缓存命中多少」。
 * 数据来自 billing.ts 的账本（工具调用与 web provider 共用同一个账本）与余额监控。
 * @module dsh-kenari-plugin/tools/billing
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolsDeps } from './shared.js'
import { GLOBAL_SCOPE, formatRupiah, scopeOf } from './shared.js'

/** 一分钟内的秒级时间戳 → 本地时间字符串。 */
function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString('zh-CN', { hour12: false })
}

/** 注册 kenari_billing。 */
export function registerBillingTool(deps: ToolsDeps, register: (tool: ReturnType<typeof defineTool>) => void): void {
  register(defineTool({
    name: 'kenari_billing',
    description: 'Show Kenari spend for this session: actual vs estimated cost, per-tool and per-model breakdown, token usage with prompt-cache hit rate, remaining budget, and wallet balance. Use it before expensive generation to decide what you can afford.',
    parameters: {
      refresh_balance: { type: 'boolean', description: 'Force a fresh wallet balance query instead of the cached one (default false).' },
      scope: { type: 'string', description: 'Session scope to report: "session" (this conversation, default) or "global" (whole dsh process, includes web search/fetch).', enum: ['session', 'global'] },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          spent_micro_idr: { type: 'integer', required: true },
          calls: { type: 'integer', required: true },
          cache_hit_rate: { type: 'number' },
          balance_rp: { type: 'number' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const scope = args.scope === 'global' ? GLOBAL_SCOPE : scopeOf(exec)
      const label = args.scope === 'global' ? '本进程' : '本会话'
      const totals = args.scope === 'global' ? deps.billing.globalSpendTotals() : deps.billing.spendTotals(scope)
      const usage = deps.billing.usageTotals(scope)
      const lines: string[] = [`Kenari 计费总览（${label}）`]

      lines.push(`- 花费：${formatRupiah(totals.microIdr)}（${totals.calls} 次调用；实际 ${formatRupiah(totals.actualMicroIdr)} + 预估 ${formatRupiah(totals.estimatedMicroIdr)}）`)

      const byTool = args.scope === 'global' ? undefined : deps.billing.byTool(scope)
      if (byTool !== undefined && byTool.length > 0) {
        lines.push('- 分工具：')
        for (const row of byTool) {
          lines.push(`  - ${row.key}：${formatRupiah(row.totals.microIdr)} × ${row.totals.calls}${row.totals.estimatedMicroIdr > 0 ? '（含预估）' : ''}`)
        }
      }
      if (args.scope !== 'global') {
        const byModel = deps.billing.byModel(scope).filter((row) => row.key !== '(无模型)')
        if (byModel.length > 0) {
          lines.push('- 分模型：')
          for (const row of byModel) lines.push(`  - ${row.key}：${formatRupiah(row.totals.microIdr)} × ${row.totals.calls}`)
        }
      }

      if (usage.calls > 0) {
        const hit = usage.hitRate === undefined ? '无缓存读数据' : `${(usage.hitRate * 100).toFixed(1)}%`
        lines.push(`- token：输入 ${usage.inputTokens} / 输出 ${usage.outputTokens} / 缓存读 ${usage.cacheReadTokens} / 缓存写 ${usage.cacheWriteTokens}；命中率 ${hit}`)
      } else {
        lines.push('- token：本次会话尚无模型调用计量（模型接入后由 Kenari 适配器记入；cached_tokens 命中率在此显示）')
      }

      const cap = deps.billing.capStatus(scope)
      if (cap.capMicroIdr === undefined) {
        lines.push('- 预算：未设封顶（cordis 配置 budgetCapRp 可设；达到上限会拒绝新的花费型调用）')
      } else {
        lines.push(`- 预算：上限 ${formatRupiah(cap.capMicroIdr)}，已用 ${formatRupiah(cap.spentMicroIdr)}，剩余 ${formatRupiah(cap.remainingMicroIdr ?? 0)}${cap.exceeded ? '（已用尽，花费型调用会被拒绝）' : ''}`)
      }

      if (args.refresh_balance === true) deps.balance.invalidate()
      const balance = await deps.balance.balanceRp()
      if (balance === undefined) {
        lines.push(`- 余额：查询失败（分享页 key 会 403；账户余额需自己账号的 key）`)
      } else {
        const threshold = deps.config.lowBalanceAlertRp ?? 0
        const low = threshold > 0 && balance < threshold ? `（低于阈值 Rp ${threshold.toLocaleString('id-ID')}，建议改免费模型或充值）` : ''
        lines.push(`- 余额：Rp ${balance.toLocaleString('id-ID')}${low}`)
      }

      const scopes = deps.billing.scopes().filter((item) => item !== GLOBAL_SCOPE)
      if (scopes.length > 1) {
        lines.push(`- 另有 ${scopes.length - 1} 个会话有花费记录（用 scope=global 看总账）`)
      }
      lines.push(`- 说明：预估按目录 pricing_lines 单价 × 数量推算，最终以 Kenari 账单为准；失败调用不计费。`)
      lines.push(`- 记录时间：${formatTime(Date.now())}`)

      return {
        text: lines.join('\n'),
        spent_micro_idr: totals.microIdr,
        calls: totals.calls,
        ...(usage.hitRate !== undefined ? { cache_hit_rate: Number(usage.hitRate.toFixed(4)) } : {}),
        ...(balance !== undefined ? { balance_rp: balance } : {}),
      }
    },
  }))
}
