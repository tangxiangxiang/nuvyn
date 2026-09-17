# Nuvyn Tags Management Phase 2.1 — Undo PRD

**Status:** Approved for Implementation
**Date:** 2026-08-16
**Product area:** Tags Management Phase 2.1 — Undo
**Research baseline:** 851624ba39aca5725b7b527a782ac1fd163583e4
**Production implementation baseline:** 99f4d73154349f8ebc99cb609f1a88b07937fb26
**Owner:** Nuvyn product owner / architecture review complete

This document is the approved product and architecture authority for future
Phase 2.1 implementation planning. It does not create an implementation plan,
a schema migration, an API endpoint, or production behavior.

## 1. Document Information

| Field | Value |
| --- | --- |
| Document | Nuvyn Tags Management Phase 2.1 — Undo PRD |
| Status | Approved for Implementation |
| Date | 2026-08-16 |
| Research HEAD | 851624ba39aca5725b7b527a782ac1fd163583e4 |
| Phase 2 production baseline | 99f4d73154349f8ebc99cb609f1a88b07937fb26 |
| Pre-Phase-2 approved PRD | docs/design/tags-management-prd.md |
| Pre-Phase-2 approved Implementation Plan | docs/design/tags-management-implementation-plan.md |
| Phase 2 closure | docs/archive/closures/tags-management-phase-2-closure.md |
| Backup authority | docs/deployment/backup-and-restore.md |

The Phase 2 closure was finalized separately. This approved PRD records the
distinct Phase 2.1 Undo product contract and does not reopen or redesign the
completed Phase 2 product.

## 2. Status / Authority

The authority order for this approved PRD is:

~~~
Approved Phase 2 PRD
>
Approved Phase 2 Implementation Plan
>
Completed Phase 2 implementation and closure evidence
>
Approved Phase 2.1 Undo PRD
>
future reviewed Phase 2.1 Implementation Plan
>
future implementation
~~~

The Phase 2 documents remain authoritative for the existing Rename, Display
Rename, Merge, Remove, Preview, Apply, identity, writer-safety, health,
selection, file-boundary, and compatibility contracts. This approved PRD
defines additional Phase 2.1 behavior only.

The required workflow is:

~~~
Phase 2.1 PRD Draft
→ PRD Review
→ PRD Approval
→ Phase 2.1 Implementation Plan
→ Plan Review
→ Implementation
~~~

This PRD is approved for implementation planning. No implementation plan is
created by this task, and no implementation has started.

### Final PRD Review Record

Final PRD Review: PASS
Review date: 2026-08-16

Defect status:

- P0: 0
- P1: 0
- P2: 0
- Architecture / PRD Conflict: None

The Phase 2.1 Undo PRD is approved as the product authority for the future
Phase 2.1 Implementation Plan. The separate Implementation Plan does not yet
exist and must be created and reviewed after this approval.

Supporting evidence: GitHub Actions CI #340, run `31931010498`, completed with
success for the preceding documentation-only PRD repair commit
`59d99687a675663f70448435f89c80d8ad3b253e`. This CI validates the current
documentation baseline against the unchanged Phase 2 repository; it does not
validate a future Undo implementation.

## 3. Background

Phase 2 completed a safe server-authoritative system for global tag
management. It provides Rename, Display Rename, Merge, and Remove with
mandatory Preview, fingerprint-bound Apply, one atomic SQLite transaction,
strict document-version updates, authoritative synchronization, and
fail-closed health and stale handling.

Phase 2 deliberately did not add a durable reversible operation record. The
current result is audit-friendly, but it is returned to the client and written
to application logs only. A user cannot safely reconstruct a Merge or Remove
from a display name after a refresh, restart, later edit, or identity conflict.

Undo is therefore a separate product decision. It must extend the Phase 2
safety model rather than turning SQLite snapshots, Git, Markdown, or the
editor history into an implicit undo system.

## 4. Phase 2 Baseline

The completed baseline has these user-visible operations:

- Rename a source tag to a new identity while preserving its stable ID.
- Display Rename a tag while preserving identity and associations.
- Merge one source tag into one existing destination tag, preserving the
  destination ID and deduplicating overlap.
- Remove one source tag and its associations while preserving documents and
  Markdown.

The baseline safety pipeline is:

~~~
server validation
→ server Preview from one SQLite read snapshot
→ deterministic relevant-graph fingerprint
→ explicit user confirmation
→ document locks
→ BEGIN IMMEDIATE
→ planner recomputation and fingerprint validation
→ complete atomic mutation
→ one authoritative client synchronization cycle
~~~

Phase 2 also provides stable tag IDs, monotonic documents.updated_at values,
field-scoped metadata writers, identity migration and health gating, stable-ID
selection reconciliation, a local selection epoch, committed-response
recovery, and sync-only retry after refresh failure.
### Current Architecture Verification — CURRENT FACT

The following facts were verified against the current repository at research
HEAD 851624ba. They describe shipped Phase 2 behavior, not the Undo proposal.

- The server operation union in server/tagManagement.ts is rename, merge, or
  remove. Display Rename is a rename plan with displayOnly=true.
- A successful Apply result contains operationId, resultId, kind, the submitted
  normalized operation, source/destination/survivor IDs and tag rows, source
  deletion state, affected/association/duplicate/version counts, commit
  timestamp, and appliedFingerprint. operationId is generated with randomUUID()
  before the mutation transaction and resultId is currently the same value.
- No current operation result is durable in SQLite. Phase 2 keeps the result in
  the HTTP response and emits a bounded [tag-management-apply] log event. The
  log is not an idempotency key, operation history, or Undo authority.
- The SQLite migration runner applies numbered SQL files through 0006 and
  records schema_version. The relevant current tables are documents, tags,
  document_tags, settings, metadata_migrations, and authentication/history
  tables. tags.id is a stable integer row identity; tags.normalized_name is
  unique; document_tags has foreign keys and a composite primary key.
- The current database connection enables foreign_keys and WAL. settings is
  used for the tag-identity-v1 migration marker, not for a durable operation
  record.
- The current Preview fingerprint is a deterministic SHA-256 over the
  identity-contract version, normalized operation, source/destination
  resolution, complete affected document tuples, complete tag rows on those
  documents, derived counts, conflicts, and warnings. It includes document
  path/title/summary/created_at/updated_at and excludes unrelated documents
  and Markdown bodies.
- Preview uses a deferred read transaction. Apply first performs a discovery
  read, acquires sorted document path locks, then recomputes inside one
  BEGIN IMMEDIATE transaction before any mutation. The same planner semantic
  is used for Preview and Apply.
- Current affected document versions use the monotonic metadata helper and
  each successful Phase 2 Apply versions an affected document once. The
  current implementation never restores historical updated_at values.
- After a committed Apply, VaultView performs one Promise.all synchronization
  cycle for canonical posts/tree refresh and the managed-tag list. A refresh
  failure enters the dialog sync-pending state; Retry calls synchronization
  only and never Apply.
- Stable-ID selection reconciliation uses the operation result and fresh
  managed tags. A local selection epoch preserves a user selection made while
  Apply is in flight. Committed protocol mismatch recovery uses the trusted
  submitted operation rather than contradictory response identity fields.
- Production startup acquires writer ownership, runs crash recovery, runs
  migrateVaultMetadata, then initializeTagIdentityAndHealth before serving.
  The Vite startup path follows the same order. A failed or unhealthy
  tag-identity/metadata precondition leaves Tag Management unavailable while
  ordinary reads remain as available as the current server permits.
