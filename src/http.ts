/**
 * Kenari HTTP 客户端：web/fetch 两条 REST 调用共用的传输层。
 * 集中超时、重试、key 现场解析与错误信封映射；后端 rc 期端点变动只改这里。
 * @module dsh-kenari-plugin/http
 */

import { extractKenariErrorMessage, kenariWebError } from './errors.js'
import type { Config as PluginConfig } from './index.js'

/** Kenari MCP 端点（Streamable HTTP，JSON 模式）。balance/usage 无 REST 端点，只能走这里。 */
const MCP_ENDPOINT = 'https://kenari.id/mcp'

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

/** 单次请求的可选覆盖：媒体生成需要更长超时，且超时不得重试。 */
export interface KenariRequestOptions {
  /** 每次尝试的超时覆盖（默认取 config.timeoutMs）。 */
  timeoutMs?: number
  /** 重试次数覆盖（默认取 config.maxRetries）。 */
  retries?: number
  /**
   * 尝试超时是否可重试（默认 true）。
   * 生成类调用置 false：请求可能已在服务端完成并计费，重试有重复扣费风险。
   */
  retryTimeouts?: boolean
  /**
   * 是否带 `Authorization: Bearer <key>` 并因此要求 key（默认 true）。
   * 站点公开端点（套餐表等，不在 /v1 下、不需要 key）置 false：
   * 没有 key 的部署也应该能读到它们。
   */
  auth?: boolean
}

