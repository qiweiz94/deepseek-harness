// The hook seam itself.
//
// SPEC DEVIATION: the spec assumed a `prompt/construct` hook. No such event
// exists in this codebase (verified against packages/core and vendor/cordis).
// The real prompt-composition seam is `ctx.systemPrompt.section()` from
// `@deepseek-ai/dsh-system-prompt`, whose `text` is a PROVIDER re-invoked by
// `SystemPrompt.assemble()` on every assembly. These tests pin that mechanism:
// the block reaches a constructed prompt, and it is rebuilt from live store
// state each time rather than captured once at registration.
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import * as PluginPinnedScratchpad from '@deepseek-ai/dsh-plugin-pinned-scratchpad'
import { apply, SECTION_NAME, SECTION_ORDER } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { estimateTokens } from '../src/store.ts'

/** Mount the plugin over a minimal real composition (no Loader indirection). */
async function mount(config?: Config): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  // `undefined` exercises apply()'s own parameter default; a value exercises
  // the configured branch of each `?? DEFAULT` fallback.
  if (config === undefined) await ctx.plugin(PluginPinnedScratchpad)
  else await ctx.plugin(PluginPinnedScratchpad, config)
  return ctx
}

/** Call `scratchpad_update`, returning the full execution result. */
async function call(ctx: Context, id: string, key: string, value: string | null) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(id),
    name: 'scratchpad_update',
    arguments: { key, value },
  })
}

/** Call `scratchpad_update` and fail loud unless it succeeded. */
async function set(ctx: Context, id: string, key: string, value: string | null): Promise<void> {
  const result = await call(ctx, id, key, value)
  if (result.isError) throw new Error(`scratchpad_update failed: ${JSON.stringify(result)}`)
}

/** The assembled, interpolated system prompt for this context. */
async function prompt(ctx: Context): Promise<string> {
  return renderPrompt(await ctx.systemPrompt.assemble())
}

/** The joined text of a tool result's content blocks (what the model reads). */
function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
}

describe('the pinned block reaches a constructed prompt', () => {
  it('registers one section at the documented slot', async () => {
    const ctx = await mount()
    await set(ctx, 'p1', 'task', 'ship the lane')
    const assembly = await ctx.systemPrompt.assemble()
    const section = assembly.sections.find(s => s.name === SECTION_NAME)
    expect(section).toBeDefined()
    expect(section?.text).toContain('task: ship the lane')
    expect(SECTION_NAME).toBe('agent:scratchpad')
    expect(SECTION_ORDER).toBe(200)
  })

  it('renders the tagged block into the interpolated prompt', async () => {
    const ctx = await mount()
    await set(ctx, 'p2', 'task', 'ship the lane')
    const text = await prompt(ctx)
    expect(text).toContain('<agent_scratchpad>\ntask: ship the lane\n</agent_scratchpad>')
  })

  it('places the volatile block after the stable sections', async () => {
    const ctx = await mount()
    await set(ctx, 'p3', 'task', 'ship the lane')
    const assembly = await ctx.systemPrompt.assemble()
    const index = assembly.sections.findIndex(s => s.name === SECTION_NAME)
    expect(index).toBe(assembly.sections.length - 1)
  })

  it('contributes an empty section that renderPrompt drops while nothing is pinned', async () => {
    const ctx = await mount()
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.find(s => s.name === SECTION_NAME)?.text).toBe('')
    expect(renderPrompt(assembly)).not.toContain('agent_scratchpad')
  })
})

describe('the block is re-derived on every assembly, not captured once', () => {
  it('reflects a write made after the section was registered', async () => {
    const ctx = await mount()
    expect(await prompt(ctx)).not.toContain('agent_scratchpad')
    await set(ctx, 'r1', 'task', 'first')
    expect(await prompt(ctx)).toContain('task: first')
    await set(ctx, 'r2', 'task', 'second')
    const text = await prompt(ctx)
    expect(text).toContain('task: second')
    expect(text).not.toContain('task: first')
  })

  it('reinjects identically across repeated assemblies with no writes between them', async () => {
    // This is what makes the block un-compactable: compaction rewrites the
    // message log, and the next turn's assembly rebuilds this text from the
    // live store regardless of what the log now contains. Assembly reads no
    // message history at all, so there is nothing for compaction to remove.
    const ctx = await mount()
    await set(ctx, 'c1', 'task', 'survive the compaction')
    const before = await prompt(ctx)
    const afterFirst = await prompt(ctx)
    const afterSecond = await prompt(ctx)
    expect(afterFirst).toBe(before)
    expect(afterSecond).toBe(before)
    expect(afterSecond).toContain('task: survive the compaction')
  })

  it('drops the least recently written entry when the budget overflows', async () => {
    // 25 tokens is exactly the marker plus the surviving line (the marker
    // itself is ~13 tokens, so a budget must clear that floor to show anything).
    const ctx = await mount({ maxTokens: 25 })
    await set(ctx, 'b1', 'old', 'x'.repeat(200))
    await set(ctx, 'b2', 'new', 'keep')
    const text = await prompt(ctx)
    expect(text).toContain('new: keep')
    expect(text).not.toContain('xxx')
    expect(text).toContain('earlier entry dropped')
  })

  it('a rewritten key is not the one evicted', async () => {
    const ctx = await mount({ maxTokens: 26 })
    await set(ctx, 'e1', 'a', 'a'.repeat(400))
    await set(ctx, 'e2', 'b', 'b'.repeat(400))
    // Rewriting "a" moves it behind "b", so "b" is now the oldest write.
    await set(ctx, 'e3', 'a', 'refreshed')
    const text = await prompt(ctx)
    expect(text).toContain('a: refreshed')
    expect(text).not.toContain('b: bbb')
  })
})

