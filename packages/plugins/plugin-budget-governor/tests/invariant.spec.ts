// The companion asserts a relation the governor alone owns: a breach verdict
// is TERMINAL and EARNED. Each check is driven against a known-healthy breach
// (it must stay silent) and a known-bad one (it must fail loud).
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { BudgetBreach } from '../src/index.ts'
import * as Invariant from '../src/invariant.ts'

const healthy: BudgetBreach = {
  subagentId: SessionId('child-1'),
  provider: 'scripted',
  kind: 'token-spend',
  observed: 101,
  threshold: 100,
  reason: 'spent 101 billed tokens against a 100-token budget',
  enforcement: { kind: 'interrupted' },
}

async function mounted(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(Invariant)
  return ctx
}

describe('plugin-budget-governor invariant companion', () => {
  it('exposes the companion export shape with no stray default', () => {
    expect(Invariant.name).toBe('plugin-budget-governor-invariant')
    expect(Invariant.inject).toEqual(['invariants'])
    expect(typeof Invariant.apply).toBe('function')
    expect('default' in Invariant).toBe(false)
  })

  it('mounts and disposes cleanly', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = await ctx.plugin(Invariant)
    expect(fiber).toBeDefined()
    await fiber.dispose()
  })

  it('stays silent on healthy breaches for distinct subagents', async () => {
    const ctx = await mounted()
    expect(() => {
      ctx.emit('budget-governor/breach', healthy)
      ctx.emit('budget-governor/breach', { ...healthy, subagentId: SessionId('child-2') })
      ctx.emit('budget-governor/breach', { ...healthy, kind: 'file-churn', observed: 3, threshold: 2, subagentId: SessionId('child-3') })
    }).not.toThrow()
    await ctx.fiber.dispose()
  })

  it('fails loud on a non-positive threshold', async () => {
    const ctx = await mounted()
    expect(() => ctx.emit('budget-governor/breach', { ...healthy, observed: 1, threshold: 0 }))
      .toThrow(/non-positive token-spend threshold 0/)
    await ctx.fiber.dispose()
  })

  it('fails loud when the measurement did not actually exceed the bound', async () => {
    const ctx = await mounted()
    expect(() => ctx.emit('budget-governor/breach', { ...healthy, observed: 100, threshold: 100 }))
      .toThrow(/does not exceed its threshold 100/)
    await ctx.fiber.dispose()
  })

  it('fails loud when one subagent is reported breached twice', async () => {
    const ctx = await mounted()
    ctx.emit('budget-governor/breach', healthy)
    expect(() => ctx.emit('budget-governor/breach', healthy))
      .toThrow(/reported breached more than once/)
    await ctx.fiber.dispose()
  })
})
