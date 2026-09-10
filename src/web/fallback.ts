/**
 * 组合 provider：Kenari 优先，调用失败后回退 dsh 默认 provider。
 * web seam 无回退链（硬约束 6），回退只能在调用失败后发生；
 * 兜底实例只实例化不注册（硬约束 3）。
 * @module dsh-kenari-plugin/web/fallback
 */

import { DeepSeekSearchProvider } from '@deepseek-ai/dsh-web-search-deepseek'
import { HttpFetchProvider } from '@deepseek-ai/dsh-web-fetch-http'
import type {
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
} from '@deepseek-ai/dsh-web'

/** 回退日志的最小形状（ctx.logger 满足）。 */
export interface FallbackLogger {
  warn(msg: string): void
  info(msg: string): void
}

/** 一次回退的方向、原因与耗时，供验证 ④ 与排障。 */
interface FallbackOutcome {
  direction: string
  reason: string
  elapsedMs: number
}

function logFallback(logger: FallbackLogger | undefined, outcome: FallbackOutcome): void {
  logger?.warn(`kenari-fallback: ${outcome.direction} 失败后回退（${outcome.reason}，${outcome.elapsedMs}ms）`)
}

/**
 * Kenari 优先搜索。Kenari available() 恒真（key 缺失在调用时以 WebError 暴露，
 * 因为 available() 禁止网络请求），所以选择权在 seam，回退在本类内部完成。
 */
export class KenariFirstSearch implements WebSearchProvider {
  readonly id = 'kenari-fallback'

  constructor(
    private readonly kenari: WebSearchProvider,
    // 兜底实例：import 自 dsh 包入口，只实例化不注册（id 冲突会抛 WEB_DUPLICATE_PROVIDER）
    private readonly official: DeepSeekSearchProvider,
    private readonly logger?: FallbackLogger,
  ) {}

  /** Kenari 或官方任一可用即选择本组合 provider。 */
  available(): boolean {
    return this.kenari.available() || this.official.available()
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const start = Date.now()
    try {
      return await this.kenari.search(request, signal)
    } catch (err) {
      logFallback(this.logger, {
        direction: `search "${request.query}"`,
        reason: String(err),
        elapsedMs: Date.now() - start,
      })
      return this.official.search(request, signal)
    }
  }
}

/** Kenari 优先抓取，回退到本地匿名 HTTP provider。 */
export class KenariFirstFetch implements WebFetchProvider {
  readonly id = 'kenari-fallback'

  constructor(
    private readonly kenari: WebFetchProvider,
    // 同上：只实例化不注册
    private readonly local: HttpFetchProvider,
    private readonly logger?: FallbackLogger,
  ) {}

  available(): boolean {
    // 本地 fetch provider 无凭据语义，available() 恒真
    return this.kenari.available() || this.local.available()
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    const start = Date.now()
    try {
      return await this.kenari.fetch(request, signal)
    } catch (err) {
      logFallback(this.logger, {
        direction: `fetch "${request.url}"`,
        reason: String(err),
        elapsedMs: Date.now() - start,
      })
      return this.local.fetch(request, signal)
    }
  }
}
