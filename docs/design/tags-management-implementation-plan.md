# Nuvyn Tags Management Phase 2 Implementation Plan

**Status:** Approved for Implementation

**Final Plan Review:** PASS — P0: 0; P1: 0; P2: 0; P3: 0; Architecture / PRD Conflict: None

**Date:** 2026-08-13

**Implementation/code planning baseline:** `f9a79c9be2723f2b163486b743e91792e1471393`

**Plan review/repair baseline:** `fc73bbe1428fb4734eada68b0a1529ffb85c8730`

**Plan repair input baseline:** `9797f75bf2a0d5c7d7c66dec79f4be01da8f4c87`

**Approved PRD commit:** `f9a79c9be2723f2b163486b743e91792e1471393`

**Scope:** Reviewed implementation execution contract; implementation begins with T2-0 only after the mandatory preflight succeeds

## 1. Document Information

This document translates the approved Tags Phase 2 product contract into a
reviewable engineering sequence. It names future modules, transaction and lock
boundaries, migration execution, API shapes, UI ownership, test locations, and
phase gates. It does not change the product contract. It has completed Final
Plan Review and is Approved for Implementation. It is the reviewed engineering
execution contract for Tags Phase 2, subject to the Approved PRD.

Approval authorizes implementation to begin with T2-0 — Identity and Writer
Safety Foundation only after the mandatory preflight defined in this Plan
succeeds. T2-1 through T2-7 then proceed in order only after each preceding
phase gate passes. Approval does not mean T2-0 is complete, migration has run,
production rollout or feature completion is approved, or phase gates, stop
conditions, or the Deferred to Phase 2.1 Undo scope may be bypassed.

The production architecture and code findings in this plan were inspected
against the implementation/code planning baseline
`f9a79c9be2723f2b163486b743e91792e1471393`. The subsequent plan review/repair
commits through `fc73bbe1428fb4734eada68b0a1529ffb85c8730` and the current
document revision were documentation-only and did not alter those production
architecture facts.

## 2. Source of Truth

The product source of truth is
[tags-management-prd.md](tags-management-prd.md), whose status is **Approved
for Implementation**. The authority order is:

```text
Approved PRD > reviewed Implementation Plan > implementation code
```

If implementation evidence contradicts a PRD contract, work stops. The
implementation must not reinterpret the contract in code; a documented PRD
amendment and review is required first. If implementation conflicts with this
Plan, correct the implementation unless real architecture evidence requires a
stop, plan amendment, and re-review. The PRD remains higher authority than the
Plan. No Architecture / PRD Conflict was found during this planning pass.

## 3. Planning and Review Baselines

### 3.1 Implementation/code planning baseline

`f9a79c9be2723f2b163486b743e91792e1471393`

Production architecture and code inspection occurred at this baseline. The
verified migration, shared-module, package/CI, and current-domain facts below,
as well as the Current Architecture Verification section, belong to this code
baseline:

The following facts were re-verified from the current repository rather than
copied from the PRD research snapshot:

- The current branch is `main`; `HEAD` and `origin/main` are
  `f9a79c9be2723f2b163486b743e91792e1471393`.
- The migration runner has applied SQL migrations `0001` through `0006`; it
  discovers only numbered `.sql` files and records one `schema_version`.
- Both `tsconfig.app.json` and `tsconfig.server.json` include `shared/**/*.ts`,
  so one pure normalization module can be imported by client and server without
  build-system changes.
- The current package scripts and CI already run client/server typecheck, build,
  the complete Vitest lanes, cross-platform Playwright, authentication smoke,
  Docker build/smoke, and macOS visual checks.
- No Tag Management domain, stable-ID management endpoint, Preview/Apply API,
  or global management UI exists at this baseline.

### 3.2 Plan review/repair baseline

`fc73bbe1428fb4734eada68b0a1529ffb85c8730`

This commit introduced the initial Implementation Plan document only. The
verified diff from `f9a79c9` to this commit contains only
`docs/design/tags-management-implementation-plan.md`; no production
architecture changed between those commits.

### 3.3 Plan repair input baseline

`9797f75bf2a0d5c7d7c66dec79f4be01da8f4c87` was the repository HEAD at the
start of the baseline-provenance repair pass. The verified diff from
`fc73bbe1` to that input baseline is also documentation-only and contains only
this Implementation Plan. It records plan review fixes; it is not the
production implementation baseline and does not supersede the
`f9a79c9` architecture evidence baseline.

## 4. Current Architecture Verification

### 4.1 Persistence and identity

Migration `0002_document_metadata.sql` currently provides:

| Store | Verified shape | Planning consequence |
|---|---|---|
| `documents` | stable `id` primary key, unique `path`, `updated_at` integer | `updated_at` remains the metadata version/timestamp token |
| `tags` | integer autoincrement `id`, `name`, unique `normalized_name` | Existing rows already have stable operation identities |
| `document_tags` | foreign keys with cascade and primary key `(document_id, tag_id)` | Physical duplicate pairs are impossible; merge overlap still needs collapse accounting |
| `settings` | generic key/value table from migration `0001` | A namespaced, versioned data-migration marker can be stored without new schema |

Foreign keys are enabled and the on-disk connection uses WAL. The code also
uses a single cached better-sqlite3 connection per server process, with explicit
test injection; cross-process/file-backed tests still matter because WAL allows
other connections. The current code already demonstrates
`db.transaction(...).immediate()` for metadata ownership CAS/restore, so no
transaction framework is needed.

### 4.2 Normalization drift

`src/lib/tags.ts` implements the approved client contract: trim, remove exactly
one leading `#`, trim again, and `toLowerCase()`, with no NFKC. The persistence
writer in `server/documentMetadata.ts` instead trims and uses
`toLocaleLowerCase()` without removing `#`. Its input dedupe follows the same
server-only rule. Historical rows such as `java` and `#java` can therefore be
distinct despite being one Phase 2 identity.

### 4.3 Metadata writers

`saveDocumentMetadata` currently performs an upsert, deletes every association
for the document, and rebuilds the supplied tag set. The following production
paths can reach that behavior directly or through `ensureDocumentMetadata`:

- ordinary metadata PATCH in `server/routes/metadata.ts`;
- AI `update_metadata` in `server/ai/tools.ts`;
- initial and repeated Frontmatter import in `server/metadataMigration.ts`;
- post create/recovery and body lifecycle paths in `server/routes/posts.ts`;
- folder and history restoration paths through the shared ensure helper;
- raw metadata snapshot compensation and crash recovery helpers.

The REST route and AI tool both currently read a complete metadata object and
then call the full writer. A title- or summary-only intent can consequently
replay an old tag array. `DocumentMetadataForm.vue` reinforces this today by
always sending `{ title, summary, tags }`.

### 4.4 Version generation

`documents.updated_at` is returned as `DocumentMetadata.updatedAt` and is used as
a stable-document version token. Existing writes mix caller timestamps,
`Math.max(existing, incoming, mtime)`, transaction timestamps, and direct
`Date.now()`. Two real mutations can receive the same millisecond, and several
path-move helpers can set a value that is not strictly greater than the row's
current value.

### 4.5 Locks and compensation

The application has one process-local vault structure lock and sorted,
path-scoped document write locks. Routes, AI mutation dispatch, Frontmatter
archive, history restore, and folder mutations normally hold the relevant
document lock across snapshot, mutation, and compensation. Crash recovery runs
before request serving. Tag Apply must participate in those locks: otherwise a
pre-Apply metadata snapshot could be restored after Apply and replay old
associations even though both individual SQLite transactions were valid.

The existing raw snapshot restore APIs remain necessary for filesystem
compensation. They are not a general metadata update API and must not become a
new route around tag version checks.

The external-file concurrency boundary is deliberately fail-closed rather than
overclaimed: in-process path locks coordinate Nuvyn writers, while a second
SQLite connection/process is serialized by IMMEDIATE/CAS. An operator or plugin
that writes the database directly without the shared version/identity contract
is unsupported; the relevant-graph fingerprint and health check detect many
such changes, but Phase 2 does not introduce distributed locks.

### 4.6 Client projections and refresh

`PostSummary.tags` is `string[]`. `TagPanel.vue` builds its Phase 1 `TagIndex`
from posts, while `VaultView.vue` owns `selectedTag: string | null`. The current
selection toggle is display-string based. `VaultView` receives the canonical
`refresh()` function from `useEditorTabs`; ordinary metadata saves currently
optimistically patch one post and refresh both posts/tree and the link index.

`server/tree.ts` currently falls back to Frontmatter tags when a Markdown file
has no metadata row. That fallback is acceptable for Phase 1 query continuity
but is exactly why management health requires complete live metadata ownership;
the planner never treats Frontmatter fallback as a second mutation store.

Tag Management needs a separate stable-ID read model. It must not change
`PostSummary.tags`, mutate `TagIndex` maps, or use the ordinary one-document
optimistic patch path.

The ordinary metadata form may keep its existing one-document response patch
for responsiveness; when its partial payload does not include tags, that patch
must preserve the latest local post tags rather than replace them from a stale
save intent. This is separate from Tag Management, whose cross-document Apply
never performs an optimistic patch.

### 4.7 Startup and availability

Both `server/prod.ts` and `server/vite-plugin.ts` acquire vault writer ownership,
run crash recovery, then await `migrateVaultMetadata` before serving requests.
That shared ordering is the correct application-data migration seam. A failed
Tag identity migration must be represented as a management health failure while
ordinary Tag Query reads remain available.

## 5. Implementation Principles

1. SQLite remains the only Tag Management mutation authority.
2. Normalize once in a pure shared module; do not reproduce identity in SQL.
3. Omitted metadata fields are not writes. Explicit tag replacement is a
   version-checked operation.
4. Preview and Apply execute one planner semantic over different transaction
   modes.
5. The server derives every affected document; the client never submits scope
   IDs.
6. Every Apply is one SQLite transaction and one all-or-nothing result.
7. Existing path locks coordinate in-process metadata snapshots with Tag Apply;
   SQLite IMMEDIATE coordinates database writers and connections.
8. Phase 1 query/index behavior and post response shapes remain compatible.
9. No event sourcing, global tag revision, workflow engine, new state library,
   ORM, or cross-store coordinator is introduced.
10. Undo remains Deferred to Phase 2.1.

## 6. Proposed Architecture

The future implementation has four small boundaries:

```text
shared/tagNormalization.ts
          |
          +--> document metadata writers + identity migration
          |
          +--> server/tagManagement.ts (list, planner, fingerprint, Apply)
                                      |
                            server/routes/tags.ts
                                      |
                    src/lib/tag-management-api.ts
                                      |
                  TagManagementDialog + VaultView sync
```

`server/tagManagement.ts` owns domain types, set-based reads, deterministic
planning, hashing, health enforcement, and mutations; it imports health state
from `server/tagIdentityMigration.ts` rather than duplicating migration logic.
`server/routes/tags.ts` only parses HTTP input, inherits the existing `/api/*`
auth/CSRF boundary, and maps domain errors. The UI is a dedicated dialog;
`TagPanel` receives only a small management entry point.

