# D6 — Diary Home Workspace Implementation Plan

> **Historical implementation lineage — not current runtime authority.** Use
> [Diary Architecture](../architecture/diary.md) and [Diary User
> Guide](../user-guide/diary.md) for current behavior. This file records the
> closed D6 implementation plan and evidence.

状态：`REVIEW-CLOSED`（原始 D6 design baseline）；Native Document Workspace superseding design amendment = `REVIEW-CLOSED`，Independent Review = `PASS`（P0/P1/P2 = 0/0/0）。D6.4 closure review = `PASS`（P0/P1/P2 = 0/0/0）。

基线：D6.0–D6.7 `REVIEW-CLOSED`。旧 D6.3 Reader Dialog implementation 在 closure 前被产品决定替代；D6.5 生命周期回归、D6.6 responsive/accessibility evidence 与 D6.7 release closure evidence 均已记录并通过独立复审，P0/P1/P2 = `0/0/0`。整个 D6 已正式关闭。

这里的 `REVIEW-CLOSED` 同时覆盖原始 D6 implementation-plan baseline 与已通过独立复审的 2026-08-26 Native Workspace superseding amendment。

日期：2026-08-26（Asia/Shanghai）

## 1. Superseding architecture

Canonical implementation direction：

```text
Calendar
  -> existing openDiaryDate()
  -> existing openPost()/tab lifecycle
  -> native Vault ReadingPane
  <-> native EditorPane through existing viewMode

FileTree
  -> generic exactPathFilter for the selected Diary context
```

旧 Reader/Editor Dialog architecture 只保留历史 evidence，不再实施。Calendar does navigation; Vault does documents.

## 2. Ownership matrix

| Concern | Owner | D6.3 allowed change | Forbidden change |
| --- | --- | --- | --- |
| Router/history | existing Vue Router | observe resulting path | new route、popstate、fake history |
| Diary scope | existing `useScopeFilter` | read `isDiaryScope` | second scope store |
| Calendar mount | `VaultView` | keep `isDiaryScope` predicate | document-triggered unmount |
| Calendar visibility | Diary presentation | HOME only | tab-count ownership |
| Date command | existing `openDiaryDate()` | consume result | second create/open command |
| Tabs/activePath | existing tab workspace | observe and reconcile | presentation mutation/clone |
| READ/EDIT | existing `VaultViewModeKey` | set READ after date success | Diary reader/editor mode |
| Raw/model/save/dirty | existing tab/editor lifecycle | reuse | duplicate state or pipeline |
| Reader | existing `VaultView` `ReadingPane` | native visibility | DiaryReader/second renderer |
| Editor | existing `EditorPane` / Monaco | native visibility | DiaryEditor/second Monaco |
| History/Recovery/Draft | existing Vault lifecycle | preserve precedence | copied state/workflow |
| FileTree filtering | generic FileTree prop | exact path + ancestors | DiaryDate/domain parsing |
| Calendar return | Diary presentation | HOME + focus restore | route/tab/dirty mutation |

## 3. State model

Use the minimum presentation model:

```ts
type DiaryPresentationMode = 'home' | 'document'
```

Presentation may own `selectedDiaryDate`, `backingPath`, `focusReturnTarget`, `dateIntentEpoch` and eligibility. It must not own Reader/Editor mode, raw, tab, activePath, save, dirty, History, Recovery or route.

`document` opens only after an explicit successful Calendar command and `activePath === result.path`. `activePath` may reset a stale document presentation but may never open one.

## 4. Command flow

```text
DiaryCalendar date-selected
  -> DiaryCalendarSurface forward
  -> VaultView.onDiaryDateSelected(date)
  -> begin date intent epoch
  -> await existing openDiaryDate(date)
  -> existing openPost() completes
  -> verify intent/current scope/eligibility
  -> record result
  -> verify opened|created and activePath === result.path
  -> presentation DOCUMENT
  -> existing viewMode.set('read')
```

No extra fetch, `getPost`, create or `openPost()` is allowed after the command result.

## 5. FileTree exact-path seam

Add a generic optional prop equivalent to:

```ts
exactPathFilter?: string | null
```

Semantics:

- null: current scope/search/tag behavior unchanged;
- non-null: recursively retain only `node.path === exactPathFilter` and required ancestor folders;
- exact filter has precedence over text/tag query without mutating its model value;
- missing exact path produces empty filtered tree, never full-tree fallback;
- exact context forces required ancestors visible without persisting expansion changes;
- FileTree does not parse Diary dates or hard-code Diary paths for this filter.

VaultView derives the prop only when Diary scope + presentation DOCUMENT + backing path are active.

