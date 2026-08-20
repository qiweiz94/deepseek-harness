/**
 * Shared bounded-integer config resolution for both bridges'
 * `stderrSummaryMaxChars` and `maxConsecutiveStopBlocks` fields: default each
 * from the protocol's reference value, then require a positive integer so
 * neither value can silently misbehave (a non-positive summary cap or block
 * cap breaks its consumer without an obvious symptom).
 * @module @deepseek-ai/dsh-hook-protocol/config-limits
 */

import { DEFAULT_STDERR_SUMMARY_MAX_CHARS } from './events.ts'
import { DEFAULT_MAX_CONSECUTIVE_STOP_BLOCKS } from './stop-guard.ts'

/**
 * Require `value` to be a positive integer, or throw with the bridge and
 * field name. `stderrSummaryMaxChars` bounds a persisted event field's slice
 * length; `maxConsecutiveStopBlocks` bounds a per-turn forced-continuation
 * count — either misbehaves silently on a non-positive value.
 * @param bridge - the bridge name stamped on the thrown message (e.g. `hooks-claude-code`).
 * @param name - the config field name stamped on the thrown message.
 * @param value - the value to check.
 */
export function assertPositiveInteger(bridge: string, name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${bridge}: ${name} must be a positive integer`)
  }
}

/** The raw optional field values a bridge's `Config` supplies to {@link resolveSharedHookLimits}. */
export interface SharedHookLimitsConfig {
  stderrSummaryMaxChars?: number
  maxConsecutiveStopBlocks?: number
}

/** The defaulted, validated field values {@link resolveSharedHookLimits} returns. */
export interface SharedHookLimits {
  stderrSummaryMaxChars: number
  maxConsecutiveStopBlocks: number
}

/**
 * Default and validate the two shared positive-integer config fields.
 * Validation happens before any config-file parsing so a bad value cannot be
 * hidden by a load failure's early return.
 * @param bridge - the bridge name stamped on a thrown message.
 * @param config - the raw optional field values from the bridge's `Config`.
 * @returns the defaulted, validated field values.
 */
export function resolveSharedHookLimits(bridge: string, config: SharedHookLimitsConfig): SharedHookLimits {
  const stderrSummaryMaxChars = config.stderrSummaryMaxChars ?? DEFAULT_STDERR_SUMMARY_MAX_CHARS
  assertPositiveInteger(bridge, 'stderrSummaryMaxChars', stderrSummaryMaxChars)
  const maxConsecutiveStopBlocks = config.maxConsecutiveStopBlocks ?? DEFAULT_MAX_CONSECUTIVE_STOP_BLOCKS
  assertPositiveInteger(bridge, 'maxConsecutiveStopBlocks', maxConsecutiveStopBlocks)
  return { stderrSummaryMaxChars, maxConsecutiveStopBlocks }
}
