# dsh web 能力缝（ctx.web）

来源：`@deepseek-ai/dsh-web`、`@deepseek-ai/dsh-tool-web`、`@deepseek-ai/dsh-web-search-exa`、`@deepseek-ai/dsh-web-search-deepseek` 的 `.d.ts`，以及 `@deepseek-ai/dsh-base` 的 `cordis.patch.yml`。

## 分工

一个能力，两个操作（search 和 fetch），一个 `ctx.web` 服务，拆在多个包里：

- **Service Definition**：`@deepseek-ai/dsh-web` —— 拥有 `ctx.web` 和 provider 注册表
- **Service Provider**：`dsh-web-search-exa`、`dsh-web-search-perplexity`、`dsh-web-search-deepseek`、`dsh-web-fetch-http`
- **Consumer**：`@deepseek-ai/dsh-tool-web` —— 拥有 `web_search` / `web_fetch` 的工具名、schema、参数校验、结果上限、提示词、展示

**Provider 注册的是能力，不是工具。** 面向模型的名称、schema、提示词、展示都只存在于 `dsh-tool-web` 这一个 consumer 里。所以换搜索 provider 不改变模型如何提问。

`dsh-tool-web` 的模块文档原文：

> This package owns schemas, validation, prompt guidance, limits, and presentation, never concrete providers. Enablement controls tool registration; an enabled tool remains visible when its provider is unavailable and fails with a structured error at execution time.

## provider 接口

```ts
interface WebSearchProvider {
  readonly id: string
  /** Cheap local usability check; must not make network calls. */
  available(): boolean
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>
}

interface WebFetchProvider {
  readonly id: string
  available(): boolean
  fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult>
}
```

`available()` 的契约是硬约束：**廉价本地检查，禁止发网络请求**（凭据是否存在、配置是否可解析）。它是选择时的输入，不是健康系统。真正的失败只能在 `search()` / `fetch()` 调用时发现，以结构化 `WebError` 抛出。

## 请求与结果词汇

```ts
interface WebSearchRequest {
  readonly query: string
  /** 上限；seam 在返回时截断。省略 = 无上限。dsh-tool-web 总会设置。 */
  readonly maxResults?: number
}

interface WebSearchResult {
  /** 可选的 provider 生成答案/摘要。Exa 与 DeepSeek 不返回；Perplexity 返回。 */
  readonly content?: string
  readonly sources: readonly WebSearchSource[]
  /** seam 为遵守 maxResults 而丢弃 source 时为 true。 */
  readonly truncated: boolean
}

interface WebSearchSource {
  readonly url: string          // 必有
  readonly title?: string
  readonly snippet?: string
  readonly publishedAt?: string // ISO-8601
}

interface WebFetchRequest { readonly url: string }

interface WebFetchResult {
  readonly url: string          // 允许重定向后的最终 URL
  readonly statusCode: number
  readonly body: WebFetchBody
  readonly truncated: boolean
}

type WebFetchBody =
  | { readonly kind: 'html'; readonly content: string }
  | { readonly kind: 'text'; readonly content: string }
```

要点：

- `WebSearchSource` 只有 `url` 必有；`title` / `snippet` / `publishedAt` 可选，因为不是每个 provider 都返回。**不要为了填满字段而编造**（Perplexity 的引用可能只有 URL）
- `dsh-tool-web` 展示时用 `title ?? hostname(url)`
- `WebFetchResult` 的非 2xx 是**结果不是错误**，状态码是资源状态的一部分。`WebError` 只用于"无法安全获取或表示资源"
- `WebFetchBody` 是 `dsh-web` 拥有的**封闭**判别联合。provider 负责解码 kind，consumer 负责渲染。新增 kind 需要跨已知包协调，不是插件扩展点

## 选择语义（调用时解析，与注册顺序无关）

```
配置了 id 且已注册且 available()  → 用该 provider
配置了 id 但未注册               → WEB_PROVIDER_CONFIGURED_MISSING
配置了 id 但不可用               → WEB_PROVIDER_CONFIGURED_UNAVAILABLE
未配 id + 恰好一个可用           → 自动选中
未配 id + 多个可用               → WEB_PROVIDER_AMBIGUOUS
未配 id + 无可用                 → WEB_PROVIDER_UNAVAILABLE
```

**没有回退链，也不是先到先得。** 多个可用 provider 且未配 id 会报 `WEB_PROVIDER_AMBIGUOUS`。

`ctx.web` 的 config：

```ts
interface WebServiceConfig {
  readonly searchProvider?: string
  readonly fetchProvider?: string
}
```

