# D8.4 Migration, Legacy Cleanup & Release Closure — Implementation Plan

> **Historical lineage — not current runtime authority.** Current behavior is
> defined by [Diary Architecture](../architecture/diary.md) and [Diary User
> Guide](../user-guide/diary.md). This file is retained for D8 review
> traceability.

Status: `REVIEW-READY`; D8.4 Independent Planning Review:
`CHANGES REQUIRED (0/5/3)` [historical]; D8.4 Planning Remediation Round 1:
`COMPLETE`; D8.4 Independent Planning Re-review:
`CHANGES REQUIRED (0/1/1)` [historical]; D8.4 Planning Remediation Round 2:
`COMPLETE`; D8.4 Independent Planning Re-review Round 2:
`CHANGES REQUIRED (0/1/0)` [historical]; D8.4 Planning Remediation Round 3:
`COMPLETE`; D8.4 Independent Planning Re-review Round 3: `PENDING`;
implementation: `IMPLEMENTED / COMPLETE / FROZEN` under the owner-authorized
fast-closure run. The pending review remains historical process state; it is
not a claim of an Independent Review PASS. This plan records the frozen
technical authority and its implementation evidence.

## 1. Status / lifecycle

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
D8.4 implementation = IMPLEMENTED / COMPLETE / FROZEN (owner override)
D8.4 = IMPLEMENTED / COMPLETE / FROZEN (review closure not asserted)
```

### Fast-closure implementation authorization

For the 2026-09-01 implementation pass, the repository owner explicitly waived
the process-only `D8.4 Independent Planning Re-review Round 3` gate. This is
recorded as `OWNER-OVERRIDE / IMPLEMENTATION AUTHORIZED`; it does not weaken
the security contract, erase historical review findings, or fabricate a
review verdict. See `diary-encryption-d8.4-implementation-evidence.md` for
the implementation and validation record.

The future sequence is Planning Independent Review -> any docs-only
remediation/re-review -> `APPROVED` ->
implementation -> self-review -> implementation Independent Review -> any
remediation/re-review -> docs-only closure -> `D8.4 REVIEW-CLOSED`. Planning
approval and implementation are separate events.

## 2. Baseline / provenance

The original planning gate was verified before drafting:

```text
HEAD:        c88e99554c291181c6e3f17e695aa228f34d40b2
branch:      main
github/main: c88e99554c291181c6e3f17e695aa228f34d40b2
status:      clean
closure CI:  #597 / run 33391810588 / attempt 1 / 8 of 8 PASS
```

The closure run's exact head is `c88e99554c291181c6e3f17e695aa228f34d40b2`.
The original D8.4 planning commit was
`cbd5424ebe82737604b621a1be58f1c1b965e5f0`; its Independent Planning Review
commit is `9f8d06d1f0dd2223dfc2ccc3d313f4a30053c386` with historical verdict
`CHANGES REQUIRED (0/5/3)`. This remediation changes planning documents only;
the historical review remains immutable and the next gate is an Independent
Planning Re-review.
The D8.3 lineage remains in the canonical lifecycle document: planning
`99f693b02080127c16911869c17edcb2fa38fe3c`, implementation
`584cf770111bc2f5ee86be08ecda7ea50586bc87`, final implementation checkpoint
`6308947cd6fd758cd6055a687a1d4e49891a5e2c`, remediation
`b49b51d5a56608479f0b46086eef739d77308d20`, re-review
`1a8ef24ce32a7f7185ef8de25897680ca6b17c20`, and closure `c88e995...`.

This plan was written after reading the D8.0-D8.3 authority chain and source
owners in the actual checkout. No reset, checkout, schema/data mutation or
production change is part of Planning.

## 3. Current owner inventory

| Concern | Current owner / evidence | D8.4 implementation boundary |
| --- | --- | --- |
| Diary path identity | `shared/diaryProtocol.ts`: `parseDiaryDate`, `diaryDateFromPath`, `isManagedDiaryPath`, `classifyDiaryPath` | Normalize extensionless logical path first; reject invalid, absolute, dot-segment, case-variant, symlink and nested look-alikes. |
| Primary read/create/save | `server/routes/diary.ts`, `server/routes/posts.ts` (`saveManagedDiary`), `server/diaryAccess/guard.ts` | Migration service is the only legacy body reader; normal D8.2 routes keep their owner and are blocked per document while migration runs. |
| Diary access/encryption | `server/diaryAccess/service.ts` (`DiaryAccessService`, `withBodyOperation`), `server/diaryAccess/body.ts` | Reuse the existing lease-local `encrypt`/`decrypt`; no raw DEK or new capability owner. |
| Vault identity | `server/vaultIdentity.ts:getVaultId()` | Stable vault tuple component; copying a vault changes identity and invalidates old ledger proof. |
| Atomic durability / migration filesystem | `server/atomicTextWrite.ts` is the existing Note owner; future `DiaryMigrationFs` is the sole D8.4 migration filesystem owner | Do not use the generic plaintext replace path for migration. `DiaryMigrationFs` prepares and authenticates one ciphertext-only candidate on every supported platform. Windows may use the reviewed captured-handle automatic finalize; Linux/macOS select `USER_FINALIZE_REQUIRED` because stock public APIs do not provide captured-source conditional plaintext namespace mutation. Candidate publication is create-only with explicit durability/unsupported results. |
| Crash recovery | `server/crashRecovery.ts:recoverInterruptedOperations`, called by `server/prod.ts` and `server/vite-plugin.ts` before HTTP | Extend startup with `DiaryMigrationService.recover`; generic Note recovery remains unchanged. |
| Document metadata | `server/documentMetadata.ts` (`createDocumentMetadata`, `getDocumentMetadata`, snapshots/restore) | Preserve stable id/path/timestamps/Mood; minimal adoption row is created only by explicit action. |
| SQLite connection/migrations | `server/db.ts`, migrations 0001-0011 (including `0001_ai_history.sql`) | Future migration 0012 adds only the structural D8.4 ledger and AI/frontmatter consent provenance; cleanup is one `BEGIN IMMEDIATE` transaction. |
| Frontmatter archive | `server/metadataMigration.ts`, `server/frontmatterArchive.ts` | Managed rows are skipped by generic owner and cleaned only by D8.4 identity-checked transaction. |
| IndexedDB Draft/Recovery | `draftStore.ts` (DB `nuvyn-draft-recovery`, v2), `useUnsavedDraftPersistence.ts`, `useUnsavedDraftRecovery.ts`, `useDraftRecoveryManagement.ts` | Inventory legacy rows; import through encrypted primary or typed-discard; no encrypted Draft Store V2. |
| AI history | `server/migrations/0001_ai_history.sql`, `server/ai/messages.ts`, `server/ai/chat.ts`, `server/ai/tools.ts` | Inventory sessions/messages and structured managed-Diary `read_file` results; require unlock for content classification; whole-session explicit discard or policy retention; no free-text or substring surgery. |
| Search | `src/lib/search.ts` (`bodyCache`, `primeBody`, epoch), `src/lib/searchResults.ts` | Verify no managed body cache; keep D8.3 structural-only behavior. |
| LinkIndex | `server/linkIndex.ts`, client `useLinkIndex` | Structural path/existence only; no migration body parsing or new managed links. |
| History/Git | `server/history/git.ts:addAndCommit`, `server/history/routes.ts`, `server/history/restore.ts` | Read-only legacy inventory; no rewrite, prune, ref mutation or force-push. |
| UI/session teardown | `useDiaryAccessSession`, `createVaultContext`, VaultView and epoch seams | Fence migration callbacks and clear managed memory on lock; no second epoch/session authority. |
| Consent/inventory authority | Future `DiaryMigrationService` plus the D8.4 ledger/API/UI | Immutable `inventoryRevision` snapshots and action-scoped consents are reconstructed and checked server-side; client tokens never authorize a later generation. |

## 4. Architectural decisions

The following 23 decisions are frozen. “Rejected alternative” is historical
context, not an implementation choice left open.

| # | Decision | Chosen contract and owner |
| ---: | --- | --- |
| 1 | Migration trigger / UX | Explicit Settings/post-upgrade **Diary Migration & Legacy Cleanup** workflow. Scan is explicit and structural; migration never runs on open/read/save/search/startup. Scan creates an immutable `inventoryRevision`; the user grants independent, revision-bound action scopes for primary migration/removal, private SQLite/AI/frontmatter work, Draft actions and Git/AI retention. |
| 2 | Orchestrator owner | New server-side `DiaryMigrationService` under `server/diaryMigration/`, called by dedicated routes and startup recovery; it composes existing owners and makes all migration decisions. |
| 3 | State machine | Item states include `DISCOVERED`, `NEEDS_UNLOCK`, `READY`, `PREPARING`, `ENCRYPTED_VERIFIED`, `USER_FINALIZE_REQUIRED`, `RECOVERY_AUTH_REQUIRED`, `DURABILITY_PENDING`, `CONSENT_REQUIRED`, `PUBLISHED`, `CLEANUP_PENDING`, `COMPLETE`, `NEEDS_ATTENTION`; aggregate states remain `NOT_STARTED`, `INVENTORIED`, `NEEDS_UNLOCK`, `RUNNING`, `ATTENTION_REQUIRED`, `COMPLETE`, `FAILED`. `USER_FINALIZE_REQUIRED` is a real non-terminal pending state and is never `PUBLISHED`/`COMPLETE`; a syntactic V1 target is never `PUBLISHED`; policy-retained AI history is separately recorded. |
| 4 | Ledger storage/schema | Future SQLite migration `0012` adds `diary_migration_runs`, `diary_migration_items` and action-scoped consent/provenance records with structural fields only: immutable `inventoryRevision`, reviewed generation, action scope, exact ciphertext fingerprint, AI session identity and frontmatter binding CAS; no plaintext/body size. Exact proposal is §6. |
| 5 | Stable idempotency identity | Resolved item key is `(vaultId, documentId, canonicalLogicalPath, migrationSchemaVersion=1)`. Unresolved path inventory rows cannot authorize mutation and are replaced by the resolved tuple after `adopt-metadata`. |
| 6 | Plaintext primary protocol | `DiaryMigrationFs` is the sole migration filesystem owner: inventory and authenticate in memory, write a ciphertext-only same-filesystem candidate with create-only publication and durability proof, then select immutable `AUTOMATIC_HANDLE_BOUND`, `USER_FINALIZE_REQUIRED` or `UNSUPPORTED`. Only Windows with the reviewed handle contract may automatically mutate the plaintext namespace; Linux/macOS stop before that boundary. Generic pathname rename/copy/delete and weaker fallback are forbidden. |
| 7 | Durable commit point | Windows automatic security linearization is the moment ciphertext publication may have succeeded; POSIX candidate durability is only a safe handoff checkpoint and leaves legacy plaintext authoritative. `PUBLISHED` requires exact candidate/target fingerprint, AES-GCM/AAD authenticated readback with the unlocked body lease and required file/directory durability. Locked uncertainty is `RECOVERY_AUTH_REQUIRED` on Windows and `USER_FINALIZE_REQUIRED` on POSIX, never `PUBLISHED`. |
| 8 | Monotonic rollback | Windows automatic finalize is forward-only after its ciphertext publication syscall may have succeeded. Linux/macOS have no Nuvyn plaintext rollback or namespace mutation: before user finalize, the legacy canonical remains authoritative; after external user action, Nuvyn verifies actual bytes and never reconstructs or overwrites an external generation. |
| 9 | No-new-plaintext artifacts | Migration temp, candidate, journal and ledger contain ciphertext or structural state only. Linux/macOS create no Nuvyn plaintext quarantine or backup; Windows may transiently own only the pre-existing source object through its handle-bound operation. A candidate/path or matching metadata never authorizes deletion. |
| 10 | Missing metadata | Canonical path/date is validated first. The item waits for explicit `adopt-metadata`; `DocumentMetadata` creates a UUID row with date title, empty summary/tags and null Mood without parsing body. Ambiguous/stale identity and null-ID frontmatter ownership are attention; adoption never binds a backup by path alone. |
| 11 | Malformed/unknown envelope | Magic-present malformed, auth failure, unknown version, wrong vault/id/path are never plaintext. Preserve bytes, return stable non-secret code, classify `NEEDS_ATTENTION`, and do not overwrite. |
| 12 | External-writer races | Nuvyn-controlled actions never delete/overwrite an unproven generation. Windows automatic operations use the reviewed handle-bound contract; Linux/macOS stop before destructive plaintext mutation and surface `USER_FINALIZE_REQUIRED`. Candidate/source generation changes, unsafe paths, cross-device and durability failures retain artifacts and require a new revision or attention. |
| 13 | Legacy Draft/Recovery | Locked structural inventory only. After unlock, each valid family has exactly `import-to-primary` or typed `discard-draft`, each bound to an immutable inventory revision/generation and action scope; ambiguous/changed families remain attention. No silent delete. |
| 14 | Encrypted Draft Store V2 | Out. D8.4 only disposes/migrates legacy rows; new managed persistent Draft/Recovery stays disabled. |
| 15 | Private SQLite metadata | Preserve structural identity/timestamps/Mood; normalize title to date; clear summary, managed tags/embeddings and proven managed history raw/payload rows after encrypted publication and action-scoped confirmation. Inventory `0001` AI sessions/messages; provable managed-Diary tool results get explicit whole-session discard or policy retention/attention. Mixed ownership remains attention. |
| 16 | `frontmatter_backup` | A `NULL document_id` is `FRONTMATTER_IDENTITY_UNRESOLVED` and retained. Optional explicit `BIND_FRONTMATTER_IDENTITY` may set a non-null ID only after exact row/generation/CAS proof and never clears backup; cleanup then requires non-null identity, `PUBLISHED`, no rollback dependency and the same CAS. Note rows are untouched. |
| 17 | Git history | Disclose and retain. Inventory all local ref/object exposure classes read-only; do not rewrite or purge. Completion wording never claims historical purge. |
| 18 | Git remote policy | Automatic remote mutation and force-push are forbidden. Remote repositories, clones and remote-tracking objects are residual exposure. |
| 19 | Partial/attention semantics | Per-document atomic transactions with vault aggregate and immutable `inventoryRevision`. Independent consents are `MIGRATE_PRIMARY`, `REMOVE_VERIFIED_LEGACY_PRIMARY`, `CLEAN_PRIVATE_SQLITE`, `IMPORT_DRAFT`, `DISCARD_DRAFT`, `DISCARD_AI_SESSION`, `RETAIN_AI_HISTORY`, `BIND_FRONTMATTER_IDENTITY` and `ACKNOWLEDGE_GIT_RETENTION`; new/changed rows are `CONSENT_REQUIRED`. Any unacknowledged attention yields `ATTENTION_REQUIRED`; acknowledged attention remains visible. |
| 20 | Completion guarantee | Every supported Nuvyn-controlled current private store, including AI sessions/messages and frontmatter null rows, is explicitly resolved/cleaned, valid-encrypted no-op, policy-retained private state, `USER_FINALIZE_REQUIRED` or `NEEDS_ATTENTION`; no new durable plaintext body copy is created; valid V1 bytes are unchanged. A verified POSIX finalize may complete while a disclosed `USER_CONTROLLED_PLAINTEXT_RESIDUAL` remains; Git and external residuals are reported separately. |
| 21 | Residual risk | Legacy Git, remote/external backups, exports, clipboard history, browser copies, unlocked process memory and forensic erase remain outside the guarantee and are disclosed. |
| 22 | Release gate | §20 exact gate: ciphertext preparation and platform capability selection, POSIX `USER_FINALIZE_REQUIRED` restart/conflict/verification, Windows automatic handle-bound migration, deferred-auth recovery, no-new-plaintext/no-body-size, malformed fail-closed, action-scoped consent, AI/frontmatter disposition, crash/idempotency using the exact hook oracle, Note regression, cross-platform, full CI, evidence, residual disclosure and review lineage all pass. |
| 23 | Overall closure | After implementation evidence and Independent Review/re-review, create a separate docs-only closure commit setting `D8.4 = REVIEW-CLOSED`; only then set overall `D8 Diary Encryption = REVIEW-CLOSED` in the canonical lifecycle. |

### 4.1 Decision records

Each decision has the same security owner: `DiaryMigrationService` delegates
cryptographic work to `DiaryAccessService`, filesystem ownership to existing
safe-path/lock primitives, metadata to `DocumentMetadata`, and client storage
to the existing DraftStore. Rejected alternatives were automatic lazy
migration, a second client key owner, generic plaintext atomic replace, an
encrypted Draft Store V2, automatic Git rewrite and remote force-push. None is
implemented by this plan.

## 5. Migration state machine

### 5.1 Item transitions

| From -> to | Preconditions / durable write | Access and locks | Crash/retry / UI |
| --- | --- | --- | --- |
| `DISCOVERED -> NEEDS_UNLOCK` | Legacy body or body-bearing auxiliary requires unlock; ledger records class/code only | No body read | Locked banner; resume after unlock. |
| `DISCOVERED -> CONSENT_REQUIRED` | Item is new/changed relative to immutable reviewed `inventoryRevision` | Structural probe only | No action until a new revision/scope is reviewed. |
| `DISCOVERED -> READY` | Canonical path, stable identity, current revision and generation proven; no body mutation | Structural locks for probe only | Retry re-probes generation and consent. |
| `DISCOVERED -> COMPLETE` | Valid encrypted no-op after authenticated verification | No body exposure for no-op; missing primary remains attention | Idempotent status. |
| `READY -> PREPARING` | Revision-bound action consent, lease and all locks acquired; journal created | Vault mutation -> structure -> document -> body lease | Crash before the platform finalize boundary leaves the canonical source unchanged; retry candidate preparation. |
| `PREPARING -> ENCRYPTED_VERIFIED` | Ciphertext temp durable and decrypt/readback matches transient plaintext | Body lease remains current | Temp/journal replayable; no body in durable state. |
| `ENCRYPTED_VERIFIED -> PUBLISHING` | Windows capability is `AUTOMATIC_HANDLE_BOUND` and the captured source/parent handle contract is available | Same locks and live native authorities | Unsupported/identity mismatch/occupied destination stops before publication; no pathname fallback. |
| `ENCRYPTED_VERIFIED -> USER_FINALIZE_REQUIRED` | Linux/macOS capability is `USER_FINALIZE_REQUIRED`; candidate and parent durability are proven, source generation still matches reviewed consent | Release body lease/migration mutation locks; retain candidate and canonical plaintext | Candidate durable; no Nuvyn plaintext namespace mutation; explicit user procedure required. |
| `USER_FINALIZE_REQUIRED -> CONSENT_REQUIRED` | Re-scan before verification observes a changed plaintext generation | No body mutation; old consent invalidated | New revision/unlock/preparation required; stale candidate cannot authorize. |
| `USER_FINALIZE_REQUIRED -> PUBLISHED` | User action occurred externally; exact candidate fingerprint, authenticated V1/AAD identity and required durability verified under unlock | Body lease for authentication; cleanup only after publication | Different/malformed/missing/unsafe state remains attention; no assumption from user instruction. |
| `PUBLISHING -> DURABILITY_PENDING` | Windows publication or required durability may have happened but result is unknown | No cleanup; target not overwritten | Retain artifacts/journal; retry verified durability. |
| `PUBLISHING -> RECOVERY_AUTH_REQUIRED` | Target may have been published; transaction fingerprint/generation matches but server is locked | No cleanup/body mutation | Unlock reconciliation required; never call syntactic V1 valid. |
| `PUBLISHING -> PUBLISHED` | Create-only target publish, required durability and authenticated readback succeed | Lease must be current for auth; post-publication is monotonic | Target authoritative; cleanup forward only. |
| `PUBLISHED -> CLEANUP_PENDING` | Any SQLite/IDB/AI/frontmatter/source cleanup or final verification fails | Cleanup owner and action scopes | Retry forward; never restore plaintext; POSIX never searches/deletes user backups. |
| `PUBLISHED -> COMPLETE` | All required cleanup gates, consent and final canary/identity checks pass | Metadata transaction and no active external conflict | Terminal resolved/cleaned result. |
| Any pre-publication -> `NEEDS_ATTENTION` | Identity conflict, external mutation, malformed source, unsupported candidate, unsafe path or failed authentication | No weaker alternate primitive | Preserve source/candidate and show stable code. |
| `CLEANUP_PENDING -> COMPLETE` | Re-run proves authenticated target and all confirmed cleanup complete | Unlock for body/AI checks; same scopes | Idempotent forward retry. |
| `RECOVERY_AUTH_REQUIRED -> PUBLISHED` | Unlock, exact fingerprint/generation and AES-GCM/AAD auth succeed with current lease | Body lease required | Journal phase is written only after durable proof. |
| `RECOVERY_AUTH_REQUIRED -> NEEDS_ATTENTION` | Auth/fingerprint/generation mismatch or forged syntactic V1 | No overwrite or cleanup | Target/quarantine preserved; explicit attention. |
| `NEEDS_ATTENTION -> READY` | User repaired condition, new revision/scope reviewed and requested `retry-item` | Required unlock/locks reacquired | No implicit retry from a timer. |

`MIGRATION_IN_PROGRESS` is a classification/code for a concurrent journal, not
a state that authorizes a second writer. `RECOVERY_AUTH_REQUIRED`,
`DURABILITY_PENDING` and `CONSENT_REQUIRED` are not success and block cleanup
or body mutation. `USER_FINALIZE_REQUIRED` is a real pending state: it allows
structural status only, blocks automatic save/body display while locked and
requires explicit user file action plus exact verification. `PUBLISHING` and
the source-quarantine transitions are Windows `AUTOMATIC_HANDLE_BOUND`
transitions; Linux/macOS do not enter them. A `CONSENT_REQUIRED` item cannot
inherit an earlier revision. `NEEDS_ATTENTION` is terminal until an explicit
user action; it is never silently converted to `COMPLETE`.

### 5.2 Aggregate transitions

`NOT_STARTED -> INVENTORIED` follows an explicit scan that creates an immutable
`inventoryRevision`. `INVENTORIED -> NEEDS_UNLOCK` occurs when legacy body
work is present. `INVENTORIED` or `NEEDS_UNLOCK -> RUNNING` follows all current
action scopes and a current lease; a rescan creates a new revision and
invalidates stale consent for changed/new rows.
`RUNNING -> ATTENTION_REQUIRED` occurs on any unacknowledged item or auxiliary
decision. `USER_FINALIZE_REQUIRED` is pending and prevents aggregate
completion until exact user-finalize verification. `RUNNING -> COMPLETE`
requires every item to be terminal (`COMPLETE`, valid-encrypted no-op,
explicitly acknowledged `NEEDS_ATTENTION`, or explicit policy-retained AI
state) plus Git-retention and AI-retention acknowledgments. A verified POSIX
finalize may complete while a separately disclosed
`USER_CONTROLLED_PLAINTEXT_RESIDUAL` remains.
Any unexpected storage failure is `FAILED` with a resumable ledger/journal; it
is not success.

### 5.3 Platform capability and restart state

The migration item records one immutable `migrationFinalizeCapability`:

```text
AUTOMATIC_HANDLE_BOUND
USER_FINALIZE_REQUIRED
UNSUPPORTED
```

Windows may select `AUTOMATIC_HANDLE_BOUND` only when its captured source and
parent handles, fail-if-exists destination and durability rules are all
available. Linux and macOS stock filesystems select `USER_FINALIZE_REQUIRED`:
they can prepare and verify an encrypted candidate, but Nuvyn performs no
automatic rename, unlink, restore or replacement of the legacy plaintext.
`UNSUPPORTED` is reserved for a filesystem that cannot safely create,
authenticate and durably retain the candidate. A Windows adapter that loses
its handle guarantee falls back to `USER_FINALIZE_REQUIRED`, never to a
pathname check/use operation.

The authority taxonomy is deliberately asymmetric:

| Authority | Meaning | Destructive scope |
| --- | --- | --- |
| Logical identity | `(vaultId, documentId, canonicalPath, schemaVersion)` item tuple | Selects an item/AAD tuple only. |
| Filesystem generation identity | Structural device/volume, inode/file ID, parent and available generation evidence | Identifies what was observed; never grants mutation authority. |
| Live automatic mutation authority | Windows source/parent handle pair consumed by `SetFileInformationByHandle` | One exact automatic Windows namespace mutation while handles are live. |
| POSIX user-finalize verification | Candidate fingerprint + authenticated envelope + current structural checks after external action | Proves resulting canonical ciphertext; cannot prove an external writer did not alter a lost generation during the manual action. |

No pathname, prior `lstat`/`stat`, metadata equality, process token or
directory lock is a destructive authority. Nuvyn will not claim a kernel CAS
primitive that Linux/macOS do not expose. User-mediated file changes are
verified after the fact, not represented as Nuvyn-atomic operations.

For Linux/macOS the durable state machine is:

```text
reviewed plaintext generation
    -> ciphertext candidate prepared and durable
    -> USER_FINALIZE_REQUIRED
    -> external user file operation (outside Nuvyn authority)
    -> resume/restart structural inspection
       -> exact candidate fingerprint + authenticated AAD
          -> PUBLISHED -> CLEANUP_PENDING/COMPLETE
       -> unchanged plaintext -> USER_FINALIZE_REQUIRED
       -> changed/missing/unsafe/different bytes -> exact conflict/attention
