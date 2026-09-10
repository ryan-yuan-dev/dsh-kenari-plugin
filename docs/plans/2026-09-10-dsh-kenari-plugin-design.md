# dsh-kenari-plugin 设计文档

日期：2026-09-10
状态：实施中 —— 第 0 期已完成并验证（2026-09-10，详见 handoff 接力主文档）
版本基线：dsh `0.1.5-rc.1`（源码 tag `dsh-v0.1.5-rc.1`）

> 机制勘误（2026-09-10 源码核对后，详见 `docs/knowledge-base/dsh/dsh-source-verified.md`）：
> patch 覆盖是**逐字段**的——`config` 作为单键整体替换，`disabled` 等是独立键；patch 行写 `name` 必须与目标行现有 name 一致否则整个 patch 被跳过。本文 3.3 节的"tool-web 覆盖需整行重写 config"按此修正为只需 `disabled: false`。

## 0. 环境前置条件

实施前环境须满足以下条件，均已于 2026-09-10 就绪（详见 `docs/handoff/002-*`）：

| 条件 | 状态 | 说明 |
|---|---|---|
| dsh `0.1.5-rc.1` 全局安装 | 已就绪 | `/opt/homebrew/bin/dsh`，取代原 npx 缓存方式 |
| pnpm 可用 | 已就绪 | `12.3.4`；`dsh plugin` 转发给它，缺失则无法安装插件 |
| 源码 submodule | 已就绪 | `vendor/deepseek-harness`，锁定 tag `dsh-v0.1.5-rc.1` |
| 版本对齐 | 已校验 | 实装版本 == submodule tag == `apps/cli/package.json` |

安装任何 dsh 子包时**必须显式指定版本**，因为 npm `latest` 标签未必与主版本对齐。

## 1. 目标

做一个 dsh bundle，装上后：

- Kenari 的模型可以成为 dsh 的会话模型（三条协议线任选）
- Kenari 的 REST 能力成为 agent 工具（OCR、图像、音视频、embeddings 等）
- Kenari 成为 web search / fetch 的优先 provider，失败时回落到 dsh 默认 provider

**纪律约束：不修改 dsh 的任何代码或包。** 所有能力通过 Cordis 插件行、patch 层、以及 dsh 公开的 seam 注册接口实现。

## 2. 事实基础

以下均为核实过的原文事实，不是推测。

### 2.1 dsh 插件模型

插件是一个 TypeScript 模块，导出 `name`、可选的 `inject`、以及 `apply(ctx, config)`。框架在加载时调用 `apply` 并传入上下文对象。

```ts
export const name = 'my-plugin'
export const inject = ['tools']
export function apply(ctx: Context, config: Config) {
  ctx.tools.register(defineTool({ /* ... */ }))
}
```

通过 `ctx` 注册的一切（事件监听、工具、定时器）都是 effect，插件卸载时自动回收，不需要手动 `removeListener`。

工具用 `defineTool` 定义，`parameters` 驱动参数推断与校验，`execute` 返回 `output.schema` 声明的规范值，`output.render` 把该值转成面向模型的内容。

配置用 Schemastery schema 声明，在插件加载时校验，非法配置直接加载失败：

```ts
export interface Config { apiKeyEnv: string; timeoutMs: number }
export const Config: Schema<Config> = Schema.object({
  apiKeyEnv: Schema.string().default('KENARI_API_KEY'),
  timeoutMs: Schema.number().default(30000),
})
```

### 2.2 打包与安装

bundle 是一个 npm 包，`package.json` 里声明 `dsh.bundle.patch` 指向 patch 文件：

