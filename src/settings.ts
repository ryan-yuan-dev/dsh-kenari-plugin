/**
 * 设置节的 Host 半边：把插件 Config 注册成 dsh 设置命名空间（Settings 页可见、可写）。
 *
 * `installSection` 让本节的合成层（cordis patch 里的 config）成为 base，用户层
 * 写 `$DSH_HOME/settings.yaml`；两者都经 schema 校验与 `validate` 把关。
 * 改动落盘后 `setSource` 给出的 thunk 立即返回新值 —— 所以插件用 {@link LiveConfig}
 * 的实时视图读取配置，下一次操作就生效，不需要重启。
 *
 * 结构性字段（是否需要注册 provider / 工具、预算封顶的账本实例）在插件加载时定型，
 * 改动它们要重启 dsh；这一点在 README 与设置卡片里写明。
 * @module dsh-kenari-plugin/settings
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: 拉入 ctx.settings 的 Context 声明合并（installSection 的宿主）
import type {} from '@deepseek-ai/dsh-settings'
import type z from '@deepseek-ai/schemastery'
import type { Config } from './index.js'

/** 设置命名空间：必须匹配 `/^[a-z][a-z0-9-]*$/`。 */
export const KENARI_SETTINGS_NAMESPACE = 'kenari'

/** 实时配置视图：`view` 每次属性读取都取当次权威值。 */
export interface LiveConfig {
  /** 可当普通 Config 读的实时视图（值在每次读取时解析）。 */
  readonly view: Config
  /** 取当次权威配置（诊断与需要完整对象时用）。 */
  current(): Config
}

/**
 * schema 表达不了的约束在**写入时**拒绝（不是等到下次请求才炸）。
 * 全部为本地判断：设置页写值时不该触发网络请求。
 */
export function validateKenariConfig(value: Config): void {
  const baseURL = value.baseURL ?? ''
  if (!URL.canParse(baseURL)) {
    throw new Error(`baseURL 必须是绝对 URL（例如 https://kenari.id），收到 "${baseURL}"`)
  }
  const providerId = value.nativeProviderId ?? ''
  if (!/^[a-z][a-z0-9-]*$/.test(providerId)) {
    throw new Error(`nativeProviderId 必须以小写字母开头且只含小写字母、数字、连字符，收到 "${providerId}"`)
  }
  for (const [alias, target] of Object.entries(value.modelAliases ?? {})) {
    if (alias.trim().length === 0 || target.trim().length === 0) {
      throw new Error('modelAliases 的别名与目标模型 id 都不能为空')
    }
  }
  if ((value.balanceCacheTtlMs ?? 0) > (value.catalogCacheTtlMs ?? 0) * 10) {
    throw new Error('balanceCacheTtlMs 不应比 catalogCacheTtlMs 大一个数量级：余额会长期陈旧')
  }
  // dsh 的 resolveRetryPolicy 会拒绝空的可重试码列表；在这里先拦，
  // 免得用户写完设置页要等到下次加载插件才炸
  if ((value.modelRetryableCodes ?? []).length === 0) {
    throw new Error('modelRetryableCodes 不能为空：空列表会让重试策略无效')
  }
}

/**
 * 注册 Kenari 设置节并返回实时配置视图。
 * 无 settings provider 挂载时只是退化为「配置即 composition 层」，插件照常工作。
 */
export function installKenariSettings(ctx: Context, schema: z<Config>, config: Config): LiveConfig {
  let current: () => Config = () => config
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, KENARI_SETTINGS_NAMESPACE, schema, config, {
      setSource: (source) => {
        current = source
      },
      // 注册期不缓存解析结果：消费方每次操作读 current()，故提交即生效
      onChange: () => {},
      validate: validateKenariConfig,
    })
  })

  const view = new Proxy({} as Config, {
    get: (_target, key) => current()[key as keyof Config],
    has: (_target, key) => key in (current() as object),
    ownKeys: () => Reflect.ownKeys(current() as object),
    getOwnPropertyDescriptor: (_target, key) => ({
      value: current()[key as keyof Config],
      enumerable: true,
      configurable: true,
      writable: false,
    }),
  })
  return { view, current: () => current() }
}
