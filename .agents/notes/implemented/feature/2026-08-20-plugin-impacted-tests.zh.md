# Agent Note：受影响测试选择器插件

Status: implemented

[English](2026-08-20-plugin-impacted-tests.md) | 中文

## Problem

编辑源码后，要知道改动是否破坏了什么，只有两条路：跑整个测试套件（慢——13000+ 个测试），或者猜哪些套件相关。模型没有廉价、精准的判定：它要么为全量运行付费，要么跳过测试碰运气。做得更好所需的信息本已存在——工作区的导入图恰好能告诉你哪些套件传递地导入了某个改动文件——但没有任何环节把它作为工具暴露出来。

## Decision

`@deepseek-ai/dsh-plugin-impacted-tests` 注册 `run_impacted_tests({ files? })`。它从 tsconfig `paths` 构建仓库的导入图，找出传递地导入了改动集中任一文件的每个测试套件（给定 `files`，或省略时取工作树未提交的改动），并严格只经配置的运行器运行这些套件，返回有界的运行输出。没有任何套件导入的改动文件（例如一个 Markdown 文档）什么都不选——这就是答案，而非失败。它注入 `tools` 与 `subprocess`；套件路径来自分析器，绝非原始模型输入，运行器 argv 也绝不经 shell 解释。

集成修复：并行分支把 `runnerCommand` 默认为 `['pnpm', 'exec', 'vitest', 'run']`，但 `pnpm exec` 在本仓库被 keel 阻断（no-remote-exec）。默认改为 `['node', 'node_modules/vitest/vitest.mjs', 'run']`，即本仓库其余部分带外运行 vitest 所用的同一个 keel 安全调用。该插件到来时没有 Agent Note；本笔记在集成时补齐。

## Alternatives considered

**按路径启发式（同目录、同包）选套件。** 一个文件的影响半径经由导入跨越包边界；目录启发式既漏掉跨包影响，又过度选中无关的同级。导入图才是精确答案。

**默认用 `pnpm exec vitest`。** 方便，但 keel 的 no-remote-exec 规则在本仓库阻断它；`node node_modules/vitest/vitest.mjs` 形式才是这里真正能跑的调用，且它仍是配置字段，不同部署可以覆盖。

## Consequences

模型以全量运行的一小部分代价，获得范围收窄到改动真正可能破坏之处的快速、精准测试判定——未受影响的改动返回一行。选择的准确度仅取决于 tsconfig 所描述的导入图；在 `paths` 解析之外表达的依赖不可见。运行器输出按每流 `maxOutputBytes` 有界。
