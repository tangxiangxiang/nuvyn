# Vault Git History — Implementation Record

## 1. Record Status

```text
Record type: Retrospective implementation record
Observed on production-code review baseline:
  00b17359d151bbdbe56115ed992700ecbb5e1ca1
Source: tangxiangxiang/nuvyn
Branch reviewed: main
Consolidated: 2026-07-31
Closure: DRAFT — CLOSURE IN PROGRESS
```

> **History Feature State: TEMPORARILY FROZEN**
>
> Normal Personal Use: SUPPORTED<br>
> Final Closure: NOT COMPLETE<br>
> Owner Approval: PENDING<br>
> Maintenance Mode: NOT ENTERED

This document records only behavior observed in production and test
source at the baseline above. `git diff` confirms that later
documentation commits through the consolidation starting point did
not change the reviewed History production or test files.

Future behavior lives in the
[Plan](../plans/2026-07-30-vault-git-history-implementation-plan.md)
and is explicitly **not implemented on the reviewed production
baseline**. Closure evidence lives in
[Draft Closure](../closures/vault-git-history-final-closure.md).

No test, typecheck, build, CI, or platform result is inferred from
source presence.

## 2. Architecture Overview

**Observed on production-code review baseline**

```text
Vue History UI/composables
        │
        ▼
src/lib/history-api.ts
        │  /api/history/*
        ▼
server/history/routes.ts
        ├── validation.ts
        ├── repo.ts
        ├── diff.ts
        └── git.ts
              ├── spawn('git', args)
              ├── process-local withRepoMutation
              ├── Temporary Commit Index
              ├── Real-Index sync / Repair
              └── Restore / Withdraw
```

The server uses Git CLI argument arrays without a shell. Create builds
commits through a Temporary Index. Repair and Withdraw synchronization
have hand-taken Index-lock helpers. Client path mutation barriers are
separate from the server mutex. The mutex is a Promise chain keyed by
`path.resolve(repoRoot)` inside one Node process; there is no
cross-process lock spanning a complete Vault mutation.

Consequently, two Nuvyn processes can interleave complete mutation
lifecycles. For example, process A can move HEAD, process B can observe
that HEAD and move it again, and then process A can publish an older
post-CAS Real Index. No reviewed lock serializes that sequence
(`H-C12`).

## 3. Module Responsibilities

| File | Observed responsibility |
|---|---|
| `server/history/git.ts` | Git spawn wrapper, status/log parsers, commit plumbing, process-local mutation queue, repository-operation checks, Repair store, Index synchronization, Withdraw, Restore. |
| `server/history/routes.ts` | 12 History endpoints, request validation, HTTP error mapping, capability cache, Working Tree hashes and Restore post-route stat. |
| `server/history/repo.ts` | first-touch dotfiles, nested-repository warning, `git init`, `core.autocrlf=false`. |
| `server/history/validation.ts` | logical History path/ref/SHA syntax only. |
| `src/lib/history-api.ts` | client-side wire interfaces and fetch wrappers; the server does not import this file despite the stale top comment. |
| `useHistoryCommit.ts` | composer, save/mutation barriers, Create request, post-commit refreshes, Repair client state. |
| `useHistoryWithdraw.ts` | confirmation, Vault-wide mutation barrier, Withdraw request, result reconciliation. |
| `useHistoryRestore.ts` | confirmation snapshot, save barrier, Restore request, editor/file-change reconciliation. |
| `useHistoryTimeline.ts` | document/revision projection and date buckets. |

## 4. HTTP API Inventory

**Observed on production-code review baseline**

