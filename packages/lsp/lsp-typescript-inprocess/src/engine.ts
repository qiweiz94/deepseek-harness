/**
 * An in-memory TypeScript `LanguageService` over a tsconfig's file set, exposing
 * the four `ctx.lsp` seam operations directly in the seam's own coordinates
 * (zero-based UTF-16 positions, `file:` URIs, half-open ranges). One instance
 * answers for one point in time: the host reads each file once, keeps one
 * snapshot version, and never watches, so the plugin builds it lazily and
 * disposes it with its fiber.
 *
 * The file set is the transitive closure of the named config's own `fileNames`
 * AND every project it reaches through `references`. That transitivity is
 * load-bearing here: a solution-style `tsconfig` includes only a few roots and
 * reaches all package sources through `references` alone; an engine built on its
 * `fileNames` would answer "no references" for every symbol declared in a
 * referenced project.
 * @module @deepseek-ai/dsh-lsp-typescript-inprocess/engine
 */

import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import type { LspHover, LspLocation, LspPosition, LspRange } from '@deepseek-ai/dsh-lsp'

/** A tsconfig's transitively resolved compilation inputs. */
export interface ProjectFileSet {
  /** Absolute file names, deduplicated across the reference graph, in first-seen order. */
  fileNames: string[]
  /** The root config's compiler options, used verbatim for the language service. */
  options: ts.CompilerOptions
}

/**
 * Resolve one tsconfig into the transitive closure of its own files and every
 * file reachable through `references`. A reference graph with diamonds (two
 * configs referencing a third) is visited once per config, so the walk
 * terminates and the file list carries no duplicates.
 * @param tsconfigPath - path to the root config file, absolute or relative to the process cwd.
 * @returns the union file set plus the ROOT config's compiler options.
 */
export function loadProjectFileSet(tsconfigPath: string): ProjectFileSet {
  let failure = 'the config file could not be parsed'
  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      failure = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
    },
  }
  const fileNames = new Set<string>()
  const visited = new Map<string, ts.ParsedCommandLine>()
  const visit = (configPath: string): ts.ParsedCommandLine => {
    const seen = visited.get(configPath)
    if (seen !== undefined) return seen
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host)
    if (parsed === undefined) {
      throw new Error(`cannot load the TypeScript project at ${configPath}: ${failure}`)
    }
    visited.set(configPath, parsed)
    for (const fileName of parsed.fileNames) fileNames.add(resolve(fileName))
    for (const reference of listOf(parsed.projectReferences)) {
      visit(resolve(ts.resolveProjectReferencePath(reference)))
    }
    return parsed
  }
  const root = visit(resolve(tsconfigPath))
  return { fileNames: [...fileNames], options: root.options }
}

/**
 * Normalize an optional TypeScript result list. The compiler API returns
 * `undefined` — not an empty array — for a config with no `references` and for a
 * position that names no symbol; both mean "nothing", never "failed".
 * @param entries - the list TypeScript returned, if any.
 * @returns the same list, or an empty one.
 */
function listOf<T>(entries: readonly T[] | undefined): readonly T[] {
  return entries ?? []
}

/**
 * Read one file into a script snapshot, memoized in the caller's cache. Exported
 * so the missing-file path stays directly exercisable: the language service
 * probes candidate module paths that may not exist, and a host that threw there
 * would fail the whole query instead of resolving the import elsewhere.
 * @param fileName - absolute path the language service asked for.
 * @param cache - the host's per-instance snapshot cache.
 * @returns the snapshot, or `undefined` when the file cannot be read.
 */
export function readSnapshot(
  fileName: string,
  cache: Map<string, ts.IScriptSnapshot>,
): ts.IScriptSnapshot | undefined {
  const cached = cache.get(fileName)
  if (cached !== undefined) return cached
  const text = ts.sys.readFile(fileName)
  if (text === undefined) return undefined
  const snapshot = ts.ScriptSnapshot.fromString(text)
  cache.set(fileName, snapshot)
  return snapshot
}

/** A TypeScript navigation result: the fields every `DocumentSpan` carries. */
interface DocumentSpan {
  readonly fileName: string
  readonly textSpan: ts.TextSpan
}

/**
 * A disposable in-process TypeScript navigation engine scoped to one project
 * file set. Every position that crosses this boundary is zero-based UTF-16,
 * matching the `ctx.lsp` seam; the TypeScript API's own zero-based coordinates
 * map through unchanged.
 */
export class TypeScriptNavigationEngine {
  readonly #fileNames: string[]
  readonly #snapshots = new Map<string, ts.IScriptSnapshot>()
  readonly #service: ts.LanguageService

  /** @param tsconfigPath - the root tsconfig whose transitive file set defines the navigable workspace. */
  constructor(tsconfigPath: string) {
    const project = loadProjectFileSet(tsconfigPath)
    this.#fileNames = project.fileNames
    const currentDirectory = dirname(resolve(tsconfigPath))
    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => this.#fileNames,
      // The host never reloads a file, so one version answers for its lifetime.
      getScriptVersion: () => '1',
      getScriptSnapshot: fileName => readSnapshot(fileName, this.#snapshots),
      getCurrentDirectory: () => currentDirectory,
      getCompilationSettings: () => project.options,
      getDefaultLibFileName: options => ts.getDefaultLibFilePath(options),
      // Module resolution (linking an import to another project file) reads the
      // real filesystem through `ts.sys`, the namespace the config was parsed in.
      fileExists: path => ts.sys.fileExists(path),
      readFile: (path, encoding) => ts.sys.readFile(path, encoding),
    }
    this.#service = ts.createLanguageService(host, ts.createDocumentRegistry())
  }

