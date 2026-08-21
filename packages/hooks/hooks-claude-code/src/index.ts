/**
 * Bridge for unmodified Claude Code command hooks on harness interception
 * extension points. It supports SessionStart, prompt/tool pre/post, Stop, and subagent
 * start/stop. It owns Claude payloads, environment, substitution, and decision
 * mapping; shared execution and parsing live in `dsh-hook-protocol`.
 * `updatedInput` is logged and warned but not honored. Bespoke behavior should
 * use typed native plugins on the same extension points; see the
 * [hook-bridges Agent Note](../../../../.agents/notes/implemented/feature/2026-06-30-hook-bridges.md).
 * @module @deepseek-ai/dsh-hooks-claude-code
 */

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
  workspaceTrustPredicate,
  type HookOutput,
  type MatcherGroup,
  type MergedHookOutcome,
} from '@deepseek-ai/dsh-hook-protocol'
// Pulls in the declaration-merged subagent events and the identity pairing their
// start/end edges.
import type { SubagentRunId } from '@deepseek-ai/dsh-subagent'
import { parseClaudeCodeConfig, type ClaudeCodeHookConfig } from './config.ts'

export const name = 'hooks-claude-code'
// `bash` is required to run hooks; the rest are read opportunistically via
// ctx.get so a deployment can load this bridge without every extension point present.
export const inject = ['shell']

/** Plugin config: where the CC hook config lives + substitution roots. */
export interface Config {
  /**
   * Path to a `hooks.json` or a settings file whose `hooks` key holds the config.
   * Process-level: read once at load, a relative path resolves against the process
   * launch cwd, so one config applies to the whole process. Combine with
   * {@link sessionConfigFile} for per-session project-local discovery.
   */
  configPath: string
  /**
   * Per-session project-local hook config discovery: a path resolved against
   * each agent session's workspace (the `session/new` cwd), e.g.
   * `.claude/hooks.json`. Read and parsed once per session at first hook use;
   * its groups run after the process-level groups on each point. Unset ⇒ no
   * discovery. A workspace without the file has no session hooks; an unreadable
   * or invalid file logs a warning and contributes nothing. Discovery runs a
   * workspace's hooks only when the workspace is listed in
   * {@link trustedWorkspaceRoots}; an untrusted workspace contributes nothing.
   */
  sessionConfigFile?: string
  /**
   * Workspace roots the deployment trusts to supply project-local hooks
   * (absolute, or relative to the process launch cwd). A session whose cwd is
   * one of these roots, or nested under one, may run its `sessionConfigFile`
   * hooks; every other workspace is denied. Empty/unset ⇒ no workspace is
   * trusted, so `sessionConfigFile` discovery never runs a command — a freshly
   * cloned untrusted repo cannot plant a hook that executes before any user
   * action.
   */
  trustedWorkspaceRoots?: string[]
  /**
   * Replaces `${CLAUDE_PLUGIN_ROOT}` in command strings (the plugin's root dir).
   */
  pluginRoot?: string
  /**
   * Replaces `${CLAUDE_PROJECT_DIR}` in command strings AND is exported as the
   * `CLAUDE_PROJECT_DIR` env var for hook processes. When omitted, the env var
   * defaults per-run to the agent's session workspace (`session.header.cwd`, the
   * same dir the hook runs in) — Claude Code always exports this var, and common
   * unmodified hooks reference `$CLAUDE_PROJECT_DIR` for project-relative paths.
   */
  projectDir?: string
  /** Default per-hook timeout in ms when a hook sets none (CC default: 600000). */
  defaultTimeoutMs?: number
  /** Character cap for the `hook/result` event's persisted stderr summary. */
  stderrSummaryMaxChars?: number
  /**
   * Consecutive Stop-hook forced continuations allowed per turn before the
   * bridge overrides the block and lets the turn stop. Claude Code's own guard
   * overrides a Stop hook after 8 consecutive blocks.
   */
  maxConsecutiveStopBlocks?: number
}

