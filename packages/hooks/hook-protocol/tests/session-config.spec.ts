import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { combineHookGroups, createSessionHookConfigCache, loadProcessHookConfig, type SessionWorkspace, workspaceTrustPredicate } from '@deepseek-ai/dsh-hook-protocol'

const dirs: string[] = []
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), 'dsh-session-config-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

interface Fixture { groups: string[] }

describe('loadProcessHookConfig', () => {
  it('on success, returns the parsed config and reports skipped hooks', () => {
    const d = dir()
    const path = join(d, 'hooks.json')
    writeFileSync(path, JSON.stringify({ a: 1 }))
    const warnSkipped = vi.fn()
    const warnFailure = vi.fn()
    const result = loadProcessHookConfig<Fixture, string>({
      configPath: path,
      hasSessionFallback: false,
      empty: { groups: [] },
      parse: _raw => ({ config: { groups: ['x'] }, skipped: ['dropped'] }),
      warnSkipped,
      warnFailure,
    })
    expect(result).toEqual({ groups: ['x'] })
    expect(warnSkipped).toHaveBeenCalledWith(['dropped'])
    expect(warnFailure).not.toHaveBeenCalled()
  })

  it('on a load failure with no session fallback, warns degraded=false and returns undefined', () => {
    const warnFailure = vi.fn()
    const result = loadProcessHookConfig<Fixture, string>({
      configPath: join(dir(), 'missing.json'),
      hasSessionFallback: false,
      empty: { groups: [] },
      parse: _raw => ({ config: { groups: [] }, skipped: [] }),
      warnSkipped: vi.fn(),
      warnFailure,
    })
    expect(result).toBeUndefined()
    expect(warnFailure).toHaveBeenCalledTimes(1)
    expect(warnFailure.mock.calls[0]?.[1]).toBe(false)
  })

  it('on a load failure WITH a session fallback, warns degraded=true and returns `empty` (?? right arm)', () => {
    const warnFailure = vi.fn()
    const empty: Fixture = { groups: [] }
    const result = loadProcessHookConfig<Fixture, string>({
      configPath: join(dir(), 'missing.json'),
      hasSessionFallback: true,
      empty,
      parse: _raw => ({ config: { groups: [] }, skipped: [] }),
      warnSkipped: vi.fn(),
      warnFailure,
    })
    expect(result).toBe(empty)
    expect(warnFailure.mock.calls[0]?.[1]).toBe(true)
  })

  it('an unparseable file (invalid JSON) is a load failure too', () => {
    const path = join(dir(), 'bad.json')
    writeFileSync(path, '{not json')
    const warnFailure = vi.fn()
    const result = loadProcessHookConfig<Fixture, string>({
      configPath: path,
      hasSessionFallback: false,
      empty: { groups: [] },
      parse: _raw => ({ config: { groups: [] }, skipped: [] }),
      warnSkipped: vi.fn(),
      warnFailure,
    })
    expect(result).toBeUndefined()
    expect(warnFailure).toHaveBeenCalledTimes(1)
  })
})

/** A minimal session-workspace fixture. */
function workspace(id: string, cwd: string | undefined): SessionWorkspace {
  return { id, session: { header: { ...cwd !== undefined ? { cwd } : {} } } }
}

