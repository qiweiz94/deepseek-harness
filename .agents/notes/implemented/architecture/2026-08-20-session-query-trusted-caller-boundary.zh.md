# Agent Note: session-query 的授权在每个消费方的边界上完成，而不是在服务内部

Status: implemented

[English](2026-08-20-session-query-trusted-caller-boundary.md) | 中文

## 问题

`@deepseek-ai/dsh-session-query` 与 `@deepseek-ai/dsh-session-query-sqlite` 的 README 各自带有一条"无调用方授权"的条目，措辞把它写成尚未完成的工作："这是上下文范围内的可信基础设施；**未来的**模型工具或 UI 必须限制调用方可检查的会话。"这段措辞在本次变更之前就已经过时了：`@deepseek-ai/dsh-tool-session-query` 已经存在，并且已经会对它暴露的每一个会话做授权。悬而未决的问题是：剩下的措辞究竟是低估了一个真实的缺口（某个消费方在未经授权的情况下就能触达会话数据），还是只需要修正措辞以匹配已经交付的现状。

## 决定

对代码库中每一处 `ctx.get('sessionQuery')` / `ctx.sessionQuery` 的调用方（排除生成的 `dsh-tool-cordis` API 目录）做一次全仓库 grep，恰好找到四个真实的消费方，而且它们每一个在把内容暴露到自身进程之外之前，都已经在各自的边界上做了会话访问授权：

- **`dsh-tool-session-query`**（面向模型的工具）——其 README 直接说明了机制："调用方只能来自 `ToolExecution.exec.agent`。跨会话访问要求目标与调用方会话的 `cwd` 值完全相等。" `session_search` 始终会排除调用方自身的会话，并在执行全文查询之前，先按调用方工作区权限检查所请求的父级 id。
- **`dsh-host-apiproxy`** 的 `session.search` RPC 处理器（`src/api-proxy.ts`，远程客户端的 `sessions.search` 调用所到达的 RPC 网关）——在返回之前，会把每一个提供方命中结果与 `listVisibleSessionSummaries()` 得到的可见 id 集合做过滤；Host 未列出的会话对应的命中会被静默丢弃，绝不会被返回。
- **`dsh-session-reference`**——其自身的 README 已经声明了等价的正面契约："该服务假设宿主有权读取 `ctx.sessionQuery` 公开的每一个会话；它不是面向模型的搜索工具。"
- **`dsh-session-query-sqlite`**——实现该抽象服务的具体后端；它是提供方，而不是跨越信任边界的调用方。

`packages/sdk` 与 `packages/acp`——两个真正的远程或跨进程客户端可能进入系统的地方——都没有在任何位置调用 `ctx.get('sessionQuery')` 或 `ctx.sessionQuery`；一个远程客户端触达 session-query 数据的唯一路径是经由 `dsh-host-apiproxy` 的 RPC 方法，而这些方法已经如上所述做了授权。

两份 README 中"无调用方授权"的条目都被改写为"受信任调用方边界"：`ctx.sessionQuery` 是一个同进程、上下文范围内的读取/搜索原语，按设计自身不做任何授权，这与 CLAUDE.md 的"在带类型的同进程边界处信任 TypeScript"原则相符——当前每一个同进程调用方，都已经在跨越真正的信任边界（线路、模型，或另一个租户）之前，在各自的边界上完成了授权；未来若有消费方跨越这样的边界，同样需要自行承担这一步。sqlite 包的条目现在链接到基础包中更完整的说明，而不是重复罗列消费方清单，因为这条信任边界是抽象服务本身的属性，只需定义一次。

## 考虑过的替代方案

- **把授权做进 `SessionQueryEngine` 本身**（一个调用方身份参数，或贯穿每个方法的可见性谓词）——已拒绝：当前没有任何消费方需要它做在那里。`dsh-tool-session-query` 与 `dsh-host-apiproxy` 分别在不同的维度上做授权（调用方会话 `cwd` 相等 vs. Host 列表可见性），这是各消费方特有的策略，而不是共享引擎能在不沦为"披着一张接口皮的两个不同服务"的情况下通用表达的东西。在没有任何消费方会使用它的情况下投机性地构建它，正是 `packages/AGENTS.md` 中"公共选择需要证据"这条原则所反对的。
- **保留 README 中"无调用方授权"的措辞，只是补充说明当前由消费方自行处理**——已拒绝：原始措辞主动陈述了一个已经存在且已经交付的机制（`dsh-tool-session-query`）的错误状态（"未来的模型工具或 UI 必须限制"），这比一条不完整但准确的限制说明问题更严重。
- **仍然把这当作一个真实缺口，出于纵深防御考虑照样加入调用方身份检查**——已拒绝：这次 grep 是针对当前代码树的穷尽式检索，因此这不是"没有证据证明调用方已被授权"，而是"没有可行的、拥有真实代码路径可供利用的未授权调用方"；CLAUDE.md 的边界原则正是把界线画在带类型的同进程代码上，为的就是避免这种投机性的校验。

## 后果

- 没有任何代码发生变化；`SessionQueryEngine` 与 `SqliteSessionQueryEngine` 均未修改。这份 Agent Note 与两处 README 改写就是本次变更的全部内容。
- 上述 grep 证据就是这一决定的可达性证明；未来若有 PR 为 `ctx.sessionQuery` 新增一个会触达线路、模型或多租户边界的消费方，就必须在那个新边界上自行加入授权，做法与现有三个消费方一致——共享服务本身仍然不做任何授权。
- 如果未来确实出现需要在共享服务内部做授权的真实需求（例如两个消费方都想要完全相同的策略），那就是新的证据，说明本笔记"当前没有消费方需要它"的前提已不再成立，届时应当重新审视上述替代方案，而不是现在。
