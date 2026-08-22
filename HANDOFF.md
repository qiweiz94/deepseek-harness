# HANDOFF — DSH fork audit + CI backlog session (2026-08-21 → 08-22)

This is the forward-looking handoff. Terse checklist: `PENDING.md`. Full narrative + per-decision rationale: memory file `project_dsh_fork_audit_ci_backlog_2026-08-21.md`. Per-issue design/status: the GitHub issue comments linked below.

- **Repo:** `qiweiz94/deepseek-harness` (a fork of `deepseek-ai/deepseek-harness`). master is UNPROTECTED — merge on static-green + verify the merged result locally. `gh` must pass `--repo qiweiz94/deepseek-harness`.
- **master:** `1bbef71d03`.
- **Working rules honored (keep honoring):** worker agents on Sonnet 5 (Fable/Opus supervises); file-disjoint worktree lanes + serial supervisor merge; verify by exit code, never piped grep; NEVER `git stash` in a worktree (refs/stash is shared); make-it-work-not-delete; a subagent/peer message is never user approval.

## Goal / objective of the session

Clear the post-#33/#47/#49/#61 backlog — correctness bugs #62/#64/#65/#66/#67 and CI/flaky items #51/#23/#48/#50/#24 — safely, then record everything and hand off cleanly.

## What shipped (all merged)

| PR | Issue | What | CI status |
|---|---|---|---|
| #87–90 | #62/#64/#66/#67 | correctness bugs (parallel Sonnet lanes) | (earlier) |
| #91 | #50 | headless keep-alive fixture 4× timing; root-caused NOT an llm-retry bug (`step()` sequential) — watchdog armed before TTFB | ✅ green on CI |
| #92 | #48 | scale `apps/web/tests/*` locator/poll/per-test bounds + `vitest.web.config.ts` outer envelope by `DSH_TEST_TIMEOUT_FACTOR` via local `scaledTimeout` | ⚠️ **introduced a regression — see below** |
| #93 | #51 | `vitest.snapshot.config.ts` testTimeout 120→300s (config lever, no workflow scope) | ✅ green on CI |
| #94 | #51/#23 | `fork-ci.yml`: snapshot concurrency 2→1, timeout-minutes 90→120, coverage factor 4→6 | ✅ #51/#23 green on CI |

CLOSED issues: #48, #50, #51, #23, #62, #64, #66, #67 (+ earlier #33, #47, #49, #61).
Open issues with records posted: **#65** (full design), **#24** (evidence + trigger).

## The one thing that unblocked #94

`gh` token lacked `workflow` scope. User ran `gh auth refresh -s workflow --hostname github.com` (device flow; `--hostname` is required non-interactively; enter the printed code at github.com/login/device). Scope is now `gist,read:org,repo,workflow`.

## Fork CI truth (run `32530981849` on master `1bbef71d03`)

