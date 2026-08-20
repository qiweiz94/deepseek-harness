# Agent Note: session-query authorizes at each consumer's boundary, not in the service

Status: implemented

English | [中文](2026-08-20-session-query-trusted-caller-boundary.zh.md)

## Problem

`@deepseek-ai/dsh-session-query` and `@deepseek-ai/dsh-session-query-sqlite`'s READMEs each carried a "No caller authorization" bullet phrased as unfinished work: "this is trusted context-wide infrastructure; **a future** model tool or UI must constrain which sessions its caller may inspect." That wording was stale even before this change: `@deepseek-ai/dsh-tool-session-query` already exists and already authorizes every session it exposes. The open question was whether the remaining phrasing understated a real gap (some consumer reaches session data without authorizing it) or just needed correcting to match what already shipped.

## Decision

A repository-wide grep for every caller of `ctx.get('sessionQuery')` / `ctx.sessionQuery` (excluding the generated `dsh-tool-cordis` API catalog) finds exactly four real consumers, and every one of them already authorizes access to sessions at its own boundary before exposing anything beyond its own process:

- **`dsh-tool-session-query`** (the model-facing tools) — its README states the mechanism directly: "The caller comes exclusively from `ToolExecution.exec.agent`. Cross-session access requires exact equality between the target and caller session `cwd` values." `session_search` always omits the caller session and checks requested parent ids against caller-workspace authority before the full-text query runs.
- **`dsh-host-apiproxy`**'s `session.search` RPC handler (`src/api-proxy.ts`, the RPC gateway a remote client's `sessions.search` call reaches) — filters every provider hit against `listVisibleSessionSummaries()`'s visible-id set before returning it; a hit for a session the Host does not list is silently dropped, never returned.
- **`dsh-session-reference`** — its own README already states the equivalent positive contract: "the service assumes its host is authorized to read every session exposed by `ctx.sessionQuery`; it is not a model-facing search tool."
- **`dsh-session-query-sqlite`** — the concrete backend implementing the abstract service; it is the provider, not a caller crossing a trust boundary.

`packages/sdk` and `packages/acp` — the two places a genuinely remote or cross-process client could reach in — call neither `ctx.get('sessionQuery')` nor `ctx.sessionQuery` anywhere; a remote client's only path to session-query data is through `dsh-host-apiproxy`'s RPC methods, which already authorize as described above.

Both READMEs' "No caller authorization" bullets are rewritten as "Trusted caller boundary": `ctx.sessionQuery` is a same-process, context-wide read/search primitive with no authorization of its own by design, matching CLAUDE.md's "Trust TypeScript at typed same-process boundaries" — every current in-process caller already authorizes at its own boundary before crossing a real trust boundary (wire, model, or another tenant), and a future consumer that crosses one owns that same step. The sqlite package's bullet now cross-links the base package's fuller statement instead of duplicating the consumer enumeration, since the trust boundary is a property of the abstract service, defined once.

## Alternatives considered

- **Add authorization inside `SessionQueryEngine` itself** (a caller-identity parameter, a visibility predicate threaded through every method) — rejected: no current consumer needs it done there. `dsh-tool-session-query` and `dsh-host-apiproxy` authorize on different axes (caller-session `cwd` equality vs. Host list visibility) that are consumer-specific policy, not something the shared engine could express generically without becoming two different services wearing one interface. Building it speculatively, with no consumer that would use it, is exactly what "Require evidence for public choices" (`packages/AGENTS.md`) argues against.
- **Leave the README wording as "No caller authorization" and just note that consumers currently handle it** — rejected: the original wording actively states the wrong thing ("a future model tool or UI must constrain") about a mechanism that already exists and already ships (`dsh-tool-session-query`), which is a stronger problem than an incomplete-but-accurate limitation.
- **Treat this as a real gap and add a caller-identity check anyway, for defense in depth** — rejected: the grep is exhaustive over the current tree, so this is not "no proof of an authorized caller," it is "no plausible unauthorized caller with a real code path to exploit," and CLAUDE.md's boundary principle draws the line at typed same-process code specifically to avoid this kind of speculative validation.

## Consequences

- No code changed; `SessionQueryEngine` and `SqliteSessionQueryEngine` are unmodified. This Agent Note and the two README rewrites are the entire change.
- The grep evidence above is the reachability proof for this decision; a future PR that adds a new consumer of `ctx.sessionQuery` reaching a wire, model, or multi-tenant boundary must add its own authorization at that new boundary, the same way the three existing ones do — the shared service still performs none.
- If a future need genuinely requires authorization inside the shared service (e.g., two consumers wanting the identical policy), that is new evidence this note's "no current consumer needs it" no longer holds, and the alternative above should be revisited then, not now.
