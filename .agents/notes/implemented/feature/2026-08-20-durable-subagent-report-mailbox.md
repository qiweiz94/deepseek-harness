# Agent Note: Durable subagent report mailbox

Status: implemented

English | [中文](2026-08-20-durable-subagent-report-mailbox.zh.md)

## Problem

A continuable child's report reaches its parent as one in-memory inbox delivery. The inbox is a durable projection (`agent/inbox/spliced`), but the parent-side record of an accepted report is not guaranteed to survive the parent process: orderly disposal is a `keepInbox: false` cancel that durably clears unclaimed items, and a crash can lose the acceptance before its splice reaches disk. A restarted parent has no pending report to read; only the child's own transcript retains the content. The subagent README carried this as "No durable report mailbox", and the report tool's README as "Acceptance is weaker than durable delivery".

## Decision

`reportFrom` appends one log-only `subagent/report` session event to the parent's durable session log inside the same no-await acceptance span, before the inbox send. The payload is versioned (`SUBAGENT_REPORT_MAILBOX_VERSION`, `src/report-mailbox.ts`) and carries the resolved delivery policy plus the exact framed accepted `UserMessage` — id, content, and its `subagent-report` source.

Delivered state is derived from the log's existing commit point, never a second marker event: a mailbox record with message id M is delivered exactly when a `user/message` event with id M exists, because the claiming turn logs the claimed message itself.

On `agent/session-start` with `source: 'resume'`, the subagent service folds the resumed session's own suffix (from `header.seedLength`, the same boundary the inbox replays from), collects undelivered mailbox records, skips ids the replayed inbox still holds pending, and re-sends each remaining record's exact message — `followup` for `wakeup` records, `inject` for `quiet` ones. Redelivery reuses the original message id, so repeated crash/resume cycles stay idempotent and a later claim closes the record through the ordinary `user/message` path. A redelivery failure is logged per record and never fails the resume.

The mailbox append sits before the send, so a send that throws after the parent resolved (the `PARENT_UNAVAILABLE` translation of a failed `followup`) leaves a durable record a later resume delivers; the report tool's documented "a failed call does not prove non-delivery" now names a delivery path rather than only an ambiguity. The append itself can fail first: content that does not survive the lossless JSON log boundary throws `SubagentError` `NOT_SERIALIZABLE` before anything is appended or sent, so that one call fails cleanly with nothing durable and nothing delivered.

Settlement notices deliberately stay outside the mailbox: they are runtime accounts whose disposal-time loss is documented behavior, and a resumed parent discovers outcomes through `list_agents` and the child session.

Model-visible ⟺ logged holds in both directions: the mailbox event itself never enters model history, and the message that does reach the model is reconstructable from it — and is separately logged as `user/message` when claimed.

## Alternatives considered

- Inbox splice replay alone (no new event): survives only crashes whose insert splice flushed, and orderly disposal durably cancels unclaimed reports — the exact gap this note closes.
- Mailbox in the child's log with a parent-side scan on resume: every parent resume would enumerate and read descendant session files; rejected for cost and for coupling resume to the durable catalog.
- An explicit claim/ack event: a second delivery source that can contradict `user/message`; delivered state derives from the existing commit point instead.
- Offline append to a non-live parent's persisted session: writing to an unloaded session needs cross-process coordination the persistence seam does not offer; the live-direct-parent acceptance rule is unchanged in v1.
- A store outside the session log: a new durable surface with its own replay and repair rules; the session log already owns durability and replay.

## Consequences

- A child's report survives parent restart and orderly teardown. Duplicates remain possible in the flush window where a claiming turn's `user/message` was lost — at-least-once with log-derived dedup, stated in both package READMEs.
- Every accepted report is durably recorded twice: once in the child transcript, once as the parent's mailbox event.
- `subagent/report` joins the required-on-read event set: a build that does not know the type refuses such a log rather than silently dropping an undelivered report (the `subagent/descriptor` stance).
- Exactly-once delivery, read receipts, host-user recipients, and cross-process leases remain out of scope; the residual README limitations narrow accordingly.

## Testing

Unit coverage in `packages/subagent/subagent/tests/report-mailbox.spec.ts` folds the mailbox in isolation against a real in-memory `Session` and a minimal fake `Agent`: claim dedup, the seed-suffix boundary, mailbox-version filtering, every `isRedeliverable` rejection shape, an already-pending inbox skip, and a redelivery send failure that warns without throwing — full per-file coverage.

REAL-composition coverage in `continuation.spec.ts`'s "durable subagent report mailbox" suite runs the full continuable stack: one test rejects a non-serializable report with `SubagentError` `NOT_SERIALIZABLE` and asserts nothing was appended; one restarts the parent over the same persistence root and asserts an unclaimed accepted report reaches the resumed parent's inbox exactly once (`nextStep` filtered to the report has length 1, `nextTurn` empty) — proving neither a redelivery gap nor a double delivery racing ordinary `agent/inbox/spliced` replay; one appends a mailbox record with an unsupported delivery policy directly onto the parent's session (a shape only a different/future harness could write), resumes, and asserts the resume completes with an empty inbox and a `warn` call naming the record corrupt. The "claimed report is not redelivered" half of the dedup claim is proven at the unit level (`undeliveredSubagentReports` excludes a record whose message id a later `user/message` event carries), not duplicated as a second full-stack test. A keyless snapshot scenario through a runnable example is queued to the examples integrator (out of this package's ownership).
