# Diary Architecture

> This is the current runtime authority for Diary. If this document, a
> historical design record, and the code disagree, the current code and this
> document take precedence over historical planning.

**Runtime baseline:** `3096661e24861f3893546eeeb277c91342805654`  
**Last audited:** 2026-09-14  
**Maintenance state:** Diary V1 is closed; maintenance mode is active.

## 1. Product identity

Diary is one of Nuvyn's first-level Personal OS Workspaces. Its specialization
is:

```text
Diary → What I experience
```

It is a date-based navigation workspace, not a second editor or an independent
diary app. Calendar navigation finds a day; Vault owns the document that
represents that day.

The stable identity is a validated local civil date:

```text
DiaryDate       YYYY-MM-DD
Logical path    diary/YYYY-MM-DD
Physical path   diary/YYYY-MM-DD.md
```

`DiaryDate` is a strict Gregorian date string. It is not a timestamp and is
never interpreted by converting UTC midnight. The server owns the canonical
date/path command and the exact path is also the identity used by document
metadata and the Vault lifecycle.

New managed Diary bodies are written using the current Diary body envelope.
The live metadata row remains in SQLite; a legacy plaintext body is a
migration state, not the current write format.

## 2. Workspace and ownership model

Diary is an existing `diary` scope inside the `/vault` route. It does not add a
second route, tab system, editor, or document identity layer.

| Concern | Current owner |
| --- | --- |
| Diary scope and access gate | `App.vue`, `useDiaryAccessSession`, and the Diary access context |
| Calendar Home shell | `DiaryWorkspace.vue` and `DiaryCalendarSurface.vue` |
| Date projection and Calendar adapter | `diaryCalendarProjection.ts` and `diaryCalendarAdapter.ts` |
| Calendar presentation | `DiaryCalendar.vue` with Naive UI `NCalendar` |
| Date open/create intent | `useDiaryDateCommand.ts`, orchestrated by `VaultView.vue` |
| Document tabs and active document | `useEditorTabs`, `useTabWorkspace`, and `VaultView.vue` |
| Read/edit/save/history/recovery lifecycle | the existing Vault components and composables, subject to Diary privacy gates |
| Diary body privacy | `server/diaryAccess/` and the guarded Diary routes |
| Legacy encrypted migration | `DiaryMigrationService` and the Settings migration workflow |

The ownership rule is:

> Calendar does navigation. Vault does documents.

## 3. Calendar Home and native document presentation

The normal presentation path is:

```text
Diary scope
  -> Calendar Home
  -> explicit date intent
  -> useDiaryDateCommand.openDiaryDate()
  -> existing Vault openPost()/tab lifecycle
  -> native READ or EDIT surface
  -> existing tab close authority
  -> Calendar Home
```

`useDiaryWorkspacePresentation` owns only the Calendar Home/native-document
visibility handoff. The Calendar subtree remains mounted for the Diary scope
and is hidden while a native Diary document is visible. This preserves the
Naive UI Calendar's internal state across the handoff without making the
Calendar a document owner.

Opening a date records the successful date command explicitly. Observing an
active path or selecting a generic Vault tab cannot synthesize a Calendar
date intent or retarget Diary presentation.

When the final managed Diary document is closed, the presentation returns to
Calendar Home. The current month and projected metadata remain available; the
Calendar's interaction selection is cleared on the Home transition.

## 4. Calendar runtime

The current provider is Naive UI `NCalendar` version `2.45.3`. The runtime has
no `v-calendar` package or production import. The Nuvyn integration is kept at
the presentation boundary:

- `diaryCalendarAdapter.ts` converts provider fields to and from validated
  local-civil Diary dates and months.
- `diaryCalendarProjection.ts` projects Vault tree and metadata into the
  Calendar's day model.
- `DiaryCalendar.vue` owns Nuvyn date buttons, month display, weekday labels,
  mood controls, Today/Selected presentation, and Nuvyn-owned ARIA/data
  attributes.
- Naive UI owns the Calendar panel and its month navigation primitives;
  Nuvyn annotates the rendered previous/next controls with stable labels and
  test attributes.

