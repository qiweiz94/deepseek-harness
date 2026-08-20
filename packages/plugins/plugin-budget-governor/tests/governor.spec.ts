// Drives the governor through the REAL observe hooks — a real
// `ctx.subagents.start` lifecycle pair, real `ctx.tools.execute` results, and
// real appends to the child's own session log — and asserts every threshold
// branch, both sides of each boundary, and the reset paths that let each
// detector clear.
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  advanceChurn,
  billedTokens,
  contentDigest,
  describeEnforcement,
  firstStringArgument,
  MAX_TRACKED_CHURN_PATHS,
  renderTerminationReport,
  resolveSettings,
} from '../src/index.ts'
import type { BudgetBreach, ChurnChain } from '../src/index.ts'
import { CHILD_ID, createHarness, governorConfig, PARENT_ID, registerLineage } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

async function boot(config: Parameters<typeof createHarness>[0] = {}, lineage = true): Promise<Harness> {
  const created = await createHarness(config)
  harness = created
  if (lineage) registerLineage(created)
  await created.start()
  return created
}

function reportText(harness: Harness): string {
  const block = harness.injected[0]?.content[0]
  return block !== undefined && block.type === 'text' ? block.text : ''
}

describe('billedTokens', () => {
  it('sums the three DISJOINT input counts plus output', () => {
    expect(billedTokens({ inputTokens: 10, outputTokens: 3, cacheReadTokens: 100, cacheWriteTokens: 7 })).toBe(120)
  })

  it('treats absent cache fields as zero', () => {
    expect(billedTokens({ inputTokens: 10, outputTokens: 3 })).toBe(13)
  })

  it('excludes reasoningTokens, which providers report inside outputTokens', () => {
    expect(billedTokens({ inputTokens: 1, outputTokens: 8, reasoningTokens: 5 })).toBe(9)
  })
})

describe('firstStringArgument', () => {
  it('returns the first key present as a string, in precedence order', () => {
    expect(firstStringArgument({ file_path: 'b', path: 'a' }, ['path', 'file_path'])).toBe('a')
    expect(firstStringArgument({ file_path: 'b' }, ['path', 'file_path'])).toBe('b')
  })

  it('ignores non-string values and missing keys', () => {
    expect(firstStringArgument({ path: 7 }, ['path'])).toBeUndefined()
    expect(firstStringArgument({}, ['path'])).toBeUndefined()
  })

  it('rejects non-object arguments', () => {
    expect(firstStringArgument('nope', ['path'])).toBeUndefined()
    expect(firstStringArgument(null, ['path'])).toBeUndefined()
  })
})

describe('contentDigest', () => {
  it('joins every configured content key that carries a string', () => {
    expect(contentDigest({ content: 'a', new_string: 'b' }, ['content', 'new_string']))
      .toBe('content\u0000a\u0001new_string\u0000b')
  })

  it('is undefined when the call wrote no recognizable content', () => {
    expect(contentDigest({ path: 'a' }, ['content'])).toBeUndefined()
    expect(contentDigest({ content: 5 }, ['content'])).toBeUndefined()
  })

  it('rejects non-object arguments', () => {
    expect(contentDigest(42, ['content'])).toBeUndefined()
    expect(contentDigest(null, ['content'])).toBeUndefined()
  })
})

describe('advanceChurn', () => {
  it('counts a flip back to the content before last as one revisit', () => {
    const chain = { revisits: 0 }
    expect(advanceChurn(chain, 'A')).toBe(0)
    expect(advanceChurn(chain, 'B')).toBe(0)
    expect(advanceChurn(chain, 'A')).toBe(1)
    expect(advanceChurn(chain, 'B')).toBe(2)
  })

  it('does not advance on an idempotent rewrite of the same content', () => {
    const chain: ChurnChain = { revisits: 0 }
    advanceChurn(chain, 'A')
    advanceChurn(chain, 'B')
    advanceChurn(chain, 'A')
    expect(advanceChurn(chain, 'A')).toBe(1)
    expect(chain.previous).toBe('A')
  })

  it('CLEARS on genuinely new content, so the detector can come back down', () => {
    const chain = { revisits: 0 }
    advanceChurn(chain, 'A')
    advanceChurn(chain, 'B')
    expect(advanceChurn(chain, 'A')).toBe(1)
    expect(advanceChurn(chain, 'C')).toBe(0)
  })
})

