# Vault Git History — Final Closure

```text
Status: DRAFT — CLOSURE IN PROGRESS
Owner Approval: PENDING / BLOCKED
Final Production Baseline: NOT YET CAPTURED
Maintenance Mode: NOT ENTERED
```

> **History Feature State: TEMPORARILY FROZEN**
>
> Normal Personal Use: SUPPORTED<br>
> Final Closure: NOT COMPLETE<br>
> Owner Approval: PENDING<br>
> Maintenance Mode: NOT ENTERED

This document is a live Closure record, not a closure declaration.
Focused production remediation has started, but the complete Closure
program has not finished. Future contracts in the
[Spec](../specs/2026-07-30-vault-git-history-design.md) and
[Plan](../plans/2026-07-30-vault-git-history-implementation-plan.md)
remain unimplemented except where the 2026-08-01 correction overlay in
§11 says otherwise.

## 1. Current Baseline and Audit Chain

### Production-code review baseline

```text
00b17359d151bbdbe56115ed992700ecbb5e1ca1
```

This is the source-review baseline only. It is not the Final
Production Baseline.

No History production or test file changed between that SHA and the
starting point of this consolidation.

### Documentation audit chain observed in Git history

| SHA | Purpose |
|---|---|
| `ff2f992eb809af091bb9260846aef02ebee8519a` | reconstruct Vault Git History documentation chain |
| `adfc4d733efdf990d413022d5aa36433da4db356` | correct reconstruction review findings |
| `7b1bb2c7912869a1e8faf8c3ac40346696d99682` | correct second-round review findings |
| `de85039d01c44e1b6cc80d8baa3cc5dd2ad69d2e` | correct third-round review findings |
| `2d5ce3f8a388e957d83195a73acdc3b73dd03aaa` | record final Round 3 SHA |
| `8d6f71aba406b4e96123ddecd70b9c1d1001e17b` | update Index synchronization and Repair documentation |
| `234bbdee10734b86d5f35ef7557f073dfc376327` | finalize reconstruction review contract |
| `856f310951d95c0c97fe7883b5323e88e6b60077` | record Round 5 correction SHA |
| `d054b3c1c183694eaaa4aa80b21a40a3cd6996d7` | align final reconstruction contracts |
| `b33fbfe351bce23d69e76e564e73f4a7dc605800` | record Round 6 correction SHA |
| `15104e23c3df2a8caa18ab10ebe1f05714cc1b64` | consolidate final documentation review findings |

The Final Documentation Consolidation correction SHA above is added
by a later bookkeeping commit. A commit never records its own
not-yet-known SHA; the bookkeeping commit is therefore reported at
handoff rather than written into itself.

## 2. Current Status

| Area | State |
|---|---|
| Documentation Contract Completion | COMPLETE after the substantive and bookkeeping commits |
| Production remediation | IN PROGRESS — focused H-C5/H-C12 correction implemented |
| Final production verification | LOCAL ONLY — cross-platform CI not run |
| Owner Approval | PENDING |
| Closure | DRAFT |
| Maintenance Mode | NOT ENTERED |

The reviewed implementation remains usable but is not closable because
the findings in §4 remain open.

## 3. Delivered Scope

Everything in this section is **Observed on production-code review
baseline**.

### 3.1 Repository and read surfaces

- Git capability and first-touch Vault repository setup;
- Status, Log, Snapshot, WORKTREE, and Diff endpoints;
- logical path and ref allowlists;
- empty-repository handling;
- client History state and read-only panes.

### 3.2 Create Version

- client save and path-mutation barriers;
- exact Working Tree hash capture;
- server status re-read before byte capture;
- Temporary Commit Index seeded from old HEAD;
- plumbing tree/commit creation;
- second repository-idle check;
- CAS HEAD movement;
- immutable commit-file query before Real-Index sync;
- auxiliary sync and Repair response.

Create routine sync still uses up to three Real-Index resets and does
not implement F0/F1 path outcomes.

### 3.3 Index Repair and Withdraw

- schema-v2 Repair metadata with v1 migration and corrupt quarantine;
- normal-restart persistence;
- hand-taken `.git/index.lock` Repair;
- Repair and Withdraw synchronization publish via
  `fsync → close → rename`;
