# Vault Git History — Implementation Plan

**Date:** 2026-07-30
**Consolidated:** 2026-07-31
**Status:** Closure Remediation Plan — Pending Owner Approval
**Closure:** DRAFT — CLOSURE IN PROGRESS
**Production-code review baseline:** `00b17359d151bbdbe56115ed992700ecbb5e1ca1`

This Plan implements the contracts in the
[Design](../specs/2026-07-30-vault-git-history-design.md). Current
behavior is recorded in the
[Implementation Record](../implementation-records/vault-git-history-implementation-record.md);
closure evidence belongs in the
[Draft Closure](../closures/vault-git-history-final-closure.md).

Every item in Part B is a **Planned remediation / Closure requirement /
Not implemented on the reviewed production baseline**. No future
behavior in this Plan may be reported as observed.

## Part A — Retrospective Baseline

The reviewed production baseline already provides:

1. repository bootstrap and Git capability;
2. logical path/ref validation;
3. Status, Log, Snapshot, and Diff reads;
4. exact Working Tree capture and Temporary-Index Create Version;
5. CAS HEAD movement;
6. process-local repository mutation serialization;
7. persistent Index Repair metadata and hand-taken Index-lock Repair;
8. Working-Tree-only Restore;
9. latest-HEAD Withdraw;
10. client Timeline, Snapshot, Comparison, Restore, Withdraw, and
    Repair surfaces.

The baseline is not the intended closure state. In particular:

- Create routine sync still runs up to three Real-Index resets;
- no F0/F1 path outcome exists;
- no canonical marker or Vault identity exists;
- filesystem operations can follow symlinks;
- HEAD/parent resolution does not fail closed;
- complete History mutations and Repair metadata have no authoritative
  cross-process Vault lock;
- Restore is not one atomic resolved-ref/read/write/post-read
  transaction;
- Create can report a successful commit as failure after refresh;
- Git-log framing and DST grouping remain incorrect;
- final regression and three-platform verification are missing.

## Part B — Closure Remediation Tasks

The finding IDs, titles, severities, and blocker status are canonical:

| ID | Finding | Severity | Closure Blocker |
|---|---|---|---|
| H-C1 | `/status` genuine server failures are swallowed as graceful unavailable | P1 | Yes |
| H-C2 | Create Version can report a successful commit as failure after refresh | P1 | Yes |
| H-C3 | Routine Real-Index sync can overwrite target-path staged intent | P1 | Yes |
| H-C4 | Withdraw lacks valid canonical same-vault marker enforcement | P1 | Yes |
| H-C5 | Restore ref/read/write/result are not one atomic observed snapshot | P1 | Yes |
| H-C6 | Short Withdraw SHA is accepted but never equals full HEAD | P2 | Yes |
| H-C7 | Timeline grouping uses fixed-duration day arithmetic across DST | P2 | Yes |
| H-C8 | Three-platform full-suite verification is missing | P1 (Verification) | Yes |
| H-C9 | Required History regression coverage is incomplete | P1 (Verification) | Yes |
| H-C10 | History filesystem reads/writes lack symlink-safe Vault containment | P1 | Yes |
| H-C11 | HEAD and Withdraw parent resolution do not fail closed | P1 | Yes |
| H-C12 | Cross-process History mutation and Repair metadata serialization is incomplete | P1 | Yes |
| H-C13 | `ensureRepo` bootstrap is not atomically serialized and its non-overwrite check has TOCTOU | P2 | Yes |
| H-C14 | Textual Git-log separator is injectable through commit messages | P2 | Yes |
| H-K8 | Rename history is not `--follow`-merged | P2 | No |
| H-K10 | Timeline and Log have no pagination | P2 | No |
| H-K13 | SHA-256 Vault repositories are unsupported by the 40-zero CAS sentinel | P2 | No |

### History-C1 — Correct `/status` response truthfulness

**Finding:** H-C1, P1, Closure Blocker.

**Files:** `src/lib/history-api.ts`,
`src/lib/__tests__/history-api.test.ts`.

**Implementation:**

Parse the response once. Recover only:

```text
HTTP 503
AND body is an object
AND body.available === false
AND body.dirty is an array
```

Every other non-2xx throws `HistoryApiError`. Remove the general
`allowNonOkJson` escape hatch from `getStatus`.

**Required tests:**

```text
recovers the exact graceful unavailable 503 body
throws on a non-graceful 503
throws on a 500 even when it has JSON
throws on a malformed non-2xx body
```

**Done:** genuine server faults cannot masquerade as Git
unavailability.

### History-C2 — Separate primary mutation success from refresh work

**Finding:** H-C2, P1, Closure Blocker.

**Files:** `src/composables/vault/useHistoryCommit.ts`,
`src/composables/vault/useHistoryWithdraw.ts`,
`src/i18n/locales/en.ts`, `src/i18n/locales/zh.ts`, and both
composable test files.

**Implementation:**

For Create:

```text
await and validate createCommit inside the primary mutation catch
→ acknowledge primary success
→ synchronously settle server result, completion state,
  lastCommittedPaths, selection, message, returned Repair state,
  and success/degraded-success classification
→ leave the primary mutation catch
→ await settleAfterSuccessfulCommit(...)
→ release the path mutation lock in finally
```

