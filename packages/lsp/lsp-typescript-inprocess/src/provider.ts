/**
 * Adapt a {@link TypeScriptNavigationEngine} to the `ctx.lsp` seam's
 * {@link LspProvider}: a stable id, the TypeScript extension mapping, and a
 * `query` that dispatches each of the four seam operations to the engine and
 * normalizes the result to the seam's closed union. The engine already speaks
 * the seam's coordinates, so this adapter only resolves the query file against
 * the request's `workspaceRoot` and stamps the canonical `resolvedWorkspaceUri`.
 * @module @deepseek-ai/dsh-lsp-typescript-inprocess/provider
 */

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { LspProvider, LspProviderId, LspProviderQuery, LspQueryResult } from '@deepseek-ai/dsh-lsp'
import type { TypeScriptNavigationEngine } from './engine.ts'

/**
 * The file extensions this provider claims, each mapped to the `typescript`
 * language id. Fixed by the TypeScript file-suffix convention (an external
 * spec), not deployment-varying: this IS the TypeScript provider. JavaScript
 * suffixes are intentionally excluded; see the package README.
 */
export const TYPESCRIPT_EXTENSIONS: Readonly<Record<string, string>> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
}

/**
 * Build the seam provider over an engine.
 * @param id - the stable provider identity reserved on `ctx.lsp`.
 * @param engine - the in-process TypeScript navigation engine to dispatch to.
 * @returns the `LspProvider` the plugin registers.
 */
export function createTypeScriptProvider(id: LspProviderId, engine: TypeScriptNavigationEngine): LspProvider {
  return {
    id,
    extensionToLanguage: TYPESCRIPT_EXTENSIONS,
    query(request: LspProviderQuery, signal?: AbortSignal): Promise<LspQueryResult> {
      // The engine is synchronous; a cancelled query rejects rather than running.
      if (signal?.aborted === true) return Promise.reject(signal.reason as Error)
      // `filePath` is relative to `workspaceRoot` or absolute; canonicalize both
      // in this process so `resolvedWorkspaceUri` and location URIs share a root.
      const filePath = resolve(request.workspaceRoot, request.filePath)
      const resolvedWorkspaceUri = pathToFileURL(resolve(request.workspaceRoot)).href
      switch (request.operation) {
        case 'goToDefinition':
          return Promise.resolve({ kind: 'locations', locations: engine.definition(filePath, request.position), resolvedWorkspaceUri })
        case 'findReferences':
          return Promise.resolve({ kind: 'locations', locations: engine.references(filePath, request.position), resolvedWorkspaceUri })
        case 'goToImplementation':
          return Promise.resolve({ kind: 'locations', locations: engine.implementation(filePath, request.position), resolvedWorkspaceUri })
        case 'hover':
          return Promise.resolve({ kind: 'hover', hover: engine.hover(filePath, request.position) })
        default: {
          // Compile-enforced exhaustiveness: a new seam operation breaks this line.
          const unreachable: never = request.operation
          return Promise.reject(new Error(`unsupported LSP operation: ${String(unreachable)}`))
        }
      }
    },
  }
}
