# @deepseek-ai/dsh-hooks-claude-code

[English](README.md) | 中文

一个 Cordis 插件，在 harness 的规范拦截点上运行用户现有 **Claude Code** hook 配置（`hooks.json` 或 settings 文件的 `hooks` key）中受支持的 command hook 子集。它是 hooks 子系统的 **CC 方言**部分，负责桥接中 CC 格式的逐事件 stdin payload、CC 的 env 和 `${CLAUDE_PLUGIN_ROOT}`／`${CLAUDE_PROJECT_DIR}` 替换，以及将 hook 的中性结果映射为 harness 的类型化 Decision。方言无关原语（matcher、退出码／stdout codec、`ctx.shell` 执行、最严格合并、`hook/*` 事件）来自 [`@deepseek-ai/dsh-hook-protocol`](../hook-protocol/README.md)。

原生 Cordis 插件可以完成此桥接的所有工作，功能更强，且具有类型化返回，没有序列化边界。**该桥接只是已映射 CC command hook 子集的兼容路径**；所有定制行为都应当使用相同扩展点上的原生插件（见 [拦截扩展点 Agent Note](../../../.agents/notes/implemented/feature/2026-06-30-interception-extension-points.md)）。

## 配置

```ts
import type { Config } from '@deepseek-ai/dsh-hooks-claude-code'
const config: Config = {
  configPath: '/path/to/hooks.json', // required: a hooks.json or a settings file with a `hooks` key
  sessionConfigFile: '.claude/hooks.json', // optional: per-session project-local discovery, resolved against each session's cwd
  pluginRoot: '/path/to/plugin',     // optional: replaces ${CLAUDE_PLUGIN_ROOT} in command strings
  projectDir: '/path/to/project',    // optional: replaces ${CLAUDE_PROJECT_DIR} AND sets the hook env var; defaults to the session cwd when omitted
  defaultTimeoutMs: 600_000,         // optional: per-hook timeout when a hook sets none (CC default)
  stderrSummaryMaxChars: 500,        // optional: char cap on the hook/result event's persisted stderr summary
  maxConsecutiveStopBlocks: 8,       // optional: consecutive Stop-hook forced continuations allowed per turn before the block is overridden (CC's own guard default)
}
```

在 `cordis.yml` 中：

```yaml
- dsh-hooks-claude-code:
    configPath: ./.claude/hooks.json
    sessionConfigFile: .claude/hooks.json
    pluginRoot: ./.claude/plugins/my-plugin
    projectDir: .
```

进程级 `configPath` 只在加载时解析**一次**：相对路径在加载时根据进程启动 cwd 解析，因此一份配置应用于整个进程。可选的 `sessionConfigFile` 增加每会话项目本地发现——路径相对于每个 agent 会话的工作区（`session/new.cwd`）解析，在每个会话首次使用 hook 时解析并缓存一次；其分组会在每个点上**晚于**进程级分组运行，没有该文件的会话工作区则没有会话级 hook。`configPath` 的读取／解析失败会被隔离处理，其中包括实际消费 matcher 的事件所带的无效 matcher 正则（会报告其 pattern 与事件）：未配置 `sessionConfigFile` 时，桥接记录警告且不注册任何内容（路径拼写错误不应使 agent（智能体）停止）；否则会继续仅依靠会话级发现运行。会话级文件自身的读取／解析失败会以同样方式被隔离，且只影响该会话。只运行 shell 形式 `type: 'command'` hook；`http`／`mcp_tool`／`prompt`／`agent` hook 会被解析并跳过，同时记录警告。没有每 hook `timeout` 的 hook 会使用协议参考默认值 `DEFAULT_HOOK_TIMEOUT_MS`（来自 `dsh-hook-protocol`，10 分钟，即 CC 默认值）。

hook **本身**会在 agent 的会话工作区中运行：对 agent scope 点，桥接会将会话 `cwd`（`session/new.cwd`）作为 hook 进程工作目录，因此 hook 的 `pwd`／相对路径／marker 作用于用户项目树，而非服务器启动目录。

## Hook 点 → 类型化 Decision

