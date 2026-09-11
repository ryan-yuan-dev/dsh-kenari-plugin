# dsh-kenari-plugin

把 [Kenari](https://kenari.id)（kenari.id）接成 DeepSeek Harness（dsh）的一等公民：

- **会话模型**：Kenari 的模型可以当 dsh 的会话模型用（11 个免费模型开箱可选）
- **web provider**：搜索与抓取走 Kenari 优先，失败回退 dsh 默认 provider
- **21 个工具**：OCR、图像、音视频、嵌入、重排、审核、账户、目录、计费、token 计数
- **设置界面**：Settings → Kenari，看凭据状态、改运行参数、看模型目录

零改动 dsh：全部通过 bundle patch 层、公开 seam（`ctx.web` / `ctx.settings`）与 `ctx.tools.register` 实现。

## 安装

```sh
dsh plugin --profile web add /path/to/dsh-kenari-plugin
dsh --profile web --dump-config | grep -A3 dsh-kenari-plugin   # 确认层已生效
dsh --profile web
```

本地开发时把 `lib/` 编出来即可（profile 里是 pnpm link）：

```sh
pnpm build        # tsc + 客户端 bundle 自检
```

## 配 key

1. 在 Kenari dashboard 的 API keys → Create key 拿 `kn-...`（**只显示一次**）
2. 写进凭据层，推荐 `.env` 形式（凭据层可写、可在设置界面里改）：

```sh
# ~/.dsh/.env  （dsh 以 user-env 层加载；或写 $DSH_HOME/.credentials.yaml）
KENARI_API_KEY=kn-...
```

不要塞进 `cordis.patch.yml`。设置文档里只保存**引用名**（`KENARI_API_KEY`），值永远不进日志、UI 与配置。

## 选模型

装上后 Settings → Models 里会出现 **Kenari** 路由，11 个免费模型已就绪：

| 模型 | 上下文 | 备注 |
| --- | --- | --- |
| `step-3-7-flash:free` | 262k | 推荐默认，支持工具调用、图片输入、reasoning 档位 |
| `muse-spark-1-3-contributor:free` | 1M | 视觉，5 档 reasoning |
| `nemotron-3-ultra-550b-a55b:free` | 1M | |
| `mimo-v2-5:free` | 1.05M | |
| `mistral-medium-3-5:free` | 262k | 视觉 |
| `glm-4-7-flash:free` · `hy3:free` · `laguna-s-2-1:free` · `laguna-xs-2-1:free` · `nemotron-3-super-120b-a12b:free` · `muse-spark-1-2-contributor:free` | | |

预设**只放免费模型**：Rp 0 的新账户装上就能跑，不会因为手滑产生费用。要用付费模型，在 Settings → Models 里给 `kenari` 路由加一条 model entry，或在设置文档里加自己的路由。

### 按能力与套餐挑模型

预设只列了 11 个免费模型，而 Kenari 目录里实际有 80 个。**设置 → 模型 → Kenari** 这一行上会多出一块
「Kenari 可选模型（能力 / 套餐筛选）」（Kenari 设置分区里也有同样的面板）：

- 每个模型名后跟着**能力标签**（`image` / `audio` / `video` / `pdf` / `embedding`）、`免费`，
  以及覆盖它的**套餐名**（Indie / Kreator / Studio / Agensi / Enterprise）
- 过滤：搜索框、套餐下拉，以及 `免费` `image` `audio` `video` `pdf` `embedding` 过滤片
  （多个过滤片是**同时满足**）
- 勾选后可「加入所选到 kenari 路由」：**追加**到该路由现有模型之后，不会覆盖已有条目

标签的口径：套餐标签 = 请求会从该套餐额度扣费（没有套餐标签 = 只能用预付余额 PAYG）；
能力标签按目录事实推导——`image/audio/video/pdf` 看 `modalities.input` 与 `endpoints`，
`embedding` 来自 `?modality=embedding` 目录。目录与套餐表都读**公开端点**，所以还没有 key 时也能看。

面板由 Host 侧算好数据（`GET /api/kenari.models`），浏览器只渲染，
所以它和 `kenari_list_models` 报的是同一套事实。

> dsh 自带的「获取可用模型」对话框只显示模型 id，插件无法往里加标签或过滤器
> （那是 dsh 自己的组件，且它收到的字段只有 `id/name/contextWindow/maxTokens`）。
> 需要筛选时用上面这块面板。

## 三条协议线与 base URL

Kenari 同时提供三条线，**base URL 形状不同，写错返回 405 而不是 404**：

| 协议（pi-ai 的 `api`） | base URL | 说明 |
| --- | --- | --- |
| `openai-completions`（[OI] 线） | `https://kenari.id/v1` | 预设用的就是这条 |
| `openai-responses` | `https://kenari.id/v1` | |
| `anthropic-messages` | `https://kenari.id` | **不带 `/v1`**，客户端自己追加 |

**兼容预设**（已写在 `cordis.patch.yml` 里，自建路由时要照抄）：

- `maxTokensField: max_tokens` —— Kenari 只读 `max_tokens`；实测发 `max_completion_tokens` 会**返回 200 但静默忽略**，输出上限直接失效
- `supportsDeveloperRole: false` —— 系统提示词继续用 `system` 角色
- `supportsUsageInStreaming: true` —— 流式最后一帧带 `usage`，这是 `cached_tokens` 计量的来源
- `reasoningEfforts` 的键只能用 dsh 的 `off|minimal|low|medium|high|xhigh|max`；Kenari 报的 `none` 映射为 `off`（值仍是线上的写法 `off: none`）。**键写错会让 dsh 直接启动失败**，改预设后务必先 `dsh --profile web --dump-config` 再启动。

## web 搜索/抓取

安装后 web 的 `searchProvider` / `fetchProvider` 都被钉到 `kenari-fallback`：先打 Kenari，失败（含 401/402/403、网络错误）回退 `deepseek-official` / 本地匿名 `http`，回退时日志给出方向、原因与耗时。

`available()` 契约禁止发网络请求，所以 Kenari 真不可用时**必须等调用失败才发现**，用户会感知一次额外延迟。不想要这个替换：把插件配置 `fallbackEnabled` 设为 `false`（需重启）。

## 计费与预算

工具每次会带一行费用回显：

- 响应里有 `cost_micro_idr` → 写**实际扣费**
- 没有回显（图像/视频/语音等）→ 按目录 `pricing_lines` 单价 × 数量写**预估**，并说明口径
- 非 token 单位（张/秒/千字符/首）**按整单位上取**：实测 21 字符的 TTS 计 1 个「1k 字符」单位 Rp 250，不是 0.021 单位

`kenari_billing` 给会话累计、分工具/分模型、token 与 `cached_tokens` 命中率、预算余量、钱包余额。余额低于 `lowBalanceAlertRp`（默认 Rp 5.000）时，花费回显后附一条告警。

预算封顶：`budgetCapRp`（默认 0 = 不封顶）。到顶后花费型工具会被拒绝并给出「改免费模型 / 提高上限」的建议。**预检只看已记录的花费**，所以它是「不再新增花钱调用」，不是「保证总额不超」。

402 `insufficient_balance`、401、405、403 等错误都带了可执行建议，直接读错误文案即可。

## 工具一览

| 类别 | 工具 |
| --- | --- |
| 目录与文档 | `kenari_list_models`（含免费分组、价格、上下文、下线与 beta 告警；公开目录，**不需要 key**）、`kenari_search_docs`（同样不需要 key） |
| 账户 | `kenari_balance`、`kenari_usage`、`kenari_quota`（分享页 key 会 403，见下） |
| 搜索 | `kenari_x_search`（handles 互斥、≤20、日期校验） |
| 文档 | `kenari_ocr`（`reuse_id` 复用免费） |
| 媒体 | `kenari_image_generate`、`kenari_image_edit`、`kenari_speech`、`kenari_transcribe`、`kenari_music`、`kenari_video_generate`、`kenari_video_extend`、`kenari_video_status`、`kenari_video_content` |
| 数据 | `kenari_embed`、`kenari_rerank`、`kenari_moderate` |
| 上下文与计费 | `kenari_count_tokens`（窗口占比 + 压缩提示）、`kenari_billing` |

二进制产物（图/音/视频）经 `ctx.attachments` 落盘成 image/file block，不塞进 JSON。

**已知的模型侧空缺**（不是工具问题）：公开目录当前没有 music 与 moderation 模型，所以 `kenari_music` / `kenari_moderate` 只会返回 400；`kenari_speech` 用 `mimo-v2-5-tts` 可用，`kokoro-tts` 与 `gemini-3-1-flash-tts` 是上游 400。

## 可选：插件自带的 LlmAdapter

第 3 期的 `llm-pi-ai` 预设已经能把 Kenari 当会话模型用。若还想要：

- **模型选择器里直接看到价格**（`入 420 / 出 24000 IDR per 1M tokens · ctx 262144 · 视觉 · 推理 low/medium/high`）
- **会话 token 计量与 `cached_tokens` 命中率进 `kenari_billing`**（预设路由下这个数据源看不到）
- 推理档位按目录原样暴露（含 `none`，不需要 off/none 键位翻译）

就把 `nativeAdapterEnabled` 设为 `true`（需重启）。它注册的路由默认叫 `kenari-direct`，与预设的 `kenari`
不同名，所以两条路可以并存：想回退把开关关掉即可。

```yaml
- id: kenari
  config:
    nativeAdapterEnabled: true
    nativeProviderId: kenari-direct
```

**不做的事**（与预设路由的能力差异）：不回放思考块、不注入 `file-parser`（文件块投影成说明文本，
读文档请用 `kenari_ocr`）、不映射 `web_search_options`。图像输入是支持的（经 `ctx.attachments.readImage`
读回字节、转 data URI 发送）。

## 故障排查

| 症状 | 原因与处置 |
| --- | --- |
| 401 `invalid api key` | key 失效、环境变量没加载（改完 `.env` 要开新终端或重启 dsh）、凭据引用名写错 |
| 402 `insufficient_balance` | 用了付费模型但余额 Rp 0。切免费模型（`kenari_list_models` 里 id 带 `:free`）或充值（QRIS 最低 Rp 1.000） |
| 405 | base URL 形状错：[OI]/Responses 用 `https://kenari.id/v1`，Anthropic 用 `https://kenari.id` |
| dsh 启动报 `invalid config ... reasoningEfforts` | `reasoningEfforts` 的键不在 dsh 允许集合里。改回 `off..max`，或从预设里删掉该模型 |
| 403（balance/usage/quota） | key 来自**分享页**：这三个工具读 key 所有者的账户数据，被拒；消费类工具不受影响 |
| 设置页 Kenari 卡片空白 | 客户端 bundle 未构建或服务名写错。跑 `pnpm build`（含自检），再重启 dsh |
| 模型列表是空的 | 预设未生效：`dsh --profile web --dump-config` 看 `llm-pi-ai` 段是否存在 |

## 可选：只用 MCP，不装插件

Kenari 自带 Streamable HTTP MCP server（8 个工具，名字带 `mcp__kenari__` 前缀）：

```json
{
  "mcpServers": {
    "kenari": { "url": "https://kenari.id/mcp", "headers": { "Authorization": "Bearer kn-..." } }
  }
}
```

代价：工具名带前缀、没有计费可视/余额预警/402 引导、多一个运行时依赖。本插件的 21 个工具与余额预检都在，所以推荐插件路径；MCP 只适合「先试一下」。

## 卸载

```sh
dsh plugin --profile web remove dsh-kenari-plugin
```

插件注册的一切（provider、工具、设置节、客户端 bundle）都挂在 Cordis fiber 上，卸载即回收；dsh 的包与配置没有被改过，所以不会留下任何残留。

## 合规边界

| 操作 | 是否允许 |
| --- | --- |
| insert 插件行 / 按 id 覆盖已有行 config | ✅ |
| `ctx.web.registerSearchProvider` / `ctx.settings.installSection` / `ctx.tools.register` | ✅ |
| import dsh 包导出的类并实例化复用 | ✅ |
| 修改、fork 或 patch dsh 任何包 / 编辑 `node_modules` | ❌ |

## 开发

```sh
pnpm build                      # tsc → lib/ + 客户端 bundle 自检
node test/real-harness.mjs      # 真实 dsh harness（ToolRuntime + attachment-local + 真 key）
node test/llm-adapter.mjs       # 本地假网关：适配器请求体/分片重组/usage/失败分类（不联网、不花钱）
node test/billed-media.mjs      # 会真花钱：TTS + STT 并校准预估（约 Rp 500/次）
KENARI_ALLOW_VIDEO=1 node test/billed-video.mjs   # 会真花钱：生成并下载 4s 视频（约 Rp 1.400）
```

`scripts/check-client.mjs` 随 `pnpm build` 运行：校验客户端 bundle 的注册格式、导出面、模块依赖声明、命名空间与 Host 一致，并**真实渲染一次卡片组件**——手写 bundle 没有打包器，这些就是它的编译期检查。
