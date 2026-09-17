# Vault Git History — Design

**Date:** 2026-07-30
**Consolidated:** 2026-07-31
**Status:** Retrospective Reconstruction — Pending Owner Approval
**Closure:** DRAFT — CLOSURE IN PROGRESS
**Production-code review baseline:** `00b17359d151bbdbe56115ed992700ecbb5e1ca1`
**Repository:** `tangxiangxiang/nuvyn`

> **History Feature State: TEMPORARILY FROZEN**
>
> Normal Personal Use: SUPPORTED<br>
> Final Closure: NOT COMPLETE<br>
> Owner Approval: PENDING<br>
> Maintenance Mode: NOT ENTERED

This retrospective specification is the design authority for Vault Git
History. It must be read with the
[Implementation Plan](../plans/2026-07-30-vault-git-history-implementation-plan.md),
[Implementation Record](../implementation-records/vault-git-history-implementation-record.md),
and [Draft Closure](../closures/vault-git-history-final-closure.md).

No production or test file changed between the production-code review
baseline and this consolidation. The labels below are normative:

- **Observed on production-code review baseline** — source behavior at
  `00b17359d151bbdbe56115ed992700ecbb5e1ca1`.
- **Intended contract / Planned remediation / Closure requirement /
  Not implemented on the reviewed production baseline** — required
  future behavior. It must not be cited as current behavior.

## 1. Problem

Vault Git History must let a user inspect, compare, restore, create, and
withdraw versions without becoming a general Git client and without
silently destroying Working Tree or Real-Index intent created outside
Nuvyn.

The state authorities are distinct:

```text
Editor Buffer → Working Tree → Temporary Commit Index → Commit/HEAD
                                      │
                         Real Git Index is independent
```

The Working Tree supplies version bytes. A Temporary Git Index builds
the commit. The Real Git Index may contain external staged intent and
must not be treated as disposable.

## 2. Product Goal

The feature shall:

1. show managed dirty Markdown paths;
2. create one explicit multi-file version from exact Working Tree
   bytes;
3. browse document history and compare a revision with current content;
4. restore one historical document to the Working Tree only;
5. withdraw the latest commit only when it carries exactly one valid
   canonical same-vault Nuvyn marker block, while preserving Working
   Tree bytes and unrelated Real-Index entries;
6. distinguish synchronized, preserved-external, and failed Index-sync
   paths truthfully;
7. expose a persistent, conflict-safe Repair path only for failed sync
   paths.

The marker is an accidental-withdrawal guard, not cryptographic
provenance proof.

## 3. Scope

**Observed on production-code review baseline**

- capability and repository bootstrap;
- Status, Log, Snapshot, and Diff APIs;
- Create Version with exact-byte capture, a Temporary Commit Index,
  `commit-tree`, and CAS `update-ref`;
- persisted Index Repair metadata;
- Working-Tree-only Restore;
- latest-HEAD Withdraw;
- Vue History panels, timeline, snapshots, comparisons, Restore,
  Withdraw, and per-Vault mutation barriers.

**Intended closure contract — not implemented on the reviewed
production baseline**

- canonical same-vault markers and atomic Vault identity;
- F0/F1 path-selective Real-Index synchronization;
- symlink-safe filesystem containment;
- fail-closed HEAD/commit/parent resolution;
- whole-Vault cross-process mutation serialization, including Repair
  metadata lost-update protection;
- one-transaction Restore with authoritative post-read bytes;
- machine-safe Git-log framing;
- DST-safe local-calendar grouping;
- complete regression and three-platform verification.

## 4. Non-Goals

- branch, tag, merge, rebase, remote, or reflog management;
- arbitrary history rewriting;
- binary attachment history;
- Git hook or signing support for plumbing commits;
- a conflict-merge editor;
- treating a marker as proof of authorship or ownership;
- accepting legacy unmarked commits for Withdraw. They must be
  recommitted through the remediated Create Version flow.

## 5. Terminology

| Term | Definition |
|---|---|
| Editor Buffer | Mutable editor text; it may be ahead of disk. |
| Working Tree | On-disk Vault bytes. |
| Real Git Index | `.git/index`; it may contain external staged intent. |
| Temporary Commit Index | `GIT_INDEX_FILE` used to build a fixed commit tree without staging through the Real Index. |
| Commit | An immutable Git commit object. The term alone makes no Nuvyn provenance claim. |
| Nuvyn-marked Version | Intended closure term: a commit whose final canonical trailer paragraph contains exactly one `Nuvyn-Version: 1` and exactly one `Nuvyn-Vault-Version` matching current Vault metadata. This is not implemented on the reviewed production baseline. |
| Valid canonical same-vault marker | The exact marker block above, parsed from the final canonical trailer paragraph. It is an accidental-withdrawal guard, not cryptographic provenance proof. |
| Mutation Barrier | Client-side exclusion for overlapping Vault path mutations. |
| Repository mutation transaction | One `withRepoMutation(repoRoot)` execution. It is process-local on the reviewed baseline. |
| F0 | Real-Index fingerprints captured for every target path before the HEAD CAS. |
| F1 | Real-Index fingerprints re-read after acquiring `.git/index.lock`. |
| Preserved External Path | A target path whose Real Index contained pre-existing staged intent or changed between F0 and F1. It is preserved unchanged, creates no Repair Transaction, exposes no Retry action, and produces informational success only. |
| Failed Sync Path | A safe candidate whose synchronization failed because of lock, I/O, Temporary Index, verification, fsync, close, or atomic replacement failure. Only this class may create a Repair Transaction. |
| Index Repair Transaction | Intended closure definition: persistent metadata for failed sync paths, bound to the pre-HEAD F0 fingerprints. On the reviewed baseline, routine sync instead captures failure-time Real-Index fingerprints. |
| Degraded Success | The primary mutation succeeded but `failedPaths` or Repair-state persistence requires an informational warning. Preserved External Paths alone are informational success, not degraded failure. |
| WORKTREE | Sentinel for current on-disk content. |

