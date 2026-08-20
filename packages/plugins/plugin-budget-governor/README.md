# @deepseek-ai/dsh-plugin-budget-governor

English | [中文](README.zh.md)

A hook/guard plugin that registers no model-facing tool. It observes every subagent run through the runtime's read-only hooks, accounts three runaway signals per child — cumulative billed token spend, consecutive failed tool executions, and oscillating file churn — and on the first breach requests the subagent seam's one public stop, then delivers a structured termination report to the child's parent.

## What it does

The governor tracks one budget record per published subagent run, opened on `subagent/start` and released on `subagent/end`. Three detectors run against that record:

- **Token spend.** Every `assistant/message` the child appends to its own session log contributes its billed tokens. `TokenUsage`'s three input counts are disjoint, so the total is `inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens`; `reasoningTokens` is excluded because providers report it inside `outputTokens`. A run breaches when the cumulative total passes `maxTokens`. Omitting `maxTokens` disables this detector.
- **Consecutive tool failures.** Every `isError` tool result extends the run; every successful one resets it to zero. A run breaches on the failure after `maxConsecutiveToolFailures` (default 4), so the fifth consecutive failure breaches and the fourth does not.
- **Oscillating file churn.** Every successful call to a configured mutation tool (`churn.tools`, default `write` / `edit` / `str_replace_editor`) is attributed to a file (`churn.pathKeys`) and fingerprinted from its written content (`churn.contentKeys`). Each file keeps a two-slot window: rewriting the same content is idempotent and advances nothing, flipping back to the content before last counts one revisit, and genuinely new content **clears** the chain. A run breaches when a file's revisit count passes `churn.repeatThreshold` (default 2) — the sequence `A B A B A` on one file, and not a long stream of ordinary revisions. Chains are capped at 256 files per run, evicted in insertion order.

The first breach is the terminal verdict: the run is retired from accounting, so one runaway produces exactly one `budget-governor/breach` event and one parent report rather than an event storm.

## Abort seam: what the real API allowed

The specification this plugin was built from named `subagent/turn-end`, `tool/call`, and `ctx.subagents.abort(subagentId, reason)`. None of the three exists. This is the mapping the plugin actually uses:

| Spec named | Real surface | Used |
| --- | --- | --- |
| `subagent/turn-end` | `subagent/start` + `subagent/end` for the run lifecycle; `agent/turn-stopping` is the nearest per-turn hook | start/end; the per-turn hook is unnecessary because breaches are evaluated inline on each observation |
| `tool/call` | `tools/result` (`@mode emit`, deep-frozen final outcome). `tool/call` is a session-log EVENT TYPE, not a Cordis hook | yes |
| — (token spend has no dedicated hook) | `session/event`, reading `assistant/message`'s `usage` | yes |
| `ctx.subagents.abort(subagentId, reason)` | **does not exist**; `SubagentRuntime` has no `abort` method | — |
| — | `ctx.subagents.interrupt(targetSessionId, authority)` — documented as "the one public stop" | yes |

The governor is an **observer that becomes an active caller only to enforce**. Its four listeners mutate nothing they are handed and return nothing, which is what the observe-hook contract requires. The stop is a separate outbound call on `ctx.subagents`, made under `{ kind: 'ancestor', agent }` authority derived from the child's own `session.header.parentSession` through `ctx.agents`. Because that parent *is* the recorded lineage the seam authorizes against, the seam's `UNAUTHORIZED` rejection is not reachable from this call site.

Three honest limits follow from using the real stop rather than an imagined one:

- `interrupt()` stops the target's **current turn**; it keeps the inbox, the Activation, and published descendants. It is not disposal.
- For a **one-shot** child — what `ctx.subagents.start()` produces — the seam documents interrupt as an accepted no-op. The stop request is still made and still reported, but only a continuable child actually stops.
- Without a resolvable live parent Agent (an out-of-process child, or a parent that already left the registry) there is no authority to present, so no stop is possible at all. That case is reported as `enforcement: { kind: 'unenforceable', why }` on the breach event — the loud advisory the seam leaves as the only option.

