# dsh-kenari-plugin 设计文档

日期：2026-09-10
状态：第 0–4、6 期已完成并验证（2026-09-10）；第 5 期为可选增强，未做。实测记录见本文末「实施补充」
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

### ✅ 第 1 期｜web fallback（2026-09-10 代码完成，冒烟验证通过）

- [x] `src/http.ts`：Kenari HTTP 客户端（超时/指数退避重试/key 现场解析/错误信封映射）
- [x] `src/errors.ts`：信封解析 + 状态码分类
- [x] `src/web/search.ts`：`max_results = min(req.maxResults ?? 5, 10)`，`results[] → WebSearchSource`，顶层 `content` 留空
- [x] `src/web/fetch.ts`：→ `{url, statusCode: 200, body:{kind:'text'}}`，`links[]` 附正文尾部（≤20 条）
- [x] `src/web/fallback.ts`：`KenariFirstSearch`/`KenariFirstFetch`，回退日志含方向/原因/耗时
- [x] 兜底实例：`DeepSeekSearchProvider`（传 `resolveApiKey` thunk）与 `HttpFetchProvider`（只传 limits），只实例化不注册
- [x] 验证：dump-config 钉层生效、启动无报错、mock 装配三路径、无效 key → 回退 + 日志
- [ ] 真实计费验证（②③④场景）：待用户配 `KENARI_API_KEY`

### ✅ 第 2 期｜REST 工具（2026-09-10 完成并验证）

全部用 `defineTool` + `ctx.tools.register`，`inject: ['web', 'tools']`，20 个工具：

- [x] `docs.ts`：`kenari_search_docs`（本地检索 `/llms-full.txt`，带 TTL 缓存、无需 key）、`kenari_list_models`（公开目录 + 价格换算）
- [x] `account.ts`：`kenari_quota`（REST `GET /v1/account/quota`）、`kenari_balance` / `kenari_usage`（**REST 无此端点，走公开 MCP 端点**，见知识库实测补充）；403 识别分享页 key 并给出说明
- [x] `x-search.ts`：`kenari_x_search` 全量过滤参数；handles ≤20/去 @/互斥、日期格式在参数层校验
- [x] `documents.ts`：`kenari_ocr`，`reuse_id` 复用（实测二次 `cost_micro_idr: 0`）
- [x] `media.ts`：图像生成/编辑、语音合成/转写、音乐、视频生成/续写/状态/下载共 9 个工具；二进制产物经 `ctx.attachments` 落盘为 image/file block
- [x] `data.ts`：embeddings / rerank / moderations
- [x] `count-tokens.ts`：`kenari_count_tokens`（只读不计费）
- [x] 统一：超时（生成类 `generationTimeoutMs`）、重试（生成类超时不重试，防重复扣费）、错误映射、成本回显
- [x] 验证：真实 key 下逐工具调用；`reuse_id` 二次免费；handles 同传报参数错；真实 harness（dsh ToolRuntime + LocalAttachmentStore）派发与图像落盘通过

### ✅ 第 3 期｜目录、计费与上下文（2026-09-10 完成并验证）

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

**验证**（2026-09-10 实测）：`test/real-harness.mjs` 33 项全绿（真实 dsh ToolRuntime + attachment-local + 真 key）；余额告警在阈值调高时触发（余额 Rp 245.103 < 阈值）；402 文案含「改用免费模型 / 充值」；
模型驱动工具调用实测通过：headless profile + Kenari 预设，session 记录 `provider: kenari` / `model: step-3-7-flash:free`，两次 `tool/call` 成功。

