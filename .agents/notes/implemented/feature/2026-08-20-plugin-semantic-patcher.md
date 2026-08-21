# Agent Note: Semantic symbol-body patcher plugin

Status: implemented

English | [中文](2026-08-20-plugin-semantic-patcher.zh.md)

## Problem

Replacing one function or method body is one of the commonest edits, but the text-matching edit tools (`str_replace`, `edit`) require the model to reproduce the exact surrounding bytes, and a near-miss either fails or, worse, patches the wrong occurrence when the same text appears twice. There is no edit that names a symbol and replaces its body regardless of surrounding text, and none that refuses to write a result that would not parse.

## Decision

`@deepseek-ai/dsh-plugin-semantic-patcher` registers `patch_symbol_body({ path, symbol, newBody })`. It parses the file with tree-sitter, locates the named symbol in the syntax tree (top-level function, arrow-function-valued binding, or `Class.method` member), and replaces exactly that body. A name that matches zero or more than one symbol fails and lists the candidates rather than guessing. The replacement is parsed before anything is written: a result that would not parse leaves the file byte-for-byte unchanged. The write is contained — `resolve(root, path)` plus a relative-path check refusing `..`/absolute (`patcher.ts`), so a path escaping the repository root is refused before any write, and the write is atomic with the original mode preserved. It injects only `tools`.

The plugin arrived on a parallel branch (`feat/plugin-semantic-patcher`) without an Agent Note; this note is supplied at integration, and the plugin was recreated on current master with the standard integrator wiring.

## Alternatives considered

**Match-and-replace on text (what the existing edit tools do).** Requires exact surrounding bytes and silently risks the wrong occurrence; a syntax-tree lookup targets the declaration by identity, which is the whole point.

**Write first, validate after.** Writing an unparseable body and reverting leaves a window where the file on disk is broken (and a crash in that window persists it); parsing the replacement before the write means the file is never in a broken state.

## Consequences

A model can replace a symbol's body by name with the guarantee that the edit lands on the right declaration and never leaves the file unparseable or writes outside the repository. It handles the common symbol kinds (top-level functions, arrow bindings, class members); other constructs (overloads, nested closures) are out of scope and fail loud with the candidate list. Files above `maxBytes` (default 2 MiB) are refused.
