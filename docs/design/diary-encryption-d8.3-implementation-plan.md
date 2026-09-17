# D8.3 — Privacy Enforcement Implementation Plan

> **Historical lineage — not current runtime authority.** Current behavior is
> defined by [Diary Architecture](../architecture/diary.md) and [Diary User
> Guide](../user-guide/diary.md). This file is retained for D8 review
> traceability.

Status: `IMPLEMENTED / REVIEW-READY` for the post-closure follow-up. The
original planning and closure checkpoints remain historical; an independent
follow-up review has not been performed. See the companion [D8.3 Privacy
Enforcement PRD](./diary-encryption-d8.3-privacy-enforcement-prd.md) and the
[post-closure follow-up evidence](./diary-encryption-d8.3-post-closure-followup.md)
for the current product/security contract.

```text
Starting HEAD:       fec4860488ba5c032931ec62d15e07ea09971e59
Implementation HEAD: e895217956577b69c627a7a640202bcbc8ba153a
Evidence/docs HEAD:  recorded by the follow-up docs commit
Independent review:  NOT YET PERFORMED
```

## 1. Exact baseline

The repository was inspected with `git rev-parse HEAD`,
`git status --porcelain=v1`, `git log -5 --oneline --decorate`, and source
searches from the actual checkout:

```text
HEAD:   fe5e0d08580058376c2d8c15045d1ce1ddae9c8f
branch: main
status: clean before adding these two planning documents

fe5e0d0 (HEAD -> main, github/main, github/HEAD) docs(diary): sync D8.2 lifecycle entry point
8710acf fix(ci): restore diary browser and production boundaries
1eb1a9a fix(diary): harden bootstrap diagnostic redaction
4f74088 test(diary): redact bootstrap diagnostics
fb00a25 fix(diary): release date lock before presentation
```
The prompt’s expected `8710acfd7964c690b3ac26d30e2f9b13479b7f53` is the parent
of the actual docs-only HEAD. No reset or checkout was performed. The prompt
supplied exact-head CI evidence is run `#587`, id `33328478854`, with Ubuntu
Node 22/24, macOS Node 24, Windows Node 24, `auth-browser`, `tags-scale`,
`visual`, and `docker-smoke` all passing (8/8). This plan does not alter or
re-run that CI evidence.

`docs/design/diary-encryption-d8.2-body-storage.md` and
`docs/design/diary-encryption-implementation-plan.md` both show D8.2
`REVIEW-CLOSED`, self-review PASS, independent review PASS, and D8.3/D8.4
`NOT STARTED`; the expected REVIEW-READY/PENDING drift is absent.

## 2. Source-backed ownership graph

The following are the owners that an implementation must change or explicitly
leave untouched. Evidence names concrete symbols and call edges.

| Invariant/surface | Entry → owner | Current source evidence | D8.3 owner boundary |
| --- | --- | --- | --- |
| Diary crypto | route → body lease → envelope | `server/routes/diary.ts` and `server/routes/posts.ts:saveManagedDiary` call `withDiaryBodyOperation`; `server/diaryAccess/body.ts` owns AES-GCM envelope/AEAD; `service.ts` owns capability/lease and the live/unwrapped DEK | Keep one adapter/lease and one server-side DEK owner; the client is never a DEK owner and has no plaintext fallback owner. |
| Client session | auth/lock event → session | `src/composables/diary/useDiaryAccessSession.ts` owns state, epoch, generation and clear; `src/lib/auth-session.ts` owns auth generations/locked-response listeners | All derived holders consume this epoch; no second unlock boolean/generation authority. |
| Server session | request → lease | `server/diaryAccess/service.ts:withBodyOperation`, `dropCapability`, quiescence | A lease must close before invalidated operation publishes. |
| Git mutation | history route → mutation | `server/history/routes.ts` → `server/history/git.ts:addAndCommit` → `hash-object`, `git add`, `update-index`, `write-tree`, `commit-tree`, `update-ref`; temp index via `fs.mkdtemp` | Reject managed paths inside `addAndCommit` before any Git/temp side effect. |
| History restore | history route → write | `server/history/restore.ts:restoreHistoricalDocument` uses historical raw and `prepareAtomicTextWrite`; route guard currently rejects managed paths | Preserve route guard and add service/mutation-owner rejection. |
| Primary body | posts/diary route → storage | `server/diaryAccess/body.ts:readDiaryBody/decryptDiaryBody/encryptDiaryBody`; `atomicTextWrite.ts` is the durable writer | Only ciphertext bytes cross durable writer. |
| Draft persistence | editor change → IDB | `useDocumentSave.ts:scheduleDraft` → `useUnsavedDraftPersistence.ts` (`snapshot.content`) → `draftStore.ts` stores `drafts`/`draftConflicts` | Managed Diary writes/read/dispose/pagehide flush are disabled. |
| Recovery UI | discover/read → tabs | `useUnsavedDraftRecovery.ts:discover/readDisk/classify`; `useDraftRecoveryTabs.ts` holds `draftRaw`/`diskRaw`; `DraftRecoveryPane.vue` renders | Filter/disable managed Diary and clear on epoch. |
| Search | query → index/cache | `src/lib/search.ts:buildIndex/primeBody/search`; module `bodyCache`; `searchResults.ts` primes and latest-runs | Structural-only Diary results; no body prime/cache; epoch-gate runner. |
| LinkIndex | scan/update → singleton | `server/linkIndex.ts:rebuild/getIndex/applyWrite/applyRename`; `routes/links.ts` calls unguarded `getIndex`; `useLinkIndex.ts` caches client snapshot | Structural paths only; no managed body parse/edge/title; filter client/server. |
| Tree/list | scan → projection | `server/tree.ts:walk/readFrontmatter/listPostsFlat/buildTree`; managed path currently uses `emptyFrontmatter`, ordinary path uses `gray-matter` | Preserve structural projection; no envelope parsing/private metadata leak. |
| Metadata/migration | metadata route/startup → SQLite | `server/routes/metadata.ts`; `metadataMigration.ts` scans raw and stores `frontmatter_backup`; `frontmatterArchive.ts` reads/writes raw; startup in `prod.ts`/`vite-plugin.ts` | Skip new managed scans/backups; filter locked legacy fields; D8.4 migration. |
| Rename/move | lifecycle route → journal/fs | `posts.ts` PATCH + `documentMutationPolicy.ts`; `folders.ts` rename footprint guard; `renameReferences.ts`, `renameReferenceJournal.ts`, folder transaction modules | Reject any managed footprint before journal/stage/fs/index mutation. |
| Delete | delete route → managed adapter or generic stage/fs/index | `posts.ts` DELETE and `folders.ts` folder delete stage `.nuvyn-delete-inflight-*`, then `LinkIndex` update; the follow-up adds an opaque direct-document owner | Direct managed-document delete uses the adapter-aware owner; folder/bulk footprints remain pre-mutation fail-closed; Note behavior is unchanged. |
| External conflict | watcher/save → tab refs | `useExternalFileChanges.ts`, `useDiskFileChanges.ts`, `useDocumentSave.ts` set `externalRaw`; `SavePostConflictError` carries current raw | Memory-only authorized conflict; epoch+tab/request fence; clear on lock. |
| History/working diff | UI loader → refs | `useHistoryComparisons.ts` (`beforeRaw/afterRaw/diff`), `useWorkingTreeDiffs.ts` request/raw refs | Clear all refs; loaders compare authoritative epoch. |
| PDF | click → browser renderer | `pdfExport.ts:exportPdfDocument` reads live/getPost raw, DOM clone, `html2pdf().save()`; `PdfExportSurface.vue` renders | Current unlocked epoch only; abort/ignore late completion; download is external copy. |
| Clipboard | click → OS clipboard | `VaultView.vue:copyActiveContent` calls `navigator.clipboard.writeText` | Current authorization check; no OS wipe claim. |
| Logs/artifacts | errors → output | `shared/sanitize-diagnostic.ts`; `server/prod.ts`, `vite-plugin.ts`, route logs; `e2e/fixtures/diary.ts`; Playwright config | Structured redaction + canary artifact grep; binary artifacts must be disabled/scrubbed. |
| AI | panel → context/provider | `aiLiveContext.ts` copies raw; `AiPanel.vue` sends; `server/ai/routes.ts` summary/commit-message can read or send body; `chat.ts` inlines context | Disable managed Diary live context/summary/commit-message/body tools in MVP. |
| Resource rendering | resource route → resolver | `server/routes/markdownResources.ts` guards path; client `markdownResources.ts` caches per-render promises | Keep body operation guard; abort/clear on epoch. |
| Route/context | route → reactive mirror | `useCurrentNote.ts` copies live/getPost raw; `createVaultContext.ts` owns dispose callbacks | Guard hydration and clear route/context refs on epoch. |

