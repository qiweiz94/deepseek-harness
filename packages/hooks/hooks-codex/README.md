# @deepseek-ai/dsh-hooks-codex

English | [中文](README.zh.md)

A cordis plugin that runs the supported subset of a user's existing **Codex** hook config on the harness's canonical interception points. The **Codex dialect** half of the hooks subsystem. The dialect-agnostic primitives come from [`@deepseek-ai/dsh-hook-protocol`](../hook-protocol/README.md); this bridge owns the Codex-shaped payloads, matcher mode, and decision mapping.

This bridge implements a deliberate subset of Codex's current hook protocol:

- **Five of ten hook points:** `PreToolUse`, `PostToolUse`, `SessionStart`, `UserPromptSubmit`, and `Stop`.
- **Regex-only matchers** (no literal fast path; the matcher is always an unanchored regex).
- **snake_case stdin payloads** with `turn_id`/`model` extras, written **without** a trailing newline.
- **No Codex plugin env injection and no config-time placeholder substitution** (the command still receives the executor's environment and runs through its shell).
- **No pre-tool approval or rewrite path** — a hook can block, but the bridge does not pre-approve or replace tool input.

A native cordis plugin could do everything this bridge does, more powerfully; the bridge exists only as a compatibility path for the mapped Codex subset (see [the interception extension-points Agent Note](../../../.agents/notes/implemented/feature/2026-06-30-interception-extension-points.md)).

## Config

```ts
import type { Config } from '@deepseek-ai/dsh-hooks-codex'
const config: Config = {
  configPath: '/path/to/.codex/hooks.json', // required
  sessionConfigFile: '.codex/hooks.json',    // optional: per-session project-local discovery, resolved against each session's cwd
  trustedWorkspaceRoots: ['/path/to/trusted/project'], // optional: workspace roots whose sessionConfigFile hooks may run; default [] denies every workspace
  model: 'deepseek-v4',                      // optional: stamped on every payload (Codex includes `model`)
  defaultTimeoutMs: 600_000,                 // optional: per-hook timeout when a hook sets none
  stderrSummaryMaxChars: 500,                // optional: char cap on the hook/result event's persisted stderr summary
  maxConsecutiveStopBlocks: 8,                // optional: consecutive Stop-hook forced continuations allowed per turn before the block is overridden (borrows Claude Code's guard default; Codex documents no cap of its own)
}
```

In a `cordis.yml`:

```yaml
- dsh-hooks-codex:
    configPath: ./.codex/hooks.json
    sessionConfigFile: .codex/hooks.json
    trustedWorkspaceRoots:
      - .
    model: deepseek-v4
```

The process-level `configPath` is parsed **once** at load — a relative path resolves against the process launch cwd at load time, so a single config applies to the whole process. An optional `sessionConfigFile` adds per-session project-local discovery — a path resolved against each agent session's workspace (`session/new.cwd`), read and parsed once per session at first hook use; its groups run *after* the process-level groups on each point, and a session workspace without the file simply has no session hooks. Because a `sessionConfigFile` runs arbitrary shell from the session's own tree before any user action, discovery is **default-deny**: a session's file is read and run only when its workspace cwd is one of `trustedWorkspaceRoots` (absolute, or relative to the process launch cwd), or nested under one; every other workspace is skipped with a one-time warning and contributes nothing. An empty or unset `trustedWorkspaceRoots` trusts no workspace, so a freshly cloned untrusted repo cannot plant a `sessionConfigFile` that executes. Roots are matched by resolved path with no symlink resolution, so list a root in the same form the session reports its cwd (e.g. `/private/tmp/proj`, not `/tmp/proj`, on macOS); a relative root resolves against the process launch cwd read at load, so prefer an absolute root when that launch cwd is ambient. A `configPath` read/parse failure is contained; an invalid regex matcher on an event that consumes matchers is one such failure and reports its pattern and event. With no `sessionConfigFile` configured the failure logs and registers nothing; otherwise the bridge keeps running on session-local discovery alone, and a session-local file's own read/parse failure is contained the same way, scoped to that one session. Only sync `type: 'command'` hooks run — a non-command or `async: true` hook is parsed-and-skipped with a warning. A hook accepts `timeout` or the `timeoutSec` alias; one that sets neither runs under the protocol's reference default (`DEFAULT_HOOK_TIMEOUT_MS` from `dsh-hook-protocol`, 10 minutes). Events outside the five bridge-supported points are dropped at parse.

The hooks themselves run in the agent's session workspace: for the agent-scoped points the bridge passes the session's `cwd` as the hook process's working directory, so a hook operates in the user's project tree, not the server launch dir.

## Hook points → typed Decisions

| Codex hook | Harness point | Mapping |
|---|---|---|
| `SessionStart` | `agent/session-start` (emit) | a plain-stdout hook's output → additionalContext → claimed and awaited by the first `agent/pre-step` step, folded into its messages (bounded by the hook timeout); `agent.inject()` when no step claims it |
| `UserPromptSubmit` | `agent/pre-step` (waterfall) | `block` (exit 2) → `PreStepDecision.reject`; `continue:false` → halts the run; additionalContext-only → delegate via `next()` then append a separately sourced message to a downstream `enter` decision |
| `PreToolUse` | `tools/pre-execute` (waterfall) | `block` → `PreToolDecision.deny` (no `allow`/`ask`); `continue:false` → halts the run and denies the tool |
| `PostToolUse` | `tools/post-execute` (waterfall) | `block` → `block` with feedback; `continue:false` → halts the run (after the tool ran); additionalContext-only → delegate via `next()` then prepend a separately sourced context to the downstream decision; Code Mode defers sub-call contexts until the outer `run_code` result |
| `Stop` | `agent/turn-stopping` (serial) | a blocking Stop hook feeds its reason through `steer()`, forcing another step, up to `maxConsecutiveStopBlocks` consecutive times per turn; `continue:false` overrides a block and lets the turn close |

A tool call's payload carries the real `tool_name` (the same value the matcher tests) and Codex's `tool_input: { command }` shape (the `command` arg when present, else `''`). The matcher subject is the tool name (`PreToolUse`/`PostToolUse`) or the session source (`SessionStart`); `UserPromptSubmit`/`Stop` ignore matchers.

Every agent-scoped stdin payload carries `session_id` and `transcript_path`. The bridge resolves the latter through `ctx.sessionPersistence.locate(session.header)` when available and otherwise sends `null`, preserving the Codex `string | null` shape. Lookup does not create or flush the artifact, so a path can be absent before the first turn-end checkpoint or omit the current open turn.

`SessionStart` — the one emit point — runs detached; each run chain is tracked, and disposing the bridge aborts a still-running hook process, then drains the continuation before the dispose resolves (`createDetachedRuns` in `dsh-hook-protocol`).

## Context source

Injected context carries an explicit `{ kind: 'plugin', plugin: 'hooks-codex' }` source so the durable message is never mistaken for a user prompt.

## Model Experience

### Hook-provided context

#### What the model sees

`SessionStart`, accepted prompt, and post-tool hooks can add source-attributed context messages; a blocking `Stop` hook adds its reason as next-step steering.

#### Token effect

No cost when hooks return no context. Hook text is data-dependent, logged, and resent until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Blocked prompt or tool outcome

#### What the model sees

Provider-supplied reasons pass through verbatim. When absent, a blocked prompt uses exactly `blocked by UserPromptSubmit hook`, a denied tool becomes `Error: blocked by PreToolUse hook`, blocked post-tool feedback is exactly `blocked by PostToolUse hook`, and a blocking stop adds steering exactly `continue: blocked by Stop hook`. Codex `systemMessage` is not surfaced.

#### Token effect

Blocking a prompt removes its request tokens; denial or feedback adds the retained fallback or provider text; forced continuation pays another full request.

#### KV Cache effect

A blocked prompt sends no request and invalidates nothing. Denial, feedback, and forced-continuation context append after the reusable prefix without rewriting it.

## Known Limitations and Deferred Work

- **Unsupported hook events (5 of Codex's current 10):** `PermissionRequest`, `PreCompact`, `PostCompact`, `SubagentStart`, and `SubagentStop`. Config for these events is silently dropped during parsing. The comparison baseline is Codex's [official hook reference](https://learn.chatgpt.com/docs/hooks).
- **`SessionStart` is partial:** plain stdout and JSON `additionalContext` work. The hook runs detached; its resolved context is claimed by the first `agent/pre-step` and folded into that step's messages, so delivery is a bounded stall on the hook's timeout rather than a race against the first request — a step that never claims it falls back to `agent.inject`. Like the other emit points it fires with no open turn, so a `{"continue": false}` there is neither recorded nor honored.
- **`UserPromptSubmit` is partial:** blocking plus plain-stdout or JSON context work, and `{"continue": false}` now halts the run; the common `systemMessage` control is still not enforced.
- **`PreToolUse` is partial:** blocking (including `{"continue": false}`, which also halts the run) works, but `additionalContext`, `permissionDecision: "allow"`, and `updatedInput` are ignored. Every tool is represented as `tool_input: { command }`, so non-shell tool arguments are not faithfully exposed to the hook.
- **`PostToolUse` is partial:** blocking feedback, JSON `additionalContext`, and `{"continue": false}` (which halts the run after the tool ran) work, but non-shell tool arguments are reduced to `{ command }` and structured tool output is flattened to text in `tool_response`.
- **`Stop` is partial:** blocking forces another model turn (up to `maxConsecutiveStopBlocks` consecutive times per turn — default 8, borrowed from Claude Code's own guard since Codex documents no cap of its own — after which the block is overridden and the turn is allowed to stop), and `stop_hook_active` truthfully reports whether a Stop hook already forced continuation this turn. `last_assistant_message` is still always `null`.
- **Common payload and output fields are partial:** every mapped event reports the statically configured `model` and `permission_mode: "default"` instead of current Codex runtime values. `systemMessage` is logged + warned but not surfaced. `{"continue": false}` halts the active run at `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `Stop` — mapped to an `AgentCancelCause` of kind `hook` that aborts the turn; `stopReason` becomes the cancel reason (falling back to a point-named reason when absent) rather than applying Codex's own event-specific stop behavior.
- **Config loading and execution are partial:** one process-level `configPath` is parsed at load; an optional `sessionConfigFile` adds per-session project-local discovery on top (see Config, above). Codex's active user, project, session, system/managed, and plugin layers beyond that, trust controls, and inline `config.toml` hook form are not implemented. Only synchronous `command` handlers run, current metadata such as `statusMessage` and `commandWindows` is ignored, and matching handlers run serially rather than with Codex's concurrent launch semantics.
