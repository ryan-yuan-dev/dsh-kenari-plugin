/**
 * 数据工具族：embeddings / rerank / moderations。
 * 模型 id 是动态目录：提示模型先用 kenari_list_models?modality=… 查活动 id。
 * 三者都按 token 计费，但响应回显程度不同：rerank 带 usage，embeddings 不带，
 * 故后者的费用只能是粗估（按字符数折算 token），并在文案里明说。
 * @module dsh-kenari-plugin/tools/data
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolsDeps } from './shared.js'
import { billSpend, estimateByUnit, spendGuard } from './shared.js'
import { kenariPost } from '../http.js'

/** 无 usage 回显时的 token 粗估系数（字符 → token），仅用于费用量级提示。 */
const CHARS_PER_TOKEN = 4

/** 输入文本总字符数（string 或 string[]）。 */
function inputChars(input: string | string[]): number {
  return (Array.isArray(input) ? input : [input]).reduce((sum, item) => sum + item.length, 0)
}

/** 注册数据三工具。 */
export function registerDataTools(deps: ToolsDeps, register: (tool: ReturnType<typeof defineTool>) => void): void {
  register(defineTool({
    name: 'kenari_embed',
    description: 'Create text embeddings with a Kenari embedding model (e.g. bge-m3). Embedding ids are dynamic — query kenari_list_models with modality=embedding for active ids. Free of charge by current pricing but ids change.',
    parameters: {
      model: { type: 'string', required: true, description: 'Embedding model id (query kenari_list_models?modality=embedding for active ids).' },
      input: {
        oneOf: [
          { type: 'string' },
          { type: 'array', items: { type: 'string' } },
        ],
        required: true,
        description: 'Text to embed: a single string or an array of strings.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          vectors: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer', required: true },
                dimensions: { type: 'integer', required: true },
                preview: { type: 'array', items: { type: 'number' } },
              },
            },
          },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      spendGuard(deps, exec, 'kenari_embed')
      // 嵌入向量不进模型上下文（动辄上千维）：只回显维度与头部预览
      const result = await kenariPost<EmbeddingResponse>(deps.http, '/embeddings', { model: args.model, input: args.input })
      const rows = (result.data ?? []).map((item) => ({
        index: item.index ?? 0,
        dimensions: item.embedding?.length ?? 0,
        preview: (item.embedding ?? []).slice(0, 5),
      }))
      const approxTokens = Math.ceil(inputChars(args.input) / CHARS_PER_TOKEN)
      const estimate = await estimateByUnit(deps, args.model, 'embeddings', approxTokens / 1_000_000)
      const billed = await billSpend(deps, exec, {
        tool: 'kenari_embed',
        model: args.model,
        estimateMicroIdr: estimate.microIdr,
        estimateNote: estimate.microIdr === undefined
          ? undefined
          : `输入 ≈${approxTokens} tokens（按 ${CHARS_PER_TOKEN} 字符/token 粗估，接口未回显 usage）`,
      })
      const base = rows.length === 0
        ? 'kenari: embeddings 响应为空'
        : `嵌入完成：${rows.length} 个向量，维度 ${rows[0].dimensions}。向量本体不回显（太大），需要时按 index 自行取用。`
      return { vectors: rows, text: `${base}${billed}` }
    },
  }))

  register(defineTool({
    name: 'kenari_rerank',
    description: 'Rerank documents against a query with a Kenari rerank model (e.g. bge-reranker-base). Up to 100 documents, 8192 bytes each. Rerank ids are dynamic — query kenari_list_models with modality=rerank.',
    parameters: {
      model: { type: 'string', required: true, description: 'Rerank model id (query kenari_list_models?modality=rerank for active ids).' },
      query: { type: 'string', required: true, description: 'The search query to rank documents against (up to 8192 bytes).' },
      documents: { type: 'array', required: true, items: { type: 'string' }, description: 'Documents to rank, in order. Up to 100, 8192 bytes each, 512 KiB combined.' },
      top_n: { type: 'integer', description: 'Return only the top N results (default all).' },
      return_documents: { type: 'boolean', description: 'Include each result\'s document text (default false).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer', required: true },
                relevance_score: { type: 'number', required: true },
                document_text: { type: 'string' },
              },
            },
          },
          usage_total_tokens: { type: 'integer' },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      spendGuard(deps, exec, 'kenari_rerank')
      const body: Record<string, unknown> = { model: args.model, query: args.query, documents: args.documents }
      if (args.top_n !== undefined) body.top_n = args.top_n
      if (args.return_documents !== undefined) body.return_documents = args.return_documents
      const result = await kenariPost<RerankResponse>(deps.http, '/rerank', body)
      const results = (result.results ?? []).map((row) => ({
        index: row.index ?? 0,
        relevance_score: row.relevance_score ?? 0,
        ...(row.document?.text !== undefined ? { document_text: row.document.text } : {}),
      }))
      const lines = results.map((row) => `#${row.index}（${args.documents[row.index] ?? '?'}）→ ${row.relevance_score}`)
      const usage = result.usage?.total_tokens !== undefined ? `\n用量：${result.usage.total_tokens} tokens` : ''
      // rerank 回显 usage.total_tokens：按目录 token 单价精确预估
      const totalTokens = result.usage?.total_tokens
      const estimate = totalTokens === undefined
        ? {}
        : await estimateByUnit(deps, args.model, 'rerank', totalTokens / 1_000_000)
      const billed = await billSpend(deps, exec, {
        tool: 'kenari_rerank',
        model: args.model,
        estimateMicroIdr: estimate.microIdr,
        estimateNote: estimate.microIdr === undefined ? undefined : `${totalTokens} tokens（响应回显）`,
      })
      return {
        results,
        ...(result.usage?.total_tokens !== undefined ? { usage_total_tokens: result.usage.total_tokens } : {}),
        text: `重排完成（best first）：\n${lines.join('\n')}${usage}${billed}`,
      }
    },
  }))

  register(defineTool({
    name: 'kenari_moderate',
    description: 'Classify text against Kenari moderation categories. No moderation model is active in the public catalog right now — this call returns 400 until one appears; check kenari_list_models?modality=moderation.',
    parameters: {
      model: { type: 'string', required: true, description: 'Moderation model id (query kenari_list_models?modality=moderation for active ids).' },
      input: {
        oneOf: [
          { type: 'string' },
          { type: 'array', items: { type: 'string' } },
        ],
        required: true,
        description: 'Text to classify: a single string or an array of strings.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                flagged: { type: 'boolean', required: true },
                flagged_categories: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      // 公开目录暂无 moderation 模型，也没有可用的计价行：只做预算预检，不记费用
      spendGuard(deps, exec, 'kenari_moderate')
      const result = await kenariPost<ModerationResponse>(deps.http, '/moderations', { model: args.model, input: args.input })
      const results = (result.results ?? []).map((row) => ({
        flagged: row.flagged ?? false,
        ...(row.categories !== undefined
          ? { flagged_categories: Object.entries(row.categories).filter(([, flagged]) => flagged === true).map(([category]) => category) }
          : {}),
      }))
      const lines = results.map((row, index) => `输入 ${index + 1}：${row.flagged ? `命中 [${(row.flagged_categories ?? []).join(', ')}]` : '未命中任何类别'}`)
      return { results, text: `审核完成：\n${lines.join('\n')}` }
    },
  }))
}

/** POST /v1/embeddings 响应。 */
interface EmbeddingResponse {
  object?: string
  model?: string
  data?: { object?: string; index?: number; embedding?: number[] }[]
}

/** POST /v1/rerank 响应。 */
interface RerankResponse {
  results?: { index?: number; relevance_score?: number; document?: { text?: string } }[]
  usage?: { prompt_tokens?: number; total_tokens?: number }
}

/** POST /v1/moderations 响应。 */
interface ModerationResponse {
  id?: string
  model?: string
  results?: { flagged?: boolean; categories?: Record<string, boolean>; category_scores?: Record<string, number> }[]
}
