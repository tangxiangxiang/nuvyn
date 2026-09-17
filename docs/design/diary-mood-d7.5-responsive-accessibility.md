# D7.5 — Responsive and Accessibility Validation

> **Historical lineage — not current runtime authority.** Current behavior is
> defined by [Diary Architecture](../architecture/diary.md) and [Diary User
> Guide](../user-guide/diary.md). This file is retained for D7 traceability.

## Status

`D7.5 = REVIEW-CLOSED`

`D7.5 Final Gate = PASS`

D7.5 Final Gate Independent Audit findings: `P0 = 0`, `P1 = 0`, `P2 = 0`

`D7.5 Round 1 = REVIEW-CLOSED`

Independent Re-review: `PASS`

Independent Re-review findings: `P0 = 0`, `P1 = 0`, `P2 = 0`

Self-review findings: `P0 = 0`, `P1 = 0`, `P2 = 0`

GitHub CI #555: `PASS`

`D7.5 Round 2 = REVIEW-CLOSED`

Round 2 Independent Re-review: `PASS`

Round 2 Independent Re-review findings: `P0 = 0`, `P1 = 0`, `P2 = 0`

GitHub CI #557: `PASS`

`D7.6 = NOT STARTED`

This document records the closed Round 1 responsive, viewport, and overflow
validation and the separate Round 2 interaction, accessibility, and locale
validation. Round 1 and Round 2 are each closed by their docs-only closure
syncs, and the overall D7.5 phase is closed by the Final Gate recorded below.
This document does not begin D7.6.

## Starting HEAD

`93dca2729003069beffc6060336a72a737771b87`

`docs(diary): close D7.4 lifecycle review`

The starting worktree was clean, and `github/main` pointed at this exact
commit before Round 1 work began.

## Round 1 Scope

Round 1 is limited to the following browser-visible contract:

- 1280×800, 768×1024, 375×812, and 320×700;
- the real Calendar and the single Teleported Mood Picker;
- fixed 4 columns × 6 rows and canonical row-major Mood order;
- picker horizontal containment, option geometry, and Clear reachability;
- Calendar date/Mood spatial separation and month navigation;
- page-level horizontal overflow;
- light/dark and zh/en layout smoke coverage;
- ordinary Vault boundary smoke.

Full keyboard semantics, ARIA semantics, contrast certification, and complete
locale/accessibility validation remain outside the Round 1 evidence. The
separate Round 2 evidence is recorded below without promoting either round
into a whole-site accessibility certification.

## Baseline Characterization

The focused suite was added before changing production CSS. At the baseline,
the 375px and 320px cases exposed one responsive layout defect:

```text
D7.5-R1-P2-1
viewport: 375×812 and 320×700
theme/locale: light / zh-CN
scenario: existing Diary with a Mood marker, Calendar Home
expected: the Mood hit area remains inside its own Calendar row and does not
          enter the following row's date targets
actual: the 24px Mood sibling extended below the fixed 44px VCalendar week
        row and crossed the following week's date hit area
root cause: the optional Mood control shared a narrow 44px row without enough
           vertical space for both the 44px date target and the Mood target
severity: P2; the controls remained visible, but their click ownership was
          ambiguous at narrow widths
```

The baseline did not show a P0/P1 data or lifecycle failure. No production
change was made until the browser geometry assertion exposed this condition.

## Production Changes

Implementation commit:

`3b43867e21f7af2e137c379621a775a6d37d04c0`

`fix(diary): keep mobile mood inside calendar row`

The remediation is component-local to
[`DiaryCalendar.vue`](/Users/txx/nuvyn/src/components/diary/DiaryCalendar.vue):

- narrow Calendar week rows and shared day content reserve 72px for the
  date target plus the optional Mood target;
- the date target remains 44px, preserving the existing keyboard/touch target
  contract;
- the Mood remains a separate sibling control below the date;
- the fixed 4×6 Mood Picker grid is unchanged;
- no global `overflow-x: hidden`, transform, zoom, JavaScript viewport layout
  state, duplicate mobile picker, or generic Vault CSS was added.

