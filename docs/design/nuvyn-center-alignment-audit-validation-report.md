# Nuvyn Center Alignment Audit & Fix

## Status

- Scope: alignment-only polish across workspace and management surfaces
- Starting HEAD: `a26e53d8e9e09926c0e08f0ec11da22430ed6796`
- Final HEAD: pending implementation commit
- Ledger Dashboard: explicitly frozen and excluded from visual changes
- Domain, routing, async, persistence, and accessibility behavior: unchanged

## Audit

The required source audit covered `src/components/**`, `src/views/**`,
`src/ui/**`, shared `src/style.css`, inline style bindings, and Naive UI
`NEmpty`/`NResult`/`NSpin` consumers. The final source scan contains 247
alignment matches; every remaining match has been classified rather than
mechanically replaced.

### Fixed

- History comparison loading/error state content now starts at the left edge.
- Command-palette no-result copy is left aligned.
- AI session picker empty copy is left aligned.
- Draft recovery empty copy is left aligned.
- Tag management loading, error, success, and undo states are left aligned;
  the undo action follows the same content axis.
- Ledger accounts, account detail, and transactions management states use
  left-aligned result/empty content while retaining vertical centering of the
  state block.
- Ledger inline empty content starts at the row's content edge.

### Kept center

- Icon-only controls, icon glyphs, badges, avatars, switches, and button
  content.
- Toolbar, navigation, tab, list-row, form-heading, and status-row vertical
  alignment (`align-items: center`).
- Pagination and compact controls whose center position is part of the
  existing interaction geometry.
- Modal, dialog, popover, command-palette, and backdrop positioning.
- Chart/canvas/renderer error geometry, math blocks, and diff markers.
- Diary calendar geometry and the 4×6 mood-picker spatial interaction.
- Auth/bootstrap outer composition and isolated full-page result states.
- All Ledger Dashboard layout and content alignment.

### Container center + content left

- The existing full-area `.content-empty` container remains centered for
  workspace geometry while its `.empty-state` content stays left aligned.
- `LedgerPendingCreateGate` keeps its recovery card centered in the viewport;
  the card's heading, explanation, and recovery details use normal left flow.
- Ledger error/result states keep vertical placement in their parent while
  their title, description, and footer content use a left content axis.

### Vertical center only

The audit retained horizontal-row centering used only for vertical geometry:
global navigation, activity/file/history rows, right-rail metadata, AI
toolbars and messages, ledger row actions, form field headings, and other
icon-to-label relationships.

## Changed surfaces

- Settings: no broad form centering was found; Tag management status/undo
  states were corrected.
- Vault: history state, command-palette empty state, AI session empty state,
  and draft recovery empty state were corrected.
- Note: editor and renderer controls remain unchanged; document content was
  not reflowed.
- FileTree: row/icon geometry and labels remain unchanged and left-flowing.
- RightRail: tabs and metadata rows retain their existing vertical alignment.
- History: comparison status content is left aligned; diff markers remain
  centered as markers.
- Tags: management states are left aligned; chips and icon controls remain
  unchanged.
- AI: session-list empty copy is left aligned; conversation rows, tool pills,
  and toolbar geometry remain unchanged.
- Auth: no change to the centered outer auth composition.
- Ledger: only non-Dashboard loading, error, and empty states were adjusted.
- Diary: no change to calendar or mood-picker spatial contracts.
- Other: renderer, markdown/math, modal, and popup alignment semantics were
  preserved.

## Important preserved areas

| Area | Result |
| --- | --- |
| Ledger Dashboard visual layout changed | NO |
| Toolbar vertical alignment changed | NO |
| Modal viewport positioning changed | NO |
| Diary spatial interaction changed | NO |
| Domain/application behavior changed | NO |

The narrow Naive UI result overrides are scoped to Ledger error-state wrappers
and only counteract Naive UI's default centered title/description/footer
styling. Naive UI does not expose public alignment props for those result
slots; no focusable element or DOM order was changed. Empty-state copy uses
public `#extra` wrappers where a custom content axis is needed.

## Remaining center usage

The final matches are intentional categories: vertical row alignment, compact
control/icon geometry, badges and glyphs, modal/backdrop placement, isolated
auth or full-page states, centered outer containers with left-flowing inner
content, renderer/chart/canvas geometry, Diary spatial controls, and the
frozen Ledger Dashboard. No unjustified content-level horizontal centering
remains in the audited workspace/management surfaces.

## Validation

| Check | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run build` | PASS; existing dependency annotation/chunk-size warnings only |
| Targeted Vitest | PASS; 7 files, 98 tests |
| `npm test` | PASS; unit 276 files/4022 passed/9 skipped, history 178 passed, recovery 198 passed |
| `npm run lint:icons:strict` | PASS; 5 files, 9 SVG elements scanned |
| Visual verification | PASS; manual responsive checks of Vault, Settings, Tags, Ledger accounts, transactions, and frozen Dashboard baseline |
| `git diff --check` | PASS |
| Final center audit | PASS; 247 matches classified, inline dynamic-center scan empty |
| Exact-head CI | pending push |

## Final verdict

- Unjustified horizontal centering remaining: NO
- Nuvyn default content alignment: LEFT
- Visual redesign performed: NO
- Ledger Dashboard visual structure changed: NO
- Ready for user review: pending exact-head CI
