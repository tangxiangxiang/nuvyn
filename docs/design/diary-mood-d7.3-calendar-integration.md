# D7.3 — Calendar Integration Evidence

> **Historical lineage — not current runtime authority.** Current behavior is
> defined by [Diary Architecture](../architecture/diary.md) and [Diary User
> Guide](../user-guide/diary.md). This file is retained for D7 traceability.

## Status

`REVIEW-CLOSED`

Independent Review: `PASS`

Independent Review findings: `P0 = 0`, `P1 = 0`, `P2 = 0`

Self-review findings: `P0 = 0`, `P1 = 0`, `P2 = 0`

D7.4: `NOT STARTED`

This document records the D7.3 Calendar integration implementation. It does
not start D7.4.

Post-closure Calendar UX revision: `REVIEW-CLOSED`

Post-closure Independent Review: `PASS`

Post-closure Independent Review findings: `P0 = 0`, `P1 = 0`, `P2 = 0`

Tests-only CI remediation: `PASS`

GitHub CI #539: `PASS`

Post-closure self-review findings: `P0 = 0`, `P1 = 0`, `P2 = 0`

The post-closure revision starts from
`7167487e4d2f89d2b5e67a0570f25efa05eac56d` and supersedes only the Calendar
Mood presentation/creation interaction described below. Historical D7.3
implementation and review records remain preserved.

## Baseline and implementation

- Starting HEAD: `5d14967e2a1de829c084cf1cc6a08ade10cdcc3c`
- Implementation commit: `e1a5b6c61373a99f42fb3b1d4af22d8805409b1e`
- Suggested commit subject: `feat(diary): integrate mood picker with calendar`

The implementation commit contains only Calendar/Mood integration code, tests,
and the focused browser regression. No closed D7 PRD or Implementation Plan
was rewritten.

## Focused remediation after the first independent review

The first independent review found two Calendar presentation findings:

1. The body-teleported Mood picker could survive a date or month context
   change while the keep-mounted Calendar was still alive.
2. The Mood action's larger hit area and duplicated Mood artwork could fully
   cover the non-interactive Mood marker, weakening the `marker != action`
   contract.

Remediation commit: `b0f8cdafcfacd7f1f2135f552ad125b6dcf606f0`

The remediation closes the picker with `restoreFocus = false` before date
navigation, before month navigation, and synchronously when Calendar Home is
about to become hidden. This is presentation cleanup only: it does not close
the backing tab, change the route, change `activePath`, or alter the existing
date command.

This was the first remediation's historical contract. The later post-closure
UX revision replaces the separate marker plus `+`/`✎` action with one sibling
Mood emoji button while preserving the non-nested DOM and the date button's
navigation ownership.

The remediation remains D7.3-only and does not start D7.4.

## Post-closure UX revision remediation

Current remediation commit: `1226b1700741017e0a93368d47b6ce9d7454108f`

Parent: `3eb2fbf002303d9ddb2551b734587d91c0e113b6`

This focused remediation initially kept the post-closure revision at
`REVIEW-READY` while its Independent Re-review was pending. The subsequent
tests-only CI remediation and independent re-review are recorded below; this
closure sync now marks the post-closure revision `REVIEW-CLOSED` without
starting D7.4. It closed the following implementation/evidence findings:

1. Removed the unused Native Diary Mood-context presentation wiring from
   `VaultView.vue`, including its resolver, context state, mutation helpers,
   and stale close/focus references. Calendar Mood mutation continues to use
   the shared `useDiaryMoodCommand` and `diaryMoodBusy` seam.
2. Replaced stale Exact Context and “Return Calendar” browser contracts with
   the ordinary FileTree `.search-input` and the actual lifecycle: a managed
   Diary tab keeps Calendar hidden, and closing the final managed Diary tab
   reveals Calendar.
3. Separated the Calendar date and Mood hit boxes with a measured gap at
   1280×720, 375×812, and 320×700. Date navigation and Mood editing remain
   sibling control owners.