## 6. Authority Model

1. Editor saves precede Create byte capture.
2. Create commits captured Working Tree bytes through a Temporary
   Commit Index.
3. HEAD moves only by CAS.
4. Real-Index synchronization is auxiliary to a successful HEAD move.
5. Existing or concurrent staged intent has authority over routine
   synchronization and must be preserved.
6. Restore changes Working Tree only.
7. A canonical same-vault marker controls Withdraw eligibility but
   does not establish cryptographic provenance.

## 7. Managed Path Contract

**Observed on production-code review baseline**

`isValidHistoryPath` validates only logical string shape:

- relative POSIX path;
- no NUL, backslash, absolute path, `..`, hidden segment, or trailing
  slash;
- lowercase kebab directory segments;
- lowercase kebab `.md` leaf.

It does not call `lstat`, reject symlinks, canonicalize a real path, or
verify filesystem containment. `safeWorktreeFile` checks lexical
containment after `path.resolve`, but ordinary reads still follow
symlinks.

**Intended closure contract — not implemented on the reviewed
production baseline**

Every History filesystem read or write uses one shared resolver
family rooted in:

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
```

The owned operations are
`resolveExistingHistoryFileForRead`,
`resolveExistingHistoryFileForWrite`,
`resolveHistoryPathAllowMissingLeaf`, and
`resolveDeletedHistoryPath`.

For an existing file:

```text
validate logical syntax
→ lstat every directory segment
→ reject symbolic-link directory segments
→ open the leaf without following symbolic links
→ fstat and require a regular file
→ verify canonical parent/root containment
→ reopen/lstat the pathname without following links
→ verify pathname identity equals the opened-handle identity
```

For a missing leaf:

```text
verify and open the existing parent directory
→ reject symbolic-link parent segments
→ verify canonical parent containment
→ capture parent directory identity
→ require only the final leaf to be absent
→ return verified parent identity plus leaf name
```

Immediately before creation or Restore, recheck parent identity and
the permitted leaf state. Fail closed if a symlink, unexpected file
type, or different parent appears. A selected deletion remains valid
when its logical path passes validation, its verified parent is
contained and non-symlinked, its leaf is absent, and its expected hash
is `null`; no `realpath` of the absent leaf is required. An untracked
file and a Restore to an initially absent leaf use the verified
missing-leaf mode.

POSIX opens use no-follow flags. Windows uses the selected
platform-specific handle/reparse-point inspection and the same
pathname/handle identity checks. `realpath` alone is never considered
race closure.

This applies to `/content-hashes`, Create capture, WORKTREE `/file`,
WORKTREE `/diff`, Restore read/write/post-read, and future
`restoreFileAtomic`.

## 8. Repository Initialization Contract

**Observed on production-code review baseline**

`ensureRepo` returns when the Vault has its own `.git`, otherwise writes
missing `.gitignore` and `.gitattributes`, initializes Git, and sets
`core.autocrlf=false`. `writeIfMissing` currently performs:

```text
fs.access(path) → fs.writeFile(path)
```

The check/write gap can overwrite a file another process creates.

**Intended closure contract — not implemented on the reviewed
production baseline**

Repository first touch is one transaction under the authoritative
cross-process Vault mutation/bootstrap lock defined in §17:

```text
acquire Vault mutation lock
→ recheck hasOwnGitDir inside the lock
→ if a repository exists, validate it and return without rewriting
→ create .gitignore with flag: 'wx'
→ create .gitattributes with flag: 'wx'
→ git init using the existing fallback sequence
→ verify this Vault owns a valid Git directory/worktree
→ set core.autocrlf=false
→ release the lock
```

Only `EEXIST` during either dotfile creation is idempotent success.
Every other error propagates. A partial initialization in which
dotfiles exist but `git init` failed is safely retryable by the next
lock holder. Different Vaults use different lock anchors and may
initialize in parallel.

The configuration policy is fixed: `core.autocrlf=false` is set when
Nuvyn performs first-touch `git init`. A pre-existing Vault repository
is validated but is not reinitialized, its dotfiles and repository
identity are not replaced, and its existing `core.autocrlf` setting is
not rewritten.

## 9. Status Contract

**Observed on production-code review baseline**

The server returns `503 { dirty: [], available: false }` when Git is
unavailable. The client passes `allowNonOkJson: true` unconditionally,
so a genuine non-graceful 5xx can be returned as a body-shaped success.

**Intended closure contract — not implemented on the reviewed
production baseline**

Only the exact graceful 503 body is recovered. Every other non-2xx
throws `HistoryApiError`.

## 10. Create Version Contract

### 10.1 Observed on production-code review baseline

The server sequence is:

```text
validate request
→ ensureRepo
→ acquire withRepoMutation
→ assertRepositoryIdle
→ ensureIndexRepairStorageReady
→ re-read Status
→ reject stale selections
→ captureExpectedFiles
→ ensure author
→ read old HEAD
→ build Temporary Commit Index from old HEAD
→ stage captured bytes and verify
→ write tree
→ create commit object with user message
→ assertRepositoryIdle
→ CAS update-ref HEAD
→ show immutable commit files
→ routine Real-Index sync
→ settle or record Repair metadata
```

Current routine Create sync runs
`git reset -q <targetHead> -- <paths>` against the Real Index with up
to three attempts. It does not capture F0, compare F0 to old HEAD,
re-read F1 under a hand-taken lock, or return the three path classes.
On routine failure, `recordIndexRepair` re-reads the failure-time Real
Index as `expectedIndex`.

The client acknowledges the returned commit inside a `try` that also
contains:

```text
release barrier
→ Promise.all(refreshStatus, refreshLog)
→ refreshComparisons
→ selection/message cleanup
```

Any refresh rejection enters the overall failure catch, may show
`commit_failed`, and may leave selection/message uncleared. A retry can
therefore create a duplicate version.

### 10.2 Intended closure contract

**Planned remediation / Closure requirement / Not implemented on the
reviewed production baseline**

The only accepted sequence is:

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
→ routine Real-Index synchronization
```

