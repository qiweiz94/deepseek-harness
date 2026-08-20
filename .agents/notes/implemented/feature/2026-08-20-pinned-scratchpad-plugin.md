# Agent Note: Pinned scratchpad plugin

Status: implemented

English | [中文](2026-08-20-pinned-scratchpad-plugin.zh.md)

## Problem

An agent has no model-facing way to keep a handful of facts (the current goal, a key decision, a file path, an id) reliably present in every request. The transcript-derived system prompt is exactly the material context compaction summarizes away, so a fact the model needs later can silently disappear once compaction runs. There was also no whole-store durable-event pattern in this package group other than `dsh-todo`'s `todo/write`, so a new per-session store had no template to reuse without re-deriving the replay and invariant plumbing from scratch.

## Decision

**A new model-facing plugin, `@deepseek-ai/dsh-plugin-pinned-scratchpad`, registers one `scratchpad_update` tool and one `scratchpad:pinned` system-prompt section.** `scratchpad_update(key, value)` upserts a string value or deletes an entry (`value: null`) in the calling agent's own key/value store; the section renders the current store as a `key: value` block wrapped in `<agent_scratchpad>`/`</agent_scratchpad>` on every prompt assembly. Because the system prompt is reassembled per request and never compacted, the block is present regardless of what compaction later drops from the transcript — compaction-resistance is a consequence of where the content lives, not a mechanism this package implements.

**Durability follows `dsh-todo`'s whole-store event pattern.** Each accepted call appends one `scratchpad/write` session event carrying the complete replacement entry list (not a delta); the current store is folded by scanning the log for the latest such event (last-write-wins). This gives resume and fork correct behavior for free — replaying the log reconstructs the same store with no separate live mirror — and was verified directly: a fresh mount over a previously-written log renders the same section content without re-running any tool call. The event is model-visible and carries no `ignorable` marker, so a reader that doesn't know the type must refuse the log rather than silently drop pinned state.

**The byte budget is enforced fail-loud at write time, never as silent truncation.** `Config.totalBudget` (default 1000, bytes not tokens — the harness has no tokenizer for the serving model) bounds the complete rendered block. A `set` call whose result would exceed it is rejected before it reaches the log, naming the bytes needed, the budget, and the bytes currently used; the model must shorten a value or delete an entry itself. The budget gates `set` only: a log written under a larger, later-shrunk budget still replays and renders in full, and `delete` against an over-budget seeded store is still accepted, so pruning back under budget stays reachable.

**Ownership boundary.** New package directory `packages/plugins/plugin-pinned-scratchpad`, one added line in `tsconfig.host.json` (`references`), the corresponding lockfile update, and one added manifest entry in `scripts/gen-tool-catalog.ts`'s `TOOL_PACKAGES` (its completeness guard scans every `packages/plugins/*` directory, so this registration is structurally required the same way the `tsconfig.host.json` line is — not optional doc content). `docs/tool-catalog.md` itself is generated output owned by the integrator's merge-time regeneration and is deliberately left stale by this change. `src/types.ts` is the one home of the `scratchpad/write` `SessionEventMap` declaration merge, kept free of this package's host-side value imports and re-exported from the package root so aggregate programs receive the merge; `src/invariant.ts` validates the durable entry shape (non-empty trimmed single-line keys, non-empty trimmed values, no duplicate keys within a snapshot) independent of the currently configured budget.

## Alternatives considered

**Fold pinned facts into the existing `dsh-todo` store or another existing section.** Rejected: todos are a task list with different lifecycle and rendering rules; overloading it with free-form pinned facts would conflate two different model-facing contracts and complicate both.

**A per-entry byte or count limit instead of one whole-block budget.** Rejected without a current consumer need: a single `totalBudget` is the smallest configurable surface that satisfies "the block must fit"; per-entry limits are deferred until a concrete case shows the model needs finer-grained guidance than the aggregate error already gives.

**Silent truncation on overflow instead of a rejected call.** Rejected: silently dropping bytes from a value the model asked to pin defeats the feature's own purpose (nothing is lost) and violates the fail-loud-at-write-time requirement; an explicit, named rejection lets the model correct itself.

**Multi-agent/shared or inherited scratchpad (parent-to-child).** Deferred, not built: the store keys off the calling agent's own session log, so a subagent does not inherit its parent's entries. Recorded as a Known Limitation rather than solved because no current consumer needs cross-agent sharing and the sharing/precedence semantics (whose budget applies, whose writes win) would need their own design.

## Consequences

A composition loading the plugin exposes one `scratchpad_update` verb and a tail-ordered (`order: 1010`, immediately after `plan:policy`) prompt section; an update rewrites only the prompt's tail, leaving the cacheable prefix byte-identical for turns that don't change the store. Misconfiguration (`totalBudget` too small to admit any entry) fails loud at plugin load. The store is per-agent only — a subagent or child agent needs its own mount and keeps an independent store; there is no cross-entry structure beyond flat `key: value` strings, no per-entry budget, and no history or undo beyond what remains as superseded events in the durable log (which nothing in this package reads back).
