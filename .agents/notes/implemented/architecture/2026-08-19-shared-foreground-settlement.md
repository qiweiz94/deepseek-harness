# Agent Note: Shared foreground delegation settlement

Status: implemented

English | [中文](2026-08-19-shared-foreground-settlement.zh.md)

## Problem

`dsh-plugin-subagent-router` shipped with a verbatim copy of `dsh-tool-subagent`'s private foreground settlement code — `settleForegroundRun`, its stop-reason mapping, the partial-output preservation, `outputValueText`, and the `ForegroundToolResult` type — about a hundred duplicated lines. The `pnpm run duplication` gate has been red since that merge (six clones between the two packages, plus one pre-existing self-clone in `scripts/slot-walk.ts`), and a red gate blocks any CI lane that runs `check:ci:lint:contracts-ready`. Copies of settlement semantics also drift: a stop-reason added to one tool's mapping would silently miss the other.

## Decision

The foreground settlement moved to [foreground-settlement](../../../../packages/subagent/subagent/src/foreground-settlement.ts) in `@deepseek-ai/dsh-subagent`, the sibling of the background-Task counterpart `run-settlement.ts`. It exports `settleForegroundRun`, `outputValueText`, and the `ForegroundToolResult` type; the stop-reason mapping and partial-output preservation stay private to the module. Both delegation tool Consumers import it; the router's copied `foreground.ts` is deleted. With two Consumers sharing identical settlement semantics, the capability package hosting that shared surface is designing the Service Definition for all current Consumers. A package-local spec ([foreground-settlement.spec.ts](../../../../packages/subagent/subagent/tests/foreground-settlement.spec.ts)) owns the module's per-file coverage; the Consumers' Loader-composition suites keep exercising it through the call sites.

Three small parallels between the two tools stay duplicated by design and carry justified `jscpd:ignore` blocks in the router: the delegation option Config fields (the tools evolve them independently — `dsh-tool-subagent` defaults `maxDepth` to 3, the router leaves it unset so its capability needs stay empty), the tool output schema (tool schemas are consumer-owned under the capability-seam rule; each tool states `ForegroundToolResult` in schema form itself), and the start-request option forwarding (it tracks each tool's own Config). The `slot-walk.ts` self-clone is gone: both scan functions now share a `readMatchedFiles` generator for the glob-normalize-dedupe-sort-read loop.

## Alternatives considered

**Wrap the copied module in `jscpd:ignore` markers.** Cheap, but it enshrines a hundred-line verbatim copy and leaves the drift hazard; the duplication gate exists to force this extraction.

**Export the helpers from `dsh-tool-subagent` and have the router import them.** Wrong dependency direction: the router is an alternative Consumer, not a consumer of the other tool plugin, and importing a plugin module for its helpers couples the two tools' release surfaces.

**Extract the schema fragments too.** Tool schemas are consumer-owned; a shared schema fragment would let one Consumer's schema change silently rewrite the other's model-facing contract.

## Consequences

`pnpm run duplication` reports zero clones again, unblocking the fork CI consumers lane. A stop-reason mapping change now lands in one module and reaches both tools. The `ForegroundToolResult` type has one home; the router's `types.ts` keeps only its capability-needs contract. The three annotated parallels remain visible duplication that reviewers must keep deliberate — a change to one side should re-ask whether the other side wants it.
