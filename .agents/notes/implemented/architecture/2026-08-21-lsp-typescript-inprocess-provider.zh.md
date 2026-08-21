# Agent Note：进程内 TypeScript 导航是 lsp seam 的 Provider，而非新工具

Status: implemented

[English](2026-08-21-lsp-typescript-inprocess-provider.md) | 中文

## 问题

一个并行插件套件提出了 `plugin-lsp-references`：两个面向模型的工具（`find_references`、`get_definition`），后端是由 tsconfig 构建的进程内 TypeScript `LanguageService`。**引擎**是对的思路——内存中的 `LanguageService` 提供精确、类型感知的导航，无需启动或管理外部语言服务器——但**接线方式**错了。harness 已经发布了 `lsp` 能力 seam（`ctx.lsp`），包含 Service Definition（四个操作：`goToDefinition`／`findReferences`／`goToImplementation`／`hover`）、一个面向模型的 Consumer（`dsh-tool-lsp`，即 `lsp` 工具）以及一个 Provider（`dsh-lsp-stdio`，启动外部服务器）。再加两个工具会重复现有 Consumer，并把模型对同一能力的代码导航界面拆成两套词汇。

## 决策

将引擎作为现有 `lsp` seam 的 **Service Provider** 发布，放在新包 `@deepseek-ai/dsh-lsp-typescript-inprocess` 中，并**不**发布那两个工具。组合该 provider 会让已发布的 `lsp` 工具在 TypeScript 仓库中无需外部服务器即可回答全部四个操作。

- 本包在 `ctx.lsp` 上注册（`inject: ['lsp']`，`ctx.lsp.registerProvider`），不暴露任何工具。它是 TypeScript 的 Provider 角色；`dsh-tool-lsp` 仍是模型看到的唯一 Consumer。这遵循能力 seam 规则：一个 seam 由 Service Definition／Provider／Consumer 组成，新后端是 Provider，而非新 Consumer。
- 引擎以 **seam 原生** 方式编写。套件原始的 `ReferenceService` 返回一基行／字符的 `CodeLocation` 并附带源行预览——为它自己的两个工具而设计。seam 使用零基 UTF-16 位置与 `LspLocation` 区间（`{ uri, range: { start, end } }`），且其 Consumer 负责结果上限与预览。TypeScript `LanguageService` API 本身就是零基的（`getPositionOfLineAndCharacter`、`getLineAndCharacterOfPosition`），因此引擎无需坐标转换即可映射，保留每个 `textSpan` 的末端用于区间，并新增 `goToImplementation`（`getImplementationAtPosition`）与 `hover`（`getQuickInfoAtPosition`）——即 seam 所需而原始引擎缺少的两个操作。它保留原始的传递项目引用文件集遍历，这对 solution 式 tsconfig 至关重要。
- provider 适配器将查询文件相对请求的 `workspaceRoot` 解析，并把 `resolvedWorkspaceUri` 记为本进程对该根的规范 `file:` URI（seam 对相对化位置 URI 的调用方所定的约定），并通过编译期强制穷尽的 switch 分派四个操作。
- 配置只有一个字段 `tsconfigPath`，急切加载，因此坏配置在加载时明确失败。provider id 与 `.ts`／`.tsx`／`.mts`／`.cts` 映射是固定的、不可配置：seam 全局保留每个扩展名，因此至多一个 TypeScript provider 处于激活状态，且后缀集合是语言约定（外部规范），而非部署选择。

## 考虑过的替代方案

- **按提议发布那两个工具** — 拒绝：在第二个名字下重复 `lsp` 工具的操作，违反代码导航能力「模型只看到一个 Consumer」的原则，让模型面对两套重叠词汇去选择。
- **原封不动地在适配器后复用原始一基 `ReferenceService`** — 拒绝：seam 需要区间（起点*和*终点），而原始实现丢弃了它（只保留一个起点加一行预览），并且需要原始实现缺少的 `goToImplementation`／`hover`。把一基点经翻译层转成零基区间会引入一次零基 TypeScript API 本可省去的坐标往返；以 seam 自身坐标编写引擎更简单，并消除一类差一错误。
- **索引按查询变化的 `workspaceRoot` 而非配置的 tsconfig** — 本次变更拒绝：每次查询重建类型检查 program、或按会话 cwd 发现 tsconfig，既昂贵又未定义。一个配置项目加急切的明确失败加载匹配已发布的部署（固定仓库项目）；`workspaceRoot` 仅用于计算 `resolvedWorkspaceUri`。若有具体的多工作区消费者需要，可再引入按工作区发现。
- **同时映射 JavaScript 扩展名（`allowJs`）** — 暂缓：TypeScript `LanguageService` 可导航 JavaScript，但让为 TypeScript 项目配置的 provider 认领 `.js` 是一个需要自身测试的独立决策；在此之前映射仅限 TypeScript。

## 后果

- `plugin-lsp-references` 不予发布；其两个工具是被拒绝的接线方式。它从未合入 `master`，因此这是一份设计记录，而非删除。
- 组合了 `dsh-lsp` + `dsh-tool-lsp` 的部署，只需添加带 `tsconfigPath` 的 `dsh-lsp-typescript-inprocess` 即可获得 TypeScript 导航；不改动任何 tool-catalog 条目，因为本包不新增工具。`typescript` 是运行时 `dependency`（编译器在进程内运行），与套件其他进程内分析包一致。
- 一个真实的 Loader 组合测试从 `cordis.yml` 引导 `lsp` + 本 provider，并针对磁盘上的 TypeScript 夹具通过 `ctx.lsp` 驱动全部四个操作；一个释放测试证明 provider 在其 fiber 释放时注销。provider 是同进程类型化边界，因此源自模型工具参数的位置值（越界行、越过符号的列、项目之外的文件）返回无结果，而非抛出。