export const Config: z<Config> = z.object({
  configPath: z.string().required(),
  sessionConfigFile: z.string(),
  trustedWorkspaceRoots: z.array(z.string()).default([]),
  pluginRoot: z.string(),
  projectDir: z.string(),
  defaultTimeoutMs: z.number().default(DEFAULT_HOOK_TIMEOUT_MS),
  stderrSummaryMaxChars: z.number().default(DEFAULT_STDERR_SUMMARY_MAX_CHARS),
  maxConsecutiveStopBlocks: z.number().default(DEFAULT_MAX_CONSECUTIVE_STOP_BLOCKS),
})

/** A stable per-handler id so an invoked/result pair correlates in the log. */
let handlerCounter = 0
function nextHandlerId(point: string): string {
  return `claude-code:${point}:${++handlerCounter}`
}

/** The `{kind:'plugin'}` source stamped on every context this bridge injects. */
const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'hooks-claude-code' }

export function apply(ctx: Context, config: Config): void {
  // Validate before config parsing so a bad value cannot be hidden by its early return.
  const { stderrSummaryMaxChars, maxConsecutiveStopBlocks } = resolveSharedHookLimits('hooks-claude-code', config)
  const defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS
  /** Warn about each parsed-and-skipped non-command hook of one config source. */
  function warnSkipped(skipped: { event: string; type: string }[]): void {
    for (const s of skipped) {
      ctx.logger.warn(`hooks-claude-code: skipping unsupported "${s.type}" hook on ${s.event} (only command hooks run)`)
    }
  }
  // Parse once at load. A read or parse failure logs and registers nothing —
  // unless per-session discovery is configured, which stays functional.
  const loadedConfig = loadProcessHookConfig({
    configPath: config.configPath,
    hasSessionFallback: config.sessionConfigFile !== undefined,
    empty: {},
    parse: raw => parseClaudeCodeConfig(raw, {
      ...config.pluginRoot !== undefined ? { pluginRoot: config.pluginRoot } : {},
      ...config.projectDir !== undefined ? { projectDir: config.projectDir } : {},
    }),
    warnSkipped,
    warnFailure: (error, degraded) => {
      const tail = degraded ? 'continuing with per-session discovery only' : 'no hooks registered'
      ctx.logger.warn(`hooks-claude-code: could not load hook config "${config.configPath}": ${String(error)} — ${tail}`)
    },
  })
  if (loadedConfig === undefined) return
  const parsed: ClaudeCodeHookConfig = loadedConfig

  // Per-session project-local discovery: read once per session at first hook
  // use. `${CLAUDE_PROJECT_DIR}` substitutes to the session workspace unless
  // an explicit projectDir is configured — the same default the env var uses.
  const trustedRoots = workspaceTrustPredicate(config.trustedWorkspaceRoots, process.cwd())
  const sessionHookConfig = createSessionHookConfigCache({
    sessionConfigFile: config.sessionConfigFile,
    ...trustedRoots !== undefined ? { isWorkspaceTrusted: trustedRoots } : {},
    warnUntrusted: (cwd, agentId) => {
      // Reached only after discovery confirmed `sessionConfigFile` is set (the
      // cache warns before reading), so it is always defined here.
      ctx.logger.warn(`hooks-claude-code: workspace ${cwd} is not a trusted workspace root; its ${config.sessionConfigFile} hooks are not run for ${agentId} (add it to trustedWorkspaceRoots to enable)`)
    },
    empty: {},
    parse: (raw, cwd) => parseClaudeCodeConfig(raw, {
      ...config.pluginRoot !== undefined ? { pluginRoot: config.pluginRoot } : {},
      projectDir: config.projectDir ?? cwd,
    }),
    warnSkipped,
    warnFailure: (path, agentId, error) => {
      ctx.logger.warn(`hooks-claude-code: could not load session hook config "${path}": ${String(error)} — no session hooks for ${agentId}`)
    },
  })

  // Emit-shaped points run detached, so track their chains; disposal aborts
  // active hooks and drains continuations before resolving.
  const detached = createDetachedRuns()
  // Only the start edge guarantees registry access. Retain each local child
  // through its paired end so stop hooks keep the session workspace after the
  // handle unregisters the agent. Every retained entry relies on that paired
  // end; a producer that can omit it must provide another release edge.
  const subagentChildren = new Map<SubagentRunId, Agent>()
  ctx.effect(() => () => detached.drain(), 'hooks-claude-code: drain detached hook runs')

  /**
   * Run every command hook configured for `point` whose matcher selects
   * `matchQuery`, with the per-event `payload` on stdin, and fold the results.
   * Writes a `hook/invoked`/`hook/result` pair per hook when `opts.turn` names
   * an open turn. Detached lifecycle points omit the pair. Returns the merged outcome (a neutral,
   * already-most-restrictive view) for the caller to map onto its extension point
   * decision. `matchQuery` is the event's matcher subject (tool name, session
   * source, …); `''` for events that ignore matchers.
   */
  async function runPoint(
    point: string,
    matchQuery: string,
    payload: unknown,
    opts: { agent?: Agent; turn?: number; readonly signal: AbortSignal },
  ): Promise<MergedHookOutcome> {
    const groups: MatcherGroup[] = combineHookGroups(parsed[point], sessionHookConfig(opts.agent)[point])
    const outputs: HookOutput[] = []
    // Run the hook in the agent's session workspace (the `session/new` cwd on the session
    // header), not the executor or entry-point process's launch dir.
    const workdir = opts.agent?.session.header.cwd
    // CLAUDE_PROJECT_DIR: an explicit config value wins; otherwise default it to the session
    // workspace (the same dir the hook runs in).
    const projectDir = config.projectDir ?? workdir
    const hookEnv = projectDir !== undefined ? { CLAUDE_PROJECT_DIR: projectDir } : undefined
    for (const group of groups) {
      if (!matchesMatcher(group.matcher, matchQuery, 'claude-code')) continue
      for (const hook of group.hooks) {
        const handlerId = nextHandlerId(point)
        const session = opts.agent?.session
        if (session && opts.turn !== undefined) {
          appendHookInvoked(session, {
            turn: opts.turn, point, dialect: 'claude-code', handlerId,
            ...group.matcher !== undefined ? { matcher: group.matcher } : {},
          })
        }
        const { output, durationMs } = await runHook(ctx.shell, hook, {
          payload,
          defaultTimeoutMs,
          ...hookEnv ? { env: hookEnv } : {},
          ...workdir !== undefined ? { cwd: workdir } : {},
          signal: opts.signal,
          trailingNewline: true,
          // Discard a `hookSpecificOutput` block whose `hookEventName` names a
          // different event than the one firing (the schemas key it by event).
          expectedEventName: point,
        }, () => performance.now())
        outputs.push(output)
        if (output.updatedInput !== undefined) {
          ctx.logger.warn(`hooks-claude-code: ${point} hook requested updatedInput, which is not yet honored (ignored)`)
        }
        if (output.systemMessage !== undefined) {
          ctx.logger.warn(`hooks-claude-code: ${point} hook emitted a systemMessage, which is not yet surfaced (ignored)`)
        }
        if (session && opts.turn !== undefined) {
          appendHookResult(session, { turn: opts.turn, point, handlerId, output, stderrSummaryMaxChars, durationMs })
        }
      }
    }
    return mergeHookOutputs(outputs)
  }

  /** Build additional model context from hook output, or return undefined when empty. */
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
    ctx.logger.warn(`hooks-claude-code: SessionStart hook failed: ${String(error)}`)
  }
  ctx.on('agent/session-start', ({ agent, source }) => {
    const run = runPoint('SessionStart', source, sessionStartPayload(ctx, agent, source), { agent, signal: detached.signal })
      .then(contextFrom)
    detached.track(startGate.register(agent, run, (context) => { agent.inject(context) }, warnSessionStartFailed)
      .catch(warnSessionStartFailed))
  })

  // --- UserPromptSubmit → PreStepDecision. The prompt text is the payload; no
  // matcher subject (CC ignores matchers for this event). The step also gates
  // on a pending SessionStart run so its context reaches the first request.
  // `agent/pre-step` also fires for a steered continuation, a plugin-injected
  // context, and a subagent settlement report — none of those is a genuine
  // prompt submission, so the hook fires only when the claimed batch holds a
  // message whose `source.kind` is `'user'` (the same discriminator
  // `dsh-tool-goal`'s `hasDirectHumanInput` uses for "was this direct human
  // input", per `Agent.followup()`/`steer()`'s documented default). ---
  ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next): Promise<PreStepDecision> => {
    const withStartContext = await bindStartContext(startGate, agent, (m) => { agent.inject(m) })
    if (messages.length === 0) return withStartContext(await next())
    if (!messages.some(message => message.source.kind === 'user')) return withStartContext(await next())
    const content = messages.flatMap(message => message.content)
    const merged = await runPoint('UserPromptSubmit', '', promptPayload(ctx, agent, content), { agent, turn, signal })
    if (merged.stop) {
      // continue:false halts the whole run; the claimed start context is
      // dropped with the rest of the cancelled pending work.
      applyHaltRequest(merged, 'UserPromptSubmit', agent)
      return { kind: 'reject' }
    }
    if (merged.decision === 'deny') {
      return withStartContext({ kind: 'reject' })
    }
    // Delegate so later listeners may still rewrite or reject, then prepend our
    // context only to a downstream enter decision.
    const downstream = withStartContext(await next())
    const ours = contextFrom(merged)
    if (!ours || downstream.kind !== 'enter') return downstream
    return {
      kind: 'enter',
      messages: [...downstream.messages, ours],
    }
  })

  // --- PreToolUse → PreToolDecision. Matcher subject is the tool name. ---
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const turn = lastTurn(exec.agent)
    const merged = await runPoint('PreToolUse', exec.name, preToolPayload(ctx, exec), { ...exec.agent ? { agent: exec.agent } : {}, turn, signal: exec.signal })
    if (merged.stop) {
      // continue:false halts the run before the tool runs; a no-agent direct
      // execution has no run to halt but still gets the denial.
      const reason = applyHaltRequest(merged, 'PreToolUse', exec.agent)
      return { kind: 'deny', reason }
    }
    if (merged.decision === 'deny') return { kind: 'deny', reason: merged.reason ?? 'blocked by PreToolUse hook' }
    if (merged.decision === 'ask') return { kind: 'ask', ...merged.reason !== undefined ? { reason: merged.reason } : {} }
    return next()
  })

  // --- PostToolUse → PostToolDecision. Matcher subject is the tool name. ---
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const turn = lastTurn(exec.agent)
    const merged = await runPoint('PostToolUse', exec.name, postToolPayload(ctx, exec, result), { ...exec.agent ? { agent: exec.agent } : {}, turn, signal: exec.signal })
    // continue:false halts the run after the tool ran; the point-local decision
    // below still maps so a downstream listener's bookkeeping stays intact.
    if (merged.stop) applyHaltRequest(merged, 'PostToolUse', exec.agent)
    const context = contextFrom(merged)
    if (merged.decision === 'deny') {
      return { kind: 'block', feedback: [{ type: 'text', text: merged.reason ?? 'blocked by PostToolUse hook' }], ...context ? { additionalContexts: [context] } : {} }
    }
    // Our hooks did not block. DELEGATE so a later listener can still block/replace,
    // then fold our context onto its decision (a downstream block carries it too).
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
    const merged = await runPoint('Stop', '', stopPayload(ctx, agent, stopHookActive), { agent, turn, signal })
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
      ctx.logger.warn(`hooks-claude-code: Stop hook blocked ${maxConsecutiveStopBlocks} consecutive times; overriding the block and letting the turn stop`)
      return
    }
    // A blocking Stop hook forces continuation.
    const text = merged.reason ?? 'continue: blocked by Stop hook'
    agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: PLUGIN_SOURCE }))
  })

  // SubagentStart may inject child context; SubagentStop only observes. Both
  // use the live child's workspace and the generic agent-type matcher subject.
  ctx.on('subagent/start', (info) => {
    const child = ctx.get('agents')?.get(info.id)
    if (child !== undefined) subagentChildren.set(info.runId, child)
    detached.track(runPoint('SubagentStart', SUBAGENT_TYPE, subagentPayload(ctx, 'SubagentStart', info, child), { ...child ? { agent: child } : {}, signal: detached.signal })
      .then((merged) => {
        const context = contextFrom(merged)
        if (context && child) child.inject(context)
      })
      .catch((error: unknown) => { ctx.logger.warn(`hooks-claude-code: SubagentStart hook failed: ${String(error)}`) }))
  })
  ctx.on('subagent/end', (info) => {
    const child = subagentChildren.get(info.runId) ?? ctx.get('agents')?.get(info.id)
    subagentChildren.delete(info.runId)
    detached.track(runPoint('SubagentStop', SUBAGENT_TYPE, subagentPayload(ctx, 'SubagentStop', info, child), { ...child ? { agent: child } : {}, signal: detached.signal }))
  })
}

