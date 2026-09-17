# Document Lifecycle

Document creation, rename, move, and deletion are server-owned transactions. They coordinate the filesystem, stable document identity, SQLite metadata, open editor state, recovery drafts, link references, and history operations.

## Stable identity

A document's path can change while its metadata and draft identity remain associated with it. Nuvyn assigns a stable document ID and stores the current path in SQLite. Lifecycle operations update this mapping as part of the mutation.

## Mutation flow

1. Validate the requested path and reserved-root contract.
2. Acquire the relevant document or folder coordination barrier.
3. Flush or block conflicting saves where the operation requires it.
4. Prepare durable filesystem and metadata work.
5. Commit the mutation and any reference rewrites.
6. Update client state using the server result.

Folder rename transactions use a durable journal because one folder can contain many documents and metadata identities. Recovery validates that a journal still owns the paths it describes before replaying or rolling it back.

## Reference updates

Rename and move operations can rewrite supported Wiki and Markdown links that point to the moved document. Reference rewriting is journaled so a process interruption does not leave it half-applied without a recovery record.

## Archive workflow

The shared archive protocol is enforced on both client and server:

- `inbox`, `literature`, and `archive` are reserved top-level roots;
- the roots themselves cannot be renamed, deleted, or re-parented;
- `archive/` is a recommended organizational area, not a permission boundary;
- descendants of `archive/` use the same file and folder lifecycle rules as ordinary Nuvyn content;
- files can use the existing move workflow, while folders retain create/rename/delete and do not support general cross-parent re-parenting;
- the built-in Archive action defaults to `archive/<filename>` and retains collision handling.

The server remains authoritative even if a client bypasses the interface. Filesystem confinement, authentication, history, recovery, and lifecycle safety remain independent of archive membership.

## Diary workflow

`diary/` is a reserved root with a date identity contract:

- the root itself cannot be renamed, deleted, or re-parented;
- managed documents use the exact logical path `diary/YYYY-MM-DD` and physical path `diary/YYYY-MM-DD.md`;
- Today and past missing dates use the server-owned date command; missing future dates are not created;
- managed entries reuse the ordinary editor, save, History, Recovery, and delete lifecycle, while identity-changing rename/move operations and generic creation under `diary/` are rejected;
- unmanaged or invalid content already present under `diary/` remains ordinary FileTree-visible content and is excluded from the Calendar projection.

The date identity and future-date rules are server-authoritative. They do not alter authentication, path confinement, atomic writes, or the ordinary lifecycle used by other vault documents.

## Failure behavior

Lifecycle code fails closed when ownership, source identity, or the current disk state is ambiguous. Startup recovery runs before the server begins accepting normal requests. See [Crash Recovery](crash-recovery.md).

