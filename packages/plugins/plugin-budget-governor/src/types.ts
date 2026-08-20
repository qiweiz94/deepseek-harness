/**
 * Type-only contracts for `@deepseek-ai/dsh-plugin-budget-governor`: what the
 * governor accounts per tracked subagent, what a breach reports, and what the
 * governor was actually able to DO about it against the real subagent seam.
 * @module @deepseek-ai/dsh-plugin-budget-governor/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session'

/** Which budget a tracked subagent exceeded. */
export type BreachKind = 'token-spend' | 'tool-failures' | 'file-churn'

/**
 * What the governor did about one breach. The subagent seam exposes exactly
 * one public stop — `ctx.subagents.interrupt()` — and it needs a live ancestor
 * Agent, so an observer cannot always reach it. This union states which of the
 * three real outcomes happened rather than implying a stop always lands.
 */
export type BreachEnforcement =
  /**
   * `ctx.subagents.interrupt()` accepted the stop request under ancestor
   * authority derived from the child's own recorded parent session. The seam
   * documents an ABSENT target — including a one-shot or already-settled
   * child — as an accepted no-op, so acceptance is not proof the child stopped.
   */
  | { readonly kind: 'interrupted' }
  /** `onBreach: 'report'` — the governor deliberately made no stop request. */
  | { readonly kind: 'reported' }
  /**
   * No stop was reachable: the seam's stop needs a live ancestor Agent, and
   * this child's parent could not be resolved from the live agent registry
   * (an out-of-process child, or a parent that already left the registry).
   */
  | { readonly kind: 'unenforceable'; readonly why: string }

/** One structured budget breach, published on `budget-governor/breach`. */
export interface BudgetBreach {
  /** The breaching child's durable session id. */
  readonly subagentId: SessionId
  /** The provider that started the run, as recorded on `subagent/start`. */
  readonly provider: string
  /** Which budget was exceeded. */
  readonly kind: BreachKind
  /** The accumulated measurement at breach time; always strictly above {@link threshold}. */
  readonly observed: number
  /** The configured bound the measurement passed. */
  readonly threshold: number
  /** One-line account of the breach, carried into the parent's termination report. */
  readonly reason: string
  /** The oscillating file's display path (`file-churn` breaches only). */
  readonly path?: string
  /** What the governor was able to do about it. */
  readonly enforcement: BreachEnforcement
}

/**
 * Per-path churn chain: the last two distinct content digests written to one
 * file by one tracked subagent, plus how many times the subagent has flipped
 * BACK to the content before last. The two-slot window bounds memory and is
 * what lets the detector CLEAR — genuinely new content resets `revisits`.
 */
export interface ChurnChain {
  /** Digest of the most recent write. */
  previous?: string
  /** Digest of the write before that. */
  beforePrevious?: string
  /** How many A-to-B-back-to-A flips have happened without new content. */
  revisits: number
}

/** Everything the governor accounts for one tracked subagent run. */
export interface SubagentBudget {
  /** The provider recorded on `subagent/start`. */
  readonly provider: string
  /** Cumulative billed tokens observed on this child's own session log. */
  tokens: number
  /** Failed tool executions since the last successful one. */
  consecutiveToolFailures: number
  /** Per-path oscillation chains, capped and evicted in insertion order. */
  readonly churn: Map<string, ChurnChain>
  /**
   * Whether this run already reported a breach. A run breaches at most once:
   * the first breach is the terminal verdict, and re-reporting a child that
   * was already stopped would turn one runaway into an event storm.
   */
  breached: boolean
}