- pre-rename failure cleanup removes lock and Temporary Index;
- Withdraw preserves Working Tree bytes and uses CAS.

Repair metadata has no cross-process lost-update protection. Withdraw
has no marker check and does not fail closed on parent-resolution
errors.

### 3.4 Restore and client reconciliation

- `git restore --worktree` without `--staged`;
- one server mutation transaction inside `restoreFile`;
- client confirmation snapshot, save barrier, newer-edit
  preservation, and settled refreshes.

The route pre-reads outside the transaction and the client trusts
gesture-time `historicalRaw`, so the intended atomic snapshot contract
is not delivered.

### 3.5 Test source

History Git, route, API, composable, component, and e2e test files
exist. Their presence is not a claim that they passed for this
Closure. The Implementation Record §12 distinguishes current source
coverage from missing scenarios.

## 4. Open Closure Findings

This table is canonical across all five documents.

| ID | Finding | Severity | Status | Closure Blocker |
|---|---|---|---|---|
| H-C1 | `/status` genuine server failures are swallowed as graceful unavailable | P1 | Open | Yes |
| H-C2 | Create Version can report a successful commit as failure after refresh | P1 | Open | Yes |
| H-C3 | Routine Real-Index sync can overwrite target-path staged intent | P1 | Open | Yes |
| H-C4 | Withdraw lacks valid canonical same-vault marker enforcement | P1 | Open | Yes |
| H-C5 | Restore ref/read/write/result are not one atomic observed snapshot | P1 | Open | Yes |
| H-C6 | Short Withdraw SHA is accepted but never equals full HEAD | P2 | Open | Yes |
| H-C7 | Timeline grouping uses fixed-duration day arithmetic across DST | P2 | Open | Yes |
| H-C8 | Three-platform full-suite verification is missing | P1 (Verification) | Open | Yes |
| H-C9 | Required History regression coverage is incomplete | P1 (Verification) | Open | Yes |
| H-C10 | History filesystem reads/writes lack symlink-safe Vault containment | P1 | Open | Yes |
| H-C11 | HEAD and Withdraw parent resolution do not fail closed | P1 | Open | Yes |
| H-C12 | Cross-process History mutation and Repair metadata serialization is incomplete | P1 | Open | Yes |
| H-C13 | `ensureRepo` bootstrap is not atomically serialized and its non-overwrite check has TOCTOU | P2 | Open | Yes |
| H-C14 | Textual Git-log separator is injectable through commit messages | P2 | Open | Yes |
| H-K8 | Rename history is not `--follow`-merged | P2 | Open | No |
| H-K10 | Timeline and Log have no pagination | P2 | Open | No |
| H-K13 | SHA-256 Vault repositories are unsupported by the 40-zero CAS sentinel | P2 | Open | No |

## 5. Candidate Final Invariants

No group below is a final-baseline verification claim.

### 5.1 Verified individually on review baseline

These have direct existing test-source cases, though the full suite was
not rerun for this consolidation:

1. Create commits selected captured bytes through a Temporary Commit
   Index.
2. Create and Withdraw use CAS HEAD movement.
3. Withdraw leaves Working Tree bytes unchanged.
4. Repair takes `.git/index.lock`, verifies fingerprints, writes,
   fsyncs, closes, and renames.
5. Restore uses `--worktree`, not `--staged`.
6. newer editor edits are preserved during a pending Restore.
7. client path/Vault mutation barriers exclude overlapping in-app
   workflows.

### 5.2 Source-traceable but incompletely tested

1. all seven repository-operation markers are present in source;
   direct Create parametrization covers only `MERGE_HEAD` and
   `CHERRY_PICK_HEAD`;
2. server `withRepoMutation` is keyed by resolved Vault path, but
   same-Vault serialization plus different-Vault parallelism lacks a
   dedicated test;
3. Repair v1 migration and quarantine branches exist, but there is no
   cross-process lock or lost-update test;
4. plumbing commits bypass ordinary commit hooks and signing;
5. bootstrap intends non-overwrite behavior, but concurrent first
   touch is not protected.

### 5.3 Unimplemented closure candidates

1. symlink-safe filesystem containment;
2. fail-closed HEAD/full-commit/parent resolution;
3. atomic Vault identity and exactly one valid canonical same-vault
   marker;
