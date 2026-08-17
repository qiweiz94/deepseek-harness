/**
 * Configuration vocabulary for the replay-aware basic compaction backend.
 *
 * @module @deepseek-ai/dsh-compaction-basic/types
 */

import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'

/** Policy fields shared by the default policy and exact model overrides. */
export interface CompactionPolicyConfig {
  /** Compact at this fraction of the model's context window; fallback when `triggerTokens` is unset. */
  thresholdRatio?: number
  /** Absolute pressure trigger in tokens; wins over `thresholdRatio`. Defaults to `120000`. */
  triggerTokens?: number
  /** Recent context retained as a fraction of the model's window; fallback when `targetResidualTokens` is unset. */
  retainRatio?: number
  /** Absolute recent-context budget; mutually exclusive with `retainRatio`. */
  retainTokens?: number
  /** Absolute post-compaction residual budget in tokens; wins over `retainTokens`/`retainRatio`. Defaults to `42000`. */
  targetResidualTokens?: number
  /** Summary provider; set together with `summarizationModel`, or inherit the conversation target. */
  summarizationProvider?: string
  /** Summary model; set together with `summarizationProvider`, or inherit the conversation target. */
  summarizationModel?: string
  /** Provider generation cap for summarization. Defaults to `8192`. */
  maxTokens?: number
  /** Extra attempts after the first compaction when pressure remains above threshold. Defaults to `1`. */
  compactionRetries?: number
  /** Maximum retries after canonical context overflow; `0` disables recovery. Defaults to `1`. */
  maxOverflowRetries?: number
}

/** Exact provider/model override merged over the default compaction policy. */
export interface ModelCompactPolicyConfig extends CompactionPolicyConfig {
  /** Registered provider route to match. */
  provider: string
  /** Exact routed model id to match within `provider`. */
  model: string
}

/** Basic compaction configuration with an optional exact-target policy table. */
export interface BasicCompactionConfig extends CompactionPolicyConfig {
  /** Exact provider/model overrides; duplicate targets fail plugin load. */
  modelPolicies?: ModelCompactPolicyConfig[]
  /** Enable automatic step-boundary pressure and overflow-recovery listeners. Defaults to `true`. */
  auto?: boolean
}

/** Exactly one validated retention form. */
export type ResolvedRetention =
  | { readonly retainRatio: number; readonly retainTokens?: never }
  | { readonly retainRatio?: never; readonly retainTokens: number }

/** Validated policy fields shared before and after exact-target matching. */
interface ResolvedPolicyFields {
  /** Explicit fraction override; undefined means the absolute default applies at spec time. */
  readonly thresholdRatio?: number
  /** Explicit absolute pressure trigger; defaults to 120000 at spec time. */
  readonly triggerTokens?: number
  /** Explicit absolute post-compaction residual; defaults to 42000 at spec time. */
  readonly targetResidualTokens?: number
  readonly summarizationProvider: string
  readonly summarizationModel: string
  readonly maxTokens: number
  readonly compactionRetries: number
  readonly maxOverflowRetries: number
}

/** Validated immutable config whose target-specific defaults remain unresolved. */
export type ResolvedConfig = ResolvedPolicyFields & ResolvedRetention & {
  readonly modelPolicies: readonly Readonly<ModelCompactPolicyConfig>[]
  readonly auto: boolean
  /** True when no retention knob was configured at the top level; the default residual then clamps under the trigger. */
  readonly defaultRetention: boolean
}

/** Fully merged policy for one routed conversation target, before capacity scaling. */
export type ResolvedTargetPolicy = ResolvedPolicyFields & ResolvedRetention & {
  readonly target: Pick<LlmCallConfig, 'provider' | 'model'>
  /** True when the retention budget resolved from the default; it clamps under the trigger. */
  readonly defaultRetention: boolean
}

/** One routed model's concrete pressure and retention budget. */
export type ResolvedCompactSpec = Omit<
  ResolvedTargetPolicy,
  'retainRatio' | 'retainTokens' | 'defaultRetention'
> & {
  readonly contextWindow: number
  readonly thresholdTokens: number
  readonly retainTokens: number
}
