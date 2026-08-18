# MASTER PROMPT — get_file_outline 插件：已交付、有界、嵌套摘要、全部合并（会话 2026-08-18）

[English](SESSION-HANDOFF-2026-08-18.md) | 中文

你正在 DeepSeek Harness monorepo 中继续已通过验证的工作。下文全部内容已由上一会话完成并通过绿灯验证，且已合并到 master；你的任务是 (1) 接受／验证现有状态，(2) 执行文末剩余的决策／提交项，且不回归任何已关闭项。不要重做已完成的工作。

## 环境

- DSH 检出目录（你工作的仓库）：/Users/nanoclaw/deepseek-harness（master 分支，HEAD d4fe628e21，工作树干净）。
- 注意：shell 默认 cwd 可能是 /Users/nanoclaw/code/trading-claw（无关仓库）——始终给命令传 workdir /Users/nanoclaw/deepseek-harness 或先 cd 过去。
- 本地 profile 只有 web 和 headless。新会话 = 在 127.0.0.1:3080 的 web GUI 里 New Session。
- 安全：用于录制 ast-context 快照的 API key（sk-Zivz...Druu）已暴露——请轮换／销毁，绝不复用进行录制。任何将来的真实重录（`test:snapshot:record`）都需要届时提供新 key。

## 门禁命令（全部在 DSH 检出目录内）

- `pnpm test` —— 完整单元套件（vitest）。预期约 806 个文件 / 13,470 个测试 / 0 失败（串行 `--maxWorkers=1` 是确定性运行；并行运行可能出现负载抖动，见下文）。
- `pnpm run typecheck`、`pnpm run lint`、`pnpm run duplication`（0 克隆）、`pnpm run build` —— 必须干净。
- `pnpm run test:snapshot` —— 无 key 重放快照套件。预期 13 个文件 / 116 通过 / 1 个模型 key 跳过。`test:snapshot:refresh`（无需 key）重录易变值；`test:snapshot:record`（DSH_SNAPSHOT=record）调用真实 API 且需要 key——仅在确需真实重录时使用。
- `pnpm run doc-sync` —— 28 个门禁，包括目录新鲜度（tool/config/cordis/persistence）、翻译配对（940 对）、Agent Note 格式、cordis-config、README 模型体验、文档图、md 链接。
- `pnpm run website:build` —— VitePress 构建 + 2,322 个内部片段链接。
- `pnpm run verify-third-party-notices` 与 `pnpm run verify-built-package-invariants`（220 个已编译 companion）。
- keel 的 `no-remote-exec` 会拦截 `pnpm exec` 和按需 `npx`；只用 `pnpm run <script>`。临时 tsx 探针：把文件放进包内（依赖 node_modules 解析）并运行 `node --import tsx/esm <file>`；提交前删除探针。
- macOS 没有 `timeout` 二进制（包装它会退出 127）。

## 上一会话交付的内容（全部已合并到 master）

