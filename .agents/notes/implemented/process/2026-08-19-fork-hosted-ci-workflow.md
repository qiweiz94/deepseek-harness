# Agent Note: Fork-hosted CI workflow

Status: implemented

English | [中文](2026-08-19-fork-hosted-ci-workflow.zh.md)

## Problem

[CI](../../../../.github/workflows/ci.yml) resolves its required Linux lanes through enterprise runner pools and self-hosted labels (`vm-backup`, `dsh-win-ci`) that only the upstream repository provides. On a personal fork every CI run dies at startup with zero jobs, so fork pull requests and fork master pushes merge with no executed gate evidence at all; the only workflow runs a fork accumulates are GitHub-managed Copilot reviews. Editing `ci.yml` to retarget hosted runners would put every upstream sync into permanent merge conflict.

## Decision

A separate workflow, [Fork CI](../../../../.github/workflows/fork-ci.yml), runs the full local gate set on standard `ubuntu-latest` runners. Every job is guarded with `github.repository_owner != 'deepseek-ai'`, so the file is inert if it ever rides a pull request into upstream, and `ci.yml` stays untouched, so upstream syncs stay conflict-free.

Three parallel jobs reuse the gate aggregates in [run-gates](../../../../scripts/run-gates.ts) through `pnpm run` scripts (the runner requires `npm_execpath`): `static` runs `check:ci:static` plus explicit `typecheck` and `verify-third-party-notices` steps, because `typecheck` lives only in `ci-primary` and the notices check in no aggregate; `coverage` runs `check:ci:coverage`; `consumers` runs `check:ci:consumers` after installing Playwright Chromium behind an `actions/cache` keyed on `pnpm-lock.yaml`. The `docs:build:mpa` gate inside `ci-static` is the site-build signal, matching upstream's required Linux lanes. Worker budgets are pinned to the 4-core hosted shape (`DSH_COVERAGE_MAX_WORKERS=4`, `DSH_GATE_CONCURRENCY` 2/4), because `ci-consumers` otherwise defaults its concurrency to the gate count. Triggers and the concurrency group mirror `ci.yml`: pull requests cancel superseded runs, master pushes never do.

## Alternatives considered

**Retarget `ci.yml` itself with fork-conditional `runs-on` expressions.** Every upstream sync of that file becomes a merge conflict, and the conditional expressions would ship upstream where they are noise.

**A single serial job running `check:all`.** One job halves the runner-hour cost but serializes coverage behind build and snapshots; the three-lane split matches upstream's proven partition and keeps the slowest lane (coverage under v8 instrumentation) independent.

**Skip the heavy lanes and run only lint plus unit tests.** That reverts to a weaker gate set than local sessions already run by hand, and per [testing policy](../../../../docs/testing.md) `test:coverage`, not `test`, is the CI coverage gate.

## Consequences

Fork pull requests and master pushes get merge-blocking evidence for the complete local gate set on free hosted runners. The coverage lane is the long pole: 13,524 tests under v8 instrumentation on 4 cores against an upstream budget of 6 workers on 16; its `timeout-minutes: 120` accepts slow feedback, and if it proves slower still the follow-up is sharding, never downgrading to uninstrumented `test`. Windows, real-API e2e, release packaging, and the Python release matrix remain upstream-only signals; the fork workflow does not attempt them.
