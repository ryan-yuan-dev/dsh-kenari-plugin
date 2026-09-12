# dsh 源码机制（vendor 实读）

来源：`vendor/deepseek-harness` submodule，tag `dsh-v0.1.5-rc.1`。以下每条都给出 `文件:行号` 证据，与知识库其他文档（官方文档转述）互为印证；**冲突时以本文档为准**（源码是最终事实）。

核实时间：2026-09-10。

---

## 1. patch 语义（`applyEntryPatches`）

实现：`vendor/include/src/index.ts:58-128`（包名 `@deepseek-ai/cordis-plugin-include`）。

### 1.1 PatchOptions 完整字段（`vendor/include/src/index.ts:145-156`）

```ts
export interface PatchOptions {
  id?: string
  insert?: EntryOptions[]
  name?: string
  config?: any
  group?: boolean | null
  disabled?: boolean | null
  inject?: any
  intercept?: any
  isolate?: any
  [key: string]: any
}
```

### 1.2 覆盖语义是"逐字段覆盖"，`config` 是单键整体替换

应用循环（`vendor/include/src/index.ts:77-125`）：

```ts
const { id, insert, name, ...overrides } = patch
// ...
if (name && name !== target.name) {
  warn('patch: name mismatch for %C ..., skipping', ...)  // name 不匹配则整个 patch 跳过
  continue
}
for (const [key, value] of Object.entries(overrides)) {
  if (key === 'id') continue
  target[key] = value        // 每个字段独立覆盖
}
```

推论（修正设计文档的一个细节）：

- `config` 是一个键，写入即**整体替换**该行的 config —— 覆盖 `- id: web` 时仍必须把 `searchProvider` 与 `fetchProvider` 一起写全
- `disabled` 是**独立于 config 的键**：只覆盖 `config` 不会碰 `disabled`；覆盖行写 `disabled: false` 即可重新启用，`dsh-web-app` 对 `tool-web` 追加的 `disabled: true` 正是靠这个键生效（它自己也是 patch：`packages/bundle/web-app/cordis.patch.yml:470-471`）
- patch 里写 `name` 时必须与目标行现有 `name` 完全一致，否则**整个 patch 被跳过并告警**（不是报错崩溃）。最稳妥：覆盖已有行时不写 `name`
- 匹配不到 id 的 patch 只 warn 不抛错（`patch: entry %C not found`）

### 1.3 insert 与索引

- `- insert:` 无 `id` → 追加到根列表；有 `id` → 必须指向 group 行，追加进其 config 数组（`vendor/include/src/index.ts:80-95`）
- insert 的行**会被立即索引进 entryMap**，同一 patch 列表里后续 patch 可以按 id 配置或禁用它（`vendor/include/src/index.ts:96-101`）——这是 dsh 对上游 cordis 的行为修正（见 `vendor/README.md:43`）

### 1.4 dsh-base 真实 patch 形状（`packages/bundle/base/cordis.patch.yml`）

整个 base 层是**一个 `- insert:`**，内含全部插件行；web-app 层是按 id 覆盖行 + 自己的 insert。行字段示例：

```yaml
- insert:
    - id: hmr
      name: '@deepseek-ai/cordis-plugin-hmr'
      disabled: true
      config:
        root: ['.']
```

web-app 覆盖行（`packages/bundle/web-app/cordis.patch.yml:467-471`）：

```yaml
- id: tool-web
  disabled: true
```

**注意：web-app 覆盖 `tool-web` 时只写了 `disabled: true`，没有写 config。** 依据 1.2，我们的覆盖行同样只需写 `disabled: false`，config 不写则保留 base 的值（`fetch: true` 等）。这与设计文档 3.3 节"必须整行重写 config"不同——config 替换是按 `config` 键整体替换，不是按"行"整体替换；不写 `config` 键就不替换。

---

## 2. 插件模块解析与加载

### 2.1 `name` 字段 = 模块 specifier

- 绝对路径或 `./`/`../` 开头 → 相对配置文件解析成 file URL（`packages/boot/app-boot/src/index.ts:329-330`）
- 其余（包名）→ 经 Node ESM import 解析，锚点是 `ctx.baseUrl`（cordis.yml 目录，即 profile 目录；该目录的 package.json 声明所有组合插件为依赖），见 `packages/typert/loader/src/index.ts:289-293`、`vendor/loader/src/config/tree.ts:145-159`

结论：patch 行 `name: 'dsh-kenari-plugin'` 按**包名**解析，包必须是 profile node_modules 里可 resolve 的依赖（`dsh plugin add` 负责装进去）。

### 2.2 插件模块导出约定

- `export const name`（loader 诊断用）、`export const inject?: string[]`、`export function apply(ctx, config)`
- ESM/CJS/default 形状都会被 `unwrapExports` 归一（`vendor/loader/src/index.ts:200-209`）
- 运行时示例：`packages/web/web-search-deepseek/src/index.ts:38-41,127`

### 2.3 config 来源

