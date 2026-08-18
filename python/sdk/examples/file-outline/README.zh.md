# 文件大纲示例

[English](https://github.com/deepseek-ai/deepseek-harness/blob/master/python/sdk/examples/file-outline/README.md) | 中文

本示例通过 Python SDK 驱动真实的 [`get_file_outline`](../../../packages/plugins/plugin-ast-context/README.md) 工具。模型端点是一个无需密钥的本地 mock：它的第一次补全以 `tool_calls` delta 应答，要求 agent 为仓库中的某个文件生成大纲；第二次以纯文本应答。工具本身在运行时进程内真实执行，因此 `tool/result` 事件中的大纲是针对所请求文件的真实 tree-sitter 输出——不需要 API 密钥，也不需要构建。

## 运行

```sh
uv sync --project python/sdk --group test
uv run --project python/sdk -- python python/sdk/examples/file-outline/outline.py
```

需要在仓库根目录执行过 `pnpm install`（示例通过 `tsx` 启动仓库源码的运行时 bin）。脚本会打印会话根目录、mock 端点、提供给模型的服务清单以及捕获到的 `tool/result` 事件，并断言：

- 模型被提供了 `get_file_outline`；
- 恰好发出一个 `tool/result` 事件；
- 大纲载荷包含来自 `packages/plugins/plugin-ast-context/src/extractor.ts` 的真实符号 `AstSymbolExtractor`。

同一流程由 pytest 收集的 `tests/test_file_outline_example.py` 覆盖。

## 组合

`cordis.yml` 是 SDK 内置的默认组合（stdio JSON-RPC 服务端、agent 主干、DeepSeek 适配器、JSONL 会话持久化、检查点策略、本地 bash、fs-local）外加一个条目：

- `plugin-ast-context` 将面向模型的 `get_file_outline` 工具注册到 agent 的工具注册表中。

## mock 的工作方式

1. 第一次模型请求——mock 以流式 `tool_calls` delta 应答 `get_file_outline`，参数为 `{"path": "packages/plugins/plugin-ast-context/src/extractor.ts"}`，并以 `finish_reason: "tool_calls"` 结束。
2. agent 在本地执行该工具（读取文件、用与扩展名匹配的 tree-sitter 语法解析、渲染大纲），并发出 `tool/call` 与 `tool/result` 事件。
3. 第二次模型请求（此时工具结果已进入消息历史）——mock 以纯文本应答，并以 `finish_reason: "stop"` 结束。

将 `DEEPSEEK_BASE_URL` 指向任意 OpenAI 兼容端点并去掉 mock，即可用同一脚本对接真实模型。