The characterization and browser-proof commit is:

`f48c77fe4638f176e58418a09e96618467d1e499`

`test(diary): expose D7.5 responsive regression`

## Viewport Matrix

The dedicated suite
[`diary-mood-responsive.spec.ts`](/Users/txx/nuvyn/e2e/diary-mood-responsive.spec.ts)
uses the same real browser behavior for every viewport. It reads browser
bounding boxes rather than relying on screenshots or CSS source inspection.

| Viewport | Calendar Home | Mood Picker | Grid | Clear | Calendar/Mood geometry | Page horizontal overflow | Native Diary |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1280×800 | PASS | PASS | 4×6 / 24 | PASS | PASS | PASS | PASS |
| 768×1024 | PASS | PASS | 4×6 / 24 | PASS | PASS | PASS | PASS |
| 375×812 | PASS | PASS | 4×6 / 24 | PASS | PASS | PASS | PASS |
| 320×700 | PASS | PASS | 4×6 / 24 | PASS | PASS | PASS | PASS |

For every matrix viewport the browser proof checks:

- six measured option row positions and four measured option column positions;
- four options in each row and six options in each column;
- all 24 options in canonical row-major order;
- non-zero, non-overlapping option hit boxes;
- picker and Clear containment without internal horizontal overflow;
- no page-level horizontal overflow in Calendar Home, picker-open, or native
  Diary states;
- date/Mood vertical separation and no Mood overlap with neighboring date
  targets;
- month previous/next navigation remains usable;
- the selected Calendar date has no filled background, border, or shadow;
- a single picker presentation is mounted.

The narrow mobile run therefore proves the remediation without changing the
semantic grid to 3×8, 2×12, or 6×4.

## Theme / Locale Geometry

The dedicated browser suite covers:

- `zh-CN` + light theme across all four official Round 1 viewports;
- `en-US` + dark theme at 1280×800 and 320×700, including the English
  `Clear mood` control;
- visible month/header and picker text remaining contained in the tested
  layouts;
- the ordinary Note/Vault boundary remaining outside Mood policy.

The existing D6.6 responsive suite continues to provide the broader keyboard,
focus-visible, selected-state, and mobile native-workspace evidence. Round 1
does not relabel that evidence as a new accessibility certification.

## Calendar and Native Workspace Boundary

The Calendar remains a keep-mounted presentation surface. The responsive
suite verifies that date navigation still opens the native Diary workspace,
the picker does not navigate the date, and closing the Diary tab returns to
Calendar Home. The date button remains the navigation owner and the Mood
control remains the separate Mood entry point.

The ordinary Vault smoke opens an ordinary Note with the FileTree, verifies
that no Calendar or Mood Picker is present, then closes the FileTree and
checks the wide native workspace for page-level overflow. Existing D6.6
coverage remains the owner for the mobile native workspace contract; this
Round 1 does not redesign generic Vault layout.

## Validation

Focused responsive browser suite:

```text
npm exec playwright test e2e/diary-mood-responsive.spec.ts --project=chromium
2 passed
```

The two tests contain the full four-viewport matrix, light/dark geometry,
zh/en smoke, Calendar navigation, native Diary smoke, and ordinary Vault
boundary assertions.

Existing Calendar and D7.4 lifecycle browser smoke:

```text
e2e/diary-mood-lifecycle-regression.spec.ts
e2e/diary-calendar-surface.spec.ts
27 passed
```

Existing focused component/Vault tests:

```text
8 test files
129 passed
```

Draft Store browser regression:

```text
npm run test:e2e:draft-store
38 passed
```

Complete Chromium browser suite:

```text
npm exec playwright test --project=chromium
140 passed
```

Full unit suite:

```text
npm run test:unit
235 test files passed
3524 passed, 2 skipped
```

Type checks:

```text
npm run typecheck:client  PASS
npm run typecheck:server  PASS
npm run typecheck         PASS
```

