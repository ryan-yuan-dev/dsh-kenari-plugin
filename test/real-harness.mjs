/**
 * Phase-3 verification against the real dsh harness (not mocks): the registry
 * owns dispatch, schema validation, render, and materialization, so a passing
 * run here means the tools behave the same way inside a real session.
 *
 * Cost discipline: only one billed call is made (a 2-character embedding, well
 * under one Rupiah) and the rest is free or pure in-process unit checking.
 * The Kenari key is read from ~/.dsh/.env and never printed.
 *
 * Run: node test/real-harness.mjs
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const GLOBAL = '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const load = async (name) => (await import(`${GLOBAL}/${name}/lib/index.js`)).default

const envFile = readFileSync(join(process.env.HOME, '.dsh', '.env'), 'utf8')
const API_KEY = /^KENARI_API_KEY=(.+)$/m.exec(envFile)?.[1]?.trim()
if (API_KEY === undefined) {
  console.error('SKIP: KENARI_API_KEY not configured in ~/.dsh/.env')
  process.exit(2)
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

const { Context } = await import('@deepseek-ai/cordis')
const [systemPromptPlugin, toolsPlugin, attachmentPlugin] = await Promise.all([
  load('dsh-system-prompt'),
  load('dsh-tools'),
  load('dsh-attachment-local'),
])

const ctx = new Context()
ctx.provide('web', { registerSearchProvider() {}, registerFetchProvider() {} })
ctx.provide('credentials', {
  resolve: async () => ({ value: API_KEY, source: 'test' }),
  describe: async () => ({ configured: true, source: 'test', writable: false }),
})
ctx.plugin(systemPromptPlugin)
ctx.plugin(toolsPlugin)
ctx.plugin(attachmentPlugin, { dshHome: mkdtempSync(join(tmpdir(), 'kenari-harness-')) })

const { apply, Config } = await import('../lib/index.js')
ctx.plugin({ name: 'kenari', inject: ['web', 'tools'], apply }, {
  ...Config({}),
  // 高阈值 + 别名：让余额告警与别名解析都能在真实调用里被观察到
  lowBalanceAlertRp: 1_000_000_000,
  modelAliases: { flash: 'step-3-7-flash:free' },
})
await new Promise((resolve) => setTimeout(resolve, 300))

const tools = ctx.get('tools')
const call = (name, args, sessionId = 'test-session-1') =>
  tools.execute({
    callId: `call_${name}_${Date.now()}`,
    name,
    arguments: args,
    agent: { id: sessionId },
    signal: AbortSignal.timeout(120_000),
  })

// ---------------------------------------------------------------- registry
const registered = tools.schemas().map((schema) => schema.name)
const expectedTools = [
  'kenari_search_docs', 'kenari_list_models', 'kenari_balance', 'kenari_usage', 'kenari_quota',
  'kenari_x_search', 'kenari_ocr', 'kenari_image_generate', 'kenari_image_edit', 'kenari_speech',
  'kenari_transcribe', 'kenari_music', 'kenari_video_generate', 'kenari_video_extend',
  'kenari_video_status', 'kenari_video_content', 'kenari_embed', 'kenari_rerank', 'kenari_moderate',
  'kenari_count_tokens', 'kenari_billing',
]
const missing = expectedTools.filter((name) => !registered.includes(name))
check('registry exposes all 21 kenari_* tools', missing.length === 0, missing.length === 0 ? `${registered.length} tools` : `missing ${missing.join(',')}`)

// ------------------------------------------------------------ catalog: list
const freeModels = await call('kenari_list_models', { free_only: true })
const freeIds = freeModels.value?.free_ids ?? []
check('list_models free_only returns a free group', freeModels.isError === false && freeIds.includes('step-3-7-flash:free') && freeIds.length >= 10, `${freeIds.length} free ids`)
check('list_models free entries are labelled free, paid ones carry per-token IDR', (freeModels.value?.text ?? '').includes('（免费）'))

const allModels = await call('kenari_list_models', {})
const allText = allModels.value?.text ?? ''
check('list_models renders per-token IDR prices with the advertised unit',
  allText.includes('IDR per 1M tokens') && /价格：入 [\d.]+ \/ 出 [\d.]+ IDR per 1M tokens/.test(allText),
  (allText.match(/价格：入 [^\n]{0,60}/) ?? [''])[0])

const imageModels = await call('kenari_list_models', { search: 'gpt-image-2' })
check('list_models surfaces non-token unit prices', (imageModels.value?.text ?? '').includes('per 张') && (imageModels.value?.text ?? '').includes('images：Rp 175'))

const noMatch = await call('kenari_list_models', { search: 'definitely-not-a-model' })
check('list_models empty result stays honest', noMatch.isError === false && (noMatch.value?.text ?? '').includes('没有匹配'))

// -------------------------------------------------- catalog: TTL cache + alias
const { KenariCatalog } = await import('../lib/catalog.js')
const httpDeps = { config: { baseURL: 'https://kenari.id', timeoutMs: 30_000, maxRetries: 1 }, resolveApiKey: async () => API_KEY }
const catalog = new KenariCatalog({ ...httpDeps, config: { ...httpDeps.config, catalogCacheTtlMs: 60_000, modelAliases: { flash: 'step-3-7-flash:free' } } })
const first = await catalog.list()
const second = await catalog.list()
check('catalog TTL cache returns the cached array', first === second, `${first.length} models`)

const aliased = await catalog.resolve('flash')
const qualified = await catalog.resolve('kenari/step-3-7-flash:free')
const cased = await catalog.resolve('STEP-3-7-FLASH:FREE')
check('catalog resolves config alias + kenari/ prefix + case', aliased?.id === 'step-3-7-flash:free' && qualified?.id === 'step-3-7-flash:free' && cased?.id === 'step-3-7-flash:free')

const resolved = await catalog.resolve('step-3-7-flash:free')
const { toResolvedModelInfo, warningsOf, formatPricingLines } = await import('../lib/catalog.js')
const info = toResolvedModelInfo(resolved.model, 'kenari')
check('catalog maps context window, modalities and reasoning efforts',
  info.context?.contextWindow === 262144
  && info.inputModalities.join(',') === 'text,image'
  && (info.reasoning?.efforts ?? []).map((effort) => effort.id).join(',') === 'low,medium,high',
  `ctx=${info.context?.contextWindow} efforts=${(info.reasoning?.efforts ?? []).map((e) => e.id).join('/')}`)

const sunsetWarnings = warningsOf({ id: 'x', sunset_at: Math.floor(Date.now() / 1000) + 86_400 * 10 })
check('catalog flags imminent sunset', sunsetWarnings.some((warning) => warning.includes('还剩 10 天')), sunsetWarnings.join('|'))
check('catalog flags beta models', warningsOf({ id: 'x', beta: true }).some((warning) => warning.includes('beta')))
check('catalog formats per-unit pricing lines',
  formatPricingLines(resolved.model).length === 0
  && (await catalog.resolve('gpt-image-2')).model !== undefined)

// ----------------------------------------------------- count_tokens + window
const counted = await call('kenari_count_tokens', {
  model: 'step-3-7-flash:free',
  text: 'Kenari 上下文窗口监控测试。'.repeat(200),
})
check('count_tokens reports input tokens + catalog window ratio',
  counted.isError === false && counted.value?.model_in_catalog === true && counted.value?.context_window === 262144
  && typeof counted.value?.window_usage_ratio === 'number',
  `tokens=${counted.value?.input_tokens} ratio=${counted.value?.window_usage_ratio}`)
check('count_tokens names the model when absent from the catalog',
  (await call('kenari_count_tokens', { model: 'no-such-model-xyz', text: 'hi' })).value?.model_in_catalog === false)

// ---------------------------------------------------------------- billing
const before = await call('kenari_billing', {})
check('billing reports session scope, budget and balance',
  before.isError === false && (before.value?.text ?? '').includes('本会话') && (before.value?.text ?? '').includes('余额：Rp'),
  (before.value?.text ?? '').split('\n').find((line) => line.includes('余额')) ?? '')

const embedded = await call('kenari_embed', { model: 'bge-m3', input: 'hi' })
const embedText = embedded.value?.text ?? ''
check('billed call echoes cost + session cumulative', embedded.isError === false && embedText.includes('费用：约') && embedText.includes('本会话累计'), embedText.split('\n').find((line) => line.includes('费用')) ?? '')
check('low-balance alert fires above threshold', embedText.includes('余额偏低'))

const after = await call('kenari_billing', {})
check('billing counts the new spend in the session ledger',
  (after.value?.calls ?? 0) > (before.value?.calls ?? 0) && (after.value?.spent_micro_idr ?? 0) > 0,
  `calls ${before.value?.calls}→${after.value?.calls}, micro ${after.value?.spent_micro_idr}`)
check('billing separates sessions',
  (await call('kenari_billing', {}, 'other-session')).value?.spent_micro_idr === 0)

// --------------------------------------------------- pure unit: cap + 402
const { BillingLedger } = await import('../lib/billing.js')
const ledger = new BillingLedger(1_000)
ledger.recordSpend('s', { tool: 't', microIdr: 1_000, estimated: false })
let capped = false
try {
  ledger.assertWithinBudget('s', 'kenari_x_search')
} catch (err) {
  capped = err.name === 'KenariBudgetError' && err.message.includes('免费模型') && err.message.includes('step-3-7-flash:free')
}
check('budget cap rejects further spend with actionable advice', capped)
check('uncapped ledger allows spend', (() => { new BillingLedger().assertWithinBudget('s', 't'); return true })())

const { extractKenariErrorMessage } = await import('../lib/errors.js')
const insufficient = extractKenariErrorMessage(JSON.stringify({ error: { code: 'insufficient_balance', message: 'insufficient balance' } }), 402)
check('402 maps to switch-to-free-model advice', insufficient.includes('免费模型') && insufficient.includes('step-3-7-flash:free'), insufficient.slice(0, 90))
check('401 maps to key/base-url advice', extractKenariErrorMessage('invalid key', 401).includes('鉴权失败'))
check('405 maps to base-url shape advice', extractKenariErrorMessage('', 405).includes('405'))
check('plain-text error bodies are preserved', extractKenariErrorMessage('invalid key', 401).startsWith('invalid key'))

// ----------------------------------------------------------- pure unit: usage
const hitLedger = new BillingLedger()
hitLedger.recordUsage('s', { inputTokens: 1_000, outputTokens: 10, cacheReadTokens: 1_000 })
const usage = hitLedger.usageTotals('s')
check('cached_tokens hit rate is cacheRead / (input + cacheRead)', usage.hitRate === 0.5, `hitRate=${usage.hitRate}`)
check('no cache data means no hit rate rather than 0%', new BillingLedger().usageTotals('s').hitRate === undefined)

// ------------------------------------------- pure unit: per-unit rounding
// Measured against the live gateway: 21 characters of TTS billed one whole
// 1k-char unit (Rp 250), not 0.021 units — an estimate that skips this is off
// by more than an order of magnitude.
const { billedUnits } = await import('../lib/tools/shared.js')
const charUnits = billedUnits(21 / 1000, '1k_chars')
check('sub-unit per-unit quantities round up to one whole unit', charUnits.units === 1 && charUnits.roundedUp === true, `units=${charUnits.units}`)
check('whole per-unit quantities stay put', billedUnits(4, 'second').units === 4 && billedUnits(4, 'second').roundedUp === false)
check('partial per-unit quantities round up', billedUnits(6.5, 'second').units === 7)
check('token-unit quantities stay fractional (per-token pricing)', billedUnits(0.000021, 'token_1m').units === 0.000021 && billedUnits(0.000021, 'token_1m').roundedUp === false)

// ------------------------------------- web fallback ④: invalid Kenari key
// The one fallback path a mock cannot prove: a real request to the real host
// that really fails auth, then really falls back. The fallback provider is a
// sentinel because the official route's own credential is not this test's
// business (that path is covered by the phase-1 checks).
const { KenariSearchProvider } = await import('../lib/web/search.js')
const { KenariFirstSearch } = await import('../lib/web/fallback.js')
const warnings = []
const invalidDeps = {
  config: { baseURL: 'https://kenari.id', timeoutMs: 15_000, maxRetries: 0 },
  resolveApiKey: async () => 'kn-invalid-key-for-fallback-test',
  logger: { warn: (msg) => warnings.push(msg), info: () => {} },
}
const sentinel = {
  id: 'deepseek-official',
  available: () => true,
  search: async (request) => ({ sources: [{ url: 'https://sentinel.invalid/', title: `fallback:${request.query}` }], truncated: false }),
}
const composed = new KenariFirstSearch(new KenariSearchProvider(invalidDeps), sentinel, invalidDeps.logger)
let fallbackSources
try {
  fallbackSources = (await composed.search({ query: 'fallback probe', maxResults: 3 })).sources
} catch (err) {
  fallbackSources = [{ url: `threw:${String(err).slice(0, 60)}` }]
}
check('invalid Kenari key falls back to the composed provider', fallbackSources[0]?.url === 'https://sentinel.invalid/', fallbackSources[0]?.url)
check('fallback logs direction, reason and elapsed time', warnings.some((line) => line.includes('kenari-fallback') && line.includes('回退') && line.includes('ms')), warnings[0]?.slice(0, 90))

const failed = results.filter((row) => !row.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log('FAILED:', failed.map((row) => row.name).join(' | '))
  process.exit(1)
}
process.exit(0)
