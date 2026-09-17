# Nuvyn Naive UI Foundation — Phase 6 Full Naive Cutover Validation Report

Status at report freeze: local continuation validation complete; final exact-head CI is pending the final pushed SHA. This report is a new continuation report. The original `docs/design/nuvyn-naive-ui-foundation-phase6-ledger-validation-report.md` remains unchanged and is immutable evidence of the first Phase 6 pass.

## Continuation baseline

- Repository: `/Users/txx/nuvyn`
- Remote used for validation: `github` (`github.com/tangxiangxiang/nuvyn.git`)
- Continuation baseline: `85b01ff86551b523fa4339d89511f8039776362e` — `docs: add Phase 6 Ledger validation report`
- Baseline exact-head CI: run `34198057439`, attempt `1`, head `85b01ff86551b523fa4339d89511f8039776362e`, completed successfully with all required jobs green.
- Continuation implementation commits before this report: `05f0dcfb` (`feat: complete Ledger full Naive UI cutover`) and `897fcbae` (`test: complete Ledger browser timezone matrix`).
- The phase was reopened because the previous pass intentionally retained seven native date/datetime controls and two native domain-control templates. The new acceptance rule requires zero native interactive controls in Ledger production surfaces.
- No package, lockfile, server API, store, money, recovery, CAS, router, or ECharts dependency changes were made.

## Full surface inventory

| File / surface | Previous structure | Naive target | Domain authority | Interaction authority | Final decision |
| --- | --- | --- | --- | --- | --- |
| `LedgerFirstAccountForm.vue`, `LedgerAccountEditForm.vue` account forms | Native form fields, selects, and date inputs | `NForm`/`NFormItem`, `NInput`, `NSelect`, `LedgerDatePicker` (`NDatePicker`), `NButton` | Existing account validation, opening-date string, money parser, account CAS | Naive controls plus real form submit | Replaced / Composed |
| `LedgerInitializationForm.vue` settings form | Native field wrappers and select | `NForm`/`NFormItem`, `NSelect`, `NAutoComplete`, `NAlert`, `NButton` | Existing settings validation and recovery intent | Naive controls plus real form submit | Replaced |
| `LedgerTransactionSheet.vue` create form | Custom fields and native transaction tabs/date-time input | `NModal` + `NCard`, `NTabs`/`NTab`, `NForm`/`NFormItem`, `NInput`, `NSelect`, `LedgerDateTimePicker`, `NButton` | Existing draft reset, money parser, Ledger timezone, recovery, CAS-free create path | Naive overlay and public component refs; Nuvyn `requestClose` | Replaced / Composed |
| `LedgerTransactionDetailSheet.vue` detail/edit sheet | Custom Teleport shell, native field wrappers, native date-time input | `NModal` + `NCard`, `NStatistic`, `NDescriptions`, `NAlert`, `NForm`/`NFormItem`, `LedgerDateTimePicker`, `NButton` | Existing transaction read/edit/delete/restore logic and CAS | Naive overlay; Nuvyn dirty-close authority | Replaced / Composed |
| `LedgerTransactionEditForm.vue` edit fields | Native form wrappers and native date-time input | `NForm`/`NFormItem`, `NInput`, `NSelect`, `LedgerDateTimePicker`, `NButton` | Existing financial validation, account recheck, timezone conversion, patch payload | Naive controls plus real form submit | Replaced / Composed |
| `LedgerDashboard.vue` metrics and period toolbar | Custom cards, date input, select, state blocks | `NCard`, `NStatistic`, `LedgerDatePicker`, `NSelect`, `NAlert`, `NSpin`, `NEmpty`, `NList`/`NListItem` | Existing overview/store request context and financial calculations | Naive controls; RouterLink for navigation; ECharts for trend | Replaced / Adapted |
| `LedgerDashboard.vue` account/category/recent sections | Custom list-like divs and empty blocks | `NCard`, `NList`/`NListItem`, `NEmpty` | Existing overview/category/account data | RouterLink remains navigation authority | Replaced |
| `LedgerTransactionsView.vue` filters/history | Native date/filter controls and button rows | `NCard`, `NForm`/`NFormItem`, `NSelect`, `LedgerDatePicker`, `NAlert`, `NSpin`, `NEmpty`, `NList`/`NListItem`, `NButton` | Existing query construction, Ledger date boundaries, transaction store | Public roles, test IDs, Naive controls | Replaced / Composed |
| `LedgerAccountsView.vue`, `LedgerAccountDetailView.vue` | Custom state/card/list wrappers | `NCard`, `NList`/`NListItem`, `NStatistic`, `NAlert`, `NSpin`, `NEmpty`, `NResult`, `NButton` | Existing account lifecycle, history locks, restore/archive CAS | RouterLink and Naive actions | Replaced |
| `LedgerView.vue` bootstrap states | Custom loading/error blocks | `NSpin`, `NResult`, `NButton` | Existing bootstrap/retry state machine | Naive action and router-owned navigation | Replaced |
| `LedgerNoActiveAccountState.vue`, `LedgerPendingCreateRecovery.vue` | Custom recovery/empty blocks | `NCard`, `NAlert`, `NEmpty`, `NList`/`NListItem`, `NButton` | Existing pending intent, idempotency, retry, and blocking rules | Naive actions | Replaced |
| `LedgerCashflowTrend` / ECharts | ECharts renderer | No Naive equivalent | Existing chart data/configuration | ECharts | Not applicable — ECharts |