- /api/tags and operation routes run behind the Hono authBoundary. Protected
  requests require the authenticated owner session; unsafe methods require
  the existing same-origin CSRF checks, body-bearing mutations require JSON
  content type, and protected responses receive Cache-Control: no-store.
- The current TagManagementDialog uses the existing useConfirm and
  ConfirmHost for explicit confirmation, focus trapping, Escape, and focus
  restoration. There is no Undo button, Undo endpoint, global Ctrl/Cmd+Z
  binding, or separate Undo state store.

### Phase 2.1 PROPOSAL boundary

The durable reversible record, Undo Preview/Apply routes, inverse planner,
record migration, and Undo UI described below do not exist in the current
implementation. They are proposed product requirements and require a reviewed
Implementation Plan after this PRD is approved.


## 5. Problem Statement

After a successful global tag operation, the product has no durable, safe way
to answer “what exactly did this operation change?” or to reverse only those
changes. A naive solution would restore an old database snapshot or a complete
per-document tag array. Both are unsafe:

- a full snapshot can delete tags added later;
- restoring old updated_at values breaks version semantics;
- restoring a database can overwrite unrelated metadata changes;
- restoring a complete tag array can undo a later unrelated tag addition;
- a Merge inverse cannot infer which destination associations existed before
  the Merge;
- a Remove inverse cannot recover a deleted stable tag identity from a display
  string alone;
- a client cannot be the authority for the inverse scope.

Phase 2.1 must make Undo an explicit, server-derived, conflict-checked
operation with enough durable delta information to reverse only the committed
Tag Management effects.

## 6. Product Goals

Phase 2.1 goals are:

1. Provide a safe Undo for the latest successfully committed Rename, Display
   Rename, Merge, or Remove.
2. Keep Undo available after page refresh and, preferably and by this proposal,
   after server restart.
3. Preserve later unrelated title, summary, tag, Markdown, and Git changes.
4. Restore deleted source stable IDs for Merge and Remove when the current
   state makes exact restoration safe.
5. Require a server-authoritative Undo Preview and explicit confirmation.
6. Preserve Phase 2 atomicity, stale handling, version monotonicity,
   synchronization, accessibility, i18n, auth, and protected-area contracts.
7. Keep the first release bounded to one user-facing Undo level, with no Redo
   or arbitrary history browser.
8. When Undo record health is enabled and healthy, prevent a supported ordinary
   Tag Management Apply from succeeding without its durable reversible record.

## 7. Non-Goals

Phase 2.1 does not include:

- Redo;
- Undo of an Undo as a user-facing Redo mechanism;
- an arbitrary multi-operation history browser;
- bulk historical rollback or global application time travel;
- SQLite snapshot rollback as a product feature;
- Git checkout, Git revert, or Git History entries for tag Undo;
- Markdown or Frontmatter rewriting;
- restoring old updated_at values;
- storing Markdown bodies;
- storing full title/summary snapshots unless later architecture research
  proves a narrowly scoped need;
- a general event-sourcing system;
- a global application revision counter;
- global Ctrl/Cmd+Z interception;
- changes to the editor's text Undo stack;
- a new ORM, generic state-management library, or generic feature-flag system;
- reverse identity migration;
- changes to Phase 1 Tag Query, TagPanel filtering, FileTree search, or
  PostSummary.tags shape.

## 8. Terminology

| Term | Meaning |
| --- | --- |
| Original operation | The committed Phase 2 Rename, Display Rename, Merge, or Remove that produced a reversible record. |
| Reversible record | Durable server-owned delta and identity information sufficient to validate and derive the inverse. |
| Undo Preview | A read-only server plan describing the inverse operation against current state. |
| Undo Apply | A new atomic forward mutation that commits the inverse delta. |
| Operation-owned delta | The exact associations, tag-row changes, or identity effects created or removed by the original operation. |
| Operation-owned association | An association effect that the original operation created, removed, or preserved as part of its reviewed delta. |
| Association provenance | Server-owned durable evidence, such as a generation, ownership, or equivalent bounded record, that proves an association is still the operation-owned effect under review. |
| Unrelated later change | A later change outside the operation-owned state needed to derive and validate the inverse. |
| Relevant conflict | A current change that makes the inverse ambiguous, unsafe, or impossible to apply exactly. |
| Record lifecycle | The durable lifecycle of a reversible record: latest user-facing, superseded, consumed, or permanently unavailable. |
| Current validation result | The current-state evaluation of a record: safe, stale, conflict, or temporarily unavailable. It is separate from record lifecycle. |
| User Undo window | The period during which the latest reversible record is exposed to the user. |
| Internal record retention | How long the server keeps metadata or delta data after the user-facing Undo is no longer available. |
| Stable tag ID | The numeric tags.id identity that must not be silently replaced by a display-string match. |

## 9. User Stories

- As an owner, after I rename a tag, I can preview and undo that rename without
  losing later document edits.
- As an owner, after I Display Rename a tag, I can restore its previous display
  without changing its stable identity.
- As an owner, after I merge tags, I can restore source-only and overlap
  memberships without assigning the source tag to destination-only documents.
- As an owner, after I remove a tag, I can restore the exact tag identity and
  associations when the required documents and identities still exist.
- As an owner, I can refresh the page or restart the server and still see the
  latest safe Undo state.
- As an owner, I receive a clear conflict instead of a partial or guessed Undo
  when another relevant change makes reversal unsafe.
- As an owner, I can continue using editor Undo independently of Tag
  Management Undo.

## 10. Supported Operations

Undo supports exactly these original operation kinds:

| Original operation | User-facing Undo label | Reversible? |
| --- | --- | --- |
| Normal Rename | Undo Rename | Yes, when current source row and original identity are safe |
| Display Rename | Undo Display Rename | Yes, when the same stable row still has the reviewed post-state |
| Merge | Undo Merge | Yes, when source identity, destination state, documents, and operation-owned associations are safe |
| Remove | Undo Remove | Yes, when the deleted source ID/identity can be restored and every required document exists |

Display Rename remains the Phase 2 Rename operation with displayOnly semantics;
it is not a separate fourth server operation kind.

An original operation is not reversible merely because its Apply response was
successful. It becomes user-undoable only when the server durably records the
minimum inverse delta in the same logical commit boundary as the original
mutation. The atomic durability and fail-closed health contract for new
ordinary Applies is defined in §12.

## 11. Single-Level Undo Product Model

### Decision

The proposed MVP accepts single-level durable Tag Management Undo. The latest
successfully committed ordinary Tag Management operation is the only
user-facing Undo target. This is a bounded product choice supported by the
current architecture: Phase 2 already has stable IDs, atomic SQLite
transactions, deterministic plans, and server-owned affected sets. No evidence
justifies a broader event-sourcing or arbitrary time-travel model.

The decision remains a proposal until this PRD is approved.

### Rules

- Only the latest successful ordinary Rename, Display Rename, Merge, or Remove
  is user-undoable.
- After Phase 2.1 is enabled and its durable-record health is healthy, an
  ordinary Apply is successful only when the tag mutation, association changes,
  monotonic document-version updates, reversible record, and latest-Undo target
  transition commit together.
- A later successful ordinary Tag Management operation supersedes the prior
  user Undo.
- A failed, stale, cancelled, or preview-only operation does not supersede an
  available Undo.
- If required reversible-record persistence or latest-target persistence fails,
  the entire ordinary Apply rolls back. If Undo-record migration or health is
  unavailable before a new supported mutation, that mutation fails closed;
  Tag Management reads and diagnostics may remain available under the existing
  health boundary.
