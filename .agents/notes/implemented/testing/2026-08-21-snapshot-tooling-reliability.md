# Agent Note: snapshot refresh updates vitest snapshots, a build preflight, and subagent-scenario contention tuning

Status: implemented

English | [中文](2026-08-21-snapshot-tooling-reliability.zh.md)

## Problem

Closing the ast-context snapshot staleness surfaced three snapshot-tooling gaps:

1. **`test:snapshot:refresh` / `test:web:refresh` did not update vitest snapshots.** `DSH_SNAPSHOT=refresh` re-writes the acp-snapshot harness's own fixtures (replay JSONL and expected-output files) but passed no `--update`, so vitest `toMatchInlineSnapshot`/`toMatchSnapshot` blocks — e.g. the tool lists in `apps/web/tests/minimal-preset.snapshot.ts` and `examples/headless-agent/tests/headless.snapshot.ts` — stayed stale after a keyless, replay-valid change. There was no one-command keyless way to refresh them; the only options were `:record` (for real transcript changes) or a hand-scoped `-u`.
2. **`test:snapshot` failed with a cryptic `ERR_MODULE_NOT_FOUND` without a prior build.** The example/CLI scenarios boot compositions that import each package's typert host registry through the `<pkg>/typert` export, which resolves to `lib/typert.host.js` — a generated build artifact with no source form, reached the same way in `src` and `lib` example modes because a subpath export bypasses the tsconfig-paths facade. CI is unaffected (its snapshot gate prepends `build`), but a bare local run died deep in a spawned child with no hint that a build was the fix.
3. **The acp `subagent-continuable`/`-inheritance` scenarios time out on the fork build lane** under 4-core contention: each spawns multiple real agent subprocesses while `DSH_SNAPSHOT_MAX_CONCURRENCY=4` scenarios run at once, and the lane comment already recorded that `DSH_TEST_TIMEOUT_FACTOR=8` was "a first widening, not a measured sufficient bound."

## Decision

1. **Append `--update` to both refresh scripts** (`package.json`), matching `test:snapshot:record`. Refresh is keyless replay, so the model transcript does not change and `--update` only rewrites deterministic derived diffs (e.g. a tool list). It writes vitest `.snap`/inline blocks, disjoint from the harness's JSONL/expected-output write-back, and does not change the serial refresh execution. The existing "review every diff" discipline covers it. `docs/testing.md` (+ zh pair) now states refresh updates vitest snapshots too.
2. **Add a vitest `globalSetup` build preflight** (`scripts/snapshot-build-preflight.ts`, wired in `vitest.snapshot.config.ts`) that checks for representative built host libraries (`packages/interaction/commands/lib/typert.host.js`, `packages/goal/goal/lib/typert.host.js`) and, when missing, throws a clear error naming `pnpm run build:lib:host`. This fails loud in the vitest process before any scenario spawns, rather than as a child-process stack trace. Chosen over forcing a build into `test:snapshot`, to keep the fast path when the libs are already built.
3. **Reduce contention on the fork build lane** (`.github/workflows/fork-ci.yml`): lower `DSH_SNAPSHOT_MAX_CONCURRENCY` 4 → 2 (fewer scenarios competing for the 4 cores — the root cause) and raise `DSH_TEST_TIMEOUT_FACTOR` 8 → 12 (120s internal waits) for headroom. The 90-minute lane budget absorbs the reduced parallelism.

## Alternatives considered

- **Correct the doc instead of adding `--update`** — rejected: the doc never actually claimed refresh updates inline snapshots, and the real friction was the missing capability, not a wrong doc. `--update` is the capability; the doc clarification comes with it.
- **Force `test:snapshot` to build first (like `test:web`)** — rejected per the maintainer choice: it adds the full build time to every local snapshot run and defeats the fast path when the libs are already built. The preflight preserves the fast path and still fails loud when a build is genuinely missing.
- **Only raise the timeout factor for the subagent scenarios** — rejected as symptom-only: the fork-ci comment already showed factor bumps alone were "not a measured sufficient bound." Lowering the concurrency attacks the core contention that causes the timeout; the factor bump is added headroom on top.

## Consequences

- `test:snapshot:refresh` is now the single keyless command to bring both harness fixtures and vitest snapshots current for a replay-valid change.
- A bare `test:snapshot` without a build fails with an actionable message. Note the preflight is unconditional (fires whenever the built host libs are missing): a hypothetical `scripts/`-only source-mode subset that imports no `<pkg>/typert` no longer runs fully zero-build, but that narrow workflow just runs one warm `build:lib:host`; the trade buys a clear error for the common `test:snapshot` invocation.
- Change 3 cannot be validated locally (the timeout only manifests under real 4-core CI contention); it is verified by the next fork build-lane run. If the scenarios still time out, the next step is lowering concurrency further or splitting the heavy subagent scenarios onto their own serial step.
