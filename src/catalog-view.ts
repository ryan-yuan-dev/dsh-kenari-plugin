/**
 * 浏览器侧模型浏览器的数据端点：`GET /api/kenari.models`。
 *
 * 为什么需要它：浏览器只装得下已经存在的 Remote 命名空间，而 dsh 没有任何一个
 * 能承载"每模型能力标签 + 套餐归属"的命名空间（新增一个要动 dsh 的 api-remotes 装配）。
 * 但 dsh 的 Connection 服务给了插件一个**同源 Fetch 路由**注册点，
 * 于是浏览器可以直接读本端点的 JSON——数据仍全部在 Host 侧算，浏览器不解析 Kenari。
 *
 * 鉴权由 dsh 的 Connection 层负责（Host/Origin 围栏 + 浏览器会话），
 * 所以这里假定"能到达本处理器就是可信的同源页面"。
 * @module dsh-kenari-plugin/catalog-view
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: 拉入 ctx.connection 的 Context 声明合并（Fetch 路由注册点的宿主）
import type {} from '@deepseek-ai/dsh-client-connection'
import {
  CAPABILITY_TAGS, capabilityTagsOf, displayNameOf, isChatCapable, isFreeModel, toModelProfile,
} from './catalog.js'
import type { CapabilityTag, KenariCatalog, KenariModel } from './catalog.js'
import { coverageOf } from './plans.js'
import type { KenariPlans } from './plans.js'
import type { KenariHttpDeps } from './http.js'

/** 浏览器读取模型视图的路径（Connection 的 Fetch 路由要求落在 `/api/` 下）。 */
export const KENARI_MODEL_VIEW_PATH = '/api/kenari.models'

/** 本端点的依赖。 */
export interface CatalogViewDeps {
  readonly http: KenariHttpDeps
  readonly catalog: KenariCatalog
  readonly plans: KenariPlans
}

/** 一个模型的浏览器视图：目录事实 + 派生标签 + 可直接写入路由的 profile。 */
interface ModelView {
  id: string
  /**
   * 展示名，**不是**目录原样给的 `name`。
   *
   * 目录里只有 8 个模型带 `name`，其余 70 多个要按 id 还原（见 `displayNameOf`）。
   * 若这里原样透传，无名模型的 `name` 就等于 id，界面把 id 印两遍；而同一个模型的
   * `profile.name` 又已经是派生名——同一份数据里两个口径，改这里就是为了消掉它。
   *
   * 这一列给的是**模型自己的名字**（不带路由前缀）：插件这一页整页都在 Kenari 节里，
   * 每行再写一遍 Kenari 是噪音。前缀只加在 {@link ModelView.profile} 的 `name` 上，
   * 那是写进路由、由 dsh 印在模型按钮与会话头部的那个字符串。
   */
  name: string
  ownedBy?: string
  contextWindow?: number
  free: boolean
  beta: boolean
  sunsetAt?: number
  chatCapable: boolean
  endpoints: string[]
  input: string[]
  tags: CapabilityTag[]
  plans: string[]
  freeCachePlans: string[]
  profile: ReturnType<typeof toModelProfile>
}

/** 一次视图响应。`plansError` 非空表示套餐维度缺失，界面据此只降级标签。 */
export interface CatalogView {
  generatedAt: number
  plans: { id: string; name: string; priceIdr?: number; modelCount: number }[]
  plansError?: string
  tags: readonly CapabilityTag[]
  models: ModelView[]
}

/** 目录行 → 浏览器视图行。 */
function toView(model: KenariModel, coverage: Map<string, { plans: string[]; freeCachePlans: string[] }>): ModelView {
  const covered = coverageOf(coverage, model.id)
  return {
    id: model.id,
    name: displayNameOf(model),
    ...(model.owned_by === undefined ? {} : { ownedBy: model.owned_by }),
    ...(typeof model.context_length === 'number' ? { contextWindow: model.context_length } : {}),
    free: isFreeModel(model),
    beta: model.beta === true,
    ...(typeof model.sunset_at === 'number' && model.sunset_at > 0 ? { sunsetAt: model.sunset_at } : {}),
    chatCapable: isChatCapable(model),
    endpoints: model.endpoints ?? [],
    input: model.modalities?.input ?? [],
    tags: capabilityTagsOf(model),
    plans: covered.plans,
    freeCachePlans: covered.freeCachePlans,
    profile: toModelProfile(model),
  }
}

/**
 * 组装一次完整视图。
 *
 * 目录是必需事实（失败即端点失败）；套餐表是可选事实（失败只标记 `plansError`），
 * 因为模型目录公开且稳定，而套餐表是站点路由、形状随时可能变。
 */
export async function buildCatalogView(deps: CatalogViewDeps, signal?: AbortSignal): Promise<CatalogView> {
  const [catalogModels, embeddingModels] = await Promise.all([
    deps.catalog.list(undefined, signal),
    deps.catalog.list('embedding', signal),
  ])
  const seen = new Set<string>()
  const models: KenariModel[] = []
  for (const model of [...catalogModels, ...embeddingModels]) {
    if (seen.has(model.id)) continue
    seen.add(model.id)
    models.push(model)
  }

  let plans: CatalogView['plans'] = []
  let plansError: string | undefined
  let coverage = new Map<string, { plans: string[]; freeCachePlans: string[] }>()
  try {
    const listed = await deps.plans.list(signal)
    coverage = await deps.plans.coverage(signal)
    plans = listed.map((plan) => ({
      id: plan.id,
      name: plan.name,
      ...(plan.priceIdr === undefined ? {} : { priceIdr: plan.priceIdr }),
      modelCount: plan.scopeModels.length,
    }))
  } catch (err) {
    plansError = err instanceof Error ? err.message : String(err)
    deps.http.logger?.warn(`kenari: 套餐表读取失败，模型视图只显示能力标签：${plansError}`)
  }

  return {
    generatedAt: Date.now(),
    plans,
    ...(plansError === undefined ? {} : { plansError }),
    tags: CAPABILITY_TAGS,
    models: models.map((model) => toView(model, coverage)),
  }
}

/** 一次 GET/HEAD 的响应；HEAD 只回头部（路由契约要求同时支持两者）。 */
async function viewResponse(deps: CatalogViewDeps, request: Request): Promise<Response> {
  let body: CatalogView
  try {
    body = await buildCatalogView(deps, request.signal)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    deps.http.logger?.warn(`kenari: 模型视图端点失败：${message}`)
    return Response.json({ error: message }, { status: 502 })
  }
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
  return new Response(JSON.stringify(body), { status: 200, headers })
}

/**
 * 注册模型视图路由。
 *
 * `connection` 是 web profile 才有的服务，所以在缺它的部署里静默跳过——
 * 插件其余能力（工具、web provider、设置节）不依赖浏览器。
 */
export function registerCatalogView(ctx: Context, deps: CatalogViewDeps): void {
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.connection.fetch.register({
      path: KENARI_MODEL_VIEW_PATH,
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: (request) => viewResponse(deps, request),
    })
  })
}