## 3. Invariants

1. A normalized managed path is enough to select the existing Diary adapter; no
   component may infer authorization from a local flag.
2. Only the existing session/capability owner can issue or revoke body access,
   and the server-side Diary access service is the sole owner of the
   live/unwrapped DEK. The client holds only existing session/capability state
   and necessary transient input, never a DEK. All derived request tokens are
   subordinate to the authoritative session epoch, never a replacement for it.
3. Plaintext exists only in an authorized operation or unlocked in-memory UI.
   Any durable writer, journal, Git primitive, IndexedDB API, SQLite backup,
   index, log, trace, or artifact receives ciphertext, approved structural
   metadata, or nothing.
4. `addAndCommit` rejects any managed Diary path before temp-index creation or
   Git mutation; mixed Note+Diary batches are atomic rejection.
5. A managed Diary body is never parsed as Markdown/frontmatter/link/search/AI
   input unless the Diary adapter has authenticated and identity-checked it.
6. AAD-bound canonical path cannot change through generic rename/move. D8.3
   rejects it rather than introducing a second re-encryption transaction.
7. Persistent managed-Diary draft/recovery and body search are disabled in the
   MVP; ordinary Note persistence/search remain as before.
8. LinkIndex contains no body-derived managed-Diary links, title, snippets, or
   backlinks; structural path/existence is the only allowed projection.
9. Lock/logout/auth invalidation/expiry/replacement synchronously advance the
   epoch before clearing and before any new body result can publish.
10. Explicit PDF/clipboard export is user-visible, current-epoch authorized,
    and outside automatic deletion/wipe guarantees.
11. D8.4 owns all legacy plaintext migration/cleanup; D8.3 prevents new leaks
    and does not silently rewrite/delete legacy state.
12. Ordinary Note behavior is a regression contract for every shared seam;
    the sole deliberate D8.3 projection exception is suppression of
    cross-scope `Note → managed Diary` LinkIndex edges. Note-to-Note links and
    all other Note semantics remain unchanged.

## 4. Architecture decisions

### 4.1 Fail closed before new infrastructure

Do not create an encrypted IndexedDB adapter, encrypted Git history, a second
Diary LinkIndex, a second search database, or a second key/DEK/session owner in
D8.3. Disable persistent managed-Diary drafts/recovery, body search,
body-derived LinkIndex, private metadata migration, generic Diary rename/move,
folder/bulk delete, Diary History, and AI body context. Keep the existing D8.2
primary adapter and Native Vault workspace.

### 4.2 One structural projection

`tree.ts`, `listPostsFlat`, Calendar, metadata public projection, and LinkIndex
must agree on canonical date/path, existence, stable id, and Mood. Title,
summary, tags, frontmatter, links, and snippets are private/body-derived for
managed Diary. Existing SQLite rows are not deleted in D8.3; locked APIs filter
them and D8.4 inventories/cleans them. Ordinary Note projections remain
unchanged, with one deliberate D8.3 exception: cross-scope `Note → managed
Diary` LinkIndex edges are suppressed because the target relation is
body-derived; Note-to-Note edges remain unchanged.

