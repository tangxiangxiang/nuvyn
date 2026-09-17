# Nuvyn Tags Management Phase 2.1 — Undo Implementation Plan

**Status:** Approved for Implementation

**Date:** 2026-08-16

**Product area:** Tags Management Phase 2.1 — Undo

**Approved PRD:** [`tags-management-undo-prd.md`](tags-management-undo-prd.md)

**Phase 2 production baseline:** `99f4d73154349f8ebc99cb609f1a88b07937fb26`

**Planning HEAD:** `841dbbf2741f65df1dec73d01c01f56237efba5d`

This document is an implementation-planning artifact only. It does not create
Undo behavior, a migration, an endpoint, a test, or a production code change.
The plan is approved for implementation, but implementation has not started;
the next authorized phase is T2.1-0 after this approval commit is reviewed.

## 1. Document Information

| Field | Value |
| --- | --- |
| Document | Nuvyn Tags Management Phase 2.1 — Undo Implementation Plan |
| Status | Approved for Implementation |
| Date | 2026-08-16 |
| Approved product authority | `docs/design/tags-management-undo-prd.md` |
| Phase 2 PRD | `docs/design/tags-management-prd.md` |
| Phase 2 Implementation Plan | `docs/design/tags-management-implementation-plan.md` |
| Phase 2 closure | `docs/archive/closures/tags-management-phase-2-closure.md` |
| Backup authority | `docs/deployment/backup-and-restore.md` |
| Current planning HEAD | `841dbbf2741f65df1dec73d01c01f56237efba5d` |
| Production implementation baseline | `99f4d73154349f8ebc99cb609f1a88b07937fb26` |
| Implementation state | Not started |

The current HEAD is documentation-only after the approved Phase 2.1 Undo PRD.
The production facts in this plan are therefore read from the unchanged Phase
2 implementation baseline and verified again in the current repository.

## 2. Status / Authority

The authority order for the Phase 2.1 behavior in this plan is:

```text
Approved Phase 2.1 Undo PRD
>
Approved Phase 2.1 Undo Implementation Plan
>
future Phase 2.1 implementation
```

The Approved Phase 2 PRD, Approved Phase 2 Implementation Plan, and Phase 2
closure remain binding for the protected Phase 2 surface and existing behavior.
The Phase 2.1 Undo PRD is product authority for new behavior. The approved
Phase 2.1 Implementation Plan chooses schema, provenance, transaction, API,
client, UI, test, and delivery details, but may not weaken or reinterpret the
approved product contract.

### Final Implementation Plan Review

```text
Final Implementation Plan Review: PASS
Review date: 2026-08-16

P0: 0
P1: 0
P2 blocking: 0
P3: 1 editorial — resolved in approval commit

Architecture blocker: 0
Plan ↔ Approved PRD Conflict: 0
```

The Phase 2.1 Undo Implementation Plan is approved as the implementation
authority beneath the Approved Phase 2.1 Undo PRD. This approval authorizes
implementation to begin at T2.1-0 after this approval commit itself is
reviewed. It does not authorize skipping T2.1-0, working ahead into T2.1-1,
exposing Undo, combining phase gates, or declaring Phase 2.1 complete.

The strict sequence remains:

```text
T2.1-0
↓ PASS
T2.1-1
↓ PASS
T2.1-2
↓ PASS
T2.1-3
↓ PASS
T2.1-4
↓ PASS
T2.1-5
↓ PASS
T2.1-6
↓ PASS
T2.1-7 external closure review
```

If implementation evidence cannot satisfy stable-ID restoration, durable
provenance, atomicity, later-change preservation, or the protected-area
boundary, implementation stops and the Architecture / PRD Conflict is reopened.
No implementation phase may work around a failed earlier gate.

## 3. Approved PRD Baseline

The approved PRD is `docs/design/tags-management-undo-prd.md` at the planning
baseline. Its review record states:

```text
Status: Approved for Implementation
Final PRD Review: PASS
Review date: 2026-08-16
P0: 0
P1: 0
P2: 0
Architecture / PRD Conflict: None
```

The approved product decisions carried into implementation are:

- exactly one user-facing Undo target: the latest successful Rename, Display
  Rename, Merge, or Remove;
- durable SQLite state survives refresh and normal restart;
- Preview and explicit confirmation are mandatory;
- Undo is a new forward mutation, never a database snapshot rollback;
- later unrelated title, summary, tag, Markdown, and Git changes survive;
- Merge and Remove restore the deleted source tag's exact stable ID when safe;
- final `(document_id, tag_id)` equality is not association ownership proof;
- a delete followed by re-add must be detectable as a new association instance;
- dynamic conflicts are non-consuming, while superseded, consumed, malformed,
  and irreconcilable records are terminal;
- committed plus refresh failure is `undo-sync-pending` and retries sync only;
- no Redo, global Ctrl/Cmd+Z, event-sourced history, reverse identity
  migration, or Markdown/Git mutation is introduced.

## 4. Current Architecture Verification

The following are **CURRENT FACTS**, verified from the repository at planning
HEAD and the unchanged Phase 2 production tree. The **IMPLEMENTATION
DECISIONS** in later sections are approved plan decisions, not current
behavior.

### 4.1 Persistence and migrations — CURRENT FACT

- `server/db.ts` discovers numbered SQL files and currently applies `0001` through
  `0006`; the latest migration is `0006_authentication.sql`.
- The runner records one integer in `schema_version`, wraps each migration in a
  better-sqlite3 transaction, and is idempotent for an already-applied version.
- The connection enables `foreign_keys = ON` and `journal_mode = WAL`.
- `documents` has stable text `id`, unique `path`, title, summary, created and
  updated timestamps.
- `tags` has integer `id INTEGER PRIMARY KEY AUTOINCREMENT`, `name`, and unique
  `normalized_name`.
- Current `document_tags` is a rowid table with `document_id`, `tag_id`, foreign
  keys with `ON DELETE CASCADE`, and `PRIMARY KEY (document_id, tag_id)` plus
  `idx_document_tags_tag(tag_id, document_id)`.
- Because the current table does not declare an `INTEGER PRIMARY KEY`, SQLite
  exposes an implicit `rowid`. That rowid is not a safe provenance identity: it
  is not an explicit application contract and must not be used for Undo.
- `settings` stores the completed/failed `tag-identity-v1` marker. It is not an
  operation log or an Undo authority.

### 4.2 Phase 2 operation seam — CURRENT FACT

- `server/tagManagement.ts` owns the `TagOperationRequest` union:
  `rename(sourceTagId, destinationName)`, `merge(sourceTagId,
  destinationTagId)`, and `remove(sourceTagId)`.
- `buildTagOperationPlanState` and the Preview/page functions are the server
  planner and the only source of affected-document scope.
- The current plan fingerprint is SHA-256 over the identity contract,
  normalized operation, resolved tag rows, complete affected document tuples,
  complete tag rows, counts, conflicts, and warnings. It intentionally includes
  title, summary, created/updated values for Phase 2 Apply; Undo will use a
  separate fingerprint contract because the PRD permits unrelated metadata
  changes.
- Preview uses a deferred read transaction. Apply performs discovery, acquires
  sorted document path locks through `withDocumentWriteLocks`, recomputes the
  plan, and runs one `db.transaction(...).immediate()` mutation.
- `applyTagOperation` generates `operationId` with `randomUUID()` before the
  transaction. The current result uses the same value for `resultId`.
- The current result is returned to the client and emitted as a bounded log
  event; it is not durable operation history and cannot be an Undo authority.
- Current Apply versions every affected document once with
  `nextMetadataUpdatedAt`, never restores old `updated_at`, and leaves Markdown
  and Git outside the mutation.

### 4.3 Metadata and association writers — CURRENT FACT

The complete production writer inventory found by searching the repository is:

| Writer/path | Current behavior | Phase 2.1 requirement |
| --- | --- | --- |
| `server/documentMetadata.ts`: `createDocumentMetadata`, `observeDocumentMetadata`, `saveDocumentMetadata` fixtures/recovery, `replaceDocumentTags` | Inserts tags and associations; ordinary new rows omit an association identity; the compatibility full writer currently deletes/rebuilds associations | New-document/import paths may insert fresh rows; full replacement is restricted to recovery/fixture/full-snapshot compensation. It is not the ordinary existing-document writer |
| `server/documentMetadata.ts`: `patchDocumentMetadataWithinTransaction` | Explicit tag changes require `expectedUpdatedAt`; unchanged tag sets are not rewritten at the document level, but the current changed-set helper deletes/reinserts the complete association set | T2.1-0 changes the ordinary existing-document path to set-diff: unchanged logical rows preserve `association_id`; only true removals are deleted and only true additions receive new IDs |
| `server/metadataMigration.ts` | Imports absent metadata through `ensureDocumentMetadata`; does not rebuild an existing database-owned row | New imported associations receive fresh IDs; no Undo record is created for import |
| `server/tagManagement.ts` | Merge inserts destination rows with `ON CONFLICT DO NOTHING`; Merge/Remove delete source associations/tags; Rename updates a tag row | Capture exact created/removed association IDs inside the same Apply transaction |
| `server/tagIdentityMigration.ts` | Repoints legacy tag rows with `INSERT OR IGNORE`, collapses duplicate logical memberships, and deletes losing tags | Runs after the schema migration; new repointed rows receive new IDs, existing rows retain IDs; migration is never an Undo record |
| `server/routes/posts.ts`, `server/routes/folders.ts`, `server/history/restore.ts`, `server/frontmatterArchive.ts`, `server/folderMove*`, `server/crashRecovery.ts` | Use centralized metadata snapshot/restore and lifecycle helpers | Snapshot compensation may restore captured physical IDs only inside its ownership/CAS rollback path; it must not forge management provenance or create Undo records |
| `server/ai/tools.ts` and `server/routes/metadata.ts` | AI and REST metadata changes use the field-scoped metadata writer; explicit tags are version checked | Preserve the same writer contract and ensure every new association gets a new ID |

Tests and fixtures also insert `document_tags` directly, but they are not
production writers. The implementation phase must update their setup helpers
and assertions to ignore or intentionally assert the new physical identity.
No Markdown, Frontmatter, Git History, TagPanel, FileTree, or editor Undo path
is a Tag Management mutation writer.

#### Ordinary existing-document writer contract — T2.1-0 decision

The current full-replacement behavior is a pre-implementation finding, not an
acceptable Phase 2.1 writer contract. In T2.1-0, the ordinary REST explicit-tag
patch and AI metadata tag patch must use one centralized set-diff helper. For an
existing document, compare the current normalized tag-ID set with the requested
set before any association SQL:

- a requested tag already present is **unchanged**; its existing
  `document_tags.association_id` is retained;
- a requested tag absent from the current set is an **add**; insert only that
  `(document_id, tag_id)` row without `association_id` so SQLite allocates a new
  identity;
- a current tag absent from the requested set is a **remove**; delete only that
  association row;
- an identical requested set is a no-op for `document_tags`; no association row
  or physical identity is rewritten.

For example, `Backend(association_id=51) → Backend, Python` preserves 51 and
allocates a new identity only for Python. `Backend, Python → Backend, Vue`
preserves Backend, deletes Python, and allocates a new identity for Vue. A
logical association that remains in the requested set must therefore keep its
physical identity. Only a true logical delete followed by a later true add
creates a new `association_id`.

`replaceDocumentTags` may remain as a separately named recovery/fixture or
full-snapshot compensation primitive only when exact snapshot ownership/CAS
semantics require it. It must not be reachable from ordinary existing-document
REST or AI tag patches. Snapshot/CAS restoration and ordinary production tag
writing are separate contracts: the former may restore an explicitly captured
physical row, while the latter preserves unchanged associations and never
accepts physical provenance from the caller.

### 4.4 Startup, health, and security — CURRENT FACT

- `server/prod.ts` and `server/vite-plugin.ts` acquire writer ownership, run
  crash recovery, run `migrateVaultMetadata`, and then call
  `initializeTagIdentityAndHealth` before serving.
- The first `getDb()` call applies numbered SQLite migrations before the caller
  enters crash recovery; therefore a v6 durable metadata journal can reach the
  recovery parser after migration 0007 has already rebuilt `document_tags`.
- `preflightTagIdentityHealth` is the read-only health seam used by the current
  tag routes; it checks marker validity, canonical tag rows, foreign keys, safe
  tag IDs, and live Markdown metadata ownership.
- `server/index.ts` mounts `authBoundary` before all `/api/*` routes. Protected
  requests require the owner session, unsafe methods use same-origin CSRF checks,
  body-bearing writes require JSON, and protected responses receive
  `Cache-Control: no-store`.
