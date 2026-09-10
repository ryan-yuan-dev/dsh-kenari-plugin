/**
 * 账户工具：kenari_balance / kenari_usage（公开 MCP 端点，无 REST 等价物）
 * 与 kenari_quota（REST GET /v1/account/quota）。
 * 分享页 key 调用三者都会 403（shared_key_not_allowed），错误文本给出解释。
 * @module dsh-kenari-plugin/tools/account
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolsDeps } from './shared.js'
import { kenariGet, kenariMcpCall } from '../http.js'

/** REST 403 的分享页 key 特征码（OpenAPI：shared_key_not_allowed）。 */
function isSharedKeyMessage(message: string): boolean {
  return message.includes('shared_key_not_allowed') || message.includes('shared key')
}

/** 统一错误转译：分享页 key 给出可执行解释，其余原样透传。 */
function explainAccountError(err: unknown): string {
  const text = String(err)
  if (isSharedKeyMessage(text) || text.includes('403')) {
    return '该 key 来自分享页（share page）：balance / usage / quota 读取的是 key 所有者的账户数据，因此被拒绝（403 shared_key_not_allowed）。消费类工具（搜索、抓取、生成）不受影响；需要读取账户数字请改用自己账号的 key。'
  }
  return `kenari 账户查询失败：${text}`
}

/** 注册账户三工具。 */
export function registerAccountTools(deps: ToolsDeps, register: (tool: ReturnType<typeof defineTool>) => void): void {
  register(defineTool({
    name: 'kenari_balance',
    description: 'Your Kenari wallet balance in Indonesian Rupiah. Requires a personal (non-shared) kn- API key.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute() {
      try {
        const text = await kenariMcpCall(deps.http, 'kenari_balance')
        return { text: `Kenari 余额：${text}` }
      } catch (err) {
        return { text: explainAccountError(err) }
      }
    },
  }))

  register(defineTool({
    name: 'kenari_usage',
    description: 'Your Kenari usage for the last 30 days (requests, tokens, and cost per model). Requires a personal (non-shared) kn- API key.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute() {
      try {
        const text = await kenariMcpCall(deps.http, 'kenari_usage')
        return { text: `Kenari 近 30 天用量：\n${text}` }
      } catch (err) {
        return { text: explainAccountError(err) }
      }
    },
  }))

  register(defineTool({
    name: 'kenari_quota',
    description: 'Your Kenari plan windows and coupon quota in Rupiah (5-hour / weekly / monthly rolling windows). Requires a personal (non-shared) kn- API key.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute() {
      try {
        const quota = await kenariGet<QuotaResponse>(deps.http, '/account/quota')
        return { text: formatQuota(quota) }
      } catch (err) {
        return { text: explainAccountError(err) }
      }
    },
  }))
}

/** GET /v1/account/quota 响应（字段宽松，plan/coupon 均可空）。 */
interface QuotaResponse {
  plan?: {
    name?: string
    windows?: {
      week?: QuotaWindow
      month?: QuotaWindow
      five_hour?: QuotaWindow
    }
  } | null
  coupon?: {
    name?: string
    used_rp?: number
    remaining_rp?: number | null
    expires_at?: string
    scope_models?: string[]
  } | null
}

/** 配额窗口：used / remaining 为整 Rupiah，resets_at 为 RFC 3339 UTC。 */
interface QuotaWindow {
  used_rp?: number
  remaining_rp?: number
  resets_at?: string
}

/** quota 响应 → 可读文本；plan 与 coupon 皆空时如实说明。 */
function formatQuota(quota: QuotaResponse): string {
  const lines: string[] = ['Kenari 套餐与优惠券额度：']
  const plan = quota.plan
  if (plan === null || plan === undefined) {
    lines.push('- 套餐：无（从未订阅、已过期或不活跃）')
  } else {
    lines.push(`- 套餐：${plan.name ?? '(未命名)'}`)
    const windows = plan.windows ?? {}
    const rows: [string, QuotaWindow | undefined][] = [
      ['5 小时', windows.five_hour],
      ['每周', windows.week],
      ['每月', windows.month],
    ]
    for (const [label, window] of rows) {
      if (window === undefined) continue
      const reset = window.resets_at === undefined ? '' : `，${window.resets_at} 重置`
      lines.push(`  - ${label}窗口：已用 Rp ${window.used_rp ?? 0} / 剩余 Rp ${window.remaining_rp ?? 0}${reset}`)
    }
  }
  const coupon = quota.coupon
  if (coupon !== null && coupon !== undefined) {
    const remaining = coupon.remaining_rp === null || coupon.remaining_rp === undefined
      ? '无上限'
      : `Rp ${coupon.remaining_rp}`
    lines.push(`- 优惠券：${coupon.name ?? '(未命名)'}，已用 Rp ${coupon.used_rp ?? 0} / 剩余 ${remaining}`)
    if (coupon.expires_at !== undefined) lines.push(`  - 过期：${coupon.expires_at}`)
    if (coupon.scope_models !== undefined && coupon.scope_models.length > 0) {
      lines.push(`  - 适用模型：${coupon.scope_models.join(', ')}`)
    }
  }
  return lines.join('\n')
}
