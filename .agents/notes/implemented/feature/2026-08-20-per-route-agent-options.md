# Agent Note: Per-route agentOptions in the subagent router

Status: implemented

English | [中文](2026-08-20-per-route-agent-options.zh.md)

## Problem

The router's `agentOptions` was one global override: every delegation, whatever route it matched, got the same child model configuration. The original suite specification wanted model-tier routing — planner-class tasks on a reasoning model, worker-class tasks on a fast model — and the shipped design could express the provider split but not the model split.

## Decision

`RoutePolicy` gains an optional `agentOptions` (`provider`, `model`, `maxTokens`, the same schema fragment as the global field, shared via one `agentOptionsSchema` constructor). Resolution mirrors candidate precedence: the first matching route in config order that declares `agentOptions` wins; a matching route without one falls through; when no matching route declares any, the global `agentOptions` applies. [matchRouteAgentOptions](../../../../packages/plugins/plugin-subagent-router/src/resolver.ts) shares its route-matching pass with `matchRouteCandidates` through a private generator, so the two precedence rules cannot drift. The keyless router snapshot pins the behavior end to end: the example route now carries `maxTokens: 512`, and the replayed child's durable `request/header` carries it — assembled-app proof the override reached the child's request construction.

## Alternatives considered

**Merging route options over global options field-by-field.** A half-merged child config (route model over global provider) is harder to reason about than whole-object precedence and has no consumer asking for it.

**Last matching route wins.** Candidate flattening puts earlier routes first; giving options the opposite precedence would make one delegation's provider come from one route and its model from another under a different rule.

## Consequences

Routes can pin task classes to model tiers without touching providers. The config catalog gains the field; the router README pair documents the precedence. `reasoningEffort` is not yet part of `AgentOptions` — that plumbing is a separate core-seam change; when it lands, per-route effort follows for free through this same field.