- `server/folderMoveTransaction.ts` currently validates durable metadata snapshot
  rows with exact v6 `document_tags` columns, and `server/crashRecovery.ts`
  revives those rows before CAS restore; T2.1-0 must make this parser
  version-aware rather than accepting a permissive mixed shape.
- Management routes currently are `/api/tags`,
  `/api/tags/operations/preview`, `/api/tags/operations/preview/page`, and
  `/api/tags/operations/apply`.

### 4.5 Client and UI — CURRENT FACT

- `TagManagementDialog.vue` owns the existing manager state machine, Preview
  invalidation, pagination, `useConfirm`, focus trap, `sync-pending`, and
  committed protocol mismatch recovery.
- `VaultView.vue` owns `selectedTag`, a local `tagSelectionEpoch`, the one
  authoritative posts/tree plus managed-tag synchronization cycle, and the
  trusted committed-operation recovery seam.
- `TagPanel.vue` owns Phase 1 query/filter/rendering only and emits the Manage
  action; it does not own manager domain state.
- `tag-selection-reconciliation.ts` resolves selected tags by stable ID at the
  authoritative managed-tag boundary and preserves a newer user selection by
  selection epoch. It already has Rename, Merge, and Remove mapping seams.
- `useConfirm()` and `ConfirmHost.vue` provide `role="alertdialog"`, safe
  Cancel default focus, Escape cancellation, Tab trapping, destructive styling,
  and focus restoration. There is no global Ctrl/Cmd+Z binding.
- `useI18n.ts` contains the existing zh/en string table, including Phase 2
  management copy.

### 4.6 Verification and CI — CURRENT FACT

- The repository has `npm run typecheck`, `npm run build`, unit/integration
  scripts, `npm run test:tags-scale`, Playwright cross-platform and Draft Store
  lanes, auth-browser, Docker smoke, and macOS visual jobs.
- The current CI matrix is Ubuntu Node 22 and 24, macOS Node 24, Windows Node
  24, `tags-scale`, `docker-smoke`, `auth-browser`, and `visual`.
- Existing scale fixtures target 10,000 documents and 50,000 associations.
- CI #343 (`31956420785`) for planning HEAD
  `841dbbf2741f65df1dec73d01c01f56237efba5d` completed with `failure`. The
  `verify (macos-latest, 24)` job failed only in `Run Draft Store browser E2E`;
  `auth-browser`, `visual`, `docker-smoke`, `tags-scale`, Windows Node 24
  verify, and Ubuntu Node 22/24 verify succeeded. The failed log contains
  Draft Store IndexedDB/fixture failures, not Phase 2.1 implementation or
  plan-document changes. This run is not recorded as green, and its status
  does not change the implementation phase status.

### 4.7 Phase 2.1 implementation boundary — DECISION

The new durable state will be a narrow SQLite boundary next to the existing
Tag Management domain. It will not become a general event store, a second
metadata authority, or a global client state system.

## 5. Implementation Goals

The implementation must:

1. Record a complete, server-owned inverse delta for every new supported Phase
   2.1 Rename, Display Rename, Merge, and Remove Apply.
2. Make the ordinary mutation and its reversible state one SQLite transaction.
3. Detect association delete→re-add using an explicit stable physical
   `association_id`, not final composite-key equality.
4. Provide bounded Undo availability, mandatory server Preview, fingerprinted
   Apply, explicit confirmation, and exactly-once committed recovery.
5. Restore deleted source stable tag IDs only when all identity and provenance
   preconditions are safe.
6. Preserve later unrelated metadata, associations, Markdown, Frontmatter,
   mtimes, Git, History, Phase 1 query behavior, and editor Undo.
7. Keep the user-facing storage bounded to one latest target and its child
   delta, with no history browser or Redo.
8. Reuse existing health, locks, version, synchronization, selection, auth,
   focus, and i18n seams.

## 6. Non-Goals

This plan does not include:

- implementation before plan approval;
- Redo or Undo of Undo;
- arbitrary multi-level Undo or a history browser;
- SQLite snapshot rollback as a product feature;
- reverse identity migration;
- Markdown, Frontmatter, Git, History, link-index, or fileChanges mutation;
- global Ctrl/Cmd+Z interception or editor/document-content Undo;
- durable operation history beyond one bounded reversible target;
- global application revision, distributed locking, a new ORM, or a new
  state-management library;
- client-provided inverse snapshots, affected-document lists, or association
  ownership;
- weakening any Phase 2 writer-safety, Preview/Apply, or TagPanel contract.

## 7. Architecture Invariants

The following are non-negotiable implementation invariants:

- SQLite is the only authority for tags, documents, associations, reversible
  records, and Undo results.
- `tag-identity-v1` remains exactly `trim → remove exactly one leading # → trim
  → toLowerCase()`, with no NFKC.
- After T2.1-1 activation, every supported ordinary Apply commits its tag
  mutation, association changes, monotonic version updates, reversible record,
  child deltas, and latest-target transition together. T2.1-0 foundation
  installation does not make this requirement active.
- Every Undo Apply is a new one-transaction forward mutation; old timestamps
  are never restored.
- The server derives complete scope. The wire sample and pagination are never
  mutation authority.
- An ordinary existing-document tag writer is set-diff based: every logical
  association that remains requested preserves its existing `association_id`,
  only true removals are deleted, and only true additions receive a new
  `association_id`. An identical set is a physical no-op.
- A physical association inserted by a normal forward writer gets a new
  `association_id`; `INSERT OR IGNORE` preserves an existing row and identity
  when used for an idempotent add, never as a full-set replacement strategy.
- A server-owned association ID is evidence for ownership, not a client token
  that can be forged or supplied as an inverse scope.
- Merge and Remove restore source tag IDs by explicit `INSERT ... (id, ...)` or
  fail closed; they never allocate a replacement ID.
- Dynamic conflict and stale Preview do not consume the record.
- A committed operation with refresh/protocol failure never re-applies; only
  authoritative synchronization or recovery is retried.
- All affected documents receive exactly one new version per successful Undo;
  unaffected documents receive none.
- Markdown bytes/mtime, Frontmatter, Git state/History, Tag Query, TagPanel,
  FileTree, PostSummary.tags, authentication, and editor Undo remain outside
  the Undo mutation boundary.

## 8. Association Provenance Design

### 8.1 Choice

Adopt the explicit relational identity design:

```sql
document_tags(
  association_id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  UNIQUE(document_id, tag_id)
)
```

`association_id` is the server-owned identity of the current physical
association instance. It is never exposed as a client mutation authority.
`AUTOINCREMENT` prevents normal deletion/reinsertion from reusing a previous
identity. The existing composite uniqueness remains the logical contract.

This is preferred over the current implicit `rowid` because an explicit
`INTEGER PRIMARY KEY` is part of the schema and survives ordinary maintenance
and backup semantics. It is preferred over a generation column because an
association instance is the exact ownership unit needed by Merge and the
delete→re-add test. It is preferred over an event log because it is bounded,
set-oriented, and does not introduce event sourcing.

### 8.2 Ownership rules

- Ordinary existing-document metadata writes use set-diff. A logical row that
  remains in the requested set is not deleted and keeps its existing
  `association_id`; only additions omit `association_id` and let SQLite allocate
  a new one, and only removals delete a row.
- An identical requested set performs no association SQL. Where an idempotent
  add helper is used, `INSERT OR IGNORE` leaves the existing `(document_id,
  tag_id)` row and its ID unchanged; it is not permission to rebuild the set.
- A delete followed by a later insert receives a new ID, even if the pair is
  identical.
- Ordinary metadata writers never update `association_id` in place.
- REST and AI explicit tag patches share this same set-diff contract. Full
  snapshot/CAS recovery writers are separately classified and may restore an
  explicitly captured physical row only after their existing ownership proof.
- Tag Apply captures IDs from the actual committed rows, not predicted IDs.
- Undo removes a Merge-created destination row only when the exact recorded
  `association_id`, document, and tag still match.
- Undo-created source associations are new forward rows with new IDs. The old
  removed association ID is provenance evidence, not an ID to restore.
- Snapshot compensation may reinsert explicit IDs only inside the existing
  ownership/CAS restore path, which restores a prior physical database state;
  it is not a normal writer and does not create an Undo record.

### 8.3 Rejected alternatives

The implementation must not use document/tag pair equality, display names,
`updated_at`, array equality, Vue state, localStorage, Markdown, Git History,
logs, or an unproven implicit rowid as sufficient provenance. Any fallback that
cannot distinguish a deleted-and-recreated association is an Architecture / PRD
Conflict.

## 9. `document_tags` Migration Design

### 9.1 Migration number and transaction

The next migration is `0007_tag_management_undo.sql`. It is applied by the
existing numbered migration runner after `0006_authentication.sql`. The runner
already wraps each file in one transaction, so the table rebuild, new Undo
tables, and `schema_version = 7` update commit together or roll back together.
No migration file is created by this planning task.

### 9.2 Mechanical rebuild

The implementation SQL will perform this ordered operation inside the runner's
transaction:

1. Create `document_tags_phase21` with the explicit `association_id`, the two
   existing foreign keys and cascades, `UNIQUE(document_id, tag_id)`, and no
   client-writable provenance column beyond the primary key.
2. Copy every existing logical row with
   `INSERT INTO document_tags_phase21 (document_id, tag_id) SELECT document_id,
   tag_id FROM document_tags ORDER BY document_id COLLATE BINARY, tag_id`.
   Existing composite PK semantics guarantee no duplicate pair is silently
   lost; foreign keys are checked.
3. Drop the old `idx_document_tags_tag` index and old `document_tags` table.
4. Rename `document_tags_phase21` to `document_tags`.
5. Recreate `idx_document_tags_tag(tag_id, document_id)` and add
   `idx_document_tags_document(document_id, tag_id)` for ownership/read paths.
   The unique constraint supplies its own uniqueness index.
6. Create the Undo state, parent, and child tables described in §10 and seed
   exactly one `tag_undo_state` row with
   `database_generation = lower(hex(randomblob(16)))`.
7. Run schema/foreign-key validation in the application health initializer
   before management is served; the migration test also runs
   `PRAGMA integrity_check` and `PRAGMA foreign_key_check`.

The migration does not change `documents`, `tags`, logical memberships, or tag
IDs. It assigns new physical association IDs deterministically by copy order,
but those IDs are not historical Undo ownership because no pre-Phase-2.1
operation is retroactively reversible.

### 9.3 Safety and retry

- `foreign_keys` is already enabled before the migration; no `PRAGMA
  foreign_keys` toggle is attempted inside the transaction.
- SQLite DDL is transactional under the existing runner. An interruption before
  commit leaves the v6 table and schema marker; it does not leave a half-renamed
  table.
- A rerun sees `schema_version = 7` and is a no-op. A rolled-back run retries
  the complete rebuild from v6.
- Before/after logical membership sets, row counts, tag/document ID sets,
  uniqueness, integrity, and foreign-key checks must match.
- The migration must not use `INSERT OR IGNORE` for unexpected duplicate source
  pairs; a corrupted v6 database fails closed rather than silently losing a
  logical association.

### 9.4 Durable recovery journal compatibility — v6 and v7

The application opens the database through `getDb()`, which applies numbered
migrations before `recoverInterruptedOperations()` runs in both production and
Vite startup. A pre-upgrade durable folder/recovery journal can therefore be
written against the v6 metadata shape and be consumed after the database has
already migrated to v7. The parser must not assume every durable journal is a
v7 journal.

T2.1-0 freezes two exact `documentTags` row generations inside the existing
durable snapshot envelope:

| Row generation | Exact row columns | Physical provenance |
| --- | --- | --- |
| Legacy v6 | `document_id`, `tag_id` | None; the journal predates explicit association provenance |
| Phase 2.1 v7 | `association_id`, `document_id`, `tag_id` | Exact positive `association_id` is captured |

Parsing is version-aware and closed: classify a snapshot by its exact row
columns (and by the explicit v7 format marker if the new journal shape adds
one), reject mixed-generation rows, reject unknown columns, and normalize both
forms into an internal representation that records whether physical provenance
is present. Expanding one exact-column allow-list to a permissive union is not
valid compatibility.

Legacy v6 recovery has deliberately weaker physical semantics:

- if the logical `(document_id, tag_id)` row is already present in the migrated
  v7 graph and the existing ownership/CAS proof establishes that it is the
  expected state, preserve its current `association_id`;
- if the snapshot must recreate a missing logical row, insert it without
  `association_id` and let SQLite allocate a new v7 identity;
- never invent, derive, or guess an historical association ID from a v6 row;
- v6 crash recovery is not user-facing Undo, creates no `tag_undo_record`, and
  retains the existing recovery ownership/CAS contract;
