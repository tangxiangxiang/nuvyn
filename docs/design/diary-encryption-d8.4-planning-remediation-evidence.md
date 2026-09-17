# D8.4 Planning Remediation Evidence

> **Historical lineage — not current runtime authority.** Current behavior is
> defined by [Diary Architecture](../architecture/diary.md) and [Diary User
> Guide](../user-guide/diary.md). This file is retained for D8 review
> traceability.

## 1. Scope and lifecycle

This file records the docs-only D8.4 Planning Remediation Round 1, Round 2
and Round 3 evidence. Round 3 remediates exactly the one finding left open by
Independent Planning Re-review Round 2 (`D8.4-IPR-P1-2`). It does not
implement D8.4, does not reopen the seven closed findings and does not edit
either immutable review record.

```text
D8.0 = REVIEW-CLOSED
D8.1 = REVIEW-CLOSED
D8.2 = REVIEW-CLOSED
D8.3 = REVIEW-CLOSED

D8.4 Planning = REVIEW-READY / NOT APPROVED
D8.4 Independent Planning Review = CHANGES REQUIRED (0/5/3) [historical]
D8.4 Planning Remediation Round 1 = COMPLETE
D8.4 Independent Planning Re-review = CHANGES REQUIRED (0/1/1) [historical]
D8.4 Planning Remediation Round 2 = COMPLETE
D8.4 Independent Planning Re-review Round 2 = CHANGES REQUIRED (0/1/0) [historical]
D8.4 Planning Remediation Round 3 = COMPLETE
D8.4 Independent Planning Re-review Round 3 = PENDING
D8.4 implementation = BLOCKED / NOT STARTED
D8.4 = NOT REVIEW-CLOSED
```

No production code, tests, schema/data, runtime configuration, vault file or
Git history was changed.

## 2. Provenance and CI investigation

| Evidence | Value |
| --- | --- |
| Starting HEAD | `9f8d06d1f0dd2223dfc2ccc3d313f4a30053c386` |
| Starting branch | `main` |
| Starting `github/main` | `9f8d06d1f0dd2223dfc2ccc3d313f4a30053c386` |
| Starting working tree | clean |
| Historical D8.4 planning | `cbd5424ebe82737604b621a1be58f1c1b965e5f0` |
| Historical planning CI | #598 / `33396383314` / attempt 1 / exact head / 8 of 8 PASS |
| Historical Independent Planning Review | `9f8d06d1f0dd2223dfc2ccc3d313f4a30053c386` |
| Historical review verdict | `CHANGES REQUIRED (0/5/3)` |

CI #599 was inspected before remediation:

```text
Run:       #599
Run ID:    33407721220
Attempt:   1
HEAD:      9f8d06d1f0dd2223dfc2ccc3d313f4a30053c386
Result:    FAILURE
Failed job: auth-browser only; seven jobs passed
```

The uploaded `auth-browser-evidence` trace and `error-context.md` show the
second test (`real revoked session preserves a browser draft through expiry,
login, and recovery`) timing out in `ensureAuthenticatedOwner` while waiting
for `.vault`; the DOM remained on the login form after the redirect. The exact
focused command `npm run test:e2e:auth` was then run against the same starting
HEAD in the isolated checkout: both tests passed (`2 passed`, 8.6 seconds).
The same lane in #598 passed (`2 passed`, 17.3 seconds). No production/test
change was made and no blind retry was used. This supports classifying #599 as
a historical, non-reproduced CI/browser setup fluctuation, not a D8.4 defect;
#599 remains failure evidence and is not erased or substituted by #598.

## 3. Source-owner basis

The remediation was checked against the existing owners: the sole
server-side `DiaryAccessService` and `DiaryBodyOperation`; V1 envelope parser
and AES-GCM/AAD adapter; production/Vite startup and generic crash recovery;
safe-path and atomic writers; vault/document lock queues; document metadata,
metadata migration and frontmatter archive; DraftStore; SQLite migration
`0001_ai_history` plus `server/ai/messages.ts`, `chat.ts` and `tools.ts`; and
the Git/history owner. The plan now names a future `DiaryMigrationFs` as the
only D8.4 filesystem owner without changing those current owners.

## 4. Finding remediation record

### D8.4-IPR-P1-1 — locked startup authentication

**Root cause.** A locked restart has no live DEK. Parsing V1 structure,
document ID or envelope magic cannot prove AES-GCM tag/AAD authenticity, yet
the original plan could advance from structural target evidence to `PUBLISHED`
or cleanup.

**Planning sections changed.** PRD §§7–9, 10, 14–16, 18, 20; Implementation
Plan decisions 3, 7–9, state machine §§5–6, Workstreams B/G/H/I/J and the
deterministic hook oracle §§17–19; canonical D8 plan §8.1.

**New frozen contract.** `RECOVERY_AUTH_REQUIRED` is the single deferred-auth
state. A target that may have been published while locked is never called
`PUBLISHED`, never restored over with plaintext, never cleaned and never
authenticated by parsing alone. The ledger records only transaction ID,
internal non-secret ciphertext SHA-256, exact target generation and phase.
After unlock the existing body lease revalidates path/generation/fingerprint
and performs AES-GCM/AAD authentication with vault ID, document ID and
canonical path. Success advances to `PUBLISHED`/`CLEANUP_PENDING`; forged,
replaced or failed authentication is `NEEDS_ATTENTION` with target/quarantine
preserved. Body read/save/create, resume, metadata cleanup, Draft import and
AI disposition while pending return `423 diary-migration-auth-required`;
structural status remains safe to read.

**Owner rationale.** `DiaryAccessService` remains the only live DEK owner and
`DiaryBodyOperation` remains the only crypto lease. Startup recovery is
structural-only until an authenticated session exists.

**Future proof/tests.** Kill at `AFTER_CIPHERTEXT_PUBLISH_SYSCALL` and
`AFTER_TARGET_DURABILITY` while locked; assert `RECOVERY_AUTH_REQUIRED`, no
plaintext restore/cleanup; unlock with exact ciphertext authenticates to
`PUBLISHED`; forged syntactic V1, wrong fingerprint and external replacement
remain attention.

**Remaining risk.** A user-controlled process can still retain legacy or
external copies; cryptographic erasure is not claimed. Status:
`PLANNING REMEDIATED` — closure pending Independent Planning Re-review.

### D8.4-IPR-P1-2 — cross-platform filesystem ownership/publication

**Root cause.** The original wording mixed lstat/pathname rename, link/rename,
unsupported-platform permissiveness and swallowed directory-fsync errors. It
did not prove that the destructive operation used the generation that had been
checked or that publication was no-replace on Windows.

**Planning sections changed.** PRD §§9.1–9.2, 9.3 and 15–16; Implementation
Plan decisions 6, 8, 9, 12, Workstream B, cross-platform §18, hook oracle §19
and API/error §14; canonical D8 plan §8.1.

**New frozen contract.** `DiaryMigrationFs` is the sole migration filesystem
owner and exposes capture, a captured-handle conditional same-generation
source transition, ciphertext-temp write, atomic create-only publication,
artifact verification, token-bound quarantine removal and durability
synchronization. Round 2 below supplies the exact Linux/macOS/Windows native
operation and restart-reacquisition semantics; no implementation choice may
fall back to a pathname check/use pair. Junction, reparse, case-folding,
cross-device, source-busy, open-handle/antivirus, unsupported exact-source or
no-replace primitive, and durability uncertainty are stable fail-closed
outcomes (`diary-migration-filesystem-unsupported` HTTP 503,
`diary-migration-durability-pending` or attention). No copy/delete, overwrite
rename or weaker alternate primitive is permitted. The sole plaintext
quarantine pathname refers to the exact pre-existing inode and is removable
only after the exact live or restart-reacquired native authority proves it.

**Owner rationale.** Existing generic atomic writers remain Note-only. The
future native helper is the single place where platform semantics are selected;
the migration service cannot silently choose a weaker Node pathname call.

**Future proof/tests.** Deterministically replace source before and at the
ownership boundary; race a junction/reparse point and target appearance;
exercise unsupported no-replace, cross-device, Windows sharing/AV handles,
case-folded reuse, directory durability failure, quarantine-name reuse and
assert external generations are never deleted and no copy path executes.

**Remaining risk.** The native helper does not yet exist and must prove these
semantics on each release filesystem. Status: `PLANNING REMEDIATED` — closure
pending Independent Planning Re-review.

### D8.4-IPR-P1-3 — immutable inventory/action consent

**Root cause.** Three run-level booleans and a refreshed active scan allowed a
new primary, Draft family, SQLite row or changed generation to inherit consent
the user granted for an earlier inventory.

**Planning sections changed.** PRD §§7, 10, 11, 12, 14, 16, 18, 20;
Implementation Plan decisions 1, 4, 13, 19–20, state machine §§5–6,
Workstreams A–E/H/J, API/error §14 and test matrix §17.

**New frozen contract.** Each explicit scan creates immutable `inventoryRevision`
R. Server-created consents bind vault, run, R, exact item key, exact current
generation/row CAS, reviewed item-set fingerprint and one scope:
`MIGRATE_PRIMARY`, `REMOVE_VERIFIED_LEGACY_PRIMARY`, `CLEAN_PRIVATE_SQLITE`,
`IMPORT_DRAFT`, `DISCARD_DRAFT`, `DISCARD_AI_SESSION`, `RETAIN_AI_HISTORY`,
`BIND_FRONTMATTER_IDENTITY` or `ACKNOWLEDGE_GIT_RETENTION`. A rescan creates
R+1; new/changed rows become `CONSENT_REQUIRED`, and old runs/tokens/typed
phrases cannot authorize them. The server reconstructs current state; client
values never become authorization.

**Owner rationale.** `DiaryMigrationService` owns the snapshot and delegates
the actual conditional mutation to the existing document, Draft, SQLite and
AI owners. No second client authority is introduced.

**Future proof/tests.** Confirm R1, introduce new/changed primary/IDB/SQLite
rows and generations, rescan to R2 and assert each requires new consent;
replay old runs; exercise changed Draft family, typed discard and action-level
CAS failures.

**Remaining risk.** Consent does not control external copies or a user who
already has authorized access. Status: `PLANNING REMEDIATED` — closure pending
Independent Planning Re-review.

### D8.4-IPR-P1-4 — durable AI history inventory/disposition

**Root cause.** SQLite `0001_ai_history` sessions/messages can contain a
structured legacy `read_file` tool result with Diary plaintext, but the
inventory started at migrations 0002–0011 and gave no identity, action or
completion treatment.

**Planning sections changed.** PRD §§6–7, 10.1–11, 14, 16, 18, 20;
Implementation Plan owner inventory, decisions 15/19/20, Workstreams A/D/H/I,
ledger §6, test matrix §17 and release gate §20.

**New frozen contract.** Sessions, messages and structured tool-result
envelopes are first-class D8.4 stores. Only a proven tool identity + exact
canonical managed path + structured result classifies
`LEGACY_DIARY_AI_HISTORY`; free-text resemblance is not evidence. Content
classification requires unlock, is hidden from ordinary AI history while
locked, and copies only opaque IDs/structural state into the ledger. The
default is `NEEDS_ATTENTION`; `discard-ai-session` is a separately consented
whole-session delete through the existing AI owner, while `retain-ai-history`
is an explicitly acknowledged Nuvyn-controlled policy-retained private state.
Mixed sessions receive no substring surgery; ordinary AI history is unchanged.

**Owner rationale.** `server/ai/messages.ts` remains the row owner and
`chat.ts`/`tools.ts` provide source-backed envelope identity. D8.4 does not
invent a second AI store or erase arbitrary user text.

**Future proof/tests.** Fixtures cover structured managed-Diary result,
ordinary AI, mixed Note+Diary, locked hiding, explicit whole-session delete,
retention acknowledgment, crash/retry/idempotency, and no message content in
ledger/logs.

**Remaining risk.** Policy-retained AI history remains a Nuvyn-controlled
private residual and must remain in every completion summary. Status:
`PLANNING REMEDIATED` — closure pending Independent Planning Re-review.

### D8.4-IPR-P1-5 — NULL frontmatter identity

**Root cause.** `metadata_migrations.document_id` is nullable. “Optional ID”
could be interpreted as path-only cleanup after metadata adoption, allowing
path reuse to clear another row's rollback backup.

**Planning sections changed.** PRD inventory, §§7.2, 11–12, 14, 16, 20;
Implementation Plan decisions 10/16, Workstreams D/E, ledger §6, API/error
§14 and test matrix §17.

**New frozen contract.** `NULL document_id` is always
`FRONTMATTER_IDENTITY_UNRESOLVED`/`NEEDS_ATTENTION`; adoption does not imply
backup ownership. Optional `BIND_FRONTMATTER_IDENTITY` is a separate,
non-destructive action requiring exact null row, path, status, updated-at,
source-hash/backup/cleaned-hash CAS (source hash compared transiently), and
proof that the current generation is the legacy row. Binding sets only the
stable ID and never clears backup. Cleanup requires non-null exact ID, verified
binding, `PUBLISHED`, no rollback dependency and unchanged CAS. Note rows are
untouched.

**Owner rationale.** The existing metadata/frontmatter owners already require
non-null ID for safe cleanup; D8.4 preserves that invariant.

**Future proof/tests.** Null row with no proof, path reuse, verified generation
binding, binding crash, changed CAS, cleanup crash/retry and same-path Note
rows all retain or safely bind without path-only deletion.

**Remaining risk.** An unprovable legacy row remains attention instead of being
automatically cleaned. Status: `PLANNING REMEDIATED` — closure pending
Independent Planning Re-review.

### D8.4-IPR-P2-1 — body-length privacy

**Root cause.** Durable `source_generation_json.size` would reveal the exact
legacy plaintext byte length despite D8.3's private body-length boundary.

**Planning sections changed.** PRD §§5–9, 11, 14, 16, 18, 20;
Implementation Plan ledger §6, Workstreams A/B/I, test matrix §17 and release
gate §20; canonical D8 plan §8.1.

**New frozen contract.** Byte size may be used transiently in an authorized
process for bounded I/O only. It is absent from source/quarantine/target
generation JSON, ledger, locked status, API/UI, logs and evidence. Remaining
generation fields are explicitly classified as structural operational
provenance and cannot authorize mutation alone. The internal randomized
ciphertext fingerprint is non-secret transaction provenance and is not locked
visible.

**Owner rationale.** `DiaryMigrationFs` may enforce limits without expanding
the durable privacy surface; tree/list's existing size behavior is not copied
into D8.4 status.

**Future proof/tests.** Inspect proposed schema/status/log/artifact values and
assert no body length, body hash or plaintext digest; assert only internal
ciphertext fingerprint/generation is retained.

**Remaining risk.** Filesystem metadata can still be observable to a local
privileged reader; D8.4 does not claim full traffic-analysis resistance.
Status: `PLANNING REMEDIATED` — closure pending Independent Planning Re-review.

### D8.4-IPR-P2-2 — ordinary PUT concurrency

**Root cause.** The existing document lock is a waiting FIFO queue with no
owner/try-lock result, so a normal PUT could not produce the promised 409
merely because migration held the lock.

**Planning sections changed.** PRD §9.3 and §14; Implementation Plan owner
inventory, decisions 2/12/19, Workstreams B/H, API/error §14 and test matrix
§17.

**New frozen contract.** Ordinary managed PUT serializes behind the existing
`withDocumentWriteLock`; after acquisition it revalidates session/CAS/primary
state and proceeds or returns the existing semantic conflict. No
migration-specific 409 is promised for lock wait. Only competing
migration-control requests may return `409 diary-migration-in-progress`.
Migration and vault/structure/document lock ordering remains one owner path;
no second migration lock registry is introduced.

**Owner rationale.** This matches the actual `documentWriteLock.ts` FIFO and
preserves Note behavior while making the API contract truthful.

**Future proof/tests.** Hold migration lock, queue ordinary save, complete
migration and assert current-state revalidation; test stale CAS, logout/expiry,
two migration starts and lock-order deadlock absence.

**Remaining risk.** A queued request may wait longer than a caller expects;
the existing server timeout/cancellation policy remains applicable. Status:
`PLANNING REMEDIATED` — closure pending Independent Planning Re-review.

### D8.4-IPR-P2-3 — deterministic crash evidence

**Root cause.** “At every hook” named no hook enum, injection API, process kill
semantics or expected durable observations, so timing-based tests could not
prove the publication/ledger boundary.

**Planning sections changed.** PRD §15 and §20; Implementation Plan §§17–21,
especially the exact hook oracle in §19.

**New frozen contract.** Round 1's exact seams are superseded by a single
authoritative set of 19 seams:
`AFTER_JOURNAL_PREPARED`, `AFTER_CIPHERTEXT_TEMP_FSYNC`,
`BEFORE_SOURCE_TRANSITION`, `AFTER_SOURCE_TRANSITION`,
`BEFORE_CIPHERTEXT_PUBLISH`, `AFTER_CIPHERTEXT_PUBLISH_SYSCALL`,
`AFTER_TARGET_DURABILITY`, `AFTER_AUTHENTICATED_READBACK`,
`BEFORE_PUBLISHED_JOURNAL`, `AFTER_PUBLISHED_JOURNAL`,
`BEFORE_SQLITE_CLEANUP_COMMIT`, `AFTER_SQLITE_CLEANUP_COMMIT`,
`BEFORE_IDB_DISPOSITION_COMMIT`, `AFTER_IDB_DISPOSITION_COMMIT`,
`BEFORE_SOURCE_QUARANTINE_UNLINK`,
`AFTER_SOURCE_QUARANTINE_UNLINK_BEFORE_DIR_DURABILITY`,
`AFTER_SOURCE_QUARANTINE_DIR_DURABILITY`, `BEFORE_ITEM_COMPLETE` and
`AFTER_ITEM_COMPLETE`. The two SQLite hooks explicitly cover
`DISCARD_AI_SESSION` whole-session deletion; each has a durable
filesystem/journal/SQLite/IDB observation, lock state, authoritative
generation, allowed/forbidden action and next state in the oracle table. A
child server signals the parent at the selected seam; the parent terminates
it without graceful cleanup and a fresh process restarts against the same
isolated state. Browser/IDB seams instrument the actual transaction. Sleeps,
waitForTimeout and random kill timing are forbidden evidence.

**Owner rationale.** The seams surround existing filesystem/SQLite/IDB owners;
disabled instrumentation has no production behavior change.

**Future proof/tests.** Execute every enum seam, compare the oracle row, and
run the separate server-response-loss/IDB before-commit/after-commit/changed
row cases.

**Remaining risk.** The harness must be implemented and kept aligned with the
native filesystem helper. Status: `PLANNING REMEDIATED` — closure pending
Independent Planning Re-review.

## 5. Adversarial planning self-review

```text
Locked startup can distinguish authenticated V1 from syntactic bytes? NO;
  RECOVERY_AUTH_REQUIRED is used until unlock.
Locked recovery can restore plaintext over a possible target? NO.
Unsupported filesystem operation can silently weaken itself? NO.
Path-only proof can authorize deleting a later external generation? NO.
R1 consent can authorize a new/changed R2 generation? NO.
Final closure can omit a provable managed legacy AI message? NO.
NULL-document-ID backup can be cleared by path equality? NO.
Locked/durable migration state can expose body byte length? NO.
Documented ordinary save behavior maps to an actual owner primitive? YES.
Every durability boundary can be deterministically killed/restarted without
  timing sleeps? YES, through the exact hook oracle.
```

Self-review classification against the historical review:

```text
D8.4-IPR-P1-1 = PLANNING REMEDIATED
D8.4-IPR-P1-2 = PLANNING REMEDIATED
D8.4-IPR-P1-3 = PLANNING REMEDIATED
D8.4-IPR-P1-4 = PLANNING REMEDIATED
D8.4-IPR-P1-5 = PLANNING REMEDIATED
D8.4-IPR-P2-1 = PLANNING REMEDIATED
D8.4-IPR-P2-2 = PLANNING REMEDIATED
D8.4-IPR-P2-3 = PLANNING REMEDIATED
```

These are not `CLOSED`; only the separate Independent Planning Re-review may
close them.

## 6. Round-1 remediation commit and next gate (historical)

Planning remediation commit: this docs-only commit (exact SHA is recorded by
the final Git HEAD and release response).

Planning remediation CI: pending the exact-head CI run after push; the future
re-review target must have a green normal 8-job CI. Historical CI #599 remains
`FAILURE` and is preserved above.

At the time of Round 1 this re-review was `PENDING`; it was later recorded as
`CHANGES REQUIRED (0/1/1)` in the immutable re-review document.

The Round-1 next action was D8.4 Independent Planning Re-review. No D8.4
implementation, schema migration or runtime change was authorized by that
remediation.

## 7. Planning Remediation Round 2 — P1-2 / P2-3

### 7.1 Scope and authority

Round 2 is a separate docs-only remediation of exactly the two findings left
open by the independent re-review. It does not reopen the six findings already
closed by that re-review and it does not edit either independent review record.

| Evidence | Value |
| --- | --- |
| Starting HEAD | `1be58a317c121a5fd676cd709174de7fbb6b72b7` |
| Starting parent | `4c90b46c1bdb37626530fc63529bf3903a6f151d` |
| Branch / `github/main` | `main` / `1be58a317c121a5fd676cd709174de7fbb6b72b7` |
| Starting working tree | clean |
| Review authority | `1be58a317c121a5fd676cd709174de7fbb6b72b7` |
| Review verdict | `D8.4 Independent Planning Re-review = CHANGES REQUIRED (0/1/1)` |
| Round-2 scope | `D8.4-IPR-P1-2` and `D8.4-IPR-P2-3` only |

The immutable lineage is `cbd5424 -> 9f8d06d -> 9ae4492 -> 4c90b46c ->
1be58a3 -> Round-2 remediation`. No D8.4 runtime implementation, test,
schema, migration, dependency or CI change is authorized.

### 7.2 D8.4-IPR-P1-2 — exact-source ownership and restart authority

**Defect closed by planning remediation.** Round 1 named a future native
helper but left the implementation free to choose a pathname check/use pair
and did not define how a process regains authority after a crash destroys the
live token. That left the exact source generation and quarantine reuse race
open.

**Four non-interchangeable authorities.** Logical identity
(`vaultId`/`documentId`/canonical path/schema) selects an item only. Filesystem
generation identity (device/volume, inode/file ID, parent identity and
available birth/generation provenance) is evidence only. Live mutation
authority is an open source/parent/quarantine handle pair consumed by one
native conditional operation. Restart recovery authority is durable
non-secret provenance plus a fresh native exact-reacquisition proof. A
pathname, prior `lstat`, prior handle comparison, process-local token or
directory lock never grants destructive authority alone.

**Exact source operation.** Both authority documents now freeze
`transitionOwnedSource(capturedSourceAuthority, expectedParentAuthority,
reservedQuarantineName)`. The native operation itself atomically compares the
source directory entry with the captured file generation, compares the parent
with the expected parent generation, requires an absent reserved destination,
rebinds the same existing inode/file object without copy/delete or overwrite,
and returns the exact quarantine generation plus parent provenance. A failed
comparison performs no namespace mutation. `removeOwnedQuarantineGeneration`
uses the same captured-handle conditional comparison at unlink time. Ciphertext
publication remains an independent atomic create-only proof.

**Platform contracts.** Linux resolves with `openat2` beneath the vault and
`RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS`, captures `O_PATH|O_NOFOLLOW` plus
`statx`/native file-handle generation, and requires the named native
conditional rename-by-handle ABI; `renameat2(RENAME_NOREPLACE)` is publication
only, and `open_by_handle_at` is reacquisition evidence only. macOS resolves
parent/source with `openat` and `O_NOFOLLOW`, captures vnode/file identity and
requires the named native vnode-handle conditional rename; `renameatx_np`
`RENAME_EXCL` is publication only. Windows opens source/parent with
reparse-safe `CreateFileW`, omits `FILE_SHARE_DELETE`, captures volume/file ID,
and uses `SetFileInformationByHandle(FileRenameInfoEx)` on the captured source
handle with the expected parent `RootDirectory` and fail-if-exists semantics.
Its publication is independently fail-if-exists. A filesystem without the
required exact operation is unsupported before mutation; no weaker pathname
operation is allowed.

Stable native results are frozen: post-compare `ESTALE`/`ENOENT` (Linux),
`ENOENT`/`ESTALE` (macOS) and `ERROR_FILE_NOT_FOUND`/`ERROR_PATH_NOT_FOUND`
(Windows) mean an external generation won; `EEXIST`/`ENOTEMPTY` and
`ERROR_FILE_EXISTS`/`ERROR_ALREADY_EXISTS` mean destination occupied;
`EXDEV`/`ERROR_NOT_SAME_DEVICE` means cross-device; `EBUSY`/`EAGAIN`/
`EWOULDBLOCK` and Windows sharing/lock violations mean retryable source busy;
missing required APIs/flags map to `FILESYSTEM_UNSUPPORTED`. File and
parent-directory durability failure or uncertainty maps to
`DURABILITY_FAILED`/`DURABILITY_UNKNOWN` and never to `PUBLISHED`.

**Durable provenance and restart.** Before transition, the journal durably
records the inventory revision, logical identity, transaction/schema, expected
parent generation, captured source generation, reserved name and phase. After
the native transition and parent barrier, it records the returned quarantine
and parent generations. Only structural non-secret values are allowed; body,
byte size, hash/digest, keys, capabilities and message content are forbidden.
The restart state machine is:

```text
owned live source
  -> source transitioned to quarantine
  -> live token lost by crash
  -> structural recovery
  -> exact native quarantine reacquisition
       -> REACQUIRED_EXACT_QUARANTINE
       -> QUARANTINE_OWNERSHIP_UNPROVEN -> NEEDS_ATTENTION
```

`REACQUIRED_EXACT_QUARANTINE` requires a fresh no-symlink/no-reparse native
open of the expected parent and reserved name, an exact generation/parent
comparison and a new handle-bound token. Missing provenance, a missing path,
parent replacement, same-name different generation or unavailable native
reacquisition is `QUARANTINE_OWNERSHIP_UNPROVEN`/`NEEDS_ATTENTION`; there is
no path-only or “probably ours” state. Pre-publication restore additionally
requires a durably pre-publication journal and an empty canonical destination;
post-publication cleanup uses the same proof. A replacement quarantine is
never deleted and a disappeared quarantine is never recreated as plaintext.

**Adversarial proof categories and required outcomes.** Source replacement at
or after capture, parent replacement, junction/reparse, quarantine occupancy
or reuse, target appearance, cross-device operation, unsupported exact-source
or no-replace operation, Windows sharing/antivirus denial, case-fold collision,
directory durability failure, live-token loss and failed restart reacquisition
all fail closed, preserve the external/unknown generation, and require a new
revision or `NEEDS_ATTENTION`. Only a native exact-generation proof can permit
the corresponding transition; no row is implementation-defined.

**Status.** `D8.4-IPR-P1-2 = PLANNING REMEDIATED / pending independent
re-review`; it is not `CLOSED` here.

### 7.3 D8.4-IPR-P2-3 — deterministic unlink/durability and AI oracles

**Defect closed by planning remediation.** Round 1 had a real child-process
hook framework but collapsed quarantine unlink with parent-directory durability
and did not map AI whole-session deletion to an exact named seam.

**Authoritative hook set.** PRD and Implementation Plan now contain the same
exact **19-hook** set:

```text
authoritative hook count = 19
PRD hook count = 19
Implementation Plan hook count = 19
```

```text
AFTER_JOURNAL_PREPARED
AFTER_CIPHERTEXT_TEMP_FSYNC
BEFORE_SOURCE_TRANSITION
AFTER_SOURCE_TRANSITION
BEFORE_CIPHERTEXT_PUBLISH
AFTER_CIPHERTEXT_PUBLISH_SYSCALL
AFTER_TARGET_DURABILITY
AFTER_AUTHENTICATED_READBACK
BEFORE_PUBLISHED_JOURNAL
AFTER_PUBLISHED_JOURNAL
BEFORE_SQLITE_CLEANUP_COMMIT
AFTER_SQLITE_CLEANUP_COMMIT
BEFORE_IDB_DISPOSITION_COMMIT
AFTER_IDB_DISPOSITION_COMMIT
BEFORE_SOURCE_QUARANTINE_UNLINK
AFTER_SOURCE_QUARANTINE_UNLINK_BEFORE_DIR_DURABILITY
AFTER_SOURCE_QUARANTINE_DIR_DURABILITY
BEFORE_ITEM_COMPLETE
AFTER_ITEM_COMPLETE
```

**Quarantine oracle.** `BEFORE_SOURCE_QUARANTINE_UNLINK` means the exact
quarantine entry still exists and only the native token-bound unlink may be
attempted. `AFTER_SOURCE_QUARANTINE_UNLINK_BEFORE_DIR_DURABILITY` means the
unlink syscall returned but the parent barrier did not; the ledger records
unlink complete and durability unknown. Restart inspects actual namespace,
never recreates plaintext, fsyncs an absent parent entry, and retries only an
exact-reacquired same generation if it remains. A different generation is
external and preserved. `AFTER_SOURCE_QUARANTINE_DIR_DURABILITY` means unlink
and the parent barrier are committed; absence is forward-only and cleanup never
requires plaintext quarantine. Each boundary has explicit filesystem, ledger,
locked/unlocked restart, forbidden-action and idempotent-rerun expectations in
both authority documents.

**AI oracle.** `DISCARD_AI_SESSION` uses
`BEFORE_SQLITE_CLEANUP_COMMIT`/`AFTER_SQLITE_CLEANUP_COMMIT` with
`operationClass=DISCARD_AI_SESSION`. Before commit, the exact session row and
all inventoried message rows exist unchanged, the transaction rolls back on
kill, the item remains `CLEANUP_PENDING`, and the same action is retryable only
for the same inventory revision, session row generation and message-ID set.
After commit, the session and all inventoried messages are absent while the
migration ledger may lag; restart records the already-completed whole-session
disposition without recreation. A replacement/new row at the same numeric ID
is a changed generation, requires new consent and is never deleted by the old
action. No substring surgery is allowed; `RETAIN_AI_HISTORY` is explicit
non-destructive policy retention and has no destructive hook.

The child process signals the parent only after the selected seam; the parent
terminates it without graceful cleanup and a fresh process observes the same
isolated state. Sleep, `waitForTimeout`, random timing and retry-until-crash
are forbidden.

**Status.** `D8.4-IPR-P2-3 = PLANNING REMEDIATED / pending independent
re-review`; it is not `CLOSED` here.

### 7.4 Closed-finding and lifecycle regression

Round 2 preserves the six previously closed findings:

```text
D8.4-IPR-P1-1 RECOVERY_AUTH_REQUIRED              = CLOSED
D8.4-IPR-P1-3 immutable inventory consent         = CLOSED
D8.4-IPR-P1-4 AI whole-session/retain policy      = CLOSED
D8.4-IPR-P1-5 NULL frontmatter identity           = CLOSED
D8.4-IPR-P2-1 no durable body size/hash            = CLOSED
D8.4-IPR-P2-2 FIFO ordinary PUT behavior          = CLOSED
```

It also preserves D8.0–D8.3 ownership: the server-side Diary access service
remains the sole live DEK owner; no new key/session/body owner, managed-Diary
History/Draft/Search/LinkIndex bypass, generic encrypted delete/rename, or
ordinary Note semantic change is introduced.

### 7.5 Round-2 self-review

```text
Can an implementer choose between two security-sensitive source primitives? NO
Can restart delete/restore by path or matching metadata alone? NO
Can a crash occur after unlink but before directory durability without a named oracle? NO
Can AI whole-session deletion commit without an exact named crash seam? NO
```

Both P1-2 and P2-3 therefore remain `PLANNING REMEDIATED` pending the next
independent re-review, not closed by this evidence.

### 7.6 Next gate

After this remediation commit and its exact-head CI are green, request
**D8.4 Independent Planning Re-review Round 2**. Only that reviewer may close
P1-2/P2-3 and approve planning. D8.4 implementation remains
`BLOCKED / NOT STARTED`.

## 8. Planning Remediation Round 3 — P1-2 only

### 8.1 Scope, authority and provenance

Round 3 is a separate docs-only remediation of exactly
`D8.4-IPR-P1-2`. It replaces the impossible POSIX exact-source mutation
contract with a platform-real product protocol. It does not reopen
`D8.4-IPR-P2-3` or any of the seven findings already closed by the Round-2
re-review, and it does not edit the immutable Round-2 re-review record.

| Evidence | Value |
| --- | --- |
| Starting HEAD | `cf661cd` (`docs(diary): record D8.4 Independent Planning Re-review Round 2`) |
| Starting parent | `250aeec` (Round-2 planning remediation) |
| Branch / tracking state | `main` / local `github/main` at `cf661cd` before remediation |
| Starting working tree | clean |
| Round-2 review authority | `docs/design/diary-encryption-d8.4-independent-planning-rereview-round2.md`, committed at `cf661cd` |
| Round-2 verdict | `CHANGES REQUIRED (0/1/0)`; `D8.4-IPR-P1-2 = OPEN`; `D8.4-IPR-P2-3 = CLOSED` |
| Round-3 scope | `D8.4-IPR-P1-2` only |

The required lineage is preserved:

```text
cbd5424 -> 9f8d06d -> 9ae4492 -> 4c90b46 -> 1be58a3
  -> 250aeec -> cf661cd (Round-2 re-review, CHANGES REQUIRED 0/1/0)
  -> <Round-3 remediation>
```

### 8.2 P1-2 root cause and decision

Round 2 described ideal Linux/macOS source-transition and quarantine-unlink
semantics under historical names that do not map to stock public kernel/API
operations. Linux `renameat2` and `unlinkat` select a source by directory fd
plus pathname; `openat2`/`statx` improve safe resolution and observation but do
not make a later pathname mutation conditional on a captured file handle.
`open_by_handle_at` can reopen an object on some filesystems with privilege,
but does not rename or unlink that object by handle. macOS `renameatx_np` also
selects the source by parent fd plus pathname; public file-handle reopening does
not provide the required captured-vnode conditional rename/unlink. A wrapper
cannot manufacture missing kernel atomicity.

The frozen Round-3 product decision is therefore:

```text
Windows supported handle/reparse/sharing/durability contract
    -> AUTOMATIC_HANDLE_BOUND
Linux/macOS supported stock filesystem
    -> USER_FINALIZE_REQUIRED
Candidate durability/authentication unavailable
    -> UNSUPPORTED
Windows guarantee lost at runtime
    -> USER_FINALIZE_REQUIRED (never pathname fallback)
```

The public source record is linked from the current PRD/Plan: Linux
[`renameat2(2)`](https://man7.org/linux/man-pages/man2/renameat2.2.html),
[`openat2(2)`](https://man7.org/linux/man-pages/man2/openat2.2.html),
[`open_by_handle_at(2)`](https://man7.org/linux/man-pages/man2/open_by_handle_at.2.html)
and [`unlinkat(2)`](https://man7.org/linux/man-pages/man2/unlink.2.html);
macOS [`rename`](https://man.freebsd.org/cgi/man.cgi?manpath=macOS+26.6.1&query=rename&sektion=2),
[`getfh(2)`](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/getfh.2.html)
and [`fhopen(2)`](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fhopen.2.html);
and Windows
[`SetFileInformationByHandle`](https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle),
[`FILE_RENAME_INFO`](https://learn.microsoft.com/windows/win32/api/winbase/ns-winbase-file_rename_info),
[`FILE_ID_INFO`](https://learn.microsoft.com/windows/win32/api/winbase/ns-winbase-file_id_info)
and [`OpenFileById`](https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-openfilebyid).

### 8.3 Linux/macOS candidate and handoff contract

The exact POSIX transaction is inventory -> encrypted candidate preparation ->
user handoff. Nuvyn canonicalizes and structurally captures the reviewed
source generation, obtains the existing Diary body lease, encrypts and
authenticates in memory, creates one same-filesystem ciphertext-only candidate
named `.nuvyn-diary-migration-ciphertext-<transactionId>`, fsyncs the candidate
and required parent directory, records only structural provenance/internal
ciphertext fingerprint, and revalidates the source generation. A changed
generation is `CONSENT_REQUIRED`; the old preparation never authorizes it.

After successful preparation the item is exactly
`USER_FINALIZE_REQUIRED` with stable API code
`diary-migration-user-finalize-required` (HTTP 409). This state is not
`PUBLISHED`, `CLEANUP_PENDING` or `COMPLETE`. The legacy canonical plaintext
remains authoritative. Search, AI, History, LinkIndex, locked body display and
automatic save remain blocked for the managed item; resume requiring body
verification requires unlock. The candidate is excluded from tree/search/
LinkIndex/History/Note parsing and may safely remain across restart.

The UI instructs the user to stop Nuvyn body mutation, close external editors
and sync writers, replace the canonical file with the prepared candidate using
the documented OS file operation, disclose any retained plaintext copy, and
reopen/resume verification. Users handle filenames/files only; Nuvyn never
asks for decrypting, re-encrypting, envelope editing, body copying or a Nuvyn
shell command. Nuvyn does not add an endpoint that runs `mv`, `rename` or `rm`.

### 8.4 Verification, conflicts and residuals

`POST /api/diary/migration/resume` never performs the POSIX replacement. It
checks canonical regular/non-symlink/non-reparse path, exact prepared
ciphertext fingerprint, vault/document/path identity, V1/AES-GCM/AAD
authentication under the existing body lease and required durability. A new
inode after user replacement is expected; same-inode continuity is not
required. The exact classifications are:

| Observed state | Result |
| --- | --- |
| Reviewed plaintext remains | `USER_FINALIZE_REQUIRED` / `diary-migration-user-finalize-required` |
| New plaintext generation before acceptance | `CONSENT_REQUIRED` / `diary-migration-consent-required`; invalidate old preparation |
| Exact candidate fingerprint + authenticated identity | `PUBLISHED`, then forward cleanup |
| Different valid encrypted bytes | `NEEDS_ATTENTION` / `diary-migration-candidate-mismatch` |
| Malformed/unknown envelope | `NEEDS_ATTENTION` / existing malformed/unknown code |
| Missing canonical | `NEEDS_ATTENTION` / `diary-migration-primary-missing` |
| Symlink/reparse/unsafe type or wrong identity | `NEEDS_ATTENTION` / `diary-migration-unsafe-path` |

The user-mediated operation is an explicit external trust boundary. If a user
installs a stale candidate after an unobserved writer created another
plaintext generation, Nuvyn can authenticate only the bytes now present; it
cannot reconstruct lost bytes or prove that external generation was untouched.
Any moved/copied plaintext backup outside the canonical managed path is
`USER_CONTROLLED_PLAINTEXT_RESIDUAL`: it is disclosed, never claimed erased,
and never searched for or deleted automatically. The no-new-plaintext
invariant remains strict: Nuvyn itself creates no second durable plaintext
body copy, plaintext rollback payload or plaintext quarantine.

### 8.5 Restart and crash semantics

POSIX restart has no plaintext quarantine or process-local ownership token to
reacquire. Before candidate durability, the legacy primary remains
authoritative and only exact transaction-owned ciphertext cleanup may remove a
partial candidate. After candidate durability, crash/restart restores
`USER_FINALIZE_REQUIRED` with candidate and plaintext retained. After an
external user finalize, crash/restart inspects actual canonical state and does
not assume the user operation occurred. Exact candidate/authentication may
advance to `PUBLISHED`; unchanged plaintext remains pending and all other
states use the exact conflict/attention table above. No plaintext is restored,
recreated, overwritten or automatically deleted.

Windows retains the reviewed automatic handle-bound transition, fail-if-exists
publication, reparse/sharing rules, durability and restart proof. If its
guarantee is unavailable, it selects `USER_FINALIZE_REQUIRED` rather than a
weaker pathname operation.

P2-3 remains closed. The exact 19-hook set remains authoritative for automatic
Windows finalize and platform-independent SQLite/IDB cleanup. On POSIX,
candidate preparation uses the applicable journal/candidate-durability hooks;
post-user verification uses readback/journal/cleanup hooks. Source-transition,
ciphertext-publication and plaintext-quarantine hooks are explicitly not
applicable and are never simulated around the user action. The deterministic
test controller performs the documented external operation, then kills the
child before `resume`; no fake user-action seam, sleep or timing retry is
evidence.

### 8.6 Closed-finding regression and self-review

The seven previously closed findings remain closed:

```text
D8.4-IPR-P1-1  RECOVERY_AUTH_REQUIRED / no structural auth       = CLOSED
D8.4-IPR-P1-3  immutable inventory revision/action consent       = CLOSED
D8.4-IPR-P1-4  AI whole-session discard/retain policy            = CLOSED
D8.4-IPR-P1-5  NULL frontmatter identity unresolved              = CLOSED
D8.4-IPR-P2-1  no durable body size/hash/digest                  = CLOSED
D8.4-IPR-P2-2  FIFO ordinary PUT wait + revalidation             = CLOSED
D8.4-IPR-P2-3  deterministic 19-hook crash oracle                = CLOSED
```

Round-3 self-review answers:

```text
Does Linux automatic migration require a fictional exact-source rename? NO
Does macOS automatic migration require a fictional exact-source rename? NO
Can Nuvyn automatically mutate/delete an unproven POSIX plaintext generation? NO
Can USER_FINALIZE_REQUIRED be mistaken for PUBLISHED/COMPLETE? NO
Does a stale candidate automatically authorize a changed source? NO
Does Windows retain only real handle-bound primitives? YES
Does Nuvyn create a second durable plaintext copy? NO
Are user-controlled residuals disclosed accurately? YES
```

### 8.7 Round-3 status and next gate

```text
D8.4-IPR-P1-2 = PLANNING REMEDIATED
D8.4-IPR-P2-3 = CLOSED [historical Round-2 re-review]
Round-3 remediation = COMPLETE after this docs-only commit and exact-head CI
D8.4 Independent Planning Re-review Round 3 = PENDING
D8.4 Planning = NOT APPROVED
D8.4 implementation = BLOCKED / NOT STARTED
D8.4 = NOT REVIEW-CLOSED
```

Only the independent Planning Re-review Round 3 may close P1-2 and approve
planning. No production/runtime/test/schema/dependency/CI change is authorized
by Round 3.
