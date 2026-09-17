# Nuvyn Naive UI Foundation — Phase 1 Report

Date: 2026-09-07

## Status

Phase 1: IMPLEMENTED / AWAITING EXACT-HEAD CI

Ready for Phase 2: NO

This report records the local implementation state before the final exact-head
GitHub Actions run. Phase 2 remains explicitly out of scope.

## Baseline and commits

- Starting HEAD: `a400aae000faaca3316d68cf076655c5d51088b0`
- Implementation commit: `ef86fc3` (`chore(ui): add naive ui production foundation`)
- Report/evidence commit: pending at report creation
- `github/main` matched the starting HEAD before implementation.

## Scope completed

Implemented the Phase 1 foundation only:

- `src/ui/tokens.css` is the global Nuvyn semantic token authority.
- `src/ui/naiveTheme.ts` maps Nuvyn tokens to the Naive UI theme boundary.
- `src/ui/NuvynUiRoot.vue` owns the production provider hierarchy.
- `src/main.ts` mounts `NuvynUiRoot` and keeps the required import order.
- `src/style.css` no longer defines a competing global base palette or alias set.
- The existing Phase 0 fixture now reuses the canonical Naive mapping.
- The Phase 0 focus probe is now a production regression test.

Naive UI remains exactly pinned at `2.45.3`; `@vicons/tabler` remains exactly
pinned at `0.13.0`. No global Naive component installer or second icon family
was added.

## Token migration

`tokens.css` defines the accepted first-version semantic groups:

- background and surfaces: `bg`, `surface-1`, `surface-2`
- text: `text-1`, `text-2`, `text-3`
- border/divider and accent/hover/pressed
- positive, negative, warning, and info status colors
- small/medium/large radii
- the six-step 4/8/12/16/24/32px spacing scale
- xs/sm/md/lg font sizes

The light and dark base values preserve the palette that was previously in
`style.css`. Status values use the smallest existing Nuvyn mappings: settings
success/warning colors, existing auth/ledger danger colors, and the existing
Vault blue info/accent value. The remaining foundation values are reserved and
do not change product selectors in this phase.

Legacy aliases remain in `tokens.css` and point to semantic tokens:

`--bg`, `--bg-soft`, `--text-h`, `--text`, `--text-muted`, `--border`,
`--code-bg`, `--accent`, `--accent-hover`, `--navbar-vault-bg`, and
`--navbar-vault-border`.

Theme precedence is explicit:

1. light defaults;
2. dark OS fallback only under `:root:not([data-theme])`;
3. explicit `data-theme='light'`;
4. explicit `data-theme='dark'`.

`--vs-*`, `--ledger-*`, editor/Markdown scoped tokens, and workspace-local
systems remain outside the global authority.

## Naive theme mapping

`naiveTheme.ts` keeps body, card, modal, border, divider, text, hover, pressed,
radius, and typography fields CSS-variable-backed.

Only `common.primaryColor` has a concrete light/dark TypeScript mirror. Naive
UI 2.45.3 uses `seemly` to parse that field and derive alpha variants; Phase 0
proved that `var(--nuvyn-accent)` reaches an invalid-color path for `NInput`.
The mirror therefore exists solely at this parser boundary. CSS remains the
semantic authority, and a regression test checks both concrete values against
the explicit light/dark `--nuvyn-accent` tokens.

The real mounted `NInput` regression path passes without a
`[seemly/rgba]` parser error.

## Provider root and authority bridges

The production hierarchy is:

```text
NConfigProvider
  NDialogProvider
    NMessageProvider
      NNotificationProvider
        App
```

`useTheme()` remains the only theme authority. Light maps to Naive's default
theme (`null`); dark maps to `darkTheme`. `useI18n().locale` remains the only
locale authority: `zh` maps to `zhCN`/`dateZhCN`, and `en` maps to
`enUS`/`dateEnUS`. The focused tests cover light → dark → light and zh → en →
zh without remounting App, and verify the router install boundary.

## Focus authority

Phase 0 browser evidence showed a double focus indicator on `NButton` and that
`NInput` already owns its visible focus presentation. Phase 1 promotes the
narrow proven boundary:

```css
:where(.n-button, .n-input input):focus-visible { outline: none; }
```

Naive owns focus for those primitives; native/Nuvyn controls continue to use
the broad Nuvyn `:focus-visible` rule. The browser regression now checks the
production CSS directly, including mouse focus, keyboard focus, Naive borders,
and clean console/page-error output.

## Bundle checkpoint

Measured from the Vite output at the starting HEAD and after Phase 1:

| Metric | Starting HEAD | Phase 1 | Delta |
| --- | ---: | ---: | ---: |
| Entry JS | 259,812 B | 505,584 B | +245,772 B |
| Largest async JS | 2,629,634 B | 2,629,634 B | 0 B |
| Total JS | 20,623,981 B | 20,858,054 B | +234,073 B |
| Total CSS | 430,347 B | 432,120 B | +1,773 B |

The entry increase is the expected first production Naive provider/theme
runtime import. The largest async chunk is unchanged. A source/output check
found provider and primitive runtime strings but no `n-data-table`,
`n-date-picker`, `n-tree`, or `n-select` component installer footprint in the
entry; no all-component registration was introduced.

## Visual Acceptance Gate

Automated visual and representative surface coverage passed with existing
baselines:

- main browser lane: 168 passed, 7 skipped;
- Markdown light/dark screenshot regression: passed with existing baselines;
- forced light/dark theme precedence: passed;
- Diary responsive/mobile journeys, Ledger narrow viewport behavior, Vault/
  Note reading surfaces, shared navbar/chrome, and auth browser smoke passed;
- dedicated draft-store browser lane: 38 passed;
- dedicated auth browser lane: 2 passed.

I manually reviewed the representative Markdown/global chrome surface at
desktop light, desktop dark, iPhone light, and iPhone dark sizes. Typography,
navbar, code surface, link treatment, spacing, and background contrast matched
the existing Nuvyn appearance. Intentional visual changes: none. Regressions
found/fixed: none. Accepted differences: none.

## Validation

- `npm ci`: passed; `package-lock.json` unchanged.
- `npm run test:ui-foundation-spike`: passed, 27 tests.
- `npm run typecheck`: passed (client and server).
- `npm run build`: passed. Existing Rolldown annotation and large-chunk
  warnings remain; no new failure was introduced.
- `npm test`: passed with 272 unit files / 3,952 tests and 9 skipped, plus
  history integration 178 passed and recovery integration 198 passed.
- `npm run test:e2e`: passed, 168 passed and 7 skipped.
- `npm run test:e2e:draft-store`: passed, 38 passed.
- `npm run test:e2e:auth`: passed, 2 passed.
- `git diff --check`: passed.

`npm run lint:icons` was also run. It reports 8 hard and 11 soft violations in
pre-existing, untouched files (`src/components/NavBar.vue` and PDF/Mermaid
test files). Phase 1 changes no icon consumers, paths, or icon architecture;
this known baseline exception is recorded rather than fixed out of scope.

## Explicit non-changes

No Feedback/Overlay migration.

No Primitive migration.

No Shared Chrome migration.

No Diary migration.

No Ledger migration.

No Vault/Note migration.

No route, store, API, server, or domain behavior changes.

## Exact-head CI

Pending at report creation. The final handoff will verify that the pushed
`github/main` exactly matches the final local SHA, locate the Actions run whose
`head_sha` is that SHA, inspect every job, and update the release status only
after that exact-head run passes.

NAIVE UI FOUNDATION PHASE 1 IMPLEMENTATION COMPLETE
