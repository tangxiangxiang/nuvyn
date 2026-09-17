# Phase 3 — Primitive Foundation Validation Report

Date: 2026-09-08

## Status

Phase 3: inventory complete; eligible production migration batch is empty by
design.

Ready for Phase 4: pending the exact-head CI run for the commit containing
this report.

This phase establishes and applies the primitive decision boundary. It does
not force a replacement merely to increase the replacement count. Every
remaining native control is assigned to its owning later phase, retained as a
documented domain exception, or excluded as a test/fixture surface.

## Baseline

- Starting HEAD: `3624f91eb22212a150cac2ec3fb1567bd656b401`
  (`fix(test): await toast removal transition`).
- `github/main` matched the starting HEAD.
- Working tree was clean before the Phase 3 inventory.
- Phase 0: PASS.
- Phase 1: PASS; the production `NuvynUiRoot` provider/theme/locale
  foundation is already in place.
- Phase 2 implementation: PASS; the Toast, Confirm, and Prompt Host bridges
  remain unchanged in this phase.
- Phase 2 exact-head preflight remediation is included in the baseline:
  `cad99fb`, `11e0c09`, `f6b3b4d`, and `3624f91`.

The implementation plan, Phase 1 report, Phase 2 report, provider root, Naive
theme/token files, and Phase 2 feedback infrastructure were read before the
inventory.

## Preflight CI Gate

The Phase 2 gate was closed before this Phase 3 inventory started.

The original exact-head run for `5b0ca7f` failed only in macOS Draft Store
Isolation. The failure was an IndexedDB `VersionError` in the blocked-open
case. The SPA boot could recreate the version-2 database after the test's
delete request, so a later `open(name, 1)` observed an existing higher version.

The independent remediation commits were:

- `cad99fb` — delete the Draft Store database before SPA boot in the browser
  fixture, removing the startup recovery/delete race.
- `11e0c09` — preserve Nuvyn' original Prompt trigger across continuous
  Naive modal instances instead of allowing a stale `VFocusTrap` target to
  restore focus to a hidden input.
- `f6b3b4d` — await the intentionally retained Diary autosave before fixture
  cleanup deletes the document, removing the cleanup/PUT race.
- `3624f91` — wait for Naive's message leave transition before asserting that
  a dismissed Toast is absent on slower Windows DOM cleanup.

The final preflight exact-head run was `34170489306` for
`3624f91eb22212a150cac2ec3fb1567bd656b401`. It completed green across the
required Ubuntu 24, Ubuntu 22, Windows 24, and macOS 24 verify lanes, plus
visual, auth-browser, docker-smoke, and tags-scale. macOS Draft Store passed
in that run. No skip, optional failure, `continue-on-error`, or platform
bypass was used.

## macOS Draft Store Isolation Diagnosis

The diagnosis is retained here because it was the mandatory Phase 3
precondition. The bug was test lifecycle ordering, not a reason to weaken the
Draft Store assertion and not a Feedback Overlay feature regression. Local
evidence after the fix was:

- adjacent blocked-open tests: 2/2 passed;
- `npm run test:e2e:draft-store`: 38 passed;
- full browser suite: 174 passed, 7 skipped;
- the subsequent exact-head CI run above: all required jobs passed.

## Scope

Phase 3 scope is `Shared / low-risk primitives`. The implementation plan
assigns the controls found in this repository to later owners as follows:

- Phase 4: NavBar, Settings, Auth shared UI, account/menu/command surfaces;
- Phase 5: Diary access, mood, calendar, and Diary forms;
- Phase 6: Ledger forms, filters, tabs, date/datetime, and financial actions;
- Phase 7: Vault, Note, Markdown, history, draft recovery, AI, file tree,
  editor tabs, and visualization toolbars;
- test/fixture controls: retained as test controls, not production migration
  candidates.

The inventory therefore produces no safe unowned production control for this
phase. This is an intentional empty migration batch, not an incomplete grep
pass.

