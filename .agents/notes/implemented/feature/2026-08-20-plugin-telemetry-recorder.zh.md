# Agent Note：会话遥测记录器插件

Status: implemented

[English](2026-08-20-plugin-telemetry-recorder.md) | 中文

## Problem

模型无法读取自己这次对话的运行数据。是否压缩、缩短上下文或停止委派，都是模型必须盲目做出的决定：它看不到自己的 token 速率、上一次请求占用了多少上下文窗口、提示词缓存命中率、转轮延迟，或还有多少子代理委派在运行。harness 把这些全都记录在持久会话日志与子代理生命周期事件里，却没有任何环节把它们呈现给模型。

## Decision

`@deepseek-ai/dsh-plugin-telemetry-recorder` 注册一个只读的、面向模型的工具 `get_session_telemetry`，它在最近若干已结束转轮的滚动窗口（`windowTurns`，默认 10）上折叠出调用会话自身的数据：每转轮平均 token 数与转轮挂钟延迟、提示词缓存命中率、最新请求占用模型上下文窗口的比例、以及子代理委派数量（已启动／已结算／运行中）。它在调用时读取 `exec.agent.session`，从持久日志加子代理生命周期配对派生一切——只注入 `tools`，本身不写入任何会话事件，从不写。会话尚未产生证据的数据会被省略，而不是报告成误导性的零。

该插件从并行分支（`feat/plugin-telemetry-recorder`）到来时没有 Agent Note；本笔记在集成时补齐，插件已在当前 master 上以标准集成接线重建（tsconfig 引用、tool-catalog 清单条目与 spec 名称、重新生成的目录、plugins README 行）。

## Alternatives considered

**用一个会话事件承载遥测。** 这些数据是对既有日志数据的派生读取，而非新的持久事实；新增一个 `SessionEventMap` 成员会为可从已记录内容重建的东西增加持久化与 UI 处理。

**在 apply 时注入 `sessions`/`subagents`。** 该工具在执行时通过 `exec.agent` 读取调用代理自身的会话，因此启动或服务该工具都不需要额外的服务注入。

## Consequences

模型可以查询自己的运行状态并据此行动。该读取是有界窗口上的快照，因此反映的是近期行为而非整个会话；窗口大小可按部署配置。由于每个数据都从持久日志派生，该工具没有自己需要保持一致的状态，除注册贡献外也没有需要清理的东西。
