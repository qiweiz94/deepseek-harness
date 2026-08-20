# @deepseek-ai/dsh-plugin-diagnostic-sifter

English | [中文](README.zh.md)

The model-facing `run_diagnostic_check` tool: run the project's own typecheck or test binary, collapse the diagnostics that one defect fanned out across the codebase onto the diagnostic that caused them, and return a compact JSON result instead of a full compiler or runner transcript.

## What it does

Registers one tool on `ctx.tools`:

- `run_diagnostic_check(command, targetPath?)` spawns the configured executable for `command` (`typecheck` → `node_modules/.bin/tsc -b`, `test` → `node_modules/.bin/vitest run`), optionally narrowed by `targetPath`, and returns `{ success, rootCauses, suppressedCascadeCount }`.

Each root cause carries `file`, `line`, `code`, and `message`. `success` is true only when the command exited 0 and no diagnostic parsed. A non-zero exit that matched no diagnostic pattern still returns a cause, coded `nonzero-exit`, carrying the first non-blank output line — a failure never comes back as an empty list.

## Cascade collapsing

One defect produces one diagnostic per affected site: a module that fails to resolve is reported at every import, and a renamed export is reported at every use. Those repeats are the cascade, not the cause.

- Diagnostics repeating the same code and the same text collapse onto their first occurrence.
- The module-resolution and export-shape codes (`TS2307`, `TS2305`, `TS2503`, `TS2614`, `TS2688`, `TS2724`) collapse on the code plus the first quoted subject in the message, because the trailing "Did you mean" hint varies per site while the cause does not.
- Groups rank by how many sites they reached, so the most-repeated cause comes first; ties keep emission order. `maxRootCauses` (default 3) caps how many are reported.

`suppressedCascadeCount` is every parsed diagnostic NOT listed: collapsed repeats plus groups ranked below the cap. It is a count of what the model is not seeing, never an "upstream was incomplete" signal.

For `test`, passing cases and progress lines never match a failure pattern and are dropped, and only the first repository-owned stack frame of each failure is kept: frames in `node_modules` or under `node:` locate the runner, not the defect.

## Output retention envelope

Both child streams are captured through the `@deepseek-ai/dsh-output-retention` `TextRetainer` (`head` strategy) at `maxOutputBytes` (default 15 KB), so a compiler or runner emitting megabytes never holds more than the envelope in memory, and the head — where the diagnostics are — is what survives.

The returned value is then bounded to `maxResultBytes` (default 1,000 bytes, under 1 KB): messages are truncated by Unicode code points down a fixed ladder, and only if that is not enough is the lowest-ranked cause dropped into `suppressedCascadeCount`.

## Process model

Every child goes through `ctx.subprocess`, so process spawning, stream collection, and tree-scoped termination stay in the subprocess seam; the plugin owns only orchestration, parsing, and ranking. A configured executable that is a relative path is anchored to `cwd` before spawning, because Node resolves a relative executable against the parent's working directory rather than the child's; a bare command name is left alone for the child's `PATH` to resolve. `timeoutMs` (default 5 minutes) aborts the process tree, and the model's `targetPath` is always passed as its own argv entry — nothing is shell-interpreted.

## Export shape

A function/namespace plugin: it exports `name` / `inject` / `Config` / `apply` and NO default. A stray `export default` would collapse the module via the Loader's `unwrapExports` and drop `inject` (see [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).

## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`run_diagnostic_check` schema](../../../docs/tool-catalog.md#deepseek-aidsh-plugin-diagnostic-sifter): a required `command` enum (`typecheck` or `test`) and an optional `targetPath` string. Which binary each command runs, the retention envelope, the result budget, the cause cap, and the timeout are plugin config validated at load; they change no schema field, only what the check executes and how much of it comes back.

#### Token effect

Fixed schema cost on every request where the tool is visible. The result is bounded by `maxResultBytes`, so a failing whole-repository build and a single failing file cost the model the same order of tokens — the saving over reading a raw transcript grows with the size of the failure.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from this schema; the check itself happens inside the call and never enters the request prefix.

## Known Limitations and Deferred Work

- **Two reporter dialects only** — the parsers recognise `tsc` (plain and `--pretty`) and Vitest's default reporter. Another compiler, another runner, or a JSON/JUnit reporter parses as no diagnostics, so a failing run degrades to the single `nonzero-exit` cause rather than named causes.
- **Cascade grouping is heuristic** — two genuinely independent defects that produce byte-identical diagnostics, or two unrelated failures of the same cascade code against the same quoted subject, count as one cause with the rest suppressed. The count always states how many were held back.
- **First line per diagnostic** — related-information lines, source excerpts, and assertion diffs are dropped, so a cause whose meaning lives in its excerpt comes back thinner than the raw transcript.
- **Foreground only** — a check occupies the tool call until it finishes or `timeoutMs` elapses; there is no background/job mode, and a timed-out run reports whatever its partial output parsed to.
- **No incremental state of its own** — `tsc -b` build info and the runner's cache are whatever the repository already has; the tool neither seeds nor invalidates them, so a first call after a clean checkout pays the full build.
- **Local processes only** — the check runs where the harness runs; there is no remote or containerised execution mode.