Production build:

```text
npm run build             PASS
```

The build emitted existing dependency/chunk-size warnings but completed
successfully. No warning was caused by the D7.5 production diff.

The first full-unit attempt in the restricted sandbox was not used as a
result: existing `tsx` crash-child tests could not listen on their temporary
IPC sockets and reported `EPERM`. The authorized rerun above passed in full.

## CI

GitHub Actions CI #555 covered the exact Round 1 implementation/evidence
HEAD before this closure-only commit:

```text
run number: 555
run ID: 33179840394
attempt: 1
HEAD: 5838773095d3468630c0789b7152cb8a48825b16
status: completed
conclusion: success
```

Required jobs all passed:

- Ubuntu 22 verify;
- Ubuntu 24 verify;
- Windows 24 verify;
- macOS 24 verify;
- auth-browser;
- visual;
- docker-smoke;
- tags-scale.

The four platform jobs also passed their typecheck, build, unit/integration,
cross-platform browser E2E, and Draft Store E2E stages. The docs-only closure
sync does not change the tested production or test implementation.

## Findings and Self-review

Baseline finding `D7.5-R1-P2-1` is closed by the component-local row-height
remediation and the real browser geometry proof above.

Current self-review:

```text
P0 = 0
P1 = 0
P2 = 0
```

Independent Re-review:

```text
PASS
P0 = 0
P1 = 0
P2 = 0
```

No lifecycle, data, Mood ownership, route, tab, History, Recovery, CAS,
FileTree query, server, shared domain, schema, dependency, or package change
was introduced by this Round 1 work. No new Mood catalog or production
feature was started.

## Commit Scope

Starting from `93dca2729003069beffc6060336a72a737771b87`, the implementation
chain is:

```text
f48c77fe4638f176e58418a09e96618467d1e499
test(diary): expose D7.5 responsive regression
        ↓
3b43867e21f7af2e137c379621a775a6d37d04c0
fix(diary): keep mobile mood inside calendar row
```

Files changed by the implementation chain:

- [`e2e/diary-mood-responsive.spec.ts`](/Users/txx/nuvyn/e2e/diary-mood-responsive.spec.ts)
- [`src/components/diary/DiaryCalendar.vue`](/Users/txx/nuvyn/src/components/diary/DiaryCalendar.vue)

This evidence document is the only file added by the following docs commit.
There are no server/shared/router/tab/schema/package/lockfile/dependency
changes.

## Round 1 State at Round 1 Closure

```text
D7.0A = REVIEW-CLOSED
D7.0  = REVIEW-CLOSED
D7.1  = REVIEW-CLOSED
D7.2  = REVIEW-CLOSED
D7.3  = REVIEW-CLOSED
D7.4  = REVIEW-CLOSED

D7.5  = IN PROGRESS
D7.5 Round 1 = REVIEW-CLOSED
D7.5 Round 1 Independent Re-review = PASS (P0/P1/P2 = 0/0/0)
GitHub CI #555 = PASS

D7.6  = NOT STARTED
D7.5 Round 2 = NOT STARTED
D7.5 implementation beyond Round 1 = NOT STARTED
```

The Round 1 closure boundary did not begin Round 2, D7.6, or unrelated
responsive/generic Vault work.

## Round 2 — Interaction / Accessibility / Locale

### Round 2 Starting HEAD

`9a35a7c003a3b9000c7f8aca6fb448c65833ad6c`

`docs(diary): close D7.5 round 1 review`

The starting worktree was clean and `github/main` pointed at this exact
commit. Round 1 was already `REVIEW-CLOSED`; D7.6 remained `NOT STARTED`.

Round 2 was kept separate from the closed responsive round. Its scope was
limited to real browser characterization of picker keyboard behavior,
focus-visible behavior, focus restoration, ARIA relationships, selected
state semantics, Clear, touch activation, locale, and theme interaction.

### Characterization-first Baseline

The new browser suite was written and run against the starting production
HEAD before any Round 2 production change.

