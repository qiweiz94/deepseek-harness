import { describe, expect, it } from 'vitest'
import { assertPositiveInteger, resolveSharedHookLimits } from '@deepseek-ai/dsh-hook-protocol'

describe('assertPositiveInteger', () => {
  it('a positive integer passes silently', () => {
    expect(() => { assertPositiveInteger('bridge', 'field', 1) }).not.toThrow()
  })

  it('zero throws with the bridge and field name', () => {
    expect(() => { assertPositiveInteger('bridge', 'field', 0) }).toThrow('bridge: field must be a positive integer')
  })

  it('a negative number throws', () => {
    expect(() => { assertPositiveInteger('bridge', 'field', -1) }).toThrow('bridge: field must be a positive integer')
  })

  it('a non-integer throws', () => {
    expect(() => { assertPositiveInteger('bridge', 'field', 1.5) }).toThrow('bridge: field must be a positive integer')
  })
})

describe('resolveSharedHookLimits', () => {
  it('defaults both fields when unset', () => {
    const limits = resolveSharedHookLimits('bridge', {})
    expect(limits.stderrSummaryMaxChars).toBeGreaterThan(0)
    expect(limits.maxConsecutiveStopBlocks).toBeGreaterThan(0)
  })

  it('uses configured values when set', () => {
    const limits = resolveSharedHookLimits('bridge', { stderrSummaryMaxChars: 42, maxConsecutiveStopBlocks: 3 })
    expect(limits).toEqual({ stderrSummaryMaxChars: 42, maxConsecutiveStopBlocks: 3 })
  })

  it('throws with the bridge name when a configured value is invalid', () => {
    expect(() => resolveSharedHookLimits('my-bridge', { stderrSummaryMaxChars: 0 })).toThrow('my-bridge: stderrSummaryMaxChars must be a positive integer')
  })

  it('validates maxConsecutiveStopBlocks independently of stderrSummaryMaxChars', () => {
    expect(() => resolveSharedHookLimits('my-bridge', { maxConsecutiveStopBlocks: -1 })).toThrow('my-bridge: maxConsecutiveStopBlocks must be a positive integer')
  })
})