## Primitive Inventory

The inventory was run before any Phase 3 source edit with these searches:

```text
rg -n '<button|<input|<select|<textarea' src
rg -n 'role="checkbox"|role="radio"|type="checkbox"|type="radio"' src
rg -n 'toggle|switch|Switch' src
rg -n 'type="date"|type="datetime-local"|type="number"|type="search"|type="password"' src
rg -n '@click|@change|@input|@keydown|@keyup' src/components src/views
```

The Vue-template inventory contains 304 native tags:

| Source boundary | button | input | select | textarea | total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Production Vue templates | 209 | 47 | 21 | 7 | 284 |
| Test / compatibility fixtures | 20 | 0 | 0 | 0 | 20 |
| Vue inventory total | 229 | 47 | 21 | 7 | 304 |

There is one additional production HTML template emitted by
`src/lib/markdownCodeGroups.ts`: a native code-group tab button. It is a
Markdown-generated control rather than a Vue primitive and is deferred with
the Note/Markdown surface.

The special-control scan found five production native `type="date"` inputs,
two `type="datetime-local"` inputs, three number inputs, four checkboxes,
three search inputs, and seven password inputs. There are no native radio
inputs in production. The two `type="date"` occurrences in
`NaiveUiFoundationSpike.vue` are already `NDatePicker` fixture props, not
native date controls.

### Exhaustive per-file decision matrix

Counts are exact per Vue file in the form `button / input / select /
textarea`. The `contract` column records the behavior that must be preserved
when the owning phase eventually migrates the controls.

