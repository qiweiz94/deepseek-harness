import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { IScriptSnapshot } from 'typescript'
import { TypeScriptNavigationEngine, loadProjectFileSet, readSnapshot } from '@deepseek-ai/dsh-lsp-typescript-inprocess/src/engine.ts'

const dirs: string[] = []
function dir(prefix = 'dsh-tsnav-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

// noLib keeps each fixture program from loading the full TypeScript standard
// library: navigation over in-file symbols does not need it, and skipping it
// turns a multi-second program build into milliseconds. One test below opts back
// into the lib to exercise default-library resolution.
const OPTIONS = { strict: true, target: 'esnext', module: 'esnext', moduleResolution: 'bundler', noEmit: true, noLib: true }

/** Write a tsconfig plus its files into a fresh dir and return the config path. */
function project(files: Record<string, string>, config: Record<string, unknown> = {}): { root: string; tsconfig: string } {
  const root = dir()
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body)
  const tsconfig = join(root, 'tsconfig.json')
  writeFileSync(tsconfig, JSON.stringify({ compilerOptions: OPTIONS, files: Object.keys(files), ...config }))
  return { root, tsconfig }
}

// Line-numbered (0-based) source used across the navigation tests:
// 0: /** Doc for greet. */
// 1: function greet(name: string): string { return name }
// 2: const first = greet('a')
// 3: const second = greet('b')
// 4: interface Shape { area(): number }
// 5: class Circle implements Shape { area() { return 1 } }
const MAIN = [
  '/** Doc for greet. */',
  'function greet(name: string): string { return name }',
  "const first = greet('a')",
  "const second = greet('b')",
  'interface Shape { area(): number }',
  'class Circle implements Shape { area() { return 1 } }',
  '',
].join('\n')

function mainEngine(): { engine: TypeScriptNavigationEngine; file: string } {
  const { root, tsconfig } = project({ 'main.ts': MAIN })
  const engine = new TypeScriptNavigationEngine(tsconfig)
  return { engine, file: join(root, 'main.ts') }
}

describe('loadProjectFileSet', () => {
  it('returns a single config\'s own files and its root compiler options', () => {
    const { tsconfig, root } = project({ 'main.ts': MAIN })
    const set = loadProjectFileSet(tsconfig)
    expect(set.fileNames).toContain(join(root, 'main.ts'))
    expect(set.options.strict).toBe(true)
  })

  it('unions the files of every referenced project', () => {
    const base = dir()
    const subDir = join(base, 'sub')
    mkdirSync(subDir)
    writeFileSync(join(subDir, 's.ts'), 'export const s = 1\n')
    writeFileSync(join(subDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { ...OPTIONS, composite: true }, files: ['s.ts'] }))
    writeFileSync(join(base, 'a.ts'), 'export const a = 2\n')
    const rootConfig = join(base, 'tsconfig.json')
    writeFileSync(rootConfig, JSON.stringify({ compilerOptions: OPTIONS, files: ['a.ts'], references: [{ path: './sub' }] }))
    dirs.push(base)
    const set = loadProjectFileSet(rootConfig)
    expect(set.fileNames).toContain(join(base, 'a.ts'))
    expect(set.fileNames).toContain(join(subDir, 's.ts'))
  })

  it('visits a diamond reference graph once per config (no duplicate files)', () => {
    const base = dir()
    for (const name of ['b', 'c', 'd']) {
      const d = join(base, name)
      mkdirSync(d)
      writeFileSync(join(d, `${name}.ts`), `export const ${name} = 1\n`)
    }
    // d is a leaf; b and c both reference d; root references b and c (a diamond).
    writeFileSync(join(base, 'd', 'tsconfig.json'), JSON.stringify({ compilerOptions: { ...OPTIONS, composite: true }, files: ['d.ts'] }))
    for (const name of ['b', 'c']) {
      writeFileSync(join(base, name, 'tsconfig.json'), JSON.stringify({ compilerOptions: { ...OPTIONS, composite: true }, files: [`${name}.ts`], references: [{ path: '../d' }] }))
    }
    const rootConfig = join(base, 'tsconfig.json')
    writeFileSync(rootConfig, JSON.stringify({ compilerOptions: OPTIONS, files: [], references: [{ path: './b' }, { path: './c' }] }))
    dirs.push(base)
    const set = loadProjectFileSet(rootConfig)
    const dFile = join(base, 'd', 'd.ts')
    expect(set.fileNames.filter(f => f === dFile)).toHaveLength(1) // visited once despite two paths to it
  })

  it('throws with the diagnostic message when the config cannot be loaded', () => {
    // A missing config file is an unrecoverable error: TypeScript reports it
    // through onUnRecoverableConfigFileDiagnostic and returns no parsed command.
    expect(() => loadProjectFileSet(join(dir(), 'nope', 'tsconfig.json')))
      .toThrow(/cannot load the TypeScript project/)
  })
})

