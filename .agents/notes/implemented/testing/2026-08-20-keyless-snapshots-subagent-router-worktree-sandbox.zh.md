# Agent Note：subagent-router 与 worktree-sandbox 的无密钥快照

Status: implemented

[English](2026-08-20-keyless-snapshots-subagent-router-worktree-sandbox.md) | 中文

## 问题

2026-08-19 的审计将 `plugin-subagent-router` 与 `plugin-worktree-sandbox` 的无密钥快照覆盖推迟到"harness 支持这些插件组合的无密钥回放"之时。该前提已过时：`llm-replay` 支持手写 override 边车与子会话回放文件，`loader-smoke` 暴露 `prepare` 钩子用于运行时夹具，而 `subagent-inheritance` 场景已经无密钥地启动了完整 subagent 栈。同时录制 key 已作废，任何需要真实重录的设计都不可行。另外，已提交的 `ast-context` 金样早于 `meta.outline` 特性（4b2a0c1fd5），在所有平台上回放失败——该失败曾被误归为 CI issue 中的 Linux 特有问题。

## 决定

`examples/headless-agent` 中两个独立场景，全部手写（任何环节都不需要 API key）：

[subagent-router](../../../../examples/headless-agent/subagent-router.cordis.snapshot.yml) 挂载 spawn 与 fork 两个进程内 provider；router 的默认候选只有 `fork`，唯一路由（`label: trial probe`）只有 `spawn`，回放的委派命中该路由——因此子会话持久 `subagent/descriptor` 中的 `spawn` 是"路由策略而非默认列表选中了 provider"的物理证据。父脚本是 `replay.override.json` 边车；子会话使用合成 `child.replay.jsonl`（`createdAt: 2` 按首调顺序绑定）。router 自己注册 `subagent` 工具，故 `dsh-tool-subagent` 不进入该组合。

[worktree-sandbox](../../../../examples/headless-agent/worktree-sandbox.cordis.snapshot.yml) 在测试 `prepare` 钩子中于运行 cwd 准备真实 git 仓库，回放一次带显式 `id` 的 `sandbox_exec`（`randomUUID().slice(0, 8)` 回退不是可规范化的 token），并物理断言隔离性：工具结果报告了写入而主工作树从未获得该文件、试验 worktree 已被移除。win32 上跳过（需要宿主 git 与 `sh -c`）。

过时的 `ast-context` 金样在同一变更中经无密钥 refresh 流程重录；唯一实质差异是该特性新增的 `meta.outline` 载荷。

## 考虑过的替代方案

**单一组合场景（router 委派一次沙箱试验）。** 沙箱工具不需要 subagent 栈；合并将其调用强行经过手写子脚本，不增加证据却耦合两个失败域。

**真实录制场景。** 需要新 API key，而回放夹具可以精确表达该行为；key 已作废使其不可行，且手写路径是更强的先例。

**路由到 `fork` 而非 `spawn`。** fork 子会话携带 seed-length 头部契约，手写夹具脆弱；路由到 `spawn` 保持夹具简单，同时仍证明"路由优先于默认"。

## 后果

两个插件现在都有组装应用级的无密钥证据，审计项 E 关闭。快照套件增长到 15 个文件；`examples/package.json` 声明了两个插件包。`ast-context` 项从 Linux 回放 issue 中消失，该 issue 缩小为 pwsh 头部与 minimal-preset 快照两案。将来任何改变 router 工具 schema 或沙箱结果面的变更都必须经 `test:snapshot:refresh` 重录这些金样。
