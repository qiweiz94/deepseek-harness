# @deepseek-ai/dsh-plugin-budget-governor

[English](README.md) | 中文

一个不注册任何模型可见工具的 hook/guard 插件。它通过运行时的只读观察钩子观测每一次子代理（subagent）运行，为每个子代理核算三类失控信号——累计计费 token 消耗、连续失败的工具执行、以及来回反复的文件改写——并在首次越界时向子代理能力缝（seam）请求其唯一的公开停止操作，随后向该子代理的父代理投递一份结构化的终止报告。

## 功能

治理器为每个已发布的子代理运行维护一条预算记录：在 `subagent/start` 时开启，在 `subagent/end` 时释放。三个探测器针对该记录运行：

- **Token 消耗。** 子代理写入自身会话日志的每条 `assistant/message` 都贡献其计费 token。`TokenUsage` 的三个输入计数互不相交，因此总量为 `inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens`；`reasoningTokens` 被排除，因为各 provider 将其计入 `outputTokens` 内部。累计总量超过 `maxTokens` 时该运行越界。省略 `maxTokens` 即关闭此探测器。
- **连续工具失败。** 每个 `isError` 工具结果延长当前连续失败链，每个成功结果将其归零。运行在超过 `maxConsecutiveToolFailures`（默认 4）的那一次失败上越界：第五次连续失败越界，第四次不越界。
- **文件反复改写。** 对已配置改写工具（`churn.tools`，默认 `write` / `edit` / `str_replace_editor`）的每次成功调用都会归属到一个文件（`churn.pathKeys`），并按其写入内容生成指纹（`churn.contentKeys`）。每个文件保留一个两格窗口：重写相同内容属于幂等操作，不推进任何计数；翻回上上次的内容记为一次 revisit；真正的新内容则**清零**该链。当某个文件的 revisit 计数超过 `churn.repeatThreshold`（默认 2）时运行越界——对应单个文件上的 `A B A B A` 序列，而不是一长串正常修订。每个运行最多保留 256 个文件的链，按插入顺序淘汰。

首次越界即终局裁定：该运行随即退出核算，因此一次失控恰好产生一个 `budget-governor/breach` 事件和一份父代理报告，而不是一串事件风暴。

## 中止能力缝：真实 API 允许什么

本插件所依据的规格提到了 `subagent/turn-end`、`tool/call` 和 `ctx.subagents.abort(subagentId, reason)`。三者都不存在。插件实际使用的映射如下：

| 规格所述 | 真实接口 | 是否使用 |
| --- | --- | --- |
| `subagent/turn-end` | 运行生命周期用 `subagent/start` + `subagent/end`；最接近的按轮钩子是 `agent/turn-stopping` | 使用 start/end；按轮钩子无必要，因为越界判定在每次观测时就地完成 |
| `tool/call` | `tools/result`（`@mode emit`，深度冻结的最终结果）。`tool/call` 是会话日志的事件类型，不是 Cordis 钩子 | 是 |
| —（token 消耗没有专门钩子） | `session/event`，读取 `assistant/message` 的 `usage` | 是 |
| `ctx.subagents.abort(subagentId, reason)` | **不存在**；`SubagentRuntime` 没有 `abort` 方法 | — |
| — | `ctx.subagents.interrupt(targetSessionId, authority)`——文档称其为“唯一的公开停止操作” | 是 |

治理器是**只在执行处置时才成为主动调用方的观察者**。它的四个监听器不修改收到的任何内容，也不返回任何值，这正是观察钩子契约的要求。停止是对 `ctx.subagents` 的一次独立外发调用，以 `{ kind: 'ancestor', agent }` 授权发起，该 agent 由子代理自身的 `session.header.parentSession` 经 `ctx.agents` 解析得到。由于该父代理正是能力缝用于授权比对的已记录血缘，能力缝的 `UNAUTHORIZED` 拒绝在此调用点不可达。

使用真实停止而非臆想的停止，随之带来三条诚实的限制：

- `interrupt()` 停止目标的**当前一轮**；它保留收件箱、Activation 以及已发布的后代。它不是销毁。
- 对于**一次性（one-shot）**子代理——也就是 `ctx.subagents.start()` 所产生的对象——能力缝文档说明 interrupt 是被接受的空操作。停止请求仍会发出并被如实上报，但只有可续（continuable）子代理才真正停止。
- 若无法解析出存活的父 Agent（跨进程子代理，或父代理已离开注册表），就没有可出示的授权，也就完全无法停止。该情形在越界事件上报为 `enforcement: { kind: 'unenforceable', why }`——这正是能力缝留下的唯一选项：高声告警。

