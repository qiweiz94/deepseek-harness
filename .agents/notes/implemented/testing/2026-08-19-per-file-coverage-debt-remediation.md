# Agent Note: Per-file coverage debt remediation

Status: implemented

English | [中文](2026-08-19-per-file-coverage-debt-remediation.zh.md)

## Problem

The fork merged weeks of work with no executed CI: upstream's `ci.yml` cannot start on a personal fork, and the fork-hosted workflow only arrived with the fork CI change. In that window the per-file 100% coverage gate (`pnpm run test:coverage`) went red on eleven `src` files across seven packages — 121 uncovered locations, 72 of them in the two audited plugins (`plugin-worktree-sandbox`, `plugin-subagent-router`), the rest introduced by the 2026-08-17 token-optimization merges and the 2026-08-19 lint fixes. A red coverage lane would make the new fork CI's evidence worthless from day one.

## Decision

Every reachable uncovered branch gained a behavior test in its package's existing suites; every genuinely unreachable guard carries a justified `v8 ignore` annotation instead of a synthetic test. The split, per file:

- `plugin-worktree-sandbox`: a fake-git shim (`fakeGit` in [sandbox.spec.ts](../../../../packages/plugins/plugin-worktree-sandbox/tests/sandbox.spec.ts)) drives the add-race reuse and rethrow paths, trial-head and removal failures (stderr and stdout-only variants), the cleanup-note and AggregateError paths, render pluralization/stream/truncation branches, and a loader-bypassing `apply` covers the documented config fallbacks. Ignored as unreachable: the bounded-capture existence guards, the `pop()` type guard, the non-Error primary wrap, and the result/primaryError exhaustiveness guard.
- `plugin-subagent-router`: tests for the empty-`toolFilter` load failure, the default tool name outside the loader, parallel-safe classification via `executionMode`, forwarding of every delegation option into the start request, capability-gap listing without persona, and route matching with no `routes` key.
- `compaction-basic`: turn-end pressure wiring tests — no agent registry, unrouted and context-less sessions, the warn-once misconfiguration path (zero context window) with Error and non-Error meter failures, the idle transition with nothing pending, maintenance-time re-checks, and the per-target `triggerTokens`/`targetResidualTokens` overrides.
- `agent-instructions`: a split-text-block pending update proves digest-based reuse; the rendered-text digest fallback itself is annotated unreachable-deterministically (compose's scope reconciliation dedupes any same-identity render before comparison).
- `goal-round-driver`: admitted-round mismatch test; the two arithmetically unreachable truncation arms are annotated.
- `tool-fs`: an astral-heavy line whose UTF-16 length trips the cap while its code points fit.
- `plugin-ast-context`: singular and zero skip-note renders, the loader-bypassing `maxFiles` default, and annotations for the pop-guard and mid-outline abort rethrow.

## Alternatives considered

**Ship fork CI with a red coverage lane and file an issue.** The lane's red would be permanent background noise, and a gate that is expected to fail is an alarm nobody reads.

**Mark the coverage job non-blocking until remediation.** A control that cannot fail protects nothing; flipping it back is the step that gets forgotten.

**Blanket `v8 ignore` the failing regions.** Most of the 121 locations were reachable behavior (failure reporting, rendering, routing options) whose tests found no bug this time but now pin the contracts; annotations are reserved for guards no composition path can reach, each carrying its reason.

## Consequences

`pnpm run test:coverage` passes per-file 100% repo-wide again, so the fork CI coverage lane is meaningful from its first run. The fake-git shim gives the sandbox plugin a reusable pattern for git-failure testing. The annotated guards are now assertions about reachability — if a refactor makes one reachable, the annotation must fall with it.
