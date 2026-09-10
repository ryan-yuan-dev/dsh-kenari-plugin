/**
 * 文档与模型目录工具：kenari_search_docs（本地检索 /llms-full.txt，无需 key）
 * 与 kenari_list_models（目录走 catalog.ts 的 TTL 缓存，公开端点）。
 * @module dsh-kenari-plugin/tools/docs
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolsDeps } from './shared.js'
import type { ResolvedModel } from '../catalog.js'
import { formatPricingLines, formatTokenPrice } from '../catalog.js'

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

/** 单节正文截断：够 context 而不淹没模型。 */
const SECTION_BODY_CHARS = 2500

/** 模型条目 → 人读多行块（能力、上下文、价格、非 token 单价、告警）。 */
export function formatModelEntry(resolved: ResolvedModel): string {
  const model = resolved.model
  const bits: string[] = []
  bits.push(`ctx ${model.context_length ?? '未知'}`)
  if (model.tool_call === true) bits.push('工具调用')
  if (model.reasoning === true) {
    const options = model.reasoning_options ?? []
    bits.push(options.length > 0 ? `推理（${options.join('/')}）` : '推理')
  }
  if (model.owned_by !== undefined) bits.push(`by ${model.owned_by}`)
  const inputModalities = model.modalities?.input ?? []
  if (inputModalities.length > 0) bits.push(`输入 ${inputModalities.join('+')}`)
  const lines = [`- ${model.id}${resolved.free ? '（免费）' : ''} — ${bits.join('，')}`, `  ${formatTokenPrice(model)}`]
  const pricingLines = formatPricingLines(model)
  if (pricingLines.length > 0) lines.push(`  ${pricingLines.join('；')}`)
  const aliases = resolved.aliases.filter((alias) => alias !== model.id)
  if (aliases.length > 0) lines.push(`  别名：${aliases.join('、')}`)
  for (const warning of resolved.warnings) lines.push(`  ⚠️ ${warning}`)
  return lines.join('\n')
}

/** 免费模型首选（新账户 Rp 0 也能跑通全流程）。 */
const RECOMMENDED_FREE_MODEL = 'step-3-7-flash:free'

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
        const full = await fetchLlmsFull(deps.config.docsCacheTtlMs ?? 3_600_000)
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
    description: 'List Kenari models with live per-token IDR prices, context window, capabilities, and non-token unit prices. Public catalog, free. Filter by id/provider substring, by specialized modality, or to free models only.',
    parameters: {
      search: { type: 'string', description: 'Optional substring to filter by model id or provider.' },
      modality: {
        type: 'string',
        description: 'Omit this for chat/session models (the common case). Set it only to list a specialized capability catalog instead of chat models.',
        enum: ['embedding', 'rerank', 'moderation'],
      },
      free_only: { type: 'boolean', description: 'Return only free models (id ends with :free or pricing.free).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          free_ids: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const all = await deps.catalog.list(args.modality)
      const described = all.map((model) => deps.catalog.describe(model))
      const search = args.search?.toLowerCase()
      const filtered = described.filter((entry) => {
        if (args.free_only === true && !entry.free) return false
        if (search === undefined || search.length === 0) return true
        return entry.id.toLowerCase().includes(search) || (entry.model.owned_by ?? '').toLowerCase().includes(search)
      })
      const freeIds = described.filter((entry) => entry.free).map((entry) => entry.id)
      if (filtered.length === 0) {
        return {
          text: `目录中没有匹配的模型（search=${args.search ?? '（无）'}, modality=${args.modality ?? 'chat'}, free_only=${args.free_only === true ? '是' : '否'}）。`,
          free_ids: freeIds,
        }
      }
      const free = filtered.filter((entry) => entry.free)
      const paid = filtered.filter((entry) => !entry.free)
      const sections: string[] = []
      if (free.length > 0) sections.push(`【免费模型 ${free.length} 个】\n${free.map(formatModelEntry).join('\n')}`)
      if (paid.length > 0) sections.push(`【付费模型 ${paid.length} 个】\n${paid.map(formatModelEntry).join('\n')}`)
      const hint = freeIds.includes(RECOMMENDED_FREE_MODEL)
        ? `\n\n新账户（Rp 0）建议先用 ${RECOMMENDED_FREE_MODEL}：免费且在三条协议线上都可用。`
        : ''
      return {
        text: `Kenari 模型目录（${filtered.length}/${all.length} 个，token 价格单位 IDR / 1M tokens）：\n\n${sections.join('\n\n')}${hint}`,
        free_ids: freeIds,
      }
    },
  }))
}