Root/empty semantics:

```text
oldHead entry absent + Real Index entry absent
→ safe candidate

oldHead entry absent + Real Index entry present
→ preserved external staged intent
```

Create appends exactly one canonical marker block. Primary success is
acknowledged immediately when `createCommit(...)` returns a validated
success body. At that boundary, synchronously settle the server
result, completion state, `lastCommittedPaths`, selection, message,
returned Repair state, and success/degraded-success classification.

Everything later is auxiliary: save-barrier release, Status, Log,
Comparison and Repair-status refresh, toast rendering, and local
reconciliation. `settleAfterSuccessfulCommit(...)` awaits barrier
release exactly once outside the primary mutation catch, retains
structured auxiliary failure fields, and collapses one or more
auxiliary failures into one informational summary. A barrier-release
failure has its own message because pending editor-save work may not
have finalized; it does not restore composer state, permit a duplicate
retry, or prevent the path mutation lock from being released in
`finally`.

```ts
interface CommitAuxiliaryOutcome {
  barrierReleaseFailed: boolean
  statusRefreshFailed: boolean
  logRefreshFailed: boolean
  comparisonRefreshFailed: boolean
  repairStatusRefreshFailed: boolean
}
```

The same primary-success rule applies to Withdraw and Restore:
server success cannot become failure because of local cleanup, tab
cleanup, barrier release, Repair-status refresh, or repository
refresh.

## 11. Real Index Safety Contract

### 11.1 Observed on production-code review baseline

- Create routine sync uses the three-attempt Real-Index reset described
  in §10.
- Withdraw routine sync already takes `.git/index.lock`, copies the
  Real Index into a Temporary Index, updates and verifies it, then
  publishes it.
- `repairIndexWithLock` and `syncDroppedIndexPaths` both already use
  the correct publication lifecycle:

```text
write replacement bytes into .git/index.lock
→ fsync lock handle
→ close lock handle
→ rename .git/index.lock to .git/index
```

Before rename, failures execute:

```text
close handle
→ remove .git/index.lock
→ remove Temporary Index directory
```

There is no observed open-handle rename defect in these current
helpers. The gap is that planned `syncIndexAtomic` must explicitly
inherit this lifecycle.

### 11.2 Intended closure contract

**Planned remediation / Closure requirement / Not implemented on the
reviewed production baseline**

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

`safeCandidatePaths` is derived inside the server from F0 and old-HEAD
tree entries. It is not a caller-supplied second authority.
Duplicate request paths are rejected during normalization. All outcome
arrays preserve normalized request order and satisfy:

```text
the three arrays are pairwise disjoint

set(synchronizedPaths)
∪ set(preservedExternalPaths)
∪ set(failedPaths)
= set(request.paths)
```

Classification:

- `synchronizedPaths` passed F0/old-HEAD and F1/F0 checks and were
  published by the Real-Index rename; Temporary-Index verification
  alone never qualifies.
- `preservedExternalPaths` had pre-existing or concurrent staged
  intent. Their Real-Index entries stay unchanged; they create no
  Repair, banner, or Retry and produce one informational toast.
- `failedPaths` were safe candidates but synchronization failed.
  Only these paths may create a Repair bound to F0.

Compatibility:

```ts
indexRefreshFailed = failedPaths.length > 0
```

Preserved paths never set `indexRefreshFailed`.

The lock lifecycle is fixed:

```text
Acquire .git/index.lock via open(..., 'wx')
→ read Real Index / classify F1
→ build and verify Temporary Index
→ truncate/write lock file
→ fsync lock handle
→ close lock handle
→ rename index.lock to index                 // sole commit point
→ replacementApplied = true
→ re-read HEAD
```

If rename has not committed, close the handle, remove `index.lock`,
and remove the Temporary Index directory.

- No safe path before locking: do not create `index.lock`; do not run
  reset/update-index; do not write or rename.
- Lock acquired but all paths become preserved: close and remove
  `index.lock`; return informational success; do not write or rename.
- Mixed paths are classified independently. An F1 mismatch preserves
  that path and does not fail safe siblings.
- Before rename, any global repository-operation, HEAD, lock, I/O,
  Temporary Index, reset/update-index, verification, lock write,
  fsync, close, or rename failure leaves
  `synchronizedPaths: []`, preserves already-preserved paths, and
  places every `pathsToSynchronize` path in `failedPaths`. All
  pre-rename failures return `replacementApplied: false`.
- Routine sync performs no destructive retry.
- Windows degraded-success normalization is limited to `EEXIST`,
  `EBUSY`, `EAGAIN`, and `EPERM` only when positively classified as
  lock contention. Ordinary permission errors remain failures.

After rename:

- if the re-read HEAD still equals `targetHead`,
  `pathsToSynchronize` become `synchronizedPaths`,
  `replacementApplied: true`, and `reconciliationRequired: false`;
- if the re-read HEAD differs, the published replacement is reported
  truthfully with `replacementApplied: true`,
  `finalHead != targetHead`, and `reconciliationRequired: true`.
  `synchronizedPaths` remains empty. To preserve the partition,
  `pathsToSynchronize` appear in `failedPaths`, but they must not
  create an ordinary F0-bound Repair.

The selected post-replacement model is a separate persisted
reconciliation transaction:

```ts
interface IndexReconciliationTransaction {
  kind: 'post-replacement-head-change'
  token: string
  status: 'pending' | 'superseded'
  appliedTargetHead: string | null
  head: string | null              // finalHead observed after rename
  paths: string[]
  expectedIndex:
    Record<string, IndexEntryFingerprint[]> // applied replacement
}
```