| Method | Path | Success shape | Important observed behavior |
|---|---|---|---|
| GET | `/capability` | `{ gitAvailable, repoInitialized, initError? }` | may initialize the repository |
| GET | `/status` | `{ dirty, available }` | server uses graceful 503 for missing Git |
| POST | `/content-hashes` | `{ hashes }` | direct `fs.readFile`, follows symlinks |
| GET | `/log` | `{ commits }` | custom textual record separator |
| GET | `/file` | `{ path, ref, content }` | WORKTREE is a direct filesystem read |
| GET | `/diff` | `{ path, oldRef, newRef, diff }` | WORKTREE side is a direct filesystem read |
| POST | `/commits` | `{ sha, filesCommitted, indexRefreshFailed?, indexRepair?, repairStatePersistenceFailed? }` | exact-byte Create and auxiliary Index sync |
| GET | `/repair-status` | `{ transactions }` | read can trigger migration or quarantine write |
| POST | `/repair-index` | `{ repaired, repairStatePersistenceFailed? }` | hand-taken Index lock |
| POST | `/repair-index/discard` | `{ discarded }` | Repair metadata only |
| POST | `/drop` | `{ sha, droppedSha, filesChanged, indexRefreshFailed, indexRepair?, repairStatePersistenceFailed }` | any current HEAD is eligible; no marker |
| POST | `/restore` | `{ path, ref, raw, mtime }` | pre-read outside server transaction; later stat |

`ensureRepo` is called by each route. Its missing-file helper uses
`fs.access` followed by `fs.writeFile`, which has a non-overwrite
TOCTOU. The full `hasOwnGitDir → dotfiles → git init → git config`
flow is not serialized across processes, and exclusive `wx` dotfile
creation is not implemented (`H-C13`).

Filesystem routes validate logical syntax but expose no shared
existing-file/missing-leaf resolver, no verified parent identity for
an absent leaf, and no pathname/handle identity contract after a file
is opened (`H-C10`).

## 5. Git Command and Parser Facts

**Observed on production-code review baseline**

- `run()` uses `spawn('git', args, { cwd, windowsHide: true })`.
- Status uses `git status --porcelain --untracked-files=all`.
- Log uses a custom
  `\x1e__NUVYN_LOG__\x1e` record separator and NUL header fields.
- `parseLog` splits on that textual separator. A commit message may
  contain it because message validation checks only non-empty text.
- The `log()` JSDoc says `--follow`; the implementation deliberately
  does not pass `--follow`.
- Create uses `read-tree`, `hash-object`, `update-index`, `write-tree`,
  `commit-tree`, `update-ref`, `show`, and Real-Index `reset`.
- Restore uses `git restore --source=<ref> --worktree`.
- Withdraw uses `show`, `rev-parse <sha>^`, CAS `update-ref`, and
  Temporary-Index synchronization.
- `git.ts` top commentary says the wrapper needs five commands; the
  current module invokes substantially more.

## 6. Create Version Sequence

**Observed on production-code review baseline**

Client:

```text
acquire path mutation barrier
→ saveSelected
→ POST /content-hashes
→ POST /commits
→ release save barrier
→ Promise.all(refreshStatus, refreshLog)
→ refreshComparisons
→ clear selection/message and update completion
→ refreshIndexRepairStatus
```

Server:

```text
validate request
→ ensureRepo
→ withRepoMutation
→ assertRepositoryIdle
→ ensureIndexRepairStorageReady
→ re-read Status
→ reject stale selection
→ captureExpectedFiles
→ ensure author identity
→ resolve old HEAD
→ build Temporary Commit Index from old HEAD
→ stage captured bytes and verify
→ write tree
→ reject unchanged tree
→ create commit object
→ assertRepositoryIdle
→ CAS update-ref HEAD
→ show immutable commit files
→ routine Real-Index sync
→ settle or record Repair metadata
→ return success/degradation shape
```

Factual boundaries:

- Status is re-read before `captureExpectedFiles`.
- `ensureIndexRepairStorageReady` failure aborts before commit-object
  creation and before HEAD update.
- immutable `show` runs after the HEAD CAS and before Real-Index sync.
- Create routine sync calls
  `git reset -q <targetHead> -- <paths>` up to three times.
- F0 and F1 do not exist in the current Create flow.
- when routine sync fails, `recordIndexRepair` captures the Real Index
  after that failure.
- the Repair-record creation helper does not acquire the Git Index
  lock.
- the client does not use `Promise.allSettled` for
  `refreshComparisons`; it awaits `Promise.all(refreshStatus,
  refreshLog)` and then awaits `refreshComparisons`.
- after `POST /commits` succeeds, the client awaits save-barrier
  release before composer cleanup. A barrier-release rejection can
  therefore enter the same overall catch as the primary mutation; the
  retained callback is then awaited again in `finally`.
- any of those refresh rejections enters `submit()`'s overall catch,
  can show `commit_failed`, and can prevent composer cleanup
  (`H-C2`).

