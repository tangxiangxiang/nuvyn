# Nuvyn Naive UI Foundation — Phase 6 Ledger Validation Report

Status at report commit time: local implementation validation complete; final exact-head CI is pending the final pushed SHA.

## Starting Baseline

- Repository: `/Users/txx/nuvyn`
- Remote used for validation: `github` (`github.com/tangxiangxiang/nuvyn.git`)
- Starting immutable SHA: `166c556fa707b55e50f0891960b115dd18763c9e`
- Starting commit: `feat: migrate Diary workspace primitives`
- Starting working tree: clean (`main...github/main`)
- Baseline exact-head CI: run `34189859565`, attempt `1`, head `166c556fa707b55e50f0891960b115dd18763c9e`, completed/success; every repository CI job was successful.
- No package, lockfile, provider, theme, API, server, store, or ECharts dependency changes were made.

## Phase 6 Inventory

The inventory was redone from the Ledger source surfaces before migration. It contained 84 source-level candidates: 45 native button tags, 18 native inputs, 17 native selects, and 4 textareas.

| Candidate class | Baseline | Final source-level result | Decision |
| --- | ---: | --- | --- |
| Generic actions | 45 buttons | 43 `NButton`; 2 native button templates | Replace safe actions; keep the transaction tab template and transaction-row template as domain controls |
| Text / money / notes | 18 inputs + 4 textareas | 15 `NInput`; 7 native date or datetime inputs | Replace generic text and textarea fields; keep temporal controls at the Ledger semantic boundary |
| Entity / scope choices | 17 selects | 17 `NSelect` | Replace with exact string-valued options and explicit accessible names |
| Total | 84 | 75 Naive primitives + 9 intentional native controls | Complete within Phase 6 scope |

The final 9 native source templates are the seven date/datetime controls plus the two domain button templates. The latter render the transaction type tabs and native transaction rows. The two custom sheet shells and their `useFocusTrap` ownership are architectural boundaries, not migration candidates. No Phase 6 work was deferred inside the requested Ledger surfaces.

## Date / DateTime Gate

All temporal decisions preserve the existing authority: a browser control supplies a canonical wall-clock string, while the configured Ledger IANA timezone performs domain conversion. The browser timezone is never used as Ledger authority.

| File/control | Canonical model and payload | Timezone authority | Final primitive | Decision / reason |
| --- | --- | --- | --- | --- |
| `LedgerFirstAccountForm.vue#ledger-account-opening-date` | `YYYY-MM-DD`; server `openingDate` string | Ledger settings timezone for the default date; the date itself is date-only | Native `input[type=date]` | Kept native because this is a date-only semantic and the existing canonical string/HTML keyboard behavior is already exact |
| `LedgerAccountEditForm.vue#ledger-edit-account-opening-date` | `YYYY-MM-DD`; server `openingDate` string | Ledger settings are already represented by the account’s canonical opening date | Native `input[type=date]` | Kept native to avoid changing account-history meaning or date-only parsing |
| `LedgerDashboard.vue#ledger-period-date` | `YYYY-MM-DD`; emits `selectDate(date)` and feeds the existing `anchorDate` request context | Ledger timezone supplies `todayDate` and historical period context | Native `input[type=date]` | Kept native; route/store period semantics and `max=todayDate` remain unchanged |
| `LedgerTransactionsView.vue#from` | `YYYY-MM-DD`; converted to inclusive lower query instant | Configured Ledger timezone via `instantFromLedgerDate(..., 'start')` | Native `input[type=date]` | Kept native; the API still receives the same Ledger-zone boundary |
| `LedgerTransactionsView.vue#to` | `YYYY-MM-DD`; converted to exclusive next-midnight query instant | Configured Ledger timezone via `instantFromLedgerDate(..., 'end')` | Native `input[type=date]` | Kept native; the API still receives the same Ledger-zone boundary |
| `LedgerTransactionSheet.vue#ledger-transaction-occurred-at` | `datetime-local` wall-clock string; server UTC instant milliseconds | `settings.timezone` via `instantFromLocalDateTime` | Native `input[type=datetime-local]` | Kept native because replacing it would change the financial event’s timezone boundary without a proven equivalent adapter |
| `LedgerTransactionEditForm.vue#ledger-edit-transaction-occurred-at` | `datetime-local` wall-clock string; server UTC instant milliseconds | `settings.timezone` via `instantFromLocalDateTime` | Native `input[type=datetime-local]` | Kept native for the same financial and DST reason; the existing edit payload remains authoritative |

Date characterization covers canonical date-only round trips, UTC/`Asia/Shanghai`/`America/New_York` boundaries, empty route dates, and New York DST spring-gap and fall-overlap wall-clock values. The exact conversion helpers and server-facing payload construction were not changed.

## Primitive Mapping

