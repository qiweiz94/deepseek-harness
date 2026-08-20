import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as tool from '../src/index.ts'
import {
  fitBudget,
  parseTypeScriptDiagnostics,
  parseVitestDiagnostics,
  plainLines,
  resolveExecutable,
  siftDiagnostics,
} from '../src/sifter.ts'
import type { Diagnostic, DiagnosticCheckResult } from '../src/types.ts'

const testToolSignal = new AbortController().signal
const roots: string[] = []

/** Narrow the registry's untyped result value to the sifter contract. */
function checkValue(result: { value?: unknown }): DiagnosticCheckResult {
  return result.value as DiagnosticCheckResult
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * A throwaway project root holding a fake `node_modules/.bin/<name>` executable.
 * Fixture diagnostic transcripts are replayed by a shell script rather than by
 * running a real compiler or runner, so the suite stays hermetic and fast while
 * still exercising the real spawn, retention, and parsing path.
 */
function fakeProject(name: string, script: string): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-diagnostic-sifter-'))
  roots.push(root)
  return addBinary(root, name, script)
}

/** Add one more fixture executable to an existing throwaway project root. */
function addBinary(root: string, name: string, script: string): string {
  const binDir = join(root, 'node_modules', '.bin')
  mkdirSync(binDir, { recursive: true })
  const path = join(binDir, name)
  writeFileSync(path, `#!/bin/sh\n${script}\n`)
  chmodSync(path, 0o755)
  return root
}

/** A heredoc-free emitter: print a fixture transcript, then exit with `code`. */
function emit(transcript: string, code: number): string {
  return `${transcript.split('\n').map(line => `printf '%s\\n' ${JSON.stringify(line)}`).join('\n')}\nexit ${code}`
}

/**
 * Mount the plugin through a wrapper so this package's Config schema never
 * runs: `apply` then sees the unfilled config a hand-written composition can
 * hand it, and the documented defaults have to come from the code itself.
 */
async function unvalidated(config: tool.Config): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin({
    name: 'unvalidated-diagnostic-sifter',
    inject: ['tools', 'subprocess'],
    apply: (inner: Context) => { tool.apply(inner, config) },
  })
  return ctx
}

async function setup(config: tool.Config): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(tool, config)
  return ctx
}

function callCheck(ctx: Context, args: unknown, name = 'run_diagnostic_check'): ReturnType<typeof ctx.tools.execute> {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`sifter-${Math.random().toString(16).slice(2)}`),
    name,
    arguments: args,
  })
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.length = 0
})

const TSC_CASCADE = [
  "src/a.ts(3,24): error TS2307: Cannot find module './missing.ts' or its corresponding type declarations.",
  "src/b.ts(1,24): error TS2307: Cannot find module './missing.ts' or its corresponding type declarations. Did you mean './missing.js'?",
  "src/c.ts(9,24): error TS2307: Cannot find module './missing.ts' or its corresponding type declarations.",
  "src/d.ts(2,10): error TS2724: '\"./api.ts\"' has no exported member named 'runCheck'. Did you mean 'runChecks'?",
  "src/e.ts(4,10): error TS2724: '\"./api.ts\"' has no exported member named 'runCheck'. Did you mean 'runChecks'?",
  'src/f.ts(12,5): error TS2322: Type \'number\' is not assignable to type \'string\'.',
].join('\n')

const VITEST_FAILURES = [
  ' ✓ tests/pass.spec.ts > adds numbers 2ms',
  ' ✓ tests/pass.spec.ts > keeps order 1ms',
  '',
  '⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯',
  '',
  ' FAIL  tests/sum.spec.ts > sum > adds two numbers',
  'AssertionError: expected 3 to be 4 // Object.is equality',
  '- Expected',
  '+ Received',
  ' ❯ node_modules/chai/index.js:100:12',
  ' ❯ tests/sum.spec.ts:12:20',
  ' ❯ node:internal/process:5:1',
  '',
  ' FAIL  tests/load.spec.ts > loads config',
  'TypeError: Cannot read properties of undefined (reading \'name\')',
  ' ❯ node:internal/modules/run:3:9',
  '',
  ' Test Files  2 failed | 1 passed (3)',
].join('\n')