```json
{
  "name": "dsh-kenari-plugin",
  "type": "module",
  "main": "lib/index.js",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

安装：`dsh plugin --profile <name> add ./dsh-kenari-plugin`
验证层生效：`dsh --profile <name> --dump-config`
卸载：`dsh plugin --profile <name> remove dsh-kenari-plugin`

patch 是 YAML 数组，行按 id 定位，**替换整行 config 而不是合并**。层序为：各 bundle patch 按声明顺序 → profile 自己的 `cordis.patch.yml` → 家目录的 → `--patch` 覆盖层。`dsh-base` 的注释原文：

> Later bundle patches and the user's profile cordis.patch.yml address these rows by id, with the last write winning per row.

### 2.3 dsh-base 的默认 web 配置

从 `@deepseek-ai/dsh-base@0.1.5-rc.1` 的 `cordis.patch.yml` 原文：

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

四点关键：

1. 默认只注册一个 search provider（id `deepseek-official`），且已显式钉住，所以不会出现 `WEB_PROVIDER_AMBIGUOUS`
2. **`fetch: true`，且 `fetchProvider: http`** —— web_fetch 默认可用，由本地匿名 HTTP provider 提供
3. 官方搜索依赖 `DEEPSEEK_API_KEY`，没配 key 时 `available()` 为假
4. 在 `web` profile 下，`tool-web` 行被 `@deepseek-ai/dsh-web-app` 追加 `disabled: true`，**web 工具整体不注册**

> 版本差异提示：`0.0.1-rc.1` 时 `fetch: false` 且无 fetch provider（"开启 fetch 是净新增能力"）。`0.1.5-rc.1` 已改为默认启用。设计据此调整，见 3.5 节。

### 2.4 web seam 的选择语义

`@deepseek-ai/dsh-web` 的 `WebService` 选择规则，调用时解析，与注册顺序无关：

```
配置了 id 且已注册可用        → 用该 provider
配置了 id 但未注册            → WEB_PROVIDER_CONFIGURED_MISSING
配置了 id 但不可用            → WEB_PROVIDER_CONFIGURED_UNAVAILABLE
未配 id + 恰好一个可用        → 自动选中
未配 id + 多个可用            → WEB_PROVIDER_AMBIGUOUS
未配 id + 无可用              → WEB_PROVIDER_UNAVAILABLE
```

**没有回退链**，所以"不可用时回退"必须由我们自己组合实现。

provider 接口：

```ts
interface WebSearchProvider {
  readonly id: string
  available(): boolean        // 廉价本地检查，禁止发网络请求
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>
}

interface WebFetchProvider {
  readonly id: string
  available(): boolean
  fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult>
}
```

请求与结果词汇：

```
WebSearchRequest  { query, maxResults? }
WebSearchResult   { content?, sources: WebSearchSource[], truncated }
WebSearchSource   { url, title?, snippet?, publishedAt? }
WebFetchRequest   { url }
WebFetchResult    { url, statusCode, body: {kind:'html'|'text', content}, truncated }
```

`available()` 的契约写死了"must not make network calls"，所以真正的失败只能在调用时发现。

### 2.5 可扩展的 seam

`ctx.web`、`ctx.llm`、`ctx.settings`、`ctx.credentials` 都是 seam（可替换），注册 provider / adapter / 设置节合法。`ctx.tools` 是 core，但 `register` 是公开扩展点。

`LlmAdapter` 提供 `providerInfo()`、`providerRetryPolicy()`、`listModels()`、`resolveModelInfo()`、`stream()`，其中 `listModels()` 可以动态 advertise 模型目录 —— 目录同步不需要改 dsh。

### 2.6 凭据 seam

`CredentialRef` 是一个 POSIX 风格的环境变量名。`resolve(ref)` 返回值和来源层，`describe(ref)` 只返回 configured / source / writable，**永不暴露值**。消费者每次操作重新解析，这是热轮换机制。本地 provider 的来源层有 `env`、`file`、`project-env`、`user-env`。

注意副作用：由环境变量提供的引用 `writable: false`，设置界面必须渲染为只读。

### 2.7 Kenari 接口

base `https://kenari.id`，key 前缀 `kn-`，支持 `Authorization: Bearer` 或 `x-api-key`（同时存在时 Authorization 优先）。

