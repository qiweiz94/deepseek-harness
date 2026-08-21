# Agent Note：在 web 平面禁用 base-bundle 的 plugin-ast-context，使其工具不在挂载前泄漏

Status: implemented

[English](2026-08-21-ast-context-web-scope-leak.md) | 中文

## 问题

`apps/web/tests/shipped-composition.e2e.ts` 断言：在 agent 之前、preset 挂载之前，`ctx.tools.schemas()` 为 `[]`——在 web 平面上，每个面向模型的工具都属于会话所挂载的某个 preset，因此全局层不持有任何内容。它却开始返回 `['get_file_outline', 'get_directory_outline']`。`plugin-ast-context` 被随 `tool-goal` / `tool-todo` / `tool-ralph` / `tool-str-replace-editor` 一起加入 `packages/bundle/base/cordis.patch.yml`（提交 `0a78be1a48`）。在 web 平面上，web-app bundle 补丁（`packages/bundle/web-app/cordis.patch.yml`）会禁用这些 base 行，使工具只来自被挂载的 preset——但它没有 `plugin-ast-context` 的禁用项，因此 ast-context 的全局 base 行仍处于启用状态，其两个工具泄漏进了挂载前的作用域。这是确定性的作用域泄漏，而非时序问题。

## 决策

在 web-app 补丁中补上缺失的 `- id: plugin-ast-context` / `disabled: true` 行，与其同类一致。在 web 平面上，会话的工具现在只来自它挂载的 preset；挂载前断言不变即可通过，`EXPECTED_TOOLS`（挂载后默认 preset 的名册，本就不含 outline 工具）也保持不变。

没有任何 preset 挂载 `plugin-ast-context`（已在 `apps/cli/config/agent-presets/*` 与 minimal preset 中核实，后者只挂载 `bash` + `str_replace_editor`），因此在 web 平面上 outline 工具现在处处都不出现——这才是正确状态：它们本就只通过泄漏可见。web agent 是否*应当*经由 preset 获得 outline 工具，是另一个此处不做的设计决策；#33 只关乎移除意外的全局泄漏。ast-context 在 CLI（其 base 工具保留在全局平面）中仍全局可用，并在 `examples/headless-agent` 中显式组装（其 `ast-context-dir` 快照未受影响，仍通过）。

`apps/web/tests/minimal-preset.snapshot.ts` 的内联快照此前曾被刷新以包含这两个 outline 工具；本次将其回退为 `[bash, str_replace_editor]`。此前那次刷新在其自身 lane 上是合理的——工具列表相对 golden 确有变化，且那里没有任何线索指向此泄漏——真正的成因是上游接线（ast-context 被加入 base bundle，却没有 preset 条目或 web-app 禁用项），本次变更修复了它。

## 考虑过的替代方案

- **重新生成 web golden 以接受泄漏** — 拒绝：挂载前为空的断言就是约定，接受泄漏会不论 preset 如何都把 outline 工具塞进每个 web 会话的全局作用域。
- **把 `plugin-ast-context` 加入 preset，使 web agent 以 agent 作用域获得 outline 工具** — 暂缓：那是关于 web 部署是否应暴露 outline 工具的产品决策，与移除泄漏相互独立。`EXPECTED_TOOLS` 表明默认 preset 本就不应拥有它们。

## 后果

- 变更后经验验证：`shipped-composition.e2e`（挂载前 `[]`）通过；`minimal-preset.snapshot` 回放为 `[bash, str_replace_editor]`；`examples/headless-agent` 快照套件（直接组装 ast-context）未受影响且为绿。
- web-app 禁用列表现在对 base-bundle 中承载工具的行是完整的：泄漏恰好是这两个 outline 工具（如 issue 所述），因此 ast-context 是唯一缺失的 base 工具插件。
