/**
 * Phase-5 adapter verification against a local fake Kenari gateway.
 *
 * A model would only tell us "something came back"; a scripted SSE stream tells
 * us the exact chunk protocol, the exact request body, the attribution header,
 * the disjoint usage arithmetic, and the failure classification. The fake
 * gateway also serves `/v1/models`, so the catalog-backed model list and the
 * spend estimate are exercised on the same code path as production.
 *
 * No network, no model, no money.
 *
 * Run: node test/llm-adapter.mjs
 */
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

/** The catalog the fake gateway serves: one free reasoning model, one paid one. */
const GATEWAY_MODELS = [
  {
    id: 'test-model:free', name: 'Test Free', owned_by: 'test', context_length: 4096,
    modalities: { input: ['text', 'image'], output: ['text'] },
    reasoning: true, reasoning_options: ['low', 'high'], tool_call: true,
    endpoints: ['chat'], pricing: { free: true, currency: 'IDR', unit: 'micro_idr_per_1m_tokens' },
  },
  {
    id: 'paid-model', name: 'Test Paid', owned_by: 'test', context_length: 8192,
    modalities: { input: ['text'], output: ['text'] },
    endpoints: ['chat'],
    pricing: { input: 2_000_000, output: 4_000_000, cache_read: 500_000, free: false, currency: 'IDR', unit: 'micro_idr_per_1m_tokens' },
  },
  { id: 'embed-only', endpoints: ['embeddings'], pricing: { free: true, currency: 'IDR', unit: 'micro_idr_per_1m_tokens' } },
]

/** Canned stream: reasoning → text → one fragmented tool call → usage → DONE. */
const SSE_FRAMES = [
  { choices: [{ delta: { reasoning_content: 'thinking' }, finish_reason: null }] },
  { choices: [{ delta: { reasoning_content: ' hard' }, finish_reason: null }] },
  { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] },
  { choices: [{ delta: { content: ' world' }, finish_reason: null }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"city"' } }] }, finish_reason: null }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"Jakarta"}' } }] }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 } } },
]

