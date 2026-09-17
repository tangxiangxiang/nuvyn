# Unsaved Draft Recovery — Design Spec

**Date:** 2026-07-19
**Status:** Accepted for staged implementation
**Scope:** Edit-09 — preserve unsaved editor buffers across abnormal exits without silently replacing newer disk content.
**Baseline:** Edit-08 is closed at `f094456`.

## 1. Principle

The file on disk is always the authoritative persisted document. An unsaved draft is
only a recovery copy of an editor buffer.

Recovering a draft must never silently write it to disk, replace a newer disk
version, select a destructive conflict outcome, or bypass the existing save,
external-change, rename, and close coordinators.

## 2. Goals

- Persist dirty editor buffers locally so refreshes, crashes, browser termination,
  and system restarts do not discard recent typing.
- Scope drafts to the current vault and a stable document identity.
- Record the disk baseline used when editing began so recovery can distinguish an
  unchanged disk file from a divergent one.
- Delete obsolete drafts after a confirmed clean save or an explicit discard.
- Preserve drafts when storage, network, rename, or recovery work fails.
- Support document rename, move, deletion, and duplicate-target transactions
  without losing either draft.
- Bound local storage use and expose enough metadata for a later recovery center.

## 3. Non-Goals

- Edit-09.1 and Edit-09.2 do not modify the editor, save pipeline, `VaultView`, file
  transactions, or recovery UI.
- Drafts are not server backups, revision history, collaborative edits, or an
  alternative save protocol.
- No draft is uploaded to the server or synchronized between browsers.
- No automatic merge is attempted in the first recovery UI.
- No third-party storage, hashing, diff, or compression dependency is added.

## 4. Draft Identity and Shape

```ts
interface UnsavedDraft {
  version: 1
  vaultId: string
  documentId: string
  documentPath: string
  content: string
  baseContentHash: string | null
  baseModifiedAt: number | null
  createdAt: number
  updatedAt: number
}
```

- `vaultId` is the stable identifier already returned by `/api/health`. Draft
  persistence does not start until a non-empty vault ID is available.
- `documentId` is the stable document identity supplied by the document lifecycle.
  It is never derived by parsing History or Diff tab IDs.
- The primary identity is `(vaultId, documentId)`.
- `documentPath` is current display and compatibility metadata. It is not the
  primary key.
- `content` is the complete editor buffer at `updatedAt`.
- `baseContentHash` identifies the authoritative disk content from which the dirty
  buffer diverged. Hash creation belongs to the integration phase; the store treats
  it as opaque.
- `baseModifiedAt` is the corresponding server modification time when known.
- `createdAt` is preserved when an existing draft is updated or moved.
- `updatedAt` is monotonic for accepted writes and drives recovery ordering and
  cleanup.

Malformed, unsupported-version, empty-identity, or impossible timestamp records are
ignored on read. A corrupt record must not make other drafts unavailable.

## 5. Storage

Draft bodies are stored in a dedicated browser IndexedDB database:

```text
database: nuvyn-draft-recovery
object store: drafts
key: [vaultId, documentId]
index: vaultUpdatedAt → [vaultId, updatedAt]
schema version: 1
```

IndexedDB is preferred over `localStorage` because editor buffers can be large,
transactions are required for identity migration, and synchronous storage would
block the main thread. No new dependency is required.

The storage layer is asynchronous and best-effort. It exposes a backend boundary so
tests can use a deterministic in-memory backend. Opening or writing IndexedDB may
fail because storage is disabled, quota is exhausted, or the database is blocked;
callers receive a failure result and normal editing continues.

The Edit-09.2 API is:

```ts
saveDraft(draft): Promise<boolean>
getDraft(vaultId, documentId): Promise<UnsavedDraft | null>
listDrafts(vaultId): Promise<UnsavedDraft[]>
deleteDraft(vaultId, documentId):
  Promise<
    | { status: 'deleted' }
    | { status: 'missing' }
    | { status: 'unsupported' }
    | { status: 'failed' }
  >
moveDraft(vaultId, oldDocumentId, newDocumentId, newPath):
  Promise<
    | { status: 'moved' }
    | { status: 'missing' }
    | { status: 'conflict' }
    | { status: 'unsupported' }
    | { status: 'failed' }
  >
clearVaultDrafts(vaultId): Promise<boolean>
```

Rules:

- Inputs and outputs are copied so callers cannot mutate stored state by reference.
- `saveDraft` rejects an older `updatedAt` for the same identity; delayed work cannot
  overwrite a newer buffer.
- Equal timestamps are idempotent only when the complete record is equal; a
  conflicting equal-timestamp write fails closed.
- Updating an existing valid record preserves the first draft's `createdAt`.
- An occupied key containing a corrupt or unsupported-version record fails closed;
  a current-version save never overwrites it.
- `listDrafts` returns only the requested vault, newest first, with deterministic
  document-ID tie breaking.
- Delete is fail-closed: it removes only a supported current-version record,
  reports `missing` idempotently, and preserves an occupied future-version or
  corrupt record as `unsupported`.
- Vault clear removes only supported current-version records. It does not treat
  skipped future-version or corrupt records as ordinary lifecycle data.
