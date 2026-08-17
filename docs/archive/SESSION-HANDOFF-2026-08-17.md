# MASTER PROMPT — DeepSeek Harness 3-Phase Work: Audit Complete + Closures (session 2026-08-17)

English | [中文](SESSION-HANDOFF-2026-08-17.zh.md)

You are continuing verified work in the DeepSeek Harness monorepo. Everything below was already done and green-verified by the prior session; your job is to (1) accept/verify the existing state, (2) execute the remaining decision/commit items at the end, without regressing any closed item. DO NOT re-do completed work.

## Environment

- DSH checkout (the repo you work in): /Users/nanoclaw/deepseek-harness (branch master, HEAD 47f943859b)
- NOTE: your shell default cwd may be /Users/nanoclaw/code/trading-claw (an unrelated repo) — always pass workdir /Users/nanoclaw/deepseek-harness or cd there.
- Runtime settings live in ~/.dsh/settings.yaml: deepseek-v4-flash and deepseek-v4-pro maxTokens are now 8192 (was 384000 — the provider 400/context-length fix, live-verified). compaction-basic triggerTokens=120000, targetResidualTokens=42000.
- Local profiles at ~/.dsh/profiles are only web and headless. There is NO `dsh goal` CLI command or goal profile in this build; the shipped agent presets are code|cordis|minimal|standard. A fresh session = New Session in the web GUI at 127.0.0.1:3080.

## Gate commands (all in the DSH checkout)

- `pnpm test` — full unit suite (vitest). Expect ~803 files / 13,437 tests / 0 failures.
- `pnpm run typecheck` — host build + contracts-ready tsc. Must be clean.
- `pnpm run test:snapshot` — keyless replay snapshot suite. Expect 12/12 files (115 pass, 1 model-keyed skip).
- Re-record fixtures: `pnpm run test:snapshot:refresh` (DSH_SNAPSHOT=refresh, replay + write-back, NO API key). Plain `pnpm run test:snapshot -u` does NOT write fixtures (replay mode never writes). `test:snapshot:record` (DSH_SNAPSHOT=record) calls the real API and needs a key — only for a truly required live re-record.
- Light gates: `pnpm run verify-translation-pairing` (937 pairs must be consistent), verify-config-catalog, verify-tool-catalog, verify-persistence-catalog, verify-cordis-catalog, verify-cordis-config, verify-config-source-ownership, constraints, knip, duplication, verify-agent-note-format|classification|archived, verify-dsh-package-licenses, verify-package-invariants, test:issue-management.
- macOS has NO `timeout` binary (exit 127 if you wrap with it). Use background jobs instead.
- The file-edit tool requires reading a file first. If inline code generation trips your parser on the literal ellipsis char, emit it as \u2026.

## The 3 phases (implemented, fixtures recorded, all tests/gates green)

