/**
 * In-process TypeScript provider for the `ctx.lsp` capability seam. Registering
 * this plugin makes the shipped `lsp` tool answer `goToDefinition`,
 * `findReferences`, `goToImplementation`, and `hover` for `.ts`/`.tsx`/`.mts`/
 * `.cts` files from a configured tsconfig's file set — through an in-memory
 * TypeScript `LanguageService`, with no external language server to spawn or
 * manage. It registers no model-facing tool of its own: it is a Service Provider
 * behind the seam, and the tool is the only Consumer the model sees.
 * @module @deepseek-ai/dsh-lsp-typescript-inprocess
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LspProviderId } from '@deepseek-ai/dsh-lsp'
import { TypeScriptNavigationEngine } from './engine.ts'
import { createTypeScriptProvider } from './provider.ts'

export const name = 'lsp-typescript-inprocess'
/** The LSP seam this provider registers on. */
export const inject = ['lsp']

/**
 * The stable provider identity reserved on `ctx.lsp`. Fixed, not configurable:
 * the seam reserves each file extension globally, so at most one TypeScript
 * provider can be active, and it owns one identity.
 */
const PROVIDER_ID = LspProviderId('typescript-inprocess')

/** Plugin configuration. */
export interface Config {
  /**
   * Root tsconfig whose transitive file set (its own files plus every project it
   * reaches through `references`) defines the navigable TypeScript workspace.
   * A deployment points this at a project inside the session workspace; a query
   * for a file outside that project returns no results.
   */
  tsconfigPath: string
}

export const Config: z<Config> = z.object({
  tsconfigPath: z.string().required(),
})

/**
 * Register the in-process TypeScript provider on `ctx.lsp`. The engine loads the
 * configured tsconfig eagerly, so a missing or unparseable config fails loud at
 * load; the expensive type-checked program builds lazily on the first query.
 * @param ctx - Cordis context; must inject `lsp`.
 * @param config - the plugin configuration naming the tsconfig.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => {
    const engine = new TypeScriptNavigationEngine(config.tsconfigPath)
    const deregister = ctx.lsp.registerProvider(createTypeScriptProvider(PROVIDER_ID, engine))
    return () => {
      deregister()
      engine.dispose()
    }
  }, 'lsp-typescript-inprocess.registerProvider')
}