It records fingerprints from the replacement that actually landed,
not F0. The server result carries the transaction and
`reconciliationRequired: true`. The client shows a distinct
"Index reconciliation required after concurrent HEAD movement"
banner and informational toast.

Retry acquires locks in the §17 hierarchy, requires current HEAD to
equal the recorded `head`, and requires current path fingerprints to
equal `expectedIndex`. It then builds and atomically publishes a
Temporary Index synchronized to that recorded HEAD. A HEAD or
fingerprint mismatch marks the transaction `superseded` without
touching the Index. Discard removes only reconciliation metadata and
keeps the currently published Index. Repair-state persistence failure
remains degraded success and never causes a fallback F0-bound Repair.

## 12. Log and Timeline Contract

### 12.1 Observed on production-code review baseline

`log()` frames records with
`\x1e__NUVYN_LOG__\x1e`. Commit messages are only checked for
non-empty text, so the separator can occur in a message and
`parseLog` can split a phantom record. The `log()` JSDoc says
`--follow`, while the implementation intentionally does not use it.

Timeline grouping computes day deltas by dividing local-midnight
millisecond differences by `86_400_000`, which is wrong across
23-hour and 25-hour DST days.

### 12.2 Intended closure contract

**Planned remediation / Closure requirement / Not implemented on the
reviewed production baseline**

- Replace the custom textual record separator with a machine-safe,
  NUL-framed Git log format and parse exact field boundaries.
- Round-trip multiline bodies and control characters without phantom
  records or body lines becoming file names.
- Use local-calendar ordinals for day grouping.
- Run DST regression cases by spawning a child Node/Vitest process
  with an explicit `TZ` environment.

Rename history remains path-scoped and not `--follow`-merged
(`H-K8`). Log/Timeline pagination remains out of scope (`H-K10`).

## 13. Snapshot Contract

Committed refs are read through `git show <ref>:<path>`. WORKTREE reads
are direct filesystem reads.

**Observed on production-code review baseline:** logical path
validation does not prevent symlink traversal.

**Intended closure contract:** every WORKTREE read uses the resolver
in §7. A committed Git object read does not dereference a Working Tree
symlink, but every path presented to filesystem I/O must still pass the
same logical contract.

## 14. Comparison Contract

Comparison uses the selected historical revision as the old side and
prefers a loaded editor buffer for the current side, falling back to
WORKTREE content. It is read-only.

WORKTREE `/diff` inherits the symlink blocker in §7. The closure tests
must prove that outside-Vault bytes are not exposed through either
WORKTREE `/file` or `/diff`.

## 15. Restore Contract

### 15.1 Observed on production-code review baseline

The route:

```text
rawAt(requestedRef, path) outside repository mutation transaction
→ restoreFile(requestedRef, path)
   → one withRepoMutation
   → git restore --source=<requestedRef> --worktree
→ fs.stat(path)
→ return pre-restore source raw + later mtime
```

The client then uses `request.historicalRaw`, not `result.raw`, for
the editor baseline and `VaultFileChanges`. Logical path validation
does not reject symlink destinations.

### 15.2 Intended closure contract

**Planned remediation / Closure requirement / Not implemented on the
reviewed production baseline**

`restoreFileAtomic(...)` is the sole entry point and owns exactly one
`withRepoMutation`. The route adds no outer mutex, performs no
`rawAt` pre-check, and does not call the old internally locked helper.

Inside that transaction:

```text
resolve accepted ref once to one immutable full commit SHA
→ use that SHA for source read and restore
→ resolve existing destination or verified missing leaf
→ verify parent/path immediately before git restore
→ restore Working Tree only
→ open verified destination handle
→ fstat/read/fstat identity check
→ reopen/lstat pathname without following symbolic links
→ compare pathname identity with opened-handle identity
→ on identity race, retry the complete post-restore verification once
→ on a second mismatch, return 409 HISTORY_CONFLICT
→ return the post-restore snapshot observed inside the repository
  mutation transaction
```

`git restore --worktree -- <path>` accepts a pathname, not a verified
file handle. Filesystem validation cannot make an external filesystem
actor disappear. Holding the Vault mutation lock serializes Nuvyn
processes, but an untrusted local process with filesystem write access
can still race pathname replacement. The implementation verifies
immediately before and after Git, detects observed symlink/identity
substitution, and fails closed; it cannot provide a kernel-level
transaction across Git and arbitrary external writers.

The contract promises only the verified post-restore snapshot observed
inside the repository mutation transaction. `result.raw` and
`result.mtime` must describe the same opened object, and that object
must still be reachable at the requested pathname after the final
identity check.
The client uses `result.raw` for editor state and file-change events
while preserving newer editor edits.

## 16. Withdraw Contract

### 16.1 Observed on production-code review baseline

`/drop` accepts 7–40 hex, but compares the request directly with the
full SHA returned for HEAD. It performs no marker check and filters
changed files only by `.endsWith('.md')`.

`readCurrentHead` maps every non-zero `rev-parse --verify HEAD` result
to `null`. Parent resolution runs `git rev-parse <sha>^`; every
non-zero result is treated as root, after which Withdraw may run:

```text
git update-ref -d HEAD <sha>
```

This does not fail closed on operational or malformed-resolution
errors. After a successful HEAD CAS, Withdraw uses the lock lifecycle
in §11. Its three principal refreshes already use
`Promise.allSettled`; `closeDroppedRevision`,
`refreshIndexRepairStatus`, and other local success updates still need
isolation tests.

### 16.2 Intended closure contract

**Planned remediation / Closure requirement / Not implemented on the
reviewed production baseline**