1. Phase 1 — contentDigest on agent-instructions: baseline instruction events carry contentDigest = SHA-1 of the raw bytes of every included baseline file joined by NUL (aggregate identity; distinct from each change's per-file digest). Files: packages/context/agent-instructions/src/{digest,index,state,files}.ts.
2. Phase 2 — compaction/range-pruned: new `compaction/range-pruned` event (registered in packages/core/session/src/known-event-types.ts:31 — required or session-persistence refuses the logs), emitted in compaction-basic/src/region.ts; ordering start < summary < user/message < range-pruned < end. New config keys triggerTokens (default 120000) / targetResidualTokens (default 42000), validated + documented EN/zh.
3. Phase 3 — spill directive template + code-point-safe truncation: spill-policy emits [Output Exceeded N chars - Full content written to <locator>] + head/preview + truncation-marker + tail, budgeted inside maxInlineBytes (overhead reserved at worst-case digits; byte-bound backstop; cap invariant verified). A code-point-safe library (codePointLength/truncateCodePoints in packages/util/output-retention) was wired into the char-cut sites (read-render, str-replace, bash-persistent, tool-web fetch, web-fetch-http, llm-deepseek historical reasoning, boundContextSummary). Code-mode run_code description appends the [Code Mode File Handling Rules] block. goal-round-driver coalesces same-revision rounds (drops the Objective line); directive guidance intact. plan-mode section moved to prompt tail (order 1000). cordis.patch.yml spill cap 15000.

## What the PRIOR session fixed (review pass) — all tested, do not redo

- BUG: the subagent continuation digest used a UTF-16 slice -> fixed to truncateCodePoints (packages/subagent/subagent/src/continuation.ts) + dep wiring (package.json/tsconfig) + astral regression test.
- BUG risk: goal-round-driver objective truncation UTF-16 slice -> new limitObjectiveToUnits (packages/goal/goal-round-driver/src/prompt.ts) + dep wiring + astral test.
- 3 missing surrogate-boundary tests added: fs/tool-str-replace-editor/tests/tools.spec.ts, shell/tool-bash-persistent/tests/tools.spec.ts (added an astral-large stub mode), web/tool-web/tests/spill.spec.ts.
- 2 missed slice sites converted: packages/workflow/workflow-worker-thread/src/runtime.ts (uses shared output-retention; dep wired) AND packages/extensions/cordis-client-runner/src/client/evaluator.ts (uses a LOCAL boundCodePoints helper — it sits in the browser CLIENT build graph; output-retention has no tsconfig.client.json, so do NOT add a host-side ref there).
- Snapshot normalizer fixes (packages/test-support/acp-snapshot/src/normalize.ts): spill-path scrub lookahead accepts `]` (class [\s)\]\]]); EVENT_READ_TARGET_REGION_RE de-anchored ([\s\S]*?Session) so event-read timestamps inside the spill preview scrub to {{eventTime}}. This made bash-spill / session-query-spill fixtures deterministic.
- Gate fixes: docs/config-catalog.md regenerated (was stale) + .zh mirrored (compaction block + 4 source refs); 8 translation-pairing violations resolved (agent-note language switchers, zh mirrors for subagent/plan-mode/tool-catalog, then --write records for the 8 pairs). verify-translation-pairing now 937 pairs consistent.
- Corrected pre-existing wrong assertions: packages/util/output-retention/tests/output-retention.spec.ts (4 counts) and a latent TS error in llm-deepseek/tests/serialize.spec.ts (union narrowing). NOTE: llm-deepseek serialization also gained a trailing-plain-answer pinning test + clarified comment (behavior unchanged, doc-conformant).
- Other test/doc additions: code-mode.spec.ts handshake pin ([Code Mode File Handling Rules] presence); agent-instructions.spec.ts digest-derivation test (NUL-join aggregate + per-file digests + every-baseline-has-contentDigest guard) + src docstring clarification.
- Cosmetic: compaction-recovery/session.jsonl timestamps normalized to the run epoch (times are zeroed at compare-time anyway).
- pnpm-lock.yaml regenerated (new workspace edges: subagent, goal-round-driver, workflow-worker-thread).

## Verified status (as of session close)

- Full suite: 803 files / 13,437 tests passing; the only failure seen on loaded runs is packages/boot/app-boot/tests/hmr-config.spec.ts (and once each process-exit.spec.ts + install-lefthook.spec.ts) — LOAD-INDUCED FLAKES under concurrent heavy jobs (typecheck running alongside the full suite); each passes solo in ~1s. Never trust a timeout failure until re-run solo, and do not run typecheck and the full suite concurrently.
- typecheck clean; snapshot 12/12 deterministic (refresh + 2 consecutive replays verified); all light gates pass.
- Working tree is UNCOMMITTED: ~115 files changed / ~1,871 insertions / 324 deletions on master. Nothing committed for any of the phases or the review fixes.

## Remaining work for your session (in priority order)

