import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LspProviderId, type LspLocation, type LspOperation, type LspProviderQuery } from '@deepseek-ai/dsh-lsp'
import type { TypeScriptNavigationEngine } from '@deepseek-ai/dsh-lsp-typescript-inprocess/src/engine.ts'
import { TYPESCRIPT_EXTENSIONS, createTypeScriptProvider } from '@deepseek-ai/dsh-lsp-typescript-inprocess/src/provider.ts'

type Call = { method: string; filePath: string; line: number }

/** A stub engine that records the file path and position each method receives. */
function stubEngine(calls: Call[]): TypeScriptNavigationEngine {
  const loc = (line: number): LspLocation => ({
    uri: 'file:///target.ts',
    range: { start: { line, character: 0 }, end: { line, character: 1 } },
  })
  const record = (method: string, filePath: string, line: number): void => { calls.push({ method, filePath, line }) }
  return {
    definition: (f: string, p: { line: number }) => { record('definition', f, p.line); return [loc(1)] },
    references: (f: string, p: { line: number }) => { record('references', f, p.line); return [loc(2)] },
    implementation: (f: string, p: { line: number }) => { record('implementation', f, p.line); return [loc(3)] },
    hover: (f: string, p: { line: number }) => { record('hover', f, p.line); return { contents: 'H' } },
  } as unknown as TypeScriptNavigationEngine
}

function query(over: Partial<LspProviderQuery>): LspProviderQuery {
  return {
    operation: 'goToDefinition',
    filePath: 'a.ts',
    position: { line: 5, character: 2 },
    workspaceRoot: '/ws',
    languageId: 'typescript',
    ...over,
  }
}

describe('createTypeScriptProvider', () => {
  it('claims the TypeScript extensions and a stable id', () => {
    const provider = createTypeScriptProvider(LspProviderId('typescript-inprocess'), stubEngine([]))
    expect(provider.id).toBe('typescript-inprocess')
    expect(provider.extensionToLanguage).toBe(TYPESCRIPT_EXTENSIONS)
    expect(TYPESCRIPT_EXTENSIONS).toEqual({ '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript' })
  })

  it.each([
    ['goToDefinition', 'definition', 1],
    ['findReferences', 'references', 2],
    ['goToImplementation', 'implementation', 3],
  ] as const)('dispatches %s to engine.%s and stamps resolvedWorkspaceUri', async (operation, method, line) => {
    const calls: Call[] = []
    const provider = createTypeScriptProvider(LspProviderId('typescript-inprocess'), stubEngine(calls))
    const result = await provider.query(query({ operation }))
    expect(result.kind).toBe('locations')
    if (result.kind !== 'locations') throw new Error('expected locations')
    expect(result.locations[0]!.range.start.line).toBe(line)
    expect(result.resolvedWorkspaceUri).toBe(pathToFileURL(resolve('/ws')).href)
    expect(calls[0]!.method).toBe(method)
  })

  it('dispatches hover to engine.hover as a hover result', async () => {
    const calls: Call[] = []
    const provider = createTypeScriptProvider(LspProviderId('typescript-inprocess'), stubEngine(calls))
    const result = await provider.query(query({ operation: 'hover' }))
    expect(result).toEqual({ kind: 'hover', hover: { contents: 'H' } })
    expect(calls[0]!.method).toBe('hover')
  })

  it('resolves a relative filePath against workspaceRoot and passes an absolute path unchanged', async () => {
    const calls: Call[] = []
    const provider = createTypeScriptProvider(LspProviderId('typescript-inprocess'), stubEngine(calls))
    await provider.query(query({ filePath: 'pkg/a.ts', workspaceRoot: '/ws' }))
    expect(calls[0]!.filePath).toBe(resolve('/ws', 'pkg/a.ts'))
    await provider.query(query({ filePath: '/abs/b.ts', workspaceRoot: '/ws' }))
    expect(calls[1]!.filePath).toBe(resolve('/abs/b.ts'))
  })

  it('rejects when the caller signal is already aborted (no engine call)', async () => {
    const calls: Call[] = []
    const provider = createTypeScriptProvider(LspProviderId('typescript-inprocess'), stubEngine(calls))
    await expect(provider.query(query({}), AbortSignal.abort())).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })

  it('throws the exhaustiveness guard for an operation outside the closed set', async () => {
    const provider = createTypeScriptProvider(LspProviderId('typescript-inprocess'), stubEngine([]))
    await expect(provider.query(query({ operation: 'renameSymbol' as LspOperation })))
      .rejects.toThrow(/unsupported LSP operation: renameSymbol/)
  })

  it('forwards a live (non-aborted) signal without throwing', async () => {
    const provider = createTypeScriptProvider(LspProviderId('typescript-inprocess'), stubEngine([]))
    const result = await provider.query(query({}), new AbortController().signal)
    expect(result.kind).toBe('locations')
  })
})