- `moveDraft` is atomic: either the old key remains unchanged or the new key is
  committed and the old key is removed.
- If the target identity already has a different draft, the move reports `conflict`
  and preserves both records regardless of their timestamps. Exact duplicate
  records may be coalesced.
- A successful move keeps the source draft's content and baseline, changes its
  identity/path, and preserves its original `createdAt`.
- A missing source reports the idempotent `missing` outcome. Unsupported/corrupt
  occupied source or target keys report `unsupported`; storage faults report
  `failed`.
- Unsupported or corrupt records are skipped on reads and are never rewritten
  automatically.
- `createdAt` and `updatedAt` are non-negative safe integers, matching the
  IndexedDB range used by vault listing. A non-null `baseModifiedAt` is a
  non-negative finite number so fractional filesystem `mtimeMs` values are
  preserved without truncation.
- Cached IndexedDB connections close on `versionchange` and clear themselves on
  `close`, so another application instance can upgrade the schema. A connection
  that succeeds after an already-rejected blocked open is closed immediately.

## 6. Draft Creation and Removal

The later editor integration creates or updates a draft only when:

- a loaded Document tab has a resolved vault and document identity;
- its editor buffer differs from its authoritative clean baseline; and
- the current close/save/rename generation still owns that tab.

Writes are independently debounced per document (target range 500–1000 ms). The
latest buffer is synchronously snapshotted before scheduling asynchronous storage
work. Each document has a generation so an older write cannot replace newer content
or recreate a draft after it was saved or discarded.

A draft is deleted only after:

- a save is authoritatively confirmed and the tab is clean;
- the buffer independently returns to the authoritative baseline; or
- the user explicitly confirms that the dirty content should be discarded.

A failed, offline, conflicted, or cancelled save retains the draft. Merely closing a
clean view, changing the active tab, or losing the source file externally does not
delete it. Teardown and `pagehide` flush the latest dirty snapshots where the
platform permits, but recovery correctness cannot depend solely on unload events.

## 7. Discovery and Recovery Decisions

After the vault ID is resolved, startup lists that vault's drafts. Opening a
document also checks its stable document identity. Draft discovery does not mutate
tabs or disk content.

### Disk equals the recorded baseline

The user is offered:

```text
Unsaved editing content was found.
[Recover draft] [Use disk version]
```

Recovering places the draft into the editor as dirty content. It does not save it.
Choosing the disk version is an explicit discard and removes the draft only after
the choice is committed.

### Disk differs from the recorded baseline

The user is told that both versions changed and is offered:

```text
[View differences] [Open draft as recovery] [Use disk version]
```

The default safe path is an independent Recovery/Diff view. The draft must not
replace the open document or be written to disk automatically.

### Source file no longer exists

The draft remains stored and can be opened as an orphan recovery document labelled
`Recovered: <original name>`. It has no writable disk target until the user chooses
a new path.

If hashing or disk metadata cannot be obtained, recovery follows the divergent/unknown
path rather than assuming the disk is unchanged.

## 8. Rename, Move, and Delete Transactions

Draft migration joins the existing file transaction; it is not a watcher that
reacts after paths change.

- A successful rename/move atomically migrates the source draft identity and path.
- If the target already has a draft, the conflict rules in section 5 apply before
  either source is removed.
- Failure to commit the draft migration must leave the old draft recoverable. File
  transaction integration will define whether the file operation rolls back or
  reports a recoverable draft warning; it may not silently delete the old draft.
- A failed or cancelled file operation leaves all draft keys and contents unchanged.
- Pending writes using an old ID are invalidated before migration commits.
- An explicit permanent delete may delete its draft only after the user confirms
  discard.
- An external delete never deletes the draft. It becomes orphaned recovery data.

## 9. Concurrency and Lifecycle

- Every scheduled editor write carries tab identity, document identity, revision,
  content snapshot, and generation.
- Completion validates ownership again before it can affect storage state.
- Save success, discard, close, rename, move, and restore increment the relevant
  generation and await/neutralize older work.
- Storage-level timestamp rejection is the final guard against late writes from a
  previous component owner.
- Multiple app instances may observe the same IndexedDB. Last-newer timestamp wins;
  equal conflicting writes fail closed rather than relying on tab ordering.

## 10. Privacy and Capacity

Draft content is local browser data and may contain sensitive notes.

- It is never included in analytics, logs, URLs, toast text, or server requests.
- UI must state that drafts are stored on this device/browser.
- A later recovery center supports individual and bulk deletion.
- Initial limits for the integration phase are:
  - maximum 2 MiB UTF-8 content per draft;
  - maximum 100 drafts per vault;
  - maximum 20 MiB estimated content per vault;
  - orphan retention target of 30 days.
- Cleanup orders candidates by `updatedAt`, oldest first.
- Cleanup never removes the currently dirty buffer's draft or a draft participating
  in save/rename/recovery work.
- Oversized active buffers remain editable and savable; draft persistence reports a
  non-blocking failure instead of truncating content silently.

The pure Edit-09.2 store preserves records and supplies deterministic ordering. The
limits and protected-record cleanup policy are implemented with editor integration,
where active ownership is known.