- if the live graph cannot be proven safe under the legacy snapshot model,
  fail closed or quarantine using the existing recovery contract rather than
  overwrite an external change merely because the old journal lacks an ID.

A v7 snapshot contains the explicit association identity. Snapshot/CAS crash
compensation may restore those captured physical IDs when its existing
ownership protocol proves that an exact prior database state must be restored.
That is distinct from user-facing Undo, whose inverse additions are new
forward rows with new IDs. The v6/v7 upgrade test must construct a real v6
database and durable journal, start the migrated application so migration 0007
runs before recovery, and verify successful safe normalization, valid v7 IDs,
no invented Undo record, integrity/FK checks, and fail-closed behavior when
external current-state drift makes the legacy ownership proof unsafe.

## 10. Durable Undo Record Schema

### 10.1 Contract versions

Add server constants:

```text
TAG_UNDO_RECORD_CONTRACT_VERSION = "tag-undo-record-v1"
UNDO_FINGERPRINT_CONTRACT_VERSION = "tag-undo-fingerprint-v1"
```

Every parent record stores the identity-contract version, record-contract
version, and database-generation ID. Unsupported versions make the current
record terminal/unavailable; they are never guessed or migrated in memory.

### 10.2 Parent table

The implementation will create `tag_undo_records` with these logical columns:

| Column | Contract |
| --- | --- |
| `record_id` | Server UUID primary key; opaque to clients |
| `original_operation_id` | Existing Phase 2 operation ID, unique and required |
| `original_result_id` | Existing Phase 2 result ID, required even though current Phase 2 uses the same UUID |
| `kind` | `rename`, `merge`, or `remove` |
| `display_only` | `0/1`; only Rename can be display-only |
| `identity_contract_version` | `tag-identity-v1` |
| `record_contract_version` | `tag-undo-record-v1` |
| `database_generation` | Matches the singleton state generation |
| `operation_json` | Canonical, bounded normalized request; diagnostic/reference only |
| `committed_at` | Original successful Apply commit timestamp |
| `source_tag_id` | Original stable source ID |
| `source_before_name`, `source_before_normalized_name` | Exact original source row |
| `source_after_exists`, `source_after_name`, `source_after_normalized_name` | Exact post-operation source state; absent after Merge/Remove |
| `destination_tag_id` | Merge destination ID, otherwise null |
| `destination_before_name`, `destination_before_normalized_name` | Exact destination state before Merge |
| `destination_after_name`, `destination_after_normalized_name` | Exact destination post-state |
| `lifecycle` | `latest`, `consumed`, or `terminal` |
| `terminal_code` | Bounded diagnostic reason for terminal state, otherwise null |
| `undo_operation_id`, `undo_result_id` | Server IDs written only when Undo commits |
| `consumed_at` | New forward Undo commit timestamp, otherwise null |
| `association_remove_count`, `association_add_count`, `version_update_count` | Durable bounded counts for availability/diagnostics |

SQL `CHECK` constraints enforce enum values, boolean values, positive IDs,
non-negative counts, bounded strings, and lifecycle consistency. The full
normalized operation is bounded JSON, never a client-supplied inverse snapshot.

### 10.3 Association child table

Create `tag_undo_association_deltas`:

```text
record_id       TEXT NOT NULL REFERENCES tag_undo_records(record_id) ON DELETE CASCADE
effect          TEXT NOT NULL CHECK (effect IN ('removed-source', 'created-destination'))
association_id  INTEGER NOT NULL
document_id     TEXT NOT NULL
tag_id          INTEGER NOT NULL
PRIMARY KEY (record_id, effect, association_id)
```

The child intentionally does not foreign-key `document_id`, `tag_id`, or
`association_id`: a deleted document/tag/association must remain as durable
evidence so the planner can report a missing/conflicting required object
instead of having SQLite cascade away the proof. Parent lifecycle and child
completeness are checked by the Undo health seam. Add indexes on
`(record_id, document_id)` and `(record_id, effect, association_id)`.

For Rename and Display Rename, no association child rows are required. For
Merge, `removed-source` rows represent every original source association and
`created-destination` rows represent only destination associations actually
created for source-only documents. For Remove, `removed-source` rows represent
the complete deleted source membership set.

### 10.4 Singleton state table

Create `tag_undo_state` with exactly one row (`state_id = 1`):

```text
state_id                  INTEGER PRIMARY KEY CHECK (state_id = 1)
database_generation       TEXT NOT NULL UNIQUE
current_record_id         TEXT NULL REFERENCES tag_undo_records(record_id)
last_superseded_record_id TEXT NULL
updated_at                INTEGER NOT NULL
```

The generation is an opaque database-instance identity, not a global revision
counter. It is preserved by consistent backup/restore and is included in Undo
fingerprints. There is no second user-facing history table.

## 11. Latest Target / Lifecycle Design

The singleton state points to at most one current parent row. The target model
is deliberately bounded:

- `current_record_id` plus a parent with `lifecycle = latest` is the only
  user-facing target.
- On successful ordinary Apply, the old parent and all of its child rows are
  deleted in the same transaction after `last_superseded_record_id` is set.
  Only the compact previous ID remains; no old delta survives.
- On successful Undo, the current parent remains as a compact `consumed` row
  containing the original summary and trusted `undo_result_id`; child rows are
  deleted in the same transaction after the inverse postcondition succeeds.
  No Redo target is created.
- A malformed or irrecoverably invalid record may be marked `terminal`; its
  bounded parent diagnostics remain, but it is never applied.
- A dynamic conflict or stale Preview does not change lifecycle.
- A request naming the current record after it is consumed receives
  `UNDO_ALREADY_APPLIED`; a request naming the compact previous ID receives
  `UNDO_SUPERSEDED`; unknown/generation-mismatched IDs fail closed as
  `UNDO_UNAVAILABLE`.
- The database retains at most one parent row and its child delta at any stable
  point, plus the singleton's one previous ID. Storage is therefore bounded by
  the latest operation's affected association set, not by the number of
  operations.

## 12. Delta Storage Design

The parent stores identity/state deltas; the child table stores set-oriented
association evidence. It does not store Markdown, Frontmatter, title/summary
snapshots, or a complete document metadata snapshot.

### 12.1 Delta capture

Inside the ordinary Apply transaction:

- insert the new parent using the pre-operation plan state and the existing
  `operationId`/`resultId`;
- for every ordinary existing-document tag patch, first derive the requested
  set-diff and preserve every unchanged association row and ID; record only
  the true additions/removals caused by that writer. The helper must never
  delete/reinsert a complete existing set merely because one tag changed;
- for Merge/Remove, bulk-insert `removed-source` children from the current
  `document_tags` rows before deleting them;
- for Merge, stage source-only document IDs and after the destination insert
  bulk-insert `created-destination` children from the actual destination rows,
  including their actual `association_id`;
- for Rename/Display Rename, store exact before and after tag rows and compute
  the current affected document set during Undo Preview rather than snapshotting
  associations.

All parent and child writes are inside the same `BEGIN IMMEDIATE` transaction
as the ordinary mutation. A child count mismatch is a transaction failure.

### 12.2 Provenance versus new association identity

The record uses old association IDs to prove what the forward operation removed
and uses forward-created destination IDs to prove what a Merge Undo may remove.
Undo-created source associations are inserted without an ID and receive new
IDs. They must not be forced back to the historical IDs. This distinction is
required for later writers to be observable and for a new Undo to remain a new
forward mutation.

## 13. Retention / Bounded Storage

The product has no arbitrary timeout. The current target remains available until
it is safely superseded, consumed, or terminally unavailable. Supersession and
consumption compact heavy child data immediately and atomically.

The retention policy is:

| Event | Durable state after commit |
| --- | --- |
| New successful post-activation ordinary Apply | New parent + complete children; previous parent/children deleted; previous ID in singleton tombstone |
| Successful T2.1-0 pre-activation ordinary Apply | Existing Phase 2 mutation semantics; no reversible record or user-facing Undo claim |
| Failed/cancelled/stale ordinary Apply | Previous parent/children unchanged; no new record |
| Dynamic Undo conflict/stale Preview | Current parent/children unchanged |
| Successful Undo | Current parent summary marked consumed, `undo_result_id` stored, child rows deleted, no Redo |
| Unsupported/corrupt/irreconcilable record | One bounded terminal parent; no mutation control |
| New operation after consumed/terminal state | Old compact parent replaced in the same transaction |

There is no user-facing history browser, no durable unbounded audit log, and no
full-delta retention after the target is no longer current. Logs contain only
bounded correlation data.

## 14. Ordinary Apply Atomic Recording

The existing `applyTagOperation` in `server/tagManagement.ts` remains the
single public ordinary Apply path. T2.1-0 first changes the ordinary metadata
writer used by REST and AI tag patches to set-diff semantics; it does not create
a second mutation path. T2.1-1 is the Phase 2.1 activation cutover: only from
that reviewed commit onward does the no-record-no-commit invariant apply to
supported ordinary Tag Management operations.

The exact transaction sequence is:

1. Parse the existing operation and perform the existing deferred discovery.
2. Acquire the same sorted document locks and enter the existing
   `db.transaction(...).immediate()` boundary.
3. Rebuild and validate the Phase 2 plan against the reviewed fingerprint.
4. In the active T2.1-1 path, insert a new parent record with
   `lifecycle = latest`, using the pre-state rows and new record ID. Do not
   change `tag_undo_state` yet. In the T2.1-0 foundation-only path, this step
   is deliberately not enabled and the ordinary Phase 2 operation remains
   pre-activation/non-Undoable.
5. Bulk-capture `removed-source` IDs and any Merge source-only staging rows.
6. Perform the set-diff-preserving metadata/tag mutation and the existing
   version update.
7. Capture actual Merge-created destination IDs and complete the child delta.
8. Run the existing plus new reversible-record postconditions: exact source/
   destination rows, association counts, child counts, versions, identity,
   generation, and contract fields.
9. Update `tag_undo_state.current_record_id` to the new record and set
   `last_superseded_record_id` to the old current ID.
10. Delete the old parent, which cascades its heavy children.
11. Drop temporary staging tables and commit.

The state pointer is moved before old-row deletion, so its foreign key always
points at the new parent. If any parent/child/transition/postcondition write
fails after activation, the entire transaction rolls back: the tag graph,
versions, old Undo target, and old delta remain exactly as before. There is no
post-commit record write. T2.1-0 intentionally has no reversible-record
requirement yet; it must not advertise those operations as user-undoable.

The current Apply result remains the client-facing result. Its `operationId` and
`resultId` are stored in the parent; the client does not receive the child delta.

## 15. Undo Availability Read Model

Add a bounded server read model; it never returns child delta rows. The exact
TypeScript shape is:

```ts
type UndoAvailability = {
  supported: true
  state: 'unavailable' | 'available' | 'consumed' | 'superseded' | 'terminal-unavailable'
  validation: 'safe' | 'conflict' | 'temporary-unavailable' | 'stale' | 'terminal-unavailable'
  recordId: string | null
  originalOperationId: string | null
  originalResultId: string | null
  kind: 'rename' | 'merge' | 'remove' | null
  displayOnly: boolean
  committedAt: number | null
  sourceBefore: TagRowView | null
  sourceAfter: TagRowView | null
  destinationBefore: TagRowView | null
  destinationAfter: TagRowView | null
  affectedCount: number
  associationAdds: number
  associationRemoves: number
  versionUpdateCount: number
  reasonCode: string | null
}
```

When there is no target, `recordId` and identity fields are null and the state
is `unavailable`. The read model may run the set-based current validation but
must return only counts and bounded tag summaries, not the complete 10k delta.
An old Phase 2 server returns 404/503 for the new route; the client treats that
as safely unsupported and does not guess.

## 16. Undo Planner Architecture

Create a dedicated `server/tagUndo.ts` domain module. It shares database,
normalization, document-lock, version, error, and audit helpers with the Phase
2 domain but does not invert the browser result.

The planner uses one deferred read transaction containing:

- the singleton state and current parent contract/lifecycle;
- original and post-operation tag rows;
- child deltas and exact association IDs;
- current tag rows for ID/normalized identity checks;
- current documents and paths for all required child IDs;
- current exact association rows for every `created-destination` ID;
- current source-tag document IDs for Rename/Display Rename;
- derived inverse counts, warnings, conflict category, and bounded sample.

