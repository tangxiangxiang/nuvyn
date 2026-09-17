# D8.4 Migration, Legacy Cleanup & Release Closure PRD

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
fast-closure run. This document remains the technical authority; it does not
claim an Independent Review PASS.

## 1. Status

The D8.3 closure is authoritative at
`c88e99554c291181c6e3f17e695aa228f34d40b2`. D8.3 is `REVIEW-CLOSED`.
D8.4 implementation is complete under the owner-authorized fast-closure run;
the historical planning record remains separate and this document does not
self-declare an Independent Review PASS.

The D8.4 planning state and implementation authorization are:

```text
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

For this implementation pass, the repository owner explicitly waived the
process-only `D8.4 Independent Planning Re-review Round 3` gate. The decision
is `OWNER-OVERRIDE / IMPLEMENTATION AUTHORIZED`; historical review records stay
intact and every technical/security requirement in this PRD remains binding.
Implementation and validation evidence is recorded in
`diary-encryption-d8.4-implementation-evidence.md`.

## 2. Background

D8.1 established the secondary-password Diary session and the single
server-side `DiaryAccessService`. D8.2 established the V1 AES-256-GCM body
envelope and its path/document/vault AAD binding. D8.3 enforced that boundary
across History/Git, Draft/Recovery, search, LinkIndex, tree/list, rename/move,
delete, export, diagnostics and teardown.

D8.3 deliberately did not mutate legacy data. A vault can therefore contain a
mixture of:

- a pre-D8 plaintext `diary/YYYY-MM-DD.md` primary;
- a valid D8.2 envelope;
- malformed or unknown encrypted bytes;
- missing, stale or mismatched `DocumentMetadata`;
- legacy browser Draft/Recovery records;
- SQLite metadata/frontmatter/history/tag-undo material; and
- plaintext in the vault's local Git history or external copies.

D8.4 is the final currently planned Diary Encryption phase. Its job is to
converge Nuvyn-controlled current state toward the reviewed boundary, disclose
what Nuvyn cannot control, and provide a release gate. It does not redesign
D8.1-D8.3, create a second key/session owner, or promise forensic erasure.

## 3. Goals

1. Provide an explicit, resumable, per-document migration from legacy
   plaintext primaries to the existing D8.2 envelope.
2. Ensure migration never creates a second durable plaintext body copy.
3. Preserve the one pre-existing legacy plaintext generation until a verified
   encrypted publication exists; Windows may then move forward automatically,
   while Linux/macOS require an explicit user-controlled finalize before
   cleanup.
4. Make identity, generation ownership, path reuse, crash recovery and
   idempotency deterministic.
5. Dispose of legacy managed-Diary Draft/Recovery and private SQLite state by
   explicit, user-visible, user-preserving rules.
6. Inventory Git/history and disclose retained legacy exposure without a
   silent rewrite or remote force-push.
7. Keep ordinary Note behavior and all D8.3 fail-closed invariants unchanged.
8. Define test, CI, evidence and closure criteria for the future implementation.

## 4. Non-goals

- No production code, test, dependency, schema, IndexedDB data, SQLite data,
  vault file, Git ref or Git object is changed by this planning commit.
- No password change rekey, DEK rotation, cipher-suite migration or envelope
  V2 is included. Valid V1 ciphertext is not re-encrypted.
- No encrypted persistent Draft Store V2 is introduced. New managed-Diary
  persistent Draft/Recovery remains disabled as required by D8.3.
- No automatic startup/open/read/save/search migration is performed.
- No automatic history rewrite, reflog expiry, object pruning or force-push is
  performed.
- No attempt is made to purge remote clones, third-party backups, downloaded
  exports, OS clipboard history or user-created copies.
- No generic Note metadata, body, Draft Store row or Git history is touched by
  proximity to a Diary path.

## 5. Frozen D8.1-D8.3 invariants

The following are carried forward without redesign:

| Invariant | D8.4 contract |
| --- | --- |
| Identity | `diary/YYYY-MM-DD.md` is the canonical physical name and `diary/YYYY-MM-DD` is the canonical logical path. One valid local civil date is one managed document. |
| Path authority | `shared/diaryProtocol.ts` (`parseDiaryDate`, `diaryDateFromPath`, `isManagedDiaryPath`, `classifyDiaryPath`) is the sole classifier. Inputs are canonicalized before any read or mutation. |
| Crypto owner | `server/diaryAccess/service.ts` is the sole live/unwrapped DEK owner. The client never owns a DEK; it holds only existing session/capability state and transient input. |
| Body adapter | `server/diaryAccess/body.ts` owns the V1 envelope, AES-256-GCM, 12-byte nonce, 16-byte tag, size bounds and AAD (`vaultId`, `documentId`, canonical logical path, envelope version). Invalid authentication, AAD or version fails closed. |
| Access lifecycle | `withDiaryBodyOperation` leases are subordinate to the existing epoch/quiescence state. Lock, logout, expiry and capability replacement fence late work before it publishes. |
| Metadata | SQLite `documents` remains the live stable identity/Mood owner. D8.4 does not move Mood into the body or into a new ledger. |
| Current projection | Locked Calendar/tree/list expose only canonical path/date, existence, stable documentId and Mood. Title, summary, tags, frontmatter, body length, links and snippets are private. |
| Durable writes | Only ciphertext may cross a durable Diary writer after migration. Generic Note atomic writers keep their existing semantics. |
| Git | `server/history/git.ts:addAndCommit` rejects managed paths before any Git/temp mutation; D8.3 managed History remains unavailable. |
| Draft/Recovery | New managed-Diary persistent Draft/Recovery is disabled. Existing legacy rows are retained for this explicit D8.4 disposition workflow. |
| Search/links | Managed Diary contributes structural path/date only. Body search and body-derived LinkIndex state remain disabled/suppressed. Note-to-Note links remain unchanged; the intentional D8.3 exception is suppression of `Note -> managed Diary` edges. |
| Rename/move/delete | The D8.3 post-closure follow-up owns direct managed-document delete through its opaque adapter-aware transaction. Managed-Diary rename/move/reference and folder/bulk delete remain fail-closed; D8.4 migration does not broaden or replace any of these operations. |
| Export | PDF/clipboard are explicit external copies, permitted only for the current unlocked epoch and outside automatic wipe guarantees. |

## 6. Legacy-store inventory

The following inventory is the source-backed starting point for implementation.
"Private" means body-derived or capable of retaining private user text; it
does not mean that every row is populated in every vault.

| Store/artifact | Current owner and location | Private content | Locked behavior / discovery | Stable identity | D8.4 disposition | Unlock / confirmation | Recovery owner | Residual risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Legacy primary `diary/YYYY-MM-DD.md` | `server/routes/diary.ts`, `server/routes/posts.ts`, filesystem under `CONTENT_DIR` | Whole plaintext body | Structural type/mtime/device identity scan is allowed locked; a transient bounded byte count may be used only in process memory for I/O limits and is never persisted, returned or displayed; body read requires a current Diary lease | Path/date plus `documents.id`; missing ID is unresolved | Prepare and authenticate one ciphertext-only candidate. Windows may automatically finalize only with `AUTOMATIC_HANDLE_BOUND`; Linux/macOS stop at `USER_FINALIZE_REQUIRED` and never mutate the plaintext namespace automatically | Unlock required for body; `MIGRATE_PRIMARY` and `REMOVE_VERIFIED_LEGACY_PRIMARY` consents bind to one reviewed inventory revision/generation; user-finalize verification requires a fresh review | New `DiaryMigrationService` plus startup recovery hook | Existing copies and any user-retained plaintext backup outside the canonical path remain |
| Valid V1 primary | `server/diaryAccess/body.ts` through Diary routes | Ciphertext at rest; plaintext only in lease/UI memory | Verify envelope only when unlocked; structural scan can identify magic/version without exposing body | AAD proves vault/id/path | Strict byte-for-byte no-op; no rekey | No migration confirmation for no-op | `DiaryMigrationService` verifies and records no-op | Valid encrypted body in authorized memory remains in scope of D8 threat model |
| Malformed/unknown/AAD-invalid primary | Same as above | Bytes may be private or corrupted | Never parsed as Markdown or plaintext | Identity cannot be trusted until verification | `NEEDS_ATTENTION`; preserve bytes; no overwrite | Unlock only for authenticated repair attempt; no automatic repair | Migration journal/ledger records code only | User must repair/export through a separately authorized path |
| Atomic temps/staging/journals | `server/atomicTextWrite.ts`, `server/crashRecovery.ts` (`.nuvyn-save-*`, `.nuvyn-staged-*`, `.nuvyn-remove-*`, journals) | Ordinary protocols can contain plaintext while serving Notes | Existing recovery runs before HTTP; D8.4 migration must not route plaintext through them | Ownership hashes are generic; not sufficient for migration | Migration uses reserved ciphertext-only temp and structural migration journal; existing Note artifacts remain under current recovery | No body exposed locked | Existing `recoverInterruptedOperations` plus `DiaryMigrationService.recover` | Pre-D8 orphan artifacts may require attention |
| Legacy IDB `drafts` | `src/composables/vault/draft-recovery/draftStore.ts`, DB `nuvyn-draft-recovery`, version 2 | `UnsavedDraft.content`, baseline/body timestamps | Locked inventory uses raw structural fields only; `readDisk` refuses managed paths | `(vaultId, documentId)` key; path in record | Retain until explicit `import-to-primary` or typed `discard-draft`; no automatic deletion | Unlock for import; typed confirmation for discard | Existing DraftStore conditional operations, orchestrated by migration service/UI | Browser profiles/backups outside Nuvyn remain |
| Legacy IDB `draftConflicts` | Same DraftStore, key `(vaultId, documentId, conflictId)` | `DraftConflictRecord.content` and conflict context | Same locked restriction | Vault/document/conflict key | Same two explicit actions; ambiguous family is `NEEDS_ATTENTION` | Unlock/import or typed discard | DraftStore transaction across both stores | Browser storage may be copied by user |
| `documents` | `server/documentMetadata.ts`, SQLite `data/nuvyn.db` | `title`, `summary`; timestamps and `mood` are allowed structural/UX fields only by policy | Read through structural projection; no new body parse | `id` and canonical `path` | Preserve id/path/created/updated/mood; set title to canonical date; clear summary after primary publication and confirmation | Cleanup confirmation | SQLite transaction under vault mutation + document lock | SQLite file backups may predate cleanup |
| `document_tags` / `tags` | `server/tagManagement.ts`, SQLite | Tag names/associations can derive from private frontmatter | Managed associations excluded from D8.3 public projection | `document_id` and FK | Delete managed associations; delete a tag row only when no Note association remains | Cleanup confirmation | Same SQLite transaction; mixed records are never split by guess | Shared tag row retained for Notes may reveal a tag name |
| `document_embeddings` | `server/documentMetadata.ts`, SQLite | Embeddings/content hashes are body-derived | Not exposed to locked managed projection | `document_id` | Delete managed rows after encrypted publication | Cleanup confirmation | SQLite transaction | Copies in DB backups are out of control |
| `metadata_migrations` | `server/metadataMigration.ts`, `server/frontmatterArchive.ts` | `frontmatter_backup`, `source_hash`, `cleaned_hash`, error text | Generic startup skips managed paths; D8.4 reads only structurally and under its owner | `path` plus a proven non-null `document_id`; `NULL` identity is unresolved | A `NULL`-identity row is `FRONTMATTER_IDENTITY_UNRESOLVED` and retained; only a separately proven identity binding may precede cleanup; Notes untouched | `CLEAN_PRIVATE_SQLITE` plus, when needed, `BIND_FRONTMATTER_IDENTITY` consent bound to the reviewed row/generation | SQLite transaction plus ledger `CLEANUP_PENDING` | Historic DB backups may retain old fields |
| AI `sessions` / `messages` | `server/migrations/0001_ai_history.sql`, `server/ai/messages.ts`, `server/ai/chat.ts`, `server/ai/tools.ts` | `messages.content` can contain a structured `read_file` tool result with legacy Diary plaintext | Locked inventory may expose only bounded counts and opaque session/message IDs; message-content classification requires an unlocked Diary body operation and is never rendered | Session/message IDs plus structured tool identity and canonical managed path; free-text resemblance is not identity proof | A provable managed-Diary tool-result exposure is `LEGACY_DIARY_AI_HISTORY`; default `NEEDS_ATTENTION`; explicit whole-session `discard-ai-session` or `retain-ai-history` only; ordinary/mixed text is never substring-redacted | `DISCARD_AI_SESSION` or `RETAIN_AI_HISTORY`, each bound to the reviewed session snapshot; unlock required for classification and discard | Existing AI session/message owner in one identity-bound SQLite transaction | Policy-retained AI history remains a Nuvyn-controlled private residual and is disclosed |
| History metadata tables | `server/history/metadataRevisions.ts`, migrations 0009 | `history_metadata_restore_journal.before_raw/target_raw`, payload JSON, body SHA, expected hashes | D8.3 rejects new managed History; legacy rows can exist | `vault_id`, document/path, operation IDs | Delete rows proven to reference managed IDs/paths; retain identity-only tombstones; mixed operation is `NEEDS_ATTENTION` rather than split | Cleanup confirmation | SQLite transaction and forward retry | Git itself is handled separately |
| Tag Undo foundation | `tag_undo_records`, `tag_undo_association_deltas`, `tag_undo_state` | `operation_json`, tag names, managed association deltas | Not a Diary body reader in D8.3; inventory is bounded structural JSON inspection | `record_id`, delta document_id | Delete records/deltas proven managed-only; mixed/invalid JSON stays `NEEDS_ATTENTION`; Note-only records untouched | Cleanup confirmation for managed-only records | SQLite transaction | A mixed audit row can retain private names |
| Local Git working tree/refs/objects | `server/history/git.ts`, `server/history/routes.ts`, vault `.git` | Legacy plaintext commits, blobs, reflogs and unreachable objects | Read-only inventory; D8.3 blocks new managed commits | Commit/ref/path | Disclose and retain; no history rewrite in D8.4 | User must acknowledge retention before completion | `DiaryMigrationService` read-only Git inventory | Remote refs, clones and backups are not controlled |
| LinkIndex/search caches | `server/linkIndex.ts`, `src/lib/search.ts`, `src/lib/searchResults.ts` | Volatile body-derived links/snippets/cache entries | D8.3 filters; lock epoch clears managed residue | Path only | Verify empty managed body-derived state; no migration copy | No unlock needed for structural verification | Existing epoch/invalidation seams | Process/browser memory can exist while unlocked |
| Logs and test artifacts | `server/prod.ts`, `server/vite-plugin.ts`, sanitizer/e2e fixtures | Potential accidental body/error serialization | Must be redacted and canary-scanned | Structural path/code only | Add D8.4 canary checks; no raw body | No | Existing logger/test artifact owners | OS/provider logs outside Nuvyn scope |

The inventory intentionally distinguishes Nuvyn-controlled current stores from
external copies. A count is safe only when it is structural; no inventory API
returns a body excerpt. `sessions`, `messages` and structured managed-Diary
AI tool-result envelopes are Nuvyn-controlled current stores, not external
residuals. Their message content is never copied into the migration ledger or
logs. A legacy file's exact byte length is treated as private body metadata:
it may exist transiently in an authorized process for bounded I/O, but never
in durable migration state, locked status, UI, logs or evidence.

## 7. User migration experience

### 7.1 Trigger and consent

The only trigger is an explicit **Diary Migration & Legacy Cleanup** workflow
opened from Settings or a user-visible post-upgrade banner. Opening, reading,
saving, searching, creating a new Diary date, or starting the server never
silently migrates a legacy file.

1. The user selects **Scan legacy Diary state**. Scan may run locked and creates
   an immutable `inventoryRevision` containing only counts, canonical
   dates/paths, stable IDs when already known, safe classifications and
   non-secret generation/provenance. A rescan never edits the reviewed
   snapshot: it creates the next revision and marks new or changed rows
   `CONSENT_REQUIRED`.
2. The user reviews one revision and grants independent action scopes. The
   exact scopes are `MIGRATE_PRIMARY`,
   `REMOVE_VERIFIED_LEGACY_PRIMARY`, `CLEAN_PRIVATE_SQLITE`,
   `IMPORT_DRAFT`, `DISCARD_DRAFT`, `DISCARD_AI_SESSION`,
   `RETAIN_AI_HISTORY`, `BIND_FRONTMATTER_IDENTITY` and
   `ACKNOWLEDGE_GIT_RETENTION`. Each destructive
   scope is bound to the vault, run, reviewed `inventoryRevision`, exact item
   identity and reviewed generation; no run-level boolean authorizes a later
   row or generation. Git retention and policy-retained AI history are
   explicit acknowledgements, not cleanup permission.
3. The workflow requests Diary unlock immediately before body migration or
   AI-content classification. Locked users can leave the workflow, rescan, or
   review safe Git/IDB/SQLite/AI counts and opaque IDs; they never see body or
   message text.
4. Progress is per item and per auxiliary store. No title, summary, tag,
   frontmatter, body length, body hash, snippet, message content or raw error
   is displayed. A generation or row change invalidates only the affected
   action consent and requires review in the new revision.
5. Rows needing identity adoption, draft/AI disposition, deferred
   authentication or external repair show `NEEDS_ATTENTION` (or the exact
   pending state below). They remain retained until an explicit action; the
   run cannot silently mark them complete.

The Settings workflow exposes `migrationFinalizeCapability` structurally with
ordinary-user wording: Windows may show **Ready for automatic encrypted
migration**; Linux/macOS show **Encrypted replacement prepared — manual
finalize required**; and an unavailable candidate path shows an unsupported
message. The UI explains why Nuvyn stopped, which file-only operation is
required, why external editors/sync writers must be closed, what Nuvyn will
verify afterwards and what user-controlled plaintext residual may remain. It
does not display kernel/API terminology.

### 7.2 Explicit item actions

The only body-bearing legacy Draft/Recovery actions are:

- `import-to-primary`: after unlock, check current encrypted primary identity
  and CAS baseline, then save through the normal D8.2 encrypted owner. Delete
  the exact IDB family only after verified save.
- `discard-draft`: requires the exact typed confirmation
  `DISCARD LEGACY DIARY RECOVERY`. It conditionally deletes the exact primary
  and conflict rows in one IndexedDB transaction. A missing or changed row is
  not deleted.

For a `LEGACY_DIARY_AI_HISTORY` item, the only destructive action is the
separately confirmed `discard-ai-session`. It deletes the whole affected AI
session through the existing session/message owner in one identity-bound
SQLite transaction; it never edits selected substrings. The alternative
`retain-ai-history` records an explicit policy-retained private residual and
leaves the whole session unchanged. Ordinary AI sessions and mixed sessions
without a provable structured managed-Diary tool result are not guessed at or
partially redacted.

For `METADATA_MISSING`, the only action is `adopt-metadata`, which creates the
minimal structural identity described in §11 after canonical date validation.
Adoption does not bind an existing `metadata_migrations` row whose
`document_id` is `NULL`. Such a row is
`FRONTMATTER_IDENTITY_UNRESOLVED` until a separately consented, non-destructive
identity-binding transaction proves the exact legacy generation and row CAS;
binding never clears the backup. For malformed, unknown, external,
missing-primary, deferred-auth or null-identity items, the action is
`acknowledge-attention` or `retry-item` after the user has repaired the
external condition; acknowledgement does not make the item `COMPLETE`.

For a legacy primary on Linux/macOS, the explicit action is
`user-finalize-required`. The UI shows the durable ciphertext candidate and
the exact file-only procedure from §9.1d; it never performs the replacement or
executes an operating-system command. While the item is pending, structural
status is allowed but body display while locked, managed-Diary search/AI/
History/LinkIndex and automatic save remain blocked. Resume performs only the
independent verification contract; the candidate is not parsed as the primary
before exact authenticated proof. Windows may use the automatic path only
when `AUTOMATIC_HANDLE_BOUND` is selected.

There is no automatic external export flow in D8.4. A user may use the normal
explicit PDF/clipboard export surface while unlocked, but that copy is outside
the migration guarantee and is not used as a cleanup proof.

### 7.3 Completion screen

Completion reports separate counts for `COMPLETE` (resolved/cleaned),
`ALREADY_ENCRYPTED_VALID` (valid encrypted no-op),
`USER_FINALIZE_REQUIRED`, policy-retained private state (including
acknowledged AI history), and `NEEDS_ATTENTION` (unresolved current
Nuvyn-controlled state). It separately lists policy-retained local Git
history, `USER_CONTROLLED_PLAINTEXT_RESIDUAL` and external/uncontrolled copies.
It states exactly which current Nuvyn-controlled stores were cleaned; it never
says “all plaintext removed” when any retained, pending or unresolved category
remains.

## 8. Managed-file classification

Classification runs before generic Markdown/frontmatter/link parsing. It uses
the canonical extensionless logical path and a symlink-safe structural read.
The exact item classifications are:

```text
ALREADY_ENCRYPTED_VALID
LEGACY_PLAINTEXT
ENCRYPTED_MALFORMED
ENCRYPTED_UNKNOWN_VERSION
ENCRYPTED_IDENTITY_MISMATCH
METADATA_MISSING
METADATA_AMBIGUOUS
PRIMARY_MISSING
EXTERNAL_PATH_CONFLICT
MIGRATION_IN_PROGRESS
CLEANUP_PENDING
RECOVERY_AUTH_REQUIRED
DURABILITY_PENDING
CONSENT_REQUIRED
USER_FINALIZE_REQUIRED
UNSUPPORTED
LEGACY_DIARY_AI_HISTORY
FRONTMATTER_IDENTITY_UNRESOLVED
NEEDS_ATTENTION
```

Rules:

1. A file with the V1 magic is never treated as plaintext. An unlocked body
   operation verifies version, bounded envelope fields, tag and AAD using the
   current identity. A locked startup may inspect only non-secret structure;
   it must not call a syntactic envelope `valid` or advance to `PUBLISHED`.
   Valid V1 is a strict no-op only after authenticated verification; any
   failure maps to the corresponding encrypted/attention class.
2. A regular file with no envelope magic is `LEGACY_PLAINTEXT`, but only after
   the path is exactly a valid Diary date and the file is not a symlink.
3. Missing `DocumentMetadata` is `METADATA_MISSING`, not permission to guess an
   ID. A row at the same path with a different ID, two rows claiming the same
   physical generation, or a row whose ID is used at another path is
   `METADATA_AMBIGUOUS`.
4. A metadata row without its primary is `PRIMARY_MISSING`; D8.4 does not
   synthesize a body. An occupied path whose generation is not the classified
   generation is `EXTERNAL_PATH_CONFLICT`.
5. An active journal/ledger item for the same stable tuple is
   `MIGRATION_IN_PROGRESS`; a target that may have been published but cannot
   yet be authenticated after a locked restart is
   `RECOVERY_AUTH_REQUIRED`; a required filesystem durability boundary that
   has not been proven is `DURABILITY_PENDING`; a new or changed row after a
   reviewed snapshot is `CONSENT_REQUIRED`; a durable ciphertext candidate
   whose POSIX source remains in place is `USER_FINALIZE_REQUIRED`; and a
   previously published item whose cleanup did not finish is
   `CLEANUP_PENDING`.
   A durable candidate with `migrationFinalizeCapability=USER_FINALIZE_REQUIRED`
   is reported as that real pending state rather than as a generic concurrent
   `MIGRATION_IN_PROGRESS`; the latter is reserved for a second operation
   attempting to own the same run/item.
6. A structured legacy AI `read_file` tool-result envelope naming an exact
   managed path is `LEGACY_DIARY_AI_HISTORY`. Free-text resemblance is not
   sufficient. A `metadata_migrations` row with `document_id IS NULL` is
   `FRONTMATTER_IDENTITY_UNRESOLVED` and cannot be cleaned by path equality.

Classification uses bounded reads and may use byte length transiently for an
I/O limit, but byte length is private body metadata and is not persisted,
returned in locked status, logged or displayed. It does not store a persistent
body hash. Plaintext equivalence hashes, when needed, are transient memory
values; a ciphertext fingerprint used for transaction provenance is internal
and non-secret and is never returned as a locked projection.

## 9. Primary plaintext migration contract

### 9.1 One-document protocol

`DiaryMigrationService` uses a narrowly scoped protocol because the generic
`prepareAtomicTextWrite` path stages the old generation under a durable
`.nuvyn-staged-*` name. Reusing it for a plaintext Diary would create a new
plaintext artifact. Every security-critical filesystem operation is owned by
one exact abstraction, `DiaryMigrationFs`; the service never calls a generic
pathname `rename`, copy, delete or alternate path directly. The migration protocol
is:

1. Canonicalize and validate the managed path, reject symlinks/reparse points
   and capture the vault directory identity through `DiaryMigrationFs`.
2. Resolve one stable `documentId`. For a missing row, stop at
   `METADATA_MISSING` until the user performs `adopt-metadata`; do not encrypt
   first. Validate the current immutable inventory revision and the action
   scopes `MIGRATE_PRIMARY` and `REMOVE_VERIFIED_LEGACY_PRIMARY`.
3. Acquire the existing `withVaultMutation` ownership, vault structure lock,
   sorted `withDocumentWriteLock`, and a `withDiaryBodyOperation` lease. The
   order is vault mutation -> structure lock -> document lock -> body lease;
   no second global lock is introduced.
4. Ask `DiaryMigrationFs.captureSourceGeneration()` for structural source
   generation evidence (and, only on the Windows automatic path, the live
   source/parent handles). A transient byte count may enforce a bounded read
   but is never durable or visible. Read plaintext only into the authorized
   operation's memory.
5. Encrypt with the existing lease-local `operation.encrypt` and the exact
   `BodyContext` (`vaultId`, `documentId`, canonical path). The service never
   receives or persists a raw DEK.
6. Authenticate the ciphertext immediately with `operation.decrypt`, verify
   exact plaintext equivalence in memory, and verify documentId, vaultId,
   canonical path and V1 envelope version.
7. Write only ciphertext to the same-directory reserved candidate
   `.nuvyn-diary-migration-ciphertext-<transactionId>` through
   `DiaryMigrationFs.writeCiphertextTemp()`. The candidate is same-filesystem,
   ciphertext-only, excluded from tree/search/LinkIndex/History/Note parsing,
   and safe to retain across restart. File and required parent-directory
   durability are recorded; the journal contains only structural names,
   generation/provenance (never size), phase and codes.
8. Revalidate the canonical source generation against the reviewed
   `inventoryRevision` and candidate preparation snapshot. If it changed,
   return `CONSENT_REQUIRED` / `diary-migration-consent-required`, retain the
   legacy canonical plaintext and candidate, and require a new unlock/review;
   the old candidate never authorizes the new generation.
9. Select the frozen `migrationFinalizeCapability` before any destructive
   action. Windows on a filesystem that supports the reviewed handle contract
   may continue with `AUTOMATIC_HANDLE_BOUND`. Linux and macOS on supported
   stock filesystems always transition to `USER_FINALIZE_REQUIRED`; Nuvyn
   performs no source rename, unlink, restore or replacement there. A
   filesystem that cannot safely prepare and durably verify the ciphertext
   candidate is `UNSUPPORTED`; a Windows adapter that loses its handle-bound
   guarantee falls back to `USER_FINALIZE_REQUIRED`, never to a pathname
   fallback.
10. For `AUTOMATIC_HANDLE_BOUND`, the Windows adapter performs the reviewed
    captured-source-handle, fail-if-exists transition and create-only
    ciphertext publication, then verifies the target and required durability.
    For `USER_FINALIZE_REQUIRED`, release the body lease and migration locks
    after candidate durability, persist the state and stable code
    `diary-migration-user-finalize-required` (HTTP 409), and perform no
    destructive plaintext namespace mutation. The candidate is not the
    authoritative primary before user-finalize verification.
11. The explicit user-finalize procedure is: stop Nuvyn body mutation for the
    item; close external editors/sync writers; replace the legacy canonical
    file with the prepared ciphertext candidate using the documented
    user-controlled file operation; disclose any separately retained plaintext
    copy; then reopen/resume Nuvyn verification. Nuvyn never exposes envelope
    fields or asks the user to decrypt, re-encrypt, edit, copy body text or
    execute a Nuvyn shell command.
12. On resume or restart, Nuvyn independently verifies the canonical path is
    a regular non-symlink/non-reparse file and that its bytes have the exact
    prepared ciphertext fingerprint. It then authenticates the V1 envelope
    with vault/document/path AAD under the existing Diary body lease. A new
    inode after manual replacement is expected; same-inode continuity is not
    required. Only exact fingerprint plus authenticated identity may advance
    the item to `PUBLISHED`/`CLEANUP_PENDING`.
13. After verified publication and the revision-bound SQLite, Draft/Recovery
    and AI dispositions, Windows may remove its owned plaintext quarantine by
    the reviewed handle contract. Linux/macOS may clean only Nuvyn-owned
    ciphertext candidate, journal, SQLite/IDB/AI state and other auxiliary
    artifacts; they never locate or delete a user-moved plaintext backup.
    `COMPLETE` is permitted only after all required cleanup gates, consent
    checks and no-new-plaintext checks succeed. A retained backup is recorded
    as `USER_CONTROLLED_PLAINTEXT_RESIDUAL` and prevents any universal-erasure
    claim.

The migration service must not call generic plaintext
`atomicReplaceTextIfUnchanged`, `atomicRemoveTextIfUnchanged`, recovery payload
writers, rename-reference journals or generic delete staging. It must not
expose an endpoint that runs `mv`, `rename` or `rm` for the user. On
Linux/macOS the only Nuvyn-controlled filesystem write to the legacy primary
workflow is ciphertext-candidate preparation; the final destructive file
operation remains explicitly user-mediated and is verified after the fact.

### 9.1a Finalize capability and threat-model boundary

The migration service selects one immutable `migrationFinalizeCapability` for
each item before any destructive action:

```text
AUTOMATIC_HANDLE_BOUND
USER_FINALIZE_REQUIRED
UNSUPPORTED
```

The capability is structural state, not an implementation-time choice:

| Platform/filesystem result | Capability | Nuvyn behavior |
| --- | --- | --- |
| Windows adapter proves the reviewed captured-source-handle, fail-if-exists and durability contract | `AUTOMATIC_HANDLE_BOUND` | Nuvyn may perform the automatic plaintext transition and encrypted publication. |
| Linux or macOS stock filesystem can safely prepare and durably verify a ciphertext candidate but exposes no accepted captured-source conditional namespace mutation | `USER_FINALIZE_REQUIRED` | Nuvyn prepares the candidate and stops before destructive plaintext namespace mutation. |
| Any platform/filesystem cannot safely create, authenticate and durably retain the ciphertext candidate | `UNSUPPORTED` | No migration mutation; retain the legacy source and structural journal with a stable unsupported code. |
| A Windows filesystem/runtime loses a required handle-bound guarantee | `USER_FINALIZE_REQUIRED` | Fall back to the same manual workflow; never use a pathname fallback. |

Nuvyn guarantees race-safe behavior only for mutations Nuvyn itself performs.
It cannot provide a kernel compare-and-swap primitive that the host does not
expose. A user-mediated filesystem change is verified after the fact and is
never represented as a Nuvyn-atomic operation. No userspace helper, native
addon, advisory lock, watcher, lease or timing window may manufacture missing
namespace atomicity.

The four authority domains remain distinct:

| Authority | Contents | Permitted proof |
| --- | --- | --- |
| Logical identity | `vaultId`, `documentId`, canonical logical path, schema version | Selects the migration item and the D8.2 AAD tuple only. |
| Filesystem generation identity | device/volume, inode/file ID, parent identity and available structural generation evidence | Identifies the generation observed during inventory or candidate preparation; never grants destructive authority. |
| Nuvyn automatic mutation authority | A captured source/parent handle pair consumed by the Windows native operation, only for `AUTOMATIC_HANDLE_BOUND` | Authorizes one exact Windows namespace mutation while the process owns the handles. It does not apply to Linux/macOS manual finalize. |
| User-finalize verification authority | Durable candidate fingerprint plus authenticated V1 envelope and current structural checks | Proves what canonical bytes exist after the external user action; it cannot prove that an external process did not alter another generation during that action. |

A pathname, prior `lstat`/`stat`, matching inode metadata, process token or
directory lock is never destructive authority. On Linux/macOS Nuvyn therefore
does not attempt to rename, unlink, restore, replace or quarantine the legacy
plaintext primary automatically.

### 9.1b Linux/macOS migration phases

For `USER_FINALIZE_REQUIRED`, the exact transaction is:

**Phase A — inventory.**

1. Canonicalize the managed path with the shared Diary classifier and reject
   symlink/reparse traversal.
2. Resolve stable `DocumentMetadata` and record an immutable
   `inventoryRevision`.
3. Capture the current primary generation structurally and require explicit
   `MIGRATE_PRIMARY` consent tied to that revision and generation.
4. Obtain the existing Diary body lease and read legacy plaintext only into
   authorized memory. No destructive namespace mutation occurs.

**Phase B — ciphertext preparation.**

5. Encrypt with the existing server-side Diary access owner and immediately
   authenticate the result with the same lease and D8.2 AAD.
6. Create a same-filesystem, ciphertext-only candidate named
   `.nuvyn-diary-migration-ciphertext-<transactionId>` with create-only
   semantics. The name is excluded from tree, search, LinkIndex, History,
   Note parsing and automatic body mutation.
7. Fsync the candidate file and required parent directory. Record only the
   candidate generation, durability result and internal ciphertext fingerprint
   in the structural journal; never record body size, body hash, plaintext or
   keys.
8. Re-read/revalidate the canonical source generation against the reviewed
   snapshot before handoff. If it changed, mark `CONSENT_REQUIRED` with
   `diary-migration-consent-required`, retain both generations and require a
   new unlock/review. The old candidate never authorizes the new source.

**Phase C — handoff.**

9. Persist item state `USER_FINALIZE_REQUIRED`, HTTP/API code
   `diary-migration-user-finalize-required`, the candidate fingerprint and
   candidate durability. Release the body lease and migration mutation locks
   according to the existing epoch/quiescence rules.
10. Nuvyn performs no source rename, unlink, restore, overwrite or shell
    command on Linux/macOS. The canonical legacy plaintext remains the
    authoritative primary until a user action is independently verified.

The workflow is safe to resume because it creates only the existing plaintext
primary plus one ciphertext candidate. It never creates a plaintext staging
file, rollback payload, quarantine copy or backup.

### 9.1c Source-backed platform decision record

The Round 3 decision is based on the public platform contracts, not on a
native wrapper name. The relevant references are Linux
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

**Linux.** `renameat2` selects its source by directory fd plus source
pathname; `RENAME_NOREPLACE` protects only the destination. `openat2` and
`O_PATH|O_NOFOLLOW` are retained for safe candidate-path resolution and
structural inspection. `open_by_handle_at` can reopen an object on some
filesystems with additional privilege, but it does not provide rename-by-file
handle or unlink-by-file-handle namespace mutation. Therefore Linux uses
`renameat2(RENAME_NOREPLACE)` only to publish the Nuvyn-created ciphertext
candidate and never uses it to move or delete the legacy plaintext.

**macOS.** `renameatx_np`/`rename` likewise select the source by parent fd plus
pathname; exclusive-destination flags protect the destination only. Public
file-handle reopening does not supply a captured-vnode conditional rename or
unlink operation accepted by this plan. `openat(..., O_NOFOLLOW)` and `fstat`
are retained for safe candidate resolution and structural checks; a
create-only `renameatx_np(RENAME_EXCL)` may publish the ciphertext candidate,
but Nuvyn never destructively mutates the legacy plaintext namespace.

**Windows.** The reviewed automatic path remains feasible: reparse-safe
`CreateFileW` opens the source and parent without `FILE_SHARE_DELETE`,
`GetFileInformationByHandleEx(FileIdInfo)` captures identity, and
`SetFileInformationByHandle(FileRenameInfoEx)` operates on the captured source
handle with the captured parent as `RootDirectory` and replace-if-exists
omitted. Ciphertext publication is independently fail-if-exists and all
required file/parent durability barriers must succeed. If any required flag,
handle or filesystem guarantee is unavailable, the adapter selects
`USER_FINALIZE_REQUIRED` rather than a pathname fallback.

Stable outcomes are `SOURCE_GENERATION_CHANGED`,
`PARENT_GENERATION_CHANGED`, `TARGET_OCCUPIED`, `CONSENT_REQUIRED`,
`USER_FINALIZE_REQUIRED`, `FILESYSTEM_UNSUPPORTED`, `CROSS_DEVICE`,
`SOURCE_BUSY`, `DURABLE`, `DURABILITY_UNKNOWN` and `DURABILITY_FAILED`.
Linux/macOS candidate preparation maps failed/unknown fsync or an unsafe path
to `FILESYSTEM_UNSUPPORTED`/`DURABILITY_PENDING`; no such result is a
permission to touch the plaintext source. Windows preserves the existing
handle-bound error mappings for its automatic path.

### 9.1d Exact user-finalize protocol and verification

The UI exposes one explicit, platform-neutral user-finalize procedure for a
`USER_FINALIZE_REQUIRED` item. It is available only when all of these
preconditions hold: the item is in `USER_FINALIZE_REQUIRED`; the candidate
fingerprint and generation are durably recorded; the canonical generation is
the reviewed generation; candidate file and parent durability are proven; and
no Nuvyn body operation for the item is active. Immediately before showing the
procedure, Nuvyn rescans and invalidates stale consent rather than relying on
the earlier snapshot.

The user is instructed to: (1) stop Nuvyn body mutation for the item; (2) close
external editors and sync writers touching the managed path; (3) replace the
legacy canonical file with the prepared ciphertext candidate using the
documented OS file operation; (4) keep or remove any old plaintext copy only
under the user's explicit procedure and acknowledge that residual; and (5)
reopen/resume Nuvyn verification. The user manipulates filenames/files only.
Nuvyn never asks the user to decrypt, re-encrypt, edit an envelope, copy body
text, paste plaintext, modify nonce/tag/AAD or run a Nuvyn shell command.

On resume/restart Nuvyn independently verifies, in this order:

1. the canonical path is present, regular, canonical and not a symlink or
   reparse point;
2. the bytes have the exact prepared ciphertext fingerprint for this
   transaction (no other valid encrypted generation is accepted);
3. the authenticated V1 envelope has the expected vault/document/path identity
   and version and passes AES-GCM/AAD authentication under the existing Diary
   body lease; and
4. the resulting ciphertext and required parent-directory durability are
   proven before the durable `PUBLISHED` journal phase is written.

The final file may have a new inode/generation; same-inode continuity is not
required after an external replacement. The exact candidate fingerprint plus
authenticated envelope is the sole acceptance rule. The result classes are:

| Observed canonical state | Exact result | Nuvyn action |
| --- | --- | --- |
| Still the reviewed plaintext generation | `USER_FINALIZE_REQUIRED` / `diary-migration-user-finalize-required` | Keep candidate and plaintext; do not publish or clean. |
| New plaintext generation detected before verification | `CONSENT_REQUIRED` / `diary-migration-consent-required` | Invalidate old consent and candidate acceptance; require a new reviewed preparation after unlock. |
| Exact prepared ciphertext fingerprint and authenticated identity | `PUBLISHED` then applicable cleanup | Advance only after durability and all action-scoped cleanup gates. |
| Different valid encrypted bytes | `NEEDS_ATTENTION` / `diary-migration-candidate-mismatch` | Preserve the file and candidate; never treat another ciphertext as this transaction. |
| Malformed or unknown envelope | `NEEDS_ATTENTION` / existing malformed/unknown code | Preserve bytes; no overwrite or cleanup. |
| Missing canonical file | `NEEDS_ATTENTION` / `diary-migration-primary-missing` | Preserve candidate and journal; do not synthesize a primary. |
| Symlink/reparse, wrong path identity or unsafe type | `NEEDS_ATTENTION` / `diary-migration-unsafe-path` | Preserve the object and all artifacts. |

If a user installs a stale candidate after an external writer created a new
plaintext generation, Nuvyn can detect the conflict only when the new
generation is observed before acceptance. Once the user has externally
replaced the canonical path, Nuvyn cannot reconstruct bytes that were lost or
prove that an external process did not change another generation during the
manual operation. This is disclosed as a user-mediated residual risk, not as
an automatic external-generation guarantee.

### 9.1e Candidate cleanup, restart and external-writer semantics

On Linux/macOS, restart never needs plaintext quarantine reacquisition because
Nuvyn has not moved the plaintext source. Durable state contains the legacy
canonical generation (if still present), the ciphertext candidate name and
generation, candidate fingerprint, inventory revision, transaction, phase and
durability. It contains no body, size, plaintext digest, key, capability or
message content.

The restart/crash oracle is:

| Event | Required result |
| --- | --- |
| Crash before candidate durability | Legacy plaintext remains authoritative; a partial candidate may be removed only by exact transaction-owned ciphertext provenance, then preparation may retry. |
| Candidate durable, then crash before handoff | Candidate remains durable and the item restores to `USER_FINALIZE_REQUIRED`; plaintext is untouched. |
| User completes external replacement, then crash before resume | Fresh process inspects actual canonical state and restores `USER_FINALIZE_REQUIRED` or the exact conflict class; it never assumes the user action occurred. |
| Exact candidate is authenticated after resume | Advance to `PUBLISHED`, then clean only Nuvyn-owned candidate/journal/SQLite/IDB/AI artifacts under the reviewed gates. |
| User retains a moved/copied plaintext backup outside the canonical managed path | Record `USER_CONTROLLED_PLAINTEXT_RESIDUAL`; disclose it and never search for or delete it automatically. |

The manual operation is not wrapped in a Nuvyn crash hook. The deterministic
test controller performs the documented external file operation, then kills
the child before `resume`; restart verifies the actual namespace. The existing
19-hook oracle remains authoritative for the automatic Windows path and for
SQLite/IDB cleanup. On POSIX, source-transition, ciphertext-publication and
plaintext-quarantine-unlink hooks are marked not applicable rather than
simulated around the user action; candidate durability and post-user
verification use the applicable candidate/readback/journal hooks.

The cross-platform security outcome is identical even though the filesystem
algorithm differs: Nuvyn never destroys an unproven external generation. On
Linux/macOS it achieves this by refusing the unsupported automatic destructive
operation; on Windows it uses the real captured-handle contract.

The `USER_FINALIZE_REQUIRED` state is not `PUBLISHED`, `CLEANUP_PENDING` or
`COMPLETE`. While it exists, structural migration status is allowed, Diary
body display while locked is forbidden, managed-Diary search/AI/History/
LinkIndex remains blocked, automatic save for that item is blocked, and any
resume that needs body verification requires unlock. Its only forward path is
the exact user-finalize verification in §9.1d or an explicit new scan that
invalidates the stale candidate.

### 9.2 Commit point and monotonicity

The security meaning of publication is platform-specific but the safety result
is common. For `AUTOMATIC_HANDLE_BOUND` Windows migration, the linearization
point is the create-only ciphertext publication syscall: after it may have
succeeded, plaintext is never restored to the canonical path and the target is
never overwritten. `PUBLISHED` still requires exact target fingerprint,
authenticated V1/AAD readback and all required durability barriers.

For `USER_FINALIZE_REQUIRED`, durable candidate preparation is not publication
and does not make the candidate authoritative. The legacy canonical plaintext
remains authoritative until the user performs the documented external file
replacement. Nuvyn then verifies the actual canonical bytes and writes
`PUBLISHED` only after exact fingerprint, identity, authentication and
durability proof. Nuvyn never performs the external replacement itself and
never claims that the manual operation had Nuvyn's automatic race guarantee.

Before candidate durability, a failed preparation may remove only the
transaction-owned ciphertext candidate. After candidate durability, restart
retains the candidate and returns `USER_FINALIZE_REQUIRED`; it never recreates
plaintext, copies plaintext or treats the candidate as the primary. After
verified publication, cleanup is forward-only. A candidate still present at
its reserved name may be removed only by the transaction-owned ciphertext
cleanup operation after exact fingerprint verification; a separately moved
plaintext backup is never searched for or removed.

The migration journal stores only transaction ID, canonical identity,
inventory revision, candidate/target generation, internal ciphertext
fingerprint, capability, phase and durability. It never stores body bytes,
body size, plaintext digest, keys, capabilities or message content. Locked
status never returns the fingerprint or generation details.

### 9.3 External-writer and save contract

For every Nuvyn-controlled automatic action, an unproven external generation
always wins and is never deleted, overwritten, renamed or replaced by Nuvyn:

| Race | Required result |
| --- | --- |
| Edit before classification or encryption | Reclassify the new generation; the old consent and candidate are stale. |
| Edit during Linux/macOS candidate preparation | Stop before handoff with `CONSENT_REQUIRED`; retain the legacy source and candidate, and require a new reviewed preparation. |
| Candidate name occupied or candidate durability fails | Preserve the occupant/artifacts; return `TARGET_OCCUPIED`, `DURABILITY_PENDING` or `FILESYSTEM_UNSUPPORTED`; never overwrite. |
| Windows source/parent/target race during automatic finalize | Use only the real captured-handle and create-only operations; return the frozen generation/occupied/busy outcome and preserve the external generation. |
| Canonical remains plaintext after user handoff | Remain `USER_FINALIZE_REQUIRED`; no Nuvyn mutation or cleanup. |
| New plaintext generation observed before user verification | `CONSENT_REQUIRED`; invalidate the old preparation and require a new unlock/review. |
| User installs the exact candidate after an unobserved external change | Authenticate and accept only the exact candidate, but disclose that Nuvyn cannot prove the lost/changed external generation was not affected by the user-mediated operation. |
| Canonical is a different encrypted file, malformed, missing or unsafe | `NEEDS_ATTENTION` with the exact stable code; preserve the file and candidate. |
| User retains a plaintext backup outside the managed path | Record `USER_CONTROLLED_PLAINTEXT_RESIDUAL`; never auto-search or delete it. |

While an item is `USER_FINALIZE_REQUIRED`, ordinary managed-Diary save for
that item is blocked, and the UI exposes only structural migration status and
the explicit finalize instructions. Search, AI, History, LinkIndex, locked
body display and automatic save remain blocked by the existing D8.3 managed-
Diary boundary. A user-finalize resume requires unlock for body
authentication. Ordinary Note save/create/history/search/Draft behavior is
unchanged. A FIFO document lock still serializes Nuvyn operations; it is not a
substitute for filesystem authority and does not produce a migration-specific
409 merely because another operation is queued.

The threat-model boundary is explicit: Nuvyn guarantees race-safe behavior
for mutations it performs. Linux/macOS manual replacement belongs to the
user-controlled filesystem trust boundary and is verified after the fact.
If the product requires Nuvyn itself to replace arbitrary POSIX plaintext
while guaranteeing exact-generation movement against a non-cooperating
external writer, the current architecture cannot satisfy that requirement;
filesystem mediation, managed storage or a changed threat model would require
a separately approved architecture.

## 10. Legacy Draft/Recovery contract

The actual legacy store is IndexedDB database `nuvyn-draft-recovery`, version
2, with object stores `drafts` (key `[vaultId, documentId]`, index
`vaultUpdatedAt`) and `draftConflicts` (key `[vaultId, documentId, conflictId]`,
index `vaultId`). `UnsavedDraft` and `DraftConflictRecord` both contain a
`content` field. `useUnsavedDraftPersistence` already blocks new managed-path
writes and deliberately leaves old managed rows for D8.4; `useUnsavedDraftRecovery`
filters managed rows from ordinary recovery and `clearSensitiveState` fences
their in-memory classifiers; `useDraftRecoveryManagement` excludes them from
automatic cleanup.

D8.4 does not add a new encrypted store. The migration service asks the client
owner for a structural inventory while locked, and a body-bearing decision
only after unlock. A valid row must match one stable `(vaultId, documentId,
canonicalPath)` and a current server identity before it can be imported. The
import path writes through the ordinary D8.2 encrypted save/CAS owner; it never
serializes the row into SQLite or a migration ledger. On verified success, a
single IndexedDB read/write transaction conditionally removes the exact primary
and all selected conflict rows. A crash before that transaction leaves the row
for a safe idempotent rerun.

Every import or discard is authorized by an `inventoryRevision`-bound
`IMPORT_DRAFT` or `DISCARD_DRAFT` consent for the exact `(vaultId, documentId,
canonicalPath, draftFamilyGeneration)` snapshot. A rescan or changed family
creates `CONSENT_REQUIRED`; an earlier run or typed phrase cannot authorize the
new row. `RECOVERY_AUTH_REQUIRED` also blocks import until cryptographic
reconciliation completes. The server reconstructs the current family and
conditional CAS; client-provided item keys or tokens are not authorization.

Ambiguous identity, split family paths, malformed/future-version rows, missing
primary, changed baseline or an unavailable IndexedDB transaction is
`NEEDS_ATTENTION`; it is never guessed or silently deleted. Typed discard uses
conditional deletion and preserves any row changed by another context.

While locked, UI may show only count, canonical path/date, documentId when
already present, record kind and status. Body, original content, conflict
content, recovery tabs, search, AI, clipboard and PDF are prohibited. Lock,
logout, expiry and capability replacement synchronously fence managed recovery
classification and clear managed in-memory buffers; Note recovery remains
unchanged.

### 10.1 Durable AI history disposition

The SQLite `sessions` and `messages` stores from migration `0001_ai_history`
are first-class D8.4 inventory entries. The service parses only the persisted
structured message/tool envelope under the existing AI message owner. A
`read_file` tool identity, an exact canonical managed path and a structured
result are required to classify a message as `LEGACY_DIARY_AI_HISTORY`;
arbitrary user/assistant text that merely resembles a Diary entry is not
evidence. Classification that inspects message content requires an unlocked
Diary body operation, is never rendered to the user and never copies content
to the ledger, logs or status.

An affected session is hidden from ordinary AI history while locked; locked
status may show only bounded counts and opaque session/message IDs. After
unlock, the user chooses one independent action bound to the reviewed session
snapshot: `discard-ai-session` (explicit confirmation, whole-session delete
through `server/ai/messages.ts` in one identity-bound SQLite transaction) or
`retain-ai-history` (whole session remains as a Nuvyn-controlled
policy-retained private residual). Mixed sessions are never substring-edited.
The default without a choice is `NEEDS_ATTENTION`; no silent redaction or
whole-session deletion occurs. Ordinary AI history without provable managed
Diary evidence is unchanged.

## 11. SQLite/private metadata contract

SQLite cleanup occurs only after encrypted primary publication, under
`withVaultMutation`, the relevant document locks, and one `BEGIN IMMEDIATE`
transaction. The stable document ID is preserved. The exact field policy is:

| Field/table | D8.4 action for managed Diary | Note behavior |
| --- | --- | --- |
| `documents.id`, `path`, `created_at`, `updated_at`, `mood` | Preserve; normalize path to the canonical date. Mood remains the structural Calendar value. | Unchanged. |
| `documents.title` | Set to canonical `YYYY-MM-DD`; never rederive from body. | Unchanged. |
| `documents.summary` | Clear to `''`; never copy into the encrypted body automatically. | Unchanged. |
| `sessions`, `messages.content` | Classify only structured managed-Diary `read_file` tool-result exposures. Apply explicit whole-session `discard-ai-session` or `retain-ai-history`; no substring rewrite and no deletion based on free text. | Ordinary sessions without provable managed-Diary evidence unchanged. |
| `document_tags` | Delete associations whose `document_id` is managed. | Associations and shared tag rows remain. |
| `tags` | Delete only rows with no remaining Note or other association. | Shared rows retained. |
| `document_embeddings` | Delete managed rows. | Unchanged. |
| `metadata_migrations` | A `NULL document_id` row is retained as `FRONTMATTER_IDENTITY_UNRESOLVED`; after separately verified identity binding, exact non-null ID/path/CAS plus `PUBLISHED` and no rollback dependency are required before clearing backup/hashes/error and setting `status='cleaned'`. | Unchanged. |
| `history_metadata_revisions` and restore journal | Delete rows proven to reference the managed ID/path, including `before_raw`, `target_raw`, payload and body SHA. | Unchanged. |
| `history_metadata_operations` | Delete a managed-only operation after its child rows are removed. A mixed operation that cannot be separated is retained and marked `NEEDS_ATTENTION`. | Unchanged. |
| `history_metadata_document_tombstones` | Retain identity/path-only tombstones. | Unchanged. |
| `tag_undo_association_deltas` | Delete deltas proven to reference managed IDs. | Unchanged. |
| `tag_undo_records` | Delete records whose deltas and bounded `operation_json` prove managed-only; mixed or invalid JSON is `NEEDS_ATTENTION`, never broad-deleted. | Unchanged. |
| `tag_undo_state` | Advance/retain state only through existing tag-undo owner; no body-derived field is added. | Unchanged. |
| migration ledger | Contains structural state only; no body, byte size, title/summary/tag value, backup, message content, plaintext hash or digest. It records inventory/consent revision, action scope, `migrationFinalizeCapability`, candidate/source/target generation provenance, internal ciphertext fingerprint and explicit user-residual state. Windows-only quarantine fields are nullable and never populated for POSIX. | No Note row is inserted. |

If SQLite cleanup fails after publication, the primary remains encrypted and
the ledger item is `CLEANUP_PENDING`. If cleanup succeeds but a later primary
step had not published, the ordering is invalid and implementation must stop;
the prescribed implementation never cleans SQLite before publication.

## 12. `frontmatter_backup` contract

`server/metadataMigration.ts` writes `metadata_migrations.frontmatter_backup`
for generic Notes; `server/frontmatterArchive.ts` reads it for preview/clean/
restore and deliberately skips managed Diary. Legacy managed rows are still a
first-class exposure. A row with `document_id IS NULL` is always
`FRONTMATTER_IDENTITY_UNRESOLVED` and `NEEDS_ATTENTION`; path equality alone
can never authorize binding or cleanup. `adopt-metadata` creates a current
DocumentMetadata identity but does not claim ownership of an old null-ID row.

If the user separately grants `BIND_FRONTMATTER_IDENTITY` for the reviewed
row/generation, D8.4 may perform a non-destructive binding transaction. It
selects the exact old row with `document_id IS NULL`, exact canonical path,
status, `source_hash`, `frontmatter_backup`, `cleaned_hash` and `updated_at`
CAS values; revalidates that the current source generation and migration item
are the legacy generation represented by that row; and sets only the stable
`document_id`. Binding never clears `frontmatter_backup`. If generation or CAS
proof is absent, the row remains retained attention.

Only after a non-null exact document ID, verified identity binding, primary
`PUBLISHED`, no rollback dependency and the same row CAS may D8.4 clear
`frontmatter_backup`, `source_hash`, `cleaned_hash` and error, set
`status='cleaned'`, and retain structural path/original-path fields in one
SQLite transaction. An already-cleaned row is a no-op. Ordinary Note rows and
the generic frontmatter archive contract are unchanged.

## 13. Git/history contract

D8.4 chooses the exact policy **disclose and retain; do not rewrite**. The
service performs a read-only inventory of:

1. current `HEAD` tree and index;
2. local branches and tags;
3. remote-tracking refs;
4. stash refs when present;
5. reachable commits/blobs;
6. reflogs; and
7. unreachable loose/packed objects discovered by `git fsck`.

The inventory reports only counts, refs, commit IDs and canonical managed
paths. It does not return blob text. D8.4 can control the current worktree and
the local repository's read-only report. It cannot control remote repositories,
other clones, filesystem backups, CI artifacts or a user's exported bundle.

No `filter-repo`, branch/tag rewrite, reflog expiry, object prune, destructive
backup or automatic `git push --force` is part of migration. Completion requires
the user acknowledgment of this retained legacy exposure. A future, separately
approved history-remediation feature would need its own scope, backup and
remote policy; it is not hidden inside D8.4.

## 14. Mixed-state and `NEEDS_ATTENTION`

Migration is per-document transactional with a vault-level aggregate. The
classifier converges the following states deterministically:

| State | Result |
| --- | --- |
| Fresh vault/no Diary | Run completes with zero items after Git/auxiliary inventory. |
| All valid encrypted | Every item is `ALREADY_ENCRYPTED_VALID`; bytes remain unchanged. |
| All legacy plaintext | Windows items may finalize automatically; Linux/macOS items prepare a candidate and remain `USER_FINALIZE_REQUIRED` until the explicit user operation is verified. |
| Mixed plaintext/encrypted | Plaintext items follow the selected platform capability; valid encrypted items no-op; aggregate waits for user-finalize, attention and cleanup. |
| Encrypted + malformed/unknown | Valid items no-op; invalid items remain `NEEDS_ATTENTION`; no plaintext interpretation. |
| Plaintext + missing metadata | Path/date is safe to show; item waits for explicit `adopt-metadata`. |
| Valid encrypted + stale metadata | AAD/ID mismatch is attention; metadata is not rewritten by path alone. |
| Primary missing + metadata exists | No body is created; `PRIMARY_MISSING` remains attention. |
| IDB only | Locked structural inventory; unlocked explicit import/discard; unresolved rows remain. |
| SQLite metadata only | Cleanup is independent but still requires identity and user confirmation. |
| Git history only | Disclosure/acknowledgment; no rewrite. |
| Cleanup pending/journal exists | Startup resumes forward from the durable phase; no plaintext rollback after a possible publication. If the target may be published but is not authenticated while locked, state is `RECOVERY_AUTH_REQUIRED`; no cleanup occurs. |
| Durable POSIX ciphertext candidate with canonical plaintext still present | `USER_FINALIZE_REQUIRED`; candidate is retained and excluded from all projections; no Nuvyn rename/unlink/restore/replace occurs. |
| New/changed row after reviewed scan | `CONSENT_REQUIRED`; the prior inventory revision/action scope cannot authorize it. |
| AI structured managed-Diary tool result | `LEGACY_DIARY_AI_HISTORY`; explicit whole-session discard or policy retention, otherwise attention. |
| Null-ID frontmatter backup | `FRONTMATTER_IDENTITY_UNRESOLVED`; retain until verified identity binding, never path-only cleanup. |
| Unsupported candidate durability or unsafe path | `UNSUPPORTED`, `DURABILITY_PENDING` or `NEEDS_ATTENTION`; retain journal/artifacts and never claim `PUBLISHED` without the required proof. |
| Orphan temp/staging artifact | Existing recovery handles generic artifacts; migration service handles only its reserved structural pattern and quarantines ambiguity. |
| External path reuse | External bytes win; migration artifacts are retained/quarantined and attention is surfaced. |
| Vault copied under a new identity | `getVaultId()` changes; all items are re-inventoried under the new vault tuple, and old ledger rows are not reused as proof. |

`NEEDS_ATTENTION` is explicit unresolved state, not success. The aggregate run
state is `ATTENTION_REQUIRED` while any item or required auxiliary decision is
unacknowledged. The user may explicitly acknowledge an attention item without
changing its item state; the item remains visible as `NEEDS_ATTENTION` and is
included in the completion summary. `COMPLETE` is permitted only when every
item is terminal (`COMPLETE`, valid-encrypted no-op, or explicitly
acknowledged `NEEDS_ATTENTION`), no item is still
`USER_FINALIZE_REQUIRED`, each policy-retained AI session is separately
acknowledged, and the Git-retention acknowledgment is recorded. A verified
POSIX finalize may reach `COMPLETE` even when a separately disclosed
`USER_CONTROLLED_PLAINTEXT_RESIDUAL` remains. The final summary distinguishes
resolved/cleaned state, valid encrypted no-op, policy-retained private AI
state, unresolved attention, pending user-finalize, policy-retained Git
history and external/uncontrolled copies.

## 15. Crash/restart semantics

The existing `recoverInterruptedOperations` and History metadata reconciliation
run before HTTP in both `server/prod.ts` and `server/vite-plugin.ts`. D8.4 adds
`DiaryMigrationService.recover` immediately after generic filesystem recovery
and before ordinary metadata scans. It never logs body bytes and never guesses
ownership.

At startup recovery uses only structural/non-secret evidence. On Linux/macOS
there is no plaintext quarantine to reacquire: the legacy canonical remains
authoritative and a durable ciphertext candidate restores
`USER_FINALIZE_REQUIRED`. A candidate or canonical file is never promoted by
syntax alone. After unlock, the existing `DiaryBodyOperation` revalidates the
exact candidate fingerprint, path identity and AES-GCM/AAD authentication;
only exact proof may advance to `PUBLISHED` or `CLEANUP_PENDING`. On Windows,
the automatic path retains its captured-handle quarantine/restart rules; if
exact reacquisition is unavailable it falls back to `USER_FINALIZE_REQUIRED`
before any weaker mutation. Any mismatch or missing provenance is
`NEEDS_ATTENTION`, with external bytes preserved.

The locked recovery matrix is frozen as:

| Case | Structural evidence | Locked result |
| --- | --- | --- |
| POSIX-A | Candidate absent or not durable; canonical legacy plaintext remains | Retry candidate preparation only after exact transaction ownership checks; no plaintext recovery is needed and no namespace mutation is attempted. |
| POSIX-B | Candidate durable; canonical remains the reviewed plaintext generation | Restore `USER_FINALIZE_REQUIRED`; preserve candidate and plaintext; no publish, restore, replace or cleanup. |
| POSIX-C | User may have replaced canonical path externally | Inspect actual canonical state on resume. Exact candidate + authenticated AAD may reach `PUBLISHED`; unchanged plaintext remains `USER_FINALIZE_REQUIRED`; all other states are the exact conflict/attention class. |
| WINDOWS-A | Target absent, pre-publication journal, exact owned source quarantine reacquired | Restore the same source object only through the reviewed Windows handle-bound operation and an empty destination; unavailable proof is `QUARANTINE_OWNERSHIP_UNPROVEN`/`NEEDS_ATTENTION`. |
| WINDOWS-B | Target exists and publication may have happened | Preserve target and quarantine; never restore plaintext or mark `PUBLISHED` from syntax; locked uncertainty is `RECOVERY_AUTH_REQUIRED`. |
| WINDOWS-C | Generation/provenance does not match transaction evidence | Preserve external target and every unproven artifact; `NEEDS_ATTENTION`; no cleanup. |

The deterministic crash oracle uses one authoritative set of **19 hooks**.
The same names and semantics appear in the Implementation Plan. The full set
is applicable to the automatic Windows path and to platform-independent
SQLite/IDB cleanup. On Linux/macOS, candidate preparation uses
`AFTER_JOURNAL_PREPARED` and `AFTER_CIPHERTEXT_TEMP_FSYNC`; post-user
verification uses `AFTER_AUTHENTICATED_READBACK`,
`BEFORE_PUBLISHED_JOURNAL`, `AFTER_PUBLISHED_JOURNAL` and the cleanup hooks.
`BEFORE_SOURCE_TRANSITION`, `AFTER_SOURCE_TRANSITION`,
`BEFORE_CIPHERTEXT_PUBLISH`, `AFTER_CIPHERTEXT_PUBLISH_SYSCALL`,
`AFTER_TARGET_DURABILITY`, `BEFORE_SOURCE_QUARANTINE_UNLINK`,
`AFTER_SOURCE_QUARANTINE_UNLINK_BEFORE_DIR_DURABILITY` and
`AFTER_SOURCE_QUARANTINE_DIR_DURABILITY` are explicitly **not applicable** to
the POSIX manual workflow; no fake seam is emitted around a user action. A
child Nuvyn server runs against an isolated temporary vault; at an applicable
hook it signals the parent, the parent terminates the child without graceful
cleanup, and a fresh process restarts against the same durable state. No
sleep, `waitForTimeout`, timing guess or random kill is evidence. The two
SQLite hooks explicitly cover the whole-session `DISCARD_AI_SESSION` operation
as mapped below.

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

For the quarantine-removal rows, the idempotent restart rule applies only to
the automatic Windows path: after
`AFTER_SOURCE_QUARANTINE_UNLINK_BEFORE_DIR_DURABILITY`, an absent name is not
recreated; the new process flushes the parent and records durable absence. If
the name is still present, it may retry unlink only after the reviewed
handle-bound operation proves the recorded generation. A different generation
is an external occupant and is preserved with `NEEDS_ATTENTION`. After
`AFTER_SOURCE_QUARANTINE_DIR_DURABILITY`, an absent Windows quarantine is a
committed forward state. Linux/macOS have no Nuvyn-created plaintext
quarantine and these three hooks are not applicable.

### 15.1 AI whole-session disposition mapping

`DISCARD_AI_SESSION` is not covered by vague generic AI crash wording. It
uses the generic SQLite hook family above with the following exact operation
class and oracle:

| Hook | Preconditions and operation boundary | SQLite state after a kill at the seam | Ledger/consent state | Restart and unlocked resume | Forbidden/idempotent result |
| --- | --- | --- | --- | --- | --- |
| `BEFORE_SQLITE_CLEANUP_COMMIT` with `operationClass=DISCARD_AI_SESSION` | `PUBLISHED`; exact consent, session row generation and message-ID snapshot selected; `BEGIN IMMEDIATE` transaction has deleted neither row yet and is immediately before `COMMIT` | Session row and every inventoried message row still exist unchanged; transaction rolls back | Item remains `CLEANUP_PENDING` (or `PUBLISHED` before cleanup starts); consent remains valid only for the same inventory revision/generation and is not consumed as completed | Fresh process sees the whole original session; after unlock it may retry the same exact action or require a new consent if any row/generation changed | Never delete selected messages only, never substring-edit, never treat a typed phrase as authority; rerun is one whole-session CAS/action |
| `AFTER_SQLITE_CLEANUP_COMMIT` with `operationClass=DISCARD_AI_SESSION` | The same exact whole-session transaction returned success; migration ledger disposition update has not necessarily committed | Session row absent and all inventoried message rows absent; no recreation is attempted | Ledger may still say `CLEANUP_PENDING`; consent/action record is reconciled to the committed transaction ID, not used against a later row | Fresh process records the already-completed disposition idempotently without recreating data. If a session/message row with the same numeric ID has a different captured row generation, it is a new/external session: old consent cannot delete it and the item becomes `CONSENT_REQUIRED`/`NEEDS_ATTENTION` | Never delete a replacement/new session, never infer completion from ID alone, and never re-run a destructive delete when the exact rows are already absent |

The consent snapshot therefore includes the exact session row generation,
message-ID set and inventory revision. A replacement/new session or message
set at the same apparent ID is external state, not an owned continuation.
`RETAIN_AI_HISTORY` uses no destructive SQLite hook; it records explicit
policy retention and remains visible in the completion summary.

On an unlocked restart, every applicable hook first revalidates the current
epoch and inventory consent. Windows automatic pre-publication hooks may retry
only the recorded phase with the captured handle/parent proof; its publication
hooks authenticate the exact target before writing `PUBLISHED`, and its
quarantine hooks continue only after exact handle-bound checks. Linux/macOS
candidate hooks may retry candidate preparation; after a user action, the
readback and journal hooks authenticate the exact candidate and then continue
forward. The POSIX source-transition/publication/quarantine hooks are skipped,
not simulated. SQLite, IDB and `AFTER_ITEM_COMPLETE` remain idempotent after
scope/generation checks. This is the unlocked counterpart of every applicable
locked-restart row above.

Lock/logout/expiry/capability replacement aborts candidate preparation and
fences late results. Windows publication remains monotonic once its syscall may
have passed. A POSIX user action is outside Nuvyn authorization; a new
unlocked run verifies actual bytes before any journal advancement. Every hook
row has a precondition, completed/not-durable boundary, durable ledger
expectation, filesystem/SQLite/IDB observation, locked and unlocked restart
rule, forbidden transition and idempotent rerun result. The 19 hook names and
the AI mapping above are normative for the future test plan and implementation
evidence.

## 16. Privacy/logging requirements

Migration logs and API responses may contain only bounded canonical path,
stable ID when appropriate, opaque session/message IDs, phase, classification,
stable error code and counts. They must not contain body, message content,
frontmatter, title derived from body, summary, tags, body length/byte size,
body hash, plaintext digest, password, KEK, DEK, capability, provider payload
or raw exception serialization. Internal ciphertext fingerprint and generation
provenance are non-secret authorization evidence only; they are not returned
in a locked projection and cannot authorize mutation by themselves.

The implementation adds canaries such as `D8_4_PRIMARY_<random>`,
`D8_4_DRAFT_<random>`, `D8_4_FRONTMATTER_<random>` and
`D8_4_METADATA_<random>`. After each migration phase, tests search migration
temps/staging/journals, SQLite (including `sessions/messages`), IndexedDB, Git
new commits, logs and test/Playwright artifacts. The pre-existing legacy source
is classified separately; any newly created plaintext canary is an immediate
STOP condition. AI message content is never copied to any migration artifact.

## 17. Compatibility

- An old vault opened by a D8.4 build remains unchanged until the explicit
  workflow starts. Opening without unlock never fetches or renders Diary body.
- A valid encrypted vault reopens locked; valid bytes are preserved and no
  migration is required.
- An interrupted migration resumes from its ledger/journal with the crash
  rules in §15.
- A user may upgrade without unlocking Diary; safe structural inventory is
  deferred or available without body access, and no body is migrated.
- A pre-D8.4 client cannot read V1 encrypted Diary bytes as Markdown. Downgrade
  compatibility for encrypted Diary is explicitly not promised; the user must
  return to a D8.4-capable build or use an authorized export made before
  downgrade.
- Ordinary Notes retain existing read/write/history/draft/search behavior.

## 18. Release guarantee

D8.4 completion guarantees that, for Nuvyn-controlled current managed-Diary
surfaces, every supported legacy plaintext primary and auxiliary private store
(including SQLite `sessions/messages` and structured managed-Diary AI
tool-result envelopes) is in one explicitly reported category: resolved and
cleaned, valid encrypted no-op, policy-retained private state,
`USER_FINALIZE_REQUIRED`, or unresolved `NEEDS_ATTENTION`. A provable AI
exposure is never omitted from inventory or closure; retention is
Nuvyn-controlled policy state, not an external residual. No D8.4 migration
transaction creates a new durable plaintext Diary-body copy. Linux/macOS
candidate preparation never claims encrypted-at-rest closure until the user
finalize is verified. Valid V1 encrypted files remain unchanged, new D8.2/D8.3
boundaries remain active, and ordinary Note behavior is regression-tested.

Completion does not guarantee cryptographic erasure from remote clones,
third-party backups, external editor copies, downloaded PDFs, OS clipboard
history, CI artifacts already exported, or arbitrary storage media. It does not
claim that legacy Git plaintext was purged; the chosen Git policy retains it as
an explicitly acknowledged policy-retained local exposure. A user-moved or
user-retained plaintext backup outside the canonical managed path is recorded
as `USER_CONTROLLED_PLAINTEXT_RESIDUAL`; Nuvyn never claims to erase it. The
completion screen and evidence must separately disclose policy-retained AI
history, pending user-finalize, user-controlled plaintext residuals,
unresolved Nuvyn-controlled attention and external/uncontrolled copies.

## 19. Explicit residual risks

1. Legacy Git objects and all remote/external copies can retain plaintext.
2. A user-controlled process, an already-unlocked browser or the Nuvyn server
   process can observe plaintext in memory during authorized work.
3. A mixed/invalid SQLite audit row may remain `NEEDS_ATTENTION` when ownership
   cannot be proven without a destructive guess.
4. Browser profiles can be copied outside the conditional IDB deletion owner.
5. Filesystem crash recovery cannot provide secure erase of an inode already
   written by a prior release.

These are disclosed residuals, not hidden completion claims.

## 20. Acceptance criteria

The future implementation is acceptable only when all are true:

- Every managed file is classified before generic parsing; all 23 planning
  decisions are implemented without a second key/session owner.
- Locked restart never treats a syntactic V1 envelope as authenticated:
  Windows possible publication enters `RECOVERY_AUTH_REQUIRED`; Linux/macOS
  candidate durability restores `USER_FINALIZE_REQUIRED`; unlock performs
  exact ciphertext-fingerprint/generation/AES-GCM/AAD reconciliation, and
  failed authentication preserves all artifacts with `NEEDS_ATTENTION`.
- Plaintext happy path, valid encrypted no-op, repeat/idempotency, malformed,
  unknown, auth/AAD/vault mismatch, missing/stale/ambiguous metadata,
  external races, lock/logout/expiry and restart tests pass.
- Filesystem inspection proves no new plaintext body in temp, staging, journal,
  rollback, recovery, candidate, SQLite ledger, new Git commit, log or test
  artifact at every phase.
- `DiaryMigrationFs` is the sole migration filesystem owner. Windows automatic
  finalize uses the reviewed captured-handle conditional generation operation;
  Linux/macOS use only safe candidate preparation and
  `USER_FINALIZE_REQUIRED`. No unsupported operation falls back to
  copy/delete or overwrite rename, no Nuvyn POSIX operation mutates the
  plaintext namespace, and unknown durability never becomes `PUBLISHED`.
- Every destructive action is bound to an immutable `inventoryRevision`, exact
  item/generation and action scope; a new/changed row requires new consent.
- Legacy Draft/Recovery rows are never silently deleted; valid rows are
  imported or typed-discarded, ambiguous rows remain attention, and no new
  managed persistent draft is written.
- SQLite and `frontmatter_backup` cleanup preserves identity/Mood, clears only
  proven managed private state, retains null-ID rows as
  `FRONTMATTER_IDENTITY_UNRESOLVED` until a verified non-destructive binding,
  is transactional/restartable and leaves Notes untouched.
- SQLite AI `sessions/messages` are inventoried; provable structured
  managed-Diary tool-result exposure receives explicit whole-session discard or
  policy-retention/attention, while ordinary and mixed text is not guessed at.
- Git inventory covers all required ref/object classes, no rewrite/force-push
  occurs, and retained exposure is explicitly acknowledged.
- Crash/restart recovery, rerun convergence and cross-platform filesystem
  behavior pass on Linux, macOS and Windows using the exact 19-hook
  deterministic oracle in §15, including the Windows unlink-before-directory-
  fsync boundary, POSIX candidate-durable -> `USER_FINALIZE_REQUIRED` and
  post-user-finalize verification, and whole-session AI disposition mapping;
  no timing sleeps or fake hooks around user actions are accepted.
- Linux/macOS release evidence proves candidate preparation works, no Nuvyn
  plaintext rename/delete occurs, `USER_FINALIZE_REQUIRED` survives restart,
  stale source/candidate conflicts are detected, authenticated user-finalize
  verification works, and ordinary Notes are unchanged. Windows evidence
  proves handle-bound automatic migration, races, restart and durability.
- Typecheck, build, full unit/integration, History, Recovery, browser E2E,
  Draft Store, auth, tags-scale, visual and Docker smoke suites are green.
- Implementation evidence, exact-head CI, residual-risk statement,
  Independent Review verdict and final docs-only closure lineage are recorded.

## 21. Out of scope

Encrypted Draft Store V2; encrypted Git history; history rewrite/purge; remote
force-push; password/DEK rekey; envelope migration; generic managed rename,
move, delete or reference rewriting; broad SQLite schema redesign; automatic
external-copy deletion; secure media erase; unrelated D7/D8.0-D8.3 reopening;
and any implementation work before Independent Planning Review approval.

The next authorized phase is **D8.4 Independent Planning Re-review Round 3**.
It must determine whether the impossible POSIX automatic exact-source
mutation has been removed from current authority, whether
`USER_FINALIZE_REQUIRED` is coherent and safely verified, whether Windows
automatic migration remains feasible, whether all residual guarantees are
accurately scoped, and whether the seven previously closed findings remain
closed. Only `PASS (0/0/0)` may approve planning; no production change begins
before that separate approval.
