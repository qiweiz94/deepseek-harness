/**
 * An in-memory TypeScript `LanguageService` over a tsconfig's file set: the
 * navigation engine behind the `find_references` and `get_definition` tools.
 *
 * The file set is the transitive closure of the named config's own `fileNames`
 * AND every project reference it reaches. That transitivity is load-bearing in
 * this repository: `tsconfig.host.json` includes only tests, scripts, and the
 * website, and reaches all 190 package sources through `references` alone — a
 * host built on its `fileNames` would answer "no references" for every symbol
 * declared in a package source directory.
 *
 * The host is static: it reads each file once, keeps one snapshot version, and
 * never watches. One service instance therefore answers for one point in time;
 * the plugin builds it lazily on first use and disposes it with its fiber.
 * @module @deepseek-ai/dsh-plugin-lsp-references/src/service
 */

import { dirname, resolve } from 'node:path'
import ts from 'typescript'
import { ItemRetainer, truncateCodePoints } from '@deepseek-ai/dsh-output-retention'
import type { CodeLocation, DefinitionResult, ReferencesResult } from './types.ts'

/** A tsconfig's transitively resolved compilation inputs. */
export interface ProjectFileSet {
  /** Absolute file names, deduplicated across the reference graph, in first-seen order. */
  fileNames: string[]
  /** The root config's compiler options, used verbatim for the language service. */
  options: ts.CompilerOptions
}

/**
 * Resolve one tsconfig into the transitive closure of its own files and every
 * file reachable through `references`.
 *
 * A reference graph with diamonds (two configs referencing a third) is visited
 * once per config, so the walk terminates and the file list carries no
 * duplicates.
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
 * Read one file into a script snapshot, memoized in the caller's cache.
 *
 * Exported so the missing-file path stays directly exercisable: the language
 * service probes candidate module paths that may not exist, and a host that
 * threw there would fail the whole query instead of resolving the import
 * elsewhere.
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

/**
 * The text of the line starting at `lineStart`, without its line terminator.
 *
 * A sentinel newline is appended so the file's final line — which may carry no
 * terminator — needs no end-of-file special case.
 * @param source - the parsed source file.
 * @param lineStart - absolute offset of the line's first character.
 * @returns the line's raw text.
 */
function lineTextAt(source: ts.SourceFile, lineStart: number): string {
  const text = `${source.text}\n`
  return text.slice(lineStart, text.indexOf('\n', lineStart))
}

/**
 * Order locations by file, then line, then column, so a result reads as a
 * stable file-grouped list regardless of the order TypeScript reported it.
 * @param locations - the located positions, in language-service order.
 * @returns the same locations sorted in place.
 */
export function sortLocations(locations: CodeLocation[]): CodeLocation[] {
  return locations.sort((a, b) =>
    a.path.localeCompare(b.path) || a.line - b.line || a.character - b.character)
}

/** Construction inputs for a {@link ReferenceService}. */
export interface ReferenceServiceOptions {
  /** Path to the root tsconfig whose transitive file set defines the navigable workspace. */
  readonly tsconfigPath: string
  /** Largest number of reference locations retained in one `find_references` result. */
  readonly maxReferences: number
  /** Largest source-line preview, in Unicode code points, carried on one location. */
  readonly maxLineChars: number
}

/**
 * A disposable TypeScript language service scoped to one project file set.
 *
 * Positions crossing this boundary are 1-based line and 1-based UTF-16
 * character, matching the sibling `lsp` tool's cursor convention; the
 * TypeScript API's 0-based coordinates never leak out.
 */
export class ReferenceService {
  readonly #options: ReferenceServiceOptions
  readonly #fileNames: string[]
  readonly #fileSet: Set<string>
  readonly #snapshots = new Map<string, ts.IScriptSnapshot>()
  readonly #service: ts.LanguageService

  /** @param options - the project file set and the result budgets. */
  constructor(options: ReferenceServiceOptions) {
    this.#options = options
    const project = loadProjectFileSet(options.tsconfigPath)
    this.#fileNames = project.fileNames
    this.#fileSet = new Set(project.fileNames)
    const currentDirectory = dirname(resolve(options.tsconfigPath))
    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => this.#fileNames,
      // The host never reloads a file, so one version answers for its lifetime.
      getScriptVersion: () => '1',
      getScriptSnapshot: fileName => readSnapshot(fileName, this.#snapshots),
      getCurrentDirectory: () => currentDirectory,
      getCompilationSettings: () => project.options,
      getDefaultLibFileName: ts.getDefaultLibFilePath,
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
    }
    this.#service = ts.createLanguageService(host, ts.createDocumentRegistry())
  }

