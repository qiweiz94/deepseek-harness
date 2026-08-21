# Agent Note: in-process TypeScript navigation is an lsp seam Provider, not new tools

Status: implemented

English | [中文](2026-08-21-lsp-typescript-inprocess-provider.zh.md)

## Problem

A parallel plugin suite proposed `plugin-lsp-references`: two model-facing tools (`find_references`, `get_definition`) backed by an in-process TypeScript `LanguageService` built from a tsconfig. The **engine** was the right idea — an in-memory `LanguageService` gives precise, type-aware navigation with no external language server to spawn or manage — but the **plugging** was wrong. The harness already ships an `lsp` capability seam (`ctx.lsp`) with a Service Definition (four operations: `goToDefinition`/`findReferences`/`goToImplementation`/`hover`), one model-facing Consumer (`dsh-tool-lsp`, the `lsp` tool), and a Provider (`dsh-lsp-stdio`, which spawns external servers). Adding two more tools would have duplicated the existing Consumer and split the model's code-navigation surface across two vocabularies for the same capability.

## Decision

Ship the engine as a **Service Provider** for the existing `lsp` seam, in a new package `@deepseek-ai/dsh-lsp-typescript-inprocess`, and do **not** ship the two tools. Composing the provider makes the already-shipped `lsp` tool answer all four operations in TypeScript repositories with no external server.

- The package registers on `ctx.lsp` (`inject: ['lsp']`, `ctx.lsp.registerProvider`) and exposes no tool. It is the Provider role for TypeScript; `dsh-tool-lsp` remains the sole Consumer the model sees. This follows the capability-seam rule: a seam comprises Service Definition / Provider / Consumer, and a new backend is a Provider, not a new Consumer.
- The engine is written **seam-native**. The suite's original `ReferenceService` returned one-based line/character `CodeLocation`s with a source-line preview — shaped for its own two tools. The seam speaks zero-based UTF-16 positions and `LspLocation` ranges (`{ uri, range: { start, end } }`), and its Consumer owns result limits and previews. The TypeScript `LanguageService` API is itself zero-based (`getPositionOfLineAndCharacter`, `getLineAndCharacterOfPosition`), so the engine maps through with no coordinate translation, preserves each `textSpan`'s end for the range, and adds `goToImplementation` (`getImplementationAtPosition`) and `hover` (`getQuickInfoAtPosition`) — the two operations the seam requires that the original engine lacked. It keeps the original's transitive project-reference file-set walk, which is load-bearing for solution-style tsconfigs.
- The provider adapter resolves the query file against the request's `workspaceRoot` and stamps `resolvedWorkspaceUri` as this process's canonical `file:` URI for that root (the seam's contract for a caller that relativizes location URIs), and dispatches the four operations through a compile-enforced exhaustive switch.
- Config is one field, `tsconfigPath`, loaded eagerly so a bad config fails loud at load. The provider id and the `.ts`/`.tsx`/`.mts`/`.cts` mapping are fixed, not configurable: the seam reserves each extension globally, so at most one TypeScript provider is active, and the suffix set is a language convention (an external spec), not a deployment choice.

## Alternatives considered

- **Ship the two tools as proposed** — rejected: duplicates the `lsp` tool's operations under a second name, violating "one Consumer the model sees" for the code-navigation capability and giving the model two overlapping vocabularies to choose between.
- **Reuse the original one-based `ReferenceService` unchanged behind an adapter** — rejected: the seam needs ranges (start *and* end), which the original discarded (it kept only a start point plus a preview line), and needs `goToImplementation`/`hover`, which it lacked. Adapting one-based points into zero-based ranges through a translation layer adds a coordinate round-trip the zero-based TypeScript API makes unnecessary; writing the engine in the seam's own coordinates is simpler and removes a class of off-by-one bug.
- **Index the per-query `workspaceRoot` instead of a configured tsconfig** — rejected for this change: rebuilding a type-checked program per query, or discovering a tsconfig per session cwd, is expensive and unspecified. One configured project with an eager fail-loud load matches the shipped deployment (a fixed repository project); `workspaceRoot` is used only to compute `resolvedWorkspaceUri`. Per-workspace discovery can be revisited if a concrete multi-workspace consumer needs it.
- **Map JavaScript extensions too (`allowJs`)** — deferred: a TypeScript `LanguageService` can navigate JavaScript, but claiming `.js` for a provider configured for a TypeScript project is a separate decision that needs its own tests; the mapping is TypeScript-only until then.

## Consequences

- `plugin-lsp-references` is not shipped; its two tools are the rejected plugging. It was never merged to `master`, so this is a design record, not a deletion.
- Deployments that compose `dsh-lsp` + `dsh-tool-lsp` gain TypeScript navigation by adding `dsh-lsp-typescript-inprocess` with a `tsconfigPath`; no tool-catalog entry changes, because the package adds no tool. `typescript` is a runtime `dependency` (the compiler runs in-process), matching the suite's other in-process analysis packages.
- A real Loader-composition test boots `lsp` + this provider from a `cordis.yml` and drives all four operations through `ctx.lsp` against an on-disk TypeScript fixture; a disposal test proves the provider deregisters when its fiber disposes. The provider is a same-process typed boundary, so position values that originate in model tool arguments (out-of-range line, off-symbol column, a file outside the project) return no results rather than throwing.