The final production surface contains no literal native `button`, `input`, `select`, or `textarea` templates. `main`, `section`, `header`, `form`, `label`, and other document containers remain semantic HTML. `RouterLink` remains the routing authority.

## Native control zero gate

Command:

```bash
rg -n '<(button|input|select|textarea)\b' \
  src/components/ledger \
  src/views/LedgerView.vue \
  src/views/LedgerAccountsView.vue \
  src/views/LedgerAccountDetailView.vue \
  src/views/LedgerTransactionsView.vue
```

Result: no production matches (the command exits with `rg`'s normal no-match status `1`).

## Temporal adapter architecture

The Ledger model remains canonical strings. `LedgerDatePicker` is a thin `NDatePicker` adapter using `formatted-value`, `value-format="yyyy-MM-dd"`, and string update events. `LedgerDateTimePicker` composes `NDatePicker` and `NTimePicker` inside `NInputGroup`; it splits and recomposes the canonical `YYYY-MM-DDTHH:mm` value without constructing a browser-local domain timestamp.

All seven required controls are Naive-based:

| Control | Final UI | Canonical model / boundary |
| --- | --- | --- |
| First-account opening date | `LedgerDatePicker` → `NDatePicker` | `YYYY-MM-DD`, sent unchanged as `openingDate` |
| Account-edit opening date | `LedgerDatePicker` → `NDatePicker` | `YYYY-MM-DD`, sent unchanged as `openingDate` |
| Dashboard period date | `LedgerDatePicker` → `NDatePicker` | `YYYY-MM-DD`, existing `selectDate` / anchor route-store flow |
| Transaction filter from | `LedgerDatePicker` → `NDatePicker` | `YYYY-MM-DD` until `instantFromLedgerDate(date, timezone, 'start')` |
| Transaction filter to | `LedgerDatePicker` → `NDatePicker` | `YYYY-MM-DD` until `instantFromLedgerDate(date, timezone, 'end')` |
| Transaction create `occurredAt` | `LedgerDateTimePicker` → `NDatePicker` + `NTimePicker` | `YYYY-MM-DDTHH:mm` until `instantFromLocalDateTime(value, settings.timezone)` |
| Transaction edit `occurredAt` | `LedgerDateTimePicker` → `NDatePicker` + `NTimePicker` | `YYYY-MM-DDTHH:mm` until `instantFromLocalDateTime(value, settings.timezone)` |

The timestamp supplied by a Naive date picker is used only as a picker-calendar coordinate for `isDateDisabled`; it is converted back to a calendar string before comparison with Ledger `todayDate`. Browser-local timestamps never become opening-date, route-date, filter, or transaction authorities.

## Date-only migration and boundaries

Date-only values stay exact for ordinary dates, month boundaries, and year boundaries. The Dashboard max-date rule still compares canonical calendar strings, so dates after Ledger `todayDate` remain disabled. Transaction from/to values remain strings until the existing inclusive-start and exclusive-end Ledger-zone conversions. Existing route query and store request context are unchanged.

## Browser/Ledger timezone matrix and DST evidence

The dedicated Playwright fixture uses real `NDatePicker`/`NTimePicker` controls and the existing Ledger time helpers. The required matrix passed:

| Browser timezone | Ledger timezone | Wall-clock input | Result |
| --- | --- | --- | --- |
| `UTC` | `UTC` | `2026-01-01T00:30` | exact string and instant round trip |
| `UTC` | `Asia/Shanghai` | `2026-03-08T02:30` | exact string and Shanghai instant |
| `America/New_York` | `Asia/Shanghai` | `2026-03-08T02:30` | exact string; browser DST does not alter Shanghai value |
| `Asia/Shanghai` | `America/New_York` | `2026-03-08T02:30` | exact input; Ledger spring-gap normalization round trips as `03:30` |

Additional DST assertions passed for Ledger `America/New_York` with browser `Asia/Shanghai`:

- spring gap `2026-03-08T02:30` resolves through the existing authority and round trips as `2026-03-08T03:30`;
- fall overlap `2026-11-01T01:30` preserves the wall-clock value on round trip.

The unit adapter tests cover canonical split/compose, empty values, and picker-calendar date conversion. The application Ledger E2E covers Dashboard date navigation, filter boundaries, create/edit datetime paths, and route/store compatibility.

## NTabs, domain rows, and interaction authority

Transaction type selection uses `NTabs`/`NTab` with exact values `expense`, `income`, and `transfer`. The existing semantic reset logic remains in the Nuvyn draft state, including clearing unsafe account/category/payee identities while retaining common amount/time/note fields. Arrow, Home, End, Enter, and Space keyboard behavior is covered.

Transaction history uses `NList`/`NListItem` with an `NButton` as the full row target. Enter/Space activation, accessible transaction content, amount alignment, mobile layout, and detail selection remain intact. No nested interactive control was introduced.

## NModal/NDrawer migration and focus authority

Both transaction sheets use controlled `NModal` + `NCard` overlays. The old `Teleport` sheet shells and `useFocusTrap` ownership were removed. Naive's overlay trap is the single focus authority. `NModal` uses `mask-closable="false"`, `close-on-esc="false"`, public `on-esc`/`on-mask-click` callbacks, controlled visibility, and public component instance focus APIs.

- create sheet: amount `NInput` receives initial focus after opening;
- detail sheet: the established detail focus target receives initial focus;
- focus restoration, Tab/Shift+Tab, Escape, mask, mobile geometry, and busy close blocking remain covered by the existing and continuation tests;
- clean and dirty close paths, including detail edit mode, route through Nuvyn `requestClose()` and the existing `useConfirm()` bridge;
- save/delete/recovery success paths close only after their domain operation settles.

## NForm/NFormItem migration

All clear field-oriented Ledger forms use `NForm`/`NFormItem`. Domain validation remains in the existing Ledger code: `parseLedgerMoney`, nature/type compatibility, transfer account mismatch, required identities, opening-date semantics, IANA timezone conversion, recovery handling, and CAS/version checks. Real form submission and Enter behavior are preserved; Naive validation is not used as a replacement for domain validation.

## NCard/NStatistic/NList migrations

Dashboard metric cards use `NCard` + `NStatistic`. Account groups, category breakdowns, and recent transaction surfaces use `NCard` plus `NList`/`NListItem` where list semantics apply. Detail hero and account balances use `NCard`/`NStatistic`; detail metadata uses `NDescriptions`. `NThing` was not needed because Ledger rows require a dense custom three-column amount layout and are already contained in public `NListItem`/`NButton` semantics.

## NAlert/NSpin/NEmpty/NResult migrations

Recoverable inline errors and warnings use `NAlert` with preserved `role="alert"`, message text, and retry/action ownership. Bootstrap and localized period loading use `NSpin`; true empty states use `NEmpty` with action slots; bootstrap and account load failures use `NResult`. Dashboard current snapshots remain visible while period analytics load, preserving the prior loading boundary.

## Dashboard fidelity

The frozen information order remains: header/actions, financial metrics, period cashflow, accounts, categories, recent transactions, and period summaries. Existing amount formatting, historical anchor behavior, current-balance semantics, responsive stacking, light/dark Nuvyn tokens, and ECharts configuration remain unchanged. No ECharts source or configuration file is in the continuation diff.

## Account and transaction compatibility

Account creation/editing preserves inherited currency, decimal-to-minor conversion, canonical opening dates, nature/type mapping, history locks, archive/restore actions, expected versions, and server payloads. Transactions preserve income/expense/transfer semantics, canonical wall-clock input, configured Ledger timezone conversion, current expected versions, account rechecks, category handling, delete confirmation, and detail refresh behavior. No API, store, money parser, time authority, or CAS strategy changed.

## Recovery compatibility

Pending create presentation now uses Naive state primitives, but `UNCERTAIN`, same-content retry, pending intent, idempotency key, new-create blocking, server-result adoption, and route persistence remain owned by the existing recovery/store code. No recovery state moved into Naive component state.

## RouterLink and ECharts exceptions

`RouterLink` remains the only navigation authority because Naive UI has no router equivalent; href, keyboard, modifier-click, and open-in-new-tab semantics are preserved. ECharts remains the authoritative chart renderer because Naive UI has no equivalent charting engine. These are allowed non-Naive exceptions, not interactive-control exceptions.

## Internal selector audit

The following audits produced no matches:

```bash
rg -n 'n-base-select-option|n-base-select-option--pending|n-input__input-el' \
  e2e/ledger*.spec.ts src/components/ledger src/views/Ledger*.vue
```

E2E select interaction uses public `combobox`, `listbox`, `option`, accessible names, keyboard behavior, and stable Nuvyn test IDs. Scoped `:deep(.n-*)` rules that remain are visual layout/theme hooks only; no product behavior or test authority depends on undocumented Naive DOM classes.

## Files changed

Continuation changes relative to `85b01ff` are limited to:

- `e2e/ledger-live.spec.ts`
- `e2e/ledger-temporal.spec.ts`
- `e2e/ledger-temporal/index.html`
- `e2e/ledger-temporal/main.ts`
- `src/components/ledger/LedgerAccountEditForm.vue`
- `src/components/ledger/LedgerDashboard.vue`
- `src/components/ledger/LedgerDatePicker.vue`
- `src/components/ledger/LedgerDateTimePicker.vue`
- `src/components/ledger/LedgerFirstAccountForm.vue`
- `src/components/ledger/LedgerInitializationForm.vue`
- `src/components/ledger/LedgerNoActiveAccountState.vue`
- `src/components/ledger/LedgerPendingCreateRecovery.vue`
- `src/components/ledger/LedgerTransactionDetailSheet.vue`
- `src/components/ledger/LedgerTransactionEditForm.vue`
- `src/components/ledger/LedgerTransactionSheet.vue`
- `src/components/ledger/__tests__/LedgerDashboard.test.ts`
- `src/components/ledger/__tests__/LedgerOnboarding.test.ts`
- `src/components/ledger/__tests__/LedgerTemporalControls.test.ts`
- `src/components/ledger/__tests__/LedgerTransactionSheet.test.ts`
- `src/components/ledger/__tests__/fixtures/LedgerTemporalHarness.vue`
- `src/features/ledger/__tests__/naiveTemporal.test.ts`
- `src/features/ledger/naiveControls.ts`
- `src/features/ledger/naiveTemporal.ts`
- `src/ui/naiveTheme.ts`
- `src/views/LedgerAccountDetailView.vue`
- `src/views/LedgerAccountsView.vue`
- `src/views/LedgerTransactionsView.vue`
- `src/views/LedgerView.vue`
- `src/views/__tests__/LedgerTransactionsView.test.ts`
- `src/views/__tests__/LedgerView.periodNavigation.test.ts`
- this new report

No unrelated files were modified, and the prior Phase 6 report was not edited.

## Tests

Successful continuation validation:

- `npm run typecheck` — passed.
- `npm run build` — passed; Vite transformed 8,209 modules.
- `npm run test:unit` — 277 test files passed; 4,011 tests passed; 9 skipped.
- `npm run test:history-integration` — 5 files; 178 tests passed.
- `npm run test:recovery-integration` — 5 files; 198 tests passed in an isolated run.
- `npm run test:tags-scale` — 2 files; 6 tests passed.
- `npm run test:platform-smoke` — 6 files; 84 tests passed.
- `npm run test:ui-foundation-spike` — 3 files; 27 tests passed.
- `npm run test:feedback-overlay` — 2 files; 18 tests passed.
- `npm run test:e2e -- e2e/ledger-live.spec.ts e2e/ledger-workspace.spec.ts e2e/ledger-temporal.spec.ts` — 12 tests passed before the final matrix expansion.
- `npm run test:e2e -- e2e/ledger-temporal.spec.ts` after the required matrix expansion — 2 tests passed.
- `npm run test:e2e` — 176 passed, 7 skipped; the full application browser suite passed, including Ledger, temporal, feedback, UI foundation, Diary, and Markdown coverage.

`npm run lint:icons` completed its diagnostic scan but exits non-zero on the repository's pre-existing 8 hard and 11 soft icon diagnostics (including existing 24×24 Ledger Dashboard SVG viewBoxes). No SVG asset or icon implementation was introduced by this continuation, and icon lint is not a required CI job.

## Bundle

After the production build, the `dist/assets` checkpoint was:

- `22,942,370` bytes summed across assets;
- `23,424 KiB` reported disk usage.

No ECharts source/configuration changed. The larger bundle is attributable to the Naive UI surface coverage and its new temporal adapters; no dependency or lockfile change was made.

## Known risks and deferred work

- Local Docker deployment smoke was not run because the local Docker daemon was unavailable; the required exact-head CI `docker-smoke` job remains authoritative.
- Naive select menus are virtualized; production browser tests use public roles and keyboard/visible-option behavior rather than internal classes.
- The repository icon diagnostic baseline remains unchanged.
- No Phase 7 work, shared Vault migration, or unrelated UI cleanup was started.

## Exit criteria and exact-head CI

The continuation now satisfies the local source, temporal, overlay, accessibility, responsive, unit, integration, build, and application-browser gates. Phase 6 is not declared closed in this report until the final report commit is pushed and every required exact-head CI job is green against that exact SHA.

Final exact-head CI: pending final pushed SHA. This report must not be edited after that run.
