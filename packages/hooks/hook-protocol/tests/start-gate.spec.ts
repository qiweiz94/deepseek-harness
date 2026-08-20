import { describe, expect, it, vi } from 'vitest'
import { bindStartContext, createStartGate, foldStartContext, type PreStepGateDecision } from '@deepseek-ai/dsh-hook-protocol'
import type { UserMessage } from '@deepseek-ai/dsh-session'

/** A minimal UserMessage fixture; only identity matters to the code under test. */
function message(text: string): UserMessage {
  return { id: text, role: 'user', content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'test' } } as unknown as UserMessage
}

describe('createStartGate', () => {
  it('a claimed run delivers to the claimer, not to `deliver`', async () => {
    const gate = createStartGate<UserMessage>()
    const agent = {}
    const deliver = vi.fn()
    const onError = vi.fn()
    const run = Promise.resolve(message('claimed'))
    const chain = gate.register(agent, run, deliver, onError)
    const claimed = gate.claim(agent)
    expect(claimed).toBeDefined()
    await expect(claimed).resolves.toEqual(message('claimed'))
    await chain
    expect(deliver).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('an unclaimed run with a value delivers via `deliver`', async () => {
    const gate = createStartGate<UserMessage>()
    const agent = {}
    const deliver = vi.fn()
    await gate.register(agent, Promise.resolve(message('unclaimed')), deliver, vi.fn())
    expect(deliver).toHaveBeenCalledWith(message('unclaimed'))
  })

  it('an unclaimed run that resolves to undefined does not call `deliver`', async () => {
    const gate = createStartGate<UserMessage>()
    const agent = {}
    const deliver = vi.fn()
    await gate.register(agent, Promise.resolve(undefined), deliver, vi.fn())
    expect(deliver).not.toHaveBeenCalled()
  })

  it('claim on an agent with nothing pending returns undefined', () => {
    const gate = createStartGate<UserMessage>()
    expect(gate.claim({})).toBeUndefined()
  })

  it('registering again for the same agent supersedes the pending entry; the superseded run still delivers unclaimed', async () => {
    const gate = createStartGate<UserMessage>()
    const agent = {}
    const firstDeliver = vi.fn()
    const secondDeliver = vi.fn()
    let resolveFirst!: (value: UserMessage | undefined) => void
    const first = new Promise<UserMessage | undefined>((resolve) => { resolveFirst = resolve })
    const firstChain = gate.register(agent, first, firstDeliver, vi.fn())
    // Supersede before the first settles.
    await gate.register(agent, Promise.resolve(message('second')), secondDeliver, vi.fn())
    expect(secondDeliver).toHaveBeenCalledWith(message('second'))
    // The superseded (first) entry is no longer the pending one — claim() now
    // returns undefined even though the first run has not settled yet.
    expect(gate.claim(agent)).toBeUndefined()
    resolveFirst(message('first'))
    await firstChain
    expect(firstDeliver).toHaveBeenCalledWith(message('first'))
  })

  it('a rejected run is contained: reported via onError, `deliver` skipped, the returned chain resolves to undefined', async () => {
    const gate = createStartGate<UserMessage>()
    const agent = {}
    const deliver = vi.fn()
    const onError = vi.fn()
    const boom = new Error('boom')
    await expect(gate.register(agent, Promise.reject(boom), deliver, onError)).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledWith(boom)
    expect(deliver).not.toHaveBeenCalled()
  })

  it('a claim() taken after the run rejects resolves to undefined rather than inheriting the rejection', async () => {
    const gate = createStartGate<UserMessage>()
    const agent = {}
    const done = gate.register(agent, Promise.reject(new Error('boom')), vi.fn(), vi.fn())
    await done // let the entry settle and prune itself
    // Nothing pending anymore (settlement already pruned it) — claim() finds no entry.
    expect(gate.claim(agent)).toBeUndefined()
  })

  it('a claim() taken BEFORE the run rejects still resolves to undefined, never rejecting the claimer', async () => {
    const gate = createStartGate<UserMessage>()
    const agent = {}
    let rejectRun!: (error: unknown) => void
    const run = new Promise<UserMessage | undefined>((_resolve, reject) => { rejectRun = reject })
    const onError = vi.fn()
    void gate.register(agent, run, vi.fn(), onError)
    const claimed = gate.claim(agent)
    rejectRun(new Error('boom'))
    await expect(claimed).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalled()
  })
})

describe('foldStartContext', () => {
  it('with no startContext, returns the decision unchanged and never calls inject', () => {
    const inject = vi.fn()
    const decision: PreStepGateDecision = { kind: 'enter', messages: [] }
    expect(foldStartContext(inject, undefined, decision)).toBe(decision)
    expect(inject).not.toHaveBeenCalled()
  })

  it('with a startContext and a non-entering decision, injects directly and passes the decision through', () => {
    const inject = vi.fn()
    const decision: PreStepGateDecision = { kind: 'reject' }
    const ctx = message('start')
    expect(foldStartContext(inject, ctx, decision)).toBe(decision)
    expect(inject).toHaveBeenCalledWith(ctx)
  })

  it('with a startContext and an entering decision, appends it to messages instead of injecting', () => {
    const inject = vi.fn()
    const existing = message('prompt')
    const ctx = message('start')
    const result = foldStartContext(inject, ctx, { kind: 'enter', messages: [existing] })
    expect(result).toEqual({ kind: 'enter', messages: [existing, ctx] })
    expect(inject).not.toHaveBeenCalled()
  })
})

describe('bindStartContext', () => {
  it('with nothing pending, the returned folder is the identity (no startContext)', async () => {
    const gate = createStartGate<UserMessage>()
    const inject = vi.fn()
    const withStartContext = await bindStartContext(gate, {}, inject)
    const decision: PreStepGateDecision = { kind: 'reject' }
    expect(withStartContext(decision)).toBe(decision)
    expect(inject).not.toHaveBeenCalled()
  })

  it('claims and awaits the pending run, then folds it', async () => {
    const gate = createStartGate<UserMessage>()
    const agent = {}
    const ctx = message('start')
    void gate.register(agent, Promise.resolve(ctx), () => {}, vi.fn())
    const inject = vi.fn()
    const withStartContext = await bindStartContext(gate, agent, inject)
    const result = withStartContext({ kind: 'enter', messages: [] })
    expect(result).toEqual({ kind: 'enter', messages: [ctx] })
  })

  it('a pending run that resolves to undefined leaves the folder as the identity', async () => {
    const gate = createStartGate<UserMessage>()
    const agent = {}
    void gate.register(agent, Promise.resolve(undefined), () => {}, vi.fn())
    const inject = vi.fn()
    const withStartContext = await bindStartContext(gate, agent, inject)
    const decision: PreStepGateDecision = { kind: 'reject' }
    expect(withStartContext(decision)).toBe(decision)
    expect(inject).not.toHaveBeenCalled()
  })

  it('a pending run that REJECTS also leaves the folder as the identity (contained by register, never reaches the claimer as a rejection)', async () => {
    const gate = createStartGate<UserMessage>()
    const agent = {}
    void gate.register(agent, Promise.reject(new Error('boom')), () => {}, vi.fn())
    const inject = vi.fn()
    const withStartContext = await bindStartContext(gate, agent, inject)
    const decision: PreStepGateDecision = { kind: 'reject' }
    expect(withStartContext(decision)).toBe(decision)
    expect(inject).not.toHaveBeenCalled()
  })
})