- Undo itself is a new successful Tag Management mutation, but it consumes the
  prior user-facing Undo and does not create a user-facing Redo target.
- There is no Undo stack browser and no arbitrary operation selection.
- Undo availability is server-derived; the client never reconstructs it from a
  toast, local storage, or stale posts.
- This rule applies to new supported commits after Phase 2.1 is healthy. It
  does not make pre-Phase-2.1 operations retroactively undoable, make an old
  client expose Undo, or turn a superseded record or a temporary current-state
  conflict into a new mutation-health failure.

## 12. Durable Undo Availability

The proposed product behavior is:

- Undo survives a browser refresh because the reversible record is stored in
  SQLite, not component state.
- Undo survives a normal server restart because startup opens the same database
  and validates the current record against the current graph before advertising
  it.
- A record whose current validation fails after restart is shown as stale,
  conflict, or unavailable, never optimistically applied. A current conflict
  does not by itself consume the record; if it later clears and all other
  preconditions remain valid, a new Preview may make Undo available again.
- A database restore restores the Undo availability corresponding to that
  database generation. A backup taken before an operation has no record for
  that operation; a backup taken after it and before Undo may retain the Undo.
- If the record is absent, malformed, from an unsupported contract version, or
  inconsistent with the current graph, the UI fails closed.

The implementation plan may choose a compact read model and child delta rows,
but it must not use browser storage or logs as the authority.

### Ordinary Apply durability and fail-closed health

After Phase 2.1 is enabled and Undo-record migration/health is available, every
new supported ordinary Rename, Display Rename, Merge, or Remove Apply must
atomically commit all of the following in one SQLite transaction:

1. the tag-row mutation;
2. all document-association changes;
3. all required monotonic document-version updates;
4. the server-owned reversible operation record; and
5. the state identifying that operation as the latest user-facing Undo target.

Conceptually:

~~~
BEGIN IMMEDIATE
tag mutation
+ association mutation
+ document version updates
+ reversible operation record
+ latest Undo target transition
COMMIT
~~~

If any required reversible-record write or latest-target transition fails, the
entire ordinary Apply rolls back. The product must never report “Rename,
Merge, or Remove succeeded but Undo was lost” for a new supported operation
while Phase 2.1 Undo is healthy and enabled.

If the Phase 2.1 record migration or health precondition is unavailable before
an ordinary mutation, the server fails closed for new supported Tag Management
mutations rather than creating irreversible state. Read-only Tag Management
resources and diagnostics may remain available according to the existing
health boundary. Exact HTTP error names remain Implementation Plan scope.

This is not a retroactive requirement for successful Phase 2 operations from
before the feature was enabled, an old client that cannot request Undo, a
superseded record that is no longer user-facing, or a current dynamic conflict
that can be revalidated after the conflicting state changes.

## 13. Undo Is a New Forward Mutation

Undo is not a rollback primitive. It is a new forward mutation:

~~~
successful Tag operation
→ durable reversible record
→ current-state Undo Preview
→ current-state validation
→ explicit confirmation
→ Undo Apply
→ new atomic SQLite commit
~~~

Undo must not:

- restore a SQLite snapshot;
- check out or revert Git;
- rewrite Markdown or Frontmatter;
- restore old document timestamps or versions;
- overwrite unrelated user changes;
- treat a client-provided inverse snapshot as authority.

Every document changed by Undo receives a new strictly monotonic metadata
version. A document changed by the original operation and changed again by
Undo therefore has two forward version advances; the old version is never
reused.

## 14. Rename Undo Semantics

For:

~~~
Java(id=7) → Backend(id=7)
~~~

Undo proposes:

~~~
Backend(id=7) → Java(id=7)
~~~

The source stable ID remains 7 and existing associations remain attached to
that row. Undo changes the tag row back to the recorded original display and
normalized identity, then versions the documents currently carrying that tag
once because their database-owned tag display changed.

Later unrelated associations to tag ID 7 survive. A later title or summary
change survives. If another actor independently changed tag ID 7 away from the
reviewed post-Rename state, the Undo is a relevant conflict rather than an
automatic second rename.

The stable ID makes the display consequence global. For example:

~~~
10:00  Java(id=7) → Backend(id=7)
10:05  A user associates doc-X with Backend(id=7)
10:10  Undo Rename
~~~

The doc-X association survives because it is still attached to tag ID 7. The
global tag row becomes Java(id=7), so doc-X now observes Java, not Backend.
Undo does not preserve the old display only for doc-X; tag identity/display is
global per stable tag row. Documents whose visible/global tag metadata changes
receive the normal new monotonic metadata version under the accepted version
contract. This is not snapshot rollback.

If the original java identity is now owned by another incompatible stable tag
row, Undo fails safely. It does not merge rows, retarget associations, or
create a replacement ID.

The record stores the original and committed post-operation tag-row state and
the operation identity. It does not need a Markdown or title/summary snapshot.

## 15. Display Rename Undo Semantics

For:

~~~
Java(id=7) → JAVA(id=7)
~~~

Undo proposes:

~~~
JAVA(id=7) → Java(id=7)
~~~

The stable ID, normalized identity, and associations remain unchanged. Only
the global display name and the required current metadata versions change.

Undo is permitted only if tag ID 7 still has the reviewed post-Display-Rename
state. A later independent display or identity rename is a relevant conflict.
Unrelated document title, summary, Markdown, Git, and tag-association changes
survive.

## 16. Merge Undo Semantics

Merge Undo is delta-aware, not a whole-document snapshot restore. The durable
record must distinguish source-only membership, overlap membership, and
destination-only documents.

For:

~~~
Before:
  Java(id=7)
  Backend(id=9)
  doc-A → Java
  doc-B → Java + Backend
  doc-C → Backend

Merge Java(id=7) → Backend(id=9)

After:
  doc-A → Backend
  doc-B → Backend
  doc-C → Backend
  Java(id=7) is deleted
~~~

Undo must derive:

~~~
  restore Java(id=7)
  doc-A: remove the destination association created by Merge; add Java
  doc-B: add Java; retain Backend
  doc-C: leave Backend unchanged
~~~

The result is:

~~~
doc-A → Java
doc-B → Java + Backend
doc-C → Backend
~~~

The record therefore needs, at minimum, the original source tag row, the
destination post-state, the exact original source memberships, the source-only
destination associations created by Merge, and overlap information. It must
not restore doc-C → Java.

The destination tag ID and display must still match the reviewed post-Merge
state. Later unrelated associations on the destination survive. If an
operation-owned destination association was independently removed, a required
document was deleted, the destination was independently renamed/removed, the
source ID is occupied, or the original source identity is occupied by another
row, the entire Undo is a conflict and no partial restoration is committed.

Final row equality is not sufficient proof of operation ownership. For example:

~~~
Before: doc-A → Java(id=7)
10:00  Merge Java(id=7) → Backend(id=9)
10:05  A later user removes doc-A → Backend(id=9)
10:06  A later user independently adds doc-A → Backend(id=9)
10:10  Undo Merge
~~~

The final `(doc-A, Backend)` key looks identical to the Merge-created row, but
the 10:06 row is a later user change. Undo may remove it only if server-owned
provenance proves it is still the original operation-owned effect. Otherwise
Undo fails safely with a conflict; it never guesses from the composite key.

The source tag is restored with its original stable ID 7 when safe. An
explicitly occupied ID is never replaced with an auto-generated ID.

## 17. Remove Undo Semantics

For:

~~~
Before:
  Java(id=7)
  doc-A → Java
  doc-B → Java

Remove Java(id=7)

After:
  Java(id=7) is absent
  doc-A and doc-B remain