patch 行的 `config` 就是传给 `apply(ctx, config)` 的 config；schemastery schema 在挂载前校验并填充默认值。

---

## 3. ctx.web（`@deepseek-ai/dsh-web`）

源码：`packages/web/web/src/index.ts`（`WebRuntime`）与 `packages/web/web/src/types.ts`。

- `registerSearchProvider` / `registerFetchProvider`：`packages/web/web/src/index.ts:103,114`。id 重复抛 `WebError` code `WEB_DUPLICATE_PROVIDER`（`registerProvider`，index.ts:124-133）。disposer 挂调用 fiber
- 选择语义与配置：`WebRuntime.Config = { searchProvider?, fetchProvider? }`（index.ts:80-83）；环境变量 `DSH_WEB_SEARCH_PROVIDER`/`DSH_WEB_FETCH_PROVIDER` 等价同字段（index.ts:92-93）
- `WebError extends HarnessError`（types.ts:130）
- 请求/结果类型与官方文档一致（types.ts:16-120）；`WebFetchBody` 是封闭联合（`'html' | 'text'`）
- `available()` 契约："Cheap local usability check; must not make network calls."（types.ts:104,117）

## 4. 兜底 provider 的构造签名（0.1.5-rc.1 实读）

### 4.1 `DeepSeekSearchProvider`（`packages/web/web-search-deepseek/src/provider.ts:180-190`）

```ts
export class DeepSeekSearchProvider implements WebSearchProvider {
  readonly id = DEEPSEEK_PROVIDER_ID        // 'deepseek-official'
  constructor(private readonly resolveOptions: () => DeepSeekSearchProviderOptions) {}
  available(): boolean {
    const options = this.resolveOptions()
    return ((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== undefined)
      && URL.canParse(options.baseURL)
  }
}
```

`DeepSeekSearchProviderOptions`（provider.ts:192-214）：`apiKey?`、`resolveApiKey?: () => Promise<string | undefined>`、`apiKeyEnv?`、`baseURL`、`model`、`apiVersion`、`maxTokens`、`maxUses`、`recordRequest?`。

**要点：构造参数是一个 thunk `() => options`，不是静态值**（注释明说：settings 节可变，每次 search 快照一次）。`available()` 的判定：有 `apiKey` **或** 提供了 `resolveApiKey` 即视为可用 + baseURL 可解析。我们的兜底实例要传 `resolveApiKey` thunk（每次现场读凭据），否则装了 key 也不可用。

默认值常量：`DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic/v1'`、`DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash'`、`DEEPSEEK_DEFAULT_API_VERSION = '2023-06-01'`、`DEEPSEEK_DEFAULT_MAX_TOKENS = 4096`、`DEEPSEEK_DEFAULT_MAX_USES = 5`（均从包入口 re-export）。

### 4.2 `HttpFetchProvider`（`packages/web/web-fetch-http/src/provider.ts:39-59`）

```ts
export class HttpFetchProvider implements WebFetchProvider {
  readonly id = LOCAL_FETCH_PROVIDER_ID     // 'http'
  constructor(
    private readonly limits: HttpFetchLimits,
    private readonly resolveAddresses: HttpFetchResolver = publicHttpNetwork.resolve,
  ) {}
  available(): boolean { return true }      // 匿名抓取，无凭据可查
}
```

`HttpFetchLimits`：`maxResponseBytes`、`maxBodyChars`、`timeoutMs`、`maxRedirects`、`userAgent`（5 字段，`maxUrlLength` 已移除）。默认值取自包 `Config`（index.ts:45-51）：5_000_000 / 100_000 / 30_000 / 5 / `DEFAULT_USER_AGENT`。第二参数有默认值，**可以只传 limits 实例化**。

### 4.3 re-export 确认

`@deepseek-ai/dsh-web-search-deepseek` 入口 re-export `DeepSeekSearchProvider` 与全部默认常量（index.ts:26-34）；`@deepseek-ai/dsh-web-fetch-http` 入口 re-export `HttpFetchProvider`、`LOCAL_FETCH_PROVIDER_ID`、`DEFAULT_USER_AGENT`（index.ts:18-21）。

## 5. dsh-tool-web 的 Config（`packages/web/tool-web/src/index.ts:37-64`）

```ts
interface Config {
  search?: boolean              // 默认 true
  fetch?: boolean               // 默认 true
  searchMaxResults?: number     // 默认 8（WEB_SEARCH_MAX_RESULTS）
  searchMaxQueries?: number     // 默认 WEB_SEARCH_MAX_QUERIES
  fetchTimeoutMs?: number       // 默认 30000
  searchTimeoutMs?: number      // 默认 30000
  fetchMaxOutputChars?: number  // 默认 200000
}
```

`apply`（index.ts:104-110）：`search`/`fetch` 为 true 时注册工具；正整数校验失败抛错。inject 是 `['tools', 'web', 'systemPrompt']`。