**落地差异（实现时定的三个口径）**：
1. **模型接入走 patch 预设，不写用户 settings.yaml**：在 `cordis.patch.yml` 里给 `llm-pi-ai` 加 `providers.kenari`，用户层按 route 合并，所以不覆盖用户自己的选择；预设**只放 11 个免费模型**（Rp 0 账户开箱可用），付费模型由用户在 Models 页加。
2. **不覆盖 `agent-default-model`**：dsh 默认模型来自 base（`deepseek-official/deepseek-flash`），把它改成 Kenari 会让没有 Kenari key 的部署每次会话都鉴权失败。**预设与设置卡片把 `step-3-7-flash:free` 标为推荐首选**，默认模型仍由用户决定。
3. **成本预估按整单位上取**：实测 21 字符 TTS 计 1 个完整「1k 字符」单位（Rp 250），不是 0.021 单位；4s 360p 视频预估 Rp 1.400 == 实际扣费 Rp 1.400。`token_1m` 例外，保留小数。

### ✅ 第 4 期｜设置界面（2026-09-10 完成并验证）

Host 半边用 `ctx.settings.installSection(ctx, NS, Config, config, { validate })` 注册 namespace，Client 半边在 `src/client/` 导出 `./client`，`package.json` 声明 `dsh.client`。

卡片实际内容：凭据状态（引用名 + configured/source/writable）、可编辑的运行参数、加载期开关、模型目录。

key 状态复用 `credentials.describe()` 的 configured / source / writable——该接口**没有承载值的字段**，所以「只显示状态」是接口保证而非 UI 自觉。进程环境提供的引用报告 `writable: false`，卡片据此渲染为「凭据层只读」；`.env` 文件（`user-env` 层）可写则显示「可写」，如实反映 seam 语义。

**与原计划的偏差**：余额、计费统计、实时价格表**没有进卡片**。它们只存在于 Host 侧端点，而 dsh 没有对应的 Remote 命名空间；补一个需要新增 Host API 包（改 dsh），与红线冲突。卡片改为列出这些数据对应的工具（`kenari_billing` / `kenari_balance` / `kenari_list_models` / `kenari_count_tokens`），并说明原因——不显示会过期的数字。模型目录这一项通过既有的 `remote.llm.discoverModels` 拿到了真实数据（76 个模型）。

**客户端 bundle 形态**：本包只有 `tsc`，没有打包器，所以 `client/index.js` 以 loader 的 factory 格式**手写**（只 require baseline 的 `react`）。`scripts/check-client.mjs` 随 `pnpm build` 运行：校验注册格式、导出面、模块依赖声明、NS 与 Host 一致，并**真实渲染一次卡片组件**——手写 bundle 的编译期检查就是它。

**验证**（2026-09-10 浏览器实测）：Settings 导航出现 **Kenari** 分区；卡片渲染无 `data-slot-error`；凭据行显示「KENARI_API_KEY / 已配置 / 来源 user-env」，全程无明文；模型目录 76 条。踩到的两个坑已固化进构建门槛：服务名写成 Host 侧的 `credentialsController`（应为 `remote.credentials`）会在页面报 `pending (waiting for service: …)`；组件里引用未定义变量会静默渲染成空面板。

### ✅ 第 5 期｜专属 LlmAdapter（2026-09-10 完成并验证，默认关闭）

继承 `LlmAdapter` 实现 `stream()`，用 `ctx.llm.registerAdapter(['kenari'], adapter)` 注册。

只补通用适配器丢掉的字段：`file-parser` 注入、`web_search_options`、`pricing_lines`、`reasoning_options`、`annotations`、`:free` 后缀处理。

`StreamChunk` 映射：文本增量、reasoning → 思考通道、tool_calls → 工具事件、usage、`finish_reason` / `stop_reason`。

与预置 provider 行共存，可回退。

**验证**：对比 `llm-pi-ai` 与自写 adapter 在同一模型上的差异；确认 `annotations` 与 `file-parser` 生效。

**实现口径**（`src/llm/adapter.ts`，`nativeAdapterEnabled` 默认 `false`）：

