/**
 * Keyless snapshots for the ast-context tools through the headless-agent
 * composition: records one live get_file_outline turn and one live
 * get_directory_outline turn through the OpenCode pi-ai route
 * (ast-context.cordis.yml), then replays the harvested sessions with
 * llm-replay (ast-context.cordis.snapshot.yml).
 */

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  normalizeSessionLog,
  normalizeStdout,
  refreshFixtureReplacements,
  scrubRequestHeaders,
  stabilizeRefreshLog,
  tokenizeSessionFixtureCwd,
  type HarvestedLog,
  type NormalizeContext,
} from '@deepseek-ai/dsh-acp-snapshot'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import {
  decompressZstdFrame,
  scanZstdFrames,
} from '@deepseek-ai/dsh-session-persistence-jsonl/src/zstd.ts'
import { describe, expect, it } from 'vitest'

const snapshotsDir = join(dirname(fileURLToPath(import.meta.url)), 'snapshots')
const configPath = fileURLToPath(new URL('../ast-context.cordis.snapshot.yml', import.meta.url))
const binScript = fileURLToPath(new URL('./fixtures/headless-driver.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'

interface JsonObject {
  [key: string]: unknown
}

interface PersistedLog {
  readonly content: string
  readonly header: JsonObject
}

function parseJsonl(content: string): JsonObject[] {
  return content.split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as JsonObject)
}

function contextFromLogs(contents: readonly string[]): NormalizeContext {
  const headers = contents.map(content => parseJsonl(content)[0])
  return {
    sessionIds: headers.flatMap(header => typeof header?.id === 'string' ? [header.id] : []),
    cwd: typeof headers[0]?.cwd === 'string' ? headers[0].cwd : '\0no-cwd\0',
  }
}

function normalizeHeadlessStream(rawStdout: string, cwd: string): string {
  const records = parseJsonl(rawStdout)
  if (records.length === 0) throw new Error('headless snapshot emitted no stream-json records')
  const final = records.at(-1)
  if (final?.type !== 'result') throw new Error('headless snapshot did not end with a result record')
  if (records.slice(0, -1).some(record => record.type !== 'session_event')) {
    throw new Error('headless snapshot emitted a non-event record before its result')
  }

  const sessionIds = [...new Set(records.flatMap(record => typeof record.sessionId === 'string' ? [record.sessionId] : []))]
  if (sessionIds.length !== 1) throw new Error(`headless snapshot streamed ${sessionIds.length} main session ids`)
  const context: NormalizeContext = { sessionIds, cwd }
  const events = records.slice(0, -1).map((record) => {
    if (record.event === null || typeof record.event !== 'object' || Array.isArray(record.event)) {
      throw new Error('headless snapshot emitted an invalid session event')
    }
    return record.event as JsonObject
  })
  const normalizedEvents = parseJsonl(scrubRequestHeaders(normalizeSessionLog(
    `${events.map(event => JSON.stringify(event)).join('\n')}\n`,
    context,
  )))
  const normalizedRecords = records.map((record, index) => index < normalizedEvents.length
    ? { ...record, event: normalizedEvents[index] }
    : record)
  return normalizeStdout(`${normalizedRecords.map(record => JSON.stringify(record)).join('\n')}\n`, context)
}

async function scenarioPrompt(scenarioDir: string): Promise<string> {
  const input = JSON.parse(await readFile(join(scenarioDir, 'input.json'), 'utf8')) as {
    steps?: { op?: unknown; text?: unknown }[]
  }
  const prompt = input.steps?.find(step => step.op === 'prompt')?.text
  if (typeof prompt !== 'string') throw new Error('ast-context input has no prompt step')
  return prompt
}

async function readPersistedLog(file: string): Promise<string> {
  const content = await readFile(file)
  if (!file.endsWith('.zstd')) return content.toString('utf8')
  const scan = scanZstdFrames(content)
  if (scan.tornStart !== undefined) throw new Error(`persisted snapshot log has a torn Zstandard frame: ${file}`)
  const decoded: Buffer[] = []
  for (const frame of scan.frames) {
    decoded.push(await decompressZstdFrame(content.subarray(frame.start, frame.end)))
  }
  return Buffer.concat(decoded).toString('utf8')
}

async function persistedLogs(cwd: string, root: string = join(cwd, '.sessions')): Promise<PersistedLog[]> {
  const files = (await readdir(root, { recursive: true }))
    .filter(file => file.endsWith('.jsonl') || file.endsWith('.jsonl.zstd'))
  return Promise.all(files.map(async (file) => {
    const content = await readPersistedLog(join(root, file))
    return { content, header: parseJsonl(content)[0] ?? {} }
  }))
}

describe('headless ast-context snapshot', () => {
  it('replays one get_file_outline turn through the one-shot app', async () => {
    await replayScenario('ast-context', 'get_file_outline')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('replays one get_directory_outline turn through the one-shot app', async () => {
    await replayScenario('ast-context-dir', 'get_directory_outline')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})

async function replayScenario(scenarioName: string, toolName: string): Promise<void> {
  const scenarioDir = join(snapshotsDir, scenarioName)
  const sessionFixture = join(scenarioDir, 'session.jsonl')
  const streamExpected = join(scenarioDir, 'stream-json.expected.jsonl')
  const prompt = await scenarioPrompt(scenarioDir)
  let expectedSession = await readFile(sessionFixture, 'utf8')
  let runCwd = ''
  const result = await runLoaderSmoke({
    label: `headless ${scenarioName} stream-json snapshot`,
    tempDirPrefix: `headless-snapshot-${scenarioName}-`,
    binScript,
    libBinScript: binScript,
    configPath,
    binArgs: [configPath, prompt],
    tsconfigPath,
    env: {
      DSH_SNAPSHOT: 'replay',
      DSH_SNAPSHOT_FILE: sessionFixture,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
    },
    prepare: (cwd) => { runCwd = cwd },
    inspect: async (cwd) => {
      const logs = await persistedLogs(cwd)
      expect(logs).toHaveLength(1)
      const actual = logs[0]
      if (actual === undefined) throw new Error(`${scenarioName} snapshot did not persist its session`)
      const records = parseJsonl(actual.content)
      const outlineCalls = records.filter(record => record.type === 'tool/call'
        && JSON.stringify(record).includes(toolName))
      expect(outlineCalls.length).toBeGreaterThan(0)
      const actualContext = contextFromLogs([actual.content])
      if (refreshing) {
        const harvested: HarvestedLog = {
          id: String(actual.header.id),
          createdAt: Number(actual.header.createdAt),
          content: actual.content,
        }
        const replacements = refreshFixtureReplacements([harvested], [expectedSession])
        expectedSession = tokenizeSessionFixtureCwd(
          stabilizeRefreshLog(actual.content, expectedSession, replacements, actualContext),
        )
        await writeFile(sessionFixture, expectedSession)
      }
      const expectedContext = contextFromLogs([expectedSession])
      expect(scrubRequestHeaders(normalizeSessionLog(actual.content, actualContext)))
        .toBe(scrubRequestHeaders(normalizeSessionLog(expectedSession, expectedContext)))
    },
  })

  expect(result.stderr).toBe('')
  const normalized = normalizeHeadlessStream(result.stdout, runCwd)
  if (refreshing) await writeFile(streamExpected, normalized)
  expect(normalized).toBe(await readFile(streamExpected, 'utf8'))
}