### 4.3 One teardown coordinator

Add coordination at the existing Vault/session seam (the eventual implementation
location may be `useDiaryAccessSession`/`createVaultContext`/`VaultView`, subject
to review), but derive every token from the existing session epoch. The
coordinator owns cancellation/clear ordering, not a new session state machine.

### 4.4 Stable errors and no body in errors

Section 10 freezes the complete D8.3 status/code/client-invalidation matrix;
implementation must not select alternate statuses or invent route strings.
All HTTP errors are `no-store` and contain no raw body, envelope, key, or
provider context. Client-only rejections never become HTTP `409` responses.

### 4.5 AI and explicit external copies

The current AI routes can bypass the body-safe tool guard through client
`liveContext`, `/summary` fallback parsing, and `/commit-message` raw Git
collection. Disable those paths for managed Diary until a separately reviewed
external-copy contract exists. PDF/clipboard are the only D8.3 explicit-copy
surfaces; they require an active epoch and remain outside automatic wipe.

## 5. Workstream decomposition

Each workstream is an invariant-sized implementation commit (or a clearly
reviewed pair of commits) with its tests. Workstreams are not “change a few
files” checklists; each has a security owner and an entry/exit proof.

### D8.3-A — History/Git mutation-owner exclusion

* Add normalized managed-path preflight in `server/history/git.ts:addAndCommit`
  before temp-index creation, `hash-object`, `git add`, tree, commit, or ref.
* Keep route guards for user-facing error semantics; add restore/service guard
  so non-HTTP callers cannot write managed historical raw.
* Reject mixed batches atomically and prove Git object/tree/ref invariance.

### D8.3-B — Draft/Recovery persistence enforcement

* Classify paths before `schedule`, `flush`, IDB `save`, conflict save, move,
  discover, and `readDisk`.
* Disable managed-Diary persistent draft/recovery and all pagehide/dispose
  flushes; keep unlocked tab editing in memory.
* Filter legacy managed records without reading them while locked; defer
  explicit migration/discard to D8.4.

### D8.3-C — Search/body-cache privacy lifecycle

* Exclude managed Diary from private MiniSearch fields and `primeBody`.
* Clear `bodyCache`, results, previews, and provider state on epoch transition;
  suppress stale latest-runner completion.
* Verify no standalone server body cache; any discovered cache is STOP-1.

### D8.3-D — LinkIndex/body-derived isolation

* Make every cold rebuild and incremental update skip managed Diary body bytes.
* Return structural paths only; filter managed source/target edges and titles
  in snapshots/backlinks/rename impact.
* Clear client `useLinkIndex` state on lock. Preserve all Note behavior,
  including Note-to-Note links; intentionally suppress only cross-scope
  `Note → managed Diary` edges as the D8.3 privacy exception.

### D8.3-E — Tree/list/metadata projection hardening

* Preserve `emptyFrontmatter` managed tree/list behavior and enforce a single
  structural projection.
* Filter private managed metadata and tags while locked; prevent new managed
  frontmatter extraction/backups in startup/API migration/archive flows.
* Keep Mood and stable identity behavior; do not delete legacy rows.

### D8.3-F — Rename/move/reference/delete policy

* Ensure document, folder, bulk, delete, and reference operations preflight the
  entire footprint and reject managed Diary before raw read, journal, stage,
  metadata, LinkIndex, or filesystem mutation. Direct Diary delete and any
  folder/bulk delete touching Diary use the current split contract: the
  post-closure opaque owner handles a direct managed document, while folder or
  bulk footprints remain unavailable; see the current transaction in PRD §15.1.
* Keep generic Note rename/move/rewrite/delete behavior unchanged.

### D8.3-G — External conflict and derived UI state

* Bind watcher reads, CAS conflict payloads, history comparisons, working-tree
  diffs, route mirrors, recovery tabs, Monaco models, and ReadingPane renders
  to epoch + identity/request tokens.
* Clear every raw/diff/conflict/DOM/model reference on lock/logout/expiry and
  make stale confirmation/save a no-op or stable invalidation error.

### D8.3-H — Explicit export/clipboard policy

* Require current unlocked authorization/epoch for PDF and clipboard actions.
* Cancel/ignore PDF completion after lock and remove temporary render DOM.
* State that downloaded files/OS clipboard are user-created external copies.

### D8.3-I — Logs/diagnostics/artifact containment

* Replace arbitrary body/error serialization with stable metadata and the
  shared sanitizer where text diagnostics are required.
* Add canary failure tests and artifact grep; use a secret-bearing browser
  profile with trace/video/screenshot disabled or an audited scrubber.

### D8.3-J — Unified lock/logout/expiry teardown

* Introduce the coordinator derived from `useDiaryAccessSession` and auth
  generation; invalidate first, then cancel, clear, and await disposal.
* Cover explicit lock, logout, auth invalidation, capability expiry,
  same-session replacement, restart, route/scope leave, tab close, and editor
  dispose.

### D8.3-K — Cross-cutting AI/resource/tag policy

* Disable managed-Diary AI live context/summary/commit-message/body tools and
  filter private tag associations.
* Keep guarded Markdown resources but abort/clear their per-render cache on
  epoch changes.

## 6. File-level change map

This is the original D8.3 implementation map. The post-closure follow-up has
now implemented the direct managed-delete row below; the remaining rows retain
their reviewed D8.3 owners and boundaries.

