# D6.2.1 Full-Bleed Calendar Polish Evidence

> **Historical lineage — not current runtime authority.** Current behavior is
> defined by [Diary Architecture](../architecture/diary.md) and [Diary User
> Guide](../user-guide/diary.md). This file is retained for D6 traceability.

## Status

D6.2 = REVIEW-CLOSED
D6.2.1 = REVIEW-CLOSED
D6.3 = NOT STARTED

Independent Review = PASS
P0 = 0
P1 = 0
P2 = 0
This is a post-closure presentation follow-up; it does not reopen D6.2 or start D6.3.

Self-review for this follow-up: P0 = 0, P1 = 0, P2 = 0.

Validation baseline (final production HEAD): 93c3db04b67dc37ec8e08fedf3dc86345ee389e6
Production commits:
- b24a02bf1bf2d33f16a38388d65f4746e90703fc — full-bleed Calendar Home layout
- 85b7a4d6d477dace90bc4738488543db16044fb9 — centered month header follow-up
- f7721a4ba2c8622e2e6b5a7b908e8593efc80d5d — remove Calendar Home Today button
- 8ae81fd21854bc2caf0ba950c8e9c30dddc3fcef — refine Calendar navigation controls
- 93c3db04b67dc37ec8e08fedf3dc86345ee389e6 — restore keyboard navigation focus ring

Documentation history:
- 8adb683ecfea97fb4759148aa3d19bef130d5f2f — initial D6.2.1 full-bleed evidence
- 5dee0d8a18d9345437ae73a055667643ac588d35 — calendar header follow-up evidence
- e91a3bd6278b2c4ab61f132ea239db268108f2b0 — Today affordance removal evidence
- a085bf94a2e4ae012f4d6848c9a2d56dc0d711cf — align D6.2.1 final evidence
- 6cf32ffc6dd632f4503fb2678e97b4d0451ed8aa — refresh D6.2.1 final evidence
- this docs-only follow-up — final-head browser validation and rollback/history corrections

## Scope

The Calendar Home was simplified into a full-bleed workspace surface. The visible Diary page heading, standalone Today toolbar, and Today button were removed. The surface-inner centered/max-width wrapper and outer Calendar card treatment were removed.

No Diary command, routing, tab, document, scope, save, dirty, server, shared, VCalendar dependency, or lifecycle ownership changed.

## Structure and semantics

- diary-calendar-surface-header and the visual Diary heading: removed.
- diary-calendar-toolbar: removed.
- Today button: removed from the Calendar Home header per the post-closure visual follow-up.
- The Calendar header now contains only VCalendar's month title and Prev/Next controls.
- Prev/Next and month-change: still owned by VCalendar.
- Surface role=region and aria-label: preserved.
- loading role=status, error role=alert, and empty role=status/aria-live: preserved.
- Calendar mount predicate: unchanged and remains isDiaryScope.

The current VCalendar 3.1.2 DOM was inspected: its root arrow header is .vc-pane-header-wrapper, its month title is .vc-pane .vc-header, and its grid is .vc-weeks/.vc-week. The implementation uses those rendered classes only for presentation sizing and stacking; it does not patch node_modules or reimplement month state.

## Full-size layout

The height chain is now flex-based:

Vault editor area
-> diary-calendar-content
-> DiaryWorkspace / Diary Home
-> diary-calendar-surface
-> DiaryCalendar
-> diary-calendar-host
-> vc-container
-> vc-pane-container / vc-pane-layout
-> vc-pane
-> vc-weeks
-> vc-week rows

Each owned layer has width/height propagation and min-width/min-height: 0. No 100vh sizing is used. The VCalendar container is borderless, transparent, full-size, and has no outer border, radius, or shadow. Desktop/tablet week rows flex to the available height; mobile keeps a 44px minimum row/day target rather than stretching dates excessively. No week count was hardcoded or synthesized.

Empty, loading, and error messages are compact overlays and do not reserve a permanent row or replace/unmount Calendar.

## Actual browser geometry evidence

The earlier 10/10 Playwright run on `e91a3bd6278b2c4ab61f132ea239db268108f2b0` remains historical evidence. On the final production baseline `93c3db04b67dc37ec8e08fedf3dc86345ee389e6`, with only the test-only follow-up `894d57a` added, the combined browser run completed 11/11 PASS:

- e2e/diary-calendar-surface.spec.ts: 3/3 PASS.
- e2e/diary-release.spec.ts: 7/7 PASS, including the keyboard focus test.
- e2e/vcalendar-compatibility.spec.ts: 1/1 PASS.

The responsive geometry test exercised 1280x800, 768x1024, 375x812, and 320x700. At every viewport it measured surface, Calendar, host, vc-container, and month-title rectangles and passed these non-brittle thresholds:

- host width >= 95% of surface width.
- vc-container width >= 95% of host width.
- host height >= 90% of surface height.
- vc-container height >= 90% of host height.
- month title stayed within 10% of the surface center.
- document horizontal scroll width did not exceed the viewport.

