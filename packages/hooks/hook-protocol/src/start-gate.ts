/**
 * First-step delivery gate for detached session-start hook runs. A
 * SessionStart hook runs detached (no extension point awaits it), so its
 * context used to race the first model request. The gate keeps each agent's
 * pending run claimable: the bridge's `agent/pre-step` listener claims and
 * awaits it, folding the resolved context into the entering messages, so the
 * first request is promised the hook's context. A run nobody claims falls back
 * to the bridge-supplied delivery (an `agent.inject`).
 * @module @deepseek-ai/dsh-hook-protocol/start-gate
 */

/** Per-agent registry of pending start-point runs; see the module doc. */
export interface StartGate<T> {
  /**
   * Track one detached start-point run for `agent` until it settles.
   * `run` must not reject — the bridge resolves hook failures to `undefined`
   * after logging. When the run settles unclaimed with a value, `deliver` is
   * called with it (a `deliver` throw rejects the returned chain and is never
   * observed by a claimer); a {@link claim} beforehand suppresses `deliver`
   * and hands the value to the claimer instead, so delivery happens exactly
   * once. Registering again for the same agent supersedes the pending entry;
   * the superseded run still delivers via `deliver` when it settles unclaimed.
   * @param agent - the agent the run belongs to (identity key).
   * @param run - the detached run chain resolving to the value to deliver, or `undefined` for none.
   * @param deliver - fallback delivery for an unclaimed value.
   * @returns the full chain including delivery, for the bridge's detached-run tracking.
   */
  register(agent: object, run: Promise<T | undefined>, deliver: (value: T) => void): Promise<T | undefined>
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
    register(agent: object, run: Promise<T | undefined>, deliver: (value: T) => void): Promise<T | undefined> {
      const entry: Entry<T> = { claimed: false, done: run }
      entry.done = run.then((value) => {
        // Prune only our own entry — a later register may have superseded it.
        if (pending.get(agent) === entry) pending.delete(agent)
        if (!entry.claimed && value !== undefined) deliver(value)
        return value
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
