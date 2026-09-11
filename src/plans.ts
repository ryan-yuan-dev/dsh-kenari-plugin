/**
 * Kenari 套餐表：`GET /api/plans` 同步 + TTL 缓存 + 模型覆盖索引。
 *
 * 这是**站点**端点（不在 `/v1` 下、不需要 key），官网的「Langganan」页就是读它渲染的；
 * 每个套餐给一份 `scope_models`——请求命中覆盖列表里的模型才从套餐额度扣，
 * 否则直接走预付余额。所以「这个模型哪些套餐能用」只有一个事实来源，就是这里。
 *
 * 形状比 API 线宽松：字段缺失、整体 404、官网改版都按"套餐数据不可用"处理，
 * 需要它的界面降级为只显示能力标签，而不是把插件判为故障。
 * @module dsh-kenari-plugin/plans
 */

import { kenariPublicGet, siteEndpoint } from './http.js'
import type { KenariHttpDeps } from './http.js'

/** 套餐端点路径（相对裸域）。 */
const PLANS_PATH = '/api/plans'

/** 一个订阅套餐：价格与它覆盖的模型列表。 */
export interface KenariPlan {
  id: string
  name: string
  /** 价格（IDR）；0 表示免费档。目录未公布时为 undefined。 */
  priceIdr?: number
  /** 覆盖的模型 id（裸 id，不带 `:free` 后缀）。 */
  scopeModels: string[]
  /** 该套餐下缓存读取不计额度的模型 id。 */
  freeCacheModels: string[]
}

/** 模型 id 的套餐归属：套餐名列表（含免费缓存标记）。 */
export interface PlanCoverage {
  /** 覆盖该模型的套餐名，按套餐表顺序。 */
  plans: string[]
  /** 其中对该模型免缓存读额度的套餐名。 */
  freeCachePlans: string[]
}

/** 去掉 `:free` 后缀：套餐表用裸 id，目录用带后缀的 id，join 前必须归一。 */
function bareId(id: string): string {
  return id.endsWith(':free') ? id.slice(0, -5) : id
}

/** 宽松解析一行套餐；缺 id/name 的行直接丢弃（不猜）。 */
function parsePlan(row: unknown): KenariPlan | undefined {
  if (typeof row !== 'object' || row === null) return undefined
  const record = row as Record<string, unknown>
  const id = record.id
  const name = record.name
  if (typeof id !== 'string' || id.length === 0) return undefined
  if (typeof name !== 'string' || name.length === 0) return undefined
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
  return {
    id,
    name,
    ...(typeof record.price_idr === 'number' ? { priceIdr: record.price_idr } : {}),
    scopeModels: strings(record.scope_models),
    freeCacheModels: strings(record.free_cache_models),
  }
}

/**
 * 套餐表客户端：进程内 TTL 缓存（复用 `catalogCacheTtlMs`——两者都是"Kenari 的目录类事实"）。
 * 并发请求合并到同一次抓取。
 */
export class KenariPlans {
  private cache: { plans: KenariPlan[]; fetchedAt: number } | undefined
  private inflight: Promise<KenariPlan[]> | undefined

  constructor(private readonly deps: KenariHttpDeps) {}

  /** 缓存有效期取自实时配置：设置页改完下一次读取即生效。 */
  private get ttlMs(): number {
    return this.deps.config.catalogCacheTtlMs ?? 3_600_000
  }

  /**
   * 抓取套餐表（公开端点，无需 key）。
   * 失败上抛：调用方按"套餐数据缺失"降级，不要让它挡住模型目录。
   */
  async list(signal?: AbortSignal): Promise<KenariPlan[]> {
    const cached = this.cache
    const ttlMs = this.ttlMs
    if (ttlMs > 0 && cached !== undefined && Date.now() - cached.fetchedAt < ttlMs) {
      return cached.plans
    }
    if (this.inflight !== undefined) return this.inflight
    const request = kenariPublicGet<unknown>(this.deps, siteEndpoint(this.deps.config.baseURL, PLANS_PATH), signal, { retries: 1 })
      .then((payload) => {
        const rows = Array.isArray(payload)
          ? payload
          : (typeof payload === 'object' && payload !== null && Array.isArray((payload as { data?: unknown }).data)
            ? (payload as { data: unknown[] }).data
            : [])
        const plans = rows.map(parsePlan).filter((plan): plan is KenariPlan => plan !== undefined)
        this.cache = { plans, fetchedAt: Date.now() }
        return plans
      })
      .finally(() => {
        this.inflight = undefined
      })
    this.inflight = request
    return request
  }

  /**
   * 模型 id → 套餐归属索引。
   *
   * 索引键同时收裸 id 与 `:free` 形式：套餐表写 `hy3`，目录里 `hy3` 与 `hy3:free`
   * 都可能是可路由的模型，两者都该算被覆盖。
   */
  async coverage(signal?: AbortSignal): Promise<Map<string, PlanCoverage>> {
    const plans = await this.list(signal)
    const index = new Map<string, PlanCoverage>()
    const record = (id: string, planName: string, freeCache: boolean): void => {
      for (const candidate of id.endsWith(':free') ? [id] : [id, `${id}:free`]) {
        const entry = index.get(candidate) ?? { plans: [], freeCachePlans: [] }
        const bucket = freeCache ? entry.freeCachePlans : entry.plans
        if (!bucket.includes(planName)) bucket.push(planName)
        index.set(candidate, entry)
      }
    }
    for (const plan of plans) {
      for (const id of plan.scopeModels) record(id, plan.name, false)
      for (const id of plan.freeCacheModels) record(id, plan.name, true)
    }
    return index
  }

  /** 清空缓存（测试与强制刷新用）。 */
  invalidate(): void {
    this.cache = undefined
  }
}

/** 覆盖查询：先按原 id，再按裸 id（目录带 `:free`、套餐表不带的场景）。 */
export function coverageOf(index: Map<string, PlanCoverage>, modelId: string): PlanCoverage {
  return index.get(modelId) ?? index.get(bareId(modelId)) ?? { plans: [], freeCachePlans: [] }
}
