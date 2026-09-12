# dsh 插件模型

来源：`/en/develop/basic/`（含 tool / config / publish）、`/en/reference/`、`@deepseek-ai/dsh-base` 的 `cordis.patch.yml`。

## 插件是一个 TypeScript 模块

导出 `name`、可选的 `inject`、以及 `apply(ctx, config)`。框架加载时调用 `apply` 并传入上下文。

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'greet-tool'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet someone by name.',
    parameters: { name: { type: 'string', required: true, description: 'The name to greet' } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) { return `Hello, ${args.name}!` },
  }))
}
```

- `inject` 让 Cordis 等待所需服务就绪后再加载插件
- `defineTool` 从 `parameters` 推断并校验参数
- `execute` 返回 `output.schema` 声明的规范值
- `output.render` 把该值转成面向模型的内容

三种形态：函数模块（默认）、对象形态（`export default { name, inject, apply }`）、类形态（继承 `Service`，用于向其他插件提供服务）。

## 生命周期与资源回收

通过 `ctx` 注册的一切（事件监听、工具、定时器）都是 effect，插件卸载时自动回收。**不要手动 `removeListener` 或 `clearInterval`。**

需要显式资源时用 `ctx.effect()`，返回的函数在卸载时执行：

```ts
ctx.effect(() => {
  const timer = setInterval(() => {}, 5000)
  return () => clearInterval(timer)
})
```

HMR 时框架卸载旧实例、加载新实例，因为注册是 effect，不会残留旧实例的注册。

## 配置

导出 `Config` 接口与**同名**的 Schemastery schema。默认值写在 schema 字段上。

```ts
import Schema from '@deepseek-ai/schemastery'

export interface Config { apiKeyEnv: string; timeoutMs: number }
export const Config: Schema<Config> = Schema.object({
  apiKeyEnv: Schema.string().default('KENARI_API_KEY'),
  timeoutMs: Schema.number().default(30000),
})

export function apply(ctx: Context, config: Config) { /* ... */ }
```

- schema 在插件加载时校验，非法配置直接加载失败并给出可操作错误
- **不要导出普通对象当 Config**，它不实现 Cordis 要求的 Standard Schema 接口
- 设计原则：**任何两个部署可能设成不同值的量都必须是配置字段**，不得硬编码。判据是"能否不改代码就通过 cordis.yml 改掉"

## 打包：bundle 与 profile

两个概念都由 `package.json` 的 `dsh` 字段描述，但回答不同问题：

- **bundle**：npm 包，携带一个配置层。声明 `dsh.bundle.patch`，回答"这个包贡献什么"
- **profile**：`$DSH_HOME/profiles/<name>` 下的目录，描述一次可运行组合。声明 `dsh.profile.bundles`，回答"哪些 bundle 按什么顺序组合"

bundle 是作者编写并分发的，profile 是用户启动的（`dsh --profile <name>`）。**两者不可兼。**

bundle 的最小结构：

```
hello-plugin/
├── package.json       # 声明 dsh.bundle
├── cordis.patch.yml   # 被 profile 列入时应用的层
└── index.js           # patch 行引用的插件模块
```

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

patch 行用**包名**引用（不是相对路径），让 Node 解析找到已安装代码：

```yaml
- insert:
    - id: hello
      name: dsh-hello-plugin
