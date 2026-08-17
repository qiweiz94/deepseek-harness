# Agent Note: Tool-result truncation cuts on code-point boundaries

Status: implemented

English | [中文](2026-08-17-code-point-safe-truncation.zh.md)

## Problem

Character-capped tool-result truncation sliced decoded text with UTF-16 code-unit operations (`String.prototype.slice`/`substring`). A cap that landed inside an astral code point (an emoji, a CJK extension character) left a **lone high surrogate** in model-facing text:

- `read` line truncation (`read-render.ts`), the `web_fetch` source and output caps (`tool-web`), the fetch provider's `maxBodyChars` cut (`web-fetch-http`), `str_replace`/persistent-bash viewer caps, the historical-reasoning bound (`llm-deepseek` serialization), and `boundContextSummary` all cut on code units.
- A lone surrogate is not valid text: `TextEncoder.encode` **throws** on it, and UTF-8 transports (the session log, the LLM wire, `tool-jobs` job-output measurement) silently replace it with U+FFFD. `tool-jobs` measures job output bytes with `TextEncoder`, so a lone surrogate produced by an upstream cut could turn a later call into a crash.
- The `read` tool's streaming line buffer capped itself at `maxLineLength + 1` UTF-16 units. An emoji-heavy line therefore stopped accumulating at roughly half its character budget — silent truncation with no `(line truncated)` suffix — and the unit cut could split a surrogate pair.

Separately, `agent-instructions`' `probeScopeInstruction` re-implemented the resolve→stat→classify probe that `fsStatFile` already owns — a third copy of the same provider metadata semantics that could drift.

## Decision

`@deepseek-ai/dsh-output-retention` (the library that already owns bounded model-facing text) exports two pure helpers:

- `codePointLength(value)` — Unicode code-point count, never UTF-16 units.
- `truncateCodePoints(value, maxCodePoints)` — bounds a string to at most `maxCodePoints` code points; a cut inside an astral code point drops that whole code point, so the result never ends in an unpaired surrogate.

Every char-capped truncation in a tool-result or model-visible path converts to these helpers: `read` line truncation, `web_fetch` source/output caps, the fetch provider body cap, `str_replace` and persistent-bash output caps, the DeepSeek historical-reasoning bound, and `boundContextSummary`. Caps documented as "characters" now count code points, which matches the wording for astral content.

The `read` streaming line buffer caps at the astral maximum (`2 × (maxLineLength + 1)` units — enough to hold `maxLineLength + 1` full code points) and backs off one unit when its cut splits a surrogate pair, so overflow detection stays exact for astral lines and the buffer never holds a lone high surrogate.

`probeScopeInstruction` now delegates to the shared `fsStatFile` probe and maps its `present` info onto the scope file shape; baseline discovery and scope reconciliation can no longer drift in symlink-follow, non-file absence, or provider-failure classification.

## Alternatives considered

- **Inline surrogate backoff at each cut site** — the `py-types.ts` precedent. Leaves the pattern duplicated across the harness for the third time and gives no shared, unit-tested contract for "what does a character cap keep?".
- **Convert the char caps to byte caps via `TextRetainer`** — changes deployment budgets (`maxBodyChars`, `maxOutputChars`, `maxLineLength` are documented and configured as characters); the byte-oriented retainers remain the authority for process/body byte budgets, and the new helpers cover character budgets.
- **Keep the old line-buffer cap and only fix `truncateLine`** — leaves the silent half-budget pre-truncation of astral lines and a unit cut that can still split a pair before `truncateLine` sees the line.

## Consequences

- Astral content at a cut boundary is kept as whole code points; no lone surrogate can reach model-facing text from these paths. `TextEncoder`-measuring consumers (`tool-jobs`, terminal rendering) are no longer at risk from truncation-produced lone surrogates.
- Character caps now count code points rather than UTF-16 units for astral content — a marginal tightening that matches the "characters" wording; BMP behavior is byte-for-byte unchanged.
- The shared helpers are unit-tested in `output-retention`; each converted seam carries a surrogate-boundary regression test (`read-render`, fetch provider, DeepSeek serialization, context summaries). The `agent-instructions` probe path keeps its full behavior suite.
- While syncing tests and READMEs to the working-tree spill-policy notice rewrite, the `tool-web` spill showcase test and the `spill-policy` READMEs were updated to the directive-style notice (`[Output Exceeded … chars - Full content written to <locator>]`).