| File / component | Current primitive and semantic purpose | Category; interaction contract; risk | Phase 3 eligibility; target; decision and reason |
| --- | --- | --- | --- |
| `src/App.vue` | `2 / 0 / 0 / 0`; auth/identity bootstrap retry | Auth; async click/retry and route replacement; medium | Not eligible; `NButton`; Deferred to Phase 4 Auth shared UI |
| `src/components/MarkMap.vue` | `3 / 0 / 0 / 0`; lock, reset, fullscreen visualization toolbar | Note/visualization; icon-only click, focus-within reveal, fullscreen/pan lifecycle; high | Not eligible; `NButton`; Deferred to Phase 7 Note outer controls |
| `src/components/Mermaid.vue` | `5 / 0 / 0 / 0`; lock, zoom, reset, fullscreen visualization toolbar | Note/visualization; icon-only click, pan/zoom instance lifecycle, focus-within reveal; high | Not eligible; `NButton`; Deferred to Phase 7 Note outer controls |
| `src/components/NavBar.vue` | `7 / 0 / 0 / 0`; workspace navigation and global actions | Shared Chrome; route semantics, keyboard/menu actions, logout/lock async state; high | Not eligible; `NButton`/menu primitive as appropriate; Deferred to Phase 4 |
| `src/components/diary/DiaryAccessDialog.vue` | `2 / 2 / 0 / 0`; password setup/unlock form | Diary; submit, password v-model, busy/error/focus contract; high | Not eligible; `NButton`/`NInput`; Deferred to Phase 5 |
| `src/components/diary/DiaryCalendar.vue` | `2 / 0 / 0 / 0`; calendar navigation | Diary; calendar navigation and spatial layout; high | Not eligible; `NButton` only after calendar review; Deferred to Phase 5 |
| `src/components/diary/DiaryMoodContextAction.vue` | `1 / 0 / 0 / 0`; diary mood context action | Diary; contextual click and permission/session semantics; medium | Not eligible; `NButton`; Deferred to Phase 5 |
| `src/components/diary/DiaryMoodPicker.vue` | `3 / 0 / 0 / 0`; mood selection and actions | Diary; radio-like selection, keyboard/focus, v-calendar context; high | Not eligible; `NRadio`/`NButton` only after contract review; Deferred to Phase 5 |
| `src/components/ledger/LedgerAccountEditForm.vue` | `2 / 3 / 2 / 1`; account form, selects, opening date, note | Ledger; submit, string/number values, required fields, date-only and textarea; high | Not eligible; `NButton`/`NInput`/`NSelect`; Deferred to Phase 6 |
| `src/components/ledger/LedgerDashboard.vue` | `5 / 1 / 1 / 0`; dashboard action, period/date control, retry | Ledger; date semantics, select value, async refresh; high | Not eligible; `NButton`/`NSelect`, date remains native pending gate; Deferred to Phase 6 |
| `src/components/ledger/LedgerFirstAccountForm.vue` | `3 / 4 / 2 / 1`; first-account form and Ledger setup | Ledger; submit, number/string v-model, read-only currency, date-only, textarea; high | Not eligible; `NButton`/`NInput`/`NSelect`; date kept native; Deferred to Phase 6 |
| `src/components/ledger/LedgerInitializationForm.vue` | `1 / 1 / 1 / 0`; Ledger initialization | Ledger; submit, select and date authority; high | Not eligible; `NButton`/`NSelect`; date kept native; Deferred to Phase 6 |
| `src/components/ledger/LedgerNoActiveAccountState.vue` | `2 / 0 / 0 / 0`; account recovery/create actions | Ledger; async action and disabled restoring state; medium | Not eligible; `NButton`; Deferred to Phase 6 |
| `src/components/ledger/LedgerPendingCreateRecovery.vue` | `1 / 0 / 0 / 0`; pending create recovery | Ledger; async recovery action; medium | Not eligible; `NButton`; Deferred to Phase 6 |
| `src/components/ledger/LedgerTransactionDetailSheet.vue` | `6 / 0 / 0 / 0`; transaction detail actions | Ledger; sheet lifecycle, destructive semantics, disabled recovery; high | Not eligible; `NButton`; Deferred to Phase 6 |
| `src/components/ledger/LedgerTransactionEditForm.vue` | `2 / 3 / 4 / 1`; transaction edit form | Ledger; submit, typed account/category values, datetime-local, textarea; high | Not eligible; `NButton`/`NInput`/`NSelect`; datetime kept native pending gate; Deferred to Phase 6 |
| `src/components/ledger/LedgerTransactionSheet.vue` | `6 / 4 / 4 / 1`; transaction entry sheet and account/category controls | Ledger; tab-like entry type, form submit, typed selects, datetime-local, Enter category creation; very high | Not eligible; primitive mapping only after domain migration; Deferred to Phase 6 |
| `src/views/LedgerAccountDetailView.vue` | `4 / 0 / 0 / 0`; account detail/reload/archive actions | Ledger; async load and destructive/archive state; high | Not eligible; `NButton`; Deferred to Phase 6 |
| `src/views/LedgerAccountsView.vue` | `4 / 0 / 0 / 0`; account list/create/reload/restore | Ledger; async list lifecycle and recovery disabled state; high | Not eligible; `NButton`; Deferred to Phase 6 |
| `src/views/LedgerTransactionsView.vue` | `8 / 2 / 3 / 0`; transaction filters/list/load-more | Ledger; select value typing, date-only filters, row buttons, async pagination; very high | Not eligible; `NButton`/`NSelect`; date kept native; Deferred to Phase 6 |
| `src/views/LedgerView.vue` | `1 / 0 / 0 / 0`; Ledger bootstrap retry | Ledger; async bootstrap/retry; medium | Not eligible; `NButton`; Deferred to Phase 6 |
| `src/components/vault/AccountMenu.vue` | `4 / 0 / 0 / 0`; account menu items | Shared Chrome; roving focus/menuitem keyboard contract and auth actions; high | Not eligible; `NDropdown`/`NMenu` or direct primitive after Phase 4 review; Deferred to Phase 4 |
| `src/components/vault/ActivityBar.vue` | `3 / 0 / 0 / 0`; Vault pane activity navigation | Shared Chrome/Vault; pane selection and keyboard/focus contract; high | Not eligible; `NButton`; Deferred to Phase 4/7 boundary review |
| `src/components/vault/AiChatMessages.vue` | `1 / 0 / 0 / 0`; AI message action | Other Workspace; async AI/session action; medium | Not eligible; `NButton`; Deferred to Phase 7 |
| `src/components/vault/AiComposer.vue` | `3 / 0 / 0 / 1`; AI composer actions and message textarea | Other Workspace; textarea input, Enter/submit, busy/cancel; high | Not eligible; `NInput`/`NButton`; Deferred to Phase 7 |
| `src/components/vault/AiContextPicker.vue` | `2 / 1 / 0 / 0`; AI context picker/search | Other Workspace; search v-model, option keyboard/focus, async context; high | Not eligible; `NInput`/menu primitive; Deferred to Phase 7 |
| `src/components/vault/AiPanel.vue` | `2 / 0 / 0 / 0`; AI panel actions | Other Workspace; panel lifecycle and async actions; high | Not eligible; `NButton`; Deferred to Phase 7 |
| `src/components/vault/AiSessionPicker.vue` | `4 / 1 / 0 / 0`; AI session selection/create | Other Workspace; option keyboard/focus, input, async create/delete; high | Not eligible; `NInput`/menu primitive; Deferred to Phase 7 |
| `src/components/vault/AiToolCallCard.vue` | `1 / 0 / 0 / 0`; tool-call action | Other Workspace; async tool lifecycle; medium | Not eligible; `NButton`; Deferred to Phase 7 |
| `src/components/vault/CommandPalette.vue` | `1 / 1 / 0 / 0`; command search and create action | Shared Chrome/Vault; custom keydown navigation, focus, query/selection semantics; very high | Not eligible; `NInput`/`NButton` only after keyboard characterization; Deferred to Phase 4/7 |
| `src/components/vault/DocumentMetadataForm.vue` | `5 / 2 / 0 / 1`; metadata title/tags/summary form | Other Workspace; form submit, async transform, readonly/dirty/validation, textarea; high | Not eligible; `NInput`/`NButton`; Deferred to Phase 7 |
| `src/components/vault/DocumentMetadataModal.vue` | `1 / 0 / 0 / 0`; metadata modal close | Other Workspace; modal/focus lifecycle; medium | Not eligible; `NButton`; Deferred to Phase 7 |
| `src/components/vault/DraftRecoveryCenter.vue` | `6 / 1 / 0 / 0`; recovery selection and destructive actions | Other Workspace; checkbox set model, protected/delete/retry state; high | Not eligible; `NCheckbox`/`NButton`; Deferred to Phase 7 |
| `src/components/vault/DraftRecoveryPane.vue` | `5 / 0 / 0 / 0`; draft recovery actions | Other Workspace; recovery lifecycle and destructive action semantics; high | Not eligible; `NButton`; Deferred to Phase 7 |
| `src/components/vault/DraftRecoveryPrompt.vue` | `9 / 0 / 0 / 0`; draft recovery prompt actions | Other Workspace; prompt/modal focus, busy, destructive semantics; high | Not eligible; `NButton`; Deferred to Phase 7 |
| `src/components/vault/EditorTabs.vue` | `2 / 0 / 0 / 0`; editor tab context actions | Shared Chrome/Vault; tab/editor lifecycle and menu keyboard contract; very high | Not eligible; direct primitive only after lifecycle review; Deferred to Phase 7 |
| `src/components/vault/FileHistoryTimeline.vue` | `2 / 0 / 0 / 0`; history timeline actions | Shared Chrome/Vault; history loading and selection; high | Not eligible; `NButton`; Deferred to Phase 7 |
| `src/components/vault/FileTree.vue` | `1 / 1 / 0 / 0`; tree rename/input and action | Shared Chrome/Vault; tree focus, rename commit/cancel, file lifecycle; very high | Not eligible; `NInput`/`NButton`; Deferred to Phase 7 |
| `src/components/vault/HistoryChangesPanel.vue` | `6 / 1 / 0 / 1`; history mutation controls and message editor | Other Workspace; checkbox, textarea, mutation lock, async repair; very high | Not eligible; `NCheckbox`/`NInput`/`NButton`; Deferred to Phase 7 |
| `src/components/vault/HistoryComparisonPane.vue` | `6 / 0 / 0 / 0`; history context menu/actions | Other Workspace; menuitem focus and destructive action semantics; high | Not eligible; `NButton`/menu primitive; Deferred to Phase 7 |
| `src/components/vault/HistoryPanel.vue` | `2 / 0 / 0 / 0`; history refresh/context action | Other Workspace; menuitem/focus and history lifecycle; high | Not eligible; `NButton`; Deferred to Phase 7 |
| `src/components/vault/LinksPanel.vue` | `2 / 0 / 0 / 0`; linked-document navigation | Other Workspace; navigation selection and document lifecycle; high | Not eligible; `NButton`; Deferred to Phase 7 |
| `src/components/vault/RightRail.vue` | `6 / 0 / 0 / 0`; right-rail tabs and controls | Shared Chrome/Vault; tab ARIA contract, routing/selection, focus; high | Not eligible; direct primitive only after tab characterization; Deferred to Phase 4/7 |
| `src/components/vault/RightRailHistory.vue` | `1 / 0 / 0 / 0`; history retry | Other Workspace; async history lifecycle; medium | Not eligible; `NButton`; Deferred to Phase 7 |
| `src/components/vault/SettingsAiSection.vue` | `4 / 3 / 1 / 0`; AI settings form | Settings; password/input/select, async save/test, validation; high | Not eligible; `NInput`/`NSelect`/`NButton`; Deferred to Phase 4 |
| `src/components/vault/SettingsDiaryMigrationSection.vue` | `12 / 0 / 0 / 0`; Diary migration workflow | Settings/Diary domain; multi-step async workflow and destructive actions; very high | Not eligible; `NButton`; Deferred to Phase 4/5 |
| `src/components/vault/SettingsEditorSection.vue` | `1 / 6 / 1 / 0`; numeric/editor settings and toggles | Settings; number coercion, min/max, select number model, boolean checkbox; high | Not eligible; `NInput`/`NSelect`/`NCheckbox`/`NButton`; Deferred to Phase 4 |
| `src/components/vault/SettingsMetadataSection.vue` | `3 / 0 / 0 / 0`; metadata settings actions | Settings; async preview/reset and action state; medium | Not eligible; `NButton`; Deferred to Phase 4 |
| `src/components/vault/SettingsModal.vue` | `2 / 0 / 0 / 0`; settings modal navigation/close | Settings; modal focus/lifecycle and section navigation; high | Not eligible; `NButton`/menu primitive; Deferred to Phase 4 |
| `src/components/vault/StatusBar.vue` | `10 / 0 / 0 / 0`; external-change resolution actions | Shared Chrome/Vault; async conflict resolution and icon-only labels; high | Not eligible; `NButton`; Deferred to Phase 4/7 |
| `src/components/vault/TagManagementPanel.vue` | `14 / 3 / 2 / 0`; tag management workflow | Other Workspace; search, checkbox/select filters, form/async synchronization; very high | Not eligible; `NInput`/`NSelect`/`NCheckbox`/`NButton`; Deferred to Phase 7 |
| `src/components/vault/TagPanel.vue` | `3 / 1 / 0 / 0`; tag filter and result navigation | Other Workspace; keydown filter, option selection, document navigation; high | Not eligible; `NInput`/`NButton`; Deferred to Phase 7 |
| `src/components/vault/TimelineCommitRow.vue` | `1 / 0 / 0 / 0`; commit timeline row | Shared Chrome/Vault; row selection/history lifecycle; medium | Not eligible; `NButton`; Deferred to Phase 7 |
| `src/components/vault/TimelineFileCommitRow.vue` | `1 / 0 / 0 / 0`; file commit row | Shared Chrome/Vault; row selection/history lifecycle; medium | Not eligible; `NButton`; Deferred to Phase 7 |
| `src/components/vault/TimelineFileRow.vue` | `1 / 0 / 0 / 0`; file timeline row | Shared Chrome/Vault; row selection/history lifecycle; medium | Not eligible; `NButton`; Deferred to Phase 7 |
| `src/components/vault/TimelineGroup.vue` | `1 / 0 / 0 / 0`; timeline group action | Shared Chrome/Vault; grouping/selection lifecycle; medium | Not eligible; `NButton`; Deferred to Phase 7 |
| `src/components/vault/TreeRow.vue` | `8 / 0 / 0 / 0`; file-tree context menu actions | Shared Chrome/Vault; menuitem, keyboard shortcuts, delete/archive semantics; very high | Not eligible; menu/button primitive only after tree characterization; Deferred to Phase 7 |
| `src/components/vault/WorkingTreeDiffPane.vue` | `1 / 0 / 0 / 0`; diff retry | Other Workspace; async diff lifecycle; medium | Not eligible; `NButton`; Deferred to Phase 7 |
| `src/views/LoginView.vue` | `1 / 2 / 0 / 0`; login form/password | Auth; form submit, password v-model, loading/error/focus; high | Not eligible; `NInput`/`NButton`; Deferred to Phase 4 |
| `src/views/SetupView.vue` | `1 / 4 / 0 / 0`; setup/bootstrap form | Auth; form submit, password confirmation, validation/loading; high | Not eligible; `NInput`/`NButton`; Deferred to Phase 4 |
| `src/ui/__tests__/fixtures/FeedbackOverlayHarness.vue` | `12 / 0 / 0 / 0`; overlay/theme/locale test triggers | Playground/Test; deterministic click hooks for Phase 2 harness | Not a production candidate; native buttons Kept to preserve fixture intent |
| `src/components/diary/__tests__/VCalendarCompatibilityProbe.vue` | `8 / 0 / 0 / 0`; v-calendar compatibility probe controls | Playground/Test; calendar, locale, theme, and week-start probes | Not a production candidate; native buttons Kept to isolate v-calendar behavior |
| `src/lib/markdownCodeGroups.ts` | one generated native `<button>`; Markdown code-group tab | Note/Markdown; delegated tab click, ARIA/tabindex/code-group lifecycle; high | Not eligible; remains generated native HTML; Deferred to Phase 7 |

