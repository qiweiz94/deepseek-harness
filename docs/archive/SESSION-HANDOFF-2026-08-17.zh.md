# MASTER PROMPT — DeepSeek Harness 三阶段工作：审计完成 + 收尾（2026-08-17 会话）

[English](SESSION-HANDOFF-2026-08-17.md) | 中文

你正在继续 DeepSeek Harness monorepo 中已经过验证的工作。以下一切均已在先前会话中完成并通过绿灯验证；你的职责是：(1) 接受/验证现有状态，(2) 执行结尾处的剩余决策/提交项，且不得回退任何已关闭项。不要重复已完成的工作。

## 环境

- DSH 检出（你工作的仓库）：/Users/nanoclaw/deepseek-harness（分支 master，HEAD 47f943859b）
- 注意：你的 shell 默认 cwd 可能是 /Users/nanoclaw/code/trading-claw（一个无关仓库）——始终传入 workdir /Users/nanoclaw/deepseek-harness 或 cd 到那里。
- 运行时设置位于 ~/.dsh/settings.yaml：deepseek-v4-flash 与 deepseek-v4-pro 的 maxTokens 现为 8192（原来是 384000 —— 提供方 400/context-length 修复，已实测验证）。compaction-basic 的 triggerTokens=120000、targetResidualTokens=42000。
- 本地 profile 在 ~/.dsh/profiles，只有 web 和 headless。此构建中没有 `dsh goal` CLI 命令或 goal profile；随附的 agent preset 是 code|cordis|minimal|standard。新建会话 = 在 127.0.0.1:3080 的 Web GUI 中 New Session。

## Gate 命令（均在 DSH 检出内）

- `pnpm test` — 完整单元套件（vitest）。预期约 803 个文件 / 13,437 个测试 / 0 失败。
- `pnpm run typecheck` — host 构建 + contracts-ready tsc。必须干净。
- `pnpm run test:snapshot` — 无 key 回放快照套件。预期 12/12 文件（115 通过，1 个模型 keyed 跳过）。
- 重新录制 fixture：`pnpm run test:snapshot:refresh`（DSH_SNAPSHOT=refresh，回放 + 回写，无需 API key）。普通的 `pnpm run test:snapshot -u` 不会写 fixture（回放模式从不写入）。`test:snapshot:record`（DSH_SNAPSHOT=record）会调用真实 API 且需要 key —— 仅当确实需要 live 重录时才用。
- 轻量 gate：`pnpm run verify-translation-pairing`（937 对必须一致）、verify-config-catalog、verify-tool-catalog、verify-persistence-catalog、verify-cordis-catalog、verify-cordis-config、verify-config-source-ownership、constraints、knip、duplication、verify-agent-note-format|classification|archived、verify-dsh-package-licenses、verify-package-invariants、test:issue-management。
- macOS 没有 `timeout` 二进制（若用它包裹会 exit 127）。改用后台任务。
- 文件编辑工具要求先读文件。若内联代码生成在你的解析器上触发字面省略号字符，请将其输出为 \u2026。

## 3 个阶段（已实现，fixture 已录制，所有测试/gate 绿灯）

1. Phase 1 — agent-instructions 的 contentDigest：基线指令事件携带 contentDigest = 每个包含的基线文件的原始字节以 NUL 连接后的 SHA-1（聚合身份；区别于每次变更的按文件 digest）。文件：packages/context/agent-instructions/src/{digest,index,state,files}.ts。
2. Phase 2 — compaction/range-pruned：新增 `compaction/range-pruned` 事件（注册于 packages/core/session/src/known-event-types.ts:31 —— 必需，否则 session-persistence 拒绝日志），在 compaction-basic/src/region.ts 中发出；顺序为 start < summary < user/message < range-pruned < end。新配置键 triggerTokens（默认 120000）/ targetResidualTokens（默认 42000），已校验并记录 EN/zh 文档。
3. Phase 3 — spill 指令模板 + 代码点安全截断：spill-policy 输出 [Output Exceeded N chars - Full content written to <locator>] + head/preview + truncation-marker + tail，预算在 maxInlineBytes 内（预留最坏情况数字位开销；字节边界后备；上限不变量已验证）。代码点安全库（packages/util/output-retention 中的 codePointLength/truncateCodePoints）已接入各字符截断点（read-render、str-replace、bash-persistent、tool-web fetch、web-fetch-http、llm-deepseek 历史推理、boundContextSummary）。Code 模式的 run_code 描述追加 [Code Mode File Handling Rules] 块。goal-round-driver 合并同版本轮次（丢弃 Objective 行）；directive 指引保持不变。plan-mode 段落移至 prompt 尾部（顺序 1000）。cordis.patch.yml spill 上限 15000。

