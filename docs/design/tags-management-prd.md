# Nuvyn Tags Management Phase 2 PRD

**Status:** Approved for Implementation
**Date:** 2026-08-13  
**Research baseline:** 89cd538dbf1f35d21fdb656324ee2815768d7a3d  
**Scope:** Approved product and architecture contract; implementation requires a separately approved plan
**Owner:** Nuvyn product owner (Owner / Architecture Review complete)

> This document defines what Tags Phase 2 must mean and why it is safe. It is
> not an Implementation Plan. It intentionally does not prescribe source-file
> placement, SQL statements, class names, migration code, mocks, or commit
> sequencing.

## 1. Document Information

### 1.1 Decision status

This PRD has completed Owner / Architecture Review and is **Approved for
Implementation**. Its product and safety contracts are the source of truth for
the Tags Phase 2 Implementation Plan. Implementation must not silently change
these contracts; any material product or architecture deviation requires a PRD
amendment and review before implementation continues.

### 1.2 Baseline and research scope

The repository was inspected at the actual current HEAD:

~~~text
89cd538dbf1f35d21fdb656324ee2815768d7a3d
~~~

The working tree was clean during research. The historical Tag documents were
read from their current archive locations:

- [Tags temporary freeze](../archive/freezes/tags-temporary-freeze.md)
- [Tags Query & Index Refactor design](../archive/specs/2026-07-30-tags-query-index-refactor-design.md)
- [Tags Query & Index Refactor plan](../archive/plans/2026-07-30-tags-query-index-refactor-implementation-plan.md)
- [Tags Query & Index Refactor implementation record](../archive/implementation-records/tags-query-index-refactor-implementation-record.md)
- [Tags Query & Index Refactor final closure](../archive/closures/tags-query-index-refactor-final-closure.md)
- [Earlier Vault Tag Filter design](../archive/specs/2026-06-02-vault-tag-filter-design.md)

The earlier Vault Tag Filter interaction is historical. It is superseded by
the shipped Phase 1 behavior and is not a Phase 2 product contract.

### 1.3 What approval authorizes

Approval authorizes creation of a Tags Phase 2 Implementation Plan.
Implementation work is authorized only after that plan is separately reviewed
and approved. Approval does not mean implementation is complete, permit an
immediate migration or production rollout, bring Undo into Phase 2 MVP, or
rewrite the historical freeze record.

**Product source of truth:** `docs/design/tags-management-prd.md`. If an
Implementation Plan conflicts with this PRD, the PRD wins.

The required sequence is:

~~~text
Approved PRD -> Implementation Plan -> Plan Review -> T2-0 through T2-7
Implementation -> Closure
~~~

## 2. Executive Summary

Tags Phase 2 establishes a persistent Tag Management system on top of the
accepted Phase 1 query and index behavior. The MVP provides:

1. Rename one tag to a previously unused normalized identity.
2. Merge one source tag into one existing destination tag.
3. Remove one tag globally from document associations and then remove its
   global tag record.
4. Mandatory server-authoritative Preview before every mutation.
5. A shared planner semantic for Preview and Apply.
6. Conflict validation and deterministic stale-preview rejection.
7. One BEGIN IMMEDIATE SQLite transaction for the complete Apply.
8. Historical identity cleanup and client/server normalization unification.
9. Exact affected-document metadata version updates.
10. An audit-friendly operation result without introducing event sourcing.

The safety pipeline is:

~~~text
request
  -> server validation and normalization
  -> read-only Preview plan
  -> deterministic plan fingerprint
  -> user confirmation
  -> BEGIN IMMEDIATE
  -> recompute the same plan
  -> compare fingerprint and conflict state
  -> all-or-nothing SQLite Apply
  -> clear operation state
  -> one authoritative client refresh
~~~

Undo is **Deferred to Phase 2.1**. Phase 2 MVP does not claim that a Rename,
Merge, or Remove can be safely undone.

## 3. Background

### 3.1 Phase 1 and Phase 1.1 are closed

The shipped Phase 1 / 1.1 work unified the client query surface around:

- normalizeTag
- normalizeTagDisplay
- TagQuery
- parseTagQuery
- matchesTagQuery
- TagIndex
- buildTagIndex
- updateDocumentTags
- FileTree tag-aware query
- TagPanel tag filtering
- TagPanel selected-tag results
- the current chip/grid presentation

The Phase 1 closure is a stable baseline, not a management implementation.

### 3.2 Why management is a separate phase

Rename, Merge, and Remove are global persistent mutations. They can affect many
documents and interact with metadata versioning, SQLite foreign keys, AI
metadata writes, multiple browser tabs, and the existing migration boundary
between Markdown and SQLite. A UI button alone would not establish correctness.

Phase 2 therefore treats Tag Management as a small domain with an explicit
identity contract, planner, conflict model, and transaction boundary.

### 3.3 Historical freeze remains historical

The temporary freeze is not changed by this PRD. It remains a historical record
of the accepted Phase 1 state. Formal removal of the freeze is a later,
separate action after PRD approval.

## 4. Existing Accepted Behavior

Phase 2 must preserve the following behavior unless a future approved PRD
explicitly changes it:

- normalizeTag trims, removes at most one leading #, trims again, and
  lowercases; it does not perform NFKC normalization.
- normalizeTagDisplay trims, removes at most one leading #, trims again, and
  preserves casing.
- #tag is an include query; -#tag is an exclude query.
- Exclude wins over include.
- Plain text tokens use case-insensitive AND matching against path and title,
  not summary.
- The TagPanel filter is a tag-name substring filter and accepts #-prefixed
  input; a bare # shows no tag rows.
- TagPanel selection remains a single selected tag with its own in-panel
  results region.
- TagPanel selection does not drive the FileTree search surface.
- TagIndex maintains forward, reverse, and count consistency.
- TagPanel keeps the current count-descending/name-ascending ordering and
  current chip/grid UI.
- FileTree keeps plain text search, #tag search, -#tag exclusion, folder
  subtree behavior, and the current path/title search scope.

Phase 2 must not rewrite TagIndex, redefine FileTree query semantics, reconnect
TagPanel selection to FileTree, or use management as a reason for visual
retuning.

## 5. Problem Statement

The current product can read and query tags but cannot safely manage a global
tag identity. The research found four product risks:

1. The client identity contract and persistence identity contract differ.
   Client normalization removes one leading #; current server persistence
   normalizes only trim plus lowercase.
2. There is no persistent Rename, Merge, Remove, Preview, or Apply domain.
3. Existing metadata PATCH and AI update_metadata paths can write tags as
   part of a per-document metadata save, so a management operation must account
   for those writers in its stale-preview model.
4. documents.updated_at is the existing document version token, but the
   schema has no separate metadata version, global tag revision, or persistent
   operation log.

The current `saveDocumentMetadata` semantics are not field-scoped: the save
path persists the document row, deletes the document's existing `document_tags`
rows, and reinserts associations from the input tag array. Therefore a caller
whose user intent is only a title or summary change is still a tag-association
writer if it carries a stale `current.tags` snapshot. This creates a real
read-before-Tag-Apply/write-after-Tag-Apply race that cannot be solved by
serializing Tag Management Apply alone.

These risks are solvable with the existing SQLite model and transaction
infrastructure, but they must be addressed before exposing controls.

## 6. Goals

### 6.1 Product goals

- Let an owner rename a tag without silently merging it into another tag.
- Let an owner explicitly merge one source tag into one existing destination.
- Let an owner remove a tag globally without deleting documents or Markdown.
- Make the impact of every operation understandable before Apply.
- Reject a Preview that no longer describes the live database.
- Keep the operation result understandable enough for support and application
  logs to identify what happened.

### 6.2 Architecture goals

- Establish one normalized tag identity across client, server, migration,
  planner, and tests.
