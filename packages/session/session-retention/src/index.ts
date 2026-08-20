/**
 * Service Definition and cross-store orchestration for the session retention
 * capability seam (`ctx.sessionRetention`). Store packages register one
 * {@link RetentionParticipant} each; the runtime fans one session's deletion
 * out across every registered store and reports per-store outcomes. The seam
 * owns NO automatic policy: age- and quota-based retention are follow-ups that
 * will call this service, and v1 deliberately exposes no model-facing tool.
 * @module @deepseek-ai/dsh-session-retention
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  RetentionParticipant,
  RetentionStoreOutcome,
  RetentionStorePlan,
  SessionRetentionPlan,
  SessionRetentionReport,
} from './types.ts'

export type {
  RetentionParticipant,
  RetentionStoreDeletion,
  RetentionStoreOutcome,
  RetentionStorePlan,
  RetentionTarget,
  SessionRetentionPlan,
  SessionRetentionReport,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionRetention: SessionRetentionRuntime
  }
}

/**
 * Cross-store session deletion runtime. Load as a plugin; it registers as
 * `ctx.sessionRetention`. Participants are dispatched sequentially in
 * registration order; one store's rejection is captured as a `failed` outcome
 * so the remaining stores still run and report.
 */
export class SessionRetentionRuntime extends Service {
  private readonly participants = new Map<string, RetentionParticipant>()

  constructor(ctx: Context) {
    super(ctx, 'sessionRetention')
  }

  /**
   * Register one store's deletion capability. The registration is an effect on
   * the calling context's fiber: disposing the fiber (or calling the returned
   * disposer) removes the store from subsequent plans and deletions. A store
   * label already registered rejects loudly — two participants over one store
   * would double-report its data.
   * @param participant - the store's unique label plus its plan and deletion operations.
   * @returns the disposer that unregisters this participant.
   */
  register(participant: RetentionParticipant): () => void {
    const dispose = this.ctx.effect(function* (this: SessionRetentionRuntime) {
      if (this.participants.has(participant.store)) {
        throw new Error(`retention store ${JSON.stringify(participant.store)} is already registered`)
      }
      this.participants.set(participant.store, participant)
      // Unconditional: `dispose()` is idempotent and a successor can only
      // register this store label after this cleanup already freed it, so
      // whenever this runs the entry (if any) is always this participant —
      // matching `dsh-shell-env`'s equivalent unconditional cleanup.
      yield () => { this.participants.delete(participant.store) }
    }.bind(this), 'sessionRetention.register()')
    return () => void dispose()
  }

  /**
   * Enumerate what deleting one session's durable data would touch, per store,
   * without mutating any store.
   * @param id - the session to enumerate.
   * @param signal - optional cancellation for store read work.
   * @returns one plan entry per registered participant, in registration order.
   */
  async plan(id: SessionId, signal?: AbortSignal): Promise<SessionRetentionPlan> {
    const stores: Array<{ store: string; plan: RetentionStorePlan }> = []
    for (const participant of this.assertParticipants()) {
      signal?.throwIfAborted()
      stores.push({ store: participant.store, plan: await participant.plan(id, signal) })
    }
    return { sessionId: id, stores }
  }

  /**
   * Delete one session's durable data across every registered store. Refuses a
   * live session before any store runs; the persistence participant enforces
   * the same refusal in its own executor. A participant rejection becomes that
   * store's `failed` outcome and later stores still run, so a partial deletion
   * is reported, never hidden; rerunning converges because participants treat
   * already-deleted data as `absent`. An abort between stores rejects — the
   * stores that already ran keep their effect, and a rerun reports them `absent`.
   * @param id - the session whose durable data is deleted.
   * @param signal - optional cancellation checked between stores and forwarded to each participant.
   * @returns one outcome per registered participant, in registration order.
   */
  async deleteSession(id: SessionId, signal?: AbortSignal): Promise<SessionRetentionReport> {
    const participants = this.assertParticipants()
    if (this.ctx.get('sessions')?.get(id) !== undefined) {
      throw new Error(`cannot delete session "${id}" while it is live`)
    }
    const stores: Array<{ store: string; outcome: RetentionStoreOutcome }> = []
    for (const participant of participants) {
      signal?.throwIfAborted()
      try {
        stores.push({ store: participant.store, outcome: await participant.deleteSession(id, signal) })
      } catch (error: unknown) {
        if (signal?.aborted) throw error
        stores.push({
          store: participant.store,
          outcome: { kind: 'failed', message: error instanceof Error ? error.message : String(error) },
        })
      }
    }
    return { sessionId: id, stores }
  }

  /** Refuse to run over zero stores: an empty fan-out reporting success would delete nothing while claiming completion. */
  private assertParticipants(): RetentionParticipant[] {
    if (this.participants.size === 0) {
      throw new Error('no retention participants are registered; refusing to report a deletion that would remove nothing')
    }
    return [...this.participants.values()]
  }
}

export default SessionRetentionRuntime
