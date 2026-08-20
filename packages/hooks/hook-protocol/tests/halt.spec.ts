import { describe, expect, it, vi } from 'vitest'
import { applyHaltRequest, type HaltTarget } from '@deepseek-ai/dsh-hook-protocol'
import type { MergedHookOutcome } from '@deepseek-ai/dsh-hook-protocol'

/** A minimal merged outcome with `stop: true`, overridable per test. */
function stopped(overrides: Partial<MergedHookOutcome> = {}): MergedHookOutcome {
  return { decision: 'none', stop: true, additionalContext: [], systemMessages: [], ...overrides }
}

describe('applyHaltRequest', () => {
  it('cancels the agent with kind "hook" and the merged stopReason, and returns it', () => {
    const cancel = vi.fn()
    const agent: HaltTarget = { cancel }
    const reason = applyHaltRequest(stopped({ stopReason: 'server says stop' }), 'PreToolUse', agent)
    expect(reason).toBe('server says stop')
    expect(cancel).toHaveBeenCalledWith({ kind: 'hook', reason: 'server says stop' })
  })

  it('falls back to a point-named reason when no hook set stopReason (?? right arm)', () => {
    const cancel = vi.fn()
    const agent: HaltTarget = { cancel }
    const reason = applyHaltRequest(stopped(), 'Stop', agent)
    expect(reason).toBe('halted by Stop hook (continue: false)')
    expect(cancel).toHaveBeenCalledWith({ kind: 'hook', reason: 'halted by Stop hook (continue: false)' })
  })

  it('with no agent (a direct no-agent tool execution), skips cancel but still returns the reason', () => {
    const reason = applyHaltRequest(stopped({ stopReason: 'halt' }), 'PreToolUse', undefined)
    expect(reason).toBe('halt')
  })
})
