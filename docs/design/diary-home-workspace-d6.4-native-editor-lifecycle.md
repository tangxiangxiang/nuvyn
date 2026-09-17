# D6.4 Native Editor Lifecycle Verification Evidence

> **Historical lineage — not current runtime authority.** Current behavior is
> defined by [Diary Architecture](../architecture/diary.md) and [Diary User
> Guide](../user-guide/diary.md). This file is retained for D6 traceability.

## Status

- D6.0–D6.3 = `REVIEW-CLOSED`.
- D6.4 = `REVIEW-CLOSED` — Native Editor Lifecycle Verification.
- Independent Review = `PASS` (P0 = 0, P1 = 0, P2 = 0).
- D6.5 = `NOT STARTED`; D6.6 and D6.7 remain `BLOCKED`.
- Task-scoped follow-up self-review: P0 = 0, P1 = 0, P2 = 0.
- Independent review passed with no remaining P0/P1/P2 findings.
- This phase changed tests and evidence only. Production code is unchanged.

The canonical D6 direction remains:

> Calendar does navigation. Vault does documents.

The native Editor lifecycle is verified through the existing Vault owners. No
Diary Editor, Editor Dialog, duplicate Monaco model, or Diary-specific save
pipeline was introduced.

## Baseline and scope

- Starting HEAD: `e550c1873d77ddfd95b96d87cff935130b09c662`
- Starting branch: `main`
- Starting worktree: clean and aligned with `github/main`.
- D6.4 evidence follow-up starting HEAD: `b5b07f183217cbf62308a56e4c9bcc581d174369`.
- Evidence commit: the test/docs commit containing this document.
- Runtime timezone used by the browser fixture: `Asia/Shanghai`.

This phase verifies the same Diary document through the native sequence:

```text
Calendar date
  -> existing openDiaryDate()
  -> existing openPost()/tab workspace
  -> native READ / ReadingPane
  -> existing READ <-> EDIT view toggle (Cmd+E remains an existing shortcut)
  -> native EditorPane / Monaco
  -> existing save, dirty, draft, History, Recovery and external-change owners
  -> presentation-only Calendar Home
  -> same-date reopen
```

The only new runtime-facing artifact is the focused browser suite:

- `e2e/diary-editor-lifecycle.spec.ts`

The plan and PRD status mirrors were updated only to record this evidence and
the resulting `REVIEW-READY` state. No `src/**`, `server/**`, `shared/**`,
package, lockfile, dependency, router, Calendar, or FileTree implementation
was changed.

## Files inspected and current architecture facts

The verification was based on the following current production seams:

- `src/views/VaultView.vue`
- `src/composables/diary/useDiaryWorkspacePresentation.ts`
- `src/components/diary/DiaryWorkspace.vue`
- `src/composables/vault/useEditorTabs.ts`
- `src/composables/vault/editor-tabs/useTabWorkspace.ts`
- `src/composables/vault/editor-tabs/useDocumentSave.ts`
- `src/composables/vault/editor-tabs/useRouteSync.ts`
- `src/composables/vault/useDocumentLifecycle.ts`
- `src/components/vault/ReadingPane.vue`
- `src/components/vault/EditorPane.vue`
- `src/components/vault/EditorTabs.vue`
- `src/components/vault/StatusBar.vue`
- `src/composables/vault/draft-recovery/`
- `src/composables/vault/history/`
- `src/composables/vault/editor-tabs/useExternalFileChanges.ts`
- `src/composables/vault/editor-tabs/useDiskFileChanges.ts`
- `e2e/helpers/edit-program.ts`

Current facts confirmed from those files:

1. `VaultView` remains the composition root. It creates the existing tab/save,
   History, Recovery and file-change owners and supplies the existing
   `openPost` callback to `useDiaryDateCommand()`.
2. `openDiaryDate()` is still the only Diary date command. It validates the
   date, performs the existing exact-path create/open contract, awaits the
   existing `openPost()` completion and returns `opened`, `created`, `future`,
   or error results to `VaultView`.
