# Agent Note: budget governor — a circuit breaker for runaway child agent runs

Status: implemented

English | [中文](2026-08-20-budget-governor-child-run-circuit-breaker.zh.md)

## Problem

A delegated child agent can burn resources without ever failing: it loops on a broken tool call, rewrites the same file over and over, or grows its context far past what its task justifies. The existing guards do not stop this. `dsh-repeat-tool-reminder` is advisory — it tells the looping model to stop, but a child that ignores the advice keeps running. `dsh-timeout-policy` bounds one tool call, not a run. The delegation Consumers (`dsh-tool-subagent`, `dsh-plugin-subagent-router`) block on `SubagentRun.result` with no ceiling of their own, so the parent waits for however long the child takes. Nothing in the composition enforces a per-delegation budget.

The originating request sketched a `subagent/turn-end` event and a `ctx.subagents.abort()` method. Neither exists, and this note maps the intent onto the seams that do.

## Decision

`@deepseek-ai/dsh-budget-governor` is a function plugin (no tool, no service) that watches child runs and terminates a run that crosses a configured ceiling. It never governs the root agent: it tracks exactly the sessions announced by the subagent lifecycle events, and a root session is never announced there.

### Spec intent → real seams

| Spec fiction | Real seam used |
|---|---|
| `subagent/turn-end` event | `subagent/start` / `subagent/end` (the run lifecycle pair on `ctx.subagents`) identify child runs; `session/event`, filtered to the announced child session ids, carries the per-run telemetry: `tool/call`, `tool/result`, `assistant/message` |
| `ctx.subagents.abort()` | The child `Agent`'s own public cancellation seam: `agent.cancel({ kind: 'hook', reason })`, on the Agent that `ctx.agents.get(info.id)` resolves during the `subagent/start` notification (documented resolvable for in-process providers) |
| "abort tells the parent" | The parent report is a governor-injected `user/message` in the parent session via `parent.inject()` (see below); the delegation's own tool result independently reports the cancellation through existing machinery |

### Enforcement propagates through existing machinery only

`agent.cancel({ kind: 'hook', reason })` aborts the child's active turn; the turn closes with `turn/end { kind: 'aborted', reason: { kind: 'hook', … } }`; the in-process one-shot driver (`dsh-subagent-in-process-driver`) maps that to `stopReason: 'aborted'`; `settleForegroundRun` converts a non-`completed` stop reason into a thrown error carrying the child's partial output, which the tool registry returns to the parent model as an `isError` tool result. The run's holder keeps sole `dispose()` ownership — the governor never touches the run handle, so no new termination hook was needed and none was added.

`{ kind: 'hook', reason }` is the one `AgentCancelCause` variant built for an out-of-band policy actor and carries the governor's reason string into the durable `turn/end` record.

### The parent report channel

On termination the governor injects one structured notice into the parent agent (`parent.inject(...)`, source `{ kind: 'plugin', plugin: 'plugin-budget-governor', form: 'notice' }`). The parent is resolved from the child session's durable lineage (`child.session.header.parentSession` → `ctx.agents.get(...)`). Injection is the right channel because:

- **Model-visible ⟺ logged holds for free**: `inject` lands as a `user/message` session event in the parent log, so the report is reconstructable from the log with no new session event type.
- **Timing**: the parent's driver claims injected context at its next pre-step — immediately after the aborted delegation's `isError` tool result, so the model reads the reason next to the failure it explains.
- **Ownership**: the tool-result text belongs to the delegation Consumer (`settleForegroundRun`); rewriting it from a listener would be enforcement outside the operation that makes the decision, and would miss consumers that settle runs elsewhere (background Task settlement).

### Detectors (v1, narrow)

Per-run telemetry keyed by child session id, created at `subagent/start`, deleted at `subagent/end` (state is bounded by live runs). All ceilings are config; at least one must be configured or the plugin fails at load.

- **`maxChildTokens`** — at each child `assistant/message`, `ctx.tokenMeter.measure(childSession).totalTokens` is compared to the ceiling. This measures the child's model-visible request surface (the same replay fold compaction prices with), not provider-billed cumulative spend; the README states the semantics.
- **`maxConsecutiveToolFailures`** — a child `tool/result` whose model-facing block has `isError: true` increments the run's counter; a non-error result resets it to zero. The detector clears: one success anywhere breaks the run of failures.
- **`editChurn`** — `{ maxSameFileEdits, window, tools: [{ name, pathArgument }] }`. Each child `tool/call` whose name matches a configured edit tool contributes its extracted path to a bounded sliding window of the run's most recent `window` edit calls; the ceiling trips when one path accounts for `maxSameFileEdits` entries in that window. The detector clears: edits falling out of the window stop counting. The edit-tool names and path-argument keys are config, not constants, because the governed tool set is deployment vocabulary (`edit`/`file_path` in this repo's `dsh-tool-fs`, different names under MCP or ACP tool sets).

