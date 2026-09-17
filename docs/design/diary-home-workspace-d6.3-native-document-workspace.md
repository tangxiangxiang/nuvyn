# D6.3 Native Document Workspace Handoff Evidence

> **Historical lineage — not current runtime authority.** Current behavior is
> defined by [Diary Architecture](../architecture/diary.md) and [Diary User
> Guide](../user-guide/diary.md). This file is retained for D6 traceability.

## Status

- D6.3 = `REVIEW-CLOSED`
- D6.4 = `NOT STARTED`
- Native Workspace superseding amendment = `REVIEW-CLOSED`
- Task-scoped self-review: P0 = 0, P1 = 0, P2 = 0
- Independent review: `PASS` (P0 = 0, P1 = 0, P2 = 0)
- Canonical direction: Calendar does navigation; Vault does documents.

The former D6.3 Reader Dialog implementation is preserved only as historical
evidence and is `SUPERSEDED BEFORE REVIEW CLOSURE`. Its historical independent
review PASS does not apply to this replacement.

## Baseline and commits

- Starting HEAD: `82c555b8dc13be22de0863c8105cc0b83cd289d1`
- Design amendment: `edfbcf07c04ad2a2063900efc489d1bef01b981b`
- Native workspace production/tests: `592a1d5181edc84d1d66392f2c87fe8a2d4a23eb`
- D6.3 mobile follow-up starting HEAD: `0c54379df9f9600234a59ffc1945f0e2f27c63d7`
- Mobile collapsed side-panel production follow-up: `032b6ea0cde34ac7834bde45efdb70516c25fcf3`
- Final production validation baseline: `032b6ea0cde34ac7834bde45efdb70516c25fcf3`
- Evidence commit: the commit containing this document

Historical superseded D6.3 commits remain in history:

- Reader Dialog implementation: `d270ee5756c0f742e92955f06fa308fd6f77bc4a`
- Reader reconciliation follow-up: `fa85f431d274e36fccbeaa0446ed63cf0d017a36`
- Historical evidence: `05fe7dc8952b21c785a303c6309369c1d1f8f03c`
  and `82c555b8dc13be22de0863c8105cc0b83cd289d1`

## Scope and changed runtime

The replacement removes the Diary-specific Reader surface and reconnects a
successful Calendar date command to the ordinary Vault document workspace.
Runtime changes are limited to Diary presentation ownership, VaultView
composition, a generic FileTree exact-path projection, responsive native Diary
layout, related i18n cleanup, and tests.

Deleted:

- `src/components/diary/DiaryReaderDialog.vue`
- `src/components/diary/__tests__/DiaryReaderDialog.test.ts`

Unchanged boundaries:

- no server or shared Diary protocol change;
- no router or route change;
- no `useDiaryDateCommand()` or tab-workspace ownership change;
- no package, lockfile, dependency, VCalendar, Popper or Calendar visual change;
- no D6.4 lifecycle implementation.

## Canonical state and ownership

```text
Diary Calendar Home
  -> explicit Calendar date intent
  -> existing openDiaryDate()
  -> existing openPost()/tab lifecycle
  -> Native Vault Document (READ)
  <-> existing view mode
  -> existing EditorPane / Monaco (EDIT)

Native Vault Document
  -> compact Calendar Home presentation action
  -> Diary Calendar Home
```

Diary presentation owns only `HOME | DOCUMENT`, selected Diary date/path,
focus-return context, stale-intent epoch and eligibility. Existing Vault owners
continue to own route, tabs, `activePath`, raw, Monaco model, READ/EDIT, save,
dirty, Draft, History, Recovery and external-change behavior.

`DOCUMENT` requires all of the following:

1. an explicit Calendar command returned `opened` or `created`;
2. the selected date/path was recorded from that result;
3. the date intent is still current and Diary presentation remains eligible;
4. existing `openPost()` has completed and `activePath === result.path`.

Observing `activePath` can only close stale DOCUMENT state. It cannot open or
retarget DOCUMENT.

## Native document handoff

`VaultView.onDiaryDateSelected()` still calls the single existing
`openDiaryDate(date)` command. After successful command adoption it requests
DOCUMENT and calls existing `viewModeApi.set('read')`.

