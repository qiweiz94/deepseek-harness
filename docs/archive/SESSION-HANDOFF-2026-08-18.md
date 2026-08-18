# MASTER PROMPT — get_file_outline plugin: shipped, bounded, nested-outline, all merged (session 2026-08-18)

English | [中文](SESSION-HANDOFF-2026-08-18.zh.md)

You are continuing verified work in the DeepSeek Harness monorepo. Everything below was already done and green-verified by the prior session and merged to master; your job is to (1) accept/verify the existing state, (2) execute the remaining decision/commit items at the end, without regressing any closed item. DO NOT re-do completed work.

## Environment

- DSH checkout (the repo you work in): /Users/nanoclaw/deepseek-harness (branch master, HEAD d4fe628e21, working tree clean).
- NOTE: your shell default cwd may be /Users/nanoclaw/code/trading-claw (an unrelated repo) — always pass workdir /Users/nanoclaw/deepseek-harness or cd there.
- Local profiles at ~/.dsh/profiles are only web and headless. A fresh session = New Session in the web GUI at 127.0.0.1:3080.
- SECURITY: the API key used to RECORD the ast-context snapshot (sk-Zivz...Druu) is EXPOSED — rotate/burn it and never reuse it for recording. Any future live re-record (`test:snapshot:record`) needs a fresh key supplied at that time.

## Gate commands (all in the DSH checkout)

- `pnpm test` — full unit suite (vitest). Expect ~806 files / 13,470 tests / 0 failures (serial `--maxWorkers=1` is the deterministic run; parallel runs can show load flakes, see below).
- `pnpm run typecheck`, `pnpm run lint`, `pnpm run duplication` (0 clones), `pnpm run build` — must be clean.
- `pnpm run test:snapshot` — keyless replay snapshot suite. Expect 13 files / 116 pass / 1 model-keyed skip. `test:snapshot:refresh` (no key) re-records volatile values; `test:snapshot:record` (DSH_SNAPSHOT=record) calls the real API and NEEDS A KEY — only for a truly required live re-record.
- `pnpm run doc-sync` — 28 gates including catalog freshness (tool/config/cordis/persistence), translation pairing (940 pairs), agent-note format, cordis-config, readme model-experience, doc graphs, md links.
- `pnpm run website:build` — VitePress build + 2,322 internal fragment links.
- `pnpm run verify-third-party-notices` and `pnpm run verify-built-package-invariants` (220 compiled companions).
- keel `no-remote-exec` blocks `pnpm exec` and `npx` on-the-fly; use `pnpm run <script>` only. To run ad-hoc tsx probes: place the file INSIDE the package (node_modules resolution) and run `node --import tsx/esm <file>`; delete the probe before committing.
- macOS has NO `timeout` binary (exit 127 if you wrap with it).

## What the PRIOR session shipped (all merged to master)