`settleAfterSuccessfulCommit(...)` releases the save barrier exactly
once and runs Status, Log, Comparison, and Repair-status refresh plus
toast/local reconciliation as auxiliary work. It returns:

```ts
interface CommitAuxiliaryOutcome {
  barrierReleaseFailed: boolean
  statusRefreshFailed: boolean
  logRefreshFailed: boolean
  comparisonRefreshFailed: boolean
  repairStatusRefreshFailed: boolean
}
```

No auxiliary work runs inside the primary commit-failure catch. A
barrier-release rejection gets a distinct informational message
because pending editor-save work may not have finalized. It cannot
restore composer state, enable a duplicate retry, or prevent the path
mutation lock from releasing in `finally`. Multiple auxiliary
failures produce one informational summary while retaining the
structured fields for tests and diagnostics.

Withdraw already uses `Promise.allSettled` for Status, Log, and
Comparison. Keep that behavior and isolate
`closeDroppedRevision`, Repair register/settle,
`refreshIndexRepairStatus`, and local completion updates so none can
turn the successful server response into `withdraw_failed`. Apply the
same primary-success boundary to Restore: local cleanup, tab cleanup,
barrier release, Repair-status refresh, and repository refresh never
convert server success to failure.

**Required tests:**

```text
commit remains successful when refreshStatus rejects
commit remains successful when refreshLog rejects
commit remains successful when comparison refresh rejects
commit remains successful when save-barrier release rejects
selection and message settle immediately after commit response
composer settles before save-barrier release
completion state increments before save-barrier release
returned Repair state is registered before save-barrier release
path mutation lock is released after save-barrier release rejection
barrier release runs exactly once
retry after refresh failure does not create a duplicate version
retry after barrier release failure cannot duplicate the version
multiple auxiliary failures produce one informational warning
withdraw remains successful when repair-status refresh rejects
withdraw remains successful when local tab cleanup throws or is isolated
```

### History-C3 — Implement path-selective atomic Real-Index sync

**Finding:** H-C3, P1, Closure Blocker.

**Dependencies:** History-C10 symlink-safe resolver and History-C12
Repair metadata lock must land first. History-C11 supplies fail-closed
HEAD resolution. C3 reuses, but does not rewrite, the proven
close-before-rename lifecycle already present in
`repairIndexWithLock` and `syncDroppedIndexPaths`.

**Files:** `server/history/git.ts`, `server/history/routes.ts`,
`src/lib/history-api.ts`,
`src/composables/vault/useHistoryCommit.ts`,
`src/composables/vault/useHistoryWithdraw.ts`,
`src/components/vault/HistoryChangesPanel.vue`,
`src/i18n/locales/en.ts`, `src/i18n/locales/zh.ts`, and relevant
server, route, API, composable, and component tests.

**Wire contract:**

```ts
interface IndexSyncRequest {
  oldHead: string | null
  targetHead: string | null
  paths: string[]
  expectedIndexBeforeHeadMove:
    Record<string, IndexEntryFingerprint[]>
}

interface IndexSyncOutcome {
  synchronizedPaths: string[]
  preservedExternalPaths: string[]
  failedPaths: string[]
  replacementApplied: boolean
  finalHead: string | null
  reconciliationRequired: boolean
}
```

The caller does not pass `safeCandidatePaths`. The server derives it
from F0 and old-HEAD tree entries. Duplicate request paths are rejected
during normalization. Outcome arrays preserve normalized request order
and satisfy:

```text
the three arrays are pairwise disjoint

set(synchronizedPaths)
∪ set(preservedExternalPaths)
∪ set(failedPaths)
= set(request.paths)
```

**Create sequence:**

```text
validate request
→ acquire withRepoMutation
→ assertRepositoryIdle
→ ensure Repair storage preflight
→ re-read Status
→ capture exact expected Working Tree bytes
→ ensure author / Vault metadata
→ build Temporary Commit Index from oldHead
→ write tree
→ create commit object
→ capture F0 from Real Index for every target path
→ compare F0 with oldHead tree entries
→ classify safeCandidatePaths / preservedExternalPaths
→ assertRepositoryIdle immediately before HEAD move
→ CAS update-ref HEAD
→ syncIndexAtomic
```

Empty-repository classification is exact:

```text
oldHead entry absent + F0 absent  → safe candidate
oldHead entry absent + F0 present → preserved external staged intent
```

**`syncIndexAtomic` algorithm:**

1. If no safe candidate exists, return preserved paths without
   acquiring `index.lock`.
2. Resolve the absolute Git directory.
3. Acquire `.git/index.lock` with `open(..., 'wx')`.
4. Read the Real Index under lock and capture F1 per target.
5. Classify each target independently:
   - F0 differs from old HEAD → preserved;
   - F1 differs from F0 → preserved;
   - both match → `pathsToSynchronize`.
6. If `pathsToSynchronize` is empty, close and remove `index.lock`;
   do not run reset/update-index, write, or rename.
7. Seed a Temporary Index from the locked Real Index, or use
   `read-tree --empty` when absent.
8. Apply scoped reset/update-index only to `pathsToSynchronize`.
9. Verify those paths against `targetHead`; preserved and unrelated
   entries remain byte-for-byte seeded.
10. Re-check the operation state and HEAD before publication.
11. Write replacement bytes to `.git/index.lock`.
12. `fsync` the lock handle.
13. Close the lock handle.
14. Atomically rename `.git/index.lock` to `.git/index`; this is the
    sole Real-Index commit point.