## 先前会话修复了什么（评审通过）—— 均已测试，勿重做

- BUG：subagent continuation digest 之前用 UTF-16 切片 —— 已修复为 truncateCodePoints（packages/subagent/subagent/src/continuation.ts）+ 依赖接线（package.json/tsconfig）+ astral 回归测试。
- BUG 风险：goal-round-driver objective 截断的 UTF-16 切片 —— 新增 limitObjectiveToUnits（packages/goal/goal-round-driver/src/prompt.ts）+ 依赖接线 + astral 测试。
- 补齐 3 个缺失的代理项边界测试：fs/tool-str-replace-editor/tests/tools.spec.ts、shell/tool-bash-persistent/tests/tools.spec.ts（新增 astral-large stub 模式）、web/tool-web/tests/spill.spec.ts。
- 转换 2 个漏掉的切片点：packages/workflow/workflow-worker-thread/src/runtime.ts（使用共享 output-retention；依赖已接线）以及 packages/extensions/cordis-client-runner/src/client/evaluator.ts（使用本地 boundCodePoints 辅助函数 —— 它位于浏览器 CLIENT 构建图中；output-retention 没有 tsconfig.client.json，所以禁止在那里添加 host 侧引用）。
- 快照规范化器修复（packages/test-support/acp-snapshot/src/normalize.ts）：spill 路径擦除的 lookahead 接受 `]`（字符类 [\s)\]\]]）；EVENT_READ_TARGET_REGION_RE 去锚定（[\s\S]*?Session），使 spill 预览内的 event-read 时间戳擦除为 {{eventTime}}。这使 bash-spill / session-query-spill fixture 变为确定性。
- Gate 修复：docs/config-catalog.md 重新生成（原先过时）+ .zh 镜像（compaction 块 + 4 个来源引用）；解决 8 个 translation-pairing 违规（agent-note 语言切换器、subagent/plan-mode/tool-catalog 的 zh 镜像，随后为这 8 对执行 --write 记录）。verify-translation-pairing 现为 937 对一致。
- 修正既有错误断言：packages/util/output-retention/tests/output-retention.spec.ts（4 个计数）以及 llm-deepseek/tests/serialize.spec.ts 中一个潜伏 TS 错误（union 收窄）。注意：llm-deepseek 序列化还新增了 trailing-plain-answer 固定测试 + 澄清注释（行为不变、符合文档）。
- 其他测试/文档增补：code-mode.spec.ts 握手固定（[Code Mode File Handling Rules] 存在性）；agent-instructions.spec.ts digest 推导测试（NUL 连接的聚合 + 按文件 digest + every-baseline-has-contentDigest 保护）+ 源码 docstring 澄清。
- 外观：compaction-recovery/session.jsonl 时间戳规范化为运行 epoch（比较时时间本就归零）。
- pnpm-lock.yaml 重新生成（新 workspace 边：subagent、goal-round-driver、workflow-worker-thread）。

## 已验证状态（截至会话关闭时）

- 完整套件：803 个文件 / 13,437 个测试通过；在负载运行中看到的唯一失败是 packages/boot/app-boot/tests/hmr-config.spec.ts（以及 process-exit.spec.ts 和 install-lefthook.spec.ts 各一次）——这是并发重负载下（typecheck 与完整套件并行运行）由负载引起的 flake；各自单独运行约 1 秒即通过。切勿在单独重跑前信超时失败，也不要并行运行 typecheck 和完整套件。
- typecheck 干净；快照 12/12 确定（refresh + 两次连续回放已验证）；所有轻量 gate 通过。
- 工作树未提交：master 上约 115 个文件变更 / 约 1,871 行新增 / 324 行删除。各阶段或评审修复均未提交。

## 你会话的剩余工作（按优先级排序）

