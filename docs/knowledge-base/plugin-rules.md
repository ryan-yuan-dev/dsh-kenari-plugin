# dsh 插件开发约束

本文件记录**由 dsh 框架机制决定的硬约束**。每条都给出机制依据；违反会导致明确的失败模式。

不包含项目决策与目录约定，那些在 `AGENTS.md`。

---

## 1. 不改动 dsh 包

dsh 的扩展机制是 Cordis 插件行与 patch 层，不是修改包本身。

| 操作 | 是否属于受支持的扩展方式 |
| --- | --- |
| `insert` 新增插件行 | 是 |
| 按 id 覆盖已有行的 config | 是 |
| `ctx.web.registerSearchProvider` / `registerFetchProvider` | 是 |
| `ctx.llm.registerAdapter` | 是 |
| `ctx.settings.installSection` | 是 |
| `ctx.tools.register` | 是 |
| import dsh 包导出的类并实例化以复用逻辑 | 是 |
| 修改 dsh 包的源码或配置 | 否 |
| fork dsh 包或给 dsh 包打 patch | 否 |

**依据**：`@deepseek-ai/dsh-base` 的 `cordis.patch.yml` 注释原文：

> Later bundle patches and the user's profile cordis.patch.yml address these rows by id, with the last write winning per row.

按 id 覆盖行是官方设计的扩展点。

**失败模式**：改包会在 dsh 升级后丢失，并与其他插件冲突。

---

## 2. patch 替换整行 config，不合并

```yaml
# 只写 searchProvider 时，该行的 fetchProvider 会丢失
- id: web
  config:
    searchProvider: my-provider
    fetchProvider: my-provider   # 必须一起写
```

**依据**：`dsh-base` 注释原文 —— "A patch replaces the targeted row's whole `config` rather than merging into it."

**失败模式**：配置字段静默丢失。

---

## 3. 不要重复注册已存在的 provider id

`dsh-base` 已注册 id 为 `deepseek-official` 的 search provider。若再注册同 id 的 provider，`registerSearchProvider` 抛 `WEB_DUPLICATE_PROVIDER`。

需要复用其逻辑时，import 其导出的类并实例化，**只持有实例直接调用方法，不注册**。

**失败模式**：`WEB_DUPLICATE_PROVIDER`，插件加载失败。

---

## 4. `web_search` / `web_fetch` 的工具面由 `dsh-tool-web` 独占

工具名、参数 schema、参数校验、结果上限、提示词、展示全部在 `@deepseek-ai/dsh-tool-web` 一个 consumer 内。provider 只注册能力，不注册工具。

接入新的 web 后端应实现 `WebSearchProvider` / `WebFetchProvider` 注册进 `ctx.web`。

**依据**：`dsh-tool-web` 的模块文档 —— "This package owns schemas, validation, prompt guidance, limits, and presentation, never concrete providers."

**失败模式**：与原生工具同名，模型调用目标不确定。

---

## 5. `available()` 不得发网络请求

接口契约原文：

> Cheap local usability check; must not make network calls.

只能做本地判断（凭据是否存在、配置是否可解析）。它是执行时选择的输入，不是健康检查系统。

provider 的真实可用性因此在 `search()` / `fetch()` 调用时才暴露，失败以 `WebError` 抛出。

**失败模式**：每次 provider 选择都产生网络往返。

---

## 6. web provider 选择没有回退链

`ctx.web` 的选择规则（调用时解析，与注册顺序无关）：

```
配置了 id 且已注册且 available()  → 该 provider
配置了 id 但未注册               → WEB_PROVIDER_CONFIGURED_MISSING
配置了 id 但不可用               → WEB_PROVIDER_CONFIGURED_UNAVAILABLE
未配 id + 恰好一个可用           → 自动选中
未配 id + 多个可用               → WEB_PROVIDER_AMBIGUOUS
未配 id + 无可用                 → WEB_PROVIDER_UNAVAILABLE
```

**依据**：`@deepseek-ai/dsh-web` 的 `WebService` 文档 —— "Selection never depends on registration, config, or HMR order"；"multiple usable providers with no configured id is `WEB_PROVIDER_AMBIGUOUS`, not first-wins."

**失败模式**：注册多个 provider 且不配 id，得到 `WEB_PROVIDER_AMBIGUOUS` 而非自动选择。

---

## 7. key 只写不读

`ctx.credentials` 的 `describe(ref)` 返回 `{configured, source, writable}`，**没有承载值的字段**。

取用值用 `resolve(ref)`；判断状态用 `describe(ref)`。值不得进入日志、错误消息、UI。

`assertUsableApiKey(raw, pkg, ref)` 在失败时只报引用名，不报值，遵循同一原则。

**依据**：`describe()` 的文档 —— "never the value. The view has no slot a value could ride in."

**失败模式**：密钥泄漏。

---

## 8. 环境变量来源的凭据 `writable: false`

本地凭据 provider 对由活动进程环境提供的引用报告 `writable: false`。此时写入会看似成功但解析仍返回遮蔽值，所以 seam 拒绝写入。

配置 UI 必须把这类引用渲染为只读。

**依据**：`dsh-credentials` 文档 —— "a write would appear to succeed while resolution kept returning the shadowing value, so the seam rejects it and the UI can render the reference read-only up front."

**失败模式**：用户以为改成功了，实际未生效。

---

## 9. 消费者每次操作重新解析凭据，不跨操作缓存

