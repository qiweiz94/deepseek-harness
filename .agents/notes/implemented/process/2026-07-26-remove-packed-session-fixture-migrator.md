# Agent Note: Remove the packed-session fixture branch migrator

Status: implemented

English | [中文](2026-07-26-remove-packed-session-fixture-migrator.zh.md)

## Problem

The repository's default writers and snapshot check keep session fixtures in the canonical packed-row layout. `pnpm run migrate:packed-session-fixtures` remains alongside that permanent enforcement only so in-flight branches carrying older fixture edits can merge current `master` and mechanically converge without re-recording model output.

Once every such branch is merged, closed, or already canonical, the write command and its branch-convergence instructions have no continuing owner. Keeping a mutation command after its transition ends adds a second apparent maintenance path beside the permanent read-only snapshot check.

## Decision

The temporary `scripts/migrate-packed-session-fixtures.ts` CLI and the root `migrate:packed-session-fixtures` package command are removed. The live inventory found no open pull request converting session-format JSONL, but it did find one continuing consumer the proposal had not modeled: the documented live re-record workflow (`test:snapshot:record`) harvested raw eager-drain-packed session logs and depended on the migrator to canonicalize them afterward. The removal therefore also closes that dependency at its source: record and refresh write-back canonicalize every fixture through `canonicalSessionFixture`, which moved from the script into `@deepseek-ai/dsh-acp-snapshot` (`src/session-fixture-canonical.ts`) so the write site and the gate share one implementation.

`scripts/session-fixture-layout.ts` remains as repository discovery for the permanent gate `scripts/session-fixture-layout.snapshot.ts`, importing the package canonicalizer; the pure-function unit tests moved to `packages/test-support/acp-snapshot/tests/session-fixture-canonical.spec.ts`. The gate's remediation text is command-independent. The transitional command links are gone from the testing policy, the ACP snapshot README, and the [packed-row Agent Note](../architecture/2026-07-26-packed-chunk-rows-by-default.md).

## Alternatives considered

**Keep the command indefinitely.** This makes old fixture conversion convenient, but it leaves a repository-wide mutation tool after the only known migration window closes. The read-only gate already supplies the durable behavior and diagnostic.

**Remove the canonicalization module with the CLI.** The module is not transition residue: snapshot CI uses it to discover future fixtures, decode mixed physical records, and compare them with the canonical packed representation. Removing it would also remove enforcement.

**Delete the command immediately when packed rows reach `master`.** Older open branches would then need ad hoc scripts or manual snapshot regeneration after retargeting, increasing conflict risk and making decoded-event preservation harder to review.

## Verification

- The live open-PR inventory at removal time (2026-08-20) found zero open pull requests; no branch carried session-format JSONL changes depending on the migration command.
- The temporary CLI, root package command, every branch-convergence link, and the command-specific gate diagnostic are absent; the permanent canonicalizer, its unit tests, and the snapshot check remain.
- Record/refresh write-back canonicalization is exercised by the acp-snapshot suite's record-suite fixture; the repository-wide layout gate, `pnpm run doc-sync`, lint, and whitespace validation pass without the temporary command. (Two snapshot scenarios fail before and after this change from unrelated pre-existing fixture defects tracked by the fork CI issues.)
- Current documentation describes only the packed default and permanent canonical-layout enforcement.

## Consequences

A branch that still carries an unpacked fixture edit converges by re-running refresh (`pnpm run test:snapshot:refresh`) or by calling `canonicalSessionFixture` on the file; there is no repository-wide mutation command to run by accident, and the permanent gate names the exact non-canonical files.