```

There is no plaintext quarantine and no process-local ownership token to
reacquire on POSIX. Candidate restart requires only structural candidate
provenance and revalidation; it never restores plaintext or infers that the
user followed instructions. The canonical path remains legacy plaintext until
verified user-finalize. A candidate remains safe to retain because it is
ciphertext-only and transaction-owned.

For Windows the existing automatic state remains:

```text
owned source/parent handles
    -> automatic handle-bound source transition
    -> ciphertext publication and durability
    -> PUBLISHED / cleanup
```

If Windows restart cannot prove the exact handle/file identity under its
filesystem contract, it falls back to `USER_FINALIZE_REQUIRED` or attention;
it never guesses ownership from a path or numeric ID alone.

## 6. Migration ledger

Future SQLite migration `0012_diary_migration_ledger.sql` proposes exactly the
following tables; no SQL migration is created by this remediation:

```sql
CREATE TABLE diary_migration_runs (
  run_id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  inventory_revision INTEGER NOT NULL,
  reviewed_revision INTEGER,
  state TEXT NOT NULL CHECK (state IN (
    'NOT_STARTED','INVENTORIED','NEEDS_UNLOCK','RUNNING','ATTENTION_REQUIRED',
    'COMPLETE','FAILED'
  )),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE diary_migration_items (
  item_key TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES diary_migration_runs(run_id),
  vault_id TEXT NOT NULL,
  document_id TEXT,
  canonical_path TEXT NOT NULL,
  inventory_revision INTEGER NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  classification TEXT NOT NULL CHECK (classification IN (
    'ALREADY_ENCRYPTED_VALID','LEGACY_PLAINTEXT',
    'ENCRYPTED_MALFORMED','ENCRYPTED_UNKNOWN_VERSION',
    'ENCRYPTED_IDENTITY_MISMATCH','METADATA_MISSING',
    'METADATA_AMBIGUOUS','PRIMARY_MISSING','EXTERNAL_PATH_CONFLICT',
    'MIGRATION_IN_PROGRESS','CLEANUP_PENDING','RECOVERY_AUTH_REQUIRED',
    'DURABILITY_PENDING','CONSENT_REQUIRED','USER_FINALIZE_REQUIRED',
    'UNSUPPORTED','LEGACY_DIARY_AI_HISTORY','FRONTMATTER_IDENTITY_UNRESOLVED',
    'NEEDS_ATTENTION'
  )),
  state TEXT NOT NULL CHECK (state IN (
    'DISCOVERED','NEEDS_UNLOCK','READY','PREPARING',
    'ENCRYPTED_VERIFIED','PUBLISHING','USER_FINALIZE_REQUIRED',
    'RECOVERY_AUTH_REQUIRED','DURABILITY_PENDING','CONSENT_REQUIRED','PUBLISHED',
    'CLEANUP_PENDING','COMPLETE','NEEDS_ATTENTION'
  )),
  finalize_capability TEXT NOT NULL CHECK (finalize_capability IN (
    'AUTOMATIC_HANDLE_BOUND','USER_FINALIZE_REQUIRED','UNSUPPORTED'
  )),
  source_generation_json TEXT,
  source_parent_generation_json TEXT,
  reviewed_source_generation_json TEXT,
  candidate_name TEXT,
  candidate_generation_json TEXT,
  candidate_parent_generation_json TEXT,
  candidate_durability TEXT CHECK (candidate_durability IN (
    'NOT_STARTED','UNKNOWN','DURABLE','FAILED'
  )),
  quarantine_name TEXT, -- non-null only for Windows AUTOMATIC_HANDLE_BOUND
  quarantine_generation_json TEXT, -- Windows-only automatic plaintext object
  quarantine_parent_generation_json TEXT, -- Windows-only automatic parent
  quarantine_durability TEXT CHECK (quarantine_durability IN (
    'NOT_STARTED','UNKNOWN','DURABLE','FAILED'
  )),
  target_generation_json TEXT,
  transaction_id TEXT,
  ciphertext_fingerprint TEXT,
  ai_session_id INTEGER,
  ai_message_ids_json TEXT,
  frontmatter_row_cas_json TEXT,
  envelope_version INTEGER,
  attention_code TEXT,
  user_residual_state TEXT CHECK (user_residual_state IN (
    'NONE','USER_CONTROLLED_PLAINTEXT_RESIDUAL'
  )),
  last_action_scope TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, inventory_revision, item_key)
);