1. **PR #1 `feat/ast-context-plugin`（合并 46c83d5939，4 个拆分提交）** —— 新模型面向工具插件 `@deepseek-ai/dsh-plugin-ast-context`，注册 `get_file_outline`：tree-sitter TypeScript 符号摘要（函数／类／接口／类型别名／枚举，1 起始行号区间，嵌套声明），让模型在读取大文件前先定位。包含提取器（文本的纯函数）、输出 schema（2 层，模型可见输入只有一个 `path`）、渲染器（每符号一行，成员缩进）、接线（base bundle + headless 示例 cordis.yml + package.json 依赖）、无 key 快照（fixtures 位于 examples/headless-agent/tests/snapshots/ast-context/：input.json、session.jsonl 约 29KB/42 条、stream-json.expected.jsonl；live-overlay 与 replay 孪生 cordis.yml）、Agent Note 2026-07-02 范围行（EN/ZH/i18n）、THIRD_PARTY_NOTICES.md 重新生成（tree-sitter 行）。目录扩展：生成器启动每个插件并采集 `ctx.tools.schemas()`；完整性守卫 glob `packages/*/tool-*` 与 `packages/plugins/*`。
2. **PR #4 `feat/ast-context-bounds`（合并 7019e3c942，3 个拆分提交）** —— 边界加固 + 易抖动加固 + 备注策略。通过 `@deepseek-ai/schemastery`（非 zod）定义 `Config`：`maxBytes` 默认 2,000,000，`maxSymbols` 默认 2,000，均为 `step(1).min(1)`（schemastery 没有 `.int()`），加载时校验并立即失败（loader-composition spec 覆盖 `maxSymbols: 0`）。读取前先 `stat`，超过 `maxBytes` 1 字节即拒绝并给出指引性错误（含限制值与实测大小）；提取器超过 `maxSymbols` 即抛错（"直接读取文件或缩小路径范围"）——错误结果，绝不部分摘要（tool-fs-search 先例）。测试：恰好限制值通过／超 1 字节拒绝、多字节按字节计数、BOM、CRLF。易抖动：`DEFAULT_PROCESS_TIMEOUT_MS` 30s→60s（packages/test-support/loader-smoke/src/index.ts:25——"did not exit within 30s" 失败来自子进程自身超时，而非 vitest 的 120s 时限）以及 `DEFAULT_SNAPSHOT_MAX_CONCURRENCY` 5→3（vitest.snapshot.config.ts；`DSH_SNAPSHOT_MAX_CONCURRENCY` 旋钮不变）。策略：`packages/plugins/*` 预留给模型面向工具插件；其中的非工具插件仍须登记 manifest 条目，并渲染空的 `parameters` 章节。
3. **PR #5 `feat/ast-context-deeper-outline`（合并 d4fe628e21，1 个提交）** —— 每个符号一层体深度的嵌套声明：`collectMembers` 改为 `collectChildren`，经 `class_body`/`interface_body`/`statement_block` 递归；方法体内声明的类出现在该方法之下并携带自己的成员。命名空间（`internal_module` 永不被报告，故其内容自然排除）、类字段、属性签名、词法声明以及控制流块内的声明均不报告（已文档化）。`maxSymbols` 现在统计每一层深度的完整树（原先只有 2 层）。输出 schema 描述已刷新；无 schema 结构变化（成员级 `children` 数组本就无约束，更深输出可通过运行时校验）；工具描述变化重新生成目录（EN+ZH 重新配对）；无需重录快照（fixture `sample.ts` 没有嵌套声明，重放仍一致）。

## 关键发现与决策（审计与自我改进价值）

- **堆叠 PR 教训**：删除已合并的 base 分支会**自动关闭**依赖它的 PR（且 `gh pr edit --base` 拒绝已关闭 PR）。修复：用同一 head 分支针对 `--base master` 重建 PR——diff 恰好只显示依赖提交。PR #2 → #4、#3 → #5 均以此方式重建。
- **模型体验门禁**（`verify-package-readme-model-experience`）：一个表面恰好三个有序 H4 字段（`What the model sees` / `Token effect` / `KV Cache effect`）；**没有**独立的 `### Config` H3——配置增量写进 `#### What the model sees` 正文（tool-bash 是参考布局）。
- **生成文档的变更源**：新增包 Config 接口 → `gen-config-catalog`（EN + 手工镜像 zh + `--write` 配对）；包依赖变化 → `gen-doc-graphs`（apps/cli/composition.md + examples/headless-agent/composition.md）；工具描述变化 → `gen-tool-catalog`（EN + zh + 配对）。三者都是 doc-sync 门禁。
- **快照重放会真实执行工具**：重放的会话启动真实子进程路径并**运行** `get_file_outline` 作用于 fixture `sample.ts`；只有模型响应被重放。增量式提取器行为无需重录；fixture 内容变化才需要。
- **覆盖率现实**：串行 `vitest run --coverage --maxWorkers=1` 通过全部 806 个文件 / 13,470 个测试；打印出的 11 个全局阈值错误属于 CI 分区的 exempt-heavy 包（compaction-basic、goal-round-driver、tool-fs、agent-instructions），是既有问题。多次出现的并行负载抖动：`subprocess-local/process-exit.spec.ts`（ready 文件 ENOENT）与 `scripts/gen-client-catalog.spec.ts` 对 oxlint-contract 套件（扫描中途 `oxlint-contract-<uuid>.ts` 临时文件被删）。超时失败未单独复跑前绝不可信。
- **翻译配对**：编辑任何范围内文档都要同步 EN+ZH，然后 `pnpm run verify-translation-pairing --write <pair>`（共 940 对）。配对检查比较标题深度与每文件 blob 哈希；静默失败的脚本替换会在这里暴露——脚本化编辑后务必核对标题表。
- **schemastery API**：`z.number().step(1).min(1)`（无 `.int()`/`.positive()`）；`@deepseek-ai/schemastery` 是 vendored 工作区依赖（`workspace:^`，已列于 THIRD_PARTY_NOTICES）。
- **仓库惯例决策（C）**：双语文档保留。EN 优先撰写已是规则（docs/i18n 契约）；约 940 个 zh 文件 + 配对门禁是产品文档化标准，归档文档为冻结历史。已否决：英文单语化（不可逆、与面向中文的产品现实相悖、无消费者证据）。

