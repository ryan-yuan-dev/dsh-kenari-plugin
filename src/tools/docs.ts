/**
 * 文档与模型目录工具：kenari_search_docs（本地检索 /llms-full.txt，无需 key）
 * 与 kenari_list_models（GET /v1/models，公开端点）。
 * @module dsh-kenari-plugin/tools/docs
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolsDeps } from './shared.js'
import { kenariGet } from '../http.js'

/** /llms-full.txt 的内存缓存：文档量大（约 130KB），进程内只抓一次。 */
let llmsFullCache: { text: string; fetchedAt: number } | undefined

/** 文档全文抓取（公开端点，无需 key）；失败上抛由 execute 层转错误文本。 */
async function fetchLlmsFull(ttlMs: number): Promise<string> {
  if (ttlMs > 0 && llmsFullCache !== undefined && Date.now() - llmsFullCache.fetchedAt < ttlMs) {
    return llmsFullCache.text
  }
  const response = await fetch('https://kenari.id/llms-full.txt', {
    headers: { Accept: 'text/plain' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`llms-full.txt HTTP ${response.status}`)
  const text = await response.text()
  llmsFullCache = { text, fetchedAt: Date.now() }
  return text
}

/** 文档分节：按一级/二级标题切，保留标题行以便模型引用章节名。 */
function splitSections(text: string): { title: string; body: string }[] {
  const sections: { title: string; body: string }[] = []
  const lines = text.split('\n')
  let title = '(前言)'
  let body: string[] = []
  for (const line of lines) {
    if (/^#{1,2} /.test(line)) {
      if (body.length > 0) sections.push({ title, body: body.join('\n') })
      title = line.replace(/^#+ /, '')
      body = []
    } else {
      body.push(line)
    }
  }
  if (body.length > 0) sections.push({ title, body: body.join('\n') })
  return sections
}

/** 命中打分：查询词按出现次数累加，标题命中权重 ×4。 */
function scoreSection(section: { title: string; body: string }, terms: string[]): number {
  let score = 0
  const titleLower = section.title.toLowerCase()
  const bodyLower = section.body.toLowerCase()
  for (const term of terms) {
    const t = term.toLowerCase()
    if (t.length === 0) continue
    let inTitle = 0
    let idx = titleLower.indexOf(t)
    while (idx !== -1) {
      inTitle++
      idx = titleLower.indexOf(t, idx + t.length)
    }
    score += inTitle * 4
    let inBody = 0
    idx = bodyLower.indexOf(t)
    while (idx !== -1) {
      inBody++
      idx = bodyLower.indexOf(t, idx + t.length)
    }
    score += inBody
  }
  return score
}

/** 单节正文截断： enough context 而不淹没模型。 */
const SECTION_BODY_CHARS = 2500

/** 注册文档检索与模型目录两个公开工具（不消耗余额）。 */
export function registerDocsTools(deps: ToolsDeps, register: (tool: ReturnType<typeof defineTool>) => void): void {
  register(defineTool({
    name: 'kenari_search_docs',
    description: 'Search the Kenari (kenari.id) documentation — quickstart, API reference, billing, routing, BYOK, error codes. Free, no API key needed.',
    parameters: {
      query: { type: 'string', required: true, description: 'What to look up, e.g. "streaming", "error codes", "shared keys".' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 45_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      try {
        const full = await fetchLlmsFull(deps.docsCacheTtlMs)
        const terms = args.query.split(/[\s,，、]+/).filter((term) => term.length > 0)
        if (terms.length === 0) {
          return { text: '查询为空：请给出检索词。' }
        }
        const scored = splitSections(full)
          .map((section) => ({ section, score: scoreSection(section, terms) }))
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 4)
        if (scored.length === 0) {
          return { text: `文档中没有匹配 "${args.query}" 的章节。可尝试的检索词：streaming、error codes、billing、BYOK、routing、tools。` }
        }
        const parts = scored.map(({ section, score }) => {
          const body = section.body.length > SECTION_BODY_CHARS ? `${section.body.slice(0, SECTION_BODY_CHARS)}\n…（已截断）` : section.body
          return `## ${section.title}\n${body}\n（相关度 ${score}）`
        })
        return { text: `Kenari 文档检索结果（${scored.length} 节，来源 https://kenari.id/llms-full.txt）：\n\n${parts.join('\n\n')}` }
      } catch (err) {
        return { text: `kenari 文档检索失败：${String(err)}` }
      }
    },
  }))

  register(defineTool({
    name: 'kenari_list_models',
    description: 'List Kenari models with live per-token IDR prices. Public catalog endpoint, free. Use search to filter by id or provider substring.',
    parameters: {
      search: { type: 'string', description: 'Optional substring to filter by model id or provider.' },
      modality: {
        type: 'string',
        description: 'Filter to one specialized modality; absent returns chat models only.',
        enum: ['embedding', 'rerank', 'moderation'],
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const query: Record<string, string> = {}
      if (args.modality !== undefined) query.modality = args.modality
      const list = await kenariGet<{ data?: ModelRow[] }>(deps.http, '/models', query)
      const models = list.data ?? []
      const search = args.search?.toLowerCase()
      const filtered = search === undefined || search.length === 0
        ? models
        : models.filter((m) => (m.id ?? '').toLowerCase().includes(search) || (m.owned_by ?? '').toLowerCase().includes(search))
      if (filtered.length === 0) {
        return { text: `目录中没有匹配的模型（search=${args.search ?? '（无）'}, modality=${args.modality ?? 'chat'}）。` }
      }
      const lines = filtered.map((m) => {
        const bits: string[] = []
        if (m.owned_by !== undefined) bits.push(`by ${m.owned_by}`)
        if (m.context_length !== undefined) bits.push(`ctx ${m.context_length}`)
        if (m.tool_call === true) bits.push('tools')
        if (m.reasoning === true) bits.push('reasoning')
        if (m.beta === true) bits.push('beta')
        const price = formatPrice(m.pricing)
        return `- ${m.id}${price}${bits.length > 0 ? ` — ${bits.join(', ')}` : ''}`
      })
      return { text: `Kenari 模型目录（${filtered.length}/${models.length} 个，价格单位 IDR / 1M tokens）：\n${lines.join('\n')}` }
    },
  }))
}

/** 模型目录行（只取本工具需要的字段；Kenari rc 期字段宽松解析）。 */
interface ModelRow {
  id?: string
  owned_by?: string
  context_length?: number
  tool_call?: boolean
  reasoning?: boolean
  beta?: boolean
  pricing?: {
    input?: number | null
    output?: number | null
    free?: boolean
    varies?: boolean
  }
}

/** pricing → 可读价格片段；免费与浮动单列。 */
function formatPrice(pricing: ModelRow['pricing']): string {
  if (pricing === undefined) return ''
  if (pricing.free === true) return ' — 免费'
  if (pricing.varies === true) return ' — 价格浮动'
  const input = pricing.input
  const output = pricing.output
  if (input === null || input === undefined) return ''
  const fmt = (micro: number | null | undefined) => micro === null || micro === undefined ? '?' : String(micro / 1_000_000)
  return ` — 入 ${fmt(input)} / 出 ${fmt(output)} IDR per 1M tokens`
}
