/**
 * token 计数与窗口监控：POST /v1/messages/count_tokens（Anthropic 线，只读不计费）。
 * 该端点在根 base（https://kenari.id）之下而非 /v1 线，路径拼接由 http 层归一化。
 * 计数结果与目录里的上下文窗口比对，给出「还能放多少 / 是否该压缩」的可执行判断。
 * @module dsh-kenari-plugin/tools/count-tokens
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolsDeps } from './shared.js'
import { kenariPost } from '../http.js'
import { toResolvedModelInfo } from '../catalog.js'

/** 窗口占用率告警阈值：超过就该考虑压缩历史。 */
const WINDOW_WARN_RATIO = 0.8

/** 注册 kenari_count_tokens（只读、不计费）。 */
export function registerCountTokensTool(deps: ToolsDeps, register: (tool: ReturnType<typeof defineTool>) => void): void {
  register(defineTool({
    name: 'kenari_count_tokens',
    description: 'Count input tokens for a Kenari Anthropic-line request (POST /v1/messages/count_tokens), and compare against the model context window from the catalog. Read-only: no model dispatch, no billing, no model id validation. Use it to decide whether to compact context before a call.',
    parameters: {
      model: { type: 'string', required: true, description: 'Model id (not validated by the endpoint; the catalog lookup is best-effort).' },
      text: { type: 'string', required: true, description: 'The user-turn text to count.' },
      system: { type: 'string', description: 'Optional system prompt text to include in the count.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          input_tokens: { type: 'integer', required: true },
          text: { type: 'string', required: true },
          model_in_catalog: { type: 'boolean' },
          context_window: { type: 'integer' },
          window_usage_ratio: { type: 'number' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const body: Record<string, unknown> = {
        model: args.model,
        messages: [{ role: 'user', content: args.text }],
      }
      if (args.system !== undefined) body.system = args.system
      const result = await kenariPost<{ input_tokens?: number }>(deps.http, '/messages/count_tokens', body)
      const tokens = result.input_tokens
      if (tokens === undefined) throw new Error('kenari: count_tokens 响应缺少 input_tokens')

      const lines = [`输入 token：${tokens}`]
      // 目录查询是增值信息：查不到不影响计数结果，也不新增网络失败面
      const resolved = await deps.catalog.resolve(args.model).catch(() => undefined)
      if (resolved === undefined) {
        lines.push(`目录中未找到模型 ${args.model}：无法给出窗口占比。用 kenari_list_models 取确切 id（免费模型 id 带 :free）。`)
        return { input_tokens: tokens, text: lines.join('\n'), model_in_catalog: false }
      }
      const info = toResolvedModelInfo(resolved.model, 'kenari')
      const contextWindow = info.context?.contextWindow
      for (const warning of resolved.warnings) lines.push(`⚠️ ${warning}`)
      if (contextWindow === undefined) {
        lines.push('该模型目录未公布 context_length：无法给出窗口占比。')
        return { input_tokens: tokens, text: lines.join('\n'), model_in_catalog: true }
      }
      const ratio = tokens / contextWindow
      lines.push(`上下文窗口：${contextWindow}，本次输入占 ${(ratio * 100).toFixed(1)}%`)
      if (ratio >= 1) {
        lines.push('⛔ 已超出窗口：这次请求会被网关拒绝。必须压缩历史、裁剪附件，或换更大窗口的模型。')
      } else if (ratio >= WINDOW_WARN_RATIO) {
        lines.push(`⚠️ 已用 ${(ratio * 100).toFixed(1)}%（≥${WINDOW_WARN_RATIO * 100}%）：建议先压缩/摘要历史或裁剪附件，再发起请求，避免中途失败。`)
      }
      if (resolved.free) lines.push('该模型免费：即使重发也不产生余额消耗。')
      return {
        input_tokens: tokens,
        text: lines.join('\n'),
        model_in_catalog: true,
        context_window: contextWindow,
        window_usage_ratio: Number(ratio.toFixed(4)),
      }
    },
  }))
}
