# dsh-kenari-plugin

[English](README.en.md) | 中文

把 [Kenari](https://kenari.id)（kenari.id）接进 DeepSeek Harness（dsh）：

- Kenari 的模型可以当 dsh 的会话模型，默认路由按你 key 的套餐自动决定
- 搜索与抓取优先走 Kenari，失败回退 dsh 自带的 provider
- 21 个 REST 能力注册成 agent 工具：目录、账户、搜索、OCR、图像、音频、视频、嵌入、重排、审核、计费、token 计数
- 新会话标题带本机时间前缀，模板可改、可关
- Settings → Kenari 一页管完：凭据状态、运行参数、模型目录

所有能力都通过 dsh 的 bundle patch 层和公开 seam（`ctx.web`、`ctx.settings`、`ctx.tools`）注册，没有改动 dsh 的任何代码或配置。

## 前提

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| dsh | `0.1.5-rc.1` | 全局安装，`dsh` 在 PATH |
| Node.js | >= 22 | 与 `package.json` 的 `engines` 一致 |
| pnpm | 可用即可 | `dsh plugin` 底层转发给它，必需 |

dsh 的子包必须和主版本对齐，装的时候显式带版本号。npm 上的 `latest` 未必是 `0.1.5-rc.1`：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-web-fetch-http@0.1.5-rc.1
```

## 安装

`lib/` 不进版本库，所以要先 clone 再编译，不能直接 `dsh plugin add github:...`：

```sh
git clone https://github.com/ryan-yuan-dev/dsh-kenari-plugin.git
cd dsh-kenari-plugin
pnpm install
pnpm build

dsh plugin --profile web add "$PWD"
dsh --profile web --dump-config | grep -A3 dsh-kenari-plugin   # 确认 patch 层生效
dsh --profile web
```

装好之后 profile 里是 pnpm link，改源码只需重新 `pnpm build`，不用再 add 一次。

## 配置密钥

1. 在 Kenari 面板的 API keys → Create key 生成 `kn-...`（只显示一次）
2. 写进凭据层，两种方式都行：
   - 打开 **Settings → 模型 → Kenari 卡片**，在密码框里填入
   - 或者写 `.env`（凭据层可写）：

```sh
# ~/.dsh/.env
KENARI_API_KEY=kn-...
```

不要写进 `cordis.patch.yml`。设置文档里只保存引用名（`KENARI_API_KEY`），值不会进日志、界面或配置。

## 会话模型

装上后 Settings → Models 里会多出 Kenari 路由。

### 默认路由

默认模型由你 key 的套餐决定。插件加载时读 `GET /v1/account/quota` 拿套餐名，从套餐表取该套餐的 `free_cache_models`（这些模型的缓存读取不占套餐额度），写进路由的模型列表。只写一次，之后这层归你，插件不再动。

读不到套餐时（没配 key、分享页 key 被 403、账户没有套餐）用内置兜底清单：

| 模型 id | 显示名称 | 上下文 | 最大输出 | 备注 |
| --- | --- | --- | --- | --- |
| `deepseek-v4-flash` | DeepSeek v4 Flash | 1M | 64K | reasoning low/high/max |
| `glm-5-3-flash` | GLM 5.3 Flash | 1M | 64K | 视觉，reasoning low/high/max |
| `gpt-5-6-luna` | GPT 5.6 Luna | 872k | 64K | 视觉 + PDF，6 档 reasoning |
| `mimo-v2-5` | MiMo v2.5 | 1.05M | 64K | 视觉 + 音频 + 视频 |

这份兜底正好是 Kreator 与 Studio 两档的免缓存清单，所以这两个套餐不会触发写入。

显示名称和最大输出都是插件推出来的，Kenari 的目录里两者都没有：名称由 id 还原（目录只给 8 个非会话模型写了 `name`），最大输出按上下文窗口的 1/4 取整到 1K、上限 64K，不公布窗口的模型不写这个字段。名称只是展示用，不参与请求，随时可以自己改。

`:free` 模型默认不进路由。想用就在挑选器里按「免费」筛一下再加。注意上面四个都不是免费模型，**没有余额的新账户第一次会话会拿到 402**，先加一个 `:free` 模型或充值。

你手动改过模型列表之后，显式的用户配置整份覆盖预设（pi-ai 的语义），插件不会再改。

### 按能力和套餐挑模型

目录里有 80 个模型，路由里默认只有 4 个。**Settings → 模型 → Kenari → 编辑 → 模型目录**里的「添加模型」和「获取可用模型」是同一个入口，点哪个都开这台挑选器：对 Kenari 来说目录就是事实来源，手打一个 id 只会绕过它。

对话框、按钮、标签都用 dsh 自己的组件，所以它就是 dsh 那个「选择要添加的模型」对话框，只是多了几个筛选维度：

- 每行显示模型 id、能力标签（`image` / `audio` / `video` / `pdf` / `embedding`），付费模型还会带一个「套餐内」标签，表示它被某个订阅套餐覆盖。免费模型不打这个标签，看 id 的 `:free` 后缀即可
- 过滤片：`套餐内` `免费` `image` `audio` `video` `pdf` `embedding`，外加「全选可见」「清除筛选」。`套餐内` 与 `免费` 互斥，`embedding` 独占（embedding 模型没有 chat 端点，混选只会得到空列表），其余能力过滤片可多选、同时满足
- 勾选后「添加所选」**追加**到现有条目之后，不覆盖。已在路由里的行不能再勾，那一格用 `✓` 代替

写入是即时的。插件够不到编辑器的草稿，所以点「添加所选」时就已经落进设置文档了，不需要再点保存。副作用是同一张卡里的模型列表在重新展开「编辑」之前显示的还是旧值，收起再展开即可刷新。

挑选器的数据由 Host 侧算好（`GET /api/kenari.models`），浏览器只渲染，和 `kenari_list_models` 报的是同一套事实。目录与套餐表都读公开端点，没有 key 也能看。

### 三条协议线与兼容预设

Kenari 同时提供三条线，base URL 形状不同，写错返回 405 而不是 404：

| pi-ai 的 `api` | base URL |
| --- | --- |
| `openai-completions` | `https://kenari.id/v1` |
| `openai-responses` | `https://kenari.id/v1` |
| `anthropic-messages` | `https://kenari.id`（不带 `/v1`） |

自建路由时这四条兼容设置要照抄，它们已写在 `cordis.patch.yml` 里：

- `maxTokensField: max_tokens`。Kenari 只读 `max_tokens`，发 `max_completion_tokens` 会返回 200 但静默忽略，输出上限直接失效
- `supportsDeveloperRole: false`，系统提示词继续用 `system` 角色
- `supportsUsageInStreaming: true`，流式最后一帧带 `usage`，`cached_tokens` 计量靠它
- `reasoningEfforts` 的键只能用 dsh 的 `off|minimal|low|medium|high|xhigh|max`，Kenari 报的 `none` 映射成 `off`。键写错会让 dsh 直接启动失败，改完预设先 `dsh --profile web --dump-config` 再启动

## web 搜索与抓取

安装后 `searchProvider` 和 `fetchProvider` 都被钉到 `kenari-fallback`：先打 Kenari，失败（含 401/402/403 与网络错误）回退 `deepseek-official` 和本地匿名 `http`，日志里给出方向、原因和耗时。

`available()` 的契约禁止发网络请求，所以 Kenari 真的不可用时只能等调用失败才发现，用户会感知一次额外延迟。不想要这层替换，把 `fallbackEnabled` 设为 `false`（需重启）。

## 模型调用失败自动恢复

Kenari 路由（`kenari` 与 `kenari-direct`）上的会话模型调用失败后自动恢复，不需要人工介入：

1. 按固定 5 秒间隔重试 5 次。这一步由 dsh 自带的 `dsh-llm-retry` 执行，会话里留下 `llm/retry` 记录，界面显示「正在重试」
2. 用尽后换一个上下文窗口不小于当前模型的模型，先在同一 provider 内挑最小的够用者，没有候选再跨 provider 找
3. 换模型仍失败，回退 dsh 的默认 provider 与模型

三步都失败，这一轮才以错误结束。重试与换模型发生在同一个 step 内，任务不中断，插件不会再发「继续」消息。

换模型不继承原模型的 `reasoningEffort`（档位按模型定义，跨模型搬运可能非法），换完会往会话注入一条说明，可用 `modelSwitchNoticeEnabled` 关掉。你手动 `/model` 选模型会清除自动切换。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `modelRecoveryEnabled` | `true` | 总开关 |
| `modelRecoveryProviders` | `['kenari','kenari-direct']` | 参与恢复的路由，范围外行为不变 |
| `modelRetryMaxRetries` | `5` | 额外重试次数（`kenari-direct` 路由） |
| `modelRetryDelayMs` | `5000` | 每次重试前的固定等待 |
| `modelRetryableCodes` | `EMPTY_RESPONSE` `RATE_LIMIT` `SERVER` `TIMEOUT` `TRANSPORT` | 可重试的失败码，不能为空 |
| `modelSwitchEnabled` | `true` | 关掉则只重试 |
| `modelSwitchDelayMs` | `5000` | 换模型或回退前的等待 |
| `modelSwitchSkipCodes` | `AUTH` `INVALID_CREDENTIAL` `MISSING_CREDENTIAL` `QUOTA` | 跳过同 provider 换模型，直接回退 provider |
| `modelSwitchNoticeEnabled` | `true` | 换模型时是否注入通知 |

`CONTEXT_WINDOW_EXCEEDED` 刻意不在可重试集里：同模型同上下文重试必然再失败，这类错误直接进换模型阶段，而这一步往往正是恢复生效的地方。

两处限制：

- **`llm-pi-ai` 路由的重试参数取自 `cordis.patch.yml` 的 `providers.kenari.retryPolicy`，不是上面的插件配置。** dsh 在适配器注册时就冻结了路由的重试策略，插件改不了。patch 里的默认值与上表一致，改一个记得改另一个。
- **`TRANSPORT` 类失败在服务端可能已经完成并计费**，重试会造成第二次计费。介意就把 `modelRetryableCodes` 调小。这与生成类端点的「超时不重试」是两回事，那条规则管的是按次计费的 REST 端点。

## 会话标题前缀

新会话的智能标题默认带一个 `20260911174258-` 形式的前缀，方便在会话列表里按时间辨认。时间取本会话第一条人类消息的时间，本机时区。前缀由插件在服务端写进 `session/title` 事件，所以 Web、TUI、headless 看到的是同一个字符串。

时间不用 `session.header.createdAt`：dsh 会复用空白会话，那条记录可能在打开工作区时就已经建好，比真正开口早几个小时。没有任何人类消息时才退回记录创建时间。

前缀是标题文本的一部分，不是独立的显示层。dsh 的标题事件 schema 固定为 `{ title, messageSeqs, source }`，没有前缀字段，界面就是把这个字符串原样画出来。所以开关控制的是生成时写不写，而不是「存着不显示」：

- 开关关闭后新标题不带前缀；关闭期间落盘的标题，文本本身就不含前缀，复制和导出也没有
- 已有会话不会被回溯修改，改开关、改模板都不会

前缀对所有来源一视同仁：LLM 智能标题、确定性 fallback、手动 rename 都加。fork 子会话继承父标题时，前缀会换成子会话自己的开始时间（继承来的父会话历史不计）。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `sessionTitlePrefixEnabled` | `true` | 生成标题时是否写入前缀 |
| `sessionTitlePrefix` | `yyyyMMddHHmmss-` | 模板，token 为 `yyyy` `MM` `dd` `HH` `mm` `ss`（本机时区），其余字符原样；不含 token 就是字面前缀，如 `kenari-` |
| `sessionTitleMaxBytes` | `96` | 前缀加正文的 UTF-8 总字节上限 |

三点注意：

- `sessionTitleMaxBytes` 必须和 `cordis.patch.yml` 里 `session-title` 行的 `maxTitleBytes` 保持一致。插件直接写标题事件，dsh 不会替它截断；patch 那一侧是让 dsh 自己的 provider 与 fallback 路径守同一个上限
- 模板没有转义。`yyyy`、`MM` 这类子串一律按 token 替换，剥旧前缀时按「当前模板 + 对应会话的开始时间」精确重放。两种罕见情况会留下双前缀：模板在父会话与 fork 之间被改过，或父会话已不在 store 里。纯字面前缀（如 `fix-`）在正文恰好同前缀开头时也可能被误剥一次
- 侧边栏里已存的旧前缀是缓存值。修复后重启 dsh 并打开那个会话，它会自动校正

## 计费与预算

工具每次带一行费用回显：响应里有 `cost_micro_idr` 就写实际扣费，没有回显的（图像、视频、语音）按目录 `pricing_lines` 单价乘数量写预估并说明口径。非 token 单位按整单位上取，比如 21 字符的 TTS 计 1 个「1k 字符」单位。

`kenari_billing` 给会话累计、分工具与分模型、token 与 `cached_tokens` 命中率、预算余量、钱包余额。余额低于 `lowBalanceAlertRp`（默认 Rp 5.000）时，费用回显后会附一条告警。

预算封顶由 `budgetCapRp` 控制，默认 0 表示不封顶。到顶后花费型工具会被拒绝，并给出「改免费模型 / 提高上限」的建议。预检只看已记录的花费，所以它是「不再新增花钱调用」，不是「保证总额不超」。

402 `insufficient_balance`、401、405、403 等错误都带了可执行建议，直接读错误文案即可。

## 设置页

Settings → **Kenari**（Host 半边注册的命名空间是 `kenari`）。分组顺序就是使用顺序：

| 分组 | 内容 |
| --- | --- |
| 密钥 | 只显示状态与名字：已配置/缺失、来源、可修改性，以及只读的「密钥引用名」。这一组没有输入框，密钥的值由 dsh 的密码框写入 |
| 模型 | 当前路由可用的模型，三列：模型 ID、显示名称、上下文。默认只列前 3 个，其余用「展开全部」打开 |
| 会话标题 | 开关、前缀格式、长度上限，不折叠 |
| 高级设置（默认折叠） | API 地址、超时、重试次数、几个缓存时长、余额提醒阈值。多数只设置一次 |
| 重启后生效（默认折叠） | 在插件加载时定型的开关（是否注册搜索/抓取/工具、预算封顶、自带适配器）。只读，布尔读作「已开启/已关闭」。改它们要编辑对应设置节并重启 dsh |
| 余额与用量 | 数字随用量变化，页面不存快照，只给出可以直接照着问的一句话 |

文案有中文和英文两套，跟随 dsh 的语言设置即时切换。字典在 `client/index.js` 的 `LOCALES` 里，`zh` 是键集真源，`en` 必须补齐同一组键，`pnpm build` 的自检会断言两者一致。

左侧导航里这一节的图标用 Kenari 自己的 mark。dsh 的 shell 按 section id 写死图标，而 section 注册项只有 `id / order / label`，插件加不进去，所以认领「标签是 Kenari 的那一行导航」再贴图标。图片经插件自己的同源路由 `GET /api/kenari.favicon` 递出。

## 工具一览

| 类别 | 工具 |
| --- | --- |
| 目录与文档 | `kenari_list_models`（免费分组、价格、上下文、下线与 beta 告警；不需要 key）、`kenari_search_docs`（同样不需要 key） |
| 账户 | `kenari_balance`、`kenari_usage`、`kenari_quota`（分享页 key 会 403，见下） |
| 搜索 | `kenari_x_search`（handles 互斥、≤20、日期校验） |
| 文档 | `kenari_ocr`（`reuse_id` 复用免费） |
| 媒体 | `kenari_image_generate`、`kenari_image_edit`、`kenari_speech`、`kenari_transcribe`、`kenari_music`、`kenari_video_generate`、`kenari_video_extend`、`kenari_video_status`、`kenari_video_content` |
| 数据 | `kenari_embed`、`kenari_rerank`、`kenari_moderate` |
| 上下文与计费 | `kenari_count_tokens`（窗口占比与压缩提示）、`kenari_billing` |

图像、音频、视频经 `ctx.attachments` 落盘成 image/file block，不塞进 JSON。

已知的模型侧空缺与工具无关：公开目录里没有 music 与 moderation 模型，所以 `kenari_music` 和 `kenari_moderate` 只会返回 400；`kenari_speech` 用 `mimo-v2-5-tts` 可用，`kokoro-tts` 与 `gemini-3-1-flash-tts` 是上游 400。

## 可选：插件自带的 LlmAdapter

`llm-pi-ai` 预设已经能把 Kenari 当会话模型用。若你还想要：

- 模型选择器里直接看到价格
- 会话 token 计量与 `cached_tokens` 命中率进 `kenari_billing`（预设路由下看不到这个数据源）
- 推理档位按目录原样暴露，含 `none`

就把 `nativeAdapterEnabled` 设为 `true`（需重启）。它注册的路由默认叫 `kenari-direct`，与预设的 `kenari` 不同名，两条路可以并存，关掉开关即可回退。

```yaml
- id: kenari
  config:
    nativeAdapterEnabled: true
    nativeProviderId: kenari-direct
```

相比预设它不做三件事：不回放思考块、不注入 `file-parser`（文件块投影成说明文本，读文档请用 `kenari_ocr`）、不映射 `web_search_options`。图像输入是支持的。

## 故障排查

| 症状 | 原因与处置 |
| --- | --- |
| 401 `invalid api key` | key 失效；环境变量没加载（改完 `.env` 要开新终端或重启 dsh）；凭据引用名写错 |
| 402 `insufficient_balance` | 用了付费模型但余额为 0。切免费模型（`kenari_list_models` 里 id 带 `:free`）或充值 |
| 405 | base URL 形状错：`openai-completions`/`openai-responses` 用 `https://kenari.id/v1`，`anthropic-messages` 用 `https://kenari.id` |
| dsh 启动报 `invalid config ... reasoningEfforts` | `reasoningEfforts` 的键不在 dsh 允许集合里。改回 `off..max`，或从预设里删掉该模型 |
| 403（balance / usage / quota） | key 来自分享页。这三个工具读 key 所有者的账户数据，所以被拒；消费类工具不受影响 |
| 设置页 Kenari 卡片空白 | 客户端 bundle 没构建或服务名写错。跑 `pnpm build`（含自检）再重启 |
| 设置导航里 Kenari 那行还是齿轮图标 | 图片没加载成功。确认包内含 `assets/kenari-favicon-128.png`（`package.json` 的 `files` 漏了 `assets` 就会这样），且 `GET /api/kenari.favicon` 能通 |
| 模型列表是空的 | 预设未生效。`dsh --profile web --dump-config` 看 `llm-pi-ai` 段是否存在 |

## 可选：只用 MCP，不装插件

Kenari 自带 Streamable HTTP MCP server（8 个工具，名字带 `mcp__kenari__` 前缀）：

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

代价是工具名带前缀、没有计费可视与余额预警、多一个运行时依赖。本插件的 21 个工具和余额预检都在，所以推荐插件路径，MCP 只适合先试一下。

## 卸载

```sh
dsh plugin --profile web remove dsh-kenari-plugin
```

插件注册的一切都挂在 Cordis fiber 上，卸载即回收；dsh 的包与配置没有被改过，不会留下残留。

## 配置项

全部字段及默认值。多数可以在 Settings → Kenari 里改，标「重启」的要在对应设置节里改并重启。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `apiKeyEnv` | `KENARI_API_KEY` | 存放 key 的凭据引用名 |
| `baseURL` | `https://kenari.id` | 插件调用 Kenari REST API 的地址 |
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
| `nativeAdapterEnabled` | `false` | 注册插件自带的 LlmAdapter（重启） |
| `nativeProviderId` | `kenari-direct` | 自带适配器的路由 id |
| `modelRecoveryEnabled` | `true` | 模型调用失败自动恢复总开关 |
| `modelRecoveryProviders` | `['kenari','kenari-direct']` | 参与恢复的路由 |
| `modelRetryMaxRetries` | `5` | 额外重试次数 |
| `modelRetryDelayMs` | `5000` | 每次重试前的固定等待 |
| `modelRetryableCodes` | 见上 | 可重试的失败码，不能为空 |
| `modelSwitchEnabled` | `true` | 是否换模型 |
| `modelSwitchDelayMs` | `5000` | 换模型或回退前的等待 |
| `modelSwitchSkipCodes` | 见上 | 直接回退 provider 的失败码 |
| `modelSwitchNoticeEnabled` | `true` | 换模型时注入通知 |
| `sessionTitlePrefixEnabled` | `true` | 标题前缀开关 |
| `sessionTitlePrefix` | `yyyyMMddHHmmss-` | 前缀模板 |
| `sessionTitleMaxBytes` | `96` | 前缀加正文的字节上限 |

## 开发

```sh
pnpm build                      # tsc → lib/，并跑客户端 bundle 自检
node test/real-harness.mjs      # 真实 dsh harness（需要真 key）
node test/llm-adapter.mjs       # 本地假网关，不联网不花钱
node test/session-title.mjs     # 会话标题前缀
node test/catalog-view.mjs      # 模型目录视图与挑选器
node test/default-route.mjs     # 默认路由决策
node test/favicon.mjs           # 图标路由
node test/billed-media.mjs      # 会真花钱：TTS + STT，约 Rp 500/次
KENARI_ALLOW_VIDEO=1 node test/billed-video.mjs   # 会真花钱：生成并下载 4s 视频，约 Rp 1.400
```

`scripts/check-client.mjs` 随 `pnpm build` 运行，校验客户端 bundle 的注册格式、导出面、模块依赖声明、命名空间，并真实渲染一次卡片组件。手写的 bundle 没有打包器，这些就是它的编译期检查。

设计与实测记录在 `docs/` 下（`plans/` 是设计文档与实施计划，`knowledge-base/` 是 dsh 与 Kenari 的接口实测），面向的是要改这个插件的人，不影响使用。

## 开发环境与致谢

这个插件在 **ZCode** 里写的，会话模型主要用 opencode 的 DeepSeek V4.1 Flash 和 Kenari 的 `deepseek-v4-flash`。写它要反复读 dsh 的源码并跨文件改，两个模型都扛得住长上下文，而 Kenari 按量计费，试错成本比按月订阅低。

如果你也想搭一套类似的组合，这两个是我实际在用的：

- **[Kenari](https://kenari.id/code/KNR-KKRNAJ)**。一个 key 打通多个厂商的模型，目录里有 80 个，从 DeepSeek、GLM、GPT 到语音、图像、视频、OCR、嵌入和重排。同时给 OpenAI 兼容、Anthropic 兼容和 Responses 三条协议线，现成的客户端改个 base URL 就能接。按量计费，账单直接是印尼盾，充值门槛低（QRIS 最低 Rp 1.000）。目录和文档都是公开端点，没有 key 也能先看清楚有什么再决定。
- **[opencode Go](https://opencode.ai/go?ref=343F5JW4RA)**。$10 一个月包月，按 5 小时窗口给额度，不用逐 token 算钱，额度不够还能单独充值。它能配任何 agent，所以我拿它跑 dsh 的会话模型。选它是因为写代码时的请求又多又碎，包月比按量计费好预测。

这两个都是推荐链接，通过它们注册我会拿到一点推荐奖励。

## License

MIT，见 [LICENSE](LICENSE)。