## 7. Shared Tag Identity Module

Add `shared/tagNormalization.ts`, with no Vue, Node, database, or locale
dependency. It will export these concepts:

- `TAG_IDENTITY_CONTRACT_VERSION = "tag-identity-v1"`;
- `normalizeTagIdentity(raw)`: nullish to empty; trim; remove one leading `#`;
  trim; `String.prototype.toLowerCase()`; no NFKC;
- `normalizeTagDisplay(raw)`: the same structural steps without lowercasing;
- `validatePersistentTag(raw)`: a discriminated valid/error result containing
  display and identity on success;
- `normalizeAndDedupeTags(values)`: validates at most 50 strings, dedupes by
  identity, and preserves the first normalized display form.

Persistent validation requires the raw string, normalized display, and
canonical identity each to be at most 100 JavaScript/UTF-16 code units, closing
both whitespace and lowercase-expansion bypasses. It rejects `\p{Cc}`, U+2028,
U+2029, BOM, and bidi/isolating format controls (including NUL/newline/tab),
while preserving ordinary internal spaces, CJK, slash, dash, underscore,
compatibility characters such as `ﬁ`, and legitimate joiners used by Unicode
scripts/emoji.

`src/lib/tags.ts` keeps the public Phase 1 names `normalizeTag` and
`normalizeTagDisplay` as re-exports/wrappers over the shared functions. Query,
index, and sorting APIs remain in place. This avoids import churn in FileTree,
TagPanel, and their tests.

**Do not use SQLite `LOWER()` as the authoritative tag normalization
implementation.** SQLite's default Unicode behavior is not the approved
JavaScript contract. SQL stores and compares values computed by the shared
TypeScript function.

`TAG_IDENTITY_CONTRACT_VERSION` is an implementation/fingerprint/migration
constant, not a database column. Any future normalization change requires a new
contract version, impact review, and data migration; it must not edit v1 in
place against completed markers or Preview fingerprints.

One fixture table in `shared/__tests__/tagNormalization.fixtures.ts` will drive
the shared function, Phase 1 client wrapper, server writer, and migration tests.
It includes `Java`, `JAVA`, surrounding whitespace, `#java`, `# java`,
`##java`, `#`, CJK, slash/dash/underscore, `ﬁ`, internal spaces, controls, and
length boundaries.

## 8. Metadata Writer Coordination

### 8.1 Explicit primitives

Refactor `server/documentMetadata.ts` around two intentional write paths:

1. A full create/import writer for a row that does not yet exist, or a narrowly
   named ownership-checked restore path. It normalizes with the shared module.
   An existing-row full replacement without an expected state is not a public
   update primitive.
2. `patchDocumentMetadata`, the only ordinary existing-row mutation primitive.

Both primitives expose `...WithinTransaction` internals for existing atomic
lifecycles and public wrappers that open the documented transaction. Callers
already inside a larger metadata transaction use the internal form explicitly;
ordinary callers cannot accidentally rely on a nested savepoint in place of an
IMMEDIATE CAS boundary.

The domain input to `patchDocumentMetadata` is an explicit non-empty list of
field changes plus document path, not a loose optional object:

```ts
type DocumentMetadataChange =
  | { field: 'title'; value: string }
  | { field: 'summary'; value: string }
  | { field: 'tags'; values: string[] }

type PatchDocumentMetadata = {
  path: string
  changes: DocumentMetadataChange[]
  expectedUpdatedAt?: number
}
```

Duplicate change kinds are invalid. The HTTP route uses `Object.hasOwn()` to
map JSON field presence to this form, so absent and present-with-`undefined`
cannot collapse into the same domain meaning.

`patchDocumentMetadata` runs in a short IMMEDIATE transaction, re-reads the row,
validates all requested fields, and applies the complete request atomically:

- title/summary changes update only their columns;
- omitted tags never query, delete, or insert `document_tags`;
- an explicit tags change requires one request-level safe-integer
  `expectedUpdatedAt`;
- a tag version mismatch rejects the whole patch with
  `METADATA_VERSION_CONFLICT` before any field changes;
- a current explicit tag change normalizes/dedupes, replaces associations, and
  advances the version once.

After validation/CAS, a request whose explicit values already equal the current
state returns the current metadata without a version bump. An explicit tag
request still validates `expectedUpdatedAt` before this no-op decision; a stale
caller cannot turn replay into an idempotence bypass.

Title-only and summary-only changes intentionally do not compare a whole-row
version. They remain valid after an intervening Tag Apply and preserve the live
association set. When title and tags are in one request, the explicit-tag token
guards the whole atomic request; a mismatch changes neither field. This is
field-scoped last-writer behavior for tag-omitting requests, not a stale tag
replay.

### 8.2 Call-site migration

T2-0 must classify every production caller before removing the unsafe path:

| Caller class | Future primitive |
|---|---|
| New document / first Frontmatter import | Full create/import writer |
| REST metadata PATCH | `patchDocumentMetadata` |
| AI `update_metadata` | `patchDocumentMetadata` |
| Existing row observed during import/read | preserve fields; reconcile observation only |
| Body/path lifecycle metadata touch | targeted version/path mutation; never rebuild tags |
| Explicit per-document tag edit | version-checked `tags` change |
| Snapshot compensation / crash recovery | existing ownership snapshot restore under its lock/CAS contract |

`ensureDocumentMetadata` must stop calling the full writer for an existing row.
Its signature will distinguish a read-only external observation from a known
committed mutation, so a GET does not bump a version and a body write cannot
collide in the same millisecond.

The audit includes `server/routes/posts.ts`, `server/routes/folders.ts`,
`server/history/restore.ts`, `server/frontmatterArchive.ts`, `server/ai/tools.ts`,
`server/metadataMigration.ts`, and crash/folder recovery callers. Non-startup
snapshot/restore flows must be proven to hold their existing document locks
from snapshot through compensation, or use the existing IMMEDIATE ownership
CAS helper. No unconditional old snapshot may be exposed as a normal metadata
write.

### 8.3 REST and client form

The public PATCH JSON remains field-shaped for compatibility:

```json
{
  "title": "optional",
  "summary": "optional",
  "tags": ["optional", "explicit"],
  "expectedUpdatedAt": 123
}
```

An empty body is invalid. `expectedUpdatedAt` is required only when `tags` is
present and is ignored/rejected when malformed, never inferred from a fresh
server read. The route continues its current title/summary limits and updates
the link index only when title was explicitly changed.

The route keeps `withDocumentWriteLock(documentPath)` around file existence,
legacy metadata ensure, patch, and any title-index update. The database
primitive's IMMEDIATE transaction is the authoritative CAS; the path lock also
coordinates with lifecycle snapshots and Tag Apply's sorted lock set.

`DocumentMetadataForm.vue` keeps a full local draft snapshot but derives the
request from differences against `savingBase`. It sends only changed fields and
adds `savingBase.updatedAt` when tags differ. Save reconciliation stores the
full intended form separately from the partial wire payload so current
uncertain-save and newer-draft behavior remains correct.

On `METADATA_VERSION_CONFLICT`, the form performs its existing authoritative
reread/reconciliation path, preserves newer local edits as a draft, and reports
the conflict. It never automatically retries the explicit tag payload with the
new token; the user must review/resave against fresh tags.

### 8.4 AI writer

`update_metadata` maps to the same patch primitive. Add an optional
`expected_updated_at` tool input and document that it is mandatory when `tags`
is supplied. `read_file` already returns metadata including `updatedAt`, so the
model has an authoritative token. Executor validation enforces the conditional
requirement even if provider JSON Schema conditional support differs.

A summary-only AI call carries no tags and cannot touch associations. An
explicit tag call with a missing or stale token returns a stable tool error and
does not fall back to a fresh read followed by last-writer-wins.

Tool-call dispatch already serializes the document path through the existing
write lock. Keep that lock and let `patchDocumentMetadata` perform the database
CAS inside it; do not add a tag-global process lock or ask the AI runtime to
retry a stale tag update automatically.

## 9. Metadata Version Semantics

Add one pure scalar server helper used by metadata PATCH, AI, migration,
lifecycle touches, and Tag Apply:

```text
nextMetadataUpdatedAt(current, candidateNow) =
  max(trunc(candidateNow), current + 1)
```

Inputs and output must be non-negative safe integers. If a current value is
`Number.MAX_SAFE_INTEGER`, fail closed rather than overflow. A batch captures
`candidateNow` once, then applies the scalar rule to each affected row; it does
not call `Date.now()` N times and does not force an unrelated future-dated row's
clock onto every other affected document.

Read-only observation is separate: `reconcileObservedUpdatedAt` may retain the
current value when file mtime/legacy timestamps did not advance. A caller that
knows it committed a mutation must use `nextMetadataUpdatedAt`, even when its
wall clock equals the current millisecond.

For a Tag Apply, capture one wall-clock candidate in the locked transaction and
update all source-associated documents with one set-based statement whose
per-row expression is `max(candidateNow, updated_at + 1)`. Preflight rejects a
`MAX_SAFE_INTEGER` row. `created_at` is never changed. Rejected/no-op operations
update no versions. Migration uses the same per-row rule for its deduplicated
affected set.

The existing durable folder journal stores one transaction timestamp. New
journals therefore use a companion `nextMetadataBatchUpdatedAt(currents, now) =
max(now, max(currents) + 1)` derived from the same safety rule, instead of raw
`Date.now()`. Pre-T2-0 journals replay their already persisted value unchanged
so crash recovery remains deterministic; startup recovery completes before the
management health gate. This is the only planned touch to the durable folder
flow, and its journal schema and ownership protocol remain unchanged.

The T2-0 call-site audit applies the scalar helper to single-document path moves
and body/metadata mutations as well. Prefix/folder transactions use the batch
companion because one durable journal value must describe their deterministic
committed snapshot.

The Tag plan fingerprint still includes complete relevant metadata and
associations. Strict versions close same-ms CAS holes; they are not used as the
fingerprint's sole evidence.

`updated_at` remains an approximate timestamp as well as a version token. When
monotonicity moves it one or more milliseconds ahead of wall time, existing API
date formatting accepts that value; no separate revision column or clock reset
is added in Phase 2.

## 10. Historical Identity Migration

### 10.1 Execution decision

Implement the identity cleanup in `server/tagIdentityMigration.ts` and call it
after `migrateVaultMetadata` in both production and Vite startup, before request
serving. It imports the shared JavaScript normalization contract and runs
synchronously inside one `db.transaction(...).immediate()` data transaction.

Run identity cleanup even when the metadata migration report contains failed
live documents, because existing tag rows still need a deterministic invariant
and any later import uses the new writer. The combined health result remains
unavailable until those live-document failures are resolved; identity success
does not mask metadata incompleteness.