3. `useTabWorkspace()` owns `tabs`, `activePath`, `activeTab`, tab reuse,
   navigation, tab persistence and document identity loading. Opening an
   already-open path activates the existing tab instead of cloning it.
4. `useEditorTabs()` wires that workspace to `useDocumentSave()`, route sync,
   external file changes, disk polling, drafts and existing document-close
   barriers.
5. `useDocumentSave()` owns `raw`, `originalRaw`, revisions, save status,
   autosave/manual save, dirty state, draft scheduling, history barriers,
   close barriers and external conflict resolution.
6. `EditorPane` is the ordinary controlled Vault editor and acquires the
   path-keyed Monaco model through the existing model registry. `ReadingPane`
   is the ordinary native reader. `VaultView` mounts one active reader slot and
   uses the existing global view mode for READ/EDIT.
7. Diary presentation owns only presentation state. `closePresentation()` can
   return to Calendar Home while leaving route, activePath, tab, raw, model and
   dirty state under their existing owners.
8. The Calendar is mounted for the whole Diary scope through the existing
   scope-only predicate and is hidden with presentation visibility when a
   native document or special surface is active. The D3.0 keep-mounted
   workaround is unchanged.
9. History Comparison, Working Tree Diff and Recovery retain their own
   precedence and lifecycle. Diary presentation yields to them; it does not
   close, copy or rehost their state.

## Ownership matrix

| Concern | Current owner / file | D6.4 observed seam | Forbidden D6.4 change |
| --- | --- | --- | --- |
| Router and browser history | Vue Router, `useTabWorkspace()` | observe resulting route | new Diary route, `popstate`, fake history |
| Route synchronization | `useRouteSync.ts` | route changes reconcile through existing `openPost()` | Dialog/editor-driven router mutation |
| Diary scope | `useScopeFilter()` / app shell | read the existing scope ref | second scope store |
| Calendar mount | `VaultView.vue` | scope-only mount remains attached | document-triggered unmount |
| Calendar visibility | `useDiaryWorkspacePresentation()` + `VaultView` | hide/show presentation | tab-count or editor ownership |
| Date command | `useDiaryDateCommand()` | consume one command result | second create/open command |
| Document identity | `useTabWorkspace()` and server metadata | same path/tab and metadata id | cloned Diary document |
| Tabs | `useTabWorkspace()` / `useEditorTabs()` | observe and reuse | Diary tab store or tab mutation from Home |
| `activePath` | `useTabWorkspace()` | existing navigation remains authoritative | presentation retargeting |
| Raw Markdown | existing `Tab.raw` | Editor/Reader consume active raw | presentation raw copy |
| Monaco model | `EditorPane` + `monacoModelRegistry` | one existing path-keyed model seam | second Monaco lifecycle |
| Save/autosave | `useDocumentSave()` | existing save and Ctrl/Cmd+S | Diary save pipeline |
| Dirty state | `useDocumentSave()` / tab state | dirty survives presentation Home | discard/save on Home |
| Draft persistence | `draftStore` + `useUnsavedDraftPersistence` | IndexedDB draft survives reload and is adopted by native tab | Diary draft store |
| History | existing History composables and `VaultView` | comparison can yield presentation | copied history state or Diary history |
| Recovery | existing draft recovery owners and `VaultView` | startup recovery adopts the native tab | Recovery Dialog/workflow owned by Diary |
| External changes | `useExternalFileChanges()` / disk changes + `useDocumentSave()` | existing 409/conflict controls remain on tab | conflict handler in Diary presentation |
| Reader rendering | `ReadingPane.vue` | exactly one native reader slot | `DiaryReader` / second Markdown renderer |
| Editor rendering | `EditorPane.vue` | existing view toggle and Monaco | `DiaryEditor` / duplicate editor |
| Dialog/Home presentation | `useDiaryWorkspacePresentation()` | Home action is presentation-only | route/tab/raw/dirty mutation |
| Keyboard ownership | `VaultView.onVaultKeydown()` and editor shortcuts | native toggle/save/close policy remains | Home cycling/closing hidden tabs |
| Focus return | Diary presentation + existing Vault focus refs | return focus to Calendar/Vault | new lifecycle or focus-owned document state |

