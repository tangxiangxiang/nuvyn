# Nuvyn — Naive UI Foundation

## Phase 6 Closure Maintenance — Validation Report

**Status at report freeze:** implementation and local validation complete; exact-head CI pending.

This is a narrow closure-maintenance round. It does not start Phase 7 and does not change Ledger financial, temporal, recovery, routing, or chart architecture.

## 1. Baseline and scope

- Baseline `main`: `d51b48073df581ad9c893fa7ef8e9c618ac3b6f3` (`docs: add Phase 6 full Naive cutover validation report`).
- Code/test freeze HEAD before this report commit: `e133cb0252df470b6d58eae69a89400ec5ef4c40`.
- Existing frozen Phase 6 reports were not edited.
- Maintenance commits: `f5f59de3` (`fix: harden Ledger Naive UI public boundaries`) and `e133cb02` (`test: cover Ledger modal geometry`).
- Production scope: `LedgerDatePicker`, `LedgerTransactionSheet`, `LedgerTransactionDetailSheet`, and `LedgerDashboard`.
- Test scope: one focused browser spec, `e2e/ledger-sheet-geometry.spec.ts`.

## 2. Private Naive UI import

The previous `LedgerDatePicker` imported `IsDateDisabled` from the private path `naive-ui/es/date-picker/src/interface`. It now derives the type from the public package export:

```ts
type LedgerIsDateDisabled = NonNullable<DatePickerProps['isDateDisabled']>
```

The adapter contract is unchanged: the Ledger model remains canonical `YYYY-MM-DD`, bridged through `formatted-value`, `format="yyyy-MM-dd"`, and `value-format="yyyy-MM-dd"`. The Dashboard timestamp boundary remains presentation-only.

## 3. Modal layout ownership

The old `.ledger-sheet-modal` and `.ledger-detail-modal` classes were passed to `NModal`, where Naive UI forwards custom-modal attrs to the first slot child. They therefore styled the `NCard` while being treated as overlay layout containers.

Both sheets now use the normal public custom-modal pattern:

- `NModal` owns controlled visibility, mask/Escape callbacks, focus trapping, and restoration.
- The first and only accessible modal surface is the `NCard` (`.ledger-sheet-card` / `.ledger-detail-sheet-card`).
- The Card explicitly owns `align-self`, width, max-height, margin, overflow, and responsive border radius.
- No `Teleport`, custom backdrop, `useFocusTrap`, or dependency on `.n-modal-container`, `.n-modal-body-wrapper`, or `.n-modal-scroll-content` was added.

Desktop Card geometry is explicitly bottom-anchored with `align-self: flex-end` and `margin: auto auto 20px`, width `min(100%, 620px)`, and max-height `min(92vh, 820px)`. At `<=600px`, both Cards use width `100%`, max-height `100%`, `margin: auto 0 0`, and flush bottom corners.

The detail sheet also now performs its established detail-target focus after the controlled `open` transition reaches the DOM. Naive UI remains the single focus-trap authority.

## 4. Dashboard icon cleanup

The baseline Ledger Dashboard contained 5 handwritten functional SVGs: 3 metric-card icons and 2 account-row icons. All 5 are now library-backed:

| Surface | Final icon |
| --- | --- |
| 总资产 | `NIcon` + `Coin` |
| 总负债 | `NIcon` + `CreditCard` |
| 净资产 | `NIcon` + `ChartBar` |
| asset account row | `NIcon` + `Wallet` |
| liability account row | `NIcon` + `CreditCard` |

No dependency was added, no metric meaning/layout was changed, and no ECharts code was modified.

## 5. Geometry and accessibility evidence

`e2e/ledger-sheet-geometry.spec.ts` adds four browser cases using real `boundingBox()` values and invariant tolerances:

- desktop create at `1280×800`: width `<=622px`, bottom gap `<=30px`, nonzero top, horizontal centering;
- desktop detail at `1280×800`: the same invariants;
- mobile create at `390×844`: full-width within rounding tolerance, x≈0, bottom≈viewport bottom, height within viewport;
- mobile detail at `390×844`: the same invariants.

All four passed. Each case also verifies exactly one visible `role="dialog"` and the accessible name is mapped to the sheet heading. Create initial focus lands on the amount input; detail initial focus lands on the established detail content target. Desktop cases verify Escape closes the sheet and restores focus to the triggering control.

