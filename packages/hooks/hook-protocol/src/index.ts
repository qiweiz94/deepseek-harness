/**
 * Shared, non-plugin hook protocol library: matching, command execution and
 * decoding, restrictive outcome merging, durable event helpers, detached run
 * quiescence, run-level halt mapping, Stop-loop accounting, and the
 * session-start first-step gate. Claude Code and Codex bridges own their
 * distinct payloads, environment rules, matcher mode, and typed
 * extension-point mappings.
 * @module @deepseek-ai/dsh-hook-protocol
 */

export type {
  CommandHook,
  HookDialect,
  HookOutput,
  MatcherGroup,
  MatcherMode,
} from './types.ts'
export { matcherDiagnostic, matchesMatcher } from './matcher.ts'
export { parseHookOutput } from './codec.ts'
export { DEFAULT_HOOK_TIMEOUT_MS, runHook } from './runner.ts'
export type { RunHookOptions, RunHookResult } from './runner.ts'
export { mergeHookOutputs } from './merge.ts'
export type { MergedDecision, MergedHookOutcome } from './merge.ts'
export { appendHookInvoked, appendHookResult, DEFAULT_STDERR_SUMMARY_MAX_CHARS, summarizeStderr } from './events.ts'
export type { HookInvocation, HookResultRecord } from './events.ts'
export { createDetachedRuns } from './detached.ts'
export type { DetachedRuns } from './detached.ts'
export { applyHaltRequest } from './halt.ts'
export type { HaltTarget } from './halt.ts'
export { createStopLoopGuard, DEFAULT_MAX_CONSECUTIVE_STOP_BLOCKS } from './stop-guard.ts'
export type { StopLoopGuard } from './stop-guard.ts'
export { createStartGate } from './start-gate.ts'
export type { StartGate } from './start-gate.ts'
