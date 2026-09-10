/**
 * Opt-in verification of the one remaining phase-2 gap: `kenari_video_content`
 * (downloading a finished video), which only a real generation can exercise.
 *
 * This one costs real money — a 4-second 360p gemini-omni-flash clip is about
 * Rp 1.400 — so it never runs by accident: set KENARI_ALLOW_VIDEO=1.
 *
 * Run: KENARI_ALLOW_VIDEO=1 node test/billed-video.mjs
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.env.KENARI_ALLOW_VIDEO !== '1') {
  console.error('SKIP: this test generates a real video (~Rp 1.400). Set KENARI_ALLOW_VIDEO=1 to run it.')
  process.exit(2)
}

const GLOBAL = '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const load = async (name) => (await import(`${GLOBAL}/${name}/lib/index.js`)).default
const API_KEY = /^KENARI_API_KEY=(.+)$/m.exec(readFileSync(join(process.env.HOME, '.dsh', '.env'), 'utf8'))?.[1]?.trim()
if (API_KEY === undefined) {
  console.error('SKIP: KENARI_API_KEY not configured')
  process.exit(2)
}

const MODEL = process.env.KENARI_VIDEO_MODEL ?? 'gemini-omni-flash'
const DURATION = Number(process.env.KENARI_VIDEO_SECONDS ?? '4')
const RESOLUTION = process.env.KENARI_VIDEO_RESOLUTION ?? '360p'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

const { Context } = await import('@deepseek-ai/cordis')
const [systemPromptPlugin, toolsPlugin, attachmentPlugin] = await Promise.all([
  load('dsh-system-prompt'), load('dsh-tools'), load('dsh-attachment-local'),
])
const ctx = new Context()
ctx.provide('web', { registerSearchProvider() {}, registerFetchProvider() {} })
ctx.provide('credentials', {
  resolve: async () => ({ value: API_KEY, source: 'test' }),
  describe: async () => ({ configured: true, source: 'test', writable: false }),
})
ctx.plugin(systemPromptPlugin)
ctx.plugin(toolsPlugin)
ctx.plugin(attachmentPlugin, { dshHome: mkdtempSync(join(tmpdir(), 'kenari-video-')) })
const { apply, Config } = await import('../lib/index.js')
ctx.plugin({ name: 'kenari', inject: ['web', 'tools'], apply }, { ...Config({}) })
await new Promise((resolve) => setTimeout(resolve, 300))

const tools = ctx.get('tools')
const call = (name, args) => tools.execute({
  callId: `call_${name}_${Date.now()}`,
  name,
  arguments: args,
  agent: { id: 'billed-video-run' },
  signal: AbortSignal.timeout(540_000),
})
const balance = async () => (await call('kenari_billing', { refresh_balance: true })).value?.balance_rp
const rp = (value) => value === undefined ? '?' : `Rp ${value.toLocaleString('id-ID')}`

const startRp = await balance()
console.log(`balance before: ${rp(startRp)}`)
console.log(`generating ${DURATION}s ${RESOLUTION} on ${MODEL}\n`)

const job = await call('kenari_video_generate', {
  model: MODEL,
  prompt: 'A single red paper boat floating on calm water, slow push-in, soft daylight.',
  duration: DURATION,
  resolution: RESOLUTION,
})
check('kenari_video_generate returns a job id', job.isError === false && typeof job.value?.job_id === 'string', job.value?.job_id)
check('kenari_video_generate echoes a per-second estimate', (job.value?.text ?? '').includes('费用：约') && (job.value?.text ?? '').includes('按秒计费'))
const jobId = job.value?.job_id

let status = 'rendering'
let polled = 0
while (status === 'rendering' && polled < 60) {
  await new Promise((resolve) => setTimeout(resolve, 5_000))
  polled++
  const state = await call('kenari_video_status', { job_id: jobId })
  status = state.value?.status ?? 'unknown'
  if (polled % 6 === 0) console.log(`  polling: ${status} (${polled * 5}s)`)
}
check('video job reaches a terminal state', status === 'done' || status === 'failed' || status === 'expired', `status=${status} after ${polled * 5}s`)

if (status === 'done') {
  const content = await call('kenari_video_content', { job_id: jobId })
  const attachment = content.value?.attachments?.[0]
  check('kenari_video_content downloads the file into an attachment', content.isError === false && (attachment?.bytes ?? 0) > 0, `name=${attachment?.name} bytes=${attachment?.bytes}`)
} else {
  check('kenari_video_content downloads the file into an attachment', false, `skipped: job ${status} (a failed job is not billed)`)
}

const endRp = await balance()
const charge = startRp !== undefined && endRp !== undefined ? startRp - endRp : undefined
console.log(`\nbalance after: ${rp(endRp)} (measured charge ${rp(charge)})`)
console.log(`expected for ${DURATION}s @ ${RESOLUTION}: see the estimate echoed above`)

const failed = results.filter((row) => !row.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