The planner is deterministic and set-based. It returns an internal plan
containing the record identity, inverse kind, complete internal
document/association scope, status, counts, sample, next cursor, and the
separate Undo fingerprint. T2.1-2 exposes no public HTTP handler; it is a
domain-only phase. Public availability, Preview, Preview/page, and Apply
routes are all owned by T2.1-4, which wires the planner to the authenticated
protocol after the internal Undo Apply layer is complete.

Conflict classification is explicit:

- `safe`: all inverse preconditions hold;
- `conflict`: ID/identity occupancy, missing required document, changed
  operation-owned association, source/destination post-state drift, or
  malformed ownership evidence;
- `stale`: an earlier reviewed Undo fingerprint no longer matches;
- `temporary-unavailable`: health/compatibility/DB read precondition;
- `terminal-unavailable`: consumed, superseded, unsupported, corrupt, or
  irreconcilable generation state.

The planner never mutates lifecycle for a dynamic conflict. Apply recomputes
the same planner after locks and compares the exact fingerprint before SQL
mutation.

## 17. Undo Fingerprint Contract

Use `UNDO_FINGERPRINT_CONTRACT_VERSION = "tag-undo-fingerprint-v1"`, not the
Phase 2 fingerprint. Canonical input is an ordered tuple containing:

1. the fingerprint contract version and identity contract version;
2. database generation, record ID, original operation/result IDs, lifecycle;
3. operation kind/display-only and stable source/destination IDs;
4. exact recorded before/post tag rows and current required tag rows;
5. required document IDs and current paths, sorted by stable document ID;
6. exact current `(association_id, document_id, tag_id)` rows for every
   operation-owned `created-destination` delta;
7. existence/absence markers for required source IDs, normalized identities,
   documents, and associations;
8. inverse counts, conflict category, and warning codes.

The fingerprint deliberately excludes current title, summary, Markdown body,
Frontmatter, Git state, and `documents.updated_at`. Those are display-only or
unrelated metadata for this inverse. Apply still reads the current version and
uses `nextMetadataUpdatedAt` to create a new version. A path/document identity
change is included because it changes lock scope and required document identity.

For Rename and Display Rename, the current set of documents carrying the stable
tag is included. A newly associated document therefore makes the Undo Preview
stale and requires a fresh Preview; a title/summary edit does not. For Merge,
only exact forward-created destination rows and required source documents are
owned. For Remove, required document existence and free source identity are
included; unrelated tag rows on those documents are excluded.

## 18. Rename Undo Algorithm

For `Java(id=7) → Backend(id=7)`:

1. Require the current row `id=7` to equal the recorded post-operation row.
2. Require the original normalized identity `java` to be free, or to belong to
   the same row only for a display-only case; never merge or retarget another
   row.
3. Read the current stable-ID document set and bounded sample.
4. In Undo Apply, update the one tag row to the recorded original display and
   normalized identity.
5. Version every current document carrying `id=7` once. New associations to
   `id=7` remain attached and observe the restored global display.
6. Verify the row, document set/version count, and consumed record, then commit.

No association snapshot is restored. Later title/summary and unrelated tag
changes survive. A current independent rename/display change is a conflict.

## 19. Display Rename Undo Algorithm

For `Java(id=7) → JAVA(id=7)`:

1. Require the current ID, normalized identity, and post-display row to equal the
   recorded Display Rename post-state.
2. Change only `tags.name` to the recorded original display; leave identity and
   associations untouched.
3. Compute current documents carrying `id=7`, version each exactly once, and
   verify the restored display plus consumed record.

The fingerprint excludes unrelated document metadata but includes the current
stable-ID membership set for the global display consequence. A later independent
identity/display change is a conflict.

## 20. Merge Undo Algorithm

For a Merge, the child rows distinguish:

- **source-only:** one `removed-source` row and one
  `created-destination` row for the same document;
- **overlap:** one `removed-source` row and no created-destination row;
- **destination-only:** no child row and therefore never receives the source
  tag on Undo.

The ordered transaction algorithm is:

1. Verify the source stable ID is free, the original source identity is free,
   and the destination row still equals its recorded post-state.
2. Verify every required source document exists.
3. For each `created-destination` row, require the exact association ID,
   document ID, and destination tag ID to be present. A deleted/re-added pair
   has a different ID and yields `UNDO_CONFLICT`.
4. Explicitly insert the source tag with its original ID/name/identity.
5. Delete only the exact recorded `created-destination` association IDs.
6. Insert new source associations for every `removed-source` document, omitting
   `association_id` so Undo creates new forward instances. `ON CONFLICT` is not
   used to hide a precondition failure; an unexpected source association is a
   conflict.
7. Leave overlap destination rows, destination-only rows, and later unrelated
   destination associations untouched.
8. Version exactly the documents whose source membership is restored and/or
   operation-created destination membership is removed; destination-only
   documents receive no bump.
9. Verify counts, exact destination-ID removals, source restoration, versions,
   and consumed lifecycle before commit.

No partial source restoration is allowed. Any missing document, occupied source
ID/identity, changed destination, or provenance mismatch rolls back the entire
Undo.

## 21. Remove Undo Algorithm

For Remove, the parent stores the deleted source tag row and
`removed-source` children for the complete original membership set.

1. Verify the original source ID is currently free and the original normalized
   identity is not owned by another tag.
2. Verify every child document still exists. An orphan Remove has zero child
   rows and is valid.
3. Explicitly insert `tags(id = original source_tag_id, name, normalized_name)`.
4. Insert one new `document_tags(document_id, tag_id)` row per recorded child,
   omitting `association_id` so each restored association receives a new ID.
5. Version each restored-association document exactly once; an orphan Remove
   versions none.
6. Verify the exact source ID/identity, association count, document existence,
   and consumed record, then commit.

If the source ID or identity is occupied, or a required document is missing,
the whole operation returns a conflict and the current post-Remove state is
unchanged. It never allocates a replacement tag ID or restores documents.

## 22. Stable-ID Restoration

Merge and Remove Undo use explicit stable-ID insertion. Before the insert, the
planner and transaction both verify:

- no current `tags.id = source_tag_id` row;
- no current row owns the recorded normalized identity;
- the recorded display/identity passes `validatePersistentTag` under
  `tag-identity-v1`;
- the record's generation and contract versions are supported;
- all required documents and provenance rows are valid.

The source ID is not allowed to be auto-allocated. If it is occupied, the
transaction fails before any inverse mutation. Tests must cover occupied ID,
occupied normalized identity, both conflicts, orphan Remove, large Remove,
and large Merge.

## 23. Metadata Versioning

Undo always calls the existing monotonic version helper and never restores the
old `updated_at` value.

| Undo kind | Version set |
| --- | --- |
| Rename | Every current document carrying the restored stable tag ID |
| Display Rename | Every current document carrying the restored display-renamed stable ID |
| Merge | Documents with a source membership restored or a Merge-created destination membership removed; destination-only documents excluded |
| Remove | Documents whose removed source association is restored; orphan Remove has an empty set |

The implementation will create a temporary affected-document table with one
row per document and its current version, compute one strictly greater value
per row, update once, and verify the exact count. Title/summary values remain
current. A version overflow or missing row fails the whole transaction.

## 24. Writer Safety

### 24.1 Writer matrix

| Writer | Association identity rule | Undo interaction |
| --- | --- | --- |
| REST explicit tag patch | Requires current `expectedUpdatedAt`; set-diff preserves unchanged rows and IDs, deletes only true removals, inserts only true additions | Unrelated additions/removals do not rewrite operation-owned unchanged rows; a true delete→re-add has a new ID and can produce a provenance conflict |
| REST title/summary patch | Does not touch `document_tags` | Must not supersede or false-conflict Undo; current version is ignored by Undo fingerprint |
| AI `update_metadata` | Same field-scoped primitive, set-diff helper, and explicit tag version token | Same identity-preserving behavior as REST |
| Create/import/frontmatter | Inserts absent rows and associations | New IDs; no Undo record |
| Lifecycle/body/path mutation | Uses targeted metadata/touch or ownership restore | Must not rebuild live tags from stale Frontmatter |
| Folder/history/frontmatter recovery | Existing snapshot/CAS compensation, including version-aware v6/v7 snapshot restore | May restore explicit v7 physical IDs only inside rollback ownership; v6 rows preserve current IDs or allocate new ones; no Undo record |
| Tag Management ordinary Apply | Omitted-ID inserts; captures actual removed/created IDs | One parent/child record in the same transaction |
| Tag identity migration | Repoints with current uniqueness semantics | No user-facing Undo; health and logical membership checks remain |

### 24.2 Safety assertions

The implementation must prove that the ordinary REST and AI writer preserves
unchanged IDs, performs no physical work for a no-op set, gives a new ID only
to a true addition, and gives a new ID to a true delete→re-add. It must also
prove that `INSERT OR IGNORE` does not replace an existing ID, arbitrary callers
cannot set a provenance owner, and all current direct `document_tags` SQL sites
are covered. Snapshot/CAS recovery is tested as a separate exact-restore
contract, including legacy v6 normalization. Any new ordinary writer
discovered during implementation is assigned to T2.1-0 before recording is
enabled.

## 25. Health / Startup Integration

Create a narrow `server/tagUndoHealth.ts` seam rather than overloading the tag
identity migration module. It exposes:

```ts
type TagUndoHealth = {
  state: 'checking' | 'healthy' | 'unavailable'
  code?: string
  reason?: string
  checkedAt: number
}
```

Startup ordering becomes:

```text
writer ownership
→ getDb() schema migrations (including 0007)
→ crash recovery, including v6/v7 journal normalization
→ metadata migration
→ tag identity migration/health
→ Undo schema/provenance/record health
→ serve
```

The health initializer verifies migration 0007 schema/indexes, singleton
`database_generation`, current pointer/lifecycle, record/delta contract
versions, positive association IDs, child-parent completeness, version-aware
v6/v7 recovery parser support, and `PRAGMA foreign_key_check`. It does not
repair malformed records or infer ownership. A corrupt/unsupported record is
terminal/unavailable.

Health has an explicit activation boundary:

- T2.1-0 exposes **foundation health** only: migration, provenance, schema,
  parser compatibility, and integrity are healthy, but Undo is not activated;
  there is no Undo API/UI, and ordinary Phase 2 operations remain explicitly
  pre-activation and are not claimed to be undoable.
- T2.1-1 atomically enables **reversible-record health** together with ordinary
  record persistence, latest-target transition, and the no-record-no-commit
  mutation precondition. From that same reviewed cutover, a supported successful
  Rename/Display Rename/Merge/Remove must have its complete record, or the
  server rolls the operation back/fails closed.

The read-only management preflight may report foundation or reversible-record
diagnostics according to this phase. After T2.1-1 activation, unavailable
reversible-record health returns the existing 503 fail-closed envelope for new
supported mutations; no mutation without a record is allowed. Ordinary reads
remain available only to the extent the existing application health boundary
permits. There is no split deployment in which record writes are enabled
without the latest-target transition or vice versa.

The Vite and production startup seams are changed identically. A test-only
health reset/injection seam is allowed; no feature flag or operator bypass is
introduced.

## 26. Undo Apply Transaction

`applyUndo` in `server/tagUndo.ts` follows this exact sequence:

1. Parse exact `{ recordId, undoFingerprint }` and validate positive bounds.
2. Perform deferred discovery and build the current Undo plan.
3. Resolve all required document paths and acquire them in the existing sorted
   global order.
4. Start one `BEGIN IMMEDIATE` transaction.
5. Reload the singleton, parent, child rows, generation, and current graph.
6. Require the record to remain current/latest/unconsumed and recompute the
   Undo plan/fingerprint.
7. Reject stale/conflict/consumed/superseded before any mutation SQL.
8. Create the temporary affected-document/version table.
9. Execute the complete operation-specific inverse from §§18–21.
10. Update each affected document once with a monotonic version.
11. Verify full postconditions and exact counts.
12. Generate/store `undo_operation_id` and `undo_result_id`, mark the parent
    consumed, update the singleton state, and delete child deltas.
13. Drop temporary tables and commit.

Every pre-commit failure rolls back the inverse, source tag row, associations,
versions, consumed state, and child deletion. No client scope or inverse data is
accepted.

## 27. Exactly-Once / Recovery

The identifier contract is:

| Identifier | Meaning/trust |
| --- | --- |
| `operationId` | Existing original Phase 2 operation identity; stored exactly in the record |
| `resultId` | Existing original result identity; stored exactly in the record |
| `undoRecordId` / `recordId` | Durable current parent identity, server-generated |
| `undoOperationId` | Server-generated identity for the committed Undo attempt |
| `undoResultId` | Server-generated committed result identity stored with consumed state |