**第 0/1 期结论**：我们的 `tool-web` 覆盖行只需 `disabled: false`；`search`/`fetch` 默认已 true，无需重写 config。`searchTimeoutMs: 60000` 由 dsh-base 已写，保留。

## 6. ctx.tools / defineTool（`@deepseek-ai/dsh-tools`）

源码：`packages/core/tools/src/schema.ts`。

`DefineToolOptions`（schema.ts:483-537）关键字段：

```ts
{
  name: string
  description: string
  parameters: ParameterSchemaSpec     // 属性映射，根是隐式 open object
  output: {
    schema: ValueSchemaSpec
    render(args, value): ContentBlock[]
    presentationMeta?(args, value): JsonValue
  }
  timeoutMs?: number                  // 协作式超时预算
  execute(args, exec: ToolRunContext): Promise<...>
  isConcurrencySafe?(args): boolean
  finalizeContent?(exec, result): ContentBlock[] | undefined
  presentCall? / presentResult?
}
```

`ParameterSchemaSpec`（schema.ts:103-107）：`{ [key]: ValueSchemaSpec & { required?: true } }`。**required 是属性级 `required: true` 标注**，不是 JSON Schema 的 required 数组。

`ValueSchemaSpec` 判别联合（schema.ts:29-101）：`{type:'string', ...}`、`number`、`integer`、`boolean`、`null`、`array`(+`items?`)、`object`(**必须** `additionalProperties: boolean`，可选 `properties`)、`json`、`oneOf`。标量可带 `description`/`enum`/`const`。

`ContentBlock`（`packages/llm/llm/src/types.ts:108-124`）：`'text' | 'reasoning' | 'image' | 'file' | 'tool-call' | 'tool-result'`。文本块即 `{ type: 'text', text: string }`。

## 7. ctx.credentials（`@deepseek-ai/dsh-credentials`）

`packages/credentials/credentials/src/index.ts:176-192`：

```ts
abstract resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>   // { value, source }
abstract describe(ref: CredentialRef): Promise<CredentialInfo>                  // { configured, source?, writable }
```

- **两个方法都是 async**（返回 Promise），与部分文档示例的同步写法不同——调用处必须 await
- 每次调用重新解析，禁止跨操作缓存（index.ts:178-181 注释原文）
- `credentialRef(value: string): CredentialRef` 构造 helper（index.ts:29）
- 空字符串值视为不存在（index.ts:160-162 注释）

## 8. ctx.settings.installSection（`@deepseek-ai/dsh-settings`）

`packages/settings/settings/src/index.ts:472-505`：

```ts
installSection<const Namespace extends string, T>(
  owner: Context,
  ns: Namespace & SettingsNamespaceInput<Namespace>,
  schema: z<T>,
  entry: T,
  hooks: SettingsSectionHooks<T>,
): void
```

`hooks`（index.ts:871 起）：`setSource(source)`、`onChange()`、可选 `validate(value)`。**hooks 的 `setSource`/`onChange` 是必需的**（web-search-deepseek 的用法：index.ts:136-144）。

namespace 必须匹配 `/^[a-z][a-z0-9-]*$/`（index.ts:20），否则 TypeError。schema 是 `@deepseek-ai/schemastery` 的 `z<T>`。

## 9. ctx.llm / LlmAdapter（`@deepseek-ai/dsh-llm`）

- 注册：`registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle`（`packages/llm/llm/src/index.ts:387`）
- 抽象类成员（index.ts:198-280）：`providerInfo(provider): LlmProviderInfo`、`providerRetryPolicy(provider)?`、`imageRequestPricing(provider, model)?`、`listModels(provider): Promise<readonly LlmModelInfo[]>`（建议性目录）、`resolveModel(provider, model, signal?): Promise<LlmResolvedModelInfo>`（注意方法名是 **resolveModel**，不是设计文档写的 resolveModelInfo）、`prepareCall(provider, model, signal?)`、抽象 `stream(options: GenerateOptions): AsyncIterable<StreamChunk>`
- 唯一必须实现的是 `stream()`；其余有默认实现
- `StreamChunk`（`packages/llm/llm/src/types.ts:390-405`）：`block-start` / `text-delta` / `reasoning-delta` / `tool-call-delta` / `block-end` / `usage` / `finish`
- `GenerateOptions`（types.ts:419-465）：`provider`、`model`、`reasoningEffort?`、`messages`、`system?`、`tools?`、`temperature?`、`maxTokens?`、`stop?`、`signal?`、`sessionId?`、`purpose?`
- 契约：每个 provider HTTP 请求必须带 `attributionHeaders()`

## 10. 依赖包名与版本（peer 依赖定版依据）

monorepo 实际包名（`packages/**/package.json`）：