let lastRequest = undefined
let lastHeaders = undefined
const server = createServer((req, res) => {
  lastHeaders = req.headers
  if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: GATEWAY_MODELS }))
    return
  }
  let raw = ''
  req.on('data', (chunk) => { raw += chunk })
  req.on('end', () => {
    lastRequest = JSON.parse(raw)
    const model = lastRequest.model
    if (model === 'error-model') {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'invalid_request_error', message: 'invalid key' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (model === 'empty-model') {
      res.end('data: [DONE]\n\n')
      return
    }
    for (const frame of SSE_FRAMES) res.write(`data: ${JSON.stringify(frame)}\n\n`)
    res.end('data: [DONE]\n\n')
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseURL = `http://127.0.0.1:${server.address().port}`

// ---------------------------------------------------------------- wiring
const { KenariCatalog } = await import('../lib/catalog.js')
const { BillingLedger } = await import('../lib/billing.js')
const { KenariLlmAdapter } = await import('../lib/llm/adapter.js')
const { LlmError } = await import('@deepseek-ai/dsh-llm')

const logger = { warn: () => {}, info: () => {} }
const httpDeps = {
  config: { baseURL, timeoutMs: 5_000, maxRetries: 0, apiKeyEnv: 'KENARI_API_KEY', catalogCacheTtlMs: 60_000 },
  resolveApiKey: async () => 'kn-test-key',
  logger,
}
const catalog = new KenariCatalog(httpDeps)
const billing = new BillingLedger()
const adapter = new KenariLlmAdapter({ http: httpDeps, catalog, billing, logger })

const collect = async (options) => {
  const chunks = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

// 一条带工具调用历史与工具结果的完整请求
const messages = [
  { id: 'm1', role: 'system', content: [{ type: 'text', text: 'You are terse.' }], source: { kind: 'plugin', plugin: 'test' } },
  { id: 'm2', role: 'user', content: [{ type: 'text', text: 'Weather in Jakarta?' }], source: { kind: 'user' } },
  {
    id: 'm3', role: 'assistant',
    content: [{ type: 'reasoning', text: 'need the tool' }, { type: 'tool-call', id: 'call_prev', name: 'get_weather', arguments: '{"city":"Jakarta"}' }],
    source: { kind: 'model', provider: 'test', model: 'test-model:free' },
  },
  { id: 'm4', role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_prev', content: [{ type: 'text', text: '31C sunny' }] }], source: { kind: 'tool', callId: 'call_prev' } },
]

const chunks = await collect({
  provider: 'kenari-direct',
  model: 'test-model:free',
  reasoningEffort: 'high',
  maxTokens: 256,
  temperature: 0.2,
  stop: ['END'],
  tools: [{ name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }],
  sessionId: 'adapter-test-session',
  messages,
})

// ------------------------------------------------------------- request shape
check('request is a streaming [OI] chat completion', lastRequest.stream === true && lastRequest.model === 'test-model:free')
check('request opts into the usage frame', lastRequest.stream_options?.include_usage === true, JSON.stringify(lastRequest.stream_options))
check('request carries the attribution user-agent', typeof lastHeaders?.['user-agent'] === 'string' && lastHeaders['user-agent'].length > 0, lastHeaders?.['user-agent'])
check('request maps max_tokens / temperature / stop / reasoning_effort',
  lastRequest.max_tokens === 256 && lastRequest.temperature === 0.2 && lastRequest.stop?.[0] === 'END' && lastRequest.reasoning_effort === 'high')
check('request maps tools to function schemas', lastRequest.tools?.[0]?.type === 'function' && lastRequest.tools[0].function.name === 'get_weather')
check('system prompt text becomes a system message', lastRequest.messages[0]?.role === 'system' && lastRequest.messages[0].content === 'You are terse.')
check('replayed assistant turn keeps tool_calls and drops reasoning',
  lastRequest.messages[2]?.role === 'assistant' && lastRequest.messages[2].tool_calls?.[0]?.id === 'call_prev' && !JSON.stringify(lastRequest.messages[2]).includes('need the tool'))
check('tool result becomes a role=tool message with the call id',
  lastRequest.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_prev' && m.content === '31C sunny'))

// ------------------------------------------------------------ chunk protocol
const kinds = chunks.map((chunk) => chunk.type)
check('stream opens a reasoning block before a text block',
  kinds[0] === 'block-start' && chunks[0].blockType === 'reasoning'
  && kinds.includes('block-start') && chunks[kinds.indexOf('block-start', 1)].blockType === 'text',
  kinds.slice(0, 4).join(','))
const reasoningEnd = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'reasoning')
check('reasoning block closes with its accumulated text', reasoningEnd?.block.text === 'thinking hard', reasoningEnd?.block.text)
const textEnd = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text')
check('text block closes with its accumulated text', textEnd?.block.text === 'Hello world', textEnd?.block.text)
const toolEnd = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
check('fragmented tool call reassembles name and arguments',
  toolEnd?.block.name === 'get_weather' && toolEnd?.block.arguments === '{"city":"Jakarta"}', `${toolEnd?.block.name} ${toolEnd?.block.arguments}`)
check('tool-call deltas carry the provider call id', chunks.filter((c) => c.type === 'tool-call-delta').every((c) => c.id === 'call_1'))

// ----------------------------------------------------------------- usage
const usageChunk = chunks.find((chunk) => chunk.type === 'usage')
check('usage counts are disjoint (input excludes cached)', usageChunk?.usage.inputTokens === 60 && usageChunk?.usage.cacheReadTokens === 40, JSON.stringify(usageChunk?.usage))
check('usage preserves the provider total', usageChunk?.usage.totalTokens === 120)
const finish = chunks.at(-1)
check('terminal chunk carries the tool-calls finish reason', finish?.type === 'finish' && finish.reason.kind === 'tool-calls', JSON.stringify(finish))

// -------------------------------------------------- ledger: usage and spend
const usageTotals = billing.usageTotals('adapter-test-session')
check('usage lands in the ledger under the session scope', usageTotals.calls === 1 && usageTotals.outputTokens === 20, JSON.stringify(usageTotals))
check('cached_tokens hit rate is derived (40 / (60 + 40))', usageTotals.hitRate === 0.4, `hitRate=${usageTotals.hitRate}`)

// 付费模型：usage 换算成预估费用，缓存读按 cache_read 单价而不是输入价
const oneShot = (model) => ({ provider: 'kenari-direct', model, maxTokens: 64, sessionId: 'adapter-test-session', messages: [{ id: `x_${model}`, role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }] })
await collect(oneShot('paid-model'))
await new Promise((resolve) => setTimeout(resolve, 200))
const paidSpend = billing.spendTotals('adapter-test-session')
// 60 未缓存 input @2 IDR/1M-token 单位 + 40 缓存读 @0.5 + 20 output @4 = 120 + 20 + 80 = 220 micro-IDR
check('paid model records an estimated spend (input + cache_read + output priced separately)',
  paidSpend.calls === 1 && paidSpend.estimatedMicroIdr === 220, `micro=${paidSpend.microIdr}`)

await collect(oneShot('test-model:free'))
await new Promise((resolve) => setTimeout(resolve, 200))
check('free model adds usage but no spend',
  billing.spendTotals('adapter-test-session').calls === 1 && billing.usageTotals('adapter-test-session').calls === 3,
  `spends=${billing.spendTotals('adapter-test-session').calls} usages=${billing.usageTotals('adapter-test-session').calls}`)

// ------------------------------------------------------------- model listing
const models = await adapter.listModels('kenari-direct')
check('listModels advertises only chat models', models.length === 2 && !models.some((m) => m.id === 'embed-only'), models.map((m) => m.id).join(','))
const free = models.find((m) => m.id === 'test-model:free')
check('listModels description carries price, context, vision and reasoning',
  free.description.includes('免费') && free.description.includes('ctx 4096') && free.description.includes('视觉') && free.description.includes('推理 low/high'), free.description)
const resolved = await adapter.resolveModel('kenari-direct', 'test-model:free')
check('resolveModel maps context window and reasoning efforts',
  resolved.context?.contextWindow === 4096 && (resolved.reasoning?.efforts ?? []).map((e) => e.id).join(',') === 'low,high', JSON.stringify(resolved.reasoning))

// --------------------------------------------------------------- failures
let authError
try {
  await collect({ provider: 'kenari-direct', model: 'error-model', messages: [{ id: 'e1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }] })
} catch (err) {
  authError = err
}
check('401 classifies as AUTH and keeps the actionable advice',
  authError instanceof LlmError && authError.code === 'AUTH' && authError.message.includes('鉴权失败'), `${authError?.code}`)

let emptyError
try {
  await collect({ provider: 'kenari-direct', model: 'empty-model', messages: [{ id: 'e2', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }] })
} catch (err) {
  emptyError = err
}
check('degenerate empty completion classifies as EMPTY_RESPONSE', emptyError?.code === 'EMPTY_RESPONSE', String(emptyError?.code))

server.close()

const failed = results.filter((row) => !row.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) console.log('FAILED:', failed.map((row) => row.name).join(' | '))
process.exit(failed.length === 0 ? 0 : 1)