## 7. Real-Index Synchronization and Repair

### 7.1 Routine Create sync

**Observed on production-code review baseline**

`syncIndexPaths`:

1. checks repository-operation state;
2. verifies HEAD;
3. runs `git reset -q <fixedHead> -- <paths>` against the Real Index;
4. verifies HEAD and `diff --cached --quiet`;
5. retries up to three times.

This can overwrite target-path staged intent that existed before the
Create operation or arrived between attempts (`H-C3`).

The current wire result has no complete path partition and no
`replacementApplied`, `finalHead`, or `reconciliationRequired`
terminal-state fields. There is no distinct persisted transaction for
a Real-Index replacement that publishes and is then found to target an
older HEAD.

Withdraw uses a Temporary Index under a hand-taken lock, so it avoids
the concurrent unlocked retry window, but it still resets every
affected target path after HEAD moves. A target path staged before
Withdraw can therefore be replaced because no old-HEAD/F0
classification exists.

### 7.2 Repair metadata

**Observed on production-code review baseline**

Path: `<git-dir>/nuvyn/index-repair.json`.

Schema version 2 stores transaction token, status, HEAD, paths, and
per-path Index fingerprints. Version 1 is migrated. Invalid data is
renamed to a corrupt quarantine file.

Publication properties are separate:

| Property | Observed state |
|---|---|
| atomic rename publication for non-empty state | observed |
| process-restart persistence | observed |
| full crash/power-loss durability | not established |
| cross-process lost-update protection | not implemented |

`writeIndexRepairFile` uses a temp file and rename but does not fsync
the file or parent directory. Empty state removes the final file.
`recordIndexRepair`, settle, discard, migration, and quarantine do not
share a cross-process metadata lock. `GET /repair-status` can trigger
migration or quarantine writes.

### 7.3 Current hand-taken Index-lock lifecycles

**Observed on production-code review baseline**

Both `repairIndexWithLock` and `syncDroppedIndexPaths` publish in this
order:

```text
write replacement bytes to .git/index.lock
→ fsync lock handle
→ close lock handle
→ rename .git/index.lock to .git/index
```

If rename has not committed, `finally` closes any open handle, removes
`.git/index.lock`, and removes the Temporary Index directory. The
reviewed source therefore does not have an open-handle rename defect
in either helper.

Repair fingerprints are checked before and after Temporary-Index
work. A mismatch can supersede a Repair. Only `EEXIST` is normalized
as Index-lock contention.

## 8. Withdraw Sequence

**Observed on production-code review baseline**

```text
client confirmation
→ acquire Vault-wide mutation barrier
→ POST /drop with 7–40 hex request
→ withRepoMutation
→ assertRepositoryIdle
→ Repair storage preflight
→ readCurrentHead
→ compare full HEAD string directly with request
→ show changed files; keep every .md suffix
→ rev-parse <sha>^
→ non-zero parent result becomes parent = null
→ assertRepositoryIdle
→ CAS update-ref HEAD or update-ref -d HEAD
→ syncDroppedIndexPaths
→ settle or record Repair
→ client register/settle Repair
→ closeDroppedRevision
→ Promise.allSettled(Status, Log, Comparison)
→ refreshIndexRepairStatus
→ local completion and toast
```

Current gaps:

- a short request cannot equal full HEAD (`H-C6`);
- no canonical same-vault marker is generated or checked (`H-C4`);
- changed paths do not pass full Managed History Path validation;
- every non-zero `rev-parse <sha>^` result is treated as root;
- `readCurrentHead` maps every non-zero result to `null`;
- merge, malformed output, and operational failures are not
  distinguished (`H-C11`);
- HEAD, commit, and parent resolution have no single shared owner;
- the server error body has no stable `HistoryErrorCode`, and
  `HistoryApiError` does not preserve a code/details contract;
- all non-operation 409 errors become latest-changed in the client
  through human-readable error-text matching;
- the three principal refreshes are settled, but remaining success
  callbacks have no dedicated regression isolation (`H-C2`).

Working Tree bytes are not changed by Withdraw.

## 9. Restore Sequence

**Observed on production-code review baseline**

