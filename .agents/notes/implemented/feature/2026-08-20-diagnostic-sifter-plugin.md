# Agent Note: Diagnostic sifter plugin

Status: implemented

English | [中文](2026-08-20-diagnostic-sifter-plugin.zh.md)

## Problem

A model that runs the project's typecheck or test suite through a shell tool has to read the whole transcript to find the defect. The transcript is mostly noise it must pay tokens for: one unresolved module is reported at every import site, one renamed export at every use, and a failing test run prints every passing case plus stack frames that locate the runner rather than the defect. The signal — which few diagnostics actually explain the failure — is buried, and a large failure costs proportionally more context than a small one.

## Decision

**A new model-facing plugin, `@deepseek-ai/dsh-plugin-diagnostic-sifter`, registers one `run_diagnostic_check` tool** taking a `command` enum (`typecheck` or `test`) and an optional `targetPath`. It spawns the configured executable for that command — `node_modules/.bin/tsc -b` and `node_modules/.bin/vitest run` by default — and returns `{ success, rootCauses, suppressedCascadeCount }` instead of the transcript.

**Cascades collapse onto their cause.** Diagnostics repeating the same code and text collapse onto the first occurrence. The module-resolution and export-shape codes (`TS2307`, `TS2305`, `TS2503`, `TS2614`, `TS2688`, `TS2724`) collapse on the code plus the first quoted subject, because the trailing "Did you mean" hint varies per import site while the cause does not. Groups rank by how many sites they reached, so the widest cascade — the most likely cause — comes first, and `maxRootCauses` (default 3) caps the report. `suppressedCascadeCount` states how many parsed diagnostics the model is not seeing, so the omission is never silent.

**The result is bounded twice.** Both child streams are retained through the `@deepseek-ai/dsh-output-retention` `TextRetainer` (`head` strategy) at `maxOutputBytes` (default 15 KB), so a compiler emitting megabytes never holds more than the envelope; the head is where the diagnostics are. The returned value is then fitted to `maxResultBytes` (default 1,000) by truncating messages down a fixed code-point ladder and only then dropping the lowest-ranked cause into the suppressed count.

**A failure always names something.** A non-zero exit that matched no diagnostic pattern still returns one cause coded `nonzero-exit` carrying the first non-blank output line, so an unrecognised reporter degrades to a thin answer rather than an empty list that reads as success.

**All processes go through `ctx.subprocess`.** The plugin owns orchestration, parsing, and ranking only. A relative configured executable is anchored to `cwd` before spawning, because Node resolves a relative executable against the parent's working directory rather than the child's; `targetPath` is always a separate argv entry and nothing is shell-interpreted.

## Alternatives considered

**Let the model call the existing bash tool and read the transcript.** Rejected: that is the status quo whose token cost this note is about, and the bash tool's byte envelope truncates the tail, which is exactly where a compiler prints its error count and a runner prints its failed-test section.

**Return the raw transcript filtered by a regular expression.** Rejected: filtering removes lines but not the cascade — forty copies of one missing-module error survive filtering intact, and the model still has to work out that they are one defect.

**Parse a machine-readable reporter (`tsc --pretty false` JSON, Vitest's JSON reporter).** Rejected for v1: neither is the output a repository's own configured scripts produce, so the tool would silently disagree with what a developer sees, and Vitest's JSON reporter needs an output file. The text parsers are documented as a limitation and can be joined by a JSON path when a consumer needs it.

**Compute `suppressedCascadeCount` as cascade repeats only, excluding causes cut by the cap.** Rejected: two numbers do not fit the compact result, and a count that excludes the cap makes the report look complete when it is not. The single number covers every parsed diagnostic that is not listed.

## Consequences

A composition loading the plugin exposes one `run_diagnostic_check` verb whose answer is bounded regardless of how large the failure is: a whole-repository build break and a single bad file cost the model the same order of tokens. Misconfiguration (a non-positive `maxResultBytes`, `maxOutputBytes`, `maxRootCauses`, or `timeoutMs`) fails loud at load. The tool is concurrency-safe because each call owns a disjoint process tree and writes no repository state.

The parsers recognise `tsc` (plain and `--pretty`) and Vitest's default reporter; another compiler or runner degrades to the single `nonzero-exit` cause. Cascade grouping is heuristic, so two independent defects producing byte-identical diagnostics count as one cause with the other suppressed — the count always says so. Related-information lines, source excerpts, and assertion diffs are dropped, so a cause whose meaning lives in its excerpt comes back thinner than the raw transcript. v1 is foreground-only and local-process-only; background trials, remote execution, and applying a suggested fix remain deferred.
