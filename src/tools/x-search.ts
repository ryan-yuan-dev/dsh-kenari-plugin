/**
 * X（原 Twitter）搜索工具：POST /v1/x/search，过滤参数全量透传。
 * allowed/excluded handles 互斥且各 ≤20（不含 @）；日期 YYYY-MM-DD。
 * 按次计费到余额，失败调用不计费。
 * @module dsh-kenari-plugin/tools/x-search
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolsDeps } from './shared.js'
import { costLine } from './shared.js'
import { kenariPost } from '../http.js'

/** handle 约束：≤20 个、不含 @（OpenAPI pattern 限字母数字下划线）。 */
const MAX_HANDLES = 20

/** 校验 handle 数组：去 @ 前缀、查数量与字符集；违规抛参数错误。 */
function normalizeHandles(handles: string[], field: string): string[] {
  const stripped = handles.map((handle) => handle.replace(/^@/, ''))
  if (stripped.length > MAX_HANDLES) {
    throw new Error(`${field} 最多 ${MAX_HANDLES} 个，收到 ${stripped.length} 个`)
  }
  for (const handle of stripped) {
    if (!/^[A-Za-z0-9_]{1,40}$/.test(handle)) {
      throw new Error(`${field} 含非法 handle "${handle}"：只允许字母、数字、下划线（不含 @）`)
    }
  }
  return stripped
}

/** 日期形参校验：只验形状（YYYY-MM-DD），语义由 Kenari 侧把关。 */
function assertDate(value: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${field} 必须是 YYYY-MM-DD 格式，收到 "${value}"`)
  }
}

/** 注册 kenari_x_search。 */
export function registerXSearchTool(deps: ToolsDeps, register: (tool: ReturnType<typeof defineTool>) => void): void {
  register(defineTool({
    name: 'kenari_x_search',
    description: 'Search X (Twitter) live via Kenari and get a synthesized answer with x.com source links. Billed per search to your Kenari balance. Optional filters: allowed/excluded handles (mutually exclusive, max 20, no @), date range, image/video understanding.',
    parameters: {
      query: { type: 'string', required: true, description: 'The X search query. Must be non-empty.' },
      allowed_x_handles: {
        type: 'array',
        items: { type: 'string' },
        description: 'Only include posts from these handles. Cannot be combined with excluded_x_handles. Max 20, without @.',
      },
      excluded_x_handles: {
        type: 'array',
        items: { type: 'string' },
        description: 'Exclude posts from these handles. Cannot be combined with allowed_x_handles. Max 20, without @.',
      },
      from_date: { type: 'string', description: 'Start date, YYYY-MM-DD.' },
      to_date: { type: 'string', description: 'End date, YYYY-MM-DD.' },
      enable_image_understanding: { type: 'boolean', description: 'Let the backend read images in posts.' },
      enable_video_understanding: { type: 'boolean', description: 'Let the backend read videos in posts.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answer: { type: 'string', required: true },
          citations: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                url: { type: 'string' },
                title: { type: 'string' },
              },
            },
          },
          cost_micro_idr: { type: 'integer' },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      // 互斥与形状约束 schema 表达不了，参数级校验（硬约束：同传报参数错）
      if (args.allowed_x_handles !== undefined && args.excluded_x_handles !== undefined) {
        throw new Error('allowed_x_handles 与 excluded_x_handles 不可同时使用')
      }
      if (args.query.trim().length === 0) {
        throw new Error('query 不能为空')
      }
      const filter: Record<string, unknown> = {}
      if (args.allowed_x_handles !== undefined) {
        filter.allowed_x_handles = normalizeHandles(args.allowed_x_handles, 'allowed_x_handles')
      }
      if (args.excluded_x_handles !== undefined) {
        filter.excluded_x_handles = normalizeHandles(args.excluded_x_handles, 'excluded_x_handles')
      }
      if (args.from_date !== undefined) {
        assertDate(args.from_date, 'from_date')
        filter.from_date = args.from_date
      }
      if (args.to_date !== undefined) {
        assertDate(args.to_date, 'to_date')
        filter.to_date = args.to_date
      }
      if (args.enable_image_understanding !== undefined) filter.enable_image_understanding = args.enable_image_understanding
      if (args.enable_video_understanding !== undefined) filter.enable_video_understanding = args.enable_video_understanding

      const body: Record<string, unknown> = { query: args.query }
      if (Object.keys(filter).length > 0) body.x_search_filter = filter

      const result = await kenariPost<XSearchResponse>(deps.http, '/x/search', body)
      const citations = (result.citations ?? [])
        .map((c) => `- [${c.title ?? c.url}](${c.url})`)
        .join('\n')
      const text = `${result.answer ?? '(无答案)'}${citations.length > 0 ? `\n\n来源：\n${citations}` : ''}${costLine(result.cost_micro_idr)}`
      return {
        answer: result.answer ?? '',
        citations: result.citations ?? [],
        ...(result.cost_micro_idr !== undefined ? { cost_micro_idr: result.cost_micro_idr } : {}),
        text,
      }
    },
  }))
}

/** POST /v1/x/search 响应（字段宽松解析）。 */
interface XSearchResponse {
  answer?: string
  citations?: { url?: string; title?: string }[]
  cost_micro_idr?: number
}
