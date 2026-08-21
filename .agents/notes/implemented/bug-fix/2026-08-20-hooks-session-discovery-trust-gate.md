# Agent Note: per-session hooks.json discovery is default-deny behind a workspace-trust gate

Status: implemented

English | [中文](2026-08-20-hooks-session-discovery-trust-gate.zh.md)

## Problem

Both hook bridges (`@deepseek-ai/dsh-hooks-claude-code`, `@deepseek-ai/dsh-hooks-codex`) support an optional `sessionConfigFile` — a project-local `hooks.json` discovered per session, resolved against each session's workspace cwd, read once at first hook use. The shared discovery cache (`createSessionHookConfigCache` in `@deepseek-ai/dsh-hook-protocol`) read and ran that file for **any** session cwd, with no trust gate. A `hooks.json` runs arbitrary shell (`PreToolUse`, `SessionStart`, …) before any user action, so a session opened in a freshly cloned, untrusted repository could plant a `hooks.json` that executed the moment the agent touched the workspace — a code-execution hole that needed no user opt-in and produced no signal.

## Decision

Make per-session discovery **default-deny**, gated on an explicit workspace-trust predicate.

- `createSessionHookConfigCache` gained two opts: an optional `isWorkspaceTrusted(cwd): boolean` predicate and a **required** `warnUntrusted(cwd, agentId)` callback. Before reading a session's file, the cache checks the predicate; an absent predicate or a `false` result skips the read entirely (the planted file is never opened), warns once, and caches `empty` for that agent. `warnUntrusted` is required (not optional) so TypeScript fails the build at any bridge call site that forgets to wire it — the enforcement is in the type, not in reviewer diligence.
- A new exported helper `workspaceTrustPredicate(roots, launchCwd)` builds the predicate a bridge passes in: it returns `undefined` when no roots are configured (so the cache trusts nothing), else a predicate that trusts a session cwd equal to, or nested under, one of the deployment-configured roots (each resolved against the process launch cwd). Containment is decided by `path.relative` after `resolve` — a `..` prefix or an absolute relative result (a different Windows drive) is outside the root.
- Both bridges gained a `trustedWorkspaceRoots: string[]` config field (default `[]`). The bridge calls `workspaceTrustPredicate(config.trustedWorkspaceRoots, process.cwd())` and passes the predicate (only when defined) plus a bridge-prefixed `warnUntrusted` into the cache. Default `[]` ⇒ predicate `undefined` ⇒ every workspace denied, so a deployment must name a trusted root before any project-local hook runs.

Trust is matched on resolved paths with **no** symlink resolution: a root must be listed in the same form the session reports its cwd (e.g. `/private/tmp/proj`, not `/tmp/proj`, on macOS). This fails closed — a mismatch denies rather than over-trusts — and is documented in both READMEs alongside the note that relative roots resolve against the ambient process launch cwd, so absolute roots are the robust form.

## Alternatives considered

- **Default-allow with an opt-out denylist** — rejected: inverts the safe default. The whole defect is that discovery ran without anyone opting in; a denylist leaves the hole open for every workspace not yet named.
- **Resolve symlinks (`realpath`) before matching** — rejected for this change: it changes a fail-closed mismatch into a fail-open risk if `realpath` disagrees with how the session records its cwd, and adds a filesystem stat on a security decision. Listing the root in the reported form is the documented, predictable contract; realpath normalization can be revisited if a concrete deployment needs it.
- **Make `warnUntrusted` optional** — rejected: an optional warning is one a bridge silently forgets, turning a security skip into an invisible one. Required-in-the-type means every current and future bridge must account for the denied path.
- **Put the trust check inside each bridge instead of the shared cache** — rejected: the read happens in the shared cache, so the gate must sit where the read is, or an alternate caller bypasses it (`packages/AGENTS.md`: "Enforce a decision in the operation that makes it").

## Consequences

- Existing deployments that set `sessionConfigFile` but not `trustedWorkspaceRoots` stop running project-local hooks and emit a one-time warning per workspace. No shipped `cordis.yml` (checked: `examples/`, bundles, presets) sets `sessionConfigFile`, and no keyless snapshot exercises session discovery, so nothing in-repo ships broken and no snapshot re-record was required.
- The seven existing bridge/cache discovery tests were updated to configure a trusted root (encoding "discovery works *for a trusted workspace*"), and new tests cover default-deny, predicate-`false`, and the `workspaceTrustPredicate` helper (exact/nested/parent/sibling). The pre-release stance (`CLAUDE.md`: foundation over compatibility, no external consumers) sanctions the breaking default.
- A future bridge adding project-local discovery inherits the gate for free by wiring the two cache opts; the compiler refuses the wiring that omits `warnUntrusted`.