## Inventory Summary by Category

| Category | Vue files | button | input | select | textarea | total | Phase owner / decision |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Auth | 3 | 4 | 6 | 0 | 0 | 10 | Phase 4; Deferred |
| Settings | 5 | 22 | 9 | 2 | 0 | 33 | Phase 4; Deferred |
| Diary | 4 | 8 | 2 | 0 | 0 | 10 | Phase 5; Deferred |
| Ledger | 13 | 45 | 18 | 17 | 4 | 84 | Phase 6; Deferred |
| Shared Chrome / Vault | 15 | 49 | 2 | 0 | 0 | 51 | Phase 4 or 7; Deferred |
| Other Workspace | 18 | 73 | 10 | 2 | 3 | 88 | Phase 7; Deferred |
| Note / visualization | 2 | 8 | 0 | 0 | 0 | 8 | Phase 7; Deferred |
| Playground / Test | 2 | 20 | 0 | 0 | 0 | 20 | Excluded; Kept |
| **Vue total** | **62** | **229** | **47** | **21** | **7** | **304** | |

The category table includes the two fixture files in the Vue total. The
production-only Vue total is 284; the generated Markdown tab is tracked
separately above.

## Inventory Summary by Decision

| Decision | Count | Meaning in this phase |
| --- | ---: | --- |
| Replaced | 0 | No production control met the Phase 3 ownership and low-risk gate. |
| Adapted | 0 | No production control needed a Phase 3-only compatibility adapter. |
| Kept | 20 Vue fixture controls | Test/compatibility fixtures intentionally keep native buttons. |
| Deferred | 284 production Vue controls + 1 generated Markdown button | Each has an explicit later owner or domain contract. |

