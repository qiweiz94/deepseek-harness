# @deepseek-ai/dsh-hooks-codex

[English](README.md) | 中文

一个 Cordis 插件，在 harness 的规范拦截点上运行用户现有 **Codex** hook 配置的受支持子集。它是 hooks 子系统中采用 **Codex 方言** 的一侧。方言无关原语来自 [`@deepseek-ai/dsh-hook-protocol`](../hook-protocol/README.md)；该桥接负责处理 Codex 形状的 payload、matcher 模式和决策映射。

该桥接实现 Codex 当前 hook 协议的一个有意选取的子集：

- **10 个 hook 点中的 5 个：** `PreToolUse`、`PostToolUse`、`SessionStart`、`UserPromptSubmit` 和 `Stop`。
- **仅使用正则的 matcher**（没有字面量快速路径；matcher 始终是未锚定正则）。
- **snake_case stdin payload**，携带 `turn_id`／`model` 额外字段，写入时**不带**尾随换行符。
- **没有 Codex 插件 env 注入，也没有配置时 placeholder 替换**（命令仍会接收执行器环境，并通过其 shell 运行）。
- **没有工具前审批或改写路径**：hook 可以阻塞，但桥接不会预审批或替换工具输入。

原生 Cordis 插件可以完成此桥接的所有工作，并且功能更强；该桥接只是已映射 Codex 子集的兼容路径（见 [拦截扩展点 Agent Note](../../../.agents/notes/implemented/feature/2026-06-30-interception-extension-points.md)）。

## 配置

```ts
import type { Config } from '@deepseek-ai/dsh-hooks-codex'
const config: Config = {
  configPath: '/path/to/.codex/hooks.json', // required
  sessionConfigFile: '.codex/hooks.json',    // optional: per-session project-local discovery, resolved against each session's cwd
  model: 'deepseek-v4',                      // optional: stamped on every payload (Codex includes `model`)
  defaultTimeoutMs: 600_000,                 // optional: per-hook timeout when a hook sets none
  stderrSummaryMaxChars: 500,                // optional: char cap on the hook/result event's persisted stderr summary
  maxConsecutiveStopBlocks: 8,                // optional: consecutive Stop-hook forced continuations allowed per turn before the block is overridden (borrows Claude Code's guard default; Codex documents no cap of its own)
}
```

在 `cordis.yml` 中：

```yaml
- dsh-hooks-codex:
    configPath: ./.codex/hooks.json
    sessionConfigFile: .codex/hooks.json
    model: deepseek-v4
```

进程级 `configPath` 只在加载时解析**一次**——相对路径在加载时根据进程启动 cwd 解析，因此一份配置应用于整个进程。可选的 `sessionConfigFile` 增加每会话项目本地发现——路径相对于每个 agent 会话的工作区（`session/new.cwd`）解析，在每个会话首次使用 hook 时解析并缓存一次；其分组会在每个点上**晚于**进程级分组运行，没有该文件的会话工作区则没有会话级 hook。`configPath` 的读取／解析失败会被隔离处理；实际消费 matcher 的事件所带的无效 matcher 正则属于此类失败，并报告其 pattern 与事件。未配置 `sessionConfigFile` 时，该失败会被记录且不注册任何内容；否则桥接会继续仅依靠会话级发现运行，会话级文件自身的读取／解析失败会以同样方式被隔离，且只影响该会话。只运行同步 `type: 'command'` hook；非 command 或 `async: true` hook 会被解析并跳过，同时记录警告。hook 接受 `timeout` 或 `timeoutSec` alias；两者都未设置时，使用协议参考默认值 `DEFAULT_HOOK_TIMEOUT_MS`（来自 `dsh-hook-protocol`，10 分钟）。五个桥接支持点之外的事件会在解析时丢弃。

hook 本身会在 agent（智能体）的会话工作区中运行：对 agent scope 点，桥接会将会话 `cwd` 作为 hook 进程工作目录，因此 hook 作用于用户项目树，而非服务器启动目录。

## Hook 点 → 类型化 Decision

| Codex hook | Harness 点 | 映射 |
|---|---|---|
| `SessionStart` | `agent/session-start`（emit） | 纯 stdout hook 的输出 → additionalContext → 被第一个 `agent/pre-step` 步骤认领并等待，折叠进该步骤的消息中（受 hook 超时限制）；没有步骤认领时使用 `agent.inject()` |
| `UserPromptSubmit` | `agent/pre-step`（waterfall，瀑布式事件） | `block`（退出码 2）→ `PreStepDecision.reject`；`continue:false` → 中止运行；仅 additionalContext → 通过 `next()` 委托，再向下游 `enter` 决策追加一条单独标记来源的消息 |
| `PreToolUse` | `tools/pre-execute`（waterfall） | `block` → `PreToolDecision.deny`（没有 `allow`／`ask`）；`continue:false` → 中止运行并拒绝该工具 |
| `PostToolUse` | `tools/post-execute`（waterfall） | `block` → 带反馈的 `block`；`continue:false` → 中止运行（在工具执行之后）；仅 additionalContext → 通过 `next()` 委托，再将一个单独标记源的上下文前置到下游决策；Code Mode 将子调用上下文延迟到外层 `run_code` 结果 |
| `Stop` | `agent/turn-stopping`（serial） | 阻塞 Stop hook 通过 `steer()` 送入其原因，强制再执行一步，每轮次最多连续 `maxConsecutiveStopBlocks` 次；`continue:false` 会覆盖阻塞，让轮次结束 |

