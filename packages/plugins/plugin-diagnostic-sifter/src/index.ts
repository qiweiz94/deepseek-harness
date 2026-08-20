/**
 * `run_diagnostic_check` tool: run the repository's own typecheck or test
 * binary and hand the model only the diagnostics that explain the failure.
 * A failing build emits one diagnostic per affected site and a failing test
 * run emits an entire passing-suite transcript; both bury the cause. This tool
 * collapses the cascade onto the diagnostic that caused it, drops passing-test
 * output and redundant stack frames, and returns a compact JSON result.
 * Named exports preserve loader injection metadata.
 * @module @deepseek-ai/dsh-plugin-diagnostic-sifter
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import {
  fitBudget,
  parseTypeScriptDiagnostics,
  parseVitestDiagnostics,
  resolveExecutable,
  runDiagnostic,
  siftDiagnostics,
} from './sifter.ts'
import type { Diagnostic, DiagnosticCheckResult, DiagnosticCommand } from './types.ts'

export const name = 'plugin-diagnostic-sifter'
export const inject = ['tools', 'subprocess']

/** Runtime configuration for the diagnostic sifter tool. */
export interface Config {
  /** Repository root the checks run in; defaults to the process cwd. */
  cwd?: string
  /** Typecheck executable; a relative path is anchored to `cwd`. Defaults to `node_modules/.bin/tsc`. */
  typecheckExecutable?: string
  /** Arguments passed to the typecheck executable; defaults to `['-b']`. */
  typecheckArgs?: string[]
  /** Test executable; a relative path is anchored to `cwd`. Defaults to `node_modules/.bin/vitest`. */
  testExecutable?: string
  /** Arguments passed to the test executable; defaults to `['run']`. */
  testArgs?: string[]
  /** Per-stream output-retention envelope in bytes; defaults to 15_000 (15 KB). */
  maxOutputBytes?: number
  /** Byte budget for the returned JSON value; defaults to 1_000 (under 1 KB). */
  maxResultBytes?: number
  /** How many distinct root causes to report; defaults to 3. */
  maxRootCauses?: number
  /** Per-check timeout in milliseconds; defaults to 300_000 (5 minutes). */
  timeoutMs?: number
  /** Model-facing tool name; defaults to `run_diagnostic_check`. */
  toolName?: string
}

/** Runtime configuration schema for the diagnostic sifter tool. */
export const Config: z<Config> = z.object({
  cwd: z.string().default(process.cwd()),
  typecheckExecutable: z.string().default('node_modules/.bin/tsc'),
  typecheckArgs: z.array(z.string()).default(['-b']),
  testExecutable: z.string().default('node_modules/.bin/vitest'),
  testArgs: z.array(z.string()).default(['run']),
  maxOutputBytes: z.number().step(1).min(1).default(15_000),
  maxResultBytes: z.number().step(1).min(1).default(1_000),
  maxRootCauses: z.number().step(1).min(1).default(3),
  timeoutMs: z.number().step(1).min(1).default(300_000),
  toolName: z.string().default('run_diagnostic_check'),
})

/** Render the compact result as model-facing text: the verdict, then one line per cause. */
function renderResult(command: DiagnosticCommand, result: DiagnosticCheckResult): string {
  const verdict = result.success
    ? `${command} passed`
    : `${command} failed with ${result.rootCauses.length} root cause${result.rootCauses.length === 1 ? '' : 's'}`
  const suppressed = result.suppressedCascadeCount > 0
    ? `; ${result.suppressedCascadeCount} further diagnostic${result.suppressedCascadeCount === 1 ? '' : 's'} suppressed as cascades or lower-ranked`
    : ''
  const causes = result.rootCauses.map(cause => `${cause.file}:${cause.line} ${cause.code}: ${cause.message}`)
  return [`${verdict}${suppressed}`, ...causes].join('\n')
}

/**
 * Build the argv for one check. The executable and its arguments are config,
 * not model input; `targetPath` is the only model-supplied argument and is
 * always passed as its own argv entry, never shell-interpreted.
 * @param config - the validated plugin configuration.
 * @param command - which check the model asked for.
 * @param cwd - the resolved repository root.
 * @param targetPath - optional path narrowing the check.
 * @returns the argv to spawn.
 */
function buildArgv(config: Config, command: DiagnosticCommand, cwd: string, targetPath?: string): string[] {
  const executable = command === 'typecheck'
    ? config.typecheckExecutable ?? 'node_modules/.bin/tsc'
    : config.testExecutable ?? 'node_modules/.bin/vitest'
  const args = command === 'typecheck' ? config.typecheckArgs ?? ['-b'] : config.testArgs ?? ['run']
  return [
    resolveExecutable(cwd, executable),
    ...args,
    ...targetPath === undefined || targetPath === '' ? [] : [targetPath],
  ]
}

