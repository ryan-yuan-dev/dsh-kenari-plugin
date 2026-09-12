/**
 * 「失败后到底重试了几次」的真实组件验证。
 *
 * 背景：线上会话日志里 `llm/retry` 事件数恒为 0，Kenari 模型第一次失败后 9ms 插件就注入
 * 换模型通知、5015ms 就发出新请求 —— dsh 自带的 5 次重试从未执行。根因是
 * `agent/request-error` 瀑布里不调用 `next()` 的监听器会否决它后面的一切：只要注册顺序被
 * live reload 翻过来一次，排在外层的插件就把 llm-retry 永久饿死。修法有两处：
 * 插件先 `await next()`（不再否决），以及 Kenari 路由上由插件自己的状态机负责重试
 * （`cordis.patch.yml` 把该路由的 `retryPolicy.maxRetries` 置 0）。
 *
 * 三个场景用真实 `dsh-llm` / `dsh-agent` / `dsh-session-projection` / `dsh-llm-retry` /
 * `dsh-agent-loop` 加上本插件跑同一轮必然 TRANSPORT 失败的调用：
 *
 *   A. 出厂配置（该路由 dsh 重试已关）：插件自己重试 5 次，再换模型 —— 全程 0 个 llm/retry。
 *   B. 该路由 dsh 重试开着、插件在内层：dsh 重试 5 次，插件不重复补预算。
 *   C. 该路由 dsh 重试开着、插件被排到**外层**（复刻 live reload 之后的顺序）：dsh 仍然
 *      重试 5 次 —— 这一条专门守住「插件不再饿死 llm-retry」。
 *
 * 全程在进程内，无网络、无计费：适配器直接抛错。
 *
 * Run: pnpm build && node test/retry-repro.mjs
 */
const GLOBAL = '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
// llm-retry 是命名导出（`name` / `inject` / `apply`），其余包是默认导出
const load = async (name) => {
  const mod = await import(`${GLOBAL}/${name}/lib/index.js`)
  return mod.default ?? mod
}
const ns = async (name) => await import(`${GLOBAL}/${name}/lib/index.js`)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

const { Context } = await ns('cordis')
const { LlmAdapter, LlmError, createUserMessage, resolveRetryPolicy } = await ns('dsh-llm')
const { SessionId } = await ns('dsh-session')

const [LlmRuntime, SessionStore, AgentRegistry, LlmRetry, SessionProjection,
  SystemPrompt, ToolRuntime, AgentLoop] = await Promise.all([
  load('dsh-llm'), load('dsh-session'), load('dsh-agent'), load('dsh-llm-retry'),
  load('dsh-session-projection'), load('dsh-system-prompt'), load('dsh-tools'), load('dsh-agent-loop'),
])

const { apply, Config } = await import('../lib/index.js')
const { dshRetryDisabledPolicy } = await import('../lib/llm/retry.js')

const WINDOWS = { current: 8192, big: 262144, huge: 1_000_000 }

/** 「dsh 还在这条路由上重试」的对照组策略：形状照旧版 patch，只把等待压到 1ms。 */
const LEGACY_POLICY = resolveRetryPolicy({
  mode: 'normal',
  maxRetries: 5,
  backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
}, 'retry-repro legacy policy')

/** 永远以 TRANSPORT 失败的适配器。 */
class AlwaysTransport extends LlmAdapter {
  constructor() {
    super()
    this.requests = 0
  }

  providerRetryPolicy() { return this.policy }

  listModels(provider) {
    return Promise.resolve(Object.keys(WINDOWS).map((id) => ({ id, provider, name: id })))
  }

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: WINDOWS[model] ?? 0 } })
  }

  async * stream() {
    this.requests += 1
    // 兜底刹车：真出现无限升级时用不可重试码结束，免得脚本挂死
    if (this.requests > 40) throw new LlmError('retry-repro request cap reached', 'INVALID_REQUEST')
    throw new LlmError('Connection error.', 'TRANSPORT')
  }
}

/**
 * 跑一个场景。`pluginFirst` 决定插件相对 `llm-retry` 的装载位置（true = 复刻 live reload
 * 之后「插件在外层」的顺序）；`policy` 决定该路由上 dsh 还重不重试。
 */