~~~

Undo restores:

~~~
  Java(id=7) with its recorded display and normalized identity
  doc-A → Java
  doc-B → Java
~~~

Undo does not restore documents, Markdown, Frontmatter, mtime, Git state, or
old versions.

The proposed safe default is all-or-nothing: if any originally affected
document no longer exists, if the exact stable ID is occupied, if the original
normalized identity is occupied by another incompatible row, or if current
state makes an operation-owned association ambiguous, the whole Undo fails as
a conflict. It does not restore the remaining documents partially.

The same provenance rule applies to Remove. Restoring an originally removed
source association is allowed only when the server can prove the inverse still
refers to that operation-owned effect and not to a later independently
recreated or otherwise changed association/state. Final `(document_id, tag_id)`
equality, or a matching final set alone, is never enough. If safe ownership
cannot be proven, the entire Remove Undo fails closed.

An orphan Remove is also reversible: its source tag row is restored with the
same ID and no document associations, provided the identity and ID are free.

Concrete identity-conflict example:

~~~
10:00  Remove Java(id=7)
10:05  Another operation creates a current incompatible java identity
10:10  Preview Undo Remove

Result: Undo is UNDO_CONFLICT; it does not merge, retarget, or allocate a new ID.
~~~

## 18. Stable-ID Restoration Contract

### Decision

Merge and Remove Undo must restore the original deleted source stable ID when
safe. This is required to keep the Phase 2 stable-identity contract
meaningful.

The inverse must fail closed if:

- the original numeric ID is occupied by any current tag row;
- the original normalized identity is owned by another incompatible row;
- the destination/source graph no longer satisfies the recorded inverse
  preconditions;
- a required document or operation-owned association cannot be validated.

The product does not silently create a new ID and label it as the old identity.
Any proposal to do that would be an explicit Architecture / PRD Conflict and
would require review before implementation.

Stable-ID restoration does not replace association provenance. Even when the
original numeric ID is available, the server must prove that every association
it removes or restores is still the operation-owned effect being reversed.

## 19. Unrelated Later Change Preservation

Undo changes only the operation-owned delta and the current tag-row state
needed for that inverse. It does not restore a whole database or a whole
document metadata snapshot.

The following later changes must survive when they do not overlap a relevant
inverse precondition:

- title changes;
- summary changes;
- unrelated tag additions/removals;
- unrelated document changes;
- Markdown body and Frontmatter changes;
- Git History changes;
- new associations on a surviving destination tag that are not part of the
  original source/destination delta.

For a later unrelated tag added to the same document, Undo may still proceed if
the operation-owned source/destination state is unchanged. Undo removes or
adds only the exact association rows named by its delta, leaving the unrelated
tag row intact.

For a later association to a renamed stable ID, the later association also
survives, but it observes the globally restored tag row. A document associated
with Backend(id=7) after `Java(id=7) → Backend(id=7)` will observe Java(id=7)
after Rename Undo. Undo never creates a per-document display exception.

The inverse may legitimately version a document again because its tag
associations or global tag display changed. Versioning is a new forward effect,
not restoration of an old timestamp.

Concrete unrelated-change example:

~~~
10:00  Merge Java → Backend
10:05  A user adds Python to doc-A
10:10  Undo Merge

Result: the Merge delta is reversed, while doc-A's Python association remains.
~~~

## 20. Relevant Conflict / Stale Semantics

Undo must distinguish disjoint later changes from relevant changes.

### Changes that do not necessarily block Undo

- title-only or summary-only edits to an affected document;
- Markdown body edits;
- Git commits or History changes;
- adding/removing an unrelated tag on an affected document;
- adding an association to a surviving destination document that is outside
  the original operation-owned delta.

These changes survive the inverse.

### Dynamic, non-consuming current conflicts

A relevant current-state conflict normally does not consume the latest
reversible record. For example:

~~~
10:00  Remove Java(id=7)
10:05  Another current tag temporarily occupies normalized identity `java`
10:10  Undo Preview → conflict
10:15  The conflicting tag is safely removed or renamed
10:20  Undo Preview again
~~~

If the original record is still latest, has not been consumed or superseded,
provenance remains valid, required documents still exist, and the current state
is safe, the second Preview may make Undo available again. `UNDO_CONFLICT` is
therefore normally a current validation result, not a permanent lifecycle
transition. The same non-consuming rule applies to a stale Preview: the user
must obtain a fresh Preview, but the record is not consumed merely because a
reviewed Preview became invalid.

### Changes that block or stale the current Preview

- a later successful Tag Management operation superseded the current record;
- the source or destination tag row changed away from its recorded post-state;
- the original identity is now occupied by another incompatible stable row;
- a deleted source ID is occupied;
- an operation-owned association was changed so the server cannot prove the
  inverse will affect only the original operation;
- a required affected document was deleted;
- a database restore or generation change makes the record and current graph
  unrelated;
- the durable record is malformed, unsupported, or missing required delta data.

The product-level current validation outcomes are:

| Outcome | Meaning |
| --- | --- |
| UNDO_AVAILABLE | The latest user-facing record exists and current validation says the inverse is safe to Preview/Apply. |
| UNDO_STALE | The reviewed Undo Preview no longer matches relevant current state; the record remains unconsumed and requires a fresh Preview. |
| UNDO_CONFLICT | Identity, document, association, or record preconditions currently make reversal unsafe; this normally does not consume the record. |
| UNDO_SUPERSEDED | A later successful ordinary Tag Management operation became the latest target; this is terminal for the prior user-facing Undo. |
| UNDO_ALREADY_APPLIED | The record was consumed by a committed Undo; this is terminal and does not expose Redo. |
| UNDO_UNAVAILABLE | No safe record can currently be advertised, including temporary health/compatibility unavailability or a permanently unsupported/corrupt record; the reason determines whether retry can help. |

The durable record lifecycle and current validation result are separate:

~~~
Record lifecycle:
latest user-facing → superseded | consumed | permanently unavailable

Current validation:
safe | stale | conflict | temporarily unavailable
~~~

Terminal lifecycle reasons include supersession, consumption, an unsupported
or corrupt record, irrecoverable provenance loss, and a database-generation
mismatch that cannot be safely related to the record. Exact persisted states
and enum names belong to the future Implementation Plan. A client retry cannot
make an irrecoverable record or provenance/generation failure safe, but it may
revalidate a temporary health condition or a dynamic conflict after the
underlying state changes.

These names are product-level concepts. Exact HTTP/error names belong in the
future reviewed Implementation Plan and must remain compatible with the
existing error-envelope and fail-closed conventions.

## 21. Undo Preview

Preview is mandatory. There is no blind one-click Undo mutation.

The server owns the current inverse plan and derives its complete affected set
from the durable record plus current SQLite state. The client submits only the
record identity and the reviewed Preview fingerprint/token; it does not submit
document IDs, complete association snapshots, counts, timestamps, or a
survivor ID as authority.

The Preview must display, at minimum:

- original operation kind and user-facing label;
- original commit time;
- original source stable ID/display/identity;
- destination stable ID/display/identity when applicable;
- the fact that this is an Undo of the named operation;
- affected document count;
- associations to add;
- associations to remove;
- duplicate/overlap restoration effects where applicable;
- restored or deleted tag identity effects;
- bounded affected-document sample;
- warnings and conflict/stale status;
- whether the Undo is currently allowed;
- a clear statement that documents, Markdown, and Git are not being rolled
  back.

An Undo Preview uses the same consistent-read principle as Phase 2 Preview.
Pagination, if exposed, is bound to the originating Undo fingerprint and
cannot expand or shrink the mutation authority.

