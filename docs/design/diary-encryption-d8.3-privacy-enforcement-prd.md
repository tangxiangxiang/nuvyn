# D8.3 — Privacy Enforcement PRD

> **Historical lineage — not current runtime authority.** Current behavior is
> defined by [Diary Architecture](../architecture/diary.md) and [Diary User
> Guide](../user-guide/diary.md). This file is retained for D8 review
> traceability.

Status: `IMPLEMENTED / REVIEW-READY` for the post-closure follow-up. The
original D8.3 closure remains `REVIEW-CLOSED` as a historical event; this
follow-up has not received an independent follow-up review. D8.4 remains
`NOT STARTED`.

This is the current source-backed D8.3 contract. The post-closure follow-up
updates the direct managed-Diary delete capability only; it does not change
the encrypted History, migration, or legacy-cleanup boundaries.

## 1. Status / lifecycle

The required baseline was rechecked rather than assumed:

```text
HEAD:   fe5e0d08580058376c2d8c15045d1ce1ddae9c8f
branch: main
tree:   clean before this document-only change
HEAD~0: docs(diary): sync D8.2 lifecycle entry point
HEAD~1: fix(ci): restore diary browser and production boundaries
```

`fe5e0d0` is a docs-only synchronization commit after the prompt’s expected
`8710acfd7964c690b3ac26d30e2f9b13479b7f53`; it is not a D8.3 implementation
change. `docs/design/diary-encryption-d8.2-body-storage.md` and the canonical
`docs/design/diary-encryption-implementation-plan.md` both record D8.0,
D8.1, and D8.2 as `REVIEW-CLOSED` with self-review and independent review
`PASS (P0/P1/P2 = 0/0/0)`, and D8.3/D8.4 as `NOT STARTED` at that historical
planning checkpoint. No lifecycle drift was found in that baseline record.

The prompt supplied CI run `#587` / run id `33328478854` with 8/8 required
jobs passing. That result is recorded as supplied baseline evidence; this
planning task does not re-run or alter CI.

The intended lifecycle after implementation is:

```text
NOT STARTED → PLAN-READY → IMPLEMENTING → REVIEW-READY
→ Independent Review → remediation (if required)
→ Independent Re-review PASS → docs-only closure → REVIEW-CLOSED
```

Passing tests or green CI alone must not be recorded as an independent-review
pass.

### Post-closure follow-up checkpoint

```text
Starting HEAD:       fec4860488ba5c032931ec62d15e07ea09971e59
Implementation HEAD: e895217956577b69c627a7a640202bcbc8ba153a
Evidence/docs HEAD:  recorded by the follow-up evidence commit
Final HEAD:          recorded after the docs/evidence commit is pushed
Independent review:  NOT YET PERFORMED
```

The implementation/test checkpoint adds an adapter-aware opaque delete owner,
an explicit physical-path History status filter, and a managed-Diary TreeRow
History capability guard. The original independent-review records are not
rewritten; they describe the contract and implementation state at their own
historical checkpoints.

## 2. Background

D8.0–D8.2 established authenticated encrypted primary storage for a managed
Diary document whose canonical identity is `diary/YYYY-MM-DD.md`. D8.3 is the
privacy-enforcement phase: it must follow the plaintext from an authorized
read through editing, derived data, conflicts, exports, and teardown. The
security question is:

> After a managed Diary body becomes authorized plaintext, can it reach an
> uncontrolled durable or long-lived plaintext surface, or can an old async
> result publish it after the session is locked?

The D8.3 closure answer must be provably **no**. When an existing surface has
no safe owner, disabling that surface for managed Diary is preferred to adding a
second crypto, history, cache, or session subsystem.

## 3. D8.2 inherited contracts

These contracts are frozen and are not redesigned by D8.3:

| Contract | Inherited rule |
| --- | --- |
| Managed identity | One date maps to one `diary/YYYY-MM-DD.md` managed document; stable `documentId` remains owned by `DocumentMetadata`. |
| Workspace | Reuse Calendar, Native Vault workspace, ReadingPane, EditorPane, existing tabs, route, dirty/save/CAS lifecycle, and metadata owner. No Diary-specific editor, reader, workspace, tab lifecycle, or route. |
| Session authority | `useDiaryAccessSession` is the sole client authority with `UNINITIALIZED`, `LOCKED`, `UNLOCKING`, `UNLOCKED(sessionEpoch)`, `LOCKING`; server `diaryAccess/service.ts` is the sole capability/body-operation authority and the sole owner of the live/unwrapped DEK. |
| Key material | The server-side Diary access service solely owns the live/unwrapped DEK; the client never owns a DEK and holds only existing session/capability state plus necessary transient password/input. These values and plaintext body are ephemeral runtime values only: they never enter local/session storage, IndexedDB, SQLite, Git, URLs, logs, telemetry, storage state, traces, or error artifacts. |
| Envelope | AES-256-GCM, fresh 96-bit nonce per write, 128-bit tag, explicit version/algorithm, vault/document/path/version AAD, fail closed on unknown/malformed/identity/auth failure. |
| Primary body | Diary routes create/read/save through the existing body operation and persist the authenticated envelope; plaintext is returned only to an authorized operation. |
| Ordinary Note | Ordinary Note behavior remains unchanged unless a shared infrastructure fix is required and covered by explicit Note regressions. D8.3 intentionally supersedes only the cross-scope `Note → managed Diary` LinkIndex projection; Note-to-Note links and all other Note semantics remain unchanged. |

## 4. Problem statement

The primary save path is encrypted, but existing lifecycle surfaces are broader
than `PUT /api/posts/*`. Source inspection found:

* History route guards reject managed Diary in HTTP callers, while the actual
  Git mutation owner `server/history/git.ts:addAndCommit` is generic and can
  still receive a mixed path batch.
* `server/linkIndex.ts` has an unguarded singleton rebuild/query path and Diary
  save/create currently call `applyWrite(logicalPath, raw)`, retaining plaintext
  links/title in long-lived server memory. Cold generic rebuild can parse an
  encrypted envelope as Markdown.
