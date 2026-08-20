/**
 * Canonical value shapes the `find_references` / `get_definition` tools return
 * and the {@link module:@deepseek-ai/dsh-plugin-lsp-references/src/service}
 * layer produces. Types only: no runtime code lives here.
 * @module @deepseek-ai/dsh-plugin-lsp-references/src/types
 */

/** One resolved source position: a file, a 1-based cursor, and that line's text. */
export interface CodeLocation {
  /** The file the position lives in, as the service resolved it. */
  path: string
  /** 1-based line of the position. */
  line: number
  /** 1-based UTF-16 column of the position. */
  character: number
  /** The position's source line, trailing whitespace trimmed and length-capped. */
  text: string
}

/** The canonical `find_references` value: the query echo plus the retained locations. */
export interface ReferencesResult {
  /** The queried file path, as the model supplied it. */
  path: string
  /** The queried 1-based line. */
  line: number
  /** The queried 1-based UTF-16 column. */
  character: number
  /** Retained reference locations in path, line, character order. */
  references: CodeLocation[]
  /** References the query found before the retention cap applied. */
  total: number
  /** Whether the retention cap omitted references from {@link ReferencesResult.references}. */
  truncated: boolean
}

/** The canonical `get_definition` value: the query echo plus every declaration anchor. */
export interface DefinitionResult {
  /** The queried file path, as the model supplied it. */
  path: string
  /** The queried 1-based line. */
  line: number
  /** The queried 1-based UTF-16 column. */
  character: number
  /** Declaration anchors in path, line, character order; more than one for an overloaded or merged symbol. */
  definitions: CodeLocation[]
}