| File / module | Current responsibility | Planned change | Security invariant |
| --- | --- | --- | --- |
| `server/history/git.ts` | Generic Git index/tree/commit mutation | Preflight all normalized paths in `addAndCommit` before temp index or Git command | No new managed Diary revision in Git. |
| `server/history/routes.ts` | HTTP History guards and route orchestration | Preserve HTTP `422 diary-history-encrypted-unsupported`/`no-store`; reject before body/diff payload construction | Locked/unsupported History is fail closed. |
| `server/history/restore.ts` | Historical raw restore/atomic write | Add service-level managed-path rejection | No raw Git body restore. |
| `server/history/metadataRevisions.ts` | SQLite raw history metadata journals (`before_raw`, `target_raw`) | Ensure managed routes never call capture/restore; classify legacy rows for D8.4 | No new managed raw journal. |
| `server/routes/posts.ts` | Diary save/read, generic create, rename, delete, recovery | Keep adapter path; route direct managed delete to `server/diaryAccess/delete.ts`; retain folder/footprint preflight and Note behavior | No plaintext durable/index/journal side effect. |
| `server/diaryAccess/delete.ts` | — | Opaque direct managed-Diary delete owner: lease assertion, generation capture, ciphertext-only staging, structural index/metadata cleanup, create-only rollback and reuse quarantine | No decrypt/parse/applyWrite/body journal; foreign generation wins. |
| `server/routes/diary.ts` | Diary date create/read/metadata/LinkIndex update | Keep encrypted write; replace raw LinkIndex update with structural/no-op policy | No body-derived server state. |
| `server/documentMutationPolicy.ts` | Generic create/recover/rename policy | Extend/freeze managed delete/folder-footprint decisions without changing Note rules | AAD path cannot change implicitly. |
| `server/routes/folders.ts` | Folder rename/delete planning, journals, staging | Preflight managed footprint for delete and all mutations before stage/read/index | No partial mixed operation. |
| `server/renameReferences.ts` | Markdown parse/rewrite | Reject managed source/target footprint; no envelope parse | No managed raw rewrite. |
| `server/renameReferenceJournal.ts` | Durable before/after raw journal | Assert managed paths absent before serialization | No plaintext journal payload. |
| `server/folderMoveTransaction.ts` and `server/folderMoveV4*` | Durable folder move/recovery transaction | Enforce preflight at transaction owner and validate no managed raw payload | No staged managed bytes. |
| `server/atomicTextWrite.ts` | Temp/atomic durable writer | Assert managed callers pass envelope bytes; reject plaintext managed input | No plaintext temp/staging. |
| `server/linkIndex.ts` | Cold scan, incremental links/title, singleton snapshots | Skip managed body reads/parsing, suppress edges/title, purge or fail-closed warm legacy state | No managed body-derived index. |
| `server/routes/links.ts` | LinkIndex/backlink/impact APIs | Use structural/filtered snapshot, no unguarded Diary body query | Locked query has no Diary edges. |
| `server/tree.ts` | Walk/frontmatter/tree/list | Keep managed empty-frontmatter branch; add tests/assertions against envelope parsing | Structural-only Diary projection. |
| `server/routes/metadata.ts` | Private/public metadata, migration/export/patch | Filter migration/backups; fail closed managed private mutation/export/restore unless adapter-approved | No locked private metadata leak. |
| `server/metadataMigration.ts` | Raw startup/API scan and SQLite backup | Skip managed Diary for new scan/backup; emit structural status only | No new legacy backup plaintext. |
| `server/frontmatterArchive.ts` | Raw preview/clean/restore | Reject managed Diary in generic archive paths | No body parse/write. |
| `server/prod.ts`, `server/vite-plugin.ts` | Startup recovery/migration/logging | Ensure startup scans/logs exclude managed body and error serialization is stable | No startup leakage. |
| `server/routes/tags.ts`, `server/tagManagement.ts` | Tag listing/preview/undo | Filter managed Diary private associations; preserve Note tag operations | No private metadata side channel. |
| `server/diaryAccess/body.ts` | Envelope parse/encrypt/decrypt | No semantic change; expose only shared classifier/identity checks if required | AEAD/fail-closed contract remains single owner. |
| `server/diaryAccess/guard.ts`, `service.ts` | Access gates/capability leases | Reuse leases for every approved body path; preserve quiescence | Operation-owned authorization. |
| `src/composables/diary/useDiaryAccessSession.ts` | Client state/epoch/clear | Publish teardown hook/snapshot for existing owner; no second state machine | Epoch is authoritative. |
| `src/lib/auth-session.ts`, `src/lib/diary-request.ts` | Auth generations/path-aware requests | Ensure invalidation/423 advances epoch before result publication | No late auth/body result. |
| `src/composables/vault/draft-recovery/draftStore.ts` | IDB draft/conflict schema and CRUD | Add managed-Diary rejection/filter before IDB access; do not migrate/delete legacy | No persistent managed plaintext. |
| `src/composables/vault/draft-recovery/useUnsavedDraftPersistence.ts` | Debounced/pagehide/dispose writes | Skip managed paths and cancel/avoid flush | No auto-flush plaintext. |
| `src/composables/vault/draft-recovery/useUnsavedDraftRecovery.ts` | Discover/read/classify recovery | Filter managed records and epoch-gate async reads | No locked recovery body. |
| `src/composables/vault/draft-recovery/useDraftRecoveryTabs.ts`, `DraftRecoveryPane.vue` | Recovery raw refs/render | Clear refs and present unavailable state | No stale body UI. |
| `src/composables/vault/editor-tabs/useDocumentSave.ts` | Autosave, CAS conflict, recovered draft | Epoch/managed checks; clear externalRaw and reject stale save | No late conflict publication. |
| `src/composables/vault/editor-tabs/useExternalFileChanges.ts`, `useDiskFileChanges.ts` | Watch/poll/read external raw | Add epoch/identity fence and avoid envelope parse | Locked watcher cannot rehydrate. |
| `src/composables/vault/useEditorTabs.ts` | Tab workspace/Diary clear/unmount | Make clearing synchronous/awaitable; dispose models/raw without draft flush | Complete editor teardown. |
| `src/composables/vault/useHistoryComparisons.ts`, `useWorkingTreeDiffs.ts` | Raw/diff comparison refs | Clear all refs; epoch-gate loaders | No locked diff. |
| `src/composables/vault/useLinkIndex.ts` | Client index snapshot/subscription | Filter/clear managed state on epoch | No stale links. |
| `src/lib/search.ts`, `src/lib/searchResults.ts` | MiniSearch/bodyCache/query runner | Exclude Diary body/private fields; clear/epoch-gate | No Diary body search/cache. |
| `src/views/VaultView.vue` | Lock watcher, copy/diff/PDF UI | Call unified teardown; gate copy/diff/PDF; clear route/recovery/history refs | No stale UI/export. |
| `src/components/vault/EditorPane.vue`, `monacoModelRegistry.ts` | Monaco models/recent/view localStorage | Clear/disallow managed recent links; dispose managed models/view state on lock | No sensitive navigation/model retention. |
| `src/components/vault/ReadingPane.vue`, `src/composables/vault/useMarkdownRender.ts` | Raw render/TOC/abort | Abort and epoch-check render completion | No stale DOM. |
| `src/composables/vault/useCurrentNote.ts`, `context/createVaultContext.ts` | Route mirror/context disposal | Clear guarded refs and coordinate teardown | No hidden body mirror. |
| `src/lib/pdfExport.ts`, `PdfExportSurface.vue` | Browser DOM/PDF export | Capture epoch, require authorization, cancel/ignore stale completion | Explicit export only. |
| `src/composables/vault/aiLiveContext.ts`, `src/components/vault/AiPanel.vue` | Raw document/diff/recovery snapshot | Reject managed Diary context and clear on lock | No unintended provider disclosure. |
| `server/ai/routes.ts`, `server/ai/chat.ts`, `server/ai/tools.ts` | AI routes/tools/SSE | Fail closed for managed summary/commit/live body; filter raw SSE/tool output | No AI bypass. |
| `src/lib/markdownResources.ts`, `server/routes/markdownResources.ts` | Guarded resource expansion | Keep guard; abort/clear client promise cache by epoch | No cross-epoch resource. |
| `shared/sanitize-diagnostic.ts`, `e2e/fixtures/diary.ts` | Diagnostic redaction/attachments | Add body/error canaries and artifact-safe serialization | No secret artifacts. |
| `playwright.config.ts`, Diary E2E specs | Trace/screenshot/retry profile | Add secret-bearing profile/expectations without masking failures | Binary artifact containment. |