* IndexedDB `drafts` and `draftConflicts` store `content` strings from
  `useUnsavedDraftPersistence`; disposal/pagehide can flush them without a
  Diary policy.
* Client search `primeBody()` stores response bodies in a module-level
  `bodyCache`, and search results have no authoritative Diary session epoch.
* Folder delete lacks the managed-Diary preflight that folder rename has;
  rename/reference journals and staging APIs serialize raw before/after data
  when their callers are not blocked.
* External-conflict, history-comparison, recovery-tab, current-note, Monaco,
  PDF, clipboard, and AI context paths hold or transmit plaintext in memory;
  lock teardown currently does not synchronously clear every holder or suppress
  every late result.
* Metadata migration exposes `frontmatterBackup` records and scans raw Markdown
  at startup; title/summary/tags in SQLite are privacy-sensitive even though
  Mood and canonical date/path are approved structural metadata.

## 5. Security goals

1. Every managed-Diary body-bearing surface uses the D8.2 adapter/authorized
   body operation, fails closed, or is an explicit user-created external copy.
2. No new managed-Diary body revision (plaintext, ciphertext, envelope, temp,
   recovery, restore, rename, move, or reference rewrite) enters a new vault
   Git commit.
3. No new managed-Diary plaintext enters filesystem temp/staging/journals,
   IndexedDB, SQLite backups, LinkIndex, persistent search, logs, telemetry,
   traces, screenshots, storage state, or failure artifacts.
4. Locked, logged-out, auth-invalidated, expired, and replaced sessions expose
   no Diary body or body-derived preview.
5. A result started under session epoch `E1` cannot repopulate a cache, tab,
   dialog, DOM, index, or model after lock advances the authoritative epoch.
6. Unknown or malformed encrypted envelopes never flow to Markdown,
   frontmatter, link, search, or AI parsers.
7. Ordinary Note read/write/history/recovery/search/link/rename/move/conflict/
   export/tree behavior remains unchanged. The sole deliberate projection
   exception is suppression of cross-scope `Note → managed Diary` LinkIndex
   edges, because that target relation is body-derived sensitive data; Note-
   to-Note edges remain unchanged.

## 6. Non-goals

* No unrelated production implementation or second owner; the post-closure
  follow-up adds only the reviewed managed-document delete owner and its
  structural recovery seam described in §15.1.
* No retroactive rewrite, purge, deletion, or migration of legacy plaintext
  primary files, Git history, IndexedDB drafts/conflicts, or metadata backups.
* No encrypted IndexedDB draft crypto owner, encrypted Diary Git history, or
  Diary-specific LinkIndex in D8.3 MVP.
* No claim that a user’s OS clipboard or an explicitly downloaded PDF can be
  wiped by Nuvyn.
* No change to ordinary Note semantics and no second Diary lifecycle owner,
  except for the intentional cross-scope `Note → managed Diary` LinkIndex
  suppression defined in §13.
* No promise to protect an already compromised/unlocked browser or server
  process, developer tools, or user-authorized external copies.

## 7. Threat model

D8.3 protects a local filesystem/database/Git/diagnostic reader who does not
possess the Diary secondary password. It covers server and browser memory
retention, durable temporary files, cache/index derivation, lifecycle races,
and artifact collection. It does not protect plaintext while an authorized
operation is actively rendering or editing, nor content the user deliberately
copies to the clipboard or downloads as a PDF. Those explicit copies must be
user-visible and are outside Nuvyn’ automatic storage guarantee.

The primary login password, `NUVYN_MASTER_KEY`, and AI credential encryption
are separate concerns. D8.3 must not reuse them as a second Diary key owner.

## 8. Privacy classification

| Data | Classification | Locked visibility | Durable plaintext allowed? | D8.3 disposition |
| --- | --- | --- | --- | --- |
| Diary body | secret | No | No | Adapter/authorized memory only; otherwise reject. |
| Secondary password | secret | No | No | Existing session owner receives it only as necessary transient input. |
| KEK | secret | No | No | Existing server-side Diary access owner only; never client-owned or persisted. |
| Live / unwrapped DEK | secret | No | No | Solely owned by the server-side Diary access service; the client never owns a DEK and holds only existing session/capability state plus necessary transient input. |
| Diary capability | secret | No | No | `diaryAuthFetch`/body lease only; never ambient storage. |
| `documentId` | structural | Yes when approved | Approved metadata only | Keep in `DocumentMetadata`; never body-derived. |
| Canonical date/path | structural | Yes | Yes | Calendar/tree/list identity projection. |
| Existence | structural | Yes | Yes | File/tree existence is allowed. |
| Mood | structural product metadata | Yes per D7 contract | Yes | Keep existing metadata owner. |
| Title | privacy-sensitive metadata | No unless explicitly approved | No new plaintext Diary title | Locked projection is basename/date; no body/frontmatter extraction. |
| Summary | privacy-sensitive metadata | No | No new plaintext Diary summary | Hide from locked list/tag/search; D8.4 handles old rows. |
| Tags | privacy-sensitive metadata | No | No new plaintext Diary tags | Hide from locked list/tag/search; D8.4 handles old rows. |
| Links/backlinks | body-derived metadata | No | No | Exclude managed Diary from body-derived LinkIndex in MVP. |
| Search snippets | body-derived secret | No | No | Diary body search disabled in MVP. |
| Draft/conflict body | secret | No | No persistent plaintext | Persistent managed-Diary draft/recovery disabled; memory only. |
| PDF | explicit user copy | N/A | Outside automatic guarantee | Allow only while unlocked/current epoch; browser memory rendering. |
| Clipboard | explicit user copy | N/A | Outside automatic guarantee | Allow only while unlocked/current epoch; do not claim OS wipe. |
| Logs/telemetry/artifacts | security metadata | No body/keys | No | Structured identifiers only; canary and artifact-grep gates. |

The ownership boundary is explicit: only the server-side Diary access service
may hold the live/unwrapped DEK. Client code is never a DEK owner; it may hold
the existing session/capability state and necessary transient user input only.

## 9. Complete plaintext / derived-data graph