- Keep SQLite as the only persistent mutation authority for Tag Management.
- Reuse stable tag IDs and stable document IDs already present in the schema.
- Reuse documents.updated_at as the current document metadata/version token;
  do not invent a global tag revision without evidence that it is necessary.
- Make Preview and Apply two executions of the same planner semantics.
- Preserve Phase 1 query behavior and TagIndex as a client projection.

## 7. Non-Goals

The Phase 2 MVP does not include:

- tag colors;
- tag hierarchy or nested tags;
- custom tag ordering;
- arbitrary drag-and-drop;
- multi-select TagPanel behavior;
- AI tag suggestions;
- saved searches;
- aliases or synonym systems;
- tag descriptions or icons;
- per-document tag display names;
- tag permissions, RBAC, or collaboration;
- a general bulk-edit framework;
- a general metadata workflow engine;
- multi-source or graph-shaped merge batches;
- automatic Markdown/frontmatter rewrite;
- Git History entries for tag-only changes;
- optimistic cross-document mutation;
- a persistent event-sourcing system;
- generic Undo in the MVP.

## 8. Current Architecture Findings

### 8.1 Client query model

The client implementation in [src/lib/tags.ts](../../src/lib/tags.ts) is a
pure query/index module. It has no fetch or persistence authority. The current
TagPanel and FileTree consumers are:

- [TagPanel.vue](../../src/components/vault/TagPanel.vue), which builds a
  client TagIndex and renders selected-tag results;
- [FileTree.vue](../../src/components/vault/FileTree.vue), which routes search
  through parseTagQuery and matchesTagQuery;
- [VaultView.vue](../../src/views/VaultView.vue), which owns selected-tag UI
  state and currently uses a raw-string toggle comparison.

The raw toggle comparison is a known Phase 1 boundary. It is not a reason to
alter Phase 1 behavior in this PRD; management state must use stable tag IDs and
the server contract instead.

### 8.2 Server persistence model

