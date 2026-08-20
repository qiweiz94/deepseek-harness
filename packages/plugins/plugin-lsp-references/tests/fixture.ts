// A throwaway multi-project workspace mirroring the shape this plugin exists
// for: a ROOT tsconfig whose own `files` are one thin entry, with every other
// source reachable only through `references` — and a diamond (two projects
// referencing a third) so the reference walk must dedupe.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Where the interesting symbols live inside a built fixture. */
export interface Fixture {
  /** The workspace root (also the fixture's temp directory). */
  root: string
  /** The root tsconfig every service in these tests is built on. */
  tsconfigPath: string
  /** `pkg-a/src/index.ts`, declaring `helper`. */
  declarationFile: string
  /** `pkg-b/src/consumer.ts`, referencing `helper` three times across two lines. */
  consumerFile: string
  /** `root.ts`, the root project's own file, referencing `helper` twice. */
  rootFile: string
}

const COMPILER_OPTIONS = {
  module: 'nodenext',
  moduleResolution: 'nodenext',
  target: 'es2022',
  strict: true,
  allowImportingTsExtensions: true,
  noEmit: true,
  // `pkg-a` imports `shared` by PACKAGE NAME, resolvable only through this map —
  // exactly how real workspace sources import each other. It pins that the
  // options handed to the language service keep their `paths` base directory:
  // without it the host answers same-package-only and every cross-package claim
  // this plugin makes becomes false, silently.
  paths: { '@fixture/shared': ['./shared/src/types.ts'] },
}

async function project(dir: string, references: string[]): Promise<void> {
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: COMPILER_OPTIONS,
    include: ['src'],
    references: references.map(path => ({ path })),
  }))
}

/**
 * Materialize the fixture workspace in a fresh temp directory.
 * @returns the fixture's root and the paths tests query against.
 */
export async function buildFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lsp-references-'))

  await project(join(root, 'shared'), [])
  await writeFile(join(root, 'shared', 'src', 'types.ts'), 'export interface Widget {\n  id: string\n}\n')

  // Both leaf projects reference `shared`: the diamond the walk must visit once.
  await project(join(root, 'pkg-a'), ['../shared'])
  await writeFile(
    join(root, 'pkg-a', 'src', 'index.ts'),
    'import type { Widget } from \'@fixture/shared\'\n'
    + '\n'
    + 'export function helper(widget: Widget): string {\n'
    + '  return widget.id\n'
    + '}\n',
  )

  await project(join(root, 'pkg-b'), ['../shared'])
  // No trailing newline: the last line must still render without a terminator.
  await writeFile(
    join(root, 'pkg-b', 'src', 'consumer.ts'),
    'import { helper } from \'../../pkg-a/src/index.ts\'\n'
    + '\n'
    + 'export const pair = [helper, helper]\n'
    + '\n'
    + 'export const single = helper',
  )

  await writeFile(
    join(root, 'root.ts'),
    'import { helper } from \'./pkg-a/src/index.ts\'\n'
    + 'export const fromRoot = helper\n',
  )
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: COMPILER_OPTIONS,
    files: ['root.ts'],
    // A directory reference and an explicit config-file reference, the two
    // spellings tsconfig.host.json itself mixes.
    references: [{ path: './pkg-a' }, { path: './pkg-b/tsconfig.json' }],
  }))

  return {
    root,
    tsconfigPath: join(root, 'tsconfig.json'),
    declarationFile: join(root, 'pkg-a', 'src', 'index.ts'),
    consumerFile: join(root, 'pkg-b', 'src', 'consumer.ts'),
    rootFile: join(root, 'root.ts'),
  }
}

/** 1-based cursor on the `helper` identifier in its own declaration. */
export const HELPER_DECLARATION = { line: 3, character: 17 } as const