describe('TypeScript diagnostic parsing', () => {
  it('parses plain, pretty, and file-less diagnostic lines and ignores everything else', () => {
    const parsed = parseTypeScriptDiagnostics([
      'src/a.ts(3,24): error TS2307: Cannot find module \'./x.ts\'.',
      'src/b.ts:9:4 - error TS2322: Type \'number\' is not assignable to type \'string\'.',
      'error TS5083: Cannot read file \'tsconfig.json\'.',
      '',
      'Found 3 errors.',
      '   ~~~~~~~~~~',
    ].join('\n'))
    expect(parsed).toEqual([
      { file: 'src/a.ts', line: 3, code: 'TS2307', message: 'Cannot find module \'./x.ts\'.' },
      { file: 'src/b.ts', line: 9, code: 'TS2322', message: 'Type \'number\' is not assignable to type \'string\'.' },
      { file: '', line: 0, code: 'TS5083', message: 'Cannot read file \'tsconfig.json\'.' },
    ])
  })

  it('strips terminal colouring and carriage returns before matching', () => {
    const coloured = '[96msrc/a.ts[0m(3,24): [91merror[0m TS2307: Cannot find module \'./x.ts\'.\r'
    expect(plainLines('a\r\nb')).toEqual(['a', 'b'])
    expect(parseTypeScriptDiagnostics(coloured)).toEqual([
      { file: 'src/a.ts', line: 3, code: 'TS2307', message: 'Cannot find module \'./x.ts\'.' },
    ])
  })
})

describe('Vitest failure parsing', () => {
  it('keeps one diagnostic per failure with its first repository-owned frame', () => {
    expect(parseVitestDiagnostics(VITEST_FAILURES)).toEqual([
      { file: 'tests/sum.spec.ts', line: 12, code: 'AssertionError', message: 'expected 3 to be 4 // Object.is equality' },
      { file: 'tests/load.spec.ts', line: 0, code: 'TypeError', message: 'Cannot read properties of undefined (reading \'name\')' },
    ])
  })

  it('keeps the header as the message when the error line carries no detail, and ignores later error lines', () => {
    const parsed = parseVitestDiagnostics([
      ' FAIL  tests/boom.spec.ts > explodes',
      'RangeError',
      'AssertionError: a later error line inside the same block',
      ' ❯ tests/boom.spec.ts:4:1',
    ].join('\n'))
    expect(parsed).toEqual([
      { file: 'tests/boom.spec.ts', line: 4, code: 'RangeError', message: 'tests/boom.spec.ts > explodes' },
    ])
  })

  it('falls back to the header path when a failure block names no test case or frame', () => {
    expect(parseVitestDiagnostics(' FAIL  tests/only.spec.ts')).toEqual([
      { file: 'tests/only.spec.ts', line: 0, code: 'test-failure', message: 'tests/only.spec.ts' },
    ])
  })

  it('drops the named-project prefix a projects config puts in front of the path', () => {
    // Verbatim from this repository's own reporter, whose config declares projects.
    expect(parseVitestDiagnostics(
      ' FAIL  |thread-safe| packages/plugins/plugin-diagnostic-sifter/tests/sifter.spec.ts > run_diagnostic_check > registers',
    )).toEqual([{
      file: 'packages/plugins/plugin-diagnostic-sifter/tests/sifter.spec.ts',
      line: 0,
      code: 'test-failure',
      message: 'packages/plugins/plugin-diagnostic-sifter/tests/sifter.spec.ts > run_diagnostic_check > registers',
    }])
  })

  it('ends a frameless failure block at the next failure header', () => {
    expect(parseVitestDiagnostics([
      ' FAIL  tests/first.spec.ts > one',
      ' FAIL  tests/second.spec.ts > two',
      'RangeError: out of range',
      ' ❯ tests/second.spec.ts:8:3',
    ].join('\n'))).toEqual([
      { file: 'tests/first.spec.ts', line: 0, code: 'test-failure', message: 'tests/first.spec.ts > one' },
      { file: 'tests/second.spec.ts', line: 8, code: 'RangeError', message: 'out of range' },
    ])
  })
})