The table records production evidence, not file-name guesses. “Current locked
behavior” describes the inspected code; “D8.3 target” is the required policy.

| Surface | Entry point | Current owner / source evidence | Reads plaintext? | Persists plaintext? | Lifetime | Current locked behavior | D8.3 target |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Primary read | `GET /api/posts/:path` | `server/routes/posts.ts` managed GET → `withDiaryBodyOperation` → `readDiaryBody` / decrypt | Yes in operation | Ciphertext file only on successful primary storage | Request/response + tab memory | `requireDiaryBodyAccess` returns `423 diary-locked` | Keep adapter/lease; bind response publication to session epoch. |
| Primary save | `PUT /api/posts/:path` | `server/routes/posts.ts:saveManagedDiary` → CAS → `prepareAtomicTextWrite` with envelope | Yes in request memory | Encrypted envelope | Request/atomic write | Locked request rejected | Keep; prohibit raw bytes at durable writer for managed paths. |
| Diary create | `POST /api/diary/dates` | `server/routes/diary.ts` creates raw in memory, encrypts, commits metadata | Yes in request memory | Encrypted envelope; metadata | Request + tab | Access required | Keep; make LinkIndex update structural/no-op for body. |
| History list/log | `/api/history/log`, `/file`, `/diff`, `/content-hashes` | `server/history/routes.ts` + `rejectEncryptedDiaryHistory` | Git raw/diff can be body-bearing | Git legacy data | Request | Managed path currently 422 at guarded routes; status is structural | Keep explicit 422; add service/mutation-owner defense. |
| History commit | `/api/history/commits` | Route → `withVaultMutation` → `server/history/git.ts:addAndCommit` (`git add`, `hash-object`, `update-index`, `write-tree`, `commit-tree`, `update-ref`) | Accepts raw/captured bytes | Git object/index/commit | Durable Git | Route guard only | Reject any managed path before any Git mutation, including mixed batches. |
| History restore | `/api/history/restore` | `server/history/restore.ts:restoreHistoricalDocument` → atomic write from historical raw | Yes if caller bypasses route | Filesystem temp/primary | Request + file | Route 422 for managed | Keep fail-closed route and service; no managed restore until encrypted-history owner. |
| Generic recovery | `PUT /api/recover/:path` | `server/routes/posts.ts` recovery route | Raw request body | Atomic file/metadata | Request + file | Managed identity rejected (`diary-recovery-identity-required`) | Keep rejection; no plaintext recovery payload. |
| Draft | `useUnsavedDraftPersistence.schedule` | `src/.../useUnsavedDraftPersistence.ts` → `draftStore.save` | `snapshot.content` | IndexedDB `drafts` (`nuvyn-draft-recovery`) | Until clear/retention | No Diary classification | Disable managed-Diary writes; no pagehide/dispose flush; memory editing only. |
| Draft conflict | `saveConflict` / `saveConflictCandidate` | `src/.../draftStore.ts`, `draftTypes.ts` (`content` field) | Yes | IndexedDB `draftConflicts` | Until conflict clear | No Diary classification | Disable managed-Diary persistence; do not read legacy records while locked. |
| Recovery discovery/read | `draftRecovery.discover`, `readDisk`, `classify` | `useUnsavedDraftRecovery.ts`, `DraftRecoveryPane.vue` | Draft and disk raw | Recovery tab refs | Component/session | Discover runs on vault id; no Diary filter | Filter managed Diary; unavailable message; clear on epoch change. |
| Search index | `buildIndex(posts)` | `src/lib/search.ts` / `searchResults.ts` MiniSearch fields | Title/summary/tags, not body in this step | Module memory | Module lifetime | Existing summaries may remain | Exclude managed Diary private fields; structural date/path only. |
| Search preview/body cache | `primeBody(posts)` → `/api/posts` | `src/lib/search.ts:bodyCache` | Yes (`data.content`) | Module `Map` | Until `dispose()` | No lock/epoch check | Do not prime Diary; clear cache/results on lock/logout/expiry; epoch-gate runners. |
| Server body cache | No standalone owner found in inspected `server/` source; LinkIndex is the long-lived derived holder | `rg` found no generic `bodyCache` server module; runtime instrumentation remains required | **UNRESOLVED** for undiscovered runtime cache | **UNRESOLVED** | **UNRESOLVED** | Must not assume absence | D8.3 gate: prove no cache or classify/disable it; any discovered Diary body cache is STOP-1. |
| LinkIndex build | `getIndex()` / `rebuild()` | `server/linkIndex.ts` reads `.md`, extracts links/title; `routes/links.ts` calls unguarded `getIndex()` | Yes; cold generic rebuild can parse envelope as Markdown | Singleton `Map` forward/paths/titles | Process lifetime | Query can expose warm data after lock | MVP keeps structural paths only; never read/parse/store managed Diary body-derived data. |
| Backlinks/outgoing | `/api/links/index`, `/backlinks`, rename impact | `server/routes/links.ts` → `linkIndex` snapshot/backlinks | Derived from body | Server singleton + client `useLinkIndex` state | Process/client lifetime | No Diary epoch filter | Filter managed source/target; clear client state on lock; ordinary Note rows unchanged except suppressed Diary edges. |
| Tree | `/api/tree` | `server/tree.ts:buildTree` / `walk` | Managed path uses empty frontmatter; ordinary path reads frontmatter | Response/tree reactive state | Request/client view | Structural Diary node visible | Preserve date/path/existence/mood/id; never parse envelope. |
| List | `/api/posts` | `server/tree.ts:listPostsFlat`, `server/routes/posts.ts` | Managed path uses empty frontmatter; metadata row may contain private fields | Response/client posts | Request/client view | Public projection partly strips fields | Hide title/summary/tags for managed Diary while locked and prevent new private derivation. |
| Metadata preview | `/api/metadata/:id`, tag management | `server/routes/metadata.ts:publicManagedDiaryMetadata`; `server/tagManagement.ts` | Can read DB private fields | SQLite `documents` | Durable | Public ID projection exists; tags endpoints unguarded | Return only approved projection; exclude managed Diary from tag/private metadata surfaces. |
| Metadata migration | startup + `/api/metadata/migration` | `server/metadataMigration.ts`, `frontmatterArchive.ts`, `server/prod.ts`, `vite-plugin.ts` | Scans raw Markdown/frontmatter | SQLite `frontmatter_backup` | Durable | Migration listing exposes failure records | Skip managed Diary for new scans/backups; filter legacy backups; D8.4 owns cleanup. |
| Document rename | `PATCH /api/posts/:path` | `server/routes/posts.ts`, `documentMutationPolicy.ts`, `useDocumentLifecycle.ts` | Reads source/reference raw for generic rewrite | Rename journal/temp/files | Request + durable journal | Managed rename currently 422 | Keep fail closed before read/journal/filesystem mutation. |
| Folder move/rename | `PATCH /api/folders/:path` | `server/routes/folders.ts`, folder transaction/journal modules | Reads subtree/reference raw | Durable v4 journal/staging | Request + recovery window | Rename footprint rejects managed; delete does not | Reject any managed-Diary footprint before staging/journal; no partial move. |
| Folder/document delete | `DELETE /api/folders`, `DELETE /api/posts` | Direct managed document delete uses `server/diaryAccess/delete.ts`; folder/bulk delete remains the generic footprint owner | Managed delete is opaque; generic folder/bulk code may read raw bytes | Managed structural intent + ciphertext-only staging; generic Note staging unchanged | Until cleanup/recovery | The original generic managed delete had no safe owner | Direct managed delete is supported through the reviewed owner; folder/bulk footprints touching managed Diary remain fail-closed. |
| Reference rewrite | `renameReferences`, `renameReferenceJournal` | `server/renameReferences.ts`, journal/owner-binding modules | Parses and serializes raw before/after | Durable journal payloads | Recovery window | Caller preflights some Diary footprints | Reject if any managed source/target; no partial rewrite. |
| External conflict | disk watcher + save CAS | `useExternalFileChanges.ts`, `useDiskFileChanges.ts`, `useDocumentSave.ts` | `tab.raw`, `externalRaw`, conflict response | Usually memory; draft conflict can be IndexedDB | Tab/session | No Diary epoch; dialogs can outlive lock | Authorized memory only; clear/invalidate on epoch; never render envelope as Markdown. |
| History comparison/diff | Vault history UI | `useHistoryComparisons.ts`, `useWorkingTreeDiffs.ts` | `beforeRaw`, `afterRaw`, diff strings | Vue refs | Until deactivate/unmount | deactivate clears active id, not raw refs | Clear all body refs and gate loaders by authoritative epoch. |
| PDF export | `exportPdfDocument` | `src/lib/pdfExport.ts`, `PdfExportSurface.vue`, `VaultView.vue` | Live tab/getPost raw; DOM clone | Browser download is explicit external copy; no server temp found | Request/DOM/download | No lock epoch | Permit only unlocked/current epoch; cancel/ignore on lock; no automatic cleanup claim for download. |
| Clipboard | `VaultView.copyActiveContent` | `navigator.clipboard.writeText` from active tab/recovery/history raw | Yes | OS clipboard (external) | OS/user controlled | No authorization check in current source | Require current authorization; user-visible external-copy semantics; do not wipe on lock. |
| Logs | server startup/routes and browser console | `server/prod.ts`, `vite-plugin.ts`, route logs, client logging | Intended identifiers only; arbitrary error serialization risk | Log files/process output | Process/log retention | No body-specific guarantee | Structured redaction, no body/keys/envelope; canary tests. |
| Failure artifacts | E2E fixture/Playwright | `e2e/fixtures/diary.ts`, `playwright.config.ts`, traces/screenshots/attachments | Diagnostics include paths/state, not body; binary artifact coverage is separate | Attachments, trace/screenshot files | Test result retention | Diary specs use trace off; defaults retain failures | Secret-bearing profile disables trace/video/screenshot or proves scrub; artifact grep gate. |
| Editor model | `EditorPane`/Monaco registry | `tabState.ts`, `useEditorTabs.ts`, `monacoModelRegistry.ts` | `Tab.raw/originalRaw/externalRaw` | No durable raw in tab persistence; model memory | Until close/lock/unmount | `clearManagedDiaryWorkspace` is best-effort and does not await draft dispose | Synchronous epoch invalidation, dispose/clear models and tab refs before new publication. |
| Reader DOM/render | `ReadingPane`, `useMarkdownRender` | Vue raw props, TOC/render AbortController | Yes | DOM/browser memory | Until replacement/unmount | Watch resets TOC; lock does not own all render cancellation | Abort render, clear DOM/TOC, reject stale completion by epoch. |
| Route hydration/current note | route mirror | `useCurrentNote.ts`, `createVaultContext.ts` | Live tab/getPost raw | Vue refs/context | Route/session | No Diary epoch filter | Guard route hydration and clear route mirror on lock; no auto-open from stale result. |
| Tab persistence | localStorage | `useTabPersistence.ts` stores paths/active only | No body | Path/existence structural only | Across reload | Diary paths restore deferred while locked | Keep structural paths; ensure no raw/model restoration and clear sensitive view/recent-link keys. |
| Browser recent/view cache | localStorage + module caches | `EditorPane.ts` recent wiki links/view state; search/link modules | Paths/view state; recent links are body-derived navigation | localStorage/module memory | Across reload/module lifetime | No lock clear | Remove managed-Diary entries on lock or disable recording; clear module caches/results. |
| AI live context | `AiPanel` send | `aiLiveContext.ts` captures document/diff/recovery raw; `server/ai/chat.ts` sends provider | Yes | Server comments say not persisted, but provider/user prompt is external | Request/provider | Tool guards do not cover snapshot | Disable managed-Diary live context/summary/commit-message/body tools until explicit external-copy contract. |
| Markdown resources | `/api/markdown-resources` | `server/routes/markdownResources.ts` guard + client resolver promise cache | Resource snippets/body | Per-render promise Map only | Render | Access guard exists; no epoch cancellation | Keep guard, abort/clear resolver on lock, never cache across epochs. |