`Kept` is also the planned date exception for the five production native
date-only inputs and the two native datetime-local inputs when their owning
Ledger phase is evaluated; they are not converted mechanically to
`NDatePicker` in Phase 3.

## Migration Mapping

The canonical mapping remains:

| Existing semantic control | Event/data contract to preserve | Target when its owning phase opens |
| --- | --- | --- |
| Native button | `type`, submit/reset behavior, disabled/loading, aria/title, click modifiers, focus, test hooks | `NButton` |
| Text input | string v-model/update, blur/Enter/IME, readonly/disabled, maxlength/placeholder | `NInput` |
| Textarea | string v-model, rows/autosize, Enter/IME, disabled/readonly | `NInput type="textarea"` |
| Select | exact string/number/null value, options, placeholder, clearability, keyboard/focus | `NSelect` |
| Checkbox | boolean or collection model, indeterminate, label association, keyboard | `NCheckbox` |
| Radio-like control | group/value/keyboard semantics | `NRadio` / `NRadioGroup` |
| Toggle | exact boolean model and disabled state | `NSwitch` |
| Date/date-time | calendar date, timezone, serialization, min/max, empty/null, keyboard | `NDatePicker` only after a domain gate; otherwise native control remains |

No `DButton`, `DInput`, `DSelect`, second provider, second theme, or new UI
library was added. Existing Phase 1 provider/theme/token infrastructure and
the Phase 2 Host bridges are untouched.