4. Seeded the ordinary FileTree filter with `YYYY-MM-DD` only after a
   missing today/past Mood-first create and authoritative Mood CAS succeed.
   Existing edits, clears, conflicts, cancellations, tab/file selection, and
   ordinary user queries do not use this missing-date seed path.

The remediation changes no server/shared contract, route ownership, Calendar
projection, Reader/Editor lifecycle, package manifest, lockfile, or
dependency. The selected Mood option's background, border, `aria-checked`,
and keyboard focus-visible treatment remain intact; only the option's check
glyph is absent as required by the established picker UX.

## Scope delivered

D7.3 adds the Calendar presentation seam for the D7.1 metadata contract and
the D7.2 native picker:

- Calendar day content shows a known Mood as the interactive Mood button
  directly below the date number.
- Unknown stored Mood values remain opaque and are represented without
  inventing a catalog asset.
- Every canonical existing Diary exposes the single Mood button. A known Mood
  renders its emoji; an unknown or unset/cleared Mood renders `?` as the
  add-again entry. There is no separate `+` or `✎` Calendar affordance.
- The Mood emoji button is a sibling of, and is never nested inside, the
  VCalendar date button.
- The date button remains the VCalendar date-navigation and
  `date-selected(DiaryDate)` owner for existing Diaries and missing future
  dates.
- The Mood button only opens the Calendar-level picker and emits a
  `mood-change(DiaryDate, MoodId | null)` intent; it does not emit a date
  navigation event.
- A missing today/past date opens the Mood picker before creation. Escape,
  explicit close, or outside-pointer dismissal creates no Diary. A successful
  selection delegates to the existing date command, obtains fresh bulk CAS,
  writes Mood through `useDiaryMoodCommand`, and only then presents the native
  Diary document.
- Missing future dates keep the existing date-command guard and do not enter
  the writable Mood-first flow. Existing future Diaries retain ordinary open
  and native Mood editing behavior.
- The Calendar owns one active `DiaryMoodPicker` presentation instance,
  teleported to `body`. It does not create one picker per cell.
- Picker selection and clear stay open until VaultView receives the
  authoritative mutation result; successful existing-date mutation closes
  the picker and restores focus to its trigger. A successful missing-date
  create transitions to the native Diary without restoring focus to the
  trigger that is about to be hidden.

## Projection and data ownership

The Calendar projection consumes the existing bulk `PostSummary[]` returned by
the `useTabWorkspace.refresh()` path together with the authoritative Vault
tree. It does not call `getPost`, `listPosts`, `fetch`, or any other API from a
Calendar component.

Projection rules are:

1. Only a direct file under the exact `diary/` root whose path parses as the
   canonical `diary/YYYY-MM-DD` identity can produce a Calendar day.
2. A `PostSummary` can enrich an existing tree day, but can never create an
   orphan Calendar day by itself.
3. Mood, `metadataUpdatedAt`, and `documentId` are joined by exact canonical
   path. Unknown Mood strings are preserved unchanged.
4. Duplicate summary anomalies use the newest valid metadata version, with a
   deterministic document-id tie-breaker.

VaultView remains the mutation owner. For a missing today/past date, Mood
selection starts one presentation intent, uses the existing `openDiaryDate()`
command to establish the canonical backing document, refreshes/reads the
current `metadataUpdatedAt`, delegates the write to
`useDiaryMoodCommand.setMood()`, and transitions from Calendar Home to the
native document only after that mutation succeeds. Calendar components still
own no API, route, tab, create, or metadata authority. Existing Diary Mood
selection, including an existing future Diary, does not navigate or create.

An existing managed Diary day without a valid metadata version is disabled for
Mood mutation rather than guessed or updated without CAS. Clear is not offered
for a missing day.

## DOM and accessibility boundary

The VCalendar-provided `dayProps` and `dayEvents` are bound to the date button.
The Mood emoji/`?` is a sibling button, so `button` elements are not nested and
a Mood click cannot accidentally invoke date navigation. Date and Mood hit
areas remain distinct, with the Mood control below the date and a measured
non-overlapping gap at the supported desktop and mobile viewports. The date
button's accessible name includes Diary and known/unknown Mood information
where available. The Mood button has a date-specific accessible label,
`aria-haspopup`, and `aria-expanded` state.

