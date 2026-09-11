# dsh 其他 seam 要点

来源：`/en/reference/capability-seams`、`/en/reference/subsystems/*`，以及 npm 包的 `.d.ts`。

## seam 与 core 的区分

**seam = 可替换（可注册实现）；core = 不可替换。**

| ctx 服务 | 角色 | owner |
|---|---|---|
| `ctx.web` | seam | `web` |
| `ctx.llm` | seam | `llm` |
| `ctx.settings` | seam | `settings` |
| `ctx.credentials` | seam | `credentials` |
| `ctx.tools` | **core** | `tools` |
| `ctx.systemPrompt` | core | `system-prompt` |
| `ctx.commands` | core | `commands` |
| `ctx.skills` | seam | `skill` |
| `ctx.tokenMeter` | **core** | `token-meter` |
| `ctx.sessionTelemetry` | seam | `session-telemetry` |
| `ctx.sessionPersistence` | seam | `session-persistence` |
| `ctx.sessionQuery` | seam | `session-query` |
| `ctx.fileReferences` | seam | `file-reference` |
| `ctx.sessionTitle` | seam | `session-title` |
| `ctx.userQuestions` | seam | `user-questions` |
| `ctx.subprocess` | seam | `subprocess` |
| `ctx.shell` | seam | `shell` |
| `ctx.terminals` | seam | `terminal` |
| `ctx.sandbox` | seam | `sandbox` |
| `ctx.approval` | seam | `user-approval` |
| `ctx.codeRuntime` | seam | `code-runtime` |
| `ctx.fs` | seam | `fs` |
| `ctx.compaction` | seam | `compaction` |
| `ctx.subagents` | seam | `subagent` |
| `ctx.jobs` | seam | `jobs` |
| `ctx.spillStore` | seam | `spill` |
| `ctx.workflowEngine` | seam | `workflow` |
| `ctx.lsp` | seam | `lsp` |
| `ctx.agentLoop` | bundle | `agent-loop` |
| `ctx.attachments` | seam | `attachment` |
| `ctx.storage` | seam | `storage` |

`ctx.tools` 与 `ctx.tokenMeter` 虽是 core，但 `ctx.tools.register` 是公开扩展点，`ctx.tokenMeter` 可只读消费。

## ctx.llm

`LlmAdapter` 是抽象类，注册方式：

```ts
ctx.llm.registerAdapter(providers: string[], adapter: LlmAdapter)
```

需要实现的成员：

| 成员 | 作用 |
|---|---|
| `providerInfo(provider)` | 描述该 provider 路由的展示元数据，返回的 id 必须等于传入的 provider |
| `providerRetryPolicy(provider)` | 该路由的重试策略，返回 `undefined` 用默认 |
| `listModels(provider)` | 当前可 advertise 的模型列表。**结果是建议性的**：adapter 可以接受未列出的模型 id，消费者不得因缺席而拒绝请求 |
| `resolveModelInfo(provider, model, signal?)` | 解析某个确切模型的全部元数据，独立于建议性目录，不校验路由 |
| `stream(options: GenerateOptions)` | 抽象方法，返回 `AsyncIterable<StreamChunk>` |

**`listModels()` 是异步的，可以返回动态目录**（例如按 provider 的 `/models` 端点实时获取）。结果是建议性的，不构成请求路由的白名单。

重要约束：**每个 provider HTTP 请求必须包含 `attributionHeaders()`**。要在真实线上请求或库的 header hook 里证明这一点。

`llm/stream` 是 waterfall 事件，围绕每次流式模型调用（重试、重放、路由）。签名：

```ts
'llm/stream'(this: LlmService, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>
```

由 agent loop 构造的请求带有进程内标识且**深度冻结**（改动会抛），其内容是会话日志的纯函数，监听者只能读不能改。

`llm/adapters-updated` 是无 payload 的注册表通知，在每次提交点（含注册释放）触发。消费者重新读取 `listProviders()` / `listModels()` / `listConfigurableProviders()`。