## Files Changed

Phase 3 production code files changed: none.

Phase 3 documentation file:

- `docs/design/nuvyn-naive-ui-foundation-phase3-primitive-foundation-validation-report.md`

This small diff is intentional: the inventory proved that every production
candidate belongs to a later frozen boundary, so introducing a speculative
replacement would violate the phase scope.

## Shared Primitive Changes

No Shared Chrome or Auth control was migrated. The implementation plan names
NavBar, Settings, Auth shared UI, and global command surfaces as Phase 4;
moving them now would make the phase boundary ambiguous. The existing
`PromptHost` use of `NInput`/`NButton` is a Phase 2 implementation and remains
unchanged.

## Date Input Decisions

The five production native `type="date"` inputs and two
`type="datetime-local"` inputs are all Ledger domain controls. They carry
calendar-date, Ledger-timezone, server-serialization, and/or datetime-local
semantics. They remain native until the Ledger phase can prove the complete
`selected calendar date → YYYY-MM-DD` and datetime contract without browser
local-time interpretation. The two date props in the Naive foundation fixture
are already `NDatePicker` probes and are not migration candidates.

## Behavioral Invariants

Because no production control was changed, there is no Phase 3 behavior
delta. The following contracts remain protected for the owning phases:

- native form submit/reset and Enter behavior;
- Vue native event/value contracts versus Naive `update:value` contracts;
- exact string/number/null select values;
- boolean, collection, radio-group, and disabled models;
- keyboard, focus, menuitem/tab roles, aria labels, titles, and test hooks;
- existing Phase 2 Toast/Confirm/Prompt queue, settlement, focus, and
  overlay lifecycle behavior.