| 能力 | 端点 | base |
|---|---|---|
| [OI] 对话 | `POST /v1/chat/completions` | `https://kenari.id/v1` |
| Anthropic 对话 | `POST /v1/messages` | `https://kenari.id`（不带 /v1） |
| Responses | `POST /v1/responses` | `https://kenari.id/v1` |
| token 计数 | `POST /v1/messages/count_tokens` | `https://kenari.id` |
| 模型目录 | `GET /v1/models`（公开，无需 key） | `https://kenari.id/v1` |
| web 搜索 | `POST /v1/web/search` | `https://kenari.id/v1` |
| web 抓取 | `POST /v1/web/fetch` | `https://kenari.id/v1` |
| X 搜索 | `POST /v1/x/search` | `https://kenari.id/v1` |
| OCR | `POST /v1/ocr` | `https://kenari.id/v1` |
| 图像生成 / 编辑 | `POST /v1/images/generations`、`/v1/images/edits` | `https://kenari.id/v1` |
| 嵌入 / 重排 / 审核 | `POST /v1/embeddings`、`/v1/rerank`、`/v1/moderations` | `https://kenari.id/v1` |
| 语音 / 音乐 | `POST /v1/audio/speech`、`/v1/audio/transcriptions`、`/v1/music/generations` | `https://kenari.id/v1` |
| 视频 | `POST /v1/videos/generations`、`/v1/videos/extensions`、`GET /v1/videos/{id}`、`GET /v1/videos/{id}/content` | `https://kenari.id/v1` |
| 额度 | `GET /v1/account/quota` | `https://kenari.id/v1` |
| MCP | `https://kenari.id/mcp`（Streamable HTTP） | — |

`GET /v1/models` 的 Model 字段（用于目录同步）：

`id`、`object`、`owned_by`、`sunset_at`（epoch 秒，可空）、`context_length`、`modalities{input[],output[]}`、`reasoning`、`tool_call`、`reasoning_options[]`、`pricing{input,output,cache_read,cache_write,free,varies,currency:'IDR',unit:'micro_idr_per_1m_tokens'}`、`pricing_lines[{endpoint,billable,unit,variant,micro_idr}]`、`endpoints[]`、`modality`、`beta`。

web 搜索响应：`{results:[{title,url,content}], id, cost_micro_idr}`，`max_results` 范围 1–10，默认 5。
web 抓取响应：`{title, content, links:[], id, cost_micro_idr}`。

免费模型：模型 id 加 `:free` 后缀，或 `pricing.free` 为真。`step-3-7-flash:free` 在 Rp 0 账户下可用。

分享页 key：balance / usage / quota 会被拒绝（403），spending 类工具仍可用。

## 3. 架构

### 3.1 决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 范围 | 模型接入 + 附加服务工具，两者都做 | 用户明确要求功能强大 |
| 交付形态 | dsh bundle | 可分发、可一键安装 |
| key 输入 | 复用 dsh 原生 provider 表单 + 凭据引用 | 用户最熟悉，凭据存储交给 dsh |
| search 链 | Kenari 优先 → 官方 deepseek-official 兜底 | 用户选定 |
| fetch | 开启，Kenari 优先 → 本地 HTTP 兜底 | 用户选定；`0.1.5-rc.1` 已默认启用，本项为替换默认 provider |
| MCP | 不作为主路径，文档提供为可选方案 | 见 3.4 |

### 3.2 包结构

```
dsh-kenari-plugin/
├── package.json           # dsh.bundle → ./cordis.patch.yml ; dsh.client → ./client
├── cordis.patch.yml       # 插件行 + web / tool-web 覆盖行
├── README.md
├── src/
│   ├── index.ts           # 主插件：Config schema + 装配
│   ├── http.ts            # Kenari HTTP 客户端
│   ├── errors.ts          # 状态码与错误信封映射
│   ├── catalog.ts         # /v1/models 同步与缓存
│   ├── web/
│   │   ├── search.ts      # KenariSearchProvider
│   │   ├── fetch.ts       # KenariFetchProvider
│   │   └── fallback.ts    # KenariFirstSearch / KenariFirstFetch
│   ├── tools/
│   │   ├── docs.ts        # kenari_search_docs / kenari_list_models
│   │   ├── account.ts     # balance / usage / quota
│   │   ├── x-search.ts    # X 搜索与过滤
│   │   ├── documents.ts   # OCR
│   │   ├── media.ts       # 图像 / 语音 / 音乐 / 视频
│   │   └── data.ts        # embeddings / rerank / moderations
│   └── client/
│       └── index.ts       # 设置卡片（Host + Client 两半）
└── test/
```