15. Set `replacementApplied = true` and re-read HEAD.
16. Remove the Temporary Index directory.

If rename has not committed, `finally` closes the handle, removes
`index.lock`, and removes the Temporary Index directory. There are no
destructive retries.

**Outcome rules:**

- `synchronizedPaths`: fully checked and published by the Real-Index
  rename. Temporary-Index verification alone never qualifies.
- `preservedExternalPaths`: unchanged; no Repair, banner, Retry, or
  `indexRefreshFailed`; one informational toast.
- before rename, any global repository-operation, HEAD, lock, I/O,
  Temporary Index, reset/update-index, verification, lock write,
  fsync, close, or rename failure returns
  `synchronizedPaths: []`, retains already-preserved paths, and puts
  every `pathsToSynchronize` path in `failedPaths`, with
  `replacementApplied: false`;
- ordinary `failedPaths` may create a pending Repair whose
  `expectedIndex` is F0;
- an F1 mismatch never fails safe siblings;
- `indexRefreshFailed = failedPaths.length > 0`.

After rename, if the re-read HEAD equals `targetHead`,
`pathsToSynchronize` become `synchronizedPaths` and
`reconciliationRequired` is false. If HEAD differs, the already
published replacement is reported with:

```text
replacementApplied = true
finalHead != targetHead
reconciliationRequired = true
synchronizedPaths = []
```

To preserve the full partition, `pathsToSynchronize` appear in
`failedPaths`, but do not create an ordinary F0-bound Repair. Instead,
persist exactly this separate reconciliation model:

```ts
interface IndexReconciliationTransaction {
  kind: 'post-replacement-head-change'
  token: string
  status: 'pending' | 'superseded'
  appliedTargetHead: string | null
  head: string | null
  paths: string[]
  expectedIndex: Record<string, IndexEntryFingerprint[]>
}
```

`expectedIndex` contains fingerprints from the replacement that
actually landed. The server result includes the transaction. The
client shows a distinct reconciliation-required banner and one
informational toast.

Retry acquires locks in the C12 hierarchy, requires current HEAD to
equal recorded `head`, and requires current fingerprints to equal
`expectedIndex`. It then atomically synchronizes a Temporary Index to
that recorded HEAD. A mismatch marks the transaction `superseded`
without writing the Index. Discard removes only reconciliation
metadata. Metadata persistence failure remains degraded success and
never falls back to an F0-bound Repair.

**Windows error normalization:**

Only `EEXIST`, `EBUSY`, `EAGAIN`, and `EPERM` positively classified as
lock contention become degraded success. An ordinary permission
failure is not swallowed.

**Required tests:**

```text
captures F0 before moving HEAD
preserves a path staged before Create Version
preserves a path changed from F0 to F1
synchronizes one safe path while preserving one mismatched path
partitions every requested path into exactly one outcome
preserves request ordering in all outcome arrays
creates Repair only for failedPaths
binds failed-path Repair to pre-HEAD F0
does not acquire index.lock when no safe path exists
removes index.lock when all paths become preserved under lock
removes index.lock after Temporary Index creation failure
removes index.lock after verification failure
closes index.lock before atomic rename
allows a subsequent external git add after every failure branch
does not rename after fingerprint mismatch
marks all pathsToSynchronize failed when a pre-rename global failure
aborts the batch
does not report Temporary-Index-only verification as synchronized
returns synchronized paths only after rename succeeds
rechecks HEAD after rename
records replacementApplied when HEAD changes after rename
does not create an F0-bound ordinary Repair after a published
replacement
persists the post-replacement reconciliation transaction
allows that reconciliation transaction to be safely retried or
dismissed
```

### History-C4 — Add atomic Vault identity and canonical marker

**Finding:** H-C4, P1, Closure Blocker.

**Dependencies:** History-C11 for full-SHA and parent parsing;
History-C10 for changed-path validation.

**Files:** `server/history/repo.ts`, `server/history/git.ts`,
`server/history/routes.ts`, `server/history/validation.ts`,
`src/lib/history-api.ts`,
`src/composables/vault/useHistoryWithdraw.ts`,
`src/i18n/locales/en.ts`, `src/i18n/locales/zh.ts`, Withdraw
composable/component tests, and server/route tests.

**Vault identity publication:**

Use `<git-dir>/nuvyn/vault-id` and one dedicated metadata creation
lock:

```text
acquire vault-id creation lock
→ if a valid final id exists, return it
→ quarantine malformed final id while still locked
→ create a same-directory temporary id file exclusively
→ write one complete lowercase UUID plus newline
→ fsync
→ close
→ atomically publish final id
→ fsync parent directory where supported
→ release creation lock
```

Concurrent first touch yields one stable ID and never exposes an empty
or partial file.

**Create marker:**

Append one final canonical trailer paragraph:

```text
Nuvyn-Version: 1
Nuvyn-Vault-Version: <vault-id>
```

User-body lines that resemble trailers are not authoritative.
Parsing examines the final canonical trailer paragraph and requires
exactly one value for each key, no unknown line inside the canonical
block, and a same-Vault ID. Duplicate keys or ambiguous final trailer
layout fail closed.

**Legacy policy: Option A — fail closed (fixed).**

