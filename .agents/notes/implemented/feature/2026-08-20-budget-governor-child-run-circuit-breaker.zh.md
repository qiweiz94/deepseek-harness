# Agent Note：预算治理器 —— 面向失控子代理运行的断路器

状态：已实现

[English](2026-08-20-budget-governor-child-run-circuit-breaker.md) | 中文

## Problem

一个被委托的子代理可能在从不失败的情况下持续消耗资源：它可能在一次损坏的工具调用上无限循环、反复重写同一个文件、或者把上下文一路增长到远超其任务所需的规模。现有的防护手段都无法阻止这种情况。`dsh-repeat-tool-reminder` 只是建议性的 —— 它会提醒陷入循环的模型停下来，但一个无视建议的子代理会继续运行。`dsh-timeout-policy` 限制的是单次工具调用，而不是一整次运行。委托消费者（`dsh-tool-subagent`、`dsh-plugin-subagent-router`）在等待 `SubagentRun.result` 时没有自己的上限，因此父代理会一直等下去，无论子代理跑多久。整个组合中没有任何环节在强制执行每次委托的预算上限。

最初的需求勾勒了一个 `subagent/turn-end` 事件和一个 `ctx.subagents.abort()` 方法。这两者都不存在，本笔记记录的是如何把这一意图映射到确实存在的接口上。

## Decision

`@deepseek-ai/dsh-budget-governor` 是一个函数插件（没有工具，没有服务），它监视子代理运行，并在某次运行越过已配置的上限时将其终止。它从不治理根代理：它只跟踪由子代理生命周期事件宣告的那些会话，而根会话从不在其中被宣告。

### 需求设想 → 真实接口

| 需求设想 | 实际使用的接口 |
|---|---|
| `subagent/turn-end` 事件 | `subagent/start` / `subagent/end`（`ctx.subagents` 上的运行生命周期配对）用于识别子运行；经过过滤、只保留已宣告子会话 id 的 `session/event`，承载每次运行的遥测数据：`tool/call`、`tool/result`、`assistant/message` |
| `ctx.subagents.abort()` | 子 `Agent` 自身公开的取消接口：`agent.cancel({ kind: 'hook', reason })`，作用于 `subagent/start` 通知期间由 `ctx.agents.get(info.id)` 解析出的那个 Agent（文档记录了本地提供方在此刻是可解析的） |
| “abort 会通知父代理” | 父级报告是治理器通过 `parent.inject()` 注入父会话的一条 `user/message`（见下文）；委托自身的工具结果会通过既有机制独立报告取消情况 |

### 强制执行只经由既有机制传播

`agent.cancel({ kind: 'hook', reason })` 会中止子代理当前活跃的回合；该回合以 `turn/end { kind: 'aborted', reason: { kind: 'hook', … } }` 结束；进程内一次性驱动器（`dsh-subagent-in-process-driver`）将其映射为 `stopReason: 'aborted'`；`settleForegroundRun` 将非 `completed` 的停止原因转换为一个携带子代理部分输出的抛出错误，工具注册表再将其作为 `isError` 工具结果返回给父模型。运行持有者始终保有唯一的 `dispose()` 所有权 —— 治理器从不触碰运行句柄，因此无需新增终止钩子，事实上也没有新增。

`{ kind: 'hook', reason }` 是专为带外策略行动者构建的那个 `AgentCancelCause` 变体，它会把治理器的原因字符串带入持久化的 `turn/end` 记录中。

### 父级报告通道

终止发生时，治理器会向父代理注入一条结构化通知（`parent.inject(...)`，来源为 `{ kind: 'plugin', plugin: 'plugin-budget-governor', form: 'notice' }`）。父代理是通过子会话持久化的血缘关系解析得到的（`child.session.header.parentSession` → `ctx.agents.get(...)`）。选择注入作为通道的原因：

- **“模型可见 ⟺ 已记录” 天然成立**：`inject` 会作为一条 `user/message` 会话事件落入父级日志，因此报告可以完全从日志重建，无需新增会话事件类型。
- **时机**：父代理的驱动器会在其下一次预备步骤 —— 也就是紧跟在被中止委托的 `isError` 工具结果之后 —— 读取被注入的内容，因此模型能在读到失败信息的同时看到其原因。
- **归属**：工具结果文本属于委托消费者（`settleForegroundRun`）所有；从监听器改写它会是在做出决策的操作之外强制执行决策，并且会遗漏在别处结算运行的消费者（后台 Task 结算）。

### 检测器（v1，范围收窄）

按子会话 id 保存的每次运行遥测状态，在 `subagent/start` 时创建，在 `subagent/end` 时删除（状态量受存活运行数限制）。所有上限均为配置项；至少必须配置一个，否则插件在加载时失败。