The client submits only `recordId` and the reviewed Undo fingerprint. If an
Undo commits but the response or refresh fails, the UI enters
`undo-sync-pending`; Retry reads fresh availability/posts/tags and never calls
Undo Apply again. If a response is contradictory, the client trusts the
submitted `recordId`, uses the dedicated committed-recovery seam, and reads the
consumed record/result state. A second Apply sees `consumed` and cannot mutate.

Failure injection covers after association inverse, after stable-ID restore,
after versions, after consumed-state write, before postcondition, before
commit, after commit before response, and contradictory committed responses.
Two concurrent Apply calls can commit at most one inverse.

## 28. API Contract

T2.1-4 is the single public protocol-exposure phase. It adds parallel routes
in the existing authenticated `server/routes/tags.ts`; T2.1-2 and T2.1-3
provide only internal domain planner/apply functions and add no public route.

```text
GET  /api/tags/undo
POST /api/tags/undo/preview
POST /api/tags/undo/preview/page
POST /api/tags/undo/apply
```

Exact request bodies:

```json
GET /api/tags/undo

POST /api/tags/undo/preview
{"recordId":"<opaque-id>","limit":20}

POST /api/tags/undo/preview/page
{"recordId":"<opaque-id>","undoFingerprint":"<64 lowercase hex>","afterDocumentId":"<cursor>","limit":100}

POST /api/tags/undo/apply
{"recordId":"<opaque-id>","undoFingerprint":"<64 lowercase hex>"}
```

`limit` is optional only on the initial Preview and is bounded to 20; page
limits are bounded to 100. The server ignores no unknown fields: exact runtime
guards reject them.

Preview response contains the §15 availability identity, original operation and
timestamp, before/post tag rows, inverse counts, warnings, bounded sample,
cursor, `undoFingerprint`, `undoContractVersion`, and `allowedToApply`. It
never includes the full child delta or client-authoritative document scope.

Apply response contains `undoRecordId`, original operation/result identity,
`undoOperationId`, `undoResultId`, kind, restored source/destination rows,
inverse counts, version count, commit timestamp, fingerprint, and consumed
lifecycle. It contains no Markdown/body data.

Domain error codes are:

```text
UNDO_UNAVAILABLE
UNDO_PREVIEW_REQUIRED
UNDO_STALE
UNDO_CONFLICT
UNDO_SUPERSEDED
UNDO_ALREADY_APPLIED
UNDO_RECORD_CORRUPT
UNDO_STABLE_ID_CONFLICT
UNDO_IDENTITY_CONFLICT
UNDO_DOCUMENT_MISSING
UNDO_ASSOCIATION_CONFLICT
```

Health errors remain `TAG_MANAGEMENT_UNAVAILABLE` with status 503. Current
state/fingerprint/lifecycle conflicts use 409; malformed input uses 400; old
server absence is safely handled as unavailable. The existing auth, CSRF,
JSON, no-store, and sanitized error-envelope boundaries remain in force.

## 29. Client Contract

Add a dedicated `src/lib/tag-undo-api.ts` rather than unsafe unions in
`tag-management-api.ts`. It defines exact runtime-guarded types:

```ts
type UndoAvailability
type UndoPreview
type UndoApplyRequest
type UndoApplyResult
type UndoError
```

The module exports `getUndoAvailability`, `previewUndo`,
`getUndoPreviewPage`, and `applyUndo`. It validates record IDs, contract
versions, stable rows, counts, sample/page bounds, lifecycle/validation enums,
fingerprints, result identity relationships, and exact object keys. It exports
`assertUndoApplyMatchesReviewedPreview` for the same client-side protocol
binding role as Phase 2 Apply.

The client never sends child associations, document IDs, old timestamps, tag
snapshots, or a replacement stable ID. It retains the submitted `recordId` as
the trusted recovery identity when an Apply response is malformed.

## 30. UI State Machine

Extend `TagManagementDialog.vue`; do not create a second global manager or make
TagPanel own Undo state. Keep the existing ordinary manager state and add a
narrow `undoState` sub-state:

```text
undo-unavailable
undo-available
undo-previewing
undo-preview-ready
undo-confirming
undo-applying
undo-committed-refreshing
undo-sync-pending
undo-conflict
undo-stale
undo-success
undo-superseded
undo-terminal-unavailable
```

The dialog loads availability on open and after every authoritative sync. A
successful ordinary Apply refreshes posts, managed tags, and Undo availability
in the same VaultView-owned Promise.all cycle. The dialog shows a bounded Last
Change summary and an Undo button only when the server says the latest record
is available. Clicking it requests Preview; Preview shows operation/time,
before/post tags, counts, samples, warnings, and a documents/Markdown/Git
preservation explanation. Apply is impossible before a current Preview and
explicit confirmation.

Use `confirmCancellable`/`ConfirmHost` for confirmation. Cancel, backdrop, and
Escape do not mutate and leave the valid Preview available. The existing safe
Cancel default focus and focus restoration are retained. `undo-sync-pending`
has a Retry synchronization action only. No global keyboard shortcut is added.

`VaultView.vue` receives typed `syncAfterUndo` and
`recoverCommittedUndo` seams alongside the existing ordinary-operation seams.
`TagPanel.vue` continues to emit only the production entry action and keeps its
Phase 1 projections unchanged.

## 31. Selection Reconciliation

Add an Undo-specific stable-ID reconciliation seam to
`src/lib/tag-selection-reconciliation.ts`:

| Undo | Selected stable ID at Undo start | Fresh result |
| --- | --- | --- |
| Rename Undo | source ID | same source ID, fresh original display |
| Display Rename Undo | source ID | same source ID, fresh original display |
| Merge Undo | restored source ID | source ID; destination ID remains if selected |
| Merge Undo | destination ID | destination ID |
| Remove Undo | restored source ID, if it was resolved before Apply | restored source ID |
| Any Undo | unrelated ID | same unrelated stable ID |
| Any Undo | unresolved display-only string | never rebound by display coincidence |

The snapshot contains selected display, resolved stable ID, and selection epoch.
`VaultView` applies reconciliation only after authoritative synchronization and
only when the epoch is unchanged. A user selection made during Undo wins. The
dialog never directly assigns production `selectedTag` and never optimistically
rewrites it before commit. The same trusted record/operation identity is used
for committed protocol-mismatch recovery.

## 32. Security

Preserve owner authentication, same-origin CSRF, JSON content-type enforcement,
`Cache-Control: no-store`, exact safe-integer parsing, bounded names/counts,
and sanitized diagnostics.

Additional rules:

- record IDs, operation IDs, and fingerprints are opaque and server-generated;
- the client cannot submit inverse rows, associations, document scope, tag
  snapshots, or stable-ID replacement choices;
- all tag rows are validated under `tag-identity-v1` before rendering/restore;
- tag names are escaped text, never HTML, Markdown, paths, or SQL;
- errors expose stable code/correlation data only, never raw SQL, SQLite
  constraint text, filesystem paths, stack traces, bodies, or secrets;
- unauthorized, cross-site, wrong-content-type, unknown-field, NUL/control,
  oversized, unsafe-integer, malformed-fingerprint, and injection-shaped inputs
  fail before mutation;
- a record from another database generation cannot be applied.

## 33. Compatibility

The production Docker image remains one atomic SPA/server build.

| Client/server | Required behavior |
| --- | --- |
| New Undo client + new Undo server | Availability and flows work only after migration/health and a safe current record |
| Old Phase 2 client + new Undo server | Existing Rename/Merge/Remove requests remain field/protocol safe; the old client does not discover or invoke Undo; the new server records them durably |
| New Undo client + old Phase 2 server | `/api/tags/undo*` 404/503 is interpreted as unavailable; hide/disable Undo; do not mutate or guess |
| New client + malformed/unsupported record | Terminal/unavailable state; no mutation |

No arbitrary cross-version compatibility is promised. A hard browser refresh may
be required after deployment. Old full tag writes without the current Phase 2
version token remain fail-closed under the existing writer-safety contract.

## 34. Migration / Upgrade

The upgrade rehearsal starts from a real Phase 2 v6 database, not an invented
post-Undo state. It covers:

- clean and dirty historical tags, orphans, existing memberships, and the
  10k/50k fixture;
- WAL mode with writers quiesced, migration restart, and idempotent rerun;
- exact logical tags/document memberships and unchanged document/tag IDs;
- explicit association IDs assigned to every existing association;
- version-aware processing of a real pre-upgrade v6 durable metadata recovery
  journal after migration 0007, including safe normalization and an unsafe
  external-drift quarantine case;
- schema, index, integrity, foreign-key, and singleton-generation checks;
- interrupted/failed migration rollback to v6 and successful retry;
- T2.1-0 foundation-only startup with no Undo route/UI and ordinary operations
  explicitly remaining pre-activation/non-Undoable;
- the T2.1-1 activation cutover, where the first successful supported Apply
  creates the first record and record health becomes a mutation precondition;
- startup order and health behavior when schema/provenance/record checks fail.

The implementation may add a test-only migration failure hook in `server/db.ts`
or `server/__tests__/db.test.ts`, but no operator bypass. A failed migration
does not delete existing data and leaves management unavailable or startup
blocked according to the existing migration runner boundary. No reverse
identity migration is introduced. A foundation-only T2.1-0 deployment must not
be treated as a partially active Undo deployment; T2.1-1 is the single
reviewed activation cutover.

## 35. Backup / Restore / Downgrade

Follow `docs/deployment/backup-and-restore.md`: stop/quiesce writers or use a
SQLite-aware consistent snapshot covering WAL/SHM, and back up the matching
vault, hidden `.git`/`.nuvyn` state, full data directory, and required master
key/configuration. Never copy only a live `nuvyn.db` main file.

The implementation rehearsal must execute:

1. v6 pre-upgrade snapshot and consistent backup with integrity/FK checks;
2. deploy the matching new image, apply 0007, and verify healthy Undo schema;
3. after the T2.1-1 activation cutover, perform an ordinary management
   operation and verify its durable record;
4. optionally perform committed Undo and verify consumed state in a backup;
5. stop the new image and restore the matching pre-upgrade database/vault set;
6. run the matching old application image/runtime against that restored state;
7. verify `/api/health`, representative notes/tags/memberships/History/auth,
   database integrity, FKs, and Markdown bytes/mtimes.

There is no reverse identity or reverse Undo migration. Rollback after a
successful consolidation/Undo-schema upgrade requires the matching pre-upgrade
backup plus matching old/compatible application image/runtime. Losing tag IDs
are never reconstructed. A restore returns the Undo availability contained in
that database generation; a partial SQLite-only or vault-only restore is not a
complete recovery model.

## 36. Concurrency

The two-connection WAL matrix must cover:

- Undo Preview while an unrelated title/summary edit commits: Preview remains
  valid; later values survive;
- Undo Preview while an unrelated tag is added/removed on an affected document:
  Preview remains valid when operation-owned IDs remain valid;
- Preview while a current operation-owned destination association is deleted or
  re-added: fresh plan conflicts/stales by association ID;
- Preview while source identity becomes occupied: conflict, non-consuming;
- Preview while a successful ordinary Tag operation supersedes the target:
  terminal superseded;
- two Undo Applies: one commit, one consumed/stale response;
- Undo racing ordinary Apply: `BEGIN IMMEDIATE` serializes; the loser
  recomputes and fails safely, with no partial graph;
- Undo racing metadata delete/re-add: document lock plus association ID
  mismatch prevents ownership guessing;
- conflict appears and clears: a fresh Preview succeeds if record remains
  latest/unconsumed.

Document paths are resolved and locked in the same sorted order as Phase 2.
Database writes use one IMMEDIATE transaction. No inconsistent lock order,
per-document network loop, or production sleep is permitted.

## 37. Scale / Performance

Preserve the Phase 2 target of approximately 10,000 documents and 50,000
associations. Measure, without creating a fixed SLA:

- 0007 provenance migration;
- ordinary Rename/Display Rename record capture;
- 10k Merge/Remove child delta capture;
- Undo Preview and page continuation;
- 10k Merge/Remove Undo Apply;
- startup/health scan and backup/restore rehearsal.

The query shape is set-based: bulk child `INSERT ... SELECT`, temp tables for
affected IDs/version candidates, one bulk delete by exact association IDs, bulk
source association insertion, and one transaction. No client request per
document/association and no SELECT-per-document is allowed. API samples remain
at most 20 initially and pages at most 100. Record storage is relational and
bounded by the current target, not a JSON blob containing an unbounded inverse.

Record exact counts, query counts, sample/page bounds, transaction duration,
elapsed time, and heap observations. Timing and memory are observational only;
do not invent a CI wall-clock or heap SLA.

## 38. Accessibility / I18n

