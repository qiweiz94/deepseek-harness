# @deepseek-ai/dsh-hook-protocol

[English](README.md) | 中文

Claude Code／Codex hook 协议格式（wire format）的**共享核心**。它不是 Cordis 插件：不注册也不注入任何内容。它是一个**库**，提供两个桥接插件（`@deepseek-ai/dsh-hooks-claude-code`、`@deepseek-ai/dsh-hooks-codex`）导入的方言无关原语，使两者都无需重复实现协议中相同的部分。

Codex 有意重新实现了 Claude Code hook 协议的一个*子集*，包括相同的 `hooks.json` matcher group 结构、相同的退出码／stdout 输出约定以及相同的 command hook 执行模式。真正共享的部分位于此处；每个桥接只负责不同的部分。

## 共享内容（此处）与各方言内容（桥接）

| 关注点 | 此处（`dsh-hook-protocol`） | 桥接（`dsh-hooks-claude-code` / `-codex`） |
|---|---|---|
| Matcher 校验与匹配判断 | `matcherDiagnostic(pattern, mode)` 用于解析时诊断；`matchesMatcher(pattern, query, mode)` 用于隔离的运行时匹配 | 选择自身的 `mode`（`claude` = 字面量或正则，`codex` = 始终使用正则），并拒绝带有诊断的配置组 |
| 运行 hook | `runHook(bash, hook, opts, now)`：通过 `ctx.shell` 提供 stdin payload + env，再解码 | 构造每个事件的 stdin **payload** + 该方言的 **env** |
| 解码输出 | `parseHookOutput(exit, stdout, stderr)` → 中性 `HookOutput` | 将中性 `HookOutput` 映射到扩展点特定的类型化 Decision |
| 合并 N 个 hook | `mergeHookOutputs(outputs)` → 最严格的 `MergedHookOutcome` | （无） |
| 持久记录 | `appendHookInvoked` / `appendHookResult`（`hook/*` 会话事件；结果的 `decision`／`stderrSummary` 从此处的 `HookOutput` 派生） | 在每次调用前后调用它们 |
| 脱离运行的完全停稳 | `createDetachedRuns()`：跟踪触发后不等待的运行链；`drain()` 先 abort，再等待它们 | 将 `signal` 传给每个脱离的 `runHook`，并将 `drain` 注册为 effect disposer |
| 运行级中止 | `applyHaltRequest(merged, point, agent)`：将 `continue:false` 映射为 `kind` 为 `hook` 的 `AgentCancelCause` | 在每个 `merged.stop` 为真的、限定于轮次的扩展点调用它 |
| Stop 循环计数 | `createStopLoopGuard(max)`：按轮次统计连续强制 continuation 的计数器 + 上限覆盖 | 围绕其 `Stop` 映射调用它，并在 payload 中报告 `stopHookActive` |
| SessionStart 首步门控 | `createStartGate()` / `bindStartContext(gate, agent, inject)`：认领并等待脱离运行，使第一个 `agent/pre-step` 被承诺获得其上下文，而非与之赛跑 | 在 `agent/session-start` 注册该运行，并将返回的折叠器应用到它返回的每个 `PreStepDecision` |
| 进程级 + 每会话 hook 配置 | `loadProcessHookConfig(opts)` / `createSessionHookConfigCache(opts)` / `combineHookGroups(process, session)`：读取／缓存／回退控制流 | 提供自身的 `parse`、警告文案和 matcher-group 类型 |
| 共享配置上限校验 | `resolveSharedHookLimits(bridge, config)` / `assertPositiveInteger(bridge, name, value)`：默认并校验 `stderrSummaryMaxChars` 与 `maxConsecutiveStopBlocks` | 在 `apply()` 中、任何配置文件解析之前调用一次 |

## 原语