describe('createSessionHookConfigCache', () => {
  it('agent undefined returns `empty` without touching the filesystem', () => {
    const empty: Fixture = { groups: [] }
    const parse = vi.fn()
    const lookup = createSessionHookConfigCache<Fixture, string>({
      sessionConfigFile: '.claude/hooks.json',
      empty,
      parse,
      warnSkipped: vi.fn(),
      warnFailure: vi.fn(),
      warnUntrusted: vi.fn(),
    })
    expect(lookup(undefined)).toBe(empty)
    expect(parse).not.toHaveBeenCalled()
  })

  it('sessionConfigFile undefined (discovery unconfigured) returns `empty`', () => {
    const empty: Fixture = { groups: [] }
    const lookup = createSessionHookConfigCache<Fixture, string>({
      sessionConfigFile: undefined,
      empty,
      parse: vi.fn(),
      warnSkipped: vi.fn(),
      warnFailure: vi.fn(),
      warnUntrusted: vi.fn(),
    })
    expect(lookup(workspace('a1', dir()))).toBe(empty)
  })

  it('no session cwd (cwd undefined) returns `empty` and caches it', () => {
    const empty: Fixture = { groups: [] }
    const parse = vi.fn()
    const lookup = createSessionHookConfigCache<Fixture, string>({
      sessionConfigFile: '.claude/hooks.json',
      empty,
      parse,
      warnSkipped: vi.fn(),
      warnFailure: vi.fn(),
      warnUntrusted: vi.fn(),
    })
    const agent = workspace('a1', undefined)
    expect(lookup(agent)).toBe(empty)
    expect(lookup(agent)).toBe(empty) // cache hit; still no cwd
    expect(parse).not.toHaveBeenCalled()
  })

  it('a missing session file (ENOENT) returns `empty` without warning', () => {
    const empty: Fixture = { groups: [] }
    const warnFailure = vi.fn()
    const lookup = createSessionHookConfigCache<Fixture, string>({
      sessionConfigFile: '.claude/hooks.json',
      empty,
      parse: _raw => ({ config: { groups: ['unreached'] }, skipped: [] }),
      warnSkipped: vi.fn(),
      warnFailure,
      isWorkspaceTrusted: () => true,
      warnUntrusted: vi.fn(),
    })
    expect(lookup(workspace('a1', dir()))).toBe(empty)
    expect(warnFailure).not.toHaveBeenCalled()
  })

  it('a session file that fails to parse (non-ENOENT) warns with path and agent id, and caches `empty`', () => {
    const d = dir()
    writeFileSync(join(d, '.claude'), '') // a FILE named `.claude`, so resolving `.claude/hooks.json` under it hits a non-ENOENT error (ENOTDIR)
    const empty: Fixture = { groups: [] }
    const warnFailure = vi.fn()
    const lookup = createSessionHookConfigCache<Fixture, string>({
      sessionConfigFile: '.claude/hooks.json',
      empty,
      parse: _raw => ({ config: { groups: ['unreached'] }, skipped: [] }),
      warnSkipped: vi.fn(),
      warnFailure,
      isWorkspaceTrusted: () => true,
      warnUntrusted: vi.fn(),
    })
    expect(lookup(workspace('a1', d))).toBe(empty)
    expect(warnFailure).toHaveBeenCalledTimes(1)
    expect(warnFailure.mock.calls[0]?.[1]).toBe('a1')
  })

  it('a discovered session config is parsed with the resolved cwd, reports skipped hooks, and is cached (one fs read across repeat lookups)', () => {
    const d = dir()
    writeFileSync(join(d, 'hooks.json'), JSON.stringify({ groups: ['found'] }))
    const parse = vi.fn((_raw: unknown, cwd: string) => ({ config: { groups: [cwd] }, skipped: ['dropped'] }))
    const warnSkipped = vi.fn()
    const lookup = createSessionHookConfigCache<Fixture, string>({
      sessionConfigFile: 'hooks.json',
      empty: { groups: [] },
      parse,
      warnSkipped,
      warnFailure: vi.fn(),
      isWorkspaceTrusted: () => true,
      warnUntrusted: vi.fn(),
    })
    const agent = workspace('a1', d)
    expect(lookup(agent)).toEqual({ groups: [d] })
    expect(lookup(agent)).toEqual({ groups: [d] })
    expect(parse).toHaveBeenCalledTimes(1) // second lookup hit the cache
    expect(warnSkipped).toHaveBeenCalledWith(['dropped'])
  })

  it('two different agents get independent cache entries', () => {
    const dA = dir()
    const dB = dir()
    writeFileSync(join(dA, 'hooks.json'), JSON.stringify({}))
    writeFileSync(join(dB, 'hooks.json'), JSON.stringify({}))
    const lookup = createSessionHookConfigCache<Fixture, string>({
      sessionConfigFile: 'hooks.json',
      empty: { groups: [] },
      parse: (_raw, cwd) => ({ config: { groups: [cwd] }, skipped: [] }),
      warnSkipped: vi.fn(),
      warnFailure: vi.fn(),
      isWorkspaceTrusted: () => true,
      warnUntrusted: vi.fn(),
    })
    expect(lookup(workspace('a', dA))).toEqual({ groups: [dA] })
    expect(lookup(workspace('b', dB))).toEqual({ groups: [dB] })
  })

  it('default-deny: with no trust predicate, an existing session file is NOT read and the workspace is warned', () => {
    const d = dir()
    writeFileSync(join(d, 'hooks.json'), JSON.stringify({ groups: ['planted'] }))
    const parse = vi.fn()
    const warnUntrusted = vi.fn()
    const empty: Fixture = { groups: [] }
    const lookup = createSessionHookConfigCache<Fixture, string>({
      sessionConfigFile: 'hooks.json',
      empty,
      parse,
      warnSkipped: vi.fn(),
      warnFailure: vi.fn(),
      warnUntrusted,
    })
    const agent = workspace('a1', d)
    expect(lookup(agent)).toBe(empty) // planted hooks never contribute
    expect(parse).not.toHaveBeenCalled() // the file was never even read
    expect(warnUntrusted).toHaveBeenCalledWith(d, 'a1')
    expect(lookup(agent)).toBe(empty) // cached; no re-warn
    expect(warnUntrusted).toHaveBeenCalledTimes(1)
  })

  it('an untrusted workspace (predicate returns false) is skipped and warned', () => {
    const d = dir()
    writeFileSync(join(d, 'hooks.json'), JSON.stringify({ groups: ['planted'] }))
    const parse = vi.fn()
    const warnUntrusted = vi.fn()
    const empty: Fixture = { groups: [] }
    const lookup = createSessionHookConfigCache<Fixture, string>({
      sessionConfigFile: 'hooks.json',
      empty,
      parse,
      warnSkipped: vi.fn(),
      warnFailure: vi.fn(),
      isWorkspaceTrusted: () => false,
      warnUntrusted,
    })
    expect(lookup(workspace('a1', d))).toBe(empty)
    expect(parse).not.toHaveBeenCalled()
    expect(warnUntrusted).toHaveBeenCalledWith(d, 'a1')
  })
})