describe('cascade sifting', () => {
  it('collapses repeats of one cause and ranks the widest cascade first', () => {
    const sifted = siftDiagnostics(parseTypeScriptDiagnostics(TSC_CASCADE), 3)
    expect(sifted.rootCauses.map(cause => [cause.code, cause.file])).toEqual([
      ['TS2307', 'src/a.ts'],
      ['TS2724', 'src/d.ts'],
      ['TS2322', 'src/f.ts'],
    ])
    expect(sifted.suppressedCascadeCount).toBe(3)
  })

  it('caps the reported causes and counts every diagnostic left out', () => {
    const sifted = siftDiagnostics(parseTypeScriptDiagnostics(TSC_CASCADE), 1)
    expect(sifted.rootCauses).toHaveLength(1)
    expect(sifted.suppressedCascadeCount).toBe(5)
  })

  it('groups a cascade code with no quoted subject by its exact text', () => {
    const diagnostics: Diagnostic[] = [
      { file: 'a.ts', line: 1, code: 'TS2307', message: 'Cannot find a module.' },
      { file: 'b.ts', line: 2, code: 'TS2307', message: 'Cannot find a module.' },
      { file: 'c.ts', line: 3, code: 'TS2307', message: 'Cannot find another module.' },
    ]
    const sifted = siftDiagnostics(diagnostics, 3)
    expect(sifted.rootCauses.map(cause => cause.file)).toEqual(['a.ts', 'c.ts'])
    expect(sifted.suppressedCascadeCount).toBe(1)
  })
})

describe('result budget', () => {
  const long = (marker: string): Diagnostic => ({ file: `${marker}.ts`, line: 1, code: 'TS2322', message: marker.repeat(300) })

  it('keeps full messages when the whole value already fits', () => {
    const value = fitBudget({ rootCauses: [long('a')], suppressedCascadeCount: 0 }, false, 1_000)
    expect(value.rootCauses[0]?.message).toHaveLength(200)
    expect(value.suppressedCascadeCount).toBe(0)
  })

  it('drops the lowest-ranked cause into the count when truncation is not enough', () => {
    const sifted = { rootCauses: [long('a'), long('b'), long('c')], suppressedCascadeCount: 4 }
    const value = fitBudget(sifted, false, 200)
    expect(value.rootCauses.length).toBeLessThan(3)
    expect(value.rootCauses.length + value.suppressedCascadeCount).toBe(7)
  })

  it('reports every diagnostic as suppressed when even one cause cannot fit', () => {
    const value = fitBudget({ rootCauses: [long('a')], suppressedCascadeCount: 2 }, false, 1)
    expect(value).toEqual({ success: false, rootCauses: [], suppressedCascadeCount: 3 })
  })
})

describe('executable resolution', () => {
  it('anchors a relative path to the run root and leaves absolute paths and bare names alone', () => {
    expect(resolveExecutable('/repo', 'node_modules/.bin/tsc')).toBe(join('/repo', 'node_modules/.bin/tsc'))
    expect(resolveExecutable('/repo', '/usr/bin/tsc')).toBe('/usr/bin/tsc')
    expect(resolveExecutable('/repo', 'tsc')).toBe('tsc')
  })
})

