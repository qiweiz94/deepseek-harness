# Agent Note: Impacted-tests selector plugin

Status: implemented

English | [中文](2026-08-20-plugin-impacted-tests.zh.md)

## Problem

After editing source, the only ways to know whether a change broke anything are running the whole test suite (slow — 13,000+ tests) or guessing which suites are relevant. A model has no cheap, targeted verdict: it either pays for the full run or skips testing and hopes. The information to do better already exists — the workspace's import graph tells you exactly which suites transitively import a changed file — but nothing exposes it as a tool.

## Decision

`@deepseek-ai/dsh-plugin-impacted-tests` registers `run_impacted_tests({ files? })`. It builds the repository's import graph from the tsconfig `paths`, finds every test suite that transitively imports any file in the changed set (given `files`, or the working tree's uncommitted changes when omitted), and runs strictly those suites through the configured runner, returning the bounded runner output. A changed file that no suite imports (a Markdown doc, say) selects nothing — that is the answer, not a failure. It injects `tools` and `subprocess`; suite paths come from the analyzer, never raw model input, and the runner argv is never shell-interpreted.

Integration fix: the parallel branch defaulted `runnerCommand` to `['pnpm', 'exec', 'vitest', 'run']`, but `pnpm exec` is keel-blocked in this repo (no-remote-exec). The default is changed to `['node', 'node_modules/vitest/vitest.mjs', 'run']`, the same keel-safe invocation the rest of the repo uses to run vitest out of band. The plugin arrived without an Agent Note; this note is supplied at integration.

## Alternatives considered

**Select suites by path heuristics (same directory, same package).** A file's blast radius crosses package boundaries through imports; a directory heuristic both misses cross-package impact and over-selects unrelated siblings. The import graph is the precise answer.

**Default to `pnpm exec vitest`.** Convenient, but keel's no-remote-exec rule blocks it in this repo; the `node node_modules/vitest/vitest.mjs` form is the invocation that actually runs here, and it stays a config field so a different deployment can override it.

## Consequences

A model gets a fast, precise test verdict scoped to what a change can actually break, at a fraction of a full run — an unimpacted change returns a single line. The selection is only as accurate as the import graph the tsconfig describes; a dependency expressed outside `paths` resolution is unseen. The runner output is bounded by `maxOutputBytes` per stream.
