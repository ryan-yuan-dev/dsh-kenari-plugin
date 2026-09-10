/**
 * Kenari REST 错误词汇：[OI] 线错误信封解析、状态码 → dsh 错误码映射，
 * 以及高频错误的**可执行建议**（模型与 UI 读到的就是这段文本）。
 *
 * Kenari 处于 rc 期，信封字段可能变动；解析保持宽松，缺字段不抛错。
 * @module dsh-kenari-plugin/errors
 */

import { WebError } from '@deepseek-ai/dsh-web'

/** [OI] 线错误信封：`{ error: { message, type, code, param } }`，字段缺省不报错。 */
export interface KenariErrorEnvelope {
  error?: {
    message?: string
    type?: string
    code?: string
  }
}

/** 纯文本错误体的最大采纳长度（401 实测返回纯文本 `invalid key`）。 */
const PLAIN_TEXT_LIMIT = 200

/**
 * 状态码 → 可执行建议。只在能给出**具体动作**时才附上，避免正确的废话。
 * 生成类调用超时不在此列（http.ts 已按 retryTimeouts 处理，不会走到这里）。
 */
function guidanceFor(status: number, text: string): string | undefined {
  if (status === 401) {
    return '鉴权失败：确认凭据引用解析出的 key 有效（重新复制 kn-... 或新开终端让环境变量生效），并确认 base URL 形状正确（[OI]/Responses 用 https://kenari.id/v1，Anthropic 用 https://kenari.id 不带 /v1）。'
  }
  if (status === 402 || text.includes('insufficient_balance')) {
    return '余额不足：改用免费模型（目录里 id 带 :free，如 step-3-7-flash:free）或充值（QRIS 最低 Rp 1.000）。'
  }
  if (status === 403 || text.includes('shared_key_not_allowed')) {
    return '403：若这是分享页 key，则 balance / usage / quota 会被拒（它们读 key 所有者的账户数据），消费类工具仍可用；要读账户数字请改用自己账号的 key。'
  }
  if (status === 405) {
    return '405 表示 base URL 形状错误（不是 404）：[OI]/Responses 用 https://kenari.id/v1，Anthropic 用 https://kenari.id（不带 /v1）。'
  }
  if (status === 413) {
    return '请求体过大：降低图像尺寸或数量、缩短输入后重试。'
  }
  if (status === 422) {
    return '参数校验失败：按响应里的取值提示修正参数。'
  }
  if (status === 429) {
    return '触发限流：按 Retry-After 退避后重试；生成类调用不要因客户端超时而重试（可能重复扣费）。'
  }
  return undefined
}

/**
 * 解析 Kenari 错误信封的 message，并附上该状态码的可执行建议。
 * 非 JSON、超长或 HTML 体回退 HTTP 状态文本；调用方向：http.ts 非 2xx 时调用。
 */
export function extractKenariErrorMessage(bodyText: string, status: number): string {
  const raw = bodyText.trim()
  let message: string | undefined
  if (raw.length > 0) {
    try {
      const parsed = JSON.parse(raw) as KenariErrorEnvelope
      message = parsed.error?.message ?? parsed.error?.code
    } catch {
      // 401 等返回纯文本；HTML 兜底页（未知路由）不当错误文案用
      if (raw.length <= PLAIN_TEXT_LIMIT && !raw.startsWith('<')) message = raw
    }
  }
  const base = message !== undefined && message.length > 0 ? message : `HTTP ${status}`
  const guidance = guidanceFor(status, base)
  return guidance === undefined ? base : `${base} — ${guidance}`
}

/**
 * 把 Kenari 状态码映射为回退语义：429/408/5xx 可重试（http.ts 已内联重试），
 * 401/402/403 等 Kenari 侧不可恢复，由 fallback 层回退兜底 provider。
 */
export function classifyKenariStatus(status: number): 'retryable' | 'fallback' {
  if (status === 429 || status === 408 || status >= 500) return 'retryable'
  return 'fallback'
}

/** 构造带 `WEB_KENARI_*` code 的 WebError，cause 保留原始错误供诊断。 */
export function kenariWebError(code: string, message: string, cause?: unknown): WebError {
  return new WebError(message, code, cause !== undefined ? { cause } : undefined)
}
