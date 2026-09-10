# Kenari API

来源：`https://kenari.id/openapi.json`（OpenAPI 3.1，权威）、`https://kenari.id/llms.txt`、`https://kenari.id/en/docs/*`。

核实时间：2026-09-10。Kenari 处于 rc 期，接口可能变动。

## 基础

- base host：`https://kenari.id`
- key 前缀：`kn-`，在 dashboard 的 API keys → Create key 获取，**只显示一次**
- 一个 key 通用于所有模型、所有 provider、两条 API 线

### 鉴权

| 方式 | header |
|---|---|
| Bearer | `Authorization: Bearer kn-...` |
| Anthropic 风格 | `x-api-key: kn-...` |

**两者同时存在时 `Authorization` 优先。**

OpenAPI 的全局默认 security 是 `bearerAuth`（`type: http`、`scheme: bearer`、`bearerFormat: "kn-..."`）。

例外：`GET /v1/models` 覆盖为 `[{}, { bearerAuth: [] }]`，即**公开无需鉴权**。

### base URL 的形状（高频错误）

| 客户端类型 | base URL | 说明 |
|---|---|---|
| [OI] 兼容 | `https://kenari.id/v1` | |
| Anthropic 协议 | `https://kenari.id` | **不带 `/v1`**，客户端自己追加 |
| Responses | `https://kenari.id/v1` | |

**base URL 形状错误返回 405 而不是 404**，例如 `https://kenari.id/v1/v1/chat/completions` 或漏掉 `/v1`。

