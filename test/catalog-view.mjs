/**
 * 模型视图（`/api/kenari.models` 的载荷）实测脚本。
 *
 * 跑的是 Host 侧真实代码路径：KenariCatalog 抓 `/v1/models`（含 `?modality=embedding`）、
 * KenariPlans 抓 `/api/plans`、buildCatalogView 组装浏览器视图。
 * 三个来源都是公开端点，不需要 key。
 *
 * 断言的是**形状与派生规则**，不是具体模型：目录内容会随上游变化，
 * 这里只要求"标签从目录事实推出来、套餐 join 上了、profile 是 pi-ai 认的形状"。
 *
 * 运行：node test/catalog-view.mjs
 */
import { DISPLAY_NAME_PREFIX, KenariCatalog, kenariNameOf } from '../lib/catalog.js'
import { KenariPlans, coverageOf } from '../lib/plans.js'
import { buildCatalogView } from '../lib/catalog-view.js'

const deps = {
  config: { baseURL: 'https://kenari.id', catalogCacheTtlMs: 0, timeoutMs: 30_000, maxRetries: 1 },
  resolveApiKey: async () => undefined,
  logger: { info: () => {}, warn: () => {} },
}

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
  if (!ok) failures++
}

const catalog = new KenariCatalog(deps)
const plans = new KenariPlans(deps)
const view = await buildCatalogView({ http: deps, catalog, plans })

check('目录非空', view.models.length > 0, `${view.models.length} 个模型`)
check('embedding 目录被并入', view.models.some((m) => m.tags.includes('embedding')),
  `embedding 标签 ${view.models.filter((m) => m.tags.includes('embedding')).length} 个`)
check('标签只在已知取值内', view.models.every((m) => m.tags.every((tag) => view.tags.includes(tag))))

// 标签必须由事实推出，而不是凭空出现：带 audio 标签的行总能在 input 或 endpoints 里找到依据
const audioGrounded = view.models.filter((m) => m.tags.includes('audio')).every((m) =>
  m.input.includes('audio') || m.endpoints.includes('audio_speech') || m.endpoints.includes('audio_transcription'))
check('audio 标签有目录依据', audioGrounded)
const videoGrounded = view.models.filter((m) => m.tags.includes('video')).every((m) =>
  m.input.includes('video') || m.endpoints.includes('videos'))
check('video 标签有目录依据', videoGrounded)

// 套餐 join：Kenari 的套餐表用裸 id，目录用 `:free` 后缀，所以 join 必须归一
const covered = view.models.filter((m) => m.plans.length > 0)
check('套餐表读取成功', view.plansError === undefined, view.plansError ?? '')
check('有模型 join 到套餐', covered.length > 0, `${covered.length}/${view.models.length} 个模型覆盖于至少一个套餐`)
check('套餐条目带模型数', view.plans.length > 0 && view.plans.every((p) => typeof p.modelCount === 'number' && p.name.length > 0))

// profile 是要写回 llm-pi-ai 路由的形状：多余或缺失的键都会被 schemastery 拒
const LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
check('每个模型都带可用 profile', view.models.every((m) => m.profile.id === m.id))
check('profile 的 input 非空且只含 text/image',
  view.models.every((m) => Array.isArray(m.profile.input) && m.profile.input.length > 0
    && m.profile.input.every((x) => x === 'text' || x === 'image')))
check('profile 的 reasoningEfforts 键都是 dsh 档位',
  view.models.every((m) => m.profile.reasoningEfforts === undefined
    || Object.keys(m.profile.reasoningEfforts).every((k) => LEVELS.has(k))))
// 展示名与输出上限：目录里没有任何会话模型的 `name`（只有 8 个专用模型有），也没有
// 输出上限字段，所以两者都由插件推出来。正确性用目录自己的事实反测。
check('每个 profile 都带非空展示名',
  view.models.every((m) => typeof m.profile.name === 'string' && m.profile.name.trim().length > 0))
// 断言的是**性质**而不是把公式抄一遍：不超过窗口的 1/4、是 1K 的整数倍、在界内。
// 「不超过 1/4」这条曾经真的抓到 bug：早期版本有 8192 下限，于是窗口只有 8192 的
// `bge-m3` 被推荐了 8192 —— 等于把整个窗口都算成输出。
check('maxTokens 不超过窗口的 1/4，且是 1K 的整数倍',
  view.models.every((m) => {
    const contextWindow = m.profile.contextWindow
    const maxTokens = m.profile.maxTokens
    if (contextWindow === undefined) return maxTokens === undefined
    return typeof maxTokens === 'number'
      && maxTokens >= 1024 && maxTokens <= 65536
      && maxTokens % 1024 === 0
      && maxTokens <= Math.max(1024, Math.floor(contextWindow / 4))
  }),
  `${view.models.filter((m) => m.profile.maxTokens !== undefined).length} 个带 maxTokens`)
// 上限是推出来的，不是常数：目录里既有 128K 窗口也有 1M 窗口，取值应当跟着分档。
const maxTokenValues = [...new Set(view.models.map((m) => m.profile.maxTokens).filter((v) => v !== undefined))].sort((a, b) => a - b)
check('maxTokens 不是单一常数（随窗口分档）', maxTokenValues.length > 1, `取值：${maxTokenValues.join(' / ')}`)

