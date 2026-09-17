# D7.2 — Native Diary Context and 4×6 Mood Picker

> **Historical lineage — not current runtime authority.** Current behavior is
> defined by [Diary Architecture](../architecture/diary.md) and [Diary User
> Guide](../user-guide/diary.md). This file is retained for D7 traceability.

## Status

**D7.2 = REVIEW-CLOSED**

This document records the D7.2 implementation, validation, and independent
review closure evidence.

- Starting HEAD: `b5794392ed5dae8235ea4018f443ff89d2b35a89`
- Implementation commit: `1f8148d187e6268d3a7c6088e1150b11de203ea7` (`feat(diary): add native mood context and picker`)
- First focused remediation commit: `80db14794116b690ecc8654a8b108dcea0422e96` (`fix(diary): keep mood picker usable on mobile`)
- Second focused remediation commit: `f066164d0bbca972fc225767b79cacd6ea778eb1` (`fix(diary): clamp mood picker keyboard navigation`)
- Independent Review: `PASS`
- Independent Review findings: `P0 = 0`, `P1 = 0`, `P2 = 0`
- GitHub CI run #529: `PASS`
- Self-review: `P0 = 0`, `P1 = 0`, `P2 = 0`
- D7.1: `REVIEW-CLOSED`
- D7.3: `NOT STARTED`
- D7.4: `NOT STARTED`

The original docs-only evidence commit was the child of the implementation
commit above. The focused remediation followed the initial independent
review. The implementation/evidence phase stopped at `REVIEW-READY`; after
the independent re-review passed, this closure sync marks D7.2
`REVIEW-CLOSED`. No D7.3 work is included in this phase.

The initial independent review of the original D7.2 implementation found
`P0 = 0`, `P1 = 1`, `P2 = 1`: the mobile picker could be clipped by the
`.editor-area` overflow boundary, and an empty generic context-action rail
could remain outside Diary contexts. Those findings are retained as history;
the first focused remediation addressed them without changing the D7.2
ownership model. A subsequent independent re-review closed those original
findings but identified a new P1: flattened-index keyboard movement could
cross the fixed 4×6 grid geometry at its edges. The second focused
remediation below addresses that keyboard finding without changing the
Teleport/mobile or slot-host architecture.

## Scope

D7.2 adds the Native Vault document context for Mood Diary and one shared
controlled picker. It supports setting, changing, and clearing the Mood
metadata of an already-open canonical managed Diary document.

The implementation does not add Calendar markers or actions, missing-date
creation, a Diary route, a Diary-specific Reader or Editor, a second document
lifecycle, or a second persistence owner.

## Files changed

Production presentation and wiring:

- `src/components/diary/DiaryMoodPicker.vue`
- `src/components/diary/DiaryMoodContextAction.vue`
- `src/components/diary/diaryMoodContext.ts`
- `src/views/VaultView.vue`
- `src/components/vault/EditorTabs.vue` — generic `context-actions` slot only
- `src/composables/useI18n.ts`
- `src/style.css`

Tests and browser evidence:

- `src/components/diary/__tests__/DiaryMoodPicker.test.ts`
- `src/components/diary/__tests__/DiaryMoodContextAction.test.ts`
- `src/components/diary/__tests__/diaryMoodContext.test.ts`
- `src/components/vault/__tests__/EditorTabs.test.ts`
- `src/views/__tests__/VaultView.test.ts`
- `e2e/diary-editor-lifecycle.spec.ts`

No server, shared domain, migration, dependency, Calendar, ReaderPane, or
EditorPane file was changed by D7.2.

## Ownership and integration

`VaultView` owns the Native Diary context projection and the single mutation
entry point. `EditorTabs` exposes only a generic optional slot; it does not
import Diary code, classify paths, or own Mood state. The slot is outside the
tablist, so the context action is a document-context action rather than a
workspace tab.

The single mounted context is shared by both native presentation branches:

```text
VaultView
├── EditorTabs
│   └── one generic context-actions slot
│       └── one DiaryMoodContextAction
│           └── one DiaryMoodPicker when open
├── ReadingPane
└── EditorPane
```

READ/EDIT toggling therefore reuses the same context action, picker state, and
authoritative Mood projection. Neither `ReadingPane` nor `EditorPane` owns a
Mood control.