  /** Absolute file names this engine can navigate, in first-seen order. */
  get fileNames(): readonly string[] {
    return this.#fileNames
  }

  #program(): ts.Program {
    const program = this.#service.getProgram()
    /* v8 ignore next 3 -- a language service over a static, non-watching host always yields a program. */
    if (program === undefined) {
      throw new Error('the TypeScript language service produced no program')
    }
    return program
  }

  /**
   * Zero-based position to an absolute file offset. An out-of-range line yields
   * `undefined` (the caller returns no results); a character past the line end
   * clamps to it, so an off-symbol column is a no-results answer, not a fault.
   * Positions originate in model tool JSON, so an out-of-bounds value is a
   * caller mistake to answer emptily, never a crash.
   */
  #offset(source: ts.SourceFile, position: LspPosition): number | undefined {
    const lineCount = source.getLineStarts().length
    if (position.line < 0 || position.line >= lineCount) return undefined
    const lineStart = source.getPositionOfLineAndCharacter(position.line, 0)
    const lineEnd = position.line + 1 < lineCount
      ? source.getPositionOfLineAndCharacter(position.line + 1, 0)
      : source.text.length
    const character = Math.max(0, Math.min(position.character, lineEnd - lineStart))
    return lineStart + character
  }

  #range(source: ts.SourceFile, span: ts.TextSpan): LspRange {
    const start = source.getLineAndCharacterOfPosition(span.start)
    const end = source.getLineAndCharacterOfPosition(span.start + span.length)
    return {
      start: { line: start.line, character: start.character },
      end: { line: end.line, character: end.character },
    }
  }

  #toLocation(span: DocumentSpan): LspLocation {
    const source = this.#program().getSourceFile(span.fileName)
    /* v8 ignore next 3 -- TypeScript only reports spans inside files its own program loaded. */
    if (source === undefined) {
      throw new Error(`the language service reported a position in ${span.fileName}, which the program did not load`)
    }
    return { uri: pathToFileURL(span.fileName).href, range: this.#range(source, span.textSpan) }
  }

  /** Locate the query file and offset, then map the navigation result to sorted seam locations. */
  #locations(
    filePath: string,
    position: LspPosition,
    run: (fileName: string, offset: number) => readonly DocumentSpan[],
  ): LspLocation[] {
    const fileName = resolve(filePath)
    // A file the extension matched but that this project does not compile is not
    // navigable here — no results, rather than a fault the model cannot act on.
    const source = this.#program().getSourceFile(fileName)
    if (source === undefined) return []
    const offset = this.#offset(source, position)
    if (offset === undefined) return []
    return run(fileName, offset)
      .map(span => this.#toLocation(span))
      .sort((a, b) =>
        a.uri.localeCompare(b.uri)
        || a.range.start.line - b.range.start.line
        || a.range.start.character - b.range.start.character)
  }

  /**
   * The declaration anchor(s) of the symbol at a position. An overloaded
   * function or a merged interface legitimately declares more than one.
   * @param filePath - absolute path of the file to query.
   * @param position - zero-based UTF-16 cursor position.
   * @returns the declaration locations, empty when the position names no symbol.
   */
  definition(filePath: string, position: LspPosition): LspLocation[] {
    return this.#locations(filePath, position, (fileName, offset) =>
      listOf(this.#service.getDefinitionAtPosition(fileName, offset)))
  }

  /**
   * Every reference to the symbol at a position, across the project file set.
   * The symbol's own declaration is included, matching the seam's contract.
   * @param filePath - absolute path of the file to query.
   * @param position - zero-based UTF-16 cursor position.
   * @returns the reference locations, empty when the position names no symbol.
   */
  references(filePath: string, position: LspPosition): LspLocation[] {
    return this.#locations(filePath, position, (fileName, offset) =>
      listOf(this.#service.getReferencesAtPosition(fileName, offset)))
  }

  /**
   * The implementation site(s) of the interface, abstract member, or type at a
   * position (`getImplementationAtPosition`).
   * @param filePath - absolute path of the file to query.
   * @param position - zero-based UTF-16 cursor position.
   * @returns the implementation locations, empty when the position names none.
   */
  implementation(filePath: string, position: LspPosition): LspLocation[] {
    return this.#locations(filePath, position, (fileName, offset) =>
      listOf(this.#service.getImplementationAtPosition(fileName, offset)))
  }

  /**
   * The hover for the symbol at a position: TypeScript's quick-info signature,
   * followed by its documentation when present.
   * @param filePath - absolute path of the file to query.
   * @param position - zero-based UTF-16 cursor position.
   * @returns the normalized hover, or `null` when the position names no symbol.
   */
  hover(filePath: string, position: LspPosition): LspHover | null {
    const fileName = resolve(filePath)
    const source = this.#program().getSourceFile(fileName)
    if (source === undefined) return null
    const offset = this.#offset(source, position)
    if (offset === undefined) return null
    const info = this.#service.getQuickInfoAtPosition(fileName, offset)
    if (info === undefined) return null
    const signature = ts.displayPartsToString(info.displayParts)
    const documentation = ts.displayPartsToString(info.documentation)
    const contents = documentation.length > 0 ? `${signature}\n\n${documentation}` : signature
    return { contents, range: this.#range(source, info.textSpan) }
  }

  /** Release the language service's program and document caches. */
  dispose(): void {
    this.#service.dispose()
  }
}
