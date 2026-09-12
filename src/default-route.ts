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
import { DISPLAY_NAME_PREFIX, displayNameOf, isChatCapable, toModelProfile } from './catalog.js'
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

/** 名字刷新只用到目录（判据是"这行还是不是旧口径的名字"）与日志。 */
export interface RouteNameDeps {
  readonly http: KenariHttpDeps
  readonly catalog: KenariCatalog
}

/**
 * 把**已经物化进用户层**的旧名字刷成当前口径。
 *
 * 为什么需要它：路由模型名由 `toModelProfile` 加前缀，但设置是**一次性物化**的——
 * {@link applyPlanDefaultRoute} 只在用户层没写过数组时才写，挑选器加模型也只 append、
 * 不覆盖已存在的 id。所以口径一变（0.2.0 起加 `Kenari ` 前缀），已经写进去的那批名字
 * 会永远停在旧口径，除非用户自己一个个改。
 *
 * 改写判据刻意收得很紧：**只动仍然逐字等于旧口径派生值的名字**（`displayNameOf` 的输出，
 * 见 src/catalog.ts）——也就是"这一行还是插件当初写的那一行"。用户改过的名字（改名、
 * 清空、或者已经带前缀）不匹配，一个字节都不碰。判据是值本身，而不是"这行是不是插件
 * 写的"：后者没有留存，也无法可靠推断。
 *
 * 写入形状与挑选器一致：`set` 整份数组（pi-ai 的语义是存下来的数组整份替换生效值），
 * 所以必须带上用户层里的全部条目，且只改 `name` 一个字段。
 * @param ctx - 已注入 `settings` 的上下文。
 * @param deps - 目录与日志依赖。
 */
export async function refreshRouteModelNames(ctx: Context, deps: RouteNameDeps): Promise<void> {
  const log = deps.http.logger
  try {
    const descriptors = ctx.settings.describe({ redactSecrets: true })
    const entry: SettingsDescriptor | undefined = descriptors.find((descriptor) => descriptor.ns === ROUTE.ns)
    if (entry === undefined) return

    const stored = pathGet(entry.user, MODELS_PATH)
    // 用户层没有这个数组 = 还没物化过，生效值就是 patch 里那份，本身已是当前口径。
    if (!Array.isArray(stored)) return

    let refreshed = 0
    const next: unknown[] = []
    for (const row of stored) {
      const record = typeof row === 'object' && row !== null ? row as Record<string, unknown> : undefined
      const id = record?.id
      const name = record?.name
      if (record === undefined || typeof id !== 'string' || typeof name !== 'string') {
        next.push(row)
        continue
      }
      const resolved = await deps.catalog.resolve(id)
      // 查不到的 id 不动：它可能是用户手写的路由条目，插件没有资格替它改名。
      if (resolved === undefined || name !== displayNameOf(resolved.model)) {
        next.push(row)
        continue
      }
      next.push({ ...record, name: DISPLAY_NAME_PREFIX + name })
      refreshed += 1
    }
    if (refreshed === 0) return

    await ctx.settings.mutate(
      ROUTE.ns,
      [{ op: 'set', path: [...MODELS_PATH], value: next }],
      entry.revision,
    )
    log?.info(`kenari: 已把路由里 ${refreshed} 个模型名刷成当前口径（加 ${DISPLAY_NAME_PREFIX}前缀）`)
  } catch (err) {
    // 名字没刷新只是名字旧，不影响任何请求
    deps.http.logger?.warn(`kenari: 路由模型名刷新失败，保持原样：${err instanceof Error ? err.message : String(err)}`)
  }
}
