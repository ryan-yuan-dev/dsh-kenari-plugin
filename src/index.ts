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
import { registerDocsTools } from './tools/docs.js'
import { registerAccountTools } from './tools/account.js'
import { registerXSearchTool } from './tools/x-search.js'
import { registerOcrTool } from './tools/documents.js'
import { registerMediaTools } from './tools/media.js'
import { registerDataTools } from './tools/data.js'
import { registerCountTokensTool } from './tools/count-tokens.js'

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
  /** Register the Kenari REST capability tools. */
  toolsEnabled?: boolean
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
  toolsEnabled: z.boolean().default(true),
})

/** Cordis plugin name used by loader diagnostics. */
export const name = 'kenari'

/** The web seam and tool registry this plugin uses; settings arrive in phase 4. */
export const inject = ['web', 'tools']

/**
 * key 读取照抄官方 provider 模式（dsh-source-verified.md §11）：
 * 优先 credentials seam，缺 seam 回退 launchEnvironment；每次现场解析（热轮换）。
 */
function resolveApiKeyOf(ctx: Context, ref: CredentialRef): ResolveApiKey {
  return async () => {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) return (await credentials.resolve(ref))?.value
    // 无 seam 时回退到启动环境快照
    const ambient = launchEnvironmentOf(ctx).get(ref)
    return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
  }
}

/** Register the Kenari capability into the harness. Phase 1: web fallback; phase 2: REST tools. */
export function apply(ctx: Context, config: Config): void {
  const ref = credentialRef(config.apiKeyEnv ?? 'KENARI_API_KEY')
  const logger = ctx.logger
  const deps: KenariHttpDeps = {
    config,
    resolveApiKey: resolveApiKeyOf(ctx, ref),
    logger,
  }

  if (config.searchEnabled ?? true) {
    const kenariSearch = new KenariSearchProvider(deps)
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
    const kenariFetch = new KenariFetchProvider(deps)
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
    const toolsDeps: ToolsDeps = { http: deps, ctx, docsCacheTtlMs: config.docsCacheTtlMs ?? 3_600_000 }
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
    logger?.info('kenari: web providers and REST tools registered')
  } else {
    logger?.info('kenari: web providers registered (tools disabled by config)')
  }
}
