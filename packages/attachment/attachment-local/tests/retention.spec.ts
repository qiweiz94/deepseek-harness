/**
 * Retention tests for the local attachment backend: `attachmentRetentionParticipant`
 * always reports `retains`/`retained` (content-addressed objects are never
 * deleted), and the store attaches it reactively to `ctx.sessionRetention`
 * whenever that service is present — at construction time, or later, once it
 * arrives — without routing through `ctx.plugin`/`ctx.inject` (this package's
 * own suite-wide test harness auto-mounts a competing `attachments` fixture on
 * the first `ctx.plugin`-family call made on a test root, which would deadlock
 * that call's own registration; see the constructor comment in `src/index.ts`).
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionRetentionRuntime from '@deepseek-ai/dsh-session-retention'
import LocalAttachmentStore, { ATTACHMENT_RETAINS_REASON, attachmentRetentionParticipant } from '../src/index.ts'

const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

async function freshDshHome(): Promise<string> {
  const dshHome = await mkdtemp(join(tmpdir(), 'dsh-attachment-retention-'))
  dirs.push(dshHome)
  return dshHome
}

describe('attachmentRetentionParticipant', () => {
  it('always retains: plan and deleteSession never remove content-addressed objects', async () => {
    const participant = attachmentRetentionParticipant()
    expect(participant.store).toBe('attachment-local')
    await expect(participant.plan(SessionId('any'))).resolves.toEqual({
      kind: 'retains', reason: ATTACHMENT_RETAINS_REASON,
    })
    await expect(participant.deleteSession(SessionId('any'))).resolves.toEqual({
      kind: 'retained', reason: ATTACHMENT_RETAINS_REASON,
    })
  })
})

describe('LocalAttachmentStore retention attachment', () => {
  it('attaches immediately when sessionRetention is already present', async () => {
    const ctx = new Context()
    new SessionRetentionRuntime(ctx)
    new LocalAttachmentStore(ctx, { dshHome: await freshDshHome() })
    await expect(ctx.sessionRetention.plan(SessionId('any'))).resolves.toMatchObject({
      stores: [{ store: 'attachment-local' }],
    })
  })

  it('attaches later, once sessionRetention arrives after construction', async () => {
    const ctx = new Context()
    new LocalAttachmentStore(ctx, { dshHome: await freshDshHome() })
    // Not yet composed: nothing to attach to.
    expect(ctx.get('sessionRetention')).toBeUndefined()
    new SessionRetentionRuntime(ctx)
    // The `internal/service` handler defers its attach to a microtask.
    await Promise.resolve()
    await expect(ctx.sessionRetention.plan(SessionId('any'))).resolves.toMatchObject({
      stores: [{ store: 'attachment-local' }],
    })
  })

  it('the retention effect disposes cleanly along with its context', async () => {
    const ctx = new Context()
    new SessionRetentionRuntime(ctx)
    new LocalAttachmentStore(ctx, { dshHome: await freshDshHome() })
    await expect(ctx.sessionRetention.plan(SessionId('any'))).resolves.toMatchObject({
      stores: [{ store: 'attachment-local' }],
    })
    // Disposing the shared root tears down both services' effects, including
    // the retention attachment's `internal/service` listener and its
    // participant registration.
    await ctx.fiber.dispose()
  })
})
