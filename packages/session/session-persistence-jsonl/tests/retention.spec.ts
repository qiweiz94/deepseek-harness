/**
 * Retention participant tests for the JSONL backend: `planStored` enumerates
 * the session-owned directory (or reports absence), `deleteStored` removes it
 * and fsyncs the parent on POSIX, and the coordinator's registered
 * `sessionRetention` participant wires both through the seam end to end.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionRetentionRuntime from '@deepseek-ai/dsh-session-retention'
import JsonlSessionPersistence from '../src/index.ts'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function freshRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-jsonl-retention-'))
  dirs.push(dir)
  return dir
}

describe('JsonlSessionPersistence retention participant', () => {
  it('plans empty targets and deletes to absent for a session with no stored log', async () => {
    const root = await freshRoot()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionRetentionRuntime)
    const fiber = await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const id = SessionId('never-stored')
    // Exercise the participant with and without an explicit signal (branch coverage
    // for the optional-chained abort checks) and with no signal at all.
    await expect(ctx.sessionRetention.plan(id, new AbortController().signal))
      .resolves.toMatchObject({ stores: [{ store: 'session-persistence-jsonl', plan: { kind: 'targets', targets: [] } }] })
    await expect(ctx.sessionRetention.deleteSession(id))
      .resolves.toMatchObject({ stores: [{ store: 'session-persistence-jsonl', outcome: { kind: 'absent' } }] })
    await fiber.dispose()
  })

  it('plans the session-owned directory and deletes it, fsyncing the parent', async () => {
    const root = await freshRoot()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionRetentionRuntime)
    const fiber = await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const id = SessionId('materialized')
    await ctx.sessionPersistence.create(meta(id, '/work'))
    await ctx.sessionPersistence.append(id, oneTurnLog())

    const plan = await ctx.sessionRetention.plan(id, new AbortController().signal)
    const planEntry = plan.stores[0]
    if (planEntry?.plan.kind !== 'targets') throw new Error('expected targets')
    expect(planEntry.plan.targets).toHaveLength(1)
    const [target] = planEntry.plan.targets
    if (target?.kind !== 'directory') throw new Error('expected a directory target')
    expect(existsSync(target.location)).toBe(true)

    const report = await ctx.sessionRetention.deleteSession(id)
    const outcome = report.stores[0]?.outcome
    if (outcome?.kind !== 'deleted') throw new Error('expected deleted')
    expect(outcome.targets).toEqual([{ kind: 'directory', location: target.location }])
    expect(existsSync(target.location)).toBe(false)
    // The parent project directory (shared with other sessions) survives.
    expect(existsSync(dirname(target.location))).toBe(true)

    // Rerunning converges: the store now reports absent, not a second delete.
    await expect(ctx.sessionRetention.deleteSession(id))
      .resolves.toMatchObject({ stores: [{ store: 'session-persistence-jsonl', outcome: { kind: 'absent' } }] })
    await fiber.dispose()
  })
})
