# dsh-kenari-plugin

把 [Kenari](https://kenari.id)（kenari.id）接成 DeepSeek Harness（dsh）的一等公民：

- **会话模型**：Kenari 的模型可以当 dsh 的会话模型用，默认路由按你 key 的套餐自动填（见「选模型」）
- **web provider**：搜索与抓取走 Kenari 优先，失败回退 dsh 默认 provider
- **21 个工具**：OCR、图像、音视频、嵌入、重排、审核、账户、目录、计费、token 计数
- **会话标题前缀**：新会话标题默认带 `20260911153045-` 时间前缀，模板可自定义、可关闭（见「会话标题前缀」）
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
2. 写进凭据层。两种都行：
   - 在 **设置 → 模型 → Kenari 卡片**的密码框里填（写入 `KENARI_API_KEY` 这个凭据；插件设置页只显示它的状态，不提供输入框）
   - 或写 `.env` 形式（凭据层可写）：

```sh
# ~/.dsh/.env  （dsh 以 user-env 层加载；或写 $DSH_HOME/.credentials.yaml）
KENARI_API_KEY=kn-...
```

不要塞进 `cordis.patch.yml`。设置文档里只保存**引用名**（`KENARI_API_KEY`），值永远不进日志、UI 与配置。

## 选模型

装上后 Settings → Models 里会出现 **Kenari** 路由。**默认模型按你 key 的套餐决定**：插件在加载时读
`GET /v1/account/quota` 拿到套餐名，再从套餐表取该套餐的 `free_cache_models`（这些模型的缓存读取不占
套餐额度），把它写进路由——只写一次，之后这一层归你，插件不会再动。

读不到套餐（没配 key、分享页 key 被 403、账户没有套餐）时，用预置的兜底清单：

| 模型 id | 显示名称 | 上下文 | 最大输出 | 备注 |
| --- | --- | --- | --- | --- |
| `deepseek-v4-flash` | DeepSeek v4 Flash | 1M | 64K | reasoning low/high/max |
| `glm-5-3-flash` | GLM 5.3 Flash | 1M | 64K | 视觉，reasoning low/high/max |
| `gpt-5-6-luna` | GPT 5.6 Luna | 872k | 64K | 视觉 + PDF，6 档 reasoning |
| `mimo-v2-5` | MiMo v2.5 | 1.05M | 64K | 视觉 + 音频 + 视频 |

**显示名称与最大输出都是插件推出来的**（Kenari 的目录里两者都没有）：

- **显示名称**：目录只给 8 个模型写了 `name`，而且都不是会话模型（语音/图像/视频那些），
  所以会话模型的展示名由 id 还原：`glm-5-3-flash` → `GLM 5.3 Flash`、`gpt-5-6-luna` →
  `GPT 5.6 Luna`。规则用目录自己反测——Kenari 给出 `name` 的那 8 个，还原结果与厂商写法
  逐字一致（`veo-3.1-lite` → `Veo 3.1 Lite`、`minimax-speech-2-8-turbo` → `MiniMax Speech 2.8 Turbo`…）。
  它是纯展示字段（不参与请求），随时可以自己改。
- **最大输出 token**：目录里**没有**这个字段（对全部 76 行核对过），所以按**窗口的 1/4** 给推荐值，
  向下取整到 1K，上限 64K。一次回答最多占多少窗口的常见取法；厂商公开的比例在 6%（Gemini 2.5 的
  65k/1M）到 32%（Claude 的 64k/200k）之间，取 1/4 偏宽——写代码时"被截断"比"留得多"更常见。
  **不写**这个字段才是问题：整条路由会共用 pi-ai 的 `defaultMaxTokens`（32768），于是每个模型
  看到的都是同一个数、那个数是 dsh 的默认值而不是这个模型的推荐值。目录不公布窗口的模型
  （18 个，只有 `qwen3-8-max` 是会话模型）不写，没有窗口可依据时不编数。

这份兜底正好是 **Kreator 与 Studio** 两档的免缓存清单，所以这两档的账户（例如我们的实测账户）
算出来与预设一致，插件不会去写设置。

**`:free` 模型默认不进路由。** 想用它们：在上面那个挑选器里按 `免费` 筛一下再加，
或直接勾选加入。免费模型 id 都带 `:free` 后缀，一眼能认。

> ⚠️ 这四条都不是免费模型：**没有余额的新账户第一次会话会拿到 402**，请先在面板里加一个 `:free`
> 模型，或充值。这是"默认不用免费模型"的代价。

自己改过路由的模型列表之后，**用户层优先**（显式写在设置里的数组会整份替换预设，这是 pi-ai 的语义），
插件不会再覆盖你。

### 按能力与套餐挑模型

目录里有 80 个模型，路由里默认只有 4 个。**设置 → 模型 → Kenari → 编辑 → 模型目录** 里的
**「添加模型」和「获取可用模型」是同一个入口**——点哪个都打开这台挑选器，因为对 Kenari 来说目录就是
事实来源，手打一个 id 只会绕过它。它不是另加一块面板，而是把能力与套餐做进了 dsh 那个对话框本身：

- 对话框、按钮、标签都用 dsh 自己的组件（`Modal` / `Button` / `Tag`，来自 dsh 的浏览器基线模块），
  所以它就是那个「选择要添加的模型」对话框，只是多了筛选维度
- 每行只显示**模型 id**（不显示厂商给的可读名：id 才是请求与路由条目里用的那个字符串），
  后面跟着**能力标签**（`image` / `audio` / `video` / `pdf` / `embedding`），付费模型还会带一个
  `套餐内` 标签——表示它在订阅套餐的覆盖范围内。免费模型不打这个标签（看 id 的 `:free` 后缀即可），
  **也不显示套餐档位名**：这里只回答"订阅能不能用"
- 所有标签同一个样式（同一套灰底 chip：同字号、同底色、同圆角），不区分主次；标签永不压缩，
  一行放不下就换到下一行继续排（换行后仍与上一行标签左端对齐）
- 过滤：搜索框（匹配 id / 名称 / 厂商），以及 `套餐内` `免费` `image` `audio` `video` `pdf` `embedding`
  过滤片，外加「全选可见」「清除筛选」。`套餐内` 与 `免费` **互斥**——免费模型不可能同时在套餐覆盖
  范围内，两个都选只会得到空列表，所以选一个会放开另一个；`embedding` **独占**——它标的是另一个
  群体（embedding 模型没有 chat 端点），和任何其他维度同时选同样只会得到空列表，所以选它会清掉其他、
  选其他会清掉它；其余能力过滤片可多选，多个之间是**同时满足**。
  选中与未选中**共用同一个外框**，选中只改填充与字重（选中态与行内标签同一个底色）
- 勾选后点「添加所选」：**追加**到该路由现有模型之后，不会覆盖已有条目。
  已在路由里的行不能再勾，它那一格用 `✓` 代替勾选框——两者是同一个尺寸的盒子，所以整列对齐

> **写入是即时的。** 插件够不到编辑器的草稿（dsh 的「保存」走组件内部状态），所以点「添加所选」时
> 就已经写进设置文档了，不需要再点保存。副作用是同一张卡里编辑器的模型列表在**重新展开「编辑」之前
> 是旧的**——收起再展开即可刷新。dsh 自己的「重置模型目录」在编辑器开着时也是这个行为。

标签的口径：`套餐内` = 付费模型会从某个订阅套餐的额度扣费（没有这个标签的付费模型只能用预付余额 PAYG）；
能力标签按目录事实推导——`image/audio/video/pdf` 看 `modalities.input` 与 `endpoints`，
`embedding` 来自 `?modality=embedding` 目录。目录与套餐表都读**公开端点**，所以还没有 key 时也能看。

挑选器的数据由 Host 侧算好（`GET /api/kenari.models`），浏览器只渲染，
所以它和 `kenari_list_models` 报的是同一套事实。

> 入口是 dsh 自己渲染的那两颗按钮：插件用一个 document 捕获阶段的点击监听识别它们（**只认 Kenari 卡片
> 里**、标签是 dsh 自己的那两颗 —— 判定是"标记所在的卡片是否包含这个按钮"，所以 DeepSeek 等其它
> provider 卡上的同名按钮不受影响，原生行为照旧），改开上面这个对话框。dsh 的对话框**内部**没有给外部
> 插件的槽位，往里加字段只能改 dsh（红线禁止），所以插件接管的是**入口**。目录读取失败时，对话框里会
> 给出「改用 dsh 自带对话框」退回原生流程。
>
> 插件的设置页不再重复提供只读的目录浏览：那一页的定位是「配置 Kenari」，而挑模型属于模型页的事，
> 同一件事有两个入口只会让人犹豫该点哪个。

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

## 模型调用失败自动恢复

Kenari 路由（`kenari` 与 `kenari-direct`）的会话模型调用失败时自动恢复，不需要人工介入：

1. **重试**：按固定 5s 间隔重试 5 次。这一步由 dsh 自带的 `dsh-llm-retry` 执行，会话里会留下 `llm/retry` 记录，界面上显示为「正在重试」。
2. **换模型**：重试用尽后换一个上下文窗口 >= 当前模型的模型——先在同一 provider 内挑最小的够用者，同 provider 没有候选再跨 provider 找。
3. **回退默认 provider**：换模型仍失败，回退到 dsh 的默认 provider/model（当前是 `deepseek-official` / `deepseek-flash`）。

三步都失败，该轮才以错误结束。因为重试与换模型都发生在**同一个 step 内**，任务不会中断，
所以插件不会再发一条「继续」消息去重启任务。

换模型时不继承原模型的 `reasoningEffort`：档位是按模型定义的，跨模型直接搬可能非法。
换模型后会往会话注入一条 `notice` 消息说明这次切换，可用 `modelSwitchNoticeEnabled` 关掉。
你手动选模型（`/model`）会清除自动切换，人工选择优先。

### 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `modelRecoveryEnabled` | `true` | 总开关 |
| `modelRecoveryProviders` | `['kenari','kenari-direct']` | 参与恢复的路由 |
| `modelRetryMaxRetries` | `5` | 重试次数（`kenari-direct` 路由） |
| `modelRetryDelayMs` | `5000` | 每次重试前的固定等待 |
| `modelRetryableCodes` | `EMPTY_RESPONSE`/`RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT` | 可重试的失败码，不能为空 |
| `modelSwitchEnabled` | `true` | 关掉则只重试 |
| `modelSwitchDelayMs` | `5000` | 换模型/回退前的等待 |
| `modelSwitchSkipCodes` | `AUTH`/`INVALID_CREDENTIAL`/`MISSING_CREDENTIAL`/`QUOTA` | 跳过同 provider 换模型，直接回退 provider（同账号的问题换模型没用） |
| `modelSwitchNoticeEnabled` | `true` | 换模型时注入切换通知 |

`CONTEXT_WINDOW_EXCEEDED` **刻意不在**可重试集里：同模型同上下文重试必然再失败，
这类错误直接进换模型阶段。这一步往往正是恢复能生效的地方。

### 两个要知道的限制

- **重试参数在 `llm-pi-ai` 路由上取自 `cordis.patch.yml` 的 `providers.kenari.retryPolicy`**，
  不是上面的插件配置。dsh 在适配器注册时就冻结了路由的重试策略，插件改不了它；
  patch 里的默认值与上表一致，改一个要记得改另一个。
- **连接中断类失败（`TRANSPORT`）在服务端可能已经完成并计费**，重试会造成第二次计费。
  介意的话把 `modelRetryableCodes` 调小——注意这与生成类端点（图像/音频/视频）的
  「超时不重试」是两回事，那条规则管的是按次计费的 REST 端点。

## 会话标题前缀

每个新会话的智能标题默认带一个 `20260911153045-` 形式的前缀（会话创建时间，本机时区），
方便在会话列表里按时间辨认。前缀由插件在服务端写进 `session/title` 事件，所以 Web、TUI、
headless 看到的是同一个字符串。

**前缀是标题文本的一部分，不是独立的显示层。** dsh 的标题事件 schema 固定为
`{ title, messageSeqs, source }`，没有独立的前缀字段，界面就是把这个字符串原样画出来。
因此这个开关控制的是**生成时写不写前缀**，不是「存着但界面隐藏」：

- 开关关闭后，**新**标题不带前缀；关闭期间落盘的标题，其文本本身就不含前缀（复制、导出也没有）。
- 已有会话不会被回溯修改——无论是改开关还是改模板。

前缀对所有来源的标题一视同仁：LLM 智能标题、确定性 fallback、以及手动 rename。
fork 子会话继承父标题时，前缀会换成**子会话自己的创建时间**（浏览器 fork 之后 dsh 会再用一次
rename 把父标题带进子会话，这一步也一并处理）。

### 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `sessionTitlePrefixEnabled` | `true` | 生成标题时是否写入前缀 |
| `sessionTitlePrefix` | `yyyyMMddHHmmss-` | 前缀模板：token `yyyy` `MM` `dd` `HH` `mm` `ss`（本机时区），其余字符原样；不含 token 即字面前缀，如 `kenari-` |
| `sessionTitleMaxBytes` | `96` | 前缀 + 正文的 UTF-8 总字节上限 |

三个字段都在设置页的 Kenari 卡片里实时生效，改动在下一次标题事件即生效，并且都在「会话标题」这一组里
（开关、前缀格式、长度上限放一起，不折叠）。

### 要知道的两件事

- **`sessionTitleMaxBytes` 必须与 `cordis.patch.yml` 里 `session-title` 行的 `maxTitleBytes`
  保持一致。** 插件直接写标题事件，dsh 不会替它截断；patch 那一侧是让 dsh 自己的
  provider/fallback 路径也守同一个上限。默认都从 80 提到了 96（15 字节前缀 + 正文）。
- **前缀模板没有转义**：模板里出现 `yyyy`、`MM` 这类子串一律按 token 替换。剥旧前缀时按
  「当前模板 + 对应会话的创建时间」精确重放，所以旧前缀能被干净剥掉；只有一种罕见情形会留下
  双前缀——**模板在父会话与 fork 之间被改过**，或父会话已不在 store 里。纯字面前缀（如 `fix-`）
  在标题正文恰好同前缀开头时也可能被误剥一次。这两点都不影响主流程。

## 计费与预算

工具每次会带一行费用回显：

- 响应里有 `cost_micro_idr` → 写**实际扣费**
- 没有回显（图像/视频/语音等）→ 按目录 `pricing_lines` 单价 × 数量写**预估**，并说明口径
- 非 token 单位（张/秒/千字符/首）**按整单位上取**：实测 21 字符的 TTS 计 1 个「1k 字符」单位 Rp 250，不是 0.021 单位

`kenari_billing` 给会话累计、分工具/分模型、token 与 `cached_tokens` 命中率、预算余量、钱包余额。余额低于 `lowBalanceAlertRp`（默认 Rp 5.000）时，花费回显后附一条告警。

预算封顶：`budgetCapRp`（默认 0 = 不封顶）。到顶后花费型工具会被拒绝并给出「改免费模型 / 提高上限」的建议。**预检只看已记录的花费**，所以它是「不再新增花钱调用」，不是「保证总额不超」。

402 `insufficient_balance`、401、405、403 等错误都带了可执行建议，直接读错误文案即可。

## 设置页

设置 → **Kenari**（Host 半边注册命名空间 `kenari`）。页面的组织顺序就是使用顺序：

| 分组 | 内容 |
| --- | --- |
| 密钥 | 只做状态与名字：已配置/缺失、来源、可修改性，再加上「密钥引用名」（只读，显示的正是模型页那张卡用的同一个）。这一组没有任何输入框——密钥的值由 dsh 的密码框写入，而引用名改了会让会话模型和工具指向不同的密钥，所以两者都不在这里编辑 |
| 模型 | 当前路由可用的模型。默认只列前 3 个，其余用「展开全部 N 个」打开——提供方自述的目录有几十条，一屏铺满没法看 |
| 会话标题 | 开关、前缀格式、长度上限。一个功能的三项放在一起，不折叠 |
| 高级设置（默认折叠） | API 地址（插件调用 Kenari API 用的，两种写法都认，可编辑）、超时、重试次数、几个缓存时长、余额提醒阈值。多数只设置一次 |
| 重启后生效（默认折叠） | 在插件加载时定型的开关（是否注册搜索/抓取/工具、预算封顶、自带适配器）。**只读**：左列是名字、右列是这个值（布尔读作「已开启/已关闭」，不是 `true/false`），值做成胶囊状与名字区分开。改它们要编辑设置里对应的那一节并重启 dsh，页面上一次说清，不再逐行挂徽章 |
| 余额与用量 | 这些数字随用量变化，页面不显示会过期的快照。右列给出**可以直接照着问的一句**（例如「我的 Kenari 余额还剩多少？」），左列说明它对应什么 |

> 为什么不把 API 地址和密钥放在显眼位置：模型页的 Kenari 卡片上已经有一份「地址 + 密钥」，
> 但那是**另一套**值——卡片上的地址是会话模型的线上协议入口（`…/v1`，dsh 的 pi-ai 路由用它），
> 密钥框写的是凭据**值**；本插件的地址是工具与网页搜索用的 REST 入口（默认裸域），密钥引用名是凭据
> **名字**（值仍是同一个）。两张卡曾经长得像同一件事、各说各话，所以现在这里只报状态、把引用名随状态
> 一起显示（只读），地址退到高级（它可编辑且立即生效）。

文案分**中文 / 英文**两套，跟随 dsh 的语言设置（设置 → 通用 → 语言）即时切换。字典在
`client/index.js` 的 `LOCALES` 里，`zh` 是键集真源、`en` 必须补齐同一组键——`pnpm build` 的自检会
断言两者一致，也会断言每个字段的标签与说明在两种语言里都能解析（少一个键就渲染成键名本身，比如
`field.timeoutMs`，只在界面上看得见，不报错）。

左侧导航里这一节的图标用的是 Kenari 自己的 mark（`assets/kenari-favicon-128.png`）。这件事只能由
客户端 bundle 完成：dsh 的 shell 按 section id 写死图标（`navIcon(row.id)`），而 section 注册项只有
`id / order / label`，没有图标字段——插件加不进去，于是认领「标签是 Kenari 的那一行导航」，把图标贴上去。
图片经插件自己的同源路由 `GET /api/kenari.favicon` 递出，原因和 `/api/kenari.models` 一样：客户端
bundle 没有打包器，只有 `exports["./client"]` 这一个文件被 loader 读，引用不了包内图片。

两个细节值得知道：

- 插件**不移动 dsh 的 DOM**，只是用一条注入的 CSS 规则把 dsh 那个 `<svg>` 隐藏，图标画在 `::before` 上。
  React 在关闭设置面板时会遍历它渲染过的每个节点调 `removeChild`，被插件摘走的节点会让那里抛错。
- 图标只在图片**真的加载成功之后**才隐藏 dsh 的齿轮：路由不通（例如打包漏了 `assets/`）时保留原生图标，
  不会留一个空位。

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
| 设置导航里 Kenari 那行还是齿轮图标 | 图片没加载成功：确认包内含 `assets/kenari-favicon-128.png`（`package.json` 的 `files` 漏了 `assets` 就会这样），以及 `GET /api/kenari.favicon` 能通。路由不通时插件故意保留 dsh 的图标 |
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
node test/favicon.mjs           # 设置导航图标端点：路由注册 + 从 lib/ 读到 assets/ 里的 PNG（不联网）
```

`scripts/check-client.mjs` 随 `pnpm build` 运行：校验客户端 bundle 的注册格式、导出面、模块依赖声明、命名空间与 Host 一致，并**真实渲染一次卡片组件**——手写 bundle 没有打包器，这些就是它的编译期检查。它同时驱动那些只在浏览器里出错、且**错了也不报错**的逻辑：挑选器的筛选/套餐 join、模型目录接管的 DOM 判定，以及设置导航行的认领与图标规则。
