/**
 * Budget governor: a hook/guard plugin that registers NO model-facing tool.
 * It subscribes to the runtime's read-only observe hooks, accounts three
 * runaway signals per subagent — cumulative billed token spend, consecutive
 * failed tool executions, and oscillating file churn — and on the first breach
 * requests the subagent seam's one public stop, then delivers a structured
 * termination report to the child's parent.
 *
 * The spec this was built from named `subagent/turn-end`, `tool/call`, and
 * `ctx.subagents.abort(subagentId, reason)`. None of the three exists. The
 * real surface is `subagent/start` / `subagent/end` (run lifecycle),
 * `tools/result` (the frozen final tool outcome; `tool/call` is a session-log
 * EVENT TYPE, not a Cordis hook), `session/event` (the child's own log, which
 * is where token accounting actually lives), and
 * `ctx.subagents.interrupt(targetSessionId, authority)` — documented as "the
 * one public stop". The README's Abort seam section records the full mapping
 * and why `Agent.cancel({ kind: 'hook', reason })` was rejected.
 *
 * Named exports preserve loader injection metadata.
 * @module @deepseek-ai/dsh-plugin-budget-governor
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-subagent'
import { BudgetGovernor } from './governor.ts'
import type { GovernorSettings } from './governor.ts'
import type { BudgetBreach } from './types.ts'

export { BudgetGovernor, MAX_TRACKED_CHURN_PATHS, PACKAGE_NAME } from './governor.ts'
export { advanceChurn, billedTokens, contentDigest, describeEnforcement, firstStringArgument, renderTerminationReport } from './governor.ts'
export type { GovernorSettings } from './governor.ts'
export type { BreachEnforcement, BreachKind, BudgetBreach, ChurnChain, SubagentBudget } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One tracked subagent exceeded a budget. Observe-only and emitted once
     * per run: the first breach is the terminal verdict. The payload's
     * `enforcement` states whether a stop was actually requested, so a listener
     * can alert on `unenforceable` breaches — the runaway the governor saw but
     * could not stop.
     * @param breach - the structured breach verdict.
     * @mode emit
     */
    'budget-governor/breach'(breach: BudgetBreach): void
  }
}

export const name = 'plugin-budget-governor'
export const inject = ['subagents', 'agents']

/** Oscillating-file-churn accounting settings. */
export interface ChurnConfig {
  /** Whether churn accounting runs at all. */
  enabled: boolean
  /** Tool names whose successful results count as a file mutation. */
  tools: string[]
  /** Argument keys read, in order, for the mutated file's path. */
  pathKeys: string[]
  /** Argument keys whose string values form the written-content fingerprint. */
  contentKeys: string[]
  /** Flips back to earlier content tolerated per file; the next one breaches. */
  repeatThreshold: number
}

/** Runtime configuration for the budget governor. */
export interface Config {
  /** Cumulative billed-token ceiling per subagent run; omitted disables the token budget. */
  maxTokens?: number
  /** Consecutive failed tool executions tolerated; the next one breaches. */
  maxConsecutiveToolFailures: number
  /** Oscillating-file-churn accounting. */
  churn: ChurnConfig
  /**
   * `interrupt` requests the subagent seam's stop on breach; `report` accounts
   * and announces without ever asking the seam to stop anything.
   */
  onBreach: 'interrupt' | 'report'
}

/** Runtime configuration schema for the budget governor. */
export const Config: z<Config> = z.object({
  // Preserve omission: a materialized 0 would breach on the child's first call.
  maxTokens: z.natural().max(Number.MAX_SAFE_INTEGER).default(undefined as unknown as number),
  maxConsecutiveToolFailures: z.natural().max(Number.MAX_SAFE_INTEGER).default(4),
  churn: z.object({
    enabled: z.boolean().default(true),
    tools: z.array(z.string()).default(['write', 'edit', 'str_replace_editor']),
    pathKeys: z.array(z.string()).default(['path', 'file_path']),
    contentKeys: z.array(z.string()).default(['content', 'file_text', 'new_string', 'new_str']),
    repeatThreshold: z.natural().max(Number.MAX_SAFE_INTEGER).default(2),
  }),
  onBreach: z.union([z.const('interrupt' as const), z.const('report' as const)]).default('interrupt'),
})

/**
 * Validate configuration and reject anything that would make the governor a
 * control that cannot fire — or one that fires on healthy work.
 *
 * Schemastery constrains SHAPE at load; a direct `apply()` bypasses it
 * entirely, and no schema can state "a churn threshold below 2 reports every
 * ordinary revision as oscillation". These are the semantic bounds, checked
 * where they cannot be skipped.
 * @param config - the governor configuration.
 * @returns the resolved settings the governor runs on.
 * @throws when a bound would disarm the detector or make it fire on healthy work.
 */
export function resolveSettings(config: Config): GovernorSettings {
  if (config.maxTokens !== undefined && config.maxTokens < 1) {
    throw new Error('plugin-budget-governor: `maxTokens` must be at least 1 — omit the key to disable the token budget instead of setting it to 0')
  }
  if (config.maxConsecutiveToolFailures < 1) {
    throw new Error('plugin-budget-governor: `maxConsecutiveToolFailures` must be at least 1 — a limit of 0 breaches on a child\'s first failed tool call')
  }
  const churn = config.churn
  if (churn.enabled) {
    if (churn.repeatThreshold < 2) {
      throw new Error('plugin-budget-governor: `churn.repeatThreshold` must be at least 2 — a lower bound reports an ordinary revert as oscillation')
    }
    if (churn.tools.length === 0) {
      throw new Error('plugin-budget-governor: `churn.enabled` is true but `churn.tools` is empty — no tool result would ever be accounted; set `churn.enabled` to false instead')
    }
    if (churn.pathKeys.length === 0) {
      throw new Error('plugin-budget-governor: `churn.enabled` is true but `churn.pathKeys` is empty — no mutation could be attributed to a file')
    }
    if (churn.contentKeys.length === 0) {
      throw new Error('plugin-budget-governor: `churn.enabled` is true but `churn.contentKeys` is empty — no write could be fingerprinted')
    }
  }
  return {
    ...config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {},
    maxConsecutiveToolFailures: config.maxConsecutiveToolFailures,
    churnEnabled: churn.enabled,
    churnTools: churn.tools,
    churnPathKeys: churn.pathKeys,
    churnContentKeys: churn.contentKeys,
    churnRepeatThreshold: churn.repeatThreshold,
    onBreach: config.onBreach,
  }
}

/**
 * Subscribe the governor to the runtime's observe hooks.
 *
 * Every listener here is read-only: it inspects the borrowed payload, updates
 * package-local accounting, and returns nothing. The stop and the parent
 * report are outbound calls the governor makes on its own, not mutations of
 * anything a hook handed it.
 * @param ctx - Cordis context carrying the subagent service and agent registry.
 * @param config - governor configuration, validated here.
 */
export function apply(ctx: Context, config: Config): void {
  const governor = new BudgetGovernor(ctx, resolveSettings(config))
  ctx.on('subagent/start', info => governor.observeStart(info))
  ctx.on('subagent/end', info => governor.observeEnd(info))
  ctx.on('session/event', (session, event) => governor.observeSessionEvent(session, event))
  ctx.on('tools/result', (exec, result) => {
    governor.observeToolResult(exec, result)
    return undefined
  })
}