## Native command and state flow

The verified production flow is:

```text
DiaryCalendar dayclick
  -> DiaryCalendarSurface forwards date-selected
  -> VaultView.onDiaryDateSelected(date)
  -> useDiaryWorkspacePresentation begins intent
  -> existing openDiaryDate(date)
  -> existing openPost(path)
  -> useTabWorkspace reuses or creates the path tab
  -> route and activePath follow existing Vault lifecycle
  -> successful result is adopted only when intent/scope/path checks pass
  -> VaultView sets existing viewMode to READ
  -> exactly one native ReadingPane renders
  -> existing view toggle / Cmd+E exposes EditorPane and Monaco
  -> EditorPane emits to useEditorTabs -> useDocumentSave
```

Returning Home is a separate presentation transition:

```text
Calendar Home action
  -> closePresentation()
  -> Calendar visible, still mounted
  -> backing tab, activePath, route, raw and dirty state remain unchanged
```

A real document close is not this transition:

```text
Tab close
  -> existing close barrier / dirty confirmation
  -> existing tab disposal and draft cleanup
```

## State ownership diagram

```text
Router / browser history
        │ resulting /vault/<path>
        ▼
useRouteSync() ───────────────► useTabWorkspace()
                                      │
                                      ├─ tabs / activePath / activeTab
                                      ├─ document identity / route navigation
                                      └─ existing close and persistence
                                      │
                                      ▼
                              useDocumentSave()
                                      │
                 raw / dirty / save / draft / external conflict
                                      │
                 ┌──────────────────┴──────────────────┐
                 ▼                                     ▼
          ReadingPane (READ)                 EditorPane + Monaco (EDIT)

Calendar dayclick ─► openDiaryDate() ─► existing Vault document lifecycle

Diary presentation owner
  ├─ HOME / DOCUMENT visibility
  ├─ selected date and backing path
  └─ focus return context

Diary presentation observes the resulting document state. It does not own
router mutation, tab mutation, raw persistence, save, dirty, draft, History,
Recovery or server mutation.
```

## D6.4 browser evidence

The dedicated Chromium suite `e2e/diary-editor-lifecycle.spec.ts` completed:

```text
6 tests PASS
```

### Calendar -> native READ -> native EDIT -> Calendar -> reopen

The test seeds a real Diary document through the existing Diary API, clicks the
exact Calendar date, and verifies:

- the URL is the exact `/vault/diary/YYYY-MM-DD` route;
- no Diary Reader Dialog exists;
- one native `ReadingPane` and one selected native document tab are present;
- the Calendar remains attached but hidden;
- the existing READ/EDIT toggle enters one `.monaco-editor` in the native
  `EditorPane`;
- an ordinary save reaches the existing saved tab state;
- an aborted autosave leaves the native tab dirty and creates a real IndexedDB
  draft;
- presentation-only return to Calendar leaves the selected tab, route,
  activePath and dirty raw in place, with no close confirmation;
- Home does not let Ctrl/Cmd+W close the hidden backing tab;
- reopening the same date reuses the same document metadata id and presents the
  unsaved local raw, while the server still contains the last saved raw;
- existing Ctrl/Cmd+S saves the dirty raw and removes the draft;
- a real tab close still invokes the existing dirty confirmation, including
  cancel and confirm paths.

This proves that Calendar Home is not a document-close operation and that the
native editor state remains owned by the ordinary Vault lifecycle.

### History Comparison precedence

The History test uses the existing history surface and a scoped fake timeline
only for deterministic browser data. It first creates a dirty native Diary
Editor buffer and persists its draft through the existing draft owner. It then
verifies that:

- native Diary Editor is yielded to History Comparison;
- Calendar remains attached and hidden while the special surface is active;
- no additional live-document PUT occurs after History becomes active;
- the dirty marker remains on the live native tab while the comparison is open;
- opening a historical comparison leaves the live raw/metadata identity
  unchanged;
