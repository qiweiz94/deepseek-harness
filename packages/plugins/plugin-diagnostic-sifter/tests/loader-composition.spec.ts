// Proves the plugin survives a REAL Loader composition: a cordis.yml booted
// through the Loader mounts the namespace plugin (name/inject/apply) against a
// real subprocess provider, and the registered run_diagnostic_check tool is
// callable end to end against a project whose check binary is a fixture script.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as PluginDiagnosticSifter from '@deepseek-ai/dsh-plugin-diagnostic-sifter'
import type { DiagnosticCheckResult } from '../src/types.ts'

let root: string | undefined
let context: Context | undefined
const projects: string[] = []

/** Narrow the registry's untyped result value to the sifter contract. */
function checkValue(result: { value?: unknown }): DiagnosticCheckResult {
  return result.value as DiagnosticCheckResult
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** A throwaway project whose `node_modules/.bin/tsc` replays a fixture transcript. */
async function fakeProject(): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), 'dsh-sifter-loader-project-'))
  projects.push(project)
  const binDir = join(project, 'node_modules', '.bin')
  mkdirSync(binDir, { recursive: true })
  const binary = join(binDir, 'tsc')
  writeFileSync(binary, [
    '#!/bin/sh',
    "printf '%s\\n' \"src/a.ts(3,24): error TS2307: Cannot find module './missing.ts' or its corresponding type declarations.\"",
    "printf '%s\\n' \"src/b.ts(9,24): error TS2307: Cannot find module './missing.ts' or its corresponding type declarations.\"",
    'exit 2',
    '',
  ].join('\n'))
  chmodSync(binary, 0o755)
  return project
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  for (const project of projects) await rm(project, { recursive: true, force: true })
  projects.length = 0
})

async function boot(pluginEntry: string): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-diagnostic-sifter-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-subprocess-local'",
    pluginEntry,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
    ['@deepseek-ai/dsh-plugin-diagnostic-sifter', PluginDiagnosticSifter],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('plugin-diagnostic-sifter real Loader composition through cordis.yml', () => {
  it('runs the composed check and returns the collapsed root cause', async () => {
    const project = await fakeProject()
    const ctx = await boot(`- name: '@deepseek-ai/dsh-plugin-diagnostic-sifter'\n  config:\n    cwd: ${project}`)

    const schema = ctx.tools.schemas().find(entry => entry.name === 'run_diagnostic_check')
    expect(schema).toBeDefined()

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('composed-sifter'),
      name: 'run_diagnostic_check',
      arguments: { command: 'typecheck' },
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected a diagnostic result')
    expect(checkValue(result).success).toBe(false)
    expect(checkValue(result).rootCauses).toEqual([
      { file: 'src/a.ts', line: 3, code: 'TS2307', message: 'Cannot find module \'./missing.ts\' or its corresponding type declarations.' },
    ])
    expect(checkValue(result).suppressedCascadeCount).toBe(1)
    expect(text(result)).toContain('typecheck failed with 1 root cause')
  }, 30_000)

  it('fails loud at load when maxResultBytes is not positive', async () => {
    const project = await fakeProject()
    await expect(boot(
      `- name: '@deepseek-ai/dsh-plugin-diagnostic-sifter'\n  config:\n    cwd: ${project}\n    maxResultBytes: 0`,
    )).rejects.toThrow(/maxResultBytes/)
  }, 30_000)
})