/** 瞬时失败（429/408/5xx/网络错误）可重试；其余状态一次即返。 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500
}

/** 定时器触发的 AbortSignal 抛 TimeoutError；用它区分超时与外部取消。 */
function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError'
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
  opts?: KenariRequestOptions,
): Promise<T> {
  return kenariRequest(deps, 'POST', path, signal, opts, async (init, endpoint) => {
    const response = await fetch(endpoint, {
      ...init,
      headers: { ...init.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return finishJson<T>(deps, response, endpoint)
  })
}

/**
 * GET 一个 Kenari [OI] 线端点并解析 JSON 响应（quota、models 等只读端点）。
 * 错误语义与 kenariPost 一致。
 */
export async function kenariGet<T>(
  deps: KenariHttpDeps,
  path: string,
  query?: Record<string, string>,
  signal?: AbortSignal,
  opts?: KenariRequestOptions,
): Promise<T> {
  const qs = query === undefined ? '' : `?${new URLSearchParams(query).toString()}`
  return kenariRequest(deps, 'GET', `${path}${qs}`, signal, opts, async (init, endpoint) => {
    const response = await fetch(endpoint, init)
    return finishJson<T>(deps, response, endpoint)
  })
}

/**
 * GET 一个 Kenari **站点**端点（绝对 URL、无 key、不补 /v1）。
 *
 * 与 REST 线分开的理由：这类端点（`/api/plans` 之类）是站点自己的公开路由，
 * 既不在 `/v1` 下也不认 `Authorization`。它们的形状比 API 线宽松（官网改版即可能变），
 * 所以调用方必须把解析失败当成可选数据缺失，而不是插件故障。
 */
export async function kenariPublicGet<T>(
  deps: KenariHttpDeps,
  url: string,
  signal?: AbortSignal,
  opts?: KenariRequestOptions,
): Promise<T> {
  return kenariRequest(deps, 'GET', url, signal, { ...opts, auth: false }, async (init, endpoint) => {
    const response = await fetch(endpoint, init)
    return finishJson<T>(deps, response, endpoint)
  })
}

/**
 * POST 一个 JSON 端点并把二进制响应体原样带回（audio/speech 等返回原始字节）。
 * 返回体可能很大，调用方负责落到 attachment 存储。
 */
export async function kenariPostBinary(
  deps: KenariHttpDeps,
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  opts?: KenariRequestOptions,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  return kenariRequest(deps, 'POST', path, signal, opts, async (init, endpoint) => {
    const response = await fetch(endpoint, {
      ...init,
      headers: { ...init.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw await httpError(deps, response, endpoint)
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    }
  })
}

/**
 * GET 一个端点并把二进制响应体原样带回（videos/{id}/content 下载）。
 * 端点需要 key：下载 URL 带 key 访问，故与 POST 共用鉴权与超时。
 */
export async function kenariGetBinary(
  deps: KenariHttpDeps,
  path: string,
  signal?: AbortSignal,
  opts?: KenariRequestOptions,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  return kenariRequest(deps, 'GET', path, signal, opts, async (init, endpoint) => {
    const response = await fetch(endpoint, init)
    if (!response.ok) throw await httpError(deps, response, endpoint)
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    }
  })
}

/**
 * POST multipart/form-data（images/edits、audio/transcriptions）并解析 JSON 响应。
 * fields 里的二进制值以 Uint8Array 出现，其余转为字符串。
 */
export async function kenariPostMultipart<T>(
  deps: KenariHttpDeps,
  path: string,
  fields: Record<string, string | Uint8Array>,
  signal?: AbortSignal,
  opts?: KenariRequestOptions,
): Promise<T> {
  return kenariRequest(deps, 'POST', path, signal, opts, async (init, endpoint) => {
    const form = new FormData()
    for (const [name, value] of Object.entries(fields)) {
      if (typeof value === 'string') form.append(name, value)
      else form.append(name, new Blob([new Uint8Array(value)]), name)
    }
    // fetch 为 FormData 自动补 Content-Type（含 boundary），只透传鉴权头
    const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: init.headers.Authorization }, body: form, signal: init.signal })
    return finishJson<T>(deps, response, endpoint)
  })
}

/**
 * 调一次 Kenari MCP server 的工具（balance/usage 无 REST 端点，公开 MCP 是唯一程序化入口）。
 * 单次 JSON-RPC，无会话（服务端是无状态模式）；isError 结果转 WEB_KENARI_HTTP。
 */
export async function kenariMcpCall(
  deps: KenariHttpDeps,
  tool: string,
  args: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<string> {
  const body = {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: { name: tool, arguments: args },
  }
  return kenariRequest(deps, 'POST', MCP_ENDPOINT, signal, undefined, async (init) => {
    const response = await fetch(MCP_ENDPOINT, {
      ...init,
      headers: {
        ...init.headers,
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const payload = await finishJson<{ result?: { content?: { type?: string; text?: string }[]; isError?: boolean }; error?: { message?: string } }>(
      deps, response, MCP_ENDPOINT,
    )
    if (payload.error !== undefined) {
      throw kenariWebError('WEB_KENARI_HTTP', `kenari: ${payload.error.message ?? 'MCP 调用失败'}`)
    }
    const text = (payload.result?.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n')
    if (payload.result?.isError === true) {
      throw kenariWebError('WEB_KENARI_HTTP', `kenari: ${text || 'MCP 工具返回错误'}`)
    }
    return text
  })
}

/** 组装鉴权与超时的公共骨架；低层各方法只差请求体与响应解析。 */
async function kenariRequest<T>(
  deps: KenariHttpDeps,
  method: 'GET' | 'POST',
  pathOrUrl: string,
  signal: AbortSignal | undefined,
  opts: KenariRequestOptions | undefined,
  run: (init: RequestInit & { headers: Record<string, string> }, endpoint: string) => Promise<T>,
): Promise<T> {
  const { config } = deps
  // MCP 与站点端点走绝对 URL；REST 端点按 [OI] 线形状补 /v1
  const endpoint = /^https?:\/\//i.test(pathOrUrl)
    ? pathOrUrl
    : restEndpoint(config.baseURL, pathOrUrl)

  if (!URL.canParse(endpoint)) {
    throw kenariWebError('WEB_KENARI_NOT_CONFIGURED', `kenari: baseURL 无法解析：${config.baseURL ?? ''}`)
  }

  // 公开站点端点不要 key：没有 key 的部署也要能读到套餐表这类数据
  const needsKey = opts?.auth ?? true
  const apiKey = needsKey ? await deps.resolveApiKey() : undefined
  if (needsKey && (apiKey === undefined || apiKey.length === 0)) {
    throw kenariWebError('WEB_KENARI_NO_KEY', `kenari: 凭据 ${config.apiKeyEnv ?? 'KENARI_API_KEY'} 未配置`)
  }

  const timeoutMs = opts?.timeoutMs ?? config.timeoutMs ?? 30_000
  const maxRetries = opts?.retries ?? config.maxRetries ?? 2
  const retryTimeouts = opts?.retryTimeouts ?? true
  let lastError: unknown

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // 每次尝试独立超时：AbortSignal.any 组合外部取消与本次定时
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const composed = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    const init = {
      method,
      headers: apiKey === undefined ? {} : { Authorization: `Bearer ${apiKey}` },
      signal: composed,
    } as RequestInit & { headers: Record<string, string> }
    try {
      return await run(init, endpoint)
    } catch (err) {
      // 已包装的 WebError 上抛；标记可重试的 HTTP 状态（429/408/5xx）按退避再试
      if (err instanceof Error && err.name === 'WebError' && 'code' in err) {
        const retryable = (err as WebErrorLike & { retryable?: boolean }).retryable === true
        if (retryable && attempt < maxRetries) {
          lastError = err
          const delayMs = (err as WebErrorLike & { retryDelayMs?: number }).retryDelayMs
          await sleep(delayMs ?? 500 * 2 ** attempt)
          continue
        }
        throw err
      }
      // 外部取消（signal）不该被重试吞掉
      if (signal?.aborted) {
        throw kenariWebError('WEB_CANCELLED', 'kenari: 请求已取消', err)
      }
      // 尝试超时且调用方声明不可重试（生成类）→ 立即上抛，避免重复扣费
      if (isTimeoutError(err) && !retryTimeouts) {
        throw kenariWebError('WEB_KENARI_TIMEOUT', `kenari: 请求超时（${timeoutMs}ms），生成类调用不自动重试以免重复计费`, err)
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

/** [OI] 线 REST 端点拼装：用户配根域时补 /v1，配错形状报 405 的坑在这里消解。 */
function restEndpoint(baseURL: string | undefined, path: string): string {
  const base = baseURL ?? 'https://kenari.id'
  const baseTrimmed = base.replace(/\/+$/, '')
  return baseTrimmed.endsWith('/v1') ? `${baseTrimmed}${path}` : `${baseTrimmed}/v1${path}`
}

/**
 * 站点端点拼装：baseURL 去掉 `/v1` 后再接路径。
 * 用户把 baseURL 配成 `https://kenari.id/v1`（[OI] 线的标准形状），
 * 而站点路由在裸域下，所以这里必须反向归一。
 */
export function siteEndpoint(baseURL: string | undefined, path: string): string {
  const base = (baseURL ?? 'https://kenari.id').replace(/\/+$/, '')
  const bare = base.endsWith('/v1') ? base.slice(0, -3) : base
  return `${bare}${path}`
}

/** 2xx → 解析 JSON；否则按错误信封抛 WEB_KENARI_HTTP。 */
async function finishJson<T>(deps: KenariHttpDeps, response: Response, endpoint: string): Promise<T> {
  if (!response.ok) throw await httpError(deps, response, endpoint)
  return (await response.json()) as T
}

/** 非 2xx → 解析 Kenari 错误信封成 WebError（消息不含 key）；429/408/5xx 标记可重试。 */
async function httpError(deps: KenariHttpDeps, response: Response, endpoint: string): Promise<WebErrorLike> {
  const bodyText = await response.text().catch(() => '')
  const message = extractKenariErrorMessage(bodyText, response.status)
  const err = kenariWebError('WEB_KENARI_HTTP', `kenari: ${message}`, undefined)
  // 记录端点便于诊断（不含 key）
  deps.logger?.warn(`kenari: ${endpoint} → HTTP ${response.status}`)
  if (isRetryableStatus(response.status)) {
    (err as WebErrorLike & { retryable?: boolean }).retryable = true
    const ra = response.headers.get('retry-after')
    if (ra !== null && Number.isFinite(Number(ra))) {
      (err as WebErrorLike & { retryDelayMs?: number }).retryDelayMs = Number(ra) * 1000
    }
  }
  return err
}

/** httpError 返回类型仅为避免循环 import 的结构化别名。 */
type WebErrorLike = Error & { code?: string }
