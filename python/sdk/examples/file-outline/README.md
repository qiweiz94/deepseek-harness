# File-outline example

English | [中文](https://github.com/deepseek-ai/deepseek-harness/blob/master/python/sdk/examples/file-outline/README.zh.md)

This example drives the real [`get_file_outline`](../../../packages/plugins/plugin-ast-context/README.md) tool through the Python SDK. The model endpoint is a keyless local mock: its first completion answers with a `tool_calls` delta asking the agent to outline a repository file, and the second answers with plain text. The tool itself runs for real inside the runtime process, so the outline in the `tool/result` event is genuine tree-sitter output for the requested file — no API key, no build.

## Run it

```sh
uv sync --project python/sdk --group test
uv run --project python/sdk -- python python/sdk/examples/file-outline/outline.py
```

Requires `pnpm install` at the repository root (the example boots the repo-source runtime bin through `tsx`). The script prints the session root, the mock endpoint, the tools offered to the model, and the captured `tool/result` event, then asserts:

- the model was offered `get_file_outline`;
- exactly one `tool/result` event was emitted;
- the outline payload names the real symbol `AstSymbolExtractor` from `packages/plugins/plugin-ast-context/src/extractor.ts`.

The same flow is covered by the collected `tests/test_file_outline_example.py`.

## The composition

`cordis.yml` is the SDK's bundled default composition (stdio JSON-RPC server, agent spine, DeepSeek adapter, JSONL session persistence, checkpoint policy, local bash, fs-local) plus one entry:

- `plugin-ast-context` registers the model-facing `get_file_outline` tool into the agent's tool registry.

## How the mock works

1. First model request — the mock answers with a streaming `tool_calls` delta for `get_file_outline` with `{"path": "packages/plugins/plugin-ast-context/src/extractor.ts"}` and `finish_reason: "tool_calls"`.
2. The agent executes the tool locally (reads the file, parses it with the tree-sitter grammar matching the extension, renders the outline) and emits `tool/call` and `tool/result` events.
3. Second model request (the tool result is now in the message history) — the mock answers with plain text and `finish_reason: "stop"`.

Point `DEEPSEEK_BASE_URL` at any OpenAI-compatible endpoint and drop the mock to use a real model with the same script.