# Agent Note：Worktree 沙箱插件

状态：已实现

[English](2026-08-19-worktree-sandbox-plugin.md) | 中文

## 问题

试运行（trial）的子代理没有安全的地方做实验：它运行的任何命令都可能改动主工作树与当前分支，被丢弃的试运行还会留下部分改动。此外，harness 缺少面向模型的、结构化的、有界的 git diff 接口来查看可丢弃的实验改动，因此审查试运行需要在真实工作树上手动 diff。

## 决策

**新增面向模型的插件 `@deepseek-ai/dsh-plugin-worktree-sandbox`，注册一个 `sandbox_exec` 工具**，在隔离的 git worktree 中运行命令。worktree 通过 `git worktree add --detach` 从配置的基准 ref（默认 `HEAD`）在 `<cwd>/.dsh/worktrees/subagent-<id>` 创建，与仓库共享对象库，但拥有独立的工作树与索引。`id` 在任何 worktree 操作前按 `[a-zA-Z0-9_-]`（最多 64 位）校验，因此模型提供的 id 无法越出试用根目录。

**试运行是可丢弃的。** 默认在调用后以 `git worktree remove --force` 移除 worktree，丢弃试运行的未提交改动；主工作树与分支永不被触碰。`cleanup: false` 会保留 worktree，使后续使用相同 `id` 的调用继续同一试运行，diff 会累积。

**结果是结构化且有界的。** 工具返回 `exitCode`/`signal`、有界的 `stdout`/`stderr`（子进程收集，tail 保留）、试运行的 `git diff`/`git diff --stat`，以及来自 `git status --porcelain` 的 `changedFiles`。diff 与 stat 经过 `@deepseek-ai/dsh-output-retention` 的 `TextRetainer`（`head` 策略）并以 `maxOutputBytes`（默认 15 KB）为界，因此返回的 diff 保留其头部并带精确的省略元数据。

**所有进程都经过 `ctx.subprocess`。** git 与 `sh -c` 命令都通过子进程接缝 spawn，插件只负责编排与报告；命令默认、流收集与树级终止都留在接缝中。

## 备选方案

**在主工作树上运行试运行并加自动提交/回滚包装。** 已否决：任何失败路径都会危及真实工作树与分支状态，且没有干净的 diff 边界。

**把仓库复制到系统临时目录。** 已否决：复制会破坏 git 对象库与远程/子分支语义，并重复复制大型历史；git worktree 以近零成本共享对象库。

**git stash save/pop 包装。** 已否决：stash 对仓库是全局的，跨试运行干扰与失败路径恢复都很脆弱。

## 后果

加载该插件的组合会暴露一个 `sandbox_exec` 动词，其试运行在可丢弃的 detached worktree 中执行，并返回有界的结构化 diff 与退出状态。误配置（`cwd` 不是 git 仓库、非正的 `maxOutputBytes`）在加载或 `git rev-parse` 处大声失败。工具并发安全，因为每次试运行都拥有独立的 worktree 与进程树。v1 仅前台；后台/任务试运行、远程/共享克隆，以及把 diff 自动应用到真实工作树仍待后续。
