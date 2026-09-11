/**
 * 会话标题前缀：`yyyyMMddHHmmss-`（模板可自定义，可开关）。
 *
 * dsh 的标题是 log-only 的 `session/title` 事件，事件数据固定为
 * `{ title, messageSeqs, source }` —— 没有独立的前缀字段，前缀只能是 title
 * 字符串的一部分。所以本模块在服务端事件层统一改写：剥掉旧前缀、按会话创建时间
 * （本机时区）重算，再 append 一条同源事件；标题取最后一条，因此 Web、TUI、
 * headless 读到的是同一个字符串。
 *
 * 不注册 provider、不改 dsh 行：监听器挂在 bundle 插件 ctx 上（未打 scope 标签的
 * 上下文全局收得到会话事件），只在标题事件与 fork 创建时动手。自动标题
 * （provider / fallback）与手动 rename 一视同仁 —— 浏览器 fork 之后会用一次
 * `source.kind === 'user'` 的 rename 把父标题带进子会话，按 source 区分会在 fork
 * 上漏改前缀。
 *
 * @module dsh-kenari-plugin/session-title
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only：拉入 session 事件的 Context 声明合并（session/event、session/created、session/disposed）
import type {} from '@deepseek-ai/dsh-session'

/** `session/title` 的 source 形状（dsh-session-title 的 SessionTitleSource）。 */
type TitleSource =
  | { readonly kind: 'fallback' }
  | { readonly kind: 'user' }
  | {
    readonly kind: 'provider'
    readonly provider: string
    readonly model?: { readonly provider: string; readonly model: string }
  }

/** `session/title` 的持久化数据。 */
interface TitleEventData {
  /** 归一化后的标题文本。 */
  readonly title: string
  /** 该标题用到的 human 消息 seq。 */
  readonly messageSeqs: readonly number[]
  /** 标题来源。 */
  readonly source: TitleSource
}

/**
 * 本模块用到的 Session 面。`session/title` 的事件类型由 `dsh-session-title`
 * 声明合并而来；为一次 append 拉那整个依赖不划算，所以按形状读写。
 */
interface TitleSession {
  readonly id: string
  readonly header: { readonly createdAt: number; readonly parentSession?: string }
  snapshotEvents(): readonly { readonly type: string; readonly data: unknown }[]
  append(type: 'session/title', data: TitleEventData): unknown
}

/** sessions 服务的最小面：fork 子会话要读父会话的创建时间。 */
interface SessionsLike {
  get(id: string): TitleSession | undefined
}

/** 前缀的可调配置。全部用 thunk 读，改动在下一次标题事件即生效。 */
export interface SessionTitlePrefixOptions {
  /** 是否在生成标题时写入前缀。 */
  readonly enabled: () => boolean
  /** 前缀模板：token `yyyy/MM/dd/HH/mm/ss`（本机时区），其余字符原样。 */
  readonly template: () => string
  /** 前缀 + 正文的 UTF-8 总字节预算。 */
  readonly maxBytes: () => number
}

/** 模板里会被替换成时间的 token，按同一趟扫描替换。 */
const TOKEN_PATTERN = /yyyy|MM|dd|HH|mm|ss/g

/** 两位数补零。 */
function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * 按会话创建时间渲染前缀模板。
 * @param template - 前缀模板。
 * @param createdAt - 会话创建时刻（epoch 毫秒）。
 * @returns 渲染后的前缀；不含 token 的模板即模板本身。
 */
export function renderTitlePrefix(template: string, createdAt: number): string {
  const date = new Date(createdAt)
  return template.replace(TOKEN_PATTERN, (token) => {
    switch (token) {
      case 'yyyy': return String(date.getFullYear()).padStart(4, '0')
      case 'MM': return pad2(date.getMonth() + 1)
      case 'dd': return pad2(date.getDate())
      case 'HH': return pad2(date.getHours())
      case 'mm': return pad2(date.getMinutes())
      case 'ss': return pad2(date.getSeconds())
      /* v8 ignore next -- 正则已是闭集 */
      default: return token
    }
  })
}

