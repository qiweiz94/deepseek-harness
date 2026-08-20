# Agent Note: 补齐钩子桥接的四项对等 TODO

Status: implemented

[English](2026-08-20-hook-bridge-parity.md) | 中文

## 问题

自 [hook-bridges Agent Note](2026-06-30-hook-bridges.md) 上线以来，`dsh-hooks-claude-code` 与 `dsh-hooks-codex` 两者都携带四个匹配的 `TODO` 标记：`hook-continue-false`（合并后的 `continue:false` 只被记录，从未真正中止运行）、`session-start-gating`（SessionStart 钩子的上下文与第一个模型请求赛跑，而非被承诺送达）、`stop-loop-guard`（一个无条件阻塞的 Stop 钩子会永远强制继续每一步，没有上限，payload 的 `stop_hook_active` 字段也始终报告 `false`），以及 `per-session-hook-config`（只会读取一个进程级 `configPath`，没有按会话的项目本地发现）。这四项都需要在两个桥接中得到相同的处理——相同的协议层原语，作用于相同的扩展点，只在各方言自身的日志前缀上措辞不同。

两个 coverage-cases 测试（`hooks-claude-code/tests/coverage-cases.ts:418`、`hooks-codex/tests/coverage-cases.ts:397`）按名称断言了*旧的*错误行为——`continue:false` 被记录为 `"stop"`，但工具仍会继续运行——将其作为 `hook-continue-false` 尚未实现的既定契约。

## 决策

`dsh-hook-protocol` 中新增五个原语，各自配有直接的按模块单元测试（`tests/halt.spec.ts`、`tests/stop-guard.spec.ts`、`tests/start-gate.spec.ts`、`tests/session-config.spec.ts`、`tests/config-limits.spec.ts`），由两个桥接对称导入：

- **`applyHaltRequest(merged, point, agent)`**（`src/halt.ts`）将合并后的 `continue:false` 映射为 `agent.cancel({ kind: 'hook', reason })`——`reason` 是首个中止钩子的 `stopReason`，缺失时回退为按 hook 点命名的字符串。两个桥接都会在 `merged.stop` 为真时，于 `UserPromptSubmit`、`PreToolUse`、`PostToolUse` 和 `Stop` 处调用它；`SessionStart`／`SubagentStart`／`SubagentStop` 仍没有已打开的轮次可以中止，因此该处的 `continue:false` 依旧既不会被记录，也不会被执行（行为未变，现在两份 README 都明确写出，而非留作隐含事实）。
- **`createStopLoopGuard(max)`**（`src/stop-guard.ts`）按 `(agent, turn)` 统计连续的强制 continuation。`agent.steer()` 送入的是 `'next-step'` inbox target，而不是 `'next-turn'`——已通过实证验证（一个两次阻塞的 Stop 测试，其两条 `hook/invoked` 记录都落在轮次 1 上）——因此将上限按 `turn` 计数是正确的：steering 不会在计数器不知情的情况下打开新轮次。`stopHookActive(agent, turn)` 现在真实支撑 payload 的 `stop_hook_active` 字段；`tryForceContinue` 在达到 `max`（默认 `DEFAULT_MAX_CONSECUTIVE_STOP_BLOCKS = 8`，即 Claude Code 自身的守护阈值，Codex 的桥接因自身未记录上限而借用它）后拒绝，桥接会让轮次结束而非再次 steering。
- **`createStartGate()` / `bindStartContext(gate, agent, inject)` / `foldStartContext(inject, startContext, decision)`**（`src/start-gate.ts`）取代旧有的「脱离运行的钩子解析完成时才 `agent.inject()`」模式。桥接的第一个 `agent/pre-step` 监听器会调用 `bindStartContext`，认领该 agent 待处理的 SessionStart 运行（在 `agentLoop.create()` 内部同步注册，早于 `followup()` 能够运行的时刻）并等待它，随后返回一个折叠器：进入型 `PreStepDecision` 会把上下文追加到其消息中，非进入型则直接注入（暂存以待下次唤醒）。这将一场赛跑变为受 hook 自身超时限制的有界等待——立即发送的第一个提示词现在能可靠地在其*第一个*请求中携带 SessionStart 上下文，已通过将 CC 桥接「SessionStart timing is best-effort (no-wait)」测试改写为断言 `adapter.requests[0]` 包含该钩子上下文来证明（这是任务简报点名的两处行为变更之外的第三处，特此说明，以免审阅者在对照简报时误认为遗漏说明）。`StartGate.register` 的拒绝路径（`run` 本身 reject，区别于 `deliver`／`agent.inject` 抛出异常）由 `register` 内部通过调用方提供的 `onError` 隔离，而非桥接自身的 `.catch`——详见「曾考虑的替代方案」。
- **`loadProcessHookConfig(opts)` / `createSessionHookConfigCache(opts)` / `combineHookGroups(processGroups, sessionGroups)`**（`src/session-config.ts`）实现了两个桥接新增的 `Config.sessionConfigFile?: string` 字段。未配置 `sessionConfigFile` 时，`loadProcessHookConfig` 保留既有的「读取／解析失败⇒警告且不注册任何内容」行为；已配置时则降级为「警告，并继续仅依靠会话级发现运行」。`createSessionHookConfigCache` 返回一个按 agent 的查找函数，在每个会话首次使用钩子时读取并解析一个相对于工作区的文件一次（ENOENT 静默处理；其他任何错误都会带上路径与 agent id 发出警告），并缓存结果——包括「没有文件」／「没有 cwd」的结果——按一个结构化的 `SessionWorkspace`（`{ id, session: { header: { cwd? } } }`）弱引用缓存，因此本库无需依赖 `@deepseek-ai/dsh-agent`。`combineHookGroups` 在每次 `runPoint` 调用时，将一个点的进程级与会话级 matcher 分组拼接起来，会话分组晚于进程分组运行。
- **`resolveSharedHookLimits(bridge, config)` / `assertPositiveInteger(bridge, name, value)`**（`src/config-limits.ts`）在任何配置文件解析之前，为新增的 `maxConsecutiveStopBlocks` 字段与既有的 `stderrSummaryMaxChars` 一并提供默认值并校验，使坏值不会被加载失败的提前返回掩盖。