describe('resolveSettings', () => {
  it('fills the documented defaults', () => {
    const settings = resolveSettings(governorConfig({}))
    expect(settings.maxTokens).toBeUndefined()
    expect(settings.maxConsecutiveToolFailures).toBe(4)
    expect(settings.churnEnabled).toBe(true)
    expect(settings.churnRepeatThreshold).toBe(2)
    expect(settings.churnTools).toEqual(['write', 'edit', 'str_replace_editor'])
    expect(settings.onBreach).toBe('interrupt')
  })

  it('carries an explicit token budget through', () => {
    expect(resolveSettings(governorConfig({ maxTokens: 50 })).maxTokens).toBe(50)
  })

  it('rejects a zero token budget rather than breaching on the first call', () => {
    expect(() => resolveSettings({ ...governorConfig({}), maxTokens: 0 })).toThrow(/maxTokens/)
  })

  it('rejects a zero tool-failure limit', () => {
    expect(() => resolveSettings({ ...governorConfig({}), maxConsecutiveToolFailures: 0 })).toThrow(/maxConsecutiveToolFailures/)
  })

  it('rejects a churn threshold below 2, which would report an ordinary revert', () => {
    expect(() => resolveSettings(governorConfig({ churn: { repeatThreshold: 1 } }))).toThrow(/repeatThreshold/)
  })

  it('rejects churn enabled with no mutation tools, path keys, or content keys', () => {
    expect(() => resolveSettings(governorConfig({ churn: { tools: [] } }))).toThrow(/churn\.tools/)
    expect(() => resolveSettings(governorConfig({ churn: { pathKeys: [] } }))).toThrow(/churn\.pathKeys/)
    expect(() => resolveSettings(governorConfig({ churn: { contentKeys: [] } }))).toThrow(/churn\.contentKeys/)
  })

  it('skips every churn bound when churn accounting is disabled', () => {
    const settings = resolveSettings(governorConfig({ churn: { enabled: false, tools: [], pathKeys: [], contentKeys: [], repeatThreshold: 0 } }))
    expect(settings.churnEnabled).toBe(false)
  })
})

describe('token-spend budget', () => {
  it('accumulates billed tokens across calls and breaches only ABOVE the ceiling', async () => {
    const h = await boot({ maxTokens: 100 })
    h.spend({ inputTokens: 40, outputTokens: 10, cacheReadTokens: 50 })
    expect(h.breaches).toHaveLength(0)
    h.spend({ inputTokens: 1, outputTokens: 0 })
    expect(h.breaches).toHaveLength(1)
    const breach = h.breaches[0] as BudgetBreach
    expect(breach.kind).toBe('token-spend')
    expect(breach.observed).toBe(101)
    expect(breach.threshold).toBe(100)
    expect(breach.provider).toBe('scripted')
    expect(breach.subagentId).toBe(CHILD_ID)
  })

  it('never breaches when no token budget is configured', async () => {
    const h = await boot({})
    h.spend({ inputTokens: 10_000_000, outputTokens: 10_000_000 })
    expect(h.breaches).toHaveLength(0)
  })

  it('ignores an assistant message with no adapter-reported usage', async () => {
    const h = await boot({ maxTokens: 1 })
    h.spend()
    expect(h.breaches).toHaveLength(0)
  })

  it('ignores every session event that is not an assistant message', async () => {
    const h = await boot({ maxTokens: 1 })
    h.childSession.append('turn/start', { turn: 99 })
    expect(h.breaches).toHaveLength(0)
  })

  it('ignores assistant messages from a session that is not a tracked subagent', async () => {
    const h = await boot({ maxTokens: 1 })
    const stranger = h.ctx.sessions.create(SessionId('unrelated'))
    h.spend({ inputTokens: 5000, outputTokens: 5000 }, stranger)
    expect(h.breaches).toHaveLength(0)
  })
})