- `NButton`: generic submit, cancel, retry, create, restore, archive, edit, load-more, filter, close, and dashboard actions across the Ledger forms and views. `attr-type` is explicit and existing disabled/busy states remain wired to the same state flags.
- `NInput`: generic text, money, payee, note, timezone, and textarea fields. Values remain strings until the existing Ledger money parser converts them to minor units.
- `NSelect`: currency, account nature/type, transaction account/category/transfer accounts, transaction filters, and dashboard scope. Options retain the existing exact values; archived labels remain presentation-only.
- `NDatePicker`: none. No exact semantic equivalence was proven for Ledger date-only or configured-timezone datetime behavior.
- `NAlert`, `NSpin`, `NEmpty`, `NTabs`: none. Existing Ledger error, loading, empty, and domain tab surfaces remain in their established markup and state ownership.
- Native controls deliberately retained: the seven temporal inputs, the transaction type tablist/button template, and transaction domain rows.
- Custom `TransactionSheet` and `DetailSheet` shells remain Teleport-based shells with their existing `role=dialog`, focus ownership, Escape, backdrop, dirty-confirm, and lifecycle rules. No `NModal` or `NDrawer` was introduced.
- No additional provider/theme/feedback hierarchy and no broad global `.n-*` selector dependency were introduced. Naive styling hooks are scoped to the owning Ledger component.

## Dashboard Compatibility

The existing Dashboard composition remains intact and only its safe generic controls changed. The order remains: header/actions, asset-liability-net-worth metrics, period cashflow, account groups, category breakdowns, recent transactions, and the existing responsive layout. Labels, minor-unit formatting, signed money semantics, account/category links, loading/error state ownership, and historical context remain unchanged. `LedgerCashflowTrend` and all ECharts data/configuration were not modified.

## Scope / Route Compatibility

- Scope values remain exactly `today`, `week`, `month`, `year`, and `all`.
- The `NSelect` update handler accepts only those exact string values and otherwise ignores the event.
- Dashboard date selection still emits the existing canonical `YYYY-MM-DD` value and uses the existing store request context.
- Transaction route query keys (`type`, `accountId`, `categoryId`, `from`, `to`) and deep-link initialization remain unchanged.
- Date filters still convert through the configured Ledger timezone before the existing server request.
- Stale/failed overview behavior and the “return to today” action remain owned by the existing store/view flow.

## Account Compatibility

Account creation and editing retain the original name validation, nature/type mapping, inherited currency, opening-balance parser, canonical opening date, and server payloads. Archive and restore actions remain the same Router/View/Confirm/CAS paths. History and archived-account locks still prevent financial-field edits where required; `expectedVersion` is unchanged. Only safe text/select/action primitives were replaced.

## Transaction Compatibility

- Create and edit continue to parse visible currency strings through `parseLedgerMoney` and submit minor units.
- Create, edit, delete, archived-account behavior, and optimistic-concurrency/version checks remain in the existing store/API paths.
- `occurredAt` continues to round-trip through the configured Ledger timezone and UTC instant conversion.
- Expense, income, and transfer type switching still clears only semantically unsafe identities while retaining the common draft fields.
- Account/category filters retain exact values, archived labels, route query initialization, and Ledger-zone date boundaries.
- Quick category creation still uses the same semantic operation and selects the server-created category.
- The browser E2E select helper now drives real `NSelect` keyboard interaction, including the virtualized currency menu; this is test interaction only and does not change production behavior.

## Dialog / Sheet Compatibility

Both custom sheets retain their existing focus trap, initial focus, Tab handling, Escape behavior, backdrop handling, dirty confirmation, busy blocking, close/focus restoration, and mobile shell behavior. `NButton` and `NIcon` are used only for safe generic actions and the existing close affordance; no second focus trap or Naive dialog lifecycle was added.

## Recovery Compatibility

`LedgerPendingCreateRecovery`, the no-active-account state, and bootstrap retry now use `NButton` for their generic actions. Uncertain-create state, same-content retry, operation gating, blocking behavior, and server-result adoption remain unchanged. No recovery or idempotency contract was moved into a UI primitive.

## Accessibility

Form labels remain attached to their controls where native IDs are available; `NSelect` controls additionally expose explicit `aria-label` values for account, category, nature, type, currency, scope, and filter semantics. Existing `role=alert`, `aria-busy`, disabled states, dialog labeling, native tablist/tab roles, RouterLink navigation, and domain-row keyboard activation remain intact. The full browser suite and the dedicated Naive UI focus-authority checks passed. Icon diagnostics found only pre-existing repository violations; Phase 6 added no SVG.

## Responsive / Theme

Existing component-scoped layout rules and Nuvyn tokens remain in place. No global theme/provider hierarchy changed. Full Chromium E2E passed across the existing responsive, light/dark, keyboard, narrow-viewport, overlay, Ledger, Diary, Markdown, and VCalendar coverage. The dedicated Markdown visual cases also passed.

## Files Changed

Implementation and validation changes are limited to:

