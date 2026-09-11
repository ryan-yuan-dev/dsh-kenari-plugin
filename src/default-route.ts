/**
 * 默认路由：按当前 key 的套餐把「免缓存额度」模型填进 `kenari` 路由。
 *
 * 背景：`cordis.patch.yml` 是**静态 YAML**，没法在运行时按 key 的套餐算出默认值，
 * 所以预设只放一份兜底清单（`deepseek-v4-flash` / `glm-5-3-flash` / `gpt-5-6-luna`
 * / `mimo-v2-5`，正好是 Kreator 与 Studio 两档的免费缓存模型）。真正的默认值在这里算：
 *
 * 1. 用户层已经自己写过 `providers.kenari.models` → 一律不动（用户的东西最大）
 * 2. 取不到 key、`/v1/account/quota` 失败或 `plan` 为 null → 保持预设（不写设置）
 * 3. 拿到套餐名 → 从套餐表取该套餐的 `free_cache_models` → 逐个查目录补全 profile
 * 4. 算出来的集合与预设**一致**时不写设置——否则每次启动都把同样的清单固化进
 *    `settings.yaml`，纯属污染；只有真的不一样（如 Indie 只有 2 个）才写一次
 *
 * 写进去之后就变成用户层覆盖，下次启动第 1 步直接返回，所以这是**一次性的物化**，
 * 不会反复改写；用户在 Models 页改过之后也永远不会被这里覆盖。
 * @module dsh-kenari-plugin/default-route
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: 拉入 ctx.settings 的 Context 声明合并
import type {} from '@deepseek-ai/dsh-settings'
import type { SettingsDescriptor } from '@deepseek-ai/dsh-settings'
import { isChatCapable, toModelProfile } from './catalog.js'
import type { KenariCatalog } from './catalog.js'
import type { KenariPlans } from './plans.js'
import { kenariGet } from './http.js'
import type { KenariHttpDeps } from './http.js'

/** pi-ai 的 profile 数组路径（相对 `llm-pi-ai` 节根）。 */
const ROUTE = { ns: 'llm-pi-ai', provider: 'kenari' } as const
const MODELS_PATH = ['providers', ROUTE.provider, 'models'] as const

/** `GET /v1/account/quota` 里我们只关心套餐名。 */
interface QuotaResponse {
  plan?: { name?: string } | null
}

/** 读取依赖。 */
export interface DefaultRouteDeps {
  readonly http: KenariHttpDeps
  readonly catalog: KenariCatalog
  readonly plans: KenariPlans
}

/** 嵌套取值：路径上任何一段不是对象就返回 undefined。 */
function pathGet(root: unknown, path: readonly string[]): unknown {
  let node: unknown = root
  for (const segment of path) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[segment]
  }
  return node
}

/** 一条 `models` 数组里的 id 列表（形状不对就当空）。 */
function idsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => (typeof entry === 'object' && entry !== null ? (entry as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === 'string')
}

/** 两个 id 列表是否同集合（顺序无关，重复无关）。 */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const left = [...a].sort()
  const right = [...b].sort()
  return left.every((id, index) => id === right[index])
}

/**
 * 按套餐算一次默认路由；只在需要且能算出来时写设置。
 * 任何失败都只记日志：默认值算不出来不该影响插件其余能力。
 * @param ctx - 已注入 `settings` 的上下文。
 * @param deps - 目录、套餐表与 HTTP 依赖。
 */
export async function applyPlanDefaultRoute(ctx: Context, deps: DefaultRouteDeps): Promise<void> {
  const log = deps.http.logger
  try {
    const descriptors = ctx.settings.describe({ redactSecrets: true })
    const entry: SettingsDescriptor | undefined = descriptors.find((descriptor) => descriptor.ns === ROUTE.ns)
    if (entry === undefined) return

    // 用户自己写过这个数组 → 永远不碰
    if (Array.isArray(pathGet(entry.user, MODELS_PATH))) {
      log?.info('kenari: 路由模型列表由用户层持有，跳过默认值计算')
      return
    }
    const presetIds = idsOf(pathGet(entry.base, MODELS_PATH))

    const apiKey = await deps.http.resolveApiKey()
    if (apiKey === undefined || apiKey.length === 0) {
      log?.info('kenari: 未配置 key，路由保持预置的默认模型')
      return
    }

    const quota = await kenariGet<QuotaResponse>(deps.http, '/account/quota').catch(() => undefined)
    const planName = quota?.plan?.name
    if (typeof planName !== 'string' || planName.length === 0) {
      log?.info('kenari: 该 key 读不到套餐（无套餐或分享页 key），路由保持预置的默认模型')
      return
    }

    const plan = (await deps.plans.list()).find((candidate) => candidate.name === planName)
    const freeCacheIds = plan?.freeCacheModels ?? []
    if (freeCacheIds.length === 0) {
      log?.info(`kenari: 套餐 ${planName} 没有免缓存模型清单，路由保持预置的默认模型`)
      return
    }

    // 目录补全：只收可当会话模型的（免缓存清单里可能混入 embedding 之类），
    // 目录里查不到的 id 直接丢——写进路由只会在请求时才发现不可用。
    const profiles = []
    for (const id of freeCacheIds) {
      const resolved = await deps.catalog.resolve(id)
      if (resolved === undefined || !isChatCapable(resolved.model)) continue
      profiles.push(toModelProfile(resolved.model))
    }
    if (profiles.length === 0) {
      log?.warn(`kenari: 套餐 ${planName} 的免缓存模型在目录里一个都对不上，路由保持预置的默认模型`)
      return
    }

    const nextIds = profiles.map((profile) => profile.id)
    if (sameIds(nextIds, presetIds)) {
      log?.info(`kenari: 套餐 ${planName} 的免缓存模型与预置默认一致（${nextIds.length} 个），无需写入设置`)
      return
    }

    await ctx.settings.mutate(
      ROUTE.ns,
      [{ op: 'set', path: [...MODELS_PATH], value: profiles }],
      entry.revision,
    )
    log?.info(`kenari: 已按套餐 ${planName} 的免缓存模型写入默认路由（${nextIds.length} 个）`)
  } catch (err) {
    // 默认值写不进去只是没默认值，不该影响插件加载
    deps.http.logger?.warn(`kenari: 默认路由计算失败，保持预置默认：${err instanceof Error ? err.message : String(err)}`)
  }
}
