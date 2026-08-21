# Agent Note：模块边界守卫插件

Status: implemented

[English](2026-08-20-plugin-arch-guard.md) | 中文

## Problem

本 monorepo 的包分层规则——架构层级方向（基础 < 能力 < 表层/插件）、"插件之间未声明不得互相导入"规则、包图无环性，以及每个包的 exports 映射——目前只由 `packages/AGENTS.md` 中 `check_module_boundary` 形态的约定强制，以及事后由人工评审与 CI 的依赖门禁把关。模型在写一条新的跨包导入时，无法在写之前检查该导入是否合法；它只有在稍后某个门禁失败时才发现违规。

## Decision

`@deepseek-ai/dsh-plugin-arch-guard` 注册一个只读的、面向模型的工具 `check_module_boundary({ sourcePath, targetImport })`，回答从 `sourcePath` 导入 `targetImport` 在上述四条规则下是否合法，并在被阻止时给出规则名称与建议。工作区包图在挂载时从 `config.root`（默认进程 cwd）扫描一次，而非每次调用重读。它只注入 `tools`，不写入任何会话事件，从不写。

该插件从并行分支（`feat/plugin-arch-guard`）到来时没有 Agent Note；本笔记在集成时补齐，插件已在当前 master 上以标准集成接线重建。

## Alternatives considered

**每次调用重新扫描图。** 包图只在新增包或编辑其依赖时才变化——相对导入检查而言很罕见——因此挂载时扫描以一个小的陈旧窗口（会话中途新增的包在重新挂载前不可见）换取不必每次调用都重走一遍树。

**一个在写入时阻断的工具，直接改导入。** 该守卫按设计是建议性的：它回答模型在写之前提出的问题，把写入本身留给普通编辑工具，在其自身的权限与沙箱策略下进行。写入期的强制属于 fs/CI 层，而非只读顾问。

## Consequences

模型可以在写一条跨包导入之前验证它，把事后的 CI 失败变成写前的回答。该裁决反映挂载时的图状态，因此同一会话中稍后新增的包在插件重新挂载前不可见。该工具除注册贡献与缓存的图之外没有其他状态。
