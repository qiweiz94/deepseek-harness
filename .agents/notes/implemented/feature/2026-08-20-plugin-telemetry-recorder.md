# Agent Note: Session telemetry recorder plugin

Status: implemented

English | [中文](2026-08-20-plugin-telemetry-recorder.zh.md)

## Problem

A model has no way to read its own conversation's operating figures. Whether to compact, shorten the context, or stop delegating are decisions the model must make blind: it cannot see its token velocity, how much of the context window the last request occupied, its prompt-cache hit rate, turn latency, or how many subagent delegations are still running. The harness records all of this in the durable session log and the subagent lifecycle events, but nothing surfaces it to the model.

## Decision

`@deepseek-ai/dsh-plugin-telemetry-recorder` registers one read-only model-facing tool, `get_session_telemetry`, that folds the calling session's own figures over a rolling window of the most recent closed turns (`windowTurns`, default 10): mean tokens per turn and turn wall-clock latency, prompt-cache hit ratio, the fraction of the model's context window the latest request occupied, and subagent delegation counts (started / settled / running). It reads `exec.agent.session` at call time and derives everything from the durable log plus the subagent lifecycle pair — it injects only `tools`, registers no session events of its own, and never writes. A figure the session has produced no evidence for is omitted rather than reported as a misleading zero.

This plugin arrived on a parallel branch (`feat/plugin-telemetry-recorder`) without an Agent Note; this note is supplied at integration, and the plugin was recreated on current master with the standard integrator wiring (tsconfig reference, tool-catalog manifest entry and spec name, regenerated catalogs, plugins README rows).

## Alternatives considered

**A session event carrying the telemetry.** The figures are a derived read of existing log data, not new durable facts; a new `SessionEventMap` member would add persistence and UI handling for something reconstructable from what is already logged.

**Injecting `sessions`/`subagents` at apply.** The tool reads the calling agent's own session through `exec.agent` at execute time, so no additional service injection is needed to boot or to serve the tool.

## Consequences

The model can query its own operating state and act on it. The reading is a snapshot over a bounded window, so it reflects recent behavior, not the whole session; the window size is deployment-configurable. Because every figure is derived from the durable log, the tool has no state of its own to keep consistent and nothing to dispose beyond its registry contribution.
