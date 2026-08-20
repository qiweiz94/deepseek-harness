/**
 * `scratchpad_update` tool plus the pinned `<agent_scratchpad>` prompt block:
 * a small key/value store the model maintains itself, re-rendered into the
 * system prompt before every turn under a hard token budget. Named exports
 * preserve loader injection metadata.
 *
 * ## Injection seam
 *
 * There is NO `prompt/construct` hook in this codebase. The real
 * prompt-composition seam is `@deepseek-ai/dsh-system-prompt`: a plugin
 * registers an ordered section whose `text` is a PROVIDER, and
 * `SystemPrompt.assemble()` re-invokes every provider on each assembly (once
 * per turn) before running the `system-prompt/assemble` waterfall. Registering
 * the section — rather than adding a waterfall listener — is what makes the
 * block un-compactable: the rendered text is produced during assembly and
 * never enters the session event log, so compaction, which prunes and
 * checkpoints that log, has nothing of ours to remove. Every turn re-reads the
 * live store, so the block is reconstructed after a compaction exactly as
 * before it.
 * @module @deepseek-ai/dsh-plugin-pinned-scratchpad
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { renderScratchpad, ScratchpadStore } from './store.ts'

export const name = 'plugin-pinned-scratchpad'
export const inject = ['tools', 'systemPrompt']

/** Prompt-section name; a composition may shadow this slot by re-using the name. */
export const SECTION_NAME = 'agent:scratchpad'

/**
 * Prompt order of the scratchpad block. Deliberately after the tool-guidance
 * band (100–199): the block is the most volatile text in the prompt, so
 * placing it last keeps every stable section ahead of it byte-identical
 * between turns.
 */
export const SECTION_ORDER = 200

/** Budget ceiling when the config omits it (the specified 250-token cap). */
const DEFAULT_MAX_TOKENS = 250

/** Per-value size ceiling when the config omits it. */
const DEFAULT_MAX_VALUE_BYTES = 4_000

/** Configuration for the pinned scratchpad. */
export interface Config {
  /**
   * Estimated-token ceiling for the whole rendered block, tags and truncation
   * marker included (default 250).
   */
  maxTokens?: number
  /**
   * Reject a single `value` larger than this many UTF-8 bytes (default 4,000),
   * so one oversized write cannot evict the entire scratchpad at render time.
   */
  maxValueBytes?: number
}

/** Runtime configuration schema for the pinned scratchpad plugin. */
export const Config: z<Config> = z.object({
  maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
  maxValueBytes: z.number().step(1).min(1).default(DEFAULT_MAX_VALUE_BYTES),
})

/** One `scratchpad_update` result, as the model sees it. */
interface UpdateResult {
  key: string
  action: string
  entries: number
  dropped: number
}

/** Render the tool result as the short confirmation prose the model reads. */
function formatResult(value: UpdateResult): string {
  const head = value.action === 'set'
    ? `Pinned "${value.key}".`
    : value.action === 'deleted'
      ? `Removed "${value.key}".`
      : `No scratchpad entry named "${value.key}"; nothing removed.`
  const evicted = value.dropped > 0
    ? ` ${value.dropped} older entr${value.dropped === 1 ? 'y is' : 'ies are'} no longer shown (token budget).`
    : ''
  return `${head} ${value.entries} entr${value.entries === 1 ? 'y' : 'ies'} pinned.${evicted}`
}

/**
 * Register `scratchpad_update` on `ctx.tools` and the pinned block on
 * `ctx.systemPrompt`.
 * @param ctx - registrant context carrying the tool registry and prompt registry.
 * @param config - the validated plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS
  const maxValueBytes = config.maxValueBytes ?? DEFAULT_MAX_VALUE_BYTES
  const store = new ScratchpadStore()

  // The provider closes over the live store, so each assembly re-reads current
  // state. This is the whole un-compactable mechanism (see the module note).
  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: () => renderScratchpad(store.entries(), maxTokens).text,
  })

  ctx.tools.register(defineTool({
    name: 'scratchpad_update',
    description: 'Pin a short, durable note to your own scratchpad, or remove one. The scratchpad is '
      + 'redrawn into your prompt before every turn and survives conversation compaction, so it is where '
      + 'you keep facts you must not lose: the task you were given, a decision you made and why, a path '
      + 'or identifier you will need later. Pass a string `value` to set or replace a key, or null to '
      + 'delete it. Keep entries short — the whole scratchpad is capped, and when it overflows your '
      + 'LEAST RECENTLY WRITTEN entries are dropped first. Re-writing a key refreshes it, so a note you '
      + 'keep updating is never the one evicted.',
    parameters: {
      key: {
        type: 'string',
        required: true,
        description: 'Short stable name for this note, e.g. "task" or "build-command". Re-using a key replaces its value.',
      },
      value: {
        required: true,
        description: 'The note text, or null to delete the key.',
        oneOf: [
          { type: 'string', description: 'The note text; replaces any current value for this key.' },
          { type: 'null', description: 'Delete this key from the scratchpad.' },
        ],
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          key: { type: 'string', required: true, description: 'The key that was written or removed.' },
          action: {
            type: 'string',
            required: true,
            enum: ['set', 'deleted', 'missing'],
            description: 'What happened: the key was set/replaced, deleted, or did not exist.',
          },
          entries: { type: 'integer', required: true, description: 'How many entries are pinned after this call.' },
          dropped: {
            type: 'integer',
            required: true,
            description: 'How many of the oldest entries the token budget currently hides from the prompt block.',
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatResult(value) }],
      presentationMeta: (_args, value) => ({ scratchpad: value }),
    },
    // The registry's execute contract is asynchronous; every write here is a
    // synchronous in-memory mutation, so nothing is awaited.
    // eslint-disable-next-line @typescript-eslint/require-await
    async execute(args) {
      if (args.value !== null) {
        const bytes = Buffer.byteLength(args.value, 'utf8')
        if (bytes > maxValueBytes) {
          throw new Error(`scratchpad value for "${args.key}" is ${bytes} bytes, exceeding the ${maxValueBytes}-byte limit; store a shorter note or a pointer to the full text`)
        }
      }
      const action = store.write(args.key, args.value)
      const { dropped } = renderScratchpad(store.entries(), maxTokens)
      return { key: args.key, action, entries: store.size, dropped }
    },
    presentCall: args => ({
      card: 'generic',
      title: args.value === null ? 'Remove scratchpad note' : 'Pin scratchpad note',
      kind: args.value === null ? 'delete' : 'edit',
      rawInput: args.key,
    }),
  }))
}

export type { RenderedScratchpad, ScratchpadEntry, WriteAction } from './store.ts'
