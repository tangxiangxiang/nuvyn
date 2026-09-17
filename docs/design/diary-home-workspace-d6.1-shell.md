# D6.1 Diary Workspace Shell Evidence

> **Historical lineage — not current runtime authority.** Current behavior is
> defined by [Diary Architecture](../architecture/diary.md) and [Diary User
> Guide](../user-guide/diary.md). This file is retained for D6 traceability.

## 1. Status

```text
D6.0 = REVIEW-CLOSED
D6.1 = REVIEW-CLOSED
D6.2 = NOT STARTED
D6.3 = NOT STARTED

Independent review = PASS
P0 = 0
P1 = 0
P2 = 0
```

This document records the D6.1 implementation evidence and closure. D6.2 and
D6.3 remain unopened.

## 2. Starting HEAD and implementation commit

```text
Starting HEAD:
1561596264b7aea5b35f0be173a2c8a06e3eaf75

Implementation commit:
95f48d314c0721a73256fd2f0b390b75a25f13bb
feat(diary): add D6 workspace shell

Independent review follow-up commit:
72468e824c02167d86afb0226719ab361be9f958
fix(diary): guard stale intents and hidden shortcuts

Browser shortcut boundary follow-up commit:
d753bb0fddb3833ba377412faadb93f58ef491b6
fix(diary): preserve browser shortcut boundaries
```

The implementation was created from a clean `main` worktree. No intervening
commit changed the D6 ownership contracts before implementation.

## 3. Scope

D6.1 establishes the Diary presentation owner and shell at the existing
`VaultView` Diary-scope seam. It does not implement a Reader Dialog, an Editor
Dialog, a new route, a second tab store, or a second document lifecycle.

The shell owns only presentation state:

- `presentationMode`: `home | reader | editor`;
- selected `DiaryDate` presentation context;
- backing logical path as a reference only;
- focus origin/return context;
- presentation eligibility and visibility.

It does not own document identity, tab state, `activePath`, route state, raw
Markdown, Monaco models, save/dirty state, draft, History, Recovery,
fileChanges, server mutations, or document close behavior.

## 4. Files changed

Implementation commit files:

- `src/components/diary/DiaryWorkspace.vue`
- `src/composables/diary/useDiaryWorkspacePresentation.ts`
- `src/views/VaultView.vue`
- `src/style.css`
- `src/components/diary/__tests__/DiaryWorkspace.test.ts`
- `src/composables/diary/__tests__/useDiaryWorkspacePresentation.test.ts`
- `src/views/__tests__/VaultView.test.ts`

This evidence document is a separate docs-only follow-up to the implementation
commit. No `server/**`, `shared/diaryProtocol.ts`, router record, package file,
lockfile, or dependency changed.

## 5. Presentation ownership

`useDiaryWorkspacePresentation()` is the single D6.1 presentation owner.
`DiaryWorkspace.vue` is its visual shell and named-slot boundary.

The shell exposes Home, future Reader, and future Editor slots. D6.1 wires only
the existing `DiaryCalendarSurface` into Home. The Reader and Editor slots are
empty extension points; no Reader or Editor implementation was added.

Presentation-only actions have no document lifecycle callback. The
`closePresentation()` primitive changes mode to `home` and keeps the backing
reference for future focus restoration. It does not navigate, close a tab, or
run dirty confirmation.

## 6. Presentation state model

```text
HOME
READER       future D6.3 slot; not wired in D6.1
EDITOR       future D6.4 slot; not wired in D6.1
```

Successful date commands in D6.1 record `selectedDiaryDate`, `backingPath`, and
`focusOrigin = calendar`, but intentionally remain in `HOME`. D6.3 will consume
the existing successful `DiaryDateCommandResult` to request Reader presentation.
No `activePath` watcher can enter Reader or Editor mode.

Failed, future, invalid, busy, and error results reset presentation context and
cannot leave a future Dialog state behind.

## 7. Diary presentation eligibility

The owner computes:

```text
diaryPresentationEligible
= activeScope === 'diary'
  && no active History Comparison
  && no active Working Tree Diff
  && no active Recovery surface
```

The ordinary Vault surface is unchanged when the scope is not Diary. The
presentation owner has no route or tab ownership input that could turn an
ordinary document selection into a Diary Dialog intent.