History-C11 owns the shared fail-closed primitives; History-C6 only
adapts `/drop` 7–40 hex input to `resolveCommitRef` and owns no second
resolver implementation:

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
resolveCommitRef(repoRoot, requested): Promise<CommitResolution>
resolveCommitParents(repoRoot, fullSha): Promise<ParentResolution>
```

The Withdraw flow:

1. Resolve a 7–40 hex request once to one full immutable commit SHA
   through the shared primitive.
2. Use that full SHA for HEAD equality, marker check, parent parse,
   changed paths, and CAS update-ref.
3. Require exactly one valid canonical same-vault marker.
4. Reject unmarked, malformed, ambiguous, cross-vault, merge, and
   invalid-changed-path candidates.
5. Legacy unmarked commits fail closed and must be recommitted through
   the new Create Version flow.
6. Resolve parents through the shared primitive backed by:

```text
git rev-list --parents -n 1 <resolvedSha>

1 token  → root commit
2 tokens → exactly one parent
3+       → merge commit, reject
command failure / malformed output → abort, do not move HEAD
```

Positive unborn detection is exact:

```text
git rev-parse --verify HEAD

status 0:
  validate one full object id
  return { kind: 'head', sha }

non-zero:
  git symbolic-ref -q HEAD
  status 0:
    validate the returned ref
    git show-ref --verify --quiet <returned-ref>
    show-ref status 1 → positive unborn branch
    show-ref status 0 → inconsistent operational failure
    other status      → operational failure
  symbolic-ref status 1 → detached/invalid operational failure
  other status           → operational failure
```

No stderr wording controls classification.

Client conflict UX distinguishes latest-changed, repository operation,
invalid same-vault marker, cross-vault marker, ambiguous marker,
legacy unmarked commit, merge commit, and invalid changed path.

## 17. Repository Mutation Serialization

### 17.1 Observed on production-code review baseline

`addAndCommit`, `dropHeadCommit`, `restoreFile`, `repairIndex`, and
`discardIndexRepair` use one process-local Promise-chain mutex keyed by
`path.resolve(repoRoot)`.

Repair JSON migration, quarantine, and read-modify-write operations do
not all hold a cross-process metadata lock. Atomic rename prevents a
half-published file but does not prevent:

```text
process A reads state
process B writes new transaction
process A writes stale state
→ B update lost
```

### 17.2 Intended closure contract

**Planned remediation / Closure requirement / Not implemented on the
reviewed production baseline**

One Nuvyn process per Vault is not an implicit guarantee. Introduce
one authoritative cross-process Vault mutation lock for the complete
History mutation lifecycle. Its stable anchor is:

```text
<canonical-vault-root>/.nuvyn-history/vault-mutation.lock
```

The Vault-root anchor is selected instead of a Git-dir-only anchor so
the same lock exists before and after first-touch `git init`.

Every server-side mutating operation enters it exactly once:

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
Repair/reconciliation metadata settlement. Internal helpers are
lock-unaware and never reacquire it. Read-only operations remain
unlocked only if they perform no initialization, migration,
quarantine, or other write; a required write is redirected into the
single mutation entry point.

The fixed lock acquisition order is:

```text
1. Vault mutation lock
2. Vault-id creation lock, only when identity initialization is needed
3. Repair metadata lock, only for Repair read-modify-write
4. Git .git/index.lock, only for Real-Index replacement
```

No path may hold Repair metadata lock while waiting for the Vault
mutation lock, hold `index.lock` while waiting for Repair metadata
lock, or hold the Vault-id lock while waiting for the Vault mutation
lock.

The selected stale-lock model is an exclusive lock-file record plus an
atomic recovery claim. The lock record contains schema version,
process ID, host identity, random nonce, and acquisition timestamp.
Acquisition uses exclusive creation and bounded backoff/timeout.

On contention:

1. read and validate the record;
2. if the host differs, liveness cannot be established and the
   operation fails closed;
3. on the same host, test process liveness by PID;
4. never remove a live lock;
5. PID reuse or indeterminate liveness fails closed;
6. a positively dead owner may be recovered only after exclusively
   creating a fixed recovery-claim directory, rereading the record,
   and verifying the same nonce;
7. atomically rename the lock to
   `vault-mutation.lock.stale-<nonce>`, verify the claimed record still
   has that nonce, then remove the quarantine and retry;
8. release the recovery claim in `finally`.

Elapsed time by itself is never proof of abandoned ownership.
Malformed, inaccessible, or host-indeterminate lock records are not
deleted; they fail closed and remain available for operator diagnosis.
Ordinary exceptions close and unlink only the lock whose nonce the
current process owns.

Repair record, settle, discard, migration, and quarantine additionally
use the Repair metadata lock under the Vault mutation lock. A
read-only status request never performs an unlocked write.

These properties are distinct:

- atomic publication — observed for non-empty Repair JSON writes;
- process-restart persistence — observed;
- power-loss durability — not established;
- cross-process lost-update protection — not implemented.

Vault-id first-touch uses its own atomic claim protocol: dedicated
metadata creation lock, temporary file, full UUID write, fsync, close,
atomic publication, and parent-directory fsync where supported.

## 18. Repository Operation State

**Observed on production-code review baseline**

The source checks seven markers:

```text
MERGE_HEAD
CHERRY_PICK_HEAD
REVERT_HEAD
REBASE_HEAD
rebase-merge
rebase-apply
sequencer
```

Create and Withdraw check at entry and immediately before HEAD CAS.
Only `MERGE_HEAD` and `CHERRY_PICK_HEAD` are directly parametrized by
the current Create test; the full seven-marker behavior is
source-traceable but incompletely tested.

**Intended closure contract**

All server-side mutations enter exactly one repository mutation
transaction and apply the operation-state check appropriate to that
operation. HEAD-moving mutations perform a second idle check
immediately before CAS `update-ref`. Restore and Repair do not move
HEAD and are not described as HEAD-moving operations.

## 19. Error Model

### 19.1 Observed on production-code review baseline

- Validation: 400.
- Missing ref/path: usually 404.
- stale bytes, stale selection, HEAD CAS, or repository operation:
  409.
- Index synchronization after a successful HEAD move:
  success response with `indexRefreshFailed`.
- Create post-response refresh rejection can enter `commit_failed`
  (`H-C2`).
- Withdraw principal refreshes use `Promise.allSettled`, but remaining
  success callbacks are not all isolated.
- all Withdraw 409 errors except repository operation are currently
  displayed as latest-changed.

### 19.2 Intended closure contract

**Planned remediation / Closure requirement / Not implemented on the
reviewed production baseline**

All History endpoints use one stable machine-readable error schema:

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

The server assigns stable codes independent of localized or
human-readable text. The client selects marker, ref, parent,
repository-operation, and conflict UX from `error.code`. It never
infers one of those classes from the prose in `error`. A legacy body
without `code` still produces `HistoryApiError`, retaining status and
message, but takes only the generic safe fallback.

| Class | HTTP/result | UI |
|---|---|---|
| Primary mutation failed before success | 4xx/5xx | Error; no success acknowledgement. |
| Successful commit/withdraw plus refresh failure | Success | Mutation remains successful; one informational refresh warning. |
| Preserved External Staged Intent | Success; `failedPaths: []`; `preservedExternalPaths` non-empty | One informational toast; no Repair banner or Retry. |
| Failed Sync Path | Success with `failedPaths` and optional Repair | Informational degraded-success toast; Repair only for failed paths. |
| Marker/ref/parent conflict | Specific 409 code | Specific client message; never collapsed into latest-changed. |

Commit success is acknowledged immediately after the success response.
Every later refresh is outside the commit-failure catch boundary.

## 20. Accessibility

Existing keyboard and ARIA behavior remains required: listbox/option
semantics, keyboard navigation, context-menu keyboard access,
confirmation before Restore/Withdraw, busy state, and focus
restoration.

## 21. Performance

Log defaults to 200 entries; there is no Timeline/Log pagination.
`H-K10` remains a non-blocking product limitation. Safety checks may
add filesystem segment walks and metadata locks; correctness takes
precedence over micro-optimizing these local operations.

## 22. Security

**Observed on production-code review baseline**

- Git is spawned without a shell and paths are separated with `--`.
- logical path and ref syntax are allowlisted;
- WORKTREE does not reach Git;
- repair tokens are opaque 32-hex values;
- no filesystem symlink containment is enforced;
- any current HEAD commit can be withdrawn;
- log framing trusts an injectable textual separator.

**Intended closure contract**

- the resolver in §7 closes filesystem containment;
- marker checks close accidental withdrawal of unrelated commits;
- machine-safe log framing closes delimiter injection;
- fail-closed ref/parent resolution prevents destructive
  misclassification.

The marker trust boundary is exact: it is an
accidental-withdrawal guard, not cryptographic provenance proof. A
local actor who can write Git objects or `<git-dir>/nuvyn/` can forge
it and is outside this feature's trust boundary.

## 23. Compatibility

### 23.1 Observed on production-code review baseline

- Windows, macOS, and Linux are historically supported.
- CI configurations exist.
- The current closure baseline has not been independently verified on
  all three platforms.
- `core.autocrlf=false` and a CRLF real-Git test exist.
- SHA-1 is assumed by the 40-zero empty-HEAD CAS sentinel (`H-K13`).
- only `EEXIST` is normalized as hand-taken Index-lock contention in
  current helpers.

No test, build, typecheck, or cross-platform result is inferred from
source review.

### 23.2 Intended closure contract

**Closure requirement / Not implemented or not verified on the
reviewed production baseline**

- complete Linux, macOS, and Windows full-suite verification;
- normalize only positively identified contention codes listed in
  §11;
- retain exact-byte behavior across supported platforms.

## 24. Acceptance Criteria

Closure requires all applicable tests below and the full Plan/Closure
gate.

### Index synchronization

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

### Symlink safety

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

### Ref and parent resolution

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

### Marker and Vault metadata

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

### Repair metadata

```text
serializes concurrent record and settle
does not lose transactions during migration
does not lose transactions during quarantine
cleans metadata lock after failure
repair-status does not perform an unlocked write
```

### Cross-process Vault mutation serialization

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

### Restore

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

### Commit and Withdraw success boundary

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

### Timeline, parser, and bootstrap

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
```