When open, `DiaryMoodContextAction` still owns exactly one
`DiaryMoodPicker`, but the picker is rendered through a Vue `Teleport` to
`document.body`. It is positioned as a fixed viewport popover from the
trigger's `getBoundingClientRect()`, with horizontal and vertical safe-inset
clamping and recomputation on open, resize, and scroll. This escapes the
document grid's `.editor-area { overflow: hidden }` boundary without adding a
second picker, route, tab, or document lifecycle. The picker uses global-token
fallbacks while teleported so light/dark body rendering remains legible.

The current value is projected from the existing reactive `posts` summary
whose path equals the existing `activeTab.path`. D7.2 does not introduce a
`ref` or cache for the current Mood. Local `open`, `focusedIndex`, and `busy`
values are presentation state only.

## Native Diary eligibility

The context resolver returns a value only when all of the following hold:

1. An active document tab exists and is not loading or in an error state.
2. Its path is classified by `classifyDiaryPath()` as `managed`.
3. `diaryDateFromPath()` returns the canonical `DiaryDate`.
4. The existing `posts` summary for that exact path is available.
5. Diary Calendar Home, History Comparison, Working Tree Diff, and Draft
   Recovery are not the active surface.

This excludes ordinary Notes, Inbox, Literature, Archive, Ledger, Diary root,
unmanaged/invalid/nested Diary paths, missing tabs, and special surfaces.
Calendar Home has no Native Mood control. A missing Diary is not created by
this context; a command `not-found` result only reports and refreshes through
the existing safe path.

## Canonical Mood registry

The picker consumes the single D7.1 registry in `shared/diaryMood.ts`. No
second catalog or filename map was added.

The canonical row-major order is fixed at four columns by six rows:

| Row | Column 1 | Column 2 | Column 3 | Column 4 |
| --- | --- | --- | --- | --- |
| R1 | `kiss` | `sad` | `surprised-big` | `surprised-small` |
| R2 | `watching` | `like` | `laughing` | `disappointed` |
| R3 | `afraid` | `shy` | `happy` | `smiling` |
| R4 | `amazed` | `angry` | `flirty` | `speechless` |
| R5 | `dizzy` | `indignant` | `frowning` | `mysterious` |
| R6 | `laughing-tears` | `playful` | `unwell` | `devilish` |

`happy` is R3C3. The DOM renders exactly 24 radios in this order and uses a
fixed `grid-template-columns: repeat(4, minmax(0, 1fr))`. There is no
transpose, auto-fit, pagination, or infinite scrolling. The compact CSS only
reduces padding, icon size, and gaps; it never changes the four-column
contract.

Each registry entry supplies its stable ID, Chinese and English labels,
accessible name, row/column position, and canonical `public/emoji/*.svg`
asset. The UI derives a runtime `/emoji/*.svg` URL. Persisted metadata carries
only the stable Mood ID, never an asset path or Chinese filename.

## Picker behavior

The picker is a controlled presentation component:

- The grid has `role="radiogroup"` and exactly 24 `role="radio"` buttons.
- Every radio has `aria-checked`, an accessible name, and a stable Mood ID.
- The separate Clear action is a button, not a 25th radio.
- A canonical current Mood is selected and initially focused.
- `null` shows an explicit Not set state, leaves every radio unchecked, and
  starts focus at R1C1.
- An unknown stored Mood is preserved and shown as Unknown; all canonical
  radios remain unchecked. Only an explicit canonical selection or Clear can
  replace it.
- Clear is enabled for an unknown value and emits the metadata clear intent;
  it is disabled for `null`.
- There is no default Mood.

Keyboard behavior uses roving tabindex and deterministic row/column clamping:

- Right/Left change the column within the same row and clamp at columns 1
  and 4.
- Down/Up change the row within the same column and clamp at rows 1 and 6.
- Edge movement never wraps, transposes, or crosses into another row or
  column; the resulting index is derived from the clamped row and column.
- Arrow keys only move focus and never submit a mutation.
- Enter and Space select the focused canonical Mood.
- Escape closes without mutation.
- Opening focuses the selected radio or R1C1; Escape and successful local
  close return focus to the trigger.

