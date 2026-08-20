// Proves the plugin survives a REAL Loader composition: a cordis.yml booted
// through the Loader mounts the namespace plugin (name/inject/apply), the
// registered tool is callable end to end, and the pinned block reaches the
// assembled system prompt of that same booted composition.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId } from '@deepseek-ai/dsh-llm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as PluginPinnedScratchpad from '@deepseek-ai/dsh-plugin-pinned-scratchpad'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(pluginEntry: string = "- name: '@deepseek-ai/dsh-plugin-pinned-scratchpad'"): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-pinned-scratchpad-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    pluginEntry,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-plugin-pinned-scratchpad', PluginPinnedScratchpad],
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

/** Call `scratchpad_update` through the booted registry, failing loud on an error result. */
async function update(ctx: Context, id: string, key: string, value: string | null): Promise<void> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(id),
    name: 'scratchpad_update',
    arguments: { key, value },
  })
  if (result.isError) throw new Error(`scratchpad_update failed: ${JSON.stringify(result)}`)
}

describe('plugin-pinned-scratchpad real Loader composition through cordis.yml', () => {
  it('exposes scratchpad_update and pins a note from the booted composition', async () => {
    const ctx = await boot()
    const schema = ctx.tools.schemas().find(s => s.name === 'scratchpad_update')
    expect(schema).toBeDefined()

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('composed-pin'),
      name: 'scratchpad_update',
      arguments: { key: 'task', value: 'finish the harness lane' },
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected scratchpad_update success')
    expect(result.value).toEqual({ key: 'task', action: 'set', entries: 1, dropped: 0 })
  }, 30_000)

  it('renders the pinned block into the assembled prompt of the booted composition', async () => {
    const ctx = await boot()
    await update(ctx, 'composed-inject', 'task', 'finish the harness lane')
    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    expect(prompt).toContain('<agent_scratchpad>')
    expect(prompt).toContain('task: finish the harness lane')
    expect(prompt).toContain('</agent_scratchpad>')
  }, 30_000)

  it('contributes no section at all while the scratchpad is empty', async () => {
    const ctx = await boot()
    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    expect(prompt).not.toContain('agent_scratchpad')
  }, 30_000)

  it('honors a configured maxTokens through the Loader', async () => {
    const ctx = await boot(
      "- name: '@deepseek-ai/dsh-plugin-pinned-scratchpad'\n  config:\n    maxTokens: 24",
    )
    await update(ctx, 'composed-old', 'old', 'a'.repeat(300))
    await update(ctx, 'composed-new', 'new', 'b')
    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    expect(prompt).toContain('new: b')
    expect(prompt).not.toContain('aaa')
  }, 30_000)

  it('fails loud at load when maxTokens is not a positive integer', async () => {
    await expect(boot(
      "- name: '@deepseek-ai/dsh-plugin-pinned-scratchpad'\n  config:\n    maxTokens: 0",
    )).rejects.toThrow(/maxTokens/)
  }, 30_000)

  it('fails loud at load when maxValueBytes is not a positive integer', async () => {
    await expect(boot(
      "- name: '@deepseek-ai/dsh-plugin-pinned-scratchpad'\n  config:\n    maxValueBytes: 0",
    )).rejects.toThrow(/maxValueBytes/)
  }, 30_000)
})
