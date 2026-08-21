/**
 * `find_references` and `get_definition` tools: precise TypeScript symbol
 * navigation over a project's transitive file set, so the model can find every
 * cross-package caller of a symbol — or its exact declaration anchor — without
 * guessing from textual matches. Named exports preserve loader injection metadata.
 * @module @deepseek-ai/dsh-plugin-lsp-references
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { ReferenceService } from './service.ts'
import type { CodeLocation, DefinitionResult, ReferencesResult } from './types.ts'

export const name = 'plugin-lsp-references'
export const inject = ['tools']

/** Author-facing schema for one resolved source position, shared by both output schemas. */
const LOCATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true, description: 'Absolute path of the file the position lives in.' },
    line: { type: 'integer', required: true, description: '1-based line of the position.' },
    character: { type: 'integer', required: true, description: '1-based UTF-16 column of the position.' },
    text: { type: 'string', required: true, description: "The position's source line, whitespace-trimmed and length-capped." },
  },
} as const satisfies ValueSchemaSpec

/** Cursor-position input parameters, shared by both tools. */
const CURSOR_PARAMS = {
  path: { type: 'string', required: true, description: 'Path to a TypeScript file in the project, absolute or relative to the working directory.' },
  line: { type: 'integer', required: true, description: '1-based line of the cursor.' },
  character: { type: 'integer', required: true, description: '1-based UTF-16 column of the cursor.' },
} as const

/** Queried-position echo fields, shared by both output schemas. */
const QUERIED_POSITION_PROPS = {
  path: { type: 'string', required: true, description: 'The queried file path.' },
  line: { type: 'integer', required: true, description: 'The queried 1-based line.' },
  character: { type: 'integer', required: true, description: 'The queried 1-based UTF-16 column.' },
} as const

/** Configuration for the symbol-navigation tools. */
export interface Config {
  /**
   * Root tsconfig whose transitive file set defines what can be navigated
   * (default `tsconfig.host.json`, resolved against the process cwd).
   */
  tsconfigPath?: string
  /** Retain at most this many reference locations per call (default 200). */
  maxReferences?: number
  /** Cap each location's source-line preview at this many characters (default 200). */
  maxLineChars?: number
}

/** Runtime configuration schema for the symbol-navigation plugin. */
export const Config: z<Config> = z.object({
  tsconfigPath: z.string().default('tsconfig.host.json'),
  maxReferences: z.number().step(1).min(1).default(200),
  maxLineChars: z.number().step(1).min(1).default(200),
})

/** One rendered location line: `path:line:character  source text`. */
function formatLocation(location: CodeLocation): string {
  return `${location.path}:${location.line}:${location.character}  ${location.text}`
}

/**
 * Render the canonical references value as model-facing prose: a count line
 * naming the query, then one line per retained location.
 * @param result - the validated references value.
 * @returns the text block describing every found reference.
 */
function formatReferences(result: ReferencesResult): string {
  const head = `${result.total} reference${result.total === 1 ? '' : 's'} to the symbol at ${result.path}:${result.line}:${result.character}`
  const notice = result.truncated
    ? `\n${result.total - result.references.length} further reference(s) omitted by the result cap; narrow the query or raise maxReferences.`
    : ''
  return `${head}\n${result.references.map(location => formatLocation(location)).join('\n')}${notice}`
}

/**
 * Render the canonical definition value as model-facing prose: a count line
 * naming the query, then one line per declaration anchor.
 * @param result - the validated definition value.
 * @returns the text block describing every declaration anchor.
 */
function formatDefinitions(result: DefinitionResult): string {
  const head = `${result.definitions.length} declaration${result.definitions.length === 1 ? '' : 's'} of the symbol at ${result.path}:${result.line}:${result.character}`
  return `${head}\n${result.definitions.map(location => formatLocation(location)).join('\n')}`
}

/**
 * Register the symbol-navigation tools on `ctx.tools`.
 *
 * The language service is built on FIRST use, not at apply time: resolving a
 * project reference graph and parsing its sources is real work that a boot which
 * never navigates must not pay. The fiber's disposal releases it.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - the resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  // Every field carries a schema default, so the validated config is total.
  const options = config as Required<Config>
  let service: ReferenceService | undefined
  const navigator = (): ReferenceService => {
    service ??= new ReferenceService(options)
    return service
  }
  ctx.effect(() => () => {
    service?.dispose()
    service = undefined
  }, 'plugin-lsp-references: language service')

  ctx.tools.register(defineTool({
    name: 'find_references',
    description: 'Find every reference to the TypeScript symbol under a cursor — callers, importers, and '
      + 'implementations — across the whole project file set, not just the file you name. Positions are '
      + '1-based line and 1-based UTF-16 character; the symbol\'s own declaration is included. Use it '
      + 'before changing a symbol, when a textual search would be ambiguous. An off-symbol position '
      + 'returns no references rather than failing.',
    parameters: CURSOR_PARAMS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...QUERIED_POSITION_PROPS,
          references: {
            type: 'array',
            required: true,
            description: 'Retained reference locations, ordered by file, line, then column.',
            items: LOCATION_SCHEMA,
          },
          total: { type: 'integer', required: true, description: 'References found before the result cap applied.' },
          truncated: { type: 'boolean', required: true, description: 'Whether the result cap omitted references from the list.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatReferences(value) }],
      presentationMeta: (_args, value) => ({ references: value }),
    },
    execute: (args): Promise<ReferencesResult> =>
      Promise.resolve(navigator().findReferences(args.path, args.line, args.character)),
    presentCall: args => ({
      card: 'generic',
      title: 'Find references',
      kind: 'search',
      rawInput: `${args.path}:${args.line}:${args.character}`,
      locations: [{ path: args.path, line: args.line }],
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'get_definition',
    description: 'Resolve the TypeScript symbol under a cursor to its exact declaration anchor. Positions are '
      + '1-based line and 1-based UTF-16 character. An overloaded function or a merged interface reports '
      + 'one anchor per declaration; an off-symbol position returns none rather than failing.',
    parameters: CURSOR_PARAMS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...QUERIED_POSITION_PROPS,
          definitions: {
            type: 'array',
            required: true,
            description: 'Declaration anchors, ordered by file, line, then column.',
            items: LOCATION_SCHEMA,
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatDefinitions(value) }],
      presentationMeta: (_args, value) => ({ definitions: value }),
    },
    execute: (args): Promise<DefinitionResult> =>
      Promise.resolve(navigator().getDefinition(args.path, args.line, args.character)),
    presentCall: args => ({
      card: 'generic',
      title: 'Get definition',
      kind: 'search',
      rawInput: `${args.path}:${args.line}:${args.character}`,
      locations: [{ path: args.path, line: args.line }],
    }),
  }))
}

export type * from './types.ts'