No schema migration is planned. In particular, do not create
`canonical_name`, `tag_revision`, or an operation log. The existing generic
`settings` table stores one namespaced marker,
`internal.tags.identity.tag-identity-v1`, as JSON. This choice avoids extending
the SQL-only runner, avoids advancing `schema_version` before data verification,
and avoids a table used only for one migration marker.

The marker payload is bounded and schema-validated:
`{ contractVersion, status, attemptedAt, completedAt?, report, errorCode? }`.
It never stores tag names, paths, raw exception text, or an unbounded affected
set. `status` is only `complete` or `failed`; active/checking is process state.

The alternatives were rejected as follows:

- SQLite-only normalization cannot reproduce the approved Unicode contract.
- Extending the migration runner with TypeScript callbacks couples the generic
  schema boot path to vault-data health and makes degraded query startup harder.
- A new bookkeeping table adds schema solely for one namespaced state value and
  would split schema readiness from application-data readiness.

Because no schema element is added, there is intentionally no future
`server/migrations/0007_*.sql` file in the proposed map. If review rejects the
namespaced settings marker and requires dedicated schema, the plan must be
revised before implementation rather than silently inventing `0007` during
T2-0.

The success marker is the final write inside the same data transaction. A
transaction failure rolls back tag rows, associations, document versions, and
the success marker. After rollback, a separate small write records
`status: "failed"`, attempted time, sanitized reason/code, and report counts in
the same settings key; that failure value is not a health advance. A restart
attempts `absent` or `failed` once per process startup, while `complete` skips
mutation and performs read-only verification. A crash during the transaction
leaves the prior marker and pre-migration graph.

If the failure-record write also fails, startup still stores an in-process
unavailable health result and emits a sanitized log; the absent/old durable
marker causes a retry next start. A malformed or unknown-version marker is not
overwritten automatically: it is `TAG_IDENTITY_CONFLICT` until operator review.

If a completed marker exists but verification later fails, do not silently
repair it on every startup. Report `TAG_IDENTITY_CONFLICT` and keep management
unavailable; this exposes post-migration writer drift or manual corruption.

### 10.2 Deterministic algorithm

Within the one IMMEDIATE transaction:

1. Read every tag row ordered by numeric ID and every association needed for
   before/after membership verification.
2. Compute shared identity and display for every row. Abort before mutation if
   any row normalizes to an invalid/empty/oversized/control-containing value;
   there is no lossless automatic identity for such a row.
3. Partition by canonical identity and sort each group by ID. The lowest tag ID
   is the survivor. Its normalized display wins, with canonical identity only
   as the impossible-empty defensive fallback.
4. Capture the set of logical `(document_id, canonical_identity)` memberships
   and the exact affected document IDs. A document is affected when its
   physical association will move/collapse or its hydrated survivor display
   will change.
5. Move every row in a group that contains an identity change or losing row
   into a transaction-local, collision-free temporary namespace. (Clean
   singleton groups need no staging.) The namespace contains a random UUID, is
   checked absent first, and is never committed. Staging the whole dirty group
   frees canonical values held by losing rows and handles normalization cycles
   without depending on update order.
   Temporary values are valid non-empty strings under the existing schema but
   are deliberately outside the persistent contract; health verification runs
   only after all survivors have final identities.
6. For each group, use `INSERT OR IGNORE ... SELECT` to attach every group
   document to the survivor, delete losing associations, then delete losing tag
   rows. Finally write the survivor's canonical display and identity.
7. Capture one candidate clock value and update each distinct affected document
   exactly once with the safe per-row monotonic expression.
8. Re-read and verify: every `normalized_name` equals the shared normalization
   of `name`; canonical identities are unique and valid; before/after logical
   membership sets are equal; no duplicate junction pairs exist; losing IDs
   are gone; survivor IDs are the lowest; `foreign_key_check` is empty; and
   version/update counts match the plan.
9. Write the structured report and `status: "complete"` marker last, then
   commit.

The report includes rows scanned, logical groups, survivors, associations
moved, duplicate associations collapsed, tag rows deleted, display/identity
rows changed, and documents versioned. Orphan groups are normalized and
consolidated but produce no document version update.

Idempotence means a second completed run performs verification only and changes
zero rows/versions; forcing the transformation algorithm against its already
canonical input would also compute zero dirty groups, but production uses the
complete marker rather than rewriting it.

An invalid historical row fails closed and preserves all data. T2-7 must include
an operator diagnostic/remediation note; the migration must not silently delete
an association to make the gate green.

## 11. Migration Health Gate

`server/tagIdentityMigration.ts` also owns a small management-health evaluator
and exports `initializeTagIdentityAndHealth(db, contentDir, metadataReport)`.
`server/prod.ts` and `server/vite-plugin.ts` call it to set the module's
process-wide state to checking/unavailable/healthy during startup; the settings
marker remains the durable cross-restart source. The cache is keyed by the
concrete database connection so production state cannot bless an injected test
connection. It reports:

- no identity migration is active and the versioned marker is complete;
- no failed live-document metadata import remains;
- every live Markdown path has database-owned metadata;
- every tag display/identity passes the shared contract;
- no canonical identity collision or duplicate junction pair exists;
- foreign keys and required uniqueness invariants hold.

Startup sets `checking` before running the data migration and records the final
combined health after both identity and live-document verification. Production
and Vite use one exported initialization function so their order/error semantics
cannot drift.

Startup performs the full filesystem/database check after metadata import and
caches its structured result for availability display. Opening management and
each Preview/page/Apply run a read-only live-path completeness and database
invariant preflight; this catches an external Markdown file added after startup
instead of silently omitting it from a global operation. The implementation may
reuse one inventory within a request, but it does not cache completeness across
an Apply safety boundary without a trustworthy vault-change generation. This
preflight is not a migration and performs no identity repair; the existing
explicit metadata migration endpoint is the recovery path for an unimported
live file. The 10k fixture records its cost rather than weakening the gate.

Tests that mount `server/index.ts` with an injected database call an explicit
test initializer/reset exported by the health module after applying migrations;
production routes never auto-mark a test/in-memory database healthy merely
because it has no tag rows.

`GET /api/tags` and operation routes return 503 when unhealthy. Existing posts,
TagPanel query, and FileTree query endpoints remain available. The manual
metadata migration endpoint refreshes management health after it finishes; it
does not rerun a completed identity migration on every UI open.

## 12. Tag Management Read Model

`listManagedTags` in `server/tagManagement.ts` uses one set-based query:

```text
tags
LEFT JOIN document_tags
GROUP BY tags.id, tags.name, tags.normalized_name
ORDER BY normalized_name, id
```

It returns `{ id, normalizedName, displayName, documentCount }`, where `id` is a
positive safe integer and the count is distinct document membership. Orphan
tags remain visible with count zero so they can be renamed or removed.

Expose it through `GET /api/tags`. `PostSummary.tags: string[]`, post hydration,
Phase 1 `TagIndex`, FileTree parsing, TagPanel ordering, and Command Palette
shapes remain unchanged.

## 13. Operation Model

Use one discriminated request union:

```ts
type TagOperationRequest =
  | { kind: 'rename'; sourceTagId: number; destinationName: string }
  | { kind: 'merge'; sourceTagId: number; destinationTagId: number }
  | { kind: 'remove'; sourceTagId: number }
```

Routes reject floats, zero/negative IDs, unsafe integers, nulls, and numeric
strings; they do not coerce JSON values into IDs.

Display Rename is a Rename whose requested identity equals the source identity
but whose normalized display differs. It is not a fourth operation. Equal
identity and equal display is a disallowed no-op with stable conflict code
`INVALID_OPERATION`. Rename to another existing row is `DESTINATION_EXISTS`,
never an implicit Merge. Merge requires two existing, distinct IDs. Remove
permits an orphan source.

The internal `TagOperationPlan` contains the normalized operation, source,
optional destination/resolution state, survivor, `displayOnly`, the complete
sorted affected document IDs, count, bounded sample, association add/remove
counts, duplicate collapses, tag creates/deletes, warnings, allowed/conflict,
and canonical fingerprint input. All current MVP operations report
`tagCreates = 0`.

Warnings are stable codes, not localized strings. Remove always carries a
destructive warning; any operation affecting at least 1,000 documents carries a
`HIGH_IMPACT` warning. The UI localizes both.

The plan keeps full affected IDs/metadata only for the duration of the
synchronous request/transaction. It is neither cached nor returned wholesale;
the successful Apply result contains counts and identity mapping, not the full
document set.

Each plan also carries `healthContractVersion: tag-identity-v1`; the health
result itself is not globally hashed. A health failure rejects Preview/Apply
before planning, while the contract version fingerprints the rules under which
the healthy graph was interpreted.

## 14. Planner

`buildTagOperationPlan(db, operation)` is synchronous and read-only. It assumes
its caller established the transaction and performs no temp-table or persistent
mutation. Preview wraps it in a deferred transaction; Apply calls the same
function inside IMMEDIATE.

Set-based planner reads are:

1. Resolve source and destination/rename-target state by stable ID or canonical
   target identity.
2. Select all source-associated documents, ordered by stable document ID with
   `COLLATE BINARY`, with path, title, summary, created/updated timestamps.
3. Select all tag associations for those affected documents in one joined query
   whose affected CTE starts from `document_tags.tag_id = sourceTagId`, ordered
   by document ID then numeric tag ID. Do not construct a 10,000-placeholder
   `IN` list.
4. Compute operation deltas and the first 20 sample rows in memory from those
   stable results.

Document `path` and `title` are returned for display only after server-side
hydration from those rows; no filesystem content read occurs in the planner.

The production connection stays in WAL mode. File-backed test connections set
WAL and foreign keys explicitly; in-memory unit databases use foreign keys and
SQLite's available journal mode. SQL orders document IDs and text identity
fields with `COLLATE BINARY` so planner/fingerprint order does not depend on a
locale collator.

No loop issues a per-document query. Destination-only documents are excluded
from a Merge plan because they do not change. The complete affected set remains
in the server plan even though only the sample is serialized to the first
response.

Planner semantics by operation are:

- Rename: source documents are affected; preserve source ID and all
  associations; reject an identity owned by another row; plan one tag-row
  update, zero association changes, and zero tag creates/deletes.
- Display Rename: same affected set; change only `tags.name`; association deltas
  are zero.
- Merge: every source document is affected, including overlap; destination-only
  documents are not; destination ID/display survive; `associationAdds` is
  source-only membership, `associationRemoves` is every source association, and
  `duplicateCollapses` is overlap.
- Remove: every source document is affected; documents and all unrelated

Resolution failures are represented internally with enough canonical sentinel
state for locked Apply to classify a previously valid Preview as stale. Initial
Preview still maps missing rows and static conflicts to the PRD error codes.

## 15. Preview Snapshot

`previewTagOperation` executes:

```ts
db.transaction(() => buildTagOperationPlan(db, operation))()
```