### 3.3 patch 层设计

```yaml
- insert:
    # 主插件：注册 web provider、工具、设置节
    - id: kenari
      name: 'dsh-kenari-plugin'

  # 覆盖 web seam：钉住我们的组合 provider
  - id: web
    config:
      searchProvider: kenari-fallback
      fetchProvider: kenari-fallback

  # 覆盖 tool-web：重新启用被 dsh-web-app 禁用的 web 工具
  - id: tool-web
    config:
      search: true
      fetch: true
      searchTimeoutMs: 60000
      fetchTimeoutMs: 30000
    disabled: false
```

三点注意：

1. `- id: web` 的 config 是整行替换，`searchProvider` 和 `fetchProvider` 必须一起写
2. `dsh-base` 已注册的 `deepseek-official` 与 `http` 保留不动，作为兜底被我们的组合 provider 内部调用
3. **`tool-web` 行在 `web` profile 下被 `dsh-web-app` 追加了 `disabled: true`，必须显式写 `disabled: false` 才能让 web 工具注册。** 这是 patch 层覆盖，不改 dsh 任何包，符合合规边界

`web-fetch-http` 无需我们插入 —— `dsh-base@0.1.5-rc.1` 已默认挂载该行。

### 3.4 关于 MCP 的取舍

Kenari 的 `/mcp` 是 Streamable HTTP，`@deepseek-ai/dsh-mcp-client` 支持该传输，一行配置就能拿到 8 个工具，工具名形如 `mcp__kenari__kenari_balance`。

但它的 8 个工具里有 7 个（list_models、balance、usage、quota、web_search、web_fetch、x_search）我们都要自建，只有 `search_docs` 是 MCP 独有的 —— 而文档搜索可以用 `/llms-full.txt` 或 `/docs.md` 本地实现。

如果同时启用，同一个能力会出现两个工具名，模型可能挑错。所以主路径全部自建，理由：

- 工具名干净，无 `mcp__` 前缀
- 能加计费可视、余额预检、402 引导 —— 裸 MCP 工具给不了
- 少一个运行时依赖
- 卸载更干净

MCP 作为**可选的零代码方案**写进 README，供只想快速试用、不想装插件的用户使用。

### 3.5 fallback provider

```ts
class KenariFirstSearch implements WebSearchProvider {
  readonly id = 'kenari-fallback'

  available() {
    // 纯本地判断：Kenari key 是否存在，或兜底 provider 是否可用
    return this.kenari.available() || this.official.available()
  }

  async search(req: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    if (this.kenari.available()) {
      try {
        return await this.kenari.search(req, signal)
      } catch (err) {
        this.logFallback('search', err)
      }
    }
    return this.official.search(req, signal)
  }
}
```

fetch 侧同理：Kenari → `HttpFetchProvider`（id `http`）。

**注意语义变化。** 在 `0.1.5-rc.1` 下 dsh 默认已启用 fetch（`fetchProvider: http`），所以这里的"兜底"不是"从无到有"，而是**把默认的本地匿名抓取换成 Kenari 优先、失败再回落到本地**。若用户不需要此替换，可用 `fallbackEnabled: false` 退回。

**兜底 provider 的实例来源。** seam 没有 `getProvider(id)` 公开接口，无法从注册表按 id 取用。所以我们在自己的 `apply` 里直接实例化：

```ts
import { DeepSeekSearchProvider } from '@deepseek-ai/dsh-web-search-deepseek'
import { HttpFetchProvider } from '@deepseek-ai/dsh-web-fetch-http'
```

