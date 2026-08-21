# Agent Note: diagnostic-sifter contains targetPath to the working directory

Status: implemented

English | [中文](2026-08-21-sifter-targetpath-containment.zh.md)

## Problem

`@deepseek-ai/dsh-plugin-diagnostic-sifter`'s `run_diagnostic_check` tool takes a model-supplied `targetPath` and appends it verbatim to the spawned `vitest run` / `tsc -b` argv (`src/index.ts`). The only defense was a leading-dash check (option injection). A path that escaped the configured `cwd` — `../../elsewhere`, or an absolute path — passed that check, and because `vitest run <dir>` and `tsc -b <project>` load the TARGET directory's own `vitest.config.ts` / `tsconfig.json`, a check could load and execute a foreign config: arbitrary code execution outside the project, or a build of an unrelated tree. The tool's schema documented `targetPath` as "relative to the working directory," but nothing enforced containment.

## Decision

Contain `targetPath` to `cwd` before it becomes an argv, in a small pure helper `containTargetPath(raw, cwd)`:

- Keep the leading-dash / empty rejection (option injection).
- Resolve the path against `cwd` and take `relative(cwd, resolve(cwd, raw))`; reject when it starts with `..` (a relative or absolute escape both surface this way on POSIX) or is absolute (a different Windows drive). Pass the contained cwd-relative path (`.` for the cwd itself).
- The model-visible schema description and the README/`README.zh` now state the path is contained within the working directory, so the enforced contract matches the documented one.

Deliberately did **not** add a `--` argv separator (the issue suggested it): the leading-dash check already fully prevents option injection for a single non-shell argv element, so `--` adds no marginal security, while it risks breaking `targetPath` targeting — `vitest`'s cac parser and `tsc -b` treat a post-`--` token differently from a positional, which would silently drop the scope filter. Containment is the security fix; `--` is not needed.

## Alternatives considered

- **Only add `--`, per the issue** — rejected: `--` does not stop path traversal (the actual vulnerability), and risks a silent targeting regression. Containment is what closes the hole.
- **Resolve to an absolute path and pass that** — rejected in favor of passing the validated cwd-relative path: it keeps the argv within the documented "relative to cwd" contract and reads the same in transcripts, and the checks already run with `cwd` as their working directory.
- **realpath / symlink resolution** — not added: matches the `#58` decision — containment compares resolved paths without following symlinks (fail-closed), and no consumer needs symlink normalization here.

## Consequences

- A `targetPath` that escapes `cwd` is now a tool error before any spawn; the four validation arms (empty/dash, `..`-escape, absolute-outside, valid nested, and the cwd itself) are covered, per-file 100% holds. The absolute-`rel` arm is Windows-only and carries a `/* v8 ignore */` with the same justification as `workspaceTrustPredicate` (#58).
- `run_diagnostic_check` is not in a pinned tool-schema snapshot (not in the `text-turn` ACP scenario), so the model-visible description change needs no snapshot re-record.
- This is one of a class of model-controlled-path tools (semantic-patcher already refuses `..`/absolute); the sifter now matches that posture.
