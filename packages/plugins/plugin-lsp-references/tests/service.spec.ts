import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loadProjectFileSet,
  readSnapshot,
  ReferenceService,
  sortLocations,
} from '../src/service.ts'
import { buildFixture, HELPER_DECLARATION, type Fixture } from './fixture.ts'

let fixture: Fixture | undefined
let service: ReferenceService | undefined

afterEach(async () => {
  service?.dispose()
  service = undefined
  if (fixture !== undefined) await rm(fixture.root, { recursive: true, force: true })
  fixture = undefined
})

async function navigator(overrides: { maxReferences?: number; maxLineChars?: number } = {}): Promise<ReferenceService> {
  fixture = await buildFixture()
  service = new ReferenceService({
    tsconfigPath: fixture.tsconfigPath,
    maxReferences: overrides.maxReferences ?? 200,
    maxLineChars: overrides.maxLineChars ?? 200,
  })
  return service
}

describe('loadProjectFileSet', () => {
  it('unions the root project\'s own files with every transitively referenced project', async () => {
    fixture = await buildFixture()
    const project = loadProjectFileSet(fixture.tsconfigPath)
    expect(project.fileNames).toEqual(expect.arrayContaining([
      fixture.rootFile,
      fixture.declarationFile,
      fixture.consumerFile,
      join(fixture.root, 'shared', 'src', 'types.ts'),
    ]))
    // shared/ is referenced by BOTH leaf projects; the diamond is visited once.
    expect(project.fileNames.filter(name => name.endsWith('types.ts'))).toHaveLength(1)
    expect(project.options.strict).toBe(true)
  })

  it('fails loud when the named config cannot be read', async () => {
    fixture = await buildFixture()
    expect(() => loadProjectFileSet(join(fixture!.root, 'no-such-tsconfig.json')))
      .toThrow(/cannot load the TypeScript project/)
  })
})

describe('readSnapshot', () => {
  it('returns undefined for a path the host cannot read, so module probing continues', () => {
    expect(readSnapshot(join(tmpdir(), 'dsh-lsp-references-absent', 'absent.ts'), new Map())).toBeUndefined()
  })

  it('memoizes each file it reads', async () => {
    fixture = await buildFixture()
    const cache = new Map<string, ts.IScriptSnapshot>()
    const first = readSnapshot(fixture.rootFile, cache)
    const second = readSnapshot(fixture.rootFile, cache)
    expect(first).toBeDefined()
    expect(second).toBe(first)
    expect(cache.size).toBe(1)
  })
})

describe('sortLocations', () => {
  it('orders by file, then line, then column', () => {
    const location = (path: string, line: number, character: number) => ({ path, line, character, text: '' })
    expect(sortLocations([
      location('b.ts', 1, 1),
      location('a.ts', 9, 1),
      location('a.ts', 2, 7),
      location('a.ts', 2, 3),
    ])).toEqual([
      location('a.ts', 2, 3),
      location('a.ts', 2, 7),
      location('a.ts', 9, 1),
      location('b.ts', 1, 1),
    ])
  })
})

