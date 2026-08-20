// The pure half: ordered key/value state and the token-budget renderer.
// These need no composition, so every budget branch is pinned directly.
import { describe, expect, it } from 'vitest'
import {
  BLOCK_CLOSE,
  BLOCK_OPEN,
  estimateTokens,
  renderScratchpad,
  ScratchpadStore,
} from '../src/store.ts'
import type { ScratchpadEntry } from '../src/store.ts'

/** Entries whose rendered size is easy to reason about in token terms. */
function entries(...pairs: Array<[string, string]>): ScratchpadEntry[] {
  return pairs.map(([key, value]) => ({ key, value }))
}

describe('estimateTokens', () => {
  it('prices the empty string at zero', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('rounds up to the next whole token', () => {
    expect(estimateTokens('a')).toBe(1)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })
})

describe('ScratchpadStore write ordering', () => {
  it('starts empty', () => {
    const store = new ScratchpadStore()
    expect(store.size).toBe(0)
    expect(store.entries()).toEqual([])
  })

  it('keeps entries in write order and reports the set action', () => {
    const store = new ScratchpadStore()
    expect(store.write('a', '1')).toBe('set')
    expect(store.write('b', '2')).toBe('set')
    expect(store.entries()).toEqual(entries(['a', '1'], ['b', '2']))
    expect(store.size).toBe(2)
  })

  it('moves a rewritten key to the newest position (eviction is by write recency)', () => {
    const store = new ScratchpadStore()
    store.write('a', '1')
    store.write('b', '2')
    store.write('a', '3')
    // a → b → a leaves [b, a]: the actively maintained key is now the youngest.
    expect(store.entries()).toEqual(entries(['b', '2'], ['a', '3']))
    expect(store.size).toBe(2)
  })

  it('deletes an existing key', () => {
    const store = new ScratchpadStore()
    store.write('a', '1')
    expect(store.write('a', null)).toBe('deleted')
    expect(store.entries()).toEqual([])
    expect(store.size).toBe(0)
  })

  it('reports a delete of a key that was never set as missing', () => {
    const store = new ScratchpadStore()
    expect(store.write('nope', null)).toBe('missing')
    expect(store.size).toBe(0)
  })
})

describe('renderScratchpad budget enforcement', () => {
  it('renders nothing at all when the scratchpad is empty', () => {
    // '' makes renderPrompt drop the section entirely rather than emit bare tags.
    expect(renderScratchpad([], 250)).toEqual({ text: '', dropped: 0 })
  })

  it('renders every entry inside the tags when the whole block fits', () => {
    const result = renderScratchpad(entries(['task', 'ship it'], ['dir', '/tmp']), 250)
    expect(result.dropped).toBe(0)
    expect(result.text).toBe([BLOCK_OPEN, 'task: ship it', 'dir: /tmp', BLOCK_CLOSE].join('\n'))
  })

  it('budgets the WHOLE block, tags included, not just the entries', () => {
    const only = entries(['k', 'v'])
    const whole = renderScratchpad(only, 250).text
    const wholeCost = estimateTokens(whole)
    const entriesOnlyCost = estimateTokens('k: v')
    expect(wholeCost).toBeGreaterThan(entriesOnlyCost)
    // At exactly the whole-block cost it still fits (the ceiling is inclusive)…
    expect(renderScratchpad(only, wholeCost).dropped).toBe(0)
    // …and one token below it, the entry is evicted.
    expect(renderScratchpad(only, wholeCost - 1).dropped).toBe(1)
  })

  it('drops the oldest entries first and says so in a marker', () => {
    const pinned = entries(
      ['old', 'x'.repeat(200)],
      ['mid', 'y'.repeat(200)],
      ['new', 'keep me'],
    )
    const result = renderScratchpad(pinned, 60)
    expect(result.dropped).toBe(2)
    expect(result.text).toContain('new: keep me')
    expect(result.text).not.toContain('old:')
    expect(result.text).not.toContain('mid:')
    expect(result.text).toContain('[2 earlier entries dropped: scratchpad token budget]')
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(60)
  })

  it('uses the singular marker when exactly one entry is dropped', () => {
    const pinned = entries(['old', 'x'.repeat(400)], ['new', 'short'])
    const result = renderScratchpad(pinned, 40)
    expect(result.dropped).toBe(1)
    expect(result.text).toContain('[1 earlier entry dropped: scratchpad token budget]')
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(40)
  })

  it('drops an oversized single entry whole rather than rendering half a note', () => {
    const result = renderScratchpad(entries(['big', 'z'.repeat(4000)]), 30)
    expect(result.dropped).toBe(1)
    expect(result.text).not.toContain('zzz')
    expect(result.text).toBe([
      BLOCK_OPEN,
      '[1 earlier entry dropped: scratchpad token budget]',
      BLOCK_CLOSE,
    ].join('\n'))
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(30)
  })

  it('renders nothing when not even the marker alone fits the budget', () => {
    // The budget is honored absolutely: a floor we cannot afford emits ''.
    const result = renderScratchpad(entries(['a', 'x'.repeat(100)], ['b', 'y']), 3)
    expect(result).toEqual({ text: '', dropped: 2 })
  })

  it('never exceeds the 250-token cap for a scratchpad of realistic notes', () => {
    const pinned = entries(
      ...Array.from({ length: 40 }, (_value, index): [string, string] =>
        [`key-${index}`, `a reasonably wordy note number ${index} about the task`]),
    )
    const result = renderScratchpad(pinned, 250)
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(250)
    expect(result.dropped).toBeGreaterThan(0)
    expect(result.text).toContain('key-39')
  })
})
