/**
 * Consecutive-block accounting for Stop hooks. A blocking Stop hook forces the
 * turn to continue; this guard counts consecutive forced continuations per
 * agent turn so a bridge can (a) report a truthful `stop_hook_active` payload
 * field — `true` exactly when the current stop boundary exists because a Stop
 * hook already forced continuation this turn — and (b) override the block once
 * the cap is reached, so an unconditionally blocking hook cannot loop a turn
 * forever.
 * @module @deepseek-ai/dsh-hook-protocol/stop-guard
 */

/**
 * The reference cap on consecutive Stop-hook forced continuations per turn
 * (both bridges' config default). Claude Code's own guard overrides a Stop
 * hook after 8 consecutive blocks; Codex documents no cap, so its bridge
 * borrows this value as prior art.
 */
export const DEFAULT_MAX_CONSECUTIVE_STOP_BLOCKS = 8

/** Per-agent Stop-hook loop accounting; see the module doc for the two consumers. */
export interface StopLoopGuard {
  /**
   * Whether the current stop boundary was reached because a Stop hook already
   * forced continuation in this same turn — the payload's `stop_hook_active`.
   * @param agent - the agent at its stop boundary (identity key).
   * @param turn - the turn about to close.
   * @returns `true` when a forced continuation of this turn is already counted.
   */
  stopHookActive(agent: object, turn: number): boolean
  /**
   * Record one more forced continuation of `turn` unless the cap is reached.
   * @param agent - the agent whose Stop hook blocked (identity key).
   * @param turn - the turn the hook wants to continue.
   * @returns `true` when the continuation is allowed (and now counted); `false`
   *   when the cap is reached — the caller overrides the block and lets the
   *   turn stop, and the count resets.
   */
  tryForceContinue(agent: object, turn: number): boolean
  /**
   * Reset the accounting after a non-blocking stop outcome (the consecutive
   * run is broken).
   * @param agent - the agent whose stop boundary passed without a block.
   */
  clear(agent: object): void
}

/**
 * Create a {@link StopLoopGuard} (one per bridge `apply()`). State is keyed
 * weakly by agent identity, so a disposed agent's accounting is collectable
 * without a lifecycle listener.
 * @param maxConsecutiveBlocks - forced continuations allowed per turn before
 *   {@link StopLoopGuard.tryForceContinue} refuses; see
 *   {@link DEFAULT_MAX_CONSECUTIVE_STOP_BLOCKS}.
 * @returns the guard.
 */
export function createStopLoopGuard(maxConsecutiveBlocks: number): StopLoopGuard {
  const state = new WeakMap<object, { turn: number; forced: number }>()
  return {
    stopHookActive(agent: object, turn: number): boolean {
      const s = state.get(agent)
      return s !== undefined && s.turn === turn && s.forced > 0
    },
    tryForceContinue(agent: object, turn: number): boolean {
      const s = state.get(agent)
      // A different turn starts a fresh consecutive run.
      const forced = s !== undefined && s.turn === turn ? s.forced : 0
      if (forced >= maxConsecutiveBlocks) {
        state.delete(agent)
        return false
      }
      state.set(agent, { turn, forced: forced + 1 })
      return true
    },
    clear(agent: object): void {
      state.delete(agent)
    },
  }
}
