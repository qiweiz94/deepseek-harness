/**
 * Bridge for unmodified Codex command hooks on harness interception points. It
 * supports five points (SessionStart, prompt/tool pre/post, Stop), regex-only
 * matchers, snake_case payloads without a trailing newline, no hook environment
 * or command substitution, and no pre-tool approval or rewrite path; only
 * blocking decisions are honored. Shared execution and parsing live in
 * `dsh-hook-protocol`; see the
 * [hook-bridges Agent Note](../../../../.agents/notes/implemented/feature/2026-06-30-hook-bridges.md).
 * @module @deepseek-ai/dsh-hooks-codex
 */

// Each dialect bridge keeps its complete dependency list visible at the entry
// point; a cross-package facade for imports alone would add indirection.
/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { PostToolDecision, PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import {
  appendHookInvoked,
  appendHookResult,
  applyHaltRequest,
  bindStartContext,
  combineHookGroups,
  createDetachedRuns,
  createSessionHookConfigCache,
  createStartGate,
  createStopLoopGuard,
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_MAX_CONSECUTIVE_STOP_BLOCKS,
  DEFAULT_STDERR_SUMMARY_MAX_CHARS,
  loadProcessHookConfig,
  matchesMatcher,
  mergeHookOutputs,
  resolveSharedHookLimits,
  runHook,
  type HookOutput,
  type MatcherGroup,
  type MergedHookOutcome,
} from '@deepseek-ai/dsh-hook-protocol'
import { parseCodexConfig, type CodexHookConfig } from './config.ts'
/* jscpd:ignore-end */

export const name = 'hooks-codex'
export const inject = ['shell']

/** Plugin config: where the Codex hooks.json lives + the model name for payloads. */
export interface Config {
  /**
   * Path to a Codex `hooks.json`. Process-level: read once at load, a relative
   * path resolves against the process launch cwd. Combine with
   * {@link sessionConfigFile} for per-session project-local discovery.
   */
  configPath: string
  /**
   * Per-session project-local hook config discovery: a path resolved against
   * each agent session's workspace (the `session/new` cwd), e.g.
   * `.codex/hooks.json`. Read and parsed once per session at first hook use;
   * its groups run after the process-level groups on each point. Unset ⇒ no
   * discovery. A workspace without the file has no session hooks; an unreadable
   * or invalid file logs a warning and contributes nothing.
   */
  sessionConfigFile?: string
  /** The model name stamped on every payload (Codex includes `model` on each event). */
  model?: string
  /** Default per-hook timeout in ms when a hook sets none (Codex default: 600000). */
  defaultTimeoutMs?: number
  /** Character cap for the `hook/result` event's persisted stderr summary. */
  stderrSummaryMaxChars?: number
  /**
   * Consecutive Stop-hook forced continuations allowed per turn before the
   * bridge overrides the block and lets the turn stop. Codex documents no cap
   * of its own; the default borrows Claude Code's 8-consecutive-blocks guard.
   */
  maxConsecutiveStopBlocks?: number
}

export const Config: z<Config> = z.object({
  configPath: z.string().required(),
  sessionConfigFile: z.string(),
  model: z.string().default(''),
  defaultTimeoutMs: z.number().default(DEFAULT_HOOK_TIMEOUT_MS),
  stderrSummaryMaxChars: z.number().default(DEFAULT_STDERR_SUMMARY_MAX_CHARS),
  maxConsecutiveStopBlocks: z.number().default(DEFAULT_MAX_CONSECUTIVE_STOP_BLOCKS),
})

let handlerCounter = 0
function nextHandlerId(point: string): string {
  return `codex:${point}:${++handlerCounter}`
}

const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'hooks-codex' }

