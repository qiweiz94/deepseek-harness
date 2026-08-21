import { availableParallelism } from 'node:os'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'

const DEFAULT_SNAPSHOT_MAX_CONCURRENCY = 3

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback

  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return value
}

const snapshotMaxConcurrency = positiveIntFromEnv(
  'DSH_SNAPSHOT_MAX_CONCURRENCY',
  Math.min(DEFAULT_SNAPSHOT_MAX_CONCURRENCY, availableParallelism()),
)

// Replay is the keyless default: boot real subprocess paths from recorded model responses and diff
// assembled requests, normalized protocol or transcript output, and persisted-log expected outputs.
// `record` calls the real API and updates fixtures and expected outputs; `refresh` replays committed scripts
// and updates current expected outputs. Replay/refresh never load `.env`; only record reads a key from the
// environment or root `.env`.
if (process.env.DSH_SNAPSHOT === 'record') {
  try {
    process.loadEnvFile(new URL('.env', import.meta.url).pathname)
  } catch (error) {
    // ENOENT (no .env) is fine — the key may already be in the environment.
    // Surface any other failure rather than silently recording with wrong env.
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
  }
}

export default defineConfig({
  // Same resolution note as vitest.config.ts: bare workspace names resolve
  // through the tsconfig.base.json paths facade; the native option cannot do
  // this (the root tsconfig is a solution file with no paths).
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] }), standardDecoratorPlugin()],
  test: {
    execArgv: vitestExecArgv,
    setupFiles: ['./scripts/test-invariants.ts'],
    // Fail loud with an actionable message when the built host libraries the
    // example/CLI compositions import (`<pkg>/typert` → `lib/typert.host.js`, a
    // build artifact with no source form) are absent, instead of a cryptic
    // ERR_MODULE_NOT_FOUND from a spawned child.
    globalSetup: ['./scripts/snapshot-build-preflight.ts'],
    include: [
      'scripts/**/*.snapshot.ts',
      // The assembled Web snapshot executes generated client bundles, so it is
      // included only in lib mode. The example/CLI lanes below also load the
      // build-only typert host registry, so this config needs a prior build
      // regardless of mode (enforced by the globalSetup preflight above).
      ...(process.env.DSH_EXAMPLE_MODE === 'lib' ? ['apps/web/tests/**/*.snapshot.ts'] : []),
      'apps/cli/tests/**/*.snapshot.ts',
      'examples/*/tests/**/*.snapshot.ts',
    ],
    // Replay never writes committed outputs and every scenario owns its
    // mutable runtime state (the subprocess suites use a unique temp dir and
    // fixture set per scenario), so replay runs the snapshot files in
    // parallel and bounds in-file concurrency with the environment knob
    // (value 1 restores fully serial replay on constrained machines). Record
    // and refresh stay serial: record spends real API quota per scenario, and
    // refresh write-back harvests volatile values from fixtures already on
    // disk, so concurrent writers would corrupt goldens.
    // Suite-wide, not per-scenario: Scenario (packages/test-support/acp-snapshot/src/suite.ts)
    // passes no third `timeout` argument to its per-scenario `it(...)`, so a heavy
    // scenario — e.g. subagent-continuable-inheritance, which spawns multiple real
    // agent subprocesses — can only be given headroom by raising this bound. Raised
    // from 120s: that scenario hit the fixed 120s ceiling under 4-core CI contention.
    // Note this value is NOT run through scaledTimeout/DSH_TEST_TIMEOUT_FACTOR (unlike
    // vitest.config.ts's testTimeout), so the snapshot lane's factor never reached it;
    // the harness's own per-wait persistence timeout is 10s * DSH_TEST_TIMEOUT_FACTOR
    // (packages/test-support/acp-snapshot/src/harness.ts), so a scenario awaiting
    // several sequential persistence events can exceed a 120s test-level bound while no
    // single wait is near its own ceiling. 300s adds headroom above that.
    testTimeout: 300_000,
    hookTimeout: 30_000,
    fileParallelism: (process.env.DSH_SNAPSHOT || 'replay') === 'replay' && snapshotMaxConcurrency > 1,
    maxConcurrency: snapshotMaxConcurrency,
  },
})