## 11. Staged Delivery

### Edit-09.1 — Design and behavior freeze

- This specification only.

### Edit-09.2 — Pure storage model

- `draftTypes.ts`
- `draftKey.ts`
- `draftStore.ts`
- deterministic backend contract and IndexedDB implementation
- characterization and implementation tests

No editor, save, `VaultView`, or file-transaction integration.

### Edit-09.3 — Dirty-buffer persistence

- per-document debounce and generation ownership;
- clean/save/discard deletion;
- teardown flush and non-blocking storage failures.

Implemented in:

- `draftHash.ts`: best-effort SHA-256 hashing of the synchronously captured
  authoritative baseline;
- `useUnsavedDraftPersistence.ts`: per-vault-context, per-document debounce,
  generation ownership, monotonic record timestamps, a shared write/delete
  operation chain, flush, clean/discard deletion, `pagehide` best-effort
  flushing, and idempotent disposal;
- `draftTypes.ts`: record timestamps remain safe integers while
  `baseModifiedAt` preserves finite fractional filesystem `mtimeMs` values;
- `useDocumentSave.ts`: the existing editor-change and
  `revision`/`savedRevision` acknowledgement paths schedule or remove drafts;
- `useTabWorkspace.ts` and `Tab`: loaded Document tabs retain the stable
  `PostDetail.metadata.id`; paths are metadata and are never substituted for
  missing document identity;
- `useEditorTabs.ts`: owns one coordinator instance and connects confirmed
  close/discard and context teardown.

Behavior remains write/delete only. This stage does not list or recover drafts,
add recovery UI, or migrate draft identities for rename/move/delete. Focused
coverage consists of 43 tests across the draft storage, hashing, persistence
coordinator, and save-state wiring suites.

### Edit-09.4 — Recovery decisions

- startup discovery;
- baseline comparison;
- safe recovery and divergent/orphan flows.

Implemented in:

- `draftRecoveryDecision.ts`: pure stable-identity, SHA-256, and fractional
  `mtimeMs` decision matrix with fail-closed `unknown`, `missing-source`, and
  `identity-mismatch` outcomes;
- `useUnsavedDraftRecovery.ts`: vault-scoped discovery with four-request bounded
  concurrency, discover/item generations, retry, session-only dismissal, and
  disposal guards;
- `useUnsavedDraftPersistence.ts`: identity-based explicit discard remains on
  the same per-document write/delete operation chain as editor-owned drafts.
  Recovery adoption compares the complete current stored record, establishes a
  runtime owner, and does not rewrite identical content with a newer timestamp.
  It observes generation, timer, snapshot, and pending-operation ownership
  across every storage read, so concurrent local edits fail adoption without
  losing their debounce work. Failed application rolls back only the exact
  adoption owner, never a newer editor generation. Each coordinator entry also
  retains the exact draft it successfully persisted or adopted; clean,
  return-to-baseline, and discard cleanup use atomic compare-and-delete and
  cannot remove a newer draft written by another browser context. Cleanup
  waits for an already-running draft write before reading that write's exact
  persisted record and advancing the generation; a new schedule during that
  wait invalidates the cleanup without touching the newer timer or snapshot;
- `useDocumentSave.ts`: `applyRecoveredDraft()` revalidates stable identity,
  clean state, external state, disk raw, and disk mtime before creating a dirty
  editor revision. It adopts the already-persisted browser draft without a
  write, and intentionally bypasses `onEditorChange()` and server autosave;
- `useDraftRecoveryTabs.ts`, `DraftRecoveryPrompt.vue`, and
  `DraftRecoveryPane.vue`: session-only read-only Recovery workspace tabs,
  decision-specific actions, local content view, and disk-versus-draft diff;
- `WorkspaceTab`, `workspaceClose.ts`, and `VaultView.vue`: Recovery is an
  explicit fourth workspace kind participating in visual order, keyboard
  navigation, fallback, focus, single close, and batch close without entering
  Document dirty-confirmation or session persistence.

This stage never restores automatically, never writes recovered content to disk,
and deletes a stored draft only after an explicit Use Disk/Discard action.
Document opening and View Current navigation both reclassify again after their
asynchronous boundary; View Current additionally verifies the actual loaded
Document tab's stable identity and load state before focusing it. A changed
stored draft, disk identity, or cached tab identity fails closed. Failed draft
application refreshes classification once more before showing Recovery content,
so the pane never falls back to the pre-adoption snapshot. If that refresh
cannot produce a current ready item, the recovery remains unresolved and
retryable instead of displaying or dismissing stale bytes.
Closing a Recovery tab or choosing Later keeps IndexedDB unchanged. Rename,
move, delete migration, recovery-center management, retention, and capacity
cleanup remain deferred to Edit-09.5/09.6.

### Edit-09.5 — File transactions

- rename/move/delete migration and rollback behavior.

**Stage status:** Closed — implemented and verified at
`69aef7c2314d9e1d784bab1c44afce8756f1647e`.

Implemented in:

- `useDraftFileTransactions.ts`: explicit stable document identities, actual
  path mappings, preserve/discard delete policy, exhaustive non-throwing draft
  transaction results, and the idempotent barrier contract;