There is no presentation-layer `getPost`, fetch, create or second `openPost()`.
The existing command still performs its authoritative exact-path existence
probe; presentation adds no request. Existing `activeTab.raw` feeds exactly one
ordinary `ReadingPane`, and the existing view toggle/shortcut reveals the same
tab's `EditorPane` and Monaco model.

No Diary Reader header, Dialog, close X, Edit button, Editor Dialog, second
renderer, second Monaco, second raw copy or second persistence pipeline remains.

## FileTree exact-path context

`FileTree` accepts generic optional presentation props headed by
`exactPathFilter`. For `diary/2026-08-25`, its recursive projection retains only
the exact file plus ancestors required to render:

```text
diary
└── 2026-08-25
```

Path matching is strict equality. A missing exact path produces an empty tree,
never a full-tree fallback. Exact context takes precedence over text/tag search
without mutating the user's `filesFilter`; leaving context restores the original
query. Only projected ancestors are temporarily expanded.

The exact-filter implementation contains no DiaryDate parsing, Calendar logic,
`diary/` literal or filename policy. `FileTree` already imported Diary protocol
classification before this task for the REVIEW-CLOSED D2 mutation presentation
guard; this replacement neither adds to nor uses that domain guard for filtering.

The compact context action calls only Diary presentation close. It preserves
route, activePath, backing tab, raw, dirty state and the user's panel/search
preferences. FileTree remains under the existing ActivityBar panel owner; this
task does not force or persist a panel selection.

## Calendar lifecycle and reconciliation

`isDiaryCalendarMounted = isDiaryScope` remains unchanged. DOCUMENT hides the
Calendar via presentation visibility but does not unmount the subtree. Returning
HOME restores the same month and semantic date focus.

| Event | Existing lifecycle result | Diary presentation result |
| --- | --- | --- |
| successful date click | exact tab becomes active; route follows existing flow | DOCUMENT + READ |
| missing future/error/stale intent | no adopted document | HOME |
| Calendar Home action | route/tab/activePath/raw/dirty unchanged | HOME; exact filter null; date focus restored |
| native view toggle | same tab/model READ <-> EDIT | DOCUMENT unchanged |
| activePath changes away | Router/tab owner reconciles | passive HOME; no retarget |
| another Diary becomes active | existing tab becomes active | HOME; must click Calendar to adopt |
| backing tab actually closes | existing dirty policy applies | HOME |
| Browser Back | Vue Router -> useRouteSync -> activePath | mismatch observed -> HOME |
| scope exit | existing documents remain lifecycle-owned | HOME/reset |
| History/Diff/Recovery | special surface owns precedence | HOME; exact context clear; Calendar remains mounted in Diary scope |
| same date reopened | existing tab/document identity reused | DOCUMENT + READ; unsaved raw preserved |

Presentation close does not call `router.back()`, `router.replace()`,
`closeTab()`, save, discard or dirty confirmation. Browser Back remains a real
router transition and is not intercepted.

## Native chrome and responsive result

In DOCUMENT, ordinary EditorTabs, FileTree, ReadingPane/EditorPane, StatusBar,
view-mode toggle and RightRail behavior resume. Desktop/tablet preserve the
persisted native RightRail state. At phone widths (`max-width: 600px`), the
Diary exact-context FileTree is compact and the right rail is only visually
suppressed to prevent horizontal overflow; its persisted open/collapsed state is
not mutated and returns automatically at wider widths or outside this context.

Calendar visuals remain frozen: full-bleed/full-height, `YYYY-MM`, Prev/Next,
Today absent, 44x44 navigation targets, focus-visible ring, markers and spacing.

## Mobile collapsed side-panel follow-up

The original phone-width native-document selector always forced the four-column
mobile grid, even when the existing `useVaultLayout().sidePanelOpen` state was
false. That left the hidden side-panel and splitter tracks in the grid and
could constrain the native document to a narrow content column.

The follow-up adds only a `side-panel-open` class derived from the existing
`sidePanelOpen` ref on the Vault root. At `max-width: 600px` the two states are:

```text
side-panel-open:
40px ActivityBar + minmax(136px, 42vw) FileTree + 1px splitter + remaining document

not side-panel-open:
40px ActivityBar + remaining document
```

