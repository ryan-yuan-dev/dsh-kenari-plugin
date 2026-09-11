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
import { KenariSearchProvider } from './web/search.js'
import { KenariFetchProvider } from './web/fetch.js'
import { KenariFirstSearch, KenariFirstFetch } from './web/fallback.js'
import type { KenariHttpDeps, ResolveApiKey } from './http.js'
import type { ToolsDeps } from './tools/shared.js'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { KenariCatalog } from './catalog.js'
import { KenariPlans } from './plans.js'
import { registerCatalogView } from './catalog-view.js'
import { BalanceMonitor, BillingLedger } from './billing.js'
import { installKenariSettings, KENARI_SETTINGS_NAMESPACE } from './settings.js'
import { KenariLlmAdapter } from './llm/adapter.js'
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

  // 第 5 期（可选）：自带 LlmAdapter。默认关闭，且路由名与 llm-pi-ai 预设不同，
  // 所以两条路可以并存、可以回退；开启后模型的 usage 与费用也进同一本账。
  if (config.nativeAdapterEnabled === true) {
    const providerId = config.nativeProviderId ?? 'kenari-direct'
    const adapter = new KenariLlmAdapter(
      { http: deps, catalog, billing, logger },
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
}
