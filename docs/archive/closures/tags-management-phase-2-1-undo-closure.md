# Nuvyn Tags Management Phase 2.1 — T2.1-7 Closure and Rollout Evidence

> **Status:** Final Closure Candidate — Awaiting External Review

This is the T2.1-7 evidence record for the reviewed Tags Management Phase 2.1
Undo implementation. It is documentation only. It records the implementation,
tests, rehearsal, limitations, compatibility, rollback, and protected-area
evidence available at the evidence HEAD.

This closure candidate does **not** itself declare Phase 2.1 complete. The
external T2.1-7 closure reviewer decides whether the phase may be declared
complete and frozen.

## 1. Closure Status

| Field | Factual value |
| --- | --- |
| Status | Final Closure Candidate — Awaiting External Review |
| Phase | Tags Management Phase 2.1 / T2.1-7 Closure and Rollout Evidence |
| Approved PRD | [`docs/design/tags-management-undo-prd.md`](../../design/tags-management-undo-prd.md) |
| Approved Implementation Plan | [`docs/design/tags-management-undo-implementation-plan.md`](../../design/tags-management-undo-implementation-plan.md) |
| Phase 2 production baseline | `99f4d73154349f8ebc99cb609f1a88b07937fb26` — `test(tags): harden phase 2 tag management` |
| Phase 2.1 production implementation baseline | `2fce11a227055ffa6402096af12d50a3859f604c` — `fix(tags): preserve authoritative undo availability` |
| T2.1-6 evidence HEAD | `95aad84ab22adae4435bb6c48bc58c3719f84ff3` — `test(tags): verify history restore rehearsal` |
| Closure candidate date | 2026-08-19 |
| External T2.1-7 review | PENDING |

The production implementation baseline and the later hardening/evidence HEAD
are intentionally separate. No production behavior is attributed to the
T2.1-6 evidence commits after `2fce11a...`.

## 2. Executive Result

The reviewed Phase 2.1 implementation provides:

- single-level durable Undo for the latest successful ordinary Rename, Display
  Rename, Merge, or Remove;
- SQLite-owned availability that survives refresh and normal restart;
- supersession by a later successful ordinary operation;
- mandatory server-authoritative Preview and explicit confirmation;
- exact stable-ID restoration where identity and provenance are safe;
- operation-owned inverse deltas that preserve later unrelated changes;
- no client inverse authority, database snapshot rollback, Markdown rollback,
  Git rollback, or editor rollback;
- one atomic ordinary Apply plus reversible-record/latest-target transition;
- one atomic Undo Apply with consumed lifecycle and bounded retention;
- committed-response recovery and sync-pending retry that perform reads and
  synchronization only;
- no Redo and no global Ctrl/Cmd+Z interception.

The live UI keeps old operation outcomes (success, consumed, terminal, or
superseded) separate from the fresh authoritative latest Undo availability.
Thus a successful old Undo may still announce success while a newer available
record remains the actionable Last Change.

## 3. Authority and Scope Compliance

The reviewed authority order is:

```text
Approved Phase 2.1 Undo PRD
>
Approved Phase 2.1 Undo Implementation Plan
>
externally reviewed T2.1-0 through T2.1-6 implementation and evidence
>
this T2.1-7 closure record
```

The approved design documents were not edited by the implementation or by
this closure candidate. The existing Phase 2 contracts remain binding.

| Audit | Result |
| --- | --- |
| Architecture / PRD Conflict | NONE |
| Phase scope violation | NONE |
| Owning-phase product defect | NONE |
| Redo added | NO |
| Arbitrary history added | NO |
| Reverse identity migration added | NO |
| Markdown/Git rollback added | NO |
| Editor Ctrl/Cmd+Z interception added | NO |
| New global manager/state store added | NO |

The closure commit is documentation-only and does not add a product
requirement, route, migration, test, CI lane, Docker behavior, or release tag.

## 4. Authority Commit Inventory

The exact authority history was verified from Git. The eight Phase 2.1
authority-history commits are listed below; the two parallel approval commits
were resolved by the final approval merge.

| Authority area | Full commit | Subject | Purpose |
| --- | --- | --- | --- |
| PRD | `8977c0244cad062dbb71e2c1f809ff86ccf7a6b4` | `docs(tags): draft phase 2.1 undo prd` | Initial Phase 2.1 Undo product/architecture proposal |
| PRD | `59d99687a675663f70448435f89c80d8ad3b253e` | `docs(tags): close phase 2.1 undo prd review gaps` | Addressed PRD review findings |
| PRD | `874eb36642d6a2407b81986efb056f8832adb06e` | `docs(tags): approve phase 2.1 undo prd` | Approved the Undo PRD |
| Implementation Plan | `b850d0a0559d361ec87f721faf681ba33303824f` | `docs(tags): draft phase 2.1 undo implementation plan` | Initial implementation plan |
| Implementation Plan | `841dbbf2741f65df1dec73d01c01f56237efba5d` | `docs(tags): harden phase 2.1 undo implementation plan` | Hardened provenance, migration, activation, and gate design |
| Implementation Plan | `f6e13c4d15841be75538b46e0f7b233bfcf2d213` | `docs(tags): approve phase 2.1 undo implementation plan` | One approval parent |
| Implementation Plan | `851f9fa27fc2cfc261d748f7bdcab5b9eab571af` | `docs(tags): approve phase 2.1 undo implementation plan` | Parallel approval parent |
| Implementation Plan | `e7175b6979b32283aca31e98cd85a34d1f7054e3` | `docs(tags): resolve phase 2.1 plan approval merge` | Resolved the two-parent approval history |

For context, the consulted Phase 2 closure history is:

| Full commit | Subject |
| --- | --- |
| `a8a0d7decf43a7743d19fa9cac7c612f9e0e13db` | `docs(tags): add phase 2 closure evidence` |
| `d8a23aa448c2e956d7f535f174aea08e6ed3c911` | `docs(tags): correct phase 2 closure evidence` |
| `851624ba39aca5725b7b527a782ac1fd163583e4` | `docs(tags): finalize phase 2 closure` |

Those Phase 2 closure commits are context and are not counted as Phase 2.1
implementation commits.

## 5. Implementation Commit Inventory

The following is the ordered inventory of every reviewed T2.1-0 through
T2.1-6 implementation or hardening commit. The final anchor for each phase is
marked in the purpose column.