| npm 包名 | 源码位置 | 说明 |
|---|---|---|
| `@deepseek-ai/cordis` | `vendor/cordis` | Context 类型 |
| `@deepseek-ai/schemastery` | `vendor/schemastery` | **不是** npm 的 `schemastery`，dsh 全部 import 这个 |
| `@deepseek-ai/dsh-web` | `packages/web/web` | ctx.web；exports 含 `.` |
| `@deepseek-ai/dsh-tools` | `packages/core/tools` | defineTool |
| `@deepseek-ai/dsh-credentials` | `packages/credentials/credentials` | credentialRef、类型 |
| `@deepseek-ai/dsh-settings` | `packages/settings/settings` | installSection |
| `@deepseek-ai/dsh-llm` | `packages/llm/llm` | LlmAdapter、StreamChunk、ContentBlock |
| `@deepseek-ai/dsh-web-search-deepseek` | `packages/web/web-search-deepseek` | 依赖仅 schemastery；peer 含 cordis/dsh-credentials/dsh-web/dsh-session/dsh-agent/dsh-launch-environment/dsh-settings |
| `@deepseek-ai/dsh-web-fetch-http` | `packages/web/web-fetch-http` | 依赖 schemastery + ipaddr.js + undici；peer 含 cordis/dsh-web/dsh-timeout/dsh-http-proxy |

版本统一 `0.1.5-rc.1`。

**import 注意**：dsh 源码内部用 `.ts` 后缀相对导入（如 `./provider.ts`），这是 monorepo tsx/自编译产物；我们作为外部包 import 其**包入口**（`@deepseek-ai/dsh-web-search-deepseek`），拿到的 `lib/*.js` 没有此问题。

`@deepseek-ai/schemastery` 的 API：`z.object({...})`、`z.string().default(x).role('secret'|'credential-ref')`、`z.number().step(1).min(n).default(x)`、`z.boolean().default(x)`（见 web-search-deepseek / web-fetch-http 的 Config）。

## 11. 凭据解析的推荐模式（来自官方 provider 自身实现）

`web-search-deepseek` 的 `resolveOptions`（index.ts:92-124）示范了 key 读取的完整模式：

```ts
resolveApiKey: async () => {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
  // 无 seam 时回退到环境
  const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv)
  return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
}
```

即：优先走 `ctx.get('credentials')`（seam 可能未挂载），否则读环境。Kenari 插件照抄此模式。

## 12. 设置客户端半边（第 4 期用，摘要）

客户端模块 = `src/client/index.ts` 导出 `apply(ctx: ClientContext)` + `inject` + `NS`；package.json `dsh.client: { platform: 'web', inject: [], immediately: true }`，exports 加 `"./client"`。示例：`packages/client/ui-settings-plugin-inventory/src/client/index.ts`。设置卡片通过 `ctx.slots.inject('settings.<section>', ...)` 挂载。

---

## 13. `ctx.llm` / `llm-pi-ai` 配置形状（第 3 期实读 + 实测）

包 `@deepseek-ai/dsh-llm-pi-ai`，types 在 `lib/types/config.d.ts`、`catalog.d.ts`、`provider.d.ts`。

```ts
interface Config { providers?: Record<string, PiAiProviderProfile> }

interface PiAiProviderProfile {
  apiKeyEnv?: string        // 凭据引用名，逐请求经 ctx.credentials 解析
  displayName?: string
  api?: string              // 线上协议；路由不在 pi-ai 目录里时**必须**写
  baseURL?: string
  models?: PiAiModelProfile[]        // 显式列表会**替换**安装目录
  modelOverrides?: Record<string, PiAiModelOverride>  // 只改指定 id，其余保持
  compat?: PiAiCompatProfile
  defaultContextWindow?: number      // 默认 262144
  defaultMaxTokens?: number          // 默认 32768
  defaultInput?: PiAiModality[]      // 默认 [text]；**不可为空**
  reasoning?: ModelThinkingLevel
  transport?: Transport
  retryPolicy?: RetryPolicyConfig
}

interface PiAiModelProfile {
  id: string                // 必填
  name? / contextWindow? / maxTokens?
  input?: PiAiModality[]
  reasoningEfforts?: false | Partial<Record<ModelThinkingLevel, string | null>>
  compat?: PiAiCompatProfile
}
```

要点（源码事实）：

- **profile 按 provider route 合并**：composition base 与用户 settings 层"merge per provider"，
  route 集合是结构性的 → 插件可以在 patch 里给 `llm-pi-ai` 预置 `providers.kenari`，用户层仍可加自己的路由
- `ReasoningEffort` 的**键**受 `ModelThinkingLevel` 限制：
  `off | minimal | low | medium | high | xhigh | max`。写别的键 → schemastery 校验失败 →
  **整个 plugin tree 加载失败、dsh 起不来**。`off` 可以留空值表示"支持但不发参数"
- **每个 provider HTTP 请求必须带 `attributionHeaders()`**（契约）
- `buildProvider`：路由不在 pi-ai 目录里（或改了协议）→ 用 `createProvider` 按协议表构造；
  命名目录路由则复用目录 provider（Bedrock 之类有私有实现）
- `supportedProtocols()` 实测值：`openai-completions` / `openai-responses` / `anthropic-messages`
  / `azure-openai-responses` / `openai-codex-responses` / `bedrock-converse-stream`