- **路由名与预设不同**（默认 `kenari-direct`），所以预设路由与原生路由可以并存、可以回退
- `stream()` 走 [OI] 线 SSE：`reasoning_content` → `reasoning-delta`（思考通道与可见文本分开），
  `content` → `text-delta`，`delta.tool_calls[]` 分片重组 → `tool-call-delta` + 组装好的 `block-end`，
  usage 帧 → `usage` chunk，`finish_reason` → `finish`
- **usage 进共享账本**（会话作用域）：这就是 `cached_tokens` 命中率的数据源。dsh 要求各项**互斥**，
  所以 `inputTokens = prompt_tokens - cached_tokens`、`cacheReadTokens = cached_tokens`
- 免费模型不记费用；付费模型按目录 `pricing` 换算预估（缓存读用 `cache_read` 单价，缺失才退回输入价）
- `listModels()` 直接来自目录，价格/上下文/视觉/推理档位写进 `description`；`resolveModel()` 给上下文与推理档位
- 同时 `registerModelDiscovery('kenari', …)`，设置卡片与 Models 页的「拉取模型」对原生路由也有效

**已知不做的三件**：不回放思考块；不注入 `file-parser`（文件块投影成说明文本，读文档用 `kenari_ocr`）；
不映射 `web_search_options`（dsh 的 `GenerateOptions` 没有对应字段）。都写在 README 里。

**验证**（2026-09-10）：
- `test/llm-adapter.mjs` 对本地假网关 25/25 通过：请求体（stream / stream_options / max_tokens /
  reasoning_effort / tools / attribution user-agent）、消息映射（system 串、assistant 的 tool_calls 回放、
  tool 结果 → `role:tool` + `tool_call_id`）、分片工具调用重组、usage 互斥口径、
  401 → `AUTH`、空响应 → `EMPTY_RESPONSE`、付费模型预估 220 micro-IDR（输入 120 + 缓存读 20 + 输出 80）
- headless 真实会话 3 轮工具调用通过，session 记录 `provider: kenari-direct`，
  `kenari_billing` 显示 token 计量与 **48.2% 缓存命中率**（这正是第 3 期缺的数据源）

### ✅ 第 6 期｜打包与文档（2026-09-10 完成并验证）

README 内容：安装、key 获取、三协议选择与 base URL 区别、fallback 说明、兼容预设、故障排查（401 / 402 / 405 三个高频错误）、MCP 可选方案、卸载。

全流程演练安装与卸载，确认卸载后无残留注册。

**验证**（2026-09-10 实测）：`dsh plugin --profile web remove dsh-kenari-plugin` → profile 的 `package.json` 里依赖与 bundle 条目消失，`--dump-config` 中本插件相关行归零，`web` 行回到 base 默认（`deepseek-official` / `http`），`tool-web` 回到 `disabled: true`，`llm-pi-ai` 回到无 config；`dsh plugin --profile web add ./` 后逐项复原，启动无报错。安装时 pnpm 报的 peer 警告来自 dsh 自己的 `dsh-web-fetch-http`（缺 cordis / dsh-web 等 peer），与本插件无关。

### ✅ 第 7 期｜可选模型筛选（2026-09-11 完成并验证）

「设置 → 模型 → Kenari → 编辑 → 自定义设置 → 获取可用模型」这个对话框是 **dsh 的**
（`ui-settings-models` 的 `ModelListEditor`），它只渲染 `candidate.id`，而 `LlmDiscoveredModel`
只带 `id/name/contextWindow/maxTokens` —— 能力和套餐信息**既进不去也显示不出来**。红线不允许改它，
所以本期做的是**同位置的能力/套餐扩展**，落在 dsh 为外部插件留的座上：

