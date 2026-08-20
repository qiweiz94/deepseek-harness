import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  appendReportMailbox,
  redeliverSubagentReports,
  SUBAGENT_REPORT_MAILBOX_VERSION,
  undeliveredSubagentReports,
} from '../src/report-mailbox.ts'
import type { SubagentReportMailboxData } from '../src/report-mailbox.ts'

function buildMessage(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

function mailboxRecord(
  delivery: SubagentReportMailboxData['delivery'],
  message: UserMessage,
  version = SUBAGENT_REPORT_MAILBOX_VERSION,
): SubagentReportMailboxData {
  return { version, delivery, message }
}

describe('appendReportMailbox', () => {
  it('appends a versioned mailbox record carrying the delivery policy and framed message', () => {
    const session = Session.create(SessionId('parent'))
    const message = buildMessage('the report')
    appendReportMailbox(session, message, 'wakeup')
    const appended = session.events.at(-1)!
    expect(appended.type).toBe('subagent/report')
    expect(appended.data).toEqual(mailboxRecord('wakeup', message))
  })

  it('throws and appends nothing when the message does not survive the lossless JSON log boundary', () => {
    const session = Session.create(SessionId('parent'))
    const hostile = {
      ...buildMessage('bad'),
      content: [{ type: 'text' as const, text: Number.NaN as unknown as string }],
    }
    expect(() => { appendReportMailbox(session, hostile, 'quiet') }).toThrow(/not JSON-serializable/)
    expect(session.events).toHaveLength(0)
  })
})

describe('undeliveredSubagentReports', () => {
  it('excludes a record whose message id a later user/message event claims', () => {
    const session = Session.create(SessionId('parent'))
    const message = buildMessage('claimed')
    session.append('subagent/report', mailboxRecord('wakeup', message))
    session.append('user/message', message, { surfaceOp: 'append' })
    expect(undeliveredSubagentReports(session.events, 0)).toEqual([])
  })

  it('returns a record no later user/message event claims', () => {
    const session = Session.create(SessionId('parent'))
    const message = buildMessage('undelivered')
    session.append('subagent/report', mailboxRecord('quiet', message))
    expect(undeliveredSubagentReports(session.events, 0)).toEqual([mailboxRecord('quiet', message)])
  })

  it('excludes mailbox records at or before the seed boundary, keeping only this session\'s own suffix', () => {
    const session = Session.create(SessionId('parent'))
    session.append('subagent/report', mailboxRecord('wakeup', buildMessage('inherited')))
    const boundary = session.events.length
    const own = buildMessage('own')
    session.append('subagent/report', mailboxRecord('quiet', own))
    expect(undeliveredSubagentReports(session.events, boundary)).toEqual([mailboxRecord('quiet', own)])
  })

  it('skips records of another mailbox format version', () => {
    const session = Session.create(SessionId('parent'))
    session.append('subagent/report', mailboxRecord('wakeup', buildMessage('future-format'), SUBAGENT_REPORT_MAILBOX_VERSION + 1))
    expect(undeliveredSubagentReports(session.events, 0)).toEqual([])
  })

  it('leaves an unrelated event type untouched while folding', () => {
    const session = Session.create(SessionId('parent'))
    session.append('turn/start', { turn: 1 })
    const message = buildMessage('after unrelated event')
    session.append('subagent/report', mailboxRecord('quiet', message))
    expect(undeliveredSubagentReports(session.events, 0)).toEqual([mailboxRecord('quiet', message)])
  })
})

/**
 * A minimal Agent stand-in — redelivery only reaches `.id`, `.session.events`,
 * `.session.header.seedLength`, `.inbox.{nextTurn,nextStep}`, `.followup()`,
 * and `.inject()`.
 */
function fakeAgent(options: {
  events?: readonly SessionEvent[]
  seedLength?: number
  nextTurn?: readonly UserMessage[]
  nextStep?: readonly UserMessage[]
} = {}): { agent: Agent; followup: ReturnType<typeof vi.fn>; inject: ReturnType<typeof vi.fn> } {
  const followup = vi.fn()
  const inject = vi.fn()
  const agent = {
    id: SessionId('resumed-parent'),
    session: {
      events: options.events ?? [],
      header: { seedLength: options.seedLength },
    },
    inbox: {
      nextTurn: options.nextTurn ?? [],
      nextStep: options.nextStep ?? [],
    },
    followup,
    inject,
  } as unknown as Agent
  return { agent, followup, inject }
}

describe('redeliverSubagentReports', () => {
  it('resends a pending wakeup record through followup, reusing its message id', () => {
    const message = buildMessage('undelivered')
    const session = Session.create(SessionId('parent'))
    session.append('subagent/report', mailboxRecord('wakeup', message))
    const { agent, followup, inject } = fakeAgent({ events: session.events })
    const warn = vi.fn()

    redeliverSubagentReports(agent, warn)

    expect(followup).toHaveBeenCalledWith(message)
    expect(inject).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('resends a pending quiet record through inject', () => {
    const message = buildMessage('undelivered')
    const session = Session.create(SessionId('parent'))
    session.append('subagent/report', mailboxRecord('quiet', message))
    const { agent, followup, inject } = fakeAgent({ events: session.events })
    const warn = vi.fn()

    redeliverSubagentReports(agent, warn)

    expect(inject).toHaveBeenCalledWith(message)
    expect(followup).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('honors an explicit header seedLength, redelivering only the resumed session\'s own suffix', () => {
    const session = Session.create(SessionId('parent'))
    session.append('subagent/report', mailboxRecord('wakeup', buildMessage('inherited from the fork seed')))
    const boundary = session.events.length
    const own = buildMessage('this session\'s own report')
    session.append('subagent/report', mailboxRecord('wakeup', own))
    const { agent, followup } = fakeAgent({ events: session.events, seedLength: boundary })
    const warn = vi.fn()

    redeliverSubagentReports(agent, warn)

    expect(followup).toHaveBeenCalledTimes(1)
    expect(followup).toHaveBeenCalledWith(own)
    expect(warn).not.toHaveBeenCalled()
  })

  it('skips a record the replayed inbox already holds pending, on its first delivery', () => {
    const message = buildMessage('still queued')
    const session = Session.create(SessionId('parent'))
    session.append('subagent/report', mailboxRecord('wakeup', message))
    const { agent, followup, inject } = fakeAgent({ events: session.events, nextTurn: [message] })
    const warn = vi.fn()

    redeliverSubagentReports(agent, warn)

    expect(followup).not.toHaveBeenCalled()
    expect(inject).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns and moves on when a redelivery send fails, without throwing', () => {
    const message = buildMessage('undelivered')
    const session = Session.create(SessionId('parent'))
    session.append('subagent/report', mailboxRecord('wakeup', message))
    const { agent, followup } = fakeAgent({ events: session.events })
    followup.mockImplementation(() => { throw new Error('parent gone') })
    const warn = vi.fn<(text: string) => void>()

    expect(() => { redeliverSubagentReports(agent, warn) }).not.toThrow()

    expect(warn).toHaveBeenCalledTimes(1)
    const [text] = warn.mock.calls[0]!
    expect(text).toContain('was not redelivered')
    expect(text).toContain('parent gone')
  })

  const message = buildMessage('undelivered')
  const malformed: Array<[string, unknown]> = [
    ['an unsupported delivery policy', mailboxRecord('urgent' as SubagentReportMailboxData['delivery'], message)],
    ['a non-object message', { ...mailboxRecord('wakeup', message), message: 'not-an-object' }],
    ['a null message', { ...mailboxRecord('wakeup', message), message: null }],
    ['a message missing its id', { ...mailboxRecord('wakeup', message), message: (({ id: _id, ...rest }) => rest)(message) }],
    ['a message with the wrong role', { ...mailboxRecord('wakeup', message), message: { ...message, role: 'assistant' } }],
    ['a message whose content is not an array', { ...mailboxRecord('wakeup', message), message: { ...message, content: 'not-an-array' } }],
    ['a message whose source is not an object', { ...mailboxRecord('wakeup', message), message: { ...message, source: 'not-an-object' } }],
  ]

  it.each(malformed)('reports and skips a record with %s instead of redelivering', (_label, record) => {
    const session = Session.create(SessionId('parent'))
    session.append('subagent/report', record as SubagentReportMailboxData)
    const { agent, followup, inject } = fakeAgent({ events: session.events })
    const warn = vi.fn()

    redeliverSubagentReports(agent, warn)

    expect(followup).not.toHaveBeenCalled()
    expect(inject).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('corrupt'))
  })
})