工具调用的 payload 携带真实 `tool_name`（matcher 测试的相同值）与 Codex `tool_input: { command }` 形状（存在 `command` arg 时使用该值，否则使用 `''`）。matcher subject 是工具名称（`PreToolUse`／`PostToolUse`）或会话源（`SessionStart`）；`UserPromptSubmit`／`Stop` 忽略 matcher。

每个 agent scope stdin payload 都携带 `session_id` 和 `transcript_path`。可用时，桥接通过 `ctx.sessionPersistence.locate(session.header)` 解析后者，否则发送 `null`，保留 Codex `string | null` 形状。查找不会创建或 flush 产物，因此在第一个轮次结束检查点之前，路径可能尚不存在，或其指向的 transcript（文本记录）可能尚未包含当前未结束的轮次。

`SessionStart` 是唯一的 emit 点，它会脱离运行。每条运行链都会被跟踪；对桥接执行 dispose（资源释放）会中止仍在运行的 hook 进程，再排空 continuation，之后 dispose 才会完成（`createDetachedRuns`，位于 `dsh-hook-protocol`）。

## 上下文源

注入上下文携带显式 `{ kind: 'plugin', plugin: 'hooks-codex' }` 来源，因此持久消息绝不会被误认为用户提示词。

## 模型体验

### Hook 提供的上下文

#### 模型看到的内容

`SessionStart`、已接受提示词和工具后 hook 可以添加带源归因的上下文消息；阻塞 `Stop` hook 将其原因添加为下一步 steering（中途引导）。

#### Token 影响

hook 不返回上下文时没有成本。Hook 文本取决于数据，会被记录，并重发直到压缩（compaction）。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 已阻塞提示词或工具结果

#### 模型看到的内容

提供方提供的原因逐字传递。缺失原因时，已阻塞提示词精确使用 `blocked by UserPromptSubmit hook`，已拒绝工具变为 `Error: blocked by PreToolUse hook`，已阻塞工具后反馈精确为 `blocked by PostToolUse hook`，阻塞 stop 则精确添加 steering `continue: blocked by Stop hook`。Codex `systemMessage` 不会呈现。

#### Token 影响

阻塞提示词不会产生该提示词对应的模型请求 token；拒绝或反馈会添加保留的回退或提供方文本；强制 continuation 需要另一个完整请求。

#### KV Cache 影响

已阻塞提示词不发送请求，不会导致失效。拒绝、反馈与强制 continuation 上下文会追加在可复用前缀之后，不改写前缀。

## 已知限制与暂缓事项

- **不支持的 hook 事件（Codex 当前 10 项中的 5 项）：** `PermissionRequest`、`PreCompact`、`PostCompact`、`SubagentStart` 和 `SubagentStop`。这些事件的配置会在解析期间静默丢弃。比较基线是 Codex [官方 hook 参考](https://learn.chatgpt.com/docs/hooks)。
- **`SessionStart` 只支持部分功能：** 支持纯 stdout 与 JSON `additionalContext`。hook 脱离运行；其解析出的上下文会被第一个 `agent/pre-step` 认领并折叠进该步骤的消息中，因此送达是受 hook 超时限制的有界等待，而非与第一个请求赛跑——若没有步骤认领它，则回退为 `agent.inject`。与其它 emit 点一样，它在没有已开启轮次时触发，因此该处的 `{"continue": false}` 既不会被记录，也不会被执行。
- **`UserPromptSubmit` 只支持部分功能：** 支持阻塞加纯 stdout 或 JSON 上下文，且 `{"continue": false}` 现在会中止运行；通用 `systemMessage` 控制仍不会被强制执行。
- **`PreToolUse` 只支持部分功能：** 支持阻塞（包括同样会中止运行的 `{"continue": false}`），但会忽略 `additionalContext`、`permissionDecision: "allow"` 和 `updatedInput`。每个工具都表示为 `tool_input: { command }`，因此非 shell 工具参数不会如实公开给 hook。
- **`PostToolUse` 只支持部分功能：** 支持阻塞反馈、JSON `additionalContext` 与 `{"continue": false}`（会在工具执行之后中止运行），但非 shell 工具参数会缩减为 `{ command }`，结构化工具输出会在 `tool_response` 中展平为文本。
- **`Stop` 只支持部分功能：** 阻塞会强制另一个模型轮次（每轮次最多连续 `maxConsecutiveStopBlocks` 次——默认 8，借用 Claude Code 自身的守护默认值，因为 Codex 自身未记录上限——达到后阻塞会被覆盖，允许该轮次结束），`stop_hook_active` 现在会如实报告本轮次是否已有 Stop hook 强制过 continuation。`last_assistant_message` 仍始终为 `null`。
- **通用 payload 与输出字段只支持部分功能：** 每个已映射事件都报告静态配置的 `model` 与 `permission_mode: "default"`，而非当前 Codex 运行时值。`systemMessage` 会被记录并触发警告，但不呈现。`{"continue": false}` 会在 `UserPromptSubmit`、`PreToolUse`、`PostToolUse` 和 `Stop` 处中止活动运行——映射为 `kind` 为 `hook` 的 `AgentCancelCause`，中止该轮次；`stopReason` 会成为取消原因（缺失时回退为按 hook 点命名的原因），而非应用 Codex 自身的事件特定停止行为。
- **配置加载与执行只支持部分功能：** 一个进程级 `configPath` 会在加载时解析；可选的 `sessionConfigFile` 在此之上增加每会话项目本地发现（见上文「配置」一节）。尚未实现 Codex 在此之外的活动用户层、项目层、会话层、系统／托管层和插件层，信任控制，以及内联 `config.toml` hook 形式。只运行同步 `command` handler，忽略 `statusMessage` 与 `commandWindows` 等当前元数据，匹配 handler 串行运行，而非使用 Codex 的并发启动语义。