## Styling / Theme Invariants

No component CSS, global selector, provider hierarchy, theme override, token,
locale, z-index, Teleport, or focus authority was changed. No `:deep(.n-*)`
rule and no global Naive primitive rule was introduced.

## Out-of-Scope Controls

Deferred controls include all Ledger financial/date/datetime controls, Diary
calendar/access/mood controls, NavBar and Auth forms, Settings forms,
CommandPalette and FileTree keyboard surfaces, EditorTabs/RightRail/StatusBar,
Draft Recovery, History, Tags, AI, Document Metadata, Markdown code tabs, and
Mermaid/MarkMap toolbars. This is consistent with the implementation plan's
Phase 4–7 ownership and the explicit “when uncertain, defer” rule.

## Tests Added / Updated

No tests were added or updated because no production primitive was migrated.
The existing inventory and preflight fixes were validated without changing
the Phase 2 test surface.

## Validation Commands

Canonical commands were taken from `package.json` and
`.github/workflows/ci.yml`, not inferred. The preflight code baseline passed:

- `npm run typecheck`
- `npm run build`
- `npm test`
- `npm run test:e2e`
- `npm run test:e2e:draft-store`
- `npm run test:e2e:auth`
- `npm run test:feedback-overlay`
- `npm run test:ui-foundation-spike`
- `npm run lint:icons` (known pre-existing violations only)
- `git diff --check`