- `maxTokens` 写在 model entry 上会同时成为**该模型的每请求默认上限**；
  只写 `defaultMaxTokens` 则只是"能力"、不会变成请求默认值 —— 不确定网关真实上限时不要写 model 级 `maxTokens`

### 模型发现（设置页"拉取模型"用的就是它）

```ts
ctx.llm.registerModelDiscovery(settingsNs, discover)         // 每个 ns 只能注册一次
ctx.llm.discoverModels(settingsNs, request, signal?)         // Remote 名 `discoverModels`
```

`llm-pi-ai` 以 `settingsNs = 'llm-pi-ai'` 注册发现（`packages/llm/llm-pi-ai/src/index.ts:260`）。
`discoverModels` 的拒绝原因（`RemoteError` code `llm/model-discovery-rejected`，message 里带真实原因）：

- `NO_DISCOVERY`：该 ns 没注册过发现
- `INVALID_DISCOVERY`：`provider` 与 `baseURL` 都为空
- `DISCOVERY_FAILED`：路由不在 pi-ai 目录里且没给 `baseURL`（"set a baseURL, or enter this provider's
  models by hand"）→ **手写路由要显示模型列表，必须把 baseURL 一起传**
- 给了 `baseURL` 后：`GET {baseURL}/models`（anthropic 线走另一形状），带路由的凭据，需要 `attributionHeaders`

## 14. 客户端（浏览器）插件实读（第 4 期）

### 声明与产物

```json
"exports": { "./client": { "default": "./client/index.js" } },
"dsh": { "client": { "platform": "web", "inject": ["<包名>"], "immediately": true } }
```

- `client-modules` 用 `exports["./client"]` 定位 bundle（`packages/client/modules/src/index.ts:208-218,765`）；
  缺文件会在**启动时**抛错并提示先 build
- bundle 是**factory 格式**，不是普通 ESM（见下面模板）——所有 shipped 客户端包由 tsdown 产出这一形态，
  但只要文件自己调 `window.__ModuleLoader__.load` 即可，**手写也合法**（本插件就手写）
- 浏览器端 `require()` 只能要 baseline 模块（`PLATFORM_MODULES`：React、Cordis、静态 UI 库）
  与 `dsh.client.external` 里声明的项；type-only import 会被擦除

```js
window.__ModuleLoader__.load({
  id: "<package name>",              // 必须等于包名
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })
    const React = require("react")
    // …组件…
    exports.NS = NS; exports.inject = inject; exports.apply = apply
    return module.exports
  },
})
```

### 设置分区

```ts
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap { 'settings.section': { kind: 'list'; scope: 'root'; owner: SettingsSectionOwnerProps } }
}
interface SettingsSectionOwnerProps { close: () => void }   // 唯一的 shell affordance
```

注册要经 `ctx.slots.inject('settings.section', () => ctx.slots.register({...}, Component))`：
**槽位由 shell 运行时声明**，声明前直接 `register` 会抛 `slot "…" is not declared`。

options：`name` / `id`（分区 key，驱动导航）/ `order` / `label`（可以是返回字符串的函数）+
可选 `inject`（业务面工厂，其返回值与 owner props 合并后传给组件）。

### 客户端服务名（易错）

| 客户端服务（`inject` 里写的） | 提供方 | 用途 |
| --- | --- | --- |
| `slots` | ui-slots | 槽位注册 |
| `locale` | dsh-client-locale | 字典；不用可省 |
| `settingsScope` | ui-settings | `bind({namespace})` → `SettingsScope<T>` |
| `settingsSchema` | ui-settings | schema 读取 |
| `remote` | api-gateway | Remote 注册表本体 |
| `remote.llm` | dsh-llm | `listProviders()` / `discoverModels(ns, req)` |
| `remote.credentials` | api-settings-controller | `describe(refs) → {configured, source, writable}` |
| `remote.settings` | api-settings-controller | `describe()` |

**`credentialsController` 是 Host 侧 service 名，客户端 injected 名是 `remote.credentials`。**
写错不会构建报错，而是在页面上显示 `web boot: … pending (waiting for service: …)`。

`SettingsScope<T>`：`getSnapshot()`（引用稳定）/ `subscribe()` / `set(field, value)` / `unset(field)` /
`mutate(ops, expectedRevision?)`。快照字段：`status`（loading/ready/unavailable）、`value`、`base`、
`user`（**字段是否出现在这里**才代表被用户覆盖）、`revision`、`writable`、`mode`。

### 渲染失败是**静默**的

slot 的 `SlotErrorBoundary` 捕获异常后渲染 `<div data-slot-error="<slotKey>" />`，并且
**崩溃的条目会被"abdicate"**：同一条注册再次挂载也不会重试。所以：

- 页面出现 `data-slot-error` ≈ 你的组件在渲染期抛了
- 只想看错误必须在**首次挂载前**挂 `console.error` 钩子（`componentDidCatch` 里 `console.error` 一次）
- 没有打包器的包，值得在 build 里用 stub React **真实跑一次组件渲染**当编译期检查。这个门禁的射程
  比"不抛错"更远：stub 的 `useEffect` 是空函数、`useState` 返回初值，所以**读取数据的组件渲染出的
  正是它的加载分支**；再配一个递归"展开函数组件元素"的 `expand()`，就能把组件树摊平成可断言的形状，
  于是"加载态必须出现哪些槽位""某个分支必须保留某个容器"这类**结构不变量**能在 build 期钉住，
  而这些在浏览器里只能靠肉眼和逐帧观察（本插件的 `scripts/check-client.mjs` 就是这么做的）

## 15. 第 7 期实读：Models 页扩展座、同源 Fetch 路由、以及"加不了 Remote 命名空间"（2026-09-11）

### 模型设置页的扩展座（唯一能往那一页加 UI 的口子）

`ui-settings-models` 声明了两个子槽位（`slot-contract.ts`），专为"仓库外的插件往模型设置页加 UI"：

```ts
'settings.models.provider-card': { kind: 'keyed'; scope: 'root'; owner: ProviderCardExtrasOwnerProps }
'settings.models.footer':       { kind: 'list';  scope: 'root'; owner: ModelsFooterOwnerProps }
```

- keyed 槽的**注册键 = provider 行的 settingsNs**（`ProviderDirectoryEntry.settingsNs`，如 `llm-pi-ai`），
  注册写 `ctx.slots.register({ name, key: 'llm-pi-ai', inject }, Component)`；组件拿到
  `{ provider, configured, keyConfigured }`（`provider.provider` 是路由 id）
- 派发点：`ModelsSection.tsx` 的三处 `renderSlot(...{entryKey: row.entry.settingsNs})`——**每个属于该
  settingsNs 的行都会派发**（含手写路由），所以组件必须自己按 `provider.provider` 收窄
- 挂载位置是**行卡片内部**（在 `编辑` 展开的编辑器之前），不是弹窗里

### 「获取可用模型」对话框**内部不可扩展**（入口可以接管）

`ModelListEditor`（`ui-settings-models`）里的候选列表只渲染 `candidate.id`，而 `LlmDiscoveredModel`
只有 `{ id, name?, contextWindow?, maxTokens? }`（`packages/llm/llm/src/types.ts:289`）。
能力/价格/套餐这类字段**既传不进去也显示不出来**，且没有任何 slot 落在弹窗内。
要在这个弹窗**里面**加字段 = 改 dsh，红线禁止。

但**入口**可以接管 —— 见下面的「接管宿主按钮的入口（第 7 期实战）」。前提是那个按钮确实在
插件能触到的 DOM 里，且插件有自己的对话框可以顶上。

### 客户端**加不了** Remote 命名空间

- 客户端能用的命名空间来自 `dsh-api-remotes`（`packages/api/remotes/src/client/index.ts`）里**写死的**
  contribution 清单，每个来自某包的 `/remote` 生成产物；插件的 client 半边不在其中
- `ctx.remote.$mount(contribution)` 虽是运行时公开方法，但客户端 `validateContribution` 要求
  descriptor 是 **strict codec**（`requireStrictDescriptor`），codec 的 `schema` 要 `{parse()}`；
  而且生成的 strict 产物本身属于 dsh 包。手搓一份等于把生成器的语义复制进插件，风险远大于收益
- 结论：**Host → 浏览器的新数据通道不要走 Remote，走下面这条同源 Fetch 路由**

### 同源 Fetch 路由：插件往浏览器送 Host 数据的正路

`ctx.connection.fetch.register({ path, methods, requestBody, fetch })`（`HostConnectionFetch`）——
精确 Fetch 路由，挂在共享 `/api` 通道上，**路径必须写成 `/api/...` 且余下段匹配
`/^[A-Za-z0-9_$.-]+$/`**（`endpointFromPath` + `assertFetchRoute`）。要点：

- 路由在 dsh 的 Connection 层之后：`isTrustedApiRequest`（Host/Origin 围栏）+ 浏览器会话认证都已通过，
  所以浏览器 `fetch('/api/<path>')` **同源**即可，不涉及 CORS、也不需要 token 头
- 归属 fiber：`ctx.connection` 的 `this.ctx` 是**读它的那个 ctx**，所以 `ctx.inject(['connection'], …)`
  里注册的路由随该 fiber 卸载
- `connection` 是 web profile 才有的服务：非 web 部署里 `ctx.inject` 的回调不跑，插件其余能力不受影响
- 类型来自 `@deepseek-ai/dsh-client-connection`（`declare module '@deepseek-ai/cordis'` 提供
  `ctx.connection`）；只需 `import type {} from '@deepseek-ai/dsh-client-connection'` 拉声明合并
- 参考实现：`packages/client/file-upload/src/index.ts:73`（`/api/session/uploadFileBinary`）、
  `packages/session-query/session-log-export/src/index.ts:85`（`/api/session.export`）

### 设置写入的现实约束（第 7 期踩到）

`llm-pi-ai` 的 profile 里 `models` 是**整体替换**语义：用户层一旦写了数组，patch 预设的数组就不再生效。
所以"往路由加一个模型"必须先把**当前生效的数组**读出来（用户层有则用用户层，否则用 `base`），
再追加写回；直接写新数组会把预设的免费模型全部丢掉。

`reasoning_options` 里的 `none` 不是 dsh 的档位键（`off|minimal|low|medium|high|xhigh|max`），
映射必须是 `off: 'none'`（键 dsh、值线上）；写错键整节 schema 校验失败、写入被拒。

**重叠的读改写会互相围栏**：`SettingsScope.mutate(ops, expectedRevision)` 带着期望版本号写入，
两个并发操作里后一个是基于**已被前一个取代**的 revision 算出来的，会被判为冲突拒掉。
症状是"连点两次删除只生效一次"，而且不报错、界面也看不出来。正确做法是把连发操作**合并成一次写**
（本插件的模型卡片用一个 120ms 的防抖批处理，把一段时间内的删除与字段编辑合成一个 `mutate`），
或者自己串行化并在每次写前重读 revision。

**写入成功与否由文档决定，不由返回值决定**：scope 不报告失败（被拒或没送达的写会重新加载镜像然后
静默收场），所以判断"写进去了没有"必须回读文档。本插件每次写完都重新读一遍，只有文档里真的没有了
才算删掉，否则才去重挂卡片。

### 浏览器基线的真实清单：`react-dom` 与 UI primitives 都在表里（第 7 期实测）

- `PLATFORM_MODULES`（`packages/client/web/src/platform.ts`）= `react`、`react/jsx-runtime`、
  `react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、
  `@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、
  `@deepseek-ai/dsh-client-ui-dockkit`
- 这张表就是浏览器 `require` 解析 external 的**隐式基线**：基线内的模块**不需要**写进
  `dsh.client.external`；只有基线之外的精确请求才要声明，且必须由某个动态包 row 或静态表键回答
- 在**安装版** 0.1.5-rc.1 上逐字核对过：shell bundle（`dsh-web-frontend/dist/assets/index-*.js`）
  的种子表对象确实以这 9 个键建表；`@deepseek-ai/dsh-client-ui-primitives` 的导出面确实含
  `Modal` / `Button` / `Pill` / `Tag` / `Input` / `Switch` / `Tooltip` 等（dsh 自己的
  `ui-settings-models/lib/client.js` 就从它取 `Modal`、`Button`）
- 因此插件 bundle 可以直接用 dsh 的对话框原子：`Modal` 自己 portal 到 `body`，自带 Escape 与遮罩关闭、
  `role="dialog"` + `aria-label`（= title）、`footer` 槽——做出**同款**界面而不是仿制品；`Tag`
  的 `tone` 里 `outline` 是只读默认样式
- `Input` 原子的宽度由它自己的 CSS module 决定（`.wrap` 是 `inline-flex`、没有宽度），插件只能传
  className 传不了 style；需要受控宽度（例如 `flex: 1` 的搜索框）时用裸 `<input>` + `--dsw-*` token 更省事

### 接管宿主按钮的入口（第 7 期实战）

- **DOM 关系是前提**：`settings.models.provider-card` 的派发点与 `renderProviderEditor(...)` 是
  **同一个 `<li>` 卡片内的兄弟节点**（`ModelsSection` 的三处 `renderSlot(...)` 实测），所以插件留一个
  隐藏标记（如 `data-kenari-model-picker`）就能判断"这个按钮属于我关心的那张卡"
- **捕获阶段能抢在 React 前面**：React 18 把监听挂在根容器上，`document` 上的**捕获**监听先跑，
  `stopPropagation()` 之后根容器收不到，dsh 自己的 onClick 不会执行
- **按钮的身份只有文本可用**：class 是 CSS module 哈希，兄弟位置随"重置模型目录"链接是否渲染而变；
  所以按 dsh 自己的标签匹配，双语都写上。`模型目录`（`ModelListEditor`）里是**两颗**按钮：
  `addModel: '添加模型'` / `'Add model'`（原生插一行空白条目）与
  `fetchModels: '获取可用模型'` / `'Fetch available models'`（原生问提供方要目录）
- **卡片范围要从标记那一侧问**：`provider-card` 的卡片元素是 `<li>`，而每张 `<li>` 之上有共同的
  `<ul class="rows">`（`ModelsSection` 实测）。所以"从按钮往上走，第一个含标记的祖先"是**错的** ——
  从兄弟卡片的按钮往上走，第一个含标记的祖先就是那个 `<ul>`，别的 provider 的同名按钮会被一并接管
  （症状：原生该插一行空白条目，结果弹出了插件的对话框，还不报错）。
  正确写法是取标记自己的卡片（`marker.closest('li')`，退路为它的父元素）再 `card.contains(button)`：
  范围由标记定义，才精确；行卡片不是 `li` 时 `closest` 落空、`contains` 为假，接管自动退回原生
- **必须 fail-open**：`preventDefault` 之前排除四种情况——没有监听者（本卡未挂载）、按钮不在标记自己的
  卡片内（别的 provider 的同名按钮）、点击来自插件自己的弹窗（portal 到 `body`，往上找不到标记）、
  插件自己重放的那次点击（一个 bypass 标志）
- 需要"退回原生"时：置 bypass → 对原按钮调 `.click()` → 下一个 tick 复位。注意 disabled 的按钮
  不派发 click，这条回退只对可点的原生按钮有效
- **写盘语义要自己扛**：插件的弹窗够不到编辑器的 draft，只能即时 `settings.mutate`；副作用是编辑器
  那份列表在重新展开前是旧的（dsh 自己的「重置模型目录」在编辑器开着时同样如此，不是插件引入的异常）

## 16. `Modal` 实读：无动画、尺寸不受约束（2026-09-13）

来源：`packages/client/ui-primitives/src/Modal.tsx` 与 `Modal.module.css`（vendor 源码），
外加在安装版 0.1.5-rc.1 的浏览器里逐帧实测。

### 没有任何动画，也没有退场阶段

- `Modal.tsx:50` 是 `if (!open) return null`：**关闭态不渲染任何东西**，所以不存在"先播退场再卸载"
  的可能。想让对话框淡出，只能由调用方自己延迟卸载（保持挂载 + 一个 closing 标记 + 定时器）
- `Modal.module.css` 里**没有 transition、没有 @keyframes**。挂载即最终态，卸载即消失
- 实测（1280×720，占满一帧的采样）：点「取消」到 `[role="dialog"]` 从 DOM 消失 **10ms**；
  点开按钮到对话框出现 **12ms**。也就是一帧硬切
- 结论：dsh 自己所有弹窗都是硬切，插件不引入动画不是缺失，而是与宿主一致。要加动画只能自己写，
  且必须限定在插件自己的 `className` 作用域内

### DOM 形状与可作用的钩子

```
body > .root (fixed inset:0, flex 居中, padding 24, 无 max-height)
        ├── .mask  (absolute inset:0, aria-hidden="true", 点击 = onClose)
        └── .dialog (role="dialog", aria-modal, aria-label = title, 拼接 className)
              .content > (.header > h2 + .close) (.description?) (.body)
              .footer (footer 槽)
```

- `className` 只合并进 `.dialog`；**没有 style 透传**。要按实例改宽度或尺寸，只能注入 CSS 规则，
  并用 `[role="dialog"]` 限定来赢过基础规则的优先级（本插件的挑选器宽 820px 就是这么来的）
- `.dialog` 基础宽度 `min(380px, 100%)`，适合 dsh 自己的短列表；带标签列的宽表格要自己加宽
- 每个 class 都是 CSS module 哈希，**不要按 class 匹配**；`[role="dialog"]` 与 `aria-label`（= title）
  是稳定钩子
- Escape 与遮罩点击都走 `onClose`；`Modal` 只在 `open` 为真时挂 `keydown`

### 尺寸完全由内容决定，且没有上限

- `.root` 没有 `max-height`、也没有滚动容器（实测 `overflow: visible`、`max-height: none`），
  尺寸安全完全由内容决定
- padding 虽写 24px，但 `align-items: center` 在卡片高于可用空间时会把**负的剩余空间均分到上下**，
  于是 padding 先被吃掉。实测：684px 的卡片在 720px 视口（可用 672px）里落成 top 18 / bottom 702，
  两侧 padding 各被压掉 6px。**卡片高度超过视口高度（这里 720px）才会真正溢出**，在那之前只是
  内边距被压缩。（按"684 + 48 > 720 所以溢出了"算会得出错误结论，要以实测为准）
- 长列表的滚动必须自己给：给列表容器 `maxHeight` + `overflowY`（本插件用 `min(52vh, 420px)`）
- **异步内容会让卡片在出现之后改变尺寸**，这是弹窗"不丝滑"的主要来源。一个先渲染一行加载提示、
  数据到位再渲染完整面板的对话框，会在出现的下一帧长高：实测从 201px 到 684px，483px 的跳变，
  而且冷缓存时加载态停留更久、两段式观感更明显
- 要让尺寸稳定，**加载态必须渲染与就绪态同一副骨架**（工具条、摘要位、列表盒子都在，只有文字不同），
  而不是只渲染一行提示。反过来，任何"某个分支少渲染一个容器"的写法都会破坏它：本插件的
  `CatalogRows` 在过滤结果为空时曾把整个列表盒子换成一行提示，卡片立刻从 684px 塌到 309px
- 列表盒子两端同尺寸（`minHeight` 与 `maxHeight` 取同一个值）还能顺带消掉"一边输入筛选词、
  对话框一边缩放"的抖动