`LlmError` 继承 `HarnessError`，`code` 是共享分类（如 `AUTH`、`RATE_LIMIT`、`NO_ADAPTER`），`failure` 保留可序列化事实，`status` / `providerRetryAfterMs` / `requestId` 可选。

`assertUsableApiKey(raw, pkg, ref)` 用于校验 key：会静默 trim（存储的 key 来自凭据 seam / `.env` / shell export，都可能带空白），失败时**只报引用名不报值**。

## ctx.settings

设置 namespace 是 Host 半边与 Client 半边的 join key。

```ts
ctx.inject(['settings'], (settingsCtx) => {
  settingsCtx.settings.installSection(ctx, MY_PLUGIN_NS, Config, config, {
    validate: (value) => void assertReachable(value.endpoint),
  })
})
```

`installSection()` 把条目分层放在用户文档之下，且在没有 settings provider 挂载时也能工作。`validate` 用于表达 schema 无法表达的约束 —— 它在**写入时**拒绝，而不是等到下次使用。

配置文档位置：`$DSH_HOME/settings.yaml`（settings 页写的就是这个文档，可直接编辑）。适配器在下次请求时重读，无需重启。

## ctx.credentials

凭据缝的设计目的是把密钥挡在配置之外：settings 节与 `cordis.yml` 条目携带**引用**（环境变量名），provider 拥有值，消费者每次操作解析一次。

```ts
type CredentialRef = Branded<'CredentialRef'>   // POSIX 风格环境变量名

resolve(ref): ResolvedCredential | undefined
// { value: string, source: string }

describe(ref): CredentialInfo
// { configured: boolean, source?: string, writable: boolean }
```

要点：

- **`describe()` 永不暴露值。** 视图里没有能承载值的槽位，这正是读半边能跨 Remote 线的原因
- 消费者**每次操作重新解析，不跨操作缓存** —— 这个逐操作读取就是热更新机制。LLM adapter 每次模型请求解析一次，所以轮换后的凭据下一次请求就生效，无需重启
- 本地 provider 的来源层：`env`、`file`、`project-env`、`user-env`
- **由活动进程环境提供的引用 `writable: false`** —— 写入会看似成功但解析仍返回遮蔽值，所以缝拒绝写入，UI 应提前渲染为只读
- 缝级规则：**空的存储值在任何地方都视为不存在**

配置位置：`$DSH_HOME/.credentials.yaml`；settings 只保留对凭据的引用。

## 凭据的部署细节（dsh-base 注释）

```
# Credential sources: inherited environment over the managed
# `$DSH_HOME/.credentials.yaml`, with project and user `.env` fallbacks.
# Adapters resolve references per request; the Models page writes only the
# managed document, which is never materialized into the process environment.
```

## ctx.tools

core 服务，但 `register` 是公开扩展点。工具的执行管线：

```
tool/call → tools/pre-execute → tools/execute → tools/post-execute → tool/result
```

`tools/pre-execute` 是策略钩子（可用于确认、拦截）。工具定义里可声明 `timeoutMs` 作为协作式预算，由 `@deepseek-ai/dsh-timeout-policy` 强制执行。

### 工具返回二进制：ctx.attachments（第 2 期实测）

`@deepseek-ai/dsh-attachment` 的 `AttachmentStore` 挂在 `ctx.attachments`（`dsh-attachment-local` 装的是 `LocalAttachmentStore`，落盘在 `DSH_HOME` 下）。工具产出图像/音频/视频时用它把字节变成耐久引用，再把引用放进规范 value，由 `output.render` 重建 block：

```ts
// execute 内
const ref = await ctx.attachments.saveImage({ data: bytes, mediaType: 'image/png', name })
// render 内
return [{ type: 'text', text }, { type: 'image', attachment: ref }]
```

要点（均源码/实测确认）：