Legacy unmarked commits cannot be withdrawn. They must be recommitted
through the new Create Version flow. There is no claim endpoint,
author/date inference, or alternate migration policy.

The marker is an accidental-withdrawal guard, not cryptographic
provenance proof.

**Withdraw client error contract:**

Use the structured `HistoryErrorCode` schema owned by C11. Return
stable server codes and distinguish:

```text
latest changed
repository operation
invalid same-vault marker
cross-vault marker
ambiguous marker
legacy unmarked commit
merge commit
invalid changed path
```

No general “all 409 = latest changed” path remains.
The client branches on `error.code`, never server prose. Unknown codes
and legacy bodies without a code use only a generic safe fallback.

**Required tests:**

```text
creates vault id atomically on first touch
concurrent first touch produces one stable vault id
does not expose a partial vault id
quarantines malformed vault id without racing a writer
Create appends exactly one canonical trailer block
user body fake trailers are not authoritative
Withdraw rejects unmarked external commit
Withdraw rejects cross-vault marker
Withdraw rejects duplicate or ambiguous canonical trailers
Withdraw rejects merge commit
Withdraw rejects non-managed changed path
client shows marker-specific conflict rather than latest-changed
```

### History-C5 — Replace Restore with one atomic entry point

**Finding:** H-C5, P1, Closure Blocker.

**Dependencies:** History-C10 and History-C11.

**Files:** `server/history/git.ts`, `server/history/routes.ts`,
`src/lib/history-api.ts`,
`src/composables/vault/useHistoryRestore.ts`, Restore route/API/
composable tests.

**Implementation:**

Introduce one `restoreFileAtomic(...)` that owns the only
`withRepoMutation`. The route must not add a mutex, run `rawAt`
beforehand, or call an old helper that acquires its own mutex.

```text
withRepoMutation
→ resolve accepted ref once to one full immutable commit SHA
→ read source using the full SHA
→ resolve and reject symlink-safe destination
→ git restore --source=<fullSha> --worktree -- <path>
→ open verified file handle
→ fstat/read/fstat identity check
→ bounded retry or conflict
→ return requestedRef, resolvedRef, result.raw, and result.mtime
```

The response is the post-restore snapshot observed inside the
repository mutation transaction. It does not promise that an external
process cannot write immediately afterward. The client uses
`result.raw` for the editor baseline and `VaultFileChanges`, while
preserving newer editor edits. Refresh failures remain success.

**Required tests:**

```text
resolves accepted ref once to one immutable full SHA
uses the resolved SHA for read and write
returns post-restore observed Working Tree bytes
uses result.raw in editor state
uses result.raw in VaultFileChanges
preserves newer editor edits
does not double-acquire withRepoMutation
rejects symlink target paths
does not report completed restore as failed when refresh fails
```

### History-C6 — Resolve accepted Withdraw SHA once

**Finding:** H-C6, P2, Closure Blocker.

**Files:** `server/history/validation.ts`, `server/history/git.ts`,
`server/history/routes.ts`, route and Git tests.

**Implementation:**

Keep 7–40 hex validation. Resolve the request with
the shared C11 `resolveCommitRef(repoRoot, requested)` primitive to one
full immutable SHA. C6 owns only the `/drop` validation and adapter;
it does not define or implement a second resolver. Reject ambiguous,
missing, malformed, or non-commit results. Every subsequent operation
uses the single returned full SHA:

- HEAD equality;
- marker check;
- parent parse;
- changed-path discovery;
- CAS update-ref.

There is no reject-short-SHA branch.

**Required tests:**

```text
resolves a short SHA to a full commit SHA
uses the same full SHA for every Withdraw check
rejects ambiguous or non-commit resolution
```

### History-C7 — Use DST-safe local-calendar ordinals

**Finding:** H-C7, P2, Closure Blocker.

**Files:** `src/composables/vault/useHistoryTimeline.ts`,
`src/composables/vault/__tests__/useHistoryTimeline.test.ts`, and a
small child-process fixture if needed.

**Implementation:**

Replace elapsed-millisecond day math with:

```ts
function localDayOrdinal(timestamp: number): number {
  const date = new Date(timestamp)
  return Date.UTC(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ) / 86_400_000
}
```

Run deterministic DST cases by spawning a child Node/Vitest process
with an explicit `TZ` environment. Runtime mutation of
`process.env.TZ` is not an alternate plan.

**Required tests:**

```text
groups correctly across DST spring-forward
groups correctly across DST fall-back
runs DST cases under an explicit child-process TZ
groups a local previous-day item as Yesterday near midnight
keeps future timestamps in Today
```

### History-C8 — Verification finding status

**Finding:** H-C8, P1 (Verification), Closure Blocker.

This heading records finding status only; it is not an independently
executed task. History-C15 is the sole final-verification execution
task. Its successful evidence on one immutable candidate production
SHA closes H-C8. Existing CI configuration is not evidence of a
completed run.

### History-C9 — Complete required regression coverage

**Finding:** H-C9, P1 (Verification), Closure Blocker.

This task owns the aggregate coverage gate. Tests implemented in
C1–C7 and C10–C14 count toward it, but the gate closes only when all
scenarios below exist and pass.

**Index synchronization**

