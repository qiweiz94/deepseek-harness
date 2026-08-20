# MASTER PROMPT — subagent-router/worktree-sandbox audit: lint green, fail-closed routing, empty-label rejection, all merged (session 2026-08-19)

English | [中文](SESSION-HANDOFF-2026-08-19.zh.md)

You are continuing verified work in the DeepSeek Harness monorepo. Everything below was already done and green-verified by the prior session and merged to master; your job is to (1) accept/verify the existing state, (2) execute the remaining decision items at the end, without regressing any closed item. DO NOT re-do completed work.

## Environment

- DSH checkout (the repo you work in): /Users/nanoclaw/deepseek-harness (branch master, HEAD b7ef220ea3, working tree clean).
- NOTE: your shell default cwd may be /Users/nanoclaw/code/trading-claw (an unrelated repo) — always pass workdir /Users/nanoclaw/deepseek-harness or cd there.
- Local profiles at ~/.dsh/profiles are only web and headless. A fresh session = New Session in the web GUI at 127.0.0.1:3080.
- SECURITY: the API key used to RECORD the ast-context snapshot (sk-Zivz...Druu) is EXPOSED — rotate/burn it and never reuse it for recording. Any future live re-record (`test:snapshot:record`) needs a fresh key supplied at that time.
- GitHub: the GraphQL API is disabled for this repo — use the `gh` REST CLI (pr create/merge/edit/view and labels all work). `gh pr merge --merge` is a real 2-parent merge; `delete_branch` does not fire, so delete remote refs explicitly with `git push origin --delete` (keel-blocked, see below).

## Gate commands (all in the DSH checkout)

- `pnpm run test` — full unit suite (vitest). A positional path filter is IGNORED: the full suite always runs, and that output is your evidence. Expect 823 files (815 passed / 8 skipped) / 13,524 tests passed / 109 skipped / 0 failures.
- `pnpm run typecheck`, `pnpm run lint`, `pnpm run duplication` (0 clones), `pnpm run build` — must be clean. lint is green repo-wide; it was red before PR #18 fixed 5 pre-existing oxlint errors in plugin-worktree-sandbox.
- `pnpm run test:snapshot` — keyless replay snapshot suite. Expect 13 files / 116 pass / 1 model-keyed skip. `test:snapshot:refresh` (no key) re-records volatile values; `test:snapshot:record` (DSH_SNAPSHOT=record) calls the real API and NEEDS A KEY — only for a truly required live re-record.
- `pnpm run doc-sync` — 28 gates including catalog freshness (tool/config/cordis/persistence), translation pairing, agent-note format, cordis-config, readme model-experience, doc graphs, md links. Re-record edited pairs with `pnpm run verify-translation-pairing --write <full/path/prefix>` (the anchor is the full path minus the .md extension; bare names are rejected).
- `pnpm run website:build` — VitePress build + 2,322 internal fragment links.
- `pnpm run verify-third-party-notices` and `pnpm run verify-built-package-invariants` (220 compiled companions).
- keel `no-remote-exec` blocks `pnpm exec` and on-the-fly `npx`; use `pnpm run <script>` only. To run ad-hoc tsx probes: place the file INSIDE the package (node_modules resolution) and run `node --import tsx/esm <file>`; delete the probe before committing.
- keel `publish-gate` blocks `git push origin --delete <branch>`; approvals are ONE-SHOT and expire — each deletion round needs a fresh `keel allow publish-gate --once` run by the USER. Never self-approve; surface the exact approval command instead.
- macOS has NO `timeout` binary (exit 127 if you wrap with it).

## What the PRIOR session shipped (all merged to master)

1. **PR #17 `fix/plugin-router-audit` (merged e2d333a96d, 1 commit)** — subagent-router + worktree-sandbox audit fixes. S1: `plugin-worktree-sandbox` validates the sandbox `id` against `/^[a-zA-Z0-9_-]{1,64}$/` in `execute` BEFORE any side effect (traversal + 65-char denial tests). S2: `.dsh/` added to .gitignore. S3: `matchRouteCandidates` now flattens EVERY matching route's providers in config order; routes are policy, so a delegation matching any route never falls back to the default candidates (fail-closed, grounded in Envoy within-pool failover semantics and Anthropic "Building Effective Agents", Dec 19 2024), and an unroutable or unsatisfiable delegation fails loud listing the attempted candidates. A `fallbackToDefaults` config flag was proposed and REJECTED (YAGNI, no consumer evidence). Tests cover fall-through, fail-loud-with-no-defaults, and candidate ordering.
2. **PR #18 `fix/plugin-sandbox-lint` (merged 08766156cd, 1 commit)** — the 5 pre-existing oxlint errors that kept the lint gate red: worktree.ts:56 `String(outcome.signal)` → `outcome.signal`; worktree.ts:90-91 reader typed `AsyncIterable<Buffer>` (precedent fs-local/src/fsio.ts:414); index.ts:191 arrow-block `() => { controller.abort() }`; index.ts:241/247 error normalization via `JSON.stringify` for the unknown-typed primary error. Plus `.gitignore` negation `!examples/acp-agent/tests/snapshots/skill-load/workspace/.dsh/` so files under the tracked fixture subtree stay visible to git despite the broad `.dsh/` rule (verified with `git check-ignore`). Full-repo `pnpm run lint` is exit 0 after this.
3. **PR #19 `fix/plugin-router-config` (merged b7ef220ea3, 1 commit)** — empty route labels were accepted config: schemastery `required()` only demands key presence, and `label: ''` matches EVERY delegation via `includes('')`, silently injecting its providers ahead of more-specific routes. Fix: `label: z.string().min(1).required()` (matching the existing `providers: .min(1)`) plus a load-fail test asserting `/string length >= 1/`; `matchRouteCandidates` now dedupes providers (first occurrence keeps its position) so fail-loud messages stay canonical; router README EN+ZH and the 2026-08-19 subagent-router Agent Note updated (empty-label rejection now listed under misconfiguration-fails-loud) and both pairs re-recorded. Config-catalog regeneration confirmed a no-op (1-line schema change, no JSDoc/line shift).

