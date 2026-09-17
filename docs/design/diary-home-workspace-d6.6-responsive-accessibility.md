# D6.6 — Responsive / Accessibility Evidence

> **Historical lineage — not current runtime authority.** Current behavior is
> defined by [Diary Architecture](../architecture/diary.md) and [Diary User
> Guide](../user-guide/diary.md). This file is retained for D6 traceability.

状态：`REVIEW-CLOSED`
Independent Review：`PASS (P0 = 0 / P1 = 0 / P2 = 0)`
Task self-review：`P0 = 0 / P1 = 0 / P2 = 0`
D6.7：`NOT STARTED`，本阶段未开始 D6.7。

日期：2026-08-26（Asia/Shanghai）

## 1. Scope and baseline

D6.6 验证现有 Native Workspace superseding architecture 的 responsive、keyboard 和
DOM/accessibility contract。它不引入 Dialog、modal、`aria-modal`、focus trap、第二套
Reader/Editor、第二个 Monaco model 或新的生命周期。

Starting HEAD：`ced273aefd941f0f568e5c22b66e482762718f4c`
Test commit：`dbb765977d04f3afae35584e8a91c8abbf651196`
Keyboard accessibility fix commit：`feafa20d93b423901a52d851e846c9f10da4f794`

Runtime rollback is `feafa20d93b423901a52d851e846c9f10da4f794` back to
`ced273aefd941f0f568e5c22b66e482762718f4c`; the test-only commit is excluded from
that runtime rollback. Documentation rollback is informational-only.

The VCalendar candidate remains `v-calendar@3.1.2`; the Popper candidate remains
`@popperjs/core@2.11.8`. No dependency selection or package version changed.

## 2. Current implementation facts

The D6.6 browser evidence uses the existing Calendar Home, Native Vault READ/EDIT,
generic FileTree exact context, existing view-mode shortcuts, and existing tab/document
lifecycle. The Calendar remains mounted in Diary scope and is hidden when Native Vault
Document is presented. The evidence does not claim WCAG conformance or screen-reader
certification; it records observable DOM semantics, keyboard behavior, focus indicators,
layout metrics and runtime diagnostics.

Two minimal implementation corrections were required by the browser evidence:

1. VCalendar's `.vc-day-content` styling removes the browser outline from the custom
   day button. `DiaryCalendar.vue` now restores a `2px` accent `:focus-visible` outline
   on the actual `[data-diary-day-content]` keyboard target, with `2px` offset.
2. FileTree's delegated tree keydown handler previously consumed bubbled keyboard events
   from its exact-path context button. `FileTree.vue` now lets native interactive
   descendants (`button`, form controls and contenteditable elements) retain their own
   keyboard activation. A unit regression covers the exact context action.

Neither correction changes Diary identity, Calendar date events, public props/emits,
router ownership, tab ownership, document save/dirty behavior or the VCalendar contract.

## 3. Browser matrix

The dedicated suite is `e2e/diary-responsive-accessibility.spec.ts`.

### Calendar Home

The Calendar Home layout and semantic test passed at:

| Viewport | Result |
| --- | --- |
| 1280×800 | PASS |
| 768×1024 | PASS |
| 375×812 | PASS |
| 320×700 | PASS |
| 601×812 breakpoint | PASS |
| 600×812 breakpoint | PASS |
| 421×812 breakpoint | PASS |
| 420×812 breakpoint | PASS |

The checks cover full-bleed/full-height sizing, no horizontal overflow, no clipped
month title or week row, usable seven-column grid, 44×44 month controls, `YYYY-MM`
title, absence of the old surface header/toolbar/Today action, and no nested button
inside a day cell.

### Native READ and EDIT

Native Diary READ and EDIT were exercised at 1280×800, 768×1024, 375×812 and 320×700.
The mobile cases covered the side panel open and closed states; at mobile widths the
right rail is visually hidden without a new Diary-specific surface. The resize sequence
`1280×800 → 375×812 → 320×700 → 768×1024 → 1280×800` preserved the exact route,
selected tab, exact FileTree context and document metadata identity.

## 4. Semantic and keyboard evidence

The browser suite verified:

- Calendar Home and Calendar expose named `region` landmarks;
- Prev/Next expose localized accessible names and activate with keyboard Enter/Space;
- each rendered day has one actual button, with the Diary marker and localized
  `Diary exists`/`有日记` information in its accessible name;
- the custom day button activates the existing date command by keyboard;
- keyboard focus on month controls, day buttons and the exact Calendar return action
  has a visible non-transparent `2px` outline with the expected offset;
- the Calendar remains attached while Native READ/EDIT is visible, but has no rendered
  focusable surface and does not retain active focus;
- returning to Calendar restores focus to the selected semantic day without changing
  route or backing tab;
- Native READ ⇄ EDIT uses existing Cmd/Ctrl+E, and existing Cmd/Ctrl+S saves through
  the current document owner; Home suppresses W/S/E/Tab where the workspace owns no
  document target, while B retains the existing sidebar behavior;
- Native DOCUMENT Cmd/Ctrl+W was directly verified: the active Diary tab closes through
  the existing workspace policy, an ordinary Note fallback becomes selected, the route
  changes to that Note and the fallback workspace tab receives focus;
- dirty Native EDIT Cmd/Ctrl+W was directly verified to show the existing confirmation;
  cancel leaves the Diary tab present and dirty;
- the exact FileTree action is a real keyboard-activatable control, and exact-path
  context does not overwrite the user's `filesFilter`;
- English and Chinese labels were exercised. The English case also toggled Calendar
  and Native READ through the existing light → dark theme control; the existing
  D6.2.1 release suite continues to cover light/dark Calendar focus behavior.

The D6.5 regression suite remains evidence for button-driven tab-close lifecycle and
fallback logic. D6.6 adds the direct browser evidence for keyboard close focus and
dirty-close cancellation; both continue to use the existing Vault owner.

## 5. Lifecycle and repetition evidence

The dedicated suite passed 8/8 tests, including ten mixed mouse/keyboard
Calendar → Native READ → Calendar cycles at 375×812 and 320×700. The combined Diary
browser command passed 38/38 tests: the 8 D6.6 tests plus the existing 30 Diary
Calendar, Native Workspace, lifecycle, compatibility and release regressions.

The combined run retained coverage for Calendar click, native Reader/Editor reuse,
same-tab behavior, dirty/raw continuity, FileTree context, Browser Back ownership,
History/Recovery/Conflict lifecycle and the existing VCalendar regression boundary.
No `pageerror`, console error or `dayIndex` runtime failure was observed by the
diagnostics/assertions in these runs.

## 6. Unit, type and build evidence

Focused Vitest command:

```text
npm exec vitest run \
  src/components/diary/__tests__/DiaryCalendar.test.ts \
  src/components/diary/__tests__/DiaryCalendarSurface.test.ts \
  src/components/diary/__tests__/DiaryWorkspace.test.ts \
  src/composables/diary/__tests__/useDiaryWorkspacePresentation.test.ts \
  src/views/__tests__/VaultView.test.ts \
  src/components/vault/__tests__/FileTree.test.ts
```

Result：6 files passed，104 tests passed。

Additional validation results：

- D6.6 dedicated Chromium suite：8/8 PASS；
- combined Diary Chromium regressions：38/38 PASS；
- `npm run typecheck:client`：PASS；
- `npm run typecheck`：PASS；
- `npm run build`：PASS；
- `git diff --check`：PASS。

The build emitted existing bundle-size and Rolldown annotation warnings but exited
successfully. They are not D6.6 runtime failures.

## 7. Change and ownership boundary

Changed implementation/test files:

- `e2e/diary-responsive-accessibility.spec.ts`;
- `src/components/diary/DiaryCalendar.vue`;
- `src/components/vault/FileTree.vue`;
- `src/components/vault/__tests__/FileTree.test.ts`.

Changed design files are limited to this evidence and phase-status mirrors in
`diary-home-workspace-implementation-plan.md` and `diary-home-workspace-prd.md`.

Not changed：

- `server/**`、`shared/**`、router、`useRouteSync()`、`useTabWorkspace()`、
  `useEditorTabs()`、save/dirty/draft/History/Recovery owners;
- Diary create/date API、Calendar projection ownership or VCalendar/Popper versions;
- D6.7 or any release-closure implementation;
- package.json、package-lock.json、dependencies。

Public Diary Calendar props (`days`, `loading`, `error`, `initialMonth`) and public
events (`date-selected`, `month-change`) are unchanged. No Diary Dialog, modal,
`aria-modal`, focus trap, duplicate ReadingPane or duplicate Monaco model was added.

## 8. D6.6 exit review

| Criterion | Result |
| --- | --- |
| Calendar 1280/768/375/320 matrix | PASS |
| 601/600 and 421/420 breakpoint smoke | PASS |
| Native READ/EDIT responsive smoke | PASS |
| Mobile side-panel open/closed layout | PASS |
| Resize continuity and no overflow | PASS |
| Calendar semantic roles/names | PASS |
| Day/Prev/Next keyboard activation | PASS |
| Focus-visible indicators | PASS |
| Hidden Calendar focus isolation | PASS |
| Native E/S/W/Tab/B shortcut boundary | PASS |
| Native DOCUMENT Cmd/Ctrl+W fallback focus | PASS |
| Dirty Cmd/Ctrl+W confirmation and cancel | PASS |
| English/Chinese labels | PASS |
| Light/dark theme evidence | PASS |
| Repeated lifecycle cycles | PASS |
| VCalendar/pageerror/dayIndex regression | PASS |
| Focused tests/typecheck/build | PASS |
| No D6.7 implementation | PASS |

No D6.6 STOP condition was triggered. The implementation/evidence commit stopped at
`REVIEW-READY`; after Independent Review PASS, this closure sync marks D6.6
`REVIEW-CLOSED`.

## 9. Phase status

```text
D6.0   = REVIEW-CLOSED
D6.1   = REVIEW-CLOSED
D6.2   = REVIEW-CLOSED
D6.2.1 = REVIEW-CLOSED
D6.3   = REVIEW-CLOSED
D6.4   = REVIEW-CLOSED
D6.5   = REVIEW-CLOSED
D6.6   = REVIEW-CLOSED
D6.7   = NOT STARTED
```

Independent Review = `PASS`; P0/P1/P2 = `0/0/0`.
GitHub status was not queried for this task.