export function apply(ctx: Context, config: Config): void {
  // Validate before config parsing so a bad value cannot be hidden by its early return.
  const { stderrSummaryMaxChars, maxConsecutiveStopBlocks } = resolveSharedHookLimits('hooks-codex', config)
  const defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS
  /** Warn about each parsed-and-skipped hook of one config source. */
  function warnSkipped(skipped: { event: string; reason: string }[]): void {
    for (const s of skipped) {
      ctx.logger.warn(`hooks-codex: skipping ${s.reason} on ${s.event} (only sync command hooks run)`)
    }
  }
  // Parse once at load. A read or parse failure logs and registers nothing —
  // unless per-session discovery is configured, which stays functional.
  const loadedConfig = loadProcessHookConfig({
    configPath: config.configPath,
    hasSessionFallback: config.sessionConfigFile !== undefined,
    empty: {},
    parse: raw => parseCodexConfig(raw),
    warnSkipped,
    warnFailure: (error, degraded) => {
      const tail = degraded ? 'continuing with per-session discovery only' : 'no hooks registered'
      ctx.logger.warn(`hooks-codex: could not load hook config "${config.configPath}": ${String(error)} — ${tail}`)
    },
  })
  if (loadedConfig === undefined) return
  const parsed: CodexHookConfig = loadedConfig

  // Per-session project-local discovery: read once per session at first hook use.
  const sessionHookConfig = createSessionHookConfigCache({
    sessionConfigFile: config.sessionConfigFile,
    empty: {},
    parse: (raw, _cwd) => parseCodexConfig(raw),
    warnSkipped,
    warnFailure: (path, agentId, error) => {
      ctx.logger.warn(`hooks-codex: could not load session hook config "${path}": ${String(error)} — no session hooks for ${agentId}`)
    },
  })

  const model = config.model ?? ''

  // SessionStart is the one emit-shaped (detached) point Codex has: track its
  // run chains so disposal aborts a still-running hook process and drains the
  // continuation (docs/defensive-patterns.md: dispose must reach quiescence).
  const detached = createDetachedRuns()
  ctx.effect(() => () => detached.drain(), 'hooks-codex: drain detached hook runs')

  /**
   * Run and fold one configured Codex hook point.
   *
   * A supplied turn records the hook invocation/result pair inside that open turn.
   * Detached lifecycle points omit it.
   */
  async function runPoint(
    point: string,
    matchQuery: string,
    payload: unknown,
    opts: {
      agent?: Agent
      turn?: number
      readonly signal: AbortSignal
      plainStdoutAsContext?: boolean
    },
  ): Promise<MergedHookOutcome> {
    const groups: MatcherGroup[] = combineHookGroups(parsed[point], sessionHookConfig(opts.agent)[point])
    const outputs: HookOutput[] = []
    // Run hooks in the agent's session workspace so relative paths address the
    // user's project rather than the server launch directory.
    const workdir = opts.agent?.session.header.cwd
    for (const group of groups) {
      // Codex always interprets matchers as regexes; it has no literal fast path.
      if (!matchesMatcher(group.matcher, matchQuery, 'codex')) continue
      for (const hook of group.hooks) {
        const handlerId = nextHandlerId(point)
        const session = opts.agent?.session
        if (session && opts.turn !== undefined) {
          appendHookInvoked(session, {
            turn: opts.turn, point, dialect: 'codex', handlerId,
            ...group.matcher !== undefined ? { matcher: group.matcher } : {},
          })
        }
        const { output, durationMs } = await runHook(ctx.shell, hook, {
          payload,
          defaultTimeoutMs,
          ...workdir !== undefined ? { cwd: workdir } : {},
          signal: opts.signal,
          trailingNewline: false, // Codex writes stdin without a trailing newline.
          // Discard a `hookSpecificOutput` block naming a different event.
          expectedEventName: point,
        }, () => performance.now())
        // Clean plain stdout becomes context only when no structured context
        // exists; nonzero output and raw JSON never leak as prose.
        if (opts.plainStdoutAsContext === true && output.exitCode === 0
          && output.additionalContext === undefined
          && output.stdout.length > 0 && !output.stdout.startsWith('{')) {
          output.additionalContext = output.stdout
        }
        outputs.push(output)
        // Execution and decision mapping remain in each bridge so dialect
        // differences stay explicit at their owning extension point.
        /* jscpd:ignore-start */
        if (output.systemMessage !== undefined) {
          ctx.logger.warn(`hooks-codex: ${point} hook emitted a systemMessage, which is not yet surfaced (ignored)`)
        }
        if (session && opts.turn !== undefined) {
          appendHookResult(session, { turn: opts.turn, point, handlerId, output, stderrSummaryMaxChars, durationMs })
        }
      }
    }
    return mergeHookOutputs(outputs)
  }

  function contextFrom(merged: MergedHookOutcome): UserMessage | undefined {
    if (merged.additionalContext.length === 0) return undefined
    const content: ContentBlock[] = merged.additionalContext.map(text => ({ type: 'text', text }))
    return createUserMessage({ content, source: PLUGIN_SOURCE })
  }

  /** Prepend one context without flattening source fields or other downstream metadata. */
  function prependContext(ours: UserMessage, theirs: UserMessage[] | undefined): UserMessage[] {
    return [ours, ...theirs ?? []]
  }

  // SessionStart runs detached, but its resolved context is claimable: the
  // pre-step gate below folds it into the first entering step, so first-turn
  // delivery is promised rather than racing the hook. A run no step claims
  // falls back to `agent.inject`.
  const startGate = createStartGate<UserMessage>()
  /** The one warning both a rejected run and a throwing `deliver` (agent.inject) share. */
  function warnSessionStartFailed(error: unknown): void {
    ctx.logger.warn(`hooks-codex: SessionStart hook failed: ${String(error)}`)
  }
  ctx.on('agent/session-start', ({ agent, source }) => {
    const run = runPoint('SessionStart', source, { ...base(ctx, agent, 'SessionStart', model), source }, { agent, plainStdoutAsContext: true, signal: detached.signal })
      .then(contextFrom)
    detached.track(startGate.register(agent, run, (context) => { agent.inject(context) }, warnSessionStartFailed)
      .catch(warnSessionStartFailed))
  })

  // UserPromptSubmit → PreStepDecision. Codex supports reject, not rewrite or
  // ask. The step also gates on a pending SessionStart run so its context
  // reaches the first request; the gating itself is shared bindStartContext
  // plumbing, identical to Claude Code's, so it stays inside the ignored span.
  ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next): Promise<PreStepDecision> => {
    const withStartContext = await bindStartContext(startGate, agent, (m) => { agent.inject(m) })
    if (messages.length === 0) return withStartContext(await next())
    /* jscpd:ignore-end */
    const payload = {
      ...base(ctx, agent, 'UserPromptSubmit', model),
      turn_id: String(turn),
      prompt: blocksToText(messages.flatMap(message => message.content)),
    }
    const merged = await runPoint('UserPromptSubmit', '', payload, {
      agent, turn, plainStdoutAsContext: true, signal,
    })
    /* jscpd:ignore-start */
    if (merged.stop) {
      // continue:false halts the whole run; the claimed start context is
      // dropped with the rest of the cancelled pending work.
      applyHaltRequest(merged, 'UserPromptSubmit', agent)
      return { kind: 'reject' }
    }
    if (merged.decision === 'deny') {
      return withStartContext({ kind: 'reject' })
    }
    // Context alone is not a veto: DELEGATE so a later pre-step listener can
    // still reject/rewrite, then fold our context onto its decision.
    const downstream = withStartContext(await next())
    const ours = contextFrom(merged)
    if (!ours || downstream.kind !== 'enter') return downstream
    return {
      kind: 'enter',
      messages: [...downstream.messages, ours],
    }
  })

  // PreToolUse → PreToolDecision. Codex blocks only (no allow/ask honored).
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const turn = lastTurn(exec.agent)
    const merged = await runPoint('PreToolUse', exec.name, preToolPayload(ctx, exec, model), { ...exec.agent ? { agent: exec.agent } : {}, turn, signal: exec.signal })
    /* jscpd:ignore-end */
    if (merged.stop) {
      // continue:false halts the run before the tool runs; a no-agent direct
      // execution has no run to halt but still gets the denial.
      const reason = applyHaltRequest(merged, 'PreToolUse', exec.agent)
      return { kind: 'deny', reason }
    }
    if (merged.decision === 'deny') return { kind: 'deny', reason: merged.reason ?? 'blocked by PreToolUse hook' }
    return next()
  })

  // PostToolUse → PostToolDecision (block with feedback, or attach context).
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const turn = lastTurn(exec.agent)
    /* jscpd:ignore-start */
    const merged = await runPoint('PostToolUse', exec.name, postToolPayload(ctx, exec, result, model), { ...exec.agent ? { agent: exec.agent } : {}, turn, signal: exec.signal })
    // continue:false halts the run after the tool ran; the point-local decision
    // below still maps so a downstream listener's bookkeeping stays intact.
    if (merged.stop) applyHaltRequest(merged, 'PostToolUse', exec.agent)
    const context = contextFrom(merged)
    if (merged.decision === 'deny') {
      return { kind: 'block', feedback: [{ type: 'text', text: merged.reason ?? 'blocked by PostToolUse hook' }], ...context ? { additionalContexts: [context] } : {} }
    }
    // Context alone is not a veto: DELEGATE, then fold our context onto the
    // downstream decision (a downstream block carries it too).
    const downstream = await next()
    if (!context) return downstream
    if (downstream.kind === 'block') {
      return { ...downstream, additionalContexts: prependContext(context, downstream.additionalContexts) }
    }
    return {
      ...downstream,
      additionalContexts: prependContext(context, downstream.additionalContexts),
    }
  })

  // A blocking Stop hook steers at the stopping boundary, which makes the
  // machine observe pending input and run another step. The guard counts
  // consecutive forced continuations per turn: the payload's `stop_hook_active`
  // is true on a boundary a Stop hook already forced, and the cap overrides an
  // unconditionally blocking hook so it cannot loop a turn forever.
  const stopGuard = createStopLoopGuard(maxConsecutiveStopBlocks)
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }): Promise<void> => {
    const stopHookActive = stopGuard.stopHookActive(agent, turn)
    const merged = await runPoint('Stop', '', { ...turnBase(ctx, agent, 'Stop', model), stop_hook_active: stopHookActive, last_assistant_message: null }, { agent, turn, signal })
    /* jscpd:ignore-end */
    if (merged.stop) {
      // continue:false overrides a blocking decision: the halt request is
      // satisfied by letting the turn close.
      stopGuard.clear(agent)
      return
    }
    if (merged.decision !== 'deny') {
      stopGuard.clear(agent)
      return
    }
    if (!stopGuard.tryForceContinue(agent, turn)) {
      ctx.logger.warn(`hooks-codex: Stop hook blocked ${maxConsecutiveStopBlocks} consecutive times; overriding the block and letting the turn stop`)
      return
    }
    // A blocking Stop hook forces continuation; a block with no reason (exit 2,
    // empty stderr) still forces it — fall back to a generic steering line
    // rather than letting the turn stop.
    const text = merged.reason ?? 'continue: blocked by Stop hook'
    agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: PLUGIN_SOURCE }))
  })
}