describe('consecutive tool-failure budget', () => {
  it('breaches on the call AFTER the tolerated run, not on it', async () => {
    const h = await boot({ maxConsecutiveToolFailures: 4 })
    for (let i = 0; i < 4; i += 1) await h.call('boom', {})
    expect(h.breaches).toHaveLength(0)
    await h.call('boom', {})
    expect(h.breaches).toHaveLength(1)
    const breach = h.breaches[0] as BudgetBreach
    expect(breach.kind).toBe('tool-failures')
    expect(breach.observed).toBe(5)
    expect(breach.threshold).toBe(4)
  })

  it('resets the run on a success, so a recovering child never breaches', async () => {
    const h = await boot({ maxConsecutiveToolFailures: 2 })
    await h.call('boom', {})
    await h.call('boom', {})
    await h.call('ok', {})
    await h.call('boom', {})
    await h.call('boom', {})
    expect(h.breaches).toHaveLength(0)
    await h.call('boom', {})
    expect(h.breaches).toHaveLength(1)
  })

  it('ignores tool results from an untracked agent and from calls with no agent', async () => {
    const h = await boot({ maxConsecutiveToolFailures: 1 }, false)
    // The run IS tracked, but a call with no calling agent has nothing to bill.
    await h.ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'agentless' as never,
      name: 'boom',
      arguments: {},
    })
    expect(h.breaches).toHaveLength(0)
  })

  it('stops accounting a run once its lifecycle ends', async () => {
    const h = await boot({ maxConsecutiveToolFailures: 1 })
    const settle = await h.start()
    settle()
    await new Promise(resolve => setTimeout(resolve, 0))
    await h.call('boom', {})
    await h.call('boom', {})
    expect(h.breaches).toHaveLength(0)
  })
})

describe('oscillating file-churn budget', () => {
  it('breaches only after MORE than the tolerated flips back to earlier content', async () => {
    const h = await boot({ churn: { repeatThreshold: 2 } })
    await h.call('write', { path: 'a.ts', content: 'A' })
    await h.call('write', { path: 'a.ts', content: 'B' })
    await h.call('write', { path: 'a.ts', content: 'A' })
    await h.call('write', { path: 'a.ts', content: 'B' })
    expect(h.breaches).toHaveLength(0)
    await h.call('write', { path: 'a.ts', content: 'A' })
    expect(h.breaches).toHaveLength(1)
    const breach = h.breaches[0] as BudgetBreach
    expect(breach.kind).toBe('file-churn')
    expect(breach.observed).toBe(3)
    expect(breach.threshold).toBe(2)
    expect(breach.path).toBe('a.ts')
  })

  it('keeps a separate chain per file, so alternating between two files is not churn', async () => {
    const h = await boot({ churn: { repeatThreshold: 2 } })
    for (let i = 0; i < 6; i += 1) {
      await h.call('write', { path: `${i % 2}.ts`, content: `v${i}` })
    }
    expect(h.breaches).toHaveLength(0)
  })

  it('clears the chain when the child writes genuinely new content', async () => {
    const h = await boot({ churn: { repeatThreshold: 2 } })
    await h.call('write', { path: 'a.ts', content: 'A' })
    await h.call('write', { path: 'a.ts', content: 'B' })
    await h.call('write', { path: 'a.ts', content: 'A' })
    await h.call('write', { path: 'a.ts', content: 'C' })
    await h.call('write', { path: 'a.ts', content: 'A' })
    await h.call('write', { path: 'a.ts', content: 'C' })
    expect(h.breaches).toHaveLength(0)
  })

  it('fingerprints an edit-shaped call from its replacement text', async () => {
    const h = await boot({ churn: { repeatThreshold: 2 } })
    for (const value of ['A', 'B', 'A', 'B', 'A']) {
      await h.call('edit', { path: 'a.ts', new_string: value })
    }
    expect(h.breaches).toHaveLength(1)
  })

  it('accounts nothing when churn is disabled', async () => {
    const h = await boot({ churn: { enabled: false } })
    for (const value of ['A', 'B', 'A', 'B', 'A', 'B', 'A']) {
      await h.call('write', { path: 'a.ts', content: value })
    }
    expect(h.breaches).toHaveLength(0)
  })

  it('ignores a tool outside the configured mutation set', async () => {
    const h = await boot({ churn: { tools: ['str_replace_editor'] } })
    for (const value of ['A', 'B', 'A', 'B', 'A']) {
      await h.call('write', { path: 'a.ts', content: value })
    }
    expect(h.breaches).toHaveLength(0)
  })

  it('ignores a mutation with no attributable path or no fingerprintable content', async () => {
    const h = await boot({ churn: { repeatThreshold: 2 } })
    for (let i = 0; i < 6; i += 1) await h.call('write', { content: 'A' })
    for (let i = 0; i < 6; i += 1) await h.call('write', { path: 'a.ts' })
    expect(h.breaches).toHaveLength(0)
  })

  it('evicts the oldest chain past the tracked-path cap rather than growing without bound', async () => {
    const h = await boot({ churn: { repeatThreshold: 2 } })
    await h.call('write', { path: 'first.ts', content: 'A' })
    await h.call('write', { path: 'first.ts', content: 'B' })
    for (let i = 0; i < MAX_TRACKED_CHURN_PATHS; i += 1) {
      await h.call('write', { path: `f${i}.ts`, content: 'A' })
    }
    // first.ts was evicted, so its chain restarts from scratch and cannot breach.
    await h.call('write', { path: 'first.ts', content: 'A' })
    await h.call('write', { path: 'first.ts', content: 'B' })
    await h.call('write', { path: 'first.ts', content: 'A' })
    expect(h.breaches).toHaveLength(0)
  })
})

