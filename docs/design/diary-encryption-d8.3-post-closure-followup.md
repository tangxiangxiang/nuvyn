# D8.3 Post-Closure Follow-up Evidence

> **Historical lineage — not current runtime authority.** Current behavior is
> defined by [Diary Architecture](../architecture/diary.md) and [Diary User
> Guide](../user-guide/diary.md). This file is retained for D8 review
> traceability.

Status: `IMPLEMENTED / REVIEW-READY`. The original D8.3 closure remains
`REVIEW-CLOSED (historical)`. This follow-up has not received an independent
follow-up review. It is a focused product-consistency remediation for managed
Diary delete and History capability projection; it is not D8.4 migration.

## Checkpoint and scope

```text
Starting HEAD:              fec4860488ba5c032931ec62d15e07ea09971e59
Implementation/Test commit: e895217956577b69c627a7a640202bcbc8ba153a
Evidence/Docs commit:       recorded by this document's commit
Final HEAD:                 recorded after the docs/evidence commit is pushed
github/main:                recorded after the final push
Independent follow-up review: NOT YET PERFORMED
```

The original independent review and re-review documents are historical
records and were not modified. D8.4 remains `NOT REVIEW-CLOSED / NOT STARTED`.

## Before / after capability matrix

| Surface | Before this follow-up | After this follow-up |
| --- | --- | --- |
| Direct `DELETE /api/posts/diary/YYYY-MM-DD` | Always rejected with `422 diary-encrypted-delete-unsupported` | A valid unlocked managed document uses the opaque owner and returns `200 {"ok":true}`; locked, missing, metadata, and generation conflicts return the frozen `423`/`404`/`503`/`409` contracts. |
| Managed Diary in `GET /api/history/status` | A physical `diary/YYYY-MM-DD.md` could appear in Changes | Explicit `isManagedDiaryBodyPath` filtering hides managed physical paths; ordinary and unmanaged diary files remain discoverable. |
| TreeRow `查看文件历史` | Menu exposed an action that later failed with `422` | Capability is hidden only for canonical managed Diary paths. Delete/export remain available under the existing menu policy. |
| History log/file/diff/content-hashes/restore/commits | Fail-closed server guards | Still fail-closed; status projection is not a security boundary and did not replace mutation guards. |
| Ordinary Note delete, Changes, and file History | Existing behavior | Unchanged; regression tests remain in the implementation checkpoint. |

## Managed delete owner and transaction

`server/routes/posts.ts` remains a thin classifier, parameter, capability, and
error-mapping layer. A canonical path enters
`server/diaryAccess/delete.ts` under the existing:

```text
withVaultStructureLock
  → withDocumentWriteLock
    → withDiaryBodyOperation
      → deleteManagedDiaryDocument
```

The existing server-side Diary access service remains the sole live/unwrapped
DEK owner. The delete owner receives only the current lease assertion; it does
not receive a DEK, create a session, or add a crypto/history owner.

The transaction captures the canonical logical path, authoritative
`documentId`, and source inode/parent identity. Its durable intent contains
only structural identities and reserved artifact names. It moves the existing
ciphertext inode to `.nuvyn-delete-inflight-*`, performs structural
`LinkIndex.applyDelete`, deletes the existing authoritative metadata graph,
and unlinks that same generation. No second body copy is written.

Rollback is create-only inode restoration plus structural metadata/index
restoration. It never calls `reidentifyReusedPath`, `LinkIndex.applyWrite`,
gray-matter, Markdown parsing, decryption, History, or a body-bearing journal.
If the canonical path or staging inode changes generation, the external
generation wins. The old generation is quarantined or left for the structural
crash-recovery owner; the old identity is detached only when the manifest
proves it, and foreign bytes are never adopted or overwritten.

The structural managed-delete intent is understood by
`server/crashRecovery.ts`. Recovery checks the recorded source identity before
completing or quarantining an artifact and preserves a fresh canonical-path
identity. It never reads artifact bytes to make that decision.

## History and UI projection

History Changes uses the existing physical-path classifier
`isManagedDiaryBodyPath` in addition to the existing History dotfile policy.
No `startsWith("diary/")` or duplicate date parser was added. Thus a dirty
batch such as `inbox/a.md`, `diary/2026-08-25.md`, and `diary/legacy.md`
projects as `inbox/a.md` and `diary/legacy.md` only.

`TreeRow.vue` reuses the canonical logical classifier
`isManagedDiaryPath`. Managed `diary/YYYY-MM-DD` hides only file History;
unmanaged `diary/legacy` continues to expose History. The backend guards for
History log/file/diff/content-hashes/restore/commit remain present and are
covered by mixed-batch rejection tests.

## Security proof counters

The implementation and focused tests establish the following counters for
this delete path:

```text
new durable plaintext copies:                  0
new managed Diary Git commits:                 0
Diary body passed to LinkIndex during delete:  0
Diary body parsed during delete:               0
foreign generation overwrite:                  0
raw key/client key ownership changes:          0
```

The owner has no body parameter, no decrypt call, no raw read, and no body
serialization path. The source identity and metadata manifest are structural
only. Existing legacy plaintext and external user-controlled copies are not
retroactively erased by this follow-up.

## Validation evidence

| Area | Result |
| --- | --- |
| Focused managed delete, History status, and context menu | 3 files, 119 tests passed |
| Targeted crash/recovery and race cases | 4 files, 9 selected tests passed |
| Server/client typecheck | Passed |
| Production build | Passed; existing chunk/annotation warnings only |
| Full unit suite | 3,593 passed, 9 skipped, 22 environment/fixture-blocked failures; no test was weakened or skipped to mask the implementation |
| Crash subprocess lane | Non-subprocess recovery assertions passed; existing `listen EPERM` sandbox failures prevented the real IPC subprocess cases from running |
| Browser/E2E | Not run locally in this focused follow-up; CI result is reported separately after push |
| Full CI | Implementation exact-head run `CI #606 / 33468787124 / attempt 1`, HEAD `e895217956577b69c627a7a640202bcbc8ba153a`, was `in_progress` while this evidence was prepared; the final docs-head run is reported after the second push. Local green tests do not imply independent-review PASS. |

The full-unit failures were environmental rather than D8.3 assertions: 19
OpenAI HTTP tests could not bind/listen in the sandbox, two crash subprocess
tests hit the same `tsx` IPC `listen EPERM`, and one unrelated auth-middleware
fixture referenced a missing `src/content/post-smoke.md`. These failures are
reported rather than masked.

## D8.4 boundary

This follow-up owns direct managed-document delete only. Managed rename/move,
reference rewrite, folder/bulk delete footprints, encrypted History, body
search, persistent Draft/Recovery, legacy plaintext migration, and legacy
cleanup remain their existing fail-closed or D8.4-owned contracts. D8.4 must
not route managed bytes through the generic plaintext Note delete path or
replace this owner.

```text
D8.3 original closure:        REVIEW-CLOSED (historical)
D8.3 post-closure follow-up:  IMPLEMENTED / REVIEW-READY
Independent follow-up review: NOT YET PERFORMED
D8.4:                         do not claim IMPLEMENTED or REVIEW-CLOSED
```

## Post-closure E2E remediation and CI closure

This section extends the follow-up evidence; it does not rewrite the
historical D8.3 closure. Cross-platform CI `#607` (`33468893504`) exposed four
deterministic browser assertions that still encoded the historical
direct-delete rejection after the opaque direct-delete owner had become the
authoritative contract.

```text
Starting HEAD:              1b50537ff12b23d5cdc4ef0cbc7583b7cbf0454a
Implementation/Test commit: 03cf19da9387fcbf8e1c59cafda37957d0df1e8f
Evidence/Docs commit:       recorded by this document's commit
Final exact-head CI:        verified after the evidence commit is pushed; see the completion report
Independent follow-up review: NOT YET PERFORMED
```

### Root cause and remediation

No production defect was found. `server/diaryAccess/delete.ts`, the posts and
folders routes, mutation policy, History guards, and the D8.3 authority all
agreed on the current boundary: unlocked direct managed-document delete is
supported, while folder/bulk delete, rename/move/reference mutation, and
Diary History remain fail-closed.

The stale browser coverage was synchronized with that already-authoritative
contract:

* `e2e/diary-access-fixture.spec.ts` now treats its created document cleanup as
  a successful direct managed delete and proves the path is subsequently 404.
* `e2e/diary-mood-lifecycle-regression.spec.ts` retains its Mood CAS identity
  checks, then proves direct delete returns `200 {"ok":true}` and removes the
  document.
* `e2e/diary-release.spec.ts` proves the Calendar marker disappears after a
  direct delete, then recreates the managed document and proves recursive
  deletion of the protected Diary folder is rejected with 422 while the
  managed document and structural marker remain.
* `e2e/diary-reader.spec.ts` preserves the valid `503
  diary-metadata-unavailable` contract for the deliberately injected
  physical-only future file. Only the isolated test-owned temporary-vault
  fixture is removed directly after that exact response; the test does not
  broaden or hide the production outcome.
* `e2e/fixtures/diary.ts` now documents why temporary-vault cleanup still has
  to cover physical-only, metadata-less test fixtures.

No retry, skip, quarantine, status wildcard, CI bypass, or production-code
change was introduced. Existing browser coverage continues to prove all
managed History endpoints reject with `422 diary-history-encrypted-unsupported`.
The server/unit coverage continues to prove History Changes filtering and the
managed file-History UI capability guard.

### Validation

| Area | Result |
| --- | --- |
| Four directly affected browser specs | 31 passed, 3 pre-existing explicit D8.2 skips |
| Managed delete / History / context menu / crash recovery | 4 files, 259 tests passed |
| Typecheck | `npm run typecheck` passed (client and server) |
| Production build | `npm run build` passed; existing dependency annotation and chunk-size warnings only |
| Standard unit suite | 242 files, 3,615 passed, 9 pre-existing skips |
| History integration | 5 files, 178 passed |
| Recovery/crash integration | 5 files, 198 passed |
| Full Chromium browser/E2E | 148 passed, 7 pre-existing explicit D8.2 skips |
| Local platform scope | macOS Chromium only; Linux, Windows, Node 22, Docker, auth, visual, and tags-scale conclusions are owned by exact-head CI |

CI `#607` itself remains a historical failed run for starting HEAD
`1b50537ff12b23d5cdc4ef0cbc7583b7cbf0454a`: all four verify jobs failed only
in cross-platform browser E2E with the same four contract mismatches, while
typecheck, build, full unit/integration, visual, tags-scale, Docker smoke, and
auth-browser passed. The final pushed evidence HEAD and every required job are
verified separately before this remediation is reported complete.
