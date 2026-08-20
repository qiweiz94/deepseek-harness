/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-plugin-budget-governor`.
 *
 * The governor owns one relation nothing else can check: the breach verdict is
 * TERMINAL and it is EARNED. A run breaches at most once — a second breach for
 * the same subagent means the retire-on-breach latch stopped working and one
 * runaway is now an event storm — and every breach names a measurement that
 * strictly exceeds a positive bound, so a misconfigured or off-by-one budget
 * cannot report a healthy child as a runaway.
 * @module @deepseek-ai/dsh-plugin-budget-governor/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type {} from './index.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-plugin-budget-governor'

/** Cordis companion plugin name. */
export const name = 'plugin-budget-governor-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Assert the terminal, earned breach verdict on every published breach. */
const install: InvariantInstaller = (ctx, fail) => {
  const reported = new Set<string>()
  ctx.on('budget-governor/breach', (breach) => {
    if (breach.threshold < 1) {
      fail(`breach for subagent ${breach.subagentId} names a non-positive ${breach.kind} threshold ${breach.threshold}`)
    }
    if (breach.observed <= breach.threshold) {
      fail(
        `breach for subagent ${breach.subagentId} reports ${breach.kind} observed ${breach.observed}, `
        + `which does not exceed its threshold ${breach.threshold}`,
      )
    }
    if (reported.has(breach.subagentId)) {
      fail(`subagent ${breach.subagentId} was reported breached more than once; the first breach must retire the run`)
    }
    reported.add(breach.subagentId)
  })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
