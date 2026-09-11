/**
 * 设置导航图标端点（`src/favicon.ts` → `GET /api/kenari.favicon`）离线实测。
 *
 * 跑的是 Host 侧真代码路径：真路由注册、真读 `assets/` 里的 PNG、真回 Response。
 * 这里最值得钉住的是**资源路径**：`lib/favicon.js` 用 `new URL('../assets/…', import.meta.url)`
 * 定位图片，一旦目录挪了或 `package.json` 的 `files` 漏了 `assets/`，路由会静默回 404，
 * 而浏览器半边会 fail-open 回 dsh 自己的齿轮——不报错，只是图标没了。
 * 所以本测试直接断言"从 lib/ 编译产物出发能读到 PNG 且它是 PNG"。
 *
 * 不联网。
 * 运行：node test/favicon.mjs
 */
import { KENARI_FAVICON_PATH, registerFaviconRoute } from '../lib/favicon.js'

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
  if (!ok) failures++
}

/** 假 ctx：记录 `inject` 的服务名，并在回调里给出假 connection。 */
function makeRig() {
  const routes = []
  const injected = []
  const connectionCtx = {
    connection: {
      fetch: {
        register: (route) => {
          routes.push(route)
          return async () => {}
        },
      },
    },
  }
  const ctx = {
    inject: (services, callback) => {
      injected.push(services)
      callback(connectionCtx)
    },
  }
  return { ctx, routes, injected }
}

const { ctx, routes, injected } = makeRig()
registerFaviconRoute(ctx)

check('注册只注入 connection（非 web 部署自动跳过）',
  injected.length === 1 && injected[0].length === 1 && injected[0][0] === 'connection',
  JSON.stringify(injected))
check('注册恰好一条路由', routes.length === 1, `${routes.length} 条`)
check('路径落在 /api 下且与浏览器半边一致',
  routes[0]?.path === KENARI_FAVICON_PATH && KENARI_FAVICON_PATH === '/api/kenari.favicon',
  routes[0]?.path)
check('同时接受 GET 与 HEAD',
  routes[0]?.methods.join(',') === 'GET,HEAD', routes[0]?.methods?.join(','))
check('请求体走 buffered（无 body 可读）', routes[0]?.requestBody === 'buffered', routes[0]?.requestBody)

const route = routes[0]
const get = await route.fetch(new Request(`http://localhost${KENARI_FAVICON_PATH}`))
const bytes = new Uint8Array(await get.arrayBuffer())

check('GET 回 200', get.status === 200, String(get.status))
check('内容类型是 PNG', get.headers.get('content-type') === 'image/png', get.headers.get('content-type'))
check('有缓存头（图标不该每次开设置都重下）',
  (get.headers.get('cache-control') ?? '').includes('max-age'), get.headers.get('cache-control'))
// PNG 签名：89 50 4E 47。断言的是"读到的是那张图"，不是"读到了若干字节"。
check('响应体是 PNG 本体',
  bytes.length > 0 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47,
  `${bytes.length} 字节, 头 ${Array.from(bytes.slice(0, 4)).map((b) => b.toString(16)).join(' ')}`)
check('content-length 与实际字节数一致',
  get.headers.get('content-length') === String(bytes.length),
  `${get.headers.get('content-length')} vs ${bytes.length}`)

const head = await route.fetch(new Request(`http://localhost${KENARI_FAVICON_PATH}`, { method: 'HEAD' }))
check('HEAD 回 200 且不带 body', head.status === 200 && (await head.text()) === '', String(head.status))

// 第二次请求复用已缓存的字节，仍然是一张可用的 PNG（缓存没把 body 用坏）
const again = await route.fetch(new Request(`http://localhost${KENARI_FAVICON_PATH}`))
const againBytes = new Uint8Array(await again.arrayBuffer())
check('重复请求返回同样大小的 PNG', againBytes.length === bytes.length, `${againBytes.length} 字节`)

if (failures > 0) {
  console.error(`\nfavicon route test failed: ${failures} assertion(s)`)
  process.exit(1)
}
console.log('\nfavicon route test passed')
