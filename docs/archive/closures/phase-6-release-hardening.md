# Phase 6 Release Hardening Baseline

Date: 2026-07-16  
Baseline: History Phases 1–5 and Tags are feature-frozen. Phase 6 adds no product capability.

## Release result

- No known P0 or P1 issue remains in the audited scope.
- The full unit/component/integration suite passes: 85 files, 861 tests.
- Type checking, production build, and the repository's icon lint pass.
- Workspace close transitions are behavior-tested rather than inferred from source strings.
- Editor dirty state remains independent from Git dirty state.
- Retained Diff content is refreshed after its Current document closes.
- Stale Vault refresh responses cannot replace newer tree or post-list state.
- Closing during autosave waits for the in-flight save chain before removing the tab.

## Hardening changes

### Workspace and document state

- Extracted deterministic single/batch Workspace close coordination into a pure state-transition module.
- Dirty confirmation completes before any batch mutation; cancellation is atomic.
- Current, History, and Diff fallback selection stays on the same document when possible.
- A retained Diff refreshes only after its Current editor tab has been removed, so discarded memory content cannot remain labelled Current.
- Batch close refreshes only comparisons that were not closed in the same operation.
- Added behavioral coverage for retained comparisons and batch close cancellation.

### Async races

- Document close cancels unsent debounce timers, waits for in-flight serialized saves, and clears trailing timers before removing state.
- Concurrent Vault refreshes use a monotonically increasing request id; only the newest response may publish tree/posts.
- Existing History Snapshot and Diff request guards continue to reject stale revision responses.

### Monaco lifecycle and bundle boundary

- Split the lightweight Markdown model registry from the Monaco-owning module.
- Non-editor Vault code can dispose registered models without statically importing Monaco.
- Monaco is now contained behind the lazy `EditorPane` boundary.

Production bundle comparison:

| Chunk | Before | After |
| --- | ---: | ---: |
| shared `useEditorPreferences` chunk | 2,561.52 kB / 659.07 kB gzip | 3.98 kB / 1.34 kB gzip |
| lazy `EditorPane` chunk | 1,095.23 kB / 278.75 kB gzip | 3,645.39 kB / 931.25 kB gzip |

The total Monaco payload was not removed; it was moved out of the initial shared path and into the editor's lazy chunk.

### Internationalization and accessibility

- Audited Vault navigation, activity controls, FileTree, History loading, AI rail, metadata/settings dialogs, status/TOC/links panels, archive flows, confirmation UI, tooltips, toasts, and ARIA labels.
- User-visible copy now uses `useI18n()` in the audited paths.
- Metadata dates use the application locale (`zh-CN` or `en-US`), not the browser default.
- Locale-sensitive tests set and restore locale explicitly to avoid module-level leakage.
- Loading announcements use `role="status"`; document errors use `role="alert"`.
- Destructive confirmation focuses Cancel by default, traps focus, cancels with Escape, and restores the invoking focus.

### Test infrastructure

- Server mount tests use an isolated in-memory SQLite database instead of the working `data/nuvyn.db`, removing Windows file-lock coupling.
- Real-Git integration cases with intentional filesystem/commit work have explicit 15-second limits; ordinary tests retain the default timeout.
- Test harness setup now waits for mounted refresh and file-change subscription microtasks before publishing events.
- The static logo source is bound so Vite SSR component tests do not attempt to resolve it as a module import.

## Regression coverage

Automated coverage includes:

- Current/History/Diff selection and deterministic fallback.
- dirty close, batch-close cancellation, Close Others, and retained Diff refresh.
- autosave serialization, edit-during-save, close-during-save, restore, external updates, and stale refresh rejection.
- route synchronization, tab restoration and hard-cap behavior, duplicate-tab prevention, and invalid document loading.
- Timeline, Snapshot, Diff, restore success/failure/partial-refresh states, focus transitions, and Git dirty refresh.
- File/Tag filters, reading-mode-related panels, AI rail UI, keyboard navigation, dialogs, localized copy, and ARIA semantics.

Manual in-app browser path completed:

```text
Vault mount
→ Files
→ open Current document
→ History Timeline
→ select document history
→ open Snapshot
→ open Diff
```

The accessibility tree confirmed distinct Current, History, and Diff Workspace tabs; localized toolbar labels; status announcements; and the expected Snapshot/Diff viewer regions.

## Performance baseline

Environment: local Windows development server at `127.0.0.1`, warm browser session, 2026-07-16. Browser interaction figures include a full accessibility-tree snapshot after the click, so they are conservative upper bounds rather than pure input-to-paint measurements.

| Scenario | Result | Notes |
| --- | ---: | --- |
| warm Vault reload to visible main region | 169 / 145 / 137 ms | three runs |
| first normal document open | 3,083 ms upper bound | includes cold lazy Monaco load and full DOM snapshot |
| open History Timeline | 323 ms upper bound | includes full DOM snapshot |
| open Snapshot | 340 ms upper bound | includes full DOM snapshot |
| open Diff | 310 ms upper bound | includes full DOM snapshot |
| 500,000-character editor component path | 1 ms test body | mocked-Monaco component regression; verifies folding and smooth scrolling are disabled, not a browser paint benchmark |
| switch among 20 Workspace tabs | not applicable | product hard-caps document restoration/opening at 9 tabs (`TAB_HARD_LIMIT = 9`) |

Initial Vault state did not contain an editor surface or Monaco resource. After opening a document the editor appeared, confirming lazy-load behavior.

The large-document number is deliberately labelled as component-level evidence. A repeatable real-browser paint benchmark needs a dedicated, non-user Vault fixture and is not introduced in this feature-frozen phase.

## Verification commands

| Command | Result |
| --- | --- |
| `npm test -- --run` | passed — 85 files, 861 tests, 80.37 s |
| `npm run typecheck` | passed — `vue-tsc --noEmit -p tsconfig.app.json` |
| `npm run build` | passed — 3,617 modules, 1.81 s Vite build |
| `npm run lint:icons` | passed — 81 SVG elements, no violations |
| `git diff --check` | passed; only Git's configured LF-to-CRLF notices |

## Known non-blocking warnings

- Rolldown reports two misplaced `/* #__PURE__ */` annotations inside the third-party `@vueuse/core` distribution. They do not fail the build.
- Vite reports chunks over 500 kB. The largest is the lazy `EditorPane`/Monaco chunk; it no longer contaminates the initial shared Vault path.
- Real Git integration tests are comparatively slow on Windows because they create repositories and commits on disk. They remain isolated and passing.

## Scope held for later phases

No arbitrary revision comparison, Git Graph, automatic snapshots, Tag expansion, graph/backlink redesign, new AI tools, editor features, or visual redesign was added.