describe('readSnapshot', () => {
  it('reads a file once and serves the cached snapshot afterwards', () => {
    const root = dir()
    const path = join(root, 'f.ts')
    writeFileSync(path, 'const y = 1\n')
    const cache = new Map<string, IScriptSnapshot>()
    const first = readSnapshot(path, cache)
    expect(first).toBeDefined()
    expect(readSnapshot(path, cache)).toBe(first) // cache hit returns the same instance
  })

  it('returns undefined for a file that cannot be read', () => {
    expect(readSnapshot(join(dir(), 'missing.ts'), new Map())).toBeUndefined()
  })
})

/** Resolve a location's URI back to an absolute path for assertions. */
function paths(locations: readonly { uri: string }[]): string[] {
  return locations.map(l => fileURLToPath(l.uri))
}

describe('TypeScriptNavigationEngine navigation', () => {
  it('exposes the project file set and disposes cleanly', () => {
    const { engine, file } = mainEngine()
    expect(engine.fileNames).toContain(file)
    engine.dispose()
  })

  it('loads the standard library for a project that does not disable it', () => {
    // The only fixture without noLib: building its program resolves the default
    // library, so a lib type resolves in hover text.
    const { root, tsconfig } = project({ 'lib.ts': 'const total: number = [1, 2].length\nexport { total }\n' }, { compilerOptions: { ...OPTIONS, noLib: false } })
    const engine = new TypeScriptNavigationEngine(tsconfig)
    const hover = engine.hover(join(root, 'lib.ts'), { line: 0, character: 6 }) // `total`
    expect(hover!.contents).toContain('number')
    engine.dispose()
  }, 60_000)

  it('finds every reference to a symbol, declaration included', () => {
    const { engine, file } = mainEngine()
    // `greet` is declared at line 1, character 9 (after "function ").
    const refs = engine.references(file, { line: 1, character: 9 })
    expect(paths(refs)).toEqual([file, file, file]) // declaration + two call sites
    expect(refs).toHaveLength(3)
    // Sorted by position: the declaration (line 1) precedes both calls.
    expect(refs[0]!.range.start.line).toBe(1)
    expect(refs[1]!.range.start.line).toBe(2)
    expect(refs[2]!.range.start.line).toBe(3)
  })

  it('resolves a definition from a call site back to the declaration', () => {
    const { engine, file } = mainEngine()
    // The `greet` call in `first` is at line 2, character 14 (after "const first = ").
    const defs = engine.definition(file, { line: 2, character: 14 })
    expect(defs).toHaveLength(1)
    expect(defs[0]!.range.start.line).toBe(1) // the declaration
    expect(fileURLToPath(defs[0]!.uri)).toBe(file)
  })

  it('resolves an interface to its implementing class', () => {
    const { engine, file } = mainEngine()
    // `Shape` interface name is at line 4, character 10 (after "interface ").
    const impls = engine.implementation(file, { line: 4, character: 10 })
    expect(impls.length).toBeGreaterThanOrEqual(1)
    expect(impls.some(l => l.range.start.line === 5)).toBe(true) // Circle implements Shape
  })

  it('hovers a documented symbol with its signature and documentation', () => {
    const { engine, file } = mainEngine()
    const hover = engine.hover(file, { line: 1, character: 9 })
    expect(hover).not.toBeNull()
    expect(hover!.contents).toContain('greet')
    expect(hover!.contents).toContain('Doc for greet.') // documentation appended
    expect(hover!.range).toBeDefined()
  })

  it('hovers a symbol without documentation (signature only)', () => {
    const { engine, file } = mainEngine()
    // `first` const at line 2, character 6 (after "const ") has no doc comment.
    const hover = engine.hover(file, { line: 2, character: 6 })
    expect(hover).not.toBeNull()
    expect(hover!.contents).toContain('first')
    expect(hover!.contents).not.toContain('Doc for greet.')
  })

  it('returns no results for a position on no symbol (off-symbol column clamps in range)', () => {
    const { engine, file } = mainEngine()
    // Character far past the line end clamps to the line end → off-symbol → empty.
    expect(engine.definition(file, { line: 1, character: 9999 })).toEqual([])
    expect(engine.hover(file, { line: 1, character: 9999 })).toBeNull()
  })

  it('returns no results for an out-of-range line (beyond EOF or negative)', () => {
    const { engine, file } = mainEngine()
    expect(engine.references(file, { line: 999, character: 0 })).toEqual([])
    expect(engine.definition(file, { line: -1, character: 0 })).toEqual([])
    expect(engine.hover(file, { line: 999, character: 0 })).toBeNull()
    // The empty final line (index 6) is in range: it exercises the line-end
    // fallback to the file length rather than the next line start.
    expect(engine.definition(file, { line: 6, character: 0 })).toEqual([])
  })

  it('navigates references across files, resolving the import through the filesystem host', () => {
    const { root, tsconfig } = project({
      'lib.ts': 'export function shared(): number { return 1 }\n',
      'app.ts': "import { shared } from './lib'\nconst r = shared()\n",
    })
    const engine = new TypeScriptNavigationEngine(tsconfig)
    const libFile = join(root, 'lib.ts')
    // `shared` declaration at line 0, character 16 (after "export function ").
    const files = new Set(engine.references(libFile, { line: 0, character: 16 }).map(r => fileURLToPath(r.uri)))
    expect(files.has(libFile)).toBe(true)
    expect(files.has(join(root, 'app.ts'))).toBe(true) // the reference resolved across the import
    engine.dispose()
  })

  it('orders same-line references by character', () => {
    // Two calls to `f` on one line force the sort to compare by character.
    const { root, tsconfig } = project({ 'twin.ts': 'function f(): void {}\nconst r = [f, f]\n' })
    const engine = new TypeScriptNavigationEngine(tsconfig)
    const file = join(root, 'twin.ts')
    const refs = engine.references(file, { line: 0, character: 9 }) // `f` declaration
    const line1 = refs.filter(r => r.range.start.line === 1)
    expect(line1).toHaveLength(2) // both uses of f are on line 1
    expect(line1[0]!.range.start.character).toBeLessThan(line1[1]!.range.start.character)
  })

  it('returns no results for a file outside the project file set', () => {
    const { engine } = mainEngine()
    const outside = join(dir(), 'outside.ts')
    writeFileSync(outside, 'const z = 1\n')
    expect(engine.definition(outside, { line: 0, character: 6 })).toEqual([])
    expect(engine.references(outside, { line: 0, character: 6 })).toEqual([])
    expect(engine.implementation(outside, { line: 0, character: 6 })).toEqual([])
    expect(engine.hover(outside, { line: 0, character: 6 })).toBeNull()
  })
})
