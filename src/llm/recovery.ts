/**
 * Kenari 路由的模型失败恢复：同路由重试 → 换模型 → 回退默认 provider，逐级升级。
 *
 * 三个阶段都由本模块负责，`dsh-llm-retry` 在 Kenari 路由上是关掉的（见 `./retry.ts`）。
 * 原因：`agent/request-error` 是没有默认行为的瀑布，不调用 `next()` 的监听器会否决它后面的
 * 一切；只要注册顺序被 live reload 翻过来一次，排在后面的 llm-retry 就永久出局，而插件
 * 观察不到。实测线上 `llm/retry` 事件数为 0、换模型发生在第一次失败上，说明承诺的 5 次重试
 * 从未执行。把重试收进自己的状态机，行为才是可验证、可测试的。
 *
 * 两个监听器的注册顺序是设计的一部分，不是随手写的：
 * 1. `agent/request` 用 `prepend` 挂在**最外层**。瀑布里外层拿最终决定权，而
 *    `installModelSelection` 会用「本 step 组装时捕获的」原模型回写 —— 排在内层会被它改回去
 *    （`packages/core/agent/src/model-selection.ts:88-105`）。
 * 2. `agent/request-error` 用默认顺序，但**先 `await next()`**：链上（`dsh-llm-retry`、
 *    compaction 等）若已决定重试，我们原样放行；只有链上放弃时才走自己的升级。这样无论
 *    注册顺序如何，插件都不会饿死别人的恢复策略。
 * @module dsh-kenari-plugin/llm/recovery
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
// Type-only：拉入 agent/* 与 session/event 的事件声明合并
import type {} from '@deepseek-ai/dsh-agent'
import type { RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { isRecoveryProvider, sleepUnlessAborted } from './retry.js'
import type { ModelCandidates } from './candidates.js'

/** 升级阶段：0 未升级，1 已换模型，2 已回退默认 provider。 */
type Stage = 0 | 1 | 2

/** 一次替换的目标路由。档位用 dsh 的 brand 类型，直接喂回 `agent/request` 才合法。 */
export interface Target {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
}

/** 一个会话的恢复状态。按 Session 对象存 WeakMap，会话释放即回收。 */
interface SessionState {
  /** `${turn}:${step}`；重试停留在同一个 step，所以升级过程不重置。 */
  stepKey: string
  stage: Stage
  target?: Target
  /** 本 step 内已经失败过的路由（`provider/model`）。换模型时排除它们，避免来回横跳。 */
  tried: Set<string>
  /** 我们已为**当前路由**重试过几次；路由一变就清零，让新模型拿到完整的一轮。 */
  ownRetries: number
  /** 上面那个计数的记账路由，用来发现路由变化。 */
  ownRoute?: string
  /** 是否已为当前路由注入过「本地重试」通知，免得每次重试都吵一次。 */
  retryNoticeSent: boolean
}

/** 恢复机制的可调输入与依赖。 */
export interface ModelRecoveryDeps {
  /** 总开关。false 时一个监听器都不装。 */
  enabled: boolean
  /** 参与恢复的 provider 路由；范围外的失败原样交给链上的其他监听者。 */
  providers: readonly string[]
  /** 是否允许换模型；false 时只做同路由重试，预算用尽后该轮以 error 结束。 */
  switchEnabled: boolean
  /** 首次请求之后的额外重试次数。 */
  retryMaxRetries: number
  /** 每次重试前的固定等待毫秒数。 */
  retryDelayMs: number
  /** 允许重试的失败码；码不在其中直接进入换模型阶段。 */
  retryCodes: readonly string[]
  /** 是否注入「正在本地重试」的通知 —— 重试期间界面没有别的痕迹，静默等待会让人困惑。 */
  retryNoticeEnabled: boolean
  /** 换模型/回退前的等待毫秒数。 */
  switchDelayMs: number
  /** 跳过「同 provider 换模型」、直接回退 provider 的失败码。 */
  skipCodes: readonly string[]
  /** 是否注入模型切换通知。 */
  noticeEnabled: boolean
  candidates: ModelCandidates
  /** dsh 默认 provider/model；服务缺失时返回 undefined，回退阶段自动退化为放弃。 */
  defaultSelection: () => Target | undefined
  logger?: { warn(msg: string): void; info(msg: string): void }
}

