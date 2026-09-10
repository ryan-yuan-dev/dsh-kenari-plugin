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