/** UTF-8 安全截断，不切开码点。 */
function truncateUtf8(input: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input
  let used = 0
  let output = ''
  for (const character of input) {
    const bytes = Buffer.byteLength(character, 'utf8')
    if (used + bytes > maxBytes) break
    output += character
    used += bytes
  }
  return output
}

/** 判断事件里的 source 是否是 dsh 认识的三种形状之一。 */
function isTitleSource(value: unknown): value is TitleSource {
  if (value === null || typeof value !== 'object') return false
  const kind = (value as { kind?: unknown }).kind
  return kind === 'fallback' || kind === 'user' || kind === 'provider'
}

/** 读会话日志里最新一条标题事件的持久化数据。 */
function latestTitle(session: TitleSession): TitleEventData | undefined {
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'session/title') continue
    const data = event.data
    if (data === null || typeof data !== 'object') return undefined
    const candidate = data as Partial<TitleEventData>
    if (typeof candidate.title !== 'string' || !isTitleSource(candidate.source)) return undefined
    return {
      title: candidate.title,
      messageSeqs: Array.isArray(candidate.messageSeqs) ? candidate.messageSeqs as number[] : [],
      source: candidate.source,
    }
  }
  return undefined
}

/** 剥掉标题开头的一个已知前缀。候选按长度降序试，避免短前缀截断长前缀。 */
function stripKnownPrefix(title: string, candidates: readonly string[]): string {
  for (const candidate of [...candidates].sort((left, right) => right.length - left.length)) {
    if (candidate.length > 0 && title.startsWith(candidate)) return title.slice(candidate.length)
  }
  return title
}

/**
 * 写入设置页时的本地校验：schema 表达不了的约束在这里拦下。
 * @param options - 当前配置值。
 * @throws 模板为空/渲染为空/含控制字符/过长，或字节预算容不下前缀加最短正文时。
 */
export function validateSessionTitlePrefix(options: {
  enabled: boolean
  template: string
  maxBytes: number
}): void {
  if (!Number.isInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new Error('sessionTitleMaxBytes 必须是正整数')
  }
  if (/[\u0000-\u001F\u007F]/u.test(options.template)) {
    throw new Error('sessionTitlePrefix 不能包含控制字符或换行')
  }
  if (Buffer.byteLength(options.template, 'utf8') > 48) {
    throw new Error('sessionTitlePrefix 过长：模板上限 48 字节')
  }
  if (!options.enabled) return
  if (options.template.length === 0) {
    throw new Error('sessionTitlePrefix 不能为空：前缀开关开启时必须给出模板')
  }
  const rendered = renderTitlePrefix(options.template, Date.now())
  if (rendered.length === 0) {
    throw new Error('sessionTitlePrefix 渲染结果为空，无法作为标题前缀')
  }
  // 前缀之外至少留 8 字节给正文，否则标题会被前缀吃光
  if (Buffer.byteLength(rendered, 'utf8') + 8 > options.maxBytes) {
    throw new Error('sessionTitleMaxBytes 太小：前缀之外至少要给标题留 8 字节')
  }
}

/**
 * 在服务端标题事件上维护前缀。
 *
 * 每次标题事件与每次 fork 创建后：剥掉标题开头的一个已知前缀（本会话上次写入的、
 * 父会话的），开关开启时再拼上按本会话创建时间渲染的前缀，然后 append 一条同源
 * 事件。同一标题重复触发时结果与当前一致，不会追加事件。
 *
 * @param ctx - bundle 插件上下文；监听器随 fiber 卸载自动回收。
 * @param options - 前缀开关、模板与字节预算。
 */
