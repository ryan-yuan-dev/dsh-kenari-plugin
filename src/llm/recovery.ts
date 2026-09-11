/**
 * Kenari 路由的模型失败恢复：重试用尽后换模型，再不行回退默认 provider。
 *
 * 分工：5s × 5 的重试交给 dsh 自带的 `dsh-llm-retry`（声明式策略，见 `./retry.ts`），
 * 本模块只负责它放弃之后的升级 —— 因为在同一个 step 内改 provider/model 是 dsh 没提供的缝。
 *
 * 两个监听器的注册顺序是设计的一部分，不是随手写的：
 * 1. `agent/request` 用 `prepend` 挂在**最外层**。瀑布里外层拿最终决定权，而
 *    `installModelSelection` 会用「本 step 组装时捕获的」原模型回写 —— 排在内层会被它改回去
 *    （`packages/core/agent/src/model-selection.ts:88-105`）。
 * 2. `agent/request-error` 用默认顺序，也就是内层：`dsh-llm-retry` 决定重试时不会 `next()`，
 *    所以我们只在它放弃（码不可重试或次数用尽）之后才被调用。
 * @module dsh-kenari-plugin/llm/recovery
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
// Type-only：拉入 agent/* 与 session/event 的事件声明合并
import type {} from '@deepseek-ai/dsh-agent'
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
}

/** 恢复机制的可调输入与依赖。 */
export interface ModelRecoveryDeps {
  /** 总开关。false 时一个监听器都不装。 */
  enabled: boolean
  /** 参与恢复的 provider 路由；范围外的失败原样交给下一个监听者。 */
  providers: readonly string[]
  /** 是否允许换模型；false 时只依赖 dsh 的重试，用尽后该轮以 error 结束。 */
  switchEnabled: boolean
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

/** 决定本次失败后进入哪个阶段；undefined 表示放弃。 */
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

  ctx.on('agent/request-error', async ({ agent, turn, step, provider, failure, signal }) => {
    if (!isRecoveryProvider(provider, deps.providers)) return undefined
    if (signal.aborted) return undefined

    const session = agent.session
    const current = session.requestContext()
    const currentModel = current?.model
    if (currentModel === undefined) return undefined

    const stepKey = `${turn}:${step}`
    const previous = states.get(session)
    const state: SessionState = previous?.stepKey === stepKey ? previous : { stepKey, stage: 0 }
    states.set(session, state)

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
    const from = `${provider}/${currentModel}`
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

    const waited = await sleepUnlessAborted(deps.switchDelayMs, signal)
    if (!waited) {
      states.delete(session)
      return undefined
    }
    return { kind: 'retry' }
  })

  // 用户显式选模型（会话日志追加 model/selection）时让人的选择优先。
  // 只有 /model 命令会追加该事件，所以不会误清我们的 override。
  ctx.on('session/event', (session, event) => {
    // `model/selection` 的事件类型由 `@deepseek-ai/dsh-session-controller` 声明合并而来。
    // 为了一个字符串比对上整个 session-controller 依赖不划算，所以按形状读。
    if ((event as { type: string }).type === 'model/selection') states.delete(session)
  })
}
