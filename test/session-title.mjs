/**
 * 会话标题前缀（`src/session-title.ts`）离线实测。
 *
 * 跑真代码路径：真模板渲染、真前缀剥离、真 defer + 幂等。用假 ctx / 假 Session
 * 复刻 dsh 的两条契约：`append` 之后同步派发 `session/event`，以及
 * `session/created` 在 fork 子会话上先于任何 rename 到达。
 *
 * 不联网。
 * 运行：node test/session-title.mjs
 */
import { renderTitlePrefix, validateSessionTitlePrefix, installSessionTitlePrefix } from '../lib/session-title.js'

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
  if (!ok) failures++
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const byteLength = (value) => Buffer.byteLength(value, 'utf8')

/** 假 ctx + 假 sessions：append 之后同步派发 session/event，与 dsh 一致。 */
function makeRig() {
  const store = new Map()
  const listeners = new Map()
  const emit = (name, ...args) => {
    for (const callback of listeners.get(name) ?? []) callback(...args)
  }
  const ctx = {
    get: (name) => (name === 'sessions' ? { get: (id) => store.get(id) } : undefined),
    logger: { warn: (...args) => console.log('  [warn]', ...args) },
    on: (name, callback) => {
      const list = listeners.get(name) ?? []
      list.push(callback)
      listeners.set(name, list)
    },
  }
  const session = (id, createdAt, options = {}) => {
    const events = [...(options.seed ?? [])]
    const handle = {
      id,
      header: {
        createdAt,
        ...(options.parentSession === undefined ? {} : { parentSession: options.parentSession }),
      },
      snapshotEvents: () => events,
      append: (type, data) => {
        const event = { type, seq: events.length, data }
        events.push(event)
        emit('session/event', handle, event)
      },
      events,
    }
    store.set(id, handle)
    return handle
  }
  return { ctx, emit, session, store }
}

const titleData = (title, source = { kind: 'fallback' }, messageSeqs = [3]) => ({ title, messageSeqs, source })
const latestTitle = (session) => session.snapshotEvents().findLast((event) => event.type === 'session/title')?.data
const titleEvents = (session) => session.snapshotEvents().filter((event) => event.type === 'session/title')

// ---------------------------------------------------------------------------
// 1) 模板渲染
// ---------------------------------------------------------------------------
const CREATED = new Date(2026, 8, 11, 15, 30, 45).getTime() // 本机时区
check('默认模板渲染成本机 yyyyMMddHHmmss-', renderTitlePrefix('yyyyMMddHHmmss-', CREATED) === '20260911153045-',
  renderTitlePrefix('yyyyMMddHHmmss-', CREATED))
check('同一 Date 的字段拼法与模板一致',
  renderTitlePrefix('yyyy-MM-dd HH:mm:ss ', CREATED) === '2026-09-11 15:30:45 ',
  renderTitlePrefix('yyyy-MM-dd HH:mm:ss ', CREATED))
check('不含 token 的模板就是字面前缀', renderTitlePrefix('kenari-', CREATED) === 'kenari-')
check('token 之外的大写 D 未被替换', renderTitlePrefix('D-yyyy', CREATED) === 'D-2026',
  renderTitlePrefix('D-yyyy', CREATED))

// ---------------------------------------------------------------------------
// 2) 写入时校验
// ---------------------------------------------------------------------------
const accepts = (options) => {
  try {
    validateSessionTitlePrefix(options)
    return true
  } catch {
    return false
  }
}
const base = { enabled: true, template: 'yyyyMMddHHmmss-', maxBytes: 96 }
check('默认配置通过校验', accepts(base))
check('开关关闭时允许空模板', accepts({ ...base, template: '', enabled: false }))
check('开关开启且模板为空 → 拒绝', !accepts({ ...base, template: '' }))
check('模板含换行 → 拒绝', !accepts({ ...base, template: 'a\nb-' }))
check('模板超过 48 字节 → 拒绝', !accepts({ ...base, template: 'x'.repeat(49) }))
check('预算容不下前缀 + 8 字节正文 → 拒绝', !accepts({ ...base, template: 'yyyyMMddHHmmss', maxBytes: 20 }))
check('非正整数预算 → 拒绝', !accepts({ ...base, maxBytes: 0 }))