## 10. History / Git

### 10.1 Owner and current enforcement

The call graph is:

```text
POST /api/history/commits
  → server/history/routes.ts
  → withVaultMutation()
  → server/history/git.ts:addAndCommit()
  → git hash-object / add / update-index / write-tree / commit-tree / update-ref
```

`server/history/routes.ts` currently calls
`rejectEncryptedDiaryHistory()` and `requireDiaryBodyAccess()` for managed
paths. The guard is route-level. `addAndCommit()` itself is generic and writes a
temporary Git index under `os.tmpdir()`; it has no managed-Diary exclusion. All
current `addAndCommit` callers are in the history route, but the invariant must
not depend on that caller inventory remaining complete.

### 10.2 Frozen D8.3 policy

The mutation owner must reject a batch before `git add`, `hash-object`,
`update-index`, temp-index creation, tree creation, or ref update when any
normalized path is managed Diary. A mixed Note + Diary batch is rejected as a
whole and performs no Git mutation. History status may continue to expose
structural state, but body-bearing log/file/diff/restore and new Diary commits
remain explicit fail-closed operations. Legacy Diary Git objects are neither
rewritten nor purged in D8.3.

The same policy is applied at `restoreHistoricalDocument`/document mutation
service boundaries so a new non-HTTP caller cannot write a Git Diary blob into
the filesystem. Ordinary Note history keeps its existing add/commit/restore
behavior.