- `e2e/ledger-live.spec.ts`
- `src/components/ledger/LedgerAccountEditForm.vue`
- `src/components/ledger/LedgerDashboard.vue`
- `src/components/ledger/LedgerFirstAccountForm.vue`
- `src/components/ledger/LedgerInitializationForm.vue`
- `src/components/ledger/LedgerNoActiveAccountState.vue`
- `src/components/ledger/LedgerPendingCreateRecovery.vue`
- `src/components/ledger/LedgerTransactionDetailSheet.vue`
- `src/components/ledger/LedgerTransactionEditForm.vue`
- `src/components/ledger/LedgerTransactionSheet.vue`
- `src/components/ledger/__tests__/LedgerDashboard.test.ts`
- `src/components/ledger/__tests__/LedgerOnboarding.test.ts`
- `src/components/ledger/__tests__/LedgerTransactionSheet.test.ts`
- `src/components/ledger/__tests__/selectTestUtils.ts`
- `src/features/ledger/__tests__/time.test.ts`
- `src/views/LedgerAccountDetailView.vue`
- `src/views/LedgerAccountsView.vue`
- `src/views/LedgerTransactionsView.vue`
- `src/views/LedgerView.vue`
- `src/views/__tests__/LedgerAccountDetailView.test.ts`
- `src/views/__tests__/LedgerTransactionsView.test.ts`
- `docs/design/nuvyn-naive-ui-foundation-phase6-ledger-validation-report.md`

No unrelated files were modified.

## Tests

Successful local validation before the report commit:

- `npm run typecheck` — passed.
- `npm run build` — passed; Vite transformed 8,203 modules.
- Focused Ledger Vitest: `npx vitest run --reporter=dot src/components/ledger/__tests__ src/views/__tests__/LedgerAccountDetailView.test.ts src/views/__tests__/LedgerAccounts.test.ts src/views/__tests__/LedgerTransactionsView.test.ts src/views/__tests__/LedgerView.test.ts src/features/ledger/__tests__/time.test.ts src/features/ledger/__tests__/periodNavigation.test.ts` — 9 files, 81 passed.
- `npm test` — unit 275 files / 4,004 passed / 9 skipped; history integration 5 files / 178 passed; recovery integration 5 files / 198 passed.
- `npm run test:tags-scale` — 2 files, 6 passed.
- `npm run test:platform-smoke` — 6 files, 84 passed.
- `npm run test:ui-foundation-spike` — 3 files, 27 passed.
- `npm run test:feedback-overlay` — 2 files, 18 passed.
- `npx playwright test e2e/ledger-live.spec.ts e2e/ledger-workspace.spec.ts` — 10 passed.
- `npm run test:e2e:draft-store` — 38 passed.
- `npm run test:e2e:auth` — 2 passed.
- `npm run test:e2e` — 174 passed, 7 skipped; this included the six Ledger live cases, four Ledger workspace cases, three Markdown visual cases, feedback overlay, Naive UI foundation, and VCalendar compatibility.
- `npm run lint:icons` — diagnostic completed over 12 files / 103 SVGs and reported the existing baseline of 8 hard and 11 soft violations; no SVG was added or changed by Phase 6.
- Local Docker deployment smoke was not runnable because the local Docker daemon was unavailable. The repository `docker-smoke` job remains part of the required exact-head CI gate.

## Bundle Checkpoint

Using the same `dist/assets` byte summation as the prior phase:

- Phase 5 baseline production assets: `22,648,956` bytes.
- Phase 5 local checkpoint: `22,650,231` bytes (`23,256 KiB` disk usage).
- Phase 6 local production assets: `22,660,573` bytes (`23,272 KiB` disk usage).
- Phase 6 delta versus Phase 5 local checkpoint: `+10,342` bytes; no ECharts source/configuration was changed.

## Known Risks

- Date and datetime controls intentionally remain native. Their visible wall-clock behavior is OS/browser-owned, but all domain serialization and query/event conversion remains Ledger-owned and is covered by exact timezone/DST characterization.
- Naive non-filterable selects render a virtualized menu. Production behavior is exercised through the real keyboard path in browser tests, while unit tests assert public component options and values rather than Naive internal DOM classes.
- Local Docker smoke could not be executed because the daemon was not running; the exact-head CI docker lane must provide the deployment evidence.
- Icon diagnostics are not a Phase 6 regression: the reported violations predate this change and no SVG asset was introduced.

## Deferred Work

No Phase 7 work or unrelated cleanup was started. Further migration of intentionally retained domain/date/sheet controls requires a separate semantic proof and is outside Phase 6.

## Exit Criteria

The implementation, focused tests, full unit/integration tests, full browser E2E, Draft Store, Auth, platform, tags-scale, UI foundation, feedback overlay, build, and typecheck are locally green. The work is ready to push for immutable exact-head CI. Phase 6 is not declared PASS in this report until every required CI job is green against the final pushed SHA.

Final exact-head CI: pending final pushed SHA.