The default better-sqlite3 transaction is deferred. The first read establishes
one SQLite read snapshot for every source, destination, association, document,
count, sample, and fingerprint query. Preview never calls `.immediate()` and
never acquires document write locks.

Because better-sqlite3 APIs and the planner are synchronous, no JavaScript
`await` or event-loop yield occurs inside this transaction. That is deliberate:
the SQLite snapshot begins on the first SELECT and remains open until the plan
is returned.

The route returns only after the plan and fingerprint are complete. A plan
cannot combine rows from two database states. A two-connection WAL integration
test must prove an interleaving writer yields either the complete before-state
or complete after-state, never mixed counts/sample/fingerprint.

## 16. Fingerprint

Use Node's built-in `createHash('sha256')`; add no dependency. Construct a
fixed-position tuple tree containing only strings, safe integers, booleans,
arrays, and null. The exact top-level input is:

Before hashing, the request and health gate must be valid. Disallowed business
plans are hashed so the user can review stable conflict details, but their
`allowedToApply` flag makes the fingerprint non-Apply-capable. Missing/malformed
states remain ordinary 400/404 errors and do not produce a Preview.

```text
[
  "nuvyn-tag-operation-plan", 1, "tag-identity-v1",
  operationTuple,
  sourceTupleOrNull,
  destinationResolutionTupleOrNull,
  affectedDocumentTuples,
  derivedPlanTuple
]
```

`operationTuple` stores the normalized display form of Rename input, not
surrounding whitespace that the server discards. Two raw spellings with the
same accepted display/identity therefore plan identically; the normalized
request is the product-relevant request.

The tuples are defined as follows:

- Rename operation: `["rename", sourceTagId, requestedDisplayName,
  requestedNormalizedName]`; Merge: `["merge", sourceTagId,
  destinationTagId]`; Remove: `["remove", sourceTagId]`.
- A tag row is `[id, displayName, normalizedName]`.
- Rename destination resolution is `[requestedNormalizedName,
  resolvedTagRowOrNull]`, so proof of absence is fingerprinted. Merge contains
  the destination row. Remove uses null.
- Affected documents are sorted by document ID using binary/code-unit string
  order.
  Each tuple is `[id, path, title, summary, createdAt, updatedAt,
  completeTagRows]`; complete tag rows are sorted by numeric tag ID.
- `derivedPlanTuple` fixes `displayOnly`, allowed/conflict code, affected count,
  association adds/removes, duplicate collapses, tag creates/deletes, and
  stable warning codes.

Serialize this already ordered tuple with `JSON.stringify`, hash its UTF-8
bytes, and return 64 lowercase hexadecimal characters. Do not stringify raw DB
objects or localized messages.

This relevant graph catches source/destination display or identity changes,
rename-target creation, source membership changes, affected path/title/summary
or timestamp changes, and any association/display change on an affected
document. It deliberately excludes unrelated documents, unrelated tags, full
Markdown bodies, the whole database, and destination-only Merge documents.
Full relevant metadata and complete associations protect against same-ms or
out-of-band timestamp limitations; the monotonic token remains the ordinary
metadata CAS primitive.

`createdAt` is included because the tuple intentionally represents the complete
current database-owned metadata row; changing it through unsupported/manual SQL
must not leave a reviewed plan valid even though Apply never mutates it.

## 17. Preview Pagination

Use stateless recomputation, not a cache or snapshot table. The initial Preview
returns at most 20 affected documents and an `afterDocumentId` cursor when more
exist. `POST /api/tags/operations/preview/page` accepts:

```json
{
  "operation": {},
  "planFingerprint": "64 lowercase hex characters",
  "afterDocumentId": "optional stable id",
  "limit": 50
}
```

`limit` defaults to 50 and is capped at 100. The server opens a new deferred
read transaction, recomputes the complete plan, compares its fingerprint, and
only then returns the deterministic document-ID slice plus the next cursor. A
relevant change returns `PREVIEW_STALE`; an unrelated change outside the hash
may leave the page valid. The cursor controls presentation only and can never
alter Apply scope.

The initial page is plan sample items 1–20. Continuation requires
`afterDocumentId` to equal an item in the recomputed affected set (normally the
last item already shown); unknown/tampered cursors are `INVALID_OPERATION`
rather than a way to probe arbitrary document ranges. The final page returns no
next cursor.

The continuation request remains POST because the operation body contains a
union and raw Rename text; it is a read-only POST and takes no write lock. Apply
is the only operation route that mutates.

## 18. Atomic Apply

Apply has two coordination layers:

1. Build one read-only discovery plan, reject an already stale fingerprint, and
   acquire existing `withDocumentWriteLocks` locks for all affected current
   paths in the helper's deterministic order. These locks make Tag Apply wait
   for in-process metadata snapshot/compensation flows and make later field
   writes wait for Apply. If the affected set/path changes during acquisition,
   the definitive recomputation rejects stale.
2. While those locks are held, run one
   `db.transaction(...).immediate()`. Recompute the same planner from locked
   SQLite state, compare the supplied fingerprint before mutation, validate the
   allowed state, execute the complete operation, update document versions,
   verify targeted postconditions, produce the result, and commit.

No structure lock is required because Tag Apply does not change vault
membership. Folder operations acquire structure then sorted document locks;
Tag Apply only acquires sorted document locks and never later requests the
structure lock, so it does not introduce the reverse-order deadlock.

The Apply request carries only `{ operation, planFingerprint }`. A missing or
malformed fingerprint is `PREVIEW_REQUIRED`. For a syntactically valid supplied
Preview, any changed row resolution or changed conflict state is
`PREVIEW_STALE` before operation SQL. A fresh initial Preview still exposes the
more specific domain error. Apply's locked recomputation may calculate a digest
for a now-disallowed state solely to establish equality/error precedence; its
`allowedToApply: false` state can never pass into mutation SQL. Constraint
messages and SQL text never escape.

Inside the IMMEDIATE transaction, capture one wall-clock commit candidate and
preflight every affected version for safe increment. Use one set-based document
update scoped by the source association while that association still exists;
the statement applies the scalar monotonic expression with that one clock
candidate, and its changed-row count must equal `affectedCount`. Then execute
tag/association SQL and targeted postcondition queries. Any thrown validation,
hook, constraint, or postcondition error rolls back every row and version.

A successful result is returned only after commit and contains an opaque UUID,
kind, source/destination/survivor IDs and final names, source-deleted flag,
affected and association counts, duplicate collapses, tag create/delete counts,
display-only flag, version-update count, commit timestamp, and applied
fingerprint. Log the same sanitized result after commit; do not persist an
operation log.

The opaque result ID is generated before entering the transaction so the
post-commit log and response use the same value; it is not a durable idempotency
key. `commitTimestamp` is the one wall-clock candidate captured in the locked
transaction, while per-document `updated_at` may be greater under monotonic
rules.

## 19. Rename

For a Rename whose canonical destination is unused, update the source row's
`name` and `normalized_name` in place. The source ID and every
`document_tags.tag_id` remain unchanged. All documents associated with the
source at locked planning time receive one strictly monotonic metadata version
update.

The mutation order is version update first while the old source association is
still the set-based selector, followed by the in-place tag-row update. Both are
inside the same transaction, so readers see neither intermediate state and a
tag-row failure rolls the versions back.

The planner fingerprints the destination-absence lookup. If another writer
creates that identity after Preview, the locked plan differs and Apply returns
`PREVIEW_STALE` before the unique constraint is reached. A fresh Preview of the
same request returns `DESTINATION_EXISTS` and instructs the user to use Merge.
Rename never deletes and recreates the source row and never auto-merges.

Postconditions assert that the source ID still exists with the requested
display/identity, the exact pre-Apply source document set remains associated,
no other tag owns the identity, and the number of versioned documents equals
the affected count.

## 20. Display Rename

When canonical identity is unchanged but normalized display differs, update only
`tags.name`. Preserve `tags.id`, `normalized_name`, and every association.
Association add/remove/collapse counts are zero. Because hydrated metadata
changes, every source-associated document receives one strictly monotonic
metadata version update.

As with normal Rename, version the source-associated set before changing the
display row, inside the same transaction. `Java -> JAVA` is the canonical
example and must pass as a display change, not a no-op.

If both display and identity are unchanged, Preview marks the plan disallowed as
`INVALID_OPERATION`/no-op and Apply cannot run. The UI labels the Preview
“Display rename” and does not imply association movement.

## 21. Merge

Merge preserves the existing destination row and display. Within Apply, while
the source association still defines the affected set:

1. Update every source-associated document once with the monotonic expression.
2. Insert missing destination associations with one
   `INSERT ... SELECT ... ON CONFLICT DO NOTHING` statement.
3. Explicitly delete source associations, recording the actual changed count.
4. Delete the source tag row after all associations are accounted for.

The affected set is every source document, including documents that already
hold the destination. Destination-only documents are untouched. The insert
change count is `associationAdds`; source association count is
`associationRemoves`; source+destination overlap is `duplicateCollapses`.
`tagDeletes = 1`, `tagCreates = 0`.

Postconditions assert that the destination ID/display are unchanged, the source
row and all source associations are gone, every affected document has exactly
one destination association, destination-only versions are unchanged, and all
unrelated associations remain.

## 22. Remove

Remove permits a source with zero associations. Apply versions the complete
source-associated set, explicitly deletes all source associations for
deterministic count verification, and then deletes the source tag. It does not
rely only on cascade for result accounting, although the foreign key remains a
defense.

Postconditions assert that the source row/associations are absent, every
document row remains, all unrelated tags and associations remain, and exactly
the affected documents were versioned. For an orphan source the association
and version counts are zero while `tagDeletes = 1`.

## 23. API

Add a Hono router in `server/routes/tags.ts` and mount it from `server/index.ts`
under the existing global `/api/*` authentication and CSRF middleware:

| Method and route | Purpose | Transaction |
|---|---|---|
| `GET /api/tags` | Health-gated stable-ID management list | read-only |
| `POST /api/tags/operations/preview` | Validate and build initial Preview | deferred read transaction |
| `POST /api/tags/operations/preview/page` | Fingerprint-bound sample continuation | deferred read transaction |
| `POST /api/tags/operations/apply` | Recompute and atomically commit | path locks + one IMMEDIATE transaction |

All mutation bodies are JSON and inherit the current origin/CSRF/content-type
checks. Add `Cache-Control: no-store` through the existing boundary. Routes do
not accept document IDs, normalized identities as authority, batch operation
arrays, or client-computed counts.

Keep the repository's existing error envelope compatible:

```json
{ "error": "human-readable text", "code": "PREVIEW_STALE", "details": {} }
```

`error` remains a string so `jsonOrThrow` and existing clients continue to
work. `details` contains only bounded, non-sensitive correction data such as a
destination tag ID/display; never SQL or stack traces.

