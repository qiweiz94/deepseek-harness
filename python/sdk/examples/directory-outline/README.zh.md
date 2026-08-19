# 目录大纲示例

[English](https://github.com/deepseek-ai/deepseek-harness/blob/master/python/sdk/examples/directory-outline/README.md) | 中文

本示例通过 Python SDK 驱动真实的 [`get_directory_outline`](../../../packages/plugins/plugin-ast-context/README.md) 工具。模型端点是一个无密钥的本地 mock：第一次补全返回一个 `tool_calls` delta，要求 agent 对仓库目录生成大纲；第二次补全返回纯文本。工具本身在运行时进程中真实执行，因此 `tool/result` 事件中的大纲是针对请求目录的真实 tree-sitter 输出——无需 API 密钥，无需构建。

## 运行方式

```sh
uv sync --project python/sdk --group test
uv run --project python/sdk -- python python/sdk/examples/directory-outline/outline.py
```

需要在仓库根目录执行 `pnpm install`（示例通过 `tsx` 启动仓库源码的运行时 bin）。脚本会打印会话根目录、mock 端点、提供给模型的工具列表以及捕获的 `tool/result` 事件，然后断言：

- 模型被提供了 `get_directory_outline`；
- 恰好发出一个 `tool/result` 事件；
- 大纲 payload 包含来自 `packages/plugins/plugin-ast-context/src/extractor.ts` 的真实符号 `AstSymbolExtractor`。

同样的流程由已收集的 `tests/test_directory_outline_example.py` 覆盖。

## 组合配置

`cordis.yml` 是 SDK 的默认组合（stdio JSON-RPC 服务器、agent 主干、DeepSeek 适配器、JSONL 会话持久化、检查点策略、本地 bash、fs-local）加上一项：

- `plugin-ast-context` 将模型可见的 `get_directory_outline` 工具注册到 agent 的工具注册表中。

## mock 的工作方式

1. 第一次模型请求——mock 返回一个流式 `tool_calls` delta，调用 `get_directory_outline`，参数为 `{"path": "packages/plugins/plugin-ast-context/src"}`，`finish_reason: "tool_calls"`。
2. Agent 在本地执行工具（遍历目录，使用与扩展名匹配的 tree-sitter 语法解析每个 `.ts`/`.tsx` 文件，渲染大纲），并发出 `tool/call` 和 `tool/result` 事件。
3. 第二次模型请求（工具结果已在消息历史中）——mock 返回纯文本，`finish_reason: "stop"`。

将 `DEEPSEEK_BASE_URL` 指向任何 OpenAI 兼容端点并移除 mock，即可使用真实模型运行同一脚本。