## 端点全集

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/models` | 模型目录与实时 IDR 价格，公开 |
| POST | `/v1/chat/completions` | [OI] 对话，支持工具调用与流式 |
| POST | `/v1/messages` | Anthropic 协议，支持工具调用与流式 |
| POST | `/v1/messages/count_tokens` | 返回 `{input_tokens}`，供 [CC] 上下文跟踪 |
| POST | `/v1/responses` | [OI] agent wire |
| POST | `/v1/images/generations` | 图像生成 |
| POST | `/v1/images/edits` | 图像编辑（multipart） |
| POST | `/v1/embeddings` | 嵌入 |
| POST | `/v1/moderations` | 内容审核 |
| POST | `/v1/rerank` | 重排 |
| POST | `/v1/audio/speech` | 语音合成 |
| POST | `/v1/audio/transcriptions` | 语音转写（multipart） |
| POST | `/v1/music/generations` | 音乐生成 |
| POST | `/v1/videos/generations` | 视频生成 |
| POST | `/v1/videos/extensions` | 视频续写 |
| GET | `/v1/videos/{id}` | 视频任务状态 |
| GET | `/v1/videos/{id}/content` | 视频内容下载 |
| POST | `/v1/web/search` | web 搜索 |
| POST | `/v1/web/fetch` | 抓取单个 URL |
| POST | `/v1/x/search` | X（原 Twitter）搜索 |
| POST | `/v1/ocr` | 文档 OCR |
| GET | `/v1/account/quota` | 账户额度 |
| — | `/mcp` | MCP server（Streamable HTTP） |

文档与元数据端点：

| 路径 | 说明 |
|---|---|
| `/llms.txt` | 短索引，每节一行一链接 |
| `/llms-full.txt` | 全部文档合并成一个文件 |
| `/openapi.json` | OpenAPI 3.1 spec |
| `/docs.md`、`/docs/chat.md` 等 | 任意文档页加 `.md` 后缀 |
| `/api/public/pricing` | 当前 token 价格 |

## 模型目录：GET /v1/models

公开，无需 key。返回 `ModelList { object: 'list', data: Model[] }`。

query 参数：`modality`（枚举 `embedding` / `rerank` / `moderation`）。

`Model` 字段：

| 字段 | 类型 | 用途 |
|---|---|---|
| `id` | string | 模型 id |
| `object` | const `model` | |
| `owned_by` | string | 厂商（anthropic / openai / deepseek 等） |
| `sunset_at` | int \| null | epoch 秒的下线时刻；非空可做弃用告警。**到期前仍正常列出与服务** |
| `context_length` | int | 上下文窗口（未知时省略） |
| `modalities` | `{input[], output[]}` | **`input` 含 image 时才可声明图像输入** |
| `reasoning` | bool | |
| `tool_call` | bool | 是否支持工具调用 |
| `reasoning_options` | string[] | 可映射到 dsh 的 `reasoningEfforts` |
| `pricing` | Pricing | 见下 |
| `pricing_lines` | PricingLine[] | 按端点的计费明细 |
| `endpoints` | string[] | 该模型可用的端点，可据此筛选会话模型 |
| `voices` | string[] | 语音模型可用音色 |
| `formats` | enum[] `mp3`/`wav`/`pcm` | |
| `max_input_chars` / `max_prompt_chars` / `max_lyrics_chars` | int | |
| `max_duration_secs` | int | |
| `reasoning_toggle` | bool | |
| `modality` | enum `embedding`/`rerank`/`moderation` | |
| `name` | string | |
| `beta` | bool | 实验性标注 |
| `backends` | string[] | 仅 admin 可见 |

`Pricing`：

```ts
{
  input: int | null
  output: int | null
  cache_read: int | null
  cache_write: int | null
  free: boolean
  varies: boolean
  currency: const 'IDR'
  unit: const 'micro_idr_per_1m_tokens'
}
```

**价格单位是 micro-IDR per 1M tokens。** 换算成可读值：`micro_idr / 1_000_000` 得到 IDR 每百万 token。

`PricingLine`：

```ts
{ endpoint: string, billable: boolean, unit: enum, variant: string | null, micro_idr: int }
```

`unit` 枚举：`token_1m` / `image` / `second` / `1k_chars` / `request` / `megapixel` / `song`。

### 免费模型

两种识别方式：模型 id 加 `:free` 后缀，或 `pricing.free` 为真。

`step-3-7-flash:free` 已验证在每条线上都返回 200 且不扣余额，**Rp 0 的全新账户也能跑通全部流程**。

## 对话：[OI] 线 POST /v1/chat/completions

必需字段 `model`、`messages`。`additionalProperties: true`。

```ts
{
  model: string
  messages: ChatMessage[]
  stream?: boolean            // 默认 false
  max_tokens?: int
  temperature?: num
  top_p?: num
  stop?: string | string[]
  frequency_penalty?: num
  presence_penalty?: num
  reasoning_effort?: string
  reasoning?: { effort?: string, enabled?: bool, max_tokens?: int, exclude?: bool }
  web_search_options?: object
  plugins?: [{ id: 'file-parser', pdf?: { engine: 'ocr', reuse_id?: string } }]
  tools?: object[]
  tool_choice?: string | object
  response_format?: object
}
```

`ChatMessage`：`role`（必需，`system`/`user`/`assistant`/`tool`）、`content`（string 或对象数组）、`name?`、`tool_calls?`、`tool_call_id?`。

响应 `ChatCompletionResponse`：

```ts
{
  id, object: 'chat.completion', created, model,
  choices: [{
    index,
    message: {
      role, content: string | null, reasoning: string | null,
      tool_calls: object[],
      annotations: [{ type: 'file', file: { hash, name, content, confidence: num|null, low_confidence: bool, reuse_id } }]
    },
    finish_reason: string | null
  }],
  usage: Usage
}
```

`Usage`：`prompt_tokens`、`completion_tokens`、`total_tokens`、`prompt_tokens_details`（可能含 `cached_tokens`）。

流式：`text/event-stream`，`data:` 分块，以 `data: [DONE]` 结束。

### file-parser 插件（预分发插件）

`plugins` 数组是"预分发插件"。目前只有 `file-parser`，用于读取文档。

```json
"plugins": [{"id": "file-parser", "pdf": {"engine": "ocr"}}]
```

带 `reuse_id` 的复用变体：

```json
"plugins": [{"id": "file-parser", "pdf": {"engine": "ocr", "reuse_id": "ocr_8f286cec-..."}}]
```

约束：`engine` 只接受 `ocr`；一个请求只带一个文档；**没有该插件的 `file` part 会被 400 拒绝**。

## 对话：Anthropic 线 POST /v1/messages

必需 `model`、`messages`。

```ts
{
  model, max_tokens?, messages: [{ role: 'user'|'assistant', content }],
  system?: string | object[], stream?: bool,
  temperature?, top_p?, top_k?, stop_sequences?: string[],
  tools?: object[], tool_choice?: object, thinking?: object
}
```

响应 `MessagesResponse`：`id`、`type: 'message'`、`role: 'assistant'`、`model`、`content: object[]`、`stop_reason`、`stop_sequence`、`usage: {input_tokens, output_tokens}`。

流式是 Anthropic 风格 SSE 事件。

`POST /v1/messages/count_tokens`：请求体同 MessagesRequest，响应 `{input_tokens: integer}`。

**Kenari 完整支持 Anthropic 协议**，每个目录模型 id 都可用，含工具调用与流式。`ANTHROPIC_API_KEY` 通过 `x-api-key` header 被接受。

## Responses 线 POST /v1/responses

必需 `model`、`input`。

```ts
{
  instructions?, input: object[],
  tools?, tool_choice?, reasoning?: { effort?: string } | null,
  max_output_tokens?, temperature?, top_p?, stream?,
  store?: bool,              // 忽略
  previous_response_id?: string | null,  // 非 null → 400
  prompt_cache_key?, text?: { format: { type: 'text' } },
  parallel_tool_calls?: bool,            // 忽略
  include?: string[], metadata?
}
```

响应：`id`（前缀 `resp_`）、`object: 'response'`、`created_at`、`status`（`completed`/`incomplete`）、`incomplete_details.reason`（`max_output_tokens`）、`model`、`output`、`usage: {input_tokens, output_tokens, total_tokens, input_tokens_details: {cached_tokens}}`。

## web：[OI] 线的 POST /v1/web/search

**需要 `kn-` key。按次计费，与模型资金来源无关（metered 与 BYOK 都付费）。响应中不透露后端来源。**

请求：

```ts
{ query: string, max_results?: int }   // 1–10，默认 5
```

响应：

```ts
{
  results: [{ title: string, url: string, content: string }],
  id: string,                 // 请求标识
  cost_micro_idr: int         // 本次收费，micro-Rupiah
}
```

## web：POST /v1/web/fetch

**需要 key，按搜索费率计费。**

请求：`{ url: string }`

响应：

```ts
{
  title: string,
  content: string,            // 页面正文，纯文本
  links: string[],            // 抽取出的超链接
  id: string,
  cost_micro_idr: int
}
```

## X 搜索：POST /v1/x/search

```ts
{
  query: string,                       // 必需，非空
  x_search_filter?: {
    allowed_x_handles?: string[],      // ≤20，不含 @
    excluded_x_handles?: string[],     // ≤20，不含 @
    from_date?: string,                // YYYY-MM-DD
    to_date?: string,                  // YYYY-MM-DD
    enable_image_understanding?: bool,
    enable_video_understanding?: bool
  }
}
```

**`allowed_x_handles` 与 `excluded_x_handles` 不可同时使用。**

返回一个答案加来源链接。使用 PAYG 余额，**无套餐额度**。失败调用不计费。每个成功结果包含实际扣费金额。

## OCR：POST /v1/ocr

请求：`{ file: { filename, file_data }, reuse_id?, engine? }`
`reuse_id` 用于复用已解析结果，避免重复计费。

## 图像

- `POST /v1/images/generations`：`ImageResponse { created, data: [{ url, b64_json, revised_prompt }] }`。`url` 是 data URI
- `POST /v1/images/edits`：multipart，字段 `image`、`mask`、`prompt`、`model`、`n`、`size`、`response_format`

## 嵌入、重排、审核

- `POST /v1/embeddings`：`{ model, input: string | string[] }` → `{ object: 'list', model, data: [{ object: 'embedding', index, embedding: num[] }] }`
- `POST /v1/rerank`：`{ model, query, documents: string[], top_n?, return_documents? }` → `{ object, model, results: [{ index, relevance_score, document: {text} }], usage: {prompt_tokens, total_tokens} }`
- `POST /v1/moderations` → `{ id, model, results: [{ flagged, categories: bool map, category_scores: num map }] }`

## 音频、音乐、视频

- `POST /v1/audio/speech`：`{ model, input, voice, response_format, speed, language }`
- `POST /v1/audio/transcriptions`：multipart，字段 `file`、`model`、`language`、`prompt`、`temperature`、`response_format`
- `POST /v1/music/generations`：`{ model, prompt, lyrics, instrumental, response_format }`
- `POST /v1/videos/generations`：`{ model, prompt, duration, image_url, end_image_url, input_images, video_url, reference_video_url, aspect_ratio, resolution }`
- `POST /v1/videos/extensions`：`{ model, prompt, duration, video: {url} }`
- `GET /v1/videos/{id}`、`GET /v1/videos/{id}/content`

## 额度：GET /v1/account/quota

`QuotaWindow`：`{ used_rp: int, remaining_rp: int, resets_at: string (RFC 3339 UTC) }`

## 错误

两条线各有错误信封：

- [OI] 线：`{ error: { message, type, ... } }`
- Anthropic 线：AnthropicError 信封

状态码：`400`、`401`、`402`、`403`、`404`、`413`、`422`、`429`、`500`、`503`。

高频错误与处置：

| 症状 | 原因 | 处置 |
|---|---|---|
| 401 `invalid api key` / `invalid x-api-key` | key 错误、环境变量未加载、改完 `~/.zshrc` 未开新终端 | 重新复制 `kn-...`；开新终端 |
| 402 `insufficient_balance` | 用了付费模型但余额 Rp 0 | 切免费模型或充值（QRIS 最低 Rp 1.000） |
| 405 | base URL 形状错误 | [OI] 必须 `https://kenari.id/v1`；[CC] 必须 `https://kenari.id` |
| `model_not_found` | 模型 id 写错或不在目录 | 用目录里的确切 id |
| 403（balance/usage/quota） | 用了分享页 key | 这三个工具被拒；spending 工具仍可用 |

## 分享页 key 的限制

来自分享页的 key，**balance / usage / quota 三个工具会被拒绝**，因为它们读取的是 key 所有者的账户数据而非调用者的。spending 类工具仍正常。

## MCP server

- 端点：`https://kenari.id/mcp`
- 传输：**Streamable HTTP**
- 鉴权：在 MCP server 配置里设 `Authorization: Bearer kn-...`；也接受 `x-api-key`；同时存在时 `Authorization` 优先

通用 MCP 配置形态：

```json
{
  "mcpServers": {
    "kenari": {
      "url": "https://kenari.id/mcp",
      "headers": { "Authorization": "Bearer kn-..." }
    }
  }
}
```

8 个工具：

| 工具 | 功能 | 需 key |
|---|---|---|
| `kenari_search_docs` | 搜索文档 | 否 |
| `kenari_list_models` | 列出模型与实时 IDR 价格 | 否 |
| `kenari_balance` | 余额（Rupiah） | 是 |
| `kenari_usage` | 近 30 天按模型用量 | 是 |
| `kenari_quota` | 套餐与优惠券额度（Rupiah） | 是 |
| `kenari_web_search` | 实时 web 搜索，返回排序链接 | 是 |
| `kenari_web_fetch` | 抓取单个 URL 的干净正文 | 是 |
| `kenari_x_search` | 实时 X 搜索，返回答案加来源链接 | 是 |