- **`maxChildTokens`** —— 在每次子代理 `assistant/message` 时，将 `ctx.tokenMeter.measure(childSession).totalTokens` 与上限比较。这衡量的是子代理面向模型的请求面（与压缩定价上下文所用的同一次重放折叠），而不是供应商计费的累计花费；README 记录了这一语义。
- **`maxConsecutiveToolFailures`** —— 一次子代理 `tool/result`，若其面向模型的结果块 `isError: true`，会使该次运行的计数器加一；非错误结果会将其重置为零。该检测器可以清除：任意位置的一次成功都会打断失败连续记录。
- **`editChurn`** —— `{ maxSameFileEdits, window, tools: [{ name, pathArgument }] }`。子代理每一次名称匹配已配置编辑工具的 `tool/call`，都会把提取出的路径计入该运行最近 `window` 次编辑调用组成的有界滑动窗口；当某一路径在该窗口内累计达到 `maxSameFileEdits` 次条目时上限触发。该检测器可以清除：移出窗口的编辑不再计数。编辑工具名称与路径参数键属于配置项而非常量，因为被治理的工具集是部署相关的词汇（本仓库 `dsh-tool-fs` 中是 `edit`/`file_path`，MCP 或 ACP 工具集下则不同）。

终止每次运行只发生一次（被触发的运行会被标记；其后续事件将被忽略）。检测器求值失败按监听器处理原则被容纳：捕获、每次运行最多记录一次警告日志，绝不允许中断会话分发。

### v1 中被搁置的范围

- **不治理远程运行。** `local: false` 的 `subagent/start`（例如 ACP 提供方）既不暴露可取消的本地 `Agent`，也不追加可观察的本地会话事件，因此检测和执行都缺乏接口。治理器会跳过这些运行；README 记录了这一限制。要跨越 ACP 边界扩展治理能力，需要在提供方接口上新增远程取消能力 —— 本次有意不做这一发明。
- **可续期子代理按其常驻的 Activation 纪元受治理。** 每个 Activation 纪元都会以相同的会话 id 宣告 `subagent/start`/`subagent/end`，因此上限作用于常驻子代理；治理器的一次取消会中止其当前回合（等价于祖先发起的一次 `interrupt`），而不会销毁持久化的子代理。
- **本 PR 不附带无密钥快照示例。** 报告文本已由包 README 与单元测试 + Loader 组合测试逐字校验；将受治理委托示例接入快照测试框架的工作被推迟，并记录在 README 的限制章节中。

### 组合

`inject = ['subagents', 'agents', 'tokenMeter']`。即便 `maxChildTokens` 未设置，这三者也都是硬性依赖，以保持激活契约静态且在加载器状态中可见，而不是依据数据变化。配置是一个 schemastery `Config` 加上失败即报错的 `apply` 检查：至少一个上限；整数且在范围内；`window >= maxSameFileEdits`（更小的窗口永远不可能触发）；编辑工具名称非空、不重复，且 `pathArgument` 非空。

## Alternatives considered

- **通过 `SubagentRun.dispose()` 或请求 `signal` 终止** —— 两者都由持有者拥有：运行句柄只返回给委托消费者，而 signal 属于发起委托的那个工具的执行过程。插件若要触及任一者，都需要在接口上新增一条侧通道；子 Agent 公开的 `cancel` 已经精确表达了这种权限。
- **`ctx.subagents.interrupt(sessionId, authority)`** —— 仅适用于可续期场景（对一次性运行而言是被接受的空操作，而一次性运行恰恰是主要的失控场景），并且需要治理器并不持有的祖先 Agent 或人工授权。
- **在子代理接口上新增 abort/turn-end 能力** —— 这是需求最初设想的形态。v1 中被拒绝：所需的每个信号在真实接口上都已存在，而为单一消费者拓宽一个能力接口违反了服务定义规则；如果未来确实需要远程治理，那将是重新审视此决定的时机。
- **通过委托工具结果报告** —— 基于归属和绕过风险被拒绝（见上文通道一节）。
- **作为新的会话事件类型报告** —— 这相当于为一件“本质上就是一条被注入的通知”的事情新增一个 `SessionEventMap` 成员以及 UI/持久化处理；带插件来源的 `user/message` 是既有通道（`dsh-repeat-tool-reminder` 用同样的方式投递其提醒）。
- **统计 `assistant/message.usage` 中的计费 token** —— 衡量的是供应商每一步上报的花费，但在某个适配器不上报用量时会缺失，且与本框架自身给上下文定价所用的口径不一致。`ctx.tokenMeter.measure` 是本仓库唯一的 token 度量接口；其请求面语义已在文档中说明。
- **在编辑抖动检测中硬编码本仓库的 `edit` 工具** —— 被治理的工具集是部署相关的词汇；硬编码常量会悄无声息地漏掉改名后的工具或 MCP 工具集，而这恰恰是配置规则想要防止的那类静默错误配置。
- **扩展 `dsh-repeat-tool-reminder` 以支持强制执行** —— 它的契约按设计对父代理自身的调用是建议性的；对子运行的强制执行属于不同的行动者（生命周期事件 + Agent 取消，而不是工具瀑布链），把两者耦合会让该提醒包多出一个与自身职责无关的变更理由。

## Consequences

- 一个失控的子代理现在最多只会花费其已配置的预算，父模型也会在看到失败的同一步中了解到委托为何终止 —— 代价是组合中多了一个插件，并对 `agents` 与 `tokenMeter` 产生硬性依赖。
- 治理器的权限就是子 Agent 公开的取消接口本身，因此被取消的子代理留下的持久化记录与任何一次钩子取消完全相同；子代理日志中不存在任何治理器专属的痕迹。
- 远程（`local: false`）委托在提供方接口具备远程取消能力之前，始终不受治理。
- Token 上限限制的是上下文面，而不是计费花费；一个通过大量重复短请求消耗 token 的子代理会触发失败或编辑抖动上限，而不是 token 上限。