/**
 * The `agent_type` value the bridge reports for SubagentStart/Stop. The harness
 * subagent seam carries no per-kind label, so the bridge uses Claude Code's own
 * Task-tool default — a hooks.json with a default/`*`/empty `agent_type` matcher
 * fires; a config matching a specific kind (e.g. `code-reviewer`) does not.
 */
const SUBAGENT_TYPE = 'general-purpose'

// --- Per-event stdin payloads (the CC DIALECT shape). Field names match CC's
// hook input schema; this is the part a bridge owns. ---

/** The last open turn number in the agent's log, or 0 without an agent. */
function lastTurn(agent: Agent | undefined): number {
  if (!agent) return 0
  const last = [...agent.session.events].findLast(e => e.type === 'turn/start')
  /* v8 ignore next -- agent-present callers are tool/stop extension points inside an open turn. */
  return last?.type === 'turn/start' ? last.data.turn : 0
}

/** Flatten content blocks to the text a hook payload carries (the common case). */
function blocksToText(content: ContentBlock[]): string {
  return content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map(b => b.text).join('')
}

function base(ctx: Context, agent: Agent | undefined, event: string): Record<string, unknown> {
  return {
    session_id: agent?.session.header.id ?? '',
    transcript_path: agent === undefined
      ? ''
      : ctx.get('sessionPersistence')?.locate(agent.session.header)?.path ?? '',
    cwd: agent?.session.header.cwd ?? process.cwd(),
    hook_event_name: event,
  }
}

