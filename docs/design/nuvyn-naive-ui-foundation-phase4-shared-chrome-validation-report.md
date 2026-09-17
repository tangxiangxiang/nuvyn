# Phase 4 — Shared Chrome Validation Report

Date: 2026-09-08

Status: Implementation and local validation complete. Final readiness is gated by the immutable exact-head CI result recorded in the final handoff.

## Starting Baseline

- Authoritative starting HEAD: `303f9854511b55983f219a85328633c08a8648a9` (`ci: split verification into parallel lanes`).
- The baseline advanced from the originally reviewed `d93ed38e423423d93eb85bee2bf6d631569b4a21` while Phase 4 was in progress. The newer `main` was retained; no reset to the older SHA was performed.
- Baseline exact-head CI: run `34176380454`, attempt 1, success.
- The four pre-existing working-tree changes were preserved exactly: `.github/workflows/ci.yml`, `README.md`, `docs/development/testing.md`, and `package.json`. They became the baseline commit `303f985` independently of the Phase 4 change set and are not included in the Phase 4 implementation commit.
- Final implementation HEAD and its exact-head CI run are intentionally recorded in the final handoff, avoiding an immutable commit self-reference loop.

## Phase 3 Input Inventory

Phase 3 recorded 304 Vue candidates: 284 production controls and 20 fixture controls, plus one generated Markdown control. The Phase 4-owned source-level candidates were:

| Surface | Controls |
| --- | ---: |
| Auth (`App`, `LoginView`, `SetupView`) | 10 |
| Settings | 33 |
| NavBar | 7 |
| AccountMenu | 4 |
| CommandPalette | 2 |
| **Phase 4 primary total** | **56** |

The explicit Phase 4/7 boundary set (`ActivityBar`, `RightRail`, `StatusBar`, `EditorTabs`, and `FileTree`) contains another 23 source-level controls.

## Phase 4 Delta Inventory

No new Phase 4 production control entered after the Phase 3 inventory. After migration, the Phase 4 primary surfaces retain only:

- one product-specific native brand button in `NavBar`;
- three native number inputs in `SettingsEditorSection`;
- twelve native Diary migration buttons deferred as one workflow to Phase 5.

Decision totals across the 56 primary controls and the 23 explicit boundary controls:

| Decision | Count |
| --- | ---: |
| Replaced | 40 |
| Adapted without retaining a native candidate | 0 |
| Kept | 4 |
| Deferred to Phase 5 | 12 |
| Deferred to Phase 7 | 23 |
| **Total reviewed** | **79** |

`AccountMenu` and `CommandPalette` retain their Nuvyn behavior authorities around replaced primitives; those are architectural adapters, not additional native-control decisions.

## Scope

Implemented only the frozen Phase 4 surfaces:

- Auth shared controls and bootstrap retry actions;
- NavBar generic controls and functional icons;
- AccountMenu controls;
- Settings shell navigation and generic AI, Editor, and Metadata controls;
- CommandPalette input and create action.

## Out of Scope

No Diary workspace, Ledger domain, Vault file/editor/history lifecycle, Tag Management, RightRail domain content, Markdown-rendered controls, API, store, persistence, route architecture, dependency, provider-tree, or broad CSS cleanup work was introduced.

## Boundary Decisions

| Component | Decision | Concrete reason |
| --- | --- | --- |
| `ActivityBar` | Deferred to Phase 7 | Owns Vault pane selection and its keyboard/focus contract, not independent app-level chrome. |
| `RightRail` | Deferred to Phase 7 | Owns Vault tab ARIA, document selection, history, metadata, and AI panel lifecycle. |
| `StatusBar` | Deferred to Phase 7 | Owns external-change and conflict-resolution actions with async document semantics. |
| `EditorTabs` | Deferred to Phase 7 | Owns editor tab lifecycle and context-menu keyboard semantics. |
| `FileTree` | Deferred to Phase 7 | Owns tree focus, inline rename, and file lifecycle operations. |
| `SettingsDiaryMigrationSection` | Deferred to Phase 5 | Its twelve controls form one very-high-risk multi-step Diary migration and destructive-cleanup workflow; primitive replacement cannot be isolated from the domain lifecycle. |
| `SettingsTagsSection` embedded domain UI | Deferred to Phase 7 | The shell has no native controls; the embedded Tag Management workflow remains domain-owned. |

## NavBar Migration

- Replaced the scope-chip template and five generic action-button templates with compact `NButton` primitives.
- Replaced generic handwritten functional icons with `NIcon` and `@vicons/tabler` icons for scope, search, theme, view mode, and panel actions.
- Preserved Note/Diary/Ledger product navigation, route differentiation, pressed labels, panel state, view-mode authority, density, placement, and existing test IDs.
- Did not convert the NavBar to `NMenu`, tabs, or generic segmented navigation.
- Kept the native brand button because its exact event target owns the three-second constellation timer and blur, visibility, Escape, route-change, and unmount cleanup. The brand SVG is product artwork and is not a generic functional icon.

## AccountMenu Migration

