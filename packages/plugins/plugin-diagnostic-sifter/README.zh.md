# @deepseek-ai/dsh-plugin-diagnostic-sifter

[English](README.md) | 中文

面向模型的 `run_diagnostic_check` 工具：运行项目自己的类型检查或测试二进制，把一个缺陷在代码库中扇出的诊断折叠回造成它们的那一条，返回紧凑的 JSON 结果，而不是完整的编译器或测试运行器输出。

## 功能

在 `ctx.tools` 上注册一个工具：

- `run_diagnostic_check(command, targetPath?)` 启动 `command` 所配置的可执行文件（`typecheck` → `node_modules/.bin/tsc -b`，`test` → `node_modules/.bin/vitest run`），可用 `targetPath` 收窄范围，返回 `{ success, rootCauses, suppressedCascadeCount }`。

每条根因携带 `file`、`line`、`code` 与 `message`。只有命令以 0 退出且未解析出任何诊断时 `success` 才为真。若非零退出但没有匹配到任何诊断模式，仍会返回一条编码为 `nonzero-exit` 的根因，携带输出中第一行非空文本——失败绝不会以空列表返回。

## 级联折叠

一个缺陷会在每个受影响的位置各产生一条诊断：无法解析的模块会在每个 import 处被报告，被改名的导出会在每个使用处被报告。这些重复是级联，不是原因。

- 代码与文本完全相同的诊断折叠到其首次出现处。
- 模块解析与导出形态类代码（`TS2307`、`TS2305`、`TS2503`、`TS2614`、`TS2688`、`TS2724`）按代码加消息中第一段引号内的主体折叠，因为结尾的 "Did you mean" 提示逐处不同，而原因相同。
- 分组按其波及的位置数排序，重复最多的原因排在最前；并列时保持输出顺序。`maxRootCauses`（默认 3）限定报告条数。

`suppressedCascadeCount` 是所有未被列出的已解析诊断：被折叠的重复，加上排名低于上限的分组。它统计的是模型看不到的部分，绝不表示"上游数据不完整"。

对 `test`，通过的用例与进度行不会匹配任何失败模式而被丢弃，每个失败只保留第一个属于本仓库的栈帧：位于 `node_modules` 或 `node:` 下的帧定位的是测试运行器，不是缺陷。

## 输出保留包络

两个子进程流都通过 `@deepseek-ai/dsh-output-retention` 的 `TextRetainer`（`head` 策略）在 `maxOutputBytes`（默认 15 KB）处捕获，因此即使编译器或运行器输出数 MB，内存中也不会超过包络大小，而保留下来的头部正是诊断所在之处。

返回值随后被限制在 `maxResultBytes`（默认 1,000 字节，不足 1 KB）：消息按 Unicode 码点沿固定阶梯截断，只有在仍不够时才把排名最低的根因丢入 `suppressedCascadeCount`。

## 进程模型

每个子进程都经由 `ctx.subprocess`，因此进程启动、流收集与按进程树终止都留在 subprocess seam 中；插件只负责编排、解析与排序。配置为相对路径的可执行文件在启动前会锚定到 `cwd`，因为 Node 按父进程而非子进程的工作目录解析相对可执行路径；裸命令名则原样保留，交由子进程的 `PATH` 解析。`timeoutMs`（默认 5 分钟）会中止整棵进程树，模型给出的 `targetPath` 始终作为独立的 argv 项传入——不经过任何 shell 解释。

## 导出形式

函数/命名空间插件：导出 `name` / `inject` / `Config` / `apply`，且没有默认导出。多余的 `export default` 会让 Loader 的 `unwrapExports` 折叠该模块并丢掉 `inject`（见 [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)）。

## Model Experience

### Tool schema

#### What the model sees

模型看到生成的 [`run_diagnostic_check` schema](../../../docs/tool-catalog.md#deepseek-aidsh-plugin-diagnostic-sifter)：必填的 `command` 枚举（`typecheck` 或 `test`）与可选的 `targetPath` 字符串。每个命令运行哪个二进制、保留包络、结果预算、根因上限与超时都是加载时校验的插件配置；它们不改动任何 schema 字段，只决定检查执行什么、返回多少。

#### Token effect

工具可见时每次请求都有固定的 schema 开销。结果受 `maxResultBytes` 限制，因此整仓构建失败与单文件失败对模型的 token 量级相同——相对于阅读原始输出的节省随失败规模增长。

#### KV Cache effect

定义与可见性不变时前缀稳定。插件生命周期或作用域限制可能使基于该 schema 的复用失效；检查本身发生在调用内部，绝不进入请求前缀。

## Known Limitations and Deferred Work

- **只识别两种输出方言** —— 解析器识别 `tsc`（普通与 `--pretty`）以及 Vitest 默认 reporter。换用其他编译器、其他运行器或 JSON/JUnit reporter 会解析出零条诊断，失败的运行退化为单条 `nonzero-exit` 根因，而非具名根因。
- **级联分组是启发式的** —— 两个确实独立、却产生逐字节相同诊断的缺陷，或同一级联代码针对同一引号主体的两处无关失败，会算作一条根因而其余被抑制。计数始终说明被压下了多少条。
- **每条诊断只取首行** —— 相关信息行、源码摘录与断言 diff 被丢弃，因此含义依赖摘录的根因会比原始输出更单薄。
- **仅前台执行** —— 一次检查会占用该工具调用直到结束或 `timeoutMs` 到期；没有后台/作业模式，超时的运行只报告其部分输出解析出的内容。
- **不自带增量状态** —— `tsc -b` 的 build info 与运行器缓存以仓库现有状态为准；本工具既不预热也不失效它们，因此干净检出后的首次调用需付出完整构建代价。
- **仅限本地进程** —— 检查在 harness 所在处运行；没有远程或容器化执行模式。
