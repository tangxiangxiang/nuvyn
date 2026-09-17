# D6.3 Reader Dialog Adapter Evidence — SUPERSEDED

> **Historical lineage — not current runtime authority.** Current behavior is
> defined by [Diary Architecture](../architecture/diary.md) and [Diary User
> Guide](../user-guide/diary.md). This file is retained for D6 traceability.

## Status

**SUPERSEDED BEFORE REVIEW CLOSURE**

Superseded by: **D6.3 — Native Vault Document Workspace**.

Product direction changed after the Reader Dialog implementation received an
independent review PASS, but before D6.3 was marked `REVIEW-CLOSED`. The review
result and implementation SHAs below remain accurate historical evidence for
the superseded implementation. They do not transfer to the replacement and do
not make the new D6.3 implementation review-closed or independently reviewed.

- D6.0 = REVIEW-CLOSED
- D6.1 = REVIEW-CLOSED
- D6.2 = REVIEW-CLOSED
- D6.2.1 = REVIEW-CLOSED
- D6.3 Reader Dialog implementation = SUPERSEDED BEFORE REVIEW CLOSURE
- D6.3 Native Vault Document Workspace replacement = REVIEW-READY
- D6.4 = NOT STARTED

Initial implementation commit: `d270ee5756c0f742e92955f06fa308fd6f77bc4a`
Reconciliation follow-up commit: `fa85f431d274e36fccbeaa0446ed63cf0d017a36`
Evidence commit: recorded by the commit containing this document.

Task-scoped self-review: P0 = 0, P1 = 0, P2 = 0.

This evidence covers only D6.3 — Reader Dialog Adapter. It does not implement
D6.4, Editor Dialog, a new Diary route, or a new document lifecycle.

## Baseline and scope

Starting HEAD:

`ce3e08c514f50304d9b73f066191a22d5739c179`

Final production validation baseline:

`fa85f431d274e36fccbeaa0446ed63cf0d017a36`

The implementation preserves the frozen D6.2.1 Calendar presentation:

- `YYYY-MM` month title;
- Prev / Next navigation;
- Today absent;
- full-bleed/full-height Calendar Home;
- existing focus-visible navigation ring and 44px targets.

The production change adds a Reader presentation adapter and the minimum
presentation/focus seams needed to mount it. `openDiaryDate()` remains the
single date command and was not replaced or duplicated.

## Ownership and command flow

The successful flow is:

```text
Calendar day click
  -> DiaryCalendar date-selected
  -> VaultView onDiaryDateSelected
  -> existing openDiaryDate()
  -> existing openPost()/tab/document lifecycle
  -> DiaryDateCommandResult opened|created
  -> activePath equals result.path
  -> requestReader(result.date, result.path)
  -> DiaryReaderDialog
```

`opened` and `created` both enter Reader only after the awaited existing date
command returns and the existing lifecycle reports the same path as `activePath`.
The Reader receives the existing backing tab's `raw`, logical path,
loading/error state, and the existing `wikiResolver`. It does not call `fetch`,
`getPost`, `openPost`, a Diary create endpoint, or router navigation.

The Reader does not own `tabs`, `activePath`, route state, save, dirty state,
drafts, History, Recovery, or document identity. The backing tab remains open
when the Reader closes.

## Reader presentation

`src/components/diary/DiaryReaderDialog.vue` provides:

- `role="dialog"`, `aria-modal`, `aria-labelledby`, and visible exact
  `YYYY-MM-DD` Diary date;
- Dialog Header Back, explicit Close, Escape, and Edit actions;
- localized English/Chinese accessible labels;
- loading and error presentation without mounting another reader;
- the existing `ReadingPane` and therefore the existing
  `RenderedMarkdown`, wiki-link resolver, source path, Markdown extensions,
  Shiki, and theme pipeline.

Only one `ReadingPane` is mounted while Reader presentation is primary. The
ordinary Vault read surface is unmounted through its existing `v-if` boundary
when Diary Reader is primary; the Reader adapter mounts the same
`ReadingPane` component in its place. There is no parallel Markdown renderer,
parser, link pipeline, or document fetch.