CREATE TABLE diary_migration_consents (
  consent_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES diary_migration_runs(run_id),
  vault_id TEXT NOT NULL,
  inventory_revision INTEGER NOT NULL,
  item_key TEXT NOT NULL,
  action_scope TEXT NOT NULL CHECK (action_scope IN (
    'MIGRATE_PRIMARY','REMOVE_VERIFIED_LEGACY_PRIMARY','CLEAN_PRIVATE_SQLITE',
    'IMPORT_DRAFT','DISCARD_DRAFT','DISCARD_AI_SESSION','RETAIN_AI_HISTORY',
    'BIND_FRONTMATTER_IDENTITY','ACKNOWLEDGE_GIT_RETENTION'
  )),
  reviewed_generation_json TEXT,
  reviewed_item_set_fingerprint TEXT NOT NULL,
  consented_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('GRANTED','INVALIDATED','CONSUMED')),
  FOREIGN KEY (run_id, inventory_revision, item_key)
    REFERENCES diary_migration_items(run_id, inventory_revision, item_key)
);

CREATE INDEX idx_diary_migration_items_run_state
  ON diary_migration_items(run_id, state);
CREATE INDEX idx_diary_migration_items_identity
  ON diary_migration_items(vault_id, document_id, canonical_path, schema_version);