The Closure additionally requires typecheck, build, full tests, Long
Flow, and Linux/macOS/Windows evidence on the final production SHA.

## 25. Known Risks and Open Questions

The following table is canonical across the Spec, Plan, Implementation
Record, Closure, and README.

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

No Closure Blocker in this table is an Accepted Risk. Owner Approval
remains pending; no Final Production Baseline has been captured.

## 26. 2026-08-01 H-C5/H-C12 Correction Overlay

The retrospective baseline and intended contracts above remain useful
history, but the following implemented correction supersedes their
direct-`git restore` and per-operation lock assumptions for H-C5/H-C12.

One active Nuvyn writer owns a canonical Vault for the server lifetime.
The `.nuvyn/vault-writer.json` record is acquired by exclusive creation
before recovery, metadata migration, or mutation-route mounting. A
malformed, cross-host, live, or indeterminate owner fails closed; only a
complete same-host record with a positively dead PID can be taken over,
after an exclusive recovery claim and immediate nonce/liveness recheck.

Within the active process, one canonical-root `withVaultMutation`
coordinator is the outer boundary for folder lifecycle, folder-move v4
recovery, Create Version, Withdraw, Restore, Index Repair state changes,
and repository bootstrap. The order is lifetime ownership, Vault
mutation, structure lock, sorted document locks, repository queue, Git
`index.lock`, then the atomic filesystem commit point. Recursive
same-Vault acquisition fails structurally, preventing the inverse
`withRepoMutation → withVaultMutation` order.

The implemented Restore contract is now:

```text
withVaultMutation
→ structure and document lock
→ retained journal ownership check
→ resolve requested ref once to an immutable commit SHA
→ read that commit's blob
→ capture current file and metadata generation
→ CAS replace an existing document or create-only commit a missing one
→ preserve/settle document identity metadata
→ read and verify the committed generation
→ return the authoritative committed bytes
```

This removes production `git restore --worktree` use. It remediates the
cross-feature H-C5 race and the active-writer/whole-Vault H-C12 race in
code at `1a065bb0c2517f8a1fe1886b806e6945c2830538`. It does not close the
broader H-C10 all-History containment finding, other History findings,
cross-platform verification, Owner Approval, or History Closure.

## 27. 2026-08-02 Current Production Overlay

The current production-code baseline is
`5df3ad9b50aebfc0d368a1d2865ec85de06afc98`. It supersedes the earlier
`b08627b` overlay. The current implementation now has strict AI History
path/status validation, bounded server-generated diffs, request abort
propagation, Create HEAD-change detection, original-fingerprint Repair
metadata persistence under `index.lock`, persistent UUID Vault markers,
locked Restore path resolution with segment identity checks, and structured
History API error codes/details. Existing History layout and interactions are
unchanged.

The current status is explicit:

| Area | Current status |
|---|---|
| AI path/data/resource boundary | Remediated and covered by route tests, including symlink and deleted-blob limits |
| Create/Withdraw/Repair consistency | Remediated for the deterministic HEAD/Index races; staged intent is fail-closed |
| Restore containment | Static and tested replacement symlink cases are fail-closed; portable directory-handle `openat` semantics remain unavailable |
| Cross-platform closure | Not complete: current evidence is macOS only |
| H-C13/H-K8/H-K10/H-K13 | Still open follow-up findings |
| Owner Approval | Pending |

Verification on macOS: `npm test -- --run` passed 163 files with 2522
passing tests and 2 skipped; `npm run typecheck` passed; `npm run build`
passed with existing dependency annotation/chunk-size warnings; and
`git diff --check` passed. History Closure remains
`DRAFT — CLOSURE IN PROGRESS` until cross-platform evidence and Owner Approval
are complete.

## 28. 2026-08-02 Follow-up Baseline

The current production-code baseline is
`b60630d2cd8fd840827aed15967a92b918e91a32`.

This baseline adds the following contract proofs without changing History
layout or interaction:

- missing-file Restore creates no temporary artifact until its final
  pre-create path/parent verification completes;
- prepared temporary files are owned by `dev/ino` plus parent-directory
  `dev/ino`, and unknown ownership fails closed for both commit and rollback;
- Index replacement reports whether it happened and which fingerprints were
  installed, allowing Repair to bind to the final observed HEAD after a
  deterministic rename-time HEAD race;
- AI commit-message diffs are line-oriented and budgeted by the final joined
  string; and
- History Repair/Withdraw responses preserve stable conflict and marker codes
  through route, API client, and composable layers.

Required local evidence:

```text
npm test -- --run: 163 test files passed; 2534 passed, 2 skipped
npm run typecheck: PASS
npm run build: PASS (existing dependency annotation/chunk-size warnings only)
git diff --check: PASS
```

The first sandbox-only full-suite attempt could not create `tsx` IPC pipes
(`EPERM`); the identical command passed with controlled process/IPC
permissions. Linux and Windows have not been run. The remaining portable
directory-handle/openat TOCTOU window in H-C10, explicit DST subprocess
coverage, H-C13 bootstrap serialization, and Owner Approval remain open.
History Closure is therefore still `DRAFT — CLOSURE IN PROGRESS`.

## 29. 2026-08-02 Temporary Ownership and Repair Persistence Follow-up

Production-code baseline: `bece8228227c5018339336c6ce00448b57192a6e`.

The atomic write contract requires creation-time ownership proof: capture
the parent directory identity before opening the exclusive temporary file,
capture the file identity from the open handle with bigint `stat`, close the
handle, then revalidate the parent and pathname identity before returning a
prepared operation. Commit and rollback continue to fail closed on any
mismatch. This closes the reviewed post-close re-claim race; it does not
claim portable `openat` semantics, so H-C10's residual check/use window stays
open pending a cross-platform directory-handle design.

Repair metadata has a separate degraded-conflict contract when a real Index
replacement has already happened but the replacement transaction cannot be
persisted. The result exposes `replacementApplied`, `finalHead`, and
`repairStatePersistenceFailed`; the route returns
`HISTORY_INDEX_REPAIR_STATE_PERSISTENCE_FAILED` with non-sensitive details,
and the UI instructs manual Git inspection. Arbitrary legacy-looking marker
values are reported only as unverified legacy markers, never as confirmed
Vault ownership.

The deterministic test seams cover the temporary close-to-identity window
and replacement-time Repair metadata failure. Final macOS evidence is 163
test files with 2537 passed and 2 skipped; typecheck, build, and
`git diff --check` all passed, with only existing build warnings. Linux/Windows
validation, DST subprocess evidence, H-C13 bootstrap serialization, and
Owner Approval are still required; Closure remains
`DRAFT — CLOSURE IN PROGRESS`.

## 30. 2026-08-02 Pathname Race Reduction

Production code: `dab1e12119c9f7f84316fe419a6d41b2e2fb3b63`.

The atomic writer now treats every temporary/staged artifact used by the
History document path as an owned generation (`dev`, `ino`, and parent
directory `dev`, `ino`). Durable create-only files obtain the file identity
from the still-open handle. The writer checks the parent again after opening
and before writing document bytes, and `atomicReplaceText` checks again before
rename. Conditional removal checks the target before takeover, the staged
generation after takeover, and the artifact/content immediately before unlink.
Unknown ownership is quarantined rather than removed. Deterministic test
hooks prove that outside files are not overwritten, deleted, or populated with
document bytes in the covered replacement windows.

