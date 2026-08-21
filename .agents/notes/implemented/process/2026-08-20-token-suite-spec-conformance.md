# Agent Note: Token-optimization suite specs — conformance disposition

Status: implemented

English | [中文](2026-08-20-token-suite-spec-conformance.zh.md)

## Problem

A set of externally-drafted "master prompts" (Phases 1–7 of an "Autonomous Token Optimization & Agent Resilience Suite") kept resurfacing as build requests. Their status lines were stale ("PR #15/#16"), their file inventories named modules that never shipped (`src/manager.ts`, `src/router.ts`), and their API references included seams that do not exist (`subagent/turn-end`, `ctx.subagents.abort()`, `@deepseek-ai/dsh-subagents`, `verify-md-links`). Without a recorded disposition, every future session risked re-scaffolding shipped packages or building against phantom APIs.

## Decision

The specs decompose as follows, and this note is their permanent close-out:

- **Phase 1 `plugin-ast-context` — SHIPPED.** `get_file_outline` + `get_directory_outline`, tree-sitter extractor, presentation cards; per-file coverage restored in PR #22; stale post-`meta.outline` goldens re-recorded in PR #26.
- **Phase 2 `plugin-subagent-router` — SHIPPED, design corrected.** Label→provider routing (`providers` + `routes[{label, providers}]`), fail-closed against defaults (PR #17), empty-label rejection + dedupe (PR #19), settlement extraction (PR #20). The spec's role→model-tier idea landed as per-route `agentOptions` (PR #27); `reasoningEffort` in `AgentOptions` is the remaining plumbing, owned by the subagent lane.
- **Phase 3 `plugin-worktree-sandbox` — SHIPPED.** `sandbox_exec` over `src/worktree.ts` (not `manager.ts`/`sandbox_run`); traversal-guarded ids (PR #17), lint + fixture-visibility fixes (PR #18), full failure-path coverage (PR #22), keyless isolation snapshot (PR #26).
- **Phase 4 `plugin-lsp-references` — REJECTED AS SPECIFIED.** The `lsp` capability seam already ships `goToDefinition`/`findReferences`/`goToImplementation`/`hover`; a parallel tool plugin would duplicate a capability against the seam rule. The genuine delta — an in-process TypeScript LanguageService **provider** for the existing seam — is queued as `lsp-typescript-inprocess`.
- **Phases 5–7 (`diagnostic-sifter`, `pinned-scratchpad`, `budget-governor`) — NOT PREVIOUSLY BUILT; in flight** on dedicated lanes, redesigned onto real seams: the sifter parses via pure fixture-tested heuristics; the scratchpad pins through `ctx.systemPrompt.section` (never compacted by construction) with a `todo/write`-style whole-store session event; the governor detects via `session/event` + `ctx.tokenMeter` on children identified from `subagent/start`, with enforcement only through a real cancellation seam.

## Alternatives considered

**Building the specs verbatim.** Re-scaffolds three shipped packages, duplicates the LSP capability, and codes against nonexistent events and services.

**Ignoring the specs.** Loses their two genuinely novel deltas (model-tier routing, the three resilience plugins) and leaves the stale prompts primed to mislead the next session.

## Consequences

The pasted specs are closed: shipped phases have their audit trail (PRs #17–#22, #26–#27), the rejected phase has its seam rationale, and the new phases proceed under repo-real designs. Any future "build the suite" request resolves against this note instead of the stale prompt text.