| Phase | Full commit | Subject | Purpose / reviewed result |
| --- | --- | --- | --- |
| T2.1-0 | `a3b2febf8c557de0ca1bb7a9ebd96bb7704754fc` | `feat(tags): add undo provenance foundation` | Migration, association provenance, bounded durable Undo foundation |
| T2.1-0 final | `ad5d88adc4a28b3de5e1d290356a60bc542e1309` | `fix(tags): harden undo provenance foundation` | Foundation repair, health, v6/v7 compatibility, set-diff writer safety; **PASS / FROZEN** |
| T2.1-1 | `bd2884f0d918f123ab34da1b1a4e82025e0ea377` | `feat(tags): record reversible tag operations atomically` | Ordinary Apply recording and latest-target transition |
| T2.1-1 | `b3630a337375fb71204b71a9507c83057d0b107a` | `test(tags): add two-connection WAL apply race coverage` | Independent WAL Apply race evidence |
| T2.1-1 final | `9220d634e0d4da7230dafa61c02e92107447af0c` | `test(tags): make WAL race harness cross-platform` | Cross-platform activation/WAL evidence; **PASS / FROZEN** |
| T2.1-2 | `f67e9361e7e80dc74e37a5539980a0937269732a` | `feat(tags): add undo planner and preview` | Server-derived inverse planner and Preview |
| T2.1-2 final | `a3afbdda5fc851e7fb0ecf1d631df4208bdb1086` | `fix(tags): harden undo planner availability semantics` | Lifecycle/validation separation, bounded read model; **PASS / FROZEN** |
| T2.1-3 | `10c720a9464b89b49a157c75fc2dfd312a8a1008` | `feat(tags): add atomic tag undo apply` | Atomic inverse mutation and consumed lifecycle |
| T2.1-3 final | `a49fc9e1b467f6228794d22a8222eb500819083c` | `fix(tags): harden undo apply completion evidence` | Completion evidence, recovery, exactly-once semantics; **PASS / FROZEN** |
| T2.1-4 | `9d495921844ee088deb615a58d33120f6e02cf2a` | `feat(tags): expose tag undo protocol` | Public HTTP routes and typed client protocol |
| T2.1-4 | `1cfca7b491bfcae0a56b1025a018ffa2c68e1dd7` | `fix(tags): harden undo protocol semantics` | Error, identity, compatibility, and recovery hardening |
| T2.1-4 final | `41a66d96a8d9f2be17d7a24321e3b18eb6a8fa73` | `fix(tags): close undo protocol compatibility gaps` | Final protocol compatibility/error boundary; **PASS / FROZEN** |
| T2.1-5 | `bcd1b2d2c3f9c3659fe0e711e743b652b55441cf` | `feat(tags): add tag management undo ui` | Dialog, Preview/confirmation, selection, i18n, and a11y UI |
| T2.1-5 | `b41df9a4a2d800ab478546daf9e58cb7a6b4c2f8` | `fix(tags): harden undo ui state transitions` | UI mutual exclusion, superseded/terminal/recovery transitions |
| T2.1-5 final | `2fce11a227055ffa6402096af12d50a3859f604c` | `fix(tags): preserve authoritative undo availability` | Fresh latest availability remains actionable after old outcomes; **PASS / FROZEN production baseline** |
| T2.1-6 | `f1662a46284f5668023a0e5ff53160af62b80f4b` | `test(tags): harden phase 2.1 undo` | Hardening evidence, scale, recovery, compatibility, and rehearsal |
| T2.1-6 final | `95aad84ab22adae4435bb6c48bc58c3719f84ff3` | `test(tags): verify history restore rehearsal` | Real application History evidence in the disposable rehearsal; **PASS / FROZEN evidence HEAD** |

T2.1-0 through T2.1-6 were externally reviewed as PASS / COMPLETE / FROZEN
with P0 = 0, P1 = 0, P2 = 0, and P3 = 0. The external T2.1-7 closure
decision remains pending.

## 6. T2.1-0 Through T2.1-6 Gate Matrix

| Gate | Evidence | Result |
| --- | --- | --- |
| T2.1-0 — migration and association provenance | `server/__tests__/tagUndoFoundation.test.ts`: `rebuilds a populated v6 association graph with explicit unique IDs`; `preserves unchanged IDs, inserts only additions, and deletes only removals`; `does no association rewrite for an identical set and allocates a new ID after delete/re-add`; exact v6/v7 compatibility cases; foundation-only rehearsal at `ad5d88...` | PASS / FROZEN. Foundation health exists without activating Undo API/UI or creating records. |
| T2.1-1 — atomic ordinary Apply recording | `server/__tests__/tagUndo.test.ts`: `records the unchanged old-client Apply shape entirely server-side`; `fails closed before mutation when reversible-record health is unhealthy`; rollback/capture failure cases; two-connection WAL tests; rehearsal activation at `9220d6...` verifies the first supported Apply creates one parent, child deltas, and the current pointer | PASS / FROZEN. No-record-no-commit and activation boundary are evidenced. |
| T2.1-2 — planner and Preview | `server/__tests__/tagUndo.test.ts`: `builds Rename and Display Rename previews from the current stable-ID membership`; `plans Merge inverse scope with exact created-destination provenance`; `plans Remove, including an orphan, without allocating a replacement ID`; `proves availability, Preview, and page are read-only and exclude unrelated state`; bounded query/page tests | PASS / FROZEN. Scope is server-derived, fingerprinted, relevant-graph only, bounded, and non-mutating. |
| T2.1-3 — atomic Undo Apply | `server/__tests__/tagUndo.test.ts`: `undoes Rename atomically, preserves later membership and metadata, and keeps association IDs`; `undoes Display Rename without changing physical memberships`; `undoes mixed Merge scope with exact destination provenance and preserves unrelated changes`; `undoes Remove with a new source ID association and permits orphan Remove`; rollback, duplicate Apply, and WAL race cases | PASS / FROZEN. Exact inverse, stable-ID rules, versioning, postconditions, and at-most-one concurrent commit are evidenced. |
| T2.1-4 — public protocol/client | `server/__tests__/tagUndo-api.test.ts` auth/CSRF/no-store, bounds, error, lifecycle, conflict, page, and Apply cases; `src/lib/__tests__/tag-undo-api.test.ts` exact request/response guards, old-server unavailability, contradictory response recovery, and strict identity binding | PASS / FROZEN. Public routes, typed errors, compatibility, and trusted recovery are covered. |
| T2.1-5 — UI and production browser | `src/components/vault/__tests__/TagManagementDialog.test.ts` component matrix, including mandatory Preview, ConfirmHost, sync-pending, superseded/terminal recovery, fresh R2 actionability, selection/mutual exclusion, and zh/en; `src/lib/__tests__/tag-selection-reconciliation.test.ts`; `e2e/tag-management.spec.ts` production Undo flow | PASS / FROZEN. Preview/confirmation, stable-ID selection, a11y/i18n, exactly-once, and authoritative latest-state adoption are evidenced. |
| T2.1-6 — hardening and rollout evidence | Full local unit/integration suite, scale suite, focused History/API/recovery suites, browser and auth E2E, real disposable old/current/restore rehearsal, security/protected-area review, and exact diff/status checks. Docker local execution was unavailable and exact final-SHA CI was unverified; both limitations are recorded in §§17–19. | PASS / FROZEN per external hardening review, with the two factual environment evidence limitations preserved rather than converted to PASS. |

## 7. Master Regression Matrix A–AP

The approved plan defines A–AG in §38 “Required Regression Cases”; the plan
adds AH–AP in §41 “Master regression additions for this repair”. The matrix
below records all 42 cases with repository evidence. Test names are copied from
the actual repository test titles; where a case is an operational rehearsal,
the named script and its observed assertions are used.

### A–P — core inverses and later-change preservation