| CC hook | Harness 点 | 映射 |
|---|---|---|
| `SessionStart` | `agent/session-start`（emit） | additionalContext → 被第一个 `agent/pre-step` 步骤认领并等待，折叠进该步骤的消息中（受 hook 超时限制）；没有步骤认领时使用 `agent.inject()` |
| `UserPromptSubmit` | `agent/pre-step`（waterfall（瀑布式事件）） | `deny` → `PreStepDecision.reject`；`continue:false` → 中止运行；仅 additionalContext → 通过 `next()` 委托，再向下游 `enter` 决策追加一条单独标记来源的消息（后续外层 listener 仍可 reject／改写） |
| `PreToolUse` | `tools/pre-execute`（waterfall） | `deny` → `PreToolDecision.deny`；`ask` → `PreToolDecision.ask`；`continue:false` → 中止运行并拒绝该工具 |
| `PostToolUse` | `tools/post-execute`（waterfall） | `deny` → 带反馈的 `block`；`continue:false` → 中止运行（在工具执行之后）；仅 additionalContext → 通过 `next()` 委托，再将一个单独标记源的上下文前置到下游决策；Code Mode 将子调用上下文延迟到外层 `run_code` 结果 |
| `Stop` | `agent/turn-stopping`（serial） | 阻塞 Stop hook 通过 `steer()` 送入其原因，强制再执行一步，每轮次最多连续 `maxConsecutiveStopBlocks` 次；`continue:false` 会覆盖阻塞，让轮次结束 |
| `SubagentStart` | `subagent/start`（emit） | additionalContext → `agent.inject()` 到仍在运行的同进程 child；远程 child 没有本地注入目标 |
| `SubagentStop` | `subagent/end`（emit） | 只观测 |

三个 emit 点都以分离方式运行：没有扩展点会等待 `SessionStart`／`SubagentStart`／`SubagentStop` hook。每条运行链都会被跟踪；对桥接执行 dispose（资源释放）时，会中止仍在运行的 hook 进程，并在 dispose 完成前排空 continuation（`createDetachedRuns`，位于 `dsh-hook-protocol`）。

matcher subject 是工具名称（`PreToolUse`／`PostToolUse`）、会话源（`SessionStart`），或常量 `agent_type`，其值为 `general-purpose`（`SubagentStart`／`SubagentStop`）。harness subagent seam 不携带每 kind label，因此桥接报告 Claude Code 自身 Task 工具默认值；默认／`*`／空 `agent_type` matcher 会触发，特定 kind matcher 不会触发。`UserPromptSubmit`／`Stop` 忽略 matcher。一个点上文件配置的多个 hook 会**按配置顺序串行运行**，并按最严格方式折叠（`deny > ask > allow`，见 `dsh-hook-protocol`）。串行使每个 hook 的 `hook/invoked`／`hook/result` 对在日志中相邻，权限决策的折叠结果与顺序无关（见 Agent Note 的「run serially, not concurrently」说明）。

每个 agent scope stdin payload 都携带 `session_id` 与字符串形式的 `transcript_path`。可用时，桥接通过 `ctx.sessionPersistence.locate(session.header)` 解析后者，否则发送 `''`。查找不会创建或 flush 产物，因此第一个轮次结束检查点之前路径可能不存在，也可能省略当前开启轮次。

## 上下文源

注入上下文携带显式 `{ kind: 'plugin', plugin: 'hooks-claude-code' }` 来源，因此持久消息绝不会被误认为用户提示词。

## 模型体验

### Hook 提供的上下文

#### 模型看到的内容

`SessionStart`、已接受提示词、工具后和实时同进程 subagent-start hook 可以添加带源归因的上下文消息；阻塞 `Stop` hook 将原因添加为下一步 steering（中途引导）。远程 child 注入没有本地目标。

#### Token 影响

hook 不返回上下文时没有成本。Hook 文本取决于数据，会被记录，并在后续会话请求中重发，直到压缩（compaction）。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 已阻塞提示词或工具结果

#### 模型看到的内容

提供方提供的原因逐字传递。缺失原因时，已阻塞提示词精确使用 `blocked by UserPromptSubmit hook`，已拒绝工具变为 `Error: blocked by PreToolUse hook`，已阻塞工具后反馈精确为 `blocked by PostToolUse hook`，阻塞 stop 则精确添加 steering `continue: blocked by Stop hook`。`systemMessage` 与 `updatedInput` 会被记录或警告，但在此实现中对模型不可见。

#### Token 影响

阻塞提示词不会产生该提示词对应的模型请求 token；拒绝或反馈会添加保留的回退或提供方文本；强制 continuation 需要另一个完整请求。

#### KV Cache 影响

已阻塞提示词不发送请求，不会导致失效。拒绝、反馈与强制 continuation 上下文会追加在可复用前缀之后，不改写前缀。

## 已知限制与暂缓事项