`Agent.cancel({ kind: 'hook', reason })` 曾被**考虑并否决**。`AgentCancelCause` 带有一个 `hook` 变体，读起来就像为本插件量身定制的 abort，而且越界时存活的子 Agent 就在手边。但 `interrupt()` 在把调用方与目标血缘完成授权比对**之后**，内部发出的正是同一个 `Agent.cancel`；直接调用它等于绕开能力缝唯一的授权步骤，只为换取略强一点的停止力度。本插件选择走授权路径，并如实记录它做不到什么。

## 配置

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `maxTokens` | *（未设置）* | 每次运行的累计计费 token 上限；未设置即关闭 token 探测器 |
| `maxConsecutiveToolFailures` | `4` | 容忍的连续失败次数；下一次失败即越界 |
| `churn.enabled` | `true` | 是否运行反复改写核算 |
| `churn.tools` | `['write', 'edit', 'str_replace_editor']` | 计为文件改写的工具名 |
| `churn.pathKeys` | `['path', 'file_path']` | 按顺序读取被改写路径的参数键 |
| `churn.contentKeys` | `['content', 'file_text', 'new_string', 'new_str']` | 用于生成写入内容指纹的参数键 |
| `churn.repeatThreshold` | `2` | 每个文件容忍的翻回旧内容次数；下一次即越界 |
| `onBreach` | `'interrupt'` | `interrupt` 请求能力缝停止；`report` 仅核算并公告，绝不请求能力缝停止任何东西 |

语义边界在 `apply()` 中检查，而不只在 schema 中，因为直接调用 `apply()` 会完全绕过 Schemastery：`maxTokens` 与 `maxConsecutiveToolFailures` 至少为 1；启用 churn 时 `repeatThreshold` 至少为 2（更低的下界会把一次普通回退当成反复改写），且 `tools`、`pathKeys`、`contentKeys` 均不得为空（任一空列表都会悄悄使探测器失效）。

## 事件

`budget-governor/breach` 发布结构化裁定：子代理的会话 id、provider、被突破的是哪项预算、越界时的测量值与其突破的界限、churn 越界时来回改写的路径、一行原因说明，以及 `enforcement` 结果。若部署方希望对“看见了却停不下来的失控”告警，可按 `enforcement.kind === 'unenforceable'` 过滤。

## 导出形态

函数/命名空间插件：导出 `name` / `inject` / `Config` / `apply`，且没有默认导出。多余的 `export default` 会经由 Loader 的 `unwrapExports` 把模块坍缩并丢弃 `inject`（见 [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)）。

## Model Experience

None, as the plugin registers no tool, prompt section, or model-visible schema; its only model-visible output is the termination report quietly injected into the breaching child's parent, whose content this package owns.

#### KV Cache effect

本插件保持沉默期间不会有任何内容进入请求前缀，因此在每个 agent 的整个健康生命周期内前缀复用不受影响。一次越界会向父代理的下一个 pre-step 注入一条 plugin 来源的 `notice` 消息，这会从父代理对话中的该点起使复用失效，与任何其他注入上下文完全相同——每个受治理的运行至多发生一次，且只发生在本就将被截断的运行上。

## Known Limitations and Deferred Work

- **反复改写检测依赖工具名与参数键。** 它从 `tools/result` 的参数中读取改写意图，而非取自 `fs/observed`，因为后者只携带一个不透明的新鲜度令牌——没有内容——且其 `actor` 是不透明的工具执行对象而非调用方 Agent。若某部署的编辑工具命名或参数形态不同，就必须配置 `churn.tools` / `pathKeys` / `contentKeys`，否则 churn 核算对它们静默地什么都观测不到。
- **一次性子代理实际上无法被停止。** `interrupt()` 对它是被接受的空操作，因此在常见的 `ctx.subagents.start()` 路径上，治理器是一个准确的探测器，但其响应仅为告知性质。要真正停止一次性运行，需要新增能力缝操作，而不是在此处改动。
- **Token 核算要求子代理会话在进程内。** 若某 provider 的子代理跨进程运行，它不会向本运行时可观测的会话追加 `assistant/message`，token 探测器因而对它一无所见；对于工具在进程外执行的子代理，失败链与反复改写探测器同样是盲的。
- **`billedTokens` 不是金额。** 它汇总 token 计数，而缓存读取与写入的计价与全新输入并不相同。若部署方需要以货币计量的预算，就需要本包刻意不携带的 provider 定价数据。