## 已验证状态（会话结束时）

- 完整串行套件：806 个文件 / 13,470 个测试通过（--maxWorkers=1 的 test:coverage）；插件包测试 29/29（边界前 24，深层摘要后 29）。
- typecheck、lint、duplication（0 克隆）、build、doc-sync 28/28、快照 13 个文件 / 116 个测试（连续两次）、website:build + 2,322 片段、verify-third-party-notices 最新、verify-built-package-invariants 220——全部绿灯。
- master = d4fe628e21（#5 的合并），工作树干净，无未合并 PR。

## 留给你的剩余工作（按优先级）

1. **轮换／销毁录制 key**（sk-Zivz...Druu）——曾嵌入真实会话数据；绝不复用于 `test:snapshot:record`。
2. **为 get_file_outline 增加 `.tsx` 支持**：插件 Known Limitations 写着仅 TypeScript；tree-sitter-typescript 依赖已内置 tsx 语法（tree-sitter-tsx.wasm）。提取器增加语法参数；工具按扩展名选择 `.ts` → typescript / `.tsx` → tsx；测试（tsx 解析、嵌套成员、字段忽略）、README EN+ZH 限制更新。无 schema 变化、无目录变化、无需重录快照（增量式；fixture 是 `.ts`）。
3. **单元套件抖动阈值提升**（CI 属有，仅在 CI 变红时做）：llm-pi-ai adapter（1s watchdog 竞争，实测 1039ms）、install-lefthook、oxlint-contract、code-block grammars 各 1 行测试超时提升——目前单独运行全部通过。
4. **Python SDK 示例**：python/ 下一个可运行示例，经现有 SDK + bundled runtime 通过 newline-delimited JSON-RPC stdio 驱动 `get_file_outline`，外加 EN+ZH 文档。
5. **第二个工具插件**（模式证明）：`get_directory_outline` 式插件（有界、结构化、目录 + 快照路线）。快照录制步骤需要**新 key**——停下来向用户索取，或先交付插件 + 脚手架、录制推迟并文档化。

## 你需要知道的（避免被误导）

- 快照 fixture 存储的是稳定化原始值；易变清洗（时间 → 0、uuid → {{sessionId}}、spill 路径 → {{spillLocator:NAME}}）在比较时由 normalizer 完成。不要当 bug 清理看似原始的 fixture 值。
- 会话 fixture 中的工具 schema（request/header，OpenAI function-calling 格式）只携带**输入**参数——输出 schema 变化永不触碰 fixture。
- 插件 `apply(ctx, config = {})` 的 config 是第二个参数；配置校验发生在 Loader（schema），不在 apply。
- keel：违反 deny 规则首次仅警告，重复才拦截。不要自行批准被拦截的操作；给出确切的批准命令即可。
- packages/*/*/src 的每文件 100% 覆盖率是门禁；不可达守卫携带 `/* v8 ignore next -- reason */`。

## 成功标准

上述门禁全部通过，每个行为变化都带测试，双语对已重录（940 一致），工作树干净且工作以路径限定方式提交在已推送分支／PR 上，不复用任何已暴露的 key 材料。