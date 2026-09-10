/**
 * Kenari web 搜索 provider：`POST /v1/web/search` 映射为 seam 的 WebSearchProvider。
 * available() 只做本地检查（硬约束 5）；字段映射集中在文件顶部便于跟进 rc 变动。
 * @module dsh-kenari-plugin/web/search
 */

import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import type { KenariHttpDeps } from '../http.js'
import { kenariPost, type KenariSearchResponse } from '../http.js'

/** Kenari `max_results` 上限（OpenAPI 1–10，默认 5）。 */
const KENARI_MAX_RESULTS = 10
const KENARI_DEFAULT_RESULTS = 5

/** seam 词汇 → Kenari 请求的映射要点（对照知识库 kenari-api.md）。 */
export const KENARI_SEARCH_PROVIDER_ID = 'kenari-fallback'

/** 计费回调：web 搜索按次扣费，记进共享账本（无会话归属，落 global 作用域）。 */
export type RecordWebSpend = (microIdr: number, kind: 'search' | 'fetch') => void

export class KenariSearchProvider implements WebSearchProvider {
  readonly id = KENARI_SEARCH_PROVIDER_ID

  constructor(
    private readonly deps: KenariHttpDeps,
    private readonly recordSpend?: RecordWebSpend,
  ) {}

  /** key 现场解析，本地判定可用性；不发网络请求。 */
  available(): boolean {
    return true
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const maxResults = Math.min(request.maxResults ?? KENARI_DEFAULT_RESULTS, KENARI_MAX_RESULTS)
    const response = await kenariPost<KenariSearchResponse>(
      this.deps,
      '/web/search',
      { query: request.query, max_results: maxResults },
      signal,
    )
    if (typeof response.cost_micro_idr === 'number') this.recordSpend?.(response.cost_micro_idr, 'search')
    const results = response.results ?? []
    // content 字段为 Kenari 的条目摘要，映射到 snippet；顶层 content 留空（seam 语义：provider 生成答案）
    const sources: WebSearchSource[] = results.flatMap((item) => {
      if (item.url === undefined) return []
      return [{
        url: item.url,
        title: item.title,
        snippet: item.content,
      }]
    })
    return {
      sources,
      // seam 在返回时按 maxResults 截断；provider 未截断则为 false
      truncated: false,
    }
  }
}
