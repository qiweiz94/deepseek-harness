# Agent Note: tool-subagent claims its toolName at plugin load

Status: implemented

English | [中文](2026-08-20-tool-subagent-toolname-load-claim.zh.md)

## Problem

Two `tool-subagent` instances configured with the same `toolName` and a provider that had not registered yet collided only inside the `subagent/provider-added` dispatch: the duplicate-name `tools.register` throw there rolled back the provider registration itself, so one misconfigured waiting instance could take down the backend both instances depend on (`TODO(subagent-dup-toolname)`). Continuable instances failed earlier only as a side effect of their `tool:<name>` prompt-section reservation; one-shot instances had no load-time claim at all.

## Decision

A per-root intent registry — a module-level `WeakMap<Context, Set<string>>` keyed by `ctx.root`, the `mcp-client` `serverName` pattern — claims `toolName` in a `ctx.effect` at the start of `apply()`, before any listener, section, or tool registration. A duplicate fails the second instance at plugin load with an actionable error naming the config key; the earlier instance and any later provider registration stay intact. The effect disposer releases the claim, so HMR replacement can reuse the name. Cross-plugin collisions with tools registered by other plugins still surface through `tools.register` at mount.

## Alternatives considered

- An empty prompt-section reservation for one-shot instances: reuses an unrelated registry as a lock, and its duplicate error names prompt sections, not tool config.
- A reservation API on `ctx.tools`: a service-surface addition for one consumer's configuration mistake; the seam design rule keeps consumer-specific behavior in the consumer.
- Keeping the late throw: leaves the provider-registration rollback, the defect itself.

## Consequences

Duplicate-name misconfiguration now fails loud at load in every mode mix, and a provider can no longer be rolled back by a colliding waiting instance. The registry is process-local by design: it separates unrelated root contexts (tests) and adds no durable or cross-process state.
