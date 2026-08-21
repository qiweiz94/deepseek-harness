# @deepseek-ai/dsh-lsp-typescript-inprocess

English | [中文](README.zh.md)

An **in-process TypeScript backend** for `ctx.lsp`. One plugin instance builds an in-memory TypeScript `LanguageService` over a configured tsconfig's file set and registers a single provider that answers the seam's four operations — `goToDefinition`, `findReferences`, `goToImplementation`, `hover` — for `.ts`/`.tsx`/`.mts`/`.cts` files. There is no language server to spawn, install, or manage: the compiler runs in the harness process.

Namespace plugin (`name` / `inject` / `Config` / `apply`, no default export).

## Why a provider, not a tool

This package registers **no model-facing tool**. Code navigation reaches the model through exactly one Consumer, the shipped `lsp` tool (`dsh-tool-lsp`); a provider that added its own `find_references`/`get_definition` tools would duplicate that Consumer and split the model's navigation surface across two vocabularies. A capability seam comprises Service Definition, Service Provider, and Consumer roles — this is the Provider role for TypeScript, so composing it makes the existing `lsp` tool work in TypeScript repositories with no external server, rather than introducing a second tool.

## What it does

- Loads the configured tsconfig eagerly at mount, so a missing or unreadable config fails loud at load; the expensive type-checked program builds lazily on the first query.
- Indexes the **transitive** file set: the root config's own files plus every file reachable through `references`. A solution-style tsconfig that lists only a few roots and reaches package sources through project references alone is fully navigable; an engine built on its own `fileNames` would answer "no references" for symbols declared in a referenced project.
- Answers each operation directly in the seam's coordinates: zero-based UTF-16 positions in, `file:` URIs with zero-based half-open ranges out. `findReferences` includes the symbol's own declaration. `hover` returns TypeScript's quick-info signature, followed by its documentation when present.
- Resolves the query file against the request's `workspaceRoot` and stamps `resolvedWorkspaceUri` as this process's canonical `file:` URI for that root, so the tool relativizes location URIs against a root computed on the execution platform.
- Reads each source file once into an unversioned snapshot and never watches: one engine answers for one point in time. The plugin disposes the language service (and its program and document caches) when its fiber disposes.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `tsconfigPath` | (required) | Root tsconfig whose transitive file set defines the navigable TypeScript workspace. Absolute, or relative to the process launch cwd. |

Point `tsconfigPath` at a project **inside the session workspace**: the provider navigates only files that project compiles. A query for a file outside the project's file set returns no results (empty locations, or a `null` hover), never an error — the same answer as an off-symbol position. A position beyond the end of the file is treated the same way, because positions originate in model tool arguments.

The provider id (`typescript-inprocess`) and the TypeScript extension mapping are fixed, not configurable: the seam reserves each extension globally, so at most one TypeScript provider is active, and its file suffixes are a language convention rather than a deployment choice.

## Model Experience

Indirectly, through `dsh-tool-lsp`, which surfaces this provider's normalized results; this backend contributes no prompt or schema itself.

#### KV Cache effect

None of its own. It answers a read-only query and returns normalized locations or hover text to the seam; only the `lsp` tool's rendered result is model-visible, and only when the model calls that tool.

## Known Limitations and Deferred Work

- **TypeScript only** — `.js`/`.jsx`/`.mjs`/`.cjs` are intentionally excluded from the extension mapping. A TypeScript `LanguageService` can navigate JavaScript under `allowJs`, but that would claim JavaScript files for a provider configured for a TypeScript project; a JavaScript mapping is deferred to a deliberate decision with its own tests.
- **One point-in-time snapshot** — the host reads each file once, keeps one version, and never watches. Edits after the engine is built are invisible until the fiber is disposed and re-composed; this backend suits read-only navigation against a stable tree, not a live editing session.
- **Single configured project** — one instance navigates one tsconfig's transitive file set. A file outside that set is not navigable here, and the `workspaceRoot` a query carries is used only to compute `resolvedWorkspaceUri`, not to discover or index a per-query project.
- **Path matching does not resolve symlinks** — the query file and the project's file names are compared after `resolve()` with no `realpath`, so a deployment whose session cwd and tsconfig reach the same files through different symlinked paths must keep them consistent.
