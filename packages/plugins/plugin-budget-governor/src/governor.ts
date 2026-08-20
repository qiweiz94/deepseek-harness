/**
 * Per-subagent budget accounting and the breach response.
 *
 * The governor is an OBSERVER on three read-only seams — `subagent/start` and
 * `subagent/end` (the run lifecycle), `tools/result` (the frozen final tool
 * outcome), and `session/event` (the child's own append-only log) — and it
 * mutates nothing any of them hands it. Enforcement is a SEPARATE outbound
 * call the governor makes as an active caller on `ctx.subagents`, which is
 * what keeps the observe hooks read-only while the stop still goes through a
 * real, authorized seam operation.
 *
 * Root-context listeners see every agent's dispatch: `dsh-scope`'s carrier
 * filter admits a listener whose context carries no scope tag
 * (`scopeOf(ctx) === undefined` returns true), so scope filtering NARROWS
 * scoped listeners without hiding anything from an unscoped one.
 * @module @deepseek-ai/dsh-plugin-budget-governor/governor
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { SubagentRunEndInfo, SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import type { BreachEnforcement, BreachKind, BudgetBreach, ChurnChain, SubagentBudget } from './types.ts'

/** The npm package name, used as the plugin message source. */
export const PACKAGE_NAME = '@deepseek-ai/dsh-plugin-budget-governor'

/**
 * How many distinct files one tracked subagent keeps churn chains for. A chain
 * is two digests and a counter, but a child that rewrites thousands of paths
 * would still grow without a bound; the oldest chain is evicted first.
 */
export const MAX_TRACKED_CHURN_PATHS = 256

/** Resolved governor configuration, as {@link BudgetGovernor} consumes it. */
export interface GovernorSettings {
  /** Cumulative billed-token ceiling; `undefined` disables the token budget. */
  readonly maxTokens?: number
  /** Consecutive failed tool executions tolerated; the next one breaches. */
  readonly maxConsecutiveToolFailures: number
  /** Whether file-churn accounting runs at all. */
  readonly churnEnabled: boolean
  /** Tool names whose results count as a file mutation. */
  readonly churnTools: readonly string[]
  /** Argument keys read, in order, for the mutated file's path. */
  readonly churnPathKeys: readonly string[]
  /** Argument keys whose values form the written-content fingerprint. */
  readonly churnContentKeys: readonly string[]
  /** Flips back to previously written content tolerated; the next one breaches. */
  readonly churnRepeatThreshold: number
  /** Whether a breach requests the seam's stop or only reports. */
  readonly onBreach: 'interrupt' | 'report'
}

/**
 * Billed tokens for one model call. The three input counts are DISJOINT per
 * {@link TokenUsage} (uncached input, cache reads, cache writes), so billed
 * input is their sum; summing only `inputTokens` would undercount a
 * cache-heavy child by most of its real spend. `reasoningTokens` is
 * deliberately excluded — providers report it as a SUBSET of `outputTokens`,
 * so adding it would double-count.
 * @param usage - one call's token accounting.
 * @returns the billed token total for that call.
 */
export function billedTokens(usage: TokenUsage): number {
  return usage.inputTokens
    + usage.outputTokens
    + (usage.cacheReadTokens ?? 0)
    + (usage.cacheWriteTokens ?? 0)
}

/**
 * Read the first present string value among `keys` from parsed tool arguments.
 * @param args - the execution's losslessly-JSON parsed arguments.
 * @param keys - candidate argument keys, in precedence order.
 * @returns the first string value found, or undefined when none is present.
 */
export function firstStringArgument(args: unknown, keys: readonly string[]): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

/**
 * Fingerprint the content a mutation call wrote. Every configured content key
 * that carries a string contributes, so an `edit`-shaped call (old text plus
 * new text) fingerprints the whole replacement, not just one half. Key and
 * value are joined with `U+0000` and pairs with `U+0001` so ordinary source
 * text cannot make two different argument sets look identical. This is a churn
 * heuristic, not a security control: content that itself contains those code
 * points can still collide, and a collision only misses one oscillation.
 * @param args - the execution's parsed arguments.
 * @param keys - configured content argument keys.
 * @returns the joined fingerprint, or undefined when the call wrote no
 *   recognizable content (which is not a churn observation at all).
 */
export function contentDigest(args: unknown, keys: readonly string[]): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  const parts: string[] = []
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string') parts.push(`${key}\u0000${value}`)
  }
  return parts.length > 0 ? parts.join('\u0001') : undefined
}

