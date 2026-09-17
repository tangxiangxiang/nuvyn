# D6.5 — Lifecycle Regression Evidence

> **Historical lineage — not current runtime authority.** Current behavior is
> defined by [Diary Architecture](../architecture/diary.md) and [Diary User
> Guide](../user-guide/diary.md). This file is retained for D6 traceability.

状态：`REVIEW-CLOSED`

Independent Review：`PASS`

Task-scoped self-review：`P0 = 0`，`P1 = 0`，`P2 = 0`

日期：2026-08-26（Asia/Shanghai）

## 1. Scope

D6.5 verifies the lifecycle boundaries around the already-closed native Diary
Document Workspace. It covers scope exit/re-entry, manual tab selection,
backing-tab close and reopen, refresh persistence, direct Diary deep links and
real browser history navigation.

This phase adds regression tests and evidence only. It does not change the
Diary presentation owner, Router, `useRouteSync()`, `useTabWorkspace()`,
`openDiaryDate()`, native Reader/Editor ownership, History, Recovery, Draft,
server/shared contracts or dependencies. D6.6 is not started.

## 2. Reproducible baseline

Starting HEAD before the D6.5 test work:

```text
6d0aa02b1632c7572bd877a8cc43f65794f54bb8
```

The focused test commits are:

```text
06ffb2e test(diary): verify D6.5 lifecycle regressions
a34d622 test(diary): cover non-active tab lifecycle
```

The test commits contain only:

```text
e2e/diary-lifecycle-regression.spec.ts
src/composables/diary/__tests__/useDiaryWorkspacePresentation.test.ts
```

The second test commit adds only the non-active-tab case to the same E2E
suite.

No production code was changed.

## 3. Existing lifecycle invariants under test

- Diary scope mounts the Calendar for the scope lifetime; native document
  presentation hides it without using a document tab as an opening signal.
- Only a successful explicit Calendar date intent can enter Diary
  `DOCUMENT` presentation.
- Selecting an existing tab, following a route, restoring persisted tabs or
  returning to a previously active `activePath` cannot synthesize a Calendar
  intent or retarget the exact Diary context.
- Scope exit, active-path mismatch and backing-tab removal passively return
  Diary presentation to `HOME`; they do not close or clone the existing
  document lifecycle.
- A Calendar reopen reuses the existing tab/document identity and native
  reading surface.
- Browser Back and Forward remain Router/history operations. Diary observes
  the resulting route/document state and reconciles presentation; it does not
  intercept history or create a presentation history entry.

## 4. Dedicated browser evidence

Command:

```text
npm run test:e2e -- e2e/diary-lifecycle-regression.spec.ts
```

Result: **7/7 Chromium tests passed**.

| Scenario | Verified result |
| --- | --- |
| Scope exit and re-entry | A successfully opened Diary remains in the existing tab/route when leaving Diary scope. Re-entry returns to Calendar `HOME`; three additional scope cycles do not auto-reopen the document, and an explicit date click reopens it. |
| Manual multi-tab selection | Two Diary tabs and one ordinary note can be selected manually. Manual selection changes the native route/tab only; it does not synthesize Calendar intent or retarget Diary exact context. The user FileTree filter remains intact. |
| Tab close, fallback and reopen | Closing the Diary tab uses the existing fallback to the ordinary note. Reopening through Calendar creates one tab with the same server metadata identity. Closing the remaining tabs returns to `/vault` and Diary re-entry is `HOME`. |
| Non-active tab close | Closing an ordinary non-active tab while a Diary document is active preserves native Diary `DOCUMENT`, route, active tab and exact FileTree context. |
| Clean refresh | Three unique tabs are restored by the existing persistence path after refresh, while Diary presentation stays `HOME`. An explicit Calendar click then re-enters native READ without adding a duplicate tab. |
| Direct Diary deep link | `/vault/diary/YYYY-MM-DD` is handled by the existing route/tab lifecycle and keeps Diary presentation at `HOME` until an explicit Calendar date click. |
| Browser Back/Forward | Real `page.goBack()` and `page.goForward()` reconcile the existing routes and active tabs. Diary presentation remains `HOME`; `history.length` is unchanged, proving no fake presentation history entry was added. |

