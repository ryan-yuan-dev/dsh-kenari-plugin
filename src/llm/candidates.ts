/**
 * 「换一个上下文 >= 当前的模型」的候选挑选。
 *
 * 挑最小够用者而不是最大者：一次失败不值得把会话切到又贵又慢的最大上下文模型。
 * 阈值取**当前**模型的窗口，所以一次会话里窗口只会持平或变大；要防止的正是「持平」那种
 * 情况下的来回横跳（两个同窗口模型互相切），所以调用方会把本 step 里失败过的路由传进来排除。
 * @module dsh-kenari-plugin/llm/candidates
 */

/** 候选挑选用到的 `ctx.llm` 最小面。注入是为了单测能替身，也避免把整个 LlmRuntime 拖进依赖。 */
export interface ModelDirectory {
  listProviders(): readonly { id: string }[]
  listModels(provider: string): Promise<readonly { id: string }[]>
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ context?: { contextWindow: number } }>
}

/** 一个候选模型及其已解析的上下文窗口。 */
export interface CandidateModel {
  provider: string
  model: string
  contextWindow: number
}

/** {@link ModelCandidates} 的依赖。 */
export interface ModelCandidatesDeps {
  llm: ModelDirectory
  /** 目录缓存时长；复用设置节的 catalogCacheTtlMs，语义同为「模型元数据可信多久」。 */
  cacheTtlMs: number
  /** 注入时钟，便于测试 TTL。 */
  now?: () => number
}

/** `pick` 的输入。 */
export interface PickInput {
  provider: string
  model: string
  contextWindow?: number
  signal?: AbortSignal
  /** 额外排除的路由（`provider/model`），用于本 step 内已经失败过的那些 —— 不再回头。 */
  exclude?: readonly string[]
}

/**
 * 找一个上下文窗口 >= 阈值的候选：先在同一 provider 内，再跨 provider。
 * 每次失败都去解析「所有 provider × 所有模型」太贵，所以按 provider 缓存目录。
 */
export class ModelCandidates {
  private readonly cache = new Map<string, { at: number; entries: CandidateModel[] }>()
  private readonly now: () => number

  constructor(private readonly deps: ModelCandidatesDeps) {
    this.now = deps.now ?? ((): number => Date.now())
  }

  /** 一个 provider 下所有「上下文窗口已知」的模型。未知窗口的模型无法证明 >= 阈值，直接排除。 */
  private async entriesOf(provider: string, signal?: AbortSignal): Promise<CandidateModel[]> {
    const at = this.now()
    const cached = this.cache.get(provider)
    if (cached !== undefined && at - cached.at < this.deps.cacheTtlMs) return cached.entries

    let entries: CandidateModel[] = []
    try {
      const models = await this.deps.llm.listModels(provider)
      const resolved = await Promise.all(models.map(async (model): Promise<CandidateModel | undefined> => {
        try {
          const info = await this.deps.llm.resolveModelInfo(provider, model.id, signal)
          const contextWindow = info.context?.contextWindow
          if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined
          return { provider, model: model.id, contextWindow }
        } catch {
          // 单个模型元数据解析失败不该毁掉整个候选列表
          return undefined
        }
      }))
      entries = resolved.filter((entry): entry is CandidateModel => entry !== undefined)
    } catch {
      // 目录整体不可用时当作「没有候选」，让调用方走到下一阶段
      entries = []
    }
    this.cache.set(provider, { at, entries })
    return entries
  }

  /** 找最小够用的候选；找不到返回 undefined。 */
  async pick(input: PickInput): Promise<CandidateModel | undefined> {
    const threshold = input.contextWindow ?? 0
    const excluded = new Set(input.exclude ?? [])

    const local = smallestAtLeast(await this.entriesOf(input.provider, input.signal), input.model, threshold, excluded)
    if (local !== undefined) return local

    for (const entry of this.deps.llm.listProviders()) {
      if (entry.id === input.provider) continue
      const found = smallestAtLeast(await this.entriesOf(entry.id, input.signal), undefined, threshold, excluded)
      if (found !== undefined) return found
    }
    return undefined
  }
}

/**
 * 排除 `exclude` 这个模型、以及 `tried` 里的路由，取 `contextWindow >= threshold` 的最小者。
 * 同窗口时按 model id 字典序取小 —— 确定性很重要，否则同一份配置在不同机器上会换到不同模型。
 */
function smallestAtLeast(
  entries: readonly CandidateModel[],
  exclude: string | undefined,
  threshold: number,
  tried: ReadonlySet<string>,
): CandidateModel | undefined {
  let best: CandidateModel | undefined
  for (const entry of entries) {
    if (exclude !== undefined && entry.model === exclude) continue
    if (tried.has(`${entry.provider}/${entry.model}`)) continue
    if (entry.contextWindow < threshold) continue
    if (best === undefined
      || entry.contextWindow < best.contextWindow
      || (entry.contextWindow === best.contextWindow && entry.model < best.model)) {
      best = entry
    }
  }
  return best
}