CREATE INDEX idx_diary_migration_consents_scope
  ON diary_migration_consents(run_id, inventory_revision, action_scope, item_key);
```

`item_key` is the literal encoded tuple
`vaultId\u0000documentId\u0000canonicalPath\u00001` for resolved items. A
pre-adoption inventory row uses `UNRESOLVED\u0000canonicalPath\u00001` only to
display an attention item; it cannot enter `PREPARING` and is replaced by the
resolved tuple after `adopt-metadata`. Every item belongs to exactly one
immutable `inventory_revision`; a rescan appends a new revision and marks new
or changed tuples `CONSENT_REQUIRED`.

Generation JSON contains only regular-file type, device/inode or Windows file
ID, available birth/generation provenance, mtime/mtimeNs when available and
directory identity. `source_generation_json` and
`reviewed_source_generation_json` identify the canonical generation observed
before candidate preparation. `candidate_name`, candidate generation and
`candidate_durability` are used on every platform. The
`quarantine_*` fields are nullable and operation-kind scoped: they are
populated only for Windows `AUTOMATIC_HANDLE_BOUND`; Linux/macOS never persist
invented plaintext-quarantine values. The live Windows handle token is
process-memory-only and is never serialized. The JSON contains no byte size,
body hash, plaintext digest or content. A ciphertext fingerprint is SHA-256
of the randomized encrypted artifact and is classified as internal non-secret
transaction provenance; it is never returned in a locked response and cannot
authorize mutation alone. `user_residual_state` records an explicitly
disclosed user-controlled plaintext backup and is not proof of erasure.
`frontmatter_row_cas_json` contains structural row status/updated-at/nullness
only; any existing source hash used as a CAS is compared transiently inside
the SQLite transaction and is never copied to this ledger. The ledger forbids
password, KEK, DEK, capability, raw body, excerpt, frontmatter, title/summary/
tags, recovery content, message content and body-derived digest/size. Journal
and ledger updates are structural and idempotent.

Each consent is server-created and binds one action scope to the exact vault,
run, immutable inventory revision, item key, reviewed generation and a
server-computed fingerprint of the reviewed item set. For run-scoped
`ACKNOWLEDGE_GIT_RETENTION`, the ledger creates a synthetic `RUN` item key
whose fingerprint covers the complete revision; `RETAIN_AI_HISTORY` remains
bound to each affected session item. The API never accepts a client token as
authorization. Retention acknowledgments are not cleanup permission.

## 7. Workstream A — discovery/classification

1. Add a `DiaryMigrationService.scan()` that enumerates only canonical managed
   paths using the existing symlink-safe resolver and bounded resource limits.
2. Inspect the first envelope bytes only to distinguish no-magic legacy bytes
   from magic-present bytes; never send magic-present bytes to Markdown,
   gray-matter or LinkIndex.
3. Resolve `DocumentMetadata` by exact path and ID. Detect stale rows,
   duplicate physical generations, path reuse and vault-ID mismatch before any
   body operation.
4. Inventory the IDB database and stores through a client bridge that returns
   structural fields only while locked. Inventory every SQLite private table,
   including `sessions`, `messages.content` and structured AI tool-result
   envelopes, plus local Git exposure classes read-only.
5. Persist an immutable `inventoryRevision` and structural item snapshots in
   the §6 ledger. Expose only counts/path/date/status and opaque AI IDs while
   locked. Do not persist body length, a body hash or message content to make
   inventory look idempotent.
6. A rescan creates a new revision rather than refreshing an authorized run in
   place. The service compares current generation/row CAS to the reviewed
   snapshot and sets `CONSENT_REQUIRED` for every new or changed primary, IDB
   family, SQLite row, AI session or frontmatter row.

Entry proof: every managed file is one of the exact classifications in the PRD;
every unresolved identity is blocked before encryption; all ordinary Notes are
absent from the ledger.

## 8. Workstream B — primary migration and platform finalize

`DiaryMigrationFs` is the sole D8.4 migration filesystem owner. It may call
the existing safe-path and durability primitives, but it must not route a
managed Diary body through the generic Note plaintext replace/delete path.
Direct managed-document deletion is already owned by the D8.3 post-closure
opaque delete transaction; D8.4 must not replace or bypass that owner. Its
semantic operations are `captureSourceGeneration`, `writeCiphertextTemp`,
`publishCiphertextCandidateCreateOnly`, `verifyCiphertextArtifact` and
`syncDurability`; a Windows adapter additionally owns its reviewed automatic
handle-bound source transition and cleanup. Linux/macOS do not expose a Nuvyn
destructive source transition operation.

### 8.1 Capability selection

Before any destructive action, the service selects one structural
`migrationFinalizeCapability`:

```text
AUTOMATIC_HANDLE_BOUND
USER_FINALIZE_REQUIRED
UNSUPPORTED
```

| Adapter result | Selected capability | Exact behavior |
| --- | --- | --- |
| Windows supported filesystem/runtime with captured source/parent handles, fail-if-exists destination and required durability | `AUTOMATIC_HANDLE_BOUND` | Continue with the reviewed handle-directed transition, create-only ciphertext publication and forward cleanup. |
| Linux/macOS stock filesystem with safe candidate creation and proven file/parent durability | `USER_FINALIZE_REQUIRED` | Prepare the encrypted candidate and stop before destructive plaintext namespace mutation. |
| Any platform/filesystem unable to create, authenticate and durably retain the candidate | `UNSUPPORTED` | Retain the legacy source and structural journal; return `diary-migration-filesystem-unsupported` (503). |
| Windows adapter loses any required handle/reparse/sharing/durability guarantee | `USER_FINALIZE_REQUIRED` | Fall back to the manual workflow; never use a pathname fallback. |

This is a fixed product policy, not an implementation choice. Nuvyn never
claims a kernel CAS primitive that the host does not provide. No native addon,
userspace helper, advisory lock, watcher, path revalidation or timing retry
may manufacture source-generation atomicity.

### 8.2 Linux/macOS phases

For `USER_FINALIZE_REQUIRED`, implement exactly:

**Phase A — inventory**

1. Canonicalize the managed path with `classifyDiaryPath`, reject symlink or
   reparse traversal, and resolve stable `DocumentMetadata`.
2. Record immutable `inventoryRevision` and the reviewed canonical generation.
3. Require explicit `MIGRATE_PRIMARY` consent for that revision/generation,
   obtain the existing Diary body lease, and read plaintext only into
   authorized memory. No destructive namespace mutation occurs.

**Phase B — ciphertext preparation**

4. Encrypt using the existing server-side Diary access owner and authenticate
   immediately with the same lease and D8.2 vault/document/path AAD.
5. Create one same-filesystem candidate named
   `.nuvyn-diary-migration-ciphertext-<transactionId>` using create-only
   semantics. It is ciphertext-only, transaction-owned, excluded from tree,
   search, LinkIndex, History, Note parsing and automatic body mutation.
6. Fsync the candidate file and required parent directory. Record candidate
   generation, durability, phase and the internal ciphertext fingerprint only;
   never record body size, body hash, plaintext or keys.
7. Revalidate the canonical generation against the reviewed snapshot. A
   changed generation returns `CONSENT_REQUIRED` /
   `diary-migration-consent-required`, retains the source and candidate and
   requires a new unlock/review. The stale candidate never authorizes the new
   generation.

**Phase C — handoff**

8. Persist item state `USER_FINALIZE_REQUIRED` and stable code
   `diary-migration-user-finalize-required` (HTTP 409). Release the body lease
   and migration mutation locks according to the existing epoch/quiescence
   owner.
9. Nuvyn performs no source rename, unlink, restore, replacement or shell
   command on Linux/macOS. The legacy canonical plaintext remains the
   authoritative primary until external user-finalize verification succeeds.

The workflow creates only the existing plaintext primary plus the new
ciphertext candidate. It never creates a plaintext staging file, rollback
payload, quarantine copy or backup.

### 8.3 Source-backed platform contract

The platform decision is based on public APIs: Linux
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

On Linux, `renameat2` selects the source by directory fd plus pathname and
`RENAME_NOREPLACE` protects only its destination. `openat2` with
`RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS`, `O_PATH|O_NOFOLLOW` and `statx` remain
safe candidate-resolution/structural tools. `open_by_handle_at` can reopen an
object on some filesystems with extra privilege, but does not rename or unlink
that object by handle. It is not used as automatic plaintext authority.
`renameat2(RENAME_NOREPLACE)` may publish only the Nuvyn-created ciphertext
candidate. A stock Linux filesystem therefore selects `USER_FINALIZE_REQUIRED`.

On macOS, `renameatx_np`/`rename` selects the source by parent fd plus
pathname; exclusive-destination flags protect only the destination. Public
file-handle reopening does not provide an accepted captured-vnode conditional
rename or unlink. `openat(..., O_NOFOLLOW)` and `fstat` are retained for safe
candidate inspection, and `renameatx_np(RENAME_EXCL)` may publish only the
ciphertext candidate. A stock macOS filesystem selects
`USER_FINALIZE_REQUIRED`.

On Windows, `CreateFileW` opens source and parent with reparse-safe flags and
without `FILE_SHARE_DELETE`; `GetFileInformationByHandleEx(FileIdInfo)`
captures identity. `SetFileInformationByHandle(FileRenameInfoEx)` on the
captured source handle, with the captured parent as `RootDirectory` and
replace-if-exists omitted, remains the automatic source operation. Ciphertext
publication is independently fail-if-exists. Missing flags, unsupported
filesystem semantics, sharing/reparse denial or unknown durability falls back
to `USER_FINALIZE_REQUIRED`, never to a pathname check/use pair.

The common adapter outcomes are `SOURCE_GENERATION_CHANGED`,
`PARENT_GENERATION_CHANGED`, `TARGET_OCCUPIED`, `CONSENT_REQUIRED`,
`USER_FINALIZE_REQUIRED`, `FILESYSTEM_UNSUPPORTED`, `CROSS_DEVICE`,
`SOURCE_BUSY`, `DURABLE`, `DURABILITY_UNKNOWN` and `DURABILITY_FAILED`.
Candidate fsync failure/unknown blocks handoff or maps to `UNSUPPORTED`/
`DURABILITY_PENDING`; it never permits a plaintext mutation.

### 8.4 Exact user-finalize protocol

The UI offers the procedure only when the item is
`USER_FINALIZE_REQUIRED`, the candidate fingerprint/generation and durability
are recorded, the canonical generation still equals the reviewed generation,
and no Nuvyn body operation is active. Nuvyn rescans immediately before
display and invalidates stale consent.

The user instructions are exact: stop Nuvyn body mutation; close external
editors/sync writers; replace the legacy canonical file with the prepared
ciphertext candidate using the documented OS file operation; explicitly keep
or remove any old plaintext copy under the user's own procedure and
acknowledge the residual; then reopen/resume Nuvyn verification. Users handle
filenames/files only. Nuvyn never asks for decrypting, re-encrypting, editing
an envelope, copying body text, modifying nonce/tag/AAD or running a shell
command through Nuvyn.

`POST /api/diary/migration/resume` performs no POSIX rename. It independently
verifies: canonical regular non-symlink/non-reparse path; exact candidate
fingerprint (no alternate encrypted bytes); vault/document/path identity and
V1 AES-GCM/AAD authentication under unlock; and required target/parent
durability before writing `PUBLISHED`. A new inode after manual replacement
is expected and same-inode continuity is not required.

| Observed canonical state | Exact state/code | Behavior |
| --- | --- | --- |
| Reviewed plaintext still present | `USER_FINALIZE_REQUIRED` / `diary-migration-user-finalize-required` | Keep candidate and plaintext; no publish or cleanup. |
| New plaintext generation before acceptance | `CONSENT_REQUIRED` / `diary-migration-consent-required` | Invalidate old preparation; new revision/unlock required. |
| Exact candidate fingerprint + authenticated identity | `PUBLISHED` then cleanup | Advance only after durability and action-scoped cleanup. |
| Different valid encrypted bytes | `NEEDS_ATTENTION` / `diary-migration-candidate-mismatch` | Preserve both; do not accept another transaction's ciphertext. |
| Malformed/unknown envelope | `NEEDS_ATTENTION` / existing malformed/unknown code | Preserve bytes; no overwrite. |
| Missing canonical file | `NEEDS_ATTENTION` / `diary-migration-primary-missing` | Preserve candidate/journal; do not synthesize a primary. |
| Symlink/reparse/unsafe type or wrong identity | `NEEDS_ATTENTION` / `diary-migration-unsafe-path` | Preserve object and artifacts. |

If the user installs a stale candidate after an unobserved external writer
created another plaintext generation, Nuvyn can authenticate only the bytes
that now exist. It cannot reconstruct lost bytes or prove the external writer
did not alter a generation during the user-controlled operation. The UI
warns immediately before finalize and the completion evidence discloses this
residual; it is not represented as an automatic race guarantee.

### 8.5 Automatic Windows and cleanup boundary

Windows `AUTOMATIC_HANDLE_BOUND` retains the reviewed handle-directed source
transition, create-only publication, authenticated readback, durability,
restart and forward cleanup. A source/parent/target race, sharing denial,
reparse point or ID uncertainty preserves the external generation and selects
the stable outcome; no pathname fallback is permitted.

On Linux/macOS, after verified user-finalize Nuvyn may remove only its exact
ciphertext candidate, structural journal and reviewed SQLite/IDB/AI artifacts.
It never locates or deletes a manually moved plaintext backup outside the
canonical managed path. Such a backup is recorded as
`USER_CONTROLLED_PLAINTEXT_RESIDUAL`; Nuvyn never claims universal plaintext
erasure.

The no-new-plaintext invariant is strict: Nuvyn itself creates no second
durable plaintext Diary-body copy, plaintext rollback payload or plaintext
quarantine. If the product requires Nuvyn to automatically replace arbitrary
POSIX plaintext while guaranteeing exact-generation movement against a
non-cooperating writer, the current architecture cannot satisfy that
requirement without separately approved managed storage/filesystem mediation or
a changed threat model.

## 9. Workstream C — Draft/Recovery legacy disposition

The client bridge adds explicit inventory and decision calls around the existing
`DraftStore.inspectVaultRecovery`, conditional delete APIs and family path
rules. It must not reuse ordinary Note recovery rendering for managed rows.

For `import-to-primary`, the unlocked UI shows the row only after current
identity and path are revalidated; the server performs an encrypted D8.2 save
with the row's baseline/CAS. Successful encrypted readback is the commit for
the import, followed by one IDB transaction deleting the exact primary and
selected conflict rows. A stale baseline or changed family returns attention.

For `discard-draft`, require the literal confirmation
`DISCARD LEGACY DIARY RECOVERY`; conditional deletion returns `deleted`,
`missing`, `stale` or `unsupported` and never drops a changed row. There is no
automatic cleanup timer for managed rows. Lock/logout/expiry calls the existing
`clearSensitiveState` seams synchronously before new state can publish.

The bridge accepts an `inventoryRevision`, exact family generation and the
server-created `IMPORT_DRAFT` or `DISCARD_DRAFT` consent ID. The server
reconstructs the current IDB family and conditional CAS; a rescan or row
change invalidates the consent and yields `CONSENT_REQUIRED`. A client token,
typed phrase or old `runId` is never sufficient. An item in
`RECOVERY_AUTH_REQUIRED` cannot import until its primary target is
cryptographically reconciled.

Exit proof: locked row bodies never render/enter search/AI/clipboard/PDF;
valid rows are imported or typed-discarded; ambiguous rows remain; no new
managed persistent Draft is written; Note Draft tests are unchanged.

## 10. Workstream D — SQLite/private metadata

Add a D8.4 cleanup transaction owned by the migration service but implemented
through existing `documentMetadata`/tag/history owners. Before deletion, select
rows by exact managed `document_id` plus canonical path and verify the item is
`PUBLISHED`. In `BEGIN IMMEDIATE`, apply the field table in PRD §11, delete
managed history raw/payload rows and tag deltas, remove only orphaned shared tag
rows, and update ledger state after commit.

History operations with mixed managed and Note children are not split by path;
they remain and set `NEEDS_ATTENTION`. `history_metadata_document_tombstones`
remain identity-only. Invalid `tag_undo_records.operation_json` is never broad
deleted; it is attention. The same transaction inventories `0001` AI
`sessions`/`messages` and identifies only structured `read_file` results naming
an exact managed path. A provable item is `LEGACY_DIARY_AI_HISTORY` and
defaults to attention; `DISCARD_AI_SESSION` is an explicit whole-session
delete through the existing AI message owner, while `RETAIN_AI_HISTORY` is an
explicit Nuvyn-controlled policy-retained residual. Mixed sessions are never
substring-edited and ordinary AI rows remain unchanged. Every action uses its
own immutable-revision consent. A transaction rollback leaves the encrypted
primary authoritative and the item `CLEANUP_PENDING`.

## 11. Workstream E — `frontmatter_backup`

The service queries `metadata_migrations` by exact path plus a proven non-null
document ID and requires no active rollback journal and a `PUBLISHED` item. A
row with `document_id IS NULL` is `FRONTMATTER_IDENTITY_UNRESOLVED` and remains
attention; `adopt-metadata` does not make it owned by path proximity. A
separately consented `BIND_FRONTMATTER_IDENTITY` transaction may set the ID
only when it selects the exact null row, exact path, status, `updated_at`,
`source_hash`, `frontmatter_backup` and `cleaned_hash` CAS values and proves
the current source generation is that legacy row. Binding never clears the
backup and its CAS values are not copied into public status.

Only after the non-null identity binding, primary `PUBLISHED`, no rollback
dependency and the same row CAS may the transaction clear
`frontmatter_backup`, `source_hash`, `cleaned_hash` and error and set
`status='cleaned'`. An already-cleaned row is a no-op; a mismatched, changed or
shared row remains attention. Generic startup `migrateVaultMetadata` and
ordinary Note `frontmatterArchive` behavior remain unchanged.

## 12. Workstream F — Git/history

Implement a read-only Git inventory in the migration service using the vault
repo owner (`server/history/git.ts`) and isolated commands equivalent to
`for-each-ref`, `rev-list --all --objects` and `fsck --no-reflogs --unreachable`.
Classify current tree/index, local branches/tags, remote-tracking refs, stash,
reachable commits, reflogs and unreachable objects separately. Record only
counts, refs, commit IDs and canonical managed paths in the report; never emit
blob content.

Do not call `addAndCommit`, `update-ref`, filter-repo, reflog expiry, prune or
push. The user-visible start request must acknowledge retention. The release
evidence records that D8.4 did not rewrite local or remote history and lists
uncontrolled residual classes.

## 13. Workstream G — mixed-state and crash recovery

Extend startup order to:

```text
vault writer ownership
seed folders
existing recoverInterruptedOperations
DiaryMigrationService.recover
History metadata reconcile
generic Note metadata migration
tag health
HTTP listener
```

`recover` recognizes only the D8.4 ciphertext candidate, Windows automatic
artifacts and their structural journal. It validates safe path/type,
transaction identity, candidate fingerprint/generation and durability without
logging body bytes. Generic `.nuvyn-staged-*` and
`.nuvyn-delete-inflight-*` remain owned by existing Note recovery.

### 13.1 Linux/macOS restart

There is no Nuvyn-created plaintext quarantine and no process-local plaintext
ownership token to reacquire. Durable state records the reviewed canonical
generation (if still present), ciphertext candidate name/generation,
candidate fingerprint, inventory revision, capability, phase and durability.
On restart:

1. candidate absent or not durable: leave the legacy plaintext authoritative;
   remove a partial candidate only when exact transaction-owned ciphertext
   provenance proves that operation, then retry preparation;
2. candidate durable and canonical plaintext still present: restore
   `USER_FINALIZE_REQUIRED` without mutating the canonical path;
3. canonical state may have changed externally: classify the actual state and
   require unlock for candidate authentication; never infer a user action;
4. exact candidate fingerprint plus authenticated V1/AAD identity and required
   durability: advance to `PUBLISHED`, then cleanup forward; and
5. different/malformed/missing/unsafe canonical state: preserve it and the
   candidate, returning the exact conflict/attention code.

`POST /api/diary/migration/resume` follows this same inspection and never
performs a POSIX rename, unlink, restore or replace. A new canonical inode is
expected after user finalize; same-inode continuity is not a requirement.

### 13.2 Windows restart

The automatic Windows path retains captured source/parent handle semantics,
fail-if-exists publication, reparse/sharing rules, durability and forward-only
cleanup. A fresh process may continue only after the reviewed filesystem
identity contract reopens the exact object. If that proof is unavailable or a
file-ID/generation is uncertain, select `USER_FINALIZE_REQUIRED` or
`NEEDS_ATTENTION`; never delete, restore or overwrite by path or numeric ID.

### 13.3 External user action and crash oracle

The user-finalize file operation is outside Nuvyn authorization. The
deterministic test controller performs the documented external replacement,
then kills the child before `resume`; a fresh process inspects the actual
canonical bytes. Candidate durability is covered by the applicable
`AFTER_CIPHERTEXT_TEMP_FSYNC` seam. Post-user authentication uses the
applicable readback/journal seams. There is no fake hook around the user's
file operation. The exact 19-hook set remains authoritative for the automatic
Windows path and platform-independent SQLite/IDB cleanup; POSIX source-
transition, publication and plaintext-quarantine hooks are explicitly
not-applicable.

At every restart or hook, lock/logout/expiry/capability replacement fences
late work. Locked status never authenticates a syntactic envelope, and no
restart path creates plaintext or silently deletes a user-controlled backup.

## 14. Workstream H — migration UX/API

### 14.1 Exact API surface

All endpoints require the existing authenticated application session and set
`Cache-Control: no-store`. Responses contain structural state only.

Settings renders the capability without kernel terminology: Windows may show
**Ready for automatic encrypted migration**; Linux/macOS show **Encrypted
replacement prepared — manual finalize required**; and an unavailable
candidate durability path shows an unsupported message. The UI explains why
Nuvyn stopped, the file-only operation required, why external editors/sync
writers must be closed, what verification will follow and which
`USER_CONTROLLED_PLAINTEXT_RESIDUAL` may remain.

| Method/path | Request | Success | Auth/unlock | Side effect / idempotency |
| --- | --- | --- | --- | --- |
| `GET /api/diary/migration/status` | none | `200` run state, `inventoryRevision`, counts, safe item path/date/id/classification/state, `migrationFinalizeCapability` and opaque AI IDs | Login; locked allowed | Read-only; no body length, fingerprint, generation detail or message content. |
| `POST /api/diary/migration/scan` | `{}` | `202` `{runId,inventoryRevision,state,counts}` | Login; locked allowed | Creates an immutable revision; a rescan never refreshes consent in place. New/changed rows become `CONSENT_REQUIRED`. |
| `POST /api/diary/migration/start` | `{runId,inventoryRevision,requestedScopes:[{itemKey,scope}]}` | `202` `{runId,inventoryRevision,state}` | Login; body work additionally requires an unlocked Diary lease | Server reconstructs the revision/generations and creates action-scoped consent records; a concurrent migration-control request returns `409 diary-migration-in-progress`, a completed run returns `409 diary-migration-already-complete`. |
| `POST /api/diary/migration/resume` | `{runId,inventoryRevision}` | `202` `{runId,inventoryRevision,state}` | Login; `RECOVERY_AUTH_REQUIRED` and `USER_FINALIZE_REQUIRED` verification/body work requires unlock | Inspects actual canonical state; performs no POSIX rename/unlink/replace; a newer revision requires new consent; safe to repeat. |
| `POST /api/diary/migration/items/:itemKey/resolve` | `{inventoryRevision,action:'adopt-metadata'|'import-to-primary'|'discard-draft'|'discard-ai-session'|'retain-ai-history'|'bind-frontmatter-identity'|'retry-item'|'acknowledge-attention',confirmation?:'DISCARD LEGACY DIARY RECOVERY'}` | `202` item state/category | Body/AI actions and binding require unlock; retry/ack require login | Actions map exactly to `IMPORT_DRAFT`, `DISCARD_DRAFT`, `DISCARD_AI_SESSION`, `RETAIN_AI_HISTORY` and `BIND_FRONTMATTER_IDENTITY`; server reconstructs item/scope; changed identity/family/session/row remains `CONSENT_REQUIRED` or attention. |

There is no Git rewrite endpoint. Git retention is the only supported policy.
AI retention is a separate explicit Nuvyn-controlled policy action; it is not
grouped with external residuals. No endpoint returns a body or AI message
content for diagnostics or export.

### 14.2 Stable errors/statuses

| HTTP | Code | Meaning |
| ---: | --- | --- |
| 400 | `diary-migration-invalid-confirmation` | Request fields or typed discard confirmation are not exact. |
| 401 | existing auth error | Application login is absent/expired. |
| 404 | `diary-migration-run-not-found` | Run/item key is not present in this vault. |
| 409 | `diary-migration-already-complete` | Start requested for a completed run. |
| 409 | `diary-migration-in-progress` | Another migration-control request owns the same run/vault; ordinary document saves do not use this code merely because the FIFO document lock is held. |
| 409 | `diary-migration-identity-missing` | Required identity/adoption action is outstanding. |
| 409 | `diary-migration-identity-ambiguous` | More than one identity/generation can claim the path. |
| 409 | `diary-migration-external-mutation` | Generation/path changed or external writer won. |
| 409 | `diary-migration-consent-required` | Item or generation is new/changed since the reviewed inventory revision or has no action-scoped consent. |
| 409 | `diary-migration-user-finalize-required` | Durable ciphertext candidate exists while the Linux/macOS legacy canonical plaintext remains; explicit user file operation and subsequent verification are required. |
| 409 | `diary-migration-candidate-mismatch` | Canonical bytes are not the exact prepared ciphertext candidate; no alternate encrypted generation is accepted. |
| 409 | `diary-migration-primary-missing` | Canonical primary is absent during user-finalize verification; no primary is synthesized. |
| 409 | `diary-migration-unsafe-path` | Canonical path is a symlink/reparse/unsafe type or has wrong identity. |
| 409 | `diary-migration-cleanup-pending` | Encrypted publication succeeded; auxiliary cleanup remains. |
| 409 | `diary-migration-durability-pending` | Publication/directory durability cannot yet be proven; item is not `PUBLISHED`. |
| 409 | `diary-migration-source-busy` | A required handle-bound source transition cannot proceed because an open/shared handle owns the generation. |
| 409 | `diary-migration-cross-device` | The required same-filesystem no-copy operation cannot be performed. |
| 409 | `diary-migration-quarantine-ownership-unproven` | Windows restart cannot reacquire the exact automatic quarantine generation and parent; no delete, restore or overwrite is permitted. |
| 409 | `diary-migration-draft-decision-required` | Legacy Draft/Recovery action is not chosen. |
| 409 | `diary-migration-git-decision-required` | Retention acknowledgment is absent. |
| 409 | `diary-migration-attention-required` | Run has unresolved attention items. |
| 200 (item) | `diary-migration-legacy-plaintext` | Item classification returned in safe status/item data, not as an implicit mutation error. |
| 422 | `diary-migration-malformed-envelope` | Magic-present envelope is malformed/auth-invalid. |
| 422 | `diary-migration-unknown-envelope` | Envelope version is unsupported. |
| 422 | `diary-migration-identity-mismatch` | AAD vault/document/path does not match. |
| 423 | `diary-migration-locked` | Operation requires current Diary body access for an item not yet in deferred recovery. |
| 423 | `diary-migration-auth-required` | Item is `RECOVERY_AUTH_REQUIRED`; structural status is readable, but body read/save/create, resume, cleanup, Draft import and AI disposition wait for post-unlock fingerprint/generation/AES-GCM/AAD reconciliation. |
| 503 | `diary-migration-filesystem-unsupported` | The adapter cannot safely create/authenticate/durably retain the ciphertext candidate; all unproven artifacts are retained. Lack of a POSIX automatic source mutation alone is not this error; it selects `USER_FINALIZE_REQUIRED`. |
| 503 | `diary-migration-unavailable` | Migration owner/ledger/recovery dependency is unavailable. |

Error bodies contain only `code`, a generic safe message, and bounded
structural details. Client-only invalidation and stale epoch results do not
become HTTP conflicts.

## 15. Workstream I — diagnostics/artifacts

Use a structured redacted logger. Canary tests must search every migration
temp, ciphertext candidate, Windows automatic quarantine, journal, SQLite table (including AI `sessions/messages`),
IndexedDB migration response, new Git commit, server output, browser console,
trace, screenshot, video and test attachment for fresh values
`D8_4_PRIMARY_<random>`, `D8_4_DRAFT_<random>`,
`D8_4_FRONTMATTER_<random>`, and `D8_4_METADATA_<random>`.

The canary harness records whether a matching legacy source existed before the
run. A match in a newly created durable artifact is failure even if the final
primary is encrypted. Body/message values, byte length, body/AI digests,
passwords, keys, capabilities, provider payloads and raw exceptions are
forbidden in logs/artifacts. The internal ciphertext fingerprint is permitted
only in the migration ledger/proof and is not exposed to locked clients.

## 16. Workstream J — release/full regression

Add focused migration suites without weakening existing tests. Preserve the
D8.3 managed-path gates and run the complete existing quality bar. Release is
blocked until §20 passes and the implementation evidence has an exact-head CI
run, residual-risk statement and Independent Review lineage.

## 17. Test matrix

### 17.1 Primary and identity

| Case | Expected proof |
| --- | --- |
| Windows plaintext happy path | Ciphertext-only durable artifacts; encrypted target decrypts exactly; source object is removed only after the reviewed handle-bound confirmation. |
| Linux/macOS plaintext preparation | Candidate is ciphertext-only and durable; canonical plaintext remains; item is `USER_FINALIZE_REQUIRED`; no Nuvyn source rename/delete occurs. |
| Valid encrypted | Byte-for-byte no-op and `ALREADY_ENCRYPTED_VALID`. |
| Repeat/rerun | Same tuple converges without re-encryption or duplicate artifact. |
| Malformed/unknown/auth/AAD/vault mismatch | Stable 422/classification, no overwrite or plaintext interpretation. |
| Missing/stale/ambiguous metadata | No encryption until adoption; wrong identity remains attention. |
| External save/replace/path reuse at each race | Nuvyn-controlled actions preserve the external generation; POSIX stops before destructive mutation and surfaces `CONSENT_REQUIRED`/`USER_FINALIZE_REQUIRED`; no clobber/delete. |
| Lock/logout/expiry/capability replacement | Pre-publish operation aborts/fences; post-publish resumes forward. |
| Locked Windows restart after publication seams | `RECOVERY_AUTH_REQUIRED` when fingerprint/generation matches; no plaintext restore/cleanup; unlock + exact AES-GCM/AAD succeeds to `PUBLISHED`, forged/replaced target to attention. |
| POSIX candidate durable -> crash/restart | Canonical plaintext remains authoritative; candidate is retained and state returns to `USER_FINALIZE_REQUIRED`; no plaintext recovery. |
| External user finalize -> crash/restart | Fresh process inspects actual canonical state; exact candidate/authentication may advance, unchanged plaintext remains pending, and every other state maps to the exact conflict/attention code. |
| Server restart at each exact hook enum | The deterministic oracle in §19 records filesystem/journal/SQLite/IDB state and allowed next state; no timing-based kill. |

### 17.2 No-new-plaintext proof

At each exact hook enum listed in §19, inspect temp/staging/journal/rollback/
recovery/candidate and Windows quarantine, SQLite ledger and `sessions/messages`, new Git commits,
logs and test artifacts. Assert no fresh body canary, byte-size value,
plaintext digest or AI message content appears. Assert valid old legacy source
is distinguished from a new copy and the ledger has no forbidden field/value.

### 17.3 Consent, AI and frontmatter

- Confirm revision R1, then introduce primary/IDB/SQLite/AI/frontmatter row B;
  a rescan produces R2 and B remains `CONSENT_REQUIRED`.
- Change a reviewed generation G1 to G2, replay the old run/action, and prove
  removal/cleanup/import/discard is rejected; typed discard does not override
  the revision check.
- Inventory `sessions/messages` fixtures for structured managed-Diary
  `read_file`, ordinary AI, mixed Note+Diary, locked hiding, explicit
  whole-session discard, retention acknowledgment, crash/retry/idempotency and
  no message-content ledger/log copy.
- Exercise `metadata_migrations.document_id IS NULL`: no proof retains
  `FRONTMATTER_IDENTITY_UNRESOLVED`; path reuse cannot bind/clear; verified
  generation binds identity only; binding/cleanup crashes and CAS changes
  retain the row; Note rows at the same path are untouched.

### 17.4 Draft/SQLite/Git

- Locked legacy IDB row is not rendered; unlock discovers valid identity;
  import, typed discard, ambiguous identity, crash during deletion and retry
  all preserve user edits; ordinary Note Draft Store is unchanged.
- Managed SQLite private rows clean transactionally; Note rows, stable ID and
  Mood remain; `frontmatter_backup` cleanup is idempotent; crash rolls back.
- Git inventory covers branches/tags/remotes/stash/reflogs/reachable and
  unreachable objects; no local rewrite/remote force-push; ordinary Note Git
  history is unchanged; rerun is read-only.

### 17.5 Locking and ownership

- A migration-held document lock makes ordinary managed PUT queue; after the
  lock is released it revalidates current session/CAS/primary and either saves
  or returns the existing semantic conflict. No migration-specific 409 is
  emitted merely for lock wait.
- Two migration-control starts have deterministic ownership conflict; logout/
  expiry while queued cannot publish a stale result; vault/structure/document
  lock ordering has no deadlock.

### 17.6 Path/platform/scale

Test valid and invalid spellings (`diary/2026-08-31`, `.md`, absolute,
duplicate separators, dot segments, nested/wrong-case/wrong-extension),
symlinked file/directory, directory replacement, cross-device temp refusal,
many dates, large bounded bodies, many IDB rows and large Git histories.

## 18. Cross-platform validation

Run Linux, macOS and Windows jobs against the same security outcome, not an
identical filesystem algorithm. Linux/macOS tests prove safe candidate
creation, authenticated readback, file/parent `fsync`, restart persistence of
`USER_FINALIZE_REQUIRED`, stale-source/candidate conflict detection,
post-user-finalize verification and the absence of any Nuvyn plaintext
rename/delete. Windows tests prove the declared captured-handle conditional
source transition, create-only publication, junction/reparse rejection,
open-handle/antivirus behavior, case-folded path identity, cross-device
refusal and file/directory durability. A pathname check/use pair is never a
source proof. If candidate durability is unavailable, return
`diary-migration-filesystem-unsupported` or
`diary-migration-durability-pending`, retain the journal/candidate and do not
advance to `PUBLISHED`; no timing retry, copy/delete or overwrite operation is
permitted. Windows loss of its automatic guarantee selects
`USER_FINALIZE_REQUIRED`.

## 19. Failure/rollback matrix and deterministic hook oracle

The only automatic rollback is the reviewed Windows pre-publication
handle-bound restoration of the same pre-existing source object. Linux/macOS
have no Nuvyn plaintext rollback because they stop before namespace mutation.
Once Windows ciphertext publication may have succeeded, no recovery path
writes plaintext to the canonical path. The authoritative hook set contains
exactly **19 named seams**, identical to the PRD §15 list. Every hook is a
deterministic fault-injection seam, not a sleep or timing window. The table
below is fully applicable to automatic Windows finalize and to
platform-independent SQLite/IDB cleanup. For Linux/macOS,
`AFTER_JOURNAL_PREPARED` and `AFTER_CIPHERTEXT_TEMP_FSYNC` cover candidate
preparation; `AFTER_AUTHENTICATED_READBACK`, `BEFORE_PUBLISHED_JOURNAL`,
`AFTER_PUBLISHED_JOURNAL` and cleanup hooks cover post-user verification.
Source-transition, ciphertext-publication and plaintext-quarantine hooks are
explicitly not applicable on POSIX and are never simulated around a user
action:

Applicability is frozen by operation, not guessed at runtime:

| Hook family | Automatic Windows finalize | Linux/macOS `USER_FINALIZE_REQUIRED` |
| --- | --- | --- |
| `AFTER_JOURNAL_PREPARED`, `AFTER_CIPHERTEXT_TEMP_FSYNC` | Applicable | Applicable to candidate preparation |
| `BEFORE_SOURCE_TRANSITION`, `AFTER_SOURCE_TRANSITION`, `BEFORE_CIPHERTEXT_PUBLISH`, `AFTER_CIPHERTEXT_PUBLISH_SYSCALL`, `AFTER_TARGET_DURABILITY` | Applicable | **Not applicable**; no Nuvyn plaintext namespace mutation or fake seam |
| `AFTER_AUTHENTICATED_READBACK`, `BEFORE_PUBLISHED_JOURNAL`, `AFTER_PUBLISHED_JOURNAL` | Applicable | Applicable after external user finalize verification |
| `BEFORE_SQLITE_CLEANUP_COMMIT`, `AFTER_SQLITE_CLEANUP_COMMIT`, `BEFORE_IDB_DISPOSITION_COMMIT`, `AFTER_IDB_DISPOSITION_COMMIT`, `BEFORE_ITEM_COMPLETE`, `AFTER_ITEM_COMPLETE` | Applicable | Applicable after exact post-user verification |
| `BEFORE_SOURCE_QUARANTINE_UNLINK`, `AFTER_SOURCE_QUARANTINE_UNLINK_BEFORE_DIR_DURABILITY`, `AFTER_SOURCE_QUARANTINE_DIR_DURABILITY` | Applicable | **Not applicable**; POSIX creates no Nuvyn plaintext quarantine |

| Hook | Filesystem state | Journal / SQLite ledger | IDB | Locked restart / authoritative generation | Allowed / forbidden action; next state |
| --- | --- | --- | --- | --- | --- |
| `AFTER_JOURNAL_PREPARED` | Source canonical; no ciphertext publication | PREPARING journal/item | unchanged | locked; source authoritative | Retry after consent/unlock; no cleanup; `PREPARING` |
| `AFTER_CIPHERTEXT_TEMP_FSYNC` | Source canonical; ciphertext temp durable | ENCRYPTED_VERIFIED journal | unchanged | locked; source authoritative | Re-probe source; temp may be removed only by token; `ENCRYPTED_VERIFIED` |
| `BEFORE_SOURCE_TRANSITION` | Source canonical; target absent | pre-publication | unchanged | locked; source authoritative | Retry or attention; no move/publish; `READY`/`NEEDS_ATTENTION` |
| `AFTER_SOURCE_TRANSITION` | Exact source inode at quarantine; target absent | PUBLISHING | unchanged | locked; quarantine authoritative pre-publication | Token-bound restore only if target empty; no pathname delete; `PUBLISHING` |
| `BEFORE_CIPHERTEXT_PUBLISH` | Quarantine source; ciphertext temp durable; target absent | PUBLISHING | unchanged | locked; source quarantine authoritative until syscall | Publish create-only or fail closed; no overwrite; `PUBLISHING` |
| `AFTER_CIPHERTEXT_PUBLISH_SYSCALL` | Target may exist; quarantine may exist | PUBLISHING, fingerprint recorded | unchanged | locked; target may be authoritative | Never restore plaintext; defer auth; `RECOVERY_AUTH_REQUIRED` or `NEEDS_ATTENTION` |
| `AFTER_TARGET_DURABILITY` | Target durable; quarantine may exist | target provenance recorded, not yet PUBLISHED | unchanged | locked; target may be authoritative | Auth only after unlock; no cleanup; `RECOVERY_AUTH_REQUIRED` |
| `AFTER_AUTHENTICATED_READBACK` | Exact target authenticated; quarantine may exist | target proof recorded, journal not PUBLISHED | unchanged | locked; target authoritative but ledger pending | Resume journal only after current lease; `PUBLISHED` pending |
| `BEFORE_PUBLISHED_JOURNAL` | Authenticated target; quarantine may exist | journal write not started | unchanged | locked; target authoritative | No plaintext restore; write journal after durability; `PUBLISHED` pending |
| `AFTER_PUBLISHED_JOURNAL` | Authenticated target; quarantine may exist | durable PUBLISHED | unchanged | locked; target authoritative | Cleanup forward only; `PUBLISHED`/`CLEANUP_PENDING` |
| `BEFORE_SQLITE_CLEANUP_COMMIT` | Authenticated target; quarantine may exist | `PUBLISHED`; SQLite transaction open and not committed (including a whole-session AI disposition) | unchanged | locked; target authoritative | Kill rolls back the transaction; no target overwrite; `CLEANUP_PENDING` |
| `AFTER_SQLITE_CLEANUP_COMMIT` | Authenticated target; quarantine may exist | SQLite transaction committed; migration ledger may still lag (including committed whole-session AI disposition) | unchanged | locked; target authoritative | Reconcile exact rows idempotently; never recreate/delete a replacement; `CLEANUP_PENDING` |
| `BEFORE_IDB_DISPOSITION_COMMIT` | Authenticated target; quarantine may exist | PUBLISHED/cleanup pending | exact rows unchanged; IDB transaction open | locked; target authoritative | Abort/rollback IDB; changed rows require consent; `CLEANUP_PENDING` |
| `AFTER_IDB_DISPOSITION_COMMIT` | Authenticated target; quarantine may exist | ledger pending auxiliary completion | exact confirmed rows deleted or retained | locked; target authoritative | Re-read idempotently; no second destructive action; `CLEANUP_PENDING` |
| `BEFORE_SOURCE_QUARANTINE_UNLINK` | Authenticated target; exact owned quarantine exists | cleanup pending; unlink not invoked | confirmed dispositions durable | locked; target authoritative; exact quarantine authority required | Unlink only through native exact-generation operation; otherwise attention; `CLEANUP_PENDING` |
| `AFTER_SOURCE_QUARANTINE_UNLINK_BEFORE_DIR_DURABILITY` | Authenticated target; unlink syscall returned; parent-directory durability barrier not completed | cleanup pending; `quarantine_unlink=COMPLETED`, `quarantine_dir_durability=UNKNOWN` | confirmed dispositions durable | locked; target authoritative; namespace may be durable or uncertain | On restart inspect actual namespace; never recreate plaintext or delete a replacement; `DURABILITY_PENDING`/`CLEANUP_PENDING` |
| `AFTER_SOURCE_QUARANTINE_DIR_DURABILITY` | Authenticated target; unlink returned and parent-directory durability barrier completed | cleanup pending; `quarantine_removal_durable=COMMITTED` | confirmed dispositions durable | locked; target authoritative; owned quarantine is durably absent | Forward-only verification; never require/recreate quarantine; `CLEANUP_PENDING`/`COMPLETE` |
| `BEFORE_ITEM_COMPLETE` | Authenticated target; no owned plaintext quarantine | all required cleanup durable | dispositions durable | locked; target authoritative | Revalidate consent/provenance; no cleanup guess; `CLEANUP_PENDING` |
| `AFTER_ITEM_COMPLETE` | Authenticated target; no owned plaintext artifact | item COMPLETE durable | dispositions durable | locked; target authoritative | Idempotent no-op; aggregate may complete only with all consents/residuals |

The three quarantine rows are automatic-Windows-only. For
`BEFORE_SOURCE_QUARANTINE_UNLINK`, the Windows quarantine entry must still
exist and the reviewed handle-bound unlink is the only next operation. For
`AFTER_SOURCE_QUARANTINE_UNLINK_BEFORE_DIR_DURABILITY`, an unlink syscall has
returned but the parent barrier has not; restart inspects the namespace and
never recreates plaintext. A different generation is preserved as external
state. For `AFTER_SOURCE_QUARANTINE_DIR_DURABILITY`, Windows absence is
durably committed and forward cleanup never requires plaintext. Linux/macOS
emit no quarantine rows because no plaintext quarantine exists.

`DISCARD_AI_SESSION` maps to the two SQLite hooks with
`operationClass=DISCARD_AI_SESSION`. At the before-commit seam the exact
session row and every inventoried message row still exist, the transaction
rolls back on kill, the item remains `CLEANUP_PENDING`, and the same consent
is usable only if its inventory revision, session row generation and message
ID set still match. At the after-commit seam the session and all inventoried
messages are absent while the migration ledger may lag; restart records the
already-completed whole-session disposition idempotently and never recreates
data. A replacement/new row with the same numeric ID is a changed generation,
requires new consent and is never deleted by the old action. `RETAIN_AI_HISTORY`
has no destructive hook and remains an explicit policy-retained state.

On an unlocked restart, every applicable hook first revalidates the current
epoch and inventory consent. Windows automatic pre-publication/publication
hooks retry only their recorded handle-bound phase and authenticate the exact
target before `PUBLISHED`; its quarantine hooks continue only after exact
handle checks. Linux/macOS candidate hooks retry only candidate preparation;
after external user finalize, readback/journal hooks authenticate the exact
candidate before `PUBLISHED`. POSIX source-transition/publication/quarantine
hooks are skipped, not simulated. SQLite, IDB and `AFTER_ITEM_COMPLETE` remain
idempotent after scope/generation checks. This is the unlocked counterpart of
every applicable locked-restart row above.

The harness launches a child Nuvyn server against an isolated temporary vault,
signals the parent exactly when a selected enum seam is reached, terminates
the child without graceful cleanup, then starts a fresh process against the
same state. Browser/IndexedDB seams separately instrument the actual IDB
transaction for server-save-response loss, before commit, after commit and a
changed row before retry. No `sleep`, `waitForTimeout`, random kill delay or
retry timing is accepted as crash evidence.

## 20. CI gate

The D8.4 implementation gate requires all of:

1. all migratable plaintext primaries are `COMPLETE`, explicit
   `NEEDS_ATTENTION` with user-visible code, or (before user action)
   explicitly reported `USER_FINALIZE_REQUIRED`;
2. no newly created durable plaintext migration artifact;
3. valid encrypted files are byte-preserving no-ops;
4. malformed/unknown/AAD-invalid envelopes fail closed;
5. locked Windows publication uncertainty enters `RECOVERY_AUTH_REQUIRED`,
   Linux/macOS candidate durability restores `USER_FINALIZE_REQUIRED`, unlock
   proves exact ciphertext fingerprint/generation/AES-GCM/AAD, and no
   plaintext restore/cleanup occurs before authentication;
6. `DiaryMigrationFs` proves ciphertext candidate creation/authentication and
   durability on all platforms; Windows additionally proves the real
   captured-handle conditional automatic path, while Linux/macOS prove no
   Nuvyn plaintext rename/delete and exact user-finalize verification. No
   unsupported outcome falls back to a pathname/copy/delete operation;
7. every destructive action is bound to immutable `inventoryRevision`, exact
   item/generation and action scope; a new/changed row cannot inherit consent;
8. legacy Draft/Recovery, SQLite private metadata, AI `sessions/messages` and
   `frontmatter_backup` follow the frozen action and preserve Note rows;
9. Git policy is applied as read-only disclosure and retention is acknowledged;
10. crash/restart and rerun idempotency proofs pass for every exact 19-hook
    enum, including the Windows unlink-before-directory-durability seam, the
    POSIX candidate-durable -> `USER_FINALIZE_REQUIRED` and post-user-
    verification scenarios, and the mapped whole-session AI disposition;
11. ordinary Note read/write/history/search/Draft behavior passes regression;
12. Linux/macOS/Windows cross-platform tests pass;
13. typecheck, build, full unit/integration, History, Recovery, browser E2E,
    Draft Store browser E2E, auth, tags-scale, visual and Docker smoke are
    green, plus all D8.4 suites;
14. docs, inventory, evidence, canary output and residual-risk disclosure are
    complete; and
15. implementation Independent Review passes (or its remediation/re-review
    chain is complete) before closure.

## 21. Evidence requirements

The future implementation evidence must record: starting HEAD and planning
approval commit; implementation commits; immutable inventory revisions and
action-scoped consents; per-store inventory including AI sessions/messages;
every state transition including `RECOVERY_AUTH_REQUIRED`,
`DURABILITY_PENDING`, `CONSENT_REQUIRED`, `USER_FINALIZE_REQUIRED` and
Windows-only `QUARANTINE_OWNERSHIP_UNPROVEN`; ciphertext candidate/
fingerprint/generation proof without body size; no-new-plaintext canary proof;
the exact 19-hook oracle crash/restart and idempotency proof, including
Windows quarantine unlink versus directory durability, POSIX candidate-durable
and post-user-finalize restart scenarios, and the mapped AI whole-session disposition;
Draft/Recovery disposition;
SQLite/`frontmatter_backup` cleanup and null-ID binding; AI whole-session
disposition; Git policy proof; ordinary Note regression; cross-platform
counts; exact-head CI run; residual-risk categories; Independent Review
verdict; remediation/re-review if any; and final docs-only closure lineage.

## 22. Review/closure lifecycle

The historical process record remains intact: the original Independent
Planning Review remains `CHANGES REQUIRED (0/5/3)`, the first
Independent Planning Re-review remains `CHANGES REQUIRED (0/1/1)`, and
Independent Planning Re-review Round 2 remains `CHANGES REQUIRED (0/1/0)`
with P1-2 open and P2-3 closed. The next action is D8.4 Independent Planning
Re-review Round 3. That reviewer must verify that the impossible POSIX
automatic exact-source mutation is absent from current authority,
`USER_FINALIZE_REQUIRED` is coherent and safely verified, Windows retains only
real handle-bound primitives, candidate/restart/conflict semantics and
residual disclosure are accurate, the seven closed findings remain closed, and
the exact API/error contracts and 19-hook applicability are consistent. That
historical gate was explicitly waived by the owner for the implementation pass
documented here; no review verdict is inferred.

The implementation evidence records the owner authorization, technical
behavior, validation and residuals. It intentionally does not claim an
Independent Review PASS or change the historical planning-review records. The
implementation lifecycle for this run is
`IMPLEMENTED / COMPLETE / FROZEN`; a future review-closure decision, if one is
required by the owner, is separate from this implementation commit.