```text
validate logical path/ref
→ ensureRepo
→ rawAt(requestedRef, path) outside withRepoMutation
→ restoreFile
   → withRepoMutation
   → git restore --source=<requestedRef> --worktree
→ fs.stat(path)
→ return pre-read raw + post-command mtime
```

The route does not resolve the accepted ref once to a full immutable
SHA. `raw` and `mtime` are not established as one post-restore file
snapshot. Filesystem operations can follow a symlink (`H-C10`).

The client writes `request.historicalRaw`, rather than `result.raw`,
to `tab.raw`, `tab.originalRaw`, and the file-change event. It does
preserve a newer editor revision and uses `Promise.allSettled` for
the two later refreshes.

## 10. Client State Lifecycles

**Observed on production-code review baseline**

- `useHistory` is scoped per `VaultContext` on the client.
- `pathMutationLock` has path and Vault-wide acquisition.
- Create uses a path lock and save barrier.
- Restore captures gesture-time confirmation input and uses a path
  lock and save barrier.
- Withdraw uses a Vault-wide lock.
- Repair transactions are mirrored in `useHistoryCommit`.
- server serialization is process-local and keyed by
  `path.resolve(repoRoot)`.
- no cross-process Vault mutation lock, fixed nested lock hierarchy, or
  stale-owner recovery protocol exists.
- `getStatus` recovers every non-2xx JSON body when called with
  `allowNonOkJson: true`, not only the intended graceful 503
  (`H-C1`).

## 11. Timeline and UI Behavior

**Observed on production-code review baseline**

- global Log projects commits to documents and revisions;
- per-document Log refresh is request-id guarded;
- grouping uses local midnight plus fixed `86_400_000` ms division,
  so DST boundaries are wrong (`H-C7`);
- no Log/Timeline pagination exists (`H-K10`);
- rename history is not `--follow`-merged (`H-K8`);
- snapshot/comparison panes are read-only;
- History context-menu and keyboard affordances exist.

## 12. Test Evidence Map

This is source inventory, not a claim that tests were run during this
documentation consolidation.

### 12.1 Existing test-source evidence

| Area | Existing source evidence |
|---|---|
| Create exact bytes / CAS / selection | `server/__tests__/history-git.test.ts`, `history-routes.test.ts` |
| Repair persistence / migration / quarantine | `history-git.test.ts`, `history-routes.test.ts` |
| Index lock during Repair | `holds index.lock across validation and atomic replacement` |
| Withdraw Worktree/unrelated Index preservation | `withdraws only the latest version...`, root-withdraw cases |
| Restore Working-Tree-only behavior | `restoreFile` Git tests and route tests |
| newer editor edit preservation | `useHistoryRestore.test.ts` |
| principal Withdraw refresh settling | `useHistoryWithdraw.test.ts` |
| repository-operation source list | seven markers in `git.ts`; direct Create parametrization covers `MERGE_HEAD` and `CHERRY_PICK_HEAD` only |
| client Vault scoping | `src/__tests__/useHistory.test.ts` |
| mutation barriers | `pathMutationLock.test.ts` and composable tests |
| parser multiline cases | current synthetic `parseLog` tests, which do not inject the separator |
| timeline grouping | one ordinary grouping test; no deterministic DST child process |

### 12.2 Coverage gaps — not implemented on the reviewed baseline