The server reads and writes SQLite metadata through
[server/documentMetadata.ts](../../server/documentMetadata.ts). The current
metadata API is mounted behind the existing authenticated /api/* boundary in
[server/index.ts](../../server/index.ts) and
[server/auth/middleware.ts](../../server/auth/middleware.ts).

Current tag writers include:

- metadata PATCH for a document;
- initial legacy Frontmatter import;
- document lifecycle metadata preservation;
- AI update_metadata in [server/ai/tools.ts](../../server/ai/tools.ts).

Current reads return database-owned tags when a document has metadata; the
Frontmatter value is a compatibility fallback for documents not yet imported.

### 8.3 Persistence authority and file boundary

The current architecture documents SQLite as the store for title, summary,
tags, stable document identity, and metadata timestamps. Existing tests verify
that metadata PATCH changes SQLite while leaving Markdown bytes unchanged.

Phase 2 therefore treats SQLite as the sole Tag Management mutation authority:

- no Markdown body or frontmatter write;
- no Markdown mtime touch;
- no fake fileChanges event;
- no vault Git commit or history entry;
- no IndexedDB mutation;
- no cross-store transaction claim.

### 8.4 Transaction infrastructure

better-sqlite3 is configured with foreign keys enabled and WAL mode. The
repository already uses transactions and explicit immediate transactions for
ownership-checked metadata recovery. This is sufficient infrastructure for a
Tag Management Apply, provided the new operation is implemented as one
SQLite-only immediate transaction.

### 8.5 Architecture Blockers

**None identified at the research baseline.** The current schema provides
stable tag IDs, stable document IDs, foreign keys, a junction primary key, and a
usable document version token. The normalization drift and missing management
domain are Phase 2 prerequisites, not blockers requiring a separate
architecture rewrite.

If implementation discovers that any of the following is false, work must stop
and this section must be reopened before coding continues:

| Potential blocker | Evidence required | Product consequence |
|---|---|---|
| SQLite is not the tag authority | A production write path that persists tags elsewhere | Revisit the atomicity boundary |
| Live tags are written back to Markdown as part of normal management | Code and test evidence | Revisit the no-cross-store contract |
| The existing transaction boundary cannot hold the complete tag mutation | Transaction/runtime evidence | Revisit MVP scope or storage design |
| updated_at cannot serve as a safe current metadata/version token | Concurrency test evidence | Design a version primitive before Apply |
| Historical identities cannot be merged without losing associations | Migration rehearsal evidence | Gate management and revise migration strategy |

## 9. Current Database Model

The current migration set is at schema version 6 in
[server/migrations](../../server/migrations). The relevant schema is:

| Table | Current columns and constraints | Phase 2 meaning |
|---|---|---|
| documents | id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, title, summary, created_at, updated_at | Stable document identity and current version/timestamp token |
| tags | id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE | Stable tag row identity, global display name, normalized identity key |
| document_tags | document_id and tag_id foreign keys with ON DELETE CASCADE; composite primary key (document_id, tag_id) | One association per document/tag row; duplicate associations cannot survive the schema |
| metadata_migrations | Path-keyed migration status, optional document ID, backup and error fields | Frontmatter import/cleanup provenance; not the tag identity authority |

Relevant current facts:

- documents.id survives path moves.
- tags.id is stable for a tag row and is distinct from normalized_name.
- tags.normalized_name is currently unique, so dirty logical duplicates
  require a data migration before management is enabled.
- document_tags already deduplicates a particular (document, tag row) pair.
- documents has one updated_at; it does not have a separate
  metadata_updated_at or monotonic revision column.
- The current server saveDocumentMetadata wraps a document metadata rewrite
  in a transaction, but its tag normalization is not yet the Phase 2 contract.
- There is no global tag revision counter and no persistent Tag operation log.

### 9.1 Research database snapshot

The local data/nuvyn.db was inspected read-only during research. It reported
58 documents, 19 tag rows, 50 document-tag associations, schema version 6, and
no duplicate normalized or #-equivalent tag groups in that local snapshot.
That snapshot is development evidence only. It does not prove that another
vault or production database has no dirty identities.

## 10. Tag Identity Contract

### 10.1 Canonical identity

The Phase 2 canonical identity is the output of one authoritative normalization
contract:

1. null and undefined are invalid/no identity and normalize to empty.
2. Trim leading and trailing whitespace.
3. If the result starts with #, remove exactly one leading #.
4. Trim again.
5. Lowercase using the same locale-independent behavior as the current client
   normalizeTag.
6. Preserve all other characters, including CJK, Unicode characters, slash,
   dash, underscore, and internal whitespace.
7. Do not apply NFKC or any other Unicode normalization.
8. An empty result is not a valid persistent tag.

Examples:

| Input | Canonical identity | Same logical tag as java? |
|---|---|---:|
| Java | java | Yes |
| JAVA | java | Yes |
|  java  | java | Yes |
| #java | java | Yes |
| # java | java | Yes |
| ##java | #java | No |
| # | empty/invalid | No |
| java script | java script | A single identity containing internal whitespace |
| 人工智能 | 人工智能 | Yes for the same CJK string |
| a/b, a-b, a_b | each preserved distinctly | No cross-punctuation folding |
| ﬁre | ﬁre | No NFKC conversion to fire |

The contract applies to client display/query, server writes, migration, the
planner, API validation, and tests. There must not be a second hand-written
server rule that omits the leading-# removal.

### 10.2 Validation limits

The current public metadata API accepts at most 50 tag entries and at most 100
characters per tag entry. Repository-level and AI validation are less uniform.
Phase 2 keeps those limits as the compatibility ceiling for a document and
requires the same validation on every persistent tag write:

- at least one canonical character after normalization;
- at most 100 JavaScript/UTF-16 code units in the accepted tag value;
- at most 50 tag entries per document metadata payload;
- reject null bytes and unexpected Unicode control characters;
- reject non-string values before normalization;
- reject an operation destination that normalizes to empty;
- preserve accepted CJK, slash, dash, underscore, and other ordinary Unicode.

The limit is a compatibility contract, not an invitation to add arbitrary
length restrictions in unrelated APIs.

### 10.3 No NFKC migration

Phase 2 does not enable NFKC. Changing that rule would merge identities such as
compatibility characters and would require a separate migration-impact review.

## 11. Display Name Contract

### 11.1 Identity versus display

normalized identity is the stable logical key used for matching, uniqueness,
conflict detection, and planning. display name is the global UI-facing name
stored on the tag row. There is no per-document display name in the MVP.

The display contract trims, removes exactly one leading #, trims again, and
preserves casing. The UI renders its own # glyph. A stored #java must never
render as ##java.

### 11.2 Case-only Rename

Java -> JAVA is a valid **Display Rename**:

- canonical identity remains java;
- the same tags.id remains in place;
- document associations are not rebuilt;
- no duplicate identity is created;
- the tag row display name changes;
- every document holding the tag receives one metadata version update because
  its hydrated metadata representation changed;
- Preview explicitly labels the change as display-only.

If the normalized identity and display name are both unchanged, the operation
is a no-op and Apply is not allowed.

### 11.3 Deterministic historical display winner

For a historical logical collision, the surviving tag row is the row with the
lowest existing tags.id (the oldest stable row). Its normalized display form
wins, with the canonical identity as fallback if the display value is empty.
This minimizes unexpected display reflow and is deterministic across reruns.
The migration must not choose a winner based on query order, locale, or current
client ordering.

## 12. Rename Contract

### 12.1 Semantics

Rename changes one source tag row to a new display/name value. The source is
identified by stable sourceTagId. The destination is supplied as user-entered
text and normalized by the server.

- If the destination normalized identity does not exist, Rename is allowed.
- The existing tags.id is preserved.
- All existing document associations remain attached to that tag row.
- The tag display name becomes the normalized display form of the requested
  destination.
- No document content, path, Markdown, or Git state changes.

### 12.2 Destination already exists

If the destination normalized identity belongs to another tag row, Rename does
not silently become Merge. Preview returns a conflict with the unambiguous
meaning:

~~~text
Destination already exists. Use Merge instead.
~~~

Apply is disallowed. The UI must provide a clear path to a separate Merge flow.

### 12.3 Source and destination identity

- A same-identity destination with a changed display form is Display Rename,
  as defined in §11.2.
- A same-identity and same-display request is a no-op.
- An empty or invalid destination is rejected before Preview is produced.
- ##java remains a distinct canonical identity #java; it is not silently
  collapsed to java.

## 13. Merge Contract

### 13.1 Semantics

Merge is one source tag row into one already existing destination tag row.
Both are identified by stable IDs, and source and destination must be distinct.

After Apply:

- every document associated with the source is associated with the destination;
- if a document already has the destination, the source association is removed
  and exactly one destination association remains;
- the source tag row is deleted after associations are safely transferred;
- the destination tag row and tags.id are preserved;
- the destination display name always wins;
- the source display/casing never overwrites the destination display;
- no document, Markdown file, content, path, or Git history is deleted or
  changed.

### 13.2 Cardinality

The MVP supports one source -> one destination only. It does not accept ten
sources, arbitrary batches, or merge graphs. A future multi-source feature
would require a new planner and safety review.

### 13.3 Affected documents

Every document with the source association is affected, including a document
that already has the destination because its source association is removed.
Destination-only documents are not affected and do not receive a version bump.

## 14. Remove Contract

Remove is global removal of one tag identity, not hiding or filtering it.

After Apply:

- every association from the source tag to every document is removed;
- the global source tag row is deleted;
- affected documents remain present and receive one metadata version update;
- document content, path, body, Markdown, frontmatter, mtime, and Git history
  are untouched;
- other tags and their associations remain untouched.

An orphan tag with zero document associations may be removed; its Preview must
show zero affected documents and explicitly state that the global tag record
will still be deleted.

## 15. Preview Contract

### 15.1 Preview is mandatory

Every Rename, Merge, and Remove requires a server-generated Preview before
Apply. A client-side TagIndex is allowed to render current information but is
not allowed to act as the mutation planner or Preview authority.

### 15.2 Shared planner semantics

Preview and Apply must use the same planner semantics. Preview is a read-only
execution. Apply recomputes the plan after taking the SQLite immediate write
lock and then validates that it still matches the user’s Preview.

Every Preview plan must be built from one internally consistent logical SQLite
snapshot. The source tag, destination state, association state, complete
affected-document set, document versions, counts, warnings, sample, and
fingerprint must all describe the same snapshot. The planner must not read the
source from one state, associations from a later state, versions from another
state, and return a mixed plan that never existed in SQLite. Preview is
read-only and must not take `BEGIN IMMEDIATE` merely to obtain consistency or
hold a long write lock; a read transaction, SQLite snapshot transaction, or
equivalent approach is implementation-owned.

The implementation may choose names later; the product contract is the shared
semantics:

~~~text
normalize -> validate -> resolve stable rows -> compute complete affected set
-> compute association/display/version deltas -> serialize deterministically
-> fingerprint
~~~

### 15.3 Preview result

The Preview result must communicate at least:

- operation (rename, merge, or remove);
- source stable tag ID, normalized identity, and display name;
- destination stable tag ID and identity when applicable;
- requested destination display/name when applicable;
- affected document count;
- bounded affected-document sample containing stable document identity and
  current path/title;
- a read-only continuation/pagination signal for expanding the sample when
  the product chooses to expose it;
- associations added;
- associations removed;
- duplicate associations collapsed;
- tags created;
- tags deleted;
- whether the change is display-only;
- warnings, including destructive or high-impact warnings;
- deterministic plan fingerprint/conflict token;
- whether Apply is currently allowed.

Preview never returns complete Markdown bodies and never implies that the
client may mutate its own copy of the affected set.

### 15.4 Large impact

For 1,000 or 10,000 affected documents, the UI shows the count plus a bounded
sample and an explicit expandable/paginated view. It does not render the full
set in one dialog. Pagination is presentation-only for mutation scope, but a
page still belongs to the Preview the user is reviewing. Any expansion or
pagination request must carry the originating `planFingerprint` or an
equivalent immutable Preview identity. The server may return the next page
only when the relevant plan still matches that identity; otherwise it returns
`PREVIEW_STALE` and the client must regenerate the Preview. It must not
silently read the latest database state for a later page and present Page 1
from one state with Page 2 from another.

The implementation may use stateless recomputation plus fingerprint
validation, a short-lived server-side Preview snapshot/cache, or another
deterministic fingerprint-bound continuation strategy. The product contract is
that all Preview pages belong to the same logical Preview snapshot. Relevant
state changes make old page expansion stale. An unrelated change outside the
plan's relevant graph need not invalidate the Preview; this is not a global
database-revision requirement.

## 16. Apply Contract

### 16.1 All-or-nothing

Apply must complete the entire tag mutation and all affected-document version
updates inside one BEGIN IMMEDIATE SQLite transaction.

The MVP forbids:

- one transaction per document;
- transaction chunking by document count;
- partial success;
- committing associations separately from tag-row updates;
- updating the client optimistically before commit.

Any validation, conflict, constraint, or execution failure rolls back the whole
operation. The user receives failure, not a success count with hidden partial
state.

### 16.2 Revalidation order

Conceptually, Apply is:

~~~text
BEGIN IMMEDIATE
  recompute the planner result from the locked SQLite state
  compare it with the Preview fingerprint and operation request
  if different: return PREVIEW_STALE and make no mutation
  validate all operation invariants
  execute complete SQLite mutation
  update each affected document version once
  produce the operation result
COMMIT
~~~

The result is returned only after a successful commit. A process crash before
commit must leave the prior SQLite state; a successful commit must represent a
complete state. Because MVP mutation is SQLite-only, a separate filesystem
journal is not required for Tag Management.

### 16.3 Operation result

The successful result is audit-friendly and includes an opaque operation/result
identifier, operation type, source/destination identities, affected count,
association counts, collapsed duplicate count, deleted/created tag counts,
display-only flag, version-update count, commit timestamp, and the applied
fingerprint. MVP retains this as the response and application-log material; it
does not create a durable event-sourcing log.

## 17. Concurrency Model

### 17.1 Existing primitive

There is no global tag revision counter in the current schema. Phase 2 does not
introduce one merely for convenience. It uses the existing SQLite serialization
and relevant document/tag graph state.

### 17.2 Fingerprint contents

The Preview fingerprint must be deterministic for the complete relevant plan.
It must cover, at minimum:

- operation and normalized request;
- source row identity, normalized identity, and display state;
- destination row identity/state when applicable;
- sorted complete affected document IDs;
- affected documents’ current path and metadata/version state;
- current source/destination association state;
- the normalization contract version/rules used by the planner.

The fingerprint may be represented as a cryptographic digest. The important
property is deterministic coverage of the full relevant graph, not a particular
hash algorithm.

Including the full relevant metadata state as well as updated_at protects
against the theoretical limitation of a millisecond timestamp token alone.

### 17.3 Stale Preview behavior

If another tab, AI tool, background refresh, metadata PATCH, or another server
request changes relevant state between Preview and Apply:

- Apply returns 409 PREVIEW_STALE;
- no tag or document row is mutated by the rejected Apply;
- the client clears the stale plan;
- the client asks the user to Preview again;
- the client does not silently apply a newly computed plan.

Examples:

- Rename Preview -> another request creates the destination -> Apply rejects
  with destination conflict/stale state.
- Merge Preview -> destination is removed -> Apply rejects.
- Remove Preview -> a document gains or loses the source association -> Apply
  rejects because the affected set changed.
- Two Apply requests from the same Preview serialize; the first valid one
  commits, the second fails stale after recomputation.

### 17.4 Existing metadata writer coordination

All persistent writers capable of rewriting `document_tags` are part of the
Tags Phase 2 concurrency surface. This includes, but is not limited to:

- ordinary metadata PATCH;
- AI `update_metadata`;
- legacy or internal metadata saves; and
- future code paths that can replace a document's tag association set.

User intent alone does not determine whether a request is a tag writer. Under
the current whole-tag-replacement behavior, a title-only or summary-only
request that carries `current.tags` can still delete and reinsert the tag
associations, so it must be coordinated as a tag-association writer until the
write contract is made field-scoped.

The required race contract is:

~~~text
Request A reads V1: tags = [Java]
Tag Management Apply: Java -> Backend
Apply commits V2: Backend is authoritative in SQLite
Request A later saves stale metadata with tags = [Java]
~~~

The final stale replay must not resurrect Java, remove a newly applied Backend
association, undo a Merge, or reverse a Remove. After a successful Tag
Management Apply commits, no request that read metadata before that commit may
replay an older tag-association snapshot and overwrite or resurrect the
committed result. This invariant applies to Rename, Display Rename, Merge, and
Remove.

The future field-scoped write contract is explicit:

- omitted metadata fields must not be rewritten as side effects;
- a title-only mutation updates title and its version, but does not rewrite
  `document_tags`;
- a summary-only mutation updates summary and its version, but does not rewrite
  `document_tags`; and
- only an explicitly supplied `tags` field is a tag-association mutation.

An explicit tag write must read the current state/version, prepare the change,
validate the state again at the mutation boundary, and reject a stale write
fail-closed. The exact implementation primitive (version CAS, transactional
re-read, field-level compare, or a shared metadata mutation primitive) is
implementation-owned; silent last-writer-wins replay is not an accepted
product outcome.

`BEGIN IMMEDIATE` protects the internal serialization of Tag Management Apply,
but it does not by itself solve a request that reads before Apply and writes
after Apply. Apply transaction serialization and existing-writer stale/field
coordination are two separate layers of the concurrency model.

The required ordering is therefore:

~~~text
Existing metadata request reads V1
        |
Tag Apply: BEGIN IMMEDIATE -> mutation -> version V2 -> COMMIT
        |
Old request attempts commit
        |
Field-scoped or version validation
        |
Old tags must not replay
~~~

### 17.5 AI and other writers

AI `update_metadata` and the ordinary metadata API use the same contract. AI
must not receive a raw `saveDocumentMetadata` bypass or a second tag mutation
semantic. An AI operation that changes only summary must not replay stale tags;
an AI operation that explicitly changes tags must use the same normalization,
version, server-authority, and stale-write rejection rules as an ordinary
metadata write. Legacy/internal writers and future writers are subject to the
same invariant.

## 18. Metadata Versioning

### 18.1 Current meaning of updated_at

The current schema has one documents.updated_at field. It is used as the
document’s current update timestamp and as the API version token; there is no
separate content timestamp and metadata timestamp in SQLite.

Phase 2 reuses this existing field rather than adding a new revision column.
This means a tag-only metadata change may change the document’s displayed
updated date when the existing client derives that date from database metadata.
That is an accepted consequence of the current model and is documented as a
risk in §31.

### 18.2 Version bump rules

Each affected document receives exactly one version/timestamp update in a
successful Apply. The update must not move created_at. The timestamp/version
must be safe for stale detection and must not move backwards; an implementation
may use a monotonic value relative to the current row when multiple changes
share a clock tick.

Affected-document rules:

| Operation | Affected documents |
|---|---|
| Rename to new identity | Every document holding the source tag |
| Display Rename | Every document holding the tag because its visible metadata changed |
| Merge | Every document holding the source, including source+destination overlap |
| Merge destination-only document | Not affected |
| Remove | Every document holding the removed tag |
| Historical identity migration | Documents whose association set or visible tag display changes |
| No-op or rejected Preview/Apply | None |

Versions are updated once per document, not once per removed/added association.

### 18.3 Content boundary

Tag Apply does not rewrite the Markdown updated field or any body content.
The existing single DB timestamp remains the version token for this phase; the
product must not pretend that a tag operation is a content edit in Git History.

## 19. Client Refresh Model

### 19.1 Authoritative refresh

After a successful Apply, the client:

1. accepts the server result for status/toast/audit display;
2. closes or clears the management dialog and Preview state;
3. performs one authoritative refresh of the canonical document/tag data;
4. rebuilds the client TagIndex from the refreshed posts;
5. resolves the surviving or newly renamed tag from the refreshed server state;
6. reconciles `selectedTag` using the stable operation identity/result mapping;
7. renders the refreshed TagPanel and selected-tag results.

The result must provide enough identity information for reconciliation,
including the operation, source tag ID, destination tag ID when applicable,
surviving tag ID, resulting display/normalized name, and whether the source was
deleted (exact field names are implementation-owned). The client must not
guess from stale display strings.

Selection reconciliation is part of the product contract:

| Operation and current selection | Result after refresh |
|---|---|
| Selected source + Rename | Follow the renamed tag; selected label is the new display name |
| Selected source + Display Rename | Remain on the same stable tag ID; update the visible label |
| Selected source + Merge | Select the destination stable tag ID/display |
| Selected destination + Merge | Keep the destination selection |
| Selected source + Remove | Clear `selectedTag` and close the selected-results region |
| Unrelated Rename, Merge, or Remove | Preserve the current selection |

No selected tag is changed optimistically before the server commit. If Apply
commits but the authoritative refresh fails, the UI reports synchronization
pending and may retain the current UI state only as pending state; it must not
fabricate a final selected label from stale posts. Final reconciliation uses a
successful authoritative refresh.

The client does not optimistically patch every affected document. It does not
emit metadata fileChanges or a Git History mutation for a SQLite-only tag
operation.

### 19.2 Refresh failure

If Apply committed but the subsequent read refresh fails, the UI must say that
the operation committed and that synchronization is pending. It must retry or
offer refresh; it must not claim the database was rolled back.

### 19.3 Existing API consumers

Existing PostSummary.tags, metadata reads, TagPanel selection, FileTree
queries, and Command Palette behavior remain compatible. The new management
read model may expose stable tag IDs without changing the existing post tag
array shape.

## 20. UI and UX Contract

### 20.1 Entry points

Management actions are available from the current TagPanel context while
preserving its single-select list, selected-tag results, chip/grid layout, and
filter behavior. The exact menu/button placement is an implementation choice;
the product flow is not.

### 20.2 Rename flow

- Choose Rename for one source tag.
- Enter a new display/name value.
- Preview is required before Apply.
- Show identity changes, display-only state, affected count, and warnings.
- If the normalized destination exists, show “Destination already exists. Use
  Merge instead.” and disable Apply.

### 20.3 Merge flow

- Choose Merge for one source tag.
- Select one existing destination tag.
- Preview overlap and deduplication counts.
- Show that the destination display wins and the source row will be deleted.
- Apply is disabled until Preview is current and allowed.

### 20.4 Remove flow

- Choose Remove for one source tag.
- Preview affected document count and the exact tag name.
- State that documents and Markdown remain; only associations and the global
  tag record are removed.
- Use destructive Apply styling and semantics.
- Do not require the user to type DELETE; Preview plus an explicit
  destructive confirmation is sufficient unless a future global Nuvyn UX
  standard changes this rule.

### 20.5 Clear and stale state

- A new input invalidates the old Preview.
- Apply is unavailable without a current allowed Preview.
- On PREVIEW_STALE, clear the plan and request a new Preview.
- On success, clear the operation state before the single refresh.
- On failure, preserve enough input to allow correction without pretending that
  a mutation partially succeeded.

### 20.6 Post-Apply selectedTag reconciliation

Management operations use stable tag IDs. The current Phase 1 `selectedTag`
representation need not be rewritten in this PRD, but a successful management
result must give the client an explicit source/destination/survivor mapping so
that selection follows identity rather than comparing old display strings.
After the one authoritative refresh, a selected source follows Rename and
Display Rename, a selected source follows Merge to the destination, a selected
source is cleared after Remove, and a selection unrelated to the operation is
preserved. The destination remains selected when it was already selected for a
Merge. The TagPanel results remain visible for a renamed or merged selection
and close when the selected tag was removed.

This contract does not reconnect TagPanel to FileTree, add multi-select, build
a global tag store, rewrite Phase 1 TagIndex/query behavior, or introduce
optimistic mutation. It only defines the post-Apply state reconciliation.

## 21. Historical Data Migration

### 21.1 Purpose

The migration unifies legacy persistence identities before management controls
become available. It must handle, without data loss:

- java and #java as two rows under the old server rule;
- Java and JAVA display collisions;
- a document carrying both legacy rows;
- duplicate associations after row consolidation;
- orphan tag rows;
- foreign key and stable ID preservation;
- document version impact;
- retry and rollback.

### 21.2 Deterministic migration contract

At the product-contract level, migration must:

1. Read every tag row and calculate the Phase 2 canonical identity.
2. Partition rows by canonical identity.
3. Choose the lowest existing tags.id as the survivor for each partition.
4. Set the survivor’s display to its canonical display form, preserving its
   casing and stripping one leading #.
5. Move every source association to the survivor.
6. Collapse any repeated (document, survivor) association to one row.
7. Delete non-survivor tag rows only after their associations are accounted for.
8. Update affected document versions once, exactly as specified in §18.
9. Verify foreign-key integrity, uniqueness, association preservation, and
   deterministic rerun behavior before marking the migration healthy.

For example:

~~~text
tags:  1 = java, 2 = #java
links: A -> 1, B -> 2, C -> 1 and 2

after migration:
one survivor row for identity java
A, B, and C each have one association to that survivor
no association is silently lost
~~~

### 21.3 Display winner

The oldest stable tag row wins. If 1 = Java and 2 = JAVA, the resulting
display is Java; if 1 = #java, its canonical display is java. The rule is
stable, explainable, and independent of client ordering.

### 21.4 No silent data loss

Migration must preserve the set of logical document/tag memberships. It may
remove duplicate physical rows and obsolete duplicate tag IDs, but it must not
remove a document’s logical tag. A migration report must include rows scanned,
logical groups, survivor rows, associations moved, duplicate associations
collapsed, tag rows deleted, and documents versioned.

### 21.5 Rollback and backup

- The data migration runs as one SQLite transaction per migration activation;
  a failure rolls back the database mutation.
- Operators must take a consistent backup of data/nuvyn.db before upgrade
  and retain it until post-migration verification succeeds.
- A backup is the recovery path for operator error; the transaction is the
  crash/failure path during the migration.
- No migration may advance the schema/health marker before all verification
  checks pass.
- Rerunning a completed migration is safe and idempotent.
- A failed migration keeps Tag Management unavailable and leaves existing Tag
  Query reads as available as the current server permits.

### 21.6 Health check and feature gate

Tag Management opens only when all live documents satisfy the database-owned
metadata precondition and the tag identity health check passes:

- no active tag identity migration;
- no failed live-document metadata import;
- each live document has a database metadata row or is explicitly handled by
  the migration result;
- no duplicate canonical tag identities;
- no duplicate document-tag associations;
- foreign keys and uniqueness checks pass.

Historical metadata_migrations tombstones marked orphaned do not by
themselves block Tag Management; they are recovery provenance for paths no
longer live. Existing Tag Query should remain as readable as possible in a
degraded state. Management controls fail closed.

### 21.7 Frontmatter boundary

The existing metadata import may read legacy tags from Frontmatter into
SQLite. Phase 2 does not add a new Frontmatter write-back step. If code review
finds that live management currently has another persistent tag source, that is
an architecture blocker, not an invitation to merge stores silently.

## 22. Error Model

The API exposes stable machine-readable error codes with human-readable
messages. It must not leak SQL statements or stack traces.

| Code | Meaning | Typical response |
|---|---|---:|
| INVALID_TAG_NAME | Empty, oversized, control-containing, or otherwise invalid input | 400 |
| INVALID_OPERATION | Missing or malformed operation fields | 400 |
| TAG_NOT_FOUND | Stable source/destination ID does not exist | 404 |
| SOURCE_DESTINATION_SAME | Merge target is the source row | 409 |
| DESTINATION_EXISTS | Rename destination identity belongs to another row; use Merge | 409 |
| TAG_IDENTITY_CONFLICT | Database violates the healthy identity invariant | 409/503 |
| PREVIEW_REQUIRED | Apply lacks a valid Preview fingerprint | 409 |
| PREVIEW_STALE | Recomputed locked plan differs from Preview | 409 |
| TAG_MANAGEMENT_UNAVAILABLE | Migration/health gate has not passed | 503 |
| AUTH_REQUIRED | Existing authentication boundary rejected the request | Existing auth status |
| TRANSACTION_FAILED | Apply failed and rolled back | 500 |

An Apply failure never returns a partial-success result.

## 23. API Product Contract

The exact route wiring is implementation-owned, but the product surface must
provide the following capabilities behind the existing authenticated boundary.

### 23.1 Tag read resource

The management list/read model exposes:

~~~text
id: number                 stable tags.id
normalizedName: string     canonical identity
displayName: string        global UI name
documentCount: number      distinct affected documents
~~~

Existing PostSummary.tags: string[] remains unchanged for compatibility.

### 23.2 Preview request

Conceptual request shapes:

~~~text
Rename: { operation: "rename", sourceTagId, destinationName }
Merge:  { operation: "merge",  sourceTagId, destinationTagId }
Remove: { operation: "remove", sourceTagId }
~~~

The server normalizes and validates destinationName; the client never sends
an authoritative normalized identity as a substitute for server validation.

### 23.3 Preview response

The response contains the fields in §15.3, including allowedToApply and a
deterministic planFingerprint. It may provide a bounded sample and a
continuation token for read-only expansion. The complete affected set remains
server-owned.

### 23.4 Apply request and response

Apply carries the original operation request plus the Preview fingerprint. The
server recomputes the plan under the immediate transaction. The successful
response contains the operation/result identifier, the same counts and
identity information, the applied fingerprint, the commit timestamp, and a
signal that the client should perform its one authoritative refresh.

### 23.5 API identity choice

Stable numeric tag IDs identify existing source and destination rows. Raw text
is used only for a new Rename destination and is normalized by the server.
Normalized strings remain part of the response and fingerprint for clarity,
but a client must not use a display string as a substitute for a stable row ID.

## 24. Performance and Scale

The product must work for a vault with approximately 10,000 documents, 50,000
document-tag associations, and thousands of tags.

Required properties:

- Preview does not perform a client-side N+1 walk.
- Apply does not open one transaction per document.
- Planner and Apply operate on complete sets, not UI pages.
- The Preview UI renders a bounded sample, not every affected document.
- SQLite indexes and set-oriented access are used where the implementation
  requires them; this PRD does not prescribe SQL.
- The operation result provides counts even when the sample is truncated.

The repository has no established Tag Management benchmark suite or accepted
latency SLA. Implementation must measure representative baselines and record
them before proposing performance claims. This PRD does not invent a 300 ms
or 1 s production guarantee.

## 25. Accessibility

The management UI must follow current Nuvyn accessibility patterns and define:

- keyboard access to each management action;
- an accessible dialog/drawer name and description;
- focus placement when opening;
- focus containment using the existing project abstraction where applicable;
- Escape to close a non-submitting dialog;
- focus return to the triggering tag/action after close;
- distinct preview, loading, allowed, stale, and error states;
- aria-live="polite" or the project equivalent for Preview result updates;
- explicit announcement of affected count and destructive warnings;
- disabled Apply while Preview is missing, stale, loading, or disallowed;
- error messages associated with the relevant input;
- no color-only indication of destructive or selected state.

Phase 2 must not replace the application-wide dialog system.

## 26. Security and Authorization

### 26.1 Authorization

Nuvyn currently uses a single-owner authenticated instance. Tag Management
continues through the existing auth and CSRF boundary. The MVP does not add
roles, permissions, or collaboration ACLs.

### 26.2 Input and database safety

The implementation must:

- validate stable IDs as IDs, not interpolate them into SQL;
- use bound database parameters;
- enforce current tag count and length limits on every write path;
- reject null bytes and unexpected control characters;
- safely handle CJK, slash, dash, underscore, and non-ASCII casing;
- avoid path or Markdown interpretation of tag names;
- cap preview samples/pages without capping the atomic Apply set;
- prevent arbitrary multi-source batch abuse by keeping MVP cardinality small;
- include enough operation/result detail for application logs without logging
  sensitive document bodies.

## 27. Backward Compatibility

Phase 2 preserves:

- FileTree plain text search;
- #tag inclusion;
- -#tag exclusion;
- TagPanel filtering;
- TagPanel selected-tag results;
- current chip/grid visual behavior;
- existing note metadata reads;
- PostSummary.tags shape;
- current API consumers;
- Command Palette’s independent search behavior;
- Markdown body and frontmatter bytes during tag-only operations;
- vault Git History behavior.

The client TagIndex remains a query/projection structure. It does not become a
second persistence authority or a mutation planner.

If migration health is incomplete, management controls are unavailable rather
than exposing a mixed legacy/new mutation mode. Read-only query behavior should
remain available where possible.

## 28. Undo Decision

**Decision: Deferred to Phase 2.1.**

MVP does not claim that Undo means “Rename back,” “reverse Merge,” or “add the
removed tag back.” Safe Undo would require an exact operation snapshot,
affected document IDs, before/after associations, before/after versions,
operation timestamp/type, and conflict validation in a new immediate
transaction. It would also need a durable retention model.

Phase 2 MVP therefore returns an audit-friendly server result and application
logs only. It does not build persistent event sourcing solely to prepare for
Undo.

## 29. Testing Strategy

No tests are added in this PRD-only phase. Future implementation must include
at least the following coverage.

### 29.1 Normalization matrix

- null/undefined/blank;
- trim and # removal;
- Java, JAVA, java, #java, # java;
- ##java remains #java;
- CJK;
- slash, dash, underscore;
- internal whitespace;
- no NFKC (ﬁre remains distinct from fire);
- invalid controls and length boundaries;
- client/server conformance.

### 29.2 Rename matrix

- normal rename;
- case-only display rename;
- destination exists;
- source missing;
- invalid/empty destination;
- leading # and whitespace;
- Chinese and punctuation names;
- one document and 100+ documents;
- Preview stale;
- destination created after Preview;
- transaction rollback;
- stable tag ID and document associations preserved.

### 29.3 Merge matrix

- source -> existing target;
- overlapping and non-overlapping documents;
- a document already carrying both tags;
- source missing;
- destination missing;
- same source/destination;
- destination display preserved;
- source row removed;
- versions updated exactly once;
- rollback;
- stale Preview;
- one-source cardinality enforcement.

### 29.4 Remove matrix

- one document;
- many documents;
- source missing;
- orphan tag;
- other tags untouched;
- documents untouched except metadata version;
- Markdown untouched;
- Git/fileChanges untouched;
- stale Preview;
- rollback.

### 29.5 Historical migration matrix

- java and #java;
- Java and JAVA;
- one document carrying both collision rows;
- different documents carrying different collision rows;
- stable tag IDs and foreign keys;
- duplicate junction associations;
- deterministic oldest-row display winner;
- document version impact;
- transaction failure rollback;
- rerun idempotence;
- no logical association loss;
- orphan rows and migration health gating.

### 29.6 Concurrency matrix

- Preview -> unrelated metadata change -> Apply remains valid when the relevant
  graph is unchanged;
- Preview -> affected document metadata change -> PREVIEW_STALE;
- Preview Rename -> destination created -> rejected;
- Preview Merge -> target removed -> rejected;
- Preview Remove -> source association changed -> rejected;
- AI metadata tag write between Preview and Apply;
- two concurrent Apply requests yield one valid serial success and one stale
  rejection;
- rollback leaves every row and version unchanged.

### 29.7 Existing metadata writer regression matrix

- title-only REST PATCH reads tags=[Java] -> Rename Java to Backend commits ->
  PATCH commits title -> title changes and Backend remains authoritative;
- summary-only AI `update_metadata` reads tags=[javascript] -> Merge
  javascript to js commits -> AI update commits summary -> js remains
  authoritative;
- explicit REST tag mutation based on stale version -> Tag Apply commits ->
  stale mutation is rejected fail-closed;
- explicit AI tag mutation based on stale version -> Tag Apply commits ->
  stale mutation is rejected fail-closed;
- Remove commits -> stale title-only request completes -> removed source
  association is not recreated;
- stale whole-tag replacement cannot resurrect a renamed/removed source,
  remove a newly applied destination, or undo a Merge.

### 29.8 Preview consistency matrix

- a writer changes an association while Preview planning is in progress ->
  Preview never returns a mixed pre/post snapshot;
- Preview count, sample, affected set, document versions, and fingerprint are
  all derived from one logical SQLite snapshot;
- Preview page 1 generated -> relevant association changes -> page 2 requested
  with the old fingerprint -> `PREVIEW_STALE`;
- Preview page 1 generated -> unrelated document changes -> page 2 may remain
  valid when the relevant graph is unchanged.

### 29.9 Integration and UI matrix

- API auth boundary;
- Preview response shape and bounded sample;
- Apply result and one-refresh behavior;
- Apply result carries stable source/destination/survivor identity needed for
  reconciliation;
- TagPanel action state;
- selected source Rename -> renamed tag remains selected and results remain;
- selected source Display Rename -> same stable tag remains selected with the
  updated display label;
- selected source Merge -> destination becomes selected;
- selected destination Merge -> destination selection remains;
- selected source Remove -> `selectedTag` clears and results close;
- unrelated operation -> current selection is preserved;
- reconciliation uses stable operation identity/result, not display-string
  guessing;
- stale/error/loading accessibility announcements;
- keyboard and focus behavior;
- large impact rendering;
- Phase 1 FileTree/TagPanel regression;
- browser E2E for Rename, Merge, Remove, Preview, stale Apply, and refresh.

### 29.8 Security matrix

- SQL injection-shaped names;
- invalid IDs;
- oversized names;
- null bytes;
- Unicode controls;
- too many tags;
- mass-operation inputs;
- unauthorized and CSRF-protected requests;
- AI path cannot bypass the domain invariants.

## 30. Rollout and Migration

### 30.1 Product rollout gates

1. Review and approve this PRD.
2. Implement and verify normalization/migration health foundation.
3. Keep management controls hidden or unavailable until health passes.
4. Enable Preview before enabling Apply.
5. Enable Rename, Merge, and Remove only with all-or-nothing Apply.
6. Monitor operation results, stale conflicts, rollback failures, and refresh
   failures before broadening scope.

The sequence above is a product rollout shape, not an implementation plan.

### 30.2 Operator safety

Before production migration, operators should:

- take a consistent backup of the SQLite database;
- ensure the vault backup/recovery policy is current;
- run the health report and retain its output;
- verify the live-document count and tag association count;
- verify no failed live metadata imports remain;
- verify foreign keys, unique identities, and association preservation;
- retain the pre-migration backup until post-migration review is complete.

### 30.3 Failure behavior

- Schema/data migration failure rolls back and leaves management gated off.
- A failed or stale Apply changes nothing.
- A process crash before SQLite commit rolls back through SQLite.
- A committed Apply is not undone because a later client refresh failed.
- No mixed “half legacy / half new” management mode is exposed.

## 31. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Existing server/client normalization drift | Duplicate logical identities or wrong destination conflict | One contract, migration health gate, conformance tests |
| updated_at is both content and metadata timestamp | Tag-only changes may change displayed update date | Reuse the field deliberately, version affected docs once, document the impact |
| Large SQLite transaction holds a write lock | Other metadata writers wait | Set-based planner/apply, bounded UI sample, measure baseline |
| Timestamp-only staleness is weak at same-millisecond writes | Missed conflict | Fingerprint full relevant metadata/association state, not timestamp alone |
| Stale whole-metadata writer replays an old tag set after Tag Management commits | Renamed/removed source tag is resurrected, Merge membership is undone, or the authoritative destination is overwritten | Field-scoped metadata writes, explicit tag-write stale validation, shared normalization/version invariants, and REST/AI regression coverage |
| Preview combines rows from different SQLite states | Counts, samples, versions, or fingerprints describe a state that never existed | Build every Preview input from one consistent read snapshot; bind expansion to the originating fingerprint |
| AI or legacy API bypasses the domain | Preview may become stale unexpectedly or normalization may diverge | Route all persistent tag writes through shared server contract |
| Frontmatter fallback remains during migration | Two apparent sources of tags | Fail closed for management until live DB ownership is healthy |
| No durable operation log | Limited post-hoc Undo/audit | Return audit-friendly result and application logs; defer Undo explicitly |
| Client cache refresh runs twice or optimistically | Stale or flickering UI | One authoritative refresh and no cross-document optimistic patch |
| Successful management leaves TagPanel selected on a deleted or renamed label | Stale results, an empty source selection, or misleading UI after commit | Return stable operation identity/result mappings and reconcile selection after the authoritative refresh |
| Historical collision migration deletes an association | Data loss | Survivor mapping, dedupe checks, counts, rollback, idempotence tests |
| User interprets Rename as Merge | Unexpected global reassignment | Destination-exists conflict and explicit “Use Merge instead” guidance |

## 32. Architecture Decision Records

Each ADR uses the required Context, Options, Decision, and Consequences format.

### ADR-1: Tag identity contract

**Context:** Client query identity removes one leading #; the current server
write path does not.

**Options:** Keep two identities; change client behavior; establish one
contract and migrate persistence.

**Decision:** Use the Phase 1 trim -> one leading # removal -> trim -> lowercase
contract, with no NFKC, across client, server, migration, planner, and tests.

**Consequences:** java and #java become one identity after migration;
normalization is a Phase 2 prerequisite; existing client query semantics remain
unchanged.

### ADR-2: Rename destination-exists semantics

**Context:** Rename to an existing identity could silently reassign many
documents.

**Options:** Implicit Merge; reject; create an alias.

**Decision:** Reject with DESTINATION_EXISTS and guide the user to Merge.

**Consequences:** User intent and risk level remain explicit; Rename cannot
perform an unexpected global merge.

### ADR-3: Merge destination display ownership

**Context:** Source and destination may have different casing/display names.

**Options:** Source wins; newest wins; destination wins.

**Decision:** Destination row and display name win; destination stable ID is
preserved.

**Consequences:** Merge is predictable and does not unexpectedly rebrand the
destination tag.

### ADR-4: Remove destructive UX

**Context:** Remove deletes every association and the global tag record.

**Options:** Immediate one-click delete; typed DELETE; mandatory Preview plus
destructive confirmation.

**Decision:** Preview is mandatory, Apply is visibly destructive, and no literal
DELETE typing is required by this feature.

**Consequences:** The user sees impact without unnecessary ceremony and cannot
accidentally execute a one-click global removal.

### ADR-5: Preview/Apply shared planner

**Context:** Client-derived Preview and server-derived Apply can disagree.

**Options:** Client planner; separate Preview/Apply rules; one server planner
semantic executed read-only and again under lock.

**Decision:** Use one shared planner semantic; Preview reads, Apply recomputes.

**Consequences:** Counts, affected sets, dedupe decisions, and validation have
one source of truth.

### ADR-6: Concurrency and stale Preview

**Context:** Other tabs, AI, and API requests may change metadata after Preview.

**Options:** Trust Preview; apply a new plan silently; recompute and reject
stale state.

**Decision:** Recompute under BEGIN IMMEDIATE, compare a deterministic
relevant-graph fingerprint, and return PREVIEW_STALE on mismatch.

**Consequences:** The system fails closed and asks for explicit re-preview;
unrelated changes need not invalidate a plan when the relevant graph is intact.

### ADR-7: Stable tag ID versus normalized string API identity

**Context:** tags.id is stable while display and normalized strings can change.

**Options:** Use display strings; use normalized strings alone; use stable IDs
for existing rows and raw text only for a new Rename destination.

**Decision:** Use stable tag IDs in operation requests and include normalized
identities in plans/fingerprints.

**Consequences:** Stale or casing-shifted UI cannot silently target a different
row; APIs expose a small new read model without changing post tag arrays.

### ADR-8: Server/client normalization unification

**Context:** Client and server currently have different rules.

**Options:** Continue duplicate rules; make the server authoritative but leave
client drift; define one contract with shared/conformance coverage.

**Decision:** One authoritative contract governs both; the server remains the
mutation authority and client behavior must conform.

**Consequences:** Migration and tests become mandatory; no directory/module
sharing decision is made in this PRD.

### ADR-9: Historical dirty-data migration

**Context:** Legacy databases can contain multiple rows for one logical tag.

**Options:** Refuse all dirty databases; silently pick a row; transactionally
consolidate with deterministic survivor and association preservation.

**Decision:** Automatically perform a safe, idempotent migration before opening
management; lowest tag ID survives and all logical associations are preserved.

**Consequences:** Existing users do not remain in a permanent mixed mode; the
migration needs backup, health reporting, and rollback tests.

### ADR-10: Undo MVP versus Phase 2.1

**Context:** Reverse operations do not restore exact prior state after other
metadata changes.

**Options:** Claim inverse-operation Undo; build exact snapshots/logging now;
defer.

**Decision:** Defer Undo to Phase 2.1 and do not claim undoability in MVP.

**Consequences:** MVP stays small and honest; a future Undo design must define
exact snapshots and conflict validation first.

### ADR-11: Optimistic versus authoritative refresh

**Context:** A global operation can affect many client projections.

**Options:** Optimistically patch every post; trust the Apply response only;
clear and perform one canonical refresh.

**Decision:** No optimistic cross-document mutation; one authoritative refresh
after a committed Apply.

**Consequences:** UI state follows SQLite and avoids projection drift; a refresh
failure is reported as synchronization pending, not treated as rollback.

### ADR-12: SQLite-only mutation boundary

**Context:** SQLite cannot atomically commit alongside Markdown, Git, or
IndexedDB.

**Options:** Coordinate several stores; write tags to Frontmatter; keep one
authoritative store.

**Decision:** Phase 2 Tag Apply mutates SQLite only.

**Consequences:** BEGIN IMMEDIATE can provide real all-or-nothing behavior;
Markdown/Git history remain unchanged and Frontmatter write-back is out of
scope.

### ADR-13: Existing metadata writer coordination

**Context:** The existing metadata save path can replace `document_tags` even
when the user intends only a title or summary change. A request can therefore
read tags before Tag Management Apply and replay them after Apply commits.

**Options:** Allow last-writer-wins; serialize every metadata request globally;
use field-scoped writes with stale validation for explicit tag writes.

**Decision:** Omitted metadata fields must not be rewritten as side effects.
Title-only and summary-only writes must preserve the authoritative
`document_tags` state. An explicitly supplied tag set participates in current
version/state validation and stale writes fail closed. REST metadata PATCH,
AI `update_metadata`, legacy/internal saves, and future writers follow the same
contract.

**Consequences:** Tag Management Apply cannot be undone by a stale metadata or
AI writer; the exact CAS/re-read/shared-primitive implementation remains for a
later Implementation Plan.

### ADR-14: Preview snapshot consistency

**Context:** A Preview assembled from separate reads can combine source state,
associations, document versions, counts, samples, and fingerprints from
different SQLite states, even if Apply later rejects a stale fingerprint.

**Options:** Permit mixed reads; hold a long write lock; build the complete
Preview from one consistent read snapshot and bind continuation to its
fingerprint.

**Decision:** Every Preview and every expanded/paginated page describes the
same logical relevant SQLite snapshot. Preview remains read-only and does not
require `BEGIN IMMEDIATE`; relevant changes make the originating fingerprint
stale, while unrelated changes need not invalidate it.

**Consequences:** Preview cannot describe a state that never existed, and a
later page cannot silently switch to a newer relevant database state. The
snapshot/cache mechanism is implementation-owned.

### ADR-15: Post-Apply selected-tag reconciliation

**Context:** A single authoritative refresh does not automatically repair the
current string-based TagPanel selection after Rename, Display Rename, Merge, or
Remove.

**Options:** Leave the old display string selected; infer from refreshed labels;
return stable operation identity/result mappings and reconcile after refresh.

**Decision:** Reconcile using stable tag IDs and the committed operation result:
Rename follows the renamed row, Display Rename keeps the same row and updates
its label, Merge follows the destination, Remove clears the selection, and an
unrelated operation preserves it. No optimistic pre-commit selection change
is allowed.

**Consequences:** TagPanel results remain truthful after a committed operation
without requiring a Phase 1 state-architecture rewrite.

## 33. Open Product Questions

None are required to define the Phase 2 MVP contract. The decisions above are
the approved source of truth for implementation planning. A future question
about separating content and metadata timestamps or adding durable operation
history belongs in a separately approved PRD/ADR, not in implementation by
assumption.

## 34. Acceptance Criteria

- [ ] One authoritative normalized tag identity is defined.
- [ ] Client and server normalization are aligned.
- [ ] Historical duplicate identities are handled safely and deterministically.
- [ ] Rename semantics are unambiguous.
- [ ] Merge semantics are unambiguous.
- [ ] Remove semantics are unambiguous.
- [ ] Preview is mandatory.
- [ ] Preview is server-authoritative.
- [ ] Preview and Apply use the same planner semantics.
- [ ] Every Preview is internally consistent and its counts, sample, affected
      set, versions, warnings, and fingerprint come from one logical SQLite
      snapshot.
- [ ] Expanded or paginated Preview results are bound to the originating
      Preview fingerprint; relevant changes return PREVIEW_STALE, while
      unrelated changes need not invalidate the plan.
- [ ] Apply uses one BEGIN IMMEDIATE transaction.
- [ ] Apply has no partial-success outcome.
- [ ] Stale Preview is rejected fail-closed.
- [ ] Affected document metadata versions are updated exactly once.
- [ ] Destination collisions are deterministic.
- [ ] Duplicate associations are deduplicated.
- [ ] Display-name rules are deterministic.
- [ ] The client performs one authoritative refresh after success.
- [ ] Title-only and summary-only metadata writes do not rewrite
      `document_tags` as side effects.
- [ ] A stale metadata writer cannot replay pre-Apply tags after Rename,
      Merge, or Remove.
- [ ] Explicit stale tag mutations are rejected fail-closed.
- [ ] REST metadata PATCH and AI `update_metadata` obey the same field/version
      and tag invariants.
- [ ] Rename, Display Rename, Merge, Remove, and unrelated operations have
      defined stable-ID selectedTag reconciliation.
- [ ] No Markdown changes occur for tag-only operations.
- [ ] No fake fileChanges are emitted.
- [ ] No Git mutation occurs for tag-only operations.
- [ ] Existing Tag query behavior remains unchanged.
- [ ] Accessibility behavior is defined.
- [ ] Migration backup, rollback, failure, and rerun behavior are defined.
- [ ] Undo scope is explicitly Deferred to Phase 2.1.
- [ ] AI and existing metadata writers cannot bypass the identity/version
      invariants.
- [ ] Management controls fail closed until migration health passes.

## 35. Phase Breakdown

The following is a product-level decomposition for later planning. No phase is
being executed by this PRD.

| Phase | Product outcome |
|---|---|
| T2-0 | One normalization contract, historical health check, migration foundation, and feature gate |
| T2-1 | Shared operation planner and server Preview for Rename/Merge/Remove |
| T2-2 | Atomic Apply domain/API with version updates, fingerprint revalidation, and result contract |
| T2-3 | Rename UI and accessibility flow |
| T2-4 | Merge UI and overlap/dedupe explanation |
| T2-5 | Remove UI and destructive safety flow |
| T2-6 | Concurrency, regression, scale, security, and browser E2E hardening |
| T2-7 | Phase 2 closure evidence and operational review |
| T2.1 | Separate Undo design and implementation, only if approved |

## 36. Definition of Done for this PRD

This PRD is complete when:

- the current repository baseline is recorded;
- the current schema and transaction/version model are documented;
- the freeze and Phase 1 historical chain are understood;
- Phase 1 invariants are explicitly protected;
- MVP scope and non-goals are clear;
- Rename, Merge, Remove, Preview, and Apply contracts are defined;
- atomicity and stale-preview behavior are defined;
- normalization and historical migration are defined;
- metadata version semantics and refresh behavior are defined;
- existing metadata/AI writer coordination and stale-write behavior are
  defined;
- Preview snapshot and continuation consistency are defined;
- post-Apply selected-tag reconciliation is defined;
- UI, accessibility, API shape, security, and authorization boundaries are
  defined;
- error taxonomy, performance expectations, risks, and rollout are documented;
- all required ADRs are complete;
- architecture blockers are identified;
- open questions are limited to genuine future product decisions;
- future tests are specified without adding tests in this task;
- no implementation plan has been created;
- no production code, schema, migration, dependency, or test file has been
  changed.

**PRD review is complete and document status is Approved for Implementation.**