| Case | Invariant | Evidence | Result |
| --- | --- | --- | --- |
| A | Rename Undo restores the original Rename state | `server/__tests__/tagUndo.test.ts`: `undoes Rename atomically, preserves later membership and metadata, and keeps association IDs`; `e2e/tag-management.spec.ts`: `production Undo previews, confirms, and restores Rename, Display Rename, Merge, and Remove` | PASS |
| B | Display Rename Undo restores display without changing identity | `server/__tests__/tagUndo.test.ts`: `undoes Display Rename without changing physical memberships`; production Undo browser flow | PASS |
| C | Merge Undo restores source-only membership | `server/__tests__/tagUndo.test.ts`: `undoes mixed Merge scope with exact destination provenance and preserves unrelated changes`; production browser Merge/Undo flow | PASS |
| D | Merge Undo restores overlap membership without duplicating destination membership | Same mixed Merge inverse test; `e2e/tag-management.spec.ts` asserts overlap tags after Undo | PASS |
| E | Destination-only documents remain untouched | `server/__tests__/tagManagement.test.ts`: `applies Merge with overlap accounting and leaves destination-only versions unchanged`; mixed Merge Undo test | PASS |
| F | Remove Undo restores the source and memberships | `server/__tests__/tagUndo.test.ts`: `undoes Remove with a new source ID association and permits orphan Remove`; production Remove/Undo browser flow | PASS |
| G | Orphan Remove is reversible without document versioning | `server/__tests__/tagUndo.test.ts`: `undoes Remove with a new source ID association and permits orphan Remove`; `reports consumed orphan Remove with all-zero counts` | PASS |
| H | Deleted source stable ID is restored exactly when safe | `server/__tests__/tagUndo.test.ts`: `undoes Remove with a new source ID association and permits orphan Remove`; `src/lib/__tests__/tag-selection-reconciliation.test.ts`: `restores Remove source only when the stable ID was resolved, never by display coincidence` | PASS |
| I | Occupied stable ID fails closed | `server/__tests__/tagUndo.test.ts`: `classifies stable-ID, identity, document, and association provenance conflicts without consuming`; `server/__tests__/tagUndo-api.test.ts`: `maps stable-ID conflicts to the approved public code` | PASS |
| J | Occupied normalized identity fails closed | The same planner conflict test and `server/__tests__/tagUndo-api.test.ts`: `maps identity, document, association, and post-state conflicts to stable public codes` | PASS |
| K | Missing required document fails the whole Undo | `server/__tests__/tagUndo-api.test.ts`: `maps missing-document conflicts without partially applying Undo`; planner conflict classification test | PASS |
| L | Later unrelated title survives | `server/__tests__/tagUndo.test.ts`: `undoes Rename atomically, preserves later membership and metadata, and keeps association IDs`; `server/__tests__/tagManagement.test.ts`: `rejects a stale explicit tag writer after Apply while title and summary writes preserve the new association` | PASS |
| M | Later unrelated summary survives | `server/__tests__/tagUndo.test.ts` mixed inverse preservation case; `scripts/phase21-undo-rehearsal.mjs` asserts `later unrelated summary` remains after Merge/Undo | PASS |
| N | Later unrelated tag survives | `server/__tests__/metadata-api.test.ts`: `preserves a Merge-owned association across a REST tag addition so Undo retains the later tag`; `server/__tests__/tools.test.ts`: `preserves a Merge-owned association across an AI tag addition so Undo retains the later tag` | PASS |
| O | Markdown bytes and mtime survive | `server/__tests__/tagManagement.test.ts`: `keeps Markdown bytes, mtime, fileChanges, link index, Git, settings, and the success log outside Apply mutation scope`; production browser boundary assertions; rehearsal SHA/mtime assertions | PASS |
| P | Later association to renamed stable ID survives and observes restored global display | Rename inverse test retains later membership while restoring the same tag row; `src/lib/__tests__/tag-selection-reconciliation.test.ts`: `reconciles Rename Undo and Display Rename Undo by the original stable source ID` | PASS |

### Q–AG — provenance, lifecycle, exactly-once, scale, compatibility, and editor boundary

| Case | Invariant | Evidence | Result |
| --- | --- | --- | --- |
| Q | Untouched Merge-created association remains operation-owned and Undo succeeds | `server/__tests__/metadata-api.test.ts`: `preserves a Merge-owned association across a REST tag addition so Undo retains the later tag`; `server/__tests__/tagUndo.test.ts`: `plans Merge inverse scope with exact created-destination provenance` | PASS |
| R | Delete→re-add changes physical identity and causes provenance conflict | `server/__tests__/metadata-api.test.ts`: `gives a REST delete and later re-add a new association ID and rejects stale Merge Undo provenance`; `server/__tests__/tagUndo.test.ts`: `rejects Merge delete-readd provenance races without deleting the replacement ID` | PASS |
| S | Dynamic conflict appears as a non-consuming Preview conflict | `server/__tests__/tagUndo.test.ts`: `keeps dynamic conflicts non-consuming and allows a safe fresh Preview after they clear`; `classifies stable-ID, identity, document, and association provenance conflicts without consuming` | PASS |
| T | Cleared dynamic conflict can be retried with a fresh Preview | `server/__tests__/tagUndo.test.ts`: `keeps dynamic conflicts non-consuming and allows a safe fresh Preview after they clear`; `rejects a stale page across two WAL connections and recovers after the conflict clears` | PASS |
| U | Later successful ordinary operation supersedes the prior target | `server/__tests__/tagUndo.test.ts`: `supersedes one target with the next and deletes the previous heavy record`; `server/__tests__/tagUndo-api.test.ts`: `returns a superseded tombstone after committed Undo and a later ordinary Apply`; UI latest-record refresh cases | PASS |
| V | Failed ordinary Apply does not supersede the existing target | `server/__tests__/tagUndo.test.ts`: `keeps the existing target and graph unchanged when a second Apply fails`; `rejects a duplicate reviewed Apply as stale without creating another record` | PASS |
| W | Reversible-record write failure rolls back ordinary Apply | `server/__tests__/tagUndo.test.ts`: `rolls back removed-source child capture and post-association failures`; `rolls back Merge staging and created-destination capture failures`; `fails closed before mutation when reversible-record health is unhealthy` | PASS |
| X | Latest-target transition failure rolls back ordinary Apply | `server/__tests__/tagUndo.test.ts`: `rolls back old-target deletion after pointer transition`; failure-injection assertions retain graph, parent, child, pointer, and versions | PASS |
| Y | Committed Undo plus refresh failure enters sync-pending and Retry is read-only | `src/components/vault/__tests__/TagManagementDialog.test.ts`: `enters sync-pending after a known commit and retries synchronization only`; `keeps committed protocol mismatch recovery pending and retries the VaultView seam without re-applying` | PASS |
| Z | Contradictory committed response never causes a second Undo Apply | `src/lib/__tests__/tag-undo-api.test.ts`: `retains the submitted record after a contradictory 2xx and recovers with reads only`; component test `recovers a malformed committed response with READ only and never Applies again` | PASS |
| AA | Two concurrent Undo Applies commit at most once | `server/__tests__/tagUndo.test.ts`: `allows exactly one Apply across two independent WAL connections`; `serializes two independent Node runtimes against one WAL with a deterministic gate` | PASS |
| AB | Preview samples/pages are bounded and cannot change mutation authority | `server/__tests__/tagUndo.test.ts`: `proves availability, Preview, and page are read-only and exclude unrelated state`; `rejects malformed bounds and tampered page fingerprints without reading a different plan`; API bounded page tests | PASS |
| AC | 10k/50k scale remains set-based and complete | `npm run test:tags-scale` — 2 files / 6 tests; 10,000 documents, 50,000 associations, bounded sample/page, complete large Undo Apply, clean FK/integrity | PASS |
| AD | Complete backup/upgrade/restore works with the matching old runtime | `node scripts/phase21-undo-rehearsal.mjs` — PASS; final JSON has `completeBackupAndRestore: true`, `noReverseMigration: true`, and `applicationHistoryRestore: true` | PASS |
| AE | Old Phase 2 client request shape remains supported by the new server | Rehearsal accepts the old ordinary Merge request shape and records it; `server/__tests__/tagUndo.test.ts`: `records the unchanged old-client Apply shape entirely server-side` | PASS |
| AF | New client against old Phase 2 server fails safely unavailable | `src/lib/__tests__/tag-undo-api.test.ts`: `treats an old-server Undo 404 as safe unavailability without fallback mutation`; restored old runtime rehearsal verifies the Undo endpoint is absent | PASS |
| AG | Editor Undo and global Ctrl/Cmd+Z remain outside Tag Management | `src/views/__tests__/VaultView.test.ts`: `keeps Monaco mounted and isolates shortcuts for read-only history tabs`; source audit found no Tag Management global shortcut or editor Undo mutation | PASS |