Preview returns 200 for every well-formed operation whose referenced rows exist,
including a static business conflict/no-op; those plans carry
`allowedToApply: false`, their stable conflict code/message/warnings, and a
review fingerprint that Apply refuses while disallowed. Malformed/invalid input
and missing IDs still use PRD 400/404 errors. Apply to a disallowed-but-current
fingerprint returns its 409 domain conflict; changed state returns
`PREVIEW_STALE`. This lets the required Rename collision Preview render “Use
Merge” while preserving unambiguous HTTP errors at the mutation boundary.

## 24. Client API

Add `src/lib/tag-management-api.ts` with only the feature's concrete types and
four request functions:

- `ManagedTag`;
- `TagOperationRequest`;
- `TagOperationPreview`, sample/page types, and warning/error-code unions;
- `TagOperationResult`;
- `listManagedTags`, `previewTagOperation`, `getTagOperationPreviewPage`, and
  `applyTagOperation`.

Export the existing `jsonOrThrow` helper from `src/lib/api.ts` and reuse
`authFetch`; do not duplicate auth/error parsing. Runtime guards validate the
identity-bearing response fields before they are used for selection
reconciliation. No new client store is introduced.

## 25. Management UI

Add `TagManagementDialog.vue` as a Teleported modal using the established
`SettingsModal`/`DocumentMetadataModal` conventions, `useFocusTrap`,
`useConfirm`, and `useI18n`. It owns:

- the authoritative stable-ID tag list and local search;
- source selection and operation selection;
- Rename input, existing-tag Merge destination picker, and Remove flow;
- Preview counts, bounded sample, pagination, warnings, and Apply;
- stale, validation, unavailable, transaction-error, and sync-pending states.

Use one discriminated local state rather than intersecting booleans:

```text
closed -> loading -> editing -> preview-loading -> preview-ready
                                      |                 |
                                      v                 v
                                    error          apply-loading
                                                        |
                                      committed-refreshing
                                         |            |
                                       closed     sync-pending

Any relevant input change from preview-ready -> editing (old Preview discarded)
PREVIEW_STALE -> stale -> editing after explicit re-preview action
```

Apply is enabled only for `preview-ready` with an allowed current fingerprint.
Remove uses a destructive button and one final `useConfirm` prompt after
Preview; no literal DELETE typing. Rename collision offers a switch to Merge
with the conflicting destination ID, but never mutates automatically. Merge
picker excludes the source and searches the authoritative list. The default
sample is 20, and “show more” requests fingerprint-bound pages without making
the rendered list the mutation scope.

`TagPanel.vue` eventually adds a keyboard-reachable “Manage tags” button in its
header and emits `manage` with no operation payload. It does not receive stable IDs,
change its tag list rows, selection behavior, count/name ordering, filter, grid,
or results region. `VaultView.vue` owns dialog open/close, the post-commit sync
callback, and selection reconciliation. The dialog may preselect the currently
selected tag after resolving it against its own authoritative list, but the
trigger never guesses an ID from the Phase 1 index.

The production trigger stays absent through T2-4. T2-3 and T2-4 may mount the
dialog/internal components directly for tests, but production users cannot see
Manage Tags yet. T2-5 wires/shows the trigger only after the cumulative
Rename/Display Rename/Merge/Remove exposure gate passes. A failed health state
then remains discoverable and repairable through the existing unavailable/
diagnostic state. No generic feature-flag framework is introduced.

## 26. `selectedTag` Reconciliation

Do not rewrite Phase 1's `selectedTag: string | null`. When opening the manager,
resolve the current string through shared normalization against the
authoritative managed-tag list and capture its stable ID, if any. When Apply
starts, capture a selection snapshot before operation work, including the raw
selected value, its resolved stable ID when available, operation source and
destination IDs, and a local selection revision/epoch/generation.

`VaultView` maintains a small local monotonic selection epoch. It increments
only when the user actually changes the selected tag. Apply captures the epoch
at start; completion compares the current epoch with that captured value. The
epoch is the race detector, not a global store, router state, or state-machine
library. The modal backdrop and focus trap may prevent interaction during Apply,
but the defensive epoch check remains required.

After Apply commits, clear operation Preview state, perform the authoritative
posts/tree refresh and fresh managed-tag-list refresh, then detect whether the
selection epoch changed while Apply was in flight. If it changed, preserve the
current user selection and do not let operation reconciliation overwrite it.
Otherwise reconcile from the captured stable ID, operation result stable IDs,
and fresh authoritative managed-tag list. Never optimistically set `selectedTag`
before the authoritative refresh.

The operation result supplies stable identity fields such as `sourceTagId`,
`destinationTagId`, `survivorTagId`, final names, and `sourceDeleted`.
Post-refresh reconciliation must not require the old display string to resolve:
Rename may change its display, Merge may delete the source, and Remove deletes
the source row. Display strings are UI values only. If the selected string did
not resolve when Apply started, treat selection as unrelated/unknown and never
attach it to source, destination, or survivor because a refreshed row happens to
share its display string.

After a committed Apply and successful refresh, resolve final display names
from the fresh management list and apply this stable-ID matrix:

| Captured/current identity | Operation | Reconciled selection |
|---|---|---|
| source | Rename / Display Rename | survivor's fresh display |
| source | Merge | destination's fresh display |
| destination | Merge | destination's fresh display |
| source | Remove | `null` |
| unrelated | any | preserve the selected stable ID, canonicalizing its display from the fresh list if it still exists |

If the user changed selection during Apply, preserve the current selection even
if operation IDs suggest another result. If an unchanged unrelated stable ID no
longer exists in the fresh authoritative list, clear it rather than retain a
label with no server row. Never use old-display survival as identity proof.

The required reconciliation order is: commit; receive result IDs; clear
Preview state; refresh posts/tree; refresh the authoritative managed-tag list;
compare the selection epoch; preserve the current selection if it changed;
otherwise reconcile by stable ID and operation result; render final TagPanel
state.

## 27. Refresh / Failure Model

`VaultView` exposes one post-Apply synchronization function. After the dialog
receives committed success it clears Preview/apply intent, then performs exactly
one sync cycle:

```text
Promise.all([
  refresh(),             // one canonical posts/tree refresh
  listManagedTags()      // one management read-model refresh
])
```

The refreshed posts naturally rebuild the existing computed `TagIndex`. Do not
call `applyPostSummary`, patch every post, mutate TagIndex maps, refresh the link
index, emit `fileChanges`, write Markdown, or invoke Git History. The management
list read is part of the same sync cycle and is not a second posts refresh.

If Apply fails before commit, keep correctable input and show the mapped error;
no refresh is required. If Apply commits but either refresh fails, enter
`sync-pending`, state clearly that the database mutation committed, disable all
Apply controls, and offer **Retry sync** only. The retry reruns the sync cycle,
never Apply. Final selection reconciliation and dialog closure happen only
after successful sync.

## 28. Error Mapping

The domain exposes stable errors and the route maps them as follows:

| Domain code | HTTP | Client behavior |
|---|---:|---|
| `INVALID_TAG_NAME` | 400 | Associate error with Rename input |
| `INVALID_OPERATION` | 400 for malformed input; 409 Apply conflict for a reviewed no-op | Preserve input; disable Apply |
| `TAG_NOT_FOUND` | 404 | Refresh list and discard Preview |
| `SOURCE_DESTINATION_SAME` | 409 | Require a different Merge destination |
| `DESTINATION_EXISTS` | 409 | Offer explicit Merge flow |
| `TAG_IDENTITY_CONFLICT` | 409 or 503 when health-wide | Disable operation; surface health guidance |
| `PREVIEW_REQUIRED` | 409 | Return to Preview step |
| `PREVIEW_STALE` | 409 | Clear plan/pages; require new Preview |
| `METADATA_VERSION_CONFLICT` | 409 | Per-document editor/AI reload; never replay tags |
| `TAG_MANAGEMENT_UNAVAILABLE` | 503 | Hide/disable controls; queries remain available |
| `TRANSACTION_FAILED` | 500 | State that no partial Apply committed |

Authentication keeps its existing statuses/codes. Unexpected SQLite errors are
logged server-side with an operation correlation ID and returned as sanitized
`TRANSACTION_FAILED`. A unique violation anticipated by planner semantics is
translated to stale/conflict, not leaked as 500 text.

## 29. Security

- Accept tag IDs only as positive safe integers and bind every SQL value.
- Accept fingerprints only as exactly 64 lowercase hexadecimal characters.
- Enforce one operation per request; reject extra/unknown operation fields at
  the route boundary.
- Normalize and validate Rename names server-side; never interpret names as
  paths, Markdown, SQL identifiers, or HTML.
- Keep the 50-tags-per-document and 100-code-unit limits consistent across
  REST, AI, import, and internal persistent writers.
- Reject NUL and unexpected controls; preserve allowed Unicode without NFKC.
- Cap samples at 20 initially and page limits at 100, while never capping the
  server-computed Apply set.
- Never accept client document IDs, counts, deltas, timestamps, survivor IDs,
  or an entire Preview plan as authority.
- Recheck health and recompute under lock; a tampered source/destination ID is
  missing/invalid, not a request to retarget by display string.
- Inherit the existing single-owner auth, same-origin CSRF, JSON content-type,
  and no-store response boundary; add no tag-specific authorization layer.
- Escape all UI text through Vue interpolation and do not render tag names with
  `v-html`.

## 30. Accessibility / Internationalization

Reuse the current modal abstractions and add Chinese/English `tags.manage.*`
keys to `useI18n.ts`. No Rename, Merge, Remove, stale, destructive, or failure
copy is hardcoded.

The management trigger is a real button. On open, capture the trigger, focus the
search/source control, name and describe the `role="dialog"`, set
`aria-modal="true"`, and trap Tab/Shift+Tab. Escape and backdrop click close
only when no Preview/Apply/sync request is active; active Apply cannot be
dismissed ambiguously. Closing restores focus to the management trigger.

Opening the Remove confirmation temporarily hands focus to the existing global
Confirm host; the management dialog stays mounted and resumes its trap after
the confirm resolves. Component tests verify nested modal focus return rather
than creating a second confirmation implementation.

A polite live region announces list loading, Preview ready and affected count,
stale Preview, committed-refreshing, sync pending, and recoverable failures.
Destructive Remove uses text/icon semantics and the existing destructive
Confirm styling, not color alone. Input errors use `aria-describedby`; loading
controls expose `aria-busy`; Apply remains disabled while missing, stale,
disallowed, or loading.

## 31. Performance

The target fixture is 10,000 documents and 50,000 associations. Domain queries
are set-based and use existing indexes (`tags.normalized_name`,
`idx_document_tags_tag`, document primary keys). Planner query count must remain
constant with affected-document count: tag resolution, affected document rows,
and complete affected associations are bounded query shapes, not N+1.

Preview necessarily materializes the complete relevant graph to fingerprint it,
but serializes only bounded samples. Apply uses set-based association and
version SQL in one transaction. Stateless pagination trades repeated planning
for no cache lifecycle or persistent snapshot table; record observed memory,
query count, Preview time, Apply time, and transaction duration rather than
inventing an SLA.