The same test confirmed at every viewport that the old surface header, toolbar, and Today button are absent, the month title is visible and centered, prev/next and day targets are usable, and FileTree/RightRail/StatusBar remain hidden only under the existing Diary Home presentation policy.

## Navigation focus accessibility

Prev/Next retain the minimal transparent default, hover, and mouse-active presentation. Keyboard focus uses a 2px `:focus-visible` outline with `var(--accent)` and 2px offset, preserving the 44px target without layout shift. The focus ring is intentionally separate from `:focus`/`:active` suppression and remains available in light and dark themes.

The final-head browser test `Diary Calendar navigation exposes keyboard-only focus indicators` drives actual `page.keyboard.press('Tab')` navigation rather than mouse focus. It covers 1280x800 and 375x812 in both light and dark themes. Prev and Next each received focus with computed `outline-style: solid`, `outline-width: 2px`, `outline-offset: 2px`, and a non-transparent resolved accent color. Their browser bounding boxes stayed 44x44 before and after focus, and the 2px outline offset remained inside the viewport with no clipping or layout shift. The test passed 1/1 on production baseline `93c3db04`.

## Calendar/browser regressions

- Previous/next month: PASS.
- Existing Diary date click and D5 document fallback: PASS; Calendar becomes hidden while remaining attached, and returns after the backing tab closes.
- Missing future date: PASS browser-visible no-op.
- Repeated existing date open/close: PASS for five repetitions.
- Marker create/delete: PASS.
- pageErrors: [] and unexpected consoleErrors: [] in the diagnostic-covered browser tests.
- VCalendar dayIndex regression: none observed; exact-stack compatibility browser test PASS.

Light/dark and en-US/zh-CN behavior passed in the exact-stack VCalendar browser compatibility test and in the focused Diary Calendar integration tests. Month titles and weekday layout remained usable after locale/theme toggles.

## Superseding product decision

D6.2 is REVIEW-CLOSED and originally preserved the Calendar Home Today affordance. D6.2.1 records a later explicit product decision to remove that Calendar Home control and keep the header minimal: Prev / month title / Next. This intentionally supersedes only the D6.2 Today-affordance requirement.

Nothing else is superseded: DiaryDate and local-civil-date semantics, month navigation, dayclick, markers, locale/theme behavior, the VCalendar candidate, Calendar mount strategy, openDiaryDate/date-command ownership, D5 fallback behavior, special-surface precedence, route/tab/document lifecycle, panel state, and keyboard ownership remain unchanged. Removing goToToday from the Calendar Home UI does not remove local civil date support; the Calendar still operates on strict DiaryDate/local-civil-date values, without a Today shortcut.

## Focused validation

- Focused Vitest: 3 files, 24/24 tests PASS on final production baseline 93c3db0.
- Final production-head Playwright: 11/11 tests PASS on production baseline 93c3db0; the new focus assertion is in test-only commit 894d57a and does not change production behavior.
- Prior full Playwright geometry/regression evidence remains 10/10 PASS on baseline e91a3bd as historical evidence.
- npm run typecheck:client: PASS on final production baseline 93c3db0.
- npm run build: PASS on final production baseline 93c3db0. Existing non-blocking Vite annotation/chunk warnings remain.
- git diff --check: PASS.
- Worktree after validation: clean before this documentation edit.
- Dependencies and lockfiles: unchanged.

Existing History/Diff/Recovery precedence, hidden-workspace keyboard contract, panel-state preservation, ordinary note/archive/ledger layout boundary, local civil Date semantics, Diary markers, and openDiaryDate contract remain unchanged.

## Rollback

### Production rollback

If the D6.2.1 production polish must be rolled back, revert production commits newest to oldest:

1. 93c3db04b67dc37ec8e08fedf3dc86345ee389e6 — fix(diary): restore calendar navigation focus
2. 8ae81fd21854bc2caf0ba950c8e9c30dddc3fcef — style(diary): refine calendar navigation controls
3. f7721a4ba2c8622e2e6b5a7b908e8593efc80d5d — style(diary): remove calendar today button
4. 85b7a4d6d477dace90bc4738488543db16044fb9 — fix(diary): align calendar month header
5. b24a02bf1bf2d33f16a38388d65f4746e90703fc — style(diary): make calendar home full bleed

This restores the closed D6.2 Calendar Home presentation. It does not require reverting D6.2, D6.1, Diary data, routes, tabs, server state, or dependencies.

Production rollback is runtime-only. The test-only commit `894d57a` and all documentation commits are excluded from this production rollback chain.

### Documentation rollback

Documentation history is informational and separate from the production chain. Exact Git-history restoration is not part of the D6.2.1 production rollback contract. If the evidence history itself must be restored, use the documented Git history independently; documentation commits are never part of the production runtime rollback order.

## Handoff

D6.2 remains REVIEW-CLOSED.
D6.2.1 = REVIEW-CLOSED.
D6.2.1 Independent Review = PASS.
D6.2.1 P0/P1/P2 = 0/0/0.
D6.3 = NOT STARTED.

No Reader Dialog, Editor Dialog, modal, focus trap, D6.3 command, or D6.3 implementation was started.
