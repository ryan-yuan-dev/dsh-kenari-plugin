/**
 * 数据工具族：embeddings / rerank / moderations。
 * 模型 id 是动态目录：提示模型先用 kenari_list_models?modality=… 查活动 id。
 * @module dsh-kenari-plugin/tools/data
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolsDeps } from './shared.js'
import { kenariPost } from '../http.js'

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
    async execute(args) {
      // 嵌入向量不进模型上下文（动辄上千维）：只回显维度与头部预览
      const result = await kenariPost<EmbeddingResponse>(deps.http, '/embeddings', { model: args.model, input: args.input })
      const rows = (result.data ?? []).map((item) => ({
        index: item.index ?? 0,
        dimensions: item.embedding?.length ?? 0,
        preview: (item.embedding ?? []).slice(0, 5),
      }))
      const text = rows.length === 0
        ? 'kenari: embeddings 响应为空'
        : `嵌入完成：${rows.length} 个向量，维度 ${rows[0].dimensions}。向量本体不回显（太大），需要时按 index 自行取用。`
      return { vectors: rows, text }
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
    async execute(args) {
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
      return {
        results,
        ...(result.usage?.total_tokens !== undefined ? { usage_total_tokens: result.usage.total_tokens } : {}),
        text: `重排完成（best first）：\n${lines.join('\n')}${usage}`,
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
    async execute(args) {
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