// 目录自带 `name` 的那几个模型（Veo 3.1 Lite、MiniMax Speech 2.8 Turbo、Nano Banana Pro…）
// 是 slug→模型自己名字 的规则的**标准答案**：把 name 抹掉再推一遍，必须与厂商写法逐字一致。
// 这条比断言某个具体模型强：它验证的是规则本身，且目录换了模型也照样成立。
// 比的是 `kenariNameOf`（不带路由前缀的那一半），展示名另有一条断言。
//
// 这里读的是**原始目录**而不是视图：视图的 `name` 现在已经是展示名了（见下一条），
// 拿它当"厂商写法"会把这条断言变成自证。
const rawModels = [...await catalog.list(), ...await catalog.list('embedding')]
const rawNameById = new Map(rawModels.map((m) => [m.id, typeof m.name === 'string' ? m.name.trim() : '']))
const vendorNamed = rawModels.filter((m) => (rawNameById.get(m.id) ?? '').length > 0)
const derivedMatches = vendorNamed.filter((m) => kenariNameOf({ id: m.id }) === rawNameById.get(m.id))
check('slug→模型名 与目录自己的写法逐字一致',
  vendorNamed.length > 0 && derivedMatches.length === vendorNamed.length,
  `${derivedMatches.length}/${vendorNamed.length} 个：${vendorNamed.map((m) => `${m.id}→${rawNameById.get(m.id)}`).join('、') || '目录里没有带 name 的模型'}`)

// 展示名 = 路由前缀 + 模型自己的名字，且前缀是**唯一**的加工：右侧的对照项来自原始目录行，
// 不是视图自己那个已经带前缀的 name——拿视图反推会把这条断言变成自证。dsh 只在 `/` 模型菜单
// 里印 provider，composer 的模型按钮只有展示名，不带前缀就分不出 Kenari 与官方 DeepSeek
// 的同名模型。
const rawById = new Map(rawModels.map((m) => [m.id, m]))
check('展示名统一带 Kenari 前缀，且前缀之后就是模型自己的名字',
  view.models.every((m) => m.name === DISPLAY_NAME_PREFIX + kenariNameOf(rawById.get(m.id) ?? { id: m.id })),
  `${view.models.length} 个，例如 ${view.models[0] === undefined ? '—' : `${view.models[0].id}→${view.models[0].name}`}`)

// 视图的 name 必须是展示名，而不是目录原样透传：后者对无名模型等于 id，界面把 id 印两遍。
// 同一个模型的 profile.name 已经派生过，两者一致才算一个口径。
check('视图的 name 与 profile.name 同口径（都是展示名）',
  view.models.every((m) => m.name === m.profile.name))
const unnamed = view.models.filter((m) => (rawNameById.get(m.id) ?? '') === '')
check('目录没给 name 的模型拿到展示名而不是 id 复读',
  unnamed.length > 0 && unnamed.every((m) => m.name.length > 0 && m.name !== m.id),
  `${unnamed.length} 个无名模型，例如 ${unnamed[0] === undefined ? '—' : `${unnamed[0].id}→${unnamed[0].name}`}`)
// 反过来说：目录自己给了 name 的，视图与 profile 都必须照抄厂商写法，不能被 id 还原覆盖掉。
// 前缀之后必须与厂商写法逐字一致，所以这里连前缀一起比，而不是只看后缀。
check('目录给了 name 的模型沿用厂商写法',
  vendorNamed.every((m) => view.models.find((v) => v.id === m.id)?.name === DISPLAY_NAME_PREFIX + rawNameById.get(m.id)))
check('没有重复模型 id', new Set(view.models.map((m) => m.id)).size === view.models.length)

// 最后一道关：把**全部** profile 一次性交给真实的 llm-pi-ai Config schema 校验。
// 设置页的写入就是过这一关；少一个键、多一个键、档位名不对，整节都会被拒。
// 这条断言比"点一次 UI 加一个模型"强：它覆盖全部目录行，而不是抽样的那一个。
try {
  const { default: piAiConfig } = await import(
    '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js'
  ).then((mod) => ({ default: mod.Config }))
  const validated = piAiConfig({
    providers: { kenari: { api: 'openai-completions', baseURL: 'https://kenari.id/v1', models: view.models.map((m) => m.profile) } },
  })
  check('全部 profile 通过 llm-pi-ai schema 校验', validated.providers.kenari.models.length === view.models.length,
    `${validated.providers.kenari.models.length} 个`)
} catch (err) {
  // 全局 dsh 不在预期路径时跳过，而不是把环境差异报成插件失败
  const message = err instanceof Error ? err.message : String(err)
  if (message.includes('Cannot find module') || message.includes('ERR_MODULE_NOT_FOUND')) {
    console.log('SKIP  全部 profile 通过 llm-pi-ai schema 校验  — 本机没有全局 dsh 的 llm-pi-ai 包')
  } else {
    check('全部 profile 通过 llm-pi-ai schema 校验', false, message)
  }
}

// 免费判定与套餐归属两件事不能混：免费模型仍可能在套餐覆盖里
const freeCovered = view.models.filter((m) => m.free && m.plans.length > 0)
check('免费与套餐是独立维度', freeCovered.length > 0, `${freeCovered.length} 个免费模型同时被套餐覆盖`)

// coverageOf 的归一：带后缀的 id 也能查到裸 id 的覆盖
const index = await plans.coverage()
const sample = view.models.find((m) => m.id.endsWith(':free') && m.plans.length > 0)
check('coverageOf 对 `:free` id 归一命中',
  sample !== undefined && coverageOf(index, sample.id).plans.length > 0,
  sample === undefined ? '目录里没有同时免费且被套餐覆盖的模型' : sample.id)

const sampleView = view.models.find((m) => m.tags.length >= 2) ?? view.models[0]
console.log('\n样例：', JSON.stringify({
  id: sampleView.id, name: sampleView.name, tags: sampleView.tags,
  plans: sampleView.plans, free: sampleView.free, chatCapable: sampleView.chatCapable,
  profile: sampleView.profile,
}, null, 1))
console.log(`\n套餐：${view.plans.map((p) => `${p.name}(${p.modelCount})`).join(' ')}`)

if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n模型视图检查通过')