环境变量 `$DSH_WEB_SEARCH_PROVIDER` / `$DSH_WEB_FETCH_PROVIDER` 等价于这两个字段，**不是隐藏的优先级链**。

注册接口：

```ts
registerSearchProvider(provider: WebSearchProvider): () => void
registerFetchProvider(provider: WebFetchProvider): () => void
```

id 重复会抛 `WEB_DUPLICATE_PROVIDER`。返回 disposer，随调用 fiber 释放。

## dsh-base 的默认 web 配置（关键）

`@deepseek-ai/dsh-base@0.1.5-rc.1` 的 `cordis.patch.yml` 原文：

```yaml
    - id: web
      name: '@deepseek-ai/dsh-web'
      config:
        searchProvider: deepseek-official
        fetchProvider: http

    - id: web-search-deepseek
      name: '@deepseek-ai/dsh-web-search-deepseek'
      config:
        apiKeyEnv: DEEPSEEK_API_KEY

    - id: web-fetch-http
      name: '@deepseek-ai/dsh-web-fetch-http'

    - id: tool-web
      name: '@deepseek-ai/dsh-tool-web'
      config:
        fetch: true
        searchTimeoutMs: 60000
```

结论：

1. 默认只注册一个 search provider，id 是 `deepseek-official`，且已显式钉住 → 不会 AMBIGUOUS
2. **`fetch: true` 且 `fetchProvider: http` → `web_fetch` 默认可用**，由本地匿名 HTTP provider 提供
3. 官方搜索依赖 `DEEPSEEK_API_KEY`，无 key 时 `available()` 为假
4. `web-fetch-http` 行默认挂载，无需额外安装

### 与 `0.0.1-rc.1` 的差异

| 配置项 | `0.0.1-rc.1` | `0.1.5-rc.1` |
|---|---|---|
| `web.fetchProvider` | 不存在 | `http` |
| `web-fetch-http` 行 | 不存在 | 默认挂载 |
| `tool-web.fetch` | `false` | `true` |
| `tool-web` 行注释 | 说明 fetch 保持禁用 | 已移除该说明 |

旧版注释原文（说明当时的取舍）：

> Fetch stays disabled and no fetch provider is mounted: that provider defers SSRF protection and the model would choose the request target.

新版已移除该取舍，改为默认启用 fetch 并挂载 `http` provider（其 SSRF 防护见下文）。

### 组合后的 `tool-web` 状态

在 `web` profile 下，`tool-web` 行由 `@deepseek-ai/dsh-web-app` 追加 `disabled: true`：

```yaml
# == @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    fetch: true
    searchTimeoutMs: 60000
  disabled: true
```

即**在 web profile 下 `web_search` / `web_fetch` 工具整体被禁用**，provider 配置虽就绪但工具不注册。

要接入自己的 provider，必须用 patch 覆盖 `- id: web` 那一行（整行替换，`searchProvider` 与 `fetchProvider` 必须一起写）。

## dsh-tool-web 的 config

```ts
interface Config {
  search?: boolean                    // 默认 true
  fetch?: boolean                     // 默认 true（但 dsh-base 覆盖为 false）
  searchMaxResults?: number           // 默认 8（WEB_SEARCH_MAX_RESULTS）
  fetchTimeoutMs?: number             // 默认 30000
  searchTimeoutMs?: number            // 默认 30000
  fetchMaxOutputChars?: number        // 默认 200000
}
```

`maxResults` 是 **consumer 拥有**的上限，不是 provider 或模型的。模型只提问，产品决定返回多少上下文。

`search` 参数实际是 `queries` 数组，consumer 扇出成多个 seam 请求，每个请求带一个 query。单元素数组就是一次搜索。

## provider 实现参考

**Exa**（`dsh-web-search-exa`）：`POST https://api.exa.ai/search`，把第一个非空 highlight 映射为 `snippet`，`publishedDate` → `publishedAt`，**丢弃没有 snippet 的条目**（seam 没有别的字段可派生 snippet，编造就是撒谎），`content` 省略。

```ts
const EXA_PROVIDER_ID = 'exa'
class ExaSearchProvider implements WebSearchProvider {
  readonly id = 'exa'
  available(): boolean          // apiKey 为空/缺失 → false
  search(request, signal?): Promise<WebSearchResult>
}
```

**DeepSeek**（`dsh-web-search-deepseek`）：走 Anthropic 兼容的 Messages API 加原生 `web_search_20250305` 服务工具。id 是 `deepseek-official`。默认 base `https://api.deepseek.com/anthropic/v1`（`/messages` 追加）。**复用 `DEEPSEEK_API_KEY` 但不复用 `DEEPSEEK_BASE_URL`**，因为搜索和 chat-completions 用不同 base。每次搜索消耗一次模型轮次。缺少结构化结果块时报错，不做散文式兜底抓取。