## 22. Undo Apply / Exactly-Once User Contract

Undo Apply uses the same safety shape as Phase 2 Apply:

~~~
current Undo Preview
→ fingerprint validation
→ document locks in deterministic order
→ BEGIN IMMEDIATE
→ durable record/current graph revalidation
→ complete inverse delta mutation
→ new monotonic document versions
→ postcondition verification
→ COMMIT
~~~

The transaction is all-or-nothing. There is no partial Merge restoration and no
partial Remove restoration.

If Undo commits but the client refresh fails:

~~~
committed Undo
→ sync-pending
→ Retry synchronization only
→ never execute Undo Apply again
~~~

If the client receives a malformed or contradictory response after the server
committed, it uses the trusted submitted Undo record identity and authoritative
fresh reads for recovery. It does not trust contradictory identity fields and
does not re-Apply. The logical Undo therefore occurs at most once for a
successful request/record state, even if the UI retries synchronization.

The future domain must make a consumed record distinguishable from a merely
failed attempt. A process crash before commit leaves the post-original state;
a commit consumes the current user Undo record atomically with the inverse
mutation.

Concrete refresh-failure example:

~~~
Undo Merge commits
→ posts refresh fails
→ UI enters undo-sync-pending
→ Retry refreshes posts and managed tags only
→ Undo Apply request count remains one
~~~

## 23. Latest Operation / Supersession Rules

The latest successfully committed ordinary Tag Management operation owns
the user Undo window.

| Event | Effect on current user Undo |
| --- | --- |
| Preview only | No change |
| Cancelled confirmation | No change |
| Failed/stale Apply | No change |
| Successful Rename/Display Rename/Merge/Remove | After its durable reversible record and latest-target transition commit atomically, the new operation becomes the only Undo target; prior target is superseded |
| Successful Undo | Prior target becomes consumed; no Redo target is exposed |
| Title/summary edit | Does not supersede by itself |
| Unrelated tag edit | Does not supersede by itself; may create a dynamic, non-consuming relevant conflict if it overlaps the recorded delta |
| Restore of a matching backup | Availability becomes the state contained by that backup |
| Restore of a different/unknown database generation | Undo fails closed until a matching durable record/current graph is established |

The latest user-facing record remains in its Undo window without an arbitrary
timeout until it is successfully superseded, consumed, or becomes permanently
unavailable. A temporary health condition, stale Preview, or dynamic conflict
does not by itself consume the record; a later Preview may succeed if the
condition clears and all reversible preconditions remain valid.

The product does not promise a browsable history after supersession. The
internal full reversible payload may be removed or compacted atomically when a
new operation supersedes it; implementation retention must not leave a record
that can be mistaken for a valid older Undo.

## 24. Operation Record Product Requirements

The PRD defines required domain information, not SQL table names or migration
numbers. A durable reversible record must contain or reference:

- a unique operation/record identity that is server-generated;
- original operation kind and whether it was Display Rename;
- original commit timestamp;
- original normalized request;
- original source stable ID, display name, and normalized identity;
- destination stable ID, display name, and normalized identity where applicable;
- the original post-operation source/destination state required for validation;
- the exact operation-owned association delta created and removed;
- server-owned association provenance or equivalent generation/ownership
  evidence sufficient to prove that each inverse association is still the
  original operation-owned effect; final `(document_id, tag_id)` equality alone
  is explicitly insufficient;
- Merge overlap/source-only/destination-only information;
- Remove deleted-tag identity/display information;
- stable document identities required for inverse validation;
- the document/association post-state or equivalent ownership evidence needed
  to distinguish relevant changes from disjoint later changes;
- current metadata/version evidence needed for conflict detection, without
  treating old timestamps as values to restore;
- durable lifecycle/consumption/supersession state separate from the current
  validation result; a dynamic conflict is not a terminal consumed state;
- the relationship between an original operation and its Undo result;
- the identity-contract version under which the record was created.

The record must not store Markdown bodies. It must not store title/summary
snapshots as a default. It must not accept a client-supplied complete inverse
database snapshot.

The reversible delta may be represented with a parent operation record and
set-oriented child data. The implementation must keep the server-owned full
delta available for correctness while returning only bounded samples and
counts over the API.

The future Implementation Plan must define a bounded server-owned provenance
mechanism for these association effects. This PRD intentionally does not
choose a final table, journal, generation, or ownership representation, but it
does freeze that client state, display equality, and a reconstructed snapshot
are never provenance authority.

## 25. UX / State Machine

The minimum UX is:

~~~
successful Rename/Merge/Remove
→ success message with [Undo]
→ latest change remains discoverable in Manage Tags after refresh
→ Undo click
→ Undo Preview
→ explicit confirmation
→ Undo Apply
→ authoritative synchronization
~~~

Display Rename uses equivalent copy such as “Display name changed … [Undo]”.
The exact placement may be a success region and/or a “Last change” region in
the existing TagManagementDialog; it must not create a second management
state machine or make TagPanel own domain state.

Proposed states:

| State | Behavior |
| --- | --- |
| undo-unavailable | No safe record, old server, failed health, or unsupported record; no mutation control. The UI distinguishes retryable health/compatibility unavailability from a terminal unsupported or corrupt record. |
| undo-available | Latest record can be inspected and Previewed. |
| undo-previewing | Server builds a current inverse Preview; inputs are locked as appropriate. |
| undo-preview-ready | Counts, delta, sample, warnings, fingerprint, and confirmation action are visible. |
| undo-confirming | Existing global confirmation host presents explicit confirmation. |
| undo-applying | Undo Apply is in flight; duplicate submission is disabled. |
| undo-committed-refreshing | Undo committed; canonical posts/tag reads are refreshing. |
| undo-sync-pending | Commit is known; Retry performs synchronization only. |
| undo-conflict | A relevant current-state condition blocks safe reversal. This normally does not consume the record; after the condition is resolved, the user may request a new Preview. |
| undo-stale | Reviewed Preview is invalid; the user must Preview again. |
| undo-success | Inverse committed and authoritative state is synchronized. |
| undo-superseded | A later successful Tag Management operation consumed the user Undo window. |
| undo-terminal-unavailable | The record is permanently unsupported/corrupt, has irrecoverable provenance loss, or cannot be related to the current database generation; retry cannot make it user-undoable. |

No global Ctrl/Cmd+Z binding is added. Monaco/editor Undo remains untouched.

## 26. Error and Recovery UX

The UI must tell the user which of these occurred:

- no latest reversible operation;
- operation was superseded;
- Undo Preview became stale;
- a temporary current conflict that does not consume the latest Undo and may be
  retried after the relevant state changes;
- stable ID or normalized identity conflict;
- required document disappeared;
- operation-owned association changed;
- association provenance cannot prove ownership after a delete/re-add;
- management health or compatibility is unavailable;
- the reversible record is permanently unsupported, corrupt, or from an
  irreconcilable database generation;
- Undo committed but the view is still synchronizing.

Messages must say that a conflict prevented mutation, not that the original
operation was rolled back. A failed or stale Undo leaves the post-original
state intact.

After undo-sync-pending, Retry calls only the authoritative refresh seam. It
must not call the Undo Apply endpoint again. After a committed protocol
mismatch, recovery uses the trusted submitted record identity and fresh
authoritative state, analogous to Phase 2 committed-operation recovery.

## 27. Accessibility

Undo must preserve the existing management modal and confirmation contracts:

- role=dialog, aria-modal=true, accessible name, and description;
- keyboard-reachable Undo control;
- focus entry into Undo Preview;
- Tab and Shift+Tab trapping in the manager and nested confirmation;
- Escape cancels confirmation without mutation;
- focus restoration to the Undo trigger after cancellation;
- safe Cancel default focus in the destructive confirmation;
- disabled Undo/Apply while loading, stale, conflicted, or unavailable;
- aria-live=polite announcements for Preview ready, affected count, conflict,
  committed-refreshing, sync-pending, and success;
- destructive meaning conveyed by text and semantics, not color alone;
- focus moves to the first actionable conflict or error explanation;
- no change to editor Undo keyboard behavior.

## 28. Internationalization

The UX must add Chinese and English strings through the existing useI18n()
table. No Undo copy is hardcoded in a component.

The copy must distinguish:

- Undo of Rename vs Undo of Display Rename;
- Undo of Merge vs Undo of Remove;
- previewed association additions/removals;
- stable-ID restoration;
- conflict/stale/superseded/unavailable states;
- “documents and Markdown remain” from “tag associations are changed”;
- committed synchronization pending from failed mutation.

Examples of required semantic coverage:

| English meaning | Chinese meaning |
| --- | --- |
| Undo Rename / Undo Merge / Undo Remove | 撤销重命名 / 撤销合并 / 撤销删除 |
| Preview Undo | 预览撤销 |
| This is a new tag-management change; old timestamps will not be restored. | 这是新的标签管理变更，不会恢复旧的时间戳。 |
| The documents and Markdown files remain. | 文档和 Markdown 文件会保留。 |
| This Undo conflicts with a later relevant change. | 此撤销与后续相关变更冲突。 |
| Undo committed; retry synchronization only. | 撤销已提交；只能重试同步。 |

## 29. Security

Phase 2.1 preserves the existing owner authentication, same-origin CSRF,
JSON content-type, and Cache-Control: no-store boundaries.

Additional Undo requirements:

- operation/record IDs are server-generated and treated as opaque;
- an Undo Preview never trusts a client-supplied association scope;
- a client submits only the record identity and Preview token/fingerprint;
- server-side current state derives the complete inverse set;
- stable IDs and fingerprints use exact runtime validation;
- samples and diagnostic details are bounded;
- tag names are rendered as escaped text, not Markdown, HTML, paths, or SQL;
- raw SQL, SQLite constraint text, filesystem paths, stack traces, document
  bodies, and secrets do not leak through Undo errors;
- the record cannot be used to target an unrelated restored/current database
  generation without a fail-closed validation;
- existing tag validation, identity contract, count limits, and control-
  character rules remain in force.

Undo does not add permissions or collaboration roles. It remains behind the
single-owner authenticated management boundary.

## 30. Atomicity / Consistency

Undo Apply must satisfy all of the following:

- one all-or-nothing SQLite transaction for the inverse mutation;
- current record and graph revalidation immediately before mutation;
- deterministic document lock ordering consistent with Phase 2;
- no partial Merge restoration;
- no partial Remove restoration;
- source tag row restoration and associations commit together;
- every inverse association is changed only when server-owned provenance proves
  it is still the operation-owned effect; final composite-key equality is not
  ownership proof, including after delete-and-recreate;
- a Rename/Display Rename inverse cannot silently merge with another identity;
- each affected document version advances exactly once for this Undo;
- unaffected documents receive no version bump;
- versions never move backward;
- failure leaves the post-original/current state intact;
- Markdown bytes and mtimes remain unchanged;
- Frontmatter remains unchanged;
- Git HEAD, status, and History remain unchanged;
- fileChanges, link-index, Draft Recovery, and Tag Query contracts remain
  unchanged unless a normal read refresh is required;
- successful commit consumes the current user-facing reversible record in the
  same durable state transition;
- client refresh failure cannot turn a committed Undo into a second mutation.

While Phase 2.1 Undo is enabled and healthy, ordinary Rename, Display Rename,
Merge, and Remove Apply must also commit the tag mutation, association changes,
monotonic document versions, reversible record, and latest-Undo target
transition in the same SQLite transaction. Failure of any required reversible
state write rolls back the entire ordinary Apply. If record migration or health
is unavailable before the mutation, new supported ordinary Applies fail closed
rather than creating irreversible state.

## 31. Metadata Version Consequences

Undo uses the existing monotonic database-owned metadata version semantics. It
does not restore the version captured by the original operation.

Examples:

- Rename Undo changes the global tag display/identity and versions documents
  currently carrying that tag once.
- Display Rename Undo versions documents currently carrying the display-renamed
  tag once, with no association rewrite.
- Merge Undo versions documents whose source/destination associations change;
  destination-only documents do not receive a version bump.
- Remove Undo versions documents whose removed source association is restored.
- A document title/summary change made after the original operation remains in
  SQLite and its later version is not replaced by the old version.

If a candidate wall-clock value is not greater than a current version, the
existing monotonic helper advances it safely. created_at and historical
timestamps are never restored.

## 32. Migration / Upgrade

### Product rollout decision

Phase 2.1 will likely require a new SQLite schema/data migration for durable
reversible records, but this PRD intentionally does not choose the migration
number, table names, or SQL shape. The future Implementation Plan must choose
one transactionally safe design and review it against the current numbered
migration runner.

Upgrade requirements:

- existing Phase 2 databases upgrade without changing existing tag/document
  state;
- no old Rename, Display Rename, Merge, or Remove becomes retroactively
  undoable unless the complete reversible delta was actually captured;
- the first successful supported Tag Management operation after deployment
  establishes the first safe user-facing Undo record;
- while durable-record health is unavailable, new supported ordinary Tag
  Management mutations fail closed; no ordinary Apply may create a mutation
  without the reversible record and latest-target transition;
- a migration failure leaves existing Phase 2 operations intact and makes
  Undo unavailable/fail closed;
- a completed migration is idempotent and health-checked;
- no reverse identity migration is introduced.

Downgrade behavior:

- do not run a new server against a partially understood durable record;
- if Phase 2.1 has committed records, rollback uses a matching backup and
  compatible old image/runtime, as in the existing backup contract;
- old code must not be promised support for a new Undo schema unless the
  future compatibility plan explicitly proves it;
- a backup restore returns the record state contained in that backup.

## 33. Backup / Restore

Durable reversible state is part of the SQLite metadata generation. The
existing backup guidance remains authoritative: stop/quiesce writers or use a
SQLite-aware consistent snapshot covering active WAL/SHM state, and back up the
matching vault and required key/configuration.

Requirements:

- the operation record and tag/document mutation commit consistently;
- the reversible record and latest user-facing target transition are included
  in the same transaction as each new supported ordinary mutation;
- a matching backup never contains a durable record for a mutation absent from
  its tag/document state;
- restoring an older backup restores its corresponding Undo availability;
- restoring a backup before a Remove does not require a reverse identity
  migration; it simply restores the earlier database generation;
- restoring a backup after a successful Undo does not resurrect the consumed
  prior Undo unless that backup itself contains the earlier state;
- a record from one database generation must not be applied to another
  generation without current-state/fingerprint validation;
- partial SQLite-only or vault-only restore remains unsupported as a complete
  Undo recovery model.

The product does not add a second backup mechanism or ask operators to copy a
live main DB while ignoring WAL.

## 34. Client / Server Compatibility

The production Docker image continues to contain SPA and server from one build;
normal deployment remains one atomic client/server image.

The proposed stale-browser behavior is:

| Combination | Required behavior |
| --- | --- |
| New Undo client + old Phase 2 server | Undo read/mutation endpoint unavailable or 404/503; hide/disable Undo safely; do not mutate. Existing Phase 2 reads/flows retain their approved behavior. |
| Old Phase 2 client + new Undo server | Existing Rename/Merge/Remove protocol remains protected by the Phase 2 contract. The old client does not discover or invoke Undo; no automatic Undo is attempted. |
| New Undo client + new Undo server | Durable Undo is available only after health/migration checks and a valid current record. |
| New client + unsupported/malformed record | Fail closed with diagnostic-safe unavailable/conflict state. |

No arbitrary cross-version compatibility is promised. A hard browser refresh
may be required after deployment, consistent with the Phase 2 release notes.

## 35. Scale / Performance

Undo must remain set-based at the Phase 2 scale target of approximately 10,000
documents and 50,000 document-tag associations.

Required properties:

- no per-document network request or N+1 inverse planning query;
- complete inverse scope is server-derived, not bounded by the response sample;
- Preview response sample remains bounded, initially at most 20 and pages at
  most 100 if pagination is exposed;
- Merge/Remove inverse association work is set-based inside one transaction;
- durable delta storage and reads are measured for large source scopes;
- document locks and transaction duration are observed;
- a fixed wall-clock or heap SLA is not invented without evidence;
- the implementation records query shape, affected counts, sample bounds,
  memory, elapsed time, and transaction observations before making claims.

The client never sends the complete affected document list as mutation
authority, even if a UI page displays a sample.

## 36. Protected-Area Requirements

Phase 2.1 must protect these existing contracts:

- Markdown rendering;
- Markdown bytes and mtimes;
- Wiki links;
- Markmap;
- Mermaid;
- KaTeX;
- Emoji;
- link-index semantics;
- fileChanges semantics;
- Git History and Git state;
- Draft Recovery storage/state/ownership;
- authentication and CSRF behavior;
- Docker and Compose;
- Phase 1 Tag Query;
- TagPanel normal query, filter, ordering, selection, and results behavior;
- FileTree behavior;
- PostSummary.tags shape;
- ordinary editor text Undo.

Any requirement to write Markdown, Git, IndexedDB, or a new projection as part
of Undo is an Architecture / PRD Conflict requiring a stop and review.

## 37. Observability / Diagnostics

The future implementation should provide bounded, supportable diagnostics:

- server-generated operation and Undo-result correlation IDs;
- original operation kind and stable IDs;
- Preview/Apply/Undo outcome and conflict category;
- affected/added/removed/restored counts;
- version-update count;
- commit timestamp and identity-contract version;
- association provenance/conflict category without logging an unbounded
  association list;
- migration/health state for durable record availability;
- sync-pending and recovery attempts.

Diagnostics must not log Markdown bodies, full document contents, raw SQL,
filesystem secrets, session tokens, stack traces in responses, or unbounded
association lists. A log entry is not the product authority for Undo.

Diagnostics must distinguish durable record lifecycle from current validation:

~~~
Record lifecycle:
latest user-facing → superseded | consumed | permanently unavailable

Current validation:
safe | stale | conflict | temporarily unavailable
~~~

A dynamic conflict or stale Preview is not a durable consumed state. Terminal
diagnostics must identify supersession, consumption, unsupported/corrupt record,
irrecoverable provenance loss, or database-generation mismatch separately from
retryable health or current-state conditions.

## 38. Acceptance Criteria

The following are product acceptance criteria for a future implementation:

### Model and durability

- [ ] The latest successful Rename, Display Rename, Merge, or Remove is the
      only user-facing Undo target.
- [ ] Undo survives refresh and normal server restart.
- [ ] Later successful Tag Management operations supersede the prior target.
- [ ] Undo itself consumes the target and does not expose Redo.
- [ ] Existing Phase 2 operations before deployment are not retroactively
      undoable without a complete durable delta.
- [ ] Every new Phase 2.1 Rename, Display Rename, Merge, or Remove durably
      creates its reversible record and latest-Undo state in the same atomic
      SQLite transaction as the ordinary mutation.
- [ ] Failure to persist required reversible state rolls back the entire
      ordinary Tag Management Apply.
- [ ] No successful Phase 2.1 management mutation can return with an
      unexpectedly missing reversible record.
- [ ] Undo-record subsystem health failure prevents new supported mutations
      from creating irreversible state.

### Semantics

- [ ] Rename Undo restores the same stable ID and original identity/display.
- [ ] Display Rename Undo restores display only on the same stable ID.
- [ ] Merge Undo distinguishes source-only, overlap, and destination-only
      documents.
- [ ] Remove Undo restores the exact deleted source ID and associations when
      safe.
- [ ] An occupied ID or incompatible normalized identity fails closed.
- [ ] Missing required Remove/Merge documents fail the whole Undo, with no
      partial restoration.
- [ ] Later unrelated title, summary, tag, Markdown, and Git changes survive.
- [ ] A later unrelated tag on the same document survives when the
      operation-owned delta remains valid.
- [ ] A later delete-and-recreate of an operation-owned association is not
      treated as the original association merely because its composite key
      matches.
- [ ] Undo changes an association only when server-owned evidence proves that
      it is still the operation-owned effect; ambiguous provenance fails closed.
- [ ] The future Implementation Plan defines a bounded provenance mechanism;
      client state is never provenance authority.
- [ ] A later association to a renamed stable ID survives and observes the
      globally restored tag display/identity after Rename Undo.
- [ ] Old updated_at values are never restored.

### Preview, Apply, and recovery

- [ ] Undo requires a current server Preview and explicit confirmation.
- [ ] Preview contains original operation/time, identity, inverse counts,
      warnings, sample, and conflict/stale state.
- [ ] Server derives the complete inverse scope.
- [ ] Undo Apply is one atomic SQLite mutation with one version bump per
      affected document.
- [ ] Preview stale/conflict leaves the post-original state unchanged.
- [ ] A dynamic conflict Preview does not consume the latest reversible record;
      after the conflict clears, a fresh Preview may make Undo available again.
- [ ] Superseded, consumed, unsupported/corrupt, irrecoverable-provenance, and
      irreconcilable-generation outcomes are terminal for the current
      user-facing Undo and cannot be revived by client retry.
- [ ] Committed + refresh failure enters sync-pending and retries sync only.
- [ ] Contradictory committed responses use trusted record identity for
      recovery and never re-Apply.

### Security, compatibility, and protected areas

- [ ] Existing auth/CSRF/no-store and tag validation contracts remain active.
- [ ] No client-provided inverse snapshot or scope is authoritative.
- [ ] New client/old server and old client/new server fail safely.
- [ ] Markdown, Frontmatter, mtime, Git, History, link index, fileChanges,
      Draft Recovery, Tag Query, TagPanel, FileTree, and editor Undo regressions
      remain green.

### UX, accessibility, and scale

- [ ] Success exposes the latest Undo without a global keyboard shortcut.
- [ ] Preview/confirmation, Escape, focus trap, focus return, and live-region
      behavior work in Chinese and English.
- [ ] Conflict, stale, superseded, unavailable, and sync-pending states are
      understandable without color alone.
- [ ] 10k/50k tests prove bounded samples, constant query shape, no N+1, and
      complete server mutation scope.

## 39. Release Criteria

Phase 2.1 cannot be declared complete until:

1. This PRD is reviewed and approved.
2. A separate Phase 2.1 Implementation Plan is created and approved.
3. The plan resolves the durable record/migration shape without changing the
   product contracts above.
4. Unit, domain, API, component, accessibility, concurrency, scale, and
   production browser tests pass.
5. Migration, backup/restore, stale-browser, and downgrade rehearsals pass in
   isolated environments.
