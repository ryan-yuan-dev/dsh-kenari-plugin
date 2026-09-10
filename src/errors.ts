/**
 * Kenari REST 错误词汇：[OI] 线错误信封解析与状态码 → dsh 错误码映射。
 * Kenari 处于 rc 期，信封字段可能变动；解析保持宽松，缺字段不抛错。
 * @module dsh-kenari-plugin/errors
 */

import { WebError } from '@deepseek-ai/dsh-web'

/** [OI] 线错误信封：`{ error: { message, type, ... } }`，字段缺省不报错。 */
export interface KenariErrorEnvelope {
  error?: {
    message?: string
    type?: string
    code?: string
  }
}

/**
 * 解析 Kenari 错误信封的 message；非 JSON 或缺字段回退 HTTP 状态文本。
 * 调用方向：http.ts 在非 2xx 时调用。
 */
export function extractKenariErrorMessage(bodyText: string, status: number): string {
  try {
    const parsed = JSON.parse(bodyText) as KenariErrorEnvelope
    return parsed.error?.message ?? `HTTP ${status}`
  } catch {
    return `HTTP ${status}`
  }
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