- `useUnsavedDraftPersistence.ts`: per-document file-transaction pause state.
  Preparing a mutation cancels an unstarted old-path debounce and waits for an
  already-running write. Input during the server request is synchronously
  retained as the latest snapshot without writing the old path. Commit moves
  the exact IndexedDB record without changing its content, baseline, or
  timestamps and then persists newer input only at the server-returned path;
  rollback resumes the latest input at the old path. Explicit delete uses the
  exact draft, pending buffer snapshot, editor revision, and generation
  synchronously captured when the user confirms deletion, before any save or
  lifecycle await. Confirmation can therefore discard a debounce or in-flight
  write that it actually covered, while a newer local revision/generation or
  cross-context record is preserved as orphan recovery content. Successful
  deletion also relinquishes the matching in-memory snapshot and persisted
  ownership. Move commit and entry release are separate phases: Document tab
  paths migrate before the barrier unlocks, and transaction-time snapshots are
  then flushed immediately at the actual server path before Recovery retry.
  Empty-family recovery tracks content durability separately from server-path
  authentication: a failed mint, transient resolver failure, or bounded
  continuous-rename attempt remains pending across debounce, flush, pagehide,
  dispose, and close sealing. Only a post-write stable-identity revalidation
  clears that state and returns the entry to its ordinary channel;
- `draftStore.ts`: schema version 2 adds an immutable `draftConflicts` store.
  If confirmed deletion finds both a newer cross-context primary draft and a
  post-CAS local edit, the primary record remains untouched while the local
  snapshot is persisted under a distinct conflict identity. Pagehide and
  disposal never flush that detached candidate back over the primary record;
- `useUnsavedDraftRecovery.ts` and `useDraftRecoveryTabs.ts`: primary and local
  conflict candidates for the same stable document identity are discovered,
  classified, and displayed as separate Recovery items/tabs. Conflict
  candidates are read-only and may be discarded independently; they cannot be
  restored directly over a Document tab;
- `useDocumentLifecycle.ts`: rename, drag move, archive, folder rename, file
  delete, and folder delete share the document-save and draft barriers. Stable
  identity is resolved before and after path changes, folder identity loading
  is bounded to four workers, and only server-confirmed results are committed.
  Draft conflict/unsupported/failure is reported as a non-blocking warning and
  never converts an already-successful server file operation into failure.
  Barrier finalization runs in `finally` around tab migration so an unexpected
  UI migration error cannot leave draft persistence paused;
- `FileTree.vue`: destructive user confirmation explicitly authorizes
  `discard-confirmed` and captures its delete token in the same synchronous
  call chain after confirmation; all programmatic lifecycle deletion defaults
  to `preserve`;
- `VaultView.vue`: loaded Document metadata is the preferred identity source,
  with `getPost()` as the safe fallback. Recovery items and open Recovery tabs
  are refreshed after moves/preserved deletes and removed only after an exact
  confirmed draft deletion. Refresh is an upsert, so a newly orphaned draft is
  visible in the current session without requiring a page reload.

Create and external-delete paths do not migrate or discard drafts. A newly
created document at an orphan path therefore remains isolated by stable
`documentId`. This stage does not add recovery management, retention, or
capacity cleanup.

If source identity resolution fails, path matching is used only to detect
possibly affected stored or in-memory drafts. Those identities are paused and
their latest transaction-time snapshot is flushed at the old path as orphan
recovery; they are never migrated by path inference. The completed file
operation reports one non-blocking warning without exposing draft content.

Browser coverage uses an isolated temporary vault and exercises real
`useDocumentLifecycle` rename/delete calls, the server-returned archive suffix,
Document tab path migration, and IndexedDB conditional-delete behavior. A
FileTree component test freezes confirmation-token capture before the lifecycle
call. The final empty-family race coverage uses a second real IndexedDB context:
when it wins the first primary mint and the first local candidate transaction
fails, a later recovery keeps the remote primary as winner, persists the local
bytes only as a conflict candidate, and converges both records to the server's
stable path.

Final Edit-09.5 seal verification (2026-07-21):

- `draftFileTransactions.test.ts`: 145 tests passed;
- draft-recovery suites: 8 files / 274 tests passed;
- complete Vitest suite: 122 files / 1,573 tests passed;
- draft-store/file-transaction Playwright suite: 28 tests passed;
- application Playwright suite: 9 tests passed;
- typecheck, production build, icon lint, and `git diff --check` passed.

Edit-09 remains open: Recovery Center, retention, and capacity cleanup are still
deferred to Edit-09.6.

### Edit-09.6 — Background recovery management and bounded cleanup

Product position revised and implemented on 2026-07-21.

> Nuvyn recovery is a browser-local safety mechanism for unsaved editor
> buffers. It is normally invisible. A prompt or temporary “Unsaved Content”
> list appears only when Nuvyn cannot safely decide what to do. It is not a
> recycle bin, file backup, version history, or a daily document-management
> destination.

- The permanent Activity Bar entry was removed. The existing Recovery workspace
  and read-only tabs remain available from an exceptional recovery prompt; old
  layouts that persisted the preview panel migrate to a closed panel.
