# Vault Git History — Freeze Backlog

```text
Status: DEFERRED DURING HISTORY FEATURE FREEZE
Feature state: TEMPORARILY FROZEN
Final Closure: DRAFT — CLOSURE IN PROGRESS
```

This backlog records the extreme filesystem-concurrency work intentionally
deferred by the 2026-08-02 History Feature Freeze. These are engineering
deferrals, not closed findings or security proofs.

## H-FREEZE-1 — Replacement EEXIST and old-FileHandle writes

```text
Status: DEFERRED
```

An external process may retain the original file descriptor, recreate the
formal target after Nuvyn takeover, and modify the staged inode before a
replacement `link` returns `EEXIST`. The current protocol still requires a
stronger quarantine or directory-handle file-operation protocol to make every
cleanup outcome authoritative.

## H-FREEZE-2 — Final snapshot to unlink window

```text
Status: DEFERRED
```

An old file descriptor can modify the same inode after Nuvyn obtains its final
snapshot and before pathname cleanup. Possible follow-up designs include
delayed quarantine, native file locks, or dirfd/openat/unlinkat-equivalent
operations.

## H-FREEZE-3 — Recovery proof and cleanup binding

```text
Status: DEFERRED
```

Crash recovery still needs a protocol that binds the decision proof directly
to cleanup, without re-capturing a changed artifact through a pathname. The
proof must cover inode, parent generation, and content hash.

## H-FREEZE-4 — Conditional Remove formal-path recovery

```text
Status: DEFERRED
```

When a staged pathname is replaced, the original generation is preserved, but
the formal target can remain absent until a stronger recovery anchor exists.
Future work should use a directory-handle protocol or an explicit formal
quarantine recovery transaction.

## H-FREEZE-5 — Cleanup result truthfulness

```text
Status: DEFERRED
```

When replacement has already succeeded but temporary, staged, or journal
cleanup fails, the operation result and metadata must clearly distinguish
success-with-warning from an ordinary failure. Future work must carry
`replacementApplied`, re-read the formal target, and keep disk state and
metadata aligned.

## Temporary risk acceptance

Accepted for:

- local personal use;
- one active Nuvyn instance;
- ordinary filesystem behavior;
- a non-adversarial environment.

Not accepted for:

- hostile local processes;
- multi-writer coordination;
- network filesystems;
- security-boundary guarantees;
- multi-user or multi-tenant use.

This is a temporary project-maintenance prioritization decision. It does not
remove the risks, constitute a security proof, or prevent the project from
revoking the decision. Reopening work must continue from this backlog.

## Reopening conditions

Reopen History hardening when any of the following occurs:

1. A user reports `.nuvyn-*` quarantine or journal residue.
2. Any user-data loss report is received.
3. Multiple Nuvyn instances are supported for one Vault.
4. Network filesystem support becomes an official requirement.
5. Strong external-editor concurrency becomes an official requirement.
6. A native module or usable dirfd/openat capability becomes available.
7. Formal Final Closure work is scheduled.
8. Linux/macOS/Windows certification is scheduled.
9. The Owner requests H-C10 or a related finding to be closed.
10. The History atomic file layer is reused by another module.

## Freeze contribution rules

While the feature is temporarily frozen, do not accept new History
enhancements, pure refactors, or complexity-only atomic cleanup changes.
Only the following may bypass the freeze:

- a deterministic normal-path bug;
- a user-data-loss fix;
- a security vulnerability;
- a compile failure;
- a test-stability fix;
- a platform-compatibility fix;
- a necessary documentation correction.

Every History production-code pull request that bypasses this freeze must
include:

```text
Why this change must bypass History Feature Freeze:
User-visible impact:
```

## Current baseline

The freeze is anchored to the following pre-freeze commits:

```text
History Freeze Production Baseline: e5e20c5ed3950e625003a443184fe8131cd20369
History Freeze Client-Test Baseline: ba90ce51dca07606e0feaa300ef7826f1b52cf22
History Freeze Documentation Baseline: 4fb35776e47befc01ae9029a714a041ae7eb8078
```

The final documentation commit and verification evidence are recorded in the
three primary History documents after the freeze-only commits are created.
