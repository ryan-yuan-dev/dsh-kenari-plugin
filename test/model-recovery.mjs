/**
 * 模型失败恢复的验证：路由判定、重试策略装配、候选挑选、升级状态机。
 *
 * 全程 in-process，无网络、无计费 —— 重试机制本身（dsh-llm-retry 的行为）属于 dsh
 * 的测试范围，这里只验证我们产出的策略形状与自己写的状态机。理由见设计文档 §7.d。
 *
 * Run: pnpm build && node test/model-recovery.mjs
 */
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

// ------------------------------------------------------------- config shape
const { Config } = await import('../lib/index.js')
const defaults = Config({})

check('modelRecoveryEnabled defaults on', defaults.modelRecoveryEnabled === true)
check('modelRecoveryProviders covers both kenari routes',
  defaults.modelRecoveryProviders.join(',') === 'kenari,kenari-direct',
  defaults.modelRecoveryProviders.join(','))
check('retry defaults to 5 attempts at 5s',
  defaults.modelRetryMaxRetries === 5 && defaults.modelRetryDelayMs === 5000,
  `${defaults.modelRetryMaxRetries}/${defaults.modelRetryDelayMs}`)
check('retryable codes default to the transient set',
  ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'].every((code) => defaults.modelRetryableCodes.includes(code)),
  defaults.modelRetryableCodes.join(','))
check('CONTEXT_WINDOW_EXCEEDED is deliberately not retryable',
  !defaults.modelRetryableCodes.includes('CONTEXT_WINDOW_EXCEEDED'))
check('switch defaults on with a 5s wait and the notice on',
  defaults.modelSwitchEnabled === true && defaults.modelSwitchDelayMs === 5000 && defaults.modelSwitchNoticeEnabled === true)