/**
 * Advance one path's churn chain with a newly written content digest.
 *
 * Rewriting the SAME content is idempotent, not oscillation, so it advances
 * nothing. Flipping back to the content before last is one revisit. Anything
 * else is genuinely new work and CLEARS the chain — without that reset the
 * detector could never come back down, and a long healthy edit session would
 * eventually be reported as a runaway.
 * @param chain - the path's chain, mutated in place.
 * @param digest - the content fingerprint just written.
 * @returns the revisit count after this write.
 */
export function advanceChurn(chain: ChurnChain, digest: string): number {
  if (chain.previous === digest) return chain.revisits
  if (chain.beforePrevious === digest) chain.revisits += 1
  else chain.revisits = 0
  const previous = chain.previous
  if (previous === undefined) delete chain.beforePrevious
  else chain.beforePrevious = previous
  chain.previous = digest
  return chain.revisits
}

/** Render the structured termination report delivered to the breaching child's parent. */
export function renderTerminationReport(breach: BudgetBreach): string {
  const lines = [
    `[budget-governor] subagent ${breach.subagentId} exceeded its ${breach.kind} budget and was terminated.`,
    `provider: ${breach.provider}`,
    `observed: ${breach.observed}`,
    `threshold: ${breach.threshold}`,
  ]
  if (breach.path !== undefined) lines.push(`path: ${breach.path}`)
  lines.push(`action: ${describeEnforcement(breach.enforcement)}`)
  lines.push(
    'Its result, if any, is incomplete. Do not re-delegate the same task unchanged — '
    + 'narrow it, fix what made it loop, or do the work yourself.',
  )
  return lines.join('\n')
}

/** One-line rendering of what the governor was able to do about a breach. */
export function describeEnforcement(enforcement: BreachEnforcement): string {
  if (enforcement.kind === 'interrupted') return 'stop requested through ctx.subagents.interrupt()'
  if (enforcement.kind === 'reported') return 'reported only (onBreach: report)'
  return `NOT STOPPED — ${enforcement.why}`
}

/**
 * Per-subagent budget accounting with a one-shot breach verdict per run.
 *
 * Instances hold only package-local state; every seam it reads is read-only
 * and every seam it writes (`ctx.subagents.interrupt`, `Agent.inject`) is a
 * public operation called with authority derived from the child's own record.
 */
export class BudgetGovernor {
  private readonly tracked = new Map<SessionId, SubagentBudget>()

  /**
   * @param ctx - the Cordis context carrying `subagents` and `agents`.
   * @param settings - validated governor configuration.
   */
  constructor(private readonly ctx: Context, private readonly settings: GovernorSettings) {}

  /** Begin accounting for one published child run (`subagent/start`). */
  observeStart(info: SubagentRunInfo): void {
    this.tracked.set(info.id, {
      provider: info.provider,
      tokens: 0,
      consecutiveToolFailures: 0,
      churn: new Map(),
      breached: false,
    })
  }

  /** Release one settled run's accounting (`subagent/end`). */
  observeEnd(info: SubagentRunEndInfo): void {
    this.tracked.delete(info.id)
  }

  /**
   * Account one child session-log event (`session/event`). Only the model
   * call's own token accounting is read; every other event type is ignored.
   * @param session - the session that appended the event.
   * @param event - the appended event, exactly as recorded.
   */
  observeSessionEvent(session: Session, event: SessionEvent): void {
    if (event.type !== 'assistant/message') return
    const budget = this.live(session.id)
    if (budget === undefined) return
    const usage = (event.data as { usage?: TokenUsage }).usage
    if (usage === undefined) return
    budget.tokens += billedTokens(usage)
    const ceiling = this.settings.maxTokens
    if (ceiling === undefined || budget.tokens <= ceiling) return
    this.breach(session.id, budget, {
      kind: 'token-spend',
      observed: budget.tokens,
      threshold: ceiling,
      reason: `spent ${budget.tokens} billed tokens against a ${ceiling}-token budget`,
    })
  }

  /**
   * Account one frozen tool outcome (`tools/result`) against the failure-run
   * and file-churn budgets.
   * @param exec - the execution that traversed the pipeline.
   * @param result - the deep-frozen final result.
   */
  observeToolResult(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): void {
    const agent = exec.agent
    if (agent === undefined) return
    const budget = this.live(agent.id)
    if (budget === undefined) return
    if (result.isError) {
      budget.consecutiveToolFailures += 1
      const tolerated = this.settings.maxConsecutiveToolFailures
      if (budget.consecutiveToolFailures > tolerated) {
        this.breach(agent.id, budget, {
          kind: 'tool-failures',
          observed: budget.consecutiveToolFailures,
          threshold: tolerated,
          reason: `failed ${budget.consecutiveToolFailures} tool executions in a row against a limit of ${tolerated}`,
        })
      }
      return
    }
    // A success is the failure run's reset: the child recovered, so the run
    // that was building toward a breach is over.
    budget.consecutiveToolFailures = 0
    this.observeChurn(agent.id, budget, exec)
  }