The corrected baseline result was:

```text
9 tests
7 passed
2 failed
```

The first local run briefly included two assertion mistakes in the new test
itself (Tab traversal for an out-of-month VCalendar target and an overly
narrow English label pattern). Those test-only assertions were corrected and
were not treated as product findings. The remaining two failures were real
browser observations:

```text
D7.5-R2-P2-1
scenario: existing Diary Mood trigger opens the single Calendar picker
expected: popup semantics describe the actual controlled surface
actual: aria-haspopup="dialog" pointed at a surface with role="group";
        the trigger had no aria-controls relationship to the picker
root cause: stale dialog-shaped ARIA declaration on a non-dialog picker
severity: P2; the picker remained operable, but the core popup relationship
          was semantically inaccurate

D7.5-R2-P2-2
scenario: selected canonical Mood versus an unselected Mood option
expected: selected state has a visible cue not dependent on color
actual: computed background/border colors differed, but the visible
        non-color font/border/style cues were identical
root cause: selected option label had no non-color visual distinction
severity: P2; aria-checked was present, but the visible state was color-only
```

No production change was made before these failures were captured.

### Round 2 Remediation

The focused implementation commit is:

`d53f1d9cc29f75f826227b6bf24e0faa162083ea` `fix(diary): preserve mood accessibility contract`

It contains only two component-local changes:

- Calendar Mood triggers no longer claim `aria-haspopup="dialog"` for the
  non-dialog picker; only the active trigger exposes `aria-controls`, pointing
  to the single stable `diary-mood-picker` presentation, while
  `aria-expanded` remains truthful;
- the selected option label uses a heavier font weight, providing a visible
  non-color cue while preserving the selected background, border,
  `aria-checked`, no-checkmark contract, 4×6 geometry, and one shared picker.

The additional dark-theme keyboard coverage is recorded in:

`48447be39833cc3c2ad0a832531e6c53f16f3a2a` `test(diary): cover dark mood focus semantics`

The initial characterization test commit is:

`ceb2b554f4b1b0c49efeb32c52f3f32d0355fa51` `test(diary): expose D7.5 accessibility regressions`

No Mood catalog IDs/assets/order, server/shared metadata lifecycle, route,
tab, History, Recovery, Draft Store, CAS, FileTree query ownership,
dependency, or generic Vault contract was changed.

### Keyboard and Focus Evidence

The dedicated suite
[`diary-mood-accessibility.spec.ts`](/Users/txx/nuvyn/e2e/diary-mood-accessibility.spec.ts)
passed 9/9 after remediation. Its real browser assertions prove:

- one picker, one named `radiogroup`, 24 radios, canonical row-major order,
  exactly one roving `tabindex="0"`, and the selected radio initially focused;
- ArrowRight/Left/Up/Down preserve the fixed 4 columns × 6 rows with
  independent row/column clamping at all four corners and representative
  interior cells;
- arrows move focus only: they do not change `aria-checked`, issue a Mood
  PATCH, navigate the route, open a tab, or navigate the Calendar date;
- Enter, Space, and Clear each produce exactly one authoritative Mood PATCH;
- Escape and the picker Close button close the presentation and restore focus
  to the same Calendar Mood trigger without navigation or a write;
- a missing past date can enter the Mood-first picker by keyboard, while
  Escape leaves the date absent and creates neither a Diary nor Mood metadata;
- the Calendar region, date button, Mood trigger, picker, radiogroup, radio
  names, Close, and Clear expose non-empty accessible names; radio names are
  unique, `aria-checked` is valid, and `aria-posinset`/`aria-setsize` are
  consistent from 1..24/24;
- the Calendar trigger's `aria-expanded` and `aria-controls` correspond to
  the one mounted picker, and no `✓` is rendered;
- keyboard-generated focus indicators are visible on the Calendar Mood
  trigger, selected radio, Clear, and Close in light theme and on the trigger,
  selected radio, and Clear in dark theme;
