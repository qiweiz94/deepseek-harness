/**
 * Assembled-app regression for the worktree-sandbox tool: one replayed
 * `sandbox_exec` command writes a file inside a detached trial worktree of a
 * real git repository prepared at the run cwd. The tool result reports the
 * write while the main working tree never gains the file, and the trial
 * worktree is removed after the call — the isolation is proved physically.
 */

import { execFileSync } from 'node:child_process'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeSessionLog, scrubRequestHeaders, type NormalizeContext } from '@deepseek-ai/dsh-acp-snapshot'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { describe, expect, it } from 'vitest'

const fixtureDir = fileURLToPath(new URL('./worktree-sandbox-snapshots/trial-exec', import.meta.url))
const replayOverride = join(fixtureDir, 'replay.override.json')
const sessionExpected = join(fixtureDir, 'session.expected.jsonl')
const configPath = fileURLToPath(new URL('../worktree-sandbox.cordis.snapshot.yml', import.meta.url))
const binScript = fileURLToPath(new URL('./fixtures/headless-driver.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'
const task = 'Run the sandbox trial.'

interface JsonObject {
  [key: string]: unknown
}

function parseJsonl(content: string): JsonObject[] {
  return content.trimEnd().split('\n').map(line => JSON.parse(line) as JsonObject)
}

/** Create the git repository the sandbox detaches its trial worktree from. */
function seedGitRepo(cwd: string): void {
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd, stdio: 'pipe' })
  }
  git('init')
  git('config', 'user.email', 'snapshot@example.com')
  git('config', 'user.name', 'Snapshot Fixture')
  git('add', '.')
  git('commit', '-m', 'init', '--no-gpg-sign')
}

// The tool runs its command through `sh -c` and the fixture needs host git.
describe.skipIf(process.platform === 'win32')('worktree-sandbox trial snapshot', () => {
  it('isolates a trial write from the main tree through the assembled headless app', async () => {
    let cwd = ''
    const result = await runLoaderSmoke({
      label: 'worktree sandbox headless stream-json snapshot',
      tempDirPrefix: 'dsh-worktree-sandbox-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, task],
      tsconfigPath,
      env: {
        // The primary fixture path must exist for llm-replay's config guard;
        // the override sidecar fully replaces the derived script.
        DSH_SNAPSHOT_FILE: replayOverride,
        DSH_SNAPSHOT_OVERRIDE: replayOverride,
      },
      prepare: async (runCwd) => {
        cwd = runCwd
        // Committed content anchors the trial diff: the worktree detaches from
        // HEAD, so the base commit must exist before the app boots.
        await writeFile(join(runCwd, 'a.txt'), 'base\n')
        seedGitRepo(runCwd)
      },
      inspect: async (runCwd) => {
        // THE isolation facts: the trial write exists only in the tool result;
        // the main tree never gains the file, and the trial worktree is gone.
        await expect(readFile(join(runCwd, 'trial.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(stat(join(runCwd, '.dsh', 'worktrees', 'subagent-trial'))).rejects.toMatchObject({ code: 'ENOENT' })

        const sessionsDir = join(runCwd, '.sessions')
        const files = (await readdir(sessionsDir, { recursive: true })).filter(file => file.endsWith('.jsonl'))
        expect(files).toHaveLength(1)
        const log = await readFile(join(sessionsDir, files[0] ?? ''), 'utf8')
        const records = parseJsonl(log)

        // The persisted tool/result carries the model-facing render; the
        // structured facts surface through its text.
        const toolResult = records.find(record => record.type === 'tool/result')
        expect(toolResult).toBeDefined()
        const resultText = JSON.stringify(toolResult)
        expect(resultText).toContain('.dsh/worktrees/subagent-trial on HEAD: exit 0; 1 file changed: trial.txt')
        expect(resultText).toContain('"isError":false')

        const header = records[0] ?? {}
        const context: NormalizeContext = {
          sessionIds: typeof header.id === 'string' ? [header.id] : [],
          cwd,
        }
        const normalized = scrubRequestHeaders(normalizeSessionLog(log, context))
        if (refreshing) {
          await writeFile(sessionExpected, normalized)
        }
        expect(normalized).toBe(await readFile(sessionExpected, 'utf8'))
      },
    })

    expect(result.stderr).toBe('')
    const records = result.stdout.trimEnd().split('\n').map(line => JSON.parse(line) as JsonObject)
    expect(records.at(-1)).toMatchObject({
      type: 'result',
      output: 'Sandbox trial complete. SANDBOX_DONE',
    })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
