/**
 * The durable subagent report mailbox: the versioned, model-hidden
 * `subagent/report` session event appended to the PARENT's log when a
 * continuable child's report is accepted, and the resume-time redelivery that
 * makes an accepted report survive the parent process.
 *
 * Delivered state is derived from the log's one authoritative commit point: a
 * mailbox record is delivered exactly when a `user/message` event with the
 * same message id exists, because the claiming turn logs the claimed message
 * itself. Redelivery re-sends the exact recorded message (same id), so
 * repeated crash/resume cycles stay idempotent — at-least-once delivery with
 * log-derived dedup. Design rationale:
 * [durable report mailbox](../../../../.agents/notes/implemented/feature/2026-08-20-durable-subagent-report-mailbox.md).
 *
 * @module @deepseek-ai/dsh-subagent/report-mailbox
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import type { SubagentReportDelivery } from './continuation.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Durable mailbox record of one accepted child report, appended to the
     * parent's log in the acceptance span before the in-memory inbox send.
     * Log-only: it carries no `surfaceOp` and never enters model history; the
     * report reaches the model through the ordinary inbox → `user/message`
     * path, on first delivery or on resume-time redelivery.
     */
    'subagent/report': SubagentReportMailboxData
  }
}

/**
 * The current mailbox record format version, stamped into every appended
 * `subagent/report` event. Records with another version are not redeliverable
 * by this runtime and are left to the build that understands them.
 */
export const SUBAGENT_REPORT_MAILBOX_VERSION = 1

/** Payload of one `subagent/report` mailbox record. */
export interface SubagentReportMailboxData {
  /** Mailbox record format version ({@link SUBAGENT_REPORT_MAILBOX_VERSION}). */
  readonly version: number
  /** The parent scheduling policy the acceptance resolved. */
  readonly delivery: SubagentReportDelivery
  /** The exact framed accepted parent message, re-sent verbatim on redelivery. */
  readonly message: UserMessage
}

/**
 * Append one mailbox record to the accepting parent's durable log. This is
 * the durable commit point of report acceptance: it precedes the in-memory
 * inbox send, so a crash or failed send afterwards is recoverable on the
 * parent's next resume.
 * @param session - the live direct parent's session.
 * @param message - the framed accepted report message.
 * @param delivery - the resolved parent scheduling policy.
 * @throws when the message does not survive the lossless JSON log boundary.
 */
export function appendReportMailbox(
  session: Session,
  message: UserMessage,
  delivery: SubagentReportDelivery,
): void {
  const record = snapshotJsonValue<SubagentReportMailboxData>({
    version: SUBAGENT_REPORT_MAILBOX_VERSION,
    delivery,
    message,
  })
  if (record === undefined) {
    throw new Error('subagent report content is not JSON-serializable; the report was not accepted')
  }
  session.append('subagent/report', record)
}

/**
 * The pending-fold key for one mailbox record: its message id when the
 * message parses far enough to have one, otherwise a fresh per-record key no
 * `user/message` event can ever carry. A record with an unreadable message
 * can never be matched as claimed, so it must never be silently treated as
 * one — it stays pending and reaches {@link redeliverSubagentReports}'s own
 * `isRedeliverable` rejection instead.
 */
function pendingKeyOf(record: SubagentReportMailboxData): MessageId | symbol {
  const message: unknown = record.message
  return typeof message === 'object' && message !== null && typeof (message as { id?: unknown }).id === 'string'
    ? (message as UserMessage).id
    : Symbol('subagent report mailbox record with an unreadable message')
}

/**
 * Fold one session's own suffix into its undelivered mailbox records: every
 * current-version `subagent/report` whose message id no later `user/message`
 * event carries. Records of another version are skipped.
 * @param events - the complete loaded session events.
 * @param seedLength - the seed boundary (the same boundary the inbox replays
 *   from), so a fork seed's ancestor records are never treated as this
 *   session's mail.
 * @returns the undelivered records in append order.
 */
export function undeliveredSubagentReports(
  events: readonly SessionEvent[],
  seedLength: number,
): SubagentReportMailboxData[] {
  const pending = new Map<MessageId | symbol, SubagentReportMailboxData>()
  for (const event of events.slice(seedLength)) {
    if (event.type === 'subagent/report') {
      const record = event.data
      if (record.version !== SUBAGENT_REPORT_MAILBOX_VERSION) continue
      pending.set(pendingKeyOf(record), record)
    } else if (event.type === 'user/message') {
      pending.delete(event.data.id)
    }
  }
  return [...pending.values()]
}

/**
 * Whether a persisted mailbox record still parses as a sendable message with
 * a policy. `record` crossed the durable/file boundary on load, so its typed
 * fields are read back through `unknown` here rather than trusted — a build
 * that wrote a different shape must be rejected, not miscompiled past.
 */
function isRedeliverable(record: SubagentReportMailboxData): boolean {
  const delivery: unknown = record.delivery
  const message = record.message as unknown as Record<string, unknown> | null
  return (delivery === 'wakeup' || delivery === 'quiet')
    && typeof message === 'object' && message !== null
    && typeof message.id === 'string'
    && message.role === 'user'
    && Array.isArray(message.content)
    && typeof message.source === 'object'
}

/**
 * Redeliver a resumed session's undelivered mailbox records into its live
 * inbox: `wakeup` records through `followup`, `quiet` records through
 * `inject`. Records whose id the replayed durable inbox already holds pending
 * are skipped — the report is still on its first delivery. A corrupt record or
 * a rejected send is reported through `warn` and never fails the resume.
 * @param agent - the freshly resumed agent whose log is scanned.
 * @param warn - sink for per-record redelivery failures.
 */
export function redeliverSubagentReports(agent: Agent, warn: (text: string) => void): void {
  const pendingInbox = new Set<MessageId>(
    [...agent.inbox.nextTurn, ...agent.inbox.nextStep].map(message => message.id),
  )
  for (const record of undeliveredSubagentReports(agent.session.events, agent.session.header.seedLength ?? 0)) {
    if (!isRedeliverable(record)) {
      warn(`subagent report mailbox record in session "${agent.id}" is corrupt and was not redelivered`)
      continue
    }
    if (pendingInbox.has(record.message.id)) continue
    try {
      if (record.delivery === 'wakeup') agent.followup(record.message)
      else agent.inject(record.message)
    } catch (error: unknown) {
      warn(`subagent report ${record.message.id} was not redelivered to resumed session "${agent.id}": ${errorChain(error)}`)
    }
  }
}