### AH–AP — implementation-plan repair cases

| Case | Invariant | Evidence | Result |
| --- | --- | --- | --- |
| AH | REST later unrelated Python addition preserves Merge-owned Backend association ID and Undo preserves Python | `server/__tests__/metadata-api.test.ts`: `preserves a Merge-owned association across a REST tag addition so Undo retains the later tag` | PASS |
| AI | AI writer has the same unchanged-provenance behavior | `server/__tests__/tools.test.ts`: `preserves a Merge-owned association across an AI tag addition so Undo retains the later tag`; `uses the same set-diff provenance contract for AI tag updates` | PASS |
| AJ | Requested unchanged association retains its physical ID across a replacement | `server/__tests__/tagUndoFoundation.test.ts`: `preserves unchanged IDs, inserts only additions, and deletes only removals`; `does no association rewrite for an identical set and allocates a new ID after delete/re-add` | PASS |
| AK | True delete→re-add receives a new ID and Undo reports provenance conflict | REST writer/re-add test above; `server/__tests__/tagUndo.test.ts`: `rejects Merge delete-readd provenance races without deleting the replacement ID` | PASS |
| AL | Real v6 recovery journal migrates/replays safely without creating an Undo record | `server/__tests__/crashRecovery.test.ts`: `migrates a v6 journal and recovers it through recoverInterruptedOperations`; `server/__tests__/tagUndoFoundation.test.ts`: `accepts exact legacy v6 and marked v7 rows, but rejects mixed rows`; focused crash recovery run: 138 tests passed | PASS |
| AM | Unsafe external drift fails closed/quarantines without overwriting the external owner | `server/__tests__/crashRecovery.test.ts`: `fails closed on unsafe live drift without overwriting the external owner`; focused crash recovery run: 138 tests passed | PASS |
| AN | T2.1-0 intermediate build is foundation-only, healthy, and not Undo-activated | `server/__tests__/tagUndoFoundation.test.ts`: `is idempotent and exposes a healthy foundation without activating Undo`; rehearsal `foundation` at `ad5d88...` reports zero Undo records and a null current pointer | PASS |
| AO | T2.1-1 activation gives the first supported ordinary operation one complete record and current pointer | Rehearsal `activation` at `9220d6...` verifies one parent, child deltas, latest lifecycle, pointer identity, generation, and contract versions | PASS |
| AP | Unhealthy reversible-record subsystem blocks mutation and produces no record-less success | `server/__tests__/tagUndo.test.ts`: `fails closed before mutation when reversible-record health is unhealthy`; rehearsal removes Undo state, expects 503 `TAG_MANAGEMENT_UNAVAILABLE`, and verifies unchanged graph/versions/no record | PASS |

**A–AP coverage:** 42 defined cases; 42 mapped; missing cases: 0.

## 8. Schema and Migration Closure

The final factual persistence state is schema version 8: migration `0007` is
the Phase 2.1 foundation migration and `0008` is the forward repair migration
for the published v7 foundation. The repair is not a rewrite of migration
history.

`document_tags` has the approved physical provenance shape:

```sql
association_id INTEGER PRIMARY KEY AUTOINCREMENT
UNIQUE(document_id, tag_id)
```

The final Undo persistence consists of:

- `tag_undo_records` — one retained current parent with original operation and
  result identity, tag-row before/post state, generation, lifecycle, counts,
  and consumed/terminal evidence;
- `tag_undo_association_deltas` — exact `removed-source` and
  `created-destination` association IDs owned by the record;
- `tag_undo_state` — singleton generation, current record pointer, compact
  previous superseded record ID, and update time.

The migration and lifecycle facts are:

- every logical v6 association receives a valid unique physical ID;
- the migration creates no Undo record and does not activate public Undo;
- `database_generation` is persisted in the singleton and parent contract;
- `latest`, `consumed`, and `terminal` lifecycle states are represented by the
  repaired schema;
- successful consumption purges heavy child deltas while retaining the
  compact consumed parent result;
- v6 recovery snapshots are parsed by version and never treated as historical
  provenance when they lack physical IDs;
- migration failure rolls back and a repaired source can retry;
- there is no reverse migration and no reverse identity reconstruction.

## 9. Ordinary Writer and Provenance Closure

The approved writer contract is set-diff based and shared by REST and AI
metadata tag writers:

| Requested change | Physical result |
| --- | --- |
| Unchanged logical association | Existing `association_id` is preserved |
| True addition | New association row and new `association_id` |
| True removal | Exact current association row is deleted |
| Delete then re-add | New `association_id`; it is not the old operation-owned row |
| Identical logical set | No physical association rewrite |
| Recovery/full snapshot | Separately owned compatibility path; it does not invent historical provenance |

Undo uses the opaque physical association ID and server-owned durable deltas,
not display name, normalized name, composite-key equality, or caller-supplied
physical IDs. The REST/AI provenance cases AH–AK are included in §7.

## 10. Ordinary Apply Recording Closure

After T2.1-1 activation, the ordinary management mutation and reversible state
share one `BEGIN IMMEDIATE` SQLite transaction:

```text
ordinary tag/association mutation
+ monotonic document versions
+ parent record
+ child deltas
+ current latest pointer
+ supersession cleanup
COMMIT
```

The transaction captures the actual operation-owned delta, not a client
snapshot. Parent, child, pointer, version, postcondition, and old-target
deletion failure injections prove rollback. If Undo health or required record
persistence is unavailable, the ordinary mutation fails closed before an
irreversible success can be observed.