const runScenario = async ({ policy, pluginFirst }) => {
  const ctx = new Context()
  ctx.provide('web', { registerSearchProvider() {}, registerFetchProvider() {} })
  ctx.provide('credentials', {
    resolve: async () => ({ value: 'repro', source: 'test' }),
    describe: async () => ({ configured: true, source: 'test', writable: false }),
  })
  // 回退目标指向另一个 provider，让 stage 2 也有落点
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'fallback', model: 'current' }) })

  const kenari = { name: 'kenari', inject: ['web', 'tools'], apply }
  const config = { ...Config({}), modelSwitchDelayMs: 5, modelRetryDelayMs: 1 }

  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjection)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentLoop)
  if (pluginFirst) {
    // 复刻 live reload 之后的顺序：先让插件的监听器注册好，再装 llm-retry
    await ctx.plugin(kenari, config)
    await new Promise((resolve) => setTimeout(resolve, 100))
    await ctx.plugin(LlmRetry)
  } else {
    await ctx.plugin(LlmRetry)
    await ctx.plugin(kenari, config)
  }
  await new Promise((resolve) => setTimeout(resolve, 300))

  const hooks = ctx.events?._hooks?.['agent/request-error'] ?? []
  const order = hooks.map((hook) => hook.ctx?.fiber?.name ?? hook.ctx?.name ?? '?')

  const llm = ctx.get('llm')
  const primary = new AlwaysTransport()
  const fallback = new AlwaysTransport()
  primary.policy = policy
  fallback.policy = policy
  llm.registerAdapter(['kenari'], primary)
  llm.registerAdapter(['fallback'], fallback)

  const agent = await ctx.agentLoop.create(SessionId('retry-repro'), { provider: 'kenari', model: 'current' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'say hi' }], source: { kind: 'user' } }))
  await Promise.race([
    agent.whenIdle(),
    new Promise((resolve) => setTimeout(resolve, 20_000)),
  ])

  const events = agent.session.snapshotEvents()
  const attempts = events.filter((event) => event.type === 'assistant/attempt')
  const retries = events.filter((event) => event.type === 'llm/retry')
  // 通知在 agent/inbox/spliced 与 user/message 里各出现一次，只数前者，免得重复
  const notices = events
    .filter((event) => event.type === 'agent/inbox/spliced')
    .flatMap((event) => event.data?.inserted ?? [])
    .map((message) => message?.source?.summary)
    .filter((summary) => typeof summary === 'string')
  // 换模型通知把尝试切成段：一段就是「同一条路由上的尝试次数」（含重试）
  const switchSeqs = new Set(events
    .filter((event) => event.type === 'agent/inbox/spliced'
      && (event.data?.inserted ?? []).some((message) => message?.source?.summary?.includes('→')))
    .map((event) => event.seq))
  const segments = []
  let seen = 0
  for (const event of events) {
    if (event.type === 'assistant/attempt') seen += 1
    if (switchSeqs.has(event.seq)) {
      segments.push(seen)
      seen = 0
    }
  }
  segments.push(seen)

  return { order, attempts: attempts.length, segments, retries: retries.length, notices, requests: primary.requests }
}

const show = (label, run) => {
  console.log(`  listeners: ${run.order.join(' → ')}`)
  console.log(`  attempts=${run.attempts} per-route=${run.segments.join('/')} llm/retry=${run.retries}`)
  console.log(`  notices: ${run.notices.join(' | ')}`)
}

console.log('--- A: 出厂配置（该路由 dsh 重试已关，插件拥有重试）---')
const a = await runScenario({ policy: dshRetryDisabledPolicy(), pluginFirst: false })
show('A', a)
check('A: each route gets 1 + 5 attempts before the escalation moves on',
  a.segments[0] === 6 && a.segments[1] === 6, a.segments.join('/'))
check('A: dsh schedules no retries for this route (single owner)',
  a.retries === 0, String(a.retries))
check('A: the retry is explained by a notice instead of a silent wait',
  a.notices.some((summary) => summary.includes('重试')), a.notices.join(' | '))
check('A: a model switch still follows the exhausted budget',
  a.notices.some((summary) => summary.includes('→')), a.notices.join(' | '))

console.log('\n--- B: 该路由 dsh 重试开着，插件在内层 ---')
const b = await runScenario({ policy: LEGACY_POLICY, pluginFirst: false })
show('B', b)
check('B: llm-retry performs the five retries on the first route',
  b.retries >= 5 && b.segments[0] === 6, `attempts=${b.segments[0]} llm/retry=${b.retries}`)
check('B: the plugin does not stack its own budget on top of a working llm-retry',
  !b.notices.some((summary) => summary.includes('重试')), b.notices.join(' | '))

console.log('\n--- C: 该路由 dsh 重试开着，插件被排到外层（复刻 live reload）---')
const c = await runScenario({ policy: LEGACY_POLICY, pluginFirst: true })
show('C', c)
check('C: the plugin is really outside llm-retry in this scenario',
  c.order.indexOf('kenari') < c.order.indexOf('llm-retry'), c.order.join(' → '))
check('C: the outer plugin no longer starves llm-retry',
  c.retries >= 5 && c.segments[0] === 6, `attempts=${c.segments[0]} llm/retry=${c.retries}`)

const failed = results.filter((row) => !row.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) console.log('FAILED:', failed.map((row) => row.name).join(' | '))
process.exit(failed.length === 0 ? 0 : 1)