Use the existing dialog, focus trap, `ConfirmHost`, `useConfirm`, and `useI18n`
seams. Add zh/en strings for:

- Undo, Undo Rename, Undo Display Rename, Undo Merge, Undo Remove;
- Last change, Preview Undo, original operation/time, affected counts,
  association additions/removals, stable-ID restoration;
- safe/unavailable, conflict, stale, superseded, consumed, terminal-unavailable;
- mandatory confirmation, Cancel, confirm, documents/Markdown preserved;
- committed-refreshing, sync-pending, Retry synchronization only, success.

The test matrix covers role dialog/alertdialog, `aria-modal`, accessible title
and description, keyboard-only Preview/confirm, nested focus trap, safe Cancel
default focus, Escape cancellation, focus restoration, disabled states, live
regions for Preview/conflict/stale/commit/sync-pending/success, and destructive
meaning conveyed by text/semantics rather than color. Editor Ctrl/Cmd+Z remains
unhandled by Tag Management.

## 39. Observability

Add bounded diagnostic events for:

- ordinary operation recorded;
- Undo availability/Preview and conflict category;
- Undo Apply attempted/committed;
- sync-pending and recovery;
- schema migration and health transitions.

Events may include original operation ID/result ID, Undo record/result IDs, kind,
stable source/destination IDs, affected/add/remove/version counts, conflict
category, commit time, generation/contract versions, and retry stage. They must
not include Markdown bodies, full delta lists, raw SQL, filesystem secrets,
session tokens, or stack traces. Logging failure is never transaction authority.

Logs distinguish durable lifecycle (`latest`, `consumed`, `terminal`, compact
superseded) from current validation (`safe`, `stale`, `conflict`, temporary
unavailable).

## 40. Protected Areas

The implementation must run and record this audit:

| Protected area | Required result |
| --- | --- |
| Markdown bytes, Frontmatter, mtimes | Byte/mtime identical before/after management/Undo |
| Markdown rendering, Wiki links, Markmap, Mermaid, KaTeX, Emoji | Existing unit/browser/visual lanes green |
| Git HEAD/status/History, link index, `fileChanges` | No management/Undo mutation or History entry |
| Draft Recovery | Existing ownership/storage and recovery tests unchanged |
| Authentication/CSRF | Existing auth and boundary tests green; no new permission model |
| Docker/Compose | Production image remains atomic; Docker smoke green |
| Phase 1 Tag Query/TagPanel/FileTree | Filtering, ordering, selection, result rows, and query semantics unchanged |
| `PostSummary.tags` | Shape and ordinary query behavior unchanged |
| Editor Undo stack | No global keyboard interception or editor state mutation |

Any proposed change to these contracts is an Architecture / PRD Conflict, not
an implementation convenience.

## 41. Test Architecture

Map implementation to concrete test layers and expected files:

| Layer | Planned evidence |
| --- | --- |
| Shared/domain | `server/__tests__/tagUndo.test.ts`, `server/tagUndo.ts` planner/algorithm unit cases |
| Schema/migration | `server/__tests__/db.test.ts` and `server/__tests__/tagUndoMigration.test.ts` for v6→v7, rebuild, retry, interruption, integrity/FK |
| Provenance/writers | `server/__tests__/documentMetadata.test.ts`, `metadata-api.test.ts`, `tools.test.ts`, `tagIdentityMigration.test.ts`, and new writer matrix cases |
| Ordinary Apply recording | `server/__tests__/tagManagement.test.ts` plus failure-injection record/delta/latest-target cases |
| Undo API | `server/__tests__/tagUndo-api.test.ts` or the existing `tags-api.test.ts` extension for auth, JSON, errors, availability, Preview, page, Apply |
| Client guards | `src/lib/__tests__/tag-undo-api.test.ts` with malformed IDs, contracts, fields, fingerprints, samples, results |
| Selection | `src/lib/__tests__/tag-selection-reconciliation.test.ts` Undo mappings, stable IDs, epoch, recovery |
| Component | `src/components/vault/__tests__/TagManagementDialog.test.ts` Undo state/Preview/confirm/sync/i18n/a11y |
| Confirm integration | `src/components/__tests__/ConfirmHost.test.ts` existing contract plus Undo invocation coverage |
| Vault/Phase 1 | `src/views/__tests__/VaultView.test.ts` and `src/components/vault/__tests__/TagPanel.test.ts` |
| Browser | `e2e/tag-management.spec.ts` production Rename/Display Rename/Merge/Remove plus Undo flows |
| Auth/browser | Existing `e2e/auth-browser.spec.ts` and auth CI lanes with old/new compatibility fixtures |
| Docker | Existing Docker smoke and an isolated Undo migration/health startup check |
| Scale | `server/__tests__/tagManagement.scale.test.ts`, `tags-api.scale.test.ts`, and new Undo scale suite |
| Rehearsal | Disposable backup/upgrade/failure/restore/old-image rehearsal evidence, never a fake fixture-only assertion |

### Master regression additions for this repair

The implementation must add these named cases to the master regression matrix;
they are not optional prose examples:

| Case | Required evidence |
| --- | --- |
| AH | Merge-created Backend association → later unrelated Python addition through REST tag patch → Backend `association_id` unchanged → Undo Merge succeeds → Python survives |
| AI | The same later-unrelated-Python scenario through the AI metadata tag writer; unchanged operation-owned provenance remains valid and Undo succeeds |
| AJ | Backend remains in the requested tag set across a tag replacement; Backend `association_id` is unchanged |
| AK | Backend is truly removed and later re-added; its `association_id` changes and Undo reports a provenance conflict |
| AL | Real v6 durable metadata recovery journal without `association_id` → v7 migration → startup recovery succeeds safely, creates no Undo record, and leaves valid v7 IDs |
| AM | The same v6 journal with unsafe external current-state drift → v7 startup recovery fails closed/quarantines without overwriting the drift |
| AN | T2.1-0 intermediate build → migration/provenance foundation healthy, no public Undo API/UI, and no claim that new ordinary operations are Phase 2.1-undoable |
| AO | T2.1-1 activation → the first successful supported ordinary operation has one complete durable record and latest-target transition |
| AP | T2.1-1 reversible-record subsystem unhealthy → the supported ordinary mutation does not commit and no record-less success is observable |

AH–AK belong to the T2.1-0 writer/provenance foundation plus the T2.1-2/3
Undo behavior; AL–AN are T2.1-0/T2.1-6 migration and activation rehearsal;
AO–AP are the T2.1-1 activation gate. Each case must retain exact database,
association-ID, lifecycle, and integrity assertions rather than snapshots.

The writer suite also contains an explicit no-op case: an identical requested
logical set performs zero `document_tags` rewrites and changes no provenance
ID. It separately verifies that snapshot/CAS compensation is not used as the
ordinary REST/AI writer.

## 42. Failure Injection

Use deterministic test-only hooks, never sleeps. Ordinary Apply hooks must cover:

- after normal tag/association mutation;
- after document versions;
- after parent record insert;
- after removed-source child rows;
- after created-destination child rows;
- after latest-target transition;
- before postcondition and before commit.

Undo hooks must cover:

- after explicit source tag restore;
- after exact association deletion/addition;
- after version updates;
- after consumed-state write;
- before postcondition and before commit;
- after commit before client response;
- contradictory committed response and refresh failure.

Every pre-commit failure must prove tags, associations, documents/versions,
parent lifecycle, child rows, singleton pointer, and previous target are exactly
the pre-attempt state. Post-commit failures must prove sync-only recovery and no
second Apply.

## 43. PRD Traceability

| Approved PRD contract | Implementation phase | Module/schema | Test/release evidence |
| --- | --- | --- | --- |
| Single-level durable Undo | T2.1-0/1/4 | `tag_undo_state`, `tag_undo_records` | lifecycle/supersession tests, restart/rehearsal |
| Refresh/restart durability | T2.1-0/2/4/6 | SQLite parent/state and startup health | restart and availability API tests |
| Atomic ordinary Apply recording | T2.1-1 | `server/tagManagement.ts` + record tables | injected record/transition rollback tests |
| Association provenance/delete→re-add | T2.1-0/1/2/3 | `document_tags.association_id`, delta child | writer matrix, Merge delete/re-add conflict |
| Rename/Display Rename inverse | T2.1-2/3/5 | Undo planner/apply/UI | basic, later association, title/summary cases |
| Merge source-only/overlap/destination-only | T2.1-1/2/3 | child effects and `server/tagUndo.ts` | C/D/E/Q/R regression cases |
| Remove/orphan/stable ID | T2.1-2/3 | explicit tag restore + child delta | F/G/H/I/J/K/AC cases |
| Later-change preservation | T2.1-2/3/6 | separate fingerprint and set inverse | L/M/N/O/P tests |
| Dynamic non-consuming conflicts | T2.1-2/3 | lifecycle/validation split | S/T and conflict retry cases |
| Mandatory Preview/confirmation | T2.1-4/5 | Undo routes/dialog/ConfirmHost | component and production browser |
| Exactly-once/sync-pending | T2.1-3/4/5 | consumed state and recovery seam | Y/Z/AA and browser request counts |
| Metadata versions | T2.1-1/3 | existing monotonic helper/temp table | exact one/zero version tests |
| Auth/CSRF/no-store/security | T2.1-4/6 | existing auth boundary/routes | invalid/unauthorized/CSRF matrix |
| Accessibility/i18n | T2.1-5/6 | dialog/ConfirmHost/useI18n | keyboard/live/zh/en tests |
| Scale/no N+1 | T2.1-0/1/2/3/6 | set SQL/temp tables/scale suite | 10k/50k observations |
| Migration/backup/restore/downgrade | T2.1-0/6/7 | 0007, startup, operator rehearsal | AD and isolated old-image rehearsal |
| Legacy v6 durable recovery compatibility | T2.1-0/6 | version-aware snapshot parser/normalizer and existing CAS recovery | AL/AM real v6-journal upgrade/recovery rehearsal |
| Phase 2.1 activation cutover | T2.1-0/1 | foundation health then reversible-record health | AN/AO/AP intermediate-build and first-record tests |
| Compatibility/protected areas | T2.1-4/6/7 | atomic image and existing seams | AE/AF/AG, full CI/browser/visual |

No approved PRD requirement is intentionally left without a phase, module, and
gate.

## 44. Architecture Decision Log

| Decision | Alternatives considered | Chosen option and reason | Trade-off / evidence |
| --- | --- | --- | --- |
| Association provenance | Pair equality, implicit rowid, generation column, event log | Explicit `association_id AUTOINCREMENT`; exact delete/re-add identity without event sourcing | Rebuilds table and touches every writer; migration/writer tests required |
| Ordinary metadata tag writer | Full delete/reinsert, set-diff | Set-diff preserving every unchanged `association_id`; true delete→re-add receives a new ID | Required to preserve unrelated later tag edits and avoid false Undo provenance conflicts; AH–AK and REST/AI writer tests |
| Legacy recovery snapshot compatibility | Reject v6 journals, pretend missing IDs are historical, permissive mixed parser | Version-aware exact v6/v7 normalization; v6 preserves a proven current ID or allocates a new one and never invents provenance | Keeps pre-upgrade durable journals recoverable after migration without weakening CAS; AL/AM |
| Phase 2.1 activation | Activate at schema migration, disable all management temporarily, split recording and health | Explicit T2.1-1 atomic activation cutover | T2.1-0 is foundation-only; T2.1-1 jointly enables recording, latest-target transition, reversible-record health gating, and no-record-no-commit; AN–AP |
| `document_tags` migration | Add column, retain rowid, rebuild | Transactional v7 rebuild with logical copy and new IDs | DDL/backup risk; v6/v7 rehearsal and integrity checks |
| Record storage | Full JSON snapshot, event sourcing, per-operation history | One parent plus set-oriented child delta | Heavy latest operation still uses rows; bounded at one target |
| Latest target | Unlimited history, singleton JSON, pointer plus records | Singleton pointer + one current parent + compact previous ID | Older superseded diagnostics are intentionally discarded |
| Merge delta | Full document tag snapshot, pair equality | Removed-source + created-destination association IDs | Overlap is derived from child effects; provenance mismatch fails closed |
| Remove inverse | Recreate by name/auto ID, full DB restore | Explicit stable-ID insert plus new associations | ID/identity conflicts reject whole Undo |
| Undo fingerprint | Reuse Phase 2 fingerprint, timestamp token, full snapshot | Separate v1 relevant-graph fingerprint excluding title/summary/version | Path/association changes can stale; unrelated edits survive |
| Health integration | Overload identity module, feature flag, ignore health | Narrow Undo health seam after identity health | More startup checks; no unsafe bypass |
| Transaction boundary | Record after commit, second transaction | Record/children/latest transition inside existing Apply transaction | Larger transaction; failure injection proves rollback |
| API layout | Overload Phase 2 operations, client reconstruction, expose Preview early | T2.1-2/3 domain-only planner/apply; T2.1-4 exposes all public `/api/tags/undo*` routes and the dedicated client module | Clean ownership prevents a partially exposed protocol; old server safely unavailable |
| UI ownership | Global Undo store, TagPanel state, global shortcut | Existing dialog + VaultView sync/recovery seams | Dialog gains a second sub-state but no new architecture |
| Versioning | Restore old timestamps, increment all rows | Existing monotonic helper and operation-specific affected set | Newer DB versions remain visible and unrelated rows untouched |