1. **PR #1 `feat/ast-context-plugin` (merged 46c83d5939, 4 split commits)** — new model-facing tool plugin `@deepseek-ai/dsh-plugin-ast-context` registering `get_file_outline`: tree-sitter TypeScript symbol outlines (functions/classes/interfaces/types/enums, 1-based line spans, nested declarations) so the model orients before reading a large file. Includes the extractor (pure function of text), output schema (2-level, model-visible input is one `path`), renderer (one line per symbol, indented members), wiring (base bundle + headless example cordis.yml + package.json deps), keyless snapshot (fixtures under examples/headless-agent/tests/snapshots/ast-context/: input.json, session.jsonl ~29KB/42 records, stream-json.expected.jsonl; live-overlay + replay twin cordis.yml files), Agent Note 2026-07-02 scope lines (EN/ZH/i18n), THIRD_PARTY_NOTICES.md regeneration (tree-sitter rows). Catalog extension: generator boots each plugin and harvests `ctx.tools.schemas()`; completeness guard globs `packages/*/tool-*` and `packages/plugins/*`.
2. **PR #4 `feat/ast-context-bounds` (merged 7019e3c942, 3 split commits)** — bounds hardening + harness flakiness + note policy. `Config` via `@deepseek-ai/schemastery` (NOT zod): `maxBytes` default 2,000,000, `maxSymbols` default 2,000, both `step(1).min(1)` (schemastery has no `.int()`), validated at load and failing loud (loader-composition spec covers `maxSymbols: 0`). `stat`-before-read rejects files one byte past `maxBytes` with a directing error naming the limit and measured size; extractor throws past `maxSymbols` ("read the file directly or narrow the path") — error result, never a partial outline (tool-fs-search precedent). Tests: exact-limit pass / one-past reject, multibyte byte-counting, BOM, CRLF. Flakiness: `DEFAULT_PROCESS_TIMEOUT_MS` 30s→60s (packages/test-support/loader-smoke/src/index.ts:25 — the "did not exit within 30s" failures came from the subprocess-owned timeout, not vitest's 120s deadline) and `DEFAULT_SNAPSHOT_MAX_CONCURRENCY` 5→3 (vitest.snapshot.config.ts; `DSH_SNAPSHOT_MAX_CONCURRENCY` knob unchanged). Note policy: `packages/plugins/*` is reserved for model-facing tool plugins; a non-tool plugin still needs a manifest entry and renders an empty `parameters` section.
3. **PR #5 `feat/ast-context-deeper-outline` (merged d4fe628e21, 1 commit)** — nested declarations one body level deep per symbol: `collectMembers` became `collectChildren` recursing through `class_body`/`interface_body`/`statement_block` bodies; a class declared inside a method body appears under that method with its own members. Namespaces (`internal_module` is never reported, so contents stay excluded), class fields, property signatures, lexical declarations, and declarations inside control-flow blocks are NOT reported (documented). `maxSymbols` now counts the COMPLETE tree at every depth (was 2 levels). Output-schema descriptions refreshed; no schema-structure change (member-level `children` array is already unconstrained, so deeper output passes runtime validation); tool description regenerated the catalog (EN+ZH re-paired); no snapshot re-record (fixture `sample.ts` has no nested declarations, replay still matches).

## Key findings and decisions (audit + self-improvement value)

- **Stacked-PR lesson**: deleting a merged base branch AUTO-CLOSES dependent PRs (and `gh pr edit --base` refuses closed PRs). The fix: recreate the PR with the same head branch against `--base master` — the diff then shows exactly the dependent commits. PR #2 → #4 and #3 → #5 were recreated this way.
- **Model-experience gate** (`verify-package-readme-model-experience`): a surface has exactly three ordered H4 fields (`What the model sees` / `Token effect` / `KV Cache effect`); there is NO separate `### Config` H3 — config deltas belong inside `#### What the model sees` prose (tool-bash is the reference layout).
- **Generated-doc churn sources**: a new package Config interface → `gen-config-catalog` (EN + hand-mirror zh + `--write` pairing); a package dependency change → `gen-doc-graphs` (apps/cli/composition.md + examples/headless-agent/composition.md); a tool description change → `gen-tool-catalog` (EN + zh + pairing). All three are doc-sync gates.
- **Snapshot replay executes tools for real**: the replayed session boots the real subprocess path and RUNS `get_file_outline` against the fixture `sample.ts`; only the model response is replayed. Additive extractor behavior stays green without re-record; a fixture-content change would need one.
- **Coverage reality**: serial `vitest run --coverage --maxWorkers=1` passes all 806 files / 13,470 tests; the 11 global-threshold errors that print are the CI-partitioned exempt-heavy packages (compaction-basic, goal-round-driver, tool-fs, agent-instructions) and are pre-existing. Parallel-load flakes seen repeatedly: `subprocess-local/process-exit.spec.ts` (ENOENT ready file) and `scripts/gen-client-catalog.spec.ts` vs the oxlint-contract suite (temp `oxlint-contract-<uuid>.ts` files deleted mid-scan). NEVER trust a timeout failure until re-run solo.
- **Translation pairing**: every edited in-scope doc needs EN+ZH updated, then `pnpm run verify-translation-pairing --write <pair>` (940 pairs total). The pairing check compares heading depth and per-file blob hashes; a python replace that silently no-ops shows up here — verify the heading table after any scripted edit.
- **schemastery API**: `z.number().step(1).min(1)` (no `.int()`/`.positive()`); `@deepseek-ai/schemastery` is a vendored workspace dep (`workspace:^`, already in THIRD_PARTY_NOTICES).
- **Repo convention decision (C)**: bilingual docs STAY. EN-first authoring is already the rule (docs/i18n contract); ~940 zh files + the pairing gate are the product's documented standard, and archive docs are frozen history. Rejected: English-only conversion (irreversible, contradicts Chinese-facing product reality, no consumer evidence).

