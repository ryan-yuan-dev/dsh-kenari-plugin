# 知识库索引

本目录只存放**经过验证、长期准确**的技术事实：接口签名、配置语义、字段定义、协议约束。

**不写入**：过程记录、推理结论、项目决策、待办事项。这三类分别属于 `docs/plans/`、`docs/handoff/`（命名 `NNN-yyyy-MM-dd-HHmmss-title.md`）与 `AGENTS.md`。

## 文档

| 文档 | 内容 |
|---|---|
| [plugin-rules.md](plugin-rules.md) | 开发规则与约束（12 条，必须遵守） |
| [dsh-plugin-model.md](dsh-plugin-model.md) | dsh 插件模型：模块形态、配置、打包、层序、安装 |
| [dsh-web-seam.md](dsh-web-seam.md) | web 能力缝：provider 接口、选择语义、dsh-base 默认配置 |
| [dsh-other-seams.md](dsh-other-seams.md) | llm / settings / credentials / tools / MCP 客户端接口 |
| [dsh-source-verified.md](dsh-source-verified.md) | vendor 源码实读：patch 语义、模块加载、seam 签名、依赖包名（权威性最高） |
| [kenari-api.md](kenari-api.md) | Kenari 端点、鉴权、schema、计费 |

## 来源与优先级

**权威性从高到低**：

1. `vendor/deepseek-harness` submodule 源码（`dsh-source-verified.md`）—— 实现即真相
2. npm 包的 `.d.ts` 与 `cordis.patch.yml` —— 实现即真相，**优先于文档**
3. 官方文档站 `https://deepseek-harness.github.io/deepseek-harness/en/` 的 develop / reference 章节
4. `https://kenari.id/openapi.json`（OpenAPI 3.1 spec）

以下两个页面内容很薄，**不可作为依据**：

- `https://kenari.id/en/docs/agents` —— 只有 MCP 工具功能表，无参数、无配置 JSON、无传输类型
- `https://deepseek-harness.github.io/deepseek-harness/en/guide/quickstart` —— 只是 Web UI 使用说明，无插件内容

Kenari 的 MCP 配置与传输类型在 `https://kenari.id/en/docs/tools`。

## 版本锚点

每条事实标注其验证所依据的包版本。dsh 的 rc 线之间行为有差异（见 `dsh-web-seam.md` 的 SSRF 与 fetch 默认值说明），脱离版本引用会出错。

本库核实于 2026-09-10，依据版本 **`0.1.5-rc.1`**（实装于 `~/.dsh`，全局安装于 `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh`）：

| 包 | 版本 |
|---|---|
| `@deepseek-ai/dsh` | `0.1.5-rc.1` |
| `@deepseek-ai/dsh-base` | `0.1.5-rc.1` |
| `@deepseek-ai/dsh-web` | `0.1.5-rc.1` |
| `@deepseek-ai/dsh-tool-web` | `0.1.5-rc.1` |
| `@deepseek-ai/dsh-web-search-deepseek` | `0.1.5-rc.1` |
| `@deepseek-ai/dsh-web-fetch-http` | `0.1.5-rc.1` |
| `@deepseek-ai/dsh-mcp-client` | `0.1.5-rc.1` |
| `@deepseek-ai/dsh-llm` | `0.1.5-rc.1` |
| `@deepseek-ai/dsh-tools` | `0.1.5-rc.1` |
| `@deepseek-ai/dsh-credentials` | `0.1.5-rc.1` |
| `@deepseek-ai/dsh-web-search-exa` | **未安装** |
| Kenari API | `https://kenari.id/openapi.json`，rc 期 |

源码锚点：`vendor/deepseek-harness` submodule，tag `dsh-v0.1.5-rc.1`。

## 安装子包的版本陷阱

dsh 各子包的 npm `latest` 与 `next` 标签**可能不一致**，且 `latest` 未必与 dsh 主版本对齐：

```
@deepseek-ai/dsh-web-fetch-http
  latest: 0.0.1-rc.5     ← 默认装这个，与 dsh 0.1.5-rc.1 不匹配
  next:   0.1.5-rc.1     ← 与主版本对齐
```

**安装任何 dsh 子包时必须显式指定版本**，例如 `add @deepseek-ai/dsh-web-fetch-http@0.1.5-rc.1`。依赖裸包名会装到不对齐的 `latest`。