### 10.3 History acceptance checks

Tests inspect Git objects, not only HTTP status: Diary create/save/recovery/
restore/rename attempts leave `git log`, `git diff-tree`, tree entries, object
counts, and refs unchanged; a mixed batch leaves them unchanged; Note commit and
restore tests continue to pass.

## 11. Draft / Recovery

`draftTypes.ts` defines plaintext `content: string` for `UnsavedDraft` and
`DraftConflictRecord`. `draftStore.ts` opens IndexedDB database
`nuvyn-draft-recovery` (version 2) with `drafts` and `draftConflicts` stores;
`save`, `saveConflict`, `saveConflictCandidate`, `moveFamily`, and cleanup
operate on cloned plaintext objects. `useUnsavedDraftPersistence.ts` schedules
`snapshot.content` writes, pagehide flushes, and `dispose()` flushes. Recovery
discovers and reads those objects in `useUnsavedDraftRecovery.ts`; recovery tabs
retain `draftRaw`/`diskRaw` refs.

The D8.3 MVP decision is **disable persistent managed-Diary draft/recovery**.
This avoids a second IndexedDB crypto owner and keeps editing in existing tab
memory while unlocked. Managed Diary drafts are not written on change,
pagehide, dispose, or crash-like flush. Recovery UI reports that Diary recovery
is unavailable; ordinary Note drafts remain unchanged.

Legacy plaintext records are not silently read, migrated, or deleted. A locked
session filters them before any body read. D8.4 owns an explicit migration or
discard flow with inventory, user-visible confirmation, idempotence, and
rollback. An explicit user discard may be added only with that D8.4 contract;
D8.3 must not turn cleanup into implicit migration.

## 12. Search / cache

`src/lib/search.ts` builds a MiniSearch index from title/path/tags/summary and
`primeBody()` fetches every post body into module-level `bodyCache`. The
`searchResults.ts` provider primes bodies for a non-empty query, while its
latest-runner version only protects UI ordering. No IndexedDB or persistent
server search body cache was found in the inspected source; a runtime
instrumentation check is a D8.3 gate for the unresolved server-cache row in the
graph.

The D8.3 MVP disables managed-Diary body search. Structural canonical date/path
may remain searchable; private title/summary/tags and body snippets may not.
`primeBody()` must exclude managed paths, existing Diary cache entries and
results must clear on lock/logout/expiry, and every provider/render completion
must compare the authoritative Diary session epoch. Ordinary Note search is
unchanged.

## 13. LinkIndex

`server/linkIndex.ts:rebuild()` walks Markdown files, parses frontmatter and
links, and stores forward links, paths, and titles in a process singleton.
`getIndex()` is unguarded and is used by `server/routes/links.ts`; only the
special `getIndexForBodyOperation(canReadBody)` path performs a managed-body
preflight. `applyWrite()` currently accepts raw plaintext from Diary create/save
routes. Therefore both cold envelope-as-Markdown parsing and warm plaintext
retention are real current gaps.

D8.3 uses one structural LinkIndex policy, not a second Diary database:

* managed Diary contributes canonical path/existence only (and any explicitly
  approved structural date fallback), never body links, backlinks, snippets,
  frontmatter title, or decrypted title;
* cold rebuild skips managed Diary bytes before `fs.readFile`; incremental
  Diary writes/deletes/renames do not add body-derived entries;
* link/backlink/rename-impact snapshots filter any managed-Diary source or
  target edge; the client `useLinkIndex` clears state on lock/epoch change;
* ordinary Note behavior is unchanged, including Note-to-Note links. D8.3
  intentionally supersedes the generic cross-scope `Note → managed Diary`
  LinkIndex projection: suppressing that target edge is required because the
  relation is body-derived sensitive data. This narrow projection exception
  does not change Note editing, storage, search, or any other Note semantics;
* a warm legacy Diary projection is purged or, if that cannot be proven
  synchronously, the query fails closed. D8.4 handles legacy state inventory.

## 14. Tree / structural projection

`server/tree.ts` deliberately uses `emptyFrontmatter()` for managed Diary in
`listPostsFlat()` and `buildTree()`, while ordinary paths use `readFrontmatter()`
and `gray-matter`. This safe split is retained. Tree/list responses may expose
canonical date/path, existence, stable id, and Mood. They must not parse an
encrypted envelope, derive title/summary/tags from it, or expose old private
SQLite fields while locked.

`server/routes/metadata.ts` already has
`publicManagedDiaryMetadata()` for a locked public projection, but
`GET /api/metadata/migration` returns migration records (including
`frontmatterBackup`) without a whole-vault body gate. `metadataMigration.ts`
and `frontmatterArchive.ts` scan/parse raw files. D8.3 filters managed records,
prevents new managed scans/backups, and fails closed for managed cleanup,
restore, export, or private-field mutation unless an adapter-aware owner is
approved. D8.4 owns legacy backup cleanup. Tag management excludes managed
Diary private associations; Mood remains available.

