import ts from 'typescript'

const decoratorSyntax = /^\s*@[A-Za-z_$][\w$]*/m

const TIMEOUT_FACTOR_ENV = 'DSH_TEST_TIMEOUT_FACTOR'

/**
 * Multiplier for test-timeout bounds, read from `DSH_TEST_TIMEOUT_FACTOR`.
 * Slow runners (the fork's 4-core hosted CI lanes) set a factor above 1 so
 * every timeout keeps its local meaning while gaining proportional headroom;
 * unset or empty means 1, leaving every bound exactly as authored.
 * @returns the validated factor; a set value must parse as a finite number >= 1.
 */
export function testTimeoutFactor(): number {
  const raw = process.env[TIMEOUT_FACTOR_ENV]
  if (raw === undefined || raw === '') return 1
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`${TIMEOUT_FACTOR_ENV} must be a finite number >= 1, got ${JSON.stringify(raw)}`)
  }
  return value
}

/**
 * Scale a timeout bound by the environment factor above.
 * @param baseMs - the bound that clears a full-speed development machine.
 * @returns `baseMs` multiplied by the factor, rounded to whole milliseconds.
 */
export function scaledTimeout(baseMs: number): number {
  return Math.round(baseMs * testTimeoutFactor())
}

/**
 * Worker arguments that keep process-wide Web Storage from shadowing jsdom storage.
 * Node lists the positive spelling in `allowedNodeEnvironmentFlags` for this negatable flag.
 */
export const vitestExecArgv = process.allowedNodeEnvironmentFlags.has('--webstorage') ? ['--no-webstorage'] : []

/**
 * Transform standard TypeScript decorators before Vite's default parser sees source files.
 * @returns a pre-transform Vite plugin shared by source-mode test configurations.
 */
export function standardDecoratorPlugin() {
  return {
    name: 'dsh-standard-decorators',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const file = id.split('?', 1)[0]!
      if (!/\.[cm]?tsx?$/.test(file) || !decoratorSyntax.test(code)) return
      const result = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: {
          target: ts.ScriptTarget.ES2024,
          module: ts.ModuleKind.ESNext,
          jsx: file.endsWith('x') ? ts.JsxEmit.ReactJSX : undefined,
          sourceMap: true,
        },
      })
      return {
        code: result.outputText
          .replace(
            /^(\s*)(__esDecorate\()/gmu,
            '$1/* v8 ignore next -- compiler-synthetic decorator accessors have no source behavior */ $2',
          )
          .replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'),
        map: result.sourceMapText,
      }
    },
  }
}
