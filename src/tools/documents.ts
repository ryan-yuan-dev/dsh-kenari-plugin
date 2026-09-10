/**
 * OCR 工具：POST /v1/ocr，按页计费；reuse_id 复用已解析文档不再计费。
 * 会话内复用：同一次 execute 的返回值带 reuse_id，模型下次直接回传即免重复扣费。
 * @module dsh-kenari-plugin/tools/documents
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolsDeps } from './shared.js'
import { formatRupiah } from './shared.js'
import { kenariPost } from '../http.js'
import type { KenariRequestOptions } from '../http.js'

/** data URL 解析：`data:<media-type>;base64,<payload>`，负载要求 canonical base64。 */
function parseDataUrl(dataUrl: string): { mediaType: string; bytes: Uint8Array } {
  const match = /^data:([!#$%&'*+.^_`|~a-zA-Z0-9/-]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl)
  if (match === null) {
    throw new Error('file_data 必须是 data:<media-type>;base64,<内容> 形式的 data URL（Kenari 不抓取 http URL）')
  }
  return { mediaType: match[1], bytes: Uint8Array.from(Buffer.from(match[2], 'base64')) }
}

/** Kenari 接受的文档媒体类型（OpenAPI：pdf 与四种位图）。 */
const ACCEPTED_MEDIA_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/tiff',
])

/** 注册 kenari_ocr。 */
export function registerOcrTool(deps: ToolsDeps, register: (tool: ReturnType<typeof defineTool>) => void): void {
  register(defineTool({
    name: 'kenari_ocr',
    description: 'Read a PDF or document image to text via Kenari OCR. Billed per page from your Kenari balance (~15 MB limit). Send file_data as a data URL, or pass reuse_id from a previous call to re-read the same document free of charge.',
    parameters: {
      file_data: { type: 'string', description: 'The document as a data URL: data:application/pdf;base64,... or an image data URL. Provide this OR reuse_id, never both.' },
      reuse_id: { type: 'string', description: 'Echo of a previously issued reuse_id to serve the stored reading at no cost. Provide this OR file_data, never both.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reuse_id: { type: 'string', required: true },
          pages: { type: 'integer' },
          cost_micro_idr: { type: 'integer' },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 400_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      if (args.file_data !== undefined && args.reuse_id !== undefined) {
        throw new Error('file_data 与 reuse_id 不可同时提供')
      }
      if (args.file_data === undefined && args.reuse_id === undefined) {
        throw new Error('必须提供 file_data（data URL）或 reuse_id 之一')
      }

      const body: Record<string, unknown> = { engine: 'ocr' }
      if (args.reuse_id !== undefined) {
        body.reuse_id = args.reuse_id
      } else if (args.file_data !== undefined) {
        // OpenAPI 要求 file: { filename, file_data }；filename 从数据源推断
        const parsed = parseDataUrl(args.file_data)
        if (!ACCEPTED_MEDIA_TYPES.has(parsed.mediaType)) {
          throw new Error(`不支持的媒体类型 ${parsed.mediaType}：接受 application/pdf、image/png、image/jpeg、image/webp、image/gif、image/tiff`)
        }
        const ext = mediaExtension(parsed.mediaType)
        body.file = { filename: `document${ext}`, file_data: args.file_data }
      }

      // OCR 按页计费：长超时（大文档），超时不重试以免重复扣费
      const ocrOptions: KenariRequestOptions = {
        timeoutMs: deps.http.config.generationTimeoutMs ?? 180_000,
        retries: 1,
        retryTimeouts: false,
      }
      const result = await kenariPost<OcrResponse>(deps.http, '/ocr', body, undefined, ocrOptions)
      if (result.reuse_id === undefined) {
        throw new Error('kenari: OCR 响应缺少 reuse_id，无法建立会话内复用')
      }
      const text = (result.content ?? [])
        .map((block) => block.text ?? '')
        .filter((part) => part.length > 0)
        .join('\n\n')
      const summary: string[] = [
        `OCR 完成：${result.pages ?? '?'} 页，置信度${result.confidence === null || result.confidence === undefined ? '未知' : ` ${Math.round(result.confidence * 100)}%`}${result.low_confidence === true ? '（低置信度告警）' : ''}。`,
        `复用凭证 reuse_id：${result.reuse_id} —— 下次读同一文档传这个 id，不再计费。`,
      ]
      if (result.cost_micro_idr !== undefined) summary.push(`费用：${formatRupiah(result.cost_micro_idr)}（${result.cost_micro_idr === 0 ? '复用命中，免费' : '按页计费'}）`)
      summary.push('', text)

      return {
        reuse_id: result.reuse_id,
        ...(result.pages !== undefined ? { pages: result.pages } : {}),
        ...(result.cost_micro_idr !== undefined ? { cost_micro_idr: result.cost_micro_idr } : {}),
        text: summary.join('\n'),
      }
    },
  }))
}

/** 媒体类型 → 文件扩展名（仅用于 filename 字段）。 */
function mediaExtension(mediaType: string): string {
  switch (mediaType) {
    case 'application/pdf': return '.pdf'
    case 'image/png': return '.png'
    case 'image/jpeg': return '.jpg'
    case 'image/webp': return '.webp'
    case 'image/gif': return '.gif'
    case 'image/tiff': return '.tiff'
    default: return ''
  }
}

/** POST /v1/ocr 响应（content 为分段文本块）。 */
interface OcrResponse {
  id?: string
  pages?: number
  cost_micro_idr?: number
  name?: string
  hash?: string
  content?: { type?: string; text?: string }[]
  confidence?: number | null
  low_confidence?: boolean
  reuse_id?: string
}