**关键约束：这些实例绝不能调用 `registerSearchProvider` / `registerFetchProvider`。** `deepseek-official` 与 `http` 的 id 与 `dsh-base` 已注册的冲突，注册会抛 `WEB_DUPLICATE_PROVIDER`。我们只持有它们、直接调方法。

已验证三个 provider 类均可 import 实例化：`DeepSeekSearchProvider`(id `deepseek-official`)、`HttpFetchProvider`(id `http`，`available()` 恒为真)、`ExaSearchProvider`(id `exa`，**该包未随 dsh 安装，需显式添加**)。

### 3.6 模型接入

dsh 的 `llm-pi-ai` 行默认休眠（零路由），由 Settings → Models 页写入 `llm-pi-ai:` 配置节激活。它的三种协议 `openai-completions` / `openai-responses` / `anthropic-messages` 覆盖 Kenari 三条线，所以**模型接入零代码可做到**。

推荐流程：用户在 Settings → Models 新建自定义 provider，凭据名填 `KENARI_API_KEY`，base URL 与协议按线选择。我们的插件用同一个凭据引用读 key，两边共用一个引用。

三条线的 base URL 必须区分：

- `openai-completions` → `https://kenari.id/v1`
- `openai-responses` → `https://kenari.id/v1`
- `anthropic-messages` → `https://kenari.id`（**不带 /v1**，客户端自己追加）

兼容预设：`supportsDeveloperRole: false`、`maxTokensField: max_tokens`。这两个是 Kenari 网关的常见坑，写进 README 与设置卡片提示。

## 4. 分期实施

> 状态标记：✅ 已完成并验证 · 🚧 进行中 · ⬜ 未开始

### ✅ 第 0 期｜骨架与配置层（2026-09-10 完成，验证通过）

- [x] `package.json`：`type: module`、`main: lib/index.js`、`dsh.bundle.patch`；peer 依赖定版：dsh 子包精确 `0.1.5-rc.1`、`@deepseek-ai/cordis ^4.0.2`、`@deepseek-ai/schemastery ^3.18.1-rc.1`
- [x] `tsconfig.json`：NodeNext、strict、`tsc` 编译到 `lib/`
- [x] `cordis.patch.yml`：insert `kenari` 行 + `web` config 覆盖 + `tool-web` `disabled: false`
- [x] `src/index.ts`：Config schema（7 字段全部带默认值）+ 空 apply
- [x] 验证：`dsh --profile web --dump-config` 出现 `# == dsh-kenari-plugin` 层
- [x] 验证：`dsh --profile web` 启动无报错

### ⬜ 第 1 期｜web fallback（核心价值）

- `src/web/search.ts`：`POST /v1/web/search`，`max_results = min(req.maxResults ?? 5, 10)`，`results[]` → `WebSearchSource { url, title, snippet: content }`，`content` 留空
- `src/web/fetch.ts`：`POST /v1/web/fetch` → `WebFetchResult { url, statusCode: 200, body: {kind:'text', content}, truncated }`，`links[]` 附在正文尾部
- `src/web/fallback.ts`：组合 provider，含回退日志（方向、失败原因、耗时）
- 兜底实例：`DeepSeekSearchProvider` 与 `HttpFetchProvider`，**只实例化不注册**

**验证**：

1. patch 生效后 `tool-web` 的 `disabled` 为 `false`，`web_search` / `web_fetch` 工具注册可见
2. 不配 `DEEPSEEK_API_KEY` → `web_search` 走 Kenari
3. 配了 `DEEPSEEK_API_KEY` → 仍走 Kenari（Kenari 优先）
4. 把 Kenari key 设为无效 → 观察回退到官方，日志有记录
5. `fallbackEnabled: false` → 退回 dsh 默认（`deepseek-official` + `http`）

### ⬜ 第 2 期｜REST 工具

全部用 `defineTool` + `ctx.tools.register`，`inject: ['tools']`。

