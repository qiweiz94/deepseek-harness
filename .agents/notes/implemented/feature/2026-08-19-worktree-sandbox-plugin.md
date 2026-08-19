# Agent Note: Worktree sandbox plugin

Status: implemented

English | [中文](2026-08-19-worktree-sandbox-plugin.zh.md)

## Problem

A trial subagent run has no safe place to experiment: any command it runs can mutate the main working tree and current branch, and a discarded trial leaves partial changes behind. The harness also lacks a model-facing way to get a structured, bounded git diff of disposable experiment changes, so reviewing a trial requires manual diffing against the real tree.

## Decision

**A new model-facing plugin, `@deepseek-ai/dsh-plugin-worktree-sandbox`, registers one `sandbox_exec` tool** that runs a command inside an isolated git worktree. The worktree is created with `git worktree add --detach` from the configured base ref (default `HEAD`) under `<cwd>/.dsh/worktrees/subagent-<id>`, so it shares the object store but has its own working tree and index.

**The trial is disposable.** By default the worktree is removed with `git worktree remove --force` after the call, discarding the trial's uncommitted changes; the main tree and branch are never touched. `cleanup: false` keeps the worktree so a later call with the same `id` continues the same trial and its diff accumulates.

**The result is structured and bounded.** The tool returns `exitCode`/`signal`, bounded `stdout`/`stderr` (subprocess collect, tail retention), and the trial's `git diff`/`git diff --stat` plus `changedFiles` from `git status --porcelain`. The diff and stat run through the `@deepseek-ai/dsh-output-retention` `TextRetainer` (`head` strategy) at `maxOutputBytes` (default 15 KB), so the returned diff keeps its head with exact omission metadata.

**All processes go through `ctx.subprocess`.** Git and the `sh -c` command are spawned via the subprocess seam, so the plugin owns only orchestration and reporting; command defaulting, stream collection, and tree-scoped termination stay in the seam.

## Alternatives considered

**Run the trial in the main working tree with an auto-commit/rollback wrapper.** Rejected: it risks the real tree and branch state on every failure path and gives no clean diff boundary.

**Copy the repo to the OS temp dir.** Rejected: a copy breaks the git object store and remote/subbranch semantics and duplicates large histories; a git worktree shares the object store at near-zero cost.

**A git stash save/pop wrapper.** Rejected: stashes are global to the repo and cross-trial interference and failure-path recovery are fragile.

## Consequences

A composition loading the plugin exposes one `sandbox_exec` verb whose trial runs in a disposable detached worktree and returns a bounded structured diff plus exit status. Misconfiguration (a non-git `cwd`, a non-positive `maxOutputBytes`) fails loud at load or on `git rev-parse`. The tool is concurrency-safe because each trial owns a disjoint worktree and process tree. v1 is foreground-only; background/job trials, remote/shared clones, and automatic diff application to the real tree remain deferred.
