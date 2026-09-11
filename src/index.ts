/**
 * dsh-kenari-plugin: Kenari (kenari.id) as a first-class citizen of dsh.
 *
 * Registers the Kenari-first web search/fetch provider pair into `ctx.web`,
 * pinned by the bundle's patch layer (`searchProvider`/`fetchProvider` both
 * `kenari-fallback`). Later phases add REST capability tools and settings.
 * @module dsh-kenari-plugin
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { DeepSeekSearchProvider } from '@deepseek-ai/dsh-web-search-deepseek'
import { HttpFetchProvider, DEFAULT_USER_AGENT } from '@deepseek-ai/dsh-web-fetch-http'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { KenariSearchProvider } from './web/search.js'
import { KenariFetchProvider } from './web/fetch.js'
import { KenariFirstSearch, KenariFirstFetch } from './web/fallback.js'
import type { KenariHttpDeps, ResolveApiKey } from './http.js'
import type { ToolsDeps } from './tools/shared.js'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { KenariCatalog } from './catalog.js'
import { KenariPlans } from './plans.js'
import { registerCatalogView } from './catalog-view.js'
import { applyPlanDefaultRoute } from './default-route.js'
import { BalanceMonitor, BillingLedger } from './billing.js'
import { installKenariSettings, KENARI_SETTINGS_NAMESPACE } from './settings.js'
import { KenariLlmAdapter } from './llm/adapter.js'
import { ModelCandidates } from './llm/candidates.js'
import { installModelRecovery } from './llm/recovery.js'
import type { Target } from './llm/recovery.js'
import { kenariRetryPolicy } from './llm/retry.js'
import { registerDocsTools } from './tools/docs.js'
import { registerAccountTools } from './tools/account.js'
import { registerXSearchTool } from './tools/x-search.js'
import { registerOcrTool } from './tools/documents.js'
import { registerMediaTools } from './tools/media.js'
import { registerDataTools } from './tools/data.js'
import { registerCountTokensTool } from './tools/count-tokens.js'
import { registerBillingTool } from './tools/billing.js'

/** Plugin config. Every field a deployment may want to tune is a config field. */
export interface Config {
  /** Credential reference holding the Kenari API key (`kn-...`). */
  apiKeyEnv?: string
  /** Kenari API base URL. */
  baseURL?: string
  /** Per-request timeout for Kenari REST calls in milliseconds. */
  timeoutMs?: number
  /** Per-attempt timeout for generation calls (image/audio/music/OCR) in milliseconds. */
  generationTimeoutMs?: number
  /** Retry count for transient Kenari REST failures. */
  maxRetries?: number
  /** Register the Kenari search provider. */
  searchEnabled?: boolean
  /** Register the Kenari fetch provider. */
  fetchEnabled?: boolean
  /** Fall back to the dsh defaults when a Kenari call fails. */
  fallbackEnabled?: boolean
  /** TTL for the in-memory cache of Kenari's /llms-full.txt documentation. */
  docsCacheTtlMs?: number
  /** TTL for the in-memory cache of Kenari's /v1/models catalog. */
  catalogCacheTtlMs?: number
  /** Register the Kenari REST capability tools. */
  toolsEnabled?: boolean
  /** Extra model aliases: `{ alias: 'exact-model-id' }`, usable wherever a model id is accepted. */
  modelAliases?: Record<string, string>
  /** Warn after a billed call when the wallet drops below this many Rupiah; 0 disables the check. */
  lowBalanceAlertRp?: number
  /** TTL for the cached wallet balance used by the low-balance alert. */
  balanceCacheTtlMs?: number
  /** Per-session spend ceiling in Rupiah; 0 leaves spending uncapped. */
  budgetCapRp?: number
  /** Register the plugin's own Kenari LlmAdapter (phase 5); off keeps the llm-pi-ai preset route. */
  nativeAdapterEnabled?: boolean
  /** Provider route id for the plugin's own LlmAdapter. */
  nativeProviderId?: string
  /** 模型调用失败时自动恢复（重试 → 换模型 → 回退默认 provider）。 */
  modelRecoveryEnabled?: boolean
  /** 参与恢复的 provider 路由；范围外的路由行为完全不变。 */
  modelRecoveryProviders?: string[]
  /** 首次请求之后的额外重试次数（kenari-direct 路由；llm-pi-ai 路由见 cordis.patch.yml）。 */
  modelRetryMaxRetries?: number
  /** 每次重试前的固定等待毫秒数（同上传导范围）。 */
  modelRetryDelayMs?: number
  /** 允许重试的失败码；不能为空。 */
  modelRetryableCodes?: string[]
  /** 是否允许换模型（关掉则只重试）。 */
  modelSwitchEnabled?: boolean
  /** 换模型/回退默认 provider 前的等待毫秒数。 */
  modelSwitchDelayMs?: number
  /** 跳过「同 provider 换模型」直接回退 provider 的失败码。 */
  modelSwitchSkipCodes?: string[]
  /** 换模型时是否往会话注入一条切换通知。 */
  modelSwitchNoticeEnabled?: boolean
}

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default('KENARI_API_KEY'),
  baseURL: z.string().default('https://kenari.id'),
  timeoutMs: z.number().step(1).min(1).default(30_000),
  generationTimeoutMs: z.number().step(1).min(1).default(180_000),
  maxRetries: z.number().step(1).min(0).default(2),
  searchEnabled: z.boolean().default(true),
  fetchEnabled: z.boolean().default(true),
  fallbackEnabled: z.boolean().default(true),
  docsCacheTtlMs: z.number().step(1).min(0).default(3_600_000),
  catalogCacheTtlMs: z.number().step(1).min(0).default(3_600_000),
  toolsEnabled: z.boolean().default(true),
  modelAliases: z.dict(z.string()).default({}),
  lowBalanceAlertRp: z.number().step(1).min(0).default(5_000),
  balanceCacheTtlMs: z.number().step(1).min(0).default(300_000),
  budgetCapRp: z.number().step(1).min(0).default(0),
  nativeAdapterEnabled: z.boolean().default(false),
  nativeProviderId: z.string().default('kenari-direct'),
  modelRecoveryEnabled: z.boolean().default(true),
  modelRecoveryProviders: z.array(z.string()).default(['kenari', 'kenari-direct']),
  modelRetryMaxRetries: z.number().step(1).min(0).default(5),
  modelRetryDelayMs: z.number().step(1).min(0).default(5_000),
  modelRetryableCodes: z.array(z.string()).default([
    'EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT',
  ]),
  modelSwitchEnabled: z.boolean().default(true),
  modelSwitchDelayMs: z.number().step(1).min(0).default(5_000),
  modelSwitchSkipCodes: z.array(z.string()).default([
    'AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'QUOTA',
  ]),
  modelSwitchNoticeEnabled: z.boolean().default(true),
})

