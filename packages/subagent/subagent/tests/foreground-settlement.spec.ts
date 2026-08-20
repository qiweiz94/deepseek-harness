import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentRun } from '../src/index.ts'
import { outputValueText, settleForegroundRun } from '../src/index.ts'

function run(overrides: Partial<SubagentRun>): SubagentRun {
  return {
    id: SessionId('child'),
    localAgent: undefined,
    result: Promise.resolve({ output: [{ type: 'text' as const, text: 'partial' }], stopReason: 'completed' as const }),
    dispose: () => Promise.resolve(),
    ...overrides,
  }
}

describe('foreground settlement', () => {
  it('returns the child output as the tool value on completed', async () => {
    const output = [{ type: 'text' as const, text: 'answer' }]
    await expect(settleForegroundRun(run({
      result: Promise.resolve({ output, stopReason: 'completed' }),
    }))).resolves.toEqual({ kind: 'foreground', runId: SessionId('child'), output })
  })

  it.each([
    ['aborted', 'subagent run was cancelled'],
    ['error', 'subagent run failed'],
    ['max-tokens', 'subagent run hit its token limit before finishing'],
    ['refusal', 'subagent declined the task'],
    ['paused', 'subagent run ended abnormally (paused)'],
  ] as const)('maps the %s stop reason to a tool error preserving partial text', async (stopReason, headline) => {
    await expect(settleForegroundRun(run({
      result: Promise.resolve({ output: [{ type: 'text' as const, text: 'partial' }], stopReason: stopReason as never }),
    }))).rejects.toThrow(`${headline}\nPartial output before the run ended:\npartial`)
  })

  it('omits the partial-output suffix when the child produced no text', async () => {
    await expect(settleForegroundRun(run({
      result: Promise.resolve({ output: [], stopReason: 'aborted' }),
    }))).rejects.toThrow(/^subagent run was cancelled$/)
  })

  it('disposes the run and surfaces a lone disposal failure', async () => {
    await expect(settleForegroundRun(run({
      dispose: () => Promise.reject(new Error('reap failed')),
    }))).rejects.toThrow('reap failed')
  })

  it('keeps an independent result failure when disposal also fails', async () => {
    const settled = settleForegroundRun(run({
      result: Promise.reject(new Error('transport gone')),
      dispose: () => Promise.reject(new Error('reap failed')),
    }))
    await expect(settled).rejects.toBeInstanceOf(AggregateError)
    await expect(settled).rejects.toThrow('subagent run failed: Error: transport gone; dispose failed: Error: reap failed')
  })

  it('rethrows the result failure alone when disposal succeeds', async () => {
    let disposed = false
    await expect(settleForegroundRun(run({
      result: Promise.reject(new Error('transport gone')),
      dispose() { disposed = true; return Promise.resolve() },
    }))).rejects.toThrow(/^transport gone$/)
    expect(disposed).toBe(true)
  })
})

describe('outputValueText', () => {
  it('concatenates only well-formed text blocks', () => {
    expect(outputValueText([
      { type: 'text', text: 'a' },
      { type: 'image', data: 'ignored' },
      'ignored',
      42,
      null,
      ['ignored'],
      { type: 'text', text: 7 },
      { type: 'text', text: 'b' },
    ])).toBe('ab')
  })
})
