# D8.3 — Privacy Enforcement Implementation Evidence

> **Historical lineage — not current runtime authority.** Current behavior is
> defined by [Diary Architecture](../architecture/diary.md) and [Diary User
> Guide](../user-guide/diary.md). This file is retained for D8 review
> traceability.

Status: historical D8.3 closure evidence. The original implementation and
fresh diff-based self-review were complete, and exact-head CI for that
checkpoint was 8/8 success. The direct managed-Diary delete rows in this
snapshot are superseded by the post-closure follow-up; the historical facts
and review timeline are intentionally retained.
Planning approval is the D8.3 planning-review baseline at `99f693b` (the
docs-only remediation checkpoint). This document records implementation
evidence and self-review only; it does not claim an independent review or
`REVIEW-CLOSED`.

Current follow-up authority: [D8.3 post-closure follow-up](./diary-encryption-d8.3-post-closure-followup.md).
It records the new opaque direct-document delete owner, while History remains
unsupported and folder/bulk delete remains fail-closed.

## Baseline and lineage

```text
branch: main
starting HEAD: 99f693b02080127c16911869c17edcb2fa38fe3c
starting worktree: clean
planning CI baseline: #590 / run 33352478819 / attempt 3
planning baseline result: Ubuntu Node 22/24, macOS Node 24, Windows Node 24,
  auth-browser, tags-scale, visual, docker-smoke — 8/8 success
implementation commit: 584cf770111bc2f5ee86be08ecda7ea50586bc87
follow-up test/evidence commit: 6308947cd6fd758cd6055a687a1d4e49891a5e2c
final implementation HEAD (exact CI head): 6308947cd6fd758cd6055a687a1d4e49891a5e2c
```

The implementation keeps D8.2's existing Diary adapter and lifecycle owners.
The server-side `server/diaryAccess/service.ts` remains the sole owner of the
live/unwrapped DEK. The client owns only the existing session/capability state
and transient authorized UI input; it never owns a DEK.

## Security invariants implemented

- Managed identity remains the canonical `diary/YYYY-MM-DD` logical path and
  the existing DocumentMetadata `documentId` remains authoritative.
- Generic durable writers reject plaintext at the managed path and generic
  delete rejects without an adapter-aware owner. Diary create rollback is the
  only narrowly-scoped internal encrypted-delete exception.
- Managed bodies are never parsed as ordinary Markdown by generic tree/list,
  LinkIndex, search, metadata migration, archive, tag, History, or rename
  owners.
- The authoritative Diary session generation advances synchronously before
  derived holders are cleared; stale managed completions are ignored.
- Existing Note behavior remains intact except for the deliberate
  `Note → managed Diary` LinkIndex edge suppression. `Note → Note` remains
  indexed.
- D8.4 owns legacy plaintext migration and cleanup. D8.3 does not silently
  migrate, purge, rewrite, or claim retroactive protection for old state.

## Surface matrix

| Surface | D8.3 behavior | Evidence owner |
| --- | --- | --- |
| Git mutation / History restore | Managed paths rejected before temp index, Git plumbing, historical raw publication, or filesystem mutation; mixed Note+Diary batches reject atomically. | `server/history/git.ts`, `server/history/restore.ts` and `server/__tests__/history-git.test.ts` |
| Primary body read/save/create/resource | Existing Diary body-operation lease and server adapter remain the only body owner; invalid lease returns HTTP `423 diary-locked` with `no-store`. | `server/diaryAccess`, `server/routes/diary.ts`, `server/routes/posts.ts`, `server/routes/markdownResources.ts` |
| Draft / Recovery | Managed persistent Draft/Recovery writes, conflict candidates, move/persistence flushes, pagehide/dispose flushes, and UI recovery viewers are disabled or filtered with client-only `diary-draft-recovery-unsupported`; legacy records are left for D8.4. | `draftStore.ts`, `useUnsavedDraftPersistence.ts`, `useUnsavedDraftRecovery.ts`, `useDraftRecoveryTabs.ts` |
| Tree / list / structural metadata | Managed entries expose canonical path/date/existence, stable identity and Mood only; private title/summary/tags/frontmatter are not part of locked structural projection. | `server/tree.ts`, metadata routes, `src/views/metadataPostSummary.ts` |
| LinkIndex | Cold and warm state retain structural paths only; managed body/title/edges are skipped or purged. `Note → managed Diary` is suppressed; `Note → Note` is preserved. | `server/linkIndex.ts`, `useLinkIndex.ts`, `server/__tests__/linkIndex.test.ts` |
| Search / body cache | Managed title/summary/tags/body are excluded; managed structural date/path search remains possible; no managed body priming/cache; stale result epoch is dropped. | `src/lib/search.ts`, `src/lib/searchResults.ts`, `src/lib/__tests__/search.test.ts`, `searchResults.test.ts` |
| Metadata migration / archive / tags | New managed scans/backups are skipped; private managed metadata migration/archive/tag mutation returns HTTP `422 diary-private-metadata-unsupported`; public structural projections filter private associations. | `metadataMigration.ts`, `frontmatterArchive.ts`, `tagManagement.ts`, metadata/tag routes |
| Rename / move / reference | Managed document rename/move returns HTTP `422 diary-encrypted-rename-unsupported`; any managed folder/reference footprint returns HTTP `422 diary-encrypted-reference-unsupported` before planning, journaling, staging, or filesystem mutation. | posts/folders routes, `renameReferences.ts`, `renameReferenceJournal.ts`, `folderMoveTransaction.ts` |
| Delete (original closure checkpoint) | Direct, mixed, and folder deletes touching managed Diary returned HTTP `422 diary-encrypted-delete-unsupported` before staging, journal, metadata, filesystem, or LinkIndex mutation. This direct-document row is superseded by the post-closure owner; folder/bulk and Note-only semantics remain as recorded. | historical posts/folders route evidence; current owner is `server/diaryAccess/delete.ts` |
| Conflict / teardown | Managed tab raw/original/external/conflict state, recovery, history/working diffs, TOC, client LinkIndex, search state, Monaco models, route mirror, AI context, and pending PDF state are fenced and cleared on the authoritative generation event. | `useDiaryAccessSession.ts`, `VaultView.vue`, related Vault composables |
| AI | Managed live context, summary, commit-message body collection, body tools, delete, and private metadata tools are fail-closed before provider or mutation work. | `server/ai/routes.ts`, `server/ai/tools.ts`, `aiLiveContext.ts` |
| PDF / clipboard | Explicit user-created copies remain allowed only for the current managed session generation; lock during render/copy prevents stale completion/download. | `VaultView.vue` |
| Diagnostics / resources | Resource reads reuse the existing body lease; HTTP errors use `Cache-Control: no-store` and stable codes without raw/envelope/key/provider payloads. | markdown resource route, shared route helpers, AI/history/posts/metadata/tag routes |

## Historical closure state (superseded for direct delete)

At the original closure checkpoint, managed direct and mixed deletes were
deliberately disabled. The existing generic delete protocol staged
`.nuvyn-delete-inflight-*`, captured rollback metadata, updated indexes, and
could create recovery manifests. The then-current D8.3 implementation had no
reviewed adapter-owned ciphertext-only delete transaction, so returning HTTP
`422 diary-encrypted-delete-unsupported` was safer than directly unlinking opaque
ciphertext or allowing a generic rollback/journal owner to handle it. That is
the historical behavior evidenced by this document; the later follow-up adds
the owner and tests described in the linked current authority document.

Folder/bulk deletes that include a managed Diary remain fail-closed under the
same `422` contract. D8.4 still does not implicitly broaden either operation.

Folder rename/reference updates use a conservative fail-closed policy when a
managed Diary footprint could be involved, because generic planners cannot
inspect encrypted Diary references safely. This is an intentional temporary
Note-folder functionality reduction, recorded for a future reviewed owner;
ordinary Note-only operations without that footprint remain unchanged.

## Local validation

Local validation completed for the implementation worktree includes:

- `npm run test:unit` — 242 files, 3,607 tests passed, 9 skipped.
- `npx vitest run src/router/__tests__/index.test.ts` — 7/7 passed; its
  navigation-policy tests use a local `VaultView` stub so the assertions do
  not depend on transforming the large workspace lazy module graph.
- `npm run test:history-integration` — 5 files, 175/175 passed.
- `npm run test:recovery-integration` — 5 files, 193/193 passed.
- D8.3 History/LinkIndex/Search/teardown focused run — 8 files, 166/166
  passed.
- Diary route/mood/AI focused run — 3 files, 147/147 passed.
- Link API/client LinkIndex run — 2 files, 43/43 passed.
- Client Draft/Recovery/Search/History/Diff/CurrentNote run — 15 files,
  284/284 passed.
- Tag management/undo/API run — 3 files, 135/135 passed.
- Markdown resource and atomic writer run — 2 files, 59/59 passed.
- `npm run test:e2e` — 153 tests, 146 passed, 7 skipped.
- `npm run test:e2e:draft-store` — 38/38 passed.
- `npm run test:e2e:auth` — 2/2 passed.
- Markdown visual browser lane — 3/3 passed.
- `npm run test:tags-scale` — 2 files, 6/6 passed.
- `npm run test:deployment-auth` — Docker authentication smoke passed.
- `npm run typecheck` — passed.
- `npm run build` — passed; only existing Rolldown annotation/chunk-size
  warnings.
- `git diff --check` — passed.

## GitHub CI exact-head evidence

```text
implementation/evidence HEAD (exact CI head): 6308947cd6fd758cd6055a687a1d4e49891a5e2c
first implementation CI #591: Ubuntu/macOS verify hit the router guard lazy
  module-graph timeout before the test-only stub follow-up; no D8.3 assertion
  failed in that run
run number / run ID / attempt: #592 / 33369599249 / 1
HEAD: 6308947cd6fd758cd6055a687a1d4e49891a5e2c
Ubuntu Node 22: PASS
Ubuntu Node 24: PASS
macOS Node 24: PASS
Windows Node 24: PASS
auth-browser: PASS
tags-scale: PASS
visual: PASS
docker-smoke: PASS
```

## Remaining risks and D8.4 boundary

- Independent review is pending; this record must not be read as an
  independent review pass. Self-review classified the implementation at
  P0 = 0, P1 = 0, P2 = 0 after the router test-only stability follow-up.
- Legacy plaintext files, Git history, IndexedDB rows, SQLite private metadata
  rows, and `frontmatter_backup` are classified/hidden or left untouched for
  D8.4. D8.3 does not claim retroactive cleanup.
- Explicit PDF/clipboard export is an external copy and is outside automatic
  OS/browser clipboard or downloaded-file wiping guarantees.
- The evidence-sync commit that records this exact-head result is docs-only;
  it does not change the implementation checkpoint validated by CI #592.

## Final D8.3 closure (historical)

The preceding status and validation sections are retained as the
implementation/evidence checkpoint narrative. This appended section records
the later lifecycle synchronization; it does not rewrite that earlier
`REVIEW-READY` state or the historical review timeline.

```text
D8.3 Independent Review       = CHANGES REQUIRED (0/2/0) [historical]
D8.3 remediation               = COMPLETE
D8.3 Independent Re-review     = PASS (0/0/0)
D8.3-IR-P1-1                  = CLOSED
D8.3-IR-P1-2                  = CLOSED
Re-review evidence             = 1a8ef24ce32a7f7185ef8de25897680ca6b17c20
Re-review evidence CI          = #596 / 33388268886 / attempt 1 / 8/8 PASS
D8.3                          = REVIEW-CLOSED
D8.4                          = NOT STARTED
```

D8.3 is `REVIEW-CLOSED`: the reviewed privacy-enforcement contract is
complete and accepted after remediation and independent re-review. This does
not claim retroactive protection or cleanup. Legacy plaintext primary files,
legacy Git/history copies, legacy IndexedDB drafts/conflicts, SQLite private
metadata and `frontmatter_backup`, mixed-state migration, migration
rollback/idempotency, and release/migration closure remain D8.4 scope.
Production code, tests, dependencies, CI configuration, and the product/security
contract are unchanged by this closure synchronization.