## 6. Native document presentation

When presentation is DOCUMENT:

- `isDiaryPresentationPrimary` is false;
- ordinary `EditorTabs` render;
- ordinary READ `ReadingPane` renders exactly once;
- existing EDIT `EditorPane` renders through global view mode;
- FileTree, RightRail and StatusBar follow native Vault rules;
- Calendar remains attached but hidden.

Remove Reader slot/runtime, `DiaryReaderDialog`, Reader-only CSS and unused Reader i18n. Do not mount `ReadingPane` inside `DiaryWorkspace`.

## 7. Calendar Home action

Provide a compact FileTree context for the exact Diary path with selected date and a “返回日历” action. It calls only presentation `closePresentation()` / `showHome()` and semantic Calendar focus restoration.

It must not call router navigation, `closeTab()`, change `activePath`, discard/save, or clear the user search model. On HOME the exact prop becomes null and D6.2.1 layout hides FileTree as before.

## 8. Reconciliation

| Event | Document lifecycle result | Diary presentation result |
| --- | --- | --- |
| date success | backing tab active | DOCUMENT + READ |
| date failure/future/stale | no adopted document | HOME |
| Calendar Home action | unchanged | HOME, exact filter cleared, focus restored |
| view toggle | same tab/model | DOCUMENT remains, READ ⇄ EDIT native |
| activePath changes away | existing lifecycle authoritative | passive HOME; no auto-open |
| another Diary becomes active | existing lifecycle authoritative | HOME; no filter retarget |
| backing tab closes | existing dirty policy | HOME |
| Browser Back | Router/useRouteSync reconcile | observe mismatch -> HOME |
| scope exit | tabs remain lifecycle-owned | reset HOME |
| History/Diff/Recovery | special surface active | reset HOME, exact cleared, Calendar mounted |
| same date reopened | existing tab reused | DOCUMENT + READ; unsaved raw preserved |

## 9. Phase breakdown

### D6.0 — Architecture Confirmation

Status: `REVIEW-CLOSED`.

### D6.1 — Diary Workspace Shell

Status: `REVIEW-CLOSED`. Its presentation owner and Calendar keep-mounted seam remain; Reader/editor future seams are superseded where applicable.

### D6.2 — Calendar Home Migration

Status: `REVIEW-CLOSED`.

### D6.2.1 — Full-Bleed Calendar Polish

Status: `REVIEW-CLOSED`. Visual contract frozen.

### D6.3 — Native Document Workspace Handoff

Status: `REVIEW-CLOSED`; production/tests/canonical evidence complete, Independent Review PASS (P0/P1/P2 = 0/0/0).

Deliverables:

- remove Diary Reader Dialog runtime/component/tests/dead CSS;
- simplify presentation to HOME/DOCUMENT;
- successful Calendar result enters native READ;
- add generic FileTree exact-path constraint and compact Calendar return affordance;
- preserve filters, backing tab, route, activePath and dirty state;
- prove native Reader/Edit, Browser Back, repeated cycles and responsive matrix;
- mark old Reader evidence SUPERSEDED and create canonical replacement evidence.

### D6.4 — Native Editor Lifecycle Verification

Status: `REVIEW-CLOSED`.

Evidence: [D6.4 Native Editor Lifecycle Verification](diary-home-workspace-d6.4-native-editor-lifecycle.md).

Starting HEAD: `e550c1873d77ddfd95b96d87cff935130b09c662`.

The focused browser evidence verifies the same Diary backing tab through
native READ -> existing EDIT -> save/dirty/History Comparison/History
Restore/baseline Recovery/divergent Recovery/external changes -> Calendar Home
-> same-date reopen. It records 6/6 dedicated Chromium tests, 60/60 focused
presentation/VaultView unit tests, 17/17 D6.2/D6.3 regression tests, 2/2
existing generic long-flow tests, client/full typecheck and build PASS. No
production code, generic lifecycle owner, route, server/shared contract or
dependency changed. No Editor adapter or new lifecycle is allowed. Independent
review passed with P0/P1/P2 = 0/0/0. At D6.4 closure D6.5 was not started; the subsequent D6.5 evidence is recorded below.

### D6.5 — Lifecycle Regression

Status: `REVIEW-CLOSED`; implementation/test evidence complete; Independent Review = `PASS`; P0/P1/P2 = `0/0/0`.

Evidence: [D6.5 Lifecycle Regression](diary-home-workspace-d6.5-lifecycle-regression.md).

Starting HEAD: `6d0aa02b1632c7572bd877a8cc43f65794f54bb8`.

