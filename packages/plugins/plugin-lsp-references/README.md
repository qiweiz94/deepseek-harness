# @deepseek-ai/dsh-plugin-lsp-references

English | [中文](README.zh.md)

The model-facing `find_references` and `get_definition` tools: precise TypeScript symbol navigation over a whole multi-project workspace, so the model can find every caller of a symbol — or its exact declaration anchor — instead of guessing from textual matches.

## What it does

Registers two tools on `ctx.tools`, both answered by one in-process TypeScript `LanguageService`:

- `find_references(path, line, character)` returns `{ path, line, character, references, total, truncated }`, where each entry in `references` is a `{ path, line, character, text }` location — the file, the 1-based cursor, and that position's whitespace-trimmed source line. Every reference across the whole project file set is reported, including callers, importers, and the symbol's own declaration (the language-server protocol's `findReferences` contract). Locations are ordered by file, then line, then column.
- `get_definition(path, line, character)` returns `{ path, line, character, definitions }` with the same location entries. An overloaded function or a merged interface legitimately declares more than one anchor, so `definitions` is a list rather than a single value.

Positions are 1-based line and 1-based UTF-16 character, matching the sibling [`lsp`](../../lsp/tool-lsp/README.md) tool's cursor convention. A column past the end of its line is clamped, and a position that names no symbol returns an empty result — an off-symbol cursor is an answer, not a failure. A line outside the file, a column below 1, and a file outside the project file set are error results that say which limit was crossed.

## Project file set

The navigable workspace is the transitive closure of one root tsconfig (`tsconfigPath`, default `tsconfig.host.json` resolved against the process working directory): its own `fileNames` plus every file reachable through `references`, walked to a fixed point so a diamond in the reference graph is parsed once.

That transitivity is what makes the tools honest here. `tsconfig.host.json` includes only test, script, and website sources and reaches all 190 package sources through `references` alone, so a host built on its own `fileNames` would answer "no references" for every symbol declared in a package source directory.

The language service is built on the FIRST call, not at load: resolving a reference graph and parsing its sources is real work that a boot which never navigates must not pay. The host is static — it reads each file once and never watches — so one instance answers for one point in time, and the fiber's disposal releases it.

## Export shape

A function/namespace plugin: it exports `name` / `inject` / `Config` / `apply` and NO default. A stray `export default` would collapse the module via the Loader's `unwrapExports` and drop `inject` (see [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).

## Model Experience

### Tool schema

#### What the model sees

The model sees two generated schemas in the [tool catalog](../../../docs/tool-catalog.md): three required parameters each (`path` string, `line` integer, `character` integer) and a structured result — `references` plus a `total`/`truncated` pair for `find_references`, `definitions` for `get_definition`. Plugin config (`tsconfigPath` default `tsconfig.host.json`, `maxReferences` default 200, `maxLineChars` default 200) is validated at load and fails loud on an invalid value; it changes no schema field, only whether a call resolves or returns a directing error result.

#### Token effect

Fixed schema cost on every request where the tools are visible. A call result scales with the number of references found, bounded by `maxReferences`; each location costs one path, one position, and at most `maxLineChars` characters of source line. A truncated result names how many references it omitted so the model never reads a capped list as complete.

#### KV Cache effect

Prefix-stable while the definitions and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from these schemas; the language service's program is built inside the call and never enters the request prefix.

## Known Limitations and Deferred Work

- **TypeScript only** — the engine is TypeScript's own `LanguageService`, so a symbol in another language is not navigable even when a real language server for it exists. The [`lsp`](../../lsp/tool-lsp/README.md) tool covers the general, server-backed case.
- **One point in time** — the host never watches the file system and holds one snapshot version per file. A file edited after the first call is answered from the text the service read; the composition must be re-mounted to pick edits up.
- **First call pays for the whole project** — building the program over a large reference graph is the tools' dominant cost, and it lands on whichever call happens first.
- **Project file set only** — a file the root tsconfig does not reach, directly or through `references`, cannot be queried and cannot appear in a result.
- **No implementation or type-hierarchy query** — `goToImplementation`, `hover`, and rename previews are out of scope here; `find_references` reports implementations only insofar as they reference the symbol.
- **Retained by count, not by bytes** — `maxReferences` bounds the location list and `maxLineChars` bounds each preview, so a result's total size is bounded by their product rather than by a byte budget.
