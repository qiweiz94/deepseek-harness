/**
 * Process-level and per-session project-local hook config loading, shared by
 * both bridges. A bridge's `apply()` parses one process-level config file
 * once at load ({@link loadProcessHookConfig}) and, when its `Config` names a
 * `sessionConfigFile`, layers a per-session discovery cache on top
 * ({@link createSessionHookConfigCache}) so each hook point's matcher groups
 * combine both sources ({@link combineHookGroups}). Parsing, warning text, and
 * the matcher-group type stay bridge-owned; this module owns the mechanical
 * read/cache/fallback control flow both bridges share.
 * @module @deepseek-ai/dsh-hook-protocol/session-config
 */

import { readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

/**
 * The minimal session-workspace shape this module needs from an `Agent`, kept
 * structural so it does not depend on `@deepseek-ai/dsh-agent`.
 */
export interface SessionWorkspace {
  /** Identifies the agent in a session-discovery failure warning. */
  readonly id: string
  readonly session: { readonly header: { readonly cwd?: string } }
}

/**
 * Load a process-level hook config file at `apply()`. A read/parse failure is
 * tolerated when session-local discovery can still contribute hooks;
 * otherwise it means the bridge registers nothing.
 * @param opts.configPath - the process-level config file path.
 * @param opts.hasSessionFallback - `true` when the bridge's `sessionConfigFile`
 *   is configured, so a load failure here should not stop registration.
 * @param opts.empty - the config value to use when the load fails but
 *   {@link opts.hasSessionFallback} keeps the bridge running.
 * @param opts.parse - parse raw JSON into the bridge's config shape plus its skipped-hook records.
 * @param opts.warnSkipped - report the parse's skipped-hook records (bridge-specific wording).
 * @param opts.warnFailure - report the read/parse failure; `degraded` is {@link opts.hasSessionFallback}.
 * @returns the parsed config, `opts.empty` on a tolerated failure, or
 *   `undefined` when the caller must stop registration.
 */
export function loadProcessHookConfig<T, S>(opts: {
  configPath: string
  hasSessionFallback: boolean
  empty: T
  parse: (raw: unknown) => { config: T; skipped: S[] }
  warnSkipped: (skipped: S[]) => void
  warnFailure: (error: unknown, degraded: boolean) => void
}): T | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(opts.configPath, 'utf8'))
    const result = opts.parse(raw)
    opts.warnSkipped(result.skipped)
    return result.config
  } catch (error: unknown) {
    opts.warnFailure(error, opts.hasSessionFallback)
    return opts.hasSessionFallback ? opts.empty : undefined
  }
}

/**
 * Create a per-session project-local hook-config lookup. Reads and parses a
 * workspace-relative file once per agent at first use — including the "no
 * file" and "discovery unconfigured" outcomes — and caches the result keyed
 * weakly by agent, so a disposed agent's entry is collectable and a later
 * hook point does not restat.
 * @param opts.sessionConfigFile - the bridge's configured relative path, or `undefined` to disable discovery entirely.
 * @param opts.empty - the config value for "no session hooks" (missing file, unset `sessionConfigFile`, or no session cwd).
 * @param opts.parse - parse raw JSON (with the resolved session `cwd`) into the bridge's config shape plus its skipped-hook records.
 * @param opts.warnSkipped - report the parse's skipped-hook records (bridge-specific wording).
 * @param opts.warnFailure - report a non-ENOENT read/parse failure for one session's file.
 * @returns a lookup from agent (or `undefined` for a no-agent direct execution) to its discovered config.
 */
export function createSessionHookConfigCache<T, S>(opts: {
  sessionConfigFile: string | undefined
  empty: T
  parse: (raw: unknown, cwd: string) => { config: T; skipped: S[] }
  warnSkipped: (skipped: S[]) => void
  warnFailure: (path: string, agentId: string, error: unknown) => void
  /**
   * Trust gate: a project-local hook config is discovered and its commands run
   * ONLY for a workspace this returns `true` for. A workspace's `hooks.json`
   * runs arbitrary shell before any user action, so an untrusted (e.g. freshly
   * cloned) repo must not be able to plant one. Absent ⇒ no workspace is
   * trusted, so discovery contributes nothing even when `sessionConfigFile` is
   * set; the deployment opts a workspace in explicitly.
   */
  isWorkspaceTrusted?: (cwd: string) => boolean
  /** Warn (once per workspace) that an untrusted workspace's session hooks were skipped. */
  warnUntrusted: (cwd: string, agentId: string) => void
}): (agent: SessionWorkspace | undefined) => T {
  const cache = new WeakMap<SessionWorkspace, T>()
  return (agent: SessionWorkspace | undefined): T => {
    const file = opts.sessionConfigFile
    if (agent === undefined || file === undefined) return opts.empty
    const cached = cache.get(agent)
    if (cached !== undefined) return cached
    let discovered = opts.empty
    const cwd = agent.session.header.cwd
    if (cwd !== undefined && (opts.isWorkspaceTrusted === undefined || !opts.isWorkspaceTrusted(cwd))) {
      // Default-deny: never execute an untrusted workspace's planted hooks.
      opts.warnUntrusted(cwd, agent.id)
      cache.set(agent, discovered)
      return discovered
    }
    if (cwd !== undefined) {
      const path = resolve(cwd, file)
      try {
        const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
        const result = opts.parse(raw, cwd)
        discovered = result.config
        opts.warnSkipped(result.skipped)
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          opts.warnFailure(path, agent.id, error)
        }
      }
    }
    cache.set(agent, discovered)
    return discovered
  }
}

/**
 * Build the workspace-trust predicate a bridge passes to
 * {@link createSessionHookConfigCache}: a workspace `cwd` is trusted when it
 * equals, or is nested under, one of the deployment-configured trusted roots
 * (each resolved against the process launch cwd). No roots ⇒ trust nothing, so
 * project-local hook discovery runs no commands until the deployment vouches
 * for a workspace.
 * @param roots - configured trusted workspace roots (absolute or launch-cwd-relative), or undefined.
 * @param launchCwd - the process launch cwd the relative roots resolve against.
 * @returns a predicate over an agent session's absolute cwd, or undefined when no roots are configured.
 */
export function workspaceTrustPredicate(
  roots: readonly string[] | undefined,
  launchCwd: string,
): ((cwd: string) => boolean) | undefined {
  if (roots === undefined || roots.length === 0) return undefined
  const absoluteRoots = roots.map(root => resolve(launchCwd, root))
  return (cwd: string): boolean => {
    const target = resolve(cwd)
    return absoluteRoots.some((root) => {
      const rel = relative(root, target)
      if (rel === '') return true // target is the root itself
      if (rel.startsWith('..')) return false // target escapes upward, outside root
      /* v8 ignore next -- a non-'..' absolute rel means a different Windows drive; posix relative() never returns one */
      if (isAbsolute(rel)) return false
      return true // a relative descent: target is nested under root
    })
  }
}

/**
 * Combine one hook point's process-level and session-level matcher groups, in
 * that order — session groups run after process groups on each point.
 * @param processGroups - the point's groups from the process-level config.
 * @param sessionGroups - the point's groups from the current session's discovered config.
 * @returns the combined ordered groups.
 */
export function combineHookGroups<T>(processGroups: T[] | undefined, sessionGroups: T[] | undefined): T[] {
  return [...processGroups ?? [], ...sessionGroups ?? []]
}