```text
captures F0 before moving HEAD
preserves a path staged before Create Version
preserves a path changed from F0 to F1
synchronizes one safe path while preserving one mismatched path
partitions every requested path into exactly one outcome
preserves request ordering in all outcome arrays
creates Repair only for failedPaths
binds failed-path Repair to pre-HEAD F0
does not acquire index.lock when no safe path exists
removes index.lock when all paths become preserved under lock
removes index.lock after Temporary Index creation failure
removes index.lock after verification failure
closes index.lock before atomic rename
allows a subsequent external git add after every failure branch
does not rename after fingerprint mismatch
marks all pathsToSynchronize failed when a pre-rename global failure
aborts the batch
does not report Temporary-Index-only verification as synchronized
returns synchronized paths only after rename succeeds
rechecks HEAD after rename
records replacementApplied when HEAD changes after rename
does not create an F0-bound ordinary Repair after a published
replacement
persists the post-replacement reconciliation transaction
allows that reconciliation transaction to be safely retried or
dismissed
```

**Symlink safety**

```text
rejects a symlink Markdown leaf
rejects a symlink directory segment
does not hash bytes outside the Vault
does not commit bytes outside the Vault
does not expose outside bytes through WORKTREE file or diff
Restore rejects a symlink destination
commits a selected deleted file without requiring realpath of its leaf
commits a new untracked file through a verified missing-leaf parent
restores a file whose leaf is initially absent
rejects a symlink introduced into a parent segment after initial
validation
rejects a symlink leaf introduced before the final operation
detects pathname replacement after opening the restored file
does not return bytes from an inode no longer reachable at the target
path
fails closed when parent identity changes
```

**Ref/parent resolution**

```text
distinguishes unborn HEAD from operational failure
resolveCurrentHead positively identifies an unborn branch
resolveCurrentHead throws on detached invalid or operational failure
resolves a short SHA to a full commit SHA
C6 calls the shared C11 commit resolver
only one full-SHA resolution occurs per Withdraw request
classifies root commit only from valid parent output
rejects merge commits
does not move HEAD on parent-resolution failure
does not move HEAD on malformed parser output
server returns stable marker/ref/parent error codes
HistoryApiError preserves status, code, message, and details
Withdraw maps every marker error code to the correct i18n message
Withdraw does not inspect human-readable server text
an unknown error code uses a generic safe fallback
legacy error bodies without code still produce HistoryApiError
```

**Marker and Vault metadata**

```text
creates vault id atomically on first touch
concurrent first touch produces one stable vault id
does not expose a partial vault id
quarantines malformed vault id without racing a writer
Create appends exactly one canonical trailer block
user body fake trailers are not authoritative
Withdraw rejects unmarked external commit
Withdraw rejects cross-vault marker
Withdraw rejects duplicate or ambiguous canonical trailers
Withdraw rejects merge commit
Withdraw rejects non-managed changed path
client shows marker-specific conflict rather than latest-changed
```

**Repair metadata**

```text
serializes concurrent record and settle
does not lose transactions during migration
does not lose transactions during quarantine
cleans metadata lock after failure
repair-status does not perform an unlocked write
```

**Cross-process Vault mutation serialization**

```text
serializes Create and Withdraw across two server processes
serializes Create and Restore across two server processes
prevents an older post-CAS sync from publishing after a newer HEAD move
allows mutations in different Vaults to proceed in parallel
uses one fixed lock acquisition order
does not deadlock when Repair and Index locks are both required
does not remove a live Vault mutation lock
recovers a positively identified stale Vault mutation lock
fails closed when stale-lock ownership cannot be determined
cleans an acquired lock after an ordinary exception
```

**Restore**

```text
resolves accepted ref once to one immutable full SHA
uses the resolved SHA for read and write
returns post-restore observed Working Tree bytes
uses result.raw in editor state
uses result.raw in VaultFileChanges
preserves newer editor edits
does not double-acquire withRepoMutation
rejects symlink target paths
does not report completed restore as failed when refresh fails
```

**Commit/Withdraw success boundary**

```text
commit remains successful when refreshStatus rejects
commit remains successful when refreshLog rejects
commit remains successful when comparison refresh rejects
commit remains successful when save-barrier release rejects
selection and message settle immediately after commit response
composer settles before save-barrier release
completion state increments before save-barrier release
returned Repair state is registered before save-barrier release
path mutation lock is released after save-barrier release rejection
barrier release runs exactly once
retry after refresh failure does not create a duplicate version
retry after barrier release failure cannot duplicate the version
multiple auxiliary failures produce one informational warning
withdraw remains successful when repair-status refresh rejects
withdraw remains successful when local tab cleanup throws or is isolated
```

**Timeline/parser/bootstrap and existing gaps**

```text
groups correctly across DST spring-forward
groups correctly across DST fall-back
runs DST cases under an explicit child-process TZ
does not create phantom log records from delimiter characters
round-trips multiline commit bodies and control characters safely
does not overwrite a dotfile created concurrently
concurrent ensureRepo calls remain idempotent
serializes concurrent ensureRepo callers
only one caller performs git init
all callers observe one valid repository
does not overwrite a concurrently created .gitignore
does not overwrite a concurrently created .gitattributes
retries safely after partial initialization failure
rechecks repository existence after acquiring the lock
different Vaults can initialize in parallel
parametrizes all seven repository-operation markers
tests logical path backslash, absolute, and hidden-directory rejection
serializes same-Vault server mutations and allows different Vaults in parallel
```