The deterministic large fixture runs in the domain integration suite. It may
record timing in test output and enforce structural bounds (query count, sample
size, exact counts) without a brittle wall-clock pass/fail threshold on CI.
Performance evidence is reviewed before T2-7; a cache design requires new data,
not anticipation.

## 32. Testing

### 32.1 Normalization and writer foundation

- `shared/__tests__/tagNormalization.test.ts`: canonical fixture and validation
  boundaries.
- `src/lib/__tests__/tags.test.ts`: Phase 1 names re-export the shared behavior;
  all query/index regression cases remain unchanged.
- `server/__tests__/documentMetadata.test.ts`: full create/import, field-scoped
  patch, omitted-tag preservation, explicit-tag CAS, strict same-ms/future-clock
  versions, empty set, and rollback.
- `server/__tests__/metadata-api.test.ts`: REST title-only and summary-only stale
  replays preserve Tag Apply; current explicit tags succeed; stale explicit tags
  return 409; Markdown bytes remain identical.
- `src/components/vault/__tests__/DocumentMetadataForm.test.ts`: partial payload
  derivation, tag-only expected token, mixed-field atomic conflict, and existing
  uncertain-save/newer-draft reconciliation with partial wire requests.
- `server/__tests__/tools.test.ts`: the same matrix for AI, including conditional
  `expected_updated_at` and no direct full-save bypass.
- Existing posts, metadata migration, history, folder, crash recovery, and
  Frontmatter tests prove internal lifecycle and compensation paths preserve
  associations and deterministic snapshots.

### 32.2 Identity migration

Add `server/__tests__/tagIdentityMigration.test.ts` covering fresh/clean DB,
`java/#java`, `Java/JAVA`, same-document overlap, different documents,
many-to-one, orphan groups, invalid empty/control rows, lowest-ID/display winner,
temporary unique staging, foreign keys, exact affected versions, report counts,
completed rerun no-op, failed retry, injected rollback at each mutation stage,
marker ordering, and health gating. Before/after logical membership sets must be
asserted directly.

### 32.3 Planner, fingerprint, and Apply

Add `server/__tests__/tagManagement.test.ts` for:

- Rename normal/display-only/no-op/destination-existing/missing/invalid;
- Merge source-only, overlap, destination-only exclusion, missing target,
  missing source, and self-merge;
- Remove zero/one/many and missing source;
- stable IDs, deterministic order/counts/samples, exact fingerprint tuple, and
  relevant versus unrelated state changes;
- source/destination display and identity changes, target absence race,
  affected metadata/association changes, and same-ms full-state detection;
- all operation postconditions and only-affected version updates;
- failure hooks after version update and after association mutation proving full
  rollback;
- two Apply calls from one Preview: one success, one stale;
- 10k/50k query-count and observation fixture.

Use a temporary on-disk WAL database and two better-sqlite3 connections for
Preview snapshot and Apply concurrency tests. Test seams may pause between
planner query groups and mutation stages; mocked arrays are not sufficient.
Because the production planner itself is synchronous, the Preview seam may run
the writer from a worker thread/child process after the first SELECT; it must not
turn production planning into an async transaction merely to make the test
interleave.

### 32.4 API and UI

- `server/__tests__/tags-api.test.ts`: auth/CSRF, health 503, list shape,
  Preview/page/Apply schemas, bounded pages, error mapping, stale races,
  SQL-injection-shaped Unicode names, tampered IDs/fingerprints, and no partial
  payloads.
- `src/lib/__tests__/tag-management-api.test.ts`: request/response/error parsing.
- `src/components/vault/__tests__/TagManagementDialog.test.ts`: state machine,
  list IDs, all three flows, display rename, Preview invalidation, stale,
  pagination, destructive confirm, keyboard/focus/live announcements, committed
  refresh failure, and sync-only retry.
- Extend `TagPanel.test.ts` for the unchanged Phase 1 list/filter/selection
  contract and the T2-5 production trigger exposure gate.
- Add `src/lib/__tests__/tag-selection-reconciliation.test.ts` for the complete
  stable-ID matrix and selection epoch guard; keep the logic pure and imported
  by VaultView. The plan must cover: (A) Rename Java(id=7) -> Backend selects
  Backend(id=7) although Java is absent; (B) Display Rename Java -> JAVA keeps
  id 7 and selects JAVA; (C) selected source 7 follows Merge destination 9
  after source deletion; (D) selected destination 9 remains selected after
  Merge 7 -> 9; (E) Remove selected source 7 clears to null after deletion;
  (F) unrelated Python(id=20) survives Java -> Backend; (G) epoch 12 at Apply
  start, user selects Python at epoch 13, and Python wins; (H) an unresolved
  pre-Apply string is not attached to source/destination by display coincidence.
- At T2-3, verify Rename works when the dialog is mounted internally while the
  production TagPanel Manage Tags entry is absent. At T2-4, verify Merge works
  internally while that entry remains absent. At T2-5, verify Rename, Display
  Rename, Merge, and Remove are all available and the production entry becomes
  visible only after the cumulative gate.
- Add `e2e/tag-management.spec.ts`: create/import notes, capture Markdown bytes
  and vault Git status/HEAD, Preview+Rename, verify TagPanel and metadata,
  Merge with overlap dedupe, Remove, verify selection behavior, then prove
  Markdown bytes/Git history are unchanged. Complex races stay in SQLite/API
  integration tests.

### 32.5 Required verification commands

Each implementation phase runs targeted tests plus:

```text
npm run typecheck
npm test
npm run build
npm run test:e2e
```

T2-6/T2-7 additionally require the existing cross-platform Playwright config,
dedicated auth browser smoke, Docker image/auth smoke, and the full GitHub Actions
matrix. The new Vitest and E2E paths are already discovered by current scripts,
so no CI workflow change is planned.

## 33. Migration / Rollout

### 33.1 Deployment order

T2-0 ships before any management control and must be independently reviewable.
T2-1 may ship read-only list/Preview endpoints. T2-2 may ship Apply endpoints
with no client entry. T2-3 builds the management shell and Rename internally,
and T2-4 adds Merge internally; both keep the production Manage Tags entry
hidden/unmounted. T2-5 adds Remove, runs the cumulative Rename/Display
Rename/Merge/Remove gates, and only then wires the production entry.

The production Docker image contains SPA and server from one build, so the
normal deployment unit is atomic. During development or a stale-browser
mismatch:

- new client + old server receives 404/503, hides/disables management, and
  performs no mutation;
- old client + new server can continue reads, but its old full metadata PATCH
  includes tags without `expectedUpdatedAt` and must fail closed rather than
  replay stale associations;
- a refreshed current client sends field-scoped patches and works normally.

Do not add protocol negotiation solely for this short-lived mismatch. Release
notes require a hard browser refresh after upgrade if metadata editing sees the
new conflict response.

The updated full create/import path accepts a legacy tag spelling but persists
only the canonical display/identity and reuses an existing canonical row. This
prevents a post-migration external Frontmatter import from recreating logical
duplicates even though the identity migration itself is one-time.

### 33.2 Backup and rollback

Before deploying T2-0, stop the writer or use a SQLite-consistent backup that
includes the database/WAL state, and retain it until migration health and a
representative query check pass. Docker operators back up the `nuvyn-data`
volume; local operators back up `data/nuvyn.db` with SQLite's backup mechanism.

Three rollback cases are distinct:

1. **Migration execution failure:** the one data transaction rolls back; the
   failure marker keeps management unavailable; query reads remain available.
2. **Code rollback before migration success:** deploy the previous atomic image;
   no logical identity consolidation committed.
3. **Rollback after migration success/new writes:** do not promise a reverse
   migration. Consolidated losing tag IDs cannot be reconstructed exactly.
   Stop the service and restore the pre-upgrade backup with the matching old
   image, accepting that post-backup writes are not in that restored state.

Downgrading only application code against a successfully migrated/live-written
database is unsupported because the old writer can recreate `#`-equivalent
identities. No implementation phase rewrites Markdown, so vault file backup is
not the recovery mechanism for this database migration.

### 33.3 Operational evidence

Startup logs emit the identity migration report and health state without tag
contents. T2-7 release notes record backup instructions, marker version,
migration counts, verification result, representative large-vault observations,
client/server mismatch behavior, known timestamp display consequence, and Undo
deferral.

## 34. Proposed File Map

### New

| Future file | Responsibility |
|---|---|
| `shared/tagNormalization.ts` | One identity/display/validation contract |
| `shared/__tests__/tagNormalization.fixtures.ts` | Cross-layer fixture table |
| `shared/__tests__/tagNormalization.test.ts` | Shared contract tests |
| `server/tagIdentityMigration.ts` | Startup data migration, marker, report, health |
| `server/tagManagement.ts` | Read model, operation types, planner, hash, Apply |
| `server/routes/tags.ts` | Hono parsing and error mapping |
| `server/__tests__/tagIdentityMigration.test.ts` | Migration/health/rollback tests |
| `server/__tests__/tagManagement.test.ts` | Domain, concurrency, scale, rollback tests |
| `server/__tests__/tags-api.test.ts` | Authenticated route integration |
| `src/lib/tag-management-api.ts` | Typed management client |
| `src/lib/__tests__/tag-management-api.test.ts` | Client transport tests |
| `src/lib/tag-selection-reconciliation.ts` | Pure stable-ID selection matrix |
| `src/lib/__tests__/tag-selection-reconciliation.test.ts` | Selection/race matrix |
| `src/components/vault/TagManagementDialog.vue` | Dedicated manager and state machine |
| `src/components/vault/__tests__/TagManagementDialog.test.ts` | Dialog/UX/a11y tests |
| `e2e/tag-management.spec.ts` | Real Rename/Merge/Remove and no-file/Git mutation flow |

### Modified

