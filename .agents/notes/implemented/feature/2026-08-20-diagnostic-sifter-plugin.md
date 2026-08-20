# Agent Note: Diagnostic sifter plugin

Status: implemented

English | [中文](2026-08-20-diagnostic-sifter-plugin.zh.md)

## Problem

Running the repository's own typecheck or a scoped test run as a tool call returns raw `tsc -b`/`vitest run` output: hundreds of lines where one broken export cascades into dozens of downstream `TS2307`/`TS2724` errors, and a failing test run mixes passing-test noise, code frames, and stack traces with the one assertion that actually failed. A model consuming that output either burns context re-reading fallout it cannot act on, or a caller that truncates blindly can turn a real, explained failure into something indistinguishable from a silently broken parser.

## Decision

**A new model-facing plugin, `@deepseek-ai/dsh-plugin-diagnostic-sifter`, registers one `run_diagnostic_check` tool** that spawns the configured `tsc -b --pretty false` build or `vitest run` (via `ctx.subprocess`, never a hardcoded tunable — argv, cwd, and timeout are all `Config` fields) and returns only the root-cause diagnostics.

**Cascade suppression is targeted, not global.** `TS2307`/`TS2724` diagnostics carry the module specifier they reference; a diagnostic of one of these codes is suppressed only when that specifier resolves (by basename) to a file that ALSO has its own retained diagnostic in the same run. A `TS2307` for a module that is simply missing — with no matching retained diagnostic elsewhere — stays a root cause. (An earlier draft suppressed every `TS2307`/`TS2724` whenever any other diagnostic was present in the run, which silently dropped genuinely independent missing-module errors; the real captured fixture under `tests/fixtures/tsc-failing.txt` exposed this before it shipped.)

**A parse failure is judged on the pre-envelope sift result, never the post-envelope one.** `boundRootCauses` can legitimately reduce a non-empty `rootCauses` list toward empty under a tiny `maxOutputBytes` — that is envelope truncation (`truncated: true`), not an unparseable run. `parseFailure` is computed from the sifter's own `recognized`/`rootCauses` output before bounding, so a tiny envelope truncates without ever being misreported as "could not parse this output."

**All three of stream capture, the root-cause list, and the raw parse-failure fallback share `maxOutputBytes`** through `@deepseek-ai/dsh-output-retention`'s `TextRetainer` (`head` strategy), so the tool never buffers more than the envelope allows at any stage. `NO_COLOR=1` is fixed in the spawn environment (protocol hygiene for the sifter's plain-ASCII regexes, not a deployment tunable) since a startup-time failure (e.g. an unresolvable vitest config) is formatted by Vite's own reporter, which colorizes unconditionally regardless of TTY.

**Sifting is pure and unit-tested against real captured output.** `siftTypecheck`/`siftTest`/`boundRootCauses`/`retainRaw` in `src/sifter.ts` take no `ctx` and do no I/O; `tests/fixtures/*.txt` are real `tsc --pretty false`/`vitest run` output (TypeScript 6.0.3, vitest 4.1.8, `NO_COLOR=1`, piped to a file — never hand-authored), captured once and replayed, with synthetic strings reserved for boundary branches (dedupe, an unrecognized cascade target, exact/tiny/multibyte byte budgets) a real capture cannot reliably reproduce.

## Alternatives considered

**Suppress every `TS2307`/`TS2724` whenever any other diagnostic is present in the run.** Rejected (see Decision): it conflates "downstream of a real break" with "coincidentally sharing a resolution-failure code," dropping independently broken imports from the model's view.

**Compute `parseFailure` from the bounded (post-`maxOutputBytes`) root-cause list.** Rejected: it makes envelope size and parse-failure classification the same signal, so a caller with a small envelope sees false "could not parse this output" reports for runs that parsed perfectly.

**Let `tsc`/`vitest`'s own TTY detection handle color.** Rejected for the spawn environment: verified empirically that vitest's own reporter does honor a non-TTY pipe, but a config-load failure is rendered by Vite's separate error formatter, which does not — `NO_COLOR=1` closes that gap unconditionally rather than depending on a code path that only sometimes checks.

## Consequences

A composition loading the plugin exposes one `run_diagnostic_check` verb that turns a repository typecheck or test run into a bounded, root-cause-only diagnostic list, with cascade suppression and truncation each reported through their own field rather than collapsed into a single ambiguous failure state. Misconfiguration (an empty `tscArgs`) fails loud at `apply`. `tsc -b` requires a composite/solution `tsconfig.json` in the target project; a non-default vitest reporter is not recognized by the parser and surfaces as a loud `parseFailure` rather than a silent clean run — both are documented, deferred limitations rather than something the tool corrects on the caller's behalf.