function sessionStartPayload(ctx: Context, agent: Agent, source: string): Record<string, unknown> {
  return { ...base(ctx, agent, 'SessionStart'), source }
}
function promptPayload(ctx: Context, agent: Agent, content: ContentBlock[]): Record<string, unknown> {
  return { ...base(ctx, agent, 'UserPromptSubmit'), prompt: blocksToText(content) }
}
function preToolPayload(ctx: Context, exec: ToolExecution): Record<string, unknown> {
  return { ...base(ctx, exec.agent, 'PreToolUse'), tool_name: exec.name, tool_input: exec.arguments, tool_use_id: exec.callId }
}
function postToolPayload(ctx: Context, exec: ToolExecution, result: ToolExecutionResult): Record<string, unknown> {
  return { ...base(ctx, exec.agent, 'PostToolUse'), tool_name: exec.name, tool_input: exec.arguments, tool_use_id: exec.callId, tool_response: blocksToText(result.content) }
}
function stopPayload(ctx: Context, agent: Agent, stopHookActive: boolean): Record<string, unknown> {
  return { ...base(ctx, agent, 'Stop'), stop_hook_active: stopHookActive }
}
/**
 * Build a SubagentStart/SubagentStop payload from the CC base (the child's
 * `session_id`/`cwd` when the child agent is available) plus the subagent-hook
 * fields. `agent_type` is the CC-default {@link SUBAGENT_TYPE}; `stop_hook_active`
 * is present on SubagentStop only (the loop-guard flag, always false).
 */
function subagentPayload(ctx: Context, event: 'SubagentStart' | 'SubagentStop', info: { id: string }, child: Agent | undefined): Record<string, unknown> {
  return {
    ...base(ctx, child, event),
    agent_id: info.id,
    agent_type: SUBAGENT_TYPE,
    ...event === 'SubagentStop' ? { stop_hook_active: false } : {},
  }
}
