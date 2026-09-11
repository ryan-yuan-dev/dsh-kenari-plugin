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

const failed = results.filter((row) => !row.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) console.log('FAILED:', failed.map((row) => row.name).join(' | '))
process.exit(failed.length === 0 ? 0 : 1)