- a real `hasTouch` 375×812 browser context uses `.tap()` to open Mood, select
  once, Clear once, and keep URL/tab/date navigation unchanged;
- Chinese light and English dark contexts retain the same 24 IDs, labels,
  accessible names, selected state, Clear/Close semantics, and picker
  geometry.

The suite collected `pageerror` and `console.error`; both were empty for all
Round 2 cases.

### Round 2 Self-review

```text
Keyboard grid / no-select arrows       PASS
Enter / Space / Clear exactly once     PASS
Escape / Close focus restoration       PASS
Missing-date keyboard cancellation     PASS
Focus-visible light                    PASS
Focus-visible dark                     PASS
ARIA structure and names               PASS
Popup relationship                     PASS
24 radios / roving tabindex             PASS
Selected aria-checked                  PASS
Selected non-color cue                 PASS
No checkmark                           PASS
Real touch activation                  PASS
zh-CN + light                          PASS
en-US + dark                           PASS

P0 = 0
P1 = 0
P2 = 0
```

### Round 2 Regression Results

The required regression gates were run after the focused changes. They preserve
Round 1 and D7.4 lifecycle ownership; they do not reopen either phase:

```text
D7.5 Round 1 responsive matrix
e2e/diary-mood-responsive.spec.ts --project=chromium
2 passed

D7.4 lifecycle and Calendar surface browser suites
e2e/diary-mood-lifecycle-regression.spec.ts
e2e/diary-calendar-surface.spec.ts
27 passed

Focused component/Vault Vitest suite
6 files, 102 passed

D6 Diary responsive/accessibility, lifecycle, reader, release, and ordinary
Vault smoke suites
38 passed after retrying the one existing Monaco teardown cancellation

Full Chromium browser suite
149 passed

Draft Store browser regression
38 passed

Full unit suite
235 test files passed
3524 passed, 2 skipped

Type checks
npm run typecheck:client  PASS
npm run typecheck:server  PASS
npm run typecheck         PASS

Production build
npm run build             PASS

Working-tree whitespace validation
git diff --check         PASS
```

The initial D6 browser run reported 37 passed plus one existing Monaco
teardown `Canceled: Canceled` page error; the affected selection was rerun and
all 8 selected tests passed. No D7.5 assertion failed, and the final evidence
count for that regression set is 38 passed. The full-unit restricted-sandbox
attempt was not used because existing crash-child tests hit `EPERM`; the
authorized rerun above passed in full. The build emitted existing dependency
annotation/chunk-size warnings but completed successfully.

Round 2 does not begin D7.6 and does not change D7.5's existing lifecycle
owners.

### Round 2 CI

GitHub Actions CI #557 covered the exact Round 2 implementation/evidence HEAD
before this docs-only closure sync. It is not reused from the historical Round
1 CI #555:

```text
run number: 557
run ID: 33186412575
attempt: 2
HEAD: 3e1a392d575b15492e30df26f28a8bb67a4be9b5
status: completed
conclusion: success
```

Required jobs all passed:

- Ubuntu 22 verify;
- Ubuntu 24 verify;
- Windows 24 verify;
- macOS 24 verify;
- auth-browser;
- visual;
- docker-smoke;
- tags-scale.

The four platform jobs also passed their typecheck, build, unit/integration,
cross-platform browser E2E, and Draft Store E2E stages. The closure commit
does not change the tested implementation or test files.

### Round 2 State at Round 2 Closure

```text
D7.0A = REVIEW-CLOSED
D7.0  = REVIEW-CLOSED
D7.1  = REVIEW-CLOSED
D7.2  = REVIEW-CLOSED
D7.3  = REVIEW-CLOSED
D7.4  = REVIEW-CLOSED

D7.5  = IN PROGRESS
D7.5 Round 1 = REVIEW-CLOSED
D7.5 Round 1 Independent Re-review = PASS (P0/P1/P2 = 0/0/0)
GitHub CI #555 = PASS

D7.5 Round 2 = REVIEW-CLOSED
D7.5 Round 2 Independent Re-review = PASS (P0/P1/P2 = 0/0/0)
GitHub CI #557 = PASS

D7.6  = NOT STARTED
```

