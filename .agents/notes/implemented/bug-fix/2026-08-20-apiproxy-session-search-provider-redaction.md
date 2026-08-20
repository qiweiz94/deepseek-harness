# Agent Note: session.search redacts provider-boundary failures

Status: implemented

English | [中文](2026-08-20-apiproxy-session-search-provider-redaction.zh.md)

## Problem

`session.search`'s outer catch answered every failure with `message: \`session search failed: ${String(error)}\``, interpolating whatever the session-query provider's own rejection carried verbatim onto the wire. The real sqlite backend's `SESSION_QUERY_INDEX_FAILED` and `SESSION_QUERY_PERSISTENCE_FAILED` codes embed the underlying SQLite/fs error text in their message (`session-search SQLite index failed to open: ${errorMessage(error)}`), which can carry an index file path or other local storage detail. The code carried a standing `XXX: Redact provider details before exposing this gateway beyond its current single-user local deployment` marker at the catch site.

## Decision

Redaction moves to the exact boundary where the provider's own rejection is caught — the inner `try`/`catch` around `sessionQuery.searchSessions(...)`, not the outer catch that also handles this gateway's own protocol-guard errors (the provider-call work budget, an oversized page, a repeated continuation cursor). At that inner boundary:

- `SESSION_QUERY_ABORTED` passes through unwrapped: its message is a fixed, safe string (`'session-search aborted'`), and the outer catch's `error instanceof SessionQueryError && error.code === 'SESSION_QUERY_ABORTED'` check needs the original typed instance to keep routing to `cancelled()`.
- `SESSION_QUERY_INVALID_LIMIT` (first page only) and `SESSION_QUERY_STALE_CURSOR` (continuation only) are unchanged: the existing adaptive-retry branches already consume them without letting their message reach a caller.
- Every other rejection — an unclassified `SessionQueryError` code, a plain `Error`, or anything else the provider throws — is logged in full via `ctx.logger.warn` and replaced with a generic `Error('session search provider failed')` before it propagates to the outer catch, so the outer catch's existing `String(error)` interpolation is safe by construction: nothing raw ever reaches it from this path.

The outer catch itself is unchanged. This gateway's own protocol-guard `Error`s (thrown in the pagination loop body, outside the inner try) never pass through the redaction point, so their diagnostic text — "session search provider exceeded the 100-call work budget", "session search provider returned N items; maximum is M", "session search provider repeated a continuation cursor" — still reaches the caller unredacted; none of that text is provider-supplied.

## Alternatives considered

- **Redact at the outer catch (every failure of this method)** — rejected after implementation: it also swallowed this gateway's own safe, controlled protocol-guard diagnostics, which are not provider detail and are useful to a caller (they explain why the search was refused, not what the backend's internals look like). Six existing tests asserted on that exact text; redacting them would have been incorrect, not just inconvenient.
- **Distinguish by `instanceof SessionQueryError`** — rejected: `SESSION_QUERY_INDEX_FAILED` and `SESSION_QUERY_PERSISTENCE_FAILED` are themselves `SessionQueryError` instances whose message embeds raw backend text, so type alone does not separate safe from unsafe. The actual line is the redaction point in the code (the provider-call catch), not the error's class.
- **Redact every other `session.*`/`subagents.*`/etc. method in this file the same way** — deferred, matching "narrow" scope: many of those already answer `String(error)` or `error.message` unredacted to the same single-user-local caller. The README's Known Limitations entry now names this explicitly rather than implying the whole gateway got this treatment.

## Consequences

- A corrupt search index or a persistence fault (or a raw provider error like a database-unavailable failure) no longer reaches a `session.search` caller with backend detail; the operator log carries the full error either way.
- `tests/api-proxy-search.spec.ts` covers a raw provider `Error` (`'database unavailable'`, asserting the wire message excludes it and `ctx.logger.warn` receives it) and a `SESSION_QUERY_INDEX_FAILED` carrying an embedded file path (same assertions), as the known-bad cases for this redaction.
- Every existing test asserting this gateway's own protocol-guard diagnostic text (work budget, oversized page, repeated cursor) and the two adaptive-retry paths needed no change: none of them cross the redaction point.
- `session.search` is the only method in `api-proxy.ts` with this treatment; every other `code: 'internal'` response in the file still interpolates raw error text, which the README now states plainly as the boundary of what shipped.
