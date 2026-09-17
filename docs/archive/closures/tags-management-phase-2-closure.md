# Nuvyn Tags Management Phase 2 Closure

Final closure review completed.
Tags Management Phase 2 COMPLETE.

## 1. Closure Status

| Field | Value |
| --- | --- |
| Status | Final Closure — Complete |
| Phase | Tags Management Phase 2 / T2-7 Closure and Rollout Evidence |
| Approved PRD | [`docs/design/tags-management-prd.md`](../../design/tags-management-prd.md) |
| Approved implementation plan | [`docs/design/tags-management-implementation-plan.md`](../../design/tags-management-implementation-plan.md) |
| T2-0 implementation comparison baseline | `f9a79c9be2723f2b163486b743e91792e1471393` |
| Release-candidate implementation HEAD | `99f4d73154349f8ebc99cb609f1a88b07937fb26` — `test(tags): harden phase 2 tag management` |
| Closure date | 2026-08-16 |

This closure record does not modify the Approved PRD or the Approved
Implementation Plan. The release-candidate implementation HEAD remains the
production-code baseline; the closure commit is documentation-only.

## 2. Executive Result

The release candidate provides four server-authoritative management flows:

- Rename a tag while preserving its stable source ID and associations.
- Display Rename a tag without changing its canonical identity.
- Merge one stable-ID source tag into one stable-ID destination tag, including
  overlap deduplication and destination ownership.
- Remove one stable-ID source tag from all document associations and delete the
  global tag row while preserving documents and Markdown files.

The implemented safety architecture is:

- one shared `tag-identity-v1` identity/display contract;
- stable-ID management and operation requests;
- mandatory read-only Preview from the server planner;
- deterministic, fingerprint-bound Apply;
- one locked, atomic SQLite mutation with strict document-version updates;
- one authoritative post-commit synchronization cycle;
- stable-ID selected-tag reconciliation with a selection-epoch race detector;
- synchronization-only retry after a committed operation;
- fail-closed management health for migration or identity invariant failures.

Undo, a durable operation history, and reverse identity migration are not part
of this release candidate.

## 3. Authority and Scope Compliance

The implementation and evidence were checked in this order:

```text
Approved PRD > Approved Implementation Plan > implementation
```

The approved documents remain authoritative. No implementation decision in this
record reinterprets or supersedes them.

```text
Architecture / PRD Conflict: None
```

The closure record is confined to T2-7 evidence, release instructions,
compatibility notes, limitations, and the explicit Phase 2.1 deferral. It does
not add product behavior, a new API, a new state store, or a new mutation
authority.

## 4. Implementation Commit Inventory

The ordered inventory below starts at the plan's approved T2-0 comparison
baseline and ends at the release-candidate implementation HEAD. SHA links point
to the repository history.