6. No P0/P1, unexplained P2, or Architecture / PRD Conflict remains.
7. Protected-area and editor Undo regressions remain green.
8. The closure record explicitly distinguishes the Phase 2.1 implementation
   baseline, operation record evidence, and backup/restore behavior.

This approved PRD is not a Phase 2.1 release gate and does not by itself
authorize implementation; it authorizes the separate Implementation Plan to be
created and reviewed.

## 40. Explicit Deferred Scope

The following remain deferred beyond the Phase 2.1 MVP:

- Redo;
- Undo of Undo as a user-facing feature;
- arbitrary multi-level Undo stack;
- history browsing/search/export;
- bulk rollback;
- event sourcing;
- global application revision/time travel;
- reverse identity migration;
- global Ctrl/Cmd+Z interception;
- editor/document-content Undo integration;
- distributed locking;
- a new ORM or client state-management framework;
- Markdown/Frontmatter mutation as part of tag Undo.

## 41. Open Product Questions

The following questions are resolved as recommended answers for review. They
are not implementation-plan details and must not be silently changed in code.

| Question | Proposed answer |
| --- | --- |
| 1. Is Phase 2.1 single-level Undo? | Yes. Only the latest successful ordinary Tag Management operation is user-undoable. |
| 2. Does Undo survive refresh? | Yes, through the durable SQLite record. |
| 3. Does Undo survive server restart? | Yes, after startup/current-state validation. |
| 4. What supersedes the latest Undo? | A later successful Rename, Display Rename, Merge, or Remove; a failed/cancelled attempt does not. |
| 5. Does a normal title/summary edit supersede Undo? | No. It survives and is not overwritten; an overlapping relevant state change may still make an inverse conflict. |
| 6. Does adding an unrelated tag supersede Undo? | No. It survives when the operation-owned delta remains valid. |
| 7. Which relevant changes block Undo? | Identity/ID occupation, operation-owned association changes, source/destination post-state changes, missing required documents, record/generation mismatch, or a superseding operation. |
| 8. Must a deleted stable ID be restored exactly? | Yes, for Merge and Remove whenever safe. |
| 9. What if the stable ID is occupied? | Fail the whole Undo safely; never auto-allocate a replacement ID. |
| 10. What if normalized identity is occupied? | Fail safely; do not silently merge or retarget. |
| 11. What if an affected document was deleted? | For Merge/Remove restoration, fail the whole Undo rather than partially restore. Rename/Display Rename need not restore a deleted document because they do not restore an association snapshot. |
| 12. Can Undo proceed when an unrelated tag was added to the same document? | Yes, if the operation-owned association preconditions still hold; preserve the unrelated association. |
| 13. Is Preview mandatory? | Yes, for every Undo. |
| 14. Does Undo require confirmation? | Yes, explicit confirmation after Preview; destructive cases use the existing confirmation host. |
| 15. How long is user-facing Undo available? | Until superseded, consumed, or permanently unavailable; a temporary health condition, stale Preview, or dynamic conflict does not consume it, and no arbitrary timeout is introduced. |
| 16. Is Redo deferred? | Yes. It is explicitly out of scope. |
| 17. What does sync-pending mean? | Undo committed; only authoritative synchronization remains and Retry never Applies again. |
| 18. How does old-client/new-server compatibility work? | Old clients continue approved Phase 2 behavior and do not invoke Undo; no automatic Undo is attempted. |
| 19. How does new-client/old-server compatibility work? | Undo reads/mutations are unavailable or 404/503; the client hides/disables Undo and does not mutate. |
| 20. What happens to Undo after backup restore? | Availability equals the matching restored database generation; mismatched/unknown records fail closed. |
| 21. What happens if the reversible record cannot be persisted during an ordinary Rename/Merge/Remove Apply? | The ordinary Apply rolls back atomically; no irreversible successful mutation is allowed while Phase 2.1 reversible-record health is required. |
| 22. Can a matching `(document_id, tag_id)` row be assumed to still belong to the original operation after delete/re-add? | No. Final equality is insufficient; server-owned provenance is required or Undo fails safely. |
| 23. Does a temporary Undo conflict permanently consume the Undo? | No. Conflict is normally non-consuming. If it later disappears and the record remains latest, unconsumed, supported, and provably reversible, Undo can become available again. |
| 24. What happens to a document associated with a renamed stable tag after the original Rename but before Undo? | Its association survives because the stable ID is unchanged; after Undo it observes the globally restored tag identity/display. |

These approved product decisions are recorded here; implementation remains
gated on a separately reviewed Phase 2.1 Implementation Plan.

## 42. Architecture / PRD Conflict

### Current finding

No existing Architecture / PRD Conflict was identified in the current
repository. SQLite is already the Tag Management mutation authority, stable
IDs and document IDs exist, the planner/apply boundaries are explicit, and the
startup migration seam and synchronization seams are reusable.

### Required review point

Phase 2.1 does require a new small durable reversible-state boundary that does
not currently exist. That is an intentional proposal for this separate phase,
not an existing implementation fact. It must be implemented only after PRD and
Implementation Plan review.

If safe delta ownership cannot be represented without restoring full document
snapshots, overwriting unrelated changes, changing Markdown/Git authority, or
breaking stable-ID restoration, the work must stop and this section must be
reopened. The fallback is not to weaken conflict checks.

Architecture / PRD Conflict: None

## 43. Review Checklist

### Authority and scope

- [x] Phase 2 approved PRD and Implementation Plan remain unchanged.
- [x] Phase 2 closure remains final and Undo remains a separate Phase 2.1
      review item.
- [x] This document is marked Approved for Implementation.
- [x] No Phase 2.1 implementation plan exists yet.

### Product model

- [x] Single-level durable Undo is accepted or explicitly amended.
- [x] Rename, Display Rename, Merge, and Remove inverse semantics are clear.
- [x] Stable-ID restoration and identity-conflict behavior are clear.
- [x] Later unrelated changes survive without snapshot rollback.
- [x] Rename Undo behavior for later associations to the same stable ID is
      clear: the association survives and observes the globally restored
      display/identity.
- [x] Relevant stale/conflict cases fail closed.
- [x] Dynamic current conflicts are non-consuming and may be re-Previewed after
      the conflicting state clears; terminal record failures remain terminal.
- [x] Undo of Undo/Redo remains deferred.

### Safety and operations

- [x] Preview and explicit confirmation are mandatory.
- [x] Exactly-once committed semantics and sync-only retry are clear.
- [x] Ordinary Apply and durable reversible-record/latest-target state commit
      atomically, or the entire ordinary Apply rolls back.
- [x] New supported mutations fail closed when reversible-state persistence or
      health is unavailable.
- [x] Association provenance is server-owned; final row equality and
      delete/re-add cannot establish ownership.
- [x] Migration, backup, restore, downgrade, and stale-browser behavior are
      implementable without inventing reverse identity migration.
- [x] Auth, CSRF, bounded samples, error hygiene, and protected areas remain
      covered.

### Implementation readiness

- [x] A separate Implementation Plan is written only after this PRD is
      approved.
- [x] The plan defines schema/migration and record retention without changing
      this product contract by assumption.
- [x] Tests and release gates trace to each accepted requirement.

## Final Approved State

~~~
PHASE 2.1 UNDO PRD APPROVED
READY FOR IMPLEMENTATION PLANNING
~~~

PRD: APPROVED
Implementation Plan: NOT YET CREATED
Implementation: NOT STARTED
Phase 2.1: NOT COMPLETE
Undo: NOT IMPLEMENTED