- `docs.ts`：`kenari_search_docs`（本地检索 `/llms-full.txt`，无需 key）、`kenari_list_models`
- `account.ts`：`kenari_balance`、`kenari_usage`、`kenari_quota`；403 时识别为分享页 key 并给出说明
- `x-search.ts`：`kenari_x_search` 与全部过滤参数 —— `allowed_x_handles` / `excluded_x_handles`（≤20 个，不含 @，两者互斥）、`from_date` / `to_date`（YYYY-MM-DD）、`enable_image_understanding` / `enable_video_understanding`
- `documents.ts`：`kenari_ocr`（`engine: ocr`，`reuse_id` 会话内复用避免重复计费）
- `media.ts`：图像生成 / 编辑、语音合成 / 转写、音乐生成、视频生成 / 续写 / 状态 / 下载
- `data.ts`：embeddings、rerank、moderations
- `kenari_count_tokens`

每个工具统一带：超时、重试、错误映射、成本回显（`cost_micro_idr`）。

**验证**：逐个工具在 Web UI 调用成功；`reuse_id` 第二次调用不重复计费；`allowed_x_handles` 与 `excluded_x_handles` 同传时报参数错误。

### ⬜ 第 3 期｜目录、计费与上下文

- `catalog.ts`：`GET /v1/models` 同步 + TTL 缓存，映射：
  - `id` → dsh 模型 id
  - `modalities.input` 含 image → `input: [text, image]`
  - `reasoning_options` → `reasoningEfforts`
  - `context_length` → 上下文窗口
  - `tool_call` → 是否允许工具调用
  - `sunset_at` 非空 → 弃用告警
  - `beta` → 实验性标注
  - `pricing` / `pricing_lines` → 可读 IDR 价格（`micro_idr_per_1m_tokens` 换算）
  - `:free` 或 `pricing.free` → 免费分组
  - `endpoints` → 筛选可用于会话的模型
- 计费：单次实际扣费回显、会话累计、余额低阈值告警、402 `insufficient_balance` 给可执行建议、预算封顶
- 上下文：`count_tokens` 接入 token 计量；`cached_tokens` 命中率
- 新账户默认 `step-3-7-flash:free`

**验证**：Rp 0 账户下默认选中免费模型；余额告警触发；402 时提示切免费模型或充值。

### ⬜ 第 4 期｜设置界面

Host 半边用 `ctx.settings.installSection(ctx, NS, Config, config, { validate })` 注册 namespace，Client 半边在 `src/client/` 导出 `./client`，`package.json` 声明 `dsh.client`。

卡片：余额、模型目录与价格表、计费统计、key 状态、连通性自检。

key 状态复用 `describe()` 的 configured / source / writable。**环境变量来源的引用必须渲染为只读**，否则写操作会假装成功但解析仍返回旧值。

**验证**：设置页出现卡片；key 只显示状态不显示明文；env 提供的 key 显示只读。

### ⬜ 第 5 期｜专属 LlmAdapter（可选增强）

继承 `LlmAdapter` 实现 `stream()`，用 `ctx.llm.registerAdapter(['kenari'], adapter)` 注册。

只补通用适配器丢掉的字段：`file-parser` 注入、`web_search_options`、`pricing_lines`、`reasoning_options`、`annotations`、`:free` 后缀处理。

`StreamChunk` 映射：文本增量、reasoning → 思考通道、tool_calls → 工具事件、usage、`finish_reason` / `stop_reason`。

与预置 provider 行共存，可回退。

**验证**：对比 `llm-pi-ai` 与自写 adapter 在同一模型上的差异；确认 `annotations` 与 `file-parser` 生效。

### ⬜ 第 6 期｜打包与文档

README 内容：安装、key 获取、三协议选择与 base URL 区别、fallback 说明、兼容预设、故障排查（401 / 402 / 405 三个高频错误）、MCP 可选方案、卸载。

全流程演练安装与卸载，确认卸载后无残留注册。

## 5. 实施前需确认的未知项

未解除：