- **浏览器侧**：注册 slot `settings.models.provider-card`（key = `llm-pi-ai`，dsh 声明这个槽位就是
  "给仓库外插件往模型设置页加 UI，而不必改这一页"），只对 `kenari` 路由渲染。面板给出
  1) 模型名后的能力标签（image / audio / video / pdf / embedding）、`免费`，以及付费模型的 `套餐内`
  （= 该付费模型在订阅套餐的覆盖范围内；**免费模型不标注**，也不显示套餐档位名——档位只是
  "覆盖与否"的来源）；
  2) 搜索 + `套餐内` / `免费` / `image` / `audio` / `video` / `pdf` / `embedding` 过滤片（多选为 AND，
  `套餐内` 是布尔维度而非选档）；
  3) 「加入所选到 kenari 路由」——按 pi-ai 语义**追加**到现有数组（用户层有数组就用它，否则用 patch 的预设），
  不整体替换。
- **Host 侧数据**：新增 `src/plans.ts`（`GET /api/plans` + TTL 缓存 + 模型→套餐归属索引）、
  `src/catalog-view.ts`（注册同源 Fetch 路由 `GET /api/kenari.models`，返回已算好的能力标签、套餐归属
  与可直接写入路由的 pi-ai profile）、`catalog.ts` 增加 `capabilityTagsOf` / `toModelProfile` /
  `reasoningEffortsOf`。
- **为什么不新建 Remote 命名空间**：客户端命名空间来自 `dsh-api-remotes` 里写死的装配清单，
  插件加不了；而 `ctx.connection.fetch.register` 是 dsh 自己的公开扩展点（精确 Fetch 路由挂在 `/api` 下），
  浏览器用同一会话同源读取即可，无需 CORS、无需新 Host API 包。标签只在 Host 算一次，
  所以设置页与 `kenari_list_models` 不可能说两套话。
- **顺带修正**：`KenariCatalog` 原来经带 key 的传输层抓公开的 `/v1/models`，没配 key 的部署会
  `WEB_KENARI_NO_KEY`。实测带 key 与不带 key 的目录响应**逐字节相同**，故改走 `kenariPublicGet`
  （不带 key）——没配 key 时正是最需要看目录与套餐的时候。

**与会话的关系**：本面板不注册任何模型，也不改 `agent-default-model`；它只往 `llm-pi-ai` 路由的
`models` 数组里追加用户勾选的条目。

**验证**（2026-09-11 实测）：

- `test/catalog-view.mjs`：真实抓公开目录（80 个模型，含 4 个 embedding）+ 套餐表（5 档），
  逐条断言标签有目录依据、套餐 join 命中 35/80、`coverageOf` 对 `:free` id 归一；
  **全部 80 个 profile 一次性通过真实的 `llm-pi-ai` Config（schemastery）校验**——这正是设置写入的那道关
- `scripts/check-client.mjs`：两个 slot 注册都真实渲染一次（Kenari 行出面板、其它 pi-ai 路由返回 null）
- 浏览器实测（`dsh --profile web --port 3099 --no-open`，不影响 3080 上用户实例）：
  设置 → 模型 → Kenari 行出现面板，过滤片为 `套餐内` `免费` `image` `audio` `video` `pdf` `embedding`
  （无套餐下拉，行内只显示一个 `套餐内` 标签，不显示档位名，也没有 hover 明细）；
  取值可复算：套餐内 35/80、再叠免费 5/80、再叠 video 3/80、清除回 80/80；
  能力标签正确（`gemini-2-5-flash` → image+audio+video+pdf+套餐内，
  `gemini-3-1-flash-tts` → audio + 非会话模型，`deepseek-v4-flash` → 已在路由）；
  Kenari 设置卡内同名面板同样渲染；两处都无 `data-slot-error`。
  「加入所选」实测把模型写进 `~/.dsh/settings.yaml` 的 `llm-pi-ai.providers.kenari.models`
  （17 → 18 条，写入通过 schema 校验），随后按备份逐字节还原（sha256 一致）
- 面板的数据请求稳定为每次挂载 1 次（修掉了 effect 依赖新建对象导致的重复取数）