The Round 2 closure sync does not close the overall D7.5 phase or begin its
final gate. Do not begin D7.6, reopen Round 1, or add unrelated generic Vault
accessibility work in this Round 2 boundary.

## D7.5 Final Gate / Overall Closure

The Final Gate was independently audited after both implementation rounds were
closed. It confirms the official D7.5 exit criteria without introducing a
third round or changing the D7.5 ownership boundary.

| Official exit criterion | Direct evidence | Result |
| --- | --- | --- |
| `1280×800` retains 4 columns × 6 rows | Real browser geometry: 6 row tops, 4 column positions, 24 options in canonical order | PASS |
| `768×1024` retains 4 columns × 6 rows | The same responsive geometry matrix | PASS |
| `375×812` retains 4 columns × 6 rows | Geometry, containment, and date/Mood non-overlap after the narrow-screen remediation | PASS |
| `320×700` retains 4 columns × 6 rows | Geometry, containment, Clear reachability, and no horizontal overflow | PASS |
| Keyboard interaction | Roving tabindex, four-direction independent grid clamping, Arrow without selection/write/navigation, and Enter/Space exactly once | PASS |
| Touch interaction | Real `hasTouch: true` browser context and `.tap()` for Mood select/Clear exactly once without date navigation | PASS |
| Focus-visible | Browser computed-style evidence for keyboard focus indicators in light and dark themes | PASS |
| Selected non-color cue | `aria-checked` plus selected-label `font-weight: 700`; no checkmark glyph | PASS |
| Clear action | Visible and contained at all four viewports; keyboard and real touch clear mutation | PASS |
| `zh` locale | Calendar, Picker, ARIA names, and interaction evidence under `zh-CN` light | PASS |
| `en` locale | Calendar, Picker, ARIA names, and interaction evidence under `en-US` dark | PASS |
| Light and dark themes | Responsive geometry and keyboard/focus/ARIA semantics in both themes | PASS |
| No horizontal page overflow | Calendar Home, Picker open, and Native Diary checked at all four viewports with `scrollWidth <= clientWidth + 1` | PASS |

Round 1's browser matrix directly measured 24 Mood options, six real rows,
four real columns, picker/Clear containment, option overlap, and page-level
overflow. Round 2 added the interaction and accessibility proof: one named
radiogroup, 24 radios, roving focus, fixed 4×6 keyboard geometry, truthful
ARIA relationships, focus-visible behavior, selected non-color semantics,
Clear, Escape/close focus restoration, and real touch. Round 1 was rerun after
the Round 2 changes and remained passing. The D7.4 lifecycle suite, full
Chromium browser suite, Draft Store suite, full unit suite, typechecks, and
build also passed.

The Final Gate relies on the exact implementation/evidence CI runs already
recorded above:

```text
GitHub CI #555 = PASS
GitHub CI #557 = PASS

D7.5 Final Gate Independent Audit = PASS
P0/P1/P2 = 0/0/0
```

The closure sync changes documentation only; it does not alter the production
or test files covered by those runs.

## Final D7.5 Lifecycle

```text
D7.0A = REVIEW-CLOSED
D7.0  = REVIEW-CLOSED
D7.1  = REVIEW-CLOSED
D7.2  = REVIEW-CLOSED
D7.3  = REVIEW-CLOSED
D7.4  = REVIEW-CLOSED

D7.5  = REVIEW-CLOSED
D7.5 Round 1 = REVIEW-CLOSED
D7.5 Round 2 = REVIEW-CLOSED
D7.5 Final Gate = PASS
D7.5 Final Gate Independent Audit = PASS
D7.5 Final Gate P0/P1/P2 = 0/0/0
GitHub CI #555 = PASS
GitHub CI #557 = PASS

D7.6  = NOT STARTED
```

This Final Gate closure does not begin D7.6 or any later phase.