## 8. Non-document workspace precedence

History Comparison, Working Tree Diff, and Recovery retain primary-surface
precedence. When any one is active:

- Diary presentation is ineligible and hidden;
- Calendar remains mounted while Diary scope remains active;
- the existing special-surface owner remains responsible for its workflow;
- Diary presentation does not close, select, restore, or mutate that surface.

When the special surface clears, eligibility is re-evaluated from the current
state. The safe D6.1 default is `HOME`; a prior future Reader/Editor state is
not automatically reopened.

## 9. Calendar lifecycle and visibility

The mount predicate remains scope-only:

```text
isDiaryCalendarMounted = activeScope === 'diary'
```

`DiaryWorkspace` is mounted with that `v-if`. Its Home slot, which contains
`DiaryCalendarSurface` and the existing `DiaryCalendar`, is hidden with
`v-show`/equivalent shell visibility. A date click therefore does not
synchronously unmount the VCalendar subtree.

The normal D6 presentation target is:

```text
Diary scope
  + eligible
  + presentationMode === HOME
    -> Calendar Home visible
```

D6.1 retains one explicit, local D5 fallback while Reader is not implemented:
after a successful date command, the existing Editor surface remains primary
while its backing document path is still present in the existing document tab
list. This is not a fourth presentation mode and is not a second lifecycle.
When that backing tab disappears, Home becomes visible again. An unrelated
ordinary tab by itself does not block Diary Home.

## 10. Ordinary EditorTabs decision

When Diary Home is primary and backing ordinary document tabs exist,
`EditorTabs` remains mounted but is hidden with `v-show`; tabs, active document,
route, and `activePath` are preserved. CSS collapses the hidden tab row for the
Diary Home presentation without treating the document workspace as empty.

During the explicit D5 date-intent fallback, the existing tab strip and editor
are visible exactly as before so D3/D4 date-open behavior remains safe until
D6.3 owns the Reader transition.

No `closeTab()`, tab clearing, route replacement, or dirty confirmation is
performed by Diary presentation.

## 11. Date-intent handoff

The current command flow remains:

```text
DiaryCalendar
  -> DiaryCalendarSurface date-selected
  -> VaultView onDiaryDateSelected()
  -> existing openDiaryDate()
  -> get/create exact Diary path
  -> existing openPost()
  -> existing tab/document lifecycle
  -> DiaryDateCommandResult
```

`onDiaryDateSelected()` records the result only after `openDiaryDate()`
resolves and its local intent token is still current. The public command API
and its ownership are unchanged. There is no `openDiaryReaderDate()`,
`openDiaryEditorDate()`, direct Calendar API call, or activePath-driven open
path.

## 12. Scope reconciliation

```text
enter Diary scope
  -> presentation owner starts at HOME when eligible

leave Diary scope
  -> presentation resets to HOME baseline
  -> selected context is cleared
  -> no tab close, route change, or dirty confirmation

Diary scope + special surface
  -> Diary presentation yields
  -> Calendar hidden but mounted

special surface clears
  -> eligibility re-evaluates
  -> safe result is HOME, not automatic Dialog reopen
```

Note, archive, and ledger scopes do not satisfy the Diary eligibility
predicate, so they continue through the existing Vault surface conditions.

## 13. Active-path and router invariants

The presentation composable does not consume `activePath`, `useRouteSync()`, or
the router. Browser Back therefore remains:

```text
Vue Router history
  -> route/pathMatch
  -> existing useRouteSync()
  -> existing openPost()/tab reconciliation
```

There is no `popstate` interception, fake Dialog history, Diary route, router
navigation from the shell, or `activePath -> Dialog` watcher.

## 14. Focus seam

D6.1 records both a typed focus origin (`calendar`, `reader`, or `editor`) and
a semantic return target. A successful date intent records:

```text
focusReturnTarget = {
  kind: 'calendar-date',
  date: selectedDiaryDate,
}
```

The target is a `DiaryDate`, not an `HTMLElement`. A future Dialog close can
ask the Calendar adapter to resolve the current day button for that date after
month navigation or a Calendar rerender. The presentation owner preserves the
semantic target through a presentation-only close, clears it on scope/special
surface reset, and never stores a persistent DOM reference. Failed or stale
date intents cannot overwrite it.

