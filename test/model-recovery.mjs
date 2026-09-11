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

const failed = results.filter((row) => !row.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) console.log('FAILED:', failed.map((row) => row.name).join(' | '))
process.exit(failed.length === 0 ? 0 : 1)
