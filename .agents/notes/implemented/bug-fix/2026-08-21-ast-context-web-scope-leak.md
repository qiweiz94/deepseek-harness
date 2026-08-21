# Agent Note: disable base-bundle plugin-ast-context on the web plane so its tools do not leak pre-mount

Status: implemented

English | [中文](2026-08-21-ast-context-web-scope-leak.zh.md)

## Problem

`apps/web/tests/shipped-composition.e2e.ts` asserts that a pre-agent, pre-preset-mount `ctx.tools.schemas()` is `[]` — on the web plane every model-facing tool belongs to a preset a session mounts, so the global layer holds nothing. It began returning `['get_file_outline', 'get_directory_outline']`. `plugin-ast-context` was shipped into `packages/bundle/base/cordis.patch.yml` (commit `0a78be1a48`) alongside `tool-goal` / `tool-todo` / `tool-ralph` / `tool-str-replace-editor`. On the web plane the web-app bundle patch (`packages/bundle/web-app/cordis.patch.yml`) disables each of those base rows so the tools come only from a mounted preset — but it had no `plugin-ast-context` disable, so ast-context's global base row stayed enabled and its two tools leaked into the pre-mount scope. Deterministic scope leakage, not timing.

## Decision

Add the missing `- id: plugin-ast-context` / `disabled: true` row to the web-app patch, matching its siblings. On the web plane a session's tools now come only from the preset it mounts; the pre-mount assertion passes unchanged and `EXPECTED_TOOLS` (the post-mount default-preset roster, which never contained the outline tools) is unchanged.

No preset mounts `plugin-ast-context` (verified across `apps/cli/config/agent-presets/*` and the minimal preset, which mounts only `bash` + `str_replace_editor`), so on the web plane the outline tools are now absent everywhere — which is the correct state: they were only ever visible through the leak. Whether web agents *should* get the outline tools via a preset is a separate design decision, not made here; #33 is only about removing the accidental global leak. ast-context stays globally available in the CLI (which keeps base tools on the global plane) and explicitly composed in `examples/headless-agent` (its `ast-context-dir` snapshots are untouched and still pass).

The `apps/web/tests/minimal-preset.snapshot.ts` inline snapshot had been refreshed to include the two outline tools; that refresh was reverted here to `[bash, str_replace_editor]`. That earlier refresh was defensible on its own lane — the tool list had genuinely changed against the golden and nothing there pointed at this leak — the real cause was the upstream wiring (ast-context added to the base bundle without a preset entry or a web-app disable), which this change fixes.

## Alternatives considered

- **Regenerate the web goldens to accept the leak** — rejected: the pre-mount-empty assertion is the contract, and accepting the leak would ship the outline tools into every web session's global scope regardless of preset.
- **Add `plugin-ast-context` to the presets so web agents get the outline tools agent-scoped** — deferred: that is a product decision about whether the web deployment should expose outline tools, separate from removing the leak. `EXPECTED_TOOLS` shows the default preset was never meant to have them.

## Consequences

- Verified empirically after the change: `shipped-composition.e2e` (pre-mount `[]`) passes; `minimal-preset.snapshot` replays to `[bash, str_replace_editor]`; the `examples/headless-agent` snapshot suite (which composes ast-context directly) is untouched and green.
- The web-app disable list is now complete for the base-bundle tool-bearing rows: the leak was exactly the two outline tools (per the issue), so ast-context was the sole base tool-plugin missing from it.
