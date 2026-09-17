# Diary V1 Final Closure

**Status:** Diary V1 = CLOSED; Runtime = FROZEN; Maintenance Mode = ACTIVE  
**Closure date:** 2026-09-14  
**Branch:** `main`  
**Runtime baseline:** `3096661e24861f3893546eeeb277c91342805654`  
**Runtime baseline commit:** `test(diary): cover d c close flow`  
**CI:** [#809](https://github.com/tangxiangxiang/nuvyn/actions/runs/34801186048) — passed

This is the final closure record for Diary V1. It is not a replacement for the
current runtime authority. The maintained authority is the [Diary
Architecture](../../architecture/diary.md) and the [Diary User
Guide](../../user-guide/diary.md). If this historical record, an older design
document, and the runtime disagree, the current authority documents and code
take precedence.

## Closure verdict

Diary V1 satisfies the current closure conditions. The date-based Calendar
workspace, native document lifecycle, Mood metadata, Diary privacy boundary,
migration workflow, responsive/accessibility contracts, and Diary `D → C`
shortcut are implemented and covered by the current test matrix.

The final audit found no open P0, P1, or P2 issue. Diary V1 is therefore
frozen and moves to Maintenance Mode. “Closed” means that the current
implementation is the stable V1 baseline; it does not delete the feature or
prevent a separately approved future scope.

## 1. Runtime baseline and CI evidence

The baseline was verified on `main` at:

```text
3096661e24861f3893546eeeb277c91342805654
test(diary): cover d c close flow
```

The runtime baseline was the last Diary runtime-changing state on `main`.
Subsequent documentation-only commits do not change the closed Diary V1
runtime. GitHub Actions run [#809](https://github.com/tangxiangxiang/nuvyn/actions/runs/34801186048)
completed successfully. Its required lanes all passed:

| CI lane | Result |
| --- | --- |
| `integration-recovery` | PASS |
| `integration-history` | PASS |
| `e2e-application` shard 1/2 | PASS |
| `e2e-application` shard 2/2 | PASS |
| `draft-store-e2e` | PASS |
| `docker-smoke` | PASS |
| `auth-browser` | PASS |
| `static-check` | PASS |
| `unit` | PASS |
| `visual` | PASS |
| `tags-scale` | PASS |
| `platform-compatibility` — Ubuntu, Node 22 | PASS |
| `platform-compatibility` — Windows, Node 24 | PASS |
| `platform-compatibility` — macOS, Node 24 | PASS |

The closure documentation commits are intentionally separate from the runtime
baseline. They document and classify the already-verified implementation; they
must not be treated as a new Diary runtime baseline.

## 2. Closed product contract

### Calendar Home and date identity

- Diary is a date-based navigation workspace inside the existing `/vault`
  route.
- The stable identity is the local-civil `YYYY-MM-DD` date, with logical path
  `diary/YYYY-MM-DD` and physical path `diary/YYYY-MM-DD.md`.
- Calendar Home owns month navigation and date intent. The existing Vault
  lifecycle owns the document opened for that date.
- Existing dates open directly. Missing today/past dates use the Mood-first
  creation flow. A missing future date is not created.
- Current month, Today state, and Mood projection survive the Calendar Home ↔
  native document handoff. Returning Home clears the transient date selection.

### Calendar runtime and accessibility

The current provider is Naive UI `NCalendar` `2.45.3`; the package and
production code contain no `v-calendar` dependency or import. Nuvyn owns the
date adapter, local-civil semantics, weekday labels, date buttons, Mood
controls, Today/Selected states, and business ARIA/data attributes. Naive UI
owns the provider panel and navigation primitives.

The supported contract includes adjacent-month identity, responsive month
navigation, no horizontal overflow, minimum navigation touch targets, weekday
semantics, `aria-current` for Today, `aria-pressed` for the live Calendar
selection, keyboard focus, dark/light themes, and stable behavior across the
supported responsive matrix.

### Native Diary documents

Opening a date resolves the canonical exact path and enters the existing native
Vault READ/EDIT document lifecycle. Diary does not maintain a second editor,
History engine, Recovery engine, draft store, dirty protocol, or tab system.
The active tab, save/dirty barrier, close confirmation, and post-close fallback
remain owned by Vault.

### Mood

Mood is current SQLite document metadata, separate from the Markdown body. The
shared Mood registry owns stable IDs, labels, accessibility names, ordering,
and assets. The Calendar and `DiaryMoodPicker` present it; the existing
compare-and-set metadata command owns writes and conflict behavior. Mood stays
visible after close, reopen, refresh, and month changes, including the safe
representation of unknown well-formed stored IDs.

### Privacy, encryption, and migration

Diary access is a separate session-bound capability boundary. Managed body
operations require that capability and use the current versioned
AES-256-GCM body envelope with identity binding. Structural Calendar metadata
can remain available without exposing body content; generic body operations
without an adapter-aware privacy owner fail closed.

`DiaryMigrationService` owns legacy inventory, consent/provenance, encrypted
candidate preparation and verification, platform-specific finalization, and
residual/attention reporting. Legacy plaintext is not silently deleted.

### Diary `D → C`

`D → C` is a Diary-scoped two-key chord, not a simultaneous modifier shortcut.
It has a `1000ms` window, excludes meta/ctrl/alt combinations, ignores text
entry and blocking overlay contexts, and resets on timeout, scope or active
presentation changes, blur, visibility changes, and unmount. Calendar Home is
a no-op. A completed chord calls the same `closeWorkspaceTab()` authority as
the tab close button, so dirty/save/discard and adjacent-tab selection policy
are shared. The future `N → C` idea is not implemented.

## 3. Current authority

These are the maintained Diary authorities:

- [Diary Architecture](../../architecture/diary.md) — current runtime
  ownership, state, boundaries, privacy, and invariants.
- [Diary User Guide](../../user-guide/diary.md) — current user-visible Diary
  behavior and workflows.
- [Documentation index](../../README.md) — current navigation and historical
  classification.

The relevant implementation authority remains in the runtime, including
[`DiaryCalendar.vue`](../../../src/components/diary/DiaryCalendar.vue),
[`DiaryCalendarSurface.vue`](../../../src/components/diary/DiaryCalendarSurface.vue),
[`DiaryWorkspace.vue`](../../../src/components/diary/DiaryWorkspace.vue),
[`useDiaryDateCommand.ts`](../../../src/composables/diary/useDiaryDateCommand.ts),
[`diaryShortcutChord.ts`](../../../src/views/diaryShortcutChord.ts), and the
Vault close owner in [`VaultView.vue`](../../../src/views/VaultView.vue).

## 4. Historical lineage

The following documents remain useful for traceability, but are not current
runtime authority:

- Early Diary product and implementation planning:
  [`diary-prd.md`](../../design/diary-prd.md) and
  [`diary-implementation-plan.md`](../../design/diary-implementation-plan.md).
- D6 Home Workspace lineage:
  [`diary-home-workspace-prd.md`](../../design/diary-home-workspace-prd.md),
  [`diary-home-workspace-implementation-plan.md`](../../design/diary-home-workspace-implementation-plan.md),
  and [`diary-home-workspace-d6.7-release-closure.md`](../../design/diary-home-workspace-d6.7-release-closure.md).
- D7 Mood lineage:
  [`diary-mood-prd.md`](../../design/diary-mood-prd.md),
  [`diary-mood-implementation-plan.md`](../../design/diary-mood-implementation-plan.md),
  and [`diary-mood-d7.6-release-closure.md`](../../design/diary-mood-d7.6-release-closure.md).
- D8 encryption and migration lineage:
  [`diary-encryption-implementation-plan.md`](../../design/diary-encryption-implementation-plan.md),
  [`diary-encryption-d8.4-implementation-evidence.md`](../../design/diary-encryption-d8.4-implementation-evidence.md),
  and [`diary-encryption-d8.4-migration-release-prd.md`](../../design/diary-encryption-d8.4-migration-release-prd.md).
- The former provider investigation:
  [`diary-vcalendar-compatibility-report.md`](../../design/diary-vcalendar-compatibility-report.md).

All Diary design, implementation, review, and evidence files under
`docs/design/` now carry a prominent Historical notice linking to the current
architecture and user guide. They were not physically moved: the repository
contains dense historical and cross-document links, so preserving their paths
avoids a broad link migration and broken references. Authority correctness is
more valuable here than directory purity.

In particular, old VCalendar claims, early Reader Dialog decisions, and
statements that Mood or encryption were not implemented are historical
statements only.

## 5. Final code audit

The closure audit checked the current main runtime rather than relying on old
closure notes:

- `DiaryCalendar`, `DiaryCalendarSurface`, and `DiaryWorkspace` are the current
  Calendar/presentation surfaces.
- The Calendar uses Naive UI `NCalendar`; `v-calendar` is absent from the
  current dependency and production-import truth.
- `selectedCalendarValue` and `clearSelection()` implement the transient
  selection lifecycle, including cleanup on Calendar Home return.
- `D → C` is registered once by `VaultView` and routes to the existing
  `closeWorkspaceTab()` command with text-entry and blocking-overlay guards.
- Mood registry, metadata, picker, CAS update, lifecycle, and accessibility
  surfaces are present.
- Diary opens native Vault documents and does not duplicate editor, dirty,
  history, recovery, or tab lifecycle ownership.
- No core Diary V1 `TODO`/`FIXME` blocker was found.

## 6. Test and invariant audit

The current matrix protects the following stable contracts:

| Contract | Representative coverage |
| --- | --- |
| Date mapping and local-civil identity | date command and Calendar adapter unit tests |
| Calendar surface, month/header, Today/Selected, and ARIA | [`diary-calendar-surface.spec.ts`](../../../e2e/diary-calendar-surface.spec.ts), [`diary-release.spec.ts`](../../../e2e/diary-release.spec.ts) |
| Responsive and accessibility behavior | [`diary-responsive-accessibility.spec.ts`](../../../e2e/diary-responsive-accessibility.spec.ts), Mood responsive/accessibility suites |
| Native READ/EDIT and document lifecycle | [`diary-reader.spec.ts`](../../../e2e/diary-reader.spec.ts), [`diary-editor-lifecycle.spec.ts`](../../../e2e/diary-editor-lifecycle.spec.ts), [`diary-lifecycle-regression.spec.ts`](../../../e2e/diary-lifecycle-regression.spec.ts) |
| Mood lifecycle, conflict, and persistence | Mood composable/component tests and lifecycle regression E2E |
| Access, encrypted body, migration, and fail-closed behavior | Diary access fixture E2E, server access/body/migration tests, and CI integration lanes |
| `D → C` state machine and real browser integration | [`diaryShortcutChord.test.ts`](../../../src/views/__tests__/diaryShortcutChord.test.ts) and the real browser flow in [`diary-responsive-accessibility.spec.ts`](../../../e2e/diary-responsive-accessibility.spec.ts) |

The browser integration covers Calendar Home → open an existing Diary → real
`page.keyboard` `d`/`c` input → native document close → the same Calendar month,
cleared selection/`aria-pressed`, retained Mood, no reload, and Diary scope.

## 7. Maintenance Mode and reopen policy

After this closure, Diary V1 may be reopened only for:

1. A correctness bug.
2. Data loss or corruption risk.
3. A privacy or security issue.
4. An accessibility regression.
5. A regression on a supported platform.
6. An explicitly approved Diary V2 requirement.

Cosmetic preference, speculative refactoring, “顺手优化”, unmeasured cleanup,
another Calendar library migration, and new shortcut ideas do not reopen Diary
V1 by default. They belong in a separately scoped backlog item or V2 proposal.

## 8. Final status

**Diary V1 = CLOSED**  
**Runtime = FROZEN**  
**Maintenance Mode = ACTIVE**