- Replaced the trigger and three menu-item templates with compact `NButton` controls and approved Tabler icons.
- Retained one Nuvyn keyboard authority instead of combining it with `NDropdown` behavior. The existing authority preserves first-enabled-item focus, ArrowUp/ArrowDown, Home/End, Escape, Tab, outside-pointer close, and busy disabling.
- The trigger ref now resolves through the component's stable public root element for focus restoration.
- Characterization coverage proves the AccountMenu → SettingsModal → Account trigger focus chain and single-shot Diary lock behavior.

## Auth Migration

- Replaced all six Login/Setup text/password inputs with `NInput`, using `InputInst.focus()` rather than DOM-internal selectors.
- Forwarded native `id`, `name`, `autocomplete`, `required`, and ARIA attributes to the rendered input through the public `input-props` API.
- Preserved native form submission and constraint validation, Enter submission, busy/double-submit protection, safe redirect behavior, error focus, password/token clearing, rate-limit/error mapping, and already-initialized recovery.
- Replaced four Login/Setup/bootstrap action templates with `NButton`, preserving submit versus button semantics.

## Settings Migration

- Kept the custom Teleport dialog shell, focus trap, Escape/backdrop close, leave guards, section reset, async loading, and overlay authority.
- Replaced shell close and section-navigation controls with `NButton` and Tabler icons; Settings IA was not converted to `NMenu`.
- Migrated AI actions, provider selection, API key, Base URL, and model fields to `NButton`, `NSelect`, and `NInput`, retaining exact provider strings, abort/latest-run state, recovery, busy, Confirm, and Toast behavior.
- Migrated Editor reset, numeric tab-size selection, font-family input, and two boolean controls to `NButton`, numeric-valued `NSelect`, `NInput`, and `NCheckbox`.
- Kept font size, line height, and wrap column as native number inputs to preserve `v-model.number`, native empty/step behavior, and exact min/max constraints.
- Migrated all three Metadata actions to `NButton` without changing preview, confirm, mutation, restore, or cleanup behavior.
- Focus is applied immediately on Settings open and again after async Settings data replaces the field subtree, preventing focus from falling back to `body`.

## CommandPalette Decision

- Migrated the search input to `NInput` and create-new action to `NButton`.
- Retained the custom dialog, focus trap, async latest-search runner, flattened active index, listbox/options, Arrow navigation, Enter, Escape, backdrop, and global Cmd/Ctrl+P authority.
- Used the public `InputInst` focus API and a component theme override for the pre-existing 53 px input geometry; no Naive internal DOM selector is used as behavior authority.

## Primitive and Density Mapping

| Existing control | Phase 4 target | Density |
| --- | --- | --- |
| Generic button | `NButton` | `small` for NavBar/AccountMenu; `medium` for Auth/Settings |
| Text/password input | `NInput` | `medium` |
| String or numeric select | `NSelect` with exact typed options | `medium` |
| Boolean checkbox | `NCheckbox` | default/medium-equivalent |
| Product brand / native number semantics | Kept native | existing |

## Icon Migration

All newly migrated functional icons use `NIcon` and `@vicons/tabler`. No new handwritten generic SVG was added. The repository icon diagnostic remains at the baseline-known 8 hard and 11 soft findings; the touched NavBar finding is the deliberately retained 1000×1000 Nuvyn brand constellation artwork. Ledger, PDF-test, Mermaid, and MarkMap findings are unchanged and outside Phase 4.

## Accessibility Preservation

- Preserved accessible names, labels, roles, `aria-pressed`, `aria-expanded`, `aria-controls`, `aria-haspopup`, `aria-busy`, invalid/described-by relationships, listbox/options, and menu/menuitem semantics.
- Icon-only controls keep text alternatives; decorative icons are hidden from accessibility APIs.
- Tests select controls by role, accessible name, ARIA state, or established test ID rather than Naive internal classes.

## Keyboard and Focus Preservation

- Auth initial/error focus uses the documented Naive input instance API.
- AccountMenu retains roving focus, Home/End, arrows, Escape/Tab, outside close, and stable Settings focus restoration.
- Settings keeps its existing focus trap and returns focus through the AccountMenu chain.
- CommandPalette retains Cmd/Ctrl+P, input focus, arrows, Enter, Escape, backdrop close, and listbox selection.
- Naive controls own Naive focus presentation; removed touched Nuvyn focus rules do not produce a double ring.

## Route and Domain Invariants

- Brand navigation still targets Home.
- Note, Diary, and Ledger routes and scope semantics are unchanged.
- Diary access/lock, Ledger onboarding, panel state, view mode, Auth redirect, Settings mutation, Toast, Confirm, and Prompt authorities are unchanged.
- No server, protocol, persistence, API, store, or domain workflow was modified.

## Theme and Styling Invariants

- Existing `NuvynUiRoot`, provider tree, semantic tokens, locale bridge, and Naive theme overrides remain the only authorities.
- No second provider/theme/feedback root and no wrapper component system was added.
- No blanket `.n-button`, `.n-input`, `.n-select`, `[class*="n-"]`, or broad `:deep()` override was introduced.
- Local CSS only preserves product geometry at Auth, Settings, and CommandPalette boundaries.