## Verified status (as of session close)

- Full serial suite: 806 files / 13,470 tests passing (test:coverage with --maxWorkers=1); package tests for the plugin 29/29 (24 before bounds, 29 after deeper outlines).
- typecheck, lint, duplication (0 clones), build, doc-sync 28/28, snapshot 13 files / 116 tests (twice, consecutive), website:build + 2,322 fragments, verify-third-party-notices up to date, verify-built-package-invariants 220 — all green.
- master = d4fe628e21 (merge of #5), working tree clean, no open PRs.

## Remaining work for your session (in priority order)

1. **Rotate/burn the recording key** (sk-Zivz...Druu) — it was embedded in live session data; never reuse it for `test:snapshot:record`.
2. **`.tsx` support for get_file_outline**: the plugin's Known Limitations says TypeScript only; the tree-sitter-typescript dep already bundles the tsx grammar (tree-sitter-tsx.wasm). Extractor takes a grammar parameter; the tool selects `.ts` → typescript / `.tsx` → tsx by extension; tests (tsx parse, nested members, fields ignored), README EN+ZH limitation update. NO schema change, NO catalog churn, NO snapshot re-record (additive; fixture is `.ts`).
3. **Unit-suite flake bumps** (CI-owned, only if CI reddens): 1-line test-timeout raises in llm-pi-ai adapter (1s watchdog race, measured 1039ms), install-lefthook, oxlint-contract, code-block grammars — all pass in isolation today.
4. **Python SDK example**: a runnable example under python/ driving `get_file_outline` through the existing SDK + bundled runtime over newline-delimited JSON-RPC on stdio, plus docs EN+ZH.
5. **Second tool plugin** (pattern-proof): a `get_directory_outline`-style plugin (bounded, structured, catalog + snapshot route). The snapshot record step needs a FRESH key — pause and ask the user for one, or ship the plugin + harness with the record deferred and documented.

## Understanding you need (so you don't get fooled)

- Snapshot fixtures store STABILIZED raw values; volatile scrubbing (times → 0, uuids → {{sessionId}}, spill paths → {{spillLocator:NAME}}) happens at compare-time in the normalizer. Do not clean up raw-looking fixture values.
- The tool schema in the session fixture (request/header, OpenAI function-calling format) carries INPUT parameters only — output-schema changes never touch fixtures.
- Plugin `apply(ctx, config = {})` receives config as the SECOND argument; config validation happens in the Loader (schema), not in apply.
- keel: first violations of deny rules warn; repeats block. Never self-approve a blocked action; surface the exact approval command instead.
- Per-file 100% coverage on packages/*/*/src is the gate; unreachable guards carry `/* v8 ignore next -- reason */`.

## Success bar

All gates above pass, every behavior change ships with its tests, bilingual pairs are re-recorded (940 consistent), the working tree is clean with the work committed path-scoped on pushed branches/PRs, and no exposed key material is reused.