Test commits: `06ffb2e` (`test(diary): verify D6.5 lifecycle regressions`) and
`a34d622` (`test(diary): cover non-active tab lifecycle`).

The dedicated Chromium suite passes 7/7 scenarios covering scope exit and
re-entry, manual multi-tab selection, tab close/fallback/reopen, clean refresh,
non-active tab close, direct Diary deep links and real Browser Back/Forward. The presentation and
generic tab/document unit set passes 163/163 tests; existing Diary/VCalendar/D4
browser regressions pass 23/23. Client/full typecheck, build and diff checks
pass. Only the two test files and the linked evidence/docs are changed; no
production, server/shared, route, dependency or D6.6 code is included.

### D6.6 — Responsive / Accessibility

Status: `REVIEW-CLOSED`; Independent Review = `PASS`; P0/P1/P2 = `0/0/0`.

Evidence: [D6.6 Responsive / Accessibility](diary-home-workspace-d6.6-responsive-accessibility.md).

Starting HEAD: `ced273aefd941f0f568e5c22b66e482762718f4c`.

Test commit: `dbb765977d04f3afae35584e8a91c8abbf651196`; keyboard accessibility fix
commit: `feafa20d93b423901a52d851e846c9f10da4f794`.

The dedicated Chromium suite passes 8/8 scenarios across Calendar Home, Native
READ/EDIT, exact FileTree context, keyboard focus/shortcuts, English/Chinese labels,
light/dark behavior and repeated Calendar/document cycles. Calendar layout also
passes the 601/600 and 421/420 breakpoint smoke. The combined Diary browser
regressions pass 38/38; focused unit tests pass 104/104 across 6 files; client/full
typecheck and build pass. No `dayIndex`, pageerror or console error was observed.
The evidence records the two minimal keyboard fixes and confirms no router, server,
shared, dependency or D6.7 change. At D6.6 closure, D6.7 was `NOT STARTED`.

### D6.7 — Release Closure

Status: `REVIEW-CLOSED`; Final Independent Review = `PASS`; P0/P1/P2 = `0/0/0`.

Evidence: [D6.7 Release Closure](diary-home-workspace-d6.7-release-closure.md).

Starting HEAD: `df73e7f76bef0e1f8bcaa8f225f97f0724222ebd`.

Fresh release validation passes 39/39 Chromium tests across 7 Diary/VCalendar
files, 225/225 focused unit tests across 11 files, and 52/52 focused
domain/server tests across 3 files. Client/full typecheck and build pass. The
release audit confirms the closed D6.0–D6.6 lineage, superseded Reader Dialog
history, native READ/EDIT lifecycle, History/Recovery/external conflict,
scope/tab/route reconciliation, responsive/accessibility matrix, ordinary
note/archive/ledger behavior, exact FileTree context and VCalendar
keep-mounted boundary. D6.7 adds no production or test change and does not
start a later phase.

## 10. Testing strategy

### Unit/component

- presentation HOME/DOCUMENT transitions and stale intent epoch;
- successful result + activePath gate;
- activePath mismatch/backing close/scope/special-surface passive reset;
- activePath cannot open DOCUMENT;
- DiaryWorkspace hosts only keep-mounted Calendar Home;
- FileTree exact file + ancestors, missing exact path, null regression and filter preservation;
- VaultView native surface predicates and no Reader runtime.

### Browser

- existing date and today/past create -> native READ, one ReadingPane;
- future missing remains HOME; existing future opens native READ;
- two Diaries seeded: clicked one is the only rendered FileTree file;
- existing toggle enters same-tab EditorPane/Monaco;
- dirty edit -> Calendar Home -> same-date reopen preserves existing tab raw;
- Calendar Home action preserves route/activePath/tab and restores date focus;
- real `page.goBack()` reconciles to HOME without interception;
- five open/Home cycles keep Calendar attached and produce no `dayIndex`/pageerror;
- 1280×800、768×1024、375×812、320×700 native workspace smoke/no overflow;
- light/dark and zh/en compact context;
- ordinary note/archive/ledger smoke.

D6.6 adds the responsive/accessibility evidence document and dedicated browser suite;
its Dialog/modal/focus-trap requirements remain superseded by the Native Workspace
architecture. Independent Review passed with P0/P1/P2 = 0/0/0; D6.6 is
`REVIEW-CLOSED`. D6.7 is `REVIEW-CLOSED`; Final Independent Review = `PASS` with P0/P1/P2 = `0/0/0`. Entire D6 is formally closed.

### Validation commands

Run focused Diary presentation/FileTree/VaultView/Calendar Vitest, then:

```text
npm run typecheck:client
npm run typecheck
npm run build
git diff --check
```

Run focused Playwright for native Diary workspace, Calendar surface and Diary release/VCalendar regressions. Record actual file/test counts; do not inherit historical PASS.

## 11. Risks and STOP conditions

| Risk | Mitigation | STOP signal |
| --- | --- | --- |
| Reader/editor duplication | native Vault only | second ReadingPane/Monaco/pipeline required |
| Exact filter leaks Diary policy | generic path equality seam | FileTree must parse Diary domain |
| Dirty content loss | presentation-only HOME | raw lost, forced save/discard |
| Router ownership conflict | passive activePath reconciliation | new route/popstate/fake history required |
| Calendar runtime regression | scope mount + hidden visibility | unmount or `dayIndex`/pageerror |
| Search regression | exact layer does not mutate model | user filter overwritten |
| Ordinary Vault regression | focused note/archive/ledger tests | ordinary behavior changes |

Also STOP for server/shared/dependency change, `openDiaryDate()` ownership change, extra fetch, D6.4 implementation, or Calendar visual change.

## 12. Rollback

Runtime rollback to D6.2.1 must be newest to oldest:

```text
592a1d5181edc84d1d66392f2c87fe8a2d4a23eb
-> fa85f431d274e36fccbeaa0446ed63cf0d017a36
-> d270ee5756c0f742e92955f06fa308fd6f77bc4a
-> ce3e08c514f50304d9b73f066191a22d5739c179
```

Docs rollback is informational-only; it is not an asserted exact history chain.

## 13. D6.3 exit criteria

- [x] Old Reader evidence marked SUPERSEDED before closure.
- [x] New canonical D6.3 evidence created.
- [x] DiaryReaderDialog runtime absent.
- [x] Calendar success enters native READ through existing command/tab.
- [x] Exactly one existing ReadingPane; existing EditorPane/Monaco reused.
- [x] Generic exact-path FileTree renders only current Diary + ancestors.
- [x] User filter preserved.
- [x] Calendar return preserves route/activePath/tab/dirty and restores focus.
- [x] activePath mismatch cannot auto-open a Diary presentation.
- [x] Browser Back remains router-owned.
- [x] Calendar remains mounted; visual contract unchanged.
- [x] focused Vitest/E2E/typecheck/build/diff checks pass.
- [x] server/shared/router/dependencies unchanged.
- [x] task self-review P0/P1/P2 = 0/0/0.

At D6.3 closure, `D6.4 = NOT STARTED`; the subsequent D6.4 verification and
independent review are recorded in the evidence linked above. D6.4 is now
`REVIEW-CLOSED` with P0/P1/P2 = 0/0/0. At that closure point D6.5 was
`NOT STARTED`; D6.5 is now `REVIEW-CLOSED` with its own evidence linked above.

## 14. D6.4 exit criteria

- [x] Calendar date command reaches the existing native READ surface.
- [x] Existing READ -> EDIT toggle reaches the same native EditorPane/Monaco path.
- [x] Same backing tab, route, activePath, document identity and dirty raw survive Calendar Home.
- [x] Existing save and dirty confirmation behavior is verified separately from presentation Home.
- [x] Baseline-match Recovery is adopted by the native tab and saved through the existing owner.
- [x] Divergent Recovery reaches the existing prompt/diff, explicit disk resolution, and same-identity Calendar reopen.
- [x] History Comparison yields presentation from a dirty native Editor without mutating the live document.
- [x] History Restore completes through the existing owner and the same document identity reopens from Calendar.
- [x] External CAS conflict and existing Keep Local resolution remain native.
- [x] No duplicate Diary Editor, Monaco, raw, save, dirty, draft, History or Recovery pipeline exists.
- [x] Calendar remains mounted and no D3.0 `dayIndex`/pageerror regression was introduced.
- [x] Focused unit, browser regression, typecheck, build and diff checks pass.
- [x] No production code, generic lifecycle, route, server/shared contract or dependency changed.
- [x] Task-scoped self-review P0/P1/P2 = 0/0/0.

The D6.4 browser evidence uses the existing `view-toggle` control for the
READ/EDIT transition. A new browser assertion for `Cmd+E` is intentionally
deferred to D6.6 keyboard/accessibility coverage.

These criteria passed: `D6.4 = REVIEW-CLOSED`, Independent Review = `PASS`,
and P0/P1/P2 = 0/0/0. At D6.4 closure D6.5 was `NOT STARTED`; the current
D6.5 lifecycle evidence is tracked in its own section and has passed
independent review with P0/P1/P2 = 0/0/0.
