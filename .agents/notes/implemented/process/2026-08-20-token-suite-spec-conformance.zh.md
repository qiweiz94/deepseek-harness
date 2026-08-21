# Agent Note：token 优化套件规格——符合性处置

Status: implemented

[English](2026-08-20-token-suite-spec-conformance.md) | 中文

## 问题

一组外部起草的"master prompts"（"自主 Token 优化与代理韧性套件"第 1–7 阶段）反复作为构建请求出现。其状态行已过时（"PR #15/#16"），文件清单点名了从未上线的模块（`src/manager.ts`、`src/router.ts`），API 引用包含不存在的接缝（`subagent/turn-end`、`ctx.subagents.abort()`、`@deepseek-ai/dsh-subagents`、`verify-md-links`）。没有书面处置，未来每个会话都可能重建已上线的包或对着幻影 API 编码。

## 决定

规格分解如下，本笔记是其永久关账：

- **阶段 1 `plugin-ast-context`——已上线。** `get_file_outline` + `get_directory_outline`、tree-sitter 提取器、呈现卡片；逐文件覆盖率在 PR #22 恢复；`meta.outline` 之后的过时金样在 PR #26 重录。
- **阶段 2 `plugin-subagent-router`——已上线，设计已修正。** 标签→provider 路由（`providers` + `routes[{label, providers}]`）、对默认候选 fail-closed（PR #17）、空标签拒绝 + 去重（PR #19）、结算抽取（PR #20）。规格的角色→模型档位想法以按路由 `agentOptions` 落地（PR #27）；`AgentOptions` 中的 `reasoningEffort` 是剩余管道，归 subagent 车道。
- **阶段 3 `plugin-worktree-sandbox`——已上线。** `sandbox_exec` 基于 `src/worktree.ts`（非 `manager.ts`/`sandbox_run`）；带穿越防护的 id（PR #17）、lint 与夹具可见性修复（PR #18）、完整失败路径覆盖（PR #22）、无密钥隔离快照（PR #26）。
- **阶段 4 `plugin-lsp-references`——按规格拒绝。** `lsp` 能力接缝已提供 `goToDefinition`/`findReferences`/`goToImplementation`/`hover`；平行的工具插件会违反接缝规则重复能力。真正的增量——为现有接缝提供进程内 TypeScript LanguageService **provider**——已排队为 `lsp-typescript-inprocess`。
- **阶段 5–7（`diagnostic-sifter`、`pinned-scratchpad`、`budget-governor`）——此前未建；进行中**，在专属车道上按真实接缝重新设计：sifter 用纯函数夹具测试的启发式解析；scratchpad 经 `ctx.systemPrompt.section` 固定（构造上永不被压缩），配 `todo/write` 式整仓会话事件；governor 经 `session/event` + `ctx.tokenMeter` 检测由 `subagent/start` 识别的子代理，执行仅经真实取消接缝。

## 考虑过的替代方案

**逐字构建规格。** 重建三个已上线的包、重复 LSP 能力、对不存在的事件与服务编码。

**忽略规格。** 丢掉其两个真正新颖的增量（模型档位路由、三个韧性插件），并让过时提示继续误导下一个会话。

## 后果

粘贴的规格已关账：已上线阶段有审计轨迹（PR #17–#22、#26–#27），被拒阶段有接缝理由，新阶段按仓库真实设计推进。未来任何"构建套件"请求都对照本笔记解析，而非过时提示文本。
