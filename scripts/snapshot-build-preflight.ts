/**
 * Vitest `globalSetup` for the snapshot lane. The example and CLI snapshot
 * scenarios boot real compositions that import each package's generated typert
 * host registry through its `<pkg>/typert` export, which resolves to
 * `lib/typert.host.js` — a build artifact with no source form, reached the same
 * way in `src` and `lib` example modes because a subpath export bypasses the
 * tsconfig-paths facade. Without a prior build those imports fail deep inside a
 * spawned subprocess as a cryptic `ERR_MODULE_NOT_FOUND`. This preflight fails
 * loud in the vitest process first, naming the fix, so a missing build is an
 * actionable error rather than a stack trace from a child process.
 * @module scripts/snapshot-build-preflight
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Representative built host-face artifacts the snapshot compositions load. Both
 * are core packages every scenario's assembled agent pulls in; if the build ran,
 * they exist, and if it did not, at least one is missing.
 */
const REQUIRED_BUILT_LIBS: readonly string[] = [
  'packages/interaction/commands/lib/typert.host.js',
  'packages/goal/goal/lib/typert.host.js',
]

/**
 * Fail loud before any snapshot scenario spawns if the built host libraries the
 * assembled compositions import are absent.
 * @throws Error naming the missing artifacts and the build command to run.
 */
export function setup(): void {
  const missing = REQUIRED_BUILT_LIBS.filter(
    rel => !existsSync(fileURLToPath(new URL(`../${rel}`, import.meta.url))),
  )
  if (missing.length === 0) return
  throw new Error(
    'Snapshot tests need built host libraries that are missing:\n'
    + missing.map(rel => `  ${rel}`).join('\n')
    + '\n\nThe example and CLI snapshot scenarios boot compositions that import each '
    + "package's generated typert host registry (`<pkg>/typert` → `lib/typert.host.js`), "
    + 'a build artifact with no source form. Run `pnpm run build:lib:host` (or `pnpm run build`) '
    + 'first, then re-run the snapshot tests.',
  )
}