/** Cordis plugin name used by loader diagnostics. */
export const name = 'kenari'

/** 需要 web seam 与工具注册表；settings 是可选 seam（缺失时退化为 composition 配置）。 */
export const inject = ['web', 'tools']

/**
 * key 读取照抄官方 provider 模式（dsh-source-verified.md §11）：
 * 优先 credentials seam，缺 seam 回退 launchEnvironment；每次现场解析（热轮换）。
 * 引用名取自实时配置视图，所以设置页改 `apiKeyEnv` 后下一次操作就换引用。
 */
function resolveApiKeyOf(ctx: Context, refOf: () => CredentialRef): ResolveApiKey {
  return async () => {
    const ref = refOf()
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) return (await credentials.resolve(ref))?.value
    // 无 seam 时回退到启动环境快照
    const ambient = launchEnvironmentOf(ctx).get(ref)
    return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
  }
}

/**
 * 读 dsh 默认模型选择的访问器。
 *
 * `agentDefaultModel` 的宿主声明在 `@deepseek-ai/dsh-agent-default-model` 里。为了一个类型
 * 新增构建期依赖（还要动 pnpm 的发布年龄豁免清单）不划算，所以按公开形状结构化读取：
 * 服务缺失或形状不符时返回 undefined，回退阶段自动退化为「放弃」。
 * 参考 packages/core/agent-default-model/src/index.ts:64-107。
 */
interface DefaultModelLike {
  currentSelection(): { provider: string; model: string; reasoningEffort?: ReasoningEffortId }
}

function defaultSelectionOf(ctx: Context): () => Target | undefined {
  const service = ctx.get('agentDefaultModel') as DefaultModelLike | undefined
  if (service === undefined || typeof service.currentSelection !== 'function') return () => undefined
  return () => {
    const selection = service.currentSelection()
    if (typeof selection?.provider !== 'string' || typeof selection?.model !== 'string') return undefined
    return {
      provider: selection.provider,
      model: selection.model,
      ...(typeof selection.reasoningEffort === 'string' ? { reasoningEffort: selection.reasoningEffort } : {}),
    }
  }
}

