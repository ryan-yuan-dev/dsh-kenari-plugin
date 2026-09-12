/**
 * 模型失败恢复的共享件：路由判定、dsh 重试的关闭策略、可取消延时。
 *
 * 为什么策略在这里拼：`LlmAdapter.providerRetryPolicy()` 只在适配器注册那一刻被调用一次，
 * 返回值随即被 dsh 冻结进注册记录（`packages/llm/llm/src/index.ts:436-442`）。所以这里产出的
 * 是「注册时的配置快照」—— 与 plugin-rules #10 对结构性字段的说明一致。
 * @module dsh-kenari-plugin/llm/retry
 */

import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'

/** 判定一个 provider 路由是否参与模型失败恢复。路由 id 是精确匹配，不做大小写归一。 */
export function isRecoveryProvider(provider: string, configured: readonly string[]): boolean {
  return configured.includes(provider)
}

/**
 * 让 dsh 自带的重试在 Kenari 路由上停手：重试由插件自己的状态机负责（见 `./recovery.ts`）。
 *
 * 为什么不把重试交给 `dsh-llm-retry`：它会**静默消失**。`agent/request-error` 是没有
 * 「默认行为」的瀑布 —— 排在后面的监听器只在前面调用 `next()` 时才被调用。只要注册顺序
 * 被翻过来一次（live patch / HMR 重载后重注册），排在外层的策略就把 llm-retry 永久饿死，
 * 而插件没有任何办法观察到这件事。实测线上会话里 `llm/retry` 事件数为 0，换模型发生在
 * 第一次失败上 —— 承诺的 5 次重试从未执行过。重试是插件对用户承诺的行为，不能建立在一个
 * 自己看不见的机制上，所以这里把它关掉，由 `recovery.ts` 自己数次数、自己等。
 *
 * 关闭方式只有一种：`maxRetries: 0` 让 `previousRetry >= maxRetries` 立刻成立，llm-retry
 * 直接 `next()`。`retryableCodes` 必须非空（dsh 的校验），给一个占位码即可 —— 0 次重试时
 * 它永远不会被读到。
 */
export function dshRetryDisabledPolicy(): ResolvedRetryPolicy {
  return resolveRetryPolicy({
    mode: 'normal',
    maxRetries: 0,
    retryableCodes: ['TRANSPORT'],
    // 退避参数用最小值：0 次重试时它不会被执行，但 dsh 要求 initialDelayMs 为正
    backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
  }, 'kenari.modelRecovery.dshRetryDisabled')
}

/**
 * 可取消的等待。返回 false 表示等待期间被取消，调用方应当放弃本次恢复而不是继续重试。
 *
 * 用 AbortSignal 而不是裸 setTimeout：用户在等待期间点了停止，不该再打一次模型请求。
 */
export function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (waited: boolean): void => {
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(waited)
    }
    const onAbort = (): void => settle(false)
    timer = setTimeout(() => settle(true), ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