describe('breach response', () => {
  it('requests the seam stop under ancestor authority and reports to the parent', async () => {
    const h = await boot({ maxTokens: 10 })
    h.spend({ inputTokens: 100, outputTokens: 0 })
    expect(h.interrupts).toEqual([{ id: CHILD_ID, authority: { kind: 'ancestor', agent: h.parent } }])
    expect((h.breaches[0] as BudgetBreach).enforcement).toEqual({ kind: 'interrupted' })
    expect(h.injected).toHaveLength(1)
    expect(h.injected[0]?.source).toMatchObject({ kind: 'plugin', plugin: '@deepseek-ai/dsh-plugin-budget-governor', form: 'notice' })
    expect(reportText(h)).toContain('stop requested through ctx.subagents.interrupt()')
    expect(reportText(h)).toContain(`subagent ${CHILD_ID}`)
  })

  it('reports without ever asking the seam to stop under onBreach: report', async () => {
    const h = await boot({ maxTokens: 10, onBreach: 'report' })
    h.spend({ inputTokens: 100, outputTokens: 0 })
    expect(h.interrupts).toHaveLength(0)
    expect((h.breaches[0] as BudgetBreach).enforcement).toEqual({ kind: 'reported' })
    expect(reportText(h)).toContain('reported only')
  })

  it('is loudly unenforceable when no live ancestor Agent can be resolved', async () => {
    const h = await boot({ maxTokens: 10 }, false)
    h.spend({ inputTokens: 100, outputTokens: 0 })
    expect(h.interrupts).toHaveLength(0)
    expect(h.injected).toHaveLength(0)
    const enforcement = (h.breaches[0] as BudgetBreach).enforcement
    expect(enforcement.kind).toBe('unenforceable')
    expect(h.breaches).toHaveLength(1)
  })

  it('is unenforceable when the child is live but its recorded parent has left the registry', async () => {
    const h = await boot({ maxTokens: 10 }, false)
    h.ctx.agents.register(h.child)
    h.spend({ inputTokens: 100, outputTokens: 0 })
    expect((h.breaches[0] as BudgetBreach).enforcement.kind).toBe('unenforceable')
  })

  it('breaches at most once per run, even as the runaway keeps going', async () => {
    const h = await boot({ maxTokens: 10, maxConsecutiveToolFailures: 1 })
    h.spend({ inputTokens: 100, outputTokens: 0 })
    h.spend({ inputTokens: 100, outputTokens: 0 })
    await h.call('boom', {})
    await h.call('boom', {})
    await h.call('boom', {})
    expect(h.breaches).toHaveLength(1)
    expect(h.interrupts).toHaveLength(1)
  })
})

describe('report rendering', () => {
  const base: BudgetBreach = {
    subagentId: SessionId('c1'),
    provider: 'scripted',
    kind: 'token-spend',
    observed: 11,
    threshold: 10,
    reason: 'spent 11 billed tokens against a 10-token budget',
    enforcement: { kind: 'interrupted' },
  }

  it('omits the path line for a non-churn breach and includes it for churn', () => {
    expect(renderTerminationReport(base)).not.toContain('path:')
    const churn = renderTerminationReport({ ...base, kind: 'file-churn', path: 'a.ts' })
    expect(churn).toContain('path: a.ts')
    expect(churn).toContain('provider: scripted')
  })

  it('renders each enforcement outcome distinctly', () => {
    expect(describeEnforcement({ kind: 'interrupted' })).toContain('ctx.subagents.interrupt()')
    expect(describeEnforcement({ kind: 'reported' })).toContain('reported only')
    expect(describeEnforcement({ kind: 'unenforceable', why: 'no parent' })).toBe('NOT STOPPED — no parent')
  })

  it('names the parent session the report is delivered to', async () => {
    const h = await boot({ maxTokens: 10 })
    h.spend({ inputTokens: 100, outputTokens: 0 })
    expect(h.parent.id).toBe(PARENT_ID)
    expect(reportText(h)).toContain('Do not re-delegate the same task unchanged')
  })
})
