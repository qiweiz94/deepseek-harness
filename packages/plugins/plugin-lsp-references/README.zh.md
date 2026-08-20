# @deepseek-ai/dsh-plugin-lsp-references

[English](README.md) | 中文

面向模型的 `find_references` 与 `get_definition` 工具：在整个多项目工作区上进行精确的 TypeScript 符号导航，使模型能够找到某个符号的每一处调用方，或其确切的声明锚点，而不必从文本匹配中猜测。

## 功能

在 `ctx.tools` 上注册两个工具，二者由同一个进程内 TypeScript `LanguageService` 应答：

- `find_references(path, line, character)` 返回 `{ path, line, character, references, total, truncated }`，其中 `references` 的每一项都是 `{ path, line, character, text }` 位置——文件、从 1 开始的光标坐标，以及该位置所在行去除首尾空白后的源码文本。整个项目文件集内的每一处引用都会被报告，包括调用方、导入方以及符号自身的声明（即语言服务器协议 `findReferences` 的约定）。位置按文件、行、列排序。
- `get_definition(path, line, character)` 返回 `{ path, line, character, definitions }`，位置项的结构相同。重载函数或合并接口本就可以声明多个锚点，因此 `definitions` 是列表而非单个值。

坐标为从 1 开始的行与从 1 开始的 UTF-16 字符，与同类的 [`lsp`](../../lsp/tool-lsp/README.md) 工具的光标约定一致。超出行尾的列会被截断到行尾；未指向任何符号的位置返回空结果——光标不在符号上是一种答案，而非失败。超出文件的行号、小于 1 的列号，以及不在项目文件集内的文件，都会返回指明所越限制的错误结果。

## 项目文件集

可导航的工作区是单个根 tsconfig（`tsconfigPath`，默认 `tsconfig.host.json`，相对进程工作目录解析）的传递闭包：它自身的 `fileNames`，加上通过 `references` 可达的每个文件，遍历至不动点，因此引用图中的菱形结构只解析一次。

正是这种传递性让这两个工具在本仓库中如实可用。`tsconfig.host.json` 只包含测试、脚本与站点源码，全部 190 个包的源码仅通过 `references` 可达；若宿主只基于它自身的 `fileNames` 构建，则对包源码目录中声明的每个符号都会答复“无引用”。

语言服务在**首次调用**时构建，而非加载时：解析引用图并读取其源码是实打实的开销，从不导航的启动不应为此付费。宿主是静态的——每个文件只读取一次且不监听变更——因此一个实例只对应一个时间点的快照，并随 fiber 释放而销毁。

## 导出形态

函数／命名空间插件：导出 `name`／`inject`／`Config`／`apply` 且**不**导出 default。多余的 `export default` 会被 Loader 的 `unwrapExports` 折叠并丢弃 `inject`（参见 [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)）。

## 模型体验

### 工具 schema

#### 模型看到的内容

模型在[工具目录](../../../docs/tool-catalog.md)中看到两个生成的 schema：各有三个必填参数（`path` 字符串、`line` 整数、`character` 整数）以及结构化结果——`find_references` 为 `references` 加上 `total`／`truncated` 这一对字段，`get_definition` 为 `definitions`。插件配置（`tsconfigPath` 默认 `tsconfig.host.json`、`maxReferences` 默认 200、`maxLineChars` 默认 200）在加载时校验，非法值快速失败；它不改变任何 schema 字段，只决定调用是成功解析还是返回指引性的错误结果。

#### Token 影响

工具可见的每个请求都有固定的 schema 成本。调用结果随找到的引用数量增长，并受 `maxReferences` 约束；每个位置的开销为一个路径、一个坐标，以及至多 `maxLineChars` 个字符的源码行。被截断的结果会说明省略了多少条引用，使模型不会把受限列表当作完整列表。

#### KV Cache 影响

在定义与可见性不变的情况下前缀稳定。插件生命周期或作用域限制可能使这些 schema 的复用失效；语言服务的 program 在调用内部构建，不会进入请求前缀。

## 已知限制与暂缓事项

- **仅限 TypeScript** —— 引擎是 TypeScript 自带的 `LanguageService`，因此即便某语言存在真实的语言服务器，其符号在此也无法导航。通用的、由服务器支撑的场景由 [`lsp`](../../lsp/tool-lsp/README.md) 工具覆盖。
- **只对应一个时间点** —— 宿主不监听文件系统，每个文件只保留一个快照版本。首次调用之后被编辑的文件，仍按服务读到的文本作答；要纳入编辑必须重新挂载该组合。
- **首次调用为整个项目付费** —— 在大型引用图上构建 program 是这两个工具的主要开销，且落在恰好最先发生的那次调用上。
- **仅限项目文件集** —— 根 tsconfig 无论直接还是经由 `references` 都无法到达的文件，既不能被查询，也不会出现在结果中。
- **不提供实现查询与类型层次查询** —— `goToImplementation`、`hover` 与重命名预览不在此处的范围内；`find_references` 只在实现确实引用了该符号时才会报告它。
- **按条数而非字节保留** —— `maxReferences` 约束位置列表，`maxLineChars` 约束每条预览，因此结果总大小由二者之积界定，而非由字节预算界定。
