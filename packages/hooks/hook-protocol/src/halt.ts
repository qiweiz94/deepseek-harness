/**
 * Map a hook's `continue:false` halt request onto the agent's run-level cancel
 * primitive. The merge folds every matched hook's halt request into
 * `MergedHookOutcome.stop`/`stopReason`; a bridge calls {@link applyHaltRequest}
 * at its turn-scoped extension points to turn that request into an
 * `AgentCancelCause` of kind `hook`, which aborts the active turn, clears
 * queued work, and records the reason durably on the turn's aborted end.
 * @module @deepseek-ai/dsh-hook-protocol/halt
 */

import type { AgentCancelCause } from '@deepseek-ai/dsh-session'
import type { MergedHookOutcome } from './merge.ts'

/**
 * The one agent capability a run-level halt needs. Structural, so this library
 * does not depend on the full `dsh-agent` runtime surface.
 */
export interface HaltTarget {
  /**
   * Cancel the agent's active run.
   * @param cause - the stable caller intent carried by the active operation signal.
   */
  cancel(cause: AgentCancelCause): void
}

/**
 * Honor a merged `continue:false` by cancelling the agent's run with a
 * `{ kind: 'hook' }` cause. Call only when `merged.stop` is `true`. Without an
 * agent (a direct no-agent tool execution) there is no run to halt; the caller
 * still owes its point-local decision (e.g. denying the tool), which this
 * function's returned reason names.
 * @param merged - the folded outcome whose `stopReason` becomes the cancel reason.
 * @param point - the hook point that requested the halt, used in the fallback reason.
 * @param agent - the run to cancel; `undefined` when the point ran without an agent.
 * @returns the halt reason: the first halting hook's `stopReason`, or a point-named fallback.
 */
export function applyHaltRequest(merged: MergedHookOutcome, point: string, agent: HaltTarget | undefined): string {
  const reason = merged.stopReason ?? `halted by ${point} hook (continue: false)`
  agent?.cancel({ kind: 'hook', reason })
  return reason
}
