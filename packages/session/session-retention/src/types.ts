/**
 * Vocabulary for the session retention capability seam. Types only — the
 * runtime service lives in `./index.ts`, and each participant lives in the
 * store package that registers it.
 * @module @deepseek-ai/dsh-session-retention/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session'

/** One durable artifact or record set a deletion removes from one store. */
export interface RetentionTarget {
  /** Artifact class within its store. */
  readonly kind: 'file' | 'directory' | 'records'
  /** Store-specific locator: an absolute path for filesystem targets, a table or record-set name for record targets. */
  readonly location: string
  /** Item count when the store counts cheaply (rows, files); omitted when counting would cost a scan the deletion does not need. */
  readonly count?: number
}

/**
 * A participant's non-mutating enumeration of one session's durable data in
 * its store. `targets` lists what a deletion would remove (empty means the
 * store holds nothing for this session); `retains` says the store keeps its
 * data by design and names the reason.
 */
export type RetentionStorePlan =
  | { readonly kind: 'targets'; readonly targets: readonly RetentionTarget[] }
  | { readonly kind: 'retains'; readonly reason: string }

/**
 * A participant's deletion result for one store: `deleted` with the removed
 * targets, `absent` when the store held nothing for this session, or
 * `retained` when the store keeps its data by design and names the reason.
 */
export type RetentionStoreDeletion =
  | { readonly kind: 'deleted'; readonly targets: readonly RetentionTarget[] }
  | { readonly kind: 'absent' }
  | { readonly kind: 'retained'; readonly reason: string }

/**
 * One store's entry in a {@link SessionRetentionReport}: the participant's
 * result, or `failed` with the message of the rejection the runtime caught, so
 * one store's failure cannot hide another store's outcome.
 */
export type RetentionStoreOutcome =
  | RetentionStoreDeletion
  | { readonly kind: 'failed'; readonly message: string }

/**
 * One store's registered deletion capability. Participants do not check
 * session liveness — the runtime refuses a live session before dispatch, and a
 * store whose integrity depends on its own write path (session persistence)
 * additionally enforces the refusal in its executor.
 */
export interface RetentionParticipant {
  /** Unique store label reported in plans and reports, e.g. `session-persistence-jsonl`. */
  readonly store: string
  /**
   * Enumerate what deleting this session's data would remove, without mutating.
   * @param id - the session whose durable data is enumerated.
   * @param signal - optional cancellation for store read work.
   * @returns the store's targets, or its retains reason.
   */
  plan(id: SessionId, signal?: AbortSignal): Promise<RetentionStorePlan>
  /**
   * Delete this session's durable data in this store. Deleting an absent
   * session resolves `absent`, never rejects, so a partial cross-store
   * deletion converges when rerun.
   * @param id - the session whose durable data is deleted.
   * @param signal - optional cancellation for store work.
   * @returns the store's deletion result.
   */
  deleteSession(id: SessionId, signal?: AbortSignal): Promise<RetentionStoreDeletion>
}

/** Cross-store enumeration returned by `ctx.sessionRetention.plan`, one entry per registered participant. */
export interface SessionRetentionPlan {
  /** The session the plan describes. */
  readonly sessionId: SessionId
  /** Per-store plans in participant registration order. */
  readonly stores: ReadonlyArray<{ readonly store: string; readonly plan: RetentionStorePlan }>
}

/** Cross-store outcome report returned by `ctx.sessionRetention.deleteSession`, one entry per registered participant. */
export interface SessionRetentionReport {
  /** The session the deletion targeted. */
  readonly sessionId: SessionId
  /** Per-store outcomes in participant registration order. */
  readonly stores: ReadonlyArray<{ readonly store: string; readonly outcome: RetentionStoreOutcome }>
}
