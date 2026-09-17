# Nuvyn Naive UI Foundation — Phase 7 Vault/Note Validation Report

## Status

- Scope: Vault/Note outer interactive controls only
- Baseline: `654a5b38246758256d8a8e3e891916bd8bd7bc25`
- Local validation: PASS
- Exact-head CI: pending at report freeze

This report is frozen before the implementation commit and therefore does not
contain a final commit SHA or an exact-head CI run number.

## Scope completed

The following Vault/Note surfaces now use the public Naive UI API for their
outer interactive controls:

- activity bar, editor tabs, status bar, file tree and tree rows;
- right rail, links, tags and tag management;
- document metadata, history, timeline and comparison actions;
- draft recovery center, pane and prompt;
- AI panel, session picker, context picker, composer, messages and tool cards;
- settings editor number controls;
- the outer action toolbars of MarkMap and Mermaid;
- the NavBar brand action.

The migration keeps each existing action, event, test id, ARIA attribute,
keyboard path and data boundary in place. It does not change Vault identity,
document ownership, editor state, command dispatch, or router authority.

## Component mapping and contract notes

| Existing control contract | Public Naive component | Preservation detail |
| --- | --- | --- |
| action and menu buttons | `NButton` | `attr-type`, text/borderless presentation, role, disabled state and handlers remain explicit |
| text/search/metadata inputs | `NInput` | native ids/classes/ARIA are passed through `input-props`; `InputInst` refs are used where focus is required |
| tag source/destination selectors | `NSelect` | public `update:value` events and `SelectInst` refs; option nodes expose `role="option"` and accessible names |
| settings numeric inputs | `NInputNumber` | original min/max bounds remain 11–24, 16–40 and 60–160 |
| history/recovery checkboxes | `NCheckbox` | existing checked state and update paths are preserved |

The Settings tag selectors are rendered inside the existing custom settings
surface (`to=false`) and receive an explicit local menu layer. This preserves
the pre-existing backdrop stacking contract without changing the global
overlay hierarchy. Tag-management browser tests use the public option role,
not Naive implementation class names.

Editor-tab context-menu geometry accepts the public component element through
`$el`, and history comparison restores focus through the same public element
boundary. These adapters are limited to DOM ownership and do not alter the
workspace-tab or history state machines.

## Deliberately untouched high-risk boundaries

The following remain under their existing owners:

- FileTree model, selection and expansion state;
- editor/tab/document lifecycle and dirty-state handling;
- Monaco integration, scroll ownership and command system;
- Markdown-it, Shiki, Mermaid, MarkMap, KaTeX and PDF/preview renderers;
- RouterLink navigation authority and Vault identity;
- Diary lifecycle and Ledger domain/time semantics.

Only the outer MarkMap/Mermaid toolbar actions were migrated; generated
renderer/content markup remains outside the component-control migration.

## Native-control and API audits

- No `naive-ui/es`, `naive-ui/lib` or `naive-ui/src` imports remain in `src`,
  `e2e` or `scripts`.
- Production native interactive controls are limited to two Diary exceptions:
  `DiaryCalendar.vue` retains the v-calendar day-button seam, and
  `DiaryMoodPicker.vue` retains its custom 4×6 spatial keyboard radio grid with
  custom imagery, ARIA and roving focus.
- `markdownCodeGroups.ts` emits a native button as trusted generated content;
  it is a renderer/content exception, not a hand-written application control.
- Remaining `.n-*` references are styling-only visual geometry hooks for
  Naive-rendered controls; no test or behavior authority depends on private
  Naive selectors.

## Local validation recorded

| Check | Result |
| --- | --- |
| `npm test` | unit: 276 files, 4022 passed, 9 skipped; history: 178 passed; recovery: 198 passed |
| `npm run test:ui-foundation-spike` | 27 passed |
| `npm run test:e2e` | 180 passed, 7 skipped |
| `npm run test:e2e:draft-store` | 38 passed |
| `npm run test:e2e:auth` | 2 passed |
| `npm run typecheck` | passed |
| `npm run build` | passed; only existing dependency annotation/chunk-size warnings |
| `npm run lint:icons` | passed |
| `npm run lint:icons:strict` | passed; 5 files, 9 SVG elements scanned |
| `git diff --check` | passed |

## Gate note

Local validation is complete for this report. Phase closure still requires a
new exact-head CI run with all required jobs green after the implementation
commit; a report cannot substitute for that gate.
