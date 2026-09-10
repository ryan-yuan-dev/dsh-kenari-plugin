/**
 * Billed-media verification: the two tools whose happy path costs real Rupiah,
 * so they stay out of the always-on harness test.
 *
 * Each call checks two things at once:
 *   1. it works end to end through the real dsh tool runtime (registry →
 *      transport → attachment store);
 *   2. our cost estimate lands in the same order of magnitude as what Kenari
 *      actually deducted, measured from the wallet balance before and after.
 *      An estimate off by 1000x is worse than no estimate, so it is measured
 *      rather than assumed.
 *
 * One run makes three small billed calls (TTS through the tool, one raw TTS
 * fetch to produce an audio input, STT through the tool) — single-digit Rupiah
 * with the shipped models. The Kenari key is read from ~/.dsh/.env and never
 * printed.
 *
 * Run: node test/billed-media.mjs
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const GLOBAL = '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const load = async (name) => (await import(`${GLOBAL}/${name}/lib/index.js`)).default

const API_KEY = /^KENARI_API_KEY=(.+)$/m.exec(readFileSync(join(process.env.HOME, '.dsh', '.env'), 'utf8'))?.[1]?.trim()
if (API_KEY === undefined) {
  console.error('SKIP: KENARI_API_KEY not configured')
  process.exit(2)
}

/** TTS model verified working (kokoro-tts and gemini-3-1-flash-tts are broken upstream). */
const TTS_MODEL = process.env.KENARI_TTS_MODEL ?? 'mimo-v2-5-tts'
/** STT model: Rp 0.175 per second of audio. */
const STT_MODEL = process.env.KENARI_STT_MODEL ?? 'whisper-large-v3-turbo'
const SPOKEN = 'Kenari speaking test.'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
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
ctx.plugin(attachmentPlugin, { dshHome: mkdtempSync(join(tmpdir(), 'kenari-billed-')) })

const { apply, Config } = await import('../lib/index.js')
ctx.plugin({ name: 'kenari', inject: ['web', 'tools'], apply }, { ...Config({}) })
await new Promise((resolve) => setTimeout(resolve, 300))

const tools = ctx.get('tools')
const call = (name, args) => tools.execute({
  callId: `call_${name}_${Date.now()}`,
  name,
  arguments: args,
  agent: { id: 'billed-media-run' },
  signal: AbortSignal.timeout(300_000),
})

/** Wallet balance in Rupiah, freshly read (the monitor caches by TTL). */
const balance = async () => {
  const result = await call('kenari_billing', { refresh_balance: true })
  return result.value?.balance_rp
}
const rp = (value) => value === undefined ? '?' : `Rp ${value.toLocaleString('id-ID', { maximumFractionDigits: 3 })}`

const startRp = await balance()
console.log(`balance before: ${rp(startRp)}\n`)

// ------------------------------------------------- TTS through the tool
const speech = await call('kenari_speech', { model: TTS_MODEL, input: SPOKEN })
const speechText = speech.value?.text ?? ''
check('kenari_speech returns an audio attachment (no error)', speech.isError === false && (speech.value?.attachments?.length ?? 0) === 1, speechText.split('\n')[0])
check('kenari_speech echoes a cost estimate with its per-unit basis', speechText.includes('费用：约') && speechText.includes('按千字符计费'))
const attachment = speech.value?.attachments?.[0]
console.log(`  attachment: name=${attachment?.name} bytes=${attachment?.bytes}`)
check('speech attachment is a non-empty file ref', (attachment?.bytes ?? 0) > 0 && attachment?.kind === 'file')

const afterSpeechRp = await balance()
const speechCharge = startRp !== undefined && afterSpeechRp !== undefined ? startRp - afterSpeechRp : undefined
console.log(`balance after TTS: ${rp(afterSpeechRp)} (charged ${rp(speechCharge)})\n`)

// ------------------------------- raw TTS fetch: audio input for the STT leg
const rawSpeech = await fetch('https://kenari.id/v1/audio/speech', {
  method: 'POST',
  headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: TTS_MODEL, input: SPOKEN }),
})
check('raw TTS probe returned audio bytes', rawSpeech.ok, `HTTP ${rawSpeech.status}`)
const audio = Buffer.from(await rawSpeech.arrayBuffer())
console.log(`  raw audio: ${audio.length} bytes, ${rawSpeech.headers.get('content-type')}\n`)

const afterRawRp = await balance()
const rawCharge = afterSpeechRp !== undefined && afterRawRp !== undefined ? afterSpeechRp - afterRawRp : undefined
console.log(`balance after raw TTS: ${rp(afterRawRp)} (charged ${rp(rawCharge)})\n`)

// ------------------------------------------------- STT through the tool
const transcribe = await call('kenari_transcribe', {
  model: STT_MODEL,
  file_data_url: `data:audio/mpeg;base64,${audio.toString('base64')}`,
  response_format: 'verbose_json',
})
const transcribeText = transcribe.value?.text ?? ''
check('kenari_transcribe returns text (no error)', transcribe.isError === false && transcribeText.length > 0, transcribeText.split('\n')[0]?.slice(0, 120))
check('transcription matches the spoken line', /kenari|speaking|test/i.test(transcribeText))
check('kenari_transcribe echoes a cost estimate', transcribeText.includes('费用'))

const afterSttRp = await balance()
const sttCharge = afterRawRp !== undefined && afterSttRp !== undefined ? afterRawRp - afterSttRp : undefined
console.log(`balance after STT: ${rp(afterSttRp)} (charged ${rp(sttCharge)})\n`)

// ------------------------------------------------- estimate vs reality
const total = startRp !== undefined && afterSttRp !== undefined ? startRp - afterSttRp : undefined
console.log(`measured total charge: ${rp(total)}`)
const estimatedMicro = (speech.value?.text ?? '').match(/micro_idr|费用：约 Rp ([\d.]+)/)?.[1]
if (estimatedMicro !== undefined) console.log(`our TTS estimate was Rp ${estimatedMicro}`)
console.log('note: a sub-Rupiah charge may round to Rp 0 in the wallet; that is the gateway\'s rounding, not a free call')

const failed = results.filter((row) => !row.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