describe('apply() called directly, without schema-supplied defaults', () => {
  // Mounting through Cordis always runs Config, which fills both fields — so
  // apply()'s own `?? DEFAULT` fallbacks are only live for a direct call.
  // These pin the defaults that signature promises.
  async function applyDirectly(): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    apply(ctx)
    return ctx
  }

  it('defaults the block budget to 250 tokens', async () => {
    const ctx = await applyDirectly()
    for (let index = 0; index < 60; index += 1) {
      await set(ctx, `dt-${index}`, `key-${index}`, `note number ${index} for the default-budget check`)
    }
    const assembly = await ctx.systemPrompt.assemble()
    const section = assembly.sections.find(s => s.name === SECTION_NAME)
    expect(section?.text).toContain('key-59')
    expect(estimateTokens(section?.text ?? '')).toBeLessThanOrEqual(250)
    // The cap actually bit, so this measures the default rather than a small input.
    expect(section?.text).toContain('dropped: scratchpad token budget')
  })

  it('defaults the per-value ceiling to 4,000 bytes', async () => {
    const ctx = await applyDirectly()
    const ok = await call(ctx, 'dv1', 'fits', 'z'.repeat(4000))
    expect(ok.isError).toBe(false)
    const tooBig = await call(ctx, 'dv2', 'huge', 'z'.repeat(4001))
    expect(tooBig.isError).toBe(true)
    expect(resultText(tooBig)).toContain('exceeding the 4000-byte limit')
  })
})

describe('scratchpad_update results and presentation', () => {
  it('reports the set action and renders a confirmation', async () => {
    const ctx = await mount()
    const result = await call(ctx, 's1', 'task', 'ship')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(result.value).toEqual({ key: 'task', action: 'set', entries: 1, dropped: 0 })
    expect(resultText(result)).toBe('Pinned "task". 1 entry pinned.')
  })

  it('pluralizes the pinned count', async () => {
    const ctx = await mount()
    await set(ctx, 's2a', 'a', '1')
    const result = await call(ctx, 's2b', 'b', '2')
    if (result.isError) throw new Error('expected success')
    expect(resultText(result)).toBe('Pinned "b". 2 entries pinned.')
  })

  it('reports a delete of an existing key', async () => {
    const ctx = await mount()
    await set(ctx, 'd1', 'task', 'ship')
    const result = await call(ctx, 'd2', 'task', null)
    if (result.isError) throw new Error('expected success')
    expect(result.value).toEqual({ key: 'task', action: 'deleted', entries: 0, dropped: 0 })
    expect(resultText(result)).toBe('Removed "task". 0 entries pinned.')
    expect(await prompt(ctx)).not.toContain('agent_scratchpad')
  })

  it('reports a delete of a key that was never set as missing', async () => {
    const ctx = await mount()
    const result = await call(ctx, 'd3', 'ghost', null)
    if (result.isError) throw new Error('expected success')
    expect(result.value).toEqual({ key: 'ghost', action: 'missing', entries: 0, dropped: 0 })
    expect(resultText(result)).toBe('No scratchpad entry named "ghost"; nothing removed. 0 entries pinned.')
  })

  it('names the singular and plural evicted-entry counts in the result prose', async () => {
    const ctx = await mount({ maxTokens: 25 })
    await set(ctx, 'v1', 'one', 'x'.repeat(200))
    const single = await call(ctx, 'v2', 'two', 'keep')
    if (single.isError) throw new Error('expected success')
    expect(resultText(single)).toContain('1 older entry is no longer shown (token budget).')

    await set(ctx, 'v3', 'three', 'y'.repeat(200))
    const plural = await call(ctx, 'v4', 'four', 'keep')
    if (plural.isError) throw new Error('expected success')
    expect(resultText(plural)).toContain('older entries are no longer shown (token budget).')
  })

  it('rejects a value over the byte limit instead of evicting the whole scratchpad', async () => {
    const ctx = await mount({ maxValueBytes: 16 })
    await set(ctx, 'x1', 'keep', 'small')
    const result = await call(ctx, 'x2', 'huge', 'z'.repeat(64))
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain('exceeding the 16-byte limit')
    // The rejected write left the existing scratchpad untouched.
    expect(await prompt(ctx)).toContain('keep: small')
  })

  it('measures the value limit in UTF-8 bytes, not characters', async () => {
    const ctx = await mount({ maxValueBytes: 8 })
    // Three 3-byte characters = 9 bytes, though only 3 characters.
    const result = await call(ctx, 'x3', 'cjk', '中文字')
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain('is 9 bytes')
  })

  it('presents a set as an edit and a delete as a delete', async () => {
    const ctx = await mount()
    const tool = ctx.tools.get('scratchpad_update') as ToolDefinition
    expect(tool.presentCall?.({ key: 'task', value: 'ship' })).toEqual({
      card: 'generic',
      title: 'Pin scratchpad note',
      kind: 'edit',
      rawInput: 'task',
    })
    expect(tool.presentCall?.({ key: 'task', value: null })).toEqual({
      card: 'generic',
      title: 'Remove scratchpad note',
      kind: 'delete',
      rawInput: 'task',
    })
  })

  it('exposes the union-typed value parameter in the model-facing schema', async () => {
    const ctx = await mount()
    const schema = ctx.tools.schemas().find(s => s.name === 'scratchpad_update')
    expect(schema).toBeDefined()
    expect(JSON.stringify(schema?.parameters)).toContain('null')
  })
})
