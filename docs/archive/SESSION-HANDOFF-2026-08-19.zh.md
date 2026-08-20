# MASTER PROMPT — subagent-router/worktree-sandbox 审计：lint 转绿、fail-closed 路由、空标签拒绝，全部合并（会话 2026-08-19）

[English](SESSION-HANDOFF-2026-08-19.md) | 中文

你正在 DeepSeek Harness monorepo 中继续已通过验证的工作。下文全部内容已由上一会话完成并通过绿灯验证，且已合并到 master；你的任务是 (1) 接受／验证现有状态，(2) 执行文末剩余的决策项，且不回归任何已关闭项。不要重做已完成的工作。

## 环境

- DSH 检出目录（你工作的仓库）：/Users/nanoclaw/deepseek-harness（master 分支，HEAD b7ef220ea3，工作树干净）。
- 注意：shell 默认 cwd 可能是 /Users/nanoclaw/code/trading-claw（无关仓库）——始终给命令传 workdir /Users/nanoclaw/deepseek-harness 或先 cd 过去。
- 本地 profile 只有 web 和 headless。新会话 = 在 127.0.0.1:3080 的 web GUI 里 New Session。
- 安全：用于录制 ast-context 快照的 API key（sk-Zivz...Druu）已暴露——请轮换／销毁，绝不复用进行录制。任何将来的真实重录（`test:snapshot:record`）都需要届时提供新 key。
- GitHub：此仓库的 GraphQL API 被禁用——用 `gh` REST CLI（pr create/merge/edit/view 和标签都可用）。`gh pr merge --merge` 是真正的双亲合并；`delete_branch` 不会触发，所以远程 ref 要用 `git push origin --delete` 显式删除（受 keel 拦截，见下文）。

## 门禁命令（全部在 DSH 检出目录内）

- `pnpm run test` —— 完整单元套件（vitest）。位置参数过滤器会被忽略：始终跑完整套件，其输出就是你的证据。预期 823 个文件（815 通过 / 8 跳过）/ 13,524 个测试通过 / 109 跳过 / 0 失败。
- `pnpm run typecheck`、`pnpm run lint`、`pnpm run duplication`（0 克隆）、`pnpm run build` —— 必须干净。lint 全仓已转绿；PR #18 修复 plugin-worktree-sandbox 中 5 个既有 oxlint 错误之前它是红的。
- `pnpm run test:snapshot` —— 无 key 重放快照套件。预期 13 个文件 / 116 通过 / 1 个模型 key 跳过。`test:snapshot:refresh`（无需 key）重录易变值；`test:snapshot:record`（DSH_SNAPSHOT=record）调用真实 API 且需要 key——仅在确需真实重录时使用。
- `pnpm run doc-sync` —— 28 个门禁，包括目录新鲜度（tool/config/cordis/persistence）、翻译配对、Agent Note 格式、cordis-config、README 模型体验、文档图、md 链接。编辑过的配对用 `pnpm run verify-translation-pairing --write <完整路径前缀>` 重录（锚点是去掉 .md 扩展名后的完整路径；裸名称会被拒绝）。
- `pnpm run website:build` —— VitePress 构建 + 2,322 个内部片段链接。
- `pnpm run verify-third-party-notices` 与 `pnpm run verify-built-package-invariants`（220 个已编译 companion）。
- keel 的 `no-remote-exec` 会拦截 `pnpm exec` 和按需 `npx`；只用 `pnpm run <script>`。临时 tsx 探针：把文件放进包内（依赖 node_modules 解析）并运行 `node --import tsx/esm <file>`；提交前删除探针。
- keel 的 `publish-gate` 会拦截 `git push origin --delete <branch>`；批准是一次性的且会过期——每轮删除都需要用户重新运行 `keel allow publish-gate --once`。绝不自我批准；改为给出确切的批准命令。
- macOS 没有 `timeout` 二进制（包装它会退出 127）。

## 上一会话交付的内容（全部已合并到 master）

1. **PR #17 `fix/plugin-router-audit`（合并 e2d333a96d，1 个提交）** —— subagent-router 与 worktree-sandbox 审计修复。S1：`plugin-worktree-sandbox` 在 `execute` 中任何副作用发生前，用 `/^[a-zA-Z0-9_-]{1,64}$/` 校验沙箱 `id`（含路径穿越与 65 字符的拒绝测试）。S2：`.dsh/` 加入 .gitignore。S3：`matchRouteCandidates` 现在按配置顺序展开每条命中路由的 providers；路由即策略，因此任何命中路由的委托都不会回退到默认候选（fail-closed，依据 Envoy 池内故障转移语义与 Anthropic《Building Effective Agents》2024-12-19），无法路由或无法满足的委托会大声失败并列出尝试过的候选。曾提议 `fallbackToDefaults` 配置标志并已否决（YAGNI，无消费者证据）。测试覆盖级联、命中断言不下放默认值、候选排序。
2. **PR #18 `fix/plugin-sandbox-lint`（合并 08766156cd，1 个提交）** —— 修复让 lint 门禁保持红色的 5 个既有 oxlint 错误：worktree.ts:56 `String(outcome.signal)` → `outcome.signal`；worktree.ts:90-91 reader 类型化为 `AsyncIterable<Buffer>`（先例 fs-local/src/fsio.ts:414）；index.ts:191 箭头块 `() => { controller.abort() }`；index.ts:241/247 对 unknown 类型主错误用 `JSON.stringify` 做错误归一化。另加 `.gitignore` 否定 `!examples/acp-agent/tests/snapshots/skill-load/workspace/.dsh/`，使宽泛 `.dsh/` 规则下已跟踪 fixture 子树内的文件仍对 git 可见（已用 `git check-ignore` 验证）。此后全仓 `pnpm run lint` 退出码 0。
3. **PR #19 `fix/plugin-router-config`（合并 b7ef220ea3，1 个提交）** —— 空路由标签曾被接受为合法配置：schemastery 的 `required()` 只要求键存在，而 `label: ''` 会经 `includes('')` 命中每一次委托，静默把它的 providers 插到更具体路由之前。修复：`label: z.string().min(1).required()`（与既有的 `providers: .min(1)` 一致）并加加载失败测试断言 `/string length >= 1/`；`matchRouteCandidates` 现在去重 providers（首次出现保持位置），让大声失败消息保持规范；路由 README EN+ZH 与 2026-08-19 subagent-router Agent Note 已更新（空标签拒绝现列入误配置即加载失败），两个配对均已重录。配置目录再生成确认无变化（单行 schema 改动，无 JSDoc／行号位移）。

