# @deepseek-ai/dsh-plugin-pinned-scratchpad

English | [中文](README.zh.md)

The model-facing `scratchpad_update` tool plus the pinned `<agent_scratchpad>` prompt block: a small key/value store the model maintains for itself, re-rendered into the system prompt before every turn under a hard token budget, so the facts it chooses to keep survive conversation compaction.

## What it does

Registers one tool on `ctx.tools` and one ordered section on `ctx.systemPrompt`:

- `scratchpad_update(key, value)` sets or replaces a key when `value` is a string, and deletes it when `value` is `null`. The result reports `{ key, action, entries, dropped }`, where `action` is `set`, `deleted`, or `missing` (a delete that matched no key), `entries` is how many keys are pinned afterwards, and `dropped` is how many of the oldest entries the token budget currently hides from the prompt block.
- The `agent:scratchpad` prompt section renders the pinned entries as an `<agent_scratchpad>` block. Its text is a *provider*, so it is re-evaluated on every assembly from live store state. While nothing is pinned the section renders as the empty string, which `renderPrompt` drops — the tags never appear over an empty scratchpad.

## The injection seam (and a correction to the spec)

**There is no `prompt/construct` hook in this codebase.** The build spec assumed one; no such event exists in `packages/cordis` (`vendor/cordis`), `packages/core`, or anywhere else in the tree. The real prompt-composition seam is `@deepseek-ai/dsh-system-prompt`:

- `ctx.systemPrompt.section({ name, order, text })` registers an ordered contribution, and `text` may be a function evaluated at each assembly with that assembly's `AssembleContext`.
- `SystemPrompt.assemble()` resolves every provider, then runs the `system-prompt/assemble` waterfall, whose returned value is authoritative.

This plugin registers a **section** and deliberately adds **no** `system-prompt/assemble` listener — both run on every assembly, so doing both would inject the block twice. The waterfall is the transformation escape hatch, not the contribution seam.

### Why a section is the un-compactable choice

`ctx.systemPrompt` offers two contribution shapes, and only one of them is out of compaction's reach:

- `section()` — part of the **system prompt**, rebuilt from the registry on every assembly. The rendered text never enters the session event log.
- `context()` — dynamic runtime context **materialized as a durable user-role snapshot** in the message history.

Compaction (`@deepseek-ai/dsh-compaction`) prunes and checkpoints the session event log. A section's text is produced *during* assembly and never written to that log, so compaction has nothing of ours to remove; the next turn re-reads the live store and reconstructs the block identically. That is the whole mechanism — the block is not "protected from" compaction, it is simply never in the material compaction operates on. Using `context()` would have put the block exactly where compaction can reach it.

## Token budget and eviction

The budget covers the **whole rendered block** — the `<agent_scratchpad>` tags and the truncation marker included, not just the entry lines. Cost is estimated at four characters per token (`estimateTokens`); the harness exposes no tokenizer service, and a per-assembly network round trip is not affordable, so the block is priced with the conventional approximation. It slightly over-estimates English prose, which keeps the budget conservative.

When the block does not fit `maxTokens` (default 250), entries are dropped **oldest write first** and replaced by a single marker line such as `[2 earlier entries dropped: scratchpad token budget]`, so the model is told it lost older notes rather than silently losing them. Two deliberate choices:

- **Order is write recency, not first insertion.** Re-writing a key moves it to the newest position, so a note the model keeps updating is never the one evicted.
- **An entry is never partially rendered.** A single value too large to fit is dropped whole and counted in the marker, because half a note is a misleading note. If not even the marker alone fits, the block renders as the empty string — the budget is honored absolutely rather than approximately.

A `maxValueBytes` ceiling (default 4,000 UTF-8 bytes) rejects an oversized single write at the tool boundary, so one bad write cannot push the entire scratchpad out of the prompt.

## Export shape

A function/namespace plugin: it exports `name` / `inject` / `apply` and NO default. A stray `export default` would collapse the module via the Loader's `unwrapExports` and drop `inject` (see [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).

## Model Experience

### Tool schema

#### What the model sees

One required `key` string and one required `value` that is a two-branch union — a string (the note text) or `null` (delete this key) — plus the structured result object of `key`, `action` (`set` | `deleted` | `missing`), `entries`, and `dropped`. Plugin config (`maxTokens` default 250, `maxValueBytes` default 4,000) is validated at load and fails loud on invalid values; it changes no schema field, only whether a call resolves or returns a directing error result.

The tool description tells the model the eviction rule directly — least recently written entries go first, and re-writing a key refreshes it — because the eviction order is only useful if the model can plan around it.

#### Token effect

Fixed schema cost on every request where the tool is visible, plus the block itself: at most `maxTokens` (250) estimated tokens, and exactly zero while nothing is pinned.

#### KV Cache effect

The block is the most volatile text in the system prompt, so it is registered at order 200 — after the harness identity (-100), the deployment persona (0), and the tool-guidance band (100–199). That keeps every stable section ahead of it byte-identical between turns. Any write still invalidates the prefix from the block onward; that cost is inherent to a mutable pinned block, and placing it last is what bounds the cost to the block's own tail.

## Known Limitations and Deferred Work

- **A `complete` prompt section erases the block.** `assemble()` restores an effective `complete: true` section as the *sole* prompt section, discarding every other contribution — this one included. That is a property of the prompt registry, not of this plugin, and it applies equally to `section()` and `context()`.
- **Estimated tokens, not counted tokens** — the four-characters-per-token heuristic is an approximation. The block may come in under 250 real tokens; it should not come in meaningfully over, but the bound is not exact for non-English text or dense identifiers.
- **In-memory only** — the scratchpad lives for the plugin fiber's lifetime. It survives compaction but not a process restart, and it is not persisted to the session log.
- **No per-agent scoping yet** — one store per plugin instance. Registering through a scoped context shadows the section, but sibling agents mounted from one instance share a scratchpad.
- **Whole-value writes only** — no append or patch operation; the model rewrites a key's full value to change it.
- **Multi-line values are rendered raw** — a value containing newlines spans several lines inside the block, which the `key: value` line format does not escape or indent.
