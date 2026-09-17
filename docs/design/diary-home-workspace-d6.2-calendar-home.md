# D6.2 Calendar Home Migration Evidence

> **Historical lineage — not current runtime authority.** Current behavior is
> defined by [Diary Architecture](../architecture/diary.md) and [Diary User
> Guide](../user-guide/diary.md). This file is retained for D6 traceability.

## Status

D6.2 = REVIEW-CLOSED.
Independent review = PASS.
P0 = 0 / P1 = 0 / P2 = 0.

Starting HEAD: f53b7b3ae724e1d5564cb56379accdbf5b9222e1
Production commit: bcbbdf0b2bfabdaecc5ae0af189f777d5d032e95
Evidence commit: 3a08aff952d3937f2bc3ee07a84ad8a4c6d1ff0f

D6.0 = REVIEW-CLOSED
D6.1 = REVIEW-CLOSED
D6.3 = NOT STARTED

This phase promotes the existing Calendar surface to the primary Diary Home presentation. It does not implement Reader or Editor Dialogs and does not change the document lifecycle.

## Scope and implementation

The existing DiaryWorkspace / DiaryCalendarSurface / DiaryCalendar stack remains in use. Home-specific chrome is driven by the existing isDiaryCalendarMode predicate, derived from Diary presentation eligibility and presentationMode === home; it is not driven by Diary scope alone. History Comparison, Working Tree Diff, and Recovery therefore retain precedence.

When Diary Home is primary, the Vault visually collapses FileTree, side-panel splitters, RightRail, and document StatusBar. Their state is not mutated; leaving Home restores the normal Vault layout. Calendar remains mounted for the entire Diary scope through isDiaryCalendarMounted, while Home visibility uses presentation visibility. D5 fallback exits the Home layout without synchronously unmounting Calendar.

The Calendar is no longer a small centered card: its workspace width is expanded, outer card border/radius are removed, and day targets remain at least 44px with larger responsive desktop/tablet sizing. Existing month navigation, Today, date selection, markers, loading, empty, error, locale, theme, and local-civil-date behavior are unchanged.

## Ownership and state preservation

- openDiaryDate() and the existing tab/document lifecycle are unchanged.
- Router, route synchronization, activePath, tabs, and panel state are unchanged.
- FileTree, side panel, RightRail, and StatusBar are presentation-hidden in Home; their state is preserved.
- No Reader Dialog, Editor Dialog, server/API, shared contract, VCalendar version, or dependency was added or changed.
- Ordinary note/archive/ledger layouts remain outside the Home-specific class.

## Actual browser evidence

The Playwright run of e2e/diary-release.spec.ts completed 6/6 PASS. The responsive test exercised all four viewports:

| Viewport | Home / chrome | Usability and layout |
| --- | --- | --- |
| 1280x800 | Calendar visible; FileTree, RightRail, StatusBar hidden | navigation and date targets usable; no horizontal overflow |
| 768x1024 | Calendar visible; document chrome hidden | seven-column layout and targets usable; no horizontal overflow |
| 375x812 | Calendar visible; document chrome hidden | seven-column layout and targets usable; no horizontal overflow |
| 320x700 | Calendar visible; document chrome hidden | month/navigation and date targets usable; no horizontal overflow |

The browser run also passed keyboard/focus, marker create/delete, and five repeated existing-Diary open/close lifecycle checks. In the diagnostic-covered browser tests, pageErrors = [] and consoleErrors = []; no page error or unexpected console error was observed during the run.

The browser evidence confirms the D5 fallback: Diary Home -> valid existing date -> existing document surface becomes primary, Calendar becomes hidden but remains mounted; closing the backing tab restores Calendar Home. Special surfaces retain precedence, and ordinary Vault layout regression remains covered by the existing test boundary.

Theme and locale behavior were not independently toggled in this browser run. Light/dark theme and English/Chinese locale contracts remain covered by the focused DiaryCalendar / DiaryCalendarSurface test suites; this evidence does not claim a separate browser visual PASS for those toggles.

## Focused and build evidence

- Focused Vitest: 74/74 PASS across the VaultView, DiaryCalendar, DiaryCalendarSurface, DiaryWorkspace, and presentation tests.
- npm run typecheck:client: PASS.
- npm run build: PASS. Existing non-blocking chunk and annotation warnings were emitted.
- git diff --check: PASS.
- Worktree after validation: clean.
- GitHub status: not queried in this phase execution.

The focused suites preserve empty, loading, error, locale, theme, marker, DiaryDate, Today, and month-navigation contracts. openDiaryDate() API and local civil date semantics are unchanged.

## VCalendar and lifecycle boundary

VCalendar version is unchanged. The Calendar mount predicate remains isDiaryScope; visibility changes do not unmount the Calendar. The browser regression showed no dayIndex runtime error in the diagnostic-covered tests and retained usable Today, previous-month, next-month, and date-click controls.

## Rollback

### Production rollback

To restore the D6.1 production presentation, revert only:

bcbbdf0b2bfabdaecc5ae0af189f777d5d032e95 — feat(diary): promote calendar to home workspace

Runtime rollback does not require Diary data migration, route migration, tab migration, server rollback, dependency rollback, or database cleanup. The evidence commit is not part of the production rollback chain.

### Documentation rollback

To restore the pre-D6.2 documentation/history state, revert the evidence commits independently, including:

3a08aff952d3937f2bc3ee07a84ad8a4c6d1ff0f and this docs-only follow-up commit.

Documentation rollback does not roll back runtime behavior.

## Phase gate and handoff

The evidence follow-up closed the previously identified evidence P1 and rollback-wording P2 without changing production. Independent review passed with P0/P1/P2 = 0/0/0.

D6.3 = NOT STARTED. No Reader Dialog, Editor Dialog, or D6.3 implementation was started.
