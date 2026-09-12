/**
 * 默认路由（`src/default-route.ts`）实测。
 *
 * 跑真实代码路径：真目录（`/v1/models`）、真套餐表（`/api/plans`）、真额度端点
 * （`/v1/account/quota`，只读免费）。设置服务用假对象，把**写入决定**录下来断言——
 * 这一段正是"什么时候该动用户配置"的全部逻辑。
 *
 * key 从 `~/.dsh/.env` 读，永不打印。
 * 运行：node test/default-route.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DISPLAY_NAME_PREFIX, KenariCatalog, displayNameOf } from '../lib/catalog.js'
import { KenariPlans } from '../lib/plans.js'
import { applyPlanDefaultRoute, refreshRouteModelNames } from '../lib/default-route.js'

const envFile = readFileSync(join(process.env.HOME, '.dsh', '.env'), 'utf8')
const API_KEY = /^KENARI_API_KEY=(.+)$/m.exec(envFile)?.[1]?.trim()
console.log(API_KEY === undefined ? 'NOTE  没有 KENARI_API_KEY：只能验无 key 路径\n' : 'NOTE  使用 ~/.dsh/.env 里的 key（不打印）\n')

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
  if (!ok) failures++
}

const deps = (resolveApiKey) => ({
  config: { baseURL: 'https://kenari.id', catalogCacheTtlMs: 0, timeoutMs: 30_000, maxRetries: 1 },
  resolveApiKey,
  logger: { info: () => {}, warn: (m) => console.log(`  [warn] ${m}`) },
})

const catalog = new KenariCatalog(deps(async () => undefined))
const plans = new KenariPlans(deps(async () => undefined))

/** 假设置服务：记录 mutate 调用，不落盘。 */
const fakeSettings = (descriptor) => {
  const writes = []
  return {
    writes,
    ctx: {
      settings: {
        describe: () => [descriptor],
        mutate: async (ns, ops, revision) => { writes.push({ ns, ops, revision }) },
      },
    },
  }
}

/** pi-ai 那一节的设置描述符：base = patch 预设，user 视用例而定。 */
const PRESET_MODELS = [
  { id: 'deepseek-v4-flash', contextWindow: 1048576, input: ['text'] },
  { id: 'glm-5-3-flash', contextWindow: 1000000, input: ['text', 'image'] },
  { id: 'gpt-5-6-luna', contextWindow: 872000, input: ['text', 'image'] },
  { id: 'mimo-v2-5', contextWindow: 1050000, input: ['text', 'image'] },
]
const descriptor = (user) => ({
  ns: 'llm-pi-ai', schema: {}, value: {}, revision: 42, applies: true,
  base: { providers: { kenari: { models: PRESET_MODELS } } },
  ...(user === undefined ? {} : { user }),
})

// 1) 用户层自己写过 models → 一个字都不写
{
  const fake = fakeSettings(descriptor({ providers: { kenari: { models: [{ id: 'user-picked' }] } } }))
  await applyPlanDefaultRoute(fake.ctx, { http: deps(async () => API_KEY), catalog, plans })
  check('用户层持有 models 时不写设置', fake.writes.length === 0, `writes=${fake.writes.length}`)
}

// 2) 没有 key → 保持预设，不写设置
{
  const fake = fakeSettings(descriptor())
  await applyPlanDefaultRoute(fake.ctx, { http: deps(async () => undefined), catalog, plans })
  check('没有 key 时不写设置', fake.writes.length === 0, `writes=${fake.writes.length}`)
}

// 3) 无效 key（quota 401）→ 保持预设，不写设置
{
  const fake = fakeSettings(descriptor())
  await applyPlanDefaultRoute(fake.ctx, { http: deps(async () => 'kn-invalid-for-test'), catalog, plans })
  check('key 无效时不写设置', fake.writes.length === 0, `writes=${fake.writes.length}`)
}