- **`matcherDiagnostic(matcher, mode)` / `matchesMatcher(matcher, query, mode)`**：缺失、`''` 或 `'*'` 时匹配全部；`claude` mode 将纯 `[A-Za-z0-9_|]+` pattern 视为字面量（管道符 = 精确匹配交替），其他 pattern 视为正则；`codex` mode 始终使用未锚定正则。桥接解析器会丢弃没有 matcher 匹配对象的事件所带的 matcher 字段，再用 `matcherDiagnostic` 拒绝事件实际使用的无效正则，并在注册任何钩子之前给出稳定诊断。运行时谓词仍会将无效 pattern 隔离为不匹配，因此直接调用本库不会向 agent loop（智能体循环）抛异常。
- **`runHook(bash, hook, options, now)`**：要求并转发调用方拥有的 `options.signal`，将 `options.payload` 序列化到 hook stdin（当且仅当 `options.trailingNewline` 时添加尾随换行符），在执行器凭证清理后合并 `options.env`（`dsh-shell` 受信任插件接口），遵循 hook 的 `timeoutSec`（否则使用 `options.defaultTimeoutMs`；默认值属于桥接，其配置默认为 lib 的 `DEFAULT_HOOK_TIMEOUT_MS` 10 分钟参考值），再解码结果（将 `options.expectedEventName` 传递给 codec）。因此取消会到达执行器的进程组终止与 join 边界。它绝不抛出异常：执行器拒绝（基础设施故障）会变为 `HookOutput`，其 `exitCode: undefined`（非阻塞错误）。`now` 会被注入，以便测试持续时间。
- **`parseHookOutput(exitCode, stdout, stderr, expectedEventName?)`** 解码退出状态与结构化 stdout。退出码为 2 时，会以 stderr 内容阻止执行；其他失败不阻塞。匹配的 hook 特定权限决策会覆盖遗留顶层决策；事件判别字段不匹配或缺失只会抑制事件特定字段。顶层字段仍与事件无关，成功但非 JSON 的输出会留给桥接处理。
- **`mergeHookOutputs(outputs)`**：折叠在一个点上匹配的每个 hook 结果：权限优先级为 **deny > ask > allow**，从首个 `continue:false` 起，halt 状态保持不变，阻塞原因用 `\n\n` 连接，`additionalContext`／`systemMessages` 按顺序累积。
- **`createDetachedRuns()`**：跟踪以 emit 形式脱离运行的点是否完全停稳（没有扩展点等待它们）。桥接会跟踪每条运行链，包括 hook 运行及其 continuation，并将 `drain()` 注册为 effect disposer。drain 会触发 tracker 的 abort `signal`（因此仍在运行的 hook 进程会通过 `runHook` 终止，而不是等待到超时），随后在所有已跟踪链结算后 resolve。因此 `fiber.dispose()` resolve 时，不会遗留任何可能作用于已 dispose（资源释放）的上下文的脱离 hook 工作（见 [防御模式](../../../docs/defensive-patterns.md)：dispose 必须达到完全停稳）。
- **`applyHaltRequest(merged, point, agent)`**：通过以 `{ kind: 'hook', reason }` 取消 `agent` 的运行来执行合并后的 `continue:false`（`reason` 是首个中止 hook 的 `stopReason`，缺失时回退为按 hook 点命名的原因）。只在 `merged.stop` 为真时调用。没有 `agent`（直接的无 agent 工具执行）时没有运行可中止；调用方仍需承担其点局部决策（例如拒绝该工具），其原因由返回值命名。
- **`createStopLoopGuard(maxConsecutiveBlocks)`**：按 agent、按轮次统计连续 Stop hook 强制 continuation 的次数。`stopHookActive(agent, turn)` 报告当前 stop 边界是否已经因本轮次的强制 continuation 而到达（对应 payload 的 `stop_hook_active`）；`tryForceContinue(agent, turn)` 再计一次，达到 `maxConsecutiveBlocks` 时返回 `false`，此时桥接会覆盖阻塞，让轮次结束而不是无限循环；`clear(agent)` 会在非阻塞结果后重置计数。`DEFAULT_MAX_CONSECUTIVE_STOP_BLOCKS`（8）是 Claude Code 自身的守护阈值；Codex 的桥接将其作为先例借用。
- **`createStartGate()` / `bindStartContext(gate, agent, inject)` / `foldStartContext(inject, startContext, decision)`**：SessionStart 首步送达门控。SessionStart hook 会脱离运行，因此其上下文过去会与第一个模型请求赛跑；该门控使每个 agent 待处理的运行可被认领。`bindStartContext` 会认领并等待待处理运行，然后返回一个绑定到已认领值的折叠器：`foldStartContext` 会将其前置到一个进入型 `PreStepDecision` 的消息中，或者（对于非进入型决策）通过 `inject` 直接注入，并将送达延后到该 agent 的下一次唤醒。没有任何步骤认领的运行会在结算后回退到门控自身的 `deliver` 回调（同样是 `agent.inject`）。
- **`loadProcessHookConfig(opts)` / `createSessionHookConfigCache(opts)` / `combineHookGroups(processGroups, sessionGroups)`**：两个桥接共享的进程级与每会话 hook 配置加载。`loadProcessHookConfig` 在 `apply()` 时解析一次进程级 `configPath`，当 `opts.hasSessionFallback`（一个可选的 `sessionConfigFile`）仍能贡献 hook 时，容忍读取／解析失败。`createSessionHookConfigCache` 返回一个按 agent 的查找函数，在每个会话首次使用 hook 时读取并解析一个相对于工作区的文件一次（包括「没有文件」／「未配置发现」的结果），并按 agent 弱引用缓存结果。`combineHookGroups` 将一个点的进程级与会话级 matcher 分组拼接起来，会话分组晚于进程分组运行。解析、警告文案与 matcher-group 类型仍由桥接负责。
- **`resolveSharedHookLimits(bridge, config)` / `assertPositiveInteger(bridge, name, value)`**：在任何配置文件解析之前，默认并校验两个共享的正整数配置字段（`stderrSummaryMaxChars`、`maxConsecutiveStopBlocks`），使坏值不会被加载失败的提前返回掩盖；`assertPositiveInteger` 会抛出 `"${bridge}: ${name} must be a positive integer"`。

