# Agent Note：AgentOptions.reasoningEffort

Status: implemented

[English](2026-08-20-agent-options-reasoning-effort.md) | 中文

## 问题

`AgentOptions` 把 `maxTokens` 作为创建期默认值携带，却没有对应的 reasoning effort 字段。以非默认 effort（例如 `high`）运行的父级 agent 无法把它声明为自己第一次请求的默认值；而 subagent child 会继承父级的 provider／model／maxTokens，却从不继承其 reasoningEffort——被委派的 child 总是以适配器自身目录默认值启动，部署方也没有办法为委派工作固定按层级的默认 effort。

## 决定

新增 `AgentOptions.reasoningEffort?: ReasoningEffortId`（`packages/core/agent/src/runtime-types.ts`），沿着 `maxTokens` 已经走过的确切路径接入请求构建。`dsh-agent-loop` 的 `Agent.buildRequest` 在此变更之前就已经会从会话自身的请求 header 中恢复一个持久化、路由匹配的 reasoning effort；现在它只在没有这种持久化值适用时才回退到 `this.options.reasoningEffort`——因此一个新会话的第一次请求，或路由切换后尚无持久化值的任何请求，都会拾取 Agent 级别的默认值，而一次显式的逐轮 effort 变更或一次在线的 `installModelSelection` 选择（它本就把 `reasoningEffort` 作为自身选择类型的一部分）在持久化后依然优先。

`dsh-subagent` 的 `resolveChildAgentOptions`（`child-agent.ts`）以与继承 `maxTokens` 相同的方式继承父级当前的 `reasoningEffort`——展开在父级派生的默认值之后、单个 child 请求自身的 `agentOptions` 之前，因此显式的按 child 覆盖依然优先。`SubagentStartRequest.agentOptions` 本就是完整的 `AgentOptions` 接口类型，因此除了类型新增之外无需额外接线。

`dsh-tool-subagent` 的 `Config.agentOptions` schema（该模型可见工具按实例配置的 child 默认值）新增了对应的 `reasoningEffort: z.string()` 字段，并以 `dsh-agent-default-model` 的 settings schema 已经对自身 reasoning-effort 字段所用的方式转换为带品牌的 `ReasoningEffortId`——schemastery 没有通用的带品牌字符串构造器，这种转换是应对这一具体情形的既定模式。

持久化的 subagent 描述符有意排除 `reasoningEffort`，原因与它已经排除 `maxTokens`相同：两者都是按一次 activation 生效的旋钮，而非持久的 child 组成。cold resume 的可继续 child 不会恢复此前的 effort，也不会重新查询在线父级的当前值——它运行在被恢复路由自身的默认值之上，这是把既有行为对称地扩展到新字段，而非引入新的不对称。

## 考虑过的替代方案

- 使用不同于 `maxTokens` 命名模式的独立字段名（例如 `defaultReasoningEffort`）：因与一个语义完全相同（原本不存在才播种一次）的既有姊妹字段不对称而被拒绝。
- 把 `reasoningEffort` 也纳入持久化描述符以支持 cold resume：被拒绝——这会针对 `reasoningEffort` 特殊处理，却与 `maxTokens` 自身既有的排除方式相悖，且没有功能收益；cold resume 本就对每个按 activation 生效的旋钮采用被恢复路由自身的默认值。
- 在（或先于）核心 `AgentOptions` 字段之前，走 `plugin-subagent-router` 的按路由覆盖：本次变更的范围之外。该路由已经自带按路由的 `agentOptions`（`provider`／`model`／`maxTokens`，参见 [per-route-agent-options](2026-08-20-per-route-agent-options.md)），本次未触碰它。它的 `agentOptionsSchema`（`packages/plugins/plugin-subagent-router/src/index.ts:68-72`）尚未包含 `reasoningEffort`，因此即便类型现在已经支持，部署方仍无法在路由层通过 cordis.yml 设置它——这是一个后续的 schema 变更，不属于本次变更。

## 后果

- 以设置了 `AgentOptions.reasoningEffort` 创建的父级，会把该值播种进每一个尚无自身持久化、路由匹配 effort 的请求——一个新会话的第一次请求，或路由切换后尚无该新路由持久化值的任何后续请求。
- 未声明显式按 child `reasoningEffort` 覆盖而启动的 subagent child（one-shot 或 continuable）现在会继承其委派父级当前的 `reasoningEffort`，与既有的 `maxTokens` 继承规则完全一致。
- cold-resume 的可继续 child 不会恢复或继承任何 `reasoningEffort`——这是既有行为，现在以对两个按 activation 生效的旋钮对称的方式加以陈述。
- `packages/core/agent` 的 README／JSDoc、`dsh-subagent` 的 `child-agent.ts`／`descriptor.ts` JSDoc，以及生成的 `docs/subsystems/core.md`／`.zh.md` 的 type-equiv 代码块和 `packages/extensions/tool-cordis` 的 API 目录均已更新以记录新字段。
- 目前还没有 `plugin-subagent-router` 可从 cordis.yml 配置的按路由 reasoning effort 界面；该插件自身的 `agentOptionsSchema` 需要单独补上对应字段。

## 测试

`packages/core/agent-loop/tests/request-reconstruction.spec.ts` 针对真实的 `AgentLoop` 组合新增两个测试：一个证明在尚无持久化值时 `AgentOptions.reasoningEffort` 会到达适配器的第一次请求以及记录的 `request/header`（并优先于适配器自身的目录默认值）；另一个证明后续一次持久化、路由匹配的 effort 变更仍会在之后的轮次中覆盖 `AgentOptions` 默认值。`packages/subagent/subagent/tests/continuation-inheritance.spec.ts` 针对真实的可继续 child 组合新增三个测试：父级到 child 的继承、显式按 child 覆盖优先于继承，以及两者都未声明时 child 的 `reasoningEffort` 保持未设置这一缺省情形——这正是 `child-agent.ts` 既有的 `maxTokens` 那一行本就需要、却缺少独立覆盖的三种情形，因此新的 `parentReasoningEffort` 那一行从第一天起就达到了完整的分支覆盖。
