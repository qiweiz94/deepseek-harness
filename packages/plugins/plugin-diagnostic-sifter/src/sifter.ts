/**
 * Diagnostic sifting for `run_diagnostic_check`: run the repository's own
 * `tsc` or `vitest` binary through `ctx.subprocess`, capture both streams
 * inside the output-retention envelope, parse the raw diagnostics, collapse
 * cascading repeats onto the diagnostic that caused them, and bound the
 * surviving root causes to a compact JSON budget.
 *
 * The plugin owns only orchestration, parsing, and ranking; process spawning,
 * stream collection, and tree-scoped termination stay in the subprocess seam,
 * and byte-level retention stays in `@deepseek-ai/dsh-output-retention`.
 * @module @deepseek-ai/dsh-plugin-diagnostic-sifter/sifter
 */

import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import { TextRetainer, truncateCodePoints } from '@deepseek-ai/dsh-output-retention'
import type { Diagnostic, DiagnosticRun, DiagnosticStreams, SiftedDiagnostics } from './types.ts'

/**
 * TypeScript codes whose diagnostics fan out across every import site of one
 * unresolved module or missing export: the compiler repeats the same finding
 * per consumer, so the consumers are a cascade of the first one. They are
 * grouped by their quoted subject (the module specifier or member name)
 * rather than by exact message text, because the trailing "Did you mean" hint
 * varies per site while the cause does not.
 */
const CASCADE_CODES: ReadonlySet<string> = new Set([
  'TS2307', // Cannot find module 'x' or its corresponding type declarations.
  'TS2305', // Module 'x' has no exported member 'y'.
  'TS2503', // Cannot find namespace 'x'.
  'TS2614', // Module 'x' has no exported member 'y'. Did you mean to use 'import y from "x"'?
  'TS2688', // Cannot find type definition file for 'x'.
  'TS2724', // 'x' has no exported member named 'y'. Did you mean 'z'?
])

/** Successive message caps tried while shrinking a result into its byte budget. */
const MESSAGE_CAPS: readonly number[] = [200, 140, 96, 64, 40]

/** ESC as a string constant so the SGR pattern carries no literal control character. */
const ESC = '\u001B'

/** CSI escape sequences (colours, cursor moves) emitted by pretty reporters. */
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'gu')

/** `file(line,col): error TS####: message` — the plain `tsc` diagnostic line. */
const TS_PLAIN = /^(?<file>\S[^(]*)\((?<line>\d+),\d+\):\s+(?:error|warning)\s+(?<code>TS\d+):\s+(?<message>.+)$/

/** `file:line:col - error TS####: message` — the `tsc --pretty` diagnostic line. */
const TS_PRETTY = /^(?<file>\S.*?):(?<line>\d+):\d+\s+-\s+(?:error|warning)\s+(?<code>TS\d+):\s+(?<message>.+)$/

/** `error TS####: message` — a project-level diagnostic naming no file. */
const TS_GLOBAL = /^(?:error|warning)\s+(?<code>TS\d+):\s+(?<message>.+)$/

/** ` FAIL  path/to/file.spec.ts > suite > case` — one failed Vitest case. */
const VITEST_FAIL = /^\s*FAIL\s+(?<target>\S.*)$/

/**
 * A named-project prefix (` FAIL  |thread-safe| path/to/file.spec.ts > case`).
 * Vitest emits it for every failure once the config declares `projects`, so it
 * is part of the header, not part of the path.
 */
const VITEST_PROJECT_PREFIX = /^\|[^|]*\|\s*/

/** `AssertionError: expected 1 to be 2` — the error class opening a failure block. */
const VITEST_ERROR = /^\s*(?<code>[A-Z][A-Za-z0-9_$]*(?:Error|Exception))(?::\s*(?<message>.*))?$/

/** ` ❯ path/to/file.spec.ts:12:5` — one stack frame under a failure block. */
const VITEST_FRAME = /^\s*❯\s+(?<file>\S.*?):(?<line>\d+):\d+/

/** First single-quoted run in a diagnostic message: the cascade's subject. */
const QUOTED_SUBJECT = /'([^']+)'/

/** Mandatory capture groups of a located TypeScript diagnostic line. */
interface LocatedGroups { file: string; line: string; code: string; message: string }

/** Mandatory capture groups of a file-less TypeScript diagnostic line. */
interface GlobalGroups { code: string; message: string }

/** Capture groups of a Vitest failure header; `target` is mandatory. */
interface FailGroups { target: string }

/** Capture groups of a Vitest error line; the message half is optional. */
interface ErrorGroups { code: string; message?: string }