## 11. Undo Planner and Fingerprint Closure

The server derives the complete inverse scope from the durable record and the
current SQLite graph. The client submits only an opaque record ID and the
reviewed fingerprint.

The planner contract is:

- relevant graph only; unrelated title/summary/version, Markdown, Git, and
  History changes are excluded when they do not affect inverse safety;
- source/destination stable rows, paths, required documents, exact association
  IDs, identity occupancy, provenance, lifecycle, and generation are included
  when they affect safety;
- current conflict and stale validation are separate from durable lifecycle;
- samples are bounded to 20 and continuation pages to 100;
- the query shape is set-based and has no client or server N+1 loop;
- a sample or page cannot expand or redefine the server mutation scope.

## 12. Undo Apply and Exactly-Once Closure

The committed inverse sequence is:

```text
discovery
→ deterministic sorted document locks
→ BEGIN IMMEDIATE
→ reload parent/children/generation/current graph
→ re-plan and re-check fingerprint
→ operation-specific inverse
→ monotonic versions
→ postconditions
→ consumed state / child purge
→ COMMIT
```

Every pre-commit failure rolls back the graph, versions, lifecycle, pointer,
and children. A duplicate Apply sees consumed/stale state and cannot mutate.
Two independent WAL connections and two independent Node runtimes prove that
at most one concurrent Apply commits.

If a commit response or subsequent synchronization is ambiguous, the trusted
submitted record identity is recovered with reads. Sync-pending Retry performs
authoritative posts/tree/tag/Undo synchronization only. It adds zero Apply
requests.

## 13. Per-Operation Inverse Matrix

| Operation | Restored | Preserved | Conflict conditions | Version effect |
| --- | --- | --- | --- | --- |
| Rename Undo | Same source tag ID, original display and normalized identity | Current associations, later associations to that stable ID, unrelated metadata/files | Source post-state changed; original identity occupied by incompatible row; generation/provenance unsafe | Current documents carrying the renamed stable row advance once |
| Display Rename Undo | Same source tag ID and normalized identity; original display only | All physical memberships and unrelated metadata/files | Reviewed stable row/display state changed | Current documents observing the global display advance once |
| Merge Undo | Original source tag row/ID; source-only memberships; overlap source memberships; exact operation-owned destination rows removed | Destination tag and destination-only memberships; later unrelated destination/Python associations | Source ID/identity occupied; destination post-state drift; missing document; operation-owned association delete/re-add or ambiguous provenance | Only affected inverse documents advance once; destination-only documents remain unchanged |
| Remove Undo | Original deleted source tag ID/identity; logical source memberships as new physical association rows | Documents, Markdown, Frontmatter, mtime, Git, History, unrelated metadata | ID/identity occupied; missing required document; unsafe association provenance | Restored-membership documents advance once; orphan Remove has zero affected versions |

Undo never restores an old `updated_at` value. A new Undo is a new forward
metadata mutation.

## 14. API and Client Closure

The approved public endpoints are:

```text
GET  /api/tags/undo
POST /api/tags/undo/preview
POST /api/tags/undo/preview/page
POST /api/tags/undo/apply
```

Request bodies are exact and bounded:

```json
GET /api/tags/undo

POST /api/tags/undo/preview
{"recordId":"<opaque-id>","limit":20}

POST /api/tags/undo/preview/page
{"recordId":"<opaque-id>","undoFingerprint":"<64 lowercase hex>","afterDocumentId":"<cursor>","limit":100}

POST /api/tags/undo/apply
{"recordId":"<opaque-id>","undoFingerprint":"<64 lowercase hex>"}
```

Unknown fields, malformed IDs/fingerprints, unsafe bounds, wrong content type,
missing auth, and failed CSRF checks are rejected before mutation. Responses
use bounded public data, `Cache-Control: no-store`, typed public error codes,
and sanitized details. The client sends no inverse rows, document scope,
association list, snapshot, old timestamp, or replacement stable ID.

Old-server absence maps to safe unavailable state without fallback mutation.
Contradictory committed responses retain the trusted submitted record ID and
use read/recovery seams only.

## 15. UI, Accessibility, and I18n Closure

The existing `TagManagementDialog` remains the manager owner; `VaultView`
owns authoritative post/tree/managed-tag/Undo synchronization and committed
recovery. `TagPanel` remains a Phase 1 query/filter and manager-entry surface.

The UI evidence covers:

- authoritative Last Change and mandatory Preview before Apply;
- explicit `ConfirmHost` confirmation, safe Cancel-default focus, Escape,
  focus trapping, focus restoration, and zero mutation on cancellation;
- live-region/status/alert semantics and warning text that does not depend on
  color alone;
- Chinese and English labels for Rename, Display Rename, Merge, Remove,
  Preview, confirmation, conflict, stale, superseded, consumed, terminal,
  sync-pending, Retry, and success;
- stable-ID selection reconciliation and selection-epoch user-wins behavior;
- ordinary/Undo mutual exclusion and stale Preview invalidation;
- authoritative fresh latest-state adoption after old success, consumed,
  terminal, superseded, or committed recovery outcomes;
- no optimistic managed-tag list or production selection rewrite;
- no global keyboard Undo and no Redo UI/state/request.

The expected and tested presentation separation is:

```text
old R1 outcome → announcement / diagnostic
fresh authoritative availability → actionable state / Last Change / Preview
```

## 16. Scale Evidence

These are executed local observations from the verbose scale test run. They
are **observational**, not SLAs or performance promises.

| Observation | Value |
| --- | ---: |
| Documents | 10,000 |
| Associations | 50,000 |
| Initial Undo Preview sample | 20 |
| Undo Preview page | 100 |
| Final memberships after large Undo | 50,000 |
| Migration elapsed | 40.50 ms |
| Planner query count | 3 |
| Planner elapsed | 65.57 ms |
| Planner heap delta | 32,203,856 bytes |
| Undo Apply elapsed | 272.98 ms |
| Health preflight elapsed | 43.24 ms |
| Health heap delta | 2,073,848 bytes |

The scale run also reported clean foreign-key and integrity checks, complete
large Undo Apply scope, and no N+1 planner shape.

## 17. Executed Test Evidence

The following results were actually executed before this documentation-only
closure candidate was prepared at the clean evidence HEAD:

| Command / evidence | Actual result |
| --- | --- |
| `node scripts/phase21-undo-rehearsal.mjs` | PASS; final JSON recorded in §19 |
| `npm run typecheck` | PASS |
| `npm run build` | PASS; existing Rolldown pure-annotation and large-chunk warnings only |
| `npm run test` | PASS; 205 files, 3,015 passed, 2 skipped, 0 failures |
| `npm run test:tags-scale` | PASS; 2 files / 6 tests |
| `npm run test:e2e` | PASS; 28 tests |
| `npm run test:e2e:auth` | PASS; 2 tests |
| `npx playwright test e2e/tag-management.spec.ts` | PASS; 4 tests |
| Focused History/API batch: `history-routes.test.ts`, `history-git.test.ts`, `history-folder-coordination.test.ts`, `tagUndoFoundation.test.ts`, `metadata-api.test.ts`, `tools.test.ts` | PASS; 6 files / 320 tests |
| `npx vitest run server/__tests__/tagUndoFoundation.test.ts` | PASS; 35 tests |
| `npx vitest run server/__tests__/crashRecovery.test.ts` | PASS; 138 tests |
| `git diff --check` | PASS |
| `git status --short` at evidence HEAD | PASS; clean |