**口径调整（2026-09-11，用户反馈后）**：初版把每个覆盖套餐的名字逐个当标签打出来，并把 `plan`
做成套餐下拉。用户指出 plan 标签的含义是"该模型在订阅覆盖范围内"，且不要显示档位名，
故改为：行内单个 `套餐内` 标签 + `套餐内` 布尔过滤片，档位名不再出现在任何界面上
（`/api/kenari.models` 仍返回套餐清单，那是数据来源与诊断用，不是展示）。
第二轮反馈又定两条：**免费模型不打 `套餐内` 标签**（免费模型花不花钱与套餐无关，
过滤片与标签读同一个判断函数，避免筛出来的行没有标签）；**行内标签不挤压、超宽自动换行**
（标签 `flexShrink: 0` + `whiteSpace: nowrap`，行 `flexWrap: wrap`，id 与名称作为一个
不拆分的左对齐单元，标签整体换到下一行且各自保持完整宽度）。

第三轮反馈再定两条：**行内只显示模型 id**（不显示厂商可读名——id 才是请求与路由条目
用的字符串；name 仍在载荷里，搜索会匹配它，写进路由条目时也带着它）；
**所有标签统一一种样式**（`免费` / 能力标签 / `套餐内` 共用 `capTag`，实测 7 种标签的
computed style 只有 1 种；`套餐内` 原来的蓝色胶囊样式删除）。

第四轮反馈再定三条：**去掉 `免费` 标签**（免费模型看 id 的 `:free` 后缀即可；13 个免费
模型全部带该后缀，实测无一例外。`免费` 过滤片保留，它读的是载荷的 `free` 字段而不是后缀，
所以 Kenari 哪天用 `pricing.free` 标一个不改名的免费模型，筛选依然准）；**模型与标签视觉居中**
——实测发现真问题：标签作为 id 的兄弟节点参与同一个换行容器时，换行后的行会退回行的最左边
（实测 `pdf@0`、`套餐内@39`，落在复选框下面）。改成"id + 独立标签列"结构后，标签在自己的列内
换行（两行都从同一 x 起，实测 661/661），id 用 `alignItems: center` 对齐整个标签块的中线
（实测 offset 0）；**选中态与未选中态外框一致**：原来选中会把外框从灰色 `rgba(127,127,127,0.4)`
换成 `currentColor`（近白），现在两态共用同一个外框常量 `CHIP_BORDER`，选中只改填充
（透明 → `rgba(127,127,127,0.28)`）与字重（400 → 600）。

第五轮反馈：**已在路由的 `✓` 要与勾选框对齐**。原生 checkbox 自带浏览器 margin 与固有尺寸，
而原来 `✓` 只是放在一个 `width: 13px` 的 span 里，两者对不上。抽出共用的 `PICK_BOX`
（14×14、`margin: 0`、`boxSizing: border-box`、`flexShrink: 0`），勾选框直接用，`✓` 再加
flex 居中；实测同一面板里两种形式的 x / 宽 / 高 / 垂直中心偏移完全一致（x=0、14×14、offset 0）。

### ✅ 合并「获取可用模型」入口（2026-09-11）

第六轮反馈：那块并列的「Kenari 可选模型（能力 / 套餐筛选）」面板**不该单独列出**，
要和 dsh 的「获取可用模型」**融合成一个入口**。

对话框内部加不了东西（红线，见上），但**入口可以接管**：`settings.models.provider-card` 的
挂载点与 `renderProviderEditor(...)` 是**同一个 `<li>` 卡片内的兄弟节点**（`ModelsSection` 实测），
所以那个按钮就在插件标记所在的卡片里。做法：

- slot 只渲染一个隐藏标记 `data-kenari-model-picker`（以及被点开后的对话框），不再渲染任何列表；
- `apply` 里注册一个 **document 捕获阶段** click 监听：`target.closest('button')` 的文本命中
  dsh 自己的标签（`获取可用模型` / `Fetch available models`）**且**该按钮往上第一个含标记的祖先存在时，
  `preventDefault + stopPropagation`（捕获阶段早于 React 挂载在根容器上的监听，所以 dsh 的处理函数
  收不到这次点击）并打开插件的对话框；