4. F0/F1 path-selective routine Index synchronization;
5. complete, ordered, pairwise-disjoint Index terminal outcomes plus
   `replacementApplied`, `finalHead`, and `reconciliationRequired`;
6. F0-bound failed-path Repair and a separate persisted
   post-replacement HEAD reconciliation transaction;
7. whole-Vault cross-process mutation locking, fixed lock hierarchy,
   Repair lost-update protection, and stale-owner recovery;
8. existing-file, missing-leaf, deleted-path, and pathname-identity
   resolver modes;
9. one-entry `restoreFileAtomic` and authoritative `result.raw`;
10. Create success settlement before save-barrier release and all
    refreshes;
11. shared fail-closed ref resolvers and stable structured History
    errors;
12. marker-specific Withdraw client errors selected by code;
13. one serialized `ensureRepo` first-touch transaction;
14. machine-safe NUL-framed Log parser;
15. DST-safe grouping and explicit child-process TZ tests;
16. three-platform full-suite evidence.

The canonical marker is an accidental-withdrawal guard, not
cryptographic provenance proof.

## 6. Closure Gate

Every item must be complete on one immutable Final Production
Baseline.

### 6.1 Governance and findings

```text
[ ] Owner approves Spec and Plan
[ ] H-C1 through H-C14 are closed
[ ] H-K8, H-K10, and H-K13 are either retained as non-blocking scope
    or changed only with Owner approval
[ ] Final Production Baseline SHA is captured
```

### 6.2 Required regression evidence

```text
[ ] F0 captured before HEAD move
[ ] pre-staged and F0→F1 changed paths preserved
[ ] mixed safe/preserved path classification
[ ] complete pairwise-disjoint path partition in request order
[ ] Repair created only for failedPaths and bound to F0
[ ] no-lock/no-write/all-preserved branches
[ ] index.lock cleanup after Temporary Index and verification failure
[ ] close-before-rename and external git add after each failure
[ ] no rename after fingerprint mismatch
[ ] no Temporary-Index-only or pre-rename partial synchronized result
[ ] post-rename HEAD recheck and truthful replacementApplied result
[ ] persisted post-replacement reconciliation can be retried/discarded
[ ] no F0-bound Repair after an already-published replacement

[ ] symlink leaf and directory-segment rejection
[ ] no outside-Vault hash, commit, WORKTREE file/diff, or Restore
[ ] selected deletion without realpath of an absent leaf
[ ] verified untracked/missing-leaf Create and initially absent Restore
[ ] parent and pathname identity rechecked around the final operation
[ ] replaced pathname never returns unreachable-inode bytes

[ ] unborn HEAD distinguished from operational failure
[ ] 7–40 hex request resolved to one full immutable SHA
[ ] C6 adapts to the single shared C11 resolver
[ ] strict root/one-parent/merge parsing
[ ] no HEAD move on command failure or malformed output
[ ] stable marker/ref/parent HistoryErrorCode responses
[ ] HistoryApiError preserves status, code, message, and details
[ ] client chooses conflict UX by code with a generic legacy fallback

[ ] atomic Vault-id first touch and locked malformed-ID quarantine
[ ] exact final canonical marker block
[ ] user-body fake trailers are not authoritative
[ ] unmarked, malformed, ambiguous and cross-vault marker rejection
[ ] merge and invalid-changed-path rejection
[ ] marker-specific client UX

[ ] concurrent Repair record/settle serialization
[ ] no migration/quarantine lost update
[ ] Repair metadata lock cleanup
[ ] repair-status performs no unlocked mutation

[ ] two-process Create/Withdraw and Create/Restore serialization
[ ] older post-CAS Index publication cannot follow a newer HEAD move
[ ] fixed Vault-id/Repair/Index nested lock order and no deadlock
[ ] live Vault lock retained; positively dead owner safely recovered
[ ] indeterminate stale-lock ownership fails closed
[ ] ordinary exception cleanup and different-Vault parallelism

[ ] Restore uses one immutable SHA for read and write
[ ] post-restore observed raw/mtime identity
[ ] client uses result.raw in editor and VaultFileChanges
[ ] newer editor edits preserved
[ ] no double repository mutex
[ ] completed Restore stays successful on refresh failure

[ ] Create stays successful on Status, Log, or Comparison refresh failure
[ ] composer settles before refresh and retry cannot duplicate
[ ] Create stays successful when save-barrier release rejects
[ ] result/completion/Repair/composer settle before barrier release
[ ] barrier release runs once and cannot retain the path mutation lock
[ ] multiple auxiliary failures produce one informational warning
[ ] Withdraw stays successful on Repair-status or local cleanup failure

[ ] DST spring/fall cases under explicit child-process TZ
[ ] Log delimiter/control/multiline cases produce no phantom record
[ ] serialized bootstrap; one git init; all callers see one valid repo
[ ] bootstrap dotfile non-overwrite and safe partial-init retry
[ ] in-lock repository recheck and different-Vault init parallelism
[ ] all seven repository-operation markers
[ ] direct logical path-shape cases
[ ] same-Vault serialization and different-Vault parallelism
```

### 6.3 Final commands and platform matrix

```text
[ ] npm run typecheck
[ ] npm run build
[ ] npm test -- --run
[ ] approved History Long Flow
[ ] git diff --check
[ ] Linux full suite
[ ] macOS full suite
[ ] Windows full suite
```

## 7. Verification Evidence

### 7.1 Documentation Contract Completion

The following evidence is for documentation only and does not satisfy
the Final Production Baseline gate:

| Check | Result |
|---|---|
| source review for the seven affected contracts | PASS — current behavior remains separated from intended remediation |
| only the five authorized Markdown files changed | PASS in the worktree — `git diff --name-only 7908f3b5c296ac1223bb3ee5df7086d0f44dc9a1` listed README, Spec, Plan, Implementation Record, and Draft Closure only; the required `...HEAD` recheck remains pending until the substantive commit exists |
| `git diff --check` | PASS — exit 0, no output |
| code-fence-aware relative Markdown links | PASS — 43 relative links resolved across the five documents; fenced code ignored |
| prohibited stale terminology scan | PASS — the required stale-contract expression set returned no matches (exit 1) |
| finding-ID/title/severity/blocker consistency | PASS — 17 canonical findings matched in all four finding tables; all 14 blockers matched in README |

### 7.2 Production verification

```text
npm test -- --run: NOT RUN
npm run typecheck: NOT RUN
npm run build: NOT RUN
History Long Flow: NOT RUN
Linux/macOS/Windows matrix: NOT RUN
```

No CI result is asserted. Existing CI configuration is not a completed
verification run.

## 8. Accepted Risks

No Accepted Risk has Owner Approval.

These items may not be accepted or downgraded:

- symlink escape;
- staged-intent loss;
- fail-open HEAD or parent resolution;
- cross-process mutation interleaving or Repair lost update;
- successful commit reported as failure;
- invalid-marker withdrawal;
- silent editor/disk divergence;
- any unverified power-loss durability claim.

Only these current non-blocking candidates may be considered later:

- H-K8 rename history not `--follow`-merged;
- H-K10 no Timeline/Log pagination;
- H-K13 no SHA-256 Vault support.

## 9. Maintenance-Mode Rules (Candidate)

These rules are inactive until Closure is CLOSED and Owner Approval is
recorded.

1. Every server-side mutation enters exactly one repository mutation
   transaction and applies the operation-state check appropriate to
   that operation.
2. Every HEAD-moving mutation performs a second repository-idle check
   immediately before CAS `update-ref`.
3. Restore and Repair are not HEAD-moving mutations and are not
   described as requiring that second pre-`update-ref` check.
4. Create uses a Temporary Commit Index and never stages a version
   through the Real Index.
5. Routine Index sync preserves pre-existing and concurrent staged
   intent path by path.
6. Only Failed Sync Paths can create a Repair Transaction.
7. Restore changes Working Tree only and returns the post-restore
   snapshot observed in its transaction.
8. Withdraw requires exactly one valid canonical same-vault marker.
9. The marker remains an accidental-withdrawal guard, not
   cryptographic provenance proof.
10. Every mutating History operation enters one cross-process Vault
    mutation lock exactly once.
11. Nested locks always follow: Vault mutation, Vault-id creation,
    Repair metadata, then Git `index.lock`.
12. Live or indeterminate Vault-lock ownership is never removed;
    recovery requires positive same-host dead-owner proof and nonce
    comparison.