## 15. Rename / move / rewrite

Envelope AAD binds vault identity, stable document id, canonical logical path,
and version. A ciphertext `mv` to a new path is therefore not a valid rename.

`documentMutationPolicy.ts` and the document PATCH route continue to reject
managed Diary rename/move. Folder rename has a reference-footprint preflight
and rejects a managed path; generic `renameReferences.ts`,
`renameReferenceJournal.ts`, and folder transaction modules still serialize raw
before/after data and therefore remain outside the managed delete owner.

D8.3 keeps the smallest safe contract: managed Diary document rename, move,
folder rename/move/delete, bulk operations, and any reference rewrite whose
footprint contains a managed Diary fail closed before reads, journals,
staging, metadata mutation, LinkIndex mutation, or filesystem mutation. No
partial Note+Diary operation is allowed. A future re-encrypt/rebind transaction
is a separate design; D8.4 may specify it only with an identity proof,
authenticated decrypt/re-encrypt, atomic commit, and rollback.

### 15.1 POST-CLOSURE SUPERSEDED / FOLLOW-UP — Managed delete

The original D8.3 closure intentionally disabled direct managed-Diary delete:
the generic delete pipeline could stage bytes, capture raw rollback state,
reindex, or write recovery artifacts without an adapter-aware ownership proof.
That historical product decision remains true for the original closure
checkpoint, but it is superseded for direct document delete by the post-closure
follow-up recorded in `diary-encryption-d8.3-post-closure-followup.md`.

The follow-up adds one authoritative owner,
`server/diaryAccess/delete.ts`, behind the existing
`withVaultStructureLock → withDocumentWriteLock → withDiaryBodyOperation`
boundary. The owner receives only the current capability-scoped lease
assertion; it never receives a DEK, decrypts a body, parses Markdown, or
serializes body bytes. It captures the canonical managed path, stable
`documentId`, and filesystem generation, writes only a structural intent
manifest, moves the existing ciphertext inode to
`.nuvyn-delete-inflight-*`, removes the structural LinkIndex path, deletes the
authoritative metadata graph, and unlinks that same generation. Rollback uses
create-only inode restoration and structural index restoration; it never calls
`reidentifyReusedPath` or `LinkIndex.applyWrite`.

The current product contract is:

* a valid, unlocked direct managed-Diary document delete returns HTTP `200`
  `{ "ok": true }` with no body, ciphertext, envelope, key, or private
  metadata in the response;
* a locked/invalid lease remains HTTP `423 diary-locked`; a missing file is
  HTTP `404`; missing/invalid authoritative metadata fails closed with
  `503 diary-metadata-unavailable`; and generation/path reuse conflicts are
  HTTP `409` with a stable delete conflict code;
* if an external generation occupies the canonical path, it wins. The old
  inode is quarantined or retained for recovery, the old identity is detached
  only when the manifest still proves that identity, and no external bytes are
  parsed, indexed, overwritten, adopted, or rebound; and
* a folder or bulk delete whose complete footprint contains any managed Diary
  remains HTTP `422 diary-encrypted-delete-unsupported` before staging, with no
  Note subset partially deleted. Note-only delete behavior is unchanged.

The same structural intent is understood by crash recovery. A managed intent
completes only when the staged inode still matches the recorded source
generation; otherwise it quarantines the foreign artifact and preserves any
fresh path identity. History log/file/diff/content-hashes/restore/commit remain
unsupported and continue to use `422 diary-history-encrypted-unsupported`.

## 16. Conflict handling

`useExternalFileChanges.ts`, `useDiskFileChanges.ts`, and
`useDocumentSave.ts` retain `tab.raw`, `originalRaw`, and `externalRaw` in
memory. `SavePostConflictError` can carry the current raw body. History
comparisons and working-tree diffs retain raw/diff refs; recovery tabs retain
draft/disk raw. `VaultView.showExternalDiff()` currently builds a confirmation
from raw slices. These are authorized runtime holders, not durable stores, but
the current lock watcher does not clear every ref or invalidate every pending
request.

For managed Diary, conflicts are memory-only while the authoritative session is
unlocked. The server must not return a managed body after the request has lost
its body lease. Client conflict models, dialogs, diffs, and externalRaw are
cleared synchronously when the Diary epoch advances. A stale confirmation,
save, disk read, or external-file event is rejected by epoch plus tab identity
and request token. Encrypted envelope bytes are never passed to Markdown,
frontmatter, diff, or recovery renderers.

## 17. Export / clipboard

`src/lib/pdfExport.ts` renders a browser DOM clone and calls `html2pdf().save()`;
the inspected path has no server PDF temp file. `VaultView.copyActiveContent()`
calls `navigator.clipboard.writeText()` for active/recovery/history/tab raw.

PDF and clipboard are supported only as explicit user actions while the current
Diary session is `UNLOCKED` and the request’s captured epoch is still current.
Lock/expiry/logout aborts or invalidates in-flight PDF rendering and removes its
temporary DOM; a late completion cannot download. A downloaded PDF or OS
clipboard is an explicit external copy outside Nuvyn’ automatic storage
guarantee; Nuvyn must not claim it can wipe that copy after lock.

## 18. Logging / diagnostics

`shared/sanitize-diagnostic.ts` redacts known password literals, sensitive query
parameters, bearer/auth/cookie headers, and caps diagnostic size. It does not
prove arbitrary body redaction. Server startup (`server/prod.ts`,
`server/vite-plugin.ts`), route errors, client console/error serialization, and
Playwright binary artifacts are separate surfaces. `e2e/fixtures/diary.ts`
attaches bootstrap NDJSON containing routes/scopes/dialog/tab paths; Diary specs
turn tracing off, while the global Playwright default retains failure traces.

D8.3 rules:

* never log body, password, KEK/DEK, capability, envelope/ciphertext, raw
  conflict, request/response body, or AI context;