### History-C10 — Add one symlink-safe filesystem resolver

**Finding:** H-C10, P1, Closure Blocker.

**Files:** new shared server History path-resolver module,
`server/history/validation.ts`, `server/history/routes.ts`,
`server/history/git.ts`, and route/Git tests.

**Implementation:**

Provide one shared resolver module with explicit existing and
missing-leaf modes:

```ts
interface VerifiedVaultRoot {
  logicalRoot: string
  canonicalRoot: string
}

interface VerifiedExistingFile {
  logicalPath: string
  absolutePath: string
  canonicalPath: string
  handle: FileHandle
  identity: FileIdentity
}

interface VerifiedMissingLeaf {
  logicalPath: string
  parentAbsolutePath: string
  parentCanonicalPath: string
  leafName: string
  parentIdentity: FileIdentity
}

type VerifiedHistoryPath =
  | { kind: 'existing-file'; value: VerifiedExistingFile }
  | { kind: 'missing-leaf'; value: VerifiedMissingLeaf }

resolveExistingHistoryFileForRead(...)
resolveExistingHistoryFileForWrite(...)
resolveHistoryPathAllowMissingLeaf(...)
resolveDeletedHistoryPath(...)
```

An existing-file operation performs:

```text
logical syntax validation
→ lstat every directory segment and reject symlinks
→ open the leaf without following symlinks
→ fstat and require a regular file
→ verify canonical parent/root containment
→ reopen/lstat the pathname without following symlinks
→ compare pathname identity with the opened-handle identity
```

For a missing leaf, verify and open the existing parent, reject
symlink parent segments, verify canonical parent containment, capture
parent identity, and require only the final leaf to be absent. Before
create or Restore, recheck parent identity and leaf absence or the
explicitly allowed replacement state. A symlink or unexpected
file-type appearance fails closed.

Selected deletion remains supported: a validated path whose verified
parent is contained and whose final leaf is absent carries expected
hash `null`; the Temporary Commit Index removes it without calling
`realpath` on the absent leaf. New untracked files and Restore to an
initially absent leaf use the same missing-leaf mode.

POSIX uses no-follow opens; Windows uses reparse-point/handle
inspection and equivalent pathname/handle identity checks. Canonical
path resolution by itself is insufficient.

No endpoint constructs `path.join(repoRoot, logicalPath)` and then
reads/writes it independently. Apply these operations to
`/content-hashes`, Create capture, WORKTREE `/file`, WORKTREE `/diff`,
Restore read/write/post-read, and `restoreFileAtomic`.

Restore holds the C12 Vault mutation lock, validates the parent/path
immediately before `git restore`, then verifies the resulting pathname
immediately afterward. Post-read verification is:

```text
open no-follow
→ fstat
→ read
→ fstat
→ reopen/lstat pathname no-follow
→ compare pathname identity with opened-handle identity
```

On identity mismatch, repeat that complete post-restore verification
exactly once. A second mismatch returns
`409 HISTORY_CONFLICT`. Only a verified pathname-reachable snapshot is
returned.

This cannot make an external filesystem writer disappear:
`git restore --worktree -- <path>` accepts a pathname, not a verified
handle. The Vault lock serializes Nuvyn mutations; a local process
with filesystem write access may still race replacement. The
implementation detects observed substitution and fails closed, but
does not claim a kernel transaction spanning Git and arbitrary
external writers.

**Required tests:** every Symlink Safety test listed in C9, including
deleted/new/missing-leaf and pathname-identity cases.

### History-C11 — Make HEAD, commit, and parent resolution fail closed

**Finding:** H-C11, P1, Closure Blocker.

**Files:** `server/history/git.ts`, `server/history/routes.ts`,
server/route tests.

**Implementation:**

Own the only shared fail-closed resolution primitives:

```ts
type HeadResolution =
  | { kind: 'head'; sha: string }
  | { kind: 'unborn' }

interface CommitResolution {
  requested: string
  fullSha: string
}

type ParentResolution =
  | { kind: 'root' }
  | { kind: 'single-parent'; parent: string }
  | { kind: 'merge'; parents: string[] }

resolveCurrentHead(repoRoot): Promise<HeadResolution>
resolveCommitRef(
  repoRoot,
  requested,
): Promise<CommitResolution>
resolveCommitParents(
  repoRoot,
  fullSha,
): Promise<ParentResolution>
```

`resolveCurrentHead` uses this exact positive-unborn algorithm:

```text
git rev-parse --verify HEAD

status 0:
  validate a full object id
  return { kind: 'head', sha }

non-zero:
  git symbolic-ref -q HEAD

  symbolic-ref status 0:
    validate returned ref
    git show-ref --verify --quiet <returned-ref>

    show-ref status 1:
      return { kind: 'unborn' }
    show-ref status 0:
      fail: HEAD inconsistency
    any other status:
      fail: operational error

  symbolic-ref status 1:
    fail: detached or invalid state
  any other status:
    fail: operational error
```

No stderr wording controls classification. C6 adapts `/drop` input to
`resolveCommitRef`; it owns no second resolver.

Resolve the candidate to one full SHA, then run:

```text
git rev-list --parents -n 1 <resolvedSha>
```

Strict parse:

```text
1 token  → root
2 tokens → one parent
3+       → merge, reject
failure, empty output, non-hex token, or unexpected SHA → abort
```