// 4) 真 key：按套餐免缓存清单决定写不写；写了就核对内容与 pi-ai schema
if (API_KEY !== undefined) {
  const fake = fakeSettings(descriptor())
  await applyPlanDefaultRoute(fake.ctx, { http: deps(async () => API_KEY), catalog, plans })

  const quota = await (await fetch('https://kenari.id/v1/account/quota', {
    headers: { Authorization: `Bearer ${API_KEY}` },
  })).json()
  const planName = quota?.plan?.name
  const plan = (await plans.list()).find((p) => p.name === planName)
  const expected = plan?.freeCacheModels ?? []
  const presetIds = PRESET_MODELS.map((m) => m.id).sort()

  if (expected.length === 0) {
    check('套餐无免缓存清单时不写设置', fake.writes.length === 0, `plan=${planName ?? '(null)'}`)
  } else if (planName === undefined) {
    check('读不到套餐名时不写设置', fake.writes.length === 0)
  } else if ([...expected].sort().join() === presetIds.join()) {
    check(`套餐 ${planName} 的免缓存清单与预设一致 → 不写设置`, fake.writes.length === 0,
      `writes=${fake.writes.length}`)
  } else {
    check(`套餐 ${planName} 的免缓存清单与预设不同 → 写一次`, fake.writes.length === 1, `writes=${fake.writes.length}`)
    if (fake.writes.length === 1) {
      const op = fake.writes[0].ops[0]
      const ids = op.value.map((m) => m.id)
      check('写入路径是 providers.kenari.models', op.path.join('.') === 'providers.kenari.models', op.path.join('.'))
      check('写入用的是读到的 revision', fake.writes[0].revision === 42, String(fake.writes[0].revision))
      check('只保留免缓存清单里、目录里可当会话模型的 id',
        ids.every((id) => expected.includes(id)),
        `${ids.length}/${expected.length} 个：${ids.join(', ')}`)
      check('非会话模型被过滤掉（清单里若有）',
        ids.every((id) => !id.includes('embedding')))
      // 与 catalog-view 同一道关：写进设置的东西必须过 pi-ai 的 schema
      try {
        const { Config } = await import(
          '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js'
        )
        Config({ providers: { kenari: { api: 'openai-completions', baseURL: 'https://kenari.id/v1', models: op.value } } })
        check('写入内容通过 llm-pi-ai schema 校验', true)
      } catch (err) {
        check('写入内容通过 llm-pi-ai schema 校验', false, String(err).slice(0, 120))
      }
      console.log(`\n套餐：${planName}；免缓存清单 ${expected.length} 个 → 路由写入 ${ids.length} 个`)
    }
  }
}

// ── 名字刷新（`refreshRouteModelNames`）─────────────────────────────────────────
//
// 口径变过一次（0.2.0 起路由名带 `Kenari ` 前缀），而设置是一次性物化的，所以要有一条
// 把旧名字刷过来的路径。判据是**值**不是来源：只有仍然逐字等于旧口径派生值的名字才动。
// 下面四个用例把这条边界钉死（真目录，id 取目录里一定有的会话模型）。
const oldName = displayNameOf({ id: 'deepseek-v4-flash' })
const modelsIn = (entries) => ({ providers: { kenari: { models: entries } } })

/** 跑一次刷新，返回假设置服务。 */
const runRefresh = async (user) => {
  const fake = fakeSettings(descriptor(user))
  await refreshRouteModelNames(fake.ctx, { http: deps(async () => undefined), catalog })
  return fake
}

// 1) 旧口径的名字 → 就地加前缀，其余字段一个不动
{
  const fake = await runRefresh(modelsIn([
    { id: 'deepseek-v4-flash', name: oldName, maxTokens: 65536, compat: { keep: 1 } },
  ]))
  const written = fake.writes[0]?.ops[0]
  const row = written?.value?.[0]
  check('旧口径的名字被刷成带前缀', written !== undefined && row?.name === DISPLAY_NAME_PREFIX + oldName,
    `writes=${fake.writes.length}${row === undefined ? '' : `，name=${row.name}`}`)
  check('刷新只改 name，其它字段原样带走',
    row?.maxTokens === 65536 && row?.compat?.keep === 1 && row?.id === 'deepseek-v4-flash')
}

// 2) 用户改过名 → 一个字节都不碰（这是"用户的东西最大"的边界）
{
  const fake = await runRefresh(modelsIn([{ id: 'deepseek-v4-flash', name: '便宜的那个' }]))
  check('用户改过的名字不被刷新覆盖', fake.writes.length === 0, `writes=${fake.writes.length}`)
}

// 3) 已经带前缀 → 幂等（第二次启动不再写）
{
  const fake = await runRefresh(modelsIn([{ id: 'deepseek-v4-flash', name: DISPLAY_NAME_PREFIX + oldName }]))
  check('已带前缀时不再写（幂等）', fake.writes.length === 0, `writes=${fake.writes.length}`)
}

// 4) 用户层没有这个数组 / 目录查不到的 id → 都不写
{
  const noArray = await runRefresh(undefined)
  const unknownId = await runRefresh(modelsIn([{ id: 'user-handwritten', name: oldName }]))
  check('用户层没有数组时不写（预设本身已是当前口径）', noArray.writes.length === 0, `writes=${noArray.writes.length}`)
  check('目录里查不到的 id 不写（可能是用户手写的路由条目）', unknownId.writes.length === 0, `writes=${unknownId.writes.length}`)
}

if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n默认路由检查通过')