  /** Account one successful mutation call against the per-path churn chain. */
  private observeChurn(id: SessionId, budget: SubagentBudget, exec: Readonly<ToolExecution>): void {
    if (!this.settings.churnEnabled) return
    if (!this.settings.churnTools.includes(exec.name)) return
    const path = firstStringArgument(exec.arguments, this.settings.churnPathKeys)
    if (path === undefined) return
    const digest = contentDigest(exec.arguments, this.settings.churnContentKeys)
    if (digest === undefined) return
    let chain = budget.churn.get(path)
    if (chain === undefined) {
      // Insertion order is eviction order: drop the least recently STARTED
      // chain so a broad refactor cannot grow this map without bound.
      if (budget.churn.size >= MAX_TRACKED_CHURN_PATHS) {
        const oldest = budget.churn.keys().next().value as string
        budget.churn.delete(oldest)
      }
      chain = { revisits: 0 }
      budget.churn.set(path, chain)
    }
    const revisits = advanceChurn(chain, digest)
    const tolerated = this.settings.churnRepeatThreshold
    if (revisits <= tolerated) return
    this.breach(id, budget, {
      kind: 'file-churn',
      observed: revisits,
      threshold: tolerated,
      path,
      reason: `rewrote ${path} back to earlier content ${revisits} times against a limit of ${tolerated}`,
    })
  }

  /** The budget for a run that has not already reported its terminal breach. */
  private live(id: SessionId): SubagentBudget | undefined {
    const budget = this.tracked.get(id)
    if (budget === undefined || budget.breached) return undefined
    return budget
  }

  /**
   * Publish one terminal breach: retire the run, request the seam's stop when
   * configured to, announce the structured verdict, and deliver the
   * termination report to the parent.
   */
  private breach(
    id: SessionId,
    budget: SubagentBudget,
    detail: { kind: BreachKind; observed: number; threshold: number; reason: string; path?: string },
  ): void {
    budget.breached = true
    const parent = this.parentOf(id)
    const breach: BudgetBreach = {
      subagentId: id,
      provider: budget.provider,
      ...detail,
      enforcement: this.stop(id, parent),
    }
    this.ctx.emit('budget-governor/breach', breach)
    // Quiet delivery: the parent learns why its child died at its next
    // pre-step without the report itself opening a turn.
    parent?.inject(createUserMessage({
      content: [{ type: 'text', text: renderTerminationReport(breach) }] as ContentBlock[],
      source: {
        kind: 'plugin',
        plugin: PACKAGE_NAME,
        form: 'notice',
        summary: boundContextSummary(`subagent ${id} ${breach.reason}`),
      },
    }))
  }

  /**
   * Request the subagent seam's one public stop.
   *
   * `ctx.subagents.interrupt()` authorizes an `ancestor` caller against the
   * target's recorded lineage; the parent here IS that recorded lineage (it
   * came from the child's own `session.header.parentSession`), so the seam's
   * UNAUTHORIZED rejection is not reachable from this call site. Without a
   * resolvable live parent there is no authority to present and therefore no
   * stop — the breach event and the `unenforceable` verdict are the loud
   * signal in that case.
   */
  private stop(id: SessionId, parent: Agent | undefined): BreachEnforcement {
    if (this.settings.onBreach === 'report') return { kind: 'reported' }
    if (parent === undefined) {
      return {
        kind: 'unenforceable',
        why: 'no live ancestor Agent for this child, so ctx.subagents.interrupt() has no authority to present '
          + '(an out-of-process child, or a parent that already left the agent registry)',
      }
    }
    this.ctx.subagents.interrupt(id, { kind: 'ancestor', agent: parent })
    return { kind: 'interrupted' }
  }

  /** The child's live direct parent Agent, from its own durable session header. */
  private parentOf(id: SessionId): Agent | undefined {
    const parentSession = this.ctx.agents.get(id)?.session.header.parentSession
    if (parentSession === undefined) return undefined
    return this.ctx.agents.get(parentSession)
  }
}
