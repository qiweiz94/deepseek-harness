/**
 * Retention participant tests for the SQLite backend: `planStored` counts the
 * session's row plus its event rows (or reports absence), `deleteStored`
 * removes the `sessions` row in one transaction and `ON DELETE CASCADE` takes
 * its events with it, and the coordinator's registered `sessionRetention`
 * participant wires both through the seam end to end.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionRetentionRuntime from '@deepseek-ai/dsh-session-retention'
import SqliteSessionPersistence from '../src/index.ts'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'

describe('SqliteSessionPersistence retention participant', () => {
  it('plans empty targets and deletes to absent for a session with no stored row', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionRetentionRuntime)
    const fiber = await ctx.plugin(SqliteSessionPersistence, { path: ':memory:' })
    const id = SessionId('never-stored')
    await expect(ctx.sessionRetention.plan(id, new AbortController().signal)).resolves.toMatchObject({
      stores: [{ store: 'session-persistence-sqlite', plan: { kind: 'targets', targets: [] } }],
    })
    await expect(ctx.sessionRetention.deleteSession(id)).resolves.toMatchObject({
      stores: [{ store: 'session-persistence-sqlite', outcome: { kind: 'absent' } }],
    })
    await fiber.dispose()
  })

  it('plans the session and event row counts, then deletes both via cascade', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionRetentionRuntime)
    const fiber = await ctx.plugin(SqliteSessionPersistence, { path: ':memory:' })
    const id = SessionId('materialized')
    await ctx.sessionPersistence.create(meta(id, '/work'))
    await ctx.sessionPersistence.append(id, oneTurnLog())

    await expect(ctx.sessionRetention.plan(id, new AbortController().signal)).resolves.toMatchObject({
      stores: [{
        store: 'session-persistence-sqlite',
        plan: {
          kind: 'targets',
          targets: [
            { kind: 'records', location: 'sessions', count: 1 },
            { kind: 'records', location: 'events', count: oneTurnLog().length },
          ],
        },
      }],
    })

    const report = await ctx.sessionRetention.deleteSession(id)
    const outcome = report.stores[0]?.outcome
    if (outcome?.kind !== 'deleted') throw new Error('expected deleted')
    expect(outcome.targets).toEqual([
      { kind: 'records', location: 'sessions', count: 1 },
      { kind: 'records', location: 'events', count: oneTurnLog().length },
    ])

    // Rerunning converges: the row is gone, so the store now reports absent.
    await expect(ctx.sessionRetention.deleteSession(id)).resolves.toMatchObject({
      stores: [{ store: 'session-persistence-sqlite', outcome: { kind: 'absent' } }],
    })
    await fiber.dispose()
  })
})