The final documentation commit has no source/runtime diff. Its exact-head CI
run is still a required gate and is recorded below once GitHub reports the
immutable commit result.

## Validation Results

- Inventory commands: PASS; complete matrix above.
- Phase 2 preflight local tests: PASS; see preflight evidence above.
- Phase 2 preflight exact-head CI: PASS; run `34170489306`.
- Phase 3 production migration tests: NOT APPLICABLE; no production
  migration was made.
- Final exact-head CI for the documentation commit: PENDING at report
  creation.

## Manual Smoke Test

No Phase 3 production surface changed, so no new manual UI surface was
introduced. The Phase 2 preflight browser smoke and visual lanes passed. A
future Phase 4 smoke must cover the actual Shared Chrome/Auth controls before
they are migrated.

## Exact-Head CI

Phase 2 preflight evidence:

```text
HEAD:    3624f91eb22212a150cac2ec3fb1567bd656b401
Run:     34170489306
Attempt: completed green (run metadata to be rechecked with the final run)
Ubuntu:  PASS (Node 24 and Node 22)
Windows: PASS (Node 24)
macOS:   PASS (Node 24, including Draft Store)
Overall: PASS
```

Phase 3 final documentation commit:

```text
HEAD:    pending commit SHA
Run:     pending
Attempt: pending
Ubuntu:  pending
Windows: pending
macOS:   pending
Overall: pending
```

The final handoff must not mark Phase 3 complete or Ready for Phase 4 until
the second block is replaced by an exact-head green result.

## Known Risks

- The inventory counts source controls, not visual equivalence. Each later
  phase must re-check current CSS density and use `compact → small` or
  `default → medium` deliberately.
- Native date and datetime controls intentionally remain exceptions until
  Ledger proves timezone/serialization compatibility.
- The later Vault/Note migration must characterize keyboard and lifecycle
  contracts before touching FileTree, EditorTabs, CommandPalette, or
  visualization toolbars.
- Existing build warnings and icon-lint baseline exceptions are unchanged;
  no Phase 3 file added a new one.

## Deferred Work

Phase 4 owns Shared Chrome, Settings, Auth shared UI, and global command
surfaces. Phase 5 owns Diary. Phase 6 owns Ledger, including its date gate.
Phase 7 owns Vault/Note and Markdown outer controls. Phase 8 owns legacy
primitive CSS cleanup after all workspace migrations.

## Phase 3 Exit Criteria

- [x] Implementation plan and prior phase reports read.
- [x] Phase 2 exact-head CI preflight closed green.
- [x] Complete primitive inventory performed before source edits.
- [x] Every candidate has a category, contract, risk, target, decision, and
  reason.
- [x] No Workspace/domain control was migrated early.
- [x] Date controls received an explicit gate and remain native where
  required.
- [x] No second provider, wrapper layer, UI library, or unrelated redesign
  was introduced.
- [x] Post-inventory result is explainable: all production candidates are
  deferred to an owning phase; fixtures remain test-native.
- [ ] Final documentation commit exact-head CI is green.

## Ready for Phase 4

NO until the final documentation commit's exact-head CI is green. Once that
immutable SHA passes every required CI lane, this Phase 3 report's intentional
empty migration batch is complete and Phase 4 may start.