- `ImageAttachmentRef` = `{ attachmentId, mediaType, bytes, width, height, name? }`；`FileAttachmentRef` = `{ attachmentId, name, bytes }`。**都是纯 JSON**，可以直接放进 `output.schema` 声明的 value（值必须是 lossless JSON，字节本身进不去）
- `saveImages(inputs)` 先 `validateImageBatch`（受 `imageLimits` 的 `maxImagesPerMessage` / `maxMessageImageBytes` / `mediaTypes` 约束）再逐张 `validateImage`，任一张不合格**整批不写**
- `saveFile` 存逐字节原文，无准入限制；基类默认实现抛 `ATTACHMENT_FILES_UNSUPPORTED`，`attachment-local` 已实现
- 支持的图像类型只有 `image/png|jpeg|webp|gif`（**不含 tiff**）；`attachment-local` 会做归一化（实测 1024×1024 的 PNG 存进去报 1254×1254）
- 服务缺失时 `ctx.get('attachments')` 返回 undefined（seam 可选），工具应显式降级成文本说明，别静默丢产物
- 载荷大小走 `imageLimits`/`saveFile` 各自策略，工具的 `timeoutMs` 与 HTTP 超时不受 attachment 影响

## ctx.web 之外的 web 相关

`dsh-tool-web` 的工具通过 `ctx.web` 执行，但**工具注册与 provider 可用性解耦**：已启用的工具即使 provider 不可用也保持可见，在执行时报结构化错误。

## turn / step 流程（理解工具何时被调用）

- **step** = 一次模型请求加上它调用的工具
- **turn** = 零个或多个 step

```
turn/start
  claim next-step input
  assemble prompt sections + tool schemas
  → agent/pre-step（可 reject）
    step/start
    agent/request → prepareCall
    stream the bound prepared call → llm/stream → agent/assistant-stream start
      agent/assistant-stream chunk*
    tool/call* → tools/pre-execute → tools/execute → tools/post-execute → tool/result*
    step/end
  → agent/turn-stopping
turn/end
```

持久会话事件：`turn/*`、`step/*`、`system/message`、`user/message`、`assistant/message`、`assistant/attempt`、`tool/*`。

## MCP 客户端（可选方案用）

`@deepseek-ai/dsh-mcp-client`：连接外部 MCP server，把工具注册到 `ctx.tools`，公开名为 `mcp__<serverName>__<rawName>`。**每个插件实例连一个 server**，多个 server 就在 `cordis.yml` 里加载多个实例。

namespace 插件（具名导出，无 default export）。生命周期是 effect 作用域：释放时断开连接、注销所有工具、释放 `serverName` 命名空间预留。HMR 通过释放旧实例、创建新实例热替换；相同 `serverName` 复现相同公开工具名。

配置是判别联合：

```ts
type Config = StdioConfig | StreamableHttpConfig

interface StreamableHttpConfig {
  transport: 'streamable-http'
  serverName: string        // 必须匹配 [A-Za-z0-9_-]{1,32}，跨实例唯一
  url: string
  headers: Record<string, string>
  toolCallTimeoutMs: number
  failOnStartupError: boolean
}
```

`apply(ctx, config): Promise<void>` 显式 async：在激活前连接并完成初次工具发现。

dsh 的行为：解析选定的 Cordis overlay，启动 stdio 命令或连接 Streamable HTTP URL，发现 MCP 工具，暴露为 `mcp__<serverName>__<tool>`。**dsh 不下载 server、不初始化数据库、不选择模型或 embedding provider、不创建云账户、不迁移数据、不监督独立 HTTP 服务。**

stdio 桥接会**刻意移除**名字像凭据的环境变量与所有 `DSH_*` 变量，再启动子进程；其他环境变量继续继承。需要额外密钥时应加到该行的 `config.env`，不要把密钥直接写进 YAML。

## 客户端半边（设置卡片）

见 `dsh-plugin-model.md`（同目录）的"客户端模块"一节。要点：一个包两个半边，Host 在 `src/`、浏览器在 `src/client/`，导出 `./client`，package.json 声明 `dsh.client`。

## ctx.sessionTitle（会话标题）实测要点

