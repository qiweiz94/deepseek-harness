/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-session-retention`.
 * @module @deepseek-ai/dsh-session-retention/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-session-retention'

/** Cordis companion plugin name. */
export const name = 'session-retention-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: deletion outcomes are request-scoped return values
 * verified against real stores in tests; the runtime owns no event stream or
 * durable data whose relation could be observed continuously in-process.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
