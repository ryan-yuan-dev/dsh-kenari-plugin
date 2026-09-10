# AGENTS.md

## 仓库

`dsh-kenari-plugin` —— DeepSeek Harness（dsh）bundle 插件，让 Kenari（kenari.id）成为 dsh 的一等公民：模型可作会话模型、REST 能力成为 agent 工具、默认 web 不可用时回退到 Kenari。

**当前状态：第 0 期（骨架与配置层）已完成并验证。** 骨架、patch 层、构建链已就绪并装进 web profile。

## 最高纪律

**绝不修改 dsh 的任何代码或包。** 只做插件扩展。

允许：新增插件行、按 id 覆盖已有行 config、通过 seam 注册 provider/adapter/设置节、import dsh 包的类复用逻辑。
禁止：改 `dsh-base`/`dsh-web`/`dsh-tool-web` 等任何 dsh 包的源码或配置、fork dsh 包、给 dsh 包打 patch、编辑 `node_modules`。

## 目录

| 目录 | 用途 |
|---|---|
| `docs/knowledge-base/dsh/` | **dsh 自身**的技术事实：插件模型、web 缝、其他缝、vendor 源码实读。**改代码前先读，不要凭记忆推测接口** |
| `docs/knowledge-base/kenari-plugin/` | **Kenari 侧**的技术事实：端点、鉴权、schema、计费 |
| `docs/knowledge-base/plugin-rules.md` | 跨两者的开发规则：13 条硬约束 |
| `docs/plans/` | 设计文档与实施计划 |
| `docs/handoff/` | 交接文档，命名 `NNN-yyyy-MM-dd-HHmmss-title.md` |
| `src/`、`cordis.patch.yml` | 插件源码与 patch 层（第 0 期已创建） |

**硬规则：交接文档文件名必须是 `NNN-yyyy-MM-dd-HHmmss-title.md`** —— `NNN` 三位序号从 `001` 递增，时间戳为创建时刻本地时区，`title` 为简短中文描述。新增时序号取当前最大值 +1。不要用 `README.md`。旧交接文档是归档，不再维护；仍有效的关键事实在写新交接时复制过去。

## 必读顺序

1. `docs/handoff/` 下**序号最大的那一份**交接文档 —— 只读这一份。交接文档是追加式快照，最新一份必须自足；旧文档一律不读（省上下文），写新交接时把旧文档仍有效的关键事实复制进新文档，不做"见 `00N-*`"式跳转引用
2. `docs/knowledge-base/plugin-rules.md` —— 13 条硬约束，**动手前必读**
3. `docs/plans/2026-09-10-dsh-kenari-plugin-design.md` —— 完整设计与分期实施
4. 按任务选读知识库（dsh 侧与 Kenari 侧已分目录）：
   - `docs/knowledge-base/dsh/dsh-source-verified.md`（**权威性最高**，patch 语义 / seam 签名 / 依赖定版）
   - `docs/knowledge-base/dsh/dsh-web-seam.md`（web fallback）、`docs/knowledge-base/dsh/dsh-plugin-model.md`（骨架/打包）、`docs/knowledge-base/dsh/dsh-other-seams.md`（llm/settings/credentials）
   - `docs/knowledge-base/kenari-plugin/kenari-api.md`（端点/schema）

## 最容易踩的五条

1. **patch 的 `config` 键整体替换、`disabled` 是独立键。** 覆盖 `- id: web` 时 `searchProvider` 与 `fetchProvider` 必须一起写；重新启用 `tool-web` 只需 `disabled: false`
2. **web seam 没有回退链。** 多个可用 provider 且未配 id 报 `WEB_PROVIDER_AMBIGUOUS`，回退须自行组合
3. **实现 provider，不自建 `web_search`/`web_fetch` 工具** —— 工具名与 schema 由 `dsh-tool-web` 独占
4. **兜底 provider 实例绝不能注册** —— id 冲突抛 `WEB_DUPLICATE_PROVIDER`，插件加载失败；只能持有实例调方法
5. **`available()` 禁止发网络请求**（契约写死），故回退发生在调用失败之后

其余约束见 `docs/knowledge-base/plugin-rules.md`。

## 环境

| 项 | 值 |
|---|---|
| dsh | `0.1.5-rc.1`，全局安装（`dsh` 在 PATH） |
| 源码 | `vendor/deepseek-harness` submodule，tag `dsh-v0.1.5-rc.1` |
| 包管理 | pnpm `12.3.4`（`dsh plugin` 转发给它，必需） |

**安装 dsh 子包必须显式指定版本**，npm `latest` 未必与主版本对齐：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-web-fetch-http@0.1.5-rc.1
```

## 命令

```sh
pnpm build                                     # tsc 编译到 lib/（改源码后即生效，本地是 pnpm link）
dsh plugin --profile web add <pkg>@<version>   # 安装（务必带版本）
dsh --profile web --dump-config                # 验证层生效
dsh plugin --profile web remove <pkg>          # 卸载
dsh --profile web                              # 启动（默认端口 3080）
```

第 0 期验证标准已达成：`--dump-config` 出现 `# == dsh-kenari-plugin` 层，`dsh --profile web` 启动无报错。

## 下一步

第 1 期：web fallback（Kenari HTTP 客户端 + search/fetch/fallback provider）。要点与验证标准见 `docs/handoff/` 下最新交接文档（当前为 `004-*`）。
