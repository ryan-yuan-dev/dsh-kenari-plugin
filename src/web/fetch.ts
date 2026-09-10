/**
 * Kenari web 抓取 provider：`POST /v1/web/fetch` 映射为 seam 的 WebFetchProvider。
 * Kenari 返回纯文本正文；seam 的非 2xx 是结果不是错误，这里恒报 200（Kenari 已代抓）。
 * @module dsh-kenari-plugin/web/fetch
 */

import type { WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'
import type { KenariHttpDeps } from '../http.js'
import { kenariPost, type KenariFetchResponse } from '../http.js'

export const KENARI_FETCH_PROVIDER_ID = 'kenari-fallback'

/** fetch 正文尾部最多附带的链接数，防 links[] 过长污染上下文。 */
const MAX_APPENDED_LINKS = 20

export class KenariFetchProvider implements WebFetchProvider {
  readonly id = KENARI_FETCH_PROVIDER_ID

  constructor(private readonly deps: KenariHttpDeps) {}

  /** key 现场解析，本地判定可用性；不发网络请求。 */
  available(): boolean {
    return true
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    const response = await kenariPost<KenariFetchResponse>(
      this.deps,
      '/web/fetch',
      { url: request.url },
      signal,
    )
    const links = response.links ?? []
    const bodyParts = [response.content ?? '']
    if (links.length > 0) {
      // links[] 附正文尾部（任务包要求），空行分隔便于 consumer 展示
      bodyParts.push('', links.slice(0, MAX_APPENDED_LINKS).join('\n'))
    }
    return {
      url: request.url,
      // Kenari 代抓正文成功即视为 200；目标站错误已在 Kenari 侧消化为正文内容
      statusCode: 200,
      body: { kind: 'text', content: bodyParts.join('\n') },
      truncated: false,
    }
  }
}
