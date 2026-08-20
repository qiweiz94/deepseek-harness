// Proves the plugin survives a REAL Loader composition: a cordis.yml booted
// through the Loader mounts the namespace plugin (name/inject/apply) against
// the real subagent service and agent registry, the governor observes a real
// delegation's lifecycle, and a bad threshold fails loud at load rather than
// producing a governor that reports healthy work as a runaway.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import * as PluginGovernor from '../src/index.ts'
import type { BudgetBreach } from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(pluginEntry: string): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-budget-governor-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-subagent'",
    pluginEntry,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-subagent', SubagentRuntime],
    ['@deepseek-ai/dsh-plugin-budget-governor', PluginGovernor],
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

describe('plugin-budget-governor real Loader composition through cordis.yml', () => {
  it('registers NO model-facing tool — it is a hook plugin, not a tool plugin', async () => {
    const ctx = await boot("- name: '@deepseek-ai/dsh-plugin-budget-governor'")
    expect(ctx.tools.schemas()).toHaveLength(0)
  }, 30_000)

  it('governs a delegation started through the composed subagent service', async () => {
    const ctx = await boot(
      "- name: '@deepseek-ai/dsh-plugin-budget-governor'\n  config:\n    maxTokens: 10\n    onBreach: report",
    )
    const childId = SessionId('composed-child')
    const parentId = SessionId('composed-parent')
    const parentSession = ctx.sessions.create(parentId)
    const childSession = ctx.sessions.create(childId, { meta: { parentSession: parentId, origin: 'subagent' } })
    const injected: unknown[] = []
    const parent = {
      id: parentId,
      session: parentSession,
      inject: (message: unknown) => { injected.push(message) },
    } as unknown as Agent
    ctx.agents.register(parent)
    ctx.agents.register({ id: childId, session: childSession } as unknown as Agent)

    const settled = Promise.withResolvers<never>()
    ctx.subagents.registerProvider({
      name: 'composed',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: () => Promise.resolve({
        id: childId,
        localAgent: undefined,
        result: settled.promise,
        dispose: () => Promise.resolve(),
      } as unknown as SubagentRun),
    })

    const breaches: BudgetBreach[] = []
    ctx.on('budget-governor/breach', (breach) => { breaches.push(breach) })
    await ctx.subagents.start('composed', {
      label: 'composed delegation',
      prompt: [{ type: 'text', text: 'work' }],
      parent,
      signal: new AbortController().signal,
    })

    childSession.append('turn/start', { turn: 1 })
    childSession.append('step/start', { turn: 1, step: 0 })
    childSession.append('assistant/message', {
      turn: 1,
      step: 0,
      message: {
        id: 'composed-assistant',
        role: 'assistant',
        content: [{ type: 'text', text: 'thinking' }],
        source: { kind: 'model', provider: 'composed', model: 'composed' },
      },
      usage: { inputTokens: 20, outputTokens: 5 },
    } as never, { surfaceOp: 'append' })

    expect(breaches).toHaveLength(1)
    expect(breaches[0]?.kind).toBe('token-spend')
    expect(breaches[0]?.observed).toBe(25)
    expect(injected).toHaveLength(1)
  }, 30_000)

  it('fails loud at load on a churn threshold that would report ordinary reverts', async () => {
    await expect(boot(
      "- name: '@deepseek-ai/dsh-plugin-budget-governor'\n  config:\n    churn:\n      repeatThreshold: 1",
    )).rejects.toThrow(/repeatThreshold/)
  }, 30_000)

  it('fails loud at load on an out-of-range threshold the schema itself rejects', async () => {
    await expect(boot(
      "- name: '@deepseek-ai/dsh-plugin-budget-governor'\n  config:\n    maxConsecutiveToolFailures: -1",
    )).rejects.toThrow()
  }, 30_000)
})