Each dedicated browser test collected `pageerror` and console error events;
the suite completed with empty error collections.

## 5. Presentation unit evidence

Command:

```text
npm exec vitest run \
  src/composables/diary/__tests__/useDiaryWorkspacePresentation.test.ts \
  src/components/diary/__tests__/DiaryWorkspace.test.ts \
  src/components/diary/__tests__/DiaryCalendarSurface.test.ts \
  src/views/__tests__/VaultView.test.ts \
  src/composables/vault/editor-tabs/__tests__/useTabWorkspace.test.ts \
  src/composables/vault/__tests__/useEditorTabs.test.ts \
  src/components/vault/__tests__/workspaceClose.test.ts
```

Result: **7 test files passed; 163/163 tests passed**.

The D6.5 additions specifically verify that:

- scope exit resets presentation without changing the backing document list or
  active path;
- moving `activePath` away and later returning to it does not reopen Diary
  presentation;
- removing a backing tab and later restoring the same path does not reopen
  presentation without a new explicit Calendar intent.

## 6. Existing Diary and release browser regressions

Command:

```text
npm run test:e2e -- \
  e2e/diary-calendar-surface.spec.ts \
  e2e/diary-reader.spec.ts \
  e2e/diary-editor-lifecycle.spec.ts \
  e2e/diary-release.spec.ts
```

Result: **23/23 Chromium tests passed**.

This includes the existing native READ/EDIT, History Comparison, History
Restore, baseline/divergent Recovery, external conflict, Calendar
keep-mounted, Browser Back, responsive, keyboard and VCalendar `dayIndex`
regressions. These are recorded as regression validation for D6.5; they are
not reclassified as newly implemented D6.5 behavior.

## 7. Static validation

The following commands passed after the test changes:

```text
npm run typecheck:client   PASS
npm run typecheck          PASS
npm run build              PASS
git diff --check           PASS
```

The production build emitted existing non-fatal bundler warnings about a
third-party `/* #__PURE__ */` annotation and large chunks; the build exited
successfully.

The first sandboxed browser attempt could not bind the local preview server
(`EPERM` on `127.0.0.1:4174`). The same commands were rerun with the required
local-server permission and passed. This was an environment limitation, not a
feature failure.

## 8. Change boundary

```text
Production code        NO
Server/shared code     NO
Tests                  YES — D6.5 regression coverage only
E2E                    YES — D6.5 regression coverage only
Dependencies           NO
package.json           NO
package-lock.json      NO
Router                 NO
Calendar projection    NO
D6.6 implementation    NO
```

## 9. D6.5 exit checklist

- [x] Diary scope exit/re-entry does not close or auto-reopen the backing tab.
- [x] Manual tab selection cannot synthesize Calendar intent or retarget exact
      Diary context.
- [x] Non-active tab close preserves active Diary `DOCUMENT` and exact context.
- [x] Backing-tab close follows existing fallback and a later explicit reopen
      preserves document identity.
- [x] Clean refresh restores unique tabs without restoring Diary `DOCUMENT`
      presentation.
- [x] Direct Diary deep link does not implicitly open Diary presentation.
- [x] Real Browser Back/Forward remains Router-owned and reconciles to `HOME`.
- [x] Stale active-path and removed-tab unit regressions are covered.
- [x] Existing Diary/VCalendar/D4 lifecycle regressions pass.
- [x] Client/full typecheck, build and diff checks pass.
- [x] No production, server, shared, route, dependency or D6.6 change.
- [x] Task-scoped self-review is `P0/P1/P2 = 0/0/0`.

## 10. Status and conclusion

```text
D6.0 = REVIEW-CLOSED
D6.1 = REVIEW-CLOSED
D6.2 = REVIEW-CLOSED
D6.2.1 = REVIEW-CLOSED
D6.3 = REVIEW-CLOSED
D6.4 = REVIEW-CLOSED
D6.5 = REVIEW-CLOSED
D6.6 = NOT STARTED
D6.7 = BLOCKED
```

D6.5 has reproducible lifecycle regression evidence and has passed independent
review with `P0/P1/P2 = 0/0/0`. This evidence does not start D6.6.

GitHub status: `GitHub status not queried`.