| Phase | Commit | Subject | Purpose |
| --- | --- | --- | --- |
| T2-0 | [`e107fc0`](https://github.com/tangxiangxiang/nuvyn/commit/e107fc0f4226c3e69ba7e18759c5e2261fb03343) | `feat(tags): implement phase 2 identity and writer safety foundation` | Shared identity/display contract, monotonic metadata versions, scoped metadata writers, migration startup path, and initial safety tests. |
| T2-0 | [`319d2bd`](https://github.com/tangxiangxiang/nuvyn/commit/319d2bd422017e8a5c2a4463111e9b7fa54431a5) | `fix(tags): harden phase 2 identity migration safety` | Strengthened migration transaction, marker, validation, rollback, retry, and health-gate behavior. |
| T2-0 | [`2e3a9d1`](https://github.com/tangxiangxiang/nuvyn/commit/2e3a9d1f19388f3b3587b722f7420bb4c6731c3d) | `fix(tags): preserve identity migration failure diagnostics` | Preserved sanitized failure state and diagnostics while keeping management unavailable. |
| T2-1 | [`86c0816`](https://github.com/tangxiangxiang/nuvyn/commit/86c08165bff53403dd8f812c5585549784ad9a50) | `feat(tags): add phase 2 planner and preview` | Added stable-ID read model, set-based planner, read-only Preview, canonical fingerprints, and health-gated routes. |
| T2-1 | [`32d4f41`](https://github.com/tangxiangxiang/nuvyn/commit/32d4f41cefe0010a390c54dd8f12db7fa30a9011) | `fix(tags): harden phase 2 planner and preview` | Hardened snapshot consistency, pagination, stale continuation, input validation, and query-shape evidence. |
| T2-1 | [`b3ec972`](https://github.com/tangxiangxiang/nuvyn/commit/b3ec972de084650556d3f028899b41c0bf58abf8) | `test(tags): stabilize 10k health preflight evidence on Windows` | T2-1 planner/Preview gate-support for the large-vault health preflight; this predates T2-2. |
| T2-2 | [`8f46267`](https://github.com/tangxiangxiang/nuvyn/commit/8f4626705f6d7846006c833479f58472a561cba8) | `feat(tags): add atomic phase 2 tag operations` | Added one-transaction Rename, Display Rename, Merge, and Remove Apply semantics and API wiring. |
| T2-2 | [`54556e5`](https://github.com/tangxiangxiang/nuvyn/commit/54556e5a1d333180b339eab3915e89b9e7404da3) | `test(tags): expand atomic apply evidence` | Added atomicity, version, duplicate-Apply, stale-writer, and rollback evidence. |
| T2-2 | [`48ed954`](https://github.com/tangxiangxiang/nuvyn/commit/48ed954120b9157874df86abf70e3c6d1df0bc8a) | `fix(tags): harden atomic apply review evidence` | Added the scale lane and tightened planner/Apply evidence and CI discovery. |
| T2-2 | [`38e641a`](https://github.com/tangxiangxiang/nuvyn/commit/38e641a49948494a3171cac90ec9736719ed6cac) | `test(tags): stabilize scale worker lifecycle` | Temporary tags-scale worker-lifecycle adjustment during the T2-2 scale/CI evidence period. |
| T2-2 | [`90955cf`](https://github.com/tangxiangxiang/nuvyn/commit/90955cf6a7f2000337af80e36224278eb12cabd0) | `Revert "test(tags): stabilize scale worker lifecycle"` | T2-2 scale/CI support; explicitly reverted the temporary worker-lifecycle experiment. |
| T2-2 | [`05338c0`](https://github.com/tangxiangxiang/nuvyn/commit/05338c0e23ea9b7004c291b1169d9fcfa4c22687) | `fix(deps): update better-sqlite3 to version 12.11.1 and increase timeout for write route tests` | T2-2/cross-platform CI compatibility support before T2-3; removed the Node 24 native teardown risk and stabilized long write-route tests. |
| T2-3 | [`dd75cad`](https://github.com/tangxiangxiang/nuvyn/commit/dd75cadc1e018c0ea1e912c156e4d57bd6aa0d35) | `feat(tags): add phase 2 rename management shell` | Added the dialog shell, typed client API, Rename flow, accessibility foundation, and bilingual management copy. |
| T2-3 | [`fd9bde7`](https://github.com/tangxiangxiang/nuvyn/commit/fd9bde75181fcfa1cc0224bf7bd20e0921f2f6ac) | `fix(tags): complete phase 2 rename UI contract` | Added Display Rename, Preview invalidation, production-owned dialog seam, harness, and Rename browser evidence. |
| T2-4 | [`15087f7`](https://github.com/tangxiangxiang/nuvyn/commit/15087f7f9672e7100f3ecf0f0ef4e36081d3586b) | `feat(tags): add phase 2 merge management UI` | Extended the reviewed manager with stable-ID destination selection, overlap Preview, Merge Apply, and reconciliation. |
| T2-4 | [`e62bc4b`](https://github.com/tangxiangxiang/nuvyn/commit/e62bc4b2e013c73c4ac6bb8ccd0c3135362e930c) | `fix(tags): close phase 2 merge UI contract` | Closed Merge destination, counts, API-shape, and UI regression evidence. |
| T2-4 | [`8631593`](https://github.com/tangxiangxiang/nuvyn/commit/8631593df5c77368f931ba1a0f7afbeb0a66e1b9) | `fix(tags): preserve committed merge recovery semantics` | Preserved committed-result semantics when synchronization or protocol validation fails. |
| T2-4/T2-5 seam | [`1467e6b`](https://github.com/tangxiangxiang/nuvyn/commit/1467e6b5cd4abd1e8a44da4e33c4a263a4d6fa24) | `fix(tags): centralize committed tag recovery` | Centralized trusted-operation recovery and stable-ID reconciliation used by Merge and Remove. |
| T2-5 | [`99fb454`](https://github.com/tangxiangxiang/nuvyn/commit/99fb4546ddc2e53a85632a9bfebb977b4f3e0058) | `feat(tags): add remove management UI` | Added destructive Remove Preview, confirmation, synchronization, selection clearing, production entry, i18n, and browser flow. |
| T2-5 | [`af45beb`](https://github.com/tangxiangxiang/nuvyn/commit/af45beb8594bc78def03e9997908417d398d8ef7) | `test(tags): close phase 2 remove UI gate` | Added Remove-specific zh/en copy and production confirmation keyboard coverage. |
| T2-5 | [`0042be5`](https://github.com/tangxiangxiang/nuvyn/commit/0042be55dd446053a3bc5b91bf213109e208448d) | `test(tags): assert remove apply exactly once` | Proved the production Remove flow sends exactly one Apply after Escape cancellation. |
| T2-6 | [`99f4d73`](https://github.com/tangxiangxiang/nuvyn/commit/99f4d73154349f8ebc99cb609f1a88b07937fb26) | `test(tags): harden phase 2 tag management` | Added the final hardening matrices for stale writers, health, security, browser boundaries, recovery, and cross-phase regression. |

The plan-only commits before `e107fc0` are authority history, not Phase 2
implementation commits. The unrelated folder-move crash-fixture commit
`beb4a975` is intentionally excluded. No history was rewritten.

## 5. T2-0 through T2-6 Acceptance Evidence Matrix

All rows below have named test, CI, or rehearsal evidence. No safety invariant
was waived.

| Phase | Gate | Evidence | Result |
| --- | --- | --- | --- |
| T2-0 | One shared `tag-identity-v1` implementation; no SQLite `LOWER()` or locale-dependent identity path | `shared/__tests__/tagNormalization.test.ts`, `shared/tagNormalization.ts`, `server/tagIdentityMigration.ts`, and the T2-0 migration suite | PASS |
| T2-0 | `java/#java` and `Java/JAVA` consolidation preserves logical membership and lowest-ID survivor | `server/__tests__/tagIdentityMigration.test.ts` — `T2-0 tag identity migration`; rehearsal §7 identity graph | PASS |
| T2-0 | One IMMEDIATE migration transaction, marker-last, retry-safe, idempotent, and rollback-safe | `server/__tests__/tagIdentityMigration.test.ts`; `server/__tests__/metadata-api.test.ts` migration marker cases; rehearsal §7 failure/retry | PASS |
| T2-0 | Invalid historical identity fails closed without data deletion | Migration invalid-identity tests and health-gate tests in `server/__tests__/tagIdentityMigration.test.ts` | PASS |
| T2-0 | REST, AI, import, lifecycle, and recovery writers are field-scoped and version-safe | `server/__tests__/metadata-api.test.ts`, `server/__tests__/documentMetadata.test.ts`, `server/__tests__/tools.test.ts`, `server/__tests__/put.test.ts` | PASS |
| T2-0 | Strictly monotonic document versions and Phase 1 behavior remain green; management remains hidden | `server/__tests__/metadataVersion.test.ts`, full `npm test`, CI verify matrix, and production-entry E2E gate | PASS |
| T2-1 | Preview is read-only, internally snapshot-consistent, fingerprinted, paginated, and bounded | `server/__tests__/tagManagement.test.ts` — `keeps Preview read-only`, deferred WAL snapshot, fingerprint, pagination, and stale continuation cases | PASS |
| T2-1 | Relevant changes stale a Preview; unrelated graph changes do not | `server/__tests__/tagManagement.test.ts` — relevant graph, unrelated orphan, two-connection, and continuation cases | PASS |
| T2-1 | Set-based planning has constant query shape and no N+1 at 10k/50k scale | `server/__tests__/tagManagement.test.ts` — `keeps planner query shapes constant as the affected set grows`; `server/__tests__/tagManagement.scale.test.ts`; `tags-scale` CI job | PASS |
| T2-1 | Health-gated read model and live-file completeness check are present; no UI/Apply exposure before the gate | `server/__tests__/tags-api.test.ts` — auth/health and live Markdown cases; commit inventory and production-entry E2E | PASS |
| T2-2 | Rename, Display Rename, Merge, and Remove are all-or-nothing in one Apply transaction | `server/__tests__/tagManagement.test.ts` — atomic Apply, exact versioning, failure injection, and postcondition cases | PASS |
| T2-2 | Fingerprint is rechecked after locks; duplicate Apply yields one commit and one stale result | `server/__tests__/tagManagement.test.ts` — `rechecks the fingerprint after locks`, `serializes two Apply calls`, and duplicate Apply cases | PASS |
| T2-2 | Remove preserves documents and unrelated associations; versions affected documents once | `server/__tests__/tagManagement.test.ts` Remove cases and production Remove E2E | PASS |
| T2-2 | Markdown, mtime, `fileChanges`, link index, settings, and Git are outside Apply scope | `server/__tests__/tagManagement.test.ts` — `keeps Markdown bytes, mtime, fileChanges, link index, Git, settings, and the success log outside Apply mutation scope`; browser E2E boundary assertions | PASS |
| T2-2 | REST/AI stale writers cannot replay a prior association set | `server/__tests__/metadata-api.test.ts`, `server/__tests__/tools.test.ts`, and `server/__tests__/tagManagement.test.ts` stale-writer matrix | PASS |
| T2-3 | Rename/Display Rename Preview, Apply, conflict, invalidation, accessibility, i18n, and sync behavior | `src/components/vault/__tests__/TagManagementDialog.test.ts` Rename/Display Rename suites; `src/views/__tests__/VaultView.test.ts`; Rename E2E | PASS |
| T2-3 | Selected Rename source follows fresh stable ID; user selection races win | `src/lib/__tests__/tag-selection-reconciliation.test.ts`; `TagManagementDialog.test.ts` selection-epoch cases | PASS |
| T2-4 | Merge destination, overlap/dedupe, destination survivor, stale handling, and production flow | `TagManagementDialog.test.ts` Merge suites; `server/__tests__/tagManagement.test.ts`; Merge E2E | PASS |
| T2-4 | Committed Merge sync failure and protocol mismatch recover without re-Apply | `TagManagementDialog.test.ts` committed recovery/sync-pending cases; `src/lib/__tests__/tag-selection-reconciliation.test.ts` | PASS |
| T2-5 | Remove Preview, exact source, destructive explanation, orphan support, confirmation, and i18n | `TagManagementDialog.test.ts` — Remove Preview, orphan, confirmation, and Remove-specific locale cases | PASS |
| T2-5 | Production entry, keyboard confirmation, Escape cancellation, focus restoration, and exactly-once Apply | `e2e/tag-management.spec.ts` — `production Remove previews, confirms once, clears selection, and preserves files`; commits `af45beb` and `0042be5` | PASS |
| T2-5 | Remove selected-source clearing, unrelated selection preservation, stale, sync-pending, and committed recovery | `tag-selection-reconciliation.test.ts`, `TagManagementDialog.test.ts`, and Remove browser assertions | PASS |
| T2-6 | REST/AI writer, concurrency, security, accessibility, browser, scale, and cross-platform hardening | `99f4d73` test additions; full local lanes; CI #336/run `31886374022` | PASS |
| T2-6 | Actual isolated backup → migration → health failure → fail-closed → retry → restore rehearsal | §7 of this record; disposable T2-6 rehearsal execution | PASS |
| T2-6 | Docker, packaged auth, dedicated auth browser, visual, Node/OS matrix, and Draft Store evidence | CI job table in §16 and the verified successful step list | PASS |

## 6. Identity and Migration Closure

The persistent identity contract is `tag-identity-v1`:

```text
trim
→ remove exactly one leading #
→ trim
→ toLowerCase()
```

No NFKC normalization is applied. Internal whitespace, CJK, slash, dash,
underscore, and other accepted characters remain distinct according to the
approved contract.

Migration behavior is deterministic:

- every legacy row is normalized using the shared implementation;
- rows are grouped by canonical identity;
- the lowest existing `tags.id` is the survivor;
- the survivor's normalized display wins, with canonical identity only as a
  defensive fallback;
- associations are repointed and duplicate `(document, tag)` memberships are
  collapsed before losing tag rows are deleted;
- logical document/tag membership is preserved;
- orphan tags are normalized and retained as zero-count managed tags;
- affected document versions advance once, while orphan-only cleanup versions
  no document;
- the namespaced settings marker is written only after all verification passes;
- a completed marker causes a verified no-op rerun;
- a failed marker keeps management unavailable and permits a later retry;
- invalid historical identity or post-migration identity corruption fails
  closed rather than deleting data.

The migration and health code remain SQLite-authoritative. Markdown/frontmatter
is an import boundary for metadata discovery; it is not the Tag Management
mutation store.

The actual rehearsal used these pre-upgrade rows:

```text
id 1  Java    (legacy identity)
id 2  #java   (legacy identity)
id 3  JAVA    (legacy identity)
id 4  Python
id 5  Orphan
```

After startup migration, IDs 2 and 3 were consolidated into the lowest-ID
survivor ID 1 (`Java` / `java`), Python remained ID 4, and the orphan remained
ID 5. Six physical associations became four after one association move and two
duplicate collapses; the logical membership set was unchanged. The completion
marker was written only after verification and the resulting management health
was `healthy`.

The rehearsal also exercised a controlled failure after association repointing.
The transaction rolled back the graph and versions, left a non-complete
`failed` marker, and reported `TAG_IDENTITY_MIGRATION_FAILED`. After removing
the failure hook, rerunning the same startup path completed the migration and
returned health to `healthy`. A separate post-migration identity corruption
returned `TAG_IDENTITY_UNHEALTHY` and kept management unavailable.

## 7. Backup / Upgrade / Restore Rehearsal

### Actual execution

This was an executed T2-6 rehearsal, not a procedure-only review. A disposable
driver created a temporary production-like root under the OS temporary
directory, with an isolated SQLite database, WAL mode, Markdown vault, Git
fixture, representative tags, document rows, and `document_tags`. The driver
and temporary root were removed after the run; no real `data/nuvyn.db`, vault,
Docker volume, or Git working data was used.

Environment:

```text
OS: Darwin 25.5.0 arm64
Node: v24.15.0
Docker: 29.4.2 client/server
Isolation: OS temporary root; temporary data/vault/backup/failure/restore copies
Release-candidate implementation: 99f4d73154349f8ebc99cb609f1a88b07937fb26
Matching old production baseline: 20a4462d556e19ad0bbcec9709d1f579231a49d0
```

The old baseline was independently verified as the direct parent of the first
Phase 2 production commit:

```text
git rev-parse e107fc0f4226c3e69ba7e18759c5e2261fb03343^
→ 20a4462d556e19ad0bbcec9709d1f579231a49d0
```

The main working tree stayed on the release-candidate closure branch. A
separate disposable checkout was used for the old image because the runner's
`.git/worktrees` directory was not writable; this kept the old runtime and its
build context separate without checking the main tree backwards.

### Consistent backup

The pre-upgrade backup used the better-sqlite3 `Database.backup()` SQLite
backup API with writers stopped, while the source database was in WAL mode. The
matching vault tree was copied as a backup set with file modification times
preserved. This was not a live main-file-only copy.

Both the source and the backup returned:

```text
PRAGMA integrity_check;  -- ok
PRAGMA foreign_key_check; -- []
```

The pre-upgrade logical snapshot recorded tags, `document_tags`, documents and
`updated_at`, the absent migration marker, logical memberships, Markdown bytes,
Markdown mtimes, file paths, and file count.

### Upgrade and healthy verification

The current release-candidate image was built from the production tree with:

```text
docker build --tag nuvyn:t2-release-99f4d73 --file Dockerfile .
image ID: sha256:46f1aa3b3eeaaf32b9456184f06de939b3fa69f6eda5d7b6b3ff7a1f6dbfdcd2
```

The isolated driver then exercised the same startup sequence used by
production:

```text
migrateVaultMetadata()
→ initializeTagIdentityAndHealth()
```

It did not simulate migration by manually editing tables. The migration report
scanned four live Markdown documents with no failed imports; the identity
migration scanned five tag rows and completed consolidation. The post-upgrade
state had:

- one Java survivor at the lowest stable ID;
- duplicate physical memberships collapsed;
- the Python row and orphan row preserved;
- logical document membership unchanged;
- foreign keys clean and `integrity_check` equal to `ok`;
- completion marker present;
- management health `healthy`.

All fixture Markdown bytes and mtimes were unchanged. The expected affected
document metadata versions advanced only for documents whose tag associations
were consolidated; the files themselves were not rewritten.

The current image's `/api/health`, managed-tag list, posts, representative
metadata, and History reads all succeeded before the rollback step. Its
identity graph was Java ID 1, Python ID 4, and Orphan ID 5; the three legacy
Java spellings had one logical membership per affected document.

### Health failure and fail-closed behavior

The rehearsal introduced a supported identity-invariant failure by corrupting
the post-migration normalized identity for the Java row, then refreshed the
health evaluator. It returned:

```text
state: unavailable
code: TAG_IDENTITY_UNHEALTHY
reason: tag identity invariant verification failed
```

Authenticated list, Preview, and Apply requests all returned HTTP 503 with
`TAG_MANAGEMENT_UNAVAILABLE`. Ordinary `/api/health` and `/api/posts` remained
available. No Markdown write occurred.

On a fresh isolated copy, a migration failure was injected after association
repointing. The failure returned `TAG_IDENTITY_MIGRATION_FAILED`; the durable
marker was `failed`, not `complete`; tags, associations, documents, and
versions matched the pre-failure snapshot; and both integrity/FK checks stayed
clean. Removing the injection and rerunning startup succeeded, produced a
`complete` marker, and restored healthy management.

### Restore

After the successful-upgrade and failure/retry checks, the isolated upgraded
database was stopped and replaced with the matching pre-upgrade SQLite backup.
The matching pre-upgrade vault backup was restored with paths, bytes, and mtimes
preserved. Before starting any application, the restored database matched the
pre-upgrade snapshot exactly and returned `integrity_check = ok` with an empty
foreign-key check.

The restored state matched the pre-upgrade snapshot for:

- `tags` rows and IDs;
- `document_tags` rows;
- documents and `updated_at` values;
- logical memberships;
- migration-marker state;
- Markdown paths, bytes, file count, and mtimes.

The restored database again returned `PRAGMA integrity_check = ok` and an empty
`PRAGMA foreign_key_check` result.

### Matching old-image rollback execution

This rollback was executed, not inferred from reopening the files. The old
production image was built from `20a4462d556e19ad0bbcec9709d1f579231a49d0` with
the repository Docker production path:

```text
docker build --tag nuvyn:t2-prephase2-20a4462 --file Dockerfile .
image ID: sha256:322b948a5bc3467d7cb645f242289f730abe370a9e9ae3abaafa8ea073fb4081
```

The matching pre-Phase-2 image was then started in an isolated container with
the restored data and vault mounts, `npm run start`, and an isolated host port.
The container reached Docker `healthy` and `/api/health` returned HTTP 200 with
`{"ok":true}`. The old image used Node 22.23.2 inside the image. No Phase 2
Manage Tags endpoint was expected or required in this old image.

Through the actually running old image, the rehearsal successfully verified:

- authenticated `/api/auth/status` for the fixture owner;
- `/api/posts`, including historical `Java`, `#java`, and `JAVA` memberships;
- `/api/posts/inbox/java` and `/api/metadata/documents/doc-java` reads;
- `/api/history/status` and the baseline History log;
- restored tag IDs 1 through 5 and their pre-upgrade associations;
- database `PRAGMA integrity_check = ok` and empty `PRAGMA foreign_key_check`.

After old-image startup, the restored database still compared exactly with the
pre-upgrade snapshot: tags, IDs, `document_tags`, documents and `updated_at`,
logical memberships, migration-marker state, Markdown paths/bytes/mtimes, and
file count all matched. Git HEAD remained the fixture baseline commit and
tracked Git status remained clean. The matching old image therefore actually
served the restored pre-upgrade state successfully.

There is no reverse identity migration after successful consolidation. Rollback
after successful consolidation requires the matching pre-upgrade backup plus the
matching old application image/runtime. Losing tag IDs are not reconstructed.

## 8. Concurrency / Atomicity Evidence

The concurrency contract is covered by the domain and route suites rather than
by browser timing:

- `server/__tests__/tagManagement.test.ts` — `uses a deferred read transaction
  snapshot while another WAL connection commits` proves one logical Preview
  snapshot;
- `rejects a relevant two-connection association change after Preview without
  partial mutation` and `rejects a relevant two-connection change after path
  discovery before the IMMEDIATE transaction` prove relevant stale rejection;
- `serializes two Apply calls from one Preview across two WAL connections` and
  `serializes two Apply calls from one Preview into one commit and one stale
  rejection` prove writer serialization;
- `rechecks the fingerprint after locks and before any mutation SQL` proves
  stale validation precedes mutation;
- `rolls back Merge after association mutation` and the controlled postcondition
  mismatch case prove full rollback;
- `applies normal Rename in place, versions each source document once, and
  rejects duplicate Apply` proves duplicate Apply behavior;
- `uses one commit candidate with strict monotonic increments for equal and
  future versions` proves strict version advancement.

Apply uses sorted document coordination followed by one `BEGIN IMMEDIATE`
transaction. The response scope is not the mutation scope: samples and pages
are bounded for the wire, while Apply recomputes and mutates the complete
affected set. No partial mutation path was added.

## 9. Writer Safety Evidence

The REST and AI matrices cover Rename, Display Rename, Merge, and Remove. The
key writer contract is:

```text
omitted tags are not tag writes
explicit tags require current metadata version
stale explicit tag mutation → METADATA_VERSION_CONFLICT
```

Named evidence:

- `server/__tests__/metadata-api.test.ts` — `preserves intervening tags for
  title/summary-only requests and rejects stale mixed tag replay`, `requires an
  explicit version token for tags and does not mutate on rejection`, and
  `keeps committed %s tag state authoritative for REST stale writers`;
- `server/__tests__/tools.test.ts` — `keeps tags untouched for a summary-only
  call`, `requires the read version for an explicit tag call`, `rejects stale
  mixed metadata without applying the title`, and `keeps committed %s tag state
  authoritative for AI stale writers`;
- `server/__tests__/documentMetadata.test.ts` — scoped field patches and
  `rejects a stale explicit tag patch atomically, including mixed title changes`;
- `server/__tests__/tagManagement.test.ts` — stale explicit writer after Apply
  with title and summary preservation.

These tests cover omitted-tag writes, current-token writes, stale-token
rejection, mixed title/summary/tag requests, and the four management operation
kinds. A stale explicit writer cannot partially apply a title or summary while
replaying an old tag set.

## 10. Security Closure

The security evidence covers:

- invalid and unsafe integer IDs;
- malformed, uppercase, non-hex, or otherwise invalid fingerprints;
- unknown request fields and malformed operation shapes;
- NUL/control characters and oversized names;
- too many tag entries and injection-shaped names;
- unauthenticated list, Preview, and Apply requests;
- JSON content type and same-origin CSRF checks;
- bounded sample/page inputs;
- `no-store` management reads;
- safe stable error codes and correlation behavior.

Evidence is in `server/__tests__/tags-api.test.ts` — `maps malformed, missing,
and security-sensitive requests without SQL leakage`, `fails closed for unsafe
IDs, fingerprints, and persistent tag names`, `enforces JSON content type and
same-origin CSRF on Preview`, and `correlates unexpected server failures
without exposing internal error text`. Client runtime guards are covered by
`src/lib/__tests__/tag-management-api.test.ts` — unsafe IDs, malformed
fingerprints, unknown fields, malformed Apply results, and operation/result
identity binding.

The management error boundary does not expose raw SQL, SQLite constraint
details, filesystem paths, or stack traces through the tested API envelopes.
The implementation returns stable codes and safe human-readable diagnostics.

## 11. Accessibility and Internationalization

The manager and confirmation contracts are covered by:

- `src/components/vault/__tests__/TagManagementDialog.test.ts` — dialog role,
  `aria-modal`, title/description, focus entry, forward and reverse Tab traps,
  Escape, return focus, validation focus, live announcements, disabled states,
  Preview/Apply focus, and sync/stale announcements;
- `src/components/__tests__/ConfirmHost.test.ts` — destructive labels,
  `role="alertdialog"`, Escape cancellation, Cancel-default focus, Tab trapping,
  and focus restoration;
- `TagManagementDialog.test.ts` — `covers Remove-specific preview, warning,
  confirmation, and success copy in both locales`;
- `e2e/tag-management.spec.ts` — production Remove alertdialog, Cancel focus,
  Escape cancellation, same-Preview continuation, focus restoration, and final
  confirmation.

The Remove copy is directly asserted in both supported locales. It names the
exact `#Java` source, states that documents remain, states that
Markdown/frontmatter remains unchanged, states that the global tag record is
deleted, announces the destructive warning, and localizes the confirmation
labels. Destructive semantics use role, text, and action semantics rather than
color alone.

## 12. Client Synchronization / Selection Matrix

The client contract is one authoritative cycle:

```text
Apply commit
→ refresh posts/tree
→ refresh managed tags
→ stable-ID reconciliation
```

If refresh fails after commit, the dialog enters `sync-pending`. Retry invokes
only synchronization and never calls `applyTagOperation` again. A committed
protocol mismatch is treated as committed state requiring trusted-operation
recovery, not as an Apply failure and not as permission to re-Apply.

| Operation/selection | Reconciliation result |
| --- | --- |
| Rename selected source | Fresh survivor display for the same stable ID |
| Display Rename selected source | Same stable ID with fresh display |
| Merge selected source | Destination survivor |
| Merge selected destination | Destination remains selected |
| Remove selected source | `null`; TagPanel results close |
| Unrelated selection | Preserved |
| Newer user selection during Apply | Newer selection wins by selection epoch |
| Unresolved display-only selection | Never rebound by display-string coincidence |

Evidence is in `src/lib/__tests__/tag-selection-reconciliation.test.ts`,
`TagManagementDialog.test.ts`, `src/views/__tests__/VaultView.test.ts`, and
the Merge/Remove browser flows. The committed recovery tests explicitly use
the trusted submitted operation, including Remove when the source row no longer
exists.

## 13. Production Browser Evidence

The real production path is exercised as:

```text
/vault
→ Tags panel
→ Manage Tags
→ VaultView-owned TagManagementDialog
```

`e2e/tag-management.spec.ts` contains:

- `authenticated Rename transport preserves Markdown and Git boundaries`,
  including a production-entry Rename followed by a production Display Rename;
- `authenticated Merge preserves the destination identity, deduplicates
  overlap, and keeps file boundaries`, including production Merge and a
  selection-epoch race;
- `production Remove previews, confirms once, clears selection, and preserves
  files`, including exact source identity, affected count/sample, destructive
  explanation, Cancel/Escape, focus restoration, exact-once Apply, source
  deletion, selected-source clearing, unrelated-tag preservation, metadata
  versions, Markdown bytes/mtime, and Git state.

The production Remove flow proves:

```text
Escape → Apply request count 0
same Preview → explicit Confirm → Apply request count 1
```

Browser evidence is intentionally distinct from domain-level two-connection
WAL/concurrency evidence in §8.

## 14. Large-Vault Evidence

The deterministic scale fixture contains:

```text
10,000 documents
50,000 document-tag associations
```

Structural acceptance evidence is:

- exact large Remove scope: 10,000 affected documents, 10,000 association
  removals, and 10,000 document version updates;
- planner query count remains constant at three in the scale evidence;
- no N+1 planner pattern is present;
- initial response sample is bounded to 20;
- continuation page size is bounded to 100;
- Apply scope is the complete affected set and is not bounded by the sample/page
  wire response; Apply recomputes the complete mutation scope.

The release-candidate CI evidence is [CI #336 / run
`31886374022`](https://github.com/tangxiangxiang/nuvyn/actions/runs/31886374022),
`tags-scale` job `95016156244`, which completed successfully and ran the two
scale test files. The job conclusion is the CI gate evidence; the exact console
timing and heap payload is not attributed to CI here because the job log is
access-controlled in this environment.

For precise provenance of the observational numbers, the same release-candidate
test files were run locally on 2026-08-16 at closure HEAD `a8a0d7d` (the
production tree is unchanged from `99f4d73`) with:

```text
OS: Darwin 25.5.0 arm64
Node: v24.15.0
Command: npm run test:tags-scale -- --disableConsoleIntercept --reporter=verbose
Result: 2 files, 3 tests passed
```

The exact local observations printed by the tests were:

```json
{
  "planner": {
    "documents": 10000,
    "associations": 50000,
    "plannerQueries": 3,
    "elapsedMs": 71.77,
    "heapDeltaBytes": 45971552
  },
  "health": {
    "markdownEntries": 10000,
    "metadataOwnershipCount": 10000,
    "elapsedMs": 40.17,
    "heapDeltaBytes": 2001032
  }
}
```

Elapsed time and heap delta are observational only and vary by runner. No
fixed wall-clock or heap SLA is introduced. The scale tests are
`server/__tests__/tagManagement.scale.test.ts` and
`server/__tests__/tags-api.scale.test.ts`.

## 15. Protected-Area Regression Audit

No unexplained Phase 2 regression was found in the following protected areas:

- Markdown rendering, Wiki links, Markmap, Mermaid, KaTeX, Emoji, and link
  index: existing full unit/browser and macOS visual lanes remain green;
- Markdown bytes, frontmatter, mtimes, `fileChanges`, and Git History: the
  Apply boundary suite and all three management browser flows assert no file or
  Git mutation;
- Draft Recovery and authentication: full unit/integration, Draft Store,
  dedicated auth-browser, and packaged auth smoke lanes pass;
- Docker/Compose: the Docker job verifies origin wiring, builds the production
  image, and runs packaged authentication smoke;
- Phase 1 Tag Query, TagPanel, FileTree, selected results, and
  `PostSummary.tags`: TagPanel/FileTree/VaultView regression suites and all
  verify jobs pass.

Phase 2 did not turn these domains into new mutation stores. Tag Management
mutates SQLite metadata only. The TagPanel entry emits/opens the existing
VaultView-owned manager and does not own manager domain state.

## 16. CI / Verification Evidence

The verified implementation release-candidate run is
[CI #336 / run `31886374022`](https://github.com/tangxiangxiang/nuvyn/actions/runs/31886374022).
GitHub's Actions API confirms it ran on `main`, for
`99f4d73154349f8ebc99cb609f1a88b07937fb26`, completed on 2026-08-15, and has
overall conclusion `success`.

| Job | Job ID | Conclusion | Verified steps/evidence |
| --- | ---: | --- | --- |
| `verify (ubuntu-latest, 22)` | `95016156222` | success | typecheck, build, complete unit/integration suite, cross-platform browser E2E, Draft Store browser E2E all success |
| `verify (ubuntu-latest, 24)` | `95016156306` | success | typecheck, build, complete unit/integration suite, cross-platform browser E2E, Draft Store browser E2E all success |
| `verify (macos-latest, 24)` | `95016156250` | success | typecheck, build, complete unit/integration suite, cross-platform browser E2E, Draft Store browser E2E all success |
| `verify (windows-latest, 24)` | `95016156279` | success | typecheck, build, complete unit/integration suite, cross-platform browser E2E, Draft Store browser E2E all success |
| `tags-scale` | `95016156244` | success | `npm run test:tags-scale` success |
| `docker-smoke` | `95016156239` | success | Docker origin wiring, production image build, and packaged authentication smoke success |
| `auth-browser` | `95016156207` | success | dedicated authentication browser smoke success |
| `visual` | `95016156209` | success | macOS `e2e/markdown-visual.spec.ts` visual baseline success |

The failure-evidence upload steps were skipped because the corresponding jobs
did not fail; they are not failed jobs. CI #336 is the authoritative production
implementation run for `99f4d73`. The initial documentation-only closure
commit was independently validated by [CI #337 / run
`31926530191`](https://github.com/tangxiangxiang/nuvyn/actions/runs/31926530191),
which ran on `a8a0d7decf43a7743d19fa9cac7c612f9e0e13db` and completed
successfully; its eight jobs also concluded successfully. The repair commit
will trigger its own CI run, and no future result is claimed here.

## 17. Atomic Deployment / Compatibility

The production Docker image contains the SPA and server from one build. The
normal deployment unit is therefore one atomic client/server image.

The approved stale-browser contract is:

- new client + old server: management endpoint absence/unavailability is treated
  as safe unavailable state; no management mutation is attempted;
- old client + new server: ordinary reads remain compatible, while old full
  metadata writes without the required current version token fail closed rather
  than overwriting committed management tag state;
- a current client sends field-scoped metadata writes with the expected version
  token and uses the current management protocol.

This is compatibility within the approved contract only; it is not a promise of
arbitrary protocol compatibility or a reverse migration.

## 18. Release / Upgrade Procedure

The operator procedure is grounded in the executed rehearsal and the maintained
[backup and restore guide](../../deployment/backup-and-restore.md):

1. Stop or quiesce Nuvyn writers. For a zero-downtime backup, use a
   SQLite-aware filesystem snapshot covering the database/WAL state and the
   matching vault; never copy only a live `nuvyn.db` main file.
2. Back up the complete matching data directory/database state and vault,
   including hidden vault state required for Git History, plus any external
   master key.
3. Verify the backup with SQLite integrity and foreign-key checks and retain it
   until migration health and a representative query/Preview check pass.
4. Deploy one matching client/server image.
5. Allow the production startup path to run metadata migration and
   `tag-identity-v1` initialization before management requests are served.
6. Inspect the startup migration report and management health. Verify a
   representative managed-tag read and Preview before enabling normal operator
   use.
7. Monitor `/api/health`, management health, stale conflicts, migration
   diagnostics, and representative document/tag reads.

Management remains fail-closed if startup verification or a live health
preflight is unavailable.

## 19. Rollback Procedure

If migration has not committed, resolve the startup issue or restore the
pre-upgrade state if required; the migration transaction is all-or-nothing.

If identity consolidation has completed and rollback is required:

1. Stop the new image and prevent new writes.
2. Restore the matching pre-upgrade SQLite/data backup and the matching vault
   backup when the complete instance state is required.
3. Run the matching old/compatible application image/runtime, including the
   matching master-key configuration.
4. Verify SQLite integrity, foreign keys, logical memberships, representative
   documents, tags, and management health before exposing the instance.

There is no reverse tag identity migration. Do not attempt to reconstruct
losing tag IDs or downgrade only the application code against a successfully
consolidated live database.

## 20. Known Limitations

### Updated-date consequence

Tag Management updates SQLite metadata versions for affected documents as
approved. The affected documents can therefore show a newer database-owned
updated date even though the Markdown body, frontmatter, path, file bytes, and
mtime were not rewritten. An orphan Remove has zero affected documents and
therefore no document version update.

### No durable operation history

Phase 2 returns an audit-friendly operation result and emits application-log
material, but it does not introduce a durable operation log, event-sourcing
store, or persistent management history.

### Undo

Undo is **Deferred to Phase 2.1**. Phase 2 does not claim that Rename, Merge, or
Remove can be safely undone.

### Other non-blocking limitations

- A successful identity consolidation cannot be reversed by code; rollback is
  backup restore with a matching image/runtime.
- Browser/client mismatch handling is intentionally fail-safe and may require a
  hard browser refresh after upgrade.
- Large Apply operations are SQLite transactions and can serialize competing
  writers; the bounded Preview sample does not reduce the mutation scope.

## 21. Deferred Scope

Phase 2 explicitly does not include:

- Undo;
- event sourcing;
- durable management history;
- a global tag revision counter;
- distributed locking;
- a new ORM;
- a new client state-management framework;
- reverse identity migration.

Undo remains:

```text
Deferred to Phase 2.1
```

## 22. Open Defect Review

The release-candidate review inventory records:

```text
P0: 0
P1: 0
P2: 0
P3: 0
Architecture / PRD Conflict: None
```

No unexplained P2 or release-blocking defect remains in the reviewed evidence.
The Final Closure Review on 2026-08-16 confirmed these counts and passed the
Phase 2 release gate.

## 23. Final Release Gate

The evidence-backed gate is:

- [x] Every T2-0 through T2-6 checkbox has named evidence and no waived safety invariant (§5).
- [x] Production backup and operator rollback instructions were executed in an isolated rehearsal, not only written (§7).
- [x] Identity migration and management health report pass on the release candidate (§6 and §7).
- [x] One atomic client/server image and stale-browser behavior are documented (§17).
- [x] No open P0/P1, Architecture / PRD Conflict, or unexplained P2 remains (§22).
- [x] Known limitations include the DB updated-date consequence, no durable operation history, and Undo Deferred to Phase 2.1 (§20 and §21).
- [x] Final full CI and browser evidence is attached/referenced (§13 and §16).
- [x] Closure is reviewed before the feature is declared complete — Final Closure Review PASS on 2026-08-16.

## 24. Final Closure Decision

```text
T2-7 COMPLETE
Tags Management Phase 2 COMPLETE
Final Closure Review: PASS — 2026-08-16
```

The final closure review authorizes the Phase 2 completion decision:

```text
Tags Management Phase 2 COMPLETE
```

This record does not start T2-6 or Phase 2.1 implementation work. In
particular, Undo remains deferred to Phase 2.1 and requires its own reviewed
PRD before implementation.
