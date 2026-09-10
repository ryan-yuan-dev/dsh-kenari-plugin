/**
 * dsh-kenari-plugin: Kenari (kenari.id) as a first-class citizen of dsh.
 *
 * Registers the Kenari-first web search/fetch provider pair into `ctx.web`,
 * pinned by the bundle's patch layer (`searchProvider`/`fetchProvider` both
 * `kenari-fallback`). Later phases add REST capability tools and settings.
 * @module dsh-kenari-plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Plugin config. Every field a deployment may want to tune is a config field. */
export interface Config {
  /** Credential reference holding the Kenari API key (`kn-...`). */
  apiKeyEnv?: string
  /** Kenari API base URL. */
  baseURL?: string
  /** Per-request timeout for Kenari REST calls in milliseconds. */
  timeoutMs?: number
  /** Retry count for transient Kenari REST failures. */
  maxRetries?: number
  /** Register the Kenari search provider. */
  searchEnabled?: boolean
  /** Register the Kenari fetch provider. */
  fetchEnabled?: boolean
  /** Fall back to the dsh defaults when a Kenari call fails. */
  fallbackEnabled?: boolean
}

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default('KENARI_API_KEY'),
  baseURL: z.string().default('https://kenari.id'),
  timeoutMs: z.number().step(1).min(1).default(30_000),
  maxRetries: z.number().step(1).min(0).default(2),
  searchEnabled: z.boolean().default(true),
  fetchEnabled: z.boolean().default(true),
  fallbackEnabled: z.boolean().default(true),
})

/** Cordis plugin name used by loader diagnostics. */
export const name = 'kenari'

/** The web seam this plugin registers providers into; tools arrive in phase 2. */
export const inject = ['web']

/** Register the Kenari capability into the harness. Phase 0: configuration layer only. */
export function apply(ctx: Context, config: Config): void {
  ctx.logger?.info('kenari: loaded (phase 0 — configuration layer only)')
  void config
}