| Future file | Planned change |
|---|---|
| `src/lib/tags.ts` | Preserve Phase 1 API while delegating normalization |
| `server/documentMetadata.ts` | Explicit create/import vs patch primitives; monotonic helper; no implicit tag rebuild |
| `server/routes/metadata.ts` | Field-presence parsing, explicit tag token, targeted link update |
| `server/routes/shared.ts` | Updated safe ensure/reconciliation seam |
| `server/metadataMigration.ts` | Existing-row preserve semantics and shared normalization |
| `server/ai/tools.ts` | Field-scoped writer and conditional expected version |
| `server/routes/posts.ts` | Targeted version touches; no existing-row full save |
| `server/routes/folders.ts` | Mint monotonic journal timestamp from snapshot |
| `server/documentFileLifecycle.ts` | Audit/use monotonic metadata touch at lifecycle boundary if it owns a direct version write |
| `server/history/restore.ts` | Use safe observation/mutation semantics without tag replay |
| `server/tree.ts` | Consume the safe existing-row observation/import seam while preserving Frontmatter query fallback |
| `server/prod.ts` | Run identity migration/health after metadata import |
| `server/vite-plugin.ts` | Same startup order in development |
| `server/index.ts` | Mount Tag routes |
| `src/lib/api.ts` | Partial metadata PATCH type and reusable JSON error helper |
| `src/components/vault/DocumentMetadataForm.vue` | Derive partial changes and supply tag version |
| `src/components/vault/TagPanel.vue` | Wire/show the Manage Tags production trigger only in T2-5; preserve Phase 1 behavior |
| `src/views/VaultView.vue` | Own dialog, one sync cycle, selection reconciliation |
| `src/composables/useI18n.ts` | Chinese/English manager strings |
| `server/__tests__/documentMetadata.test.ts`, `metadata-api.test.ts`, `tools.test.ts`, `metadataMigration.test.ts` | Writer/import regression matrix |
| `src/lib/__tests__/tags.test.ts`, `src/components/vault/__tests__/DocumentMetadataForm.test.ts`, `TagPanel.test.ts` | Client contract/form/entry regressions |
| Existing lifecycle/history/recovery tests named in §32 | Compensation and protected-area coverage |

`server/crashRecovery.ts`, `server/folderMoveTransaction.ts`,
`server/folderMoveV4Metadata.ts`, and `server/frontmatterArchive.ts` are audit
targets, not planned edits. The planned folder timestamp change is owned at the
`server/routes/folders.ts` journal-construction call site. If T2-0 proves the
audit-target modules' persisted-journal or compensation behavior itself needs a
change, stop and review the Draft Recovery boundary before adding them to the
modified list.

### Protected / should remain untouched

- Markdown renderer, Markmap, Mermaid, KaTeX, Emoji, and Wiki-link resolver;
- link-index semantics and `fileChanges` event model;
- Git History domain and commit behavior;
- Draft Recovery state machine, snapshot schema, and ownership/CAS protocol;
- authentication semantics and public endpoint policy;
- Docker and Compose configuration;
- GitHub Actions workflows and package/lock files;
- Phase 1 TagIndex/query semantics and `PostSummary.tags` shape;
- Approved PRD and archived freeze/design/closure records.

No new dependency is required.

## 35. T2-0 — Identity and Writer Safety Foundation

### Scope

Before starting T2-0, record the actual implementation HEAD and compare
production-code changes since the approved implementation/code planning
baseline `f9a79c9be2723f2b163486b743e91792e1471393`. Revalidate any changed
files that affect this plan. If the architecture has materially changed, stop
and update/re-review the plan; otherwise continue using this plan without
rewriting its historical baselines.

1. Add the shared identity/display/validation contract and delegate the Phase 1
   client exports to it.
2. Establish scalar and folder-batch monotonic metadata version helpers.
3. Split full create/import from field-scoped existing-row patch; eliminate
   implicit tag replacement from ordinary callers.
4. Integrate field-scoped semantics into REST, `DocumentMetadataForm`, AI, and
   all legacy/internal writer categories.
5. Audit lock-scoped snapshot/compensation paths and add stale-replay regression
   tests without redesigning recovery.
6. Implement and rehearse the TypeScript identity data migration, settings
   marker/report, startup ordering, and health evaluator.
7. Keep every management route and UI control absent.

### Acceptance gate before T2-1

- [ ] Client, server, migration, planner fixture, and persistent writer use the
      same `tag-identity-v1` implementation and locale-independent
      `toLowerCase()` semantics.
- [ ] No authoritative identity path uses SQLite `LOWER()` or
      `toLocaleLowerCase()`.
- [ ] `java/#java` and `Java/JAVA` consolidate without logical membership loss;
      the lowest ID and its normalized display survive.
- [ ] Migration is one IMMEDIATE transaction, marker-last, retry-safe,
      idempotent, fully verified, and rolls back under every injected failure.
- [ ] Invalid historical identity fails closed without deleting data.
- [ ] Title-only and summary-only REST writes cannot resurrect, remove, or
      replace tags after an intervening management-style mutation.
- [ ] Explicit REST tags require a current `expectedUpdatedAt`; stale and
      missing tokens fail closed.
- [ ] AI summary-only and explicit-tag operations share those same semantics;
      there is no direct full-save bypass.
- [ ] Create/import/lifecycle/recovery callers are classified and tested;
      existing-row observation does not rebuild associations.
- [ ] Every real document mutation strictly advances `updated_at`, including
      same-millisecond and future-clock cases; reads do not invent updates.
- [ ] Phase 1 Tag Query/TagPanel/FileTree tests and full existing test lanes pass.
- [ ] No Tag Management API or UI is exposed.

## 36. T2-1 — Planner and Preview

### Scope

1. Add the stable-ID management list and health-gated GET route.
2. Define the request/plan/read-model types in `server/tagManagement.ts`.
3. Implement set-based read-only planning for Rename, Display Rename, Merge,
   and Remove.
4. Implement exact canonical serialization and SHA-256 fingerprinting.
5. Add deferred-transaction Preview, bounded sample, and stateless
   fingerprint-bound page continuation.
6. Add domain errors, route parsing/mapping, domain/API tests, two-connection
   snapshot tests, and the large deterministic fixture.
7. Do not add Apply mutation or UI controls.

### Acceptance gate before T2-2

- [ ] Preview is read-only and never uses `BEGIN IMMEDIATE` or document locks.
- [ ] Every plan field comes from one logical SQLite read snapshot.
- [ ] Identical relevant state produces byte-identical canonical input and
      fingerprint regardless of incidental query order.
- [ ] Fingerprint includes exact source/destination/absence, full affected
      metadata and association state, and normalization contract version.
- [ ] An unrelated document/tag change outside the relevant graph does not
      invalidate the plan.
- [ ] Every relevant change makes Preview continuation stale.
- [ ] Affected set/count/deltas are complete; response sample is bounded to 20
      and pages to 100.
- [ ] Pagination recomputes and verifies the originating fingerprint; it has no
      server cache or mutation authority.
- [ ] Planner query count is constant with document count and contains no N+1.
- [ ] 10k/50k fixture records memory/query/timing observations and exact counts.
- [ ] A live Markdown file added after startup keeps management unavailable
      until the existing metadata migration/health refresh accounts for it.
- [ ] No Apply endpoint or management UI is exposed.

## 37. T2-2 — Atomic Apply and API

### Scope

1. Add the Apply domain entry and HTTP route.
2. Coordinate discovery with sorted document locks, then recompute under one
   IMMEDIATE transaction.
3. Compare the Preview fingerprint before SQL mutation and implement stable
   stale/error precedence.
4. Implement Rename, Display Rename, Merge, Remove, monotonic version updates,
   postcondition verification, and audit-friendly results.
5. Add failure-injection, two-connection, duplicate-Apply, stale writer,
   Markdown/Git boundary, auth, and security tests.
6. Keep management UI hidden.

### Acceptance gate before T2-3

- [ ] One operation is all-or-nothing; no transaction chunking or partial
      success path exists.
- [ ] Apply takes sorted document locks and exactly one `BEGIN IMMEDIATE`
      transaction, calls the same planner, and rejects stale before mutation.
- [ ] Rename preserves source ID and associations; Display Rename changes only
      display plus affected versions.
- [ ] Merge preserves destination ID/display, deletes source, collapses overlap,
      and leaves destination-only documents/version tokens unchanged.
- [ ] Remove deletes only source associations/tag; every document and unrelated
      association remains.
- [ ] Every affected document advances exactly once; no unaffected document is
      updated.
- [ ] Failure hooks after version/association/tag steps restore every row and
      version.
- [ ] Two Apply calls from one Preview yield one commit and one
      `PREVIEW_STALE`.
- [ ] No client-supplied scope or SQL/constraint detail can affect/leak from the
      mutation.
- [ ] Markdown bytes, file mtimes, `fileChanges`, link index, and vault Git state
      are untouched by Tag Apply.
- [ ] Successful result/log contains the PRD identity/count/timestamp fields and
      no persistent operation log was added.

## 38. T2-3 — Rename UI

### Scope

1. Add typed client API, manager shell, health/list loading, state machine,
   Preview rendering, pagination, Apply, and post-commit sync callback.
2. Add the dialog/VaultView ownership seam; keep the production TagPanel
   management trigger hidden until T2-5.
3. Implement normal Rename and Display Rename UX, destination conflict guidance,
   stable-ID selection reconciliation, accessibility, and bilingual copy.
4. Keep the production trigger unmounted; runtime health still gates every
   management read/mutation and renders diagnostics on failure.

### Acceptance gate before T2-4

- [ ] TagPanel's Phase 1 list/filter/grid/results behavior is unchanged apart
      from the management trigger.
- [ ] Rename cannot Apply before a current allowed Preview; changing input
      discards the fingerprint.
- [ ] Existing destination explicitly guides to Merge and cannot auto-merge.
- [ ] Display Rename is labeled and shows zero association delta.
- [ ] Rename follows the fresh survivor display by stable ID even when the old
      source display no longer exists after refresh.
- [ ] Display Rename resolves the same stable ID to its fresh display.
- [ ] Actual user selection changes during Apply are preserved; old-display
      survival is not used as the race detector.
- [ ] Production TagPanel Manage Tags remains hidden/unmounted; tests mount the
      dialog/internal components directly.
- [ ] Success performs one posts/tree refresh and one management-list read in a
      single sync cycle, with no optimistic post/TagIndex patch.
- [ ] Committed + refresh failure enters sync-pending and retries sync only.
- [ ] Focus entry/trap/Escape/return, live announcements, and input errors pass
      component tests in Chinese and English.
- [ ] Rename browser flow passes and Markdown/Git evidence remains unchanged.

## 39. T2-4 — Merge UI

### Scope

Extend the reviewed manager shell with existing-tag destination search, source
exclusion, overlap/dedupe Preview, destination-display ownership explanation,
source-deletion warning, and source/destination selected-tag reconciliation.
Do not rewrite the shell or TagPanel. Keep the production Manage Tags trigger
hidden/unmounted; Merge tests may mount the dialog/internal components directly.

### Acceptance gate before T2-5

- [ ] Only an existing distinct destination stable ID can be selected.
- [ ] Preview shows complete affected count, added/removed/collapsed counts,
      destination display winner, and source deletion.
- [ ] Selected source follows the fresh destination even though the source row
      is deleted; selected destination stays; unrelated selection remains.
- [ ] A user-changed unrelated selection is not overwritten by reconciliation.
- [ ] Stale/deleted destination clears Preview and requires a new one.
- [ ] Source-only, overlap, destination-only exclusion, selection, refresh
      failure, keyboard, and real browser Merge cases pass.
- [ ] Manager shell, Rename behavior, and Phase 1 projections remain unchanged.

## 40. T2-5 — Remove UI

### Scope