* use structured identifiers, stable error codes, and sanitized metadata only;
* run representative failures with canaries such as
  `D8_3_BODY_SECRET_...`, `D8_3_PASSWORD_SECRET_...`, and
  `D8_3_CAPABILITY_SECRET_...`, then grep server output, logs,
  `test-results`, attachments, screenshots/metadata, and trace archives;
* use a secret-bearing Diary browser profile with trace/video/screenshot off,
  or prove a post-capture scrub. Sanitizing a text attachment does not scrub a
  binary trace or screenshot.

## 19. Lock teardown

`useDiaryAccessSession.clear()` synchronously advances the authoritative
generation/epoch and clears capability; server `diaryAccess/service.ts`
quiesces body-operation leases and zeroes the DEK. D8.3 adds one teardown
coordinator derived from that owner (not a second session state machine):

| Event | Required sequence |
| --- | --- |
| Explicit lock | Advance epoch synchronously → reject new body work → cancel timers/requests/render/worker tasks → clear tab/model/raw/external/conflict/recovery/history/search/link/PDF/context refs → clear sensitive localStorage entries → await best-effort disposal; server lease quiesces independently. |
| Logout | Auth generation and Diary epoch advance first; perform the same clear; suppress late auth/body responses. |
| Auth invalidation / `423` | Treat as lock immediately; no response body publication before the clear. |
| Capability expiry | Session owner invalidates epoch and server capability; all derived operations compare epoch before cache/UI publication. |
| Same-session capability replacement | Old epoch is fenced before new capability is visible; old requests cannot publish into the new session. |
| Application restart | No body or key is reconstructed from storage; only structural tab paths may restore. |
| Route/scope leave | Do not silently unlock or persist; clear body-specific views when leaving Diary scope. |
| Tab close/editor dispose | Cancel save/draft flush and clear raw/model refs; managed Diary draft persistence remains disabled. |

The lock watcher in `VaultView.vue` and `clearManagedDiaryWorkspace()` are
therefore coordination points to harden, not new authorities. Late result
tests must use `E1 → lock → E2` and prove no rehydration of UI, cache, tab,
LinkIndex, search preview, or renderer.

## 20. Unsupported behavior

The following statuses are frozen for D8.3 MVP:

| Capability | Status | User-visible behavior |
| --- | --- | --- |
| Primary Diary read/save/create | Supported through D8.2 adapter/lease | Works only while unlocked; lock is `423 diary-locked`. |
| Diary Git History/restore/diff/body log | Fail closed | Stable `422 diary-history-encrypted-unsupported`; no Git mutation. |
| Persistent Diary draft/conflict/recovery | Disabled | Client-only `diary-draft-recovery-unsupported`; “Diary recovery unavailable”; no IndexedDB write/read for managed paths. |
| Diary body search/snippets | Disabled | Structural date/path remains available; no body result or cache. |
| Diary body-derived LinkIndex/backlinks | Disabled | Structural paths only; no links/title/snippets; filtered endpoint results. Cross-scope `Note → managed Diary` edges are intentionally suppressed; Note-to-Note links remain unchanged. |
| Diary rename/move/reference rewrite | Fail closed | HTTP `422 diary-encrypted-rename-unsupported` for document rename/move; HTTP `422 diary-encrypted-reference-unsupported` for folder/reference footprints; no partial mixed operation. |
| Diary direct document delete | Supported through the post-closure opaque owner | HTTP `200 {"ok":true}` with current capability; ciphertext-only staging, metadata/index cleanup, no body response. |
| Diary folder or bulk delete touching managed paths | Fail closed | HTTP `422 diary-encrypted-delete-unsupported` before staging/journal/filesystem/index mutation; no partial mixed operation. |
| Private Diary title/summary/tags migration/archive/tag mutation | Fail closed | HTTP `422 diary-private-metadata-unsupported`; no private-field read or backup mutation; D8.4 owns old rows/backups. |
| Private Diary public metadata projection | Filtered | HTTP `200`; date/path/existence/id/Mood only. |
| AI live context, Diary summary, commit-message, body tools | Disabled | Each returns HTTP `422` before raw/provider access: live context=`diary-ai-context-unsupported`; summary=`diary-ai-summary-unsupported`; commit-message=`diary-ai-commit-message-unsupported`. Ordinary Note AI remains unchanged. |
| Tree/list structural projection | Supported | Date/path/existence/id/Mood only; no envelope parsing. |
| PDF/clipboard | Explicit external copy | Current epoch/unlocked check; no OS/download wipe claim. |
| Markdown resources | Supported only with body operation | Guarded target, abort/clear on lock, no cross-epoch cache. |

## 21. User-visible semantics

* Calendar, tree, and list may show that a date/document exists and its Mood;
  they do not reveal private Diary title/summary/tags or body previews while
  locked.
* Opening a Diary while locked prompts for the existing unlock flow; there is
  no alternative editor or reader.
* History, recovery, body search, body-derived backlinks, rename/move, folder/
  bulk delete, and private metadata actions show a stable “unavailable while
  encrypted” state, not a generic empty success and not ciphertext rendered as
  Markdown. Direct managed-document delete uses the current opaque owner and
  reports a body-free success or stable conflict.
* A lock/logout immediately removes open Diary content, diffs, previews, AI
  context, and conflict dialogs. A late request is ignored rather than shown.
* PDF/export and copy are explicit actions. The UI states that the resulting
  download/clipboard is an external copy outside automatic Nuvyn retention.
* Ordinary Note behavior and messaging remain unchanged, except that the
  LinkIndex intentionally suppresses cross-scope `Note → managed Diary` edges;
  Note-to-Note links remain unchanged.

## 22. Failure behavior

The following contract is frozen at Gate 0; implementation must not choose a
different status, code, or client invalidation behavior. Every HTTP error is
`Cache-Control: no-store` and contains only stable code/message/path identity,
never raw content, envelope, keys, or provider context.