1. 提交工作（按仓库规则）：创建会话分支（git worktree add ../dsh-<topic> -b session/2026-08-17-<topic> 或从 master 开分支），检查 git status / git diff，并按路径作用域提交（共享树中切勿使用 git add -A / 裸 commit）。按逻辑分组（phase 1-3 对评审修复）。推送会话分支。
2. 决定残余判断项（记录或交付）：
   - Spill 措辞 NIT：[N chars truncated] 按 UTF-16 单元计数而预算是字节/字符；决定是重新标注还是改为按代码点计数（packages/spill/spill-policy/src/index.ts:211）+ 测试 + README en/zh + 若文本变化则经 test:snapshot:refresh 重录 fixture。
   - plan-mode 顺序：1000 这个魔法尾部数字（今天安全；未来某个 >1000 的段落会抢到尾部）——考虑改为常量或注释。
   - goal-round-driver restore-now-appends 顺序：驱动 spec 中未做位置断言（仅经 inbox.spec/agent.spec.ts:144-160 推断）——若想完全固定，增加尾部位置断言。
   - 3 个示例 cordis.yml 仍用旧 thresholdRatio: 0.8（examples/acp-agent、examples/jsonrpc-agent、examples/headless-agent）而 README 已迁移到 triggerTokens —— 迁移或有意记录该回退。
   - compaction 自动路径测试未显式断言 range-pruned 位于 compaction/end 之前（由共享 commitCompactionBody 路径保证）——若想双保险，补上该断言。

## 你需要了解的知识（以免被误导）

- 快照 fixture 存储的是 STABILIZED（非完全 token 化）的原始值；易变擦除发生在 normalizeSessionLog 的比较阶段（记录时间 -> 0，uuid -> {{sessionId}}，spill 路径 -> {{spillLocator:NAME}}，event-read 时间 -> {{eventTime}}）。不要把看起来原始的 fixture 值当作 bug 去清理；回放是确定性的。
- 像 dsh-acp-snap-<hex> 这类 spill 根按场景确定；其下的 session 目录在比较阶段被擦除。
- goal-round 合并：renderGoalRoundPrompt(goal, round, includeObjective=false) 仅在 objectiveAlreadyAdmitted() 为真时才丢弃 Objective；不变量重建出同一纯粹决策。第 1 轮总是包含它。
- 翻译/配对：编辑任何范围内的 README/文档时同时更新 EN 和 zh，然后运行 `pnpm exec tsx scripts/verify-translation-pairing.ts --write <pair>` 重录 i18n.yaml。切勿 --write 语言实际不匹配的一对。
- 在模型可见文本的任何字符上限处，使用 @deepseek-ai/dsh-output-retention 中的 codePointLength/truncateCodePoints（浏览器安全），切勿对解码文本使用 String.slice。
- output-retention 的依赖接线模式：package.json（dependencies + devDependencies，或纯 peer 包用 peer + devDependencies）、tsconfig references 条目（仅当消费者是 client 项目且 output-retention 拥有 tsconfig.client.json 时才用）、然后 `pnpm install --lockfile-only`。

## 事后评审暴露的未决缺口（交给下一会话的任务清单）

对提交 5aa1dc7699 + 13e3443ac2 的深度评审给出干净的 GO（无 BUG 发现；所有受影响套件通过），但指出两个设计级缺口需在新字节包络投入信任前解决，外加四个外观性 NIT：

- GAP-1（compaction region.ts:147-159）：新的 15 步 / 3 轮逐字尾截断上限可能在达到 retainTokens token 下限之前就停止收缩，导致 token 廉价会话明显低于配置的 targetResidualTokens 包络。当前是未测试路径——补充测试和/或下限保护。
- GAP-2（goal-round-driver prompt.ts:20-31, 78-83）：limitObjectiveToUnits 是 O(n²)（33K objective 上出现数秒尖峰），且长 objective 每版本最多只被接纳一次，截断到约 470 units，完整文本可能永远到不了模型。考虑改为线性扫描并显式接纳完整文本。
- NIT：agent-instructions digest-vs-framing 措辞；fetch.ts partial-footer 措辞；continuation digest 后缀溢出边界；spill-policy “chars” vs “units” 标签。
## 成功标准

以上所有 gate 通过，你交付的所有内容都具备代码点安全截断，并且行为变化处都有回归测试，fixture 与代码一致（任何模板/文本变更后用 test:snapshot 验证；必要时用 test:snapshot:refresh 重录），工作已按路径作用域提交到已推送的会话分支。