/** 下游（链上更内层）的策略结论；抛错也收成值，好让我们留痕后继续自己的恢复。 */
type Downstream =
  | { type: 'decision'; decision: RequestErrorAction }
  | { type: 'error'; error: unknown }

/** 先让链上决定。`next()` 抛错不该毁掉我们的恢复，但要留痕。 */
async function settleDownstream(next: () => Promise<RequestErrorAction>): Promise<Downstream> {
  try {
    return { type: 'decision', decision: await next() }
  } catch (error) {
    return { type: 'error', error }
  }
}

/** 决定本次失败后进入哪个升级阶段；undefined 表示放弃。 */
function planStage(stage: Stage, code: string, deps: ModelRecoveryDeps): Stage | undefined {
  if (!deps.switchEnabled) return undefined
  if (stage === 0) return deps.skipCodes.includes(code) ? 2 : 1
  if (stage === 1) return 2
  return undefined
}

/** 装上恢复机制。调用方负责只在 llm seam 存在时调用（`ctx.inject(['llm'], …)`）。 */
export function installModelRecovery(ctx: Context, deps: ModelRecoveryDeps): void {
  if (!deps.enabled) return

  const states = new WeakMap<Session, SessionState>()
  /**
   * 一个会话在本 step 内由链上策略（`dsh-llm-retry`）排程的重试次数。
   *
   * 用途只有一个：**判断这轮重试该由谁负责**。链上已经在重试时我们不再补一轮自己的预算，
   * 否则两条机制会叠加成两倍的等待与请求。出厂配置把 Kenari 路由的 dsh 重试关掉了
   * （`cordis.patch.yml` 的 `maxRetries: 0`），所以正常情况这里恒为 0，重试由我们负责；
   * 用户可以重新打开它，那时就交给 dsh，我们只在它一次都没出手时才兜底。
   */
  const scheduled = new WeakMap<Session, { stepKey: string; count: number }>()

  // 最外层：先拿到全链结果再覆盖，才能盖过 installModelSelection 用组装快照做的回写
  ctx.on('agent/request', async ({ agent }, next) => {
    const resolved = await next()
    const target = states.get(agent.session)?.target
    if (target === undefined) return resolved
    // 档位是 adapter-owned、按模型定义的：把上一个模型的档位搬给新模型可能直接非法，所以丢掉
    const { reasoningEffort: _dropped, ...rest } = resolved
    return {
      ...rest,
      provider: target.provider,
      model: target.model,
      ...(target.reasoningEffort === undefined ? {} : { reasoningEffort: target.reasoningEffort }),
    }
  }, { prepend: true })

  ctx.on('agent/request-error', async (
    { agent, turn, step, provider, failure, signal },
    next,
  ) => {
    // 先交回链上：别人的重试决定优先，我们只在链上放弃后才介入。
    // 不调用 next() 会否决链上后面的一切 —— 那是这次「重试静默消失」的根因之一。
    const downstream = await settleDownstream(next)
    if (downstream.type === 'decision' && downstream.decision?.kind === 'retry') {
      return downstream.decision
    }
    if (downstream.type === 'error') {
      deps.logger?.warn(`kenari: agent/request-error 下游策略抛错，改由本地恢复接手：${String(downstream.error)}`)
    }
    if (!isRecoveryProvider(provider, deps.providers)) return undefined
    if (signal.aborted) return undefined

    const session = agent.session
    const current = session.requestContext()
    const currentModel = current?.model
    if (currentModel === undefined) return undefined

    const route = `${provider}/${currentModel}`
    const stepKey = `${turn}:${step}`
    const previous = states.get(session)
    const state: SessionState = previous?.stepKey === stepKey
      ? previous
      : { stepKey, stage: 0, tried: new Set<string>(), ownRetries: 0, retryNoticeSent: false }
    states.set(session, state)
    state.tried.add(route)
    // 路由变了（换过模型或回退过 provider）就重置重试预算：新模型应当拿到完整的一轮
    if (state.ownRoute !== route) {
      state.ownRoute = route
      state.ownRetries = 0
      state.retryNoticeSent = false
    }

    // 阶段 0：同一路由重试。瞬时类失败重发有意义，重试预算按路由走。
    // 链上（llm-retry）这轮已经排程过重试时让位给它 —— 两条机制各数一遍会叠成两倍等待。
    const chained = scheduled.get(session)
    const chainedRetries = chained !== undefined && chained.stepKey === stepKey ? chained.count : 0
    if (chainedRetries === 0
      && deps.retryCodes.includes(failure.code)
      && state.ownRetries < deps.retryMaxRetries) {
      state.ownRetries += 1
      deps.logger?.info(`kenari: ${route} 失败（${failure.code}），本地重试 ${state.ownRetries}/${deps.retryMaxRetries}`)
      if (deps.retryNoticeEnabled && !state.retryNoticeSent) {
        // 重试期间界面上只有一次失败的尝试，不解释的话就是一个没有理由的等待
        state.retryNoticeSent = true
        agent.inject(createUserMessage({
          content: [{
            type: 'text' as const,
            text: `[kenari: ${route} 失败（${failure.code}），本地重试最多 ${deps.retryMaxRetries} 次（每次 ${deps.retryDelayMs}ms）]`,
          }],
          source: { kind: 'plugin', plugin: 'kenari', form: 'notice', summary: `${route} 重试 ${state.ownRetries}/${deps.retryMaxRetries}` },
        }))
      }
      const retried = await sleepUnlessAborted(deps.retryDelayMs, signal)
      if (!retried) {
        states.delete(session)
        return undefined
      }
      return { kind: 'retry' }
    }

    const planned = planStage(state.stage, failure.code, deps)
    if (planned === undefined) {
      states.delete(session)
      return undefined
    }

    let target: Target | undefined
    let entered: Stage = 2
    if (planned === 1) {
      const candidate = await deps.candidates.pick({
        provider,
        model: currentModel,
        ...(current?.contextWindow === undefined ? {} : { contextWindow: current.contextWindow }),
        // 本 step 里失败过的路由一律不再回头：同窗口的两个模型（`>=` 判定）否则会来回横跳
        exclude: [...state.tried],
        signal,
      })
      if (candidate !== undefined) {
        target = { provider: candidate.provider, model: candidate.model }
        entered = 1
      }
    }
    if (target === undefined) {
      const fallback = deps.defaultSelection()
      // 已经处于默认路由时「回退」是空操作；重试同一个组合没有意义
      if (fallback === undefined || (fallback.provider === provider && fallback.model === currentModel)) {
        states.delete(session)
        return undefined
      }
      target = { ...fallback }
    }

    state.stage = entered
    state.target = target
    const from = route
    const to = `${target.provider}/${target.model}`
    deps.logger?.warn(`kenari: ${from} 失败（${failure.code}），${entered === 1 ? '换模型' : '回退默认 provider'}为 ${to}`)

    if (deps.noticeEnabled) {
      // 换模型对用户是可见的行为变化（风格与能力都会变），静默切换会让人困惑。
      // 形态照抄 dsh 自己的 modelSwitchNotice，走 inject 排到下一个 step 的 pre-step。
      agent.inject(createUserMessage({
        content: [{ type: 'text' as const, text: `[kenari: ${from} 连续失败（${failure.code}），已切换到 ${to}]` }],
        source: { kind: 'plugin', plugin: 'kenari', form: 'notice', summary: `${from} → ${to}` },
      }))
    }

    const switched = await sleepUnlessAborted(deps.switchDelayMs, signal)
    if (!switched) {
      states.delete(session)
      return undefined
    }
    return { kind: 'retry' }
  })

  // 用户显式选模型（会话日志追加 model/selection）时让人的选择优先。
  // 只有 /model 命令会追加该事件，所以不会误清我们的 override。
  ctx.on('session/event', (session, event) => {
    const shape = event as { type: string; data?: { turn?: number; step?: number } }
    // `model/selection` 的事件类型由 `@deepseek-ai/dsh-session-controller` 声明合并而来。
    // 为了一个字符串比对上整个 session-controller 依赖不划算，所以按形状读。
    if (shape.type === 'model/selection') {
      states.delete(session)
      scheduled.delete(session)
      return
    }
    // 数链上排程的重试。事件自带 turn/step，所以能按 step 归集，不必读会话上下文。
    if (shape.type !== 'llm/retry') return
    const { turn, step } = shape.data ?? {}
    if (turn === undefined || step === undefined) return
    const stepKey = `${turn}:${step}`
    const previous = scheduled.get(session)
    scheduled.set(session, previous?.stepKey === stepKey
      ? { stepKey, count: previous.count + 1 }
      : { stepKey, count: 1 })
  })
}