/** Mandatory capture groups of a Vitest stack frame. */
interface FrameGroups { file: string; line: string }

/**
 * Drop CSI escape sequences and carriage returns so the line patterns see the
 * same text whether the child decided it was writing to a TTY or a pipe.
 * @param raw - one captured stream.
 * @returns the stream's lines, without terminal control sequences.
 */
export function plainLines(raw: string): string[] {
  return raw.replace(ANSI_PATTERN, '').split('\n').map(line => line.replace(/\r$/, ''))
}

/**
 * Parse `tsc` output into diagnostics, keeping only each diagnostic's first
 * line: the indented related-information and source-excerpt lines that follow
 * restate the same finding and would blow the compact budget.
 * @param raw - the captured `tsc` stream.
 * @returns the diagnostics in emission order.
 */
export function parseTypeScriptDiagnostics(raw: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  for (const line of plainLines(raw)) {
    // Every named group in these patterns is mandatory, so a match always
    // populates all of them; the cast states that instead of adding
    // unreachable per-group fallbacks.
    const located = (TS_PLAIN.exec(line) ?? TS_PRETTY.exec(line))?.groups as LocatedGroups | undefined
    if (located !== undefined) {
      diagnostics.push({
        file: located.file,
        line: Number(located.line),
        code: located.code,
        message: located.message.trim(),
      })
      continue
    }
    const global = TS_GLOBAL.exec(line.trim())?.groups as GlobalGroups | undefined
    if (global === undefined) continue
    diagnostics.push({ file: '', line: 0, code: global.code, message: global.message.trim() })
  }
  return diagnostics
}

/** A frame inside `node_modules` or a `node:` builtin is runner plumbing, not the failure site. */
function isOwnFrame(file: string): boolean {
  return !file.startsWith('node:') && !file.includes('node_modules')
}

/**
 * Parse Vitest output into one diagnostic per failed case. Passing cases,
 * progress lines, diff blocks, and every stack frame after the first
 * repository-owned one are dropped: the failure's own frame is the only one
 * that locates the defect.
 * @param raw - the captured Vitest stream.
 * @returns one diagnostic per `FAIL` header, in emission order.
 */
export function parseVitestDiagnostics(raw: string): Diagnostic[] {
  const lines = plainLines(raw)
  const diagnostics: Diagnostic[] = []
  for (const [index, line] of lines.entries()) {
    const header = VITEST_FAIL.exec(line)?.groups as FailGroups | undefined
    if (header === undefined) continue
    const target = header.target.replace(VITEST_PROJECT_PREFIX, '')
    let code = 'test-failure'
    let message = target.trim()
    /* v8 ignore next -- String.split always yields at least one segment; the fallback answers the indexed-access type. */
    let file = (target.split(' > ')[0] ?? '').trim()
    let located = false
    for (const following of lines.slice(index + 1)) {
      if (VITEST_FAIL.test(following)) break
      const failure = VITEST_ERROR.exec(following)?.groups as ErrorGroups | undefined
      if (failure !== undefined && code === 'test-failure') {
        code = failure.code
        const detail = (failure.message ?? '').trim()
        if (detail !== '') message = detail
        continue
      }
      const frame = VITEST_FRAME.exec(following)?.groups as FrameGroups | undefined
      if (frame === undefined) continue
      const frameFile = frame.file.trim()
      if (!isOwnFrame(frameFile)) continue
      file = frameFile
      located = true
      diagnostics.push({ file, line: Number(frame.line), code, message })
      break
    }
    if (!located) diagnostics.push({ file, line: 0, code, message })
  }
  return diagnostics
}

/**
 * The key two diagnostics share when one is a cascade of the other: an exact
 * repeat of code and text, or — for the module-resolution and export-shape
 * codes — the same code reported against the same quoted subject.
 * @param diagnostic - the diagnostic to key.
 * @returns the cascade-grouping key.
 */
function cascadeKey(diagnostic: Diagnostic): string {
  if (CASCADE_CODES.has(diagnostic.code)) {
    const subject = QUOTED_SUBJECT.exec(diagnostic.message)?.[1]
    if (subject !== undefined) return `${diagnostic.code}|'${subject}'`
  }
  return `${diagnostic.code}|${diagnostic.message}`
}

/**
 * Collapse cascading repeats and keep the highest-ranked distinct diagnostics.
 * A group's size is how many sites the same cause reached, so the most
 * repeated group ranks first; ties keep emission order, which puts the
 * compiler's own first finding ahead of later ones.
 * @param diagnostics - every parsed diagnostic, in emission order.
 * @param maxRootCauses - how many distinct causes to report.
 * @returns the reported causes plus the count of diagnostics left out.
 */