```text
Index: F0 before HEAD; pre-staged preservation; F0/F1 mismatch;
mixed path outcomes; failedPaths-only Repair; F0-bound Repair;
all no-write/cleanup/close-before-rename branches; external git add
after each failure; no rename after mismatch; full terminal partition
and order; no pre-rename partial synchronized result; post-rename HEAD
recheck and persisted reconciliation.

Filesystem: symlink leaf; symlink directory segment; no outside-Vault
hash, commit, WORKTREE read/diff, or Restore destination; selected
deletion and untracked/missing-leaf handling; parent identity;
post-open pathname replacement.

Resolution: unborn vs operational failure; full-SHA resolution;
strict root/one-parent/merge parsing; no HEAD move on failures; shared
resolver ownership; stable structured server codes; client code-based
mapping and legacy generic fallback.

Marker/Vault metadata: atomic first touch; stable concurrent ID;
no partial ID; locked malformed-ID quarantine; exact marker;
fake body trailers; unmarked/cross-vault/ambiguous/merge/invalid-path
Withdraw; marker-specific client UX.

Repair metadata: concurrent record/settle; migration/quarantine
lost-update protection; lock cleanup; read-only status behavior.

Vault serialization: two-process Create/Withdraw and Create/Restore;
older post-CAS sync exclusion; fixed nested lock order; live-owner
retention; positively dead-owner recovery; indeterminate-owner
fail-closed behavior; different-Vault parallelism.

Restore: one immutable SHA; same SHA for read/write; post-read
result.raw; client result.raw authority; no double mutex; symlink;
refresh-success boundary.

Create/Withdraw success: each refresh rejection; save-barrier release
rejection; immediate composer/result/Repair settlement; exactly-once
barrier release; mutation-lock cleanup; one auxiliary warning; no
duplicate retry; repair-status and local cleanup isolation.

Timeline/Log/bootstrap: DST spring/fall in explicit child TZ;
delimiter injection; multiline/control framing; bootstrap concurrent
non-overwrite and idempotence; one serialized first-touch transaction;
single `git init`; partial-init retry; in-lock repository recheck;
different-Vault initialization parallelism.

Existing gaps: all seven operation markers; direct backslash,
absolute, and hidden-path cases; same-Vault serialization and
different-Vault parallelism.
```

## 13. Reviewed Source Comments That Do Not Match Source

**Observed on production-code review baseline**

- `git.ts` says the wrapper uses five Git commands; the module now
  uses many more.
- `log()` JSDoc says `--follow`; implementation omits it.
- `repo.ts` says `.gitattributes` contains
  `* text=auto eol=lf`; the constant is intentionally empty.
- `history-api.ts` says the server imports its wire types; the server
  defines its own types.

These comments are documentary defects only in this task; production
source is intentionally unchanged.

## 14. Deviations From Intended Contract

Every Closure finding below is observed and open. Planned fixes are in
Plan Part B.

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

## 15. Observed Protections

The following are present in source but do not close the findings
above:

1. Create commits captured bytes through a Temporary Commit Index.
2. Create and Withdraw move HEAD by CAS.
3. Create and Withdraw check repository operation state at entry and
   before HEAD movement.
4. Repair and Withdraw Index publication fsync, close, then rename.
5. Repair verifies Index fingerprints.
6. Withdraw does not edit Working Tree bytes.
7. Restore uses `--worktree` and not `--staged`.
8. client mutation barriers prevent overlapping in-app workflows.
9. Repair state survives a normal process restart.

These are source-reviewed facts. Full final verification remains
unrun, Owner Approval is pending, and no Final Production Baseline is
recorded.

## 16. 2026-08-01 Focused Production Correction

This is an implementation overlay, not a rewrite of the reviewed
baseline above. RED commit
`36fed44dbf0276ee876f1d2a1f8d6c51c6bc7be9` proved that the History
repository queue, folder structure/document locks, and startup recovery
sequencing were independent lock domains. It also proved that two Nuvyn
processes could serve one canonical Vault.

Production commit `1a065bb0c2517f8a1fe1886b806e6945c2830538`
selects these corrections:

- one process-lifetime writer record at `.nuvyn/vault-writer.json`,
  acquired before recovery, migration, and route mounting;
- one canonical-root process-local `withVaultMutation` boundary shared
  by History, folder lifecycle, and recovery;
- lock order: lifetime owner, Vault mutation, structure lock, sorted
  document locks, History repository queue, Git `index.lock`, then the
  atomic filesystem commit point;
- complete Create Version, Withdraw, Repair Retry/Discard/status-write,
  and repository-bootstrap transactions inside that boundary; and
- Restore implemented as immutable-ref blob read plus locked
  CAS/create-only document commit, metadata settlement, and
  authoritative post-read. Production no longer uses
  `git restore --worktree`.

The writer record uses exclusive creation and includes version, nonce,
host, PID, and start time. Malformed, cross-host, live, and indeterminate
owners fail closed. A same-host positively dead record is eligible for
takeover only under an exclusive recovery claim after nonce and PID
liveness are rechecked. Release requires the caller's nonce.