Busy state prevents another mutation and keeps the picker close/Escape path
available. The outside-pointer guard treats both the context trigger root and
the teleported picker root as inside targets, so clicking a radio or picker
control does not close it before the event is handled. A pointer down on an
outside interactive target closes the presentation without forcibly moving
focus back to the trigger; Escape and successful mutation continue to restore
focus to the trigger.

## Metadata mutation boundary

`VaultView` creates the one `useDiaryMoodCommand()` instance for this
document-context action and reuses the existing `historyMutationLock`.

Set, change, and clear all call:

```text
useDiaryMoodCommand.setMood(
  current DiaryDate,
  MoodId | null,
  current PostSummary.metadataUpdatedAt,
)
```

The CAS token is read from the current authoritative summary. If it is
missing, non-safe, or invalid, the trigger is disabled and no mutation is
submitted. No guessed version, `Date.now()`, raw mtime, or picker-local token
is used.

On success, the server-returned `DocumentMetadata` follows the existing
authoritative update path:

```text
onMetadataSaved(metadata)
→ applyMetadataToPostSummary(post, metadata)
→ applyPostSummary(updated)
→ existing refresh/link-index synchronization
```

There is no optimistic Mood assignment and no direct `posts[index].mood`
write. A conflict or not-found response leaves the raw document, tab, route,
active path, and dirty state alone, then uses the existing refresh seam to
reconcile authoritative metadata. Other errors keep the current projection
and report through the existing toast mechanism.

## Native document invariants

The Mood path is metadata-only:

- It does not call the Diary date creation command.
- It does not call the body save pipeline.
- It does not alter `raw`, `originalRaw`, Monaco model contents, or dirty
  state.
- It does not create or close a tab, change tab order, change `activePath`,
  navigate the router, or change view mode.
- It does not create a Mood draft, Mood Recovery path, or Mood History path.
- An existing managed future Diary document is eligible; missing-date
  Calendar orchestration remains D7.3.

The browser regression creates a managed Diary, sets `happy` in READ, enters
the native EDIT surface, makes the body dirty while autosave is intentionally
aborted, changes the Mood to `sad`, and verifies that the server raw remains
the base body, the stable document identity is unchanged, and the tab remains
dirty. The same context action remains the only instance in both branches.

The focused remediation browser regression additionally runs the native Diary
context at `320×700` and `375×812`, with the Explorer side panel both closed
and open. It asserts that the single teleported picker stays fully inside the
viewport, has four computed columns, exposes all 24 radios, keeps each option
at least 44px in both dimensions, and accepts a selection. The same browser
suite asserts that ordinary Notes and special History/Recovery surfaces have
no empty `.editor-tabs-context-actions` rail. `EditorTabs` remains generic:
its optional `contextActionsVisible` prop is only a generic slot-host
visibility signal and contains no Diary imports or path policy.

## Validation evidence

The following commands were run for the original implementation before the
independent review remediation:

```text
npm exec vitest run \
  src/components/diary/__tests__/DiaryMoodPicker.test.ts \
  src/components/diary/__tests__/DiaryMoodContextAction.test.ts \
  src/components/diary/__tests__/diaryMoodContext.test.ts \
  src/components/vault/__tests__/EditorTabs.test.ts \
  src/views/__tests__/VaultView.test.ts \
  src/composables/diary/__tests__/useDiaryMoodCommand.test.ts
→ 6 files passed, 98 tests passed

npm run test:unit
→ 235 files passed, 3508 tests passed, 2 skipped

npm exec -- playwright test e2e/diary-editor-lifecycle.spec.ts
→ 8 tests passed

npm run typecheck:client
→ PASS

npm run typecheck
→ PASS

npm run build
→ PASS
```

The first restricted-environment attempt at the full unit suite reported
only existing child TCP/tsx IPC `listen EPERM` failures; the same suite was
rerun with the allowed environment permission and passed as recorded above.
The browser suite likewise required permission to bind its local web server;
the final 8-test run passed. These are historical pre-remediation results,
not the final remediation run.

Focused remediation validation for `80db14794116b690ecc8654a8b108dcea0422e96`:

```text
npm exec vitest run \
  src/components/diary/__tests__/DiaryMoodPicker.test.ts \
  src/components/diary/__tests__/DiaryMoodContextAction.test.ts \
  src/components/diary/__tests__/diaryMoodContext.test.ts \
  src/components/vault/__tests__/EditorTabs.test.ts \
  src/views/__tests__/VaultView.test.ts \
  src/composables/diary/__tests__/useDiaryMoodCommand.test.ts
→ 6 files passed, 100 tests passed

npm exec -- playwright test e2e/diary-editor-lifecycle.spec.ts -g \
  "native Diary mood picker remains fully usable"
→ 1 test passed

npm exec -- playwright test e2e/diary-editor-lifecycle.spec.ts
→ 9 tests passed

npm run test:unit
→ 235 files passed, 3510 tests passed, 2 skipped

npm run typecheck:client
→ PASS

npm run typecheck:server
→ PASS

npm run typecheck
→ PASS

npm run build
→ PASS

git diff ad0f6b5697608234e12987117f33500d57476181..80db14794116b690ecc8654a8b108dcea0422e96 --check
→ PASS
```

The focused browser run required permission to bind the local Playwright
server; it passed after the allowed environment permission was granted. The
full unit run passed in the allowed environment as well. The build retained
only the repository's existing large-chunk and third-party annotation
warnings. No failure was a D7.2 assertion or product behavior failure.

Second focused keyboard-boundary remediation validation for
`f066164d0bbca972fc225767b79cacd6ea778eb1`:

```text
npm exec vitest run \
  src/components/diary/__tests__/DiaryMoodPicker.test.ts \
  src/components/diary/__tests__/DiaryMoodContextAction.test.ts \
  src/components/diary/__tests__/diaryMoodContext.test.ts \
  src/components/vault/__tests__/EditorTabs.test.ts \
  src/views/__tests__/VaultView.test.ts \
  src/composables/diary/__tests__/useDiaryMoodCommand.test.ts
→ 6 files passed, 100 tests passed

npm exec -- playwright test e2e/diary-editor-lifecycle.spec.ts
→ 9 tests passed

npm run test:unit
→ 235 files passed, 3510 tests passed, 2 skipped

npm run typecheck:client
→ PASS

npm run typecheck:server
→ PASS

npm run typecheck
→ PASS

npm run build
→ PASS
```

The component boundary assertions cover all four corners of the 4×6 grid:
horizontal movement stays on the same row, vertical movement stays in the
same column, and each edge remains on its current cell. They also cover
middle-cell movement in each direction and confirm that arrow navigation
emits no `select` event. The browser suite remains green for the first
mobile/Teleport remediation, native context lifecycle, and empty
context-action rail behavior.

## Scope and lifecycle checks

- Calendar production components were untouched.
- Native Reader/Editor components were untouched.
- Server, shared Diary protocol, migrations, History, Recovery, and D7.1
  foundation were untouched.
- No package, lockfile, dependency, route, or backend API change was made.
- The generic `EditorTabs` slot contains no Diary-specific policy.
- The generic `EditorTabs` context-action host is absent when the caller
  reports no rendered action, so ordinary and special surfaces do not retain
  empty tab-strip chrome.
- The mobile Mood picker is a single teleported fixed popover; no global
  `.editor-area` overflow behavior was changed.
- No D7.3 marker, Calendar picker entry, or missing-date flow was started.
- GitHub status was not queried for this local implementation evidence; the
  later GitHub CI run #529 passed and is recorded in the closure result below.

## D7.2 readiness result

The first independent re-review closed the original mobile clipping P1 and
empty context-action rail P2, but found the flattened-index keyboard
boundary P1. The second focused remediation self-review found no additional
issue and the implementation gates above pass. The subsequent independent
re-review passed with no findings. This closure sync records D7.2 as
`REVIEW-CLOSED` and keeps the phase stopped before D7.3:

```text
D7.0A = REVIEW-CLOSED
D7.0  = REVIEW-CLOSED
D7.1  = REVIEW-CLOSED

D7.2  = REVIEW-CLOSED
Initial Independent Review = FAIL (P0/P1/P2 = 0/1/1)
First remediation: mobile P1 CLOSED; empty chrome P2 CLOSED
Second focused remediation self-review = PASS (P0/P1/P2 = 0/0/0)
Independent Re-review = PASS (P0/P1/P2 = 0/0/0)
GitHub CI #529 = PASS

D7.3  = NOT STARTED
D7.4  = NOT STARTED
```

No D7.3 implementation is included in this evidence.
