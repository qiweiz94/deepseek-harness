/** Model-visible continuation prompt for one same-session goal round. */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { truncateCodePoints } from '@deepseek-ai/dsh-output-retention'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { GoalView } from '@deepseek-ai/dsh-goal'

/** Hard budget for one goal-round prompt, keeping repetitive rounds cheap. */
export const MAX_ROUND_PROMPT_CHARS = 1000

/**
 * Truncate a JSON-stringified objective to at most `maxUnits` UTF-16 units,
 * landing on a code-point boundary. The naive `.slice(0, maxUnits)` cut splits
 * an astral pair into a lone surrogate; this drops whole trailing code points
 * until the unit budget is honored without ever producing a lone half.
 * @param text - the objective to bound.
 * @param maxUnits - the unit budget (the caller keeps one unit for the marker).
 * @returns a code-point-safe prefix of at most `maxUnits` units.
 */
function limitObjectiveToUnits(text: string, maxUnits: number): string {
  /* v8 ignore next -- callers invoke this only when the objective already exceeds the unit budget. */
  if (text.length <= maxUnits) return text
  let units = 0
  let codePoints = 0
  for (const codePoint of text) {
    const unitCount = codePoint.length
    if (units + unitCount > maxUnits) break
    units += unitCount
    codePoints += 1
  }
  // One O(n) pass instead of dropping a single code point per iteration, then a
  // single library truncation to the found code-point count.
  return truncateCodePoints(text, codePoints)
}

/** Stable directive text; the objective line is the only variable part. */
const DIRECTIVE = 'Continue working toward the objective in this same session. Treat the current workspace, '
  + 'tool results, and durable session state as authoritative; inspect them instead of assuming '
  + 'earlier narration is still current. Make concrete progress and verify the result. Before '
  + 'claiming completion, gather evidence that the whole objective is achieved, read the current '
  + 'goal, and mark it complete. If work remains, leave the goal active for the next round. Follow '
  + 'the configured goal-tool policy before reporting a blocker.'

/**
 * Whether this exact goal revision's objective text was already delivered as a
 * prior admitted goal-round message. Pure over durable session events, so the
 * driver and its invariant companion reconstruct the same prompt.
 * @param events - durable session events preceding the candidate round message.
 * @param goal - exact goal revision being admitted.
 * @returns true when an earlier goal-round message carried the same revision.
 */
export function objectiveAlreadyAdmitted(events: readonly SessionEvent[], goal: GoalView): boolean {
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const source = event.data.source
    if (source.kind !== 'goal' || source.round <= 0) continue
    if (source.goalId === goal.id && source.revision === goal.revision) return true
  }
  return false
}

/**
 * Render the goal-round instruction retained in session history.
 *
 * Repetitive rounds coalesce: when the exact objective was already admitted
 * for this revision ({@link includeObjective} false), the prompt omits the
 * `Objective:` line entirely. Every rendered prompt stays within
 * {@link MAX_ROUND_PROMPT_CHARS}; an over-long objective is truncated
 * deterministically rather than exceeding the budget.
 * @param goal - exact active goal revision being admitted.
 * @param round - next positive round number.
 * @param includeObjective - whether to repeat the objective text (default true).
 * @returns a fresh one-block prompt for `Agent.followup()`.
 */
export function renderGoalRoundPrompt(
  goal: GoalView,
  round: number,
  includeObjective = true,
): ContentBlock[] {
  const objective = JSON.stringify(goal.objective)
  const objectiveLine = includeObjective ? `Objective: ${objective}\n` : ''
  const head = `<goal_round>\n${objectiveLine}Round: ${round}/${goal.maxGoalRounds}\n\n`
  let text = head + DIRECTIVE + '\n</goal_round>'
  if (text.length > MAX_ROUND_PROMPT_CHARS && includeObjective) {
    const slack = MAX_ROUND_PROMPT_CHARS - (text.length - objective.length)
    /* v8 ignore next 3 -- text over the cap implies the objective exceeds its
       slack; the fitting arm answers the guard's arithmetic, not a reachable case. */
    const kept = objective.length <= slack
      ? objective
      : limitObjectiveToUnits(objective, Math.max(slack - 1, 0)) + '…'
    text = `<goal_round>\nObjective: ${kept}\nRound: ${round}/${goal.maxGoalRounds}\n\n`
      + DIRECTIVE + '\n</goal_round>'
  }
  return [{ type: 'text', text }]
}