- **其余一律放行**：别的 provider 的同名按钮（其卡片没有标记）、插件自己对话框里的点击
  （Modal 是 portal 到 `body` 的，上方没有标记）、以及插件自己重放的那一次点击（`takeoverBypassed`）。

**顺带实测出的基线事实**：`PLATFORM_MODULES` 里有 `react-dom` / `react-dom/client` /
`@deepseek-ai/dsh-client-ui-primitives`。在安装版 0.1.5-rc.1 的 shell bundle 里逐字核对过这张表，
且该模块的导出面确实带 `Modal` / `Button` / `Pill` / `Tag`（dsh 自己的 `ui-settings-models` 也从这里取
`Modal`、`Button`）。**基线模块是隐式 external，不需要 `dsh.client.external` 声明** —— 于是合并后的对话框
用的是 dsh 自己的 Modal / Button / Pill / Tag：同一套 chrome、同一套 `--dsw-*` token，是那个对话框本身，
而不是一个长得像的仿制品。行内标签也换成了 dsh 的 `Tag`（`tone: outline`，只留一个 tone，
"所有标签统一样式"的口径不变）。

**对话框宽度与文案（后续反馈）**：`Modal` 的卡片是 `width: min(380px, 100%)` —— 那是为 dsh 自己的
裸 id 列表定的，而这里一行是 id + 最多 5 个标签、工具条 7 个过滤片，实测很挤。`Modal` 只接 className
（不转发 style prop），所以宽度走一条注入规则
`.kenari-catalog-dialog[role="dialog"]{width:min(820px,92vw);max-width:92vw}`
（`[role="dialog"]` 限定词用来盖过基础规则的特异性，不必用 `!important`；在 `apply` 时注入，
避免首次绘制先窄后宽）。实测 1280 视口下卡片 820px：7 个过滤片一行放下、标签最多的那一行（5 个）
也回到一行。同时把说明压成一句（计数 + `套餐内` 的含义），成功提示压成一句。

**标签样式与行距（再一轮反馈）**：行内标签从 `outline`（细描边 + 三级文字色）换成 `neutral`
（灰底实心 chip）——原来那种几乎只剩文字，读不出"这是一个标签"；全部标签仍是**同一个 tone**，
"样式保持一致"的口径不变。行距同时放开：行内边距 `3px 0` → `7px 8px`（行高实测 26 → 33px）、
行间距 `2px` → `4px`、列表内边距 `6px 8px` → `8px`、标签列内的换行间距 `2px 6px` → `4px 8px`，
并给对话框主体加 14px 的分节间距（工具条 / 计数 / 列表 / 反馈各成一段，不再挤成一段控件）。
实测标签仍不挤压（`scrollWidth == clientWidth`）。

**语义差异（必须知道）**：dsh 原对话框把勾选加进**编辑器草稿**，之后还要点「保存」；插件够不到那份草稿，
所以写入是**即时**的（走 `settings.mutate`，与「加入所选」同一条路）。由此：

- 对话框脚注与成功提示都写明"写入立即生效，不需要再点保存"；
- 同一卡片里编辑器的模型列表在**重新展开「编辑」之前是旧的**（实测：编辑器开着时写入，
  编辑器仍显示 18 行；收起再展开 → 19 行）。成功提示把这句也写出来。dsh 自己的「重置模型目录」
  在编辑器开着时同样是这个行为，不是本插件引入的异常。

**失效回退**：目录视图读取失败时，对话框给出「改用 dsh 自带对话框」——关掉本对话框，置
`takeoverBypassed` 后重放刚才那一次点击，原生流程照旧。

**验证**（2026-09-11）：

- `scripts/check-client.mjs` 27 条断言全过。本轮新增：纯函数层（`套餐内`/`免费`/能力 AND/搜索/已在路由
  不重复加入/全选态/用户层覆盖 base 层/`pathGet` 不造默认值）、`cardWithMarker`
  的"只认带标记的卡片"（另一张卡片必须返回 null，否则会抢走它唯一的模型选择器）、
  以及对话框 chrome / body / footer 的真实渲染