| Surface / operation | Transport and status | Stable code | Client behavior |
| --- | --- | --- | --- |
| Diary body read/save/create/resource without a current lease | HTTP `423` | `diary-locked` | Advance the Diary epoch synchronously, clear Diary holders, show the existing unlock flow, and publish no body. |
| Diary History body log/file/diff/content-hashes/restore | HTTP `422` | `diary-history-encrypted-unsupported` | Keep the session, show unavailable, and perform no Git/filesystem mutation. |
| Generic recovery targeting managed Diary identity | HTTP `422` | `diary-recovery-identity-required` | Show unavailable and create no recovery state. |
| Managed document rename/move | HTTP `422` | `diary-encrypted-rename-unsupported` | Show unavailable; do not read raw content or mutate journal/staging/filesystem/index state. |
| Managed folder rename/move or reference rewrite footprint | HTTP `422` | `diary-encrypted-reference-unsupported` | Show unavailable; reject the complete footprint with no partial Note mutation. |
| Managed direct document delete without a current lease | HTTP `423` | `diary-locked` | Advance the Diary epoch synchronously and publish no body. |
| Managed direct document delete with missing/invalid authoritative metadata | HTTP `503` | `diary-metadata-unavailable` | Show unavailable; leave the ciphertext generation untouched. |
| Managed direct document delete with external generation/path reuse | HTTP `409` | `diary-delete-path-reused` or `diary-delete-generation-changed` | Preserve the external generation; quarantine/restore only with structural ownership proof. |
| Managed folder/bulk delete whose footprint contains Diary | HTTP `422` | `diary-encrypted-delete-unsupported` | Reject before raw read, staging, journal, metadata, filesystem, or index mutation. |
| Managed private metadata migration/archive/tag mutation | HTTP `422` | `diary-private-metadata-unsupported` | Show unavailable; no private-field read or backup mutation. Public structural projection remains `200`. |
| Managed AI live context | HTTP `422` | `diary-ai-context-unsupported` | Reject before raw read or provider call; no context publication. |
| Managed AI summary fallback | HTTP `422` | `diary-ai-summary-unsupported` | Reject before raw read or provider call. |
| Managed AI commit-message body collection | HTTP `422` | `diary-ai-commit-message-unsupported` | Reject before Git collection or provider call. |
| Managed Diary draft/recovery IDB write, discovery, or read | Client-only rejection; no HTTP request | `diary-draft-recovery-unsupported` | Make no IndexedDB call, clear candidate refs, and show “Diary recovery unavailable.” |
| Search, LinkIndex, tree, and list projections | HTTP `200` filtered response | No error code | Return structural data only; clear managed derived state on epoch changes. |
| Stale client body operation, conflict, PDF, or clipboard after epoch advance | Client-only rejection; no HTTP request | `diary-session-invalidated` | Discard the result, clear the relevant holder, and never retry or publish body; a server request that loses its lease is handled as `423 diary-locked`. |

Unknown, malformed, identity-mismatched, or authentication-failed envelopes
stop at the adapter and are never passed to downstream parsers.

## 23. STOP conditions

Implementation and review stop immediately if any condition is observed:

1. Managed Diary plaintext reaches `fs.writeFile`, atomic temp/staging,
   journal, Git, IndexedDB, LinkIndex, persistent search, recovery payload,
   logs, trace, screenshot, or failure artifact.
2. Locked History, Recovery, Search, LinkIndex, tree/list, route, tab, or
   conflict surfaces return body or body-derived preview.
3. Gray-matter, Markdown, link, search, diff, or AI parser consumes an
   encrypted envelope or malformed bytes as document text.
4. A managed rename/move changes AAD-bound path without an authenticated,
   identity-checked, atomic decrypt/re-encrypt transaction.
5. A stale async result after epoch advancement rehydrates any UI/cache/index/
   tab/model or downloads an export.
6. A second key, unlock, session, body, or History owner is introduced.
7. A shared change alters ordinary Note semantics without independent review
   and Note regression coverage.

## 24. Acceptance criteria

D8.3 is implementation-ready only when the plan’s file map, test matrix, and
error contracts are approved. It is implementation-complete only when all of
the following are evidenced:

* Git mutation-owner tests prove no managed Diary object/tree/ref changes for
  create/save/recovery/restore/rename/move/reference/mixed batches, while Note
  history remains unchanged.
* IndexedDB inspection proves no new managed-Diary plaintext draft/conflict;
  lock/reload/crash-like flows do not read legacy records while locked.
* Search and LinkIndex canary tests prove no envelope parsing, no Diary body
  result/edge after lock, no stale repopulation, and unchanged Note results.
* Tree/list/metadata/tag/migration tests prove structural-only locked output,
  no new Diary frontmatter backups, and no private field leak.
* Rename/folder/reference tests prove pre-mutation rejection and no
  journal/staging/metadata/filesystem partial state; direct managed-document
  delete tests prove the opaque owner’s success, rollback, race, and recovery
  invariants while folder/bulk delete remains pre-mutation rejection.
* Conflict/history/PDF/clipboard/AI/resource tests prove authorization,
  epoch fencing, and no envelope rendering or late publication.
* Lock/logout/expiry/replacement/restart/route/tab teardown tests clear every
  listed holder and suppress late results.
* Diagnostic canaries are absent from logs, server output, browser artifacts,
  attachments, traces, screenshots, and test result metadata.
* The eight supplied CI dimensions plus new D8.3 browser/negative suites pass
  without skip, retry, timeout, sleep, or platform-conditional masking.
* Independent review records `PASS (P0/P1/P2 = 0/0/0)` only after remediation
  and evidence review; docs-only lifecycle sync then marks `REVIEW-CLOSED`.

## 25. Deferred D8.4 scope

D8.4 owns legacy inventory and migration: plaintext primary files, legacy Git
history, IndexedDB drafts/conflicts, SQLite private metadata and
`frontmatter_backup`, mixed encrypted/plaintext state, idempotent migration,
rollback/recovery proof, folder/bulk legacy cleanup, and any approved encrypted
Diary History/search/LinkIndex/draft design. The post-closure D8.3 follow-up
already owns direct managed-document delete; D8.4 must not replace it with a
generic plaintext delete path. D8.3 may classify legacy state and prevent new
leakage, but it must not silently migrate, delete, rewrite, purge, or claim
retroactive protection.
