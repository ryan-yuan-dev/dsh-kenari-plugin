/**
 * 模型失败恢复的共享件：路由判定、重试策略装配、可取消延时。
 *
 * 为什么策略在这里拼：`LlmAdapter.providerRetryPolicy()` 只在适配器注册那一刻被调用一次，
 * 返回值随即被 dsh 冻结进注册记录（`packages/llm/llm/src/index.ts:436-442`）。所以这里产出的
 * 是「注册时的配置快照」—— 改 `modelRetryMaxRetries` 要重启 dsh 才生效，与 plugin-rules #10
 * 对结构性字段的说明一致。
 * @module dsh-kenari-plugin/llm/retry
 */

import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { ResolvedRetryPolicy, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'

/** 判定一个 provider 路由是否参与模型失败恢复。路由 id 是精确匹配，不做大小写归一。 */
export function isRecoveryProvider(provider: string, configured: readonly string[]): boolean {
  return configured.includes(provider)
}

/** 重试策略的可调输入，取自插件 Config。 */
export interface KenariRetryInput {
  /** 首次请求之后的额外重试次数。 */
  maxRetries?: number
  /** 每次重试前的固定等待毫秒数。 */
  delayMs?: number
  /** 允许重试的失败码；省略则用 dsh 默认集，但显式传空数组会被拒绝。 */
  retryableCodes?: readonly string[]
}

/**
 * 拼出 Kenari 路由的重试策略：固定间隔、无抖动。
 *
 * dsh 的退避是 `initialDelayMs * 2^n` 用 `maxDelayMs` 封顶，所以把两者设成同一个值、
 * 关掉抖动，就得到「每次都等同样久」。「5s 后重试」只有这样才表达得准确。
 */
export function kenariRetryPolicy(input: KenariRetryInput): ResolvedRetryPolicy {
  const delayMs = input.delayMs ?? 5_000
  const config: RetryPolicyConfig = {
    mode: 'normal',
    maxRetries: input.maxRetries ?? 5,
    ...(input.retryableCodes === undefined ? {} : { retryableCodes: [...input.retryableCodes] }),
    backoff: { initialDelayMs: delayMs, maxDelayMs: delayMs, jitterRatio: 0 },
  }
  // resolveRetryPolicy 顺带做校验：maxRetries 非负、retryableCodes 非空
  return resolveRetryPolicy(config, 'kenari.modelRecovery.retryPolicy')
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