D6.1 does not implement a modal focus trap or complete Dialog accessibility
policy; that is a later D6 Dialog phase. Hidden Home/tab surfaces use
`display: none` through `v-show`, so their controls are not keyboard reachable
while hidden.

## 15. Independent review follow-up

The D6.1 independent review identified two P1 boundaries and one P2 seam. The
follow-up remains inside the D6.1 presentation integration and does not change
the Diary date command, document lifecycle, Router, or special-surface owners.

A subsequent independent re-review identified two P2 evidence boundaries:
browser shortcut ownership when no workspace target exists, and an incomplete
rollback chain. This follow-up closes both without changing the presentation
epoch, date-command API, or any lifecycle owner.

### Async date-intent concurrency policy

`useDiaryWorkspacePresentation()` owns a monotonic date-intent epoch. Every new
Calendar date intent receives a new token. Leaving Diary scope, activating
History Comparison, Working Tree Diff, or Recovery, and presentation reset
invalidate pending tokens. `VaultView` adopts a resolved
`DiaryDateCommandResult` only when its token is still current and Diary
presentation is still eligible.

This enforces latest-valid-intent-wins:

- a success after scope exit is ignored;
- a success after special-surface takeover is ignored;
- an older intent cannot overwrite a newer intent;
- an older failure cannot reset a newer successful intent.

Presentation invalidation does not roll back an already completed document
lifecycle. A stale command may still have completed `openPost()`, reused or
created a backing tab, and changed the existing route. D6.1 only suppresses
stale presentation adoption; it does not call `closeTab()`, `router.back()`,
route restore, or Diary deletion.

### Hidden workspace keyboard policy

When Diary Home is primary, hidden document tabs remain lifecycle-active but
are not the keyboard-active workspace UI. The Vault-level handler only claims
Cmd/Ctrl+W when `activeWorkspaceTabId` exists and only claims Cmd/Ctrl+Tab when
`workspaceTabs.length > 0`. When Diary Home has no corresponding workspace
target, the handler returns without `preventDefault()` and without falling
through to the hidden document shortcut pipeline. With a target, W/Tab are
prevented but do not close or cycle hidden tabs. Cmd/Ctrl+S and Cmd/Ctrl+E
remain suppressed in Diary Home so they cannot reach the hidden
document/editor lifecycle.

The handler therefore does not close a hidden tab, cycle hidden tabs, trigger
dirty confirmation, or toggle the hidden editor view. This preserves the
existing Vault ownership prerequisites instead of making Diary Home an
unconditional browser-shortcut owner.

Cmd/Ctrl+B remains available as the existing global Files-panel shortcut.
When D5 fallback or an ordinary note/Vault presentation is primary, the
existing document shortcut branches remain unchanged. History, Diff, and
Recovery retain their existing read-only shortcut precedence because the Diary
Home gate applies only when `isDiaryPresentationPrimary` is true.

### Follow-up tests

The follow-up adds controlled presentation tests for scope invalidation,
special-surface invalidation, out-of-order two-date intents, and an old failure
returning after a newer success. The browser shortcut follow-up adds
behavior-oriented checks for W/Tab with and without a workspace target, and
retains S/E suppression plus B forwarding. VaultView characterization tests
cover the hidden shortcut gate and the current-token adoption seam. Browser
regression coverage continues to monitor the kept-mounted Calendar and
VCalendar `dayIndex` runtime boundary.

## 16. VCalendar and browser evidence

The existing Calendar adapter, projection, local-civil-date behavior, and
VCalendar version were not changed. The real browser regression completed:

```text
npm exec playwright test \
  e2e/diary-calendar-surface.spec.ts \
  e2e/diary-release.spec.ts

9 passed
pageerror = 0
unexpected console error = 0
expected console diagnostic = one exact future-document GET 404
```

Covered behavior includes Diary Home/month navigation, existing Diary date
open, future missing no-op, managed tab close, keyboard focus, marker update,
and five repeated opens, plus Diary Home hidden-tab shortcut isolation with
and without a workspace target. The responsive matrix passed at:

```text
1280 x 800
768 x 1024
375 x 812
320 x 700
```

The matrix reported no horizontal overflow and retained usable Calendar
controls/touch targets. The existing VCalendar keep-mounted behavior remained
attached through date-open fallback.

## 17. Test evidence

New D6.1 focused tests:

```text
npm exec vitest run \
  src/composables/diary/__tests__/useDiaryWorkspacePresentation.test.ts \
  src/components/diary/__tests__/DiaryWorkspace.test.ts \
  src/views/__tests__/VaultView.test.ts

3 test files passed
53 tests passed
```

Diary/Vault regression set:

```text
npm exec vitest run \
  src/components/diary \
  src/composables/diary \
  src/views/__tests__/VaultView.test.ts

8 test files passed
100 tests passed
```

These tests cover initial HOME, scope exit, History/Diff/Recovery precedence,
successful and failed date results, stale scope/special-surface results,
out-of-order date intents, stale failures, semantic focus targets,
backing-tab fallback, presentation-only close, shell slot visibility, Calendar
wiring, projection, adapter, and the existing Diary command contract.

## 18. Typecheck and build

```text
npm run typecheck       PASS
npm run build           PASS
git diff --check        PASS
```

The build emitted the repository's existing Rolldown warning about a VueUse
`#__PURE__` annotation and existing large-chunk warnings. These did not fail
the build and did not originate from the D6.1 shell.

## 19. Known limitations and D6.2/D6.3 handoff

D6.1 intentionally does not include:

- Reader Dialog rendering or Markdown/TOC adapter wiring;
- Editor Dialog rendering, Monaco mounting, save, or dirty wiring;
- Dialog Header Back/Escape runtime controls;
- D6.2 Calendar visual-weight/chrome migration;
- full Dialog focus trap/a11y policy;
- Browser Back reconciliation beyond existing router ownership;
- Recent Diaries, Mood, or Emoji features.

D6.3 owns the successful-command-result -> Reader transition. D6.4 owns the
Editor adapter and Monaco duplication gate. The temporary D5 fallback is the
rollback-safe bridge until those phases are independently implemented.

## 20. Rollback seam

### Production rollback

The D6.1 runtime changes must be reverted in reverse chronological/dependency
order. The current production rollback chain is:

```text
1. d753bb0fddb3833ba377412faadb93f58ef491b6
   fix(diary): preserve browser shortcut boundaries
2. 72468e824c02167d86afb0226719ab361be9f958
   fix(diary): guard stale intents and hidden shortcuts
3. 95f48d314c0721a73256fd2f0b390b75a25f13bb
   feat(diary): add D6 workspace shell
```

Reverting this production chain restores the D5
`workspaceTabs.length === 0` Calendar visibility predicate. It does not
require Diary file migration, tab migration, route migration, document
identity changes, server rollback, History/Recovery changes, database cleanup,
or any other data migration.

### Documentation rollback

The runtime rollback is separate from documentation history. If exact
pre-D6.1 branch history is ever required, documentation commits such as
`360802f860d9d0c6e421ceb5d3fbc105d0b015d6` and
`9ee88431f117c4c06734e428a3e33902504b1a99`, plus any later D6.1 evidence
commit, are reverted separately. Runtime rollback does not imply documentation
rollback.

## 21. STOP conditions checked

No STOP condition was triggered:

- no new Diary route;
- no second tab store or document lifecycle;
- no server/shared Diary contract change;
- no `openDiaryDate()` API change;
- no Router or `useRouteSync()` change;
- no Calendar adapter/projection/VCalendar change;
- no duplicate Reader/Markdown renderer;
- no duplicate Editor/Monaco lifecycle;
- no History/Diff/Recovery implementation change;
- no D7 Mood/Emoji integration;
- no production mutation or save pipeline in the presentation owner.

## 22. Conclusion

```text
D6.0 = REVIEW-CLOSED
D6.1 = REVIEW-CLOSED
D6.2 = NOT STARTED
D6.3 = NOT STARTED

P0 = 0
P1 = 0
P2 = 0
```

The D6.1 Diary presentation owner and shell passed independent review and are
closed. No D6.2, D6.3, Reader Dialog, Editor Dialog, or D7 work has started.