## 45. Implementation Phases

The delivery sequence is strictly:

```text
T2.1-0 PASS
→ T2.1-1 PASS
→ T2.1-2 PASS
→ T2.1-3 PASS
→ T2.1-4 PASS
→ T2.1-5 PASS
→ T2.1-6 PASS
→ T2.1-7 external closure review
```

### T2.1-0 — Reversible State and Association Provenance Foundation

- **Goal / why:** add migration 0007, explicit association identity, durable
  parent/child/state schema, v6/v7 recovery compatibility, and set-diff writer
  provenance before any reversible record is exposed. This phase installs the
  foundation only; it does not activate user-facing Undo guarantees.
- **Expected files/modules:** `server/migrations/0007_tag_management_undo.sql`,
  `server/tagUndoHealth.ts`, `server/db.ts` test seam,
  `server/documentMetadata.ts`, `server/tagIdentityMigration.ts`, all audited
  association writers, migration/writer tests. No UI/API exposure.
- **Schema/API:** rebuild `document_tags`; create the three Undo tables and
  contract constants; add version-aware v6/v7 durable snapshot parsing; no
  HTTP route, client contract, Undo Preview, or Undo UI.
- **Sequence:** apply v7; verify logical graph; replace the ordinary existing-
  document tag writer with set-diff; classify full-snapshot/CAS recovery as a
  separate writer contract; add v6/v7 snapshot normalization; add foundation
  health after identity health; keep management UI/routes and reversible-record
  activation unchanged.
- **Activation:** this is `FOUNDATION INSTALLED, PHASE 2.1 UNDO NOT ACTIVATED`.
  Existing ordinary Rename/Display Rename/Merge/Remove behavior remains the
  explicit pre-activation Phase 2 behavior and is not claimed to be undoable.
- **Tests/failure/concurrency:** v6→v7 clean/dirty/large/WAL/retry/interruption,
  association IDs, set-diff/no-op/delete→re-add, REST/AI writer matrix,
  v6 durable-journal recovery and unsafe-drift quarantine, compensation exact
  restore, foundation-only no-API/UI, and two-connection identity uniqueness.
- **Security/performance/protected audit:** no new input surface; schema checks
  reject malformed state; copy and health are set-based; all Phase 1/file/Git/
  auth/Draft Recovery tests remain green.
- **Gate/exit:** migration clean and idempotent, logical associations unchanged,
  every ordinary existing-document writer preserves unchanged IDs and allocates
  only true additions, v6 journals remain safely recoverable, foundation health
  is correct, no Undo API/UI is exposed, reversible recording is not activated,
  and Phase 2 remains green.
- **Commit boundary/dependency:** `feat(tags): add undo provenance foundation`;
  starts only after this plan is approved and Phase 2 remains green.

### T2.1-1 — Atomic Ordinary Apply Recording

- **Goal / why:** perform the single Phase 2.1 activation cutover and make every
  new successful Rename, Display Rename, Merge, and Remove durably reversible
  without a second transaction.
- **Expected files/modules:** `server/tagManagement.ts`, `server/tagUndo.ts`
  persistence helpers, current tag-management tests, failure-injection tests.
- **Schema/API:** populate the v1 parent/child records and atomically advance
  `tag_undo_state`; no public Undo endpoint yet. Activate reversible-record
  health as a mutation precondition in the same reviewed commit.
- **Activation cutover:** atomically enable (1) durable reversible recording,
  (2) latest-target transition, (3) reversible-record health gating for
  supported ordinary mutations, and (4) the fail-closed no-record-no-commit
  invariant. There is no intermediate commit that enables only one of these.
- **Sequence:** preserve current plan/lock/IMMEDIATE boundary; insert new parent;
  capture removed/created IDs; perform the set-diff-preserving mutation; verify;
  pointer-swap; purge old target; commit. Roll back all on any
  record/transition/health failure.
- **Tests/failure/concurrency:** four operation record shapes, orphan Remove,
  source/overlap/destination delta, failed ordinary Apply leaves old target,
  failures at every parent/child/pointer stage, first post-activation record,
  record-health unavailable, old-client/new-server server-side recording,
  duplicate Apply, WAL race, exact counts and versions.
- **Security/performance/protected audit:** record is server-created and bounded;
  child capture is bulk SQL; no client payload changes; file/Git/Phase 1 tests
  stay green.
- **Gate/exit:** activation is atomic; every successful post-activation
  supported Apply has one complete matching record; record/child/latest
  transition failure rolls back the ordinary mutation; reversible-record health
  is a mutation precondition; old clients still get server-side recording; no
  record-less success exists. Public Undo Preview/Apply remains hidden until
  later protocol phases.
- **Commit boundary/dependency:** `feat(tags): record reversible tag operations atomically`;
  requires T2.1-0 PASS.

### T2.1-2 — Undo Planner and Preview

- **Goal / why:** derive a safe inverse from durable state and current SQLite
  state before adding any mutation endpoint.
- **Expected files/modules:** `server/tagUndo.ts`,
  `server/__tests__/tagUndo.test.ts`, and internal planner/contract tests. No
  public route module or API route test is owned here.
- **Schema/API:** internal availability read model, Preview, bounded page
  computation, and fingerprint contracts only; no public HTTP route, Undo Apply
  endpoint, client contract, or production UI.
- **Sequence:** implement current validation, operation-specific inverse counts,
  association-ID checks, stable-ID checks, separate fingerprint, bounded sample,
  and dynamic conflict/non-consuming lifecycle.
- **Tests/failure/concurrency:** all four Preview kinds, delete→re-add conflict,
  dynamic conflict clear/re-Preview, unrelated title/summary/tag/Markdown/Git
  changes, missing document, occupied ID/identity, pagination tamper, two WAL
  connections, record corruption.
- **Security/performance/protected audit:** internal domain bounds and
  fingerprint checks, no delta in any future wire response, set query shape/no
  N+1, no public HTTP surface, UI, shortcut, or file mutation.
- **Gate/exit:** all four inverse plans are complete and deterministic; unrelated
  changes do not false-conflict; provenance mismatch is proven; Preview remains
  mandatory and read-only when later exposed; no public HTTP route or Apply
  mutation is exposed in this phase.
- **Commit boundary/dependency:** `feat(tags): add undo planner and preview`;
  requires T2.1-1 PASS.

### T2.1-3 — Atomic Undo Apply

- **Goal / why:** implement the safe inverse as one atomic server forward
  mutation, independent of production UI.
- **Expected files/modules:** `server/tagUndo.ts`, `server/documentMetadata.ts`
  version/temp-table helpers, `server/documentWriteLock.ts` only if the same
  lock seam needs typed reuse, domain tests.
- **Schema/API:** internal domain Apply result and consumed parent state; HTTP
  mutation remains hidden until T2.1-4; no public route is added here.
- **Sequence:** discovery → sorted locks → IMMEDIATE → reload/replan/fingerprint
  → operation inverse → one version bump per affected document → postcondition
  → consumed IDs/child purge → commit.
- **Tests/failure/concurrency:** Rename/Display/Merge/Remove algorithms,
  source/overlap/destination semantics, stable-ID conflicts, missing docs,
  later changes, all failure hooks, duplicate/concurrent Applies, ordinary Apply
  race, delete/re-add race, exact consumed state.
- **Security/performance/protected audit:** no client scope, explicit identity
  checks, bulk set operations at 10k/50k, no Markdown/Git/editor mutation.
- **Gate/exit:** no partial inverse, versions exact, one of concurrent Applies
  commits, consumed record distinguishes failure from success. No user UI or
  HTTP dependency required.
- **Commit boundary/dependency:** `feat(tags): add atomic tag undo apply`;
  requires T2.1-2 PASS.

### T2.1-4 — Undo API and Client Protocol

- **Goal / why:** expose the reviewed server contract and recovery identities to
  authenticated clients without exposing inverse authority.
- **Expected files/modules:** `server/routes/tags.ts`, `src/lib/tag-undo-api.ts`,
  client/API tests, auth/CSRF tests, compatibility fixtures.
- **Schema/API:** this is the sole public protocol-exposure phase: add all four
  `/api/tags/undo*` routes (`GET /undo`, `POST /preview`, `POST /preview/page`,
  `POST /apply`), error mapping, `UndoAvailability`, `UndoPreview`, and
  `UndoApplyResult` runtime guards. T2.1-2 owns no HTTP handler.
- **Sequence:** route health/auth; parse exact body; call domain planner/apply;
  map stable errors; enforce no-store; validate client identities/fingerprints;
  add trusted-record recovery handling.
- **Tests/failure/concurrency:** unauthorized/CSRF/content-type/unknown fields,
  old server/new client, old client/new server, malformed response, preview
  continuation, stale/conflict/consumed, committed response mismatch.
- **Security/performance/protected audit:** existing auth boundary remains the
  owner; bounded summaries and samples; no new dependency; Phase 2 routes and
  PostSummary/TagPanel remain unchanged.
- **Gate/exit:** API matrices green, old/new compatibility safe, domain Apply
  still exactly once, client never sends inverse scope. No user-visible Undo
  control yet.
- **Commit boundary/dependency:** `feat(tags): expose tag undo protocol`;
  requires T2.1-3 PASS.

### T2.1-5 — Undo Management UI

- **Goal / why:** add the user-facing single-level Undo flow to the existing
  manager without a second state architecture.
- **Expected files/modules:** `TagManagementDialog.vue`, `VaultView.vue`,
  `tag-selection-reconciliation.ts`, `useI18n.ts`, component/Vault/ConfirmHost
  tests, `e2e/tag-management.spec.ts`.
- **Schema/API:** consume the T2.1-4 contracts; add typed sync/recovery seams,
  no new server mutation authority.
- **Sequence:** load availability; show Last Change; Preview; render counts /
  sample/warnings; ConfirmHost confirmation; Apply; authoritative sync; map
  selection; handle conflict/stale/superseded/terminal/sync-pending; add zh/en
  and focus/live behavior.
- **Tests/failure/concurrency:** component state matrix, Cancel/Escape/no Apply,
  focus return, all four browser Undo flows, committed refresh failure and
  sync-only retry, protocol mismatch recovery, epoch race, selection mappings,
  i18n/a11y.
- **Security/performance/protected audit:** no global shortcut, no optimistic
  selectedTag, bounded UI sample, TagPanel/FileTree/Markdown/Git regression.
- **Gate/exit:** component and real production browser flows green; Preview is
  mandatory; no second Apply on retry; selection/a11y/i18n pass.
- **Commit boundary/dependency:** `feat(tags): add tag management undo ui`;
  requires T2.1-4 PASS.

### T2.1-6 — Hardening

- **Goal / why:** close the full safety, scale, compatibility, migration, and
  operational rehearsal matrix before closure.
- **Expected files/modules:** only owning-phase fixes; hardening tests, CI
  configuration only if an already-approved lane needs wiring, rehearsal
  scripts kept disposable unless separately reviewed.
- **Schema/API:** no new product behavior; verify final v7 schema, health,
  routes, and contracts.
- **Sequence:** run migration/writer/atomicity/concurrency/security/a11y/browser/
  scale/Docker/backup/restore/downgrade matrices; assign defects back to their
  owning phase; never weaken assertions.
- **Tests/failure/concurrency:** all required regressions A–AP, including the
  approved PRD regressions A–AG and implementation-plan regressions AH–AP,
  10k/50k,
  old/new compatibility, editor Undo, actual matching old-image restore
  rehearsal, and no-open-defect review.
- **Security/performance/protected audit:** verify provenance/error hygiene,
  observational scale provenance, full protected-area matrix and CI OS/Node.
- **Gate/exit:** P0=0, P1=0, no unexplained P2, Architecture / PRD Conflict
  none, all prior gates green. No T2.1-7 closure declaration.
- **Commit boundary/dependency:** `test(tags): harden phase 2.1 undo`;
  requires T2.1-5 PASS.

### T2.1-7 — Closure and Rollout Evidence

