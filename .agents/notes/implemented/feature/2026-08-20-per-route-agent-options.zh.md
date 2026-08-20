# Agent Note：subagent 路由器的按路由 agentOptions

Status: implemented

[English](2026-08-20-per-route-agent-options.md) | 中文

## 问题

路由器的 `agentOptions` 是单一全局覆盖：无论委托命中哪条路由，子代理都得到同一份模型配置。套件的原始规格想要模型档位路由——规划类任务用推理模型、工人类任务用快速模型——而已上线的设计只能表达 provider 拆分，无法表达模型拆分。

## 决定

`RoutePolicy` 获得可选的 `agentOptions`（`provider`、`model`、`maxTokens`，与全局字段共享同一个 `agentOptionsSchema` 构造器）。解析规则镜像候选优先级：配置顺序中第一条声明了 `agentOptions` 的命中路由获胜；声明了但未命中或命中未声明的路由被跳过；没有命中路由声明时应用全局 `agentOptions`。[matchRouteAgentOptions](../../../../packages/plugins/plugin-subagent-router/src/resolver.ts) 与 `matchRouteCandidates` 通过私有生成器共享同一趟路由匹配，两条优先级规则不会漂移。无密钥路由器快照端到端钉住该行为：示例路由现在带 `maxTokens: 512`，回放子代理的持久 `request/header` 携带了它——组装应用级证明覆盖抵达了子代理的请求构造。

## 考虑过的替代方案

**路由选项与全局选项逐字段合并。** 半合并的子配置（路由的 model 叠在全局的 provider 上）比整对象优先级更难推理，也没有消费者需要它。

**最后一条命中路由获胜。** 候选展平让更早的路由靠前；给选项相反的优先级会让同一次委托的 provider 来自一条路由而 model 来自另一条，规则割裂。

## 后果

路由可以在不动 provider 的情况下把任务类别钉到模型档位。配置目录获得该字段；路由器 README 双语对记录了优先级。`reasoningEffort` 尚不属于 `AgentOptions`——那是独立的核心接缝改动；落地后按路由 effort 经由同一字段自然获得。