describe('run_diagnostic_check', () => {
  it('registers a model-facing tool exposing command + targetPath', async () => {
    const root = fakeProject('tsc', 'exit 0')
    const ctx = await setup({ cwd: root })
    const schema = ctx.tools.schemas().find(entry => entry.name === 'run_diagnostic_check')
    expect(schema).toBeDefined()
    const props = (schema?.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual(['command', 'targetPath'])
    await ctx.fiber.dispose()
  })

  it('removes its registration when the fiber is disposed', async () => {
    const root = fakeProject('tsc', 'exit 0')
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const fiber = await ctx.plugin(tool, { cwd: root })
    expect(ctx.tools.schemas().some(entry => entry.name === 'run_diagnostic_check')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(entry => entry.name === 'run_diagnostic_check')).toBe(false)
    await ctx.fiber.dispose()
  })

  it('returns collapsed root causes for a cascading typecheck failure', async () => {
    const root = fakeProject('tsc', emit(TSC_CASCADE, 2))
    const ctx = await setup({ cwd: root })
    const result = await callCheck(ctx, { command: 'typecheck' })
    expect(result.isError).toBe(false)
    const value = checkValue(result)
    expect(value.success).toBe(false)
    expect(value.rootCauses.map(cause => cause.code)).toEqual(['TS2307', 'TS2724', 'TS2322'])
    expect(value.suppressedCascadeCount).toBe(3)
    expect(JSON.stringify(value).length).toBeLessThanOrEqual(1_000)
    expect(text(result)).toContain('typecheck failed with 3 root causes')
    expect(text(result)).toContain('3 further diagnostics suppressed')
    await ctx.fiber.dispose()
  })

  it('returns failing tests only, with the passing transcript dropped', async () => {
    const root = fakeProject('vitest', emit(VITEST_FAILURES, 1))
    const ctx = await setup({ cwd: root })
    const result = await callCheck(ctx, { command: 'test' })
    expect(result.isError).toBe(false)
    const value = checkValue(result)
    expect(value.rootCauses.map(cause => cause.code)).toEqual(['AssertionError', 'TypeError'])
    expect(value.suppressedCascadeCount).toBe(0)
    expect(text(result)).toContain('test failed with 2 root causes')
    expect(text(result)).not.toContain('suppressed')
    await ctx.fiber.dispose()
  })

  it('reports success and passes targetPath through as its own argv entry', async () => {
    const root = fakeProject('tsc', 'printf \'%s\\n\' "$@" > "$(dirname "$0")/../../argv.txt"\nexit 0')
    const ctx = await setup({ cwd: root })
    const result = await callCheck(ctx, { command: 'typecheck', targetPath: 'packages/core/tools' })
    expect(result.isError).toBe(false)
    expect(checkValue(result)).toEqual({ success: true, rootCauses: [], suppressedCascadeCount: 0 })
    expect(readFileSync(join(root, 'argv.txt'), 'utf8')).toBe('-b\npackages/core/tools\n')
    expect(text(result)).toBe('typecheck passed')
    await ctx.fiber.dispose()
  })

  it('reports a single suppressed diagnostic in the singular', async () => {
    const root = fakeProject('tsc', emit([
      'src/a.ts(1,1): error TS2307: Cannot find module \'./x.ts\'.',
      'src/b.ts(2,1): error TS2307: Cannot find module \'./x.ts\'.',
    ].join('\n'), 2))
    const ctx = await setup({ cwd: root })
    const result = await callCheck(ctx, { command: 'typecheck' })
    expect(text(result)).toContain('typecheck failed with 1 root cause;')
    expect(text(result)).toContain('1 further diagnostic suppressed')
    await ctx.fiber.dispose()
  })

  it('turns an unparseable non-zero exit into one reported cause', async () => {
    const root = fakeProject('vitest', 'echo "Error: Cannot find configuration file" >&2\nexit 1')
    const ctx = await setup({ cwd: root })
    const result = await callCheck(ctx, { command: 'test' })
    const value = checkValue(result)
    expect(value.success).toBe(false)
    expect(value.rootCauses).toEqual([
      { file: '', line: 0, code: 'nonzero-exit', message: 'exit 1: Error: Cannot find configuration file' },
    ])
    await ctx.fiber.dispose()
  })

  it('names the signal when the timeout kills a silent check', async () => {
    const root = fakeProject('tsc', 'sleep 30')
    const ctx = await setup({ cwd: root, timeoutMs: 100 })
    const result = await callCheck(ctx, { command: 'typecheck' })
    const value = checkValue(result)
    expect(value.rootCauses).toEqual([
      { file: '', line: 0, code: 'nonzero-exit', message: 'the check ended with a signal and produced no output' },
    ])
    await ctx.fiber.dispose()
  }, 15_000)

  it('honours a custom tool name and the configured test executable', async () => {
    const root = fakeProject('runner', emit(' FAIL  tests/x.spec.ts > case', 1))
    const ctx = await setup({
      cwd: root,
      toolName: 'check_diagnostics',
      testExecutable: 'node_modules/.bin/runner',
      testArgs: ['--run'],
      maxRootCauses: 1,
    })
    const result = await callCheck(ctx, { command: 'test' }, 'check_diagnostics')
    expect(result.isError).toBe(false)
    expect(checkValue(result).rootCauses).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('applies every documented default when the validated Config filled none in', async () => {
    const root = fakeProject('tsc', emit('src/a.ts(1,1): error TS2322: Type mismatch.', 2))
    addBinary(root, 'vitest', emit(' FAIL  tests/x.spec.ts > case', 1))
    const ctx = await unvalidated({ cwd: root })
    const typecheck = await callCheck(ctx, { command: 'typecheck' })
    expect(checkValue(typecheck).rootCauses).toEqual([
      { file: 'src/a.ts', line: 1, code: 'TS2322', message: 'Type mismatch.' },
    ])
    const test = await callCheck(ctx, { command: 'test' })
    expect(checkValue(test).rootCauses).toEqual([
      { file: 'tests/x.spec.ts', line: 0, code: 'test-failure', message: 'tests/x.spec.ts > case' },
    ])
    await ctx.fiber.dispose()
  })

  it('runs in the process working directory when no repository root is configured', async () => {
    const root = fakeProject('tsc', emit('src/a.ts(1,1): error TS2322: Type mismatch.', 2))
    const ctx = await unvalidated({ typecheckExecutable: join(root, 'node_modules', '.bin', 'tsc') })
    const result = await callCheck(ctx, { command: 'typecheck' })
    expect(checkValue(result).rootCauses).toHaveLength(1)
    await ctx.fiber.dispose()
  })
})

describe('call presentation', () => {
  it('titles each command and follows along only when a path is named', async () => {
    const root = fakeProject('tsc', 'exit 0')
    const ctx = await setup({ cwd: root })
    const registered = ctx.tools.schemas().find(entry => entry.name === 'run_diagnostic_check')
    expect(registered).toBeDefined()
    const definition = ctx.tools.get('run_diagnostic_check')
    expect(definition?.presentCall?.({ command: 'typecheck', targetPath: 'src/a.ts' })).toEqual({
      card: 'generic',
      title: 'Typecheck',
      kind: 'execute',
      rawInput: 'src/a.ts',
      locations: [{ path: 'src/a.ts' }],
    })
    expect(definition?.presentCall?.({ command: 'test' })).toEqual({
      card: 'generic',
      title: 'Run tests',
      kind: 'execute',
      rawInput: '',
    })
    // Sibling checks share `cwd` and its incremental state, so the tool keeps
    // the registry's exclusive default rather than declaring itself parallel.
    expect(definition?.isConcurrencySafe).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('carries the structured value as replayable presentation metadata', async () => {
    const root = fakeProject('tsc', emit('src/a.ts(1,1): error TS2322: Type mismatch.', 2))
    const ctx = await setup({ cwd: root })
    const result = await callCheck(ctx, { command: 'typecheck' })
    expect(result.meta).toEqual({ diagnostics: checkValue(result) })
    await ctx.fiber.dispose()
  })
})