describe('ReferenceService.findReferences', () => {
  it('reports every cross-project reference, including the declaration itself', async () => {
    const nav = await navigator()
    const result = nav.findReferences(fixture!.declarationFile, HELPER_DECLARATION.line, HELPER_DECLARATION.character)
    expect(result.total).toBe(7)
    expect(result.truncated).toBe(false)
    expect(result.references).toEqual([
      { path: fixture!.declarationFile, line: 3, character: 17, text: 'export function helper(widget: Widget): string {' },
      { path: fixture!.consumerFile, line: 1, character: 10, text: 'import { helper } from \'../../pkg-a/src/index.ts\'' },
      { path: fixture!.consumerFile, line: 3, character: 22, text: 'export const pair = [helper, helper]' },
      { path: fixture!.consumerFile, line: 3, character: 30, text: 'export const pair = [helper, helper]' },
      { path: fixture!.consumerFile, line: 5, character: 23, text: 'export const single = helper' },
      { path: fixture!.rootFile, line: 1, character: 10, text: 'import { helper } from \'./pkg-a/src/index.ts\'' },
      { path: fixture!.rootFile, line: 2, character: 25, text: 'export const fromRoot = helper' },
    ])
  }, 30_000)

  it('reaches a symbol declared in a project the ROOT config only references', async () => {
    const nav = await navigator()
    // `Widget` lives in shared/, which the root tsconfig never includes directly.
    const shared = join(fixture!.root, 'shared', 'src', 'types.ts')
    const result = nav.findReferences(shared, 1, 18)
    expect(result.total).toBeGreaterThan(1)
    expect(result.references.map(location => location.path)).toContain(fixture!.declarationFile)
  }, 30_000)

  it('retains at most maxReferences and reports the pre-cap total', async () => {
    const nav = await navigator({ maxReferences: 2 })
    const result = nav.findReferences(fixture!.declarationFile, HELPER_DECLARATION.line, HELPER_DECLARATION.character)
    expect(result.references).toHaveLength(2)
    expect(result.total).toBe(7)
    expect(result.truncated).toBe(true)
  }, 30_000)

  it('caps each location\'s source-line preview at maxLineChars', async () => {
    const nav = await navigator({ maxLineChars: 6 })
    const result = nav.findReferences(fixture!.declarationFile, HELPER_DECLARATION.line, HELPER_DECLARATION.character)
    expect(result.references.every(location => location.text.length <= 6)).toBe(true)
    expect(result.references[0]?.text).toBe('export')
  }, 30_000)

  it('answers an off-symbol position with no references rather than failing', async () => {
    const nav = await navigator()
    // Line 2 of the declaration file is blank.
    expect(nav.findReferences(fixture!.declarationFile, 2, 1)).toMatchObject({ total: 0, references: [], truncated: false })
  }, 30_000)

  it('clamps a column past the end of its line instead of throwing', async () => {
    const nav = await navigator()
    expect(nav.findReferences(fixture!.declarationFile, 3, 5_000).total).toBe(0)
  }, 30_000)

  it('refuses a file outside the project file set', async () => {
    const nav = await navigator()
    const stray = join(fixture!.root, 'stray.ts')
    await writeFile(stray, 'export const stray = 1\n')
    expect(() => nav.findReferences(stray, 1, 14)).toThrow(/not part of the .* project file set/)
  }, 30_000)

  it('refuses a line below the 1-based floor', async () => {
    const nav = await navigator()
    expect(() => nav.findReferences(fixture!.declarationFile, 0, 1)).toThrow(/line 0 is out of range/)
  }, 30_000)

  it('refuses a line past the end of the file', async () => {
    const nav = await navigator()
    expect(() => nav.findReferences(fixture!.declarationFile, 9_000, 1)).toThrow(/line 9000 is out of range/)
  }, 30_000)

  it('refuses a character below the 1-based floor', async () => {
    const nav = await navigator()
    expect(() => nav.findReferences(fixture!.declarationFile, 3, 0)).toThrow(/character 0 is out of range/)
  }, 30_000)

  it('exposes the navigable file set', async () => {
    const nav = await navigator()
    expect(nav.fileNames).toContain(fixture!.consumerFile)
  }, 30_000)
})

describe('ReferenceService.getDefinition', () => {
  it('resolves a cross-project use to its declaration anchor', async () => {
    const nav = await navigator()
    const result = nav.getDefinition(fixture!.consumerFile, 5, 23)
    expect(result).toEqual({
      path: fixture!.consumerFile,
      line: 5,
      character: 23,
      definitions: [{
        path: fixture!.declarationFile,
        line: 3,
        character: 17,
        text: 'export function helper(widget: Widget): string {',
      }],
    })
  }, 30_000)

  it('answers an off-symbol position with no declarations', async () => {
    const nav = await navigator()
    expect(nav.getDefinition(fixture!.declarationFile, 2, 1).definitions).toEqual([])
  }, 30_000)
})