来源：`packages/session/session-title`、`session-title-llm`、`session-title-first-prompt-llm` 实读，加上对 `packages/core/session`、`packages/core/scope` 的实现核对。

**挂载现状**：web profile 已挂 `session-title`（服务）+ `session-title-llm` 行 = `dsh-session-title-first-prompt-llm`（用会话当前模型，从第一条人类消息生成标题）。两者都由 `packages/bundle/base/cordis.patch.yml:48` 提供；base 里 `maxTitleBytes` 是 80。

**存储形状与显示**：标题是 log-only 的 `session/title` 事件，数据固定为
`{ title, messageSeqs, source }` —— **没有独立的前缀字段**。客户端会话列表读服务端 `title` 投影（`displayTitle = title ?? cwd 基名 ?? id`，`api/session-controller/src/client/sessions/service.ts:146`），即把该字符串原样渲染。因此「存着前缀但显示时隐藏」在插件边界内做不到：`ui-workspace` 的会话行标题没有槽位（`sidebar.workspaces` 的子槽只有 `sidebar.workspaces.directoryFlow`），TUI 更无触点。

**单 provider 槽位**：`ctx.sessionTitle.register()` 第二次注册抛错，所以插件若要自己产出标题，必须在 patch 里 `disabled: true` 掉 `session-title-llm` 行（`sdk-app`/`acp-app` 有先例）。只加前缀则不需要接管 provider。

**事件监听（加前缀的合法缝）**：`ctx.on('session/event'|'session/created'|'session/disposed')`。未打 scope 标签的插件 ctx 能收到所有会话事件 —— `core/scope` 的 `scopeTarget()` 过滤器对 `scopeOf(ctx) === undefined` 的监听器一律放行（`packages/core/scope/src/index.ts:176`）。

**append 重入**：`session/event` 在 append 的发布窗口内**同步**派发（`core/session/src/index.ts:745`），此时 `entry.appending === true`，回调里再 `session.append` 会抛 `session append cannot reenter while another append is being published`（同文件 `:723`）。改写标题必须 `queueMicrotask` defer，并在执行时重读最新 folded title，否则会覆盖更新的标题。

**fork 的坑**：浏览器 fork 之后会显式调 host 的 `rename`，写入 `increasedForkTitle(父标题)`（`api/session-controller/src/client/sessions/service.ts:437`、`:156`），这次 rename 在 host 上 `source.kind === 'user'`。所以按 source 区分「用户改名不加前缀」会在 fork 上漏改前缀；统一按「剥旧前缀 + 按本会话开始时间重加」处理才对。fork 子会话继承的父标题事件**不会**触发 `session/event`（seed 由构造器写入），只能靠 `session/created` 补一次改写；普通 resume 要跳过，否则等于回溯已有会话。

**`header.createdAt` 不是「会话开始时间」（踩过的坑）**：Web 侧会**复用空白会话**（`SessionSummary.blank`：New Session 复用同一 workspace 的空白记录），所以 `header.createdAt` 可能是工作区打开时的时间，比用户第一条消息早几个小时。实测一例：`createdAt` 14:49:33，第一条人类 `user/message` 在 17:42:58，差 173 分钟。取「会话开始时间」必须扫日志里第一条 `type === 'user/message' && data.source.kind === 'user'` 的事件（`source.kind` 还有 `agent-instructions` / `plugin` / `skill-catalog` 等注入来源，不算）；fork 子会话要跳过 seed 继承的前导事件 —— `session.inheritedEventCount` 是**持久的 fork 切点**（resume 时保持原值），从它开始扫才是子会话自己的第一条消息。没有任何人类消息时才退回 `header.createdAt`。

**时间与长度**：`inheritedEventCount` / `firstLiveSeq` 的区别见 `core/session/src/index.ts:466`、`:476` —— 前者是持久 fork 切点，后者是本次进程内构造 seed 的长度。`maxTitleBytes` 只约束 dsh 自己的写入路径，插件直接 append 的事件要自己截断 —— 两处上限需人工同步。