No resolution failure may reach `update-ref`.

Define and share the wire/client error contract:

```ts
type HistoryErrorCode =
  | 'HISTORY_GIT_UNAVAILABLE'
  | 'HISTORY_VALIDATION_FAILED'
  | 'HISTORY_CONTENT_CHANGED'
  | 'HISTORY_SELECTION_STALE'
  | 'HISTORY_REPOSITORY_CHANGED'
  | 'HISTORY_REPOSITORY_OPERATION'
  | 'HISTORY_LATEST_CHANGED'
  | 'HISTORY_MARKER_MISSING'
  | 'HISTORY_MARKER_INVALID'
  | 'HISTORY_MARKER_CROSS_VAULT'
  | 'HISTORY_MARKER_AMBIGUOUS'
  | 'HISTORY_LEGACY_UNMARKED'
  | 'HISTORY_MERGE_COMMIT'
  | 'HISTORY_INVALID_CHANGED_PATH'
  | 'HISTORY_REF_RESOLUTION_FAILED'
  | 'HISTORY_PARENT_RESOLUTION_FAILED'
  | 'HISTORY_INDEX_LOCKED'
  | 'HISTORY_CONFLICT'

interface HistoryErrorBody {
  error: string
  code: HistoryErrorCode
  details?: Record<string, unknown>
}

class HistoryApiError extends Error {
  status: number
  code?: HistoryErrorCode
  details?: Record<string, unknown>
}
```

Server codes are stable. Clients branch on `error.code`, never
human-readable text. An unknown code or a legacy body without `code`
uses only a generic safe fallback; marker/ref classes are not inferred
from prose.

**Required tests:** every Ref/Parent Resolution test listed in C9,
plus all structured-error and C6 shared-ownership cases there.

### History-C12 — Serialize whole-Vault History mutations across processes

**Finding:** H-C12, P1, Closure Blocker.

**Files:** `server/history/git.ts`, `server/history/repo.ts`, a new
Vault-lock module and/or Repair-store module, `server/history/routes.ts`,
and server/route/multi-process tests.

**Implementation:**

Introduce one authoritative cross-process Vault mutation lock for the
complete server-side History mutation lifecycle. Use the stable
pre-/post-bootstrap anchor:

```text
<canonical-vault-root>/.nuvyn-history/vault-mutation.lock
```

Each operation enters it exactly once:

```text
Create Version
Withdraw
Restore
Repair Retry
Repair Discard
Repair migration/quarantine when a write is required
repository first-touch initialization
```

The lock covers HEAD CAS, post-CAS Real-Index synchronization, and
Repair/reconciliation settlement. Internal helpers never reacquire
it. A read-only operation remains unlocked only if it performs no
initialization, migration, quarantine, or other write.

The fixed lock acquisition order is:

```text
1. Vault mutation lock
2. Vault-id creation lock, only when identity initialization is needed
3. Repair metadata lock, only for Repair read-modify-write
4. Git .git/index.lock, only for Real-Index replacement
```

No code path reverses this order: it may not hold the Repair lock while
waiting for the Vault lock, hold `index.lock` while waiting for the
Repair lock, or hold the Vault-id lock while waiting for the Vault
lock.

Select the exclusive lock-record protocol. The record contains schema
version, process ID, host identity, random nonce, and acquisition
timestamp. Acquisition uses exclusive creation plus bounded
backoff/timeout. On contention:

1. read and validate the record;
2. fail closed when the host differs;
3. on the same host, test PID liveness;
4. never remove a live lock;
5. fail closed on PID reuse or indeterminate liveness;
6. for a positively dead owner, exclusively create one fixed
   recovery-claim directory;
7. reread and require the same nonce;
8. atomically rename the lock to
   `vault-mutation.lock.stale-<nonce>`, verify the quarantined record's
   nonce, remove it, and retry;
9. release the recovery claim in `finally`.

Elapsed time alone does not establish abandoned ownership. Malformed,
inaccessible, cross-host, or otherwise indeterminate records are left
for diagnosis and fail closed. Ordinary cleanup closes and unlinks
only the lock whose nonce the current process owns.

Introduce `withRepairMetadataLock` under the Vault lock. All of the
following execute under that metadata lock:

- `recordIndexRepair`;
- `settleIndexRepairPaths`;
- `discardIndexRepair`;
- v1 migration;
- corrupt quarantine;
- any read-modify-write state transition.

`GET /repair-status` is read-only. If migration or quarantine is
needed, it enters the locked mutation helper before writing; it never
performs an unlocked write.

Keep the distinctions explicit:

```text
atomic publication                    implemented already for non-empty writes
process-restart persistence           implemented already
power-loss durability                 not established
cross-process lost-update protection  delivered by this task
```

**Required tests:** every Repair Metadata and Cross-process Vault
Mutation Serialization case listed in C9.

### History-C13 — Serialize complete repository bootstrap

**Finding:** H-C13, P2, Closure Blocker.

**Files:** `server/history/repo.ts`,
`server/__tests__/history-git.test.ts`.

**Implementation:**

Run the whole first-touch flow under the C12 Vault
mutation/bootstrap lock:

```text
acquire Vault mutation/bootstrap lock
→ recheck hasOwnGitDir inside the lock
→ if a repository exists, validate it and return without rewriting
→ create .gitignore with flag: 'wx'
→ create .gitattributes with flag: 'wx'
→ git init using the existing fallback sequence
→ verify this Vault owns a valid Git directory/worktree
→ set core.autocrlf=false
→ release the lock
```

Only `EEXIST` on dotfile creation is idempotent success. Propagate
every other error. Existing dotfile content is never overwritten.
When dotfiles exist but `git init` failed, the next lock holder retries
safely. Different Vaults use separate lock anchors and initialize in
parallel.

The configuration policy is fixed: set `core.autocrlf=false` only when
Nuvyn performs first-touch `git init`. For a pre-existing repository,
validate ownership/worktree and return without reinitializing,
rewriting user dotfiles, replacing repository identity, or changing
its existing `core.autocrlf` setting.

**Required tests:**

```text
serializes concurrent ensureRepo callers
only one caller performs git init
all callers observe one valid repository
does not overwrite a concurrently created .gitignore
does not overwrite a concurrently created .gitattributes
retries safely after partial initialization failure
rechecks repository existence after acquiring the lock
different Vaults can initialize in parallel
```

### History-C14 — Replace injectable textual Log framing

**Finding:** H-C14, P2, Closure Blocker.

**Files:** `server/history/git.ts`,
`server/__tests__/history-git.test.ts`, route/API tests as needed.

**Implementation:**

Use one NUL-framed Git output contract. Header fields and name-only
paths are NUL-terminated; an empty NUL field closes each record.
Because Git commit messages and path names cannot contain NUL, the
parser can consume exact field boundaries without a textual sentinel.
Validate field count, SHA, date, and record termination; malformed
output fails instead of yielding partial `CommitRecord`s.

Delete `LOG_SEPARATOR` and `findHeaderEnd`. Do not add a second
message-validation fallback.

**Required tests:**

```text
does not create phantom log records from delimiter characters
round-trips a message containing record-separator characters
round-trips multiline commit bodies and control characters safely
does not interpret body lines as file names
rejects malformed NUL framing
```

### History-C15 — Run final closure verification

After C9 passes, C15 is the only task that executes the complete final
verification on one immutable candidate production SHA:

```text
npm run typecheck
npm run build
npm test -- --run
approved History Long Flow
git diff --check
Linux full suite
macOS full suite
Windows full suite
```

Record exact commands, SHA, platform, run URL/log, date, and results.
Successful C15 evidence closes H-C8. A documentation-only check is not
Final Production Baseline evidence.

### History-C16 — Capture immutable Final Production Baseline

Only after C15 is green, record the immutable production SHA in the
Closure. Do not guess it and do not record a commit's own unknown SHA
inside that same commit.

### History-C17 — Owner approval and maintenance-mode entry

After all blockers are closed, the final SHA is recorded, and the
Owner approves:

- flip Closure to CLOSED;
- set Owner Approval to approved;
- update README with the final production SHA;
- activate Maintenance-Mode rules.

Until then:

```text
Owner Approval: PENDING / BLOCKED
Final Production Baseline: NOT YET CAPTURED
Maintenance Mode: NOT ENTERED
```

## Execution Order

```text
Phase 0
  Final documentation Contract Completion

Phase 1
  Shared safety foundations:
  C10, C11, C12, C13, C14

Phase 2
  API/client truthfulness:
  C1, C2, structured C4 error propagation

Phase 3
  Marker and Index safety:
  C4, C6 adapter, C3

Phase 4
  Restore and Timeline:
  C5, C7

Phase 5
  Aggregate regression gate:
  C9

Phase 6
  Final verification:
  C15
  successful C15 evidence closes H-C8

Phase 7
  Final production baseline and approval:
  C16, C17
```

C3, C4, C6, C10, C11, and C12 touch shared server core. The phase
order is mandatory; parallel implementation against the same
functions is not authorized by this Plan.

## 2026-08-01 Focused Correction Execution Record

This record supersedes the direct-`git restore` implementation proposed
in History-C5 and the per-operation cross-process mutex proposed in
History-C12. It does not mark the rest of the Closure plan complete.

RED commit `36fed44dbf0276ee876f1d2a1f8d6c51c6bc7be9`
added deterministic folder-move/History and two-process failures before
the production correction. Production commit
`1a065bb0c2517f8a1fe1886b806e6945c2830538` then implemented:

1. process-lifetime single-writer ownership for the canonical Vault,
   before recovery, migration, or serving mutation routes;
2. process-local `withVaultMutation` shared by folder lifecycle,
   recovery, all persisted History mutations, and bootstrap;
3. the order lifetime owner → Vault mutation → structure → sorted
   documents → repository queue → `index.lock` → atomic commit;
4. Restore by immutable blob read plus document-protocol CAS or
   create-only commit, metadata settlement, and authoritative post-read;
   and
5. complete Withdraw/Create/Repair transactions retained inside the
   shared boundary through HEAD, Real Index, and Repair settlement.

No folder-move v4 phase, journal schema, executor, metadata state
machine, generation rule, quarantine rule, or SQLite ownership
footprint changed. Local verification passed 145 focused tests, the
complete 2,478-test run (2,476 passed, 2 skipped), typecheck, build, and
diff check. Cross-platform CI and Owner Approval remain pending, so the
History Closure status remains `DRAFT — CLOSURE IN PROGRESS`.
