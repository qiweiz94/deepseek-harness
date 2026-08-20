/**
 * Pure scratchpad state and its prompt-budget rendering. This module owns no
 * Cordis, filesystem, or clock dependency: the store is an ordered key/value
 * map and {@link renderScratchpad} is a pure function of its entries and a
 * token budget, so both are directly testable without a booted composition.
 * @module @deepseek-ai/dsh-plugin-pinned-scratchpad/store
 */

/** One pinned entry: its key and current value, in write order. */
export interface ScratchpadEntry {
  /** The model-chosen key. */
  readonly key: string
  /** The current value. */
  readonly value: string
}

/** The outcome of rendering the scratchpad under a token budget. */
export interface RenderedScratchpad {
  /**
   * The block text, or `''` when nothing is pinned (or when not even the
   * truncation marker fits the budget). An empty section contributes nothing:
   * `renderPrompt` drops zero-length sections before joining.
   */
  readonly text: string
  /** How many entries were dropped to fit the budget, oldest write first. */
  readonly dropped: number
}

/** Opening tag of the injected block. */
export const BLOCK_OPEN = '<agent_scratchpad>'

/** Closing tag of the injected block. */
export const BLOCK_CLOSE = '</agent_scratchpad>'

/**
 * Estimate the token cost of prompt text.
 *
 * The harness has no tokenizer service, and the budget must be enforced
 * without a network round trip on every assembly, so this is the conventional
 * four-characters-per-token approximation rounded up. It is deliberately a
 * slight OVER-estimate for prose (real BPE averages closer to ~4.7 characters
 * per token for English), which makes the budget conservative: the block may
 * come in under 250 real tokens, never meaningfully over.
 * @param text - the text to price.
 * @returns the estimated token count.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * The marker that replaces dropped entries, so the model is told its older
 * notes were evicted rather than silently losing them.
 * @param dropped - how many entries were evicted.
 * @returns the single marker line.
 */
function truncationMarker(dropped: number): string {
  return `[${dropped} earlier entr${dropped === 1 ? 'y' : 'ies'} dropped: scratchpad token budget]`
}

/** Assemble the block text from an optional marker and the surviving entries. */
function composeBlock(marker: string | undefined, entries: readonly ScratchpadEntry[]): string {
  const lines = entries.map(entry => `${entry.key}: ${entry.value}`)
  const body = marker === undefined ? lines : [marker, ...lines]
  return [BLOCK_OPEN, ...body, BLOCK_CLOSE].join('\n')
}

/**
 * Render the pinned entries as the `<agent_scratchpad>` block, dropping the
 * oldest writes first until the WHOLE block — tags and truncation marker
 * included — fits `maxTokens`.
 *
 * An entry is never partially rendered: a single value too large to fit is
 * dropped whole and counted in the marker, because half a note is a
 * misleading note. When not even the marker alone fits, the block renders as
 * `''` so the budget is honored absolutely rather than "almost".
 * @param entries - the pinned entries, oldest write first.
 * @param maxTokens - the inclusive estimated-token ceiling for the block.
 * @returns the block text and the number of dropped entries.
 */
export function renderScratchpad(
  entries: readonly ScratchpadEntry[],
  maxTokens: number,
): RenderedScratchpad {
  if (entries.length === 0) return { text: '', dropped: 0 }
  const whole = composeBlock(undefined, entries)
  if (estimateTokens(whole) <= maxTokens) return { text: whole, dropped: 0 }
  // Drop the oldest write first, re-pricing the marker each time because its
  // own length grows with the count it reports.
  for (let dropped = 1; dropped <= entries.length; dropped += 1) {
    const text = composeBlock(truncationMarker(dropped), entries.slice(dropped))
    if (estimateTokens(text) <= maxTokens) return { text, dropped }
  }
  return { text: '', dropped: entries.length }
}

/** What one {@link ScratchpadStore.write} did to the store. */
export type WriteAction = 'set' | 'deleted' | 'missing'

/**
 * An ordered key/value scratchpad.
 *
 * Order is WRITE RECENCY, not first insertion: re-writing an existing key
 * moves it to the newest position, so eviction ("oldest first") drops the
 * least recently written note and an actively maintained key is never evicted
 * out from under the model.
 */
export class ScratchpadStore {
  readonly #entries = new Map<string, string>()

  /**
   * Set, replace, or delete one key.
   * @param key - the entry key.
   * @param value - the new value, or `null` to delete the key.
   * @returns `set`, `deleted`, or `missing` when a delete found no such key.
   */
  write(key: string, value: string | null): WriteAction {
    if (value === null) return this.#entries.delete(key) ? 'deleted' : 'missing'
    // Delete first so a rewrite re-enters the Map at the newest position.
    this.#entries.delete(key)
    this.#entries.set(key, value)
    return 'set'
  }

  /** @returns the pinned entries, least recently written first. */
  entries(): ScratchpadEntry[] {
    return [...this.#entries].map(([key, value]) => ({ key, value }))
  }

  /** @returns how many keys are pinned. */
  get size(): number {
    return this.#entries.size
  }
}
