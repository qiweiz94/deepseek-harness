/**
 * Coordinator-level retention tests: `installRetention` registers a
 * participant only when the backend implements both `planStored` and
 * `deleteStored` (compositions on a backend that omits them are unaffected);
 * `deleteCore` refuses a live session and a preparation reserved for resume,
 * drops coordinator caches before the physical delete, and treats a
 * created-but-never-materialized session as already deleted; and
 * `planDeletion`/`delete` reject on a backend without retention support
 * (reachable when called directly, not through the registered participant).
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import SessionRetentionRuntime from '@deepseek-ai/dsh-session-retention'
import type { RetentionTarget } from '@deepseek-ai/dsh-session-retention'
import { PersistenceCoordinator, SessionPersistenceRevision, type PersistenceBackend } from '../src/index.ts'
import { meta, oneTurnLog } from './contract.ts'

type MemoryStore = Map<string, { meta: SessionHeader; events: SessionEvent[] }>

function revisionFor(entry: { meta: SessionHeader; events: SessionEvent[] }): SessionPersistenceRevision {
  return SessionPersistenceRevision(JSON.stringify(entry))
}

/** The required storage primitives, shared by both fixtures below. */
abstract class MemoryBackendBase implements PersistenceBackend<never> {
  abstract readonly name: string
  readonly store: MemoryStore = new Map()

  async loadStored(id: SessionId) {
    const entry = this.store.get(id)
    if (entry === undefined) return undefined
    return { meta: structuredClone(entry.meta), events: structuredClone(entry.events), revision: revisionFor(entry) }
  }

  async readStoredRevision(id: SessionId) {
    const entry = this.store.get(id)
    return entry === undefined ? undefined : revisionFor(entry)
  }

  async appendBatch(m: SessionHeader, events: readonly SessionEvent[]): Promise<void> {
    const existing = this.store.get(m.id)
    if (existing === undefined) {
      this.store.set(m.id, { meta: structuredClone(m), events: structuredClone(events) as SessionEvent[] })
    } else {
      existing.events.push(...structuredClone(events) as SessionEvent[])
    }
  }

  async commitRepair(m: SessionHeader, _tornMarker: undefined, closers: readonly SessionEvent[]): Promise<void> {
    const entry = this.store.get(m.id)
    if (entry !== undefined && closers.length > 0) entry.events.push(...structuredClone(closers) as SessionEvent[])
  }

  async list() {
    return [...this.store.values()].map(entry => structuredClone(entry.meta))
  }
}

/** Implements retention: a working `planStored`/`deleteStored` pair. */
class RetentionBackend extends MemoryBackendBase {
  override readonly name = 'retention-memory'

  async planStored(id: SessionId): Promise<RetentionTarget[] | undefined> {
    const entry = this.store.get(id)
    return entry === undefined ? undefined : [{ kind: 'records', location: 'store', count: entry.events.length }]
  }

  async deleteStored(id: SessionId): Promise<RetentionTarget[] | undefined> {
    const entry = this.store.get(id)
    if (entry === undefined) return undefined
    this.store.delete(id)
    return [{ kind: 'records', location: 'store', count: entry.events.length }]
  }
}

/** Omits `planStored`/`deleteStored`, like a backend predating the retention seam. */
class NoRetentionBackend extends MemoryBackendBase {
  override readonly name = 'no-retention-memory'
}

const WORK = '/work'

describe('PersistenceCoordinator retention integration', () => {
  it('registers no participant for a backend that omits planStored/deleteStored', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionRetentionRuntime)
    await ctx.plugin(Object.assign((inner: Context) => {
      new PersistenceCoordinator(inner, new NoRetentionBackend())
    }, { inject: ['sessions'] }))

    await expect(ctx.sessionRetention.plan(SessionId('any')))
      .rejects.toThrow(/no retention participants are registered/)
  })

  it('registers a participant that plans and deletes through the seam for a backend that implements both hooks', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionRetentionRuntime)
    const backend = new RetentionBackend()
    await ctx.plugin(Object.assign((inner: Context) => {
      new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    backend.store.set(SessionId('materialized'), { meta: meta('materialized', WORK), events: oneTurnLog() })

    await expect(ctx.sessionRetention.plan(SessionId('materialized'))).resolves.toMatchObject({
      stores: [{ store: 'retention-memory', plan: { kind: 'targets', targets: [{ kind: 'records', location: 'store', count: 6 }] } }],
    })
    const report = await ctx.sessionRetention.deleteSession(SessionId('materialized'))
    expect(report.stores).toEqual([
      { store: 'retention-memory', outcome: { kind: 'deleted', targets: [{ kind: 'records', location: 'store', count: 6 }] } },
    ])
    expect(backend.store.has(SessionId('materialized'))).toBe(false)
  })

  it('planDeletion/delete reject directly on a backend without retention support', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new NoRetentionBackend()
    let coordinator!: PersistenceCoordinator<never>
    await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))

    await expect(coordinator.planDeletion(SessionId('any')))
      .rejects.toThrow(/backend "no-retention-memory" does not support retention deletion/)

    const id = SessionId('materialized-no-retention')
    await coordinator.create(meta(id, WORK))
    await coordinator.append(id, oneTurnLog())
    await expect(coordinator.delete(id))
      .rejects.toThrow(/backend "no-retention-memory" does not support retention deletion/)
  })

  it('deletes a created-but-never-materialized session by dropping its creation intent (no backend call)', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new RetentionBackend()
    let coordinator!: PersistenceCoordinator<never>
    await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))

    const id = SessionId('never-appended')
    await coordinator.create(meta(id, WORK))
    await expect(coordinator.delete(id)).resolves.toBeUndefined()
    expect(backend.store.has(id)).toBe(false)
  })

  it('refuses to delete a live session', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new RetentionBackend()
    let coordinator!: PersistenceCoordinator<never>
    await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))

    const id = SessionId('live-delete')
    ctx.sessions.create(id, { meta: { cwd: WORK } })
    await expect(coordinator.delete(id)).rejects.toThrow(/cannot delete session "live-delete" while it is live/)
  })

  it('refuses to delete while a persisted preparation is reserved for resume', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new RetentionBackend()
    let coordinator!: PersistenceCoordinator<never>
    await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))

    const id = SessionId('reserved-delete')
    await coordinator.create(meta(id, WORK))
    await coordinator.append(id, oneTurnLog())
    await coordinator.prepare(id) // left reserved (not disposed, not published)
    await expect(coordinator.delete(id))
      .rejects.toThrow(/cannot delete session "reserved-delete" while its persisted preparation is reserved for resume/)
  })
})
