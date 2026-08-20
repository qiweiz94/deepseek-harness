# Agent Note：子代理路由器插件

状态：已实现

[English](2026-08-19-subagent-router-plugin.md) | 中文

## 问题

子代理接缝暴露了多 provider 注册表（`spawn`、`fork`、`acp`、`codex`、`claude-code`、`dsh-sdk`），但每个面向模型的委托工具都绑定到一个已配置的 provider（`dsh-tool-subagent`）：要暴露多个传输方式，就必须为每个后端加载一次该工具插件并赋予不同的 `toolName`，由模型按工具名选择。Provider 选择被记录为配置而非模型可见，并且刻意没有单一委托入口，也没有按能力解析。接缝 README 记录了"等待具体消费者"的延后决策 API——路由器正是占据这一位置的消费者。

## 决策

**新增面向模型的插件 `@deepseek-ai/dsh-plugin-subagent-router`，注册一个 `subagent` 工具**（`toolName` 可配置，默认 `subagent`），按配置所拥有的策略路由委托任务。模型只描述任务（`description` + `prompt`）；从不指名 provider 或传输方式。

**路由是确定性策略。** `Config.providers` 是默认的有序候选列表；`Config.routes` 提供按标签命中的覆盖，不区分大小写地匹配任务 `description`。每条命中的路由都按配置顺序贡献其有序 provider；任何命中路由的委托都不会回退到默认候选——路由即策略，无法路由的委托大声失败。调用时路由器遍历候选、跳过未注册的 provider，并派发给第一个 `SubagentCapabilities` 满足请求需求的 provider——只有当相应配置项被设置时才要求 `persona`/`toolFilter`/`depthLimit`。没有可用的候选时大声失败，并列出尝试过的候选与缺失的能力。

**路由器是调用方/协调者，而非拦截器。** 子代理接缝没有暴露派发前 waterfall，因此插件注册自己的工具，调用 `ctx.subagents.start(provider, request)`。它不缓存任何 provider 状态；每次调用都对着实时注册表解析，因此兄弟加载顺序与 HMR 都无需 `subagent/provider-added` 记账。

**`dsh-tool-subagent` 继续保留**，作为 1:1 provider 绑定以及后台/可续会话模式的显式底层逃生通道；v1 路由器不暴露这些模式。

## 备选方案

**纯能力自动解析。** 已否决：能力本身无法区分 `spawn`（全新）、`fork`（种子化）与 `dsh-sdk`（进程外）——它们共享能力标志但语义不同；按能力自动选择会迫使模型表达传输意图。

**只做配置间接层而不新增工具。** 已否决：这没有填补路由器要解决的"单一委托入口"缺口。

**在现有工具之上做故障转移/可用性层。** 延后：接缝的 `getProvider`/注册表已提供注册存在性；暂时还不需要健康信号层。

## 后果

加载路由器的组合会暴露一个 `subagent` 动词，其后端由策略与能力决定。误配置（空的 `providers`、空的 `toolFilter`、空的 `routes[].label`）会在加载时通过 z schema 大声失败；provider 集合不可达或不具备能力时，会在调用时以模型可见的原因大声失败。工具返回子代理的最终输出，并把非 `completed` 的终止原因映射为保留部分输出的错误。v1 仅前台；`run_in_background` 与可续会话委托仍由 `dsh-tool-subagent` 承担。工具是并发安全的，因此兄弟委托最多可重叠到循环的并行调用上限。