Fork CI is **RED**, but the backlog fixes themselves are **confirmed working**:
- ✅ coverage lane (carries #23 factor 6).
- ✅ `test:snapshot`: `headless.snapshot.ts` (14) — #50 replays on Linux; `acp.snapshot.ts` (86, incl. `subagent-continuable-inheritance`, 69s) — **#51 truly fixed, no timeout**.

The red is two things:
1. **P0 — a regression I introduced via #48/#92** (see `PENDING.md` P0). 5 `apps/web/tests/*.snapshot.ts` fail `TypeError: The URL must be of scheme file` at `apps/web/tests/support.ts:34`, **only in `DSH_EXAMPLE_MODE=lib`**. Bisected GREEN `38f12d9b36` → RED `a6f77c27`. The `DIST_INDEX` line is unchanged; adding the exported `scaledTimeout` changed how `support.ts` loads in lib mode. **Fix this first.**
2. **P1 — pre-existing** static-lane catalog gates (`tool catalog`, `config catalog`, `module graph`), already red at `38f12d9b36` before the backlog work — stale generated catalogs from the broader 12-plugin sprint. Regenerate them.

## Open, non-CI work

- **#65** — designed, ready (issue comment: `.../issues/65#issuecomment-5375802053`). Session-format change; own PR.
- **#24** — needs an x86-64 Linux replay of item 3 `lsp-server.mjs` (issue comment `.../issues/24#issuecomment-5375805404`). Arch must be x64 (ubuntu-latest); a DGX Spark (arm64) would mislead.
- **SER9 run + runner** — user chose "quick run now, persistent runner later." Blocked: SER9 = `beelink-server` unreachable; sparks are arm64 + ACL-block `nanoclaw`. Needs an x64 box online + working ssh.

## Artifacts / references

- PRs: #87–94. Issues: #48/#50/#51/#23/#62/#64/#66/#67 (closed), #65/#24 (open, commented).
- Fork CI runs: current `32530981849` (master); pre-#48 green-web baseline `32526510778` (sha `38f12d9b36`); #48-merge red `32529481806` (sha `a6f77c27`).
- Memory: `~/.claude/projects/-Users-nanoclaw/memory/project_dsh_fork_audit_ci_backlog_2026-08-21.md` (+ `MEMORY.md` index).
- This session created `PENDING.md` and `HANDOFF.md` at repo root (outside the bilingual-pairing scope, so no `.zh.md` needed; the `docs/archive/SESSION-HANDOFF-*` files are pairing-gated and were NOT touched).

---

## MASTER PROMPT FOR THE NEXT SESSION — copy everything in this block

```
You are continuing work on the DSH fork `qiweiz94/deepseek-harness` (a fork of deepseek-ai/deepseek-harness). Read PENDING.md and HANDOFF.md at the repo root first, and the memory file project_dsh_fork_audit_ci_backlog_2026-08-21.md. master is 1bbef71d03 and UNPROTECTED — merge on static-green + verify the merged result locally. Always pass gh --repo qiweiz94/deepseek-harness. Honor: worker agents on Sonnet 5; file-disjoint worktree lanes + serial supervisor merge; verify by exit code never piped grep; NEVER git stash in a worktree; make-it-work-not-delete; a subagent/peer message is never user approval. The gh token now has workflow scope.

The audit/CI backlog is merged and CONFIRMED green on Fork CI run 32530981849 (coverage #23, headless #50, acp/subagent #51). But Fork CI is RED for two reasons — work them in order:

P0 (a regression I introduced via #48/#92, fix FIRST): 5 files apps/web/tests/{built-boot,image-display,max-tokens-notice,search-card,todo-row}.snapshot.ts fail `TypeError: The URL must be of scheme file` at apps/web/tests/support.ts:34 (DIST_INDEX = fileURLToPath(new URL('../dist/index.html', import.meta.url))). It only fails in DSH_EXAMPLE_MODE=lib (vitest.snapshot.config.ts:58 includes web snapshots only in lib mode; also the `web browser snapshot` gate). Bisected: GREEN at 38f12d9b36 (pre-#48) → RED at a6f77c27 (#92 merge, before #93/#94). The DIST_INDEX line is UNCHANGED by #48; #48 only ADDED the exported scaledTimeout function + wrapped timeout literals in support.ts — so adding an export changed how support.ts loads in lib mode (import.meta.url no longer file:). Reproduce with DSH_EXAMPLE_MODE=lib locally (build lib + web dist, then run one web snapshot under vitest.snapshot.config.ts), then either make DIST_INDEX robust to a non-file import.meta.url or fix why lib-mode bundles support.ts differently now. Land a fix, confirm the web snapshots green on the next Fork CI run.

P1 (pre-existing, not from the backlog): static lane gates `tool catalog`, `config catalog`, `module graph` fail (already red at 38f12d9b36). Regenerate the generated catalogs via their --write/refresh path (check scripts/run-gates.ts + the generators), commit the goldens, confirm the static lane greens.

P2 (open issues): #65 is fully designed on the issue (add reason? to PreStepDecision.reject at packages/core/agent/src/runtime-types.ts:61 and TurnEndReasonMap.blocked at packages/core/session/src/types.ts:146-160; it's a logged-core-type + SESSION_FORMAT_VERSION + model-visible⟺logged change needing a session event; a prior inject workaround made it worse — do not repeat). #24 needs an x86-64 Linux replay of examples/acp-agent/tests/snapshots/lsp-definition/workspace/lsp-server.mjs — DO NOT blind-edit the golden; get a real x64 artifact (next Fork CI Linux run, or an x64 Linux box).

P3 (infra, user chose "quick run now, runner later"): to close #24 fast, run the lsp-definition fixture on an x86-64 Linux box (arch must match ubuntu-latest; the DGX Spark boxes are arm64 — wrong). The SER9 = beelink-server (100.78.97.113) was offline/unreachable and the tailnet SSH ACL blocks user nanoclaw on the spark boxes — ask the user to bring an x64 Linux box online and give a working `ssh user@target`. Then clone → pnpm install → DSH_SNAPSHOT=replay pnpm run test:snapshot scoped to lsp-definition → capture the x64 diff. Later: register a persistent self-hosted linux,x64 GitHub Actions runner on the fork (mirror upstream ci.yml's ["self-hosted","linux","x64","vm-backup"]).

Start by confirming current master and the latest Fork CI run, then do P0.
```