/**
 * Register the diagnostic sifter tool on `ctx.tools`.
 * @param ctx - Cordis context carrying the tool registry and subprocess service.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const toolName = config.toolName ?? 'run_diagnostic_check'
  ctx.tools.register(defineTool({
    name: toolName,
    description: 'Run the project\'s TypeScript build or test suite and return only the diagnostics that explain the '
      + 'failure. Repeated errors caused by one defect (a missing module reported at every import site, a renamed '
      + 'export reported at every use) are collapsed onto the single diagnostic that caused them, passing-test output '
      + 'and stack frames outside the project are dropped, and at most a handful of root causes come back. Use it '
      + 'instead of reading a full compiler or test transcript; fix the reported causes first, then run it again.',
    parameters: {
      command: {
        type: 'string',
        required: true,
        enum: ['typecheck', 'test'],
        description: 'Which check to run: `typecheck` builds the TypeScript projects, `test` runs the test suite.',
      },
      targetPath: {
        type: 'string',
        description: 'Optional repo-relative path narrowing the check to one project or test file. Omit to check everything.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean', required: true, description: 'True when the check reported no failure.' },
          rootCauses: {
            type: 'array',
            required: true,
            description: 'The distinct diagnostics that explain the failure, most-repeated first.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                file: { type: 'string', required: true, description: 'The reported path; empty when the diagnostic names no file.' },
                line: { type: 'integer', required: true, description: '1-based line, or 0 when the diagnostic names no location.' },
                code: { type: 'string', required: true, description: 'The diagnostic code: a TypeScript `TS####`, a runner error class, or `nonzero-exit`.' },
                message: { type: 'string', required: true, description: 'The diagnostic text, bounded to fit the result budget.' },
              },
            },
          },
          suppressedCascadeCount: {
            type: 'integer',
            required: true,
            description: 'Diagnostics not listed: cascade repeats collapsed into a reported cause, plus causes ranked below the cap.',
          },
        },
      },
      render: (args, value) => [{ type: 'text', text: renderResult(args.command, value) }],
      presentationMeta: (_args, value) => ({ diagnostics: value }),
    },
    // Each call spawns its own child process tree and mutates no repository
    // state, so sibling checks cannot corrupt one another.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const cwd = config.cwd ?? process.cwd()
      const controller = new AbortController()
      const timer = setTimeout(() => { controller.abort() }, config.timeoutMs ?? 300_000)
      try {
        const streams = await runDiagnostic(ctx, {
          argv: buildArgv(config, args.command, cwd, args.targetPath),
          cwd,
          maxBytes: config.maxOutputBytes ?? 15_000,
          signal: AbortSignal.any([exec.signal, controller.signal]),
        })
        const raw = `${streams.stdout.text}\n${streams.stderr.text}`
        const parsed: Diagnostic[] = args.command === 'typecheck'
          ? parseTypeScriptDiagnostics(raw)
          : parseVitestDiagnostics(raw)
        // A non-zero exit the parsers cannot explain still has to reach the
        // model as a failure, so the exit itself becomes the reported cause.
        const diagnostics = parsed.length > 0 || streams.exitCode === 0
          ? parsed
          : [{ file: '', line: 0, code: 'nonzero-exit', message: firstMeaningfulLine(streams.stderr.text, streams.stdout.text, streams.exitCode) }]
        const sifted = siftDiagnostics(diagnostics, config.maxRootCauses ?? 3)
        return fitBudget(sifted, streams.exitCode === 0 && diagnostics.length === 0, config.maxResultBytes ?? 1_000)
      } finally {
        clearTimeout(timer)
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: args.command === 'typecheck' ? 'Typecheck' : 'Run tests',
      kind: 'execute',
      rawInput: args.targetPath ?? '',
      ...args.targetPath === undefined || args.targetPath === '' ? {} : { locations: [{ path: args.targetPath }] },
    }),
  }))
}

/**
 * The first non-blank line of a failed run's output, used when no diagnostic
 * pattern matched but the command still failed.
 * @param stderr - the retained stderr text.
 * @param stdout - the retained stdout text.
 * @param exitCode - the command's exit code; null when a signal killed it.
 * @returns a one-line explanation naming the exit status.
 */
function firstMeaningfulLine(stderr: string, stdout: string, exitCode: number | null): string {
  const line = [...stderr.split('\n'), ...stdout.split('\n')].map(entry => entry.trim()).find(entry => entry !== '')
  const status = exitCode === null ? 'a signal' : `exit ${exitCode}`
  return line === undefined ? `the check ended with ${status} and produced no output` : `${status}: ${line}`
}

export type * from './types.ts'
