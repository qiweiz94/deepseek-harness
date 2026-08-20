# Agent Note: Subagent router plugin

Status: implemented

English | [中文](2026-08-19-subagent-router-plugin.zh.md)

## Problem

The subagent seam exposes a multi-provider registry (`spawn`, `fork`, `acp`, `codex`, `claude-code`, `dsh-sdk`), but each model-facing delegation tool binds to exactly one configured provider (`dsh-tool-subagent`): exposing more than one transport means loading the tool plugin once per backend with a distinct `toolName`, and the model picks the right tool by name. Provider selection is documented as config, not model-facing, and there is deliberately no single delegation entry and no capability-aware resolution. The seam README records a deferred decision API "waiting for a concrete consumer" — the router occupies that space.

## Decision

**A new model-facing plugin, `@deepseek-ai/dsh-plugin-subagent-router`, registers one `subagent` tool** (configurable `toolName`, default `subagent`) that routes a delegated task by config-owned policy. The model names only the task (`description` + `prompt`); it never names a provider or transport.

**Routing is deterministic policy.** `Config.providers` is the ordered default candidate list; `Config.routes` provides label-routed overrides matched case-insensitively against the task `description`. Every matching route contributes its ordered providers in config order; a delegation that matches any route never falls back to the default candidates — routes are policy, and an unroutable delegation fails loud. At call time the router walks the candidates, skips unregistered providers, and dispatches to the first whose `SubagentCapabilities` satisfy the request's needs — `persona`/`toolFilter`/`depthLimit` required only when the corresponding config option is set. No capable candidate fails loud with the candidates tried and the missing capabilities.

**The router is a caller/coordinator, not an interceptor.** The subagent seam exposes no pre-start waterfall, so the plugin registers its own tool that calls `ctx.subagents.start(provider, request)`. It holds no cached provider state; each call resolves against the live registry, so sibling load order and HMR need no `subagent/provider-added` bookkeeping.

**`dsh-tool-subagent` remains** as the explicit low-level escape hatch for 1:1 provider bindings and for background/continuable modes, which the router does not expose in v1.

## Alternatives considered

**Pure capability auto-resolver.** Rejected: capabilities alone do not distinguish `spawn` (fresh), `fork` (seeded), or `dsh-sdk` (out-of-process), which share flags but differ in semantics — auto-picking by capability would force the model to express transport intent.

**Config-only indirection without a new tool.** Rejected: it does not close the single-delegation-entry gap the router exists to fill.

**Fallback/availability layer over the existing tools.** Deferred: the seam's `getProvider`/registry already provide registration presence; a health-signaled layer is not needed yet.

## Consequences

A composition loading the router exposes one `subagent` verb whose backend is chosen by policy and capability. Misconfiguration (empty `providers`, an empty `toolFilter`, an empty `routes[].label`) fails loud at load via the z schema; an unreachable or incapable provider set fails loud at call time with a model-visible reason. The tool returns the child's final output and maps a non-`completed` stop reason to an error that preserves partial output. v1 is foreground-only; `run_in_background` and continuable delegation remain on `dsh-tool-subagent`. The tool is concurrency-safe, so sibling delegations overlap up to the loop's parallel-call bound.