## Files Changed

Production:

- `src/App.vue`
- `src/components/NavBar.vue`
- `src/components/vault/AccountMenu.vue`
- `src/components/vault/CommandPalette.vue`
- `src/components/vault/SettingsAiSection.vue`
- `src/components/vault/SettingsEditorSection.vue`
- `src/components/vault/SettingsMetadataSection.vue`
- `src/components/vault/SettingsModal.vue`
- `src/style.css`
- `src/views/LoginView.vue`
- `src/views/SetupView.vue`

Tests:

- `src/components/__tests__/NavBar.test.ts`
- `src/components/vault/__tests__/AccountMenu.test.ts`
- `src/components/vault/__tests__/CommandPalette.test.ts`
- `src/components/vault/__tests__/SettingsModal.test.ts`
- `src/views/__tests__/auth-views.test.ts`

Documentation:

- `docs/design/nuvyn-naive-ui-foundation-phase4-shared-chrome-validation-report.md`

## Tests Added or Updated

- Auth: required/native form validity, password clearing, Setup required fields, and already-initialized authenticated redirect.
- NavBar: brand Home navigation, search/theme/panel accessible names and ARIA state, without class-order coupling.
- AccountMenu: Settings focus handoff/restoration and busy single-shot Diary locking, in addition to retained keyboard coverage.
- Settings: exact numeric/select/boolean models, native bounds, and first real field focus after async open.
- CommandPalette: Ctrl+P/input focus/listbox state, ArrowDown/Enter selection, Unicode create-new, Escape, and backdrop close.

## Validation Commands and Results

| Command | Result |
| --- | --- |
| Focused Phase 4 Vitest set | PASS — 5 files, 72 tests |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm test` | PASS — unit 3978 passed / 9 skipped; history 178 passed; recovery 198 passed |
| `npm run test:ui-foundation-spike` | PASS — 27 tests |
| `npm run test:feedback-overlay` | PASS — 18 tests |
| `npm run test:platform-smoke` | PASS — 74 tests |
| `npm run test:e2e` | PASS — 174 passed / 7 skipped |
| `npm run test:e2e:draft-store` | PASS — 38 tests |
| `npm run test:e2e:auth` | PASS — 2 tests |
| `npm run test:tags-scale` | PASS — 6 tests |
| Relevant Ledger/view-mode/tag-management browser subset | PASS — 19 tests |
| `git diff --check` | PASS |
| `npm run lint:icons` | Diagnostic parity — baseline-known 8 hard / 11 soft findings; no new generic icon violation |

An initial sandboxed `npm test` invocation reported only `listen EPERM` failures from local sockets and `tsx` IPC. The identical canonical command passed when rerun in an environment where those test prerequisites were available; no assertion, timeout, skip, or product behavior was changed to obtain the pass.

## Manual Smoke Test

Checked against an isolated local vault and database:

- Setup in light theme: layout, required fields, focus, and owner creation PASS.
- Login at desktop and 390×844: layout, theme, focus, and authentication PASS.
- Vault NavBar in light and dark: layout, compact density, scope state, action alignment, and icons PASS.
- Ledger NavBar/route in dark: shared navigation and route differentiation PASS.
- AccountMenu: visual geometry, first-item focus, Settings entry, and logout PASS.
- Settings AI and Editor sections in light/dark: modal geometry, navigation, input/select/checkbox states, and focus PASS.
- CommandPalette: geometry, focused search input, listbox/no-result surface, and backdrop PASS.
- The existing narrow Vault workspace keeps its pre-existing minimum-width/horizontal-crop behavior; Phase 4 did not alter workspace layout ownership. Canonical Ledger and Diary narrow-viewport browser suites remain green.

## Known Risks

- AccountMenu remains a custom menu implementation. This is deliberate so one authority continues to own Home/End and the Account → Settings focus chain; its observable contract is covered by regression tests.
- The three Editor number fields remain mixed native/Naive controls. This preserves native number coercion and bounds until a later phase can prove `NInputNumber` equivalence.
- The repository-wide icon lint baseline is not clean. Phase 4 adds no generic violation and does not broaden scope into unrelated artwork, PDF fixtures, Mermaid, MarkMap, or Ledger domain icons.

## Deferred Work

- Phase 5: `SettingsDiaryMigrationSection` together with the Diary domain migration.
- Phase 7: `ActivityBar`, `RightRail`, `StatusBar`, `EditorTabs`, `FileTree`, Tag Management, history/timeline/tree rows, and other Vault/Note controls.
- Cleanup phase: repository-wide legacy CSS and any approved icon-lint baseline remediation.

## Phase 4 Exit Criteria

All implementation, behavioral, accessibility, theme, scope, local test, and manual visual criteria are satisfied. Phase 4 is ready to close only when the final pushed immutable HEAD has a fully green exact-head CI run; that evidence belongs in the final handoff.
