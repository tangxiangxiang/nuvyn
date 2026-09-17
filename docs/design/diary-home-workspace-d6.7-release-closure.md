# D6.7 — Release Closure Evidence

> **Historical lineage — not current runtime authority.** Current behavior is
> defined by [Diary Architecture](../architecture/diary.md) and [Diary User
> Guide](../user-guide/diary.md). This file is retained for D6 traceability.

## 1. Status

```text
D6.0   = REVIEW-CLOSED
D6.1   = REVIEW-CLOSED
D6.2   = REVIEW-CLOSED
D6.2.1 = REVIEW-CLOSED
D6.3   = REVIEW-CLOSED
D6.4   = REVIEW-CLOSED
D6.5   = REVIEW-CLOSED
D6.6   = REVIEW-CLOSED

D6.7   = REVIEW-CLOSED
Final Independent Review = PASS
P0/P1/P2 = 0/0/0
```

D6.7 is a release-closure and evidence phase. It adds no production behavior,
test coverage, route, server/shared contract, package, lockfile, or dependency.
No later Diary phase was started.

## 2. Starting baseline and scope

```text
Starting HEAD: df73e7f76bef0e1f8bcaa8f225f97f0724222ebd
Branch: main
Starting worktree: clean
Starting remote relation: main == github/main
```

The D6 runtime-footprint baseline used for the release diff is the D6.0 closure
commit `1561596264b7aea5b35f0be173a2c8a06e3eaf75`. D6.0 itself was docs/evidence
only; using its closure as the runtime baseline excludes unrelated work merged
before D6.1 and captures the complete D6.1–D6.6 production/test tree.

The release closure audited current code, Git history, canonical D6 documents,
all D6.0–D6.6 evidence, focused domain/unit coverage, the final Diary browser
matrix, client/server types, and the production build. Historical PASS counts
were not reused as D6.7 results.

## 3. Release lineage matrix

| Phase | Purpose | Starting baseline | Production/test commits | Evidence/review commits | Closure commit | Final state |
| --- | --- | --- | --- | --- | --- | --- |
| D6.0 | Current-code architecture confirmation | `6674f444` | None | `77545362`, `5e82b360`, `7f0c213b` | `15615962` | REVIEW-CLOSED; PASS 0/0/0 |
| D6.1 | Presentation owner and shell | `15615962` | `95f48d31`, `72468e82`, `d753bb0f` | `9ee88431`, `360802f8`, `674369bb` | `f53b7b3a` | REVIEW-CLOSED; PASS 0/0/0 |
| D6.2 | Calendar Home migration | `f53b7b3a` | `bcbbdf0b` | `3a08aff9`, `c1b1b452` | `c2d9e6a8` | REVIEW-CLOSED; PASS 0/0/0 |
| D6.2.1 | Full-bleed Calendar polish | `c2d9e6a8` | `b24a02bf`, `85b7a4d6`, `f7721a4b`, `8ae81fd2`, `93c3db04`, test `894d57a8` | `8adb683e`, `5dee0d8a`, `e91a3bd6`, `a085bf94`, `6cf32ffc`, `b517307f` | `ce3e08c5` | REVIEW-CLOSED; PASS 0/0/0 |
| D6.3 | Native Vault Document Workspace | `82c555b8` | amendment `edfbcf07`; runtime `592a1d51`, `032b6ea0` | `0c54379d`, `1337e349` | `e550c187` | REVIEW-CLOSED; PASS 0/0/0 |
| D6.4 | Native Editor lifecycle verification | `e550c187` | tests `b5b07f18`, `61029bf9` | Evidence is maintained in the same test/docs lineage | `6d0aa02b` | REVIEW-CLOSED; PASS 0/0/0 |
| D6.5 | Scope/tab/route lifecycle regression | `6d0aa02b` | tests `06ffb2e9`, `a34d6229` | `f4d56cc3`, `f09da6c4` | `ced273ae` | REVIEW-CLOSED; PASS 0/0/0 |
| D6.6 | Responsive/accessibility verification | `ced273ae` | test `dbb76597`, runtime `feafa20d`, test `19264088` | `ee2723fa`, `03f15d1a`, wording follow-up `df73e7f7` | `4b12f13e` | REVIEW-CLOSED; PASS 0/0/0 |

All abbreviated SHAs above were resolved from the repository and correspond to
the full commits recorded in the phase evidence and Git history.

### Superseded D6.3 lineage

The former Reader Dialog lineage is historical only:

```text
d270ee5756c0f742e92955f06fa308fd6f77bc4a  Reader Dialog implementation
05fe7dc8952b21c785a303c6309369c1d1f8f03c  initial evidence
fa85f431d274e36fccbeaa0446ed63cf0d017a36  reconciliation follow-up
82c555b8dc13be22de0863c8105cc0b83cd289d1  refreshed evidence

Status: SUPERSEDED BEFORE REVIEW CLOSURE
```

