/**
 * Runtime tests for `@deepseek-ai/dsh-session-retention`: participant
 * registration (duplicate rejection, effect-scoped and explicit disposal, the
 * stale-disposer-after-re-register guard), cross-store `plan`/`deleteSession`
 * fan-out and ordering, the zero-participant and live-session refusals, and
 * failure isolation (one participant's rejection reports `failed` without
 * stopping the rest, except when the caller's abort caused it).
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionRetentionRuntime, { type RetentionParticipant } from '../src/index.ts'

/** A controllable participant: records calls and lets a test drive its outcomes. */
function participant(store: string, overrides: Partial<RetentionParticipant> = {}): RetentionParticipant {
  return {
    store,
    plan: async () => ({ kind: 'targets', targets: [] }),
    deleteSession: async () => ({ kind: 'absent' }),
    ...overrides,
  }
}

describe('SessionRetentionRuntime', () => {
  it('rejects plan and deleteSession over zero registered participants', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionRetentionRuntime)
    await expect(ctx.sessionRetention.plan(SessionId('none')))
      .rejects.toThrow(/no retention participants are registered/)
    await expect(ctx.sessionRetention.deleteSession(SessionId('none')))
      .rejects.toThrow(/no retention participants are registered/)
  })

  it('rejects duplicate registration for the same store label, synchronously', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionRetentionRuntime)
    ctx.sessionRetention.register(participant('dup'))
    expect(() => ctx.sessionRetention.register(participant('dup')))
      .toThrow(/retention store "dup" is already registered/)
  })

  it('fans a plan out to every registered participant, in registration order', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionRetentionRuntime)
    ctx.sessionRetention.register(participant('b', {
      plan: async () => ({ kind: 'targets', targets: [{ kind: 'file', location: '/b' }] }),
    }))
    ctx.sessionRetention.register(participant('a', {
      plan: async () => ({ kind: 'retains', reason: 'shared objects' }),
    }))
    const id = SessionId('sess-1')
    const report = await ctx.sessionRetention.plan(id)
    expect(report.sessionId).toBe(id)
    expect(report.stores).toEqual([
      { store: 'b', plan: { kind: 'targets', targets: [{ kind: 'file', location: '/b' }] } },
      { store: 'a', plan: { kind: 'retains', reason: 'shared objects' } },
    ])
  })

  it('fans a deletion out to every registered participant and reports each outcome', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionRetentionRuntime)
    ctx.sessionRetention.register(participant('deleted-store', {
      deleteSession: async () => ({ kind: 'deleted', targets: [{ kind: 'directory', location: '/d' }] }),
    }))
    ctx.sessionRetention.register(participant('absent-store'))
    ctx.sessionRetention.register(participant('retained-store', {
      deleteSession: async () => ({ kind: 'retained', reason: 'content-addressed' }),
    }))
    const id = SessionId('sess-2')
    const report = await ctx.sessionRetention.deleteSession(id)
    expect(report.sessionId).toBe(id)
    expect(report.stores).toEqual([
      { store: 'deleted-store', outcome: { kind: 'deleted', targets: [{ kind: 'directory', location: '/d' }] } },
      { store: 'absent-store', outcome: { kind: 'absent' } },
      { store: 'retained-store', outcome: { kind: 'retained', reason: 'content-addressed' } },
    ])
  })

  it('refuses to delete a live session before any participant runs', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionRetentionRuntime)
    let called = false
    ctx.sessionRetention.register(participant('store', {
      deleteSession: async () => { called = true; return { kind: 'absent' } },
    }))
    const id = SessionId('live-session')
    ctx.sessions.create(id)
    await expect(ctx.sessionRetention.deleteSession(id))
      .rejects.toThrow(/cannot delete session "live-session" while it is live/)
    expect(called).toBe(false)
  })

  it('captures one participant\'s Error rejection as a failed outcome and still runs the rest', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionRetentionRuntime)
    ctx.sessionRetention.register(participant('broken', {
      deleteSession: async () => { throw new Error('disk full') },
    }))
    ctx.sessionRetention.register(participant('healthy'))
    const report = await ctx.sessionRetention.deleteSession(SessionId('sess-3'))
    expect(report.stores).toEqual([
      { store: 'broken', outcome: { kind: 'failed', message: 'disk full' } },
      { store: 'healthy', outcome: { kind: 'absent' } },
    ])
  })

  it('captures a non-Error rejection by stringifying it', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionRetentionRuntime)
    ctx.sessionRetention.register(participant('broken', {
      deleteSession: async () => { throw 'boom' },
    }))
    const report = await ctx.sessionRetention.deleteSession(SessionId('sess-4'))
    expect(report.stores).toEqual([{ store: 'broken', outcome: { kind: 'failed', message: 'boom' } }])
  })

  it('rethrows (does not capture as failed) a participant rejection caused by the caller\'s own abort', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionRetentionRuntime)
    const controller = new AbortController()
    ctx.sessionRetention.register(participant('aborting', {
      deleteSession: async () => { controller.abort(); throw new Error('cancelled') },
    }))
    await expect(ctx.sessionRetention.deleteSession(SessionId('sess-5'), controller.signal))
      .rejects.toThrow('cancelled')
  })

  it('checks the signal between stores, with and without one supplied', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionRetentionRuntime)
    ctx.sessionRetention.register(participant('first'))
    ctx.sessionRetention.register(participant('second'))
    // No signal at all.
    await expect(ctx.sessionRetention.plan(SessionId('sess-6'))).resolves.toBeDefined()
    // A live, unaborted signal.
    await expect(ctx.sessionRetention.plan(SessionId('sess-6'), new AbortController().signal)).resolves.toBeDefined()
    // An already-aborted signal stops before any participant runs.
    await expect(ctx.sessionRetention.plan(SessionId('sess-6'), AbortSignal.abort())).rejects.toThrow()
  })

  it('removes an effect-scoped participant when its plugin is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionRetentionRuntime)
    const fiber = await ctx.plugin({
      inject: ['sessionRetention'],
      apply(inner: Context) {
        inner.sessionRetention.register(participant('temporary'))
      },
    })
    await expect(ctx.sessionRetention.plan(SessionId('sess-7')))
      .resolves.toMatchObject({ stores: [{ store: 'temporary' }] })
    await fiber.dispose()
    await expect(ctx.sessionRetention.plan(SessionId('sess-7')))
      .rejects.toThrow(/no retention participants are registered/)
  })

  it('returns an explicit disposer, idempotent on a repeat call, that frees the store label for re-registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionRetentionRuntime)
    const first = participant('reused')
    const disposeFirst = ctx.sessionRetention.register(first)
    disposeFirst()
    const second = participant('reused', {
      plan: async () => ({ kind: 'retains', reason: 'still here' }),
    })
    ctx.sessionRetention.register(second)
    // A repeat call on the first (already-disposed) registration's disposer
    // must not disturb the successor now registered under the same label.
    disposeFirst()
    await expect(ctx.sessionRetention.plan(SessionId('sess-8')))
      .resolves.toMatchObject({ stores: [{ store: 'reused', plan: { kind: 'retains', reason: 'still here' } }] })
  })
})