This is deliberately documented as a partial portable mitigation. No
directory-handle-relative `openat`/`renameat`/`unlinkat` equivalent was added,
so the final pathname check/use TOCTOU window remains H-C10. The design must
not claim “fully safe”, “ownership guaranteed”, or “no external file can ever
be created” until that protocol or an equivalent cross-platform primitive is
implemented and verified. Closure remains `DRAFT — CLOSURE IN PROGRESS` until
H-C10 treatment, Linux/Windows validation, DST subprocess evidence, H-C13
bootstrap serialization, and Owner Approval are complete.

## 2026-08-02 Atomic Artifact Follow-up

Production commit: `e5e20c5ed3950e625003a443184fe8131cd20369`.
Client regression-test commit: `ba90ce51dca07606e0feaa300ef7826f1b52cf22`.

The History atomic text protocol now treats the old generation as mutable
even after takeover: replacement commit re-reads staged content after the
new target link and before cleanup. A same-inode external FileHandle write
therefore produces `HISTORY_POST_COMMIT_EXTERNAL_MUTATION`, retains the
changed staged generation, and records a `post-commit-external-mutation`
journal phase that recovery preserves.

Conditional remove no longer leaves the formal path absent when final staged
validation detects a same-inode change. It restores only a generation whose
identity is still proven, using create-only link; an externally re-created
target wins and the staged generation is quarantined. Durable journal and
recovery-payload cleanup uses creation or capture proofs with identity and
content-hash checks. Journal rewrite uses an incumbent-generation check and
post-rename inode verification.

This is not an H-C10 closure. The implementation still lacks a portable
dirfd/openat/renameat/unlinkat-equivalent protocol, so pathname check/use
windows remain. Empty outside temporary artifacts are still possible in the
unsupported-parent-replacement window, but document bytes are not written
there by the pre-write revalidation. Linux/Windows validation, DST subprocess
evidence, H-C13 bootstrap serialization, and Owner Approval remain pending.
Closure stays `DRAFT — CLOSURE IN PROGRESS`.

Verification on the macOS development host for this commit: 163 test files,
2551 passed, 2 skipped; `npm run typecheck` passed; `npm run build` passed
with existing dependency pure-annotation/chunk-size warnings; and
`git diff --check` passed. No Linux or Windows run and no Owner Approval are
claimed.

## 2026-08-02 History Feature Freeze

The design is temporarily frozen for maintenance prioritization. Normal
single-user personal use is supported, while remaining work is concentrated
in extreme filesystem concurrency races. Fully addressing those races would
require a directory-handle protocol, native filesystem interfaces, delayed
quarantine, or a broader file-transaction layer. This freeze avoids adding
complexity whose regression risk exceeds its current user benefit.

This is not final security acceptance, does not close all Closure findings,
and does not enter formal Closure maintenance mode.

### Supported Usage

- one user and one active Nuvyn instance;
- a local-disk Vault;
- ordinary editing, saving, restoring, version creation, and withdrawal;
- occasional non-adversarial external-editor edits;
- a personally managed Vault with regular backups.

### Unsupported / High-Risk Usage

Multiple Nuvyn instances on one Vault, high-frequency multi-editor writes,
unstable or network filesystems, multiple sync tools writing the same Vault,
hostile inode/pathname race generation, and security-boundary,
multi-user, or multi-tenant isolation are outside this temporary support
envelope.

### Deferred Findings

See [vault-git-history-freeze-backlog.md](../freezes/vault-git-history-freeze-backlog.md)
for H-FREEZE-1 through H-FREEZE-5. They remain `DEFERRED`, not closed.
The accepted risk is limited to local personal use, one active Nuvyn instance,
ordinary filesystem behavior, and a non-adversarial environment. It is not a
security proof and may be revoked.

### Reopening Conditions and Contribution Rules

Reopen hardening after quarantine or journal residue, user-data loss, plans
for multi-instance/network-filesystem/strong external-editor support, native
dirfd/openat support, Final Closure or cross-platform certification work, an
Owner request to close H-C10, or reuse of the atomic layer by another module.

During the freeze, only deterministic normal-path bugs, user-data-loss fixes,
security vulnerabilities, compile failures, test stability fixes, platform
compatibility fixes, or necessary documentation corrections may bypass it.
Every bypassing production-code PR must state:

```text
Why this change must bypass History Feature Freeze:
User-visible impact:
```

### Freeze Baseline and Current Status

```text
History Freeze Production Baseline: e5e20c5ed3950e625003a443184fe8131cd20369
History Freeze Client-Test Baseline: ba90ce51dca07606e0feaa300ef7826f1b52cf22
History Freeze Documentation Baseline: 4fb35776e47befc01ae9029a714a041ae7eb8078
Freeze content commit: 1fd777074761bc8fc63c47f76645c198594367b5
Freeze verification bookkeeping commit: this commit, SHA reported at handoff

History Feature State: TEMPORARILY FROZEN
Normal Personal Use: SUPPORTED
Final Closure: DRAFT — CLOSURE IN PROGRESS
Owner Approval: PENDING
Maintenance Mode: NOT ENTERED
```

The freeze-only changes do not modify History production code, UI,
interaction, or the atomic file protocol. Verification is recorded by the
follow-up bookkeeping commit.

### Verification Evidence

```text
npm test -- --run: 163 test files passed; 2551 passed; 2 skipped; 0 failed
npm run typecheck: PASS
npm run build: PASS; existing dependency pure-annotation and chunk-size warnings only
git diff --check: PASS
Markdown fences: PASS; all four freeze-related documents have balanced fences
Relative Markdown links: PASS; all checked local targets exist
Production code changed in this freeze: NO
```

Validation was performed on macOS only. Linux and Windows were not run.
GitHub Actions/CI was not run because this freeze was not pushed. Owner
Approval remains pending. The tag status and final bookkeeping SHA are
reported at handoff.
