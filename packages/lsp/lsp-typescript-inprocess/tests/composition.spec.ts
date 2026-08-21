// Proves the provider works in a REAL system: booted through the Loader from a
// cordis.yml alongside the lsp seam, it answers navigation queries for a real
// on-disk TypeScript project; and disposing its fiber removes it from the seam.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Lsp, { type LspService } from '@deepseek-ai/dsh-lsp'
import * as TsProvider from '@deepseek-ai/dsh-lsp-typescript-inprocess'

let context: Context | undefined
const dirs: string[] = []
afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const MAIN = [
  '/** Doc for greet. */',
  'function greet(name: string): string { return name }',
  "const first = greet('a')",
  "const second = greet('b')",
  'interface Shape { area(): number }',
  'class Circle implements Shape { area() { return 1 } }',
  '',
].join('\n')

/** A fresh TypeScript fixture project; realpath so it matches the engine's resolved file names. */
function fixture(): { root: string; tsconfig: string; mainFile: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-tsnav-comp-')))
  dirs.push(root)
  writeFileSync(join(root, 'main.ts'), MAIN)
  const tsconfig = join(root, 'tsconfig.json')
  writeFileSync(tsconfig, JSON.stringify({
    // noLib avoids loading the TypeScript standard library on every boot; in-file
    // navigation does not need it, and it keeps this composition test fast.
    compilerOptions: { strict: true, target: 'esnext', module: 'esnext', moduleResolution: 'bundler', noEmit: true, noLib: true },
    files: ['main.ts'],
  }))
  return { root, tsconfig, mainFile: join(root, 'main.ts') }
}

/** Boot lsp + the provider through the Loader from a written cordis.yml. */
async function bootLoader(tsconfigPath: string): Promise<Context> {
  const bootRoot = mkdtempSync(join(tmpdir(), 'dsh-tsnav-boot-'))
  dirs.push(bootRoot)
  const configPath = join(bootRoot, 'cordis.yml')
  writeFileSync(configPath, [
    "- name: '@deepseek-ai/dsh-lsp'",
    "- name: '@deepseek-ai/dsh-lsp-typescript-inprocess'",
    '  config:',
    `    tsconfigPath: ${JSON.stringify(tsconfigPath)}`,
    '',
  ].join('\n'))
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(bootRoot).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-lsp', Lsp],
    ['@deepseek-ai/dsh-lsp-typescript-inprocess', TsProvider],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('lsp-typescript-inprocess real Loader composition', () => {
  it('serves all four operations for a TypeScript file through ctx.lsp', async () => {
    const { root, tsconfig, mainFile } = fixture()
    const ctx = await bootLoader(tsconfig)
    const lsp = ctx.get('lsp') as LspService

    const refs = await lsp.query({ operation: 'findReferences', filePath: mainFile, position: { line: 1, character: 9 }, workspaceRoot: root })
    expect(refs.kind).toBe('locations')
    if (refs.kind !== 'locations') throw new Error('expected locations')
    expect(refs.locations).toHaveLength(3) // declaration + two call sites
    expect(refs.resolvedWorkspaceUri).toBe(pathToFileURL(root).href)

    const def = await lsp.query({ operation: 'goToDefinition', filePath: mainFile, position: { line: 2, character: 14 }, workspaceRoot: root })
    if (def.kind !== 'locations') throw new Error('expected locations')
    expect(def.locations[0]!.range.start.line).toBe(1)

    const impl = await lsp.query({ operation: 'goToImplementation', filePath: mainFile, position: { line: 4, character: 10 }, workspaceRoot: root })
    if (impl.kind !== 'locations') throw new Error('expected locations')
    expect(impl.locations.some(l => l.range.start.line === 5)).toBe(true)

    const hover = await lsp.query({ operation: 'hover', filePath: mainFile, position: { line: 1, character: 9 }, workspaceRoot: root })
    if (hover.kind !== 'hover') throw new Error('expected hover')
    expect(hover.hover?.contents).toContain('Doc for greet.')
  }, 60_000)

  it('removes the provider from the seam when its fiber disposes', async () => {
    const { root, tsconfig, mainFile } = fixture()
    const ctx = new Context()
    context = ctx
    await ctx.plugin(Lsp)
    const fiber = await ctx.plugin(TsProvider, { tsconfigPath: tsconfig })
    const lsp = ctx.get('lsp') as LspService
    await expect(lsp.query({ operation: 'findReferences', filePath: mainFile, position: { line: 1, character: 9 }, workspaceRoot: root }))
      .resolves.toMatchObject({ kind: 'locations' })
    await fiber.dispose()
    await expect(lsp.query({ operation: 'findReferences', filePath: mainFile, position: { line: 1, character: 9 }, workspaceRoot: root }))
      .rejects.toThrow(expect.objectContaining({ code: 'LSP_UNAVAILABLE' }))
  }, 60_000)

  it('fails loud at mount when the configured tsconfig cannot be loaded', async () => {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(Lsp)
    await expect(ctx.plugin(TsProvider, { tsconfigPath: join(tmpdir(), 'dsh-tsnav-does-not-exist', 'tsconfig.json') }))
      .rejects.toThrow(/cannot load the TypeScript project/)
  })
})
