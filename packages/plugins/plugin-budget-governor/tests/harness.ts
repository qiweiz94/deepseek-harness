/**
 * Package-local harness for the budget governor's tests: a real Context with
 * the session store, agent registry, tool registry, and subagent service, a
 * scripted provider whose one-shot run stays open until the test settles it,
 * and hand-registered parent/child Agents so the governor's ancestor-authority
 * lookup resolves the way it does in a live in-process composition.
 * @module plugin-budget-governor/test/harness
 */

import { vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import SessionStore from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { CallId, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { TokenUsage, UserMessage } from '@deepseek-ai/dsh-llm'
import * as Governor from '../src/index.ts'
import type { BudgetBreach, ChurnConfig, Config } from '../src/index.ts'

/**
 * Partial governor configuration a test writes. Schemastery fills the omitted
 * keys at load; `Config` itself is typed as its own fully-resolved output, so
 * the partial crosses that one cast here instead of at every call site.
 */
export interface GovernorConfigInput {
  maxTokens?: number
  maxConsecutiveToolFailures?: number
  churn?: Partial<ChurnConfig>
  onBreach?: 'interrupt' | 'report'
}

/**
 * Resolve a partial test configuration through the real schema.
 * @param input - the keys this test cares about.
 * @returns the fully-defaulted configuration.
 */
export function governorConfig(input: GovernorConfigInput = {}): Config {
  return Governor.Config(input as unknown as Config)
}

export const PARENT_ID = SessionId('parent-session')
export const CHILD_ID = SessionId('child-session')

/** Everything a governor test drives and asserts on. */
export interface Harness {
  readonly ctx: Context
  readonly parent: Agent
  readonly child: Agent
  readonly childSession: Session
  /** Every `budget-governor/breach` payload, in emission order. */
  readonly breaches: BudgetBreach[]
  /** Every message quietly injected into the parent. */
  readonly injected: UserMessage[]
  /** Every `ctx.subagents.interrupt` call the governor made. */
  readonly interrupts: { id: SessionId; authority: unknown }[]
  /** Publish a `subagent/start` for the tracked child; returns the run settler. */
  start(): Promise<(result?: SubagentResult) => void>
  /**
   * Append one assistant message to a session's log. Omitting `usage` models
   * an adapter that reported no token accounting; passing another session
   * models a log the governor is not tracking.
   */
  spend(usage?: TokenUsage, session?: Session): void
  /** Run one tool as the child and return its normalized result. */
  call(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult>
  dispose(): Promise<void>
}

/** A structurally sufficient stand-in for a live in-process Agent. */
function fakeAgent(id: SessionId, session: Session, injected?: UserMessage[]): Agent {
  return {
    id,
    session,
    inject: (message: UserMessage) => { injected?.push(message) },
  } as unknown as Agent
}

/**
 * Boot a governor harness.
 * @param config - governor configuration overrides layered on the schema defaults.
 * @returns the booted harness.
 */
export async function createHarness(config: GovernorConfigInput = {}): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SubagentRuntime)

  const parentSession = ctx.sessions.create(PARENT_ID)
  const childSession = ctx.sessions.create(CHILD_ID, { meta: { parentSession: PARENT_ID, origin: 'subagent' } })
  const injected: UserMessage[] = []
  const parent = fakeAgent(PARENT_ID, parentSession, injected)
  const child = fakeAgent(CHILD_ID, childSession)

  const pending = Promise.withResolvers<SubagentResult>()
  const interrupts: { id: SessionId; authority: unknown }[] = []
  const realInterrupt = ctx.subagents.interrupt.bind(ctx.subagents)
  vi.spyOn(ctx.subagents, 'interrupt').mockImplementation((id, authority) => {
    interrupts.push({ id, authority })
    realInterrupt(id, authority)
  })

  ctx.subagents.registerProvider({
    name: 'scripted',
    capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
    inheritsParentContext: false,
    start: () => Promise.resolve({
      id: CHILD_ID,
      localAgent: undefined,
      result: pending.promise,
      dispose: () => Promise.resolve(),
    } satisfies SubagentRun),
  })

  ctx.tools.register(defineTool({
    name: 'ok',
    description: 'always succeeds',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: () => [{ type: 'text', text: 'ok' }],
    },
    execute: () => Promise.resolve({}),
  }))
  for (const name of ['write', 'edit']) {
    ctx.tools.register(defineTool({
      name,
      description: 'records a file mutation',
      parameters: {
        path: { type: 'string', description: 'target path' },
        content: { type: 'string', description: 'written content' },
        new_string: { type: 'string', description: 'replacement text' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: {} },
        render: () => [{ type: 'text', text: 'written' }],
      },
      execute: () => Promise.resolve({}),
    }))
  }
  ctx.tools.register(defineTool({
    name: 'boom',
    description: 'always fails',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: () => [{ type: 'text', text: 'boom' }],
    },
    execute: () => Promise.reject(new Error('scripted tool failure')),
  }))

  const breaches: BudgetBreach[] = []
  ctx.on('budget-governor/breach', (breach) => { breaches.push(breach) })
  await ctx.plugin(Governor, governorConfig(config))

  let turn = 0
  return {
    ctx,
    parent,
    child,
    childSession,
    breaches,
    injected,
    interrupts,
    async start() {
      await ctx.subagents.start('scripted', {
        label: 'scripted delegation',
        prompt: [{ type: 'text', text: 'work' }],
        parent,
        signal: new AbortController().signal,
      })
      return (result?: SubagentResult) => {
        pending.resolve(result ?? { output: [], stopReason: 'completed' })
      }
    },
    spend(usage?: TokenUsage, session: Session = childSession) {
      turn += 1
      session.append('turn/start', { turn })
      session.append('step/start', { turn, step: 0 })
      session.append('assistant/message', {
        turn,
        step: 0,
        message: createAssistantMessage({
          content: [{ type: 'text', text: 'thinking' }],
          source: { provider: 'scripted', model: 'scripted' },
        }),
        ...usage === undefined ? {} : { usage },
      }, { surfaceOp: 'append' })
    },
    call(name: string, args: Record<string, unknown>) {
      return ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId(`call-${name}-${Math.random()}`),
        name,
        arguments: args,
        agent: child,
      })
    },
    async dispose() {
      pending.resolve({ output: [], stopReason: 'completed' })
      await ctx.fiber.dispose()
    },
  }
}

/** Register the parent and child Agents so ancestor-authority lookup resolves. */
export function registerLineage(harness: Harness): void {
  harness.ctx.agents.register(harness.child)
  harness.ctx.agents.register(harness.parent)
}
