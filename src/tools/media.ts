/**
 * 媒体工具族：图像生成/编辑、语音合成/转写、音乐生成、视频生成/续写/状态/下载。
 * 二进制产物（图像、音频、视频）经 ctx.attachments 落盘；attachment ref 是纯 JSON，
 * 放进规范 value 由 render 重建 image/file block，模型与 UI 都能看到产物。
 * @module dsh-kenari-plugin/tools/media
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ToolsDeps } from './shared.js'
import { billSpend, estimateByUnit, spendGuard } from './shared.js'
import { kenariPost, kenariPostBinary, kenariPostMultipart, kenariGet, kenariGetBinary } from '../http.js'

/** 规范 value 里的产物描述：kind 决定 render 重建成 image 还是 file block。 */
export interface MediaAttachmentValue {
  kind: 'image' | 'file'
  /** ImageAttachmentRef 字段（image）。 */
  attachmentId: string
  mediaType?: string
  width?: number
  height?: number
  /** FileAttachmentRef 字段（file）。 */
  name?: string
  bytes: number
}

/** 解析 base64 data URI → 原始字节（图像响应的 url 字段恒为 data URI）。 */
function decodeDataUri(dataUri: string, field: string): { mediaType: string; bytes: Uint8Array } {
  const match = /^data:([!#$%&'*+.^_`|~a-zA-Z0-9/-]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUri)
  if (match === null) throw new Error(`${field} 不是合法的 base64 data URI`)
  return { mediaType: match[1], bytes: Uint8Array.from(Buffer.from(match[2], 'base64')) }
}

/** attachment 存储支持的图像类型。 */
function imageMediaType(mediaType: string): ImageMediaType | undefined {
  if (mediaType === 'image/png' || mediaType === 'image/jpeg' || mediaType === 'image/webp' || mediaType === 'image/gif') {
    return mediaType
  }
  return undefined
}

/** 落盘图像并产出规范 value 的 attachments 数组；存储未挂载时返回空数组。 */
async function saveImages(
  deps: ToolsDeps,
  images: { mediaType: string; bytes: Uint8Array }[],
  name: string,
): Promise<{ attachments: MediaAttachmentValue[]; storeMissing: boolean }> {
  const attachments = deps.ctx.get('attachments')
  // 没有存储就展示不了图：显式告知调用方，避免模型以为产物已在上下文里
  if (attachments === undefined) return { attachments: [], storeMissing: true }
  const refs = await attachments.saveImages(images.map((img) => {
    const mediaType = imageMediaType(img.mediaType)
    if (mediaType === undefined) throw new Error(`图像媒体类型 ${img.mediaType} 不受 attachment 存储支持`)
    return { data: img.bytes, mediaType, name }
  }))
  return {
    storeMissing: false,
    attachments: refs.map((ref) => ({
      kind: 'image' as const,
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      width: ref.width,
      height: ref.height,
      name: ref.name,
      bytes: ref.bytes,
    })),
  }
}

/** 落盘任意文件并产出单元素 attachments 数组；存储未挂载时抛可读错误。 */
async function saveFile(deps: ToolsDeps, bytes: Uint8Array, name: string): Promise<MediaAttachmentValue[]> {
  const attachments = deps.ctx.get('attachments')
  if (attachments === undefined) {
    throw new Error('本部署没有挂载 attachment 存储，无法保存音频/视频文件')
  }
  const ref = await attachments.saveFile({ data: bytes, name })
  return [{ kind: 'file', attachmentId: ref.attachmentId, name: ref.name, bytes: ref.bytes }]
}

/** 规范 value 的 attachments → ContentBlock（render 用；损坏的 ref 退化为文本）。 */
export function renderAttachments(value: { attachments?: MediaAttachmentValue[] }): ContentBlock[] {
  const blocks: ContentBlock[] = []
  for (const item of value.attachments ?? []) {
    if (item.kind === 'image' && item.mediaType !== undefined && item.width !== undefined && item.height !== undefined) {
      blocks.push({
        type: 'image',
        attachment: {
          attachmentId: item.attachmentId as never,
          mediaType: item.mediaType as ImageMediaType,
          bytes: item.bytes,
          width: item.width,
          height: item.height,
          ...(item.name !== undefined ? { name: item.name } : {}),
        },
      })
    } else if (item.kind === 'file' && item.name !== undefined) {
      blocks.push({
        type: 'file',
        attachment: { attachmentId: item.attachmentId as never, name: item.name, bytes: item.bytes },
      })
    }
  }
  return blocks
}

/**
 * 生成类调用的传输选项：长超时 + 超时不重试（服务端可能已完成并计费，
 * 重试有重复扣费风险）；5xx/429 仍允许重试一次。
 */
function generationOptions(deps: ToolsDeps) {
  return {
    timeoutMs: deps.http.config.generationTimeoutMs ?? 180_000,
    retries: 1,
    retryTimeouts: false,
  }
}

/** 从 content-type 推断扩展名（仅用于文件命名）。 */
function extensionFor(contentType: string): string {
  if (contentType.includes('mpeg')) return '.mp3'
  if (contentType.includes('wav')) return '.wav'
  if (contentType.includes('pcm')) return '.pcm'
  if (contentType.includes('ogg')) return '.ogg'
  if (contentType.includes('aac')) return '.aac'
  if (contentType.includes('flac')) return '.flac'
  if (contentType.includes('mp4')) return '.mp4'
  if (contentType.includes('webm')) return '.webm'
  if (contentType.includes('quicktime')) return '.mov'
  return '.bin'
}

/** value 的 attachments 字段 schema（各产物工具共用）。 */
const attachmentsSchema = {
  type: 'array' as const,
  items: {
    type: 'object' as const,
    additionalProperties: false as const,
    properties: {
      kind: { type: 'string' as const },
      attachmentId: { type: 'string' as const },
      mediaType: { type: 'string' as const },
      width: { type: 'integer' as const },
      height: { type: 'integer' as const },
      name: { type: 'string' as const },
      bytes: { type: 'integer' as const },
    },
  },
}

/** 带产物 render 的 output（text + attachments，render 重建 image/file block）。 */
function outputWithMedia() {
  return {
    schema: {
      type: 'object' as const,
      additionalProperties: false as const,
      properties: {
        text: { type: 'string' as const, required: true as const },
        attachments: attachmentsSchema,
      },
    },
    render: (_args: never, value: { text: string; attachments?: MediaAttachmentValue[] }) => {
      const blocks: ContentBlock[] = [{ type: 'text', text: value.text }]
      blocks.push(...renderAttachments(value))
      return blocks
    },
  }
}

/** 注册媒体工具族。 */
export function registerMediaTools(deps: ToolsDeps, register: (tool: ReturnType<typeof defineTool>) => void): void {
  register(defineTool({
    name: 'kenari_image_generate',
    description: 'Generate images with a Kenari image model (e.g. gpt-image-2). Returns inline images. Billed per image from your Kenari balance.',
    parameters: {
      model: { type: 'string', required: true, description: 'Image model id from the catalog, e.g. gpt-image-2.' },
      prompt: { type: 'string', required: true, description: 'What to draw.' },
      n: { type: 'integer', description: 'Number of images (default 1). Each image is billed.' },
      size: { type: 'string', description: 'Image size, e.g. "1024x1024".' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true },
          revised_prompts: { type: 'array', items: { type: 'string' } },
          text: { type: 'string', required: true },
          attachments: attachmentsSchema,
        },
      },
      render: (_args, value: { count: number; revised_prompts?: string[]; text: string; attachments?: MediaAttachmentValue[] }) => {
        const blocks: ContentBlock[] = [{ type: 'text', text: value.text }]
        blocks.push(...renderAttachments(value))
        return blocks
      },
    },
    timeoutMs: 400000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      spendGuard(deps, exec, 'kenari_image_generate')
      const body: Record<string, unknown> = { model: args.model, prompt: args.prompt }
      if (args.n !== undefined) body.n = args.n
      if (args.size !== undefined) body.size = args.size
      const result = await kenariPost<ImageResponse>(deps.http, '/images/generations', body, undefined, generationOptions(deps))
      const items = result.data ?? []
      const images: { mediaType: string; bytes: Uint8Array }[] = []
      const revised: string[] = []
      for (const item of items) {
        const raw = item.b64_json !== undefined
          ? { mediaType: 'image/png', bytes: Uint8Array.from(Buffer.from(item.b64_json, 'base64')) }
          : item.url !== undefined
            ? decodeDataUri(item.url, '图像响应 url')
            : undefined
        if (raw !== undefined) images.push(raw)
        if (item.revised_prompt !== undefined) revised.push(item.revised_prompt)
      }
      const saved = await saveImages(deps, images, `kenari-${args.model}.png`)
      const notes = revised.length > 0 ? `\n修订提示词：${revised.join('；')}` : ''
      const storeNote = saved.storeMissing ? '\n（本部署没有挂载 attachment 存储，图像已生成但无法内联展示）' : ''
      // 图像按张计费：以实际产出张数记账（生成失败时张数为 0，不产生费用）
      const estimate = await estimateByUnit(deps, args.model, 'images', images.length)
      const billed = await billSpend(deps, exec, {
        tool: 'kenari_image_generate',
        model: args.model,
        estimateMicroIdr: images.length > 0 ? estimate.microIdr : undefined,
        estimateNote: estimate.note,
        note: '按张计费',
      })
      return {
        count: images.length,
        revised_prompts: revised,
        text: `已生成 ${images.length} 张图像。${notes}${storeNote}${billed}`,
        attachments: saved.attachments,
      }
    },
  }))

  register(defineTool({
    name: 'kenari_image_edit',
    description: 'Edit a PNG image with a Kenari image model. Provide image as a data URL; optional mask marks editable regions. Billed per image.',
    parameters: {
      model: { type: 'string', required: true, description: 'Image model id, e.g. gpt-image-2.' },
      prompt: { type: 'string', required: true, description: 'Description of the desired edit.' },
      image_data_url: { type: 'string', required: true, description: 'Source PNG as a data URL (data:image/png;base64,...).' },
      mask_data_url: { type: 'string', description: 'Optional PNG mask; transparent regions mark where the edit applies.' },
      n: { type: 'integer', description: 'Number of images (default 1).' },
      size: { type: 'string', description: 'Image size, e.g. "1024x1024".' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true },
          text: { type: 'string', required: true },
          attachments: attachmentsSchema,
        },
      },
      render: (_args, value: { count: number; text: string; attachments?: MediaAttachmentValue[] }) => {
        const blocks: ContentBlock[] = [{ type: 'text', text: value.text }]
        blocks.push(...renderAttachments(value))
        return blocks
      },
    },
    timeoutMs: 400000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      spendGuard(deps, exec, 'kenari_image_edit')
      const image = decodeDataUri(args.image_data_url, 'image_data_url')
      const fields: Record<string, string | Uint8Array> = {
        model: args.model,
        prompt: args.prompt,
        image: image.bytes,
      }
      if (args.mask_data_url !== undefined) {
        fields.mask = decodeDataUri(args.mask_data_url, 'mask_data_url').bytes
      }
      if (args.n !== undefined) fields.n = String(args.n)
      if (args.size !== undefined) fields.size = args.size
      const result = await kenariPostMultipart<ImageResponse>(deps.http, '/images/edits', fields, undefined, generationOptions(deps))
      const items = result.data ?? []
      const images: { mediaType: string; bytes: Uint8Array }[] = []
      for (const item of items) {
        const raw = item.b64_json !== undefined
          ? { mediaType: 'image/png', bytes: Uint8Array.from(Buffer.from(item.b64_json, 'base64')) }
          : item.url !== undefined
            ? decodeDataUri(item.url, '图像响应 url')
            : undefined
        if (raw !== undefined) images.push(raw)
      }
      const saved = await saveImages(deps, images, `kenari-edit-${args.model}.png`)
      const storeNote = saved.storeMissing ? '\n（本部署没有挂载 attachment 存储，图像已生成但无法内联展示）' : ''
      const estimate = await estimateByUnit(deps, args.model, 'images', images.length)
      const billed = await billSpend(deps, exec, {
        tool: 'kenari_image_edit',
        model: args.model,
        estimateMicroIdr: images.length > 0 ? estimate.microIdr : undefined,
        estimateNote: estimate.note,
        note: '按张计费',
      })
      return {
        count: images.length,
        text: `编辑完成，产出 ${images.length} 张图像。${storeNote}${billed}`,
        attachments: saved.attachments,
      }
    },
  }))

  register(defineTool({
    name: 'kenari_speech',
    description: 'Synthesize speech from text with a Kenari TTS model. Voice and format names are model-specific (read the model entry in kenari_list_models). Returns an audio file.',
    parameters: {
      model: { type: 'string', required: true, description: 'TTS model id from the catalog.' },
      input: { type: 'string', required: true, description: 'Text to synthesize.' },
      voice: { type: 'string', description: 'Voice id (model-specific; omit for the model default).' },
      response_format: { type: 'string', description: 'Audio format: mp3, wav, pcm, opus, aac or flac.', enum: ['mp3', 'wav', 'pcm', 'opus', 'aac', 'flac'] },
      speed: { type: 'number', description: 'Playback speed multiplier.' },
      language: { type: 'string', description: 'Language hint (default auto).' },
    },
    output: outputWithMedia(),
    timeoutMs: 400000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      spendGuard(deps, exec, 'kenari_speech')
      const body: Record<string, unknown> = { model: args.model, input: args.input }
      if (args.voice !== undefined) body.voice = args.voice
      if (args.response_format !== undefined) body.response_format = args.response_format
      if (args.speed !== undefined) body.speed = args.speed
      if (args.language !== undefined) body.language = args.language
      const audio = await kenariPostBinary(deps.http, '/audio/speech', body, undefined, generationOptions(deps))
      const attachments = await saveFile(deps, audio.bytes, `kenari-speech${extensionFor(audio.contentType)}`)
      // 语音按千字符计费：输入文本长度即计费量
      const estimate = await estimateByUnit(deps, args.model, 'audio_speech', args.input.length / 1000)
      const billed = await billSpend(deps, exec, {
        tool: 'kenari_speech',
        model: args.model,
        estimateMicroIdr: estimate.microIdr,
        estimateNote: estimate.note,
        note: '按千字符计费',
      })
      return {
        text: `语音合成完成：${audio.bytes.length} 字节（${audio.contentType}），文件已保存。${billed}`,
        attachments,
      }
    },
  }))

  register(defineTool({
    name: 'kenari_transcribe',
    description: 'Transcribe an audio file with a Kenari STT model. Send the file as a data URL. verbose_json adds segments and duration.',
    parameters: {
      model: { type: 'string', required: true, description: 'STT model id from the catalog.' },
      file_data_url: { type: 'string', required: true, description: 'Audio file as a data URL.' },
      language: { type: 'string', description: 'ISO-639-1 language code, e.g. "en" or "id".' },
      prompt: { type: 'string', description: 'Optional context hint to improve accuracy.' },
      temperature: { type: 'number', description: 'Sampling temperature 0–1.' },
      response_format: { type: 'string', description: 'json, text or verbose_json. Default json.', enum: ['json', 'text', 'verbose_json'] },
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
    timeoutMs: 400000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      spendGuard(deps, exec, 'kenari_transcribe')
      const file = decodeDataUri(args.file_data_url, 'file_data_url')
      const fields: Record<string, string | Uint8Array> = {
        model: args.model,
        file: file.bytes,
        response_format: args.response_format ?? 'json',
      }
      if (args.language !== undefined) fields.language = args.language
      if (args.prompt !== undefined) fields.prompt = args.prompt
      if (args.temperature !== undefined) fields.temperature = String(args.temperature)
      const result = await kenariPostMultipart<TranscriptionResponse>(deps.http, '/audio/transcriptions', fields, undefined, generationOptions(deps))
      // 转写按秒计费：时长只在 verbose_json 里回显，缺它就如实说明无法预估
      const duration = result.duration
      const estimate = duration === undefined
        ? {}
        : await estimateByUnit(deps, args.model, 'audio_transcription', duration)
      const billed = await billSpend(deps, exec, {
        tool: 'kenari_transcribe',
        model: args.model,
        estimateMicroIdr: estimate.microIdr,
        estimateNote: estimate.note,
        note: duration === undefined ? '响应未回显时长，改用 response_format=verbose_json 可得到费用预估' : '按秒计费',
      })
      return { text: `${result.text ?? '(转写结果为空)'}${billed}` }
    },
  }))

  register(defineTool({
    name: 'kenari_music',
    description: 'Generate a song or instrumental track with a Kenari music model. Lyrics required for songs; prompt required for instrumentals. Returns an mp3 file.',
    parameters: {
      model: { type: 'string', required: true, description: 'Music model id from the catalog.' },
      prompt: { type: 'string', description: 'Style and mood. Required when instrumental is true.' },
      lyrics: { type: 'string', description: 'The words of a sung track. Required when instrumental is false or absent.' },
      instrumental: { type: 'boolean', description: 'Generate an instrumental track (default false).' },
    },
    output: outputWithMedia(),
    timeoutMs: 500000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      spendGuard(deps, exec, 'kenari_music')
      const body: Record<string, unknown> = { model: args.model }
      if (args.prompt !== undefined) body.prompt = args.prompt
      if (args.lyrics !== undefined) body.lyrics = args.lyrics
      if (args.instrumental !== undefined) body.instrumental = args.instrumental
      const result = await kenariPost<MusicResponse>(deps.http, '/music/generations', body, undefined, generationOptions(deps))
      const item = (result.data ?? [])[0]
      if (item?.b64_json === undefined) throw new Error('kenari: 音乐响应缺少 b64_json')
      const bytes = Uint8Array.from(Buffer.from(item.b64_json, 'base64'))
      const attachments = await saveFile(deps, bytes, 'kenari-music.mp3')
      // 音乐按首计费，但公开目录当前无 music 模型，故无单价可查（如实说明未计入）
      const estimate = await estimateByUnit(deps, args.model, 'music_generations', 1)
      const billed = await billSpend(deps, exec, {
        tool: 'kenari_music',
        model: args.model,
        estimateMicroIdr: estimate.microIdr,
        estimateNote: estimate.note,
      })
      return {
        text: `音乐生成完成：mp3，${bytes.length} 字节，文件已保存。${billed}`,
        attachments,
      }
    },
  }))

  register(defineTool({
    name: 'kenari_video_generate',
    description: 'Start a Kenari video generation job (text-to-video, image-to-video or reference-to-video). Returns a job id; poll with kenari_video_status, download with kenari_video_content. Billed per second of output.',
    parameters: {
      model: { type: 'string', required: true, description: 'Video model id from the catalog.' },
      prompt: { type: 'string', required: true, description: 'Text description of the video.' },
      duration: { type: 'integer', description: 'Seconds, 1–15 (default 6; model-specific lists may apply).' },
      image_url: { type: 'string', description: 'Source image URL for image-to-video (must serve the image directly).' },
      end_image_url: { type: 'string', description: 'Optional final frame, paired with image_url.' },
      video_url: { type: 'string', description: 'Reference clip URL for reference-to-video (takes priority over image_url).' },
      aspect_ratio: { type: 'string', description: 'e.g. "16:9" or "9:16".' },
      resolution: { type: 'string', description: 'Resolution tier, e.g. "720p" or "1080p".' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          job_id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      spendGuard(deps, exec, 'kenari_video_generate')
      const body: Record<string, unknown> = { model: args.model, prompt: args.prompt }
      if (args.duration !== undefined) body.duration = args.duration
      if (args.image_url !== undefined) body.image_url = args.image_url
      if (args.end_image_url !== undefined) body.end_image_url = args.end_image_url
      if (args.video_url !== undefined) body.video_url = args.video_url
      if (args.aspect_ratio !== undefined) body.aspect_ratio = args.aspect_ratio
      if (args.resolution !== undefined) body.resolution = args.resolution
      const result = await kenariPost<VideoJobResponse>(deps.http, '/videos/generations', body)
      if (result.id === undefined) throw new Error('kenari: 视频响应缺少任务 id')
      // 视频按秒计费且分分辨率档：分辨率决定单价，时长决定数量
      const seconds = args.duration ?? 6
      const estimate = await estimateByUnit(deps, args.model, 'videos', seconds, args.resolution)
      const billed = await billSpend(deps, exec, {
        tool: 'kenari_video_generate',
        model: args.model,
        estimateMicroIdr: estimate.microIdr,
        estimateNote: estimate.note,
        note: '按秒计费；任务失败不计费，实际扣费以成片为准',
      })
      return {
        job_id: result.id,
        status: result.status ?? 'rendering',
        text: `视频任务已创建：id=${result.id}，状态 ${result.status ?? 'rendering'}。用 kenari_video_status 轮询；完成后用 kenari_video_content 下载。${billed}`,
      }
    },
  }))

  register(defineTool({
    name: 'kenari_video_extend',
    description: 'Extend an existing Kenari video with a follow-up segment. Requires the source video URL. Returns a new job id.',
    parameters: {
      model: { type: 'string', required: true, description: 'Video model id from the catalog.' },
      video_url: { type: 'string', required: true, description: 'URL of the source video to extend.' },
      prompt: { type: 'string', description: 'Optional prompt for the extension.' },
      duration: { type: 'integer', description: 'Extension length in seconds, 1–15 (default 6).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          job_id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      spendGuard(deps, exec, 'kenari_video_extend')
      const body: Record<string, unknown> = { model: args.model, video: { url: args.video_url } }
      if (args.prompt !== undefined) body.prompt = args.prompt
      if (args.duration !== undefined) body.duration = args.duration
      const result = await kenariPost<VideoJobResponse>(deps.http, '/videos/extensions', body)
      if (result.id === undefined) throw new Error('kenari: 视频续写响应缺少任务 id')
      const seconds = args.duration ?? 6
      const estimate = await estimateByUnit(deps, args.model, 'videos', seconds)
      const billed = await billSpend(deps, exec, {
        tool: 'kenari_video_extend',
        model: args.model,
        estimateMicroIdr: estimate.microIdr,
        estimateNote: estimate.note,
        note: '按秒计费；失败不计费',
      })
      return {
        job_id: result.id,
        status: result.status ?? 'rendering',
        text: `续写任务已创建：id=${result.id}，状态 ${result.status ?? 'rendering'}。${billed}`,
      }
    },
  }))

  register(defineTool({
    name: 'kenari_video_status',
    description: 'Check a Kenari video job status (rendering / done / failed / expired). When done, the response includes a kenari-hosted download URL.',
    parameters: {
      job_id: { type: 'string', required: true, description: 'Job id from kenari_video_generate or kenari_video_extend.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          url: { type: 'string' },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const result = await kenariGet<VideoStatusResponse>(deps.http, `/videos/${encodeURIComponent(args.job_id)}`)
      const lines = [`视频任务 ${args.job_id}：${result.status ?? 'unknown'}`]
      if (result.url !== null && result.url !== undefined) lines.push(`下载地址：${result.url}`)
      if (result.status === 'failed') lines.push('生成失败：费用不扣除，可调整提示词重试。')
      if (result.status === 'expired') lines.push('成片已过期：kenari 只保留有限时间，请尽快下载。')
      return {
        status: result.status ?? 'unknown',
        ...(result.url !== null && result.url !== undefined ? { url: result.url } : {}),
        text: lines.join('\n'),
      }
    },
  }))

  register(defineTool({
    name: 'kenari_video_content',
    description: 'Download a finished Kenari video as a file. Requires the job status to be done.',
    parameters: {
      job_id: { type: 'string', required: true, description: 'Job id from kenari_video_generate or kenari_video_extend.' },
    },
    output: outputWithMedia(),
    timeoutMs: 500000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const video = await kenariGetBinary(deps.http, `/videos/${encodeURIComponent(args.job_id)}/content`, undefined, generationOptions(deps))
      const attachments = await saveFile(deps, video.bytes, `kenari-video-${args.job_id}${extensionFor(video.contentType)}`)
      return {
        text: `视频下载完成：${video.bytes.length} 字节（${video.contentType}），文件已保存。`,
        attachments,
      }
    },
  }))
}

/** POST /v1/images/* 响应（url 恒为 data URI）。 */
interface ImageResponse {
  created?: number
  data?: { url?: string; b64_json?: string; revised_prompt?: string }[]
}

/** POST /v1/music/generations 响应。 */
interface MusicResponse {
  data?: { b64_json?: string; format?: string }[]
}

/** 视频任务创建响应。 */
interface VideoJobResponse {
  id?: string
  object?: string
  status?: string
  model?: string
}

/** GET /v1/videos/{id} 响应。 */
interface VideoStatusResponse {
  id?: string
  status?: 'rendering' | 'done' | 'failed' | 'expired'
  url?: string | null
}

/** POST /v1/audio/transcriptions 响应（rebuilt 字段）。 */
interface TranscriptionResponse {
  text?: string
  task?: string
  language?: string
  duration?: number
}