Calendar cells have no hover background, selection background/frame, or
visible blue existence dot. Mouse focus leaves no persistent decoration.
Keyboard-only `:focus-visible` outlines remain for both date and Mood buttons.

The existing D7.2 picker remains the single 24-option, four-column by six-row
radio grid with keyboard movement, focus-visible treatment, Enter/Space
selection, Escape close, clear, and the established responsive Teleport
positioning. Its selected background, selected border, and `aria-checked`
state remain; only the selected check glyph is omitted. Calendar integration
does not add a second registry or picker implementation.

## Post-closure UX revision validation

The revision is covered by the final production contract rather than source
shape alone:

- component/Vault focused validation: **11 files, 178 tests passed**;
- Calendar + responsive browser validation: **16 tests passed**;
- Native Diary lifecycle browser validation: **9 tests passed**;
- combined Diary browser regression validation: **46 tests passed**;
- full unit/integration validation: **235 files, 3520 tests passed, 2
  skipped**;
- full repository browser validation: **119 tests passed**;
- client, server, and aggregate typecheck: **PASS**;
- production build: **PASS**.

Browser coverage proves that an existing Diary without Mood exposes `?` as the
Calendar Mood entry; an existing Mood emoji opens the one picker without
navigation; missing today/past cancellation creates nothing; successful
Mood-first intent creates, writes Mood, seeds the FileTree date filter, and
presents the native Diary; missing future remains a no-op; blue dots and
hover backgrounds are not visually rendered; Date/Mood hit boxes do not
overlap at 1280×720, 375×812, or 320×700; and the picker remains responsive
without covering month navigation.

## Calendar lifecycle and compatibility

The D5/D6 keep-mounted boundary is unchanged:

- Diary scope owns Calendar subtree mounting.
- Diary presentation owns Calendar visibility.
- Mood picker visibility is local Calendar presentation state.
- Calendar remains free of router, API, tab, raw, save, dirty, or document
  lifecycle ownership.

The existing VCalendar `day-content` seam remains in use. The implementation
does not introduce UTC conversion, `toISOString()`, `Date.UTC()`, a new
VCalendar candidate, DatePicker/range behavior, or a dependency change.

## Tests and validation

Focused Vitest command:

```text
npm exec vitest run \
  src/components/diary/__tests__/DiaryCalendar.test.ts \
  src/components/diary/__tests__/DiaryCalendarSurface.test.ts \
  src/components/diary/__tests__/diaryCalendarProjection.test.ts \
  src/components/diary/__tests__/DiaryMoodPicker.test.ts \
  src/components/diary/__tests__/DiaryMoodContextAction.test.ts \
  src/components/diary/__tests__/diaryMoodContext.test.ts \
  src/components/vault/__tests__/FileTree.test.ts \
  src/components/vault/__tests__/EditorTabs.test.ts \
  src/views/__tests__/VaultView.test.ts \
  src/composables/diary/__tests__/useDiaryDateCommand.test.ts \
  src/composables/diary/__tests__/useDiaryMoodCommand.test.ts
```

Historical implementation result: **10 test files, 124 tests passed**.

The focused tests cover:

- exact tree + bulk-summary Mood projection;
- no orphan projection from summary-only content;
- unknown/null/known Mood values and deterministic duplicate handling;
- known and unknown Calendar markers;
- one Calendar-level picker and 24 options;
- sibling, non-nested date/Mood buttons;
- Mood selection/clear without `date-selected` emission;
- reactive Mood updates without Calendar remount;
- VaultView bulk-summary and existing-command/CAS wiring;
- existing D7.1/D7.2 Calendar, picker, date-command, and Mood-command
  regressions.

Current post-closure remediation result: **11 test files, 178 tests passed**.
The focused selection covers the removed Native Mood-context wiring, shared
Calendar/Mood projection and command seams, ordinary FileTree behavior, and
the existing Calendar/picker/date-command/Mood-command regressions.

Calendar browser regression:

```text
npm exec -- playwright test e2e/diary-calendar-surface.spec.ts
```