- A primary record whose authoritative baseline still matches disk is adopted
  automatically into the dirty editor buffer. Adoption never invokes the
  server autosave pipeline and shows one lightweight recovered-content notice.
  Divergent, missing-source, identity-mismatch, unreadable and conflict records
  remain explicit user decisions.
- Automatic deletion is value-aware. It may conditionally delete an exact
  record whose recovered body already equals disk, or a ready-classified
  missing/identity-mismatch orphan strictly older than 30 days. Capacity is a
  soft limit: divergent, conflict, unknown, classification-error, protected and
  unsupported/future records are never evicted merely for being oldest.
- Cleanup runs once after vault discovery (and on explicit management actions),
  not after every debounced draft write. Requests remain vault-scoped,
  serialized/coalesced, classification-aware, protected at plan and mutation
  time, and use full-record conditional deletion.
- Management inventory reads only the current vault’s compound-key ranges while
  still counting corrupt/future rows whose secondary indexes are invalid. Raw
  unsupported content is never returned to the UI or automatically deleted.
- The temporary list uses user-facing decision language and emphasizes title,
  path, last edit, view/retry/discard. Database versions, internal IDs and
  routine capacity telemetry are not the primary interface.
- The 2 MiB record gate remains shared by all primary/candidate persistence
  channels. Oversized and failed browser writes remain pending/fail closed and
  emit deduplicated, content-free warnings; ordinary Markdown disk saving is
  unchanged.

IndexedDB recovery data belongs only to the current browser profile. Clearing
site data can remove it. A recovery record is not a Markdown file, and recovery
defaults to filling the editor buffer rather than silently writing disk. Formal
file-deletion recovery is outside the Edit series.

Edit-09.6 leaves the sealed Edit-09.5 family-path state machine and all Edit-10
AI context work unchanged.

**Stage status:** Closed — implemented and verified at
`9a0837b243b159e8bbfdecae7b275ca47134b118`.

Final Edit-09.6 verification (2026-07-21):

- draft-recovery plus Recovery Center/layout focused suites: 14 files / 310 tests passed;
- complete Vitest suite: 127 files / 1,600 tests passed;
- draft-store/file-transaction Playwright suite: 31 tests passed;
- application Playwright suite: 9 tests passed;
- typecheck, production build, icon lint, and `git diff --check` passed.

The seal review approved the exception-driven downgrade and found two blocking
holes plus one tightening, fixed at `9a0837b` (`fix: bind cleanup decisions to
exact recovery records`):

- Cleanup decisions are now bound to the EXACT classified record
  (`ClassifiedCleanupDecision`): the planner applies a verdict only while the
  fresh Store inventory still equals it (full `draftsEqual` /
  `conflictDraftsEqual`). A record another context wrote under the same
  recoveryId after classification has no certified verdict and stays until a
  fresh classification certifies it — the conditional CAS delete alone cannot
  protect it, since it matches the replacement exactly.
- `safe-redundant` additionally requires the same stable identity: disk ready,
  `disk.documentId === draft.documentId`, identical body. A path reused by
  another document is an identity-mismatch, never redundant.
