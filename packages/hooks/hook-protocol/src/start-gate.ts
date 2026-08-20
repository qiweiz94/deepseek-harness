/**
 * First-step delivery gate for detached session-start hook runs. A
 * SessionStart hook runs detached (no extension point awaits it), so its
 * context used to race the first model request. The gate keeps each agent's
 * pending run claimable: the bridge's `agent/pre-step` listener claims and
 * awaits it, folding the resolved context into the entering messages via
 * {@link foldStartContext}, so the first request is promised the hook's
 * context. A run nobody claims falls back to the bridge-supplied delivery (an
 * `agent.inject`).
 * @module @deepseek-ai/dsh-hook-protocol/start-gate
 */

import type { UserMessage } from '@deepseek-ai/dsh-session'

/**
 * A pre-step decision shaped like `PreStepDecision` from `@deepseek-ai/dsh-agent`
 * (structural, so this library does not depend on the agent runtime).
 */
export type PreStepGateDecision =
  | { readonly kind: 'reject' }
  | { readonly kind: 'enter'; readonly messages: UserMessage[] }

/**
 * Fold a claimed SessionStart context onto a pre-step decision: prepend it to
 * an entering decision's messages, or inject it directly and pass a
 * non-entering decision through unchanged — a rejected or never-entered step
 * carries no messages forward, so direct injection parks delivery for the
 * agent's next wake instead.
 * @param inject - deliver the context directly (the agent's `inject`), used when `decision` does not enter.
 * @param startContext - the claimed SessionStart context, or `undefined` for none pending/claimed.
 * @param decision - the pre-step decision to fold the context onto.
 * @returns `decision`, with `startContext` prepended to its messages when it enters.
 */
export function foldStartContext(
  inject: (message: UserMessage) => void,
  startContext: UserMessage | undefined,
  decision: PreStepGateDecision,
): PreStepGateDecision {
  if (startContext === undefined) return decision
  if (decision.kind !== 'enter') {
    inject(startContext)
    return decision
  }
  return { kind: 'enter', messages: [...decision.messages, startContext] }
}

/**
 * Claim `agent`'s pending SessionStart run (if any) and await it, then build
 * a {@link foldStartContext} folder bound to the claimed value and `inject`.
 * The bridge's `agent/pre-step` listener calls this first, then applies the
 * returned folder to every `PreStepDecision` it returns.
 * @param startGate - the bridge's start gate.
 * @param agent - the agent whose pending run to claim (identity key), and the
 *   injection target for a non-entering decision.
 * @param inject - deliver a claimed-but-parked context directly (the agent's `inject`).
 * @returns a folder that applies the claimed context to a pre-step decision
 *   (identity when nothing was claimed).
 */
export async function bindStartContext(
  startGate: StartGate<UserMessage>,
  agent: object,
  inject: (message: UserMessage) => void,
): Promise<(decision: PreStepGateDecision) => PreStepGateDecision> {
  const pending = startGate.claim(agent)
  const startContext = pending === undefined ? undefined : await pending
  return (decision: PreStepGateDecision): PreStepGateDecision => foldStartContext(inject, startContext, decision)
}

/** Per-agent registry of pending start-point runs; see the module doc. */
export interface StartGate<T> {
  /**
   * Track one detached start-point run for `agent` until it settles. A `run`
   * rejection is contained here — reported via `onError`, then treated as no
   * value (pruned, `deliver` skipped, the returned chain resolves to
   * `undefined`) — so a later {@link claim} never inherits a rejecting
   * promise. When the run settles unclaimed with a value, `deliver` is called
   * with it (a `deliver` throw still rejects the returned chain, uncontained,
   * since the caller owns that failure mode); a {@link claim} beforehand
   * suppresses `deliver` and hands the value to the claimer instead, so
   * delivery happens exactly once. Registering again for the same agent
   * supersedes the pending entry; the superseded run still delivers via
   * `deliver` when it settles unclaimed.
   * @param agent - the agent the run belongs to (identity key).
   * @param run - the detached run chain resolving to the value to deliver, or `undefined` for none.
   * @param deliver - fallback delivery for an unclaimed value.
   * @param onError - report a `run` rejection (the bridge's "hook failed" warning).
   * @returns the full chain including delivery, for the bridge's detached-run tracking.
   */
  register(
    agent: object,
    run: Promise<T | undefined>,
    deliver: (value: T) => void,
    onError: (error: unknown) => void,
  ): Promise<T | undefined>
  /**
   * Claim the agent's pending run, removing it from the registry. The caller
   * owns delivery of the resolved value (including parking it back when its
   * step never enters).
   * @param agent - the agent whose pending run to claim (identity key).
   * @returns the pending run's settlement, or `undefined` when none is pending.
   */
  claim(agent: object): Promise<T | undefined> | undefined
}

/**
 * Create a {@link StartGate} (one per bridge `apply()`). Settled and claimed
 * entries are pruned, so a long-lived process does not accumulate them.
 * @returns the gate.
 */
export function createStartGate<T>(): StartGate<T> {
  interface Entry<V> { claimed: boolean; done: Promise<V | undefined> }
  const pending = new Map<object, Entry<T>>()
  return {
    register(
      agent: object,
      run: Promise<T | undefined>,
      deliver: (value: T) => void,
      onError: (error: unknown) => void,
    ): Promise<T | undefined> {
      const entry: Entry<T> = { claimed: false, done: run }
      entry.done = run.then((value) => {
        // Prune only our own entry — a later register may have superseded it.
        if (pending.get(agent) === entry) pending.delete(agent)
        if (!entry.claimed && value !== undefined) deliver(value)
        return value
      }, (error: unknown): undefined => {
        // A rejected run is contained here, not left for a later claim() to inherit.
        if (pending.get(agent) === entry) pending.delete(agent)
        onError(error)
        return undefined
      })
      pending.set(agent, entry)
      return entry.done
    },
    claim(agent: object): Promise<T | undefined> | undefined {
      const entry = pending.get(agent)
      if (entry === undefined) return undefined
      // Mark synchronously so the settlement continuation skips `deliver`.
      entry.claimed = true
      pending.delete(agent)
      return entry.done
    },
  }
}
