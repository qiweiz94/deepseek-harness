# @deepseek-ai/dsh-lsp-typescript-inprocess

[English](README.md) | 中文

`ctx.lsp` 的**进程内 TypeScript 后端**。一个插件实例在配置的 tsconfig 文件集之上构建一个内存中的 TypeScript `LanguageService`，并注册单个 provider，为 `.ts`/`.tsx`/`.mts`/`.cts` 文件回答该 seam 的四个操作——`goToDefinition`、`findReferences`、`goToImplementation`、`hover`。没有需要启动、安装或管理的语言服务器：编译器就在 harness 进程内运行。

命名空间插件（`name` / `inject` / `Config` / `apply`，无默认导出）。

## 为什么是 provider，而非 tool

本包**不注册任何面向模型的工具**。代码导航通过唯一的 Consumer——即已发布的 `lsp` 工具（`dsh-tool-lsp`）——到达模型；若某个 provider 增加自己的 `find_references`／`get_definition` 工具，就会重复该 Consumer，并把模型的导航界面拆成两套词汇。一个能力 seam 由 Service Definition、Service Provider 与 Consumer 三个角色组成——本包是 TypeScript 的 Provider 角色，因此组合它会让现有 `lsp` 工具在 TypeScript 仓库中无需外部服务器即可工作，而不是引入第二个工具。

## 它做什么

- 在挂载时急切加载配置的 tsconfig，因此缺失或不可读的配置会在加载时明确失败；昂贵的类型检查 program 在首次查询时惰性构建。
- 索引**传递**文件集：根配置自身的文件，加上通过 `references` 可达的每个文件。一个仅列出少数根、通过项目引用才能到达各包源文件的 solution 式 tsconfig 也可完全导航；仅基于其自身 `fileNames` 构建的引擎会对被引用项目中声明的符号回答「无引用」。
- 直接以 seam 的坐标回答每个操作：输入为零基 UTF-16 位置，输出为带零基半开区间的 `file:` URI。`findReferences` 包含符号自身的声明。`hover` 返回 TypeScript 的 quick-info 签名，存在文档时附带其文档。
- 将查询文件相对请求的 `workspaceRoot` 解析，并把 `resolvedWorkspaceUri` 记为本进程对该根的规范 `file:` URI，因此工具会相对一个在执行平台上计算的根来相对化位置 URI。
- 每个源文件只读取一次，存入无版本快照，且从不 watch：一个引擎回答某一时间点的查询。插件在其 fiber 释放时释放 language service（及其 program 与文档缓存）。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `tsconfigPath` | （必填） | 其传递文件集定义可导航 TypeScript 工作区的根 tsconfig。绝对路径，或相对进程启动 cwd。 |

请将 `tsconfigPath` 指向**会话工作区内**的一个项目：provider 只导航该项目所编译的文件。对项目文件集之外文件的查询会返回无结果（空 location，或 `null` hover），而非错误——与越过符号的位置得到相同的答案。越过文件末尾的位置也同样处理，因为位置源自模型工具参数。

provider id（`typescript-inprocess`）与 TypeScript 扩展名映射是固定的，不可配置：seam 全局保留每个扩展名，因此至多一个 TypeScript provider 处于激活状态，且其文件后缀是语言约定，而非部署选择。

## 模型体验

间接地，通过 `dsh-tool-lsp`，由它呈现本 provider 归一化后的结果；本后端自身不贡献任何提示词或 schema。

#### KV Cache 影响

自身没有。它回答一个只读查询，向 seam 返回归一化的 location 或 hover 文本；只有 `lsp` 工具渲染出的结果对模型可见，且仅在模型调用该工具时。

## 已知限制与暂缓事项

- **仅 TypeScript** — `.js`／`.jsx`／`.mjs`／`.cjs` 有意排除在扩展名映射之外。TypeScript `LanguageService` 可在 `allowJs` 下导航 JavaScript，但那会让为 TypeScript 项目配置的 provider 认领 JavaScript 文件；JavaScript 映射暂缓为一个带自身测试的明确决策。
- **单一时间点快照** — 主机每个文件只读取一次，只保留一个版本，且从不 watch。引擎构建之后的编辑在 fiber 释放并重新组合之前不可见；本后端适合面向稳定树的只读导航，而非实时编辑会话。
- **单个配置项目** — 一个实例导航一个 tsconfig 的传递文件集。该集合之外的文件在此不可导航，且查询携带的 `workspaceRoot` 仅用于计算 `resolvedWorkspaceUri`，不用于发现或索引按查询变化的项目。
- **路径匹配不解析符号链接** — 查询文件与项目文件名在 `resolve()` 之后比较，不做 `realpath`，因此若某部署的会话 cwd 与 tsconfig 通过不同的符号链接路径到达相同文件，必须保持二者一致。