- **不支持的 hook 事件（Claude Code 当前 30 项中的 23 项）：** `Setup`、`InstructionsLoaded`、`UserPromptExpansion`、`MessageDisplay`、`PermissionRequest`、`PostToolUseFailure`、`PostToolBatch`、`PermissionDenied`、`Notification`、`TaskCreated`、`TaskCompleted`、`StopFailure`、`TeammateIdle`、`ConfigChange`、`CwdChanged`、`FileChanged`、`WorktreeCreate`、`WorktreeRemove`、`PreCompact`、`PostCompact`、`SessionEnd`、`Elicitation` 和 `ElicitationResult`。这些事件的配置会在配置组解析前被忽略，因此不支持的事件既不会使配置失效，也不会注册 hook。比较基线是 Claude Code [官方 hook 事件参考](https://code.claude.com/docs/en/hooks#hook-events)。
- **`SessionStart` 只支持部分功能：** 会消费 JSON `additionalContext`，但不支持纯 stdout 上下文、`initialUserMessage`、`sessionTitle`、`watchPaths`、`reloadSkills` 与 `CLAUDE_ENV_FILE`。hook 脱离运行；其解析出的上下文会被第一个 `agent/pre-step` 认领并折叠进该步骤的消息中，因此送达是受 hook 超时限制的有界等待，而非与第一个请求赛跑——若没有步骤认领它（例如 agent 先被 dispose），则回退为 `agent.inject`。payload 会省略 `model`、`agent_type` 和 `session_title` 等当前可选字段。与其它 emit 点一样，它在没有已开启轮次时触发，因此该处的 `{"continue": false}` 既不会被记录，也不会被执行。
- **`UserPromptSubmit` 只支持部分功能：** 支持阻塞与 JSON `additionalContext`，但不支持纯 stdout 上下文、`sessionTitle` 和 `suppressOriginalPrompt`。除非被覆盖，否则桥接还会使用自身 600 秒默认值，而非 Claude Code 的事件特定 30 秒 command 超时。
- **`PreToolUse` 只支持部分功能：** `deny` 与 `ask` 决策可用；`allow` 不会预审批，不支持 `defer`，`additionalContext` 会被忽略，`updatedInput` 会被记录 + 警告但不应用（见 [pre-tool-input-rewrite Agent Note](../../../.agents/notes/proposed/feature/2026-06-30-pre-tool-input-rewrite.md)）。
- **`PostToolUse` 只支持部分功能：** 支持阻塞反馈与 JSON `additionalContext`，但不支持 `updatedToolOutput` 和 `updatedMCPToolOutput`，`tool_response` 会展平为文本。
- **`SubagentStart` 与 `SubagentStop` 只支持部分功能：** 两者均报告常量 `agent_type`，其值为 `general-purpose`，并在 Claude Code 报告父会话的位置使用 child 会话 id。Start 上下文是尽力而为，且只能到达仍在运行的同进程 child；stop 只观测，无法阻塞 subagent 或向其提供上下文。Start 省略 `transcript_path`；stop 还省略 `agent_transcript_path`、`last_assistant_message`、`background_tasks` 和 `session_crons`，并始终报告 `stop_hook_active: false`。两者都在没有已开启轮次时触发，因此该处的 `{"continue": false}` 既不会被记录，也不会被执行。
- **`Stop` 只支持部分功能：** 阻塞会强制另一个模型轮次（每轮次最多连续 `maxConsecutiveStopBlocks` 次——默认 8，即 Claude Code 自身守护阈值，达到后阻塞会被覆盖，允许该轮次结束），`stop_hook_active` 现在会如实报告本轮次是否已有 Stop hook 强制过 continuation。仍会省略 `last_assistant_message`、`background_tasks` 和 `session_crons`。
- **通用 payload 与输出字段只支持部分功能：** 已映射事件会省略 Claude Code 原本会提供的 `prompt_id`、`transcript_path`、`permission_mode` 和 `effort`。`systemMessage` 会被记录 + 警告但不呈现。`{"continue": false}` 会在 `UserPromptSubmit`、`PreToolUse`、`PostToolUse` 和 `Stop` 处中止活动运行——映射为 `kind` 为 `hook` 的 `AgentCancelCause`，中止该轮次；`stopReason` 会成为取消原因（缺失时回退为按 hook 点命名的原因）。仍不会应用 `suppressOutput` 和 `terminalSequence`。
- **Handler 与配置只支持部分功能：** 只运行 shell 形式 command handler。会跳过 `http`、`mcp_tool`、`prompt` 和 `agent` handler；不遵循 `args`、`async`、`asyncRewake`、`shell`、`if`、`once` 和 `statusMessage` 等 command handler 选项。匹配 handler 串行运行且不去重，而 Claude Code 会并行运行并对相同 handler 去重。一个进程级 `configPath` 会在加载时解析一次；可选的 `sessionConfigFile` 在此之上增加每会话项目本地发现（见上文「配置」一节）。尚未实现 Claude Code 在此之外的分层项目、用户、插件与策略发现，以及实时重新加载。