Add the destructive Remove flow to the existing manager: exact source label,
affected count/sample, explicit documents/Markdown-preserved explanation,
destructive confirmation, and selected-source clearing. Add the cumulative
Rename/Display Rename/Merge/Remove regression gates, then wire/show the
production TagPanel Manage Tags entry only after every exposure gate passes. Do
not redesign the manager.

### Acceptance gate before T2-6

- [ ] Remove cannot run without a current Preview and final explicit
      destructive confirmation.
- [ ] Zero-document orphan removal is clearly represented and permitted.
- [ ] UI states that documents and Markdown remain while associations/global
      tag are removed.
- [ ] Selected source clears after fresh sync; unrelated selection remains.
- [ ] Selected removed source clears even though its source row no longer exists
      after refresh; a user-changed selection is preserved.
- [ ] Cancel/confirm, stale, sync-pending, keyboard/live-region, zero/many, and
      real browser Remove cases pass.
- [ ] Rename and Merge regressions remain green.
- [ ] Rename, Display Rename, Merge, and Remove production flows are complete;
      Preview/Apply, stale handling, sync-pending, selectedTag, accessibility,
      and i18n gates are green.
- [ ] No partial management controls are exposed; only now is the production
      Manage Tags entry enabled.

## 41. T2-6 — Hardening

### Scope

Run and close the complete concurrency, writer, migration, scale, security,
accessibility, refresh-failure, cross-platform, and browser matrices. Rehearse a
real backup/upgrade/health failure/restore in an isolated production-like copy.
Resolve defects in their owning T2 phase rather than weakening tests.

### Acceptance gate before T2-7

- [ ] REST and AI stale-writer matrices pass for Rename, Display Rename, Merge,
      and Remove.
- [ ] Two-connection Preview and Apply interleavings prove snapshot consistency,
      stale rejection, serialization, and full rollback.
- [ ] Migration rehearsal covers clean, dirty, invalid, interrupted, failed,
      retried, completed, and downgraded/restore scenarios.
- [ ] 10k/50k observations show bounded responses and no N+1; any material
      regression is explained or fixed.
- [ ] Invalid IDs/fingerprints, controls, oversized names, too many tags,
      injection-shaped names, unauthorized, and CSRF cases fail safely.
- [ ] Component accessibility checks and keyboard-only flows pass.
- [ ] Full typecheck, build, Vitest lanes, browser suites, auth smoke, Docker
      smoke, and Node/OS CI matrix pass without snapshot weakening.
- [ ] Protected Markdown, link, Git, Draft Recovery, auth, Docker, and Phase 1
      behavior has no unexplained diff/regression.

## 42. T2-7 — Closure and Rollout Evidence

### Scope

Create the separate final closure record only after all prior gates pass. It
collects implementation commits, test/CI evidence, migration report/rehearsal,
large-vault observations, release/backup/restore instructions, compatibility
notes, known limitations, protected-area audit, and the explicit Phase 2.1 Undo
deferral. This planning task does not create that closure.

### Final release gate

- [ ] Every T2-0 through T2-6 checkbox has linked evidence and no waived safety
      invariant.
- [ ] Production backup and operator rollback instructions were executed in a
      rehearsal, not only written.
- [ ] Identity migration and management health report pass on the release
      candidate.
- [ ] One atomic client/server image and stale-browser behavior are documented.
- [ ] No open P0/P1, Architecture / PRD Conflict, or unexplained P2 remains.
- [ ] Known limitations include the DB updated-date consequence, no durable
      operation history, and Undo Deferred to Phase 2.1.
- [ ] Final full CI and browser evidence is attached.
- [ ] Closure is reviewed before the feature is declared complete.

## 43. Commit Strategy

Use one reviewable commit series and do not combine all Phase 2 work into a
single commit. Recommended boundaries are:

1. `T2-0: establish tag identity and metadata writer safety`
2. `T2-1: add tag planner and read-only preview`
3. `T2-2: add atomic tag operations apply`
4. `T2-3: add rename management UI`
5. `T2-4: add merge management UI`
6. `T2-5: add remove management UI`
7. `T2-6: harden tags management`
8. `T2-7: close tags management phase 2`

Each commit must pass its phase's targeted tests and acceptance gate before the
next phase begins. Small corrective commits within a phase are acceptable; do
not expose later UI early merely to preserve a one-commit-per-phase aesthetic.
No generated migration/report data, local database, screenshots, or vault files
belong in these commits.

## 44. Risks

| Risk | Mitigation / evidence |
|---|---|
| JS and SQLite Unicode normalization drift | Shared TS contract is the sole authority; SQL receives computed values; fixture spans Unicode and no NFKC |
| Historical unique collisions make in-place updates fail | Temporary collision-free identities inside one rolled-back-or-committed IMMEDIATE transaction |
| Invalid historical tags have no lossless canonical identity | Abort before mutation, record failed health, preserve data, provide operator diagnostic |
| Same-ms `updated_at` permits stale explicit tags | Scalar `max(now, current + 1)`, safe-integer guard, field-scoped CAS tests |
| Title/summary or AI replays old tags | Omitted fields do not write; explicit tags require expected version; one domain primitive |
| Lifecycle compensation restores pre-Apply associations | Sorted document-lock coordination plus existing snapshot ownership/CAS audit and interleaving tests |
| Preview hashes too much or too little | Exact ordered relevant-graph tuple is frozen in tests; unrelated/relevant change matrix |
| Rename destination appears after Preview | Fingerprint includes resolved absence; locked recomputation returns stale before UNIQUE SQL |
| Large Preview consumes memory or holds transactions | Set-based fixed query count, bounded wire sample, measured 10k/50k fixture; no invented SLA/cache |
| Apply commit succeeds but client looks stale | Separate committed-refreshing/sync-pending state; retry sync only; no optimistic projection |
| Post-Apply reconciliation mistakes old display survival for a selection race | Capture stable ID plus local selection epoch at Apply start; detect actual user selection mutation; reconcile with operation-result IDs and the fresh authoritative list |
| Manage Tags production entry appears before the Phase 2 MVP is complete | Keep production trigger hidden through T2-4 and wire it only after the cumulative T2-5 Rename/Display Rename/Merge/Remove gate |
| New client and old server, or stale old client | Management unavailable safely; old explicit full-tag PATCH fails closed; atomic image + refresh note |
| Downgrade after identity consolidation | Pre-upgrade SQLite backup; no false reverse-migration promise; restore matching image/database together |
| Scope expands into renderer/history/recovery rewrite | Protected file map and per-phase review gate; stop on newly discovered architecture conflict |

## 45. Architecture Blockers

None identified at planning baseline
`f9a79c9be2723f2b163486b743e91792e1471393`.

The current schema has stable tag/document IDs, foreign keys, unique identity,
and a usable version token; better-sqlite3 provides deferred and IMMEDIATE
transactions; shared TypeScript is in both build graphs; startup has a safe
pre-serving data-migration seam; and the UI has reusable modal/focus/confirm
patterns.

Implementation must stop and reopen this section if it discovers a production
tag authority outside SQLite, a compensation path that cannot be coordinated
without changing the Draft Recovery contract, inability to make all metadata
writers field-scoped/version-safe, or inability to consolidate identities while
preserving logical memberships.

## 46. Architecture / PRD Conflict and Open Implementation Questions

**Architecture / PRD Conflict:** None.

**Open Implementation Questions:** None. The code-backed trade-offs required
for implementation are resolved in this draft. Review may challenge a decision,
but implementation must not defer normalization authority, migration
execution/marker semantics, version monotonicity, fingerprint inputs,
pagination, lock order, or selected-tag reconciliation to coding time.

## 47. Acceptance Gates

The phase gates in §§35–42 are cumulative. In addition, every review must verify
these release-wide invariants:

- [ ] Approved PRD remains unchanged and authoritative.
- [ ] SQLite is the only Tag Management mutation store.
- [ ] Shared identity is used by every read/write/migration/planner path.
- [ ] Management stays unavailable until metadata and tag identity health pass.
- [ ] Preview is mandatory, server-authoritative, internally consistent,
      read-only, and fingerprint-bound across pages.
- [ ] Apply recomputes under document locks plus one IMMEDIATE transaction and
      has no partial-success path.
- [ ] Field-scoped REST/AI/internal writes cannot replay old tag associations.
- [ ] Versions strictly advance once for affected rows and never for unaffected
      or rejected operations.
- [ ] Rename/source ID, Merge/destination ID, Remove/document preservation, and
      display winner contracts hold.
- [ ] One authoritative client sync and stable-ID selection matrix hold,
      including sync failure and user-selection race.
- [ ] `PostSummary.tags`, TagIndex, FileTree, TagPanel query/selection, Markdown,
      `fileChanges`, link index, Git, and Draft Recovery contracts are preserved.
- [ ] Security, accessibility, migration, rollback, scale, cross-platform, and
      browser evidence is complete.
- [ ] No new dependency, global store rewrite, operation log, Undo, or generic
      framework entered scope.

## 48. Definition of Done

Tags Management Phase 2 is done only when:

1. `tag-identity-v1` is the sole client/server/migration identity contract and
   all historical logical collisions are safely consolidated or management
   fails closed without data loss.
2. Ordinary REST, AI, import, lifecycle, compensation, and future metadata
   writers cannot overwrite Tag Apply with a stale association set.
3. Every real metadata mutation uses a safe, strictly monotonic per-document
   version and every Tag operation fingerprints the complete relevant graph.
4. The stable-ID management list, deterministic planner, deferred-snapshot
   Preview, fingerprint-bound continuation, and one locked IMMEDIATE Apply are
   implemented and verified.
5. Rename, Display Rename, Merge, and Remove satisfy all ID, association,
   display, version, no-file, and no-Git postconditions under success, conflict,
   concurrency, crash/failure injection, and duplicate request scenarios.
6. The dedicated accessible manager provides the three flows without rewriting
   Phase 1 TagPanel/query behavior; committed operations perform one canonical
   sync and stable-ID selection reconciliation.
7. Migration backup/health/failure/restore, client/server compatibility,
   production deployment, large-vault observations, security, accessibility,
   full CI, and browser E2E evidence are recorded in a reviewed closure.
8. No Architecture / PRD Conflict or open release-blocking defect remains.
9. Undo is still explicitly Deferred to Phase 2.1 and no durable operation log
   was smuggled into the MVP.
10. The separate T2-7 closure must be approved. This Approved Implementation
    Plan authorizes T2-0 to begin only after the mandatory implementation
    preflight succeeds; it does not satisfy the implementation Definition of
    Done.

Plan-level reconciliation and exposure checks:

- [ ] Selection race detection is based on actual selection-state change, not
      old-display survival.
- [ ] Rename reconciliation works when the old display disappears.
- [ ] Merge reconciliation works when the source ID disappears.
- [ ] Remove reconciliation works when the source ID disappears.
- [ ] A user-selected unrelated tag during Apply is preserved.
- [ ] Production Manage Tags is not exposed before Rename, Merge, and Remove
      are all available.