The existing interaction authority remains explicit in both sheets: `trap-focus=true`, `mask-closable=false`, `close-on-esc=false`, `on-esc` and `on-mask-click` route through `requestClose`, dirty close uses the existing `useConfirm`, busy mutation blocks close, and Naive handles focus restoration. Existing Ledger view unit coverage for dirty detail close remains green.

## 6. Compatibility boundaries

No changes were made to:

- `parseLedgerMoney`, minor-unit payloads, or account/category selection;
- Ledger timezone conversion, date-only authority, DST gap/overlap behavior, or `occurredAt` conversion;
- expected-version/CAS, account-history locks, archive/restore, or transaction rechecks;
- `UNCERTAIN`, pending-create, idempotency, retry, or recovery gates;
- router semantics or `LedgerCashflowTrend` / ECharts.

The existing browser temporal matrix remains green: UTC/UTC, UTC/Asia/Shanghai, America/New_York/Asia/Shanghai, Asia/Shanghai/America/New_York, DST spring gap, and DST fall overlap.

## 7. Required static gates

Private import gate:

```bash
rg -n "from ['\"]naive-ui/(es|lib|src)/" src
```

Result: no matches.

Native interactive-control gate:

```bash
rg -n '<(button|input|select|textarea)\b' \
  src/components/ledger \
  src/views/LedgerView.vue \
  src/views/LedgerAccountsView.vue \
  src/views/LedgerAccountDetailView.vue \
  src/views/LedgerTransactionsView.vue
```

Result: no matches.

Raw Ledger SVG gate:

```bash
rg -n '<svg\b' \
  src/components/ledger \
  src/views/LedgerView.vue \
  src/views/LedgerAccountsView.vue \
  src/views/LedgerAccountDetailView.vue \
  src/views/LedgerTransactionsView.vue
```

Result: no matches. The runtime SVG emitted inside `NIcon` is library output, not handwritten Ledger source.

Private behavior-selector gate:

```bash
rg -n 'n-base-select-option|n-base-select-option--pending|n-input__input-el' \
  e2e/ledger*.spec.ts \
  src/components/ledger \
  src/views/Ledger*.vue
```

Result: no matches.

Legacy modal-authority audit (`useFocusTrap`, `<Teleport>`, old modal classes, and private modal wrapper selectors): no matches in Ledger sheets/views.

`LedgerCashflowTrend.vue` diff from the baseline: empty.

## 8. Local validation

- `npm run typecheck`: passed.
- `npm run build`: passed; Vite transformed 8,209 modules.
- `npm run test:unit`: 277 files, 4,011 passed, 9 skipped.
- `npm run test:history-integration`: 5 files, 178 passed.
- `npm run test:recovery-integration`: 5 files, 198 passed.
- `npm run test:e2e -- e2e/ledger-sheet-geometry.spec.ts`: 4 passed.
- `npm run test:e2e`: 180 passed, 7 skipped.
- `npm run test:e2e:draft-store`: 38 passed.
- `npm run test:e2e:auth`: 2 passed.
- `npm run test:platform-smoke`: 6 files, 84 passed.
- `npm run test:tags-scale`: 2 files, 6 passed.
- `npm run test:ui-foundation-spike`: 3 files, 27 passed.
- `npm run test:feedback-overlay`: 2 files, 18 passed.
- `git diff --check`: passed.

`npm run lint:icons` still reports the repository's pre-existing non-Ledger SVG debt: 8 hard and 6 soft violations across 11 scanned files / 98 SVG elements. No Ledger file is reported, and this maintenance scope does not include unrelated project icon cleanup.

Local Docker smoke was not run because the Docker daemon is unavailable in this workspace; the required CI Docker job remains part of the exact-head gate.

## 9. Files changed

- `src/components/ledger/LedgerDatePicker.vue`
- `src/components/ledger/LedgerTransactionSheet.vue`
- `src/components/ledger/LedgerTransactionDetailSheet.vue`
- `src/components/ledger/LedgerDashboard.vue`
- `e2e/ledger-sheet-geometry.spec.ts`
- this maintenance validation report

## 10. CI status at report freeze

The report is intentionally frozen before the final push/CI run. The exact-head CI run number, attempt, and final SHA must be recorded in the handoff after the pushed maintenance HEAD completes. This file must not be edited afterward merely to add those values.

