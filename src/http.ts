/**
 * Kenari HTTP 客户端：web/fetch 两条 REST 调用共用的传输层。
 * 集中超时、重试、key 现场解析与错误信封映射；后端 rc 期端点变动只改这里。
 * @module dsh-kenari-plugin/http
 */

import { extractKenariErrorMessage, kenariWebError } from './errors.js'
import type { Config as PluginConfig } from './index.js'

/** Kenari web 端点响应体：search 与 fetch 共有的计费字段之外各取所需。 */
export interface KenariSearchResponse {
  results?: { title?: string; url?: string; content?: string }[]
  id?: string
  cost_micro_idr?: number
}

export interface KenariFetchResponse {
  title?: string
  content?: string
  links?: string[]
  id?: string
  cost_micro_idr?: number
}

/** 每次操作现场解析 key（硬约束 9：禁止跨操作缓存）。 */
export type ResolveApiKey = () => Promise<string | undefined>

/** 跨操作持有的运行时依赖，由 apply 装配。 */
export interface KenariHttpDeps {
  readonly config: PluginConfig
  readonly resolveApiKey: ResolveApiKey
  readonly logger?: { warn(msg: string): void; info(msg: string): void }
}

/** 瞬时失败（429/408/5xx/网络错误）可重试；其余状态一次即返。 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * POST 一个 Kenari [OI] 线端点并解析 JSON 响应。
 * 非法 URL → WEB_KENARI_NOT_CONFIGURED；key 缺失 → WEB_KENARI_NO_KEY；
 * 网络失败 → WEB_KENARI_NETWORK；非 2xx → WEB_KENARI_HTTP（消息不含 key）。
 */
export async function kenariPost<T>(
  deps: KenariHttpDeps,
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const { config } = deps
  const base = config.baseURL ?? 'https://kenari.id'
  // [OI] 线 base 必须以 /v1 结尾；用户配根域时补齐，配错形状报 405 的坑在这里消解
  const baseTrimmed = base.replace(/\/+$/, '')
  const endpoint = baseTrimmed.endsWith('/v1') ? `${baseTrimmed}${path}` : `${baseTrimmed}/v1${path}`

  if (!URL.canParse(endpoint)) {
    throw kenariWebError('WEB_KENARI_NOT_CONFIGURED', `kenari: baseURL 无法解析：${base}`)
  }

  const apiKey = await deps.resolveApiKey()
  if (apiKey === undefined || apiKey.length === 0) {
    throw kenariWebError('WEB_KENARI_NO_KEY', `kenari: 凭据 ${config.apiKeyEnv ?? 'KENARI_API_KEY'} 未配置`)
  }

  const timeoutMs = config.timeoutMs ?? 30_000
  const maxRetries = config.maxRetries ?? 2
  let lastError: unknown

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // 每次尝试独立超时：AbortSignal.any 组合外部取消与本次定时
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const composed = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: composed,
      })
      if (response.ok) {
        return (await response.json()) as T
      }
      const bodyText = await response.text()
      const message = extractKenariErrorMessage(bodyText, response.status)
      if (isRetryableStatus(response.status) && attempt < maxRetries) {
        lastError = kenariWebError('WEB_KENARI_HTTP', `kenari: ${message}`, undefined)
        await sleep(500 * 2 ** attempt)
        continue
      }
      throw kenariWebError('WEB_KENARI_HTTP', `kenari: ${message}`, undefined)
    } catch (err) {
      // 已包装的 WebError 直接上抛（不可重试或重试耗尽后的最终失败）
      if (err instanceof Error && err.name === 'WebError' && 'code' in err) throw err
      // 外部取消（signal）不该被重试吞掉
      if (signal?.aborted) {
        throw kenariWebError('WEB_CANCELLED', 'kenari: 请求已取消', err)
      }
      lastError = err
      if (attempt < maxRetries) {
        await sleep(500 * 2 ** attempt)
        continue
      }
      throw kenariWebError('WEB_KENARI_NETWORK', `kenari: 网络请求失败：${String(lastError)}`, lastError)
    }
  }
  // 循环正常退出必然经过 throw；此处只为类型收敛
  throw kenariWebError('WEB_KENARI_NETWORK', 'kenari: 请求失败', lastError)
}