The product suite was not rerun solely to write this documentation-only
record. The result above is the factual T2.1-6 execution evidence, not a new
T2.1-7 product test run.

## 18. CI, Cross-Platform, and Docker Factual Status

The configured `.github/workflows/ci.yml` matrix is:

- `verify`: Ubuntu Node 24, macOS Node 24, Windows Node 24, Ubuntu Node 22;
- `tags-scale`: Ubuntu Node 24;
- `docker-smoke`: Ubuntu Node 24;
- `auth-browser`: Ubuntu Node 24;
- `visual`: macOS Node 24.

Exact final-SHA status:

```text
95aad84ab22adae4435bb6c48bc58c3719f84ff3 GitHub CI: UNVERIFIED
```

No Actions result for exactly `95aad84...` was established while preparing
this record. Earlier baseline or other-SHA CI evidence is not relabeled as
evidence for this SHA. This record therefore does not call CI green or claim
that all OS lanes are green.

Local Docker status:

```text
NOT RUN — Docker environment unavailable
Docker client could not connect to:
/Users/txx/.docker/run/docker.sock
```

The Docker deployment-auth command was not marked PASS. This is an environment
evidence limitation, not a discovered product defect, and it remains distinct
from the external T2.1-6 defect audit. It does not retroactively make Docker
or exact-SHA CI green.

## 19. Real Backup, Upgrade, Restore, and History Rehearsal

The disposable rehearsal was executed from the committed T2.1-6 evidence
checkout. It used isolated temporary vault/data copies and historical runtime
worktrees, not the developer's live vault or data directory.

Historical runtime references used by the rehearsal:

| Runtime role | Full SHA |
| --- | --- |
| Phase 2 baseline | `99f4d73154349f8ebc99cb609f1a88b07937fb26` |
| T2.1-0 foundation | `ad5d88adc4a28b3de5e1d290356a60bc542e1309` |
| T2.1-1 activation | `9220d634e0d4da7230dafa61c02e92107447af0c` |
| Reviewed production behavior | `2fce11a227055ffa6402096af12d50a3859f604c` |

The actual final output was:

```json
{
  "status": "PASS",
  "phase2Baseline": "99f4d73154349f8ebc99cb609f1a88b07937fb26",
  "foundation": "ad5d88adc4a28b3de5e1d290356a60bc542e1309",
  "activation": "9220d634e0d4da7230dafa61c02e92107447af0c",
  "current": "2fce11a227055ffa6402096af12d50a3859f604c",
  "evidence": {
    "isolatedOldRuntime": true,
    "completeBackupAndRestore": true,
    "noReverseMigration": true,
    "activationBoundary": true,
    "sessionRevocationOnRestoredStartup": true,
    "applicationHistoryRestore": true
  }
}
```

The rehearsal verified, in order:

1. an isolated old Phase 2 runtime and a real v6 database;
2. owner authentication, representative tags/memberships, an orphan tag, and
   deterministic application History H1/H2;
3. a complete backup containing the vault, hidden `.git`/`.nuvyn` state, and
   full data directory;
4. current migration to schema version 8 with logical IDs/memberships,
   association IDs, FK/integrity health, and no migration-created Undo record;
5. T2.1-0 foundation-only and T2.1-1 activation boundaries;
6. first current ordinary operation, durable record, authoritative Preview,
   committed Undo, consumed state, later summary preservation, Markdown
   SHA/mtime preservation, Git preservation, and unchanged application History;
7. complete restore to v6 before old runtime startup;
8. restored-startup session revocation, owner login, representative
   tags/memberships, clean FK/integrity state, original History H1/H2, and the
   absence of the Undo endpoint;
9. no reverse migration or identity reconstruction.

The isolated fixture contained no encrypted AI credential requiring a matching
master key. Master-key rehearsal status is therefore **N/A**, not PASS.

## 20. Backup, Rollback, and Operator Instructions

The maintained operator authority is
[`docs/deployment/backup-and-restore.md`](../../deployment/backup-and-restore.md).
The Phase 2.1 operator contract is:

### Before upgrade

- Stop or quiesce Nuvyn writers, or use a SQLite-aware point-in-time snapshot.
- Back up the complete vault, including hidden `.git` and `.nuvyn` content.
- Back up the complete data directory, including WAL/SHM state when applicable;
  never copy only a live `nuvyn.db` main file.
- Preserve the matching external or managed master key when applicable.
- Verify the backup with SQLite integrity/foreign-key checks and retain it
  until operator acceptance.
- Record the old application/runtime version or SHA.

### Upgrade and acceptance

- Start one matching current client/server image or runtime.
- Wait for startup migration and health initialization to complete.
- Verify schema/migration/Undo health, `/api/health`, authentication, and
  representative vault/tags/memberships.
- Run a representative server Preview and explicit Undo confirmation.
- Do not delete the pre-upgrade backup before acceptance and observation.

### Rollback after a successful v7/v8-era upgrade

1. Stop the new runtime and prevent new writes.
2. Restore the matching complete pre-upgrade database/data and vault backup.
3. Start the matching old application/runtime with the matching key
   configuration.
4. If the restored authentication state is older or untrusted, set
   `NUVYN_AUTH_REVOKE_SESSIONS_ON_START=1` for the first startup as described
   by the deployment guide, then return it to normal.
5. Verify health, authentication, representative documents/tags,
   memberships, History, and integrity.

There is no reverse migration. Do not run an older application against a
successfully consolidated live database without first restoring the matching
pre-upgrade backup.

## 21. Application History Closure

Raw Git preservation and Nuvyn History application behavior are separate
claims. The final rehearsal used the real application/API History seam:

```text
POST /api/history/commits
GET  /api/history/log
GET  /api/history/file
```

The old runtime created deterministic revisions for `inbox/note.md`:

- H1 subject `phase21 history H1`, content `Phase 2.1 History H1\n`;
- H2 subject `phase21 history H2`, content `Phase 2.1 History H2\n`.

The same public History evidence was verified:

1. on the old Phase 2 baseline before backup;
2. on the current runtime after migration and before Tag Management;
3. after current ordinary Tag Management and committed Undo;
4. after complete restore and matching old-runtime startup.

Tag Management and Undo did not create, alter, or remove an application
History revision. The rehearsal also compared the Git HEAD, Git status, and
raw file SHA/mtime independently.

## 22. Protected-Area Matrix