## `hook/*` 会话事件

通过 declaration merging 合并到 `SessionEventMap`（仅日志，与 `compaction/*` 相同；不是 `SurfaceEventType`，没有 `surfaceOp`）：`hook/invoked`（hook 命令已运行）与 `hook/result`（其结果，按 `handlerId` 配对，决策规则由 `appendHookResult` 负责）。Payload 与每事件 JSDoc 位于生成的 [持久化日志事件目录](../../../docs/persistence-catalog.md)；`stderrSummary` 会截断到记录的 `stderrSummaryMaxChars`（桥接配置，参考默认值 `DEFAULT_STDERR_SUMMARY_MAX_CHARS` = 500；为空时省略）。

Hook 调用／结果记录必须位于一个尚未结束的轮次内。`UserPromptSubmit`、`PreToolUse`、`PostToolUse` 与 `Stop` 按构造满足这条由所有者定义的关系。`SessionStart` 在轮次 1 之前运行，因此没有 `hook/*` 记录；其解析出的上下文会被第一个 `agent/pre-step` 步骤认领，并在该步骤进入时直接折叠进其消息中（受 hook 超时限制的有界等待，而非赛跑）——若没有步骤认领它（例如 agent 先被 dispose），则回退为 `agent.inject`，将上下文暂存在 inbox 中，直到后续唤醒交付打开一个轮次。详见 hooks Agent Note。

## 模型体验

通过 `dsh-hooks-claude-code` 与 `dsh-hooks-codex` 间接影响；它们可以将解析后 hook 输出转为提示词上下文、已阻塞结果或 continuation 反馈。

#### KV Cache 影响

不会直接失效；请求前缀变更由上述消费方负责。

## 已知限制与暂缓事项

- **`HookOutput.updatedInput` 会被解析但不会应用**：输入改写是已暂缓的一致性设计问题（见 [pre-tool-input-rewrite Agent Note](../../../.agents/notes/proposed/feature/2026-06-30-pre-tool-input-rewrite.md)）；当 hook 设置它时，桥接会记录 + 警告。完整约定见 `src/types.ts`。
