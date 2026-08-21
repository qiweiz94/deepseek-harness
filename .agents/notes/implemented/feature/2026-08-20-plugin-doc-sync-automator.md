# Agent Note: Bilingual doc-sync automator plugin

Status: implemented

English | [中文](2026-08-20-plugin-doc-sync-automator.zh.md)

## Problem

Every English doc under `docs/`, `.agents/notes/`, or a package README is paired with a `.zh.md` mirror and an `.i18n.yaml` consistency record, and `pnpm run verify-translation-pairing` fails the moment an English section changes without its mirror being brought along. Keeping the pair in sync by hand — splicing the changed section into the mirror, rewriting the record, and staying within the doc budget — is exactly the repetitive work that dominated the plugin-suite integration, and a model editing docs has no tool for it: it either does the multi-step splice by hand or leaves the pair silently drifting until the gate catches it later.

## Decision

`@deepseek-ai/dsh-plugin-doc-sync-automator` registers one model-facing tool, `sync_bilingual_pair({ docPath, updatedSection: { heading } })`, that splices a changed English section into its `.zh.md` mirror behind `NEEDS-TRANSLATION` markers (it does **not** translate — the spliced content is the exact English text), rewrites the `.i18n.yaml` record so the pairing gate accepts the result, and reports whether the mirror stays within its doc budget. `derivePairPaths` refuses an absolute or traversal `docPath` before any resolve, because the derived mirror and sidecar paths are written to — a repository-relative source path is the contract, and an escaping path is rejected fail-loud. The splice is refused if it would break the heading-axis structural correspondence, so a pre-existing pairing drift cannot be papered over. It injects only `tools` and reads/writes under `config.root` (default cwd).

This plugin arrived on a parallel branch (`feat/plugin-doc-sync-automator`) without an Agent Note and without the path-traversal guard; both are supplied at integration, and the plugin was recreated on current master with the standard integrator wiring.

## Alternatives considered

**Translate the section, not just splice it.** The harness has no offline translator and MT quality is uneven; the honest contract is a structural splice that keeps the pair gate-valid and leaves marked English for a human translator, exactly matching how the pairing record's NEEDS-TRANSLATION debt already works.

**Skip the traversal guard and rely on `config.root`.** `resolve(root, '../../x')` still escapes root; a model-supplied `docPath` is untrusted input to a write, so the guard rejects it at the string level before any filesystem call.

## Consequences

A model editing an English doc can keep its mirror gate-valid in one call, turning the multi-step manual splice into a single tool. The mirror carries visible NEEDS-TRANSLATION debt until a human translates it, so the pair is never silently wrong; a budget breach is reported, not enforced. The traversal guard means the tool can only ever write inside the repository.