Its historical review does not transfer to the replacement. The canonical,
closed D6.3 is the Native Vault Document Workspace lineage ending at
`e550c1873d77ddfd95b96d87cff935130b09c662`.

## 4. Final architecture and runtime-owner matrix

The current release contract remains:

> Calendar does navigation. Vault does documents.

| Concern | Final owner | Release finding |
| --- | --- | --- |
| Router/history | Vue Router + existing route sync | `/vault` routes only; Browser Back/Forward remains router-owned |
| Diary scope | existing scope filter | Diary remains a Vault scope, not route identity |
| Calendar mount | `VaultView` Diary-scope predicate | mounted for the whole Diary scope |
| Calendar visibility | Diary presentation owner | HOME visible; DOCUMENT/special surfaces hide without unmounting |
| Date intent | existing `openDiaryDate()` | only explicit successful Calendar intent opens DOCUMENT |
| Tabs/active path | existing tab workspace | presentation observes; `activePath` may close stale DOCUMENT but cannot open/retarget it |
| Native READ | the single ordinary `ReadingPane` slot | no Diary Reader runtime or second Markdown pipeline |
| Native EDIT/Monaco | existing `EditorPane` and path-keyed model lifecycle | no Diary Editor or second Monaco lifecycle |
| Save/dirty/draft | existing document-save lifecycle | Calendar Home is presentation-only and preserves backing state |
| History/Recovery/external conflict | existing Vault workflows | remain authoritative and have visible-surface precedence |
| FileTree exact context | generic `exactPathFilter` projection | exact file + required ancestors; no Diary parser; user `filesFilter` preserved |

The current source confirms `DiaryPresentationMode = 'home' | 'document'`.
`recordDateCommandResult()` remains an explicit handoff and leaves presentation
at HOME; only `requestDocument()` can adopt a successful current date intent
whose path equals the existing `activePath`. The `activePath` watcher is passive
reset only.

`DiaryWorkspace` contains only the kept-mounted Calendar Home slot. Native READ
and EDIT render through the ordinary `VaultView` surfaces. Repository search
found no live `DiaryReaderDialog`, `diary-reader-dialog`, or `DiaryEditor`
runtime. Other ordinary application dialogs are unrelated to Diary D6.

## 5. Calendar, FileTree, and domain/security boundaries

Final Calendar contract:

- physical identity remains `diary/YYYY-MM-DD.md`, one date per file;
- the visible title is `YYYY-MM`, Today is absent, and Prev/Next remain;
- the Calendar is full-bleed/full-height and retains 44x44 navigation targets;
- the subtree remains attached while Diary scope is active and hidden in
  DOCUMENT or special-surface presentation;
- Calendar Home does not close, save, discard, navigate, or mutate active path.

Final FileTree contract:

- `exactPathFilter` is a generic strict path projection;
- exact match retains only the file and rendering ancestors;
- a missing exact path yields an empty projection rather than the full tree;
- exact context takes precedence without changing the user's `filesFilter`;
- returning Home clears exact context and restores the preserved filter.

Domain/security boundaries remain covered by the existing strict `DiaryDate`,
one-date-one-file, future guard, managed-path and authoritative server mutation
contracts. D6 changed no `server/**`, `shared/**`, router, package or lockfile.

## 6. D6.7 fresh release validation

### Focused Vitest

```text
npm exec vitest run \
  src/components/diary/__tests__/DiaryCalendar.test.ts \
  src/components/diary/__tests__/DiaryCalendarSurface.test.ts \
  src/components/diary/__tests__/DiaryWorkspace.test.ts \
  src/components/diary/__tests__/diaryCalendarProjection.test.ts \
  src/components/diary/__tests__/VCalendarCompatibility.test.ts \
  src/composables/diary/__tests__/useDiaryDateCommand.test.ts \
  src/composables/diary/__tests__/useDiaryWorkspacePresentation.test.ts \
  src/views/__tests__/VaultView.test.ts \
  src/components/vault/__tests__/FileTree.test.ts \
  src/composables/vault/editor-tabs/__tests__/useTabWorkspace.test.ts \
  src/composables/vault/__tests__/useEditorTabs.test.ts
```

Result: **11 files / 225 tests PASS**.

### Domain/server focused validation

```text
npm exec vitest run \
  shared/__tests__/diaryProtocol.test.ts \
  server/__tests__/diary-routes.test.ts \
  server/__tests__/documentMutationPolicy.test.ts
```

Result: **3 files / 52 tests PASS**.

This fresh run covers strict DiaryDate/path semantics, one-date-one-file and
future/create authority, managed Diary mutation policy, and the generic move
guard into the Diary namespace.

### Final Diary Playwright matrix