This focused change remediates H-C5 and the active-writer/whole-Vault
portion of H-C12 in code. H-C10 remains open for the broader all-History
filesystem-containment contract, and no other canonical finding is
declared closed here. Folder-move v4 executor, metadata state machine,
journal schema/phases, external-incumbent precedence, and durable
SQLite ownership footprint are unchanged.

Evidence on the production SHA: focused suites 145/145; complete suite
2,476 passed and 2 skipped across 156 files; typecheck, build, and diff
check passed. Cross-platform CI was not run, so Final Production
Baseline and Owner Approval remain pending.

## 17. 2026-08-02 Current Production-Code Baseline

Current production-code commit: `5df3ad9b50aebfc0d368a1d2865ec85de06afc98`.
Earlier sections are historical records; this section is the authoritative
implementation summary for the current review.

Implemented in this commit:

1. `/api/ai/commit-message` now validates every client path with the
   History Markdown whitelist, rejects duplicates and unchanged files,
   rejects symlinks, and enforces a 20-path limit without filter-then-truncate
   behavior.
2. AI context is server-generated from actual HEAD/WORKTREE changes. Added,
   modified, and deleted files are distinguished; bounded reads and bounded
   line/byte/prompt budgets prevent a full large-file diff from reaching the
   provider. Git subprocesses and provider requests observe the request abort
   signal.
3. Create Version stops if HEAD changes after staged-intent classification
   and before temporary-index initialization. The real Index is not touched
   on that conflict and the route returns 409.
4. Repair metadata receives the original operation-start Index fingerprint,
   verifies it while holding `.git/index.lock`, and writes the transaction
   before releasing that lock. It never re-captures unknown staged intent.
5. `.nuvyn/vault-id` is a persistent, exclusive-created, fsynced UUID record.
   Marker parsing is strict and Withdraw rejects foreign, malformed, duplicate,
   root, and merge commits.
6. Restore resolves and rechecks every path segment inside the mutation and
   document locks, including post-write and rollback checks. The shared safe
   reader is used by History worktree reads, hashes, capture, and AI diffs.
7. `HistoryApiError` preserves stable `code` and `details`; UI handling uses
   stable codes where available. Existing History layout and interactions are
   unchanged.

Regression evidence:

```text
npm test -- --run: 163 test files passed; 2522 passed, 2 skipped
npm run typecheck: PASS
npm run build: PASS (existing dependency pure-annotation/chunk-size warnings only)
git diff --check: PASS
```

Not closed by this commit: the residual non-portable directory-handle TOCTOU
window in H-C10, explicit DST subprocess coverage, Linux/Windows execution,
H-C13 bootstrap serialization, rename-follow history, pagination, SHA-256
sentinel support, and Owner Approval. Closure therefore remains
`DRAFT — CLOSURE IN PROGRESS`.

## 30. 2026-08-02 Filesystem Pathname Race Follow-up

Production-code commit: `dab1e12119c9f7f84316fe419a6d41b2e2fb3b63`.

The atomic text path now captures durable create-only artifacts from the
exclusive open handle, records file and parent `dev/ino`, and verifies that
proof before cleanup. The temporary writer invokes a deterministic seam after
parent identity capture and before open; after open it validates the parent
generation before writing raw document bytes. This is a fail-closed leak
reduction, not an `openat` implementation: on unsupported platforms a stale
empty artifact may remain quarantined, but the secret document bytes are not
written in that pre-write replacement case.

`atomicReplaceText` verifies the prepared temporary artifact before its final
rename. `atomicRemoveTextIfUnchanged` captures the target generation, checks
the staged generation after takeover, and performs another ownership/content
check before unlink. If the staged pathname is replaced, the operation throws
`HISTORY_PATH_MOVED` and leaves both the original quarantine and the external
occupant untouched. The atomic commit's temporary, staged, and journal cleanup
paths use the same proof-based cleanup where the operation owns the artifact.

New deterministic hooks cover parent-before-open, replace-before-rename,
remove-before-takeover, and staged-path replacement. The composable test now
covers the repair-metadata persistence error branch directly, and the History
API test confirms structured `code` and `details` survive the fetch wrapper.

This does not close H-C10. Node's portable API surface here still lacks a
directory-handle-relative `openat`/`renameat`/`unlinkat` protocol, so a final
pathname check/use window remains. Linux/Windows execution, DST subprocess
evidence, H-C13 bootstrap serialization, and Owner Approval remain open.
Closure stays `DRAFT — CLOSURE IN PROGRESS`.

