# dsh-kenari-plugin

[![npm version](https://img.shields.io/npm/v/dsh-kenari-plugin.svg)](https://www.npmjs.com/package/dsh-kenari-plugin)

[English](README.en.md) | 中文

把 [Kenari](https://kenari.id) 接进 DeepSeek Harness（dsh）：

- Kenari 的模型可以当 dsh 会话模型，默认路由按 key 的套餐自动决定
- 搜索与抓取优先走 Kenari，失败回退 dsh 自带的 provider
- 21 个 REST 能力注册成 agent 工具：目录、账户、搜索、OCR、图像、音频、视频、嵌入、重排、审核、计费、token 计数
- 新会话标题带本机时间前缀，模板可改、可关
- Settings → Kenari 一页管完：凭据状态、运行参数、模型目录

所有能力通过 dsh 的 bundle patch 层与公开 seam（`ctx.web`、`ctx.settings`、`ctx.tools`）注册，没有改动 dsh 的任何代码或配置。

## 前提

需要 dsh `0.1.5-rc.1`（全局安装，`dsh` 在 PATH）、Node.js >= 22，以及 pnpm（`dsh plugin` 底层转发给它）。dsh 子包必须与主版本对齐，装的时候显式带版本号，npm 的 `latest` 未必对得上：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-web-fetch-http@0.1.5-rc.1
```

## 安装

插件已发布到 [npmjs](https://www.npmjs.com/package/dsh-kenari-plugin)，用 dsh 自己的插件命令装：

```sh
dsh plugin --profile web add dsh-kenari-plugin
dsh --profile web --dump-config | grep -A3 dsh-kenari-plugin   # 确认 patch 层生效
dsh --profile web
```

要固定版本就在包名后加，例如 `dsh-kenari-plugin@0.1.1`。改插件源码时换成 clone 安装：`pnpm install && pnpm build`，再 `dsh plugin --profile web add "$PWD"`，之后改源码只需重新 `pnpm build`。

## 升级

同一条 `add` 命令，带上版本号就是升级：

```sh
dsh plugin --profile web add dsh-kenari-plugin@0.2.3
dsh --profile web --dump-config | grep -A3 dsh-kenari-plugin   # 确认换过来了
dsh --profile web
```

装完要重启 dsh：插件的 Host 侧与客户端 bundle 都是加载时定版的。升级只替换 profile 里那一份依赖，`~/.dsh/settings.yaml` 里的模型路由、密钥引用名、会话标题这些设置都不动，所以不需要重新配。

不带版本号装的是 npm 的 `latest`；`npm view dsh-kenari-plugin version` 看当前发布的版本，仓库每版都打 `vX.Y.Z` 的 tag。要退回旧版就把版本号换成旧的再 add 一次。刚发布的版本 pnpm 会自己加进 profile 的 `pnpm-workspace.yaml`（`minimumReleaseAgeExclude`），不用手动处理。

## 配置密钥

在 Kenari 面板的 API keys → Create key 生成 `kn-...`（只显示一次），然后二选一：

- 打开 **Settings → 模型 → Kenari 卡片**，在密码框里填入
- 写 `.env`（凭据层可写）：

```sh
# ~/.dsh/.env
KENARI_API_KEY=kn-...
```

不要写进 `cordis.patch.yml`。设置文档只存引用名，值不进日志、界面与配置。

## 会话模型

装上后 Settings → Models 里会多出 Kenari 路由。

### 默认路由

默认模型由 key 的套餐决定。插件加载时读 `GET /v1/account/quota` 拿套餐名，取该套餐的 `free_cache_models`（缓存读取不占套餐额度）写进路由。只写一次，之后这层归你。

读不到套餐时（没配 key、分享页 key 被 403、账户没有套餐）用内置兜底清单，它正好是 Kreator 与 Studio 两档的免缓存清单：

| 模型 id | 显示名称 | 上下文 | 最大输出 | 备注 |
| --- | --- | --- | --- | --- |
| `deepseek-v4-flash` | Kenari DeepSeek v4 Flash | 1M | 64K | reasoning low/high/max |
| `glm-5-3-flash` | Kenari GLM 5.3 Flash | 1M | 64K | 视觉，reasoning low/high/max |
| `gpt-5-6-luna` | Kenari GPT 5.6 Luna | 872k | 64K | 视觉 + PDF，6 档 reasoning |
| `mimo-v2-5` | Kenari MiMo v2.5 | 1.05M | 64K | 视觉 + 音频 + 视频 |

四个都不是免费模型，**没有余额的新账户第一次会话会拿到 402**，先加一个 `:free` 模型或充值。`:free` 模型默认不进路由，用挑选器里的「免费」筛一下再加。

显示名称与最大输出由插件推导（目录里都没有）：名称先还原自 id（目录自己带 `name` 的那几个模型照抄厂商写法）；**写进路由**的名字再统一加 `Kenari ` 前缀——dsh 的模型按钮和会话头部只有名字一个字段，不带前缀就分不出它是 Kenari 路由还是官方 DeepSeek 的同名模型；插件自己那一页的模型表不加前缀，整页都在 Kenari 节里，再加一遍是噪音。最大输出取窗口的 1/4 并夹在 [1K, 64K]，不公布窗口的模型不写这个字段。名称只用于展示，模型身份始终是 id。

你手动改过列表之后，用户配置整份覆盖预设（pi-ai 的语义），插件不再改。

### 按能力和套餐挑模型

**Settings → 模型 → Kenari → 编辑 → 模型目录**里，「添加模型」和「获取可用模型」是同一个入口，都开这台挑选器。它用 dsh 自己的对话框组件，只多了筛选维度：

- 每行显示模型 id 与能力标签（`image` `audio` `video` `pdf` `embedding`），付费模型另带「套餐内」标签，表示被某个订阅套餐覆盖。免费模型看 id 的 `:free` 后缀
- 过滤片有 `套餐内` `免费` 与各能力标签。「套餐内」与「免费」互斥，`embedding` 独占（它没有 chat 端点，混选只会得到空列表），其余可多选
- 「添加所选」**追加**到现有条目之后，已在路由里的行不能再勾

写入是即时的：挑选器写完即关，卡片里当场多出那几行。卡片其余部分同理——显示名、API 地址、协议，以及每行的 id／显示名／上下文窗口／最大输出，都在改完（停止输入）后立即写入；删除一行与「恢复默认模型」也是点完即生效。正因如此，「取消／保存」被挪到 API 密钥字段下方，只负责提交密钥（密钥框为空时这两个按钮不显示）。数据由 Host 侧算好（`GET /api/kenari.models`），与 `kenari_list_models` 同源，没有 key 也能看。

### 三条协议线与兼容预设

Kenari 有三条线，base URL 形状不同，写错返回 405 而不是 404：

| pi-ai 的 `api` | base URL |
| --- | --- |
| `openai-completions` | `https://kenari.id/v1` |
| `openai-responses` | `https://kenari.id/v1` |
| `anthropic-messages` | `https://kenari.id`（不带 `/v1`） |

自建路由时照抄这四条兼容设置（已写在 `cordis.patch.yml`）：

- `maxTokensField: max_tokens`。Kenari 只读 `max_tokens`，发 `max_completion_tokens` 会返回 200 但静默忽略
- `supportsDeveloperRole: false`，系统提示词继续用 `system` 角色
- `supportsUsageInStreaming: true`，流式最后一帧带 `usage`，`cached_tokens` 计量靠它
- `reasoningEfforts` 的键只能用 `off|minimal|low|medium|high|xhigh|max`，Kenari 的 `none` 映射成 `off`。键写错会让 dsh 启动失败，改完先 `--dump-config`

## web 搜索与抓取

`searchProvider` 与 `fetchProvider` 都钉到 `kenari-fallback`：先打 Kenari，失败（含 401/402/403 与网络错误）回退 `deepseek-official` 和本地匿名 `http`，日志给出方向、原因与耗时。

`available()` 的契约禁止发网络请求，所以 Kenari 不可用只能等调用失败才发现，用户会多等一次。不想要这层替换，把 `fallbackEnabled` 设为 `false`（需重启）。

## 模型调用失败自动恢复

Kenari 路由上的会话模型调用失败后自动恢复：

1. 按固定 5 秒间隔重试 5 次，**同一条路由**上重发，预算按路由计算
2. 用尽后换一个窗口不小于当前模型的模型，先在同一个 provider 内挑最小的够用者，没有候选再跨 provider
3. 仍失败则回退 dsh 的默认 provider 与模型

三步都失败这一轮才报错。重试与换模型都在同一个 step 内，任务不中断，插件不会再发「继续」消息。换模型不继承 `reasoningEffort`（档位按模型定义），换完注入一条说明，可用 `modelSwitchNoticeEnabled` 关掉；重试开始时也会注入一条说明（重试期间界面上只有一次失败的尝试，不解释就是一个没有理由的等待），可用 `modelRetryNoticeEnabled` 关掉。手动 `/model` 会清除自动切换。

`CONTEXT_WINDOW_EXCEEDED` 刻意不在可重试集里：同模型同上下文重试必然再失败，直接进换模型阶段，而这一步往往正是恢复生效的地方。

两处限制：

- **重试由插件自己的恢复状态机执行，Kenari 路由上 dsh 自带的 `dsh-llm-retry` 被刻意关掉**（`cordis.patch.yml` 里 `providers.kenari.retryPolicy.maxRetries: 0`，插件自带适配器同理）。原因是它**会静默失效**：`agent/request-error` 是没有默认行为的瀑布，不调用 `next()` 的监听器会否决它后面的一切，而插件无法观察自己的注册顺序有没有被 live reload 之类的动作翻过来。实测线上会话里 `llm/retry` 事件数为 0、换模型发生在第一次失败上，承诺的重试从未执行。因此重试的预算只有一个来源：`modelRetryMaxRetries` / `modelRetryDelayMs` / `modelRetryableCodes`。如果你把该路由的 `retryPolicy` 改回大于 0，插件会在这条路由上让位给 dsh，两条机制不会各数一遍（`test/retry-repro.mjs` 的三个场景守着这条边界）。
- **`TRANSPORT` 类失败在服务端可能已经完成并计费**，重试会重复扣费。介意就把 `modelRetryableCodes` 调小。这与生成类端点的「超时不重试」是两回事。

字段与默认值见「配置项」。

## 会话标题前缀

新会话标题默认带 `20260911174258-` 形式的前缀，时间取本会话第一条人类消息的时间（本机时区）。前缀由插件写进 `session/title` 事件，Web、TUI、headless 看到同一个字符串。

时间不用 `session.header.createdAt`（它记的是会话记录创建时间，dsh 复用空白会话时可能比真正开口早几个小时），完全没有人类消息时才退回它。

前缀是标题文本的一部分，不是独立的显示层。所以开关控制的是生成时写不写：关掉后新标题不带前缀，关闭期间落盘的标题文本本身就不含前缀；已有会话不会被回溯修改，改开关或模板都不会。

LLM 标题、确定性 fallback、手动 rename 一视同仁。fork 继承父标题时，前缀换成子会话自己的开始时间（父会话历史不计）。

三点注意：

- `sessionTitleMaxBytes` 必须与 `cordis.patch.yml` 里 `session-title` 行的 `maxTitleBytes` 一致。插件直接写标题事件，dsh 不会替它截断
- 模板没有转义，`yyyy`、`MM` 这类子串一律替换；剥旧前缀按「当前模板 + 对应会话的开始时间」重放。模板在父会话与 fork 之间被改过、或父会话已不在 store 里，会留下双前缀
- 侧边栏里已存的旧前缀是缓存值，重启 dsh 并打开那个会话，它会自动校正

字段与默认值见「配置项」。

## 计费与预算

工具每次带一行费用回显：响应里有 `cost_micro_idr` 就写实际扣费，没有的（图像、视频、语音）按目录 `pricing_lines` 单价乘数量写预估。非 token 单位按整单位上取（21 字符的 TTS 计 1 个「1k 字符」单位）。

`kenari_billing` 给会话累计、分工具与分模型、`cached_tokens` 命中率、预算余量、钱包余额；余额低于 `lowBalanceAlertRp` 时费用回显附一条告警。`budgetCapRp` 默认 0（不封顶），到顶后花费型工具会被拒绝。预检只看已记录的花费，所以它是「不再新增花钱调用」，不是「保证总额不超」。402、401、405、403 都带了可执行建议。

## 设置页

Settings → **Kenari**（命名空间 `kenari`）。分组顺序就是使用顺序：

| 分组 | 内容 |
| --- | --- |
| 密钥 | 只显示状态与名字（已配置/缺失、来源、可修改性、只读引用名），没有输入框 |
| 模型 | 当前路由可用的模型：ID、显示名称、上下文。默认只列前 3 个 |
| 会话标题 | 开关、前缀格式、长度上限 |
| 高级设置（默认折叠） | API 地址、超时、重试次数、缓存时长、余额提醒阈值 |
| 重启后生效（默认折叠） | 加载时定型的开关（是否注册搜索/抓取/工具、预算封顶、自带适配器）。只读，改它们要编辑对应设置节并重启 dsh |
| 余额与用量 | 数字随用量变化，页面不存快照，只给一句可以直接照着问的话 |

文案有中英两套，跟随 dsh 的语言设置切换；`pnpm build` 会断言两边键集一致。

## 工具一览

| 类别 | 工具 |
| --- | --- |
| 目录与文档 | `kenari_list_models`（免费分组、价格、上下文、下线与 beta 告警；不需要 key）、`kenari_search_docs`（同样不需要 key） |
| 账户 | `kenari_balance`、`kenari_usage`、`kenari_quota`（分享页 key 会 403） |
| 搜索 | `kenari_x_search` |
| 文档 | `kenari_ocr`（`reuse_id` 复用免费） |
| 媒体 | `kenari_image_generate`、`kenari_image_edit`、`kenari_speech`、`kenari_transcribe`、`kenari_music`、`kenari_video_generate`、`kenari_video_extend`、`kenari_video_status`、`kenari_video_content` |
| 数据 | `kenari_embed`、`kenari_rerank`、`kenari_moderate` |
| 上下文与计费 | `kenari_count_tokens`、`kenari_billing` |

图像、音频、视频经 `ctx.attachments` 落盘成 image/file block，不塞进 JSON。

公开目录里没有 music 与 moderation 模型，所以 `kenari_music` 和 `kenari_moderate` 只会返回 400；`kenari_speech` 用 `mimo-v2-5-tts` 可用，`kokoro-tts` 与 `gemini-3-1-flash-tts` 是上游 400。

## 可选：插件自带的 LlmAdapter

`llm-pi-ai` 预设已经能把 Kenari 当会话模型用。把 `nativeAdapterEnabled` 设为 `true`（需重启）还能得到：模型选择器里直接看到价格、token 计量与 `cached_tokens` 命中率进 `kenari_billing`、推理档位按目录原样暴露（含 `none`）。

它注册的路由默认叫 `kenari-direct`，与预设的 `kenari` 不同名，两条可以并存，关掉开关即回退。相比预设，它不回放思考块、不注入 `file-parser`（文件块投影成说明文本，读文档请用 `kenari_ocr`）、不映射 `web_search_options`；图像输入是支持的。

```yaml
- id: kenari
  config:
    nativeAdapterEnabled: true
    nativeProviderId: kenari-direct
```

## 故障排查

| 症状 | 原因与处置 |
| --- | --- |
| 401 `invalid api key` | key 失效；`.env` 改完没重启 dsh；凭据引用名写错 |
| 402 `insufficient_balance` | 用了付费模型但余额为 0。切 `:free` 模型或充值 |
| 405 | base URL 形状错，见「三条协议线」 |
| 启动报 `invalid config ... reasoningEfforts` | 该模型的 `reasoningEfforts` 键不在 `off..max` 里，改回或从预设删掉该模型 |
| 403（balance / usage / quota） | key 来自分享页，这三个工具读 key 所有者的账户数据，所以被拒 |
| 设置页 Kenari 卡片空白 | 客户端 bundle 没构建或服务名写错。跑 `pnpm build` 再重启 |
| 导航里 Kenari 那行还是齿轮图标 | 图片没加载成功。确认包内含 `assets/kenari-favicon-128.png`，且 `GET /api/kenari.favicon` 能通 |
| 模型列表是空的 | 预设未生效，`dsh --profile web --dump-config` 看 `llm-pi-ai` 段是否存在 |

## 可选：只用 MCP，不装插件

Kenari 自带 Streamable HTTP MCP server（8 个工具，名字带 `mcp__kenari__` 前缀），配置如下：

```json
{ "mcpServers": { "kenari": { "url": "https://kenari.id/mcp", "headers": { "Authorization": "Bearer kn-..." } } } }
```

代价是工具名带前缀、没有计费可视与余额预警、多一个运行时依赖。MCP 只适合先试一下。

## 卸载

```sh
dsh plugin --profile web remove dsh-kenari-plugin
```

注册的一切都挂在 Cordis fiber 上，卸载即回收；dsh 的包与配置没有被改过。

## 配置项

多数可以在 Settings → Kenari 里改，标（重启）的要改对应设置节并重启。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `apiKeyEnv` | `KENARI_API_KEY` | 存放 key 的凭据引用名 |
| `baseURL` | `https://kenari.id` | 插件调用 REST API 的地址 |
| `timeoutMs` | `30000` | 单次 REST 请求超时 |
| `generationTimeoutMs` | `180000` | 生成类调用（图像/音频/音乐/OCR）的单次超时 |
| `maxRetries` | `2` | 瞬时失败的 REST 重试次数 |
| `searchEnabled` | `true` | 注册搜索 provider（重启） |
| `fetchEnabled` | `true` | 注册抓取 provider（重启） |
| `fallbackEnabled` | `true` | Kenari 失败时回退 dsh 默认（重启） |
| `toolsEnabled` | `true` | 注册 21 个工具（重启） |
| `docsCacheTtlMs` | `3600000` | `/llms-full.txt` 缓存时长 |
| `catalogCacheTtlMs` | `3600000` | `/v1/models` 缓存时长 |
| `modelAliases` | `{}` | 模型别名，`{ 别名: '精确模型 id' }` |
| `lowBalanceAlertRp` | `5000` | 低于这个卢比数就告警，0 关闭 |
| `balanceCacheTtlMs` | `300000` | 余额缓存时长 |
| `budgetCapRp` | `0` | 单会话花费上限，0 不封顶 |
| `nativeAdapterEnabled` | `false` | 注册自带 LlmAdapter（重启） |
| `nativeProviderId` | `kenari-direct` | 自带适配器的路由 id |
| `modelRecoveryEnabled` | `true` | 失败自动恢复总开关 |
| `modelRecoveryProviders` | `['kenari','kenari-direct']` | 参与恢复的路由 |
| `modelRetryMaxRetries` | `5` | 每条路由的额外重试次数 |
| `modelRetryDelayMs` | `5000` | 每次重试前的固定等待 |
| `modelRetryableCodes` | `EMPTY_RESPONSE` `RATE_LIMIT` `SERVER` `TIMEOUT` `TRANSPORT` | 可重试的失败码，不能为空 |
| `modelRetryNoticeEnabled` | `true` | 开始重试时注入通知 |
| `modelSwitchEnabled` | `true` | 是否换模型 |
| `modelSwitchDelayMs` | `5000` | 换模型或回退前的等待 |
| `modelSwitchSkipCodes` | `AUTH` `INVALID_CREDENTIAL` `MISSING_CREDENTIAL` `QUOTA` | 跳过同 provider 换模型，直接回退 |
| `modelSwitchNoticeEnabled` | `true` | 换模型时注入通知 |
| `sessionTitlePrefixEnabled` | `true` | 标题前缀开关 |
| `sessionTitlePrefix` | `yyyyMMddHHmmss-` | 前缀模板 |
| `sessionTitleMaxBytes` | `96` | 前缀加正文的字节上限 |

## 开发

```sh
pnpm build                      # tsc → lib/，并跑客户端 bundle 自检
node test/real-harness.mjs      # 真实 dsh harness（需要真 key）
node test/llm-adapter.mjs       # 本地假网关，不联网不花钱
# 离线套件：session-title / catalog-view / default-route / favicon，各一个 .mjs
node test/billed-media.mjs      # 会真花钱：TTS + STT，约 Rp 500
KENARI_ALLOW_VIDEO=1 node test/billed-video.mjs   # 会真花钱：4s 视频，约 Rp 1.400
```

`scripts/check-client.mjs` 随 `pnpm build` 运行，校验客户端 bundle 的注册格式、导出面、依赖声明与命名空间，并真实渲染一次卡片组件（手写的 bundle 没有打包器，这些就是它的编译期检查）。设计与实测记录在 `docs/` 下，面向要改这个插件的人。

## 开发环境与致谢

这个插件在 **ZCode** 里写的，会话模型主要用 opencode 的 DeepSeek V4.1 Flash 和 Kenari 的 `deepseek-v4-flash`。写它要反复读 dsh 的源码并跨文件改，选这两个是因为都扛得住长上下文。

如果你也想搭一套类似的组合，可以参考我实际在用的这两个：

- **[Kenari](https://kenari.id/code/KNR-KKRNAJ)**：一个 key 打通多个厂商的模型，目录七十多个，从 DeepSeek、GLM、GPT 到语音、图像、视频、OCR、嵌入和重排；OpenAI 兼容、Anthropic 兼容与 Responses 三条协议线，现成客户端改个 base URL 就能接。按量付费与包月套餐都有，账单是印尼盾，充值门槛低（QRIS 最低 Rp 1.000）。目录与文档是公开端点，没有 key 也能先看清有什么。
- **[opencode Go](https://opencode.ai/go?ref=343F5JW4RA)**：$10 一个月，按 5 小时窗口给额度，不用逐 token 算钱，不够还能单独充值。它能配任何 agent，所以我拿它跑 dsh 的会话模型。

两个都支持支付宝扫码支付。

## License

MIT，见 [LICENSE](LICENSE)。
