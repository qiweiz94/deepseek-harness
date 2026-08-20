# Agent Note: Keyless snapshots for subagent-router and worktree-sandbox

Status: implemented

English | [中文](2026-08-20-keyless-snapshots-subagent-router-worktree-sandbox.zh.md)

## Problem

The 2026-08-19 audit deferred keyless snapshot coverage for `plugin-subagent-router` and `plugin-worktree-sandbox` "until the harness supports keyless replay for these plugin bundles". That premise went stale: `llm-replay` supports hand-authored override sidecars and child replay files, `loader-smoke` exposes a `prepare` hook for runtime fixtures, and the `subagent-inheritance` scenario already boots the whole subagent stack keylessly. Meanwhile the recording key was burned, so any design requiring a live re-record was off the table. Separately, the committed `ast-context` goldens predated the `meta.outline` feature (4b2a0c1fd5) and failed replay everywhere — the failure was misfiled as Linux-specific under the CI issue.

## Decision

Two independent scenarios in `examples/headless-agent`, both fully hand-authored (no API key at any point):

[subagent-router](../../../../examples/headless-agent/subagent-router.cordis.snapshot.yml) mounts spawn and fork in-process providers; the router's default candidates name only `fork` while its single route (`label: trial probe`) names only `spawn`, and the replayed delegation matches the route — so the child session's durable `subagent/descriptor` naming `spawn` is physical proof that route policy, not the default list, chose the provider. The parent script is a `replay.override.json` sidecar; the child rides a synthetic `child.replay.jsonl` (`createdAt: 2` binds it by first-call order). The router registers the `subagent` tool itself, so `dsh-tool-subagent` stays out of this tree.

[worktree-sandbox](../../../../examples/headless-agent/worktree-sandbox.cordis.snapshot.yml) prepares a real git repository at the run cwd in the test's `prepare` hook, replays one `sandbox_exec` with an explicit `id` (the `randomUUID().slice(0, 8)` fallback is not a normalizable token), and asserts the isolation physically: the tool result reports the write while the main tree never gains the file and the trial worktree is removed. Skipped on win32 (host git + `sh -c`).

The stale `ast-context` goldens were re-recorded through the keyless refresh flow in the same change; the only substantive delta is the `meta.outline` payload the feature added.

## Alternatives considered

**One combined scenario (router delegates a sandbox trial).** The sandbox tool needs no subagent stack; combining forces its call through a hand-authored child script for no additional evidence and couples two failure domains.

**Recording the scenarios live.** Requires a fresh API key for a behavior that replay fixtures express exactly; the burned key made this a non-starter and the hand-authored path is the stronger precedent.

**Routing to `fork` instead of `spawn`.** Fork children carry a seed-length header contract that makes hand-authoring fragile; routing to `spawn` keeps the fixture simple while still proving route-over-default selection.

## Consequences

Both plugins now carry assembled-app keyless evidence, closing audit item E. The snapshot suite grows to 15 files; `examples/package.json` declares both plugin packages. The `ast-context` item disappears from the Linux-replay issue, which shrinks to the pwsh header and minimal-preset snapshot cases. Any future change to the router's tool schema or the sandbox result surface must re-record these goldens through `test:snapshot:refresh`.