后三个 spending 工具**按调用计费到余额**。`kenari_x_search` 要求非空 query。

## 客户端接入（各工具的配置形态）

**Anthropic 线（[CC] 类）**：

```sh
export ANTHROPIC_BASE_URL=https://kenari.id
export ANTHROPIC_AUTH_TOKEN=kn-...
export ANTHROPIC_MODEL=step-3-7-flash:free
```

`ANTHROPIC_BASE_URL` 是根 `https://kenari.id`（**不带 `/v1`**）。`ANTHROPIC_API_KEY`（走 `x-api-key`）也被接受。

**Codex**（`~/.codex/config.toml`）：

```toml
model = "step-3-7-flash:free"
model_provider = "kenari"

[model_providers.kenari]
name = "kenari"
base_url = "https://kenari.id/v1"
wire_api = "responses"
env_key = "KENARI_API_KEY"
requires_openai_auth = false
```

**OpenCode**：`/connect` 里找 Kenari，粘贴 `kn-...`；或 `export KENARI_API_KEY=kn-...`。

**Zoo Code**：设置里 API Provider 选 Kenari，粘贴 key，模型列表自动从 `/v1/models` 拉取。

**Hermes**：base URL 以 `/v1` 结尾，key 读 `OPENAI_API_KEY`。

## token 效率提示

Markdown 比 HTML 省约 30 倍 token，推荐给模型用 Markdown 上下文。
