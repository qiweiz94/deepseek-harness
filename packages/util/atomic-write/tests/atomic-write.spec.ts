import { lstat, mkdir, mkdtemp, open, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withFileLock, writeFileAtomic } from '../src/index.ts'

const fsControl = vi.hoisted(() => ({
  failDirectoryOpen: false,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>): ReturnType<typeof actual.open> {
      if (fsControl.failDirectoryOpen && args[1] === 'r') {
        throw new Error('simulated directory open failure')
      }
      return actual.open(...args)
    },
  }
})

afterEach(() => {
  fsControl.failDirectoryOpen = false
})

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-atomic-write-'))
}

/**
 * Spy on the shared `FileHandle` prototype's `sync` so only the `callNumber`th
 * fsync call made by anything under test fails (1-indexed); every other call
 * runs the real implementation. `writeFileAtomic` calls sync at most twice per
 * write — temp-file content, then the best-effort parent directory — so this
 * selects which of the two is forced to fail.
 */
async function failSyncOnCall(callNumber: number): Promise<{ restore: () => void }> {
  const probe = await open(tmpdir(), 'r')
  const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> }
  await probe.close()
  const real = proto.sync
  let calls = 0
  const spy = vi.spyOn(proto, 'sync').mockImplementation(async function (this: unknown) {
    calls += 1
    if (calls === callNumber) throw new Error('simulated fsync failure')
    return real.call(this)
  })
  return { restore: () => { spy.mockRestore() } }
}

describe('writeFileAtomic', () => {
  it('creates the file and its parents with exactly the stated mode', async () => {
    const dir = await scratch()
    const target = join(dir, 'nested', 'deep', 'doc.yaml')
    await writeFileAtomic(target, 'a: 1\n', { mode: 0o600 })
    expect(await readFile(target, 'utf8')).toBe('a: 1\n')
    if (process.platform !== 'win32') expect((await stat(target)).mode & 0o777).toBe(0o600)
  })

  it('replaces existing content and narrows a wider-permission file to the stated mode', async () => {
    const dir = await scratch()
    const target = join(dir, 'doc.yaml')
    await writeFile(target, 'old', { mode: 0o644 })
    await writeFileAtomic(target, 'new', { mode: 0o600 })
    expect(await readFile(target, 'utf8')).toBe('new')
    if (process.platform !== 'win32') expect((await stat(target)).mode & 0o777).toBe(0o600)
  })

  it('replaces a symlinked target itself without writing through to the referent', async () => {
    const dir = await scratch()
    const victim = join(dir, 'victim')
    await writeFile(victim, 'victim-content')
    const target = join(dir, 'doc.yaml')
    await symlink(victim, target)
    await writeFileAtomic(target, 'replaced', { mode: 0o600 })
    expect((await lstat(target)).isSymbolicLink()).toBe(false)
    expect(await readFile(target, 'utf8')).toBe('replaced')
    expect(await readFile(victim, 'utf8')).toBe('victim-content')
  })

  it('leaves no temp sibling and rethrows when the rename fails', async () => {
    const dir = await scratch()
    const target = join(dir, 'occupied')
    await mkdir(target)
    await expect(writeFileAtomic(target, 'content', { mode: 0o600 })).rejects.toThrow()
    expect((await readdir(dir)).filter(entry => entry.includes('.tmp'))).toEqual([])
  })

  it('rejects and removes the temp sibling when the content fsync fails, never publishing the write', async () => {
    const dir = await scratch()
    const target = join(dir, 'doc.yaml')
    const { restore } = await failSyncOnCall(1)
    try {
      await expect(writeFileAtomic(target, 'content', { mode: 0o600 })).rejects.toThrow(/simulated fsync failure/)
    } finally {
      restore()
    }
    expect((await readdir(dir)).filter(entry => entry.includes('.tmp'))).toEqual([])
    await expect(stat(target)).rejects.toThrow(/ENOENT/)
  })

  it('still publishes the write when the best-effort parent-directory fsync cannot complete', async () => {
    const dir = await scratch()
    const target = join(dir, 'doc.yaml')
    // Call 1 is the content fsync (must succeed here); call 2 is the
    // best-effort parent-directory fsync this test forces to fail.
    const { restore } = await failSyncOnCall(2)
    try {
      await writeFileAtomic(target, 'content', { mode: 0o600 })
    } finally {
      restore()
    }
    expect(await readFile(target, 'utf8')).toBe('content')
  })

  it('still publishes the write when the best-effort parent-directory fsync cannot open the directory', async () => {
    const dir = await scratch()
    const target = join(dir, 'doc.yaml')
    fsControl.failDirectoryOpen = true
    await writeFileAtomic(target, 'content', { mode: 0o600 })
    expect(await readFile(target, 'utf8')).toBe('content')
  })
})

describe('withFileLock', () => {
  it('rejects an invalid parent hierarchy before running the operation', async () => {
    const dir = await scratch()
    const parent = join(dir, 'not-a-directory')
    await writeFile(parent, 'occupied')
    let called = false

    await expect(withFileLock(join(parent, 'document'), async () => {
      called = true
    })).rejects.toThrow(/ENOENT|ENOTDIR|not a directory/i)
    expect(called).toBe(false)
  })
})