Original implementation result: **4 tests passed**.

Current remediation result: **8 tests passed**. In addition to the original
coverage, the browser suite now verifies:

- picker open → existing Diary date navigation closes the picker before the
  Calendar Home is hidden;
- picker open → month navigation closes the picker;
- missing today and past dates use the existing `openDiaryDate()` command and
  create exactly through the existing Diary-date endpoint;
- a missing future date remains uncreated and the Calendar remains available;
- known Mood controls have disjoint date/Mood bounding boxes at 1280×720,
  375×812, and 320×700; and
- clearing a Mood leaves the `?` entry available for another picker open.

Responsive/accessibility browser regression:

```text
npm exec -- playwright test e2e/diary-responsive-accessibility.spec.ts
```

Current remediation result: **8 tests passed**. The suite verifies ordinary
FileTree search semantics, Calendar-hidden/native-document behavior while a
managed Diary tab remains open, final-tab Calendar restoration, responsive
focus/layout behavior, and the absence of the removed Exact Context and
Return Calendar controls.

Existing native Diary lifecycle browser regression:

```text
npm exec -- playwright test e2e/diary-editor-lifecycle.spec.ts
```

Result: **9 tests passed**, preserving D6.4/D7.2 native reading, editing,
History, Recovery, conflict, and responsive Mood-context behavior.

Full unit validation:

```text
npm run test:unit
```

Current remediation result: **235 test files passed; 3520 tests passed; 2
skipped**. The first
sandboxed attempt was limited by local `listen EPERM` errors in unrelated
HTTP/IPC crash-fixture tests; the same command was rerun with the repository's
permitted elevated local test environment and passed. This is not a feature
failure.

Typecheck and build:

- `npm run typecheck:client` — PASS
- `npm run typecheck` — PASS (client and server)
- `npm run build` — PASS

`git diff --check` before the implementation commit: PASS.

## Review history

Historical D7.3 implementation Independent Review: **FAIL**
(`P0 = 0`, `P1 = 2`, `P2 = 0`):

- P1: keep-mounted Calendar context changes could leave a stale body-teleported
  picker open;
- P1: the Mood action could visually and geometrically occlude the non-
  interactive marker.

Historical focused remediation self-review: **PASS**
(`P0 = 0`, `P1 = 0`, `P2 = 0`).

Historical Independent re-review: **PASS**
(`P0 = 0`, `P1 = 0`, `P2 = 0`).

The historical re-review closed the original two remediation findings: the
Teleport picker closes before Calendar date/month or Diary Home presentation
transitions, and the original separate Mood action no longer overlapped its
non-interactive marker. D7.3 was then closed by the subsequent docs-only
closure sync; no D7.4 work is included.

Post-closure UX revision Independent Review: **FAIL**
(`P0 = 0`, `P1 = 2`, `P2 = 3`). The findings were stale Native Mood-context
dead code, stale Exact Context/Return Calendar E2E contracts, mobile Date/Mood
hit-box overlap, missing-date FileTree filter seeding, and outdated evidence.

Current post-closure remediation self-review: **PASS**
(`P0 = 0`, `P1 = 0`, `P2 = 0`).

Tests-only CI remediation commit: `dfe8edd6e7f81e84ae91637ae2dcdaf92dc591be`

The tests-only remediation fixed the two cross-platform harness failures
without changing production code: the Calendar spec now runs its civil-date
helper and browser in the same `Asia/Shanghai` timezone, and the
`VaultView.test.ts` source assertion normalizes CRLF to LF.

Post-closure UX revision Independent Re-review: **PASS**
(`P0 = 0`, `P1 = 0`, `P2 = 0`). The revision is now
`REVIEW-CLOSED`; this status is recorded by the separate docs-only closure
sync after the independent re-review.

GitHub CI #532 was not green at the time of review: visual, docker-smoke,
tags-scale, and auth-browser had passed; Ubuntu 24/22 and macOS 24 verification
jobs were still running; and Windows 24 verification had failed during the
full-unit stage after typecheck and build had passed. The failure details were
not available in this review, so CI #532 is not recorded as PASS and is not
used as the D7.3 closure proof.