4. **子进程能力是否受 install scripts 拦截影响**：5 个包的 install scripts 被 npm 拦截，其中 `dsh-subprocess-local` 的 `ensure-spawn-helper.mjs` 可能影响 bash 工具与 subagent

已解除：

1. **`ctx.settings.installSection()` 的完整签名** —— 源码核对解除（`packages/settings/settings/src/index.ts:472-505`）：`installSection(owner, ns, schema, entry, hooks)`，hooks 含 `setSource`/`onChange`（必需）与可选 `validate`；ns 必须匹配 `/^[a-z][a-z0-9-]*$/`
2. ~~`llm-pi-ai` provider 行的确切配置字段形状~~ —— 尚未逐字确认，但已确认 `LlmAdapter` 抽象类真实形状：唯一必须实现的是 `stream()`，`resolveModel`（非 resolveModelInfo）、`prepareCall`、`listModels` 均有默认实现（`packages/llm/llm/src/index.ts:198-280`）。`llm-pi-ai` 的字段形状在第 3 期动模型目录时再核对
3. **`disabled: false` 在 patch 中的确切写法** —— 源码核对解除（`vendor/include/src/index.ts:121-124,145-156`）：`disabled` 是 `PatchOptions` 的合法独立键，覆盖按字段写入目标行；第 0 期已实测 `--dump-config` 显示 `tool-web ... disabled: false`
- **peer 依赖版本范围**：dsh 子包精确 `0.1.5-rc.1`；`@deepseek-ai/cordis ^4.0.2`（npm 无 0.1.5-rc.1）；`@deepseek-ai/schemastery ^3.18.1-rc.1`。各子包 `latest` 标签可能与主版本不匹配，安装时必须显式指定版本
- **`--dump-config` 输出格式**：实测为 `# == <bundle>` 层标记 + YAML 行，每行含 `id` / `name` / `config` / `disabled`
- **`dsh-web-fetch-http` 导出**：导出 `HttpFetchProvider` 类，可实例化复用；构造签名 `(limits, resolveAddresses?)`，第二参数有默认值
- **SSRF 语义版本差异**：`0.1.5-rc.1` 已实现"校验并固定公网 IP 目的地"，与旧版 `0.0.1-rc.5` 的"未实现"不同

## 6. 合规边界

| 操作 | 合法 | 依据 |
|---|---|---|
| `insert` 新增插件行 | 是 | patch 机制原生支持 |
| 覆盖 `- id: web` 的 config | 是 | dsh-base 注释明确 last write wins |
| 覆盖 `- id: tool-web` 的 config（含 `disabled: false`） | 是 | 同上 |
| `ctx.web.registerSearchProvider` / `registerFetchProvider` | 是 | `ctx.web` 是 seam |
| `ctx.llm.registerAdapter` | 是 | `ctx.llm` 是 seam |
| `ctx.settings.installSection` | 是 | `ctx.settings` 是 seam |
| `ctx.tools.register` | 是 | 公开扩展点 |
| 实例化 dsh 包导出的类复用逻辑 | 是 | 复用而非修改 |
| 修改 dsh 任何包的源码或配置 | 否 | 违反纪律 |
| fork 或 patch dsh 包 | 否 | 违反纪律 |

## 7. 风险

**web 走向被改变。** 钉住 `searchProvider` 会让所有 web 搜索先走 Kenari。这是设计目标（用户要求 Kenari 优先），但需要在 README 里说清楚，并提供 `fallbackEnabled: false` 一键退回官方。

**回退有一次失败延迟。** `available()` 禁止网络探测，所以 Kenari 实际不可用时，必须等调用失败才发现，然后回退。用户会感知到一次额外延迟。

**兜底实例的 id 冲突。** 若误将兜底 provider 注册进 seam，会抛 `WEB_DUPLICATE_PROVIDER`。代码里要用注释明确标注"不注册"。

**Kenari 处于 rc 期。** 接口可能变动，所有端点映射集中在 `http.ts`，字段映射集中在各模块顶部，便于跟进。

