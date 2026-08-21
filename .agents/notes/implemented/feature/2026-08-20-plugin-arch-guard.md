# Agent Note: Module-boundary guard plugin

Status: implemented

English | [中文](2026-08-20-plugin-arch-guard.zh.md)

## Problem

The monorepo's package-layering rules — architectural tier direction (foundation < capability < surface/plugin), the "plugins do not import each other unless declared" rule, package-graph acyclicity, and each package's exports map — are enforced only by the `check_module_boundary`-shaped conventions in `packages/AGENTS.md` and after the fact by human review and CI's dependency gates. A model writing a new cross-package import has no way to check, before writing it, whether the import is legal; it discovers a violation only when a gate later fails.

## Decision

`@deepseek-ai/dsh-plugin-arch-guard` registers one read-only model-facing tool, `check_module_boundary({ sourcePath, targetImport })`, that answers whether importing `targetImport` from `sourcePath` is legal under those four rules and, when blocked, names the rule and a suggestion. The workspace package graph is scanned once from `config.root` (default the process cwd) at mount time, not re-read per call. It injects only `tools`, registers no session events, and never writes.

This plugin arrived on a parallel branch (`feat/plugin-arch-guard`) without an Agent Note; this note is supplied at integration and the plugin was recreated on current master with the standard integrator wiring.

## Alternatives considered

**Re-scan the graph per call.** The package graph changes only when packages are added or their dependencies edited — rare relative to import checks — so a mount-time scan trades a small staleness window (a package added mid-session is unseen until remount) for not re-walking the tree on every call.

**A write-blocking tool that edits imports.** The guard is advisory by design: it answers a question the model asks before writing, leaving the write to the ordinary edit tools under their own permission and sandbox policy. Enforcement on write belongs to the fs/CI layer, not a read-only advisor.

## Consequences

A model can validate a cross-package import before writing it, turning a post-hoc CI failure into a pre-write answer. The verdict reflects the graph as of mount, so a package added later in the same session is not seen until the plugin is remounted. The tool has no state beyond its registry contribution and the cached graph.