这是热轮换机制。LLM adapter 每次模型请求解析一次，所以轮换后的凭据下一次请求即生效，无需重启。

**依据**：`dsh-credentials` 文档 —— "Consumers re-resolve at each operation and never cache across operations — that per-operation read is the hot-update mechanism."

**失败模式**：缓存凭据导致轮换不生效。

---

## 10. 可调值必须是配置字段

框架要求：任何两个部署可能设成不同值的量都必须是配置字段。

判据：**能否不改代码就通过 cordis.yml 改掉？**

配置用 Schemastery schema 声明。**不要导出普通对象当 `Config`**，它不实现 Cordis 要求的 Standard Schema 接口。

**依据**：插件配置文档 —— "Harness requires anything that two deployments may want to set differently to be a configuration field."

**失败模式**：schema 校验失败或默认值不生效。

---

## 11. 用 effect 管理资源

通过 `ctx` 注册的一切（工具、事件监听、定时器）都是 effect，插件卸载时自动回收。

**不要手动 `removeListener` 或 `clearInterval`。** 需要显式资源时用 `ctx.effect()` 并返回 disposer。

**依据**：插件生命周期文档 —— "Anything registered through ctx—event listeners, tools, or timers—is cleaned up when the plugin unloads. You do not need to call removeListener or clearInterval manually."

**失败模式**：HMR 或卸载后残留注册，产生重复行为。

---

## 12. 计费端点按次扣费

`POST /v1/web/search`、`POST /v1/web/fetch`、`POST /v1/x/search` 按次计费到余额，**与模型资金来源无关**（metered 与 BYOK 都付费）。

失败调用不计费；成功调用计费。

**依据**：Kenari OpenAPI 的 operation description —— "Billed at the per-search rate regardless of model funding (metered and BYOK both pay)."

**失败模式**：测试消耗真实余额。

---

## 13. 计费工具不得用于分享页 key

来自分享页的 key 调用 balance / usage / quota 会返回 403，因为这些工具读取 key 所有者的账户数据。spending 类工具仍可用。

**依据**：Kenari agents 文档 —— "balance, usage, and quota tools are rejected for keys from a share page, because those read the owner's account data."

**失败模式**：对分享页 key 反复重试 403。

---

## 14. 生成类调用超时不得自动重试

按次/按页/按秒计费的端点（`/v1/images/*`、`/v1/ocr`、`/v1/audio/*`、`/v1/videos/*`、`/v1/x/search`）在客户端超时后**不能重试**：请求可能已在服务端完成并扣费，重试会造成重复计费。

网络错误、429、5xx 仍可重试——那些状态下服务端明确未产生成功结果。

**实现**：`KenariRequestOptions.retryTimeouts: false`，配套更长的单次超时（`generationTimeoutMs`，默认 180s；30s 对图像生成不够）。

**依据**：Kenari 计费规则「失败调用不计费，成功调用计费」只在服务端判定成功/失败；客户端超时不等于服务端失败。

**失败模式**：用户为同一次生成付两次钱。

---

## 15. 二进制产物走 attachment seam，不塞进 value

工具的 `execute` 返回值必须是 lossless JSON，字节进不去。图像/音频/视频要用 `ctx.attachments.saveImage/saveFile` 落盘，把返回的引用（纯 JSON）放进 value，再由 `output.render` 重建成 `image` / `file` block。

**依据**：`ContentBlock` 的 `image`/`file` 只承载 `ImageAttachmentRef`/`FileAttachmentRef`，字节由 attachment 服务持有（硬约束源自 value 的 JSON 约束与 attachment 的所有权模型）。

**失败模式**：把 base64 塞进 value → 会话日志爆炸或 schema 校验失败。

---

## 16. 瀑布事件里不调用 `next()` 会否决整条链

`agent/request-error`、`agent/request`、`session/event`、`llm/stream` 这类 waterfall 事件**没有默认行为**：监听器按注册顺序从外层到内层串起来，谁不调用 `next()`，它后面（更内层）的监听器就永远不会被调用，包括 `dsh-llm-retry`、`compaction-basic` 这些 dsh 自带的策略。

**要求**：

1. 插件在 waterfall 上注册的监听器，除非**有意**否决整条链，否则必须先 `await next()`，再决定自己要不要介入；下游抛错记 `logger.warn` 后继续，而不是让恢复逻辑静默失效。
2. 注册顺序由装载时刻决定，**插件读不到、也控制不了**。所以任何「另一个策略会替我做 X」的设计都必须附带一个**可观察的验证**（例如读会话里的事件、或者自己兜底），不能只靠顺序假设。
3. 内层决定放弃的表现是返回 `undefined`，不是抛错；`{kind:'retry'}` 一类的决定要原样透传给调用方。

**依据**：cordis 的 `waterfall` 是 `cbs.shift()` 串成的链（`vendor/cordis/src/events.ts:235-242`），注释原文「a listener that does not call `next()` vetoes the rest of the chain」。2026-09-13 的实例：插件把「5 次重试」外包给 `dsh-llm-retry`，而插件自己是个不调用 `next()` 的监听器；顺序一旦被 live reload 翻过来，llm-retry 就永久出局，8 个会话日志里 `llm/retry` 事件数为 0，承诺的重试从未执行（详见 `docs/handoff/004-*`）。

**失败模式**：功能「静默消失」—— 没有报错、没有日志，只有行为悄悄退化。