- 浏览器实测（3099，不影响 3080）：模型页 Kenari 行**只剩** `Edit` / `Restore defaults` /
  `Fetch available models`，并列面板已消失；点 dsh 的按钮弹出本插件对话框（标题「选择要添加的模型」、
  7 个过滤片、`显示 80 / 80`、17 行「已在路由」、30 行「套餐内」、63 个勾选框）；
  `image` 过滤 → 46/80 且**每行都带 image 标签**、`aria-pressed=true`；
  标签不挤压（`scrollWidth == clientWidth`，实测宽 49/46/46/35/50）、行 `nowrap` 而标签列 `wrap`、
  id 与行中线偏移 < 1px；
  写入实测 17 → 18 → 19 条并**按备份逐字节还原**（sha256 一致，见下）；
  设置 → Kenari 页的「可选模型目录」按钮打开同一个对话框，只读（0 个勾选框、无「添加所选」、脚注只有「关闭」）；
  「取消」只关本对话框，设置对话框保持打开

### ✅ 默认路由按套餐决定（2026-09-11）

用户要求：默认**不要**放 `:free` 模型；插件能查到当前 key 的套餐与该套餐的 `free_cache_models`，
默认就把这些免缓存模型放进路由；查不到就用兜底清单（`deepseek-v4-flash` / `glm-5-3-flash` /
`gpt-5-6-luna` / `mimo-v2-5`）。

实现上的关键约束：`cordis.patch.yml` 是**静态 YAML**，算不出套餐相关的东西，所以拆成两层：

- **静态兜底**：patch 预设改成那 4 个（正好等于 Kreator / Studio 两档的免缓存清单），
  字段形状与 `catalog.ts` 的 `toModelProfile()` 一致，所以两条路径对同样的 id 产出同样的条目
- **动态默认**：新增 `src/default-route.ts`，在 `settings` 节挂上后跑一次：
  用户层已持有 `providers.kenari.models` → 不动；没有 key / quota 401 / `plan` 为 null → 不写；
  拿到套餐名 → 从套餐表取 `free_cache_models` → 逐个过目录补全 profile（丢掉查不到的与非会话模型）→
  **与预设同集合时不写**（否则每次启动都把同样的清单固化进 `settings.yaml`），不同才
  `ctx.settings.mutate('llm-pi-ai', [set providers.kenari.models], revision)` 写一次

写进去即成为用户层覆盖，下次启动第 1 步就返回 —— 一次性物化，不会反复改写，也永远不会覆盖
用户自己改过的列表。

**验证**（2026-09-11）：
- `test/default-route.mjs`：真目录 + 真套餐表 + 真 `/v1/account/quota`（只读免费），
  假设置服务录下写入决定。实测账户套餐 **Studio**，其免缓存清单与预设完全一致 →
  **0 次写入**（正是期望：预设已经是对的，不该碰用户配置）；用户层持有 / 无 key / key 无效
  三条路径均 0 次写入
- `dsh --profile web --dump-config`：预设已换成那 4 个、`:free` 全部消失、同日另一条工作线的
  `retryPolicy` 保持完好（同文件不同块，未受影响）
- 服务实测：插件加载无报错，面板照常渲染（80/80、无 `data-slot-error`、行内无 `免费` 标签），
  启动前后 `settings.yaml` 的 sha256 **逐字节不变**

**注意（对既有安装的含义）**：pi-ai 的语义是"用户层写了数组就整份替换预设"，所以已经自己改过路由的
账户看不到新默认值——需要在 Models 页点「重置模型目录」把数组交还预设，或者手动改成想要的清单。
另外这 4 个都不是免费模型：**余额为 0 的新账户第一次会话会 402**，这是"默认不用免费模型"的代价，
已在 README 写明。

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