export function installSessionTitlePrefix(ctx: Context, options: SessionTitlePrefixOptions): void {
  /** 本进程内每个会话最后一次写入的前缀，供 fork 子会话剥离父前缀。 */
  const appliedPrefix = new Map<string, string>()

  const sessionsOf = (): SessionsLike | undefined => ctx.get('sessions') as unknown as SessionsLike | undefined

  const parentCreatedAtOf = (session: TitleSession): number | undefined => {
    const parentId = session.header.parentSession
    if (parentId === undefined) return undefined
    return sessionsOf()?.get(parentId)?.header.createdAt
  }

  /**
   * 按当前标题算出应写入的标题。
   *
   * 自定义模板下旧前缀不能用固定正则识别，只能按模板 + 对应创建时间精确重放：
   * 本会话的（覆盖 resume 与模板未改的情形）、父会话的（覆盖 fork）、以及进程内
   * 记下的实际写入值（覆盖模板改过之后仍在本进程内的会话）。
   */
  const desiredTitleOf = (session: TitleSession, current: string): string => {
    const template = options.template()
    const ownPrefix = renderTitlePrefix(template, session.header.createdAt)
    const candidates: string[] = [ownPrefix]
    const knownOwn = appliedPrefix.get(session.id)
    if (knownOwn !== undefined) candidates.push(knownOwn)
    const parentId = session.header.parentSession
    if (parentId !== undefined) {
      const knownParent = appliedPrefix.get(parentId)
      if (knownParent !== undefined) candidates.push(knownParent)
      const parentCreatedAt = parentCreatedAtOf(session)
      if (parentCreatedAt !== undefined) candidates.push(renderTitlePrefix(template, parentCreatedAt))
    }
    const body = stripKnownPrefix(current, candidates)
    if (!options.enabled() || ownPrefix.length === 0) return body
    const budget = options.maxBytes() - Buffer.byteLength(ownPrefix, 'utf8')
    const truncated = truncateUtf8(body, Math.max(budget, 0))
    return truncated.length === 0 ? ownPrefix : ownPrefix + truncated
  }

  /** 重写一条已知会话的标题。调用方保证在 append 发布窗口之外。 */
  const rewrite = (session: TitleSession): void => {
    // 会话可能已从 store 卸下；此时 append 不会进持久化，直接放弃
    if (sessionsOf()?.get(session.id) !== session) return
    const latest = latestTitle(session)
    if (latest === undefined) return
    const desired = desiredTitleOf(session, latest.title)
    if (desired.length === 0 || desired === latest.title) return
    if (options.enabled()) {
      const ownPrefix = renderTitlePrefix(options.template(), session.header.createdAt)
      if (ownPrefix.length > 0) appliedPrefix.set(session.id, ownPrefix)
    }
    session.append('session/title', {
      title: desired,
      messageSeqs: [...latest.messageSeqs],
      source: latest.source,
    })
  }

  /**
   * 标题事件发生在 append 的发布窗口内，同步再 append 会被 dsh 的 reentrancy
   * 检查拒绝。defer 一拍，并在执行时重读最新标题：更新的标题已经落地时，
   * 这次改写自然退化为幂等空操作，不会覆盖它。
   */
  const scheduleRewrite = (session: TitleSession): void => {
    queueMicrotask(() => {
      try {
        rewrite(session)
      } catch (error: unknown) {
        ctx.logger.warn(`kenari: session title prefix update failed: ${String(error)}`)
      }
    })
  }

  ctx.on('session/event', (session, event) => {
    if ((event as { type: string }).type !== 'session/title') return
    scheduleRewrite(session as unknown as TitleSession)
  })

  // fork 子会话继承父标题（带父会话时间戳），按子会话创建时间重写；
  // 普通 resume 不动 —— 前缀不回溯已有会话。
  ctx.on('session/created', (session) => {
    const target = session as unknown as TitleSession
    if (target.header.parentSession === undefined) return
    scheduleRewrite(target)
  })

  ctx.on('session/disposed', (session) => {
    appliedPrefix.delete((session as unknown as TitleSession).id)
  })
}