## Key findings and decisions (audit + self-improvement value)

- **schemastery semantics** (vendor/schemastery/src/index.ts:609-617): `required()` = key presence only; `.min(n)` is the string-length gate (`checkWithinRange(data.length, ...)`); the error text is `expected string length >= 1 but got 0`. Empty-label acceptance was finding B of the deep audit and the worst of the three fixed footguns.
- **Fail-closed routing is the product decision**: routes are explicit policy; once any route matches, defaults are out of reach; failure is loud with the candidate list in the message. No escape-hatch flag.
- **Audit disposition**: A (broad `.dsh/` ignore hiding a tracked fixture subtree) fixed in PR #18; B (empty label) fixed in PR #19; C (duplicate providers) fixed in PR #19; D (`args.id` auto-generation on non-string/empty input) LEFT by decision — the z schema already enforces `type: 'string'` upstream and there is no consumer evidence for stricter behavior; E (keyless snapshot coverage for subagent-router/worktree-sandbox) DEFERRED until the harness supports keyless replay for these plugin bundles.
- **Process lesson**: never merge with a known-red local gate — the 5 lint errors predated this session's PRs and would have blocked CI; verify the FULL gate set (lint + tests + typecheck + doc-sync) before every PR.
- **CI wiring is UNCONFIRMED**: no `ci.yml` runs appear for this repo's commits (only Copilot "dynamic" runs). Investigation was offered to the user, not yet requested — confirm scope with the user before acting.
- **Translation pairing**: the `--write` anchor is the full path prefix (bare names rejected); after any scripted edit, verify the heading table — a silent no-op shows up as a pairing failure.
- **Keel approvals expire**: a one-shot `keel allow publish-gate --once` does not persist; expect to re-request it per deletion round.
- **Catalog churn scoping**: single-line z-schema edits at an unchanged line position need NO config-catalog regeneration; JSDoc/interface changes do.

## Verified status (as of session close)

- Full serial suite: 13,524 passed / 109 skipped, 815 passed files / 8 skipped (823 total), 0 failures (includes the 2 new PR #19 tests: resolver dedup + empty-label load-fail).
- lint exit 0, typecheck exit 0, doc-sync 28/28 (router README pair and router Agent Note pair re-recorded; gen-config-catalog no-op), pre-commit hooks (translation pairing / lint / whitespace / vendor guard) green on both PR commits.
- master = b7ef220ea3 (merge of #19), working tree clean, no open PRs, no remote `fix/plugin-*` branches (all three PR branches deleted with user-approved keel approvals).

## Remaining work for your session (in priority order)

1. **CI wiring (CONFIRM SCOPE WITH USER FIRST)**: no ci.yml runs for this repo's commits — investigate whether CI exists and is green; if missing, propose minimal CI running lint + test:coverage + doc-sync on PRs.
2. **Audit item E (do only if the harness now supports it)**: keyless snapshot coverage for subagent-router and worktree-sandbox behavior via a runnable example.
3. **Audit item D (leave unless evidence appears)**: `args.id` auto-generation — no consumer evidence for stricter behavior.
4. **Rotate/burn the recording key** (sk-Zivz...Druu) — it was embedded in live session data; never reuse it for `test:snapshot:record`.

## Understanding you need (so you don't get fooled)

- Snapshot fixtures store STABILIZED raw values; volatile scrubbing happens at compare-time in the normalizer. Do not clean up raw-looking fixture values.
- The tool schema in the session fixture (request/header, OpenAI function-calling format) carries INPUT parameters only — output-schema changes never touch fixtures.
- Plugin `apply(ctx, config = {})` receives config as the SECOND argument; config validation happens in the Loader (schema), not in apply.
- keel: first violations of deny rules warn; repeats block. Never self-approve a blocked action; surface the exact approval command instead.
- Per-file 100% coverage on packages/*/*/src is the gate; unreachable guards carry `/* v8 ignore next -- reason */`.
- The test-suite positional filter is ignored by design — `pnpm run test -- <path>` still runs the whole suite; that output is your evidence.

## Success bar

All gates above pass, every behavior change ships with its tests, bilingual pairs are re-recorded, the working tree is clean with the work committed path-scoped on pushed branches/PRs, no remote branches linger after merge, and no exposed key material is reused.