## 7. Dependency ordering

The implementation order must keep the boundary true at every merge:

```text
Existing D8.2 adapter + session epoch
          │
          ├── A: Git mutation-owner exclusion ──┐
          │                                      ├── History route/restore tests
          ├── J: teardown coordinator ───────────┼── UI/cache/conflict invalidation
          │                                      │
          ├── E: structural projection ──────────┼── tree/list/metadata/tags
          │                                      └── D: LinkIndex structural policy
          │                                             │
          │                                             └── C: search/body cache
          ├── B: draft/recovery persistence ───────────┐
          ├── F: rename/move/reference/delete policy ──┤
          ├── G: conflict/diff/route/model state ──────┤
          ├── H: PDF/clipboard explicit copy ───────────┤
          └── I/K: diagnostics + AI/resources/tags ─────┘
```

Concrete order:

1. Freeze the invariant/error matrix in §10 and add
   characterization/negative tests (no behavior change yet).
2. Land A’s mutation-owner rejection and B’s no-write draft guard; these stop
   new durable leakage before UI work.
3. Land E and D together where LinkIndex/list contracts meet; do not merge a
   cold-scan change without the endpoint/client filtering tests.
4. Land C, then J’s epoch/teardown wiring with G’s raw-holder clearing. A
   temporary feature flag is not a substitute for tests; each merged commit
   must leave locked behavior fail closed.
5. Land F, H, and K; then I’s artifact evidence.
6. Run the full browser/platform matrix, independent review, remediation, and
   docs-only lifecycle closure. Do not mark D8.3 `REVIEW-CLOSED` earlier.

## 8. Transaction / rollback behavior

| Operation | Preflight | Commit side effects | Failure/rollback contract |
| --- | --- | --- | --- |
| Managed save/create | Normalize identity; body lease; decrypt/CAS in memory; encrypt envelope | `prepareAtomicTextWrite/Create` writes ciphertext; metadata transaction; no Git/Diary LinkIndex body update | Auth/tag/identity failure leaves original bytes/metadata unchanged; temp cleanup; LinkIndex structural update only. |
| History commit | Inspect every path, reject if any managed Diary | Only Note paths reach temp index/Git commands | Reject before `mkdtemp`, `hash-object`, `git add`, tree/ref; no rollback needed because no mutation. |
| History restore | Reject managed path before reading historical raw | Note restore uses existing atomic/journal path | Managed rejection leaves file/metadata/index untouched; Note rollback unchanged. |
| Draft save/conflict | Classify path and session epoch | Managed: no IDB transaction; Note: existing IDB transaction | Managed call returns client-only `diary-draft-recovery-unsupported`; no legacy record deletion. |
| Search/index update | Filter managed path before body fetch/parse | Note index/cache update; structural Diary path only | Stale result discarded; on lock clear caches/results. |
| Rename/move/reference/delete | Classify the operation and complete footprint; direct managed document delete enters the opaque owner, any folder/bulk managed footprint rejects | Only Note footprint, or a proven direct managed delete transaction, reaches filesystem/index owners | Direct delete uses the follow-up owner and returns `200`, `423`, `404`, `503`, or `409` as specified in the PRD; folder/bulk and rename/move/reference retain frozen `422` pre-mutation rejection and mixed requests have no partial mutation. |
| Conflict resolution | Check current epoch, tab identity, request token and lease | Authorized in-memory save only | Epoch mismatch returns `diary-session-invalidated`; no save, draft, index, or dialog publication. |
| PDF | Check unlocked epoch before and after render | Browser DOM clone and user download | Lock aborts/removes DOM; late result cannot call download. Downloaded file remains external. |
| Clipboard | Check unlocked epoch immediately before copy | OS clipboard write | Lock does not promise clipboard wipe; no automatic persistence by Nuvyn. |
| Metadata migration/archive | Classify all files before scan/backup | Managed excluded; Note continues existing migration | No managed body/backup mutation; legacy managed state remains for D8.4. |

No operation may “repair” an encrypted envelope by parsing it as Markdown. Any
unknown version, malformed bytes, AAD mismatch, or authentication failure stops
at the adapter with no downstream side effect.

Direct managed-Diary deletion is now owned by the follow-up transaction in
`server/diaryAccess/delete.ts`. It captures the source inode and structural
identity, writes only a structural intent, moves the existing ciphertext inode
to staging, removes only the structural LinkIndex path and authoritative
metadata, and unlinks that same generation. Create-only inode restoration and
structural quarantine are the only rollback/reuse paths; the owner never calls
`reidentifyReusedPath`, parses the body, or writes a plaintext journal. A
folder/bulk delete whose footprint contains Diary still returns the frozen
`422 diary-encrypted-delete-unsupported` before staging, and Note-only delete
is unchanged.

## 9. Lock teardown sequencing

The implementation must make this sequence observable and testable:

```text
1. Authoritative session owner advances epoch/generation synchronously.
2. New Diary body operations, UI publications, and explicit exports are rejected.
3. Abort/cancel timers, fetches, watchers, render controllers, workers, IDB
   flush promises, search runners, LinkIndex subscriptions, and PDF waiters.
4. Clear tab.raw/originalRaw/externalRaw, Monaco models, ReadingPane DOM/TOC,
   route/current-note/context refs, recovery/history/working-tree/diff refs,
   search/bodyCache/results, link snapshots, AI snapshots, conflict dialogs,
   and any in-memory resource cache.
5. Remove managed entries from recent-link/view-state localStorage; retain only
   approved structural tab paths/active state.
6. Await disposal/quiescence where APIs permit; ignore any completion whose
   captured epoch is no longer current.
7. Server lease quiesces and zeroes DEK through the existing service owner.
```

Apply the same ordering to explicit lock, logout, auth invalidation/423,
capability expiry, same-session replacement, route/scope leave, tab close,
editor dispose, and restart (restart reconstructs no body/key from storage).

## 10. Error contracts

The following matrix is frozen at Gate 0. Implementation must use these exact
statuses, codes, and client invalidation actions; it must not invent ad hoc
route strings or turn a client-only rejection into HTTP `409`. Every HTTP error
is `Cache-Control: no-store` and contains no raw/envelope/key/provider data.

| Surface / operation | Transport and status | Stable code | Client behavior |
| --- | --- | --- | --- |
| Diary body read/save/create/resource without a current lease | HTTP `423` | `diary-locked` | Advance the Diary epoch synchronously, clear Diary holders, show the existing unlock flow, and publish no body. |
| Diary History body log/file/diff/content-hashes/restore | HTTP `422` | `diary-history-encrypted-unsupported` | Keep the session, show unavailable, and perform no Git/filesystem mutation. |
| Generic recovery targeting managed Diary identity | HTTP `422` | `diary-recovery-identity-required` | Show unavailable and create no recovery state. |
| Managed document rename/move | HTTP `422` | `diary-encrypted-rename-unsupported` | Show unavailable; do not read raw content or mutate journal/staging/filesystem/index state. |
| Managed folder rename/move or reference rewrite footprint | HTTP `422` | `diary-encrypted-reference-unsupported` | Show unavailable; reject the complete footprint with no partial Note mutation. |
| Managed direct document delete without a current lease | HTTP `423` | `diary-locked` | Advance the Diary epoch synchronously and publish no body. |
| Managed direct document delete with missing/invalid metadata | HTTP `503` | `diary-metadata-unavailable` | Show unavailable; leave the ciphertext generation untouched. |
| Managed direct document delete with external generation/path reuse | HTTP `409` | `diary-delete-path-reused` or `diary-delete-generation-changed` | Preserve the external generation; quarantine/restore only with structural ownership proof. |
| Managed folder/bulk delete whose footprint contains managed Diary | HTTP `422` | `diary-encrypted-delete-unsupported` | Reject before raw read, staging, journal, metadata, filesystem, or index mutation. |
| Managed private metadata migration/archive/tag mutation | HTTP `422` | `diary-private-metadata-unsupported` | Show unavailable; no private-field read or backup mutation. Public structural projection remains `200`. |
| Managed AI live context | HTTP `422` | `diary-ai-context-unsupported` | Reject before raw read or provider call; no context publication. |
| Managed AI summary fallback | HTTP `422` | `diary-ai-summary-unsupported` | Reject before raw read or provider call. |
| Managed AI commit-message body collection | HTTP `422` | `diary-ai-commit-message-unsupported` | Reject before Git collection or provider call. |
| Managed Diary draft/recovery IDB write, discovery, or read | Client-only rejection; no HTTP request | `diary-draft-recovery-unsupported` | Make no IndexedDB call, clear candidate refs, and show “Diary recovery unavailable.” |
| Search, LinkIndex, tree, and list projections | HTTP `200` filtered response | No error code | Return structural data only; clear managed derived state on epoch changes. |
| Stale client body operation, conflict, PDF, or clipboard after epoch advance | Client-only rejection; no HTTP request | `diary-session-invalidated` | Discard the result, clear the relevant holder, and never retry or publish body; a server request that loses its lease is handled as `423 diary-locked`. |

## 11. Security negative tests

Tests are designed before implementation and must include source-owner and
observable-artifact assertions:

| Scenario | Expected assertion |
| --- | --- |
| Locked History log/file/diff/restore | HTTP `422 diary-history-encrypted-unsupported`; no raw response; no Git/fs mutation. |
| Diary create/save/recovery/restore/rename/move | No new Git commit/object/tree/ref; unsupported operation leaves bytes/metadata unchanged. |
| Mixed Note + Diary History or folder batch | Whole request rejected before temp index/journal/stage; Note not partially committed. |
| IndexedDB Diary draft/conflict write | No `drafts`/`draftConflicts` record; no pagehide/dispose flush; Note record still works. |
| Locked legacy IDB draft discovery | Record is not read or rendered; no silent delete/migrate. |
| Unlock → search → lock | Diary result/cache/snippet gone; same query cannot rediscover; Note result remains. |
| Paused search result `E1`, lock → `E2`, resolve | Result ignored; cache/UI remain empty. |
| Cold LinkIndex on encrypted envelope | Envelope is never sent to gray-matter/link parser; only structural path remains. |
| Warm LinkIndex after lock | Managed edges/title/backlinks are absent or query fails closed; client snapshot cleared. |
| Ordinary Note backlinks | Note-to-Note link unchanged; cross-scope `Note → managed Diary` edge is intentionally suppressed by the D8.3 projection rule; no other Note regression. |
| Tree/list/metadata/tag locked | Date/path/existence/id/Mood allowed; no private title/summary/tags/frontmatter/backup. |
| Metadata migration startup/API | Managed Diary raw not scanned/backed up; legacy records filtered while locked. |
| Managed rename/folder/reference and folder/bulk delete | Exact frozen `422` code for the operation before raw read/journal/stage/fs/index; no partial state. |
| Direct Diary delete | HTTP `200` on a valid unlocked document; `423`/`404`/`503`/`409` for the frozen lease, missing, metadata, and generation conflicts; no plaintext or body-derived side effect. |
| Mixed folder/bulk delete | HTTP `422 diary-encrypted-delete-unsupported` for any managed footprint; no Note subset is partially deleted. |
| External conflict/CAS | Plaintext conflict is memory-only while authorized; stale confirm/save cannot commit. |
| Envelope bytes in diff/reader/recovery | Never rendered/parsed as Markdown; malformed/unknown/auth-failed envelope stops. |
| Lock/logout/expiry/replacement | Every raw/cache/model/dialog/ref is cleared; server lease quiesces; no late publication. |
| PDF during lock race | Late render cannot download; no server temp; explicit download semantics visible. |
| Clipboard | Copy requires current unlock; no claim of OS clipboard wipe after lock. |
| AI summary/commit/live context | Managed request rejected before raw read/provider call; Note AI unchanged. |
| Diagnostic canaries | `D8_3_BODY_SECRET_...`, password, capability, envelope absent from server output, logs, test-results, attachments, screenshots, trace archives, and error context. |
| Unknown/malformed AAD | No parser/index/cache/UI side effect; stable sanitized error. |

## 12. Ordinary Note regression tests

The following existing suites are the minimum regression inventory; D8.3 adds
managed cases beside them and does not weaken assertions:

* Server History: `server/__tests__/history-git.test.ts`,
  `history-routes.test.ts`, `history-diff.test.ts`,
  `history-folder-coordination.test.ts`, and
  `history-metadata-revisions.test.ts`.
* Server storage/structure: `server/__tests__/atomicTextWrite.test.ts`,
  `tree.test.ts`, `linkIndex.test.ts`, `frontmatterArchive.test.ts`,
  `metadataMigration.test.ts`, `renameReferences.test.ts`,
  `tagManagement.test.ts`, and `routes/folders.test.ts`.
* Client History/link/search: `src/lib/__tests__/history-api.test.ts`,
  `src/lib/__tests__/search.test.ts`, `searchResults.test.ts`,
  `src/composables/vault/__tests__/useHistory*.test.ts`,
  `useLinkIndex.test.ts`, and `useWorkingTreeDiffs.test.ts`.
* Client editor/recovery: `useDocumentSave*.test.ts`,
  `useTabPersistence.test.ts`, `useEditorTabs.test.ts`, all draft-recovery
  characterization/management/cleanup/transaction tests, and
  `useCurrentNote.test.ts`.
* UI/export/diagnostic: `ReadingPane.test.ts`, `MonacoEditorPane.test.ts`,
  `AiPanel.test.ts`, `src/lib/__tests__/pdfExport.test.ts`,
  `src/__tests__/sanitize-diagnostic.test.ts`.

Regression assertions must cover ordinary Note save, History, Recovery, draft,
search, backlinks, rename, folder move, reference rewrite, conflict, PDF,
clipboard, tree/list, and metadata/tag behavior with the same expected payloads
and side effects as before D8.3.

## 13. Browser / E2E tests

Add or extend browser scenarios without `test.skip`, timeout inflation, retry
inflation, sleeps, or platform-conditional masking:

1. Unlock Diary, edit/save, lock, and assert editor/reader/diff/recovery/search/
   LinkIndex/AI/route content is gone and structural Calendar/tree state remains.
2. Start a paused search, PDF render, disk-change read, CAS conflict, Markdown
   resource, or recovery classification under epoch E1; lock to E2; release the
   promise and assert no UI/cache/tab/download rehydrates.
3. Inspect IndexedDB in browser context after edit/dirty/pagehide-like close;
   prove no managed `drafts`/`draftConflicts` plaintext. Repeat for ordinary Note.
4. Exercise locked History/Recovery/rename/folder/delete/reference/metadata/tag
   actions and assert stable unavailable semantics, no partial filesystem state,
   and no ciphertext Markdown view.
5. Exercise explicit PDF/clipboard while unlocked and lock races; verify only
   current-epoch action succeeds and UI explains the external-copy boundary.
6. Exercise logout, auth invalidation, capability expiry, same-session
   replacement, reload, route leave, tab close, and editor dispose.
7. Run representative failure paths with canary secrets and inspect browser
   console, attachments, screenshots/metadata, traces, and server output.

Existing Diary fixture behavior (`e2e/fixtures/diary.ts`) may retain sanitized
bootstrap diagnostics, but no body/capability/password is allowed in them.
Secret-bearing tests use trace/video/screenshot-off configuration or an audited
post-capture scrub; this is an artifact policy, not a reason to hide failures.

## 14. Docker / build implications

No Dockerfile, dependency, build script, or CI configuration is changed by this
planning task. Implementation must preserve:

* server/client TypeScript boundaries and existing `npm run typecheck`/
  `npm run build` behavior;
* production startup recovery and migration behavior for ordinary Note;
* nested-vault Git setup and `docker-smoke` contract;
* browser-compatible IndexedDB/session teardown APIs and no Node-only client
  dependency;
* no new persistent database, worker, or crypto runtime unless a separately
  approved design supersedes the D8.3 MVP.

If a planned change needs a schema/version, it must be additive, migration-safe,
and reviewed as D8.4 scope; D8.3 must not silently transform legacy data.

## 15. CI matrix

Retain the prompt-supplied green baseline and add D8.3 cases to the narrowest
existing suites before the full matrix:

| Dimension | D8.3 evidence |
| --- | --- |
| Ubuntu Node 22 | Server unit/typecheck, Git/metadata/index/negative tests. |
| Ubuntu Node 24 | Same plus full client/server build and race tests. |
| macOS Node 24 | Path/temp/clipboard/PDF/browser teardown smoke. |
| Windows Node 24 | Path/case/temp/Git staging and browser teardown smoke. |
| `auth-browser` | Lock/logout/expiry/session replacement and late-result E2E. |
| `tags-scale` | Managed metadata/tag filtering does not regress Note scale. |
| `visual` | Locked structural projection and cleared body UI screenshots; no secret artifacts. |
| `docker-smoke` | Production startup/migration/History boundary and no plaintext artifact. |

Run focused unit tests, then `typecheck`, build, browser, and the complete
matrix. A green matrix is necessary evidence, not independent-review closure.

## 16. Commit strategy

Suggested small, reviewable commits (each with tests and no unrelated cleanup):

1. Freeze error contracts and add mutation-owner/draft characterization tests.
2. D8.3-A History/Git owner exclusion and restore boundary.
3. D8.3-B Draft/Recovery no-persistence guard.
4. D8.3-E structural tree/list/metadata/migration projection.
5. D8.3-D LinkIndex structural isolation.
6. D8.3-C Search/body-cache exclusion and epoch fencing.
7. D8.3-J teardown coordinator plus D8.3-G conflict/diff/model clearing.
8. D8.3-F rename/move/reference/delete policy.
9. D8.3-H explicit PDF/clipboard and D8.3-K AI/resource/tag policy.
10. D8.3-I diagnostics/artifact canaries and cross-platform evidence.
11. D8.3 regression/evidence sync (docs-only lifecycle status after review).
12. Post-closure direct managed-delete owner, History status projection, and
    TreeRow capability projection (see the follow-up evidence document).

If a dependency requires combining commits, preserve one coherent invariant
and show the intermediate test proof; never land a temporary plaintext path.

## 17. Review gates

### Gate 0 — Plan approval

Review this plan/PRD, source evidence, statuses, the frozen error matrix,
unsupported semantics, and D8.4 boundary. The original Gate 0 checkpoint
confirmed no production code changed; the later post-closure follow-up is a
separate implementation/review-ready checkpoint.

### Gate 1 — Owner-level security review

Inspect diffs at Git mutation, atomic writer, IDB, LinkIndex, migration,
rename/staging, AI, and teardown owners. Verify route guards are defense in
depth, not the only enforcement.

### Gate 2 — Negative and Note regression review

Review raw artifact assertions, epoch races, lock/expiry matrix, and ordinary
Note side-by-side results. Reject skips, retries, timeout/sleep masking, and
platform-specific bypasses.

### Gate 3 — Browser/platform/artifact review

Review all eight CI dimensions, browser DOM/storage inspection, Git object
inspection, canary grep, trace/screenshot policy, and Docker smoke evidence.

### Gate 4 — Independent review

Lifecycle becomes `REVIEW-READY` only after implementation evidence is complete.
Independent review records P0/P1/P2 findings; remediation and a fresh
independent re-review are required before `PASS (0/0/0)` and docs-only
`REVIEW-CLOSED`.

## 18. STOP conditions

Stop implementation/review immediately on any of:

* managed Diary plaintext at filesystem temp/staging/journal, Git, IndexedDB,
  SQLite backup, LinkIndex, persistent search, recovery payload, logs,
  telemetry, trace, screenshot, or failure artifact;
* locked body or body-derived preview through History, Recovery, Search,
  LinkIndex, tree/list, route, tab, conflict, AI, or renderer;
* any generic parser consuming an encrypted/malformed envelope;
* AAD-bound path changed without authenticated identity-checked re-encryption;
* stale E1 completion publishing after lock/E2;
* a second key/session/body/History owner;
* ordinary Note semantics changed without a shared-bug review and regression
  evidence;
* a test is made green by skip/retry/timeout/sleep/platform masking;
* legacy state is silently migrated, deleted, rewritten, or claimed protected.

## 19. Definition of Done

The D8.3 implementation may be proposed for independent review only when:

```text
[ ] Exact HEAD/tree/lifecycle evidence is recorded.
[ ] Every required body/derived surface has an owner and test.
[ ] addAndCommit and restore mutation owners fail closed for managed Diary.
[ ] No new Diary plaintext reaches durable or long-lived unapproved state.
[ ] Draft/Recovery, Search, LinkIndex, metadata, rename, conflict, export,
    AI, renderer, and teardown policies match the PRD.
[ ] Epoch fencing covers lock/logout/invalidation/expiry/replacement and all
    late async paths.
[ ] Unknown/malformed/AAD/auth failures stop before generic parsers.
[ ] Managed rename/move/reference and folder/bulk delete remain pre-mutation
    atomic rejection; direct managed-document delete uses the opaque owner;
    Note operations remain unchanged.
[ ] Git object/tree/ref, IndexedDB, logs, traces, screenshots, attachments,
    and server output have observable negative assertions.
[ ] Legacy migration/cleanup is explicitly deferred to D8.4.
[ ] Focused tests, typecheck, build, browser/E2E, eight CI dimensions, and
    docker-smoke pass without masking.
[ ] Independent Review PASS (P0/P1/P2 = 0/0/0) is recorded separately from
    green tests/CI, followed by docs-only lifecycle closure.
```