| Protected area | Invariant | Evidence | Result |
| --- | --- | --- | --- |
| Markdown bytes | Tag Management/Undo do not write document bodies | `tagManagement.test.ts` boundary test, production browser flows, rehearsal SHA comparison | PASS |
| Frontmatter | Tag Management/Undo are SQLite metadata-only and do not rewrite frontmatter | Existing management/file-boundary contract plus no server file operation in the reviewed diff; complete raw-file preservation in E2E/rehearsal | PASS |
| mtime | Metadata-only management does not change Markdown mtime | `tagManagement.test.ts`, `e2e/tag-management.spec.ts`, rehearsal mtime comparison | PASS |
| Git HEAD | Management/Undo do not commit or reset vault Git | boundary test, browser Git snapshots, rehearsal Git baseline | PASS |
| Git working tree | Management/Undo do not dirty or rewrite the vault worktree | boundary test, browser Git snapshots, rehearsal status | PASS |
| Nuvyn History | No management/Undo History entry; restored old History remains readable | Real H1/H2 API evidence in §21 | PASS |
| Link index | Tag metadata does not rebuild or mutate link index | `tagManagement.test.ts` boundary test | PASS |
| `fileChanges` | No metadata operation emits file-change events | `tagManagement.test.ts` boundary test | PASS |
| Draft Recovery | Existing browser-local recovery ownership remains unchanged | Full unit/recovery/E2E evidence; no Draft Store or recovery production files changed in T2.1 | PASS |
| Phase 1 Tag Query | Query/filter semantics remain unchanged | `src/components/vault/__tests__/TagPanel.test.ts` existing Phase 1 filter/selection cases; full suite | PASS |
| TagPanel | Remains the Phase 1 projection and manager entry point | `TagPanel.test.ts`: `exposes Manage Tags without changing the Phase 1 filter or selection state` | PASS |
| FileTree | No Tag Management mutation or ownership transfer | Full unit/browser suite and no FileTree production change in T2.1 | PASS |
| `PostSummary.tags` | Shape and ordinary query behavior remain unchanged | Full unit/browser suite; no shape change in reviewed implementation | PASS |
| Editor Undo | No editor state mutation or global Ctrl/Cmd+Z binding | `VaultView.test.ts`: `keeps Monaco mounted and isolates shortcuts for read-only history tabs`; source audit | PASS |
| Authentication | Existing owner/auth/CSRF boundary remains in force | `tagUndo-api.test.ts` auth/CSRF/no-store cases; auth E2E; restored-startup revocation rehearsal | PASS |
| Docker architecture | Atomic SPA/server image and existing Compose wiring remain unchanged | `.github/workflows/ci.yml` Docker lane configuration and source audit; local Docker runtime was unavailable | ARCHITECTURE UNCHANGED; LOCAL RUNTIME NOT RUN |

## 23. Security Closure

The executed and reviewed security evidence covers:

- unauthenticated access to all four Undo endpoints;
- authenticated JSON, same-origin CSRF, and `no-store` boundaries;
- strict unknown-field, positive-bound, opaque-record-ID, and lowercase
  fingerprint validation;
- malformed, uppercase, non-hex, unsafe, and out-of-range values;
- cross-generation and invalid foundation state fail-closed behavior;
- safe public codes for stable-ID, identity, document, association, post-state,
  stale, superseded, consumed, terminal, and unavailable outcomes;
- bounded availability/Preview that excludes child scope and physical IDs;
- sanitized unexpected failures without raw SQL, SQLite constraint text,
  filesystem paths, stack traces, Markdown bodies, or secrets.

Named evidence includes the authenticated boundary and error cases in
`server/__tests__/tagUndo-api.test.ts`, the existing `tags-api.test.ts`
security boundary, `src/lib/__tests__/tag-undo-api.test.ts` strict client
guards, and foundation health tests. No new permission model or credential
storage was introduced.

## 24. Concurrency and Atomicity Closure

The evidence is not based on a same-process mutex masquerading as concurrency
proof. It includes independent SQLite WAL connections and independent Node
runtime processes.

Covered invariants include:

- deferred Preview/read snapshots while another WAL connection commits;
- relevant writer changes rejected after Preview or after path discovery;
- ordinary Apply race serialization with one commit and one stale loser;
- Undo Apply duplicate race with at most one inverse commit;
- Undo versus ordinary Apply serialization and safe loser re-planning;
- operation-owned association delete/re-add race rejection by physical ID;
- dynamic conflict clear followed by fresh Preview;
- deterministic failure-injection rollback before commit;
- committed response/refresh ambiguity handled by read-only recovery.

Evidence is in `server/__tests__/tagManagement.test.ts`,
`server/__tests__/tagUndo.test.ts`, the two WAL worker fixtures, and the
focused crash/recovery suites.

## 25. Compatibility

Compatibility is limited to the approved contracts; arbitrary mixed-version
operation is not promised.

| Combination | Required behavior | Evidence |
| --- | --- | --- |
| Old Phase 2 client + new server | Existing ordinary Rename/Display Rename/Merge/Remove requests remain safe; the new server records supported ordinary operations; old client does not expose Undo | Rehearsal accepts the old ordinary Merge request shape; `records the unchanged old-client Apply shape entirely server-side` |
| New Undo client + old Phase 2 server | Undo endpoint absence/legacy unavailability becomes safe unavailable; no fallback mutation or guessed inverse | `src/lib/__tests__/tag-undo-api.test.ts`: old-server 404/legacy 503 safe-unavailability cases; restored old-runtime rehearsal gets HTTP 404 |
| New client + malformed/unsupported record | Terminal or unavailable state; no mutation | Foundation health/lifecycle and client strict response tests |
| Atomic current image | Client and server ship from one production image | Existing build/deployment architecture; no Docker architecture change |

A hard browser refresh may be required after deployment. Old full metadata
writes without the current Phase 2 version token remain fail-closed under the
existing writer contract.

## 26. Retention and Storage

The user-facing storage model is deliberately single-level:

```text
one current parent
+ current heavy child delta
+ one compact previous superseded record ID
```

Only the latest successful ordinary operation is exposed. A later successful
ordinary operation deletes the previous heavy parent/children after recording
the compact superseded ID. Successful Undo marks the current parent consumed
and purges heavy child deltas. There is no durable Redo target, arbitrary
history browser, event-sourcing log, or unbounded operation stack.

## 27. Known Limitations and Deferred Scope

The following are approved exclusions or factual evidence limitations, not
unexplained product defects:

- Redo: DEFERRED / NOT IMPLEMENTED.
- Global Ctrl/Cmd+Z: NOT IMPLEMENTED.
- Arbitrary management history: NOT IMPLEMENTED.
- Undo for operations before Phase 2.1 activation: NOT AVAILABLE.
- Reverse migration: NOT IMPLEMENTED / NOT SUPPORTED.
- Client-supplied inverse scope: NOT SUPPORTED.
- Markdown, Frontmatter, or Git rollback: NOT PART OF TAG MANAGEMENT UNDO.
- Local Docker execution at the final evidence run: NOT RUN — daemon/socket
  unavailable.
- Exact final-SHA GitHub CI: UNVERIFIED.
- Master-key rehearsal: N/A because the isolated fixture had no encrypted
  credential requiring a matching key.

These limitations do not create a second Undo level or change the approved
Phase 2.1 product contract.

## 28. No-Open-Defect Audit

The final reviewed state reported for T2.1-6 is:

```text
P0: 0
P1: 0
P2: 0
P3: 0
Unexplained P2: 0
Architecture / PRD Conflict: NONE
Phase scope violation: NONE
Owning-phase product defect: NONE
Known flake: NONE
```

Known environment evidence limitations are:

- local Docker daemon unavailable;
- exact final-SHA GitHub CI unverified.

An environment evidence limitation is not a product defect, but it also is
not converted into PASS evidence. The external closure reviewer must make the
final judgment with these limitations visible.

## 29. Rollout and Operator Checklist

### Pre-upgrade

- [ ] Stop/quiesce writers or establish a consistent SQLite-aware snapshot.
- [ ] Back up the complete vault, including hidden `.git` and `.nuvyn`.
- [ ] Back up the complete data directory and active WAL/SHM state as needed.
- [ ] Preserve the matching master key/configuration when applicable.
- [ ] Verify integrity/foreign keys and record the old runtime/SHA.
- [ ] Keep the backup until acceptance is complete.

### Upgrade

- [ ] Start the matching current image/runtime.
- [ ] Wait for migration and startup health to complete.
- [ ] Verify `/api/health`, authentication, schema/Undo health, representative
      documents, tags, and memberships.
- [ ] Run a representative Undo Preview and explicit confirmation.
- [ ] Confirm later unrelated metadata remains preserved.

### Post-upgrade

- [ ] Monitor health, stale/conflict diagnostics, migration diagnostics, and
      representative tag operations.
- [ ] Retain and re-verify the pre-upgrade backup until operator acceptance.

### Rollback

- [ ] Stop the new runtime and prevent writers.
- [ ] Restore the matching complete pre-upgrade backup.
- [ ] Start the matching old runtime/image with matching key configuration.
- [ ] Optionally revoke restored sessions using the documented startup flag.
- [ ] Verify health, auth, vault/tags/memberships, History, and integrity.
- [ ] Do not run a reverse migration.

## 30. Final Traceability

| Approved contract | Owning phase | Primary implementation/schema | Evidence | Status |
| --- | --- | --- | --- | --- |
| Single-level durable latest target | T2.1-0/1/4 | `tag_undo_state`, `tag_undo_records` | Lifecycle/supersession tests; rehearsal | PASS |
| Refresh/restart durability | T2.1-0/2/4/6 | SQLite parent/state and startup health | Availability/restart/rehearsal evidence | PASS |
| Atomic ordinary Apply recording | T2.1-1 | `server/tagManagement.ts`, record tables | Record/transition rollback and activation evidence | PASS |
| Association provenance and delete→re-add | T2.1-0/1/2/3 | `document_tags.association_id`, delta children | REST/AI writer and provenance cases AH–AK | PASS |
| Rename/Display Rename inverse | T2.1-2/3/5 | Planner, `server/tagUndo.ts`, dialog | A/B/P tests and browser flow | PASS |
| Merge source-only/overlap/destination-only | T2.1-1/2/3 | Delta effects and inverse planner | C/D/E/Q/R tests | PASS |
| Remove/orphan/stable ID | T2.1-2/3 | Explicit tag restore and child delta | F/G/H/I/J/K tests | PASS |
| Later-change preservation | T2.1-2/3/6 | Relevant fingerprint and set inverse | L/M/N/O/P tests and rehearsal | PASS |
| Dynamic non-consuming conflict | T2.1-2/3 | Lifecycle/validation split | S/T tests | PASS |
| Mandatory Preview and confirmation | T2.1-4/5 | Undo routes/client/dialog/ConfirmHost | Component and production browser | PASS |
| Exactly-once and sync-pending | T2.1-3/4/5 | Consumed state and recovery seams | Y/Z/AA and request-count tests | PASS |
| Monotonic metadata versions | T2.1-1/3 | Existing helper and affected-document staging | Version tests and inverse tests | PASS |
| Auth/CSRF/no-store/sanitized errors | T2.1-4/6 | Existing auth boundary and Undo routes | API/security suites | PASS |
| Accessibility and i18n | T2.1-5/6 | Dialog/ConfirmHost/useI18n | Component/browser zh/en/a11y tests | PASS |
| Scale and no N+1 | T2.1-0/1/2/3/6 | Set-based SQL/temp tables/scale suite | 10k/50k observations | PASS |
| Migration/backup/restore/downgrade | T2.1-0/6/7 | 0007/0008, startup, operator guide | AD and actual rehearsal | PASS with Docker limitation recorded |
| Legacy v6 recovery compatibility | T2.1-0/6 | Version-aware recovery parser/normalizer | AL/AM and crash recovery suite | PASS |
| Phase 2.1 activation boundary | T2.1-0/1 | Foundation health then reversible-record health | AN/AO/AP and rehearsal | PASS |
| Compatibility and protected areas | T2.1-4/6/7 | Atomic image and existing seams | AE/AF/AG, full suite, History rehearsal | PASS with exact-SHA CI unverified |
| Redo deferral / no global shortcut | Product boundary | No Redo state/request; editor-owned shortcuts | PRD/Plan non-goals and AG evidence | PASS / deferred as approved |

No major approved requirement is intentionally unaccounted for in this
record.

## 31. Closure Review Checklist

- [x] PRD authority identified.
- [x] Implementation Plan authority identified.
- [x] Production baseline identified as `2fce11...`.
- [x] Evidence HEAD identified as `95aad84...`.
- [x] T2.1-0 through T2.1-6 externally passed/frozen.
- [x] Exact authority and implementation commit inventory verified.
- [x] A–AP mapped with zero missing cases.
- [x] Migration and association provenance evidence recorded.
- [x] Ordinary atomic recording evidence recorded.
- [x] Undo planner and fingerprint evidence recorded.
- [x] Undo Apply and stable-ID inverse evidence recorded.
- [x] Public API/client evidence recorded.
- [x] UI, accessibility, and i18n evidence recorded.
- [x] Exactly-once and recovery evidence recorded.
- [x] Scale observations recorded as observational, not SLA.
- [x] Real backup/upgrade/restore evidence recorded.
- [x] Application History evidence recorded through the real API seam.
- [x] Protected-area audit recorded.
- [x] Security evidence recorded without unsupported claims.
- [x] Compatibility and operator rollback instructions recorded.
- [x] Redo deferred and reverse migration unsupported.
- [x] P0/P1/P2/P3 defect state recorded as zero.
- [x] Architecture / PRD Conflict recorded as NONE.
- [ ] Final external T2.1-7 closure review PASS.

The external T2.1-7 closure review is explicitly pending. This checklist does
not self-approve the phase.

## 32. Closure Candidate Status

```text
T2.1-7 CLOSURE CANDIDATE READY FOR EXTERNAL REVIEW

P0: 0
P1: 0
P2: 0

Architecture / PRD Conflict: None
T2.1-0 through T2.1-6: PASS / FROZEN
External T2.1-7 review: PENDING
Phase 2.1: NOT YET DECLARED COMPLETE
```

T2.1-7 CLOSURE CANDIDATE COMPLETE — AWAITING EXTERNAL FINAL REVIEW
PHASE 2.1 NOT YET DECLARED COMPLETE
