# Agent Note: AgentOptions.reasoningEffort

Status: implemented

English | [中文](2026-08-20-agent-options-reasoning-effort.zh.md)

## Problem

`AgentOptions` carried `maxTokens` as a creation-time default but had no equivalent for reasoning effort. A parent agent running at a non-default effort (e.g. `high`) had no way to declare that as the default for its own first request, and a subagent child inherited the parent's provider/model/maxTokens but never its reasoningEffort — a delegated child always started at whatever the adapter's own catalog default happened to be, with no way for a deployment to pin a per-tier default effort for delegated work either.

## Decision

Add `AgentOptions.reasoningEffort?: ReasoningEffortId` (`packages/core/agent/src/runtime-types.ts`), plumbed along the exact path `maxTokens` already takes into request construction. `dsh-agent-loop`'s `Agent.buildRequest` already restored a persisted, route-matched reasoning effort from the session's own request header before this change; it now falls back to `this.options.reasoningEffort` only when no such persisted value applies — so a fresh session's first request, or any request after a route switch with nothing persisted yet, picks up the Agent-level default, while an explicit per-turn effort change or a live `installModelSelection` selection (which already owned `reasoningEffort` as part of its own selection type) continues to win once persisted.

`dsh-subagent`'s `resolveChildAgentOptions` (`child-agent.ts`) inherits the parent's current `reasoningEffort` the same way it inherits `maxTokens` — spread after the parent-derived defaults and before the per-child request's own `agentOptions`, so an explicit per-child override still wins. `SubagentStartRequest.agentOptions` is already typed as the full `AgentOptions` interface, so no separate plumbing was needed there beyond the type addition itself.

`dsh-tool-subagent`'s `Config.agentOptions` schema (the model-facing tool's per-instance child defaults) gains a matching `reasoningEffort: z.string()` field, cast to the branded `ReasoningEffortId` the same way `dsh-agent-default-model`'s settings schema already does for its own reasoning-effort field — schemastery has no generic branded-string constructor, so the cast is the established pattern for this exact situation.

The durable subagent descriptor deliberately excludes `reasoningEffort`, for the same reason it already excludes `maxTokens`: both are per-activation knobs, not durable child composition. A cold-resumed continuable child does not restore a prior effort or re-consult the live parent's current one — it runs on the resumed route's own defaults, unchanged behavior extended symmetrically to the new field rather than a new asymmetry.

## Alternatives considered

- A separate field name distinct from `maxTokens`'s pattern (e.g. `defaultReasoningEffort`): rejected for asymmetry against an established sibling field with identical seed-once-if-absent semantics.
- Restoring `reasoningEffort` into the durable descriptor for cold resume: rejected — it would special-case `reasoningEffort` against `maxTokens`'s own established omission for no functional gain; cold resume already accepts a fresh route's defaults for every per-activation knob.
- A `plugin-subagent-router` per-route override instead of (or before) a core `AgentOptions` field: out of scope for this change. The router already ships its own per-route `agentOptions` (`provider`/`model`/`maxTokens`, [per-route-agent-options](2026-08-20-per-route-agent-options.md)) and is not touched here. Its `agentOptionsSchema` (`packages/plugins/plugin-subagent-router/src/index.ts:68-72`) does not yet include `reasoningEffort`, so a deployment cannot set it from cordis.yml at the router layer yet even though the type now supports it — a follow-up schema change, not part of this change.

## Consequences

- A parent created with `AgentOptions.reasoningEffort` set seeds that value into every request that has no persisted, route-matched effort of its own yet — the first request of a fresh session, or any later request after a route switch with nothing persisted for the new route.
- A subagent child (one-shot or continuable) started without an explicit per-child `reasoningEffort` override now inherits its delegating parent's current `reasoningEffort`, matching the existing `maxTokens` inheritance rule exactly.
- A cold-resumed continuable child does not restore or inherit any `reasoningEffort` — unchanged existing behavior, now stated symmetrically for both per-activation knobs.
- `packages/core/agent`'s README/JSDoc, `dsh-subagent`'s `child-agent.ts`/`descriptor.ts` JSDoc, and the generated `docs/subsystems/core.md`/`.zh.md` type-equiv block and `packages/extensions/tool-cordis` API catalog are updated to document the new field.
- No `plugin-subagent-router` or `plugin-subagent-router` cordis.yml-configurable surface yet for per-route reasoning effort; that plugin's own `agentOptionsSchema` needs a matching field added separately.

## Testing

`packages/core/agent-loop/tests/request-reconstruction.spec.ts` adds two tests against a real `AgentLoop` composition: one proves `AgentOptions.reasoningEffort` reaches the adapter's first request and the logged `request/header` when nothing is persisted yet (and wins over the adapter's own catalog default), the other proves a later persisted, route-matched effort change still overrides the `AgentOptions` default on a subsequent turn. `packages/subagent/subagent/tests/continuation-inheritance.spec.ts` adds three tests against a real continuable-child composition: parent-to-child inheritance, an explicit per-child override winning over inheritance, and the absent case (neither declares one) leaving the child's `reasoningEffort` unset — the same three cases `child-agent.ts`'s existing `maxTokens` line already needed and lacked isolated coverage for, so the new `parentReasoningEffort` line lands at full branch coverage from day one.