  /** Absolute file names this service can navigate, in first-seen order. */
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

  #sourceFile(path: string): { fileName: string; source: ts.SourceFile } {
    const fileName = resolve(path)
    if (!this.#fileSet.has(fileName)) {
      throw new Error(
        `${path} is not part of the ${this.#options.tsconfigPath} project file set; `
        + 'only files that project compiles can be navigated',
      )
    }
    const source = this.#program().getSourceFile(fileName)
    /* v8 ignore next 3 -- every name in the file set is a program root, so its source file is always loaded. */
    if (source === undefined) {
      throw new Error(`${path} is in the project file set but the TypeScript program did not load it`)
    }
    return { fileName, source }
  }

  #offset(source: ts.SourceFile, path: string, line: number, character: number): number {
    const lineCount = source.getLineStarts().length
    if (line < 1 || line > lineCount) {
      throw new Error(`line ${line} is out of range for ${path}: the file has ${lineCount} line(s) and positions are 1-based`)
    }
    if (character < 1) {
      throw new Error(`character ${character} is out of range for ${path}: positions are 1-based`)
    }
    const lineStart = source.getPositionOfLineAndCharacter(line - 1, 0)
    // Clamp past the line end rather than throwing: an off-symbol position is a
    // no-results answer, not a tool failure.
    return lineStart + Math.min(character - 1, lineTextAt(source, lineStart).length)
  }

  #locate(fileName: string, start: number): CodeLocation {
    const source = this.#program().getSourceFile(fileName)
    /* v8 ignore next 3 -- TypeScript only reports spans inside files its own program loaded. */
    if (source === undefined) {
      throw new Error(`the language service reported a position in ${fileName}, which the program did not load`)
    }
    const position = source.getLineAndCharacterOfPosition(start)
    const lineStart = source.getPositionOfLineAndCharacter(position.line, 0)
    return {
      path: fileName,
      line: position.line + 1,
      character: position.character + 1,
      text: truncateCodePoints(lineTextAt(source, lineStart).trim(), this.#options.maxLineChars),
    }
  }

  /**
   * Every reference to the symbol under a cursor, across the whole project file
   * set. The symbol's own declaration is included, matching the language
   * server protocol's `findReferences` contract.
   * @param path - the file to query, absolute or relative to the process cwd.
   * @param line - 1-based line of the cursor.
   * @param character - 1-based UTF-16 column of the cursor.
   * @returns the retained locations plus the pre-cap total.
   */
  findReferences(path: string, line: number, character: number): ReferencesResult {
    const { fileName, source } = this.#sourceFile(path)
    const offset = this.#offset(source, path, line, character)
    const entries = listOf(this.#service.getReferencesAtPosition(fileName, offset))
    const retainer = new ItemRetainer<CodeLocation>({ kind: 'head', maxItems: this.#options.maxReferences })
    for (const location of sortLocations(entries.map(entry => this.#locate(entry.fileName, entry.textSpan.start)))) {
      retainer.push(location)
    }
    const retained = retainer.finish()
    return {
      path,
      line,
      character,
      references: retained.items,
      total: retained.seen,
      truncated: retained.truncated,
    }
  }

  /**
   * The declaration anchor(s) of the symbol under a cursor. An overloaded
   * function or a merged interface legitimately declares more than one anchor.
   * @param path - the file to query, absolute or relative to the process cwd.
   * @param line - 1-based line of the cursor.
   * @param character - 1-based UTF-16 column of the cursor.
   * @returns the declaration locations, empty when the cursor is off-symbol.
   */
  getDefinition(path: string, line: number, character: number): DefinitionResult {
    const { fileName, source } = this.#sourceFile(path)
    const offset = this.#offset(source, path, line, character)
    const entries = listOf(this.#service.getDefinitionAtPosition(fileName, offset))
    const definitions = sortLocations(entries.map(entry => this.#locate(entry.fileName, entry.textSpan.start)))
    return { path, line, character, definitions }
  }

  /** Release the language service's program and document caches. */
  dispose(): void {
    this.#service.dispose()
  }
}