## 18. 2026-08-02 Restore/Index/Error-Code Follow-up

Production commit: `b60630d2cd8fd840827aed15967a92b918e91a32`.

Implementation details:

1. `prepareAtomicTextCreate` and `prepareAtomicTextWrite` capture the
   temporary file and parent directory identities. `commit` and `rollback`
   verify those identities immediately before linking or unlinking. An
   identity mismatch produces a `HISTORY_PATH_MOVED` ownership error and
   leaves the pathname quarantined rather than cleaning by string path.
2. Restore's missing-target flow invokes `beforeRestoreCommit`, resolves and
   verifies the parent again, confirms the target is still absent, then
   creates the temporary file. `afterRestorePrepare` is test-only coverage for
   the post-create replacement window. Restore rollback continues to resolve
   and verify the target under the existing mutation/structure/document locks.
3. `IndexSyncResult` records `synchronized`, `replacementApplied`, `finalHead`,
   and the expected fingerprints actually installed in the real Index.
   Create and Withdraw use those fingerprints and the final observed HEAD for
   Repair metadata when a HEAD move wins after Index replacement.
4. AI History diffs use array accumulation and newline joining. Route tests
   assert exact modified, added, and deleted diff strings.
5. Repair false results and Withdraw marker failures now preserve stable error
   codes through the route and `HistoryApiError`; the Withdraw composable uses
   codes first and only retains regexes as compatibility fallback.

Regression evidence on macOS:

```text
npm test -- --run: 163 test files passed; 2534 passed, 2 skipped
npm run typecheck: PASS
npm run build: PASS (existing dependency annotation/chunk-size warnings only)
git diff --check: PASS
```

The initial sandbox attempt was blocked by `tsx` child-process IPC `EPERM`; a
controlled-permission rerun passed. Linux/Windows validation, explicit DST
subprocess evidence, H-C13 bootstrap follow-up, and Owner Approval remain
open. Closure remains `DRAFT — CLOSURE IN PROGRESS`.

## 19. 2026-08-02 Temporary Ownership and Repair Persistence Follow-up

Production-code commit: `bece8228227c5018339336c6ce00448b57192a6e`.

The atomic text writer now returns an immutable creation proof containing
the temporary file's `dev/ino` captured from its open `FileHandle`, plus the
parent directory identity captured before creation. Closing the handle is
followed by a deterministic test seam and parent/path identity verification;
identity failure quarantines the artifact and never removes the replacement
pathname. Both create-only and replacement preparation consume this proof,
so they cannot re-claim a file by a later pathname `lstat`.

`repairIndex` now distinguishes a normal unverifiable repair from the case
where the real Index was already replaced but the transaction update could
not be persisted. That case returns `replacementApplied`, `finalHead`, and
`repairStatePersistenceFailed`; `/api/history/repair-index` emits HTTP 409
with `HISTORY_INDEX_REPAIR_STATE_PERSISTENCE_FAILED`, and the composable
shows a manual Git-status warning. Legacy 12-hex markers remain blocked, but
are described as unverified (`reason: unverified-legacy-marker`) rather than
as authenticated historical Nuvyn versions.

Focused evidence: `atomicTextWrite`, `history-git`, `history-routes`, and
`useHistoryWithdraw` passed 175 tests on macOS; client/server typecheck
passed. Final evidence on macOS is 163 test files with 2537 passed and 2
skipped, typecheck PASS, build PASS with existing dependency/chunk-size
warnings, and `git diff --check` PASS. H-C10's portable
directory-handle/openat gap, Linux/Windows validation, DST subprocess tests,
H-C13 bootstrap serialization, and Owner Approval remain open.

## 31. 2026-08-02 Post-Commit Artifact and Conditional-Remove Follow-up

Production commit: `e5e20c5ed3950e625003a443184fe8131cd20369`.
Client regression-test commit: `ba90ce51dca07606e0feaa300ef7826f1b52cf22`.

The replacement protocol now performs a stable final read of the staged
generation after linking the new target and before staged cleanup. A changed
same-inode old FileHandle therefore cannot be silently unlinked. The target
replacement remains authoritative, the changed old generation remains under
the staged quarantine name, and the durable journal records
`post-commit-external-mutation`; startup recovery treats that phase as
manual/quarantined and does not delete either generation.