No second panel state, persistence change, forced Files selection, right-rail
state mutation or FileTree/Calendar semantics changed. The phone-only
right-rail rule remains visual suppression only, as in the original D6.3
replacement.

The final production-tree browser follow-up covered:

- 375x812 and 320x700 with Files open and with Files closed;
- closed-sidebar READ geometry starting after the 40px Activity Bar and
  reaching the viewport edge, with no phantom sidebar gap or horizontal
  overflow;
- native EDIT smoke while the side panel was closed;
- reopening Files through the existing ActivityBar action;
- exact selected Diary context restored, with the other seeded Diary absent;
- page errors = 0, unexpected console errors = 0, `dayIndex` errors = 0.

The existing FileTree filter-preservation tests remain part of the focused
regression run; this follow-up does not change the `filesFilter` model or exact
path matching.

## Test evidence

The preceding native-workspace replacement recorded 8 test files / 124 tests.
This mobile follow-up rerun on the final production tree was:

```text
4 test files PASS
80 tests PASS
```

Coverage includes HOME/DOCUMENT ownership, successful-command + exact active
path gate, stale intent, passive activePath/backing-tab/special-surface reset,
keep-mounted Workspace, exact FileTree projection/missing path/filter
preservation, VaultView native composition, Calendar command and ReadingPane.

Focused Chromium Playwright, run on the final production tree:

```text
e2e/diary-reader.spec.ts
e2e/diary-calendar-surface.spec.ts
e2e/diary-release.spec.ts

17 / 17 PASS
```

Browser evidence proves:

- existing, created today/past and pre-existing future enter native READ;
- missing future remains HOME;
- exact FileTree renders only the clicked Diary;
- ordinary ReadingPane count is one and no DiaryReaderDialog exists;
- existing view toggle enters the same tab/editor, and unsaved raw survives
  Calendar HOME plus same-date reopen;
- mobile native document mode fills the remaining viewport when the existing
  Files panel is closed at 375x812 and 320x700, and the panel reopens with the
  exact Diary context;
- Calendar Home action preserves route, activePath and tab and restores focus;
- real `page.goBack()` passively reconciles to HOME;
- ordinary note, archive and ledger retain native Vault behavior;
- five DOCUMENT/HOME cycles retain one tab and do not reproduce `dayIndex`;
- 1280x800, 768x1024, 375x812 and 320x700 have usable native surfaces and no
  horizontal document overflow;
- page errors = 0, unexpected console errors = 0, `dayIndex` errors = 0.

## Static validation

```text
npm run typecheck:client  PASS
npm run typecheck         PASS (client + server)
npm run build             PASS
git diff --check          PASS
```

Build emitted only existing dependency annotation/chunk-size warnings. No code
test was weakened into a historical assertion; all counts above are from this
replacement tree.

GitHub status was not queried. No CI PASS is claimed.

## Rollback

Runtime rollback to D6.2.1, newest to oldest:

```text
032b6ea0cde34ac7834bde45efdb70516c25fcf3
-> 592a1d5181edc84d1d66392f2c87fe8a2d4a23eb
-> fa85f431d274e36fccbeaa0446ed63cf0d017a36
-> d270ee5756c0f742e92955f06fa308fd6f77bc4a
-> ce3e08c514f50304d9b73f066191a22d5739c179
```

Documentation rollback is informational-only and is not asserted as an exact
runtime history chain.

## Self-review and conclusion

STOP conditions checked: none triggered. In particular, no router/server/shared
change, second lifecycle, extra presentation fetch, dirty-content loss,
FileTree domain hard-code, Calendar unmount, ordinary-scope regression,
`dayIndex` error or browser page error was found.

Task-scoped self-review:

```text
P0 = 0
P1 = 0
P2 = 0
```

Conclusion:

```text
D6.0   = REVIEW-CLOSED
D6.1   = REVIEW-CLOSED
D6.2   = REVIEW-CLOSED
D6.2.1 = REVIEW-CLOSED
D6.3   = REVIEW-CLOSED
D6.4   = NOT STARTED
```

Stop here for a new independent D6.3 review. Do not begin D6.4.