**计费工具真实扣费。** `web_search`、`web_fetch`、`x_search` 按次计费。测试用 `:free` 模型与最小调用量，失败调用不计费。

**peer 依赖版本。** 实装统一为 `0.1.5-rc.1`，源码 submodule 锁定 tag `dsh-v0.1.5-rc.1`。注意各子包的 npm `latest` 标签可能与主版本不匹配（如 `dsh-web-fetch-http` 的 `latest` 是 `0.0.1-rc.5`，`next` 才是 `0.1.5-rc.1`），安装时必须显式指定版本。

**web 工具默认被禁用。** `web` profile 下 `tool-web` 行被 `dsh-web-app` 追加 `disabled: true`，我们的 patch 必须显式写 `disabled: false`。若该字段语义与预期不符，web 能力无法交付（见第 5 节未知项 3）。

## 8. 附录：功能点清单与载体映射

原始头脑风暴的 100 项中，有相当一部分经核实是重复造轮子。下表按实现载体归类，并标注被裁掉的项。

### 配置层（零代码）

MCP 接入 8 个工具（改为文档提供为可选）；预置三协议 provider 行；兼容预设 `supportsDeveloperRole: false` 与 `maxTokensField: max_tokens`；凭据引用；卸载即净。

### 模型目录同步（第 3 期）

`id` 映射、`modalities.input`、`reasoning_options`、`context_length`、`tool_call`、`sunset_at` 告警、`beta` 标注、`pricing` 与 `pricing_lines` 换算、免费模型分组、`endpoints` 筛选、按 `modality` 拉取 embedding / rerank / moderation 目录、TTL 缓存、新账户默认免费模型、模型别名。

### web 能力（第 1 期，Provider 而非 Tool）

Kenari search provider、Kenari fetch provider、组合 fallback、`maxResults` 透传（Kenari 上限 10，dsh 默认 8）、`sources[]` 映射、`statusCode` 语义对齐、`truncated` 透传、fetch 的 `links[]` 附加。

### 工具（第 2 期）

x_search 及全部过滤参数、OCR 与 `reuse_id` 复用、图像生成 / 编辑、嵌入、重排、审核、语音合成 / 转写、音乐生成、视频生成 / 续写 / 状态 / 下载、余额、用量、额度、文档检索、模型列表、token 计数。

### 账户与计费（第 3 期）

单次扣费回显、会话累计、余额告警、402 引导、充值入口、价格表、预算封顶、分享页 key 检测。

### 上下文与推理（第 3 期）

`count_tokens` 接入、窗口监控与压缩提示、`cached_tokens` 命中率、成本预估、`reasoning` 参数透传、`reasoning_effort` 映射。

### 适配器（第 5 期，可选）

`stream()` 实现、文本增量、reasoning 增量、tool_calls 增量、usage 映射、结束原因映射、`annotations` 透传、三协议统一选路。

### 错误与韧性（贯穿各期）

10 个状态码映射、[OI] 与 Anthropic 双错误信封、429 退避与 `Retry-After`、5xx 重试、可配置超时、兼容开关集中配置、诊断日志脱敏。

### 设置界面（第 4 期）

namespace 注册、余额卡片、模型目录与价格表卡片、计费统计卡片、key 状态、连通性自检。

### 打包与运维（第 0、6 期）

`dsh.bundle` manifest、`dsh plugin add`、`--dump-config` 验证、Config schema 校验、可调值走配置、多 profile、代理支持、目录快照版本化、纯 MCP 降级模式（文档提供）。

### 被裁掉的项及原因

| 原项 | 裁掉原因 |
|---|---|
| 原 27–40 的大部分 LLM 适配器条目 | `llm-pi-ai` 已覆盖三条协议，重复实现会与原生 provider 抢注册 |
| 原 41–43 的 web 工具自建 | 与 `dsh-tool-web` 的工具名冲突，应实现 provider |
| 原 5–9 的 key 管理与脱敏 | 由 `dsh-credentials` seam 原生提供 |
| 原 98 的手动资源回收 | Cordis effect 机制原生提供 |