这些 provider 类可以从包里 import 出来直接实例化复用 —— 但**如果它的 id 与已注册的冲突，绝不能调用 `register*Provider`**，只持有实例直接调方法。

## 各 provider 包的导出与 id

| 包 | 导出的类 | 常量 | id | `available()` 语义 |
|---|---|---|---|---|
| `dsh-web-search-exa` | `ExaSearchProvider` | `EXA_PROVIDER_ID` | `exa` | apiKey 为空/缺失 → false |
| `dsh-web-search-deepseek` | `DeepSeekSearchProvider` | `DEEPSEEK_PROVIDER_ID` | `deepseek-official` | 依赖凭据 |
| `dsh-web-fetch-http` | `HttpFetchProvider` | `LOCAL_FETCH_PROVIDER_ID` | `http` | **恒为 true**（匿名公开抓取，无凭据可查） |

`HttpFetchProvider` 构造签名（`0.1.5-rc.1`）：

```ts
interface HttpFetchLimits {
  maxResponseBytes: number
  maxBodyChars: number
  timeoutMs: number
  maxRedirects: number
  userAgent: string
}
constructor(limits: HttpFetchLimits)
```

**注意字段数变化**：`0.0.1-rc.5` 有 6 个字段（多一个 `maxUrlLength`），`0.1.5-rc.1` 是 5 个，`maxUrlLength` 已移除。

`dsh-web-fetch-http` 的 `Config`（`apply` 用它填充 `HttpFetchLimits` 的默认值）：`maxResponseBytes`、`maxBodyChars`、`timeoutMs`、`maxRedirects`、`userAgent`。默认 `User-Agent` 由 `DEFAULT_USER_AGENT` 导出，是明确的产物标识而非浏览器伪装。

`DeepSeekSearchProvider` 的构造参数（`DeepSeekSearchProviderOptions`）：`apiKey`、`baseURL`、`model`、`apiVersion`、`maxTokens`、`maxUses`。默认 base `https://api.deepseek.com/anthropic/v1`，默认 model `deepseek-v4-flash`，默认 `apiVersion` `2023-06-01`，默认 `maxTokens` 4096，默认 `maxUses` 5。

`ExaSearchProvider` 的构造参数（`ExaSearchProviderOptions`）：`apiKey`、`baseURL`、`searchType`（`auto`/`keyword`/`neural`）、`numResults?`、`highlightsPerResult`。默认 base `https://api.exa.ai`。

## 本地 fetch provider 的安全边界（rc 版本差异）

两处描述不一致，**说明 rc 线之间行为有变化，引用时必须以实际使用的包版本为准**。

**`0.0.1-rc.5`** 的模块文档明确声明**不实现**私网与 SSRF 防护：

> Private-network and SSRF protection is not implemented; do not enable this provider where it can reach sensitive internal targets.

**`0.1.5-rc.1`** 的模块文档声明**已实现**，且新增 `network.d.ts` 模块（`PublicAddress` 类型）：

> Safe HTTP(S) retrieval for `ctx.web`: validates and pins public IP destinations, follows only same-origin redirects, enforces time and size limits, classifies and decodes text, and leaves presentation to `@deepseek-ai/dsh-tool-web`. Requests carry no browser cookies or ambient credentials.

即新版已实现"校验并固定公网 IP 目的地"，与 `dsh-base` 注释及 `reference/subsystems/web` 的描述一致。

`dsh-web-fetch-http` 实现的限制：校验并固定公网 IP 目的地、只跟随同源重定向、强制时间与大小上限、分类并解码文本、不做展示。请求不携带浏览器 cookie 或环境凭据。

## fetch 网络策略

已发布的 Cordis / Code / Standard 预设在所有沙箱与审批模式下都暴露 `web_fetch`，无需逐次确认。文件沙箱预设不管理 web 网络访问。

HTTP provider 对每个实际请求解析地址，拒绝非公网答案（含通过活跃 DNS64 前缀到达的私有 IPv4），固定已验证地址集，并对每个同源重定向重复执行。**跨源重定向需要新的工具调用与全新的公网地址校验。** 这些检查防止 SSRF 访问非公网目标，但不阻止模型向公网 URL 发数据。

本地 fetch 后端只接受 HTTP(S)、拒绝凭据、每个主机名解析一次、拒绝任何含非公网 IPv4/IPv6 目的地的答案集、把请求连接固定在已验证地址上、对每个同源重定向跳重复检查、限制重定向数、字节数、字符数与时间，并解码正文。