For the current post-closure remediation, GitHub Actions was queried after the
implementation commit was pushed. The CI workflow for
`1226b1700741017e0a93368d47b6ce9d7454108f` was `IN_PROGRESS` at query time
(run `33090489272`); no PASS conclusion is claimed here. This current revision
was subsequently covered by the tests-only CI remediation below; this
unfinished historical run is not used as the final closure evidence.

GitHub CI #539 (run `33097659703`) for tests-only remediation commit
`dfe8edd6e7f81e84ae91637ae2dcdaf92dc591be` completed with conclusion
`success`. The auth-browser, docker-smoke, visual, tags-scale, Ubuntu 22/24,
macOS 24, and Windows 24 verification jobs all passed, including their
typecheck, build, unit/integration, browser, and Draft Store suites. CI #539 is
the final CI evidence for this post-closure revision.

## Scope audit

The implementation commit changed 11 files:

- `e2e/diary-calendar-surface.spec.ts`
- `src/components/diary/DiaryCalendar.vue`
- `src/components/diary/DiaryCalendarSurface.vue`
- `src/components/diary/__tests__/DiaryCalendar.test.ts`
- `src/components/diary/__tests__/DiaryCalendarSurface.test.ts`
- `src/components/diary/__tests__/diaryCalendarProjection.test.ts`
- `src/components/diary/diaryCalendarAdapter.ts`
- `src/components/diary/diaryCalendarProjection.ts`
- `src/composables/useI18n.ts`
- `src/views/VaultView.vue`
- `src/views/__tests__/VaultView.test.ts`

No `server/**`, `shared/**`, Calendar dependency/version, package manifest,
lockfile, or new dependency changed. No D7.4/UI phase was started; D7.3 does
not add Mood statistics, custom icons, multi-select, or a new Reader/Editor
surface.

The historical focused remediation commit changed five files: the Calendar
adapter, VaultView presentation wiring, their focused tests, and the Calendar
browser regression. The current post-closure remediation commit
`1226b1700741017e0a93368d47b6ce9d7454108f` changes nine files:

- `src/components/diary/DiaryCalendar.vue`
- `src/views/VaultView.vue`
- `src/views/__tests__/VaultView.test.ts`
- `e2e/diary-calendar-surface.spec.ts`
- `e2e/diary-editor-lifecycle.spec.ts`
- `e2e/diary-lifecycle-regression.spec.ts`
- `e2e/diary-reader.spec.ts`
- `e2e/diary-release.spec.ts`
- `e2e/diary-responsive-accessibility.spec.ts`

It does not change server/shared contracts, the Mood registry, Calendar
projection, Reader/Editor lifecycle, package manifests, lockfiles, or
dependencies.

## Lifecycle state

```text
D7 PRD                  = REVIEW-CLOSED
D7 Implementation Plan = REVIEW-CLOSED
D7.0A                  = REVIEW-CLOSED
D7.0                   = REVIEW-CLOSED
D7.1                   = REVIEW-CLOSED
D7.2                   = REVIEW-CLOSED

D7.3                   = REVIEW-CLOSED
D7.3 Independent Review = PASS (`P0 = 0`, `P1 = 0`, `P2 = 0`)
D7.3 post-closure UX revision = REVIEW-CLOSED
D7.3 UX revision Independent Review = PASS (`P0 = 0`, `P1 = 0`, `P2 = 0`)

D7.4                   = NOT STARTED
D7 Mood production     = NOT STARTED
```

## Readiness and stop conditions

The D7.3 implementation and post-closure focused remediation are closed after
independent re-review and the tests-only CI remediation. The implementation
stopped at the Calendar integration boundary: no D7.4 work, no mood statistics,
no custom catalog changes, no new lifecycle, and no new route/API were added.

The independent re-review covered the real browser behavior for existing and
missing dates, CAS rejection/refresh behavior, unknown Mood preservation, the
single-picker boundary, no-N+1 projection, and keep-mounted VCalendar
compatibility.

GitHub status: **queried; CI #539 passed** (run `33097659703`).
