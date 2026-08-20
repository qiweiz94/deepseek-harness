/**
 * Assembled-app regression for subagent-router label routing: the default
 * candidates name only `fork`, the single route names only `spawn`, and the
 * replayed delegation matches the route — so the child's durable descriptor
 * naming `spawn` is physical proof the route (not the default list) chose the
 * provider.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeSessionLog, scrubRequestHeaders, type NormalizeContext } from '@deepseek-ai/dsh-acp-snapshot'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { describe, expect, it } from 'vitest'

const fixtureDir = fileURLToPath(new URL('./subagent-router-snapshots/label-route', import.meta.url))
const replayOverride = join(fixtureDir, 'replay.override.json')
const childReplay = join(fixtureDir, 'child.replay.jsonl')
const parentExpected = join(fixtureDir, 'parent.expected.jsonl')
const childExpected = join(fixtureDir, 'child.expected.jsonl')
const configPath = fileURLToPath(new URL('../subagent-router.cordis.snapshot.yml', import.meta.url))
const binScript = fileURLToPath(new URL('./fixtures/headless-driver.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'
const task = 'Delegate the trial probe.'

interface JsonObject {
  [key: string]: unknown
}

function parseJsonl(content: string): JsonObject[] {
  return content.trimEnd().split('\n').map(line => JSON.parse(line) as JsonObject)
}

describe('subagent-router label routing snapshot', () => {
  it('routes the matching delegation to the route provider through the assembled headless app', async () => {
    let cwd = ''
    const result = await runLoaderSmoke({
      label: 'subagent router headless stream-json snapshot',
      tempDirPrefix: 'dsh-subagent-router-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, task],
      tsconfigPath,
      env: {
        // The primary fixture path must exist for llm-replay's config guard;
        // the override sidecar fully replaces the derived parent script.
        DSH_SNAPSHOT_FILE: replayOverride,
        DSH_SNAPSHOT_OVERRIDE: replayOverride,
        DSH_SNAPSHOT_CHILD_FILES: childReplay,
      },
      prepare: (runCwd) => {
        cwd = runCwd
        return Promise.resolve()
      },
      inspect: async (runCwd) => {
        const sessionsDir = join(runCwd, '.sessions')
        const files = (await readdir(sessionsDir, { recursive: true })).filter(file => file.endsWith('.jsonl'))
        const logs = await Promise.all(files.map(async file => readFile(join(sessionsDir, file), 'utf8')))
        const headerOf = (content: string): JsonObject => parseJsonl(content)[0] ?? {}
        const parent = logs.find(content => headerOf(content).parentSession === undefined)
        const child = logs.find(content => typeof headerOf(content).parentSession === 'string')
        if (parent === undefined || child === undefined) throw new Error('missing persisted parent or child log')

        // THE routing fact: the child's durable descriptor names the route's
        // provider. The default candidate list (`fork`) cannot produce this.
        const descriptor = parseJsonl(child).find(record => record.type === 'subagent/descriptor')
        expect(descriptor).toBeDefined()
        expect(descriptor?.data).toMatchObject({
          provider: 'spawn',
          label: 'Route this trial probe',
        })

        const sessionIds = [parent, child]
          .map(content => headerOf(content).id)
          .flatMap(id => typeof id === 'string' ? [id] : [])
        const context: NormalizeContext = { sessionIds, cwd }
        const normalizedParent = scrubRequestHeaders(normalizeSessionLog(parent, context))
        const normalizedChild = scrubRequestHeaders(normalizeSessionLog(child, context))
        if (refreshing) {
          await writeFile(parentExpected, normalizedParent)
          await writeFile(childExpected, normalizedChild)
        }
        expect(normalizedParent).toBe(await readFile(parentExpected, 'utf8'))
        expect(normalizedChild).toBe(await readFile(childExpected, 'utf8'))
        expect(normalizedChild).toContain('CHILD_OK')
      },
    })

    expect(result.stderr).toBe('')
    const records = result.stdout.trimEnd().split('\n').map(line => JSON.parse(line) as JsonObject)
    expect(records.at(-1)).toMatchObject({
      type: 'result',
      output: 'Routed delegation complete. ROUTER_DONE',
    })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