The current Vault-scoped TOC publisher therefore still has one owner. The
Reader presentation hides the ordinary RightRail chrome so it does not present
a second or competing TOC surface. TOC state and scroll-spy implementation are
not copied; a richer Reader-specific TOC presentation is outside D6.3.

## State and reconciliation

### Successful and unsuccessful date intents

- Existing managed Diary -> Reader.
- Missing today/past -> existing exact create, then Reader.
- Existing future Diary -> Reader.
- Missing future -> Home, no Reader, no create.
- Invalid, failed, or busy command -> Home, no stale Reader.
- Stale asynchronous intent -> no Reader transition.

The browser tests use a direct vault fixture only for an already-existing future
file. This does not weaken the public future-missing/create contract.

### Active document / Browser Back reconciliation

`activePath` is passed into the presentation owner as a read-only lifecycle
input. It is used only to close stale Reader presentation:

```text
Reader active
  + backingPath exists
  + activePath === backingPath
  -> keep Reader

Reader active
  + activePath !== backingPath
  -> passive reset -> Home
```

This covers both an ordinary document and another Diary document becoming
active while the old backing tab remains open. The old Reader closes, the
presentation returns to Home, and no new Reader is opened for the newly active
path. `documentPaths` remains the separate backing-tab-existence check; the two
watchers are not interchangeable.

The only Reader opening path remains an explicit Calendar date intent followed
by a successful `openDiaryDate()` result. `activePath` can never open Reader.
The successful-intent adoption also checks `activePath === result.path` before
requesting Reader; an unexpected mismatch resets presentation instead of
presenting stale content.

### Close and focus

Dialog Header Back, explicit Close, and Escape all use the same
presentation-only close path:

```text
closePresentation()
  -> Home
  -> keep backing tab / route / active document
  -> restore the Calendar date focus
```

No close action calls `router.back()`, `router.replace()`, `closeTab()`,
changes `activePath`, or triggers dirty confirmation. The Calendar exposes a
semantic `focusDate()` method, and `VaultView` falls back to the Vault root
focus if the original date target is no longer available.

Explicit Dialog close restores the Calendar date focus. Passive reconciliation
from an active-path mismatch does not call the Dialog close/focus-restoration
path and does not steal focus from the router/document lifecycle.

Reader initial focus enters the Dialog Header Back action. Hidden Calendar
controls do not receive Tab focus while Reader is primary. D6.3 does not claim
a WCAG-complete focus-trap architecture; that remains a separate scope.

### Edit and fallback

Edit is deliberately the existing D5 fallback bridge. It hides the Reader,
keeps the same backing tab/path and route, and reveals the existing Editor
surface. It does not create an Editor Dialog, a second Monaco model, a second
save pipeline, or a D6.4 lifecycle.

### Browser Back, scope, and special surfaces

Browser Back remains owned by Vue Router and the existing route/tab/document
reconciliation. D6.3 does not intercept `popstate`, create Dialog history, or
auto-open Reader from `activePath` or route watchers. When the existing
router/document lifecycle changes the active document away from the Reader
backing path, the presentation observes that result and passively resets.

History Comparison, Working Tree Diff, and Recovery retain precedence over
Diary presentation. Leaving Diary scope or activating one of those surfaces
resets Diary presentation to the safe Home state without closing the backing
tab. If the backing tab is closed externally while Reader is active, the
presentation resets and does not reopen from stale state.

Refresh and Reader deep-link restoration remain outside the D6 MVP because
Dialog state is not encoded in the URL.

The real Browser Back regression builds a genuine history stack using ordinary
document routes, then opens Diary through the existing `router.replace()` date
flow. Before Back the URL is `/vault/diary/<local-civil-date>` and the Diary
Reader is active; `page.goBack()` returns to
`/vault/inbox/d6-browser-back-source`, the existing route sync changes
`activePath` to that source document, the Reader disappears, and the Diary
backing tab remains open. No fake history entry or Reader-specific router hook
is involved.

## Calendar and compatibility boundary

`isDiaryCalendarMounted` remains exactly scope-owned:

```text
isDiaryCalendarMounted = isDiaryScope
```

When Reader is visible, Calendar is hidden but remains mounted. This preserves
the D5/D3.0 VCalendar keep-mounted workaround and avoids synchronous Calendar
unmount during a day click. No VCalendar candidate, dependency, router, server,
shared protocol, Calendar projection, or D6.2.1 visual rule changed.

