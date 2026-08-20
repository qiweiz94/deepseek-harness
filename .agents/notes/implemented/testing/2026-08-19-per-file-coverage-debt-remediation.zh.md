# Agent Note：逐文件覆盖率欠账清偿

Status: implemented

[English](2026-08-19-per-file-coverage-debt-remediation.md) | 中文

## 问题

该 fork 在没有任何已执行 CI 的情况下合并了数周的工作：上游 `ci.yml` 在个人 fork 上无法启动，而 fork 托管的工作流随 fork CI 变更才出现。在这段窗口内，逐文件 100% 覆盖率门禁（`pnpm run test:coverage`）在七个包的十一个 `src` 文件上变红——121 个未覆盖位置，其中 72 个位于两个被审计的插件（`plugin-worktree-sandbox`、`plugin-subagent-router`），其余由 2026-08-17 的 token 优化合并和 2026-08-19 的 lint 修复引入。红着的覆盖率通道会让新 fork CI 的证据从第一天起就一文不值。

## 决定

每个可达的未覆盖分支都在其包的现有测试套件中获得行为测试；每个确实不可达的守卫改以带理由的 `v8 ignore` 注解标记，而非合成测试。按文件划分：

- `plugin-worktree-sandbox`：伪 git 垫片（[sandbox.spec.ts](../../../../packages/plugins/plugin-worktree-sandbox/tests/sandbox.spec.ts) 中的 `fakeGit`）驱动 add 竞争的复用与重抛路径、trial-head 与移除失败（stderr 与仅 stdout 两种变体）、清理注记与 AggregateError 路径、渲染的复数/流/截断分支；绕过 loader 的 `apply` 覆盖文档化的配置回退。注解为不可达：有界捕获存在性守卫、`pop()` 类型守卫、非 Error 主错误包装、以及 result/primaryError 穷尽性守卫。
- `plugin-subagent-router`：空 `toolFilter` 加载失败、loader 之外的默认工具名、经 `executionMode` 的并行安全分类、将全部委派选项转发进启动请求、无 persona 的能力缺口列举、以及无 `routes` 键的路由匹配。
- `compaction-basic`：turn-end 压力接线测试——无 agent 注册表、无路由与无上下文窗口的会话、warn-once 误配置路径（零上下文窗口）加 Error 与非 Error 的度量失败、无待处理项的 idle 转换、维护期复查、以及按目标的 `triggerTokens`/`targetResidualTokens` 覆写。
- `agent-instructions`：拆分文本块的待处理更新证明基于摘要的复用；渲染文本摘要回退本身注解为无法确定性到达（compose 的作用域调和会在比较之前去重任何同一身份的渲染）。
- `goal-round-driver`：已接纳轮次不匹配测试；两个算术上不可达的截断分支加注解。
- `tool-fs`：一行星体字符，UTF-16 长度触发上限而码点数量合规。
- `plugin-ast-context`：单数与零跳过注记的渲染、绕过 loader 的 `maxFiles` 默认值、以及 pop 守卫与轮廓中途中止重抛的注解。

## 考虑过的替代方案

**让 fork CI 带着红色覆盖率通道上线并开 issue。** 该通道的红色会成为永久背景噪音，而预期会失败的门禁是没人读的警报。

**在清偿前把覆盖率作业设为非阻断。** 无法失败的控制保护不了任何东西；把它改回来的那一步正是会被遗忘的一步。

**对失败区域整体 `v8 ignore`。** 121 个位置中的大多数是可达行为（失败上报、渲染、路由选项），这次测试虽未发现缺陷，但现在钉住了契约；注解只保留给任何组合路径都无法到达的守卫，且各自附带理由。

## 后果

`pnpm run test:coverage` 重新在全仓库通过逐文件 100%，fork CI 覆盖率通道从首次运行起就有意义。伪 git 垫片为 sandbox 插件提供了可复用的 git 失败测试模式。被注解的守卫如今是关于可达性的断言——若重构使某个守卫变得可达，注解必须随之删除。