export function siftDiagnostics(diagnostics: readonly Diagnostic[], maxRootCauses: number): SiftedDiagnostics {
  const groups = new Map<string, { first: Diagnostic; order: number; count: number }>()
  for (const diagnostic of diagnostics) {
    const key = cascadeKey(diagnostic)
    const existing = groups.get(key)
    if (existing === undefined) groups.set(key, { first: diagnostic, order: groups.size, count: 1 })
    else existing.count += 1
  }
  const rootCauses = [...groups.values()]
    .sort((left, right) => right.count - left.count || left.order - right.order)
    .slice(0, maxRootCauses)
    .map(group => group.first)
  return { rootCauses, suppressedCascadeCount: diagnostics.length - rootCauses.length }
}

/**
 * Shrink a sifted result until its JSON encoding fits `maxBytes`: first bound
 * the messages by code points, then drop the lowest-ranked cause. Dropped
 * causes move into `suppressedCascadeCount`, so the count always covers every
 * parsed diagnostic the caller does not see.
 * @param sifted - the ranked result to bound.
 * @param success - whether the command reported no failure.
 * @param maxBytes - the JSON byte budget for the whole value.
 * @returns a value whose JSON encoding is at most `maxBytes` bytes.
 */
export function fitBudget(sifted: SiftedDiagnostics, success: boolean, maxBytes: number): {
  success: boolean
  rootCauses: Diagnostic[]
  suppressedCascadeCount: number
} {
  const encoder = new TextEncoder()
  const total = sifted.rootCauses.length + sifted.suppressedCascadeCount
  for (let kept = sifted.rootCauses.length; kept > 0; kept--) {
    const causes = sifted.rootCauses.slice(0, kept)
    for (const cap of MESSAGE_CAPS) {
      const bounded = causes.map(cause => ({ ...cause, message: truncateCodePoints(cause.message, cap) }))
      const value = { success, rootCauses: bounded, suppressedCascadeCount: total - bounded.length }
      if (encoder.encode(JSON.stringify(value)).byteLength <= maxBytes) return value
    }
  }
  // Every cause was dropped: only a budget smaller than the empty envelope can
  // reach here, and the count still accounts for every parsed diagnostic.
  return { success, rootCauses: [], suppressedCascadeCount: total }
}

/**
 * Resolve a configured executable against the run's working directory. A bare
 * command name (`tsc`) stays bare so the child's PATH resolves it; a relative
 * path (`node_modules/.bin/tsc`) is anchored to `cwd`, because Node resolves a
 * relative executable against the PARENT's cwd, not the child's.
 * @param cwd - the run's working directory.
 * @param executable - the configured executable path or command name.
 * @returns the argv[0] to spawn.
 */
export function resolveExecutable(cwd: string, executable: string): string {
  if (isAbsolute(executable) || !executable.includes('/')) return executable
  return join(cwd, executable)
}

/**
 * Run one diagnostic command through the subprocess seam, retaining each
 * stream's head inside the output-retention envelope. A compiler or runner can
 * emit megabytes; only the envelope's worth is ever held in memory, and the
 * head is what carries the diagnostics.
 * @param ctx - the Cordis context carrying `ctx.subprocess`.
 * @param run - the fully-specified command, envelope, and cancellation.
 * @returns the exit status and both retained streams.
 */
export async function runDiagnostic(ctx: Context, run: DiagnosticRun): Promise<DiagnosticStreams> {
  const handle = ctx.subprocess.spawn({
    argv: run.argv,
    cwd: run.cwd,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    graceMs: 2_000,
    signal: run.signal,
  })
  const stdout = new TextRetainer({ kind: 'head', maxBytes: run.maxBytes })
  const stderr = new TextRetainer({ kind: 'head', maxBytes: run.maxBytes })
  const drain = async (reader: AsyncIterable<Buffer> | undefined, retainer: TextRetainer): Promise<void> => {
    /* v8 ignore next -- this spawn pipes both streams, so both readers exist; the guard answers the optional type. */
    if (reader === undefined) return
    for await (const chunk of reader) retainer.push(chunk)
  }
  const consumed = Promise.all([
    drain(handle.stdout as AsyncIterable<Buffer> | undefined, stdout),
    drain(handle.stderr as AsyncIterable<Buffer> | undefined, stderr),
  ])
  const outcome = await handle.done
  await consumed
  const retainedOut = stdout.finish()
  const retainedErr = stderr.finish()
  return {
    exitCode: outcome.exitCode,
    stdout: { text: retainedOut.text, truncated: retainedOut.truncated },
    stderr: { text: retainedErr.text, truncated: retainedErr.truncated },
  }
}