13. All migration, quarantine, and Repair read-modify-write metadata
    operations hold the dedicated metadata lock under the Vault lock.
14. Regression tests and the approved verification matrix accompany
    every safety-contract change.

## 10. Final Closure Procedure

1. Implement C1–C7 and C10–C14 in dependency order.
2. Complete and pass the C9 aggregate regression gate.
3. Run C15 once on one immutable candidate SHA.
4. Use C15 evidence to close H-C8.
5. Capture the Final Production Baseline through C16.
6. Obtain Owner Approval.
7. Close or explicitly retain only approved non-blocking H-K risks.
8. Enter CLOSED / Maintenance Mode through C17.

Until every step is complete:

```text
Status: DRAFT — CLOSURE IN PROGRESS
Owner Approval: PENDING / BLOCKED
Final Production Baseline: NOT YET CAPTURED
Maintenance Mode: NOT ENTERED
```

## 11. 2026-08-01 Cross-Feature Correction Overlay

This overlay records a narrow remediation against production commit
`1a065bb0c2517f8a1fe1886b806e6945c2830538`. It does not declare the
History feature closed and does not convert the remaining canonical
findings into accepted risks.

RED commit `36fed44dbf0276ee876f1d2a1f8d6c51c6bc7be9`
demonstrated eight deterministic failures: six History mutation types
entered while a folder transaction owned the Vault, History Restore
entered while startup recovery held its seam, and a second process
served mutations for the same Vault.

For this correction slice:

| Finding | Correction status | Remaining closure qualification |
|---|---|---|
| H-C5 | REMEDIATED IN CODE | Restore now resolves one immutable SHA, reads its blob, and commits through locked CAS/create-only document writes with authoritative post-read verification. Broader H-C10 filesystem-containment closure remains open. |
| H-C12 | REMEDIATED IN CODE | One lifetime writer owns the canonical Vault; all covered mutations and recovery share `withVaultMutation`. Cross-platform production verification remains open. |
| H-C10 | OPEN | Restore rejects observed leaf symlinks and validates missing parents, but this focused change does not claim the full all-History symlink-safe resolver contract. |

The selected lock order is:

```text
process-lifetime Vault writer ownership
→ process-local withVaultMutation
→ withVaultStructureLock when membership changes
→ sorted document write locks
→ withRepoMutation
→ Git index.lock
→ atomic file write/link/rename commit point
```

Restore no longer invokes `git restore --worktree`. Existing files use
`atomicReplaceTextIfUnchanged`; missing files use
`prepareAtomicTextCreate`; metadata identity is preserved and rolled
back on failed settlement. Retained valid or malformed journal
ownership blocks the write before any content commit.

Local evidence bound to the production SHA:

```text
focused History/coordination: 4 files, 145 passed
complete npm test -- --run:    156 files, 2476 passed, 2 skipped
npm run typecheck:             PASS
npm run build:                 PASS (dependency/chunk-size warnings only)
git diff --check:              PASS
direct restore search:         no production matches
v4 executor/metadata diff:     empty
```

The Ubuntu, macOS CI, Windows, and Visual jobs have not been dispatched
for this production SHA. Local execution was on macOS only. Therefore:

```text
Cross-feature concurrency bug: REMEDIATED IN CODE
Folder-move v4 protocol semantics: UNCHANGED
History Restore direct git overwrite: REMOVED
Single active Vault writer: ENFORCED
History production verification: IN PROGRESS
History Closure: DRAFT — CLOSURE IN PROGRESS
Owner Approval: PENDING / BLOCKED
```

## 12. 2026-08-02 Current Production Baseline

Current production-code baseline: `5df3ad9b50aebfc0d368a1d2865ec85de06afc98`.
This section supersedes the earlier current-baseline overlays above.

Closed or remediated in this baseline:

| Finding / area | Status and evidence |
|---|---|
| AI path overreach | Strict `validateHistoryPaths`, changed-status recheck, duplicate rejection, symlink rejection, and 20-path cap. Invalid/mixed/unchanged/symlink inputs are covered by route tests. |
| AI resource exhaustion | 256 KiB/file, 1 MiB total input, 10,000 total lines, 8,000 chars/file, 20,000 chars total; oversized added and deleted blobs return 413 before provider invocation. |
| Create HEAD race | `addAndCommit` compares the HEAD captured before staged-intent classification with the HEAD immediately before temporary-index initialization; deterministic soft-reset coverage proves no Nuvyn commit, Index Repair, or staged-content loss. |
| Repair metadata race | Repair records use the operation-start fingerprint, revalidate it while holding `.git/index.lock`, and persist metadata before releasing the lock. Create and Withdraw races are covered. |
| Vault marker identity | `.nuvyn/vault-id` is an exclusive, fsynced, strict UUID record; malformed, symlinked, duplicate-trailer, foreign, root, and merge cases fail closed. Directory moves retain the marker. |
| Restore containment | Restore target resolution is inside Vault/structure/document locks; path-segment identities are rechecked before write, after write, before post-read, and during rollback. Deterministic parent-symlink tests prove no outside write. |
| Structured client errors | `HistoryApiError` now preserves `status`, `code`, and `details`; History composables prefer stable repository/repair codes with message fallback. |

Still open or qualification-required:

| Area | Remaining status |
|---|---|
| H-C10 filesystem TOCTOU | The shared lstat/open/fstat resolver closes static symlink and tested replacement windows, but Node does not provide a portable directory-handle `openat` protocol here. A narrow check/use window remains, so this finding is not declared fully closed. |
| H-C7 / DST evidence | Timeline code uses local calendar dates; explicit child-process DST spring/fall tests are still missing. |
| H-C8 | Full verification was run on macOS only; Linux and Windows CI were not run. |
| H-C13 and H-K8/H-K10/H-K13 | Bootstrap cross-process TOCTOU, rename-follow history, pagination, and SHA-256 zero-sentinel follow-ups remain open. |
| Closure governance | Owner Approval is pending. |

Final local evidence on macOS:

```text
npm test -- --run: 163 test files passed; 2522 passed, 2 skipped
npm run typecheck: PASS
npm run build: PASS (existing dependency pure-annotation/chunk-size warnings only)
git diff --check: PASS
```

Because cross-platform evidence and Owner Approval are incomplete, the
History feature remains:

```text
DRAFT — CLOSURE IN PROGRESS
```

## 2026-08-02 History Feature Freeze

### Freeze Decision

History is temporarily frozen for maintenance prioritization. Normal
single-user personal use is supported, while the remaining work is
concentrated in extreme filesystem concurrency races. Fully addressing those
races would require a directory-handle protocol, native filesystem
interfaces, delayed quarantine, or a broader file-transaction layer.
Continuing to add patches now has a lower expected benefit than the risk of
regressions in ordinary paths.

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

### Deferred Findings

The detailed backlog is recorded in
[vault-git-history-freeze-backlog.md](../freezes/vault-git-history-freeze-backlog.md).
H-FREEZE-1 through H-FREEZE-5 remain `DEFERRED`; this freeze does not declare
them closed.

### Temporary Risk Acceptance

The project temporarily accepts these risks for local personal use, one
active Nuvyn instance, ordinary filesystem behavior, and a non-adversarial
environment. It does not accept them for hostile local processes,
multi-writer coordination, network filesystems, security-boundary guarantees,
or multi-user/multi-tenant use.

This is a reversible project-maintenance decision, not a security proof.
Reopening work continues from the Freeze Backlog.

### Reopening Conditions

Reopen History hardening after quarantine or journal residue, any user-data
loss report, a plan for multi-instance or network-filesystem support, a
requirement for strong external-editor concurrency, native dirfd/openat
support, Final Closure or cross-platform certification work, an Owner request
to close H-C10, or reuse of the History atomic layer by another module.

### Freeze Contribution Rules

Do not accept new History enhancements, pure refactors, or complexity-only
atomic protocol changes during the freeze. Only deterministic normal-path
bugs, user-data-loss fixes, security vulnerabilities, compile failures, test
stability fixes, platform compatibility fixes, or necessary documentation
corrections may bypass it.

Every History production-code pull request that bypasses this freeze must
state:

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

## 31. 2026-08-02 Post-Commit Artifact and Conditional-Remove Follow-up

Production-code commit: `e5e20c5ed3950e625003a443184fe8131cd20369`.
Client regression-test commit: `ba90ce51dca07606e0feaa300ef7826f1b52cf22`.

This follow-up closes the reviewed data-loss paths without changing History
layout or interaction:

| Finding | Result and evidence |
|---|---|
| Replacement old-FD mutation | After the replacement is linked, staged content is captured again with stable reads and compared with the expected generation. Same-inode external writes raise `HISTORY_POST_COMMIT_EXTERNAL_MUTATION`; staged bytes remain quarantined and the journal enters `post-commit-external-mutation`. |
| Conditional remove formal-path loss | Final staged validation failures restore the still-proven generation with create-only semantics. A target claimed by an external writer is never overwritten; staged bytes remain quarantined and the operation returns a structured conflict. |
| Durable artifact cleanup | Journal and recovery-payload removal accepts creation proofs or captures identity/content hash before recovery cleanup. A second proof after the deterministic replacement hook prevents deleting a changed occupant. Journal rewrites verify the old generation and the new temporary before rename. |
| Crash recovery | The post-commit quarantine journal phase is parsed and retained without touching either generation. Recovery also refuses to remove a staged generation whose content no longer matches the expected hash. |
| Repair API test semantics | `repairIndex()` now has an endpoint-specific 409 test asserting URL, method, token, status, code, and details. |
| Markdown fences | Focused and full verification evidence are separate balanced code blocks. All three History documents have balanced fenced blocks. |

Focused macOS evidence:

```text
requested focused total: 4 test files, 95 passed, 0 failed
```

Full required macOS verification for this commit:

```text
npm test -- --run: 163 test files passed; 2551 passed, 2 skipped
npm run typecheck: PASS
npm run build: PASS (existing dependency pure-annotation/chunk-size warnings only)
git diff --check: PASS
```

The portable pathname check/use window remains open: no dirfd/openat,
renameat, or unlinkat-equivalent protocol was added. A replaced parent can
still produce an empty outside temporary on unsupported platforms, although
the pre-write check prevents document bytes from being written there. Linux,
Windows, DST subprocess evidence, H-C13 bootstrap serialization, and Owner
Approval remain open. Closure remains:

```text
DRAFT — CLOSURE IN PROGRESS
```

## 14. 2026-08-02 Temporary Ownership and Repair Persistence Follow-up

Current production-code commit:
`bece8228227c5018339336c6ce00448b57192a6e`.

This follow-up closes the reviewed P1/P2/P3 defects without changing the
History layout or interaction:

| Finding | Result |
|---|---|
| Temporary-file re-claim race | Temporary-file `dev/ino` is captured from the still-open `FileHandle.stat({ bigint: true })`; the parent identity is captured before creation and revalidated after close. `prepareAtomicTextCreate` and `prepareAtomicTextWrite` no longer recapture ownership from a pathname. A deterministic post-close parent replacement test proves the outside occupant is not removed or linked. |
| Repair metadata after Index replacement | When a HEAD move wins after the real Index replacement and the replacement transaction cannot be persisted, Repair returns `repairStatePersistenceFailed` with `replacementApplied` and `finalHead`; the route returns `HISTORY_INDEX_REPAIR_STATE_PERSISTENCE_FAILED` (409), and the UI tells the user to inspect Git manually. |
| Unverifiable legacy marker | Arbitrary 12-hex markers are no longer described as confirmed old Nuvyn versions; the stable legacy code now carries `reason: unverified-legacy-marker` and user-facing text explicitly says Vault ownership cannot be confirmed. |

Focused evidence on macOS: 4 test files, 175 tests passed; client and
server typecheck passed. Final required command evidence on macOS is:

```text
npm test -- --run: 163 test files passed; 2537 passed, 2 skipped
npm run typecheck: PASS
npm run build: PASS (existing dependency annotation/chunk-size warnings only)
git diff --check: PASS
```

The portable directory-handle/openat
TOCTOU window in H-C10, Linux/Windows execution, DST subprocess evidence,
H-C13 bootstrap serialization, and Owner Approval remain open. Closure stays:

```text
DRAFT — CLOSURE IN PROGRESS
```

## 13. 2026-08-02 Restore/Index/Error-Code Follow-up

The production-code commit for this follow-up is
`b60630d2cd8fd840827aed15967a92b918e91a32`.

This commit closes the specifically reviewed follow-up defects:

| Area | Result and evidence |
|---|---|
| Missing-file Restore rollback | The pre-commit hook now runs before temporary-file creation. Prepared files record temporary-file and parent-directory `dev/ino`; commit and rollback verify both identities and never remove an unproven pathname. Deterministic tests cover parent isolation and temporary pathname replacement. |
| Create/Withdraw Index rename race | Index synchronization returns structured replacement state. If HEAD changes after the real Index replacement, Repair binds to the observed final HEAD and the fingerprints actually installed by Nuvyn. Create and Withdraw tests verify Repair execution and unrelated staged entries. |
| AI Diff formatting | Diff lines are accumulated and joined with `\\n`, producing exact line-oriented modified/added/deleted text without leading/trailing or concatenated newlines. |
| Structured History errors | Repair verification failure returns `HISTORY_INDEX_REPAIR_CONFLICT`; Withdraw distinguishes external, legacy-marker, repository-operation, writer-active, and HEAD-changed cases. Legacy path-hash versions remain viewable/restorable but cannot be withdrawn. |

Final local verification on macOS, with the crash-recovery subprocess suite
run under the required controlled process/IPC permission:

```text
npm test -- --run: 163 test files passed; 2534 passed, 2 skipped
npm run typecheck: PASS
npm run build: PASS (existing dependency annotation/chunk-size warnings only)
git diff --check: PASS
```

The first sandbox-only test attempt could not create the existing `tsx` IPC
pipe and reported `EPERM`; the same required command passed under controlled
permissions. No Linux or Windows execution was performed, and Owner Approval
is still pending. The residual portable directory-handle/openat TOCTOU window
in H-C10 remains open. Therefore Closure remains:

```text
DRAFT — CLOSURE IN PROGRESS
```

## 15. 2026-08-02 Filesystem Pathname Race Follow-up

Current production-code commit:
`dab1e12119c9f7f84316fe419a6d41b2e2fb3b63`.

This follow-up narrows the remaining portable pathname races without
claiming a directory-handle protocol:

| Finding | Result |
|---|---|
| Parent replacement before temporary open | A deterministic hook now replaces the parent after identity capture. The writer revalidates the opened file and parent before writing document bytes; the outside case can leave only an empty quarantine file and cannot receive the document content. |
| Unconditional replacement rename | `atomicReplaceText` revalidates the temporary artifact and parent generation immediately before rename. A replaced parent returns `HISTORY_PATH_MOVED` and leaves the original artifact isolated. |
| Conditional removal | `atomicRemoveTextIfUnchanged` captures target and staged `dev/ino` plus parent identity, revalidates before takeover and before unlink, and preserves a replaced staged pathname instead of deleting its occupant. |
| Intermediate cleanup | Temporary, staged, and operation journal cleanup in the atomic writer uses creation-time identity proofs. Durable create-only files now capture identity from the still-open handle and fail closed during cleanup. |
| Repair client coverage | The client directly tests `HISTORY_INDEX_REPAIR_STATE_PERSISTENCE_FAILED`; it retains the transaction, avoids a discardable conflict token, refreshes status, and shows the manual Git inspection warning. API tests preserve code/details. |

The implementation does not provide portable `openat`/`renameat`/`unlinkat`
semantics. The remaining check/use window therefore remains H-C10: an
attacker capable of replacing a directory at that exact point can still affect
a pathname operation. The code and tests do not claim that external empty
artifacts are impossible on unsupported platforms; they prove that the
pre-write window does not leak document bytes. H-C10 is not declared closed.

Focused macOS evidence after this follow-up:

```text
server/__tests__/atomicTextWrite.test.ts: 22 passed
server/__tests__/createOnlyMove.test.ts: 22 passed
src/composables/vault/__tests__/useHistoryCommit.test.ts: passed
src/lib/__tests__/history-api.test.ts: passed
```

Full required macOS verification:

```text
npm test -- --run: 163 test files passed; 2543 passed, 2 skipped
npm run typecheck: PASS
npm run build: PASS (existing dependency annotation/chunk-size warnings only)
git diff --check: PASS
```

Linux/Windows validation, DST subprocess evidence, H-C13 bootstrap
serialization, and Owner Approval remain open. Closure remains:

```text
DRAFT — CLOSURE IN PROGRESS
```
