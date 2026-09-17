# Nuvyn Naive UI Foundation — Phase 8 Cleanup Validation Report

## Status

- Scope: selective migration cleanup and audit only
- Baseline: `654a5b38246758256d8a8e3e891916bd8bd7bc25`
- Local validation: PASS
- Exact-head CI: pending at report freeze

This report is frozen before the implementation commit and therefore does not
contain a final commit SHA or an exact-head CI run number.

## Cleanup completed

The migration-only Vault icon infrastructure is no longer consumed by
production code and was removed:

- `src/components/vault/icons.ts`;
- its dedicated icon contract test;
- `src/views/IconPreviewView.vue`;
- the `/__icon-preview` route.

The current functional icon path is Tabler plus `NIcon`/public Naive UI
components. The icon lint script now scans the active source set, validates
shared SVG attributes, and records only explicit non-functional exceptions:
brand/network artwork, trusted renderer toolbars, PDF/Markdown fixtures and
the MarkMap security boundary.

## CSS and selector cleanup

- Settings narrow-screen selectors now target the public Naive component roots
  (`.n-input`, `.n-input-number`, `.n-select`, `.n-checkbox`) instead of
  obsolete native `input`/`select` assumptions.
- Input-specific visual rules that need the actual editing element are passed
  through `input-props` or scoped with `:deep`, preserving the existing layout
  and focus treatment.
- Custom classes retained by NButton remain intentionally supported where
  they carry existing Vault/Note visual contracts.
- No broad token deletion, Ledger redesign, renderer rewrite or unrelated
  cleanup was included.

The remaining `.n-*` selectors in Ledger and Diary are presentation hooks for
public Naive-rendered controls (selection geometry, input color and form
layout). They are not behavioral selectors or test authority.

## Audit results

- private Naive import audit: no matches in `src`, `e2e` or `scripts`;
- strict icon lint: passed, 5 files and 9 SVG elements scanned;
- native production-control audit: only the two documented Diary seams plus
  the generated Markdown button exception remain;
- legacy functional icon module/preview route: no production consumers remain;
- historical design/PRD/archive references are intentionally retained as
  historical records and are not runtime consumers.

The two Diary exceptions are deliberate: the calendar button is owned by the
v-calendar compatibility seam, while the mood picker is a custom 4×6 spatial
keyboard radio grid whose geometry, imagery, ARIA and roving focus are part of
its contract. The Markdown button is generated trusted content. NavBar brand
artwork and renderer toolbar SVGs are similarly explicit lint exceptions.

## Local validation recorded

| Check | Result |
| --- | --- |
| `npm test` | unit: 276 files, 4022 passed, 9 skipped; history: 178 passed; recovery: 198 passed |
| `npm run test:e2e` | 180 passed, 7 skipped |
| `npm run typecheck` | passed |
| `npm run build` | passed; only existing dependency annotation/chunk-size warnings |
| `npm run lint:icons` | passed |
| `npm run lint:icons:strict` | passed |
| `git diff --check` | passed |

## Gate note

This cleanup report is complete locally. Phase closure remains subject to the
frozen exact-head CI gate after the implementation commit; no CI exception,
skip or continue-on-error path is implied.