The five-cycle Reader browser regression observed no `dayIndex` runtime error
and no `pageerror`.

## Browser and accessibility evidence

The focused Playwright command completed **15/15 PASS**:

- existing Diary -> Reader, exact route/tab identity, Markdown heading/link/code
  rendering, one ReadingPane, Calendar attached-but-hidden;
- Back, explicit Close, Escape, route preservation, backing-tab preservation,
  and Calendar date focus restoration;
- real Browser Back from a Diary Reader to an ordinary document route, with
  stale Reader closure, active ordinary tab selection, retained Diary backing
  tab, and no fake history behavior;
- today/past create -> Reader;
- existing future -> Reader;
- missing future -> Home/no create with only the expected exact GET 404s;
- Reader Edit -> existing D5 Editor fallback;
- five repeated Reader open/close cycles;
- existing D5 Calendar surface and keyboard-focus regression suites;
- Reader action target sizes at 1280x800, 768x1024, 375x812, and 320x700;
- light/dark theme toggle while Reader remains mounted;
- no horizontal overflow.

The Reader unit suite verifies English and Chinese action labels, dialog
semantics, existing ReadingPane props, loading/error behavior, close actions,
Escape, Edit, and initial focus. The Calendar unit test verifies semantic date
focus restoration.

The missing-future browser case intentionally records the server's exact
expected GET 404 console message. Other diagnostic-covered browser cases have
empty unexpected console-error lists. All focused cases have `pageErrors = []`.
No `dayIndex` page error was observed.

## Validation

- Focused Vitest: **8 files, 114 tests PASS**.
- `npm run typecheck:client`: PASS.
- `npm run typecheck`: PASS (client and server).
- `npm run build`: PASS.
- Focused Playwright Diary suites: **15/15 PASS**.
- `git diff --check`: PASS on the final D6.3 follow-up tree.

The GitHub status was not queried for this task.

## Changed files

Production/presentation:

- `src/components/diary/DiaryReaderDialog.vue`
- `src/components/diary/DiaryWorkspace.vue`
- `src/composables/diary/useDiaryWorkspacePresentation.ts`
- `src/views/VaultView.vue`
- `src/components/diary/DiaryCalendar.vue`
- `src/components/diary/DiaryCalendarSurface.vue`
- `src/composables/useI18n.ts`
- `src/style.css`

Tests/evidence:

- `src/components/diary/__tests__/DiaryReaderDialog.test.ts`
- `src/components/diary/__tests__/DiaryCalendar.test.ts`
- `src/composables/diary/__tests__/useDiaryWorkspacePresentation.test.ts`
- `src/views/__tests__/VaultView.test.ts`
- `e2e/diary-reader.spec.ts`
- `e2e/diary-calendar-surface.spec.ts`
- `e2e/diary-release.spec.ts`

No changes were made to `server/**`, `shared/**`, router definitions, package
files, lockfiles, dependencies, `useDiaryDateCommand.ts`, or the D6.4 Editor
surface.

This reconciliation follow-up changed only:

- `src/composables/diary/useDiaryWorkspacePresentation.ts`
- `src/views/VaultView.vue`
- `src/composables/diary/__tests__/useDiaryWorkspacePresentation.test.ts`
- `src/views/__tests__/VaultView.test.ts`
- `e2e/diary-reader.spec.ts`

## Rollback boundary

The D6.3 runtime rollback is newest to oldest:

```text
fa85f431d274e36fccbeaa0446ed63cf0d017a36
-> d270ee5756c0f742e92955f06fa308fd6f77bc4a
```

This restores the D6.2.1 production baseline at `ce3e08c...`. Documentation is
informational and is not part of the runtime rollback chain. No earlier D6.0–
D6.2.1 commits need to be reverted to remove this Reader adapter.

## Conclusion

D6.3 implementation, focused tests, browser evidence, and task-scoped
self-review are complete.

```text
D6.3 = REVIEW-READY
D6.4 = NOT STARTED
P0 = 0
P1 = 0
P2 = 0
```

Stop here for independent review. Do not begin D6.4 in this evidence commit.
