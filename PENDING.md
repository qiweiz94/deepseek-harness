# PENDING — DSH fork open work

Last updated: 2026-08-22. master: `1bbef71d03`. Repo: `qiweiz94/deepseek-harness` (fork; UNPROTECTED — merge on static-green + verify locally).
Full narrative + rationale: see `HANDOFF.md` (root) and the memory file `project_dsh_fork_audit_ci_backlog_2026-08-21.md`.

Fork CI is currently RED on master. The audit/CI backlog fixes themselves are CONFIRMED green on CI; the red is one regression I introduced plus pre-existing breakage. Ranked by priority:

## P0 — Regression I introduced (fix first)

- [ ] **Web snapshots broken in lib mode by #48/#92.** 5 files fail `TypeError: The URL must be of scheme file` at `apps/web/tests/support.ts:34` (`DIST_INDEX = fileURLToPath(new URL('../dist/index.html', import.meta.url))`): `built-boot`, `image-display`, `max-tokens-notice`, `search-card`, `todo-row` (`.snapshot.ts`).
  - Only fails in **`DSH_EXAMPLE_MODE=lib`** (`vitest.snapshot.config.ts:58` includes web snapshots only in lib mode; and the `web browser snapshot` gate).
  - Bisected: GREEN at `38f12d9b36` (pre-#48) → RED at `a6f77c27` (#92 merge, before #93/#94). The `DIST_INDEX` line is unchanged by #48 — only the exported `scaledTimeout` fn + wrapped timeout literals were added — so adding an export changed how `support.ts` loads in lib mode (`import.meta.url` no longer `file:`).
  - **Fix plan:** reproduce with `DSH_EXAMPLE_MODE=lib` locally (build lib + web dist, run one web snapshot); make `DIST_INDEX` robust to a non-file `import.meta.url`, or find why lib-mode bundles `support.ts` differently now. Evidence: Fork CI run `32530981849`.

## P1 — Pre-existing breakage (not from the backlog session)

- [ ] **Static lane: 3 generated-catalog gates fail** — `tool catalog`, `config catalog`, `module graph`. Already red at `38f12d9b36` (before the backlog work), from the broader 12-plugin sprint. Fix = regenerate the catalogs (find the gates' `--write`/refresh path in `scripts/run-gates.ts` / the generators), commit the regenerated goldens, confirm the static lane greens.

## P2 — Open issues (tracked, designed/blocked)

- [ ] **#65** — `UserPromptSubmit` deny drops the documented reason. **Fully designed** (posted on the issue): add `reason?` to `PreStepDecision.reject` (`packages/core/agent/src/runtime-types.ts:61`) and `TurnEndReasonMap.blocked` (`packages/core/session/src/types.ts:160`); precedent `AgentCancelCause.hook` (`session/types.ts:146`). It's a logged-core-type + `SESSION_FORMAT_VERSION` + model-visible⟺logged (needs a session event) change → own PR with full CI. A prior in-scope inject workaround made it worse (reason bled into next prompt) — do NOT repeat that.
- [ ] **#24** — 3 fork-authored fixtures don't replay on Linux; item 1 fixed+Linux-confirmed, item 2 fixed by #33, **item 3** (`examples/acp-agent/tests/snapshots/lsp-definition/workspace/lsp-server.mjs`) has no findable static OS cause (ASCII, no CRLF, no path/case refs). Needs a real **x86-64 Linux** replay artifact. Options: (a) the next fork-CI Linux run's artifact for that fixture; (b) run it on an x64 Linux box — see the SER9 task below. Do NOT blind-edit the golden.

## P3 — Infra (user chose "quick run now, runner later")

- [ ] **SER9 x64 Linux run for #24 (quick).** Blocked: the SER9 = `beelink-server` (100.78.97.113) is unreachable (tx/rx 0, tailscale link down or wrong host); the 4 online `spark-*` boxes are arm64 GB10 (wrong arch) and the tailnet SSH ACL rejects `nanoclaw`. Needs: power on an x64 Linux box + a working `ssh user@target` (specific user + my key authorized). Then: clone fork → `pnpm install` → `DSH_SNAPSHOT=replay pnpm run test:snapshot` scoped to `lsp-definition` → capture the x64-Linux diff.
- [ ] **SER9 persistent self-hosted runner (later).** Register a GitHub Actions self-hosted `linux,x64` runner on the fork (mirror upstream `ci.yml`'s `["self-hosted","linux","x64","vm-backup"]` pattern) and point a fork Linux lane at it. Optional.

## Done this session (closed + CI-confirmed) — for reference

CLOSED issues: #48, #50, #51, #23, #62, #64, #66, #67 (+ earlier #33, #47, #49, #61). PRs: #91 (#50), #92 (#48 — but see P0 regression), #93 (#51 config testTimeout 300s), #94 (#51/#23 workflow), #87–90 (#62/#64/#66/#67). CI-confirmed green on run `32530981849`: coverage (#23), headless (#50), acp/subagent (#51).