- Startup auto-adoption opens with `{ refresh: false }` and each adoption is
  individually isolated: a routine tree/posts refresh failure (which runs
  outside openPost's load try/catch) no longer rejects the adoption or aborts
  the startup loop. A failed adoption keeps its record and surfaces it through
  the temporary Unsaved Content panel — baseline-match items never reach the
  prompt, so a silent exception would leave the stored bytes with no entry
  point at all.

Regression coverage: cross-context replacement of a safe-redundant primary, a
stale missing-source verdict, and a same-conflictId candidate all preserve the
replacement; an identity-mismatch record with an identical body is not treated
as redundant; `openPost` refresh-failure isolation is tested behaviorally
(default propagates the rejection, `refresh: false` skips the refresh and
resolves).

Accepted residual risk: classification certifies the disk snapshot at
classification time; cleanup does not re-read disk. A record once proven
byte-identical to disk that disk later outgrows is not expected to recover the
newer disk version — recovery is a local unsaved-buffer safety net, not version
history. Cleanup runs only once after startup discovery (plus explicit
management actions), so the window is narrow. If scheduled background cleanup
is ever reintroduced, bind the disk snapshot to a version marker or re-verify
disk before deleting.

Final Edit-09.6 seal verification (2026-07-21, post-review hardening at
`9a0837b`):

- draft-recovery plus Recovery Center/layout focused suites: 15 files / 323 tests passed;
- complete Vitest suite: 128 files / 1,617 tests passed;
- draft-store/file-transaction Playwright suite: 31 tests passed;
- application Playwright suite: 9 tests passed;
- typecheck, production build, icon lint, and `git diff --check` passed.

Edit-09 is closed: stages 09.1–09.6 (design and behavior freeze, pure storage
model, dirty-buffer persistence, recovery decisions, file transactions, and
exception-driven recovery management) are all implemented, reviewed, and
verified.

## 12. Edit-09.2 Acceptance Tests

- Stable, vault-scoped keys do not collide across documents or vaults.
- A valid draft round-trips without sharing mutable references.
- Updating a draft preserves the original `createdAt`.
- Older and conflicting equal-timestamp writes cannot overwrite newer state.
- Corrupt and future-version records occupying a key cannot be overwritten.
- Listing is vault-scoped, newest first, and deterministic.
- Delete and clear are idempotent and isolated by vault.
- Move changes identity/path and removes the old key atomically.
- Move preserves source content, baseline, and `createdAt`.
- Any different duplicate-target draft conflicts without changing either record.
- Move distinguishes moved, missing, conflict, unsupported, and backend failure.
- Invalid inputs are rejected.
- Corrupt and future-version records do not break valid reads.
- IndexedDB unavailable/open/request/transaction failures resolve as safe failures;
  they do not create unhandled promises.

## 13. Quality Gates

Each stage is an independent commit and must pass its focused tests. The completed
Edit-09.2 batch additionally runs:

```bash
npm test
npm run test:e2e:draft-store
npm run typecheck
npm run build
npm run lint:icons
```

## 14. Edit-09 Final Closure

Final sealing round (2026-07-21). Closure baseline: `13a43ab`
(`fix: keep recovery storage failures out of the normal workspace` — round 3:
storage-failure typing, management, Recovery Center, and toast-dedup tests). The earlier `9a0837b` seal verification in
Section 11 remains preserved as the Edit-09.6 stage record, but it is NOT the
basis for this final closure: the full diff range `EDIT09_BASE` (`f094456`,
Edit-08 seal) .. HEAD was frozen, regressed end-to-end, and closed below.
Nature of this round: final sealing regression only — only regressing, only
filling missing tests, only fixing real blockers, only updating final docs.
No production behavior changed since `13a43ab`.

### 14.1 Behavior freeze (13 points)

Frozen at `13a43ab` and asserted by the regression matrix below:

1. Normal typing persists the dirty buffer on an 800ms draft debounce while an
   independent 800ms server autosave runs in parallel; a successful server save
   removes the draft via `markClean` — drafts are normally unobservable
   (~50ms window).
2. Startup discovery silently adopts baseline-matching drafts: no dialog, no
   toast, no direct disk write — adoption flows through the editor's normal
   save pipeline, each adoption isolated with `{ refresh: false }`.
3. Divergent, missing-source, and identity-mismatch drafts never auto-adopt;
   they surface through the recovery prompt (`.draft-recovery-dialog`) with
   per-kind actions.
4. The recovery viewer is a read-only workspace tab (`.draft-recovery-pane`);
   Ctrl+S while it has focus never fires the document Save pipeline.
5. Document tabs and recovery tabs coexist in one stable tab strip; closing
   one never disturbs the other.
6. Startup shows no Recovery Center and emits no toast on a clean boot;
   `warnRecoveryReadFailure` toasts once per vault per page lifecycle.
7. Every IndexedDB failure resolves as a typed `DraftStorageError` with reason
   `indexeddb-unavailable | upgrade-blocked | open-failed | transaction-failed`;
   no unhandled rejections anywhere in the recovery path.
8. Under a blocked upgrade (an old tab holding an old-version connection): the
   first open rejects `upgrade-blocked`, the startup refresh awaits a silently
   queued connection, and the workspace stays entirely normal — no toast, no
   panel switch. IndexedDB delivers `blocked` only to the FIRST upgrade
   attempt; later opens queue silently. After the blocker closes, the next
   reload recovers normally.
9. Cleanup is bound to the exact classified record: a record another context
   replaced after classification has no certified verdict and survives until a
   fresh classification certifies it.
10. `safe-redundant` requires the same stable identity: disk ready, identical
    `documentId`, byte-identical body. A path reused by another document is an
    identity-mismatch, never redundant.
11. Drafts are vault-scoped by `sha256(CONTENT_DIR).slice(0,12)`; tab
    persistence is pure `localStorage` (`nuvyn:tabs:v1:<vaultId>`) with no
    server sync.
12. Draft bodies are never logged by application code or by tests.
13. No production code changed in Final Closure; the round adds tests, test-
    harness hygiene, and documentation only.

### 14.2 Six-chain regression matrix

| Chain | Evidence (files → tests) | Result |
| --- | --- | --- |
| Editing / autosave | `useDocumentSave.ts` (onEditorChange, scheduleDraft, scheduleSave, saveLatest→markClean) → E2E-1 draft creation under a held Save API; E2E-9 dirty buffer; vitest `useDocumentSave` suites | Pass |
| Crash recovery | `VaultView.vue` startup discovery/adoption loop; `useUnsavedDraftRecovery.ts` pendingItem; `applyRecoveredDraft` → E2E-1 (hard restart adopts baseline-match, dialog absent, disk untouched); E2E-2 (external disk change → divergent prompt → View Diff shows both sides) | Pass |
| Rename / move / delete | `draftStore.ts` move/CAS/quarantine transactions → `draft-file-transactions.spec.ts` (5 tests: move to server path byte/time preserving, newer cross-context record kept after delete, conflict paths moved on rename, conflict-only delete clears frozen conflicts, mid-CAS edit persists as conflict candidate); `draft-store.spec.ts` move/CAS/retry suites (lines 234–2449) | Pass |
| Multi-tab concurrency | `createIndexedDbDraftBackend` connection cache + `openDatabase` blocked/versionchange handling → cross-context suites (inventory keeps newer conflict 73; never adopts newer cross-context draft 372; conflict re-pinned on family move in another context 1021; cached connection closed on upgrade 1269; no late-connection leak after blocked open 1312); E2E-5 two live contexts editing the same identity — stale write promoted to a candidate with `crossContextUpdatedAt`, primary never re-minted; E2E-7 cross-context replacement survives cleanup; E2E-10 blocked upgrade with a seeded v1 record | Pass |
| External conflicts | `draftRecoveryDecision.ts`; `SavePostConflictError` path in `saveLatest` → mid-CAS conflict candidate (file-transactions 409); same-identity conflict save blocks (draft-store 630/1124); E2E-2 divergent classification; E2E-9 coexistence | Pass |
| History / Diff / Recovery workspace | `DraftRecoveryPrompt.vue`, `DraftRecoveryPane.vue`, `useDraftRecoveryTabs`, `VaultView.vue` workspace wiring → E2E-2 View Diff pane renders both sides; E2E-9 read-only viewer + document coexist, Ctrl+S isolated, closing recovery leaves document intact; E2E-10 workspace stays normal under a blocked upgrade | Pass |

### 14.3 Final Closure E2E coverage (E2E-1 .. E2E-10)

Seven tests were created in Final Closure (`e2e/draft-store.spec.ts`, all
against real IndexedDB on a dedicated Vite origin with a fresh vault per
suite run); the remaining scenarios reuse existing real-IndexedDB/real-server
tests:

| Req. | Covered by | Status |
| --- | --- | --- |
| E2E-1 | NEW `E2E-1: a hard restart adopts a baseline-matching autosaved draft without saving the server file` | Added, Pass |
| E2E-2 | NEW `E2E-2: an external disk change makes the draft divergent and offers a diff instead of auto-adoption` | Added, Pass |
| E2E-3 rename/move under failure | `draft-store.spec.ts:1398` a stale quarantine retry in a second IndexedDB context adopts the certified current path; `:1562` the move-indeterminate counterpart; `draft-file-transactions.spec.ts:17` atomic move to the actual server path; `:221` conflict records moved along on rename | Reused, Pass |
| E2E-4 delete | `draft-file-transactions.spec.ts:123` keeps a newer cross-context record after confirmed delete; `:324` removes frozen conflicts on conflict-only delete | Reused, Pass |
| E2E-5 | NEW `E2E-5: two concurrent contexts route a stale write to the candidate channel without overwriting the primary` — two live persistence channels (two IndexedDB contexts) edit the same identity from the same baseline; the lagging context's primary write comes back stale and the production state machine promotes it to a conflict candidate whose `crossContextUpdatedAt` points at the certified primary; a further edit stays on the candidate channel and the primary's body AND `updatedAt` are never re-minted. Additionally `draft-file-transactions.spec.ts:409` persists a mid-CAS edit as a conflict candidate across dispose | Added, Pass |
| E2E-6 chained rename across contexts | `draft-store.spec.ts:1398` Context A renames into quarantine, Context B moves the family onward, A's stale retry adopts B's certified path — the family is never dragged back, and A's body lands as a candidate at the certified path; `:2449` an emptied-family retry converges when another window renames between the resolve and the revalidation; `:1021` a conflict candidate is re-pinned when the family moves in another context | Reused, Pass |
| E2E-7 | NEW `E2E-7: a record another context replaces after safe-redundant classification survives cleanup` (real IndexedDB, two live store contexts) | Added, Pass |
| E2E-8 | NEW `E2E-8: external delete and path reuse remain identity-mismatched` — draft recorded under document A; A is deleted externally; document B takes over the same path with a different `documentId` and a body BYTE-IDENTICAL to A's draft; restart → identity-mismatch prompt ("The original path now belongs to another document."), no auto-adoption, the draft survives startup cleanup despite byte equality (identity-mismatch is never safe-redundant), B's markdown stays byte-exact | Added, Pass |
| E2E-9 | NEW `E2E-9: document and recovery viewers coexist without cross-saving` (real Monaco, real tab strip; Ctrl+S on the read-only viewer must not save the dirty document — checked in the 400ms window between an immediate wrongful save and the 800ms autosave debounce) | Added, Pass |
| E2E-10 | `E2E-10: a blocked upgrade preserves seeded records and recovers into adoption after the blocker closes` — the blocker mints a v1 database whose `drafts` store holds a valid baseline-match draft for a real document; under the blocked upgrade the workspace stays normal (no toast, no panel, no backdrop); after the blocker closes, the silently queued v2 upgrade completes with the seeded record still intact (raw IndexedDB proof at version 2); a reload then recovers the surviving record all the way into adoption (editor shows the draft, disk never written directly, startup warning-free) | Strengthened, Pass |
| Connection lifecycle | `draft-store.spec.ts:1269` closes a cached connection when another context upgrades; `:1312` does not leak a late connection after a blocked open | Reused, Pass |

Draft-store E2E suite total: 38 tests (31 pre-existing + 7 created in Final
Closure), all passing. Application E2E suite: 9 tests, all passing.

### 14.4 Final gate results (run locally, 2026-07-21; no CI)

| Gate | Exit | Result |
| --- | --- | --- |
| `npm ci` | 0 | 408 packages, clean install |
| `npm run typecheck` | 0 | clean (re-run after the final spec/config edits) |
| `npm run lint:icons` | 0 | no violations |
| `npm test` (vitest) | 0 | 128 files / 1,623 tests, 27.88s |
| `npm run build` | 0 | built in 1.47s |
| `npm run test:e2e:draft-store` | 0 | 38 passed, 26.2s |
| `npm run test:e2e` | 0 | 9 passed, 7.1s |
| `git diff --check` | 0 | no whitespace errors |
| `.only` / `.skip` audit | 0 hits | no focused or skipped tests |

All verification was executed locally on the development machine; there is no
CI pipeline for this repository.

### 14.5 Edit-10 audit over `f094456..HEAD`

Scope check: the full Edit-09 diff must contain no Edit-10 surface (AI
SDKs/clients, Chat UI, prompt builder, context pack, embedding/vector/RAG,
model settings, token budget, AI persistence, AI routes, feature flags,
telemetry).

| Surface | Result | Evidence |
| --- | --- | --- |
| AI SDKs / clients in dependencies | Pass | `package.json` diff vs `f094456` touches scripts only; `package-lock.json` and `pnpm-lock.yaml` unchanged since `56a5f4e` (pre-Edit-09) |
| Chat UI / prompt builder / context pack | Pass | keyword grep over the diff range finds no chat/prompt/context-pack additions |
| Embedding / vector / RAG | Pass | no matches in the diff range |
| Model settings / token budget / AI persistence / AI routes | Pass | no matches; the only `recovery`/`draft` keyword hits are the Edit-09 `DraftRecoveryPrompt` component itself |
| Feature flags / telemetry | Pass | no flag or telemetry additions in the diff range |

Conclusion: **No Edit-10 implementation was introduced.** (The pre-existing AI
panel predates `f094456` and is outside the Edit-09 diff.)

### 14.6 Harness blocker found and fixed during gating

`playwright.config.ts` (application E2E) launched its webServer with
`pnpm exec vite`. Under the npm-managed `node_modules` produced by the
mandated `npm ci` gate, `pnpm exec` re-installs per `pnpm-lock.yaml` mid-run,
re-laying `node_modules` out with symlinks while the Playwright CLI is already
loaded — so the CLI and the collected specs resolve two distinct physical
`@playwright/test@1.61.1` instances and every spec fails collection
("Playwright Test did not expect test() to be called here"; 2 failed,
7 did not run). The specs were proven healthy under a pnpm-consistent layout
(9 passed) and the webServer command was changed to the manager-agnostic
`npm exec vite -- …`, which resolves from `node_modules/.bin` under BOTH
layouts (matching the draft-store config). This is a pre-existing baseline
harness inconsistency, not an Edit-09 regression; fixed in a separate `fix:`
commit per the minimal-fix policy.

### 14.7 Accepted residual risks

1. Deferred proposal (user decision, NOT implemented; production frozen at
   `13a43ab`): silence routine startup recovery failures — startup would drop
   the toast for `transaction-failed` / `open-failed` / `indexeddb-unavailable`
   and warn once per tab session for `upgrade-blocked` via `sessionStorage`
   (`RECOVERY_BLOCKED_WARNING_PREFIX = 'nuvyn.recovery-blocked-warning:'`);
   manual Recovery Center retries would still toast per reason, and a
   successful recovery would clear the marker. Would have been
   `fix: silence routine recovery failures during startup`. Rationale:
   Recovery is a low-frequency exception backstop; normal startups should not
   announce it.
2. Under a blocked upgrade the startup refresh awaits silently with no visible
   signal until the blocker closes (frozen `13a43ab` contract, verified by
   E2E-10). Follows directly from IndexedDB delivering `blocked` only to the
   first upgrade attempt.
3. Toast deduplication is effective only within the current page lifecycle —
   accepted per user observation.
4. Classification certifies the disk snapshot at classification time; cleanup
   does not re-read disk (pre-existing, Section 11 Edit-09.6 seal note).

### 14.8 Closure

Final Closure adds: seven real-IndexedDB E2E tests (E2E-1, E2E-2, E2E-5,
E2E-7, E2E-8, E2E-9, E2E-10 — E2E-5 dual-context stale-write routing, E2E-8
external-delete/path-reuse identity-mismatch, and a strengthened E2E-10
seeded-v1-record survival were completed in the final closure matrix pass),
draft-store suite hygiene (fresh vault per webServer start, exact-aria-label
tree targeting), the manager-agnostic application-E2E webServer fix, and this
section. Stage records and SHAs from Section 11 (`9a0837b` seal) and the
round-3 seal (`13a43ab`) are preserved above. The closure commit
(`chore: close Edit-09 end-to-end`) sealed production at zero regressions;
the final closure matrix commit (`test: complete Edit-09 final closure
matrix`) completes the E2E-1..E2E-10 evidence matrix with no production
changes.