check('skip codes cover the credential-class failures',
  ['AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'QUOTA'].every((code) => defaults.modelSwitchSkipCodes.includes(code)),
  defaults.modelSwitchSkipCodes.join(','))

const { validateKenariConfig } = await import('../lib/settings.js')
let emptyCodesError
try { validateKenariConfig({ ...defaults, modelRetryableCodes: [] }) } catch (err) { emptyCodesError = err }
check('an empty retryable-code list is rejected at write time', emptyCodesError !== undefined, String(emptyCodesError?.message))

// ------------------------------------------------------- retry policy shape
const { isRecoveryProvider, kenariRetryPolicy, sleepUnlessAborted } = await import('../lib/llm/retry.js')

check('isRecoveryProvider matches configured routes only',
  isRecoveryProvider('kenari', ['kenari', 'kenari-direct']) === true
  && isRecoveryProvider('deepseek-official', ['kenari', 'kenari-direct']) === false)

const policy = kenariRetryPolicy({ maxRetries: 5, delayMs: 5000 })
check('policy retries 5 times in normal mode', policy.mode === 'normal' && policy.maxRetries === 5)
// dsh 的退避是 initialDelay * 2^n 被 maxDelay 封顶：两者相等就退化成「每次等同样久」，
// 这是「固定 5s」唯一能精确表达的写法，所以这两条断言是关键
check('policy waits a flat 5s (initial === max kills the exponential, jitter off)',
  policy.initialDelayMs === 5000 && policy.maxDelayMs === 5000 && policy.jitterRatio === 0,
  `${policy.initialDelayMs}/${policy.maxDelayMs}/${policy.jitterRatio}`)

let emptyPolicyError
try { kenariRetryPolicy({ retryableCodes: [] }) } catch (err) { emptyPolicyError = err }
check('an empty retryable-code list fails fast', emptyPolicyError !== undefined)

const preAborted = new AbortController()
preAborted.abort()
check('sleepUnlessAborted returns false for an already-aborted signal',
  (await sleepUnlessAborted(50, preAborted.signal)) === false)

const midAborted = new AbortController()
setTimeout(() => midAborted.abort(), 20)
check('sleepUnlessAborted returns false when aborted mid-wait',
  (await sleepUnlessAborted(5000, midAborted.signal)) === false)

check('sleepUnlessAborted returns true after the full wait',
  (await sleepUnlessAborted(10, new AbortController().signal)) === true)

// ----------------------------------------------------------- model candidates
const { ModelCandidates } = await import('../lib/llm/candidates.js')

const DIRECTORY = {
  kenari: [['small', 4096], ['current', 8192], ['big', 262144], ['huge', 1_000_000]],
  'deepseek-official': [['deepseek-flash', 65536], ['deepseek-pro', 131072]],
  other: [['other-max', 2_000_000]],
}

const makeDirectory = (overrides = {}) => {
  const calls = { listModels: 0 }
  return {
    calls,
    listProviders: () => Object.keys(DIRECTORY).map((id) => ({ id })),
    listModels: async (provider) => {
      calls.listModels += 1
      return (DIRECTORY[provider] ?? []).map(([id]) => ({ id }))
    },
    resolveModelInfo: async (provider, model) => {
      const entry = (DIRECTORY[provider] ?? []).find(([id]) => id === model)
      return entry === undefined ? {} : { context: { contextWindow: entry[1] } }
    },
    ...overrides,
  }
}

const directory = makeDirectory()
const candidates = new ModelCandidates({ llm: directory, cacheTtlMs: 60_000 })

const sameProvider = await candidates.pick({ provider: 'kenari', model: 'current', contextWindow: 8192 })
check('picks the smallest sufficient model in the same provider',
  sameProvider?.provider === 'kenari' && sameProvider?.model === 'big',
  `${sameProvider?.provider}/${sameProvider?.model}`)

const excluded = await candidates.pick({ provider: 'kenari', model: 'small', contextWindow: 4096 })
check('never picks the model that just failed',
  excluded?.model === 'current', String(excluded?.model))

check('reuses the cached directory within the TTL', directory.calls.listModels === 1, String(directory.calls.listModels))

const crossProvider = await candidates.pick({ provider: 'kenari', model: 'huge', contextWindow: 1_000_000 })
check('falls back to another provider when the same one has no candidate',
  crossProvider?.provider === 'other' && crossProvider?.model === 'other-max',
  `${crossProvider?.provider}/${crossProvider?.model}`)

const unknownWindow = await candidates.pick({ provider: 'kenari', model: 'huge' })
check('treats an unknown current window as 0 so any known window qualifies',
  unknownWindow?.model === 'small', String(unknownWindow?.model))

const none = await candidates.pick({ provider: 'kenari', model: 'current', contextWindow: 5_000_000 })
check('returns undefined when nothing is big enough', none === undefined)

// TTL 为 0 时必须每次都重新读目录，否则模型上下线不会反映出来
const fresh = makeDirectory()
const uncached = new ModelCandidates({ llm: fresh, cacheTtlMs: 0 })
await uncached.pick({ provider: 'kenari', model: 'current', contextWindow: 8192 })
await uncached.pick({ provider: 'kenari', model: 'current', contextWindow: 8192 })
check('a zero TTL re-reads the directory every time', fresh.calls.listModels === 2, String(fresh.calls.listModels))

// 同窗口的并列必须确定性取小 id，否则同一份配置在不同机器上会换到不同模型
const tieDirectory = makeDirectory({
  listProviders: () => [{ id: 'tie' }],
  listModels: async () => [{ id: 'bbb' }, { id: 'aaa' }],
  resolveModelInfo: async () => ({ context: { contextWindow: 100 } }),
})
const tie = await new ModelCandidates({ llm: tieDirectory, cacheTtlMs: 60_000 })
  .pick({ provider: 'tie', model: 'zzz', contextWindow: 1 })
check('breaks ties deterministically by model id', tie?.model === 'aaa', String(tie?.model))

// 单个模型的元数据解析失败不能毁掉整个候选列表
const partialDirectory = makeDirectory({
  resolveModelInfo: async (provider, model) => {
    if (model === 'big') throw new Error('metadata unavailable')
    const entry = (DIRECTORY[provider] ?? []).find(([id]) => id === model)
    return entry === undefined ? {} : { context: { contextWindow: entry[1] } }
  },
})
const partial = await new ModelCandidates({ llm: partialDirectory, cacheTtlMs: 60_000 })
  .pick({ provider: 'kenari', model: 'current', contextWindow: 8192 })
check('skips models whose metadata cannot be resolved',
  partial?.model === 'huge', String(partial?.model))

// ------------------------------------------------------- escalation machine
const { Context } = await import('@deepseek-ai/cordis')
const { agentEvents } = await import('@deepseek-ai/dsh-agent')
const { installModelRecovery } = await import('../lib/llm/recovery.js')

/** 只实现恢复逻辑真正触碰到的面：requestContext / id / inject。 */
const makeSession = (id) => {
  const state = { current: undefined }
  return { id, state, requestContext: () => state.current }
}
const makeAgent = (session) => ({
  id: session.id,
  session,
  injected: [],
  inject(message) { this.injected.push(message) },
})

const signal = () => new AbortController().signal
const BASE_DEPS = {
  enabled: true,
  providers: ['kenari'],
  switchEnabled: true,
  switchDelayMs: 5,
  skipCodes: ['AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'QUOTA'],
  noticeEnabled: true,
  defaultSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
}

/** 建一个装好恢复机制的 ctx 与它驱动的 agent。seed 带 reasoningEffort，用来验证跨模型时会被丢掉。 */
const withRecovery = (overrides = {}) => {
  const ctx = new Context()
  const candidates = new ModelCandidates({ llm: makeDirectory(), cacheTtlMs: 60_000 })
  installModelRecovery(ctx, { ...BASE_DEPS, candidates, ...overrides })
  const session = makeSession('s1')
  session.state.current = { provider: 'kenari', model: 'current', contextWindow: 8192 }
  const agent = makeAgent(session)
  const dispatch = agentEvents(ctx, agent)
  const requestError = (failure, step = 1) => dispatch.waterfall(
    'agent/request-error',
    { turn: 1, step, provider: 'kenari', failure, retryPolicy: undefined, signal: signal() },
    () => Promise.resolve(undefined),
  )
  const request = () => dispatch.waterfall(
    'agent/request',
    { turn: 1, step: 1, signal: signal() },
    () => Promise.resolve({ provider: 'kenari', model: 'current', reasoningEffort: 'high' }),
  )
  return { ctx, agent, session, request, requestError }
}

// 没有失败时不该动请求配置，连档位都要原样透传
const happy = withRecovery()
const untouched = await happy.request()
check('leaves the request alone before any failure',
  untouched.provider === 'kenari' && untouched.model === 'current' && untouched.reasoningEffort === 'high',
  `${untouched.provider}/${untouched.model}/${untouched.reasoningEffort}`)

// 第一次失败 → 同 provider 换模型
const first = withRecovery()
const action1 = await first.requestError({ message: 'boom', code: 'SERVER' })
check('first failure schedules a retry', action1?.kind === 'retry', JSON.stringify(action1))
const afterFirst = await first.request()
check('first escalation switches to the smallest sufficient model',
  afterFirst.provider === 'kenari' && afterFirst.model === 'big', `${afterFirst.provider}/${afterFirst.model}`)
check('the switch drops the previous reasoning effort', afterFirst.reasoningEffort === undefined)
check('a model-switch notice is injected once', first.agent.injected.length === 1, String(first.agent.injected.length))
check('the notice names both routes',
  String(first.agent.injected[0]?.content?.[0]?.text).includes('kenari/current')
  && String(first.agent.injected[0]?.content?.[0]?.text).includes('kenari/big'),
  String(first.agent.injected[0]?.content?.[0]?.text))

// 第二次失败 → 回退默认 provider（此刻当前路由已经是换过去的 big）
first.session.state.current = { provider: 'kenari', model: 'big', contextWindow: 262144 }
const action2 = await first.requestError({ message: 'boom', code: 'SERVER' })
check('second failure schedules another retry', action2?.kind === 'retry')
const afterSecond = await first.request()
check('second escalation falls back to the default provider',
  afterSecond.provider === 'deepseek-official' && afterSecond.model === 'deepseek-flash',
  `${afterSecond.provider}/${afterSecond.model}`)

// 第三次失败 → 放弃，该轮按现状以 error 结束
first.session.state.current = { provider: 'deepseek-official', model: 'deepseek-flash', contextWindow: 65536 }
const action3 = await first.requestError({ message: 'boom', code: 'SERVER' })
check('third failure gives up (no infinite escalation)', action3 === undefined, JSON.stringify(action3))

// 凭据类失败跳过「同 provider 换模型」：同账号的 key 坏了，换个模型没用
const credential = withRecovery()
const actionCredential = await credential.requestError({ message: 'bad key', code: 'AUTH' })
check('a credential-class code still schedules a retry', actionCredential?.kind === 'retry')
const afterCredential = await credential.request()
check('...but goes straight to the default provider, skipping the same-provider switch',
  afterCredential.provider === 'deepseek-official' && afterCredential.model === 'deepseek-flash',
  `${afterCredential.provider}/${afterCredential.model}`)

// 范围外 provider 完全不介入
const foreign = withRecovery()
const foreignDispatch = agentEvents(foreign.ctx, makeAgent(makeSession('s9')))
const foreignResult = await foreignDispatch.waterfall(
  'agent/request-error',
  { turn: 1, step: 1, provider: 'deepseek-official', failure: { message: 'x', code: 'SERVER' }, retryPolicy: undefined, signal: signal() },
  () => Promise.resolve(undefined),
)
check('a provider outside the recovery scope is left alone', foreignResult === undefined)

// 总开关关掉时监听器完全不装
const disabled = withRecovery({ enabled: false })
const disabledAction = await disabled.requestError({ message: 'boom', code: 'SERVER' })
check('the master switch disables recovery entirely', disabledAction === undefined)

// 换模型关掉时只保留 dsh 的重试
const retryOnly = withRecovery({ switchEnabled: false })
const retryOnlyAction = await retryOnly.requestError({ message: 'boom', code: 'SERVER' })
check('switchEnabled: false leaves recovery to dsh retries only', retryOnlyAction === undefined)

// 顺序回归：installModelSelection 会用「本 step 组装时捕获的」原模型回写。
// 它注册得更晚因而在内层；我们的 prepend 让我们拿到最终决定权。
const ordering = withRecovery()
const assembled = { provider: 'kenari', model: 'current' }
ordering.ctx.on('agent/request', async (_payload, next) => {
  const resolved = await next()
  return { ...resolved, provider: assembled.provider, model: assembled.model }
})
await ordering.requestError({ message: 'boom', code: 'SERVER' })
const ordered = await ordering.request()
check('our override survives an inner listener that rewrites the model back',
  ordered.provider === 'kenari' && ordered.model === 'big', `${ordered.provider}/${ordered.model}`)

// 用户显式选模型（会话日志追加 model/selection）后，人的选择优先
const manual = withRecovery()
await manual.requestError({ message: 'boom', code: 'SERVER' })
manual.ctx.emit('session/event', manual.session, { type: 'model/selection', seq: 1 })
const afterManual = await manual.request()
check('a manual model selection clears the override',
  afterManual.provider === 'kenari' && afterManual.model === 'current',
  `${afterManual.provider}/${afterManual.model}`)

// ------------------------------------------------------- adapter retry policy
const { KenariLlmAdapter } = await import('../lib/llm/adapter.js')

// 适配器构造只保存依赖，providerRetryPolicy 不碰它们，所以空壳足够
const shellDeps = { http: {}, catalog: {}, billing: {} }
const wired = new KenariLlmAdapter({ ...shellDeps, retryPolicy: kenariRetryPolicy({ maxRetries: 5, delayMs: 5000 }) })
check('the native adapter exposes the configured retry policy',
  wired.providerRetryPolicy('kenari-direct')?.maxRetries === 5,
  String(wired.providerRetryPolicy('kenari-direct')?.maxRetries))
check('the native adapter stays policy-free when not configured',
  new KenariLlmAdapter(shellDeps).providerRetryPolicy('kenari-direct') === undefined)

// ------------------------------------------------------ assembly integration
// 上面验证的是 installModelRecovery 本身；这一段验证 apply 真的把它接上了 ——
// 接线断掉的话单元测试照样全绿。
const { apply } = await import('../lib/index.js')

const makeLlmSeam = () => ({
  listProviders: () => [{ id: 'kenari' }, { id: 'deepseek-official' }],
  listModels: async (provider) => (DIRECTORY[provider] ?? []).map(([id]) => ({ id, provider, name: id })),
  resolveModelInfo: async (provider, model) => {
    const entry = (DIRECTORY[provider] ?? []).find(([id]) => id === model)
    return entry === undefined ? {} : { context: { contextWindow: entry[1] } }
  },
  registerAdapter: () => ({ replace() {}, dispose() {} }),
  registerModelDiscovery: () => {},
})

const loadPlugin = async (overrides = {}, options = {}) => {
  const ctx = new Context()
  ctx.provide('web', { registerSearchProvider() {}, registerFetchProvider() {} })
  ctx.provide('tools', { register() {}, schemas: () => [] })
  ctx.provide('llm', makeLlmSeam())
  if (options.provideDefault !== false) {
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
    })
  }
  ctx.plugin({ name: 'kenari', inject: ['web', 'tools'], apply }, { ...Config({}), modelSwitchDelayMs: 5, ...overrides })
  await new Promise((resolve) => setTimeout(resolve, 200))
  return ctx
}

