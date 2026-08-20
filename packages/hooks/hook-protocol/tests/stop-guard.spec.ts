import { describe, expect, it } from 'vitest'
import { createStopLoopGuard } from '@deepseek-ai/dsh-hook-protocol'

describe('createStopLoopGuard', () => {
  it('stopHookActive is false for an agent/turn with no forced continuation yet', () => {
    const guard = createStopLoopGuard(8)
    expect(guard.stopHookActive({}, 1)).toBe(false)
  })

  it('tryForceContinue counts consecutive forced continuations for the same turn, and stopHookActive reflects it', () => {
    const guard = createStopLoopGuard(2)
    const agent = {}
    expect(guard.tryForceContinue(agent, 1)).toBe(true)
    expect(guard.stopHookActive(agent, 1)).toBe(true)
  })

  it('a different turn starts a fresh consecutive run (binary-expr false arm: s.turn !== turn)', () => {
    const guard = createStopLoopGuard(1)
    const agent = {}
    expect(guard.tryForceContinue(agent, 1)).toBe(true)
    // Cap is 1, so a second forced-continue on the SAME turn would be refused —
    // but turn 2 is a different turn, so it gets a fresh count instead.
    expect(guard.tryForceContinue(agent, 2)).toBe(true)
    expect(guard.stopHookActive(agent, 2)).toBe(true)
    expect(guard.stopHookActive(agent, 1)).toBe(false)
  })

  it('the cap overrides the block once reached, and resets the count', () => {
    const guard = createStopLoopGuard(1)
    const agent = {}
    expect(guard.tryForceContinue(agent, 1)).toBe(true)
    expect(guard.tryForceContinue(agent, 1)).toBe(false)
    // The count reset on refusal: a later call for the same turn starts fresh.
    expect(guard.stopHookActive(agent, 1)).toBe(false)
    expect(guard.tryForceContinue(agent, 1)).toBe(true)
  })

  it('clear resets accounting after a non-blocking stop outcome', () => {
    const guard = createStopLoopGuard(8)
    const agent = {}
    expect(guard.tryForceContinue(agent, 1)).toBe(true)
    guard.clear(agent)
    expect(guard.stopHookActive(agent, 1)).toBe(false)
  })
})
