// Proves the plugin survives a REAL Loader composition: a cordis.yml booted
// through the Loader mounts the namespace plugin (name/inject/apply) and both
// registered tools are callable end to end, with their presentation intents.
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId } from '@deepseek-ai/dsh-llm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as PluginLspReferences from '@deepseek-ai/dsh-plugin-lsp-references'
import { buildFixture, HELPER_DECLARATION, type Fixture } from './fixture.ts'

let fixture: Fixture | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (fixture !== undefined) await rm(fixture.root, { recursive: true, force: true })
  fixture = undefined
})

async function boot(configLines: string[] = []): Promise<Context> {
  fixture ??= await buildFixture()
  const configPath = join(fixture.root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-plugin-lsp-references'",
    '  config:',
    `    tsconfigPath: ${JSON.stringify(fixture.tsconfigPath)}`,
    ...configLines,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(fixture.root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-plugin-lsp-references', PluginLspReferences],
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

async function call(ctx: Context, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`composed-${name}`),
    name,
    arguments: args,
  })
  if (result.isError) throw new Error(`expected ${name} success, got: ${JSON.stringify(result.content)}`)
  const [block] = result.content
  if (block?.type !== 'text') throw new Error(`expected ${name} to render text`)
  return block.text
}

describe('plugin-lsp-references real Loader composition through cordis.yml', () => {
  it('exposes both navigation tools from the booted composition', async () => {
    const ctx = await boot()
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toContain('find_references')
    expect(names).toContain('get_definition')
  }, 60_000)

  it('finds every cross-project reference and renders one line per location', async () => {
    const ctx = await boot()
    const text = await call(ctx, 'find_references', {
      path: fixture!.declarationFile,
      line: HELPER_DECLARATION.line,
      character: HELPER_DECLARATION.character,
    })
    expect(text).toContain('7 references to the symbol at')
    expect(text).toContain(`${fixture!.consumerFile}:3:22  export const pair = [helper, helper]`)
    expect(text).not.toContain('omitted by the result cap')
  }, 60_000)

  it('renders the singular count and the cap notice when maxReferences bites', async () => {
    const ctx = await boot(['    maxReferences: 1'])
    const text = await call(ctx, 'find_references', {
      path: fixture!.declarationFile,
      line: HELPER_DECLARATION.line,
      character: HELPER_DECLARATION.character,
    })
    expect(text).toContain('6 further reference(s) omitted by the result cap')

    // A position with exactly one reference renders the singular head line.
    const single = await call(ctx, 'find_references', { path: fixture!.rootFile, line: 2, character: 14 })
    expect(single).toContain('1 reference to the symbol at')
  }, 60_000)

  it('resolves a use to its declaration anchor and renders it', async () => {
    const ctx = await boot()
    const text = await call(ctx, 'get_definition', { path: fixture!.consumerFile, line: 5, character: 23 })
    expect(text).toBe(
      `1 declaration of the symbol at ${fixture!.consumerFile}:5:23\n`
      + `${fixture!.declarationFile}:3:17  export function helper(widget: Widget): string {`,
    )
  }, 60_000)

  it('renders the plural head line when a position declares nothing', async () => {
    const ctx = await boot()
    const text = await call(ctx, 'get_definition', { path: fixture!.declarationFile, line: 2, character: 1 })
    expect(text).toBe(`0 declarations of the symbol at ${fixture!.declarationFile}:2:1\n`)
  }, 60_000)

  it('presents each call as a follow-along search card at the queried position', async () => {
    const ctx = await boot()
    const args = { path: fixture!.declarationFile, line: 3, character: 17 }
    for (const [name, title] of [['find_references', 'Find references'], ['get_definition', 'Get definition']] as const) {
      expect(ctx.tools.get(name)?.presentCall?.(args)).toEqual({
        card: 'generic',
        title,
        kind: 'search',
        rawInput: `${fixture!.declarationFile}:3:17`,
        locations: [{ path: fixture!.declarationFile, line: 3 }],
      })
    }
  }, 60_000)

  it('disposes cleanly when no call ever built the language service', async () => {
    const ctx = await boot()
    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('find_references')
    await expect(ctx.fiber.dispose()).resolves.not.toThrow()
    context = undefined
  }, 60_000)

  it('fails loud at load when maxReferences is not a positive integer', async () => {
    await expect(boot(['    maxReferences: 0'])).rejects.toThrow(/maxReferences/)
  }, 60_000)
})