/**
 * Register the Kenari capability into the harness.
 * 第 1 期 web fallback；第 2 期 REST 工具；第 3 期目录 / 计费账本 / 窗口监控；
 * 第 4 期设置节（Host 半边）。
 */
export function apply(ctx: Context, config: Config): void {
  // 设置节：用户层提交后 current() 立即返回新值，插件各处读实时视图
  const live = installKenariSettings(ctx, Config, config)
  const liveConfig = live.view
  const refOf = (): CredentialRef => credentialRef(liveConfig.apiKeyEnv ?? 'KENARI_API_KEY')
  const logger = ctx.logger
  const deps: KenariHttpDeps = {
    config: liveConfig,
    resolveApiKey: resolveApiKeyOf(ctx, refOf),
    logger,
  }

  // 目录与账本是跨工具共享的进程级单例：目录带 TTL 缓存，账本按会话作用域累计。
  // 先于 provider 建立，web 搜索/抓取的按次扣费也记进同一本账（global 作用域）。
  const catalog = new KenariCatalog(deps)
  const plans = new KenariPlans(deps)
  const budgetCapRp = config.budgetCapRp ?? 0
  const billing = new BillingLedger(budgetCapRp > 0 ? budgetCapRp * 1_000_000 : undefined)
  const balance = new BalanceMonitor(deps)
  const recordWebSpend = (microIdr: number, kind: 'search' | 'fetch'): void => {
    // web 工具没有会话归属，落 global 作用域；金额来自响应回显，非预估
    billing.recordSpend('global', { tool: `web_${kind}`, microIdr, estimated: false })
  }

  if (config.searchEnabled ?? true) {
    const kenariSearch = new KenariSearchProvider(deps, recordWebSpend)
    if (config.fallbackEnabled ?? true) {
      // 兜底实例：传 resolveApiKey thunk（每次现场解析），否则 available() 判不可用。
      // 绝不能注册进 seam（id `deepseek-official` 冲突 → WEB_DUPLICATE_PROVIDER）。
      const officialSearch = new DeepSeekSearchProvider(() => ({
        resolveApiKey: async () => {
          const credentials = ctx.get('credentials')
          if (credentials !== undefined) return (await credentials.resolve(credentialRef('DEEPSEEK_API_KEY')))?.value
          const ambient = launchEnvironmentOf(ctx).get('DEEPSEEK_API_KEY')
          return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
        },
        baseURL: 'https://api.deepseek.com/anthropic/v1',
        model: 'deepseek-v4-flash',
        apiVersion: '2023-06-01',
        maxTokens: 4096,
        maxUses: 5,
      }))
      ctx.web.registerSearchProvider(new KenariFirstSearch(kenariSearch, officialSearch, logger))
    } else {
      ctx.web.registerSearchProvider(kenariSearch)
    }
  }

  if (config.fetchEnabled ?? true) {
    const kenariFetch = new KenariFetchProvider(deps, recordWebSpend)
    if (config.fallbackEnabled ?? true) {
      // 第二参 resolveAddresses 有默认值，只传 limits（5 字段，0.1.5-rc.1）。
      // 同样绝不注册（id `http` 冲突）。
      const localFetch = new HttpFetchProvider({
        maxResponseBytes: 5_000_000,
        maxBodyChars: 100_000,
        timeoutMs: 30_000,
        maxRedirects: 5,
        userAgent: DEFAULT_USER_AGENT,
      })
      ctx.web.registerFetchProvider(new KenariFirstFetch(kenariFetch, localFetch, logger))
    } else {
      ctx.web.registerFetchProvider(kenariFetch)
    }
  }

  // REST 工具族：defineTool + ctx.tools.register（disposer 挂 fiber，卸载自动回收）
  if (config.toolsEnabled ?? true) {
    const toolsDeps: ToolsDeps = {
      http: deps,
      ctx,
      config: liveConfig,
      catalog,
      billing,
      balance,
    }
    const register = (tool: ToolDefinition): void => {
      ctx.tools.register(tool)
    }
    registerDocsTools(toolsDeps, register)
    registerAccountTools(toolsDeps, register)
    registerXSearchTool(toolsDeps, register)
    registerOcrTool(toolsDeps, register)
    registerMediaTools(toolsDeps, register)
    registerDataTools(toolsDeps, register)
    registerCountTokensTool(toolsDeps, register)
    registerBillingTool(toolsDeps, register)
    logger?.info('kenari: web providers, REST tools, catalog and billing ledger registered')
  } else {
    logger?.info('kenari: web providers registered (tools disabled by config)')
  }

  // 浏览器侧「可选模型」面板的数据端点（能力标签 + 套餐归属）。
  // 只在挂载了 connection 的 web profile 生效；数据与目录/套餐缓存同源，
  // 所以设置页看到的标签与 kenari_list_models 说的是同一件事。
  registerCatalogView(ctx, { http: deps, catalog, plans })

  // 默认路由：按当前 key 的套餐把「免缓存额度」模型填进 `kenari` 路由。
  // 预设是静态 YAML，算不出套餐相关的东西，所以要在设置节挂上之后补一次
  // （用户层已经自己写过 models 时一律不动，详见 src/default-route.ts）。
  ctx.inject(['settings'], (settingsCtx) => {
    void applyPlanDefaultRoute(settingsCtx, { http: deps, catalog, plans })
  })

  // 第 5 期（可选）：自带 LlmAdapter。默认关闭，且路由名与 llm-pi-ai 预设不同，
  // 所以两条路可以并存、可以回退；开启后模型的 usage 与费用也进同一本账。
  if (config.nativeAdapterEnabled === true) {
    const providerId = config.nativeProviderId ?? 'kenari-direct'
    const adapter = new KenariLlmAdapter(
      {
        http: deps,
        catalog,
        billing,
        logger,
        retryPolicy: kenariRetryPolicy({
          maxRetries: liveConfig.modelRetryMaxRetries ?? 5,
          delayMs: liveConfig.modelRetryDelayMs ?? 5_000,
          retryableCodes: liveConfig.modelRetryableCodes,
        }),
      },
      (imageRef) => {
        const attachments = ctx.get('attachments')
        if (attachments === undefined) return Promise.reject(new Error('本部署没有 attachment 存储，无法回传图像'))
        return attachments.readImage(imageRef)
      },
    )
    // llm 是可选 seam：没挂载时不注册，插件其余能力照常工作
    ctx.inject(['llm'], (llmCtx) => {
      llmCtx.llm.registerAdapter([providerId], adapter)
      // 设置卡片与 Models 页的「拉取模型」走这里（本插件命名空间下的发现）
      llmCtx.llm.registerModelDiscovery(KENARI_SETTINGS_NAMESPACE, async () =>
        (await catalog.chatModels()).map((model) => ({
          id: model.id,
          ...(model.name === undefined ? {} : { name: model.name }),
          ...(typeof model.context_length === 'number' ? { contextWindow: model.context_length } : {}),
        })),
      )
      logger?.info(`kenari: native LlmAdapter registered for route "${providerId}"`)
    })
  }

  // 模型失败恢复：重试用尽后换模型、再回退默认 provider。
  // llm 是可选 seam，缺它整块不装 —— 与自带适配器同一模式，插件其余能力不受影响。
  ctx.inject(['llm'], (llmCtx) => {
    const llm = llmCtx.llm
    const candidates = new ModelCandidates({
      // 显式转发而不是直接传 llmCtx.llm：LlmRuntime 的方法依赖 this，
      // 脱开接收者调用会在内部 this.registration(...) 处炸掉
      llm: {
        listProviders: () => llm.listProviders(),
        listModels: (provider) => llm.listModels(provider),
        resolveModelInfo: (provider, model, signal) => llm.resolveModelInfo(provider, model, signal),
      },
      cacheTtlMs: liveConfig.catalogCacheTtlMs ?? 3_600_000,
    })
    installModelRecovery(llmCtx, {
      enabled: liveConfig.modelRecoveryEnabled ?? true,
      providers: liveConfig.modelRecoveryProviders ?? ['kenari', 'kenari-direct'],
      switchEnabled: liveConfig.modelSwitchEnabled ?? true,
      switchDelayMs: liveConfig.modelSwitchDelayMs ?? 5_000,
      skipCodes: liveConfig.modelSwitchSkipCodes ?? [],
      noticeEnabled: liveConfig.modelSwitchNoticeEnabled ?? true,
      candidates,
      defaultSelection: defaultSelectionOf(ctx),
      ...(logger === undefined ? {} : { logger }),
    })
    logger?.info('kenari: model failure recovery installed (retry → model switch → default provider)')
  })
}
