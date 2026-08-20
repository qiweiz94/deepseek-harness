# @deepseek-ai/dsh-session-retention

English | [中文](README.zh.md)

The **`SessionRetentionRuntime`** (`ctx.sessionRetention`) owns deletion of one session's durable data across every store that opts in. It is the capability seam every store-package README pointed at as a consumer gap: enumerate what deleting a session would remove, then delete it, with a per-store outcome instead of a single opaque success.

## Service API (`ctx.sessionRetention`)

| Member | Semantics |
|---|---|
| `plan(id, signal?)` | Enumerate what deleting `id` would remove, per registered store, without mutating anything. |
| `deleteSession(id, signal?)` | Delete `id`'s durable data in every registered store. Refuses a live session and refuses to run with zero registered participants. |
| `register(participant)` | A store's registration entry point (used by store packages, not by `deleteSession`'s caller); returns the disposer that unregisters it. |

Both `plan` and `deleteSession` return one entry per registered `RetentionParticipant`, in registration order:

- A `plan` entry is `{ kind: 'targets', targets }` (possibly empty) or `{ kind: 'retains', reason }` when the store keeps its data by design.
- A `deleteSession` entry is `{ kind: 'deleted', targets }`, `{ kind: 'absent' }` (nothing was stored for `id`), `{ kind: 'retained', reason }`, or `{ kind: 'failed', message }` — the runtime catches one participant's rejection so it cannot hide another store's outcome, and later stores still run.

`RetentionTarget` names one artifact or record set removed: `kind` (`file` | `directory` | `records`), a store-specific `location`, and an optional cheap `count`. Rerunning a deletion converges: every participant treats already-deleted data as `absent`, never a rejection.

This package is the Service Definition and orchestrator; store packages are the providers. `dsh-session-persistence` registers one participant per persistence backend (shared by `dsh-session-persistence-jsonl` and `dsh-session-persistence-sqlite`) over two backend hooks, `planStored`/`deleteStored`, optional so a backend that predates retention (or a test fixture) is unaffected. `dsh-spill-local` removes its per-session spill directory. `dsh-attachment-local` registers an honest `retains`/`retained` participant: its objects are content-addressed and deduplicated across sessions, so per-session deletion is unsafe without reference-aware garbage collection.

v1 deliberately ships **no automatic age- or quota-based retention policy** and **no model-facing tool**: this seam is the single-session deletion primitive a policy or the session-management surface (`dsh-workspace`) dispatches through.

## Model Experience

None, as the seam deletes durable data on an explicit caller request and touches no prompt, message, schema, stream, or tool result.

#### KV Cache effect

None; the seam never assembles or sends provider requests.

## Known Limitations and Deferred Work

- **No automatic retention policy** — age- and quota-based eviction are deferred; this seam is the deletion primitive they will call.
- **Attachment bytes are never reclaimed** — `dsh-attachment-local` always reports `retained`; reference-aware garbage collection across sessions is deferred in `dsh-attachment`/`dsh-attachment-local`.
- **Deletion is per-session-id, not lineage-aware** — a forked session's log may reference its parent's spill locators and attachment objects; deleting the parent leaves the fork's spill references dangling. Lineage-aware deletion (walk fork/resume ancestry before deleting) is deferred.
- **No `retention/session-deleted` event** — deferred until a real consumer exists (a projection-cache eviction or the workspace header index would be the first); an unconsumed event is surface without an owner.
- **No workspace consumer wiring** — `dsh-workspace` still lacks the confirmation UX and folder-removal pairing that would call `deleteSession`; this seam provides the method, not the caller.
