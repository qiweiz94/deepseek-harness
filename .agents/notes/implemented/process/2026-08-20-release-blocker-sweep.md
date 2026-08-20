# Agent Note: Release-blocker sweep — stale FIXME, apiproxy version, attribution URL

Status: implemented

English | [中文](2026-08-20-release-blocker-sweep.zh.md)

## Problem

Three small pre-release blockers remained open beside the [migrator removal](2026-07-26-remove-packed-session-fixture-migrator.md), each cheap individually but each carrying a decision that needed recording: a stale rename FIXME in `packages/guard/timeout-policy/src/index.ts`, the hardcoded `version: '0.0.1'` placeholder in `host.describe` (`packages/host/apiproxy/src/api-proxy.ts`), and the `packages/llm/llm` Known Limitation stating `APP_IDENTITY.url` names a repository that does not exist.

## Decision

**Timeout-policy FIXME: deleted, no rename.** The FIXME asked to settle a `@deepseek-ai/dsh-timeout-guard` rename "at resolution time". The [naming contract and rename ledger](../architecture/2026-08-11-repository-naming-contract-and-rename-ledger.md) already resolved it: the package is `@deepseek-ai/dsh-tool-call-timeout-policy`, and its `guard/timeout-policy/` directory and `timeout-policy` plugin id are explicitly kept. The FIXME predated that decision; deleting it is the settlement, and re-litigating the ledger's choice would need a new proposal, not a marker.

**`host.describe` version: the lockstep workspace version from the package's own manifest.** Every harness package, the CLI app included, publishes at one workspace version, so `createRequire(import.meta.url)('../package.json')` — the exact pattern `packages/llm/llm/src/attribution.ts` already ships — reports the host application version without new seams. Reading `apps/cli`'s manifest was rejected: apiproxy cannot depend on an app, and any relative reach across workspace roots breaks under built `lib/`. Adding a `version` field to `ApiProxyDefaults` was rejected: it would push a constant every caller must thread through a surface already scheduled for replacement by the API plane.

**`APP_IDENTITY.url` limitation: removed as satisfied, value unchanged.** The limitation's own condition was reachability before release. `https://github.com/deepseek-ai/deepseek-harness` was verified public (GitHub API: `"private": false, "visibility": "public"`) on 2026-08-20, so the bullet is stale; the value already pointed at the canonical repository and does not change.

## Alternatives considered

**Track the URL limitation as an issue instead of removing it.** Rejected: the condition it guarded is verifiably met; an issue would track nothing.

**Rename to `dsh-timeout-guard` for role-word accuracy.** The ledger's own `Policy` row argues the plugin performs the mechanism, but the ledger weighed that after writing the row and still kept the name; overturning it belongs to a new proposed note with the full reference inventory, not a sweep.

## Verification

- `pnpm run typecheck` and the apiproxy, llm, and timeout-policy suites pass; no test or fixture pinned the old `'0.0.1'` value.
- The llm README pair no longer lists the URL limitation; translation pairing is re-recorded.
- `git grep 'dsh-timeout-guard'` finds only this note and the ledger's history.

## Consequences

`host.describe` reports the real release version and tracks the workspace version with no further maintenance. The timeout-guard question cannot resurface as a marker: reopening it requires a proposed note against the ledger. Removing the URL limitation leaves the llm package's remaining Known Limitations all current; a future repository move would be a new fact requiring its own change, not a revival of the old bullet.