`HookOutput.updatedInput` 仍未被执行：`packages/core/tools/src/index.ts` 中的 `PreToolDecision` 是一个封闭的 `allow | deny | ask` 联合类型，没有重写这一种类，因此执行它需要改动 `packages/core/tools`，超出本 lane 对 `packages/hooks/*` 的所有权范围。这一发现并非新发现——此前已记录在 [pre-tool-input-rewrite Agent Note](../../proposed/feature/2026-06-30-pre-tool-input-rewrite.md)，并已被两份桥接 README 引用——因此本笔记不重复记录，只确认该约束依然成立。

两个记录旧行为的 coverage-cases 测试已改写为断言新行为：一个 `{"continue":false}` 的 `PreToolUse` 钩子现在会拒绝该工具（工具从未运行），轮次以 `{ kind: 'aborted', reason: { kind: 'hook', reason: 'halt' } }` 结束，而不再是工具照常运行、轮次正常完成。

## 曾考虑的替代方案

**用 `jscpd:ignore` 标记包裹两个桥接新增的近乎相同的代码**，而非提取共享逻辑。双胞胎 TODO 修复落地后，重复检测门（`pnpm run duplication`）标记出三处新的克隆——配置加载／会话发现控制流、matcher-group 合并，以及 pre-step 起始上下文绑定。真正的提取（上文五个原语）解决了除一段残余 10 行／66 token 的纯 `ctx.on()` 注册样板代码之外的全部问题，该样板围绕现已变得极简的 `bindStartContext` 调用；它被并入 `hooks-codex` 中已有的 `jscpd:ignore` 区间（该区间此前已用于同一类别的「共享 helper 调用点，方言差异从此处之后开始」），而非新开一个豁免区间——与既有先例一致，不是新的例外。

**在桥接层而非库层报告 `StartGate.register` 的运行 reject。** 旧代码有一个横跨 `runPoint(...).then(agent.inject).catch(warn)` 的单一 `.catch`；将送达拆分进 `register` 内部的 `deliver` 调用后，这条链的内半部分（`run` 本身 reject，区别于 `deliver` 抛出异常）在结构上变得无法通过任何桥接层测试触达——因为 `runHook` 有文档保证从不抛出异常，而 `appendHookInvoked`／`appendHookResult` 对无轮次的 SessionStart 点是被门控关闭的。这个内层 catch 也并非纯粹的死代码：一个未被隔离的 `run` reject 会使 `claim()` 返回一个调用方必须以 reject 形式继承的 promise，破坏 `bindStartContext` 对调用方一侧「不得 reject」的契约。将 reject→`undefined` 的转换移入 `StartGate.register` 自身（一个调用方提供的 `onError`）恢复了完全可达性（`start-gate.spec.ts` 直接用 `Promise.reject` 加以验证），并将该不变量保持在其所属层级强制执行，而非在每个桥接中重复实现。

**按运行而非按轮次为 Stop 循环上限计数。** 曾考虑此方案，因为一次强制 continuation 理论上可能打开新轮次，从而在计数器不知情的情况下将其重置，使上限形同虚设。已先通过实证验证（见「决策」）`agent.steer()` 保持在同一轮次内，因此按轮次计数的既有设计是正确的；无需改动。

## 后果

`packages/hooks/hook-protocol/src/**`、`hooks-claude-code/src/**` 与 `hooks-codex/src/**` 均达到逐文件 100% 语句／分支／函数／行覆盖率（`node node_modules/vitest/vitest.mjs run packages/hooks --coverage --coverage.include='packages/hooks/*/src/**'`），`pnpm run duplication` 报告零克隆，`pnpm run typecheck` 与 `pnpm run lint` 均干净通过。两个桥接的 `Config` 都新增了 `sessionConfigFile?: string` 与 `maxConsecutiveStopBlocks?: number`；两份 README 的「已知限制」章节都移除了 `TODO(hook-continue-false)`／`TODO(session-start-gating)`／`TODO(stop-loop-guard)`／`TODO(per-session-hook-config)` 标记，并换上了准确的替代文案，包括 `hook-protocol` README 自身的原语表格，以及此前已经过时的「SessionStart 上下文暂存在 inbox 中」那一行。未来第三个方言桥接只需导入这五个 `dsh-hook-protocol` 导出，即可获得相同的四项行为，而无需重新实现。