// --- Codex DIALECT payloads: snake_case, model on every event, turn_id on
// turn-scoped events. ---

// These small payload helpers intentionally remain next to the dialect shape;
// sharing them would pull bridge-only agent/LLM dependencies into hook-protocol.
/* jscpd:ignore-start */
function lastTurn(agent: Agent | undefined): number {
  if (!agent) return 0
  const last = [...agent.session.events].findLast(e => e.type === 'turn/start')
  /* v8 ignore next -- agent-present turnBase callers are tool/stop extension points inside an open turn. */
  return last?.type === 'turn/start' ? last.data.turn : 0
}

function blocksToText(content: ContentBlock[]): string {
  return content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map(b => b.text).join('')
}
/* jscpd:ignore-end */

/** Base fields on every Codex payload (no turn_id). */
function base(ctx: Context, agent: Agent | undefined, event: string, model: string): Record<string, unknown> {
  return {
    session_id: agent?.session.header.id ?? '',
    transcript_path: agent === undefined
      ? null
      : ctx.get('sessionPersistence')?.locate(agent.session.header)?.path ?? null,
    cwd: agent?.session.header.cwd ?? process.cwd(),
    hook_event_name: event,
    model,
    permission_mode: 'default',
  }
}

/** Base + turn_id, for the turn-scoped events (PreToolUse/PostToolUse/UserPromptSubmit/Stop). */
function turnBase(ctx: Context, agent: Agent | undefined, event: string, model: string): Record<string, unknown> {
  return { ...base(ctx, agent, event, model), turn_id: String(lastTurn(agent)) }
}

/** Extract a `command` string from a tool call's parsed arguments, else ''. */
function commandOf(args: unknown): string {
  if (typeof args === 'object' && args !== null && 'command' in args) {
    const command: unknown = args.command
    if (typeof command === 'string') return command
  }
  return ''
}

function preToolPayload(ctx: Context, exec: ToolExecution, model: string): Record<string, unknown> {
  // `tool_name` is the REAL tool name (matching the `exec.name` matcher subject);
  // a hardcoded constant would disagree with what the matcher tests and make a
  // config's tool matcher never fire. `tool_input` keeps Codex's `{ command }`
  // shape (its shell payload), derived from the call's `command` arg when present.
  return { ...turnBase(ctx, exec.agent, 'PreToolUse', model), tool_name: exec.name, tool_input: { command: commandOf(exec.arguments) }, tool_use_id: exec.callId }
}

function postToolPayload(ctx: Context, exec: ToolExecution, result: ToolExecutionResult, model: string): Record<string, unknown> {
  return { ...turnBase(ctx, exec.agent, 'PostToolUse', model), tool_name: exec.name, tool_input: { command: commandOf(exec.arguments) }, tool_use_id: exec.callId, tool_response: blocksToText(result.content) }
}