```text
npm run test:e2e -- \
  e2e/diary-calendar-surface.spec.ts \
  e2e/diary-reader.spec.ts \
  e2e/diary-editor-lifecycle.spec.ts \
  e2e/diary-lifecycle-regression.spec.ts \
  e2e/diary-responsive-accessibility.spec.ts \
  e2e/diary-release.spec.ts \
  e2e/vcalendar-compatibility.spec.ts
```

The first sandboxed attempt was environment-limited because the preview server
could not bind `127.0.0.1:4174` (`EPERM`). The same unchanged command was rerun
with local-server permission and completed **7 files / 39 Chromium tests PASS**.

Fresh browser coverage includes:

- Calendar explicit navigation, native READ/EDIT, save, dirty and same-date
  identity continuity;
- dirty History Comparison, History Restore, baseline Recovery, divergent
  Recovery and external CAS conflict resolution through existing owners;
- scope exit/re-entry, manual tab selection, active/non-active close, refresh,
  direct deep link and real Browser Back/Forward;
- responsive Calendar and native READ/EDIT at 1280x800, 768x1024, 375x812 and
  320x700, plus the existing 601/600 and 421/420 breakpoint checks;
- keyboard focus, E/S/W boundaries, hidden Calendar focus isolation, semantic
  return focus, light/dark and English/Chinese labels;
- ordinary note, archive and ledger documents retaining native Vault surfaces;
- repeated DOCUMENT/HOME cycles, markers and exact-stack VCalendar behavior.

The diagnostic assertions completed with `pageErrors = []`, no unexpected
console errors, and no `dayIndex` runtime failure. Narrow expected diagnostics
remain limited to the suites' deliberate aborted-request, exact future 404 and
external-conflict 409 cases; no broad console-ignore rule was added.

### Static validation

```text
npm run typecheck:client  PASS
npm run typecheck         PASS
npm run build             PASS
git diff --check          PASS before documentation edits
```

The build emitted only the existing third-party pure-annotation and large-chunk
warnings and exited successfully.

## 7. Responsive, accessibility, and ordinary Vault summary

| Release area | Fresh result |
| --- | --- |
| 1280x800 Calendar / READ / EDIT | PASS |
| 768x1024 Calendar / READ / EDIT | PASS |
| 375x812 Calendar / READ / EDIT | PASS |
| 320x700 Calendar / READ / EDIT | PASS |
| Keyboard and focus-visible behavior | PASS |
| Hidden Calendar focus isolation | PASS |
| No page-level horizontal overflow | PASS |
| Ordinary note workspace | PASS |
| Archive descendant workspace | PASS |
| Ledger workspace | PASS |

No Diary exact context or Calendar presentation leaked into the ordinary
note/archive/ledger journeys.

## 8. Production footprint and dependency audit

The release footprint diff from the D6.0 closure baseline
`1561596264b7aea5b35f0be173a2c8a06e3eaf75` to the D6.7 starting HEAD contains
31 files: D6 docs, Diary/browser tests, and the already-reviewed production
footprint in Diary Calendar/Workspace presentation, generic FileTree,
`VaultView`, supporting style/i18n, and the Diary Home keyboard helper.

Final D6 production ownership changes are confined to the closed D6 phases.
There are no changes in:

```text
server/**
shared/**
src/router/**
useRouteSync / useTabWorkspace / useEditorTabs / useDocumentSave
package.json
package-lock.json
dependencies
```

Installed exact versions remain:

```text
v-calendar@3.1.2
@popperjs/core@2.11.8
```

D6.7 itself changes docs only and adds no test or production commit.

## 9. STOP-condition audit

No D6.7 STOP condition was triggered:

- no production, server/shared, router, lifecycle-owner or dependency fix was
  required;
- no Reader/Dialog runtime, second ReadingPane, Diary Editor, second Monaco,
  second save/raw lifecycle, route-derived intent or activePath-derived intent
  was found;
- Calendar stayed mounted in Diary scope and no `dayIndex`/page error appeared;
- History, Recovery, external conflict, dirty/raw identity, ordinary Vault,
  320px layout and keyboard/focus regressions all passed;
- tests left no tracked fixture, draft, history or content pollution.

## 10. Rollback and repository state

D6.7 has **no runtime rollback** because it changes no runtime code. The D6
runtime remains the independently closed D6.6 tree. Documentation rollback is
informational-only and consists of reverting the D6.7 docs/evidence commit; it
is not an asserted production-history rollback chain.

GitHub status was not queried during this D6.7 execution. No CI PASS is claimed.

## 11. Conclusion

The D6.0–D6.6 closed lineage, final ownership boundaries, domain protections,
ordinary Vault compatibility, responsive/accessibility contract, native
document lifecycle and VCalendar compatibility all passed fresh release
validation without a production or test change.

```text
D6.7 = REVIEW-CLOSED
Final Independent Review = PASS
P0/P1/P2 = 0/0/0

Entire D6 release = REVIEW-CLOSED
```

Stop here. Entire D6 is REVIEW-CLOSED and no later phase has started.