- **Goal / why:** create the separate final evidence record; external review,
  not this plan or its implementation commits, decides completion.
- **Expected files/modules:** one closure document under the repository's
  established archive convention; no production code or product feature.
- **Schema/API:** none; document migration/schema/provenance/API/CI/rehearsal
  facts and operator instructions.
- **Sequence:** inventory commits and gates; attach actual CI/browser/scale and
  backup/restore/downgrade evidence; record limitations, protected audit,
  compatibility, and Redo deferral; request external review.
- **Tests/failure/concurrency/security/performance/protected audit:** validate
  references and `git diff --check`; do not replace missing execution evidence
  with prose.
- **Gate/exit:** every T2.1-0–6 checkbox has evidence, no waived invariant,
  final external closure review PASS. This plan does not self-approve it.
- **Commit boundary/dependency:** `docs(tags): close phase 2.1 undo`;
  requires T2.1-6 PASS and remains a documentation-only boundary.

## 46. Acceptance Gates

The following gates are cumulative and remain pending until implementation:

### T2.1-0 gate

- [ ] v7 migration preserves all logical associations.
- [ ] Every existing association has a valid explicit `association_id`.
- [ ] Unchanged logical associations preserve `association_id` during ordinary
      metadata tag edits.
- [ ] A true delete→re-add receives a new `association_id`.
- [ ] REST and AI tag writers use set-diff semantics.
- [ ] Recovery/full-snapshot writers are separately classified and tested.
- [ ] Legacy v6 durable metadata snapshots remain recoverable after v7 upgrade.
- [ ] No Undo API/UI is exposed.
- [ ] Phase 2.1 reversible recording is **not activated yet**.
- [ ] Existing Phase 2 behavior remains green.

This is the foundation-only gate. Passing it does not make any new ordinary
operation user-undoable and does not enable the no-record-no-commit invariant.

### T2.1-1 gate

- [ ] Phase 2.1 activation occurs here.
- [ ] Every new successful supported ordinary operation has one complete
      reversible record.
- [ ] Reversible-record health is now a mutation precondition.
- [ ] Record/child/latest-transition failure rolls back the ordinary mutation.
- [ ] Old client/new server operations are recorded by the server.
- [ ] No successful post-activation management operation exists without a
      record.
- [ ] A failed/stale/cancelled Apply does not supersede the old target.

The four activation items—recording, latest-target transition, health gating,
and no-record-no-commit—ship as one reviewed cutover.

### T2.1-2 gate

Rename, Display Rename, Merge, and Remove Preview inverse semantics are complete;
stable-ID and association provenance conflicts are detected; dynamic conflict is
non-consuming; unrelated later changes do not false-conflict; samples/pages are
bounded and no N+1 exists. This gate exposes no public HTTP route; all public
Undo protocol ownership is deferred to T2.1-4.

### T2.1-3 gate

Undo Apply is one locked IMMEDIATE transaction with a complete inverse, exact
stable-ID restore, exact version set, postconditions, consumed state, and no
partial Merge/Remove. Concurrent attempts commit at most one.

### T2.1-4 gate

HTTP/client contracts have exact guards, auth/CSRF/no-store/error mapping,
bounded responses, old/new compatibility behavior, and trusted committed
recovery. No client inverse scope is authoritative.

### T2.1-5 gate

The existing manager provides latest-change discovery, mandatory Preview,
confirmation, conflict/stale/superseded/terminal/sync-pending states, selection
epoch protection, zh/en, keyboard/focus/live-region behavior, and production
browser evidence. Editor Undo and TagPanel Phase 1 behavior remain unchanged.

### T2.1-6 gate

Migration, writers, atomicity, concurrency, security, a11y, browser, scale,
Docker, auth, backup/restore, downgrade, cross-platform, and protected-area
matrices pass. P0/P1 are zero, no unexplained P2 remains, and there is no
Architecture / PRD Conflict.

### T2.1-7 gate

The closure record is externally reviewed with all evidence attached. The
reviewer, not the implementation plan, makes the final `Phase 2.1 COMPLETE`
decision.

## 47. Commit Strategy

Use one reviewable commit boundary per phase:

```text
feat(tags): add undo provenance foundation
feat(tags): record reversible tag operations atomically
feat(tags): add undo planner and preview
feat(tags): add atomic tag undo apply
feat(tags): expose tag undo protocol
feat(tags): add tag management undo ui
test(tags): harden phase 2.1 undo
docs(tags): close phase 2.1 undo
```

Small defect fixes stay in the owning phase and use `fix(tags): ...` only when
needed. Do not squash approved PRD/plan history, mix closure evidence into
production commits, or commit databases, WAL/SHM files, vaults, backups,
screenshots, or generated runtime state.

The planner commit is domain-only: `feat(tags): add undo planner and preview`
must not add `/api/tags/undo*` handlers. The protocol commit is the single
public route boundary: `feat(tags): expose tag undo protocol` adds all four
routes and their client/runtime guards after T2.1-3. The T2.1-0 and T2.1-1
commits are also distinct: T2.1-0 installs foundation/provenance without Undo
activation, while T2.1-1 is the atomic recording/health/latest-target cutover.

## 48. Risks

| Risk | Mitigation | Required evidence |
| --- | --- | --- |
| `document_tags` rebuild loses rows | Transactional ordered copy and before/after logical set comparison | v6/v7 migration tests, integrity/FK checks |
| Association writer is missed | Repository-wide SQL/caller inventory and T2.1-0 writer matrix | Writer tests and code review |
| Full-set tag rewrites accidentally destroy provenance | T2.1-0 set-diff helper for ordinary REST/AI writers; full replacement restricted to separately proven recovery/fixture paths | AH–AK, no-op, unchanged-ID, and delete→re-add writer tests |
| Legacy v6 durable journal is rejected after v7 migration | Exact version-aware v6/v7 row parsing and normalization before CAS restore; no permissive column union | AL upgrade/recovery success and AM unsafe-drift quarantine |
| Legacy recovery invents unsafe physical provenance | v6 rows never supply an historical `association_id`; preserve only a proven live row or insert a new v7 row; otherwise fail closed | v6 missing-row, existing-row, external-drift, and no-Undo-record assertions |
| Intermediate T2.1-0 build accidentally claims active Undo semantics | Foundation-only health/state and no API/UI; T2.1-1 is the sole activation cutover | AN intermediate-build test and explicit activation health diagnostics |
| Public API is partially exposed before domain Apply is complete | T2.1-2/3 have no HTTP handlers; T2.1-4 owns all four public routes after internal Apply passes | route inventory, build boundary, and API exposure tests |
| Large child delta consumes storage | One current parent, relational rows, purge on supersede/consume | 10k/50k storage/scale observation |
| Long SQLite transaction | Sorted locks, set SQL, observed duration, no fixed SLA | WAL/concurrency/scale tests |
| Explicit stable-ID insert conflicts | Preflight ID/identity checks and whole-transaction rollback | occupied ID/identity tests |
| Foreign-key ordering | Restore source row before associations; delete exact rows before consume | Merge/Remove postconditions and FK checks |
| Latest-target split brain | Pointer swap, old purge, and mutation in same IMMEDIATE transaction | transition failure injection |
| Stale Undo Preview | separate fingerprint and replan after locks | dynamic/stale tests |
| Two-tab concurrent Undo | current lifecycle reload and consumed state | two-Apply WAL test |
| Delete/re-add provenance bug | explicit association ID captured/checked | Q/R and writer matrix |
| Backup mismatch | matching full data/vault/key backup and old-image rehearsal | T2.1-6/7 operator rehearsal |
| Old-client compatibility | old client ignores Undo; new server records old Apply; new client hides on old server | AE/AF compatibility tests |
| Refresh after commit | `undo-sync-pending`, trusted record recovery, sync-only retry | Y/Z browser/component tests |
| Record corruption | version/generation/child health checks; terminal fail closed | malformed-record health tests |
| Migration interruption | migration runner transaction, retry from v6, no partial table swap | interruption/retry rehearsal |

## 49. Architecture Blockers

After this repair, the plan closes the unrelated-tag provenance contradiction
with set-diff writers, defines v6/v7 recovery compatibility, freezes the
T2.1-1 activation boundary, and assigns public route ownership only to
T2.1-4. The planning review status is:

```text
Architecture blocker: 0
Plan ↔ Approved PRD Conflict: 0
```

These counts record the passed plan review; they are not an implementation
PASS. The following required feasibility answers are all **Yes**, subject to
the implementation gates:

| Required answer | Planning conclusion |
| --- | --- |
| Can provenance be safe and bounded? | Yes: explicit association ID plus one current relational delta |
| Can ordinary Apply record its inverse in the same transaction? | Yes: existing IMMEDIATE boundary can include parent/child/pointer writes |
| Can Merge/Remove restore exact stable IDs? | Yes: explicit ID insert with preflight occupancy checks |
| Can unrelated later metadata survive? | Yes: inverse touches only tag/association-owned rows and uses a separate fingerprint |
| Can delete→re-add be detected? | Yes: AUTOINCREMENT association identity changes |
| Can Undo remain set-based at 10k/50k? | Yes: bulk child capture, exact-ID set deletes, and temp version tables |
| Can migration preserve all existing associations? | Yes: transactional v6 logical copy and checks |
| Can backup/downgrade follow current operator practice? | Yes: matching full backup plus matching old runtime/image; no reverse migration |

If any answer becomes No, work stops, `Architecture / PRD Conflict` is reopened,
and no later phase is patched around the blocker.

## 50. Definition of Done

Phase 2.1 may eventually be declared complete only after:

1. The Undo PRD and this Implementation Plan are both separately approved.
2. T2.1-0 through T2.1-6 pass their gates in strict order.
3. T2.1-7 closure receives external final review PASS.
4. All required unit, migration, writer, domain, API, client, component,
   browser, accessibility, concurrency, scale, auth, Docker, CI, and
   backup/restore evidence is available and factual.
5. P0 = 0, P1 = 0, no unexplained P2, and Architecture / PRD Conflict = None.
6. Stable-ID restoration, provenance, atomicity, exactly-once recovery, health,
   compatibility, and protected-area invariants are all demonstrated.
7. Markdown/Frontmatter/mtime/Git/History/Phase 1/TagPanel/FileTree/editor Undo
   behavior remains within the approved boundary.
8. No reverse identity migration, event-sourcing history, Redo, or global
   shortcut entered scope.

## 51. Review Checklist

The external final plan review passed. The following checklist records the
reviewed plan decisions; these are plan-review checks, not implementation
acceptance gates.

- [x] Approved PRD remains unchanged
- [x] Current architecture facts verified
- [x] Association provenance design is safe
- [x] delete→re-add is provably detectable
- [x] migration preserves logical associations
- [x] record storage is bounded
- [x] ordinary Apply + record is one transaction
- [x] latest target transition is atomic
- [x] Undo fingerprint ignores unrelated state appropriately
- [x] Merge/Remove algorithms preserve later unrelated changes
- [x] exact stable-ID restoration is implementable
- [x] dynamic conflicts are non-consuming
- [x] exactly-once recovery is implementable
- [x] all association writers are covered
- [x] ordinary metadata tag writers preserve unchanged association IDs
- [x] unrelated tag additions/removals do not false-conflict Undo
- [x] legacy v6 durable recovery snapshots are compatible with v7
- [x] legacy recovery never invents historical provenance
- [x] T2.1-0 is foundation-only and does not activate Undo guarantees
- [x] T2.1-1 is the atomic Phase 2.1 activation cutover
- [x] public Undo HTTP routes are owned only by T2.1-4
- [x] `database_generation` naming is consistent
- [x] API/client contracts are explicit
- [x] UI integrates existing state/sync seams
- [x] concurrency matrix is complete
- [x] 10k/50k plan is set-based
- [x] backup/downgrade rehearsal is defined
- [x] protected areas are covered
- [x] PRD traceability is complete
- [x] no Architecture / PRD Conflict
- [x] implementation has NOT started

## Plan Status

```text
PHASE 2.1 UNDO IMPLEMENTATION PLAN APPROVED FOR IMPLEMENTATION

Final Implementation Plan Review: PASS — 2026-08-16

P0: 0
P1: 0
P2 blocking: 0
Architecture blocker: 0
Plan ↔ Approved PRD Conflict: 0

PRD: APPROVED
Implementation Plan: APPROVED
Implementation: NOT STARTED
T2.1-0: NOT STARTED
Phase 2.1: NOT COMPLETE
Undo: NOT IMPLEMENTED

NEXT AUTHORIZED PHASE:
T2.1-0 — Reversible State and Association Provenance Foundation
```