Termination is once per run (the tripped run is marked; later events on it are ignored). Detector evaluation failures are contained per the listener discipline: caught, logged as a warning once per run, never allowed to break session dispatch.

### Scope parked in v1

- **Remote runs are not governed.** A `subagent/start` with `local: false` (e.g. the ACP provider) exposes no local `Agent` to cancel and appends no local session events to observe, so both detection and enforcement lack a seam. The governor skips those runs; the README records the limitation. Extending governance across the ACP boundary would need a remote-cancellation capability on the provider seam — deliberately not invented here.
- **Continuable children are governed per resident Activation.** Each Activation epoch announces `subagent/start`/`subagent/end` with the same session id, so ceilings apply to the resident child; a governor cancel aborts its current turn (equivalent to an ancestor `interrupt`) without destroying the durable child.
- **No keyless snapshot example ships in this PR.** The report text is pinned verbatim in the package README and by unit + Loader-composition tests; wiring a governed-delegation example into the snapshot harness is deferred and recorded in the README's limitations section.

### Composition

`inject = ['subagents', 'agents', 'tokenMeter']`. All three are hard requirements even when `maxChildTokens` is unset, keeping the activation contract static and visible in loader state rather than data-dependent. Config is a schemastery `Config` plus fail-loud `apply` checks: at least one ceiling; integers within range; `window >= maxSameFileEdits` (a smaller window could never trip); non-empty, duplicate-free edit-tool names with non-empty `pathArgument`s.

## Alternatives considered

- **Terminate via `SubagentRun.dispose()` or the request `signal`** — both are holder-owned: the run handle is returned only to the delegation Consumer and the signal belongs to the spawning tool's execution. A plugin reaching either would need a new side channel on the seam; the child Agent's public `cancel` already expresses exactly this authority.
- **`ctx.subagents.interrupt(sessionId, authority)`** — continuable-only (an accepted no-op for one-shot runs, which are the primary runaway case) and demands an ancestor-Agent or human authority the governor does not hold.
- **Add an abort/turn-end capability to the subagent seam** — the spec's original shape. Rejected for v1: every needed signal already exists on real seams, and widening a capability seam for one consumer violates the Service-Definition rule; if remote governance is ever needed, that is the point to revisit.
- **Report through the delegation tool result** — rejected on ownership and bypass grounds (see the channel section).
- **Report as a new session event type** — a new `SessionEventMap` member plus UI/persistence handling for what is exactly an injected notice; `user/message` with a plugin source is the established channel (`dsh-repeat-tool-reminder` delivers its reminders the same way).
- **Count billed tokens from `assistant/message.usage`** — measures provider-reported spend per step but is absent when an adapter reports no usage, and diverges from what the harness itself prices context with. `ctx.tokenMeter.measure` is the repo's one token-measurement seam; its request-surface semantics are documented instead.
- **Hardcode this repo's `edit` tool for churn detection** — the governed tool set is deployment vocabulary; a constant would silently miss renamed or MCP tool sets, exactly the class of quiet misconfiguration the config rules exist to prevent.
- **Extend `dsh-repeat-tool-reminder` with enforcement** — its contract is advisory-by-design on the parent's own calls; enforcement on child runs is a different actor (lifecycle events + agent cancellation, not the tool waterfall), and coupling them would give the reminder package two unrelated reasons to change.

## Consequences

- A runaway child now costs at most its configured budget, and the parent model learns why the delegation died in the same step it sees the failure — at the price of one more plugin in the composition and hard dependencies on `agents` and `tokenMeter`.
- The governor's authority is exactly the child Agent's public cancellation seam, so a cancelled child leaves the same durable record as any hook cancellation; nothing governor-specific exists in the child log.
- Remote (`local: false`) delegations remain ungoverned until a remote-cancellation capability exists on the provider seam.
- The token ceiling bounds context surface, not billed spend; a child that burns tokens on repeated short requests trips the failure or churn ceilings, not the token one.