- closing the comparison returns to Calendar Home;
- reopening the same date reuses the same document identity and presents the
  unsaved local raw, while the server still contains the last saved raw.

History Comparison remains a Vault-owned surface; D6.4 adds no Diary history
adapter.

### History Restore continuity

The History Restore test uses the real temporary-vault history repository. It
creates a real Diary revision through `POST /api/history/commits`, changes the
same document through the real CAS-backed post endpoint, then uses the native
History Comparison More actions menu and restore confirmation. It verifies:

- the historical bytes are restored through the existing History restore owner;
- the restored server document keeps the original metadata identity;
- the existing document tab remains present and no second Diary document is
  opened;
- closing the comparison returns to Calendar Home with the backing tab intact;
- reopening the same date through Calendar presents the restored bytes in the
  native Reader.

No History state or restore pipeline is owned by Diary presentation.

### Recovery continuity (baseline and divergent)

The dedicated suite covers both Recovery branches. The baseline-match test
aborts the browser save after a native Editor change so the draft is persisted
by the existing draft owner. After reload it verifies:

- Calendar Home is initially visible;
- startup Recovery adopts the draft into the native Diary tab without a new
  Diary recovery prompt;
- the adopted raw is visible in the native Monaco model and remains dirty;
- the server baseline and document metadata id are unchanged until save;
- reopening the same date presents the recovered local raw;
- existing Ctrl/Cmd+S saves it and the real draft record is removed.

The divergent test then verifies the separate explicit-resolution path:

- a dirty native Diary Editor draft is persisted while the browser autosave is
  deliberately aborted;
- an external disk append creates a real disk/draft divergence before reload;
- the existing Recovery prompt appears and `View Diff` shows both draft and
  disk markers;
- Calendar remains attached but is hidden while the existing Recovery pane is
  active, and the original native Diary tab remains the document identity;
- `Open Recovered Content` followed by `Use Disk Version` removes the draft,
  leaves the existing tab/lifecycle in control, and leaves the exact disk
  bytes and metadata identity on the server;
- a fresh existing Vault lifecycle load followed by an explicit Calendar
  reopen presents the disk winner in native Reader.

The repository's existing generic `e2e/edit-program-long-flows.spec.ts` was
also run separately (`2/2 PASS`). Its sealed Long Flow A supplies generic
divergent-Recovery coverage; the Diary-specific test above supplies the
Diary-scope presentation precedence, identity and Calendar-reopen bridge.

No Recovery state is copied into Diary presentation.

### External conflict continuity

The external-change test parks the existing browser autosave, edits the native
Diary document, writes a competing server version through the real API and
releases the parked save. It verifies:

- the existing compare-and-swap save returns 409;
- the native tab enters the existing external-conflict status;
- Calendar Home and same-date reopen preserve the local raw and document id;
- the existing `Keep local version and overwrite disk` action resolves the
  conflict through the existing save owner;
- the server ends with the local raw and unchanged metadata identity.

The conflict path does not introduce a Diary-specific resolver.

### Browser diagnostics

All six dedicated tests recorded `pageErrors = []`. The test diagnostics
recorded no unexpected console errors after filtering only the deliberate
test-induced network messages from aborted requests and the expected 409
conflict response. The suite does not convert those expected test-hook network
messages into a general console-clean claim.

The D6.4 suite uses the existing `view-toggle` control for READ/EDIT
transitions. It does not add a new browser assertion for `Cmd+E`; the existing
shortcut remains deferred to the broader D6.6 keyboard/accessibility phase.

## Regression and static validation

The focused native/presentation unit run completed:

```text
npm exec vitest run \
  src/composables/diary/__tests__/useDiaryWorkspacePresentation.test.ts \
  src/components/diary/__tests__/DiaryWorkspace.test.ts \
  src/components/diary/__tests__/DiaryCalendarSurface.test.ts \
  src/views/__tests__/VaultView.test.ts

4 test files PASS
60 tests PASS
```

The D6.2/D6.3 Calendar, native reader, History/Recovery, Browser Back and
release regressions completed:

```text
npm run test:e2e -- \
  e2e/diary-calendar-surface.spec.ts \
  e2e/diary-reader.spec.ts \
  e2e/diary-release.spec.ts

17 tests PASS
```

The existing `diary-reader.spec.ts` portion of that run was 7/7 PASS. The
existing generic long-flow suite was run separately and was 2/2 PASS. The
dedicated D6.4 suite was run separately and was 6/6 PASS, including the
Diary-specific divergent Recovery and History Restore cases above.

Static validation on this tree:

```text
npm run typecheck:client  PASS
npm run typecheck         PASS (client + server)
npm run build             PASS
git diff --check          PASS
```

The build emitted only the repository's existing Vite dependency annotation
and large-chunk warnings. No test, production implementation or dependency
was changed to obtain a passing result.

## Reconciliation matrix

| Event | Existing lifecycle owner/result | D6.4 presentation result |
| --- | --- | --- |
| Calendar date success | `openDiaryDate()` -> existing tab/route/activePath | native READ; then existing toggle may enter EDIT |
| Calendar date failure/future missing | no adopted document | HOME; no Editor/Reader transition |
| Native view toggle | existing Vault view mode and EditorPane | same DOCUMENT state; no second model; `Cmd+E` browser assertion deferred to D6.6 |
| Editor change | `useDocumentSave()` updates raw/dirty/draft | presentation remains passive |
| Ctrl/Cmd+S | existing save owner | dirty state clears through native lifecycle |
| Presentation Calendar return | tab/raw/route/activePath unchanged | HOME; Calendar visible and still mounted |
| Same-date reopen | existing path tab is reused | native READ of same document identity/local raw |
| Tab/document close | existing dirty confirmation and disposal | presentation follows resulting state; no special close path |
| History Comparison | existing History surface and diff tab | dirty native document remains intact; Diary presentation yields and Calendar remains mounted |
| History Restore | existing History restore owner and document tab | historical bytes replace the same document identity; Calendar reopens the restored native Reader |
| Recovery adoption | existing draft recovery and native tab state | baseline and divergent branches remain lifecycle-owned; presentation does not copy recovery state |
| External conflict | existing CAS/StatusBar resolution | presentation does not intercept or resolve conflict |
| Browser Back | Router -> `useRouteSync()` -> existing document lifecycle | observe/reconcile; no interception |
| Scope change | existing scope owner | presentation resets; documents remain lifecycle-owned |

## D6.4 readiness and deferred work

The following are proven and require no new architecture seam:

- Calendar-to-native-READ command handoff;
- native READ-to-EDIT toggle;
- same-tab/raw/dirty continuity through Calendar Home;
- existing save, draft, History Comparison, History Restore, Recovery and
  external-change ownership;
- divergent Recovery explicit resolution with same-identity Calendar reopen;
- no duplicate Diary Editor, Monaco, raw, save or recovery pipeline;
- Calendar keep-mounted behavior remains intact.

D6.5 remains the next blocked phase for broader lifecycle regression coverage.
It is not started here. This phase does not implement a new Editor adapter,
DiaryWorkspace component, Dialog, route, server API or lifecycle owner.

## STOP conditions checked

No STOP condition was triggered. In particular:

- no production or generic lifecycle fix was required;
- no router, route, server, shared contract or dependency change was required;
- no D1–D5 contract changed;
- no Calendar/VCalendar workaround changed;
- no duplicate Monaco/model or second save/raw/draft/history/recovery pipeline
  was introduced;
- no D6.5 work was started.

## Conclusion

```text
D6.0   = REVIEW-CLOSED
D6.1   = REVIEW-CLOSED
D6.2   = REVIEW-CLOSED
D6.2.1 = REVIEW-CLOSED
D6.3   = REVIEW-CLOSED
D6.4   = REVIEW-CLOSED
D6.5   = NOT STARTED
D6.6   = BLOCKED
D6.7   = BLOCKED

Task-scoped self-review: P0 = 0, P1 = 0, P2 = 0
Independent Review: PASS (P0 = 0, P1 = 0, P2 = 0)
```

Independent review is complete. Stop here; do not begin D6.5.