const failure = { message: 'boom', code: 'SERVER' }
const kenariFailure = (step = 1) => ({
  turn: 1, step, provider: 'kenari', failure, retryPolicy: undefined, signal: signal(),
})

const wiredCtx = await loadPlugin()
const wiredSession = makeSession('asm')
wiredSession.state.current = { provider: 'kenari', model: 'current', contextWindow: 8192 }
const wiredDispatch = agentEvents(wiredCtx, makeAgent(wiredSession))
const wiredAction = await wiredDispatch.waterfall('agent/request-error', kenariFailure(), () => Promise.resolve(undefined))
check('apply wires recovery in (a kenari failure schedules a retry)',
  wiredAction?.kind === 'retry', JSON.stringify(wiredAction))
const wiredNext = await wiredDispatch.waterfall(
  'agent/request',
  { turn: 1, step: 1, signal: signal() },
  () => Promise.resolve({ provider: 'kenari', model: 'current' }),
)
check('...and the switch reaches the request', wiredNext.model === 'big', String(wiredNext.model))

// 第二次失败 → 走 apply 里读到的真实 dsh 默认 provider
wiredSession.state.current = { provider: 'kenari', model: 'big', contextWindow: 262144 }
const wiredSecond = await wiredDispatch.waterfall('agent/request-error', kenariFailure(), () => Promise.resolve(undefined))
const wiredFallback = await wiredDispatch.waterfall(
  'agent/request',
  { turn: 1, step: 1, signal: signal() },
  () => Promise.resolve({ provider: 'kenari', model: 'current' }),
)
check('...and the second stage reaches the real dsh default provider',
  wiredSecond?.kind === 'retry' && wiredFallback.provider === 'deepseek-official',
  `${wiredFallback.provider}/${wiredFallback.model}`)