describe('workspaceTrustPredicate', () => {
  it('no roots configured (undefined) yields no predicate — nothing is trusted', () => {
    expect(workspaceTrustPredicate(undefined, '/launch')).toBeUndefined()
  })

  it('an empty roots array yields no predicate', () => {
    expect(workspaceTrustPredicate([], '/launch')).toBeUndefined()
  })

  it('trusts a root exactly and its nested descendants, rejecting parents and siblings', () => {
    const root = dir()
    const predicate = workspaceTrustPredicate([root], '/launch')
    expect(predicate).toBeDefined()
    expect(predicate!(root)).toBe(true) // the root itself
    expect(predicate!(join(root, 'sub', 'deep'))).toBe(true) // nested descent
    expect(predicate!(join(root, '..'))).toBe(false) // parent escapes upward
    expect(predicate!(join(root, '..', 'sibling'))).toBe(false) // sibling outside root
  })

  it('resolves a launch-cwd-relative root against the launch cwd', () => {
    const base = dir()
    const predicate = workspaceTrustPredicate(['project'], base)
    expect(predicate!(join(base, 'project'))).toBe(true)
    expect(predicate!(join(base, 'project', 'pkg'))).toBe(true)
    expect(predicate!(join(base, 'other'))).toBe(false)
  })
})

describe('combineHookGroups', () => {
  it('concatenates process groups before session groups', () => {
    expect(combineHookGroups(['p1', 'p2'], ['s1'])).toEqual(['p1', 'p2', 's1'])
  })

  it('undefined process groups treat as empty', () => {
    expect(combineHookGroups(undefined, ['s1'])).toEqual(['s1'])
  })

  it('undefined session groups treat as empty', () => {
    expect(combineHookGroups(['p1'], undefined)).toEqual(['p1'])
  })

  it('both undefined yields an empty array', () => {
    expect(combineHookGroups(undefined, undefined)).toEqual([])
  })
})
