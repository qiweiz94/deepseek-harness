/**
 * Retention tests for the local spill backend: the Cordis-free
 * `listSpillDir`/`removeSpillDir` storage mechanics (absence, a real listing,
 * and a non-ENOENT read failure), and the `sessionRetention` participant the
 * service registers end to end.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionRetentionRuntime from '@deepseek-ai/dsh-session-retention'
import LocalSpillStore, { listSpillDir, removeSpillDir, sessionDir } from '@deepseek-ai/dsh-spill-local'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-spill-retention-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('listSpillDir / removeSpillDir', () => {
  it('reports undefined for a session with no spill directory (ENOENT)', async () => {
    await expect(listSpillDir(root, 'never-spilled')).resolves.toBeUndefined()
    await expect(removeSpillDir(root, 'never-spilled')).resolves.toBeUndefined()
  })

  it('lists an existing directory\'s entry count and removes it', async () => {
    const dir = sessionDir(root, 'sess-1')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.txt'), 'x')
    writeFileSync(join(dir, 'b.txt'), 'y')

    await expect(listSpillDir(root, 'sess-1')).resolves.toEqual({ dir, entries: 2 })
    await expect(removeSpillDir(root, 'sess-1')).resolves.toEqual({ dir, entries: 2 })
    await expect(listSpillDir(root, 'sess-1')).resolves.toBeUndefined()
  })

  it('surfaces a non-ENOENT read failure instead of treating it as absence', async () => {
    // A FILE where the session directory is expected: readdir fails ENOTDIR,
    // which must propagate rather than being folded into "no spills".
    const dir = sessionDir(root, 'sess-blocked')
    mkdirSync(dirname(dir), { recursive: true })
    writeFileSync(dir, 'not a directory')

    await expect(listSpillDir(root, 'sess-blocked')).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})

describe('LocalSpillStore retention participant', () => {
  it('plans empty targets and deletes to absent for a session with nothing spilled', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionRetentionRuntime)
    const fiber = await ctx.plugin(LocalSpillStore, { root })
    const id = SessionId('never-spilled')
    await expect(ctx.sessionRetention.plan(id)).resolves.toMatchObject({
      stores: [{ store: 'spill-local', plan: { kind: 'targets', targets: [] } }],
    })
    await expect(ctx.sessionRetention.deleteSession(id)).resolves.toMatchObject({
      stores: [{ store: 'spill-local', outcome: { kind: 'absent' } }],
    })
    await fiber.dispose()
  })

  it('plans and deletes an existing spill directory', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionRetentionRuntime)
    const fiber = await ctx.plugin(LocalSpillStore, { root })
    const id = SessionId('has-spills')
    const dir = sessionDir(root, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'r.txt'), 'body')

    await expect(ctx.sessionRetention.plan(id)).resolves.toMatchObject({
      stores: [{ store: 'spill-local', plan: { kind: 'targets', targets: [{ kind: 'directory', location: dir, count: 1 }] } }],
    })
    await expect(ctx.sessionRetention.deleteSession(id)).resolves.toMatchObject({
      stores: [{ store: 'spill-local', outcome: { kind: 'deleted', targets: [{ kind: 'directory', location: dir, count: 1 }] } }],
    })
    await expect(listSpillDir(root, id)).resolves.toBeUndefined()
    await fiber.dispose()
  })
})