// ---------------------------------------------------------------------------
// 3) 实时改写
// ---------------------------------------------------------------------------
{
  const rig = makeRig()
  const config = { enabled: true, template: 'yyyyMMddHHmmss-', maxBytes: 96 }
  installSessionTitlePrefix(rig.ctx, {
    enabled: () => config.enabled,
    template: () => config.template,
    maxBytes: () => config.maxBytes,
  })

  const session = rig.session('s1', CREATED)
  session.append('session/title', titleData('fix web fallback'))
  await tick()
  const prefixed = '20260911153045-fix web fallback'
  check('fallback 标题被加上前缀', latestTitle(session)?.title === prefixed, latestTitle(session)?.title)
  check('前缀事件沿用原 source 与 messageSeqs',
    latestTitle(session)?.source.kind === 'fallback' && latestTitle(session)?.messageSeqs.join() === '3')
  check('幂等：改写后不再追加第二条', titleEvents(session).length === 2, `events=${titleEvents(session).length}`)

  // 用户改名同样带前缀（fork 的 rename 就是 user source，按 source 区分会漏改）
  session.append('session/title', titleData('renamed by hand', { kind: 'user' }, []))
  await tick()
  check('手动改名也带前缀', latestTitle(session)?.title === '20260911153045-renamed by hand', latestTitle(session)?.title)

  // 关掉开关后新标题不带前缀
  config.enabled = false
  session.append('session/title', titleData('after off'))
  await tick()
  check('开关关闭后新标题不带前缀', latestTitle(session)?.title === 'after off', latestTitle(session)?.title)

  // 非标题事件不触发改写
  const before = titleEvents(session).length
  session.append('user/message', {})
  await tick()
  check('非标题事件不触发改写', titleEvents(session).length === before)
}

// ---------------------------------------------------------------------------
// 4) fork：按子会话创建时间重写；resume 不回溯
// ---------------------------------------------------------------------------
{
  const rig = makeRig()
  const config = { enabled: true, template: 'yyyyMMddHHmmss-', maxBytes: 96 }
  installSessionTitlePrefix(rig.ctx, {
    enabled: () => config.enabled,
    template: () => config.template,
    maxBytes: () => config.maxBytes,
  })

  const parentCreated = new Date(2026, 8, 11, 10, 0, 0).getTime()
  const childCreated = new Date(2026, 8, 11, 12, 0, 0).getTime()
  const parent = rig.session('p1', parentCreated)
  parent.append('session/title', titleData('parent topic'))
  await tick()
  check('父会话标题带父前缀', latestTitle(parent)?.title === '20260911100000-parent topic', latestTitle(parent)?.title)

  const child = rig.session('c1', childCreated, { parentSession: 'p1', seed: parent.events.slice() })
  rig.emit('session/created', child)
  await tick()
  check('fork 子会话换成子会话创建时间前缀',
    latestTitle(child)?.title === '20260911120000-parent topic', latestTitle(child)?.title)

  // 浏览器 fork 之后的那次 rename：父前缀 + " (1)"
  child.append('session/title', titleData('20260911100000-parent topic (1)', { kind: 'user' }, []))
  await tick()
  check('fork 的 rename 剥掉父前缀、换成子前缀',
    latestTitle(child)?.title === '20260911120000-parent topic (1)', latestTitle(child)?.title)

  // resume：没有 parentSession，带前缀的既有标题不许被再改一次
  const resumed = rig.session('r1', parentCreated, { seed: [{ type: 'session/title', seq: 0, data: titleData('20260911100000-old') }] })
  rig.emit('session/created', resumed)
  await tick()
  check('普通 resume 不回溯', titleEvents(resumed).length === 1, `events=${titleEvents(resumed).length}`)
}

// ---------------------------------------------------------------------------
// 5) 关闭开关时的 fork：剥掉继承来的父前缀
// ---------------------------------------------------------------------------
{
  const rig = makeRig()
  const config = { enabled: true, template: 'yyyyMMddHHmmss-', maxBytes: 96 }
  installSessionTitlePrefix(rig.ctx, {
    enabled: () => config.enabled,
    template: () => config.template,
    maxBytes: () => config.maxBytes,
  })
  const parentCreated = new Date(2026, 8, 11, 10, 0, 0).getTime()
  const parent = rig.session('p2', parentCreated)
  parent.append('session/title', titleData('parent topic'))
  await tick()

  config.enabled = false
  const child = rig.session('c2', new Date(2026, 8, 11, 12, 0, 0).getTime(), {
    parentSession: 'p2',
    seed: parent.events.slice(),
  })
  rig.emit('session/created', child)
  await tick()
  check('开关关闭时 fork 子会话不继承父前缀',
    latestTitle(child)?.title === 'parent topic', latestTitle(child)?.title)
}

// ---------------------------------------------------------------------------
// 6) 字节预算
// ---------------------------------------------------------------------------
{
  const rig = makeRig()
  installSessionTitlePrefix(rig.ctx, {
    enabled: () => true,
    template: () => 'yyyyMMddHHmmss-',
    maxBytes: () => 24,
  })
  const session = rig.session('s2', CREATED)
  session.append('session/title', titleData('a very long title that must be clipped'))
  await tick()
  const title = latestTitle(session)?.title ?? ''
  check('超长标题被截到字节预算内', byteLength(title) === 24, `${byteLength(title)} bytes: ${title}`)
  check('截断保留完整前缀', title.startsWith('20260911153045-'), title)
}

if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n会话标题前缀检查通过')