`Agent.cancel({ kind: 'hook', reason })` was **considered and rejected**. `AgentCancelCause` carries a `hook` variant that reads like a purpose-built abort for exactly this plugin, and the live child Agent is in hand at breach time. But `interrupt()` issues that same `Agent.cancel` internally *after* authorizing the caller against the target's lineage; calling it directly would reach around the seam's only authorization step to gain a marginally harder stop. The plugin takes the authorized path and documents what it cannot do.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `maxTokens` | *(unset)* | Cumulative billed-token ceiling per run; unset disables the token detector |
| `maxConsecutiveToolFailures` | `4` | Failures tolerated in a row; the next one breaches |
| `churn.enabled` | `true` | Whether churn accounting runs |
| `churn.tools` | `['write', 'edit', 'str_replace_editor']` | Tool names counted as file mutations |
| `churn.pathKeys` | `['path', 'file_path']` | Argument keys read, in order, for the mutated path |
| `churn.contentKeys` | `['content', 'file_text', 'new_string', 'new_str']` | Argument keys fingerprinted as written content |
| `churn.repeatThreshold` | `2` | Flips back to earlier content tolerated per file; the next one breaches |
| `onBreach` | `'interrupt'` | `interrupt` requests the seam stop; `report` accounts and announces without ever asking the seam to stop anything |

Semantic bounds are checked in `apply()`, not only in the schema, because a direct `apply()` call bypasses Schemastery entirely: `maxTokens` and `maxConsecutiveToolFailures` must be at least 1, and with churn enabled `repeatThreshold` must be at least 2 (a lower bound reports an ordinary revert as oscillation) with non-empty `tools`, `pathKeys`, and `contentKeys` (each empty list would silently disarm the detector).

## Events

`budget-governor/breach` publishes the structured verdict: the child's session id, the provider, which budget was exceeded, the measurement and the bound it passed, the oscillating path for a churn breach, a one-line reason, and the `enforcement` outcome. A deployment that wants to alarm on runaways it could not stop filters on `enforcement.kind === 'unenforceable'`.

## Export shape

A function/namespace plugin: it exports `name` / `inject` / `Config` / `apply` and NO default. A stray `export default` would collapse the module via the Loader's `unwrapExports` and drop `inject` (see [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).

## Model Experience

None, as the plugin registers no tool, prompt section, or model-visible schema; its only model-visible output is the termination report quietly injected into the breaching child's parent, whose content this package owns.

#### KV Cache effect

Nothing this plugin does enters a request prefix while it stays silent, so prefix reuse is unaffected for the whole healthy lifetime of every agent. One breach injects one plugin-sourced `notice` message into the parent's next pre-step, which invalidates reuse from that point in the parent's conversation exactly as any other injected context does — once per governed run at most, and only for a run that was already going to be truncated.

## Known Limitations and Deferred Work

- **Churn detection is tool-name and argument-key driven.** It reads mutation intent out of `tools/result` arguments rather than from `fs/observed`, because that event carries only an opaque freshness token — no content — and its `actor` is an opaque tool-execution object rather than the calling Agent. A deployment whose editing tools are named or shaped differently must configure `churn.tools` / `pathKeys` / `contentKeys`, or churn accounting silently observes nothing for them.
- **A one-shot child cannot actually be stopped.** `interrupt()` is an accepted no-op for it, so for the common `ctx.subagents.start()` path the governor is an accurate detector with an advisory-only response. Stopping a one-shot run would need a new seam operation, not a change here.
- **Token accounting requires an in-process child session.** A provider whose child runs out of process appends no `assistant/message` to a session this runtime observes, so the token detector sees nothing for it; the tool-failure and churn detectors are equally blind to a child whose tools run out of process.
- **`billedTokens` is not a price.** It sums token counts, and cache reads and writes are not billed at the same rate as fresh input. A deployment that wants a currency budget needs provider pricing this package deliberately does not carry.
