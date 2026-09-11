/**
 * 浏览器侧 Kenari 图标的同源端点：`GET /api/kenari.favicon`。
 *
 * 为什么要有这个端点：设置面板左侧导航的图标由 dsh 的 shell 画（`navIcon(row.id)`
 * 是写死的 id 分支），而 section 注册项只有 `{ id, order, label }`，没有图标字段——
 * 插件加不进去。能加进去的只有 DOM，所以图标由浏览器半边自己贴（见 `client/index.js`）。
 * 但客户端 bundle 没有打包器：loader 只读 `exports["./client"]` 这一个文件，图片引用
 * 拿不到可用的 URL。于是图标留在 `assets/` 里，浏览器像读模型视图一样向 Host 要它。
 *
 * 这与模型视图补的是同一种缺口，所以走同一条路：Connection 的 Fetch 路由。
 * `connection` 是 web profile 才有的服务；没有它的部署不会提供图标，
 * 浏览器半边会退回 dsh 自己的齿轮图标（不贴标签就什么都不改）。
 * @module dsh-kenari-plugin/favicon
 */

import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: 拉入 ctx.connection 的 Context 声明合并（Fetch 路由注册点的宿主）
import type {} from '@deepseek-ai/dsh-client-connection'

/** 浏览器读取图标的路径（Connection 的 Fetch 路由要求落在 `/api/` 下）。 */
export const KENARI_FAVICON_PATH = '/api/kenari.favicon'

/**
 * 图标本体：包内 `assets/kenari-favicon-128.png`（128×128）。
 * `lib/favicon.js` 与 `src/favicon.ts` 都在包根下一层，所以 `../assets` 两条路都对。
 */
const FAVICON_FILE = new URL('../assets/kenari-favicon-128.png', import.meta.url)

/** 进程内文件不会变，第二次读没有意义；失败也不缓存，下次请求还会再试。 */
let cached: Promise<Buffer> | undefined

function faviconBytes(): Promise<Buffer> {
  const pending = cached ?? readFile(FAVICON_FILE)
  cached = pending
  return pending.catch((err: unknown) => {
    cached = undefined
    throw err
  })
}

async function faviconResponse(request: Request): Promise<Response> {
  let bytes: Buffer
  try {
    bytes = await faviconBytes()
  } catch (err) {
    // 打包漏掉 assets/ 时走到这里。回 404 而不是抛错：浏览器半边据此保持
    // dsh 自己的图标，而"图标没贴上去"不该让设置页整个坏掉。
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ error: message }, { status: 404 })
  }
  const headers = {
    'content-type': 'image/png',
    'content-length': String(bytes.byteLength),
    'cache-control': 'public, max-age=86400',
  }
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
  return new Response(bytes, { status: 200, headers })
}

/**
 * 注册图标路由。
 *
 * 无 connection 服务时静默跳过——图标只是界面装饰，插件其余能力不依赖它。
 */
export function registerFaviconRoute(ctx: Context): void {
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.connection.fetch.register({
      path: KENARI_FAVICON_PATH,
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: (request) => faviconResponse(request),
    })
  })
}
