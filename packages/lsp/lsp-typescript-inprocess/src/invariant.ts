/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-lsp-typescript-inprocess`.
 * @module @deepseek-ai/dsh-lsp-typescript-inprocess/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-lsp-typescript-inprocess'

/** Cordis companion plugin name. */
export const name = 'lsp-typescript-inprocess-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the in-memory language service and its snapshot cache are
 * private implementation state, and this provider publishes no independent
 * lifecycle event stream or enumerable snapshot to assert a relation over.
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
