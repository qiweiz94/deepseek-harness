# dsh-atomic-write

English | [中文](README.zh.md)

Zero-dependency atomic, durable file replacement shared by file-backed stores that must never leave partial, symlink-hijacked, or wider-than-intended content on disk — the user-settings document (`dsh-settings-file`) and the credentials store (`dsh-credentials-local`).

## Surface

```ts
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

declare const text: string
declare const render: (previous: string) => string

await writeFileAtomic('/home/u/.dsh/settings.yaml', text, { mode: 0o600 })

// Read-modify-write against the same file from several processes.
await withFileLock('/home/u/.dsh/settings.yaml', async () => {
  await writeFileAtomic('/home/u/.dsh/settings.yaml', render(text), { mode: 0o600 })
})
```

`writeFileAtomic` commits one already-rendered string. The contract, in the order failures would exploit it:

- **Exclusive-create temp** (`wx`, random suffix): the open refuses to follow a symlink planted at a guessable temp path.
- **The fresh inode carries `mode` through the rename**: replacing a wider-permission file narrows it without a chmod race. `mode` is required so the permission decision stays visible at every call site (subject to the process umask, like every fresh inode).
- **`rename` replaces a symlinked target itself**, never writing through to its referent.
- **Same-directory sibling** keeps the rename on one filesystem, so the swap stays atomic.
- **The temp file is fsynced before the rename**: a sync failure aborts the write (temp removed, failure rethrown) rather than risk publishing content the device never received, so a crash never promotes empty or partially written content.
- **The parent directory is fsynced after the rename, on a best-effort basis**: failure there does not fail the call — the rename has already committed the new content under its final name — but it narrows the window in which a crash could leave the directory entry unobserved after recovery. See Known Limitations below.
- Parent directories are created; on any failure before the rename commits, the temp is removed and the failure rethrown; readers observe either the old or the new complete content.

`withFileLock` serializes the writers of one file across processes, for the read-render-commit cycles a bare atomic commit cannot make safe on its own. The lock is a `wx`-created `<filename>.lock` sibling, so readers never contend; waiters back off exponentially and fail with a timeout rather than block forever. A contender never removes the existing lock: age cannot distinguish a crashed owner from a paused live writer.

## Model Experience

None, as this is a pure filesystem primitive; nothing here reaches a model request.

#### KV Cache effect

None; nothing here enters a request prefix.

## Known Limitations and Deferred Work

- **Directory-entry durability is best-effort, not guaranteed** — the temp file's content is fsynced before the rename (fail-loud), but the parent-directory fsync after the rename swallows its own failure instead of failing the call, because some platforms and filesystems (Windows, several network mounts) reject directory reads or syncs even though the rename itself succeeded. On those, or when the directory-entry fsync otherwise fails, a crash can still leave the rename unobserved after recovery even though the content itself was durably written. The file-backed stores here re-read and republish on boot, keeping that residual crash window the caller's policy.
- **String content only** — no `Buffer` or stream form until a consumer needs one.
- **Orphaned locks require operator recovery** — a process that exits while holding the lock can leave the sibling behind. Later writers time out without deleting it; an operator removes it only after verifying that no writer still owns it. File age alone is not safe evidence of abandonment.