Month navigation uses the provider's panel-change boundary and preserves the
current `DiaryCalendarMonth`. The weekday row is Nuvyn-owned and follows the
active locale (`zh-CN` begins Monday; `en-US` begins Sunday). Adjacent-month
cells retain valid date identity and can navigate to that month through the
same date adapter.

Existing dates can be opened. A missing local-today or past date enters the
Calendar Mood-first flow before the canonical date command creates it. A
missing future date is not created. Existing future files remain ordinary
existing documents and are resolved through the same exact-path command.

The Calendar date button is the business interaction owner. It exposes
`data-diary-day-content`, `data-date`, `aria-current` for local Today, and
`aria-pressed` for the current Calendar selection. Naive UI class names are
used only for layout compatibility, not for Diary business semantics.

## 5. Selection semantics

Selected is a live Calendar Home interaction state, not a historical record of
the last opened Diary. It is held by `DiaryCalendar`'s
`selectedCalendarValue` and is set only by an explicit Calendar date
interaction.

The lifecycle is:

```text
Calendar Home        selected = null
  -> click/keyboard date
Diary document       selected date may remain in mounted Calendar state
  -> close / return Home
Calendar Home        clearSelection(); selected = null
```

The return transition intentionally keeps the Calendar mounted, so it does
not reset unrelated state. It preserves the current month, mood projection,
and Today styling while clearing the stale selected marker and its
`aria-pressed="true"` semantics.

## 6. Mood architecture

Mood is a Diary metadata field, not part of the Markdown body. The current
metadata owner is the `documents.mood` field exposed through the existing
document metadata API. Explicit Mood writes require the current metadata
version and are applied through the shared compare-and-set mutation path.

The framework-independent registry in `shared/diaryMood.ts` owns stable Mood
IDs, labels, accessibility names, order, and canonical assets. User-managed
icon preferences can add configured custom IDs without changing the persisted
meaning of existing IDs.

`DiaryMoodPicker.vue` owns the picker surface. `DiaryCalendar.vue` presents one
mood action per day and keeps that action separate from date navigation.
`useDiaryMoodCommand.ts` performs the authoritative CAS update; it does not
create a file or open a document on its own. Missing today/past dates are
created by the existing date command before their Mood update completes.

Mood remains visible after closing and reopening a Diary, survives refresh,
and is projected back into Calendar without copying body content. Unknown but
well-formed stored IDs remain representable and use the safe unknown-Mood
presentation.

## 7. Native document lifecycle

Diary documents are ordinary Vault workspace documents after the date command
has resolved their canonical path. The active tab authority is the live
workspace state in `VaultView.vue`, derived from the existing editor,
comparison, and recovery tab owners; it is never inferred from the last DOM
node or the last clicked date.

The close path is shared by the tab close button and keyboard commands:

```text
closeWorkspaceTab(id)
  -> closeWorkspaceTabState()
  -> useEditorTabs.closeTab()
  -> existing mutation barrier and dirty/save policy
  -> remove the document tab
  -> existing workspace fallback selection
```

If the active document is dirty, the existing confirmation/save/discard policy
decides whether the close proceeds. Cancel leaves the tab and its selection
unchanged. A successful close uses the existing workspace fallback policy,
which prefers the remaining tab at the closing position and then the adjacent
tab, with companion diff handling kept by the generic workspace owner. If no
tab remains, `VaultView` focuses the Vault root and Diary presentation returns
to Calendar Home when the Diary scope is active.

Diary does not duplicate Monaco, ReadingPane, save, History, Recovery, draft,
or tab lifecycle code. Privacy restrictions may intentionally make a generic
surface unavailable for a managed encrypted Diary; that is a guarded policy
boundary, not a second Diary implementation.

## 8. Diary `D → C` shortcut

`D → C` is a Diary-only two-key chord named Diary Close. It is registered once
by `VaultView.vue` through `createDiaryShortcutChord()` and is processed by the
existing Vault keydown authority.

Current contract:

- timeout: `1000ms`;
- keys are matched case-insensitively using `event.key`;
- `metaKey`, `ctrlKey`, and `altKey` cancel/exclude the chord;
- input, textarea, select, contenteditable, textbox, Monaco, and other text
  entry contexts are ignored;
