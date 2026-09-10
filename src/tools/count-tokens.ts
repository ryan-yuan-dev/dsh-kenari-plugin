/**
 * token 计数工具：POST /v1/messages/count_tokens（Anthropic 线，只读不计费）。
 * 该端点在根 base（https://kenari.id）之下而非 /v1 线，路径拼接特殊处理。
 * @module dsh-kenari-plugin/tools/count-tokens
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolsDeps } from './shared.js'
import { kenariPost } from '../http.js'

/** 注册 kenari_count_tokens。 */
export function registerCountTokensTool(deps: ToolsDeps, register: (tool: ReturnType<typeof defineTool>) => void): void {
  register(defineTool({
    name: 'kenari_count_tokens',
    description: 'Count input tokens for a Kenari Anthropic-line request (POST /v1/messages/count_tokens). Read-only: no model dispatch, no billing, no model id validation. Useful to budget context before a call.',
    parameters: {
      model: { type: 'string', required: true, description: 'Model id (not validated, but accepted by the endpoint).' },
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
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      // count_tokens 挂在 [OI] 线同一 host 的 /v1/messages/count_tokens 上，
      // 经 http 层的 /v1 归一化后形状正确（Anthropic 客户端形态的 base 差异不影响本路径）
      const body: Record<string, unknown> = {
        model: args.model,
        messages: [{ role: 'user', content: args.text }],
      }
      if (args.system !== undefined) body.system = args.system
      const result = await kenariPost<{ input_tokens?: number }>(deps.http, '/messages/count_tokens', body)
      const tokens = result.input_tokens
      if (tokens === undefined) throw new Error('kenari: count_tokens 响应缺少 input_tokens')
      return {
        input_tokens: tokens,
        text: `输入 token 估算：${tokens}`,
      }
    },
  }))
}