1. COMMIT the work (per repo rules): create a session branch (git worktree add ../dsh-<topic> -b session/2026-08-17-<topic> or branch off master), review git status / git diff, and commit PATH-SCOPED (never git add -A / bare commit in shared trees). Group logically (phases 1-3 vs review fixes). Push the session branch.
2. DECIDE the residual judgment calls (document or ship):
   - Spill wording NIT: [N chars truncated] counts UTF-16 units while budgets are byte/char; decide whether to relabel or count code points (packages/spill/spill-policy/src/index.ts:211) + tests + README en/zh + re-record fixtures via test:snapshot:refresh if the text changes.
   - plan-mode order: 1000 magic tail number (safe today; a future section ordered >1000 would overtake the tail) — consider a constant or comment.
   - goal-round-driver restore-now-appends ordering: not positionally asserted in the driver spec (only inferred via inbox.spec/agent.spec.ts:144-160) — add a tail-position assertion if you want full pinning.
   - 3 example cordis.yml files still use legacy thresholdRatio: 0.8 (examples/acp-agent, examples/jsonrpc-agent, examples/headless-agent) while README migrated to triggerTokens — migrate or deliberately document the fallback.
   - The compaction auto-path test doesn't explicitly assert range-pruned before compaction/end (guaranteed by the shared commitCompactionBody path) — add the assertion if you want belt-and-suspenders.

## Understanding you need (so you don't get fooled)

- Snapshot fixtures store STABILIZED (not fully tokenized) raw values; volatile scrubbing happens at compare-time in normalizeSessionLog (record times -> 0, uuids -> {{sessionId}}, spill paths -> {{spillLocator:NAME}}, event-read times -> {{eventTime}}). Do not clean up raw-looking fixture values as if they were bugs; replays are deterministic.
- Spill roots like dsh-acp-snap-<hex> are deterministic per scenario; the session dirs under them are scrubbed at compare-time.
- goal-round coalescing: renderGoalRoundPrompt(goal, round, includeObjective=false) drops the Objective only when objectiveAlreadyAdmitted() is true; the invariant reconstructs the same pure decision. Round 1 always includes it.
- Translation/pairing: update BOTH en and zh when editing any in-scope README/doc, then `pnpm exec tsx scripts/verify-translation-pairing.ts --write <pair>` to re-record the i18n.yaml. Never --write a pair whose languages do not actually match.
- When adding char caps anywhere in model-facing text, use codePointLength/truncateCodePoints from @deepseek-ai/dsh-output-retention (browser-safe), never String.slice on decoded text.
- Dep-wiring pattern for output-retention: package.json (dependencies + devDependencies, or peer + devDependencies for pure-peer packages), a tsconfig references entry (use tsconfig.client.json only if the consumer is a client project AND output-retention ever gains one), then `pnpm install --lockfile-only`.

## Unresolved gaps surfaced by the post-overhaul review (next session's mandate)

The deep review of commits 5aa1dc7699 + 13e3443ac2 returned a clean GO (no BUG findings; all affected suites pass), but it flagged two design-level gaps to close before relying on the new envelopes, plus four cosmetic NITs:

- GAP-1 (compaction region.ts:147-159): the new 15-step / 3-turn verbatim-tail caps can stop shrinking before the retainTokens token floor is met, so token-cheap sessions can land well below the configured targetResidualTokens envelope. Currently an untested path — add a test and/or a floor safeguard.
- GAP-2 (goal-round-driver prompt.ts:20-31, 78-83): limitObjectiveToUnits is O(n²) (multi-second spike on a 33K objective), and a long objective is admitted at most once per revision, truncated to ~470 units, so the full text may never reach the model. Consider a linear scan and an explicit full-text admission.
- NITs: agent-instructions digest-vs-framing wording; fetch.ts partial-footer wording; continuation digest suffix-overflow edge; spill-policy "chars"-vs-"units" label.
## Success bar

All gates above pass, everything you ship has code-point-safe truncation and a regression test where behavior changed, fixtures are consistent with the code (verify with test:snapshot after any template/text change; re-record via test:snapshot:refresh if needed), and the work is committed path-scoped on a pushed session branch.