```

未声明 `dsh.bundle` 的包仍可安装，但只作为普通依赖，`dsh plugin` 会警告且不激活任何层。

## 层序

以空根为起点，按序应用：

1. profile 的 `dsh.profile.bundles` 中每个 bundle patch，按列表顺序（`@deepseek-ai/dsh-base` 第一）
2. profile 自己的 `cordis.patch.yml`
3. 家目录的 `$DSH_HOME/cordis.patch.yml`
4. 任何 `--patch` 覆盖层

**patch 按 id 定位行，替换整行 config，不合并。最后写入者胜。** 因此覆盖某行时，该行 config 的完整字段都必须写出，遗漏的字段会丢失。

> 原文（dsh-base patch 注释）：Later bundle patches and the user's profile cordis.patch.yml address these rows by id, with the last write winning per row.
>
> 原文（reference）：A patch replaces the targeted row's whole `config` rather than merging into it.

## 安装与验证

```sh
dsh plugin --profile <name> add ./my-plugin     # 安装（转发给 pnpm）
dsh --profile <name> --dump-config              # 查看组合结果，应出现 "# == <pkg>" 层
dsh --profile <name>                            # 启动
dsh plugin --profile <name> remove <pkg>        # 卸载，同时移除依赖与层
```

首次使用 `dsh plugin` 会初始化 profile，以 `@deepseek-ai/dsh-base` 作为第一个 bundle。包若声明 `dsh.bundle`，`dsh` 会自动把它追加到 `dsh.profile.bundles`。

### `add` 既是安装也是升级（2026-09-13 实测）

同一命令带版本号就完成升级，profile 的依赖被换成那一个：

```sh
dsh plugin --profile web add my-plugin@0.2.3
```

- 本地目录安装与 registry 安装**互相替换**：先 `add link:/path`（或 `add "$PWD"`）再 `add my-plugin@0.2.3`，`node_modules` 里的软链会换成真实目录
- **装完要重启**：新版本的 Host 侧要重新加载才生效，不要指望换完依赖就自动切过去（本仓库的升级流程一律在重启后复验）
- 设置文档（`~/.dsh/settings.yaml`）不受影响，只替换依赖本身
- 验证换过来了没有：`--dump-config` 看层，以及读 `node_modules/<pkg>/package.json` 的 `version`

### pnpm 自动维护 `minimumReleaseAgeExclude`

pnpm 12 有一道"新发布的包先别装"的供应链策略。用 `dsh plugin add` 装刚发布的版本时，它会自己把
该版本追加进 profile 的 `pnpm-workspace.yaml`，然后照常安装：

```
Added 1 entry to minimumReleaseAgeExclude in pnpm-workspace.yaml
  (set minimumReleaseAgeStrict to true to gate these updates with a prompt):
  my-plugin@0.2.3
```

追加是**合并**进已有条目的（同一行累成 `pkg@0.1.1 || 0.2.0 || 0.2.3` 的形式），所以**不需要手动维护**
这个列表——手动加只是重复它的动作。要让这类安装变成需要确认的门，设 `minimumReleaseAgeStrict: true`。

## 已发布的 profile 模板

`web`、`headless`、`sdk`、`sdk-minimal`、`acp`。

`dsh-base` 是 `web` / `headless` / `sdk` / `acp` 的共享第一层：模型适配器、工具、持久化、沙箱与审批策略、设置、凭据、遥测。`dsh-web-app` 加浏览器应用，`dsh-headless` 加无服务一次性运行器，`dsh-sdk-app` 加 SDK JSON-RPC 服务，`dsh-acp-app` 加自动化 ACP 服务。`dsh-sdk-minimal` 是例外：一个 bundle 拥有自己完整的显式 SDK 树，不应用 `dsh-base`。

自定义 profile 默认实时 patch 重载；`headless` / `sdk` / `sdk-minimal` / `acp` 在启动时一次性应用所有层（因为它们是一次性或 stdio 应用，事后替换依赖会破坏生命周期）。

## 客户端模块（设置卡片用）

Host 半边与浏览器半边同在一个包：Host 在 `src/`，浏览器在 `src/client/`，导出为 `./client` 并在 package.json 声明 `dsh.client`。

`ctx.clientModules`（`ClientModuleRegistry`）扫描 host Loader 中声明 `dsh.client` 的包，组合 `window.__DSH_BOOT__` 入口图，在 `/plugins` 下提供带版本的 combo 脚本。

设置 namespace 是两半的 join key，必须拼写一致。Host 半边用 `ctx.settings.installSection()` 注册，它把条目分层放在用户文档之下，且在没有 settings provider 挂载时也能工作：

```ts
ctx.inject(['settings'], (settingsCtx) => {
  settingsCtx.settings.installSection(ctx, MY_PLUGIN_NS, Config, config, {
    validate: (value) => void assertReachable(value.endpoint),
  })
})
```
