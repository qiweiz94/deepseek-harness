# Agent Note: 工具结果截断按码点边界进行

Status: implemented

[English](2026-08-17-code-point-safe-truncation.md) | 中文

## 问题

按字符数上限截断工具结果时，代码使用 UTF-16 码元级操作（`String.prototype.slice`/`substring`）对已解码文本进行切片。当上限恰好落在增补平面码点（emoji、CJK 扩展字符）内部时，会在面向模型的文本中留下**孤立高位代理项**：

- `read` 行截断（`read-render.ts`）、`web_fetch` 源与输出上限（`tool-web`）、fetch provider 的 `maxBodyChars` 截断（`web-fetch-http`）、`str_replace`/持久化 bash 的查看器上限、历史推理上限（`llm-deepseek` 序列化）以及 `boundContextSummary` 都以码元为单位截断。
- 孤立代理项不是合法文本：`TextEncoder.encode` 会对其**抛错**，而 UTF-8 传输路径（会话日志、LLM 线上格式、`tool-jobs` 的任务输出测量）会静默地将其替换为 U+FFFD。`tool-jobs` 用 `TextEncoder` 测量任务输出字节数，因此上游截断产生的孤立代理项可能让后续调用直接崩溃。
- `read` 工具的流式行缓冲区以 `maxLineLength + 1` 个 UTF-16 码元为上限。emoji 密集的行因此大约在字符预算的一半处就停止累积——静默截断且不带 `(line truncated)` 后缀——而且码元级切片还可能拆开代理对。

另外，`agent-instructions` 的 `probeScopeInstruction` 重新实现了 `fsStatFile` 已有的 resolve→stat→classify 探测逻辑——同一份 provider 元数据语义的第三份拷贝，存在漂移风险。

## 决策

`@deepseek-ai/dsh-output-retention`（本就负责有界模型可见文本的库）导出两个纯函数：

- `codePointLength(value)`——Unicode 码点计数，绝不使用 UTF-16 码元。
- `truncateCodePoints(value, maxCodePoints)`——将字符串限制为至多 `maxCodePoints` 个码点；若截断落在增补平面码点内部，则丢弃整个码点，因此结果绝不会以未配对的代理项结尾。

所有工具结果或模型可见路径中的按字符截断都改用这两个函数：`read` 行截断、`web_fetch` 源/输出上限、fetch provider 正文上限、`str_replace` 与持久化 bash 输出上限、DeepSeek 历史推理上限、`boundContextSummary`。文档中表述为"字符"的上限现在按码点计数，与增补平面内容的语义一致。

`read` 流式行缓冲区按增补平面最大值设上限（`2 × (maxLineLength + 1)` 个码元——足以容纳 `maxLineLength + 1` 个完整码点），并在切片拆开代理对时回退一个码元，因此对增补平面行而言溢出检测依然精确，缓冲区也绝不会持有孤立高位代理项。

`probeScopeInstruction` 现在委托共享的 `fsStatFile` 探测并把 `present` 信息映射为作用域文件形态；基线发现与作用域对账在符号链接跟随、非文件缺失、provider 失败分类上不再可能漂移。

## 备选方案

- **在每个截断点内联代理项回退**——`py-types.ts` 的先例。会让该模式在 harness 中第三次重复，且没有一个共享、可单测的"字符上限保留什么"的契约。
- **把字符上限改成字节上限并统一走 `TextRetainer`**——会改变部署预算（`maxBodyChars`、`maxOutputChars`、`maxLineLength` 都以字符为文档与配置单位）；字节导向的 retainer 仍是进程/正文字节预算的权威，新函数只负责字符预算。
- **保留旧的行缓冲区上限、只修 `truncateLine`**——无法解决增广平面行的静默半预算预截断，且 `truncateLine` 看到行之前，码元级切片仍可能拆开代理对。

## 结果

- 增补平面内容在截断边界处按完整码点保留；这些路径上不再有孤立代理项进入模型可见文本。使用 `TextEncoder` 测量的消费方（`tool-jobs`、终端渲染）不再面临截断产生的孤立代理项风险。
- 字符上限对增补平面内容按码点而非 UTF-16 码元计数——与"字符"表述一致的小幅收紧；BMP 行为逐字节不变。
- 共享函数在 `output-retention` 中有单元测试；每个改造点都带有代理项边界回归测试（`read-render`、fetch provider、DeepSeek 序列化、上下文摘要）。`agent-instructions` 探测路径保持完整行为测试套件。
- 在把测试与 README 同步到工作区中 spill-policy 通知改写的同时，`tool-web` spill showcase 测试与 `spill-policy` README 已更新为指令式通知格式（`[Output Exceeded … chars - Full content written to <locator>]`）。