// 总开关关掉时 apply 不该装恢复机制
const switchedOff = await loadPlugin({ modelRecoveryEnabled: false })
const offSession = makeSession('off')
offSession.state.current = { provider: 'kenari', model: 'current', contextWindow: 8192 }
const offDispatch = agentEvents(switchedOff, makeAgent(offSession))
check('modelRecoveryEnabled: false skips the wiring entirely',
  (await offDispatch.waterfall('agent/request-error', kenariFailure(), () => Promise.resolve(undefined))) === undefined)

// agentDefaultModel 服务缺失时必须优雅退化：换模型照做，回退阶段放弃而不是抛错
const noDefault = await loadPlugin({}, { provideDefault: false })
const noDefaultSession = makeSession('nodefault')
noDefaultSession.state.current = { provider: 'kenari', model: 'current', contextWindow: 8192 }
const noDefaultDispatch = agentEvents(noDefault, makeAgent(noDefaultSession))
check('without agentDefaultModel the model switch still works',
  (await noDefaultDispatch.waterfall('agent/request-error', kenariFailure(), () => Promise.resolve(undefined)))?.kind === 'retry')
noDefaultSession.state.current = { provider: 'kenari', model: 'big', contextWindow: 262144 }
check('...and the default-provider stage degrades to giving up instead of throwing',
  (await noDefaultDispatch.waterfall('agent/request-error', kenariFailure(), () => Promise.resolve(undefined))) === undefined)

const failed = results.filter((row) => !row.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) console.log('FAILED:', failed.map((row) => row.name).join(' | '))
process.exit(failed.length === 0 ? 0 : 1)