`atomicRemoveTextIfUnchanged` now restores the staged generation before
returning a post-commit conflict. It uses create-only linking, so an external
target is preserved. If the staged pathname no longer proves the original
generation, no restore or cleanup is attempted and `HISTORY_PATH_MOVED` is
returned. The result type records removed/restored/quarantined state for
callers that need it.

Durable journals and recovery payloads now carry optional content hashes in
their creation proof. String-based startup cleanup first captures the current
artifact and then performs identity/content verification again before unlink.
Journal rewrites capture the incumbent before creating the rewrite temporary,
verify both generations before rename, and verify the installed inode after
rename. The final portable check/use window remains an H-C10 limitation.

New deterministic coverage includes same-inode replacement and remove races,
target reoccupation during remove recovery, staged-path replacement,
journal-parent replacement, journal occupant replacement, crash-recovery
retention of post-commit mutation, and direct `repairIndex()` 409 wire shape.

macOS requested focused evidence for this commit: 4 test files, 95 passed,
0 failed. The additional crash-recovery focused run also passed under
controlled IPC permissions.
Full required macOS verification for this commit is 163 test files with 2551
passed and 2 skipped; typecheck PASS; build PASS with existing dependency
pure-annotation/chunk-size warnings; and `git diff --check` PASS. Linux,
Windows, DST subprocess evidence, H-C13 bootstrap serialization, and Owner
Approval remain open. Closure remains `DRAFT — CLOSURE IN PROGRESS`.

## 2026-08-02 History Feature Freeze

History is temporarily frozen for maintenance prioritization. Normal
single-user personal use is supported, while remaining work is concentrated
in extreme filesystem concurrency races. Fully addressing those races would
require a directory-handle protocol, native filesystem interfaces, delayed
quarantine, or a broader file-transaction layer. Continuing to add patches
now has a lower expected benefit than the risk of regressions in ordinary
paths.

This freeze is not final security acceptance, does not close all Closure
findings, and does not enter formal Closure maintenance mode.

### Supported Usage

- one user and one active Nuvyn instance;
- a local-disk Vault;
- ordinary editing, saving, restoring, version creation, and withdrawal;
- occasional non-adversarial external-editor edits;
- a personally managed Vault with regular backups.

### Unsupported / High-Risk Usage

Do not treat the current implementation as suitable for multiple Nuvyn
instances on one Vault, several editors repeatedly writing the same file,
unstable or network filesystems, multiple sync tools writing the same Vault,
hostile inode/pathname race generation, or security-boundary,
multi-user, or multi-tenant isolation.

### User Guidance

Back up the Vault regularly. Avoid several programs saving the same document
at high frequency. If an anomaly occurs, do not manually delete `.nuvyn-*`
hidden artifacts. Preserve quarantine files and journals for analysis or
recovery, and let external synchronization finish before reopening Nuvyn.

### Deferred Findings and Risk Acceptance

The detailed backlog is recorded in
[vault-git-history-freeze-backlog.md](../freezes/vault-git-history-freeze-backlog.md).
H-FREEZE-1 through H-FREEZE-5 remain `DEFERRED`; this freeze does not
declare them closed.

The project temporarily accepts these risks only for local personal use, one
active Nuvyn instance, ordinary filesystem behavior, and a non-adversarial
environment. It does not accept them for hostile local processes,
multi-writer coordination, network filesystems, security-boundary guarantees,
or multi-user/multi-tenant use. This is a reversible maintenance decision,
not a security proof.

### Reopening and Contribution Rules

Reopen History hardening after quarantine or journal residue, any user-data
loss report, a plan for multi-instance or network-filesystem support, strong
external-editor concurrency support, native dirfd/openat support, Final
Closure or cross-platform certification work, an Owner request to close
H-C10, or reuse of the History atomic layer by another module.

During the freeze, do not accept new History enhancements, pure refactors, or
complexity-only atomic protocol changes. Only deterministic normal-path bugs,
user-data-loss fixes, security vulnerabilities, compile failures, test
stability fixes, platform compatibility fixes, or necessary documentation
corrections may bypass it. Each bypassing production-code PR must state:

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