- blocking dialogs/popovers own the keyboard and prevent background close;
- scope changes, active-tab/presentation changes, blur, visibility changes,
  timeout, and unmount reset pending state;
- Calendar Home is a no-op because it has no active managed Diary document;
- a completed chord calls the same `closeWorkspaceTab(activeId)` path used by
  the tab close button.

The future `N → C` idea is not implemented and is not part of the current
shortcut contract.

## 9. Privacy, encryption, and migration

Diary access is a separate secondary-password boundary, distinct from the
Nuvyn owner login. `App.vue` requests access before entering Diary, and the
server `DiaryAccessService` owns the session-bound capability. The service
derives a Diary-only key-encryption key with the bounded existing scrypt
parameters, unwraps a random Diary data-encryption key, and keeps live key
material in the server-side capability boundary. The raw key is not exposed to
routes or persisted as a body value.

The current body format is a versioned AES-256-GCM envelope with vault,
document, and logical-path identity binding. New Diary writes emit that
envelope. Body reads and writes run through `withDiaryBodyOperation()` and
are fenced by the access-session epoch; explicit lock, logout, session expiry,
and capability replacement invalidate new work and drain active operations
before releasing the capability.

Managed Diary body routes require the active capability. Structural Calendar
metadata can remain available without decrypting body content, while generic
operations that would scan, rewrite, version, recover, or expose an encrypted
body are rejected or kept fail-closed unless they have an adapter-aware owner.

Legacy migration is owned by `DiaryMigrationService`, not by the Calendar or
the editor. The Settings workflow explicitly scans, records an immutable
inventory, prepares or verifies encrypted candidates, handles platform
capability differences, and reports residuals or attention states. On
platforms requiring user finalization, Nuvyn gives the user the replacement
steps and verifies the result; it does not silently delete a legacy plaintext
primary. The migration ledger records structural/provenance state and does
not become a plaintext body store.

## 10. Boundaries

Diary-specific authority is limited to:

- canonical date identity and date-command rules;
- Calendar month/navigation presentation;
- Mood metadata and icon presentation;
- Diary access/privacy and migration contracts;
- Calendar Home/native-document presentation state;
- Diary-scoped `D → C` shortcut policy.

Diary must not copy or become the owner of the Vault editor, generic document
tabs, save/dirty protocol, History, Recovery, draft store, filesystem safety,
authentication, or generic document lifecycle. Note and Ledger remain outside
Diary's scope.

## 11. Invariants and test coverage

The current test matrix protects these stable contracts:

| Invariant | Coverage category |
| --- | --- |
| Strict date/path identity and local-civil behavior | shared protocol and Calendar adapter tests |
| Calendar surface, month navigation, weekday/header, Today/Selected, and ARIA | Calendar component tests and Calendar surface/release E2E |
| Mood registry, picker, CAS, conflict, lifecycle, and responsive behavior | Mood component/composable tests and Mood E2E |
| Native READ/EDIT and ordinary Vault lifecycle reuse | Diary reader/editor/lifecycle E2E |
| Selection cleanup, retained month, scope and route handoff | lifecycle regression and responsive E2E |
| Access sessions, encrypted body fail-closed behavior, and teardown | Diary access/body unit and integration tests |
| Legacy migration ownership, recovery, consent, and platform states | migration service/route tests and CI integration lanes |
| `D → C`, text-entry/overlay guards, timeout, and browser integration | `diaryShortcutChord` unit tests and the real Diary browser E2E |
| Release regressions and cross-platform compatibility | Diary release suite and the full CI matrix |

The latest baseline CI run passed all required jobs. The final closure audit
found no open P0, P1, or P2 issue.

## 12. Historical lineage

The D0–D8 planning, implementation, review, and evidence files under
`docs/design/` remain useful for traceability, but they are historical
lineage. In particular, old VCalendar claims, early Reader Dialog decisions,
and statements that Mood or encryption were not implemented must not be used
to infer current behavior. The maintained user-facing authority is
[`Diary User Guide`](../user-guide/diary.md); the maintained technical
authority is this document.