## 关键发现与决策（审计与自我改进价值）

- **schemastery 语义**（vendor/schemastery/src/index.ts:609-617）：`required()` 只要求键存在；`.min(n)` 才是字符串长度门禁（`checkWithinRange(data.length, ...)`）；错误文本为 `expected string length >= 1 but got 0`。空标签被接受是深度审计的发现 B，也是三个已修复脚枪中最严重的一个。
- **Fail-closed 路由是产品决策**：路由是显式策略；一旦任何路由命中，默认候选就不可达；失败时大声并附候选列表。无逃生舱标志。
- **审计处置**：A（宽泛 `.dsh/` 忽略隐藏已跟踪 fixture 子树）在 PR #18 修复；B（空标签）在 PR #19 修复；C（重复 providers）在 PR #19 修复；D（`args.id` 对非字符串／空输入自动生成）按决策保留——z schema 在上游已强制 `type: 'string'`，且无消费者证据要求更严格行为；E（subagent-router/worktree-sandbox 的无 key 快照覆盖）推迟到 harness 支持这些插件 bundle 的无 key 重放。
- **流程教训**：绝不在已知本地门禁为红时合并——那 5 个 lint 错误早于本会话的 PR，本会拦下 CI；每个 PR 前都要验证完整门禁集（lint + 测试 + typecheck + doc-sync）。
- **CI 接线未确认**：本仓库提交没有出现 `ci.yml` 运行（只有 Copilot "dynamic" 运行）。调查曾向用户提议、尚未被要求——动手前先与用户确认范围。
- **翻译配对**：`--write` 锚点是完整路径前缀（裸名称会被拒绝）；任何脚本化编辑后都要核对标题表——静默无效替换会表现为配对失败。
- **keel 批准会过期**：一次性 `keel allow publish-gate --once` 不会持续有效；每轮删除都要重新申请。
- **目录变更范围**：行号不变的单行 z-schema 编辑无需再生成配置目录；JSDoc／接口变更才需要。

## 已验证状态（会话结束时）

- 完整串行套件：13,524 通过 / 109 跳过，815 个文件通过 / 8 跳过（共 823），0 失败（含 PR #19 新增的 2 个测试：resolver 去重与空标签加载失败）。
- lint 退出 0、typecheck 退出 0、doc-sync 28/28（路由器 README 配对与路由器 Agent Note 配对均已重录；gen-config-catalog 无变化）、两个 PR 提交的 pre-commit 钩子（翻译配对 / lint / 空白 / vendor 守卫）全绿。
- master = b7ef220ea3（#19 的合并），工作树干净，无未决 PR，无远端 `fix/plugin-*` 分支（三个 PR 分支均经用户批准的 keel 批准删除）。

## 本会话剩余工作（按优先级）

1. **CI 接线（先与用户确认范围）**：本仓库提交没有 ci.yml 运行——调查 CI 是否存在且为绿；若缺失，提议在 PR 上运行 lint + test:coverage + doc-sync 的最小 CI。
2. **审计项 E（仅当 harness 现已支持）**：通过可运行示例为 subagent-router 与 worktree-sandbox 增加无 key 快照覆盖。
3. **审计项 D（除非出现证据否则保留）**：`args.id` 自动生成——无消费者证据要求更严格行为。
4. **轮换／销毁录制 key**（sk-Zivz...Druu）——它曾嵌入真实会话数据；绝不复用于 `test:snapshot:record`。

## 你需要知道的（以免被误导）

- 快照 fixture 存的是已稳定的原始值；易变值清理发生在比较时的 normalizer 中。不要清理看似原始的 fixture 值。
- 会话 fixture 中的工具 schema（request/header，OpenAI function-calling 格式）只携带输入参数——输出 schema 变化永远不触及 fixture。
- 插件 `apply(ctx, config = {})` 的 config 是第二个参数；配置校验发生在 Loader（schema），不在 apply。
- keel：deny 规则首次违反只警告，重复则拦截。绝不自我批准被拦截的动作；改为给出确切的批准命令。
- packages/*/*/src 的逐文件 100% 覆盖率是门禁；不可达守卫带 `/* v8 ignore next -- reason */`。
- 测试套件的位置参数过滤器按设计被忽略——`pnpm run test -- <path>` 仍会跑整个套件；那份输出就是你的证据。

## 成功标准

以上所有门禁通过，每个行为变更都随附测试，双语配对已重录，工作树干净且工作按路径限定提交到已推送的分支／PR，合并后不留远端分支，且不复用任何已暴露的 key 材料。