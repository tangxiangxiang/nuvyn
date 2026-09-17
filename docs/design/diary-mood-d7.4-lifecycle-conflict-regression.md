# D7.4 — Lifecycle and Conflict Regression Evidence

> **Historical lineage — not current runtime authority.** Current behavior is
> defined by [Diary Architecture](../architecture/diary.md) and [Diary User
> Guide](../user-guide/diary.md). This file is retained for D7 traceability.

## Status

`D7.4 = REVIEW-CLOSED`

D7.4 Final Gate: `PASS`

D7.4 Final Gate findings: `P0 = 0`, `P1 = 0`, `P2 = 0`

`D7.4 Round 1 = REVIEW-CLOSED`

Independent Review: `PASS`

Independent Review findings: `P0 = 0`, `P1 = 0`, `P2 = 0`

`D7.4 Round 2 = REVIEW-CLOSED`

Independent Review: `PASS`

Independent Review findings: `P0 = 0`, `P1 = 0`, `P2 = 0`

Round 2 self-review findings: `P0 = 0`, `P1 = 0`, `P2 = 0`

Self-review findings: `P0 = 0`, `P1 = 0`, `P2 = 0`

`D7.4 Round 3 = REVIEW-CLOSED`

Independent Re-review: `PASS` — `P0 = 0`, `P1 = 0`, `P2 = 0`

Historical Round 3 re-review findings before the final remediation:

```text
D7.4-R3-P2-4 OPEN at d28c2ab:
a user-owned empty query is indistinguishable from a fresh empty query after
refresh, so Diary bootstrap can re-seed the active Diary date.

D7.4-R3-P2-3 CLOSED at 5f4bda4:
user edits are now an explicit provenance transition; a query edited away and
then back to the Calendar date remains user-owned.

D7.4-R3-P2-2 CLOSED at 57ba3409:
Calendar-seed provenance now survives refresh alongside the FileTree query.

D7.4-R3-P2-1 CLOSED at e829df7:
scope-exit check now distinguishes unchanged Calendar seed from user query.
```

D7.4-R3-P2-2 remediation commit: `57ba340964cfa935756657be0b841a3f742972e4`
(`fix(diary): persist Calendar-seed provenance across refresh`)

Remediation self-review findings: `P0 = 0`, `P1 = 0`, `P2 = 0`

D7.4 Round 0 starting HEAD: `14b1efdf03a13063420fe344dc36eafc40c61dc8`

D7.4 Round 0 test implementation commit: `ed8524b46e40fb15b38fd39320bfd7f3af2f442c`
(`test(diary): cover D7.4 lifecycle conflicts`)

D7.4 Round 1 starting HEAD: `9112065437bfe49ab9a54ee77f89458e6c4e4f7c`

D7.4 Round 1 implementation commit: `8017594d9da4f7ac2e6ab8482fdefdaa3838781f`
(`fix(diary): gate missing-date presentation on mood commit`)

D7.4 Round 1 stale-intent remediation commit: `ec4b190a4ad89871021afa46906a77c18ec2fc61`
(`fix(diary): invalidate stale Mood-first intent`)

D7.4 Round 2 starting HEAD: `658b25fb0edd2e8b5d4e61a8ec3d02c3f52dd479`

D7.4 Round 2 test commit: `b8d721ee5c957b0097a1e22d9602822262754867`
(`test(diary): cover D7.4 conflict continuity`)

D7.4 Round 2 production remediation commit: `c029408d0e7e44e94f6e3c1c068e07749a82da27`
(`fix(diary): preserve filter on rejected diary date`)

D7.4 Round 2 focused test remediation commit: `b87cc2acedd23f116a37922a6ae173eac25523e0`
(`test(diary): close D7.4 lifecycle evidence gaps`)

D7.4 Round 3 starting HEAD: `ab34ed4d9b598422b7c8f9fbb0cc4bda861980d2`

D7.4 Round 3 navigation/test commits:

```text
8909970 test(diary): cover D7.4 navigation continuity
59e8655 fix(diary): preserve query across scope navigation
60778db test(diary): cover dirty navigation continuity
e829df7 fix(diary): distinguish seeded and user queries
f2ccccc docs(diary): record D7.4 round 3 evidence
```

D7.4 Round 3 review P2 remediation commit: `57ba340964cfa935756657be0b841a3f742972e4`
(`fix(diary): persist Calendar-seed provenance across refresh`)

D7.4 Round 3 user-edit provenance remediation commit: `5f4bda4b313e641dca116017d401bb9a5a9b9b37`
(`fix(diary): track user-owned FileTree query`)

D7.4 Round 3 empty-query ownership remediation commit: `f461496`
(`fix(diary): preserve user-owned empty query`)

This document records the D7.4 lifecycle/conflict regression evidence. Each
implementation/evidence round stopped at `REVIEW-READY`; independent review
results are recorded by separate closure syncs. The final gate below records
D7.4 itself as `REVIEW-CLOSED`.

Current lifecycle:

```text
D7.0A = REVIEW-CLOSED
D7.0  = REVIEW-CLOSED
D7.1  = REVIEW-CLOSED
D7.2  = REVIEW-CLOSED
D7.3  = REVIEW-CLOSED
D7.4  = REVIEW-CLOSED
D7.4 Final Gate = PASS (0/0/0)
D7.4 Round 1 = REVIEW-CLOSED
D7.4 Independent Review = PASS
D7.4 Round 2 = REVIEW-CLOSED
D7.4 Round 2 Independent Review = PASS (0/0/0)
D7.4 Round 2 GitHub CI #547 = PASS
D7.4 Round 3 = REVIEW-CLOSED
D7.4 Round 3 Independent Re-review = PASS (0/0/0)
D7.4-R3-P2-2 = CLOSED (by 57ba3409)
D7.4-R3-P2-3 = CLOSED (by 5f4bda4)
D7.4-R3-P2-4 = CLOSED (by f461496)
D7.4 Round 3 GitHub CI #549 = PASS (at f2ccccc; historical evidence)
D7.4 Round 3 GitHub CI #552 = PASS
D7.5  = NOT STARTED
D7.6  = NOT STARTED
D7 Mood release = NOT STARTED
```

## 1. Scope

D7.4 verifies that the D7 Mood metadata contract survives the existing Nuvyn
document lifecycle. This is a test/evidence phase, not a new Mood feature
phase. It covers clean and dirty body state, metadata compare-and-swap (CAS),
History, Recovery, delete/recreate identity boundaries, native tab/route
reconciliation, Calendar presentation continuity, and ordinary Vault
regression.

The initial D7.4 Round 0 implementation/evidence snapshot was test-only. Round
1 is a separate, narrowly scoped lifecycle follow-up: it adds a deferred
presentation capability to the existing Diary date command, updates the
VaultView orchestration, and adds the focused failure-path regression. No
server, shared domain, migration, PRD, Implementation Plan, package, lockfile,
or dependency change is included.

D7.4 does not start D7.5, D7.6, or a Mood release. It does not add a Diary
route, a Diary-specific editor/reader, a second tab store, a second save or
recovery pipeline, or a second metadata owner.

## 2. Frozen contracts and current owners

The following contracts are inherited from the reviewed D7.0–D7.3 phases:

- Calendar is a navigation and presentation surface; the native Vault owns
  documents.
- A canonical Diary remains one file at `diary/YYYY-MM-DD.md`.
- `openDiaryDate()` remains the only canonical date create/open command.
- `useDiaryMoodCommand` performs the authoritative Mood metadata mutation
  with the current `metadataUpdatedAt` expected value.
- SQLite `documents.mood` is the live Mood owner. Persisted values are stable
  Mood IDs or `NULL`, never asset paths.
- Existing tabs, `activePath`, route synchronization, raw body, save, dirty
  state, drafts, History, Recovery, and file mutation keep their existing
  owners.
- Calendar summary enrichment uses the existing bulk `PostSummary[]` seam;
  D7.4 does not introduce per-day metadata reads or N+1 requests.
- Calendar remains keep-mounted when its native document surface is shown;
  presentation changes do not close or recreate the backing tab.
- Unknown Mood values remain opaque and are not silently rewritten by a
  lifecycle operation.

The ownership model exercised by the tests is:

| Concern | Current owner | D7.4 boundary checked |
| --- | --- | --- |
| Diary date validation/create/open | `useDiaryDateCommand` / `openDiaryDate()` | Mood-first and existing-date paths reuse the canonical command |
| Mood set/change/clear | `useDiaryMoodCommand` → metadata API | CAS result is authoritative; no direct Calendar persistence |
| Live Mood storage | SQLite `documents.mood` / server metadata owner | Body writes and tab changes do not create a second Mood source |
| Body raw/model | `useTabWorkspace` and native Editor/Reader surfaces | Dirty raw remains distinct from metadata writes |
| Save/autosave/dirty | `useDocumentSave` and existing tab workspace | Manual save persists the body without losing Mood or identity |
| Draft persistence/recovery | existing draft persistence/recovery owners | Recovery handles body state and preserves current durable Mood |
| History capture/restore | existing server History owner and native History UI | v2 matching metadata restores together; legacy policy preserves current Mood |
| Tabs/active document | `useTabWorkspace` / existing tab lifecycle | Same tab and stable document identity survive tested transitions |
| Route synchronization | Vue Router + `useRouteSync()` | Browser navigation remains router-owned |
| Calendar projection/presentation | `DiaryCalendar` / `VaultView` | Calendar continuity is observed, not a new document owner |
| Ordinary Vault behavior | existing Vault/FileTree/editor lifecycle | Note and non-Diary flows remain outside Mood policy |

## 3. Characterization matrix

The D7.4 matrix is composed from the new focused browser suite plus the
existing lower-level and cross-phase regression suites. A row marked
“existing” is not presented as a newly invented D7.4 implementation; it is
included to show the already-verified owner that D7.4 depends on.

| Lifecycle / conflict case | Evidence | Result |
| --- | --- | --- |
| Clean Mood set, change, and clear | New E2E: `Mood set/change/clear stays separate from a dirty native Diary body`; existing D7.3 Calendar set/clear coverage | PASS |
| Dirty body plus Mood mutation | New E2E test 1: disk body remains unchanged while the native buffer is dirty; Mood changes independently | PASS |
| Body save ordering and draft removal | New E2E test 1: real `Ctrl+S` persists the dirty body and removes the draft while Mood and identity remain stable | PASS |
| Metadata CAS conflict | Round 2 clean Calendar conflict and dirty native-body conflict E2E plus `server/__tests__/diary-mood-metadata.test.ts` | PASS |
| External body conflict | Round 2 direct native body-conflict E2E plus existing D6.4 real conflict and Round 1 divergent Recovery E2E | PASS |
| Unknown Mood value | Round 2 native save/refresh/close/reopen E2E, bulk/detail/explicit-replace-clear server coverage, Calendar opaque-value unit coverage, and D7.2/D7.3 projection coverage | PASS |
| Dirty History Comparison does not mutate live body | Existing D6.4 History Comparison E2E with a dirty native editor | PASS |
| v2 History Restore restores matching Mood | New E2E test 2 plus `server/__tests__/history-metadata-revisions.test.ts`; actual native History Restore UI | PASS |
| Legacy/pre-Mood History Restore preserves current Mood | Focused `history-metadata-revisions` coverage from D7.0/D7.1 | PASS |
| Baseline Recovery preserves current Mood | New E2E test 3: body draft adoption, native identity, and current Mood remain separate | PASS |
| Divergent Recovery preserves current Mood | New E2E test 4: draft/disk divergence, View Diff, Open Recovered Content, and Use Disk Version use the existing Recovery owner | PASS |
| Delete/recreate generation boundary | New E2E test 5: stale CAS rejects, delete/recreate receives a new document identity, and Mood starts `NULL` | PASS |
| Same-date reopen | Existing D6.5 close/reopen identity regression | PASS |
| Scope exit and re-entry | Existing D6.5 Diary/Note/Ledger scope regression | PASS |
| Multi-tab selection and close | Existing D6.5 tab-selection and fallback lifecycle regression | PASS |
| Refresh | Existing D6.5 refresh lifecycle regression; new Recovery tests also reload a native Diary | PASS |
| Deep link | Existing D6.5 deep-link native Vault regression | PASS |
| Browser Back / Forward | Existing D6.5 route reconciliation regression | PASS |
| Identity continuity | New History/Recovery/CAS tests plus existing native lifecycle suites | PASS |
| Raw/dirty continuity | New tests 1, 3, and 4 plus D6.4 dirty editor coverage | PASS |
| Metadata continuity | New tests 1–5 and focused server metadata/history suites | PASS |
| Calendar continuity | Round 2 conflict/unknown assertions including native close/reopen, History Restore/Recovery assertions, and existing D6.5/D7.3 Calendar lifecycle | PASS |
| No N+1 metadata reads | D7.3 bulk `PostSummary[]` projection contract and static owner audit; no Calendar component fetch was added | PASS |
| Ordinary Vault regression | Existing D6.5 ordinary Note/Archive/Ledger coverage, focused VaultView tests, and full browser/unit suites | PASS |

## 4. New D7.4 browser scenarios

`e2e/diary-mood-lifecycle-regression.spec.ts` uses a real authenticated
browser page, real Vault files, real metadata routes, real History routes, and
the existing native Recovery UI. It does not mock away the lifecycle under
test.

### 4.1 Dirty body and metadata separation

The test sets, changes, and clears Mood through the metadata API, then opens a
native Diary, creates a dirty editor buffer and persisted draft, and repeats
Mood changes while the body remains dirty. It verifies:

- the on-disk body is still the baseline before the body save;
- the Mood is cleared without replacing the stable document identity;
- the native tab remains dirty and no tab-close confirmation is triggered by
  metadata mutation;
- the existing `Ctrl+S` owner later persists the body and removes the draft;
- the final Mood and document identity remain intact.

### 4.2 Mood-aware History Restore

The test captures a real History revision after the Diary has Mood `happy`,
changes the body and current Mood to `sad`, and invokes the existing native
History Comparison → Restore flow. It verifies the historical body and
matching Mood are restored, the stable document identity is retained, and the
metadata version advances. It then closes the History and Diary tabs through
the existing tab controls and verifies Calendar continuity and the restored
Mood marker.

### 4.3 Baseline Recovery

The test creates a dirty native body draft for a Diary with Mood `happy`,
reloads the application, and verifies the existing baseline recovery adopts
the body draft without changing the on-disk baseline, stable identity, or
current Mood. The existing save owner then persists the recovered body.

### 4.4 Divergent Recovery

The test creates a dirty body draft, changes the disk body externally, changes
the durable Mood through the real CAS route, and reloads. It then resolves the
divergent Recovery through the existing prompt, View Diff, Open Recovered
Content, and Use Disk Version flow. The resulting disk body is the selected
disk version while the externally current Mood and stable identity remain
unchanged.

### 4.5 CAS and generation isolation

The test submits a stale metadata update and verifies the server returns `409`
without changing the current raw body or Mood. It then deletes and recreates
the same Diary date and verifies a fresh document identity and `NULL` Mood
before setting a Mood on the new generation.

All five new scenarios use an explicit `Asia/Shanghai` Playwright timezone,
the same civil-date authority used by the Diary E2E helpers, and generated
dates selected from unused candidates. They do not rely on fixed calendar
dates or sleeps.

## 5. Defects and remediation history

During the original D7.4 Round 0 validation, no production defect was found.
One focused browser assertion expected a specific
`data-save-status="dirty"` state after an intentionally aborted autosave and
several independent metadata writes. The existing save owner can expose an
error status after that transport is aborted, while the editor buffer and tab
dirty indicator remain correct. The test was tightened to assert the
user-visible dirty tab indicator and the actual body/draft invariants instead
of overfitting to that transient status.

That Round 0 correction was test-only and did not change the save owner or
production behavior. The final test files contain no `skip`, `only`, fixed
delay, fake metadata mutation, or test-only production branch.

Round 1 addresses the independently identified Mood-first presentation P1.
The pre-fix flow called `openDiaryDate()` before the Mood CAS, so creation
could open a native Diary tab and hide Calendar before the metadata write was
known to succeed. Round 1 extends the same `useDiaryDateCommand` owner with
`ensureDiaryDate()`, which validates, locks, creates/resolves, publishes, and
refreshes the canonical Diary without opening a document. `VaultView` now
uses that deferred path first, performs the existing `useDiaryMoodCommand`
CAS, and calls `openDiaryDate()` only after an `updated` result. A failed CAS
keeps the created canonical file, leaves Calendar as the visible owner, and
retains a pending repair intent so an immediate successful retry opens the
native Diary exactly through the existing lifecycle.

The follow-up remediation addresses a lifecycle P2 found during independent
review: a date-only pending repair could survive an explicit native navigation
and later make an ordinary existing-Diary Mood edit reopen the document. The
pending repair is now scoped by both its `DiaryDate` and the existing
presentation date-intent epoch. Explicit date navigation, leaving Diary scope,
losing Diary presentation eligibility, Calendar Home becoming hidden, an
active-path transition, or a different Mood date clears the repair context.
Asynchronous Mood results retain a pending repair only when their original
epoch is still current. Once the Mood CAS succeeds, the one-shot repair intent
is consumed before attempting the native handoff, so a failed handoff cannot
leak navigation into a later ordinary Mood edit.

## 6. Round 0 validation snapshot

The following records the original D7.4 Round 0 validation snapshot. It is
kept as historical evidence and is not presented as the Round 1 validation:

| Command | Result |
| --- | --- |
| `npm exec playwright test e2e/diary-mood-lifecycle-regression.spec.ts --project=chromium` | **5 passed** |
| `npm exec playwright test e2e/diary-editor-lifecycle.spec.ts e2e/diary-lifecycle-regression.spec.ts e2e/diary-calendar-surface.spec.ts --project=chromium` | **24 passed** |
| `npm run test:e2e` | **124 passed** |
| Focused Vitest: metadata/history/mood command/VaultView/draft recovery/save suites | **6 files, 120 tests passed** |
| `npm run test:unit` | **235 files, 3520 tests passed, 2 skipped** |
| `npm run typecheck:client` | **PASS** |
| `npm run typecheck:server` | **PASS** |
| `npm run typecheck` | **PASS** (client and server) |
| `npm run build` | **PASS** |

The two skipped unit tests are pre-existing suite skips; no D7.4 test is
skipped. The build emitted existing dependency annotation and large-chunk
warnings but completed successfully. The full browser run also emitted known
Monaco cancellation messages on the web-server log while all 124 tests
passed; the five D7.4 tests recorded no page errors or unexpected console
errors.

## 7. Round 1 validation evidence

Round 1 validation was run after implementation commit
`8017594d9da4f7ac2e6ab8482fdefdaa3838781f`.

Before the production fix, the new focused browser regression failed as
intended: while the first Mood metadata request was held open, the Calendar
surface was already hidden by the premature native-document adoption. The
same scenario passed after the fix, with the first failed Mood CAS leaving
Calendar visible and the canonical file repairable through `?` before a later
successful retry opened the native Diary.

| Command | Result |
| --- | --- |
| Focused Vitest: Mood picker/context, Calendar surface, mood/date commands, EditorTabs, VaultView | **8 files, 126 tests passed** |
| Focused Round 1 E2E: `diary-calendar-surface.spec.ts --grep "Mood-first creation keeps Calendar visible until Mood CAS succeeds"` | **1 passed** |
| Complete Diary E2E set: Calendar, Editor lifecycle, lifecycle regression, Mood lifecycle, Reader, release, responsive/accessibility | **52 passed** |
| `npm run test:unit` | **235 files, 3521 tests passed, 2 skipped** |
| `npm run test:e2e` | **125 passed** |
| `npm run typecheck:client` | **PASS** |
| `npm run typecheck:server` | **PASS** |
| `npm run typecheck` | **PASS** (client and server) |
| `npm run build` | **PASS** |
| `git diff --check` | **PASS** |

The first unprivileged browser invocation was blocked by the local sandbox
with `listen EPERM` on `127.0.0.1:4174`; the same requested suites were then
rerun with the repository's permitted elevated local test environment and
passed. The build emitted existing dependency annotation and large-chunk
warnings, and the browser web server emitted known Monaco cancellation
messages, but no test failed.

Round 1 changed only the following implementation/test files:

```text
e2e/diary-calendar-surface.spec.ts
src/composables/diary/__tests__/useDiaryDateCommand.test.ts
src/composables/diary/useDiaryDateCommand.ts
src/views/VaultView.vue
src/views/__tests__/VaultView.test.ts
```

No server, shared, router, dependency, package, or lockfile changes were
made.

### 7.1 Round 1 stale-intent remediation

The remediation regression first failed against the pre-remediation code: a
failed Mood-first creation followed by explicit opening and closing of the
same Diary left the old pending date active, so the next ordinary Mood edit
hid Calendar and reopened Native Diary. After commit
`ec4b190a4ad89871021afa46906a77c18ec2fc61`, the same flow persists Mood while
Calendar remains visible, the route remains `/vault`, and no Diary tab is
created by the later Mood edit. The existing immediate retry flow remains
covered separately by the original Round 1 scenario.

| Command | Result |
| --- | --- |
| Focused stale-intent E2E: `diary-calendar-surface.spec.ts --grep "failed Mood-first repair intent"` | **1 passed** |
| Complete Diary Calendar E2E: `diary-calendar-surface.spec.ts --project=chromium` | **10 passed** |
| Focused Vitest: date command and VaultView wiring | **2 files, 59 tests passed** |
| D7.4 focused Vitest suites | **7 files, 114 tests passed** |
| `npm run test:unit` (elevated local environment) | **235 files, 3521 tests passed, 2 skipped** |
| `npm run test:e2e` (elevated local environment) | **126 passed** |
| `npm run typecheck` | **PASS** (client and server) |
| `npm run build` | **PASS** |
| `git diff --check` | **PASS** |

The first full-unit invocation was blocked by local sandbox IPC/listen
permissions in four unrelated server suites; the elevated rerun passed in
full. Build output retained only the repository's existing dependency
annotation and large-chunk warnings. Browser output retained known Monaco
cancellation messages; all 126 browser tests passed.

The focused remediation changed only:

```text
e2e/diary-calendar-surface.spec.ts
src/views/VaultView.vue
```

No server, shared, router, dependency, package, or lockfile changes were
made.

The Round 1 independent re-review then confirmed that the original
Mood-first presentation P1 and the stale pending-intent P2 were closed, with
`P0 = 0`, `P1 = 0`, and `P2 = 0`. This closure sync records that result and
does not start D7.5.

## 8. GitHub status (Round 0 snapshot)

GitHub checks were queried after the D7.4 commits were pushed. At the time of
the evidence snapshot, Actions run `33103894152` was still `in_progress`:

```text
visual                    PASS
auth-browser              PASS
tags-scale                PASS
docker-smoke              IN PROGRESS
verify Ubuntu 22          IN PROGRESS
verify Ubuntu 24          IN PROGRESS
verify macOS 24           IN PROGRESS
verify Windows 24         IN PROGRESS
```

The run was not used as a completed CI proof. D7.4 readiness is based on the
local focused/full validation listed above; this document does not claim
`GitHub CI = PASS` while the remote run is incomplete.

This is retained as the Round 0 historical snapshot. Round 1's final HEAD
status is checked separately after its commits are pushed and is not inferred
from this older run.

## 8.1 Round 1 final CI status

GitHub Actions run `#544` (`33134486083`) was queried for final HEAD
`bd9539507ad45f9af30841c7cc0698bef36932b0` and completed successfully. The
eight required jobs passed: Ubuntu 22, Ubuntu 24, Windows 24, macOS 24,
`auth-browser`, `visual`, `docker-smoke`, and `tags-scale`. This is the final
Round 1 CI closure evidence; it is not inferred from the historical Round 0
snapshot above.

## 9. Review and readiness

Task-scoped self-review:

```text
P0 = 0
P1 = 0
P2 = 0
```

Independent re-review:

```text
PASS
P0 = 0
P1 = 0
P2 = 0
```

The Round 1 evidence phase has passed independent review and is recorded as
`REVIEW-CLOSED` by this docs-only sync. D7.4 remains in progress because no
later D7 phase is being started here.

The following remain unchanged and not started:

```text
D7.5 = NOT STARTED
D7.6 = NOT STARTED
D7 Mood release = NOT STARTED
```

No D7.5 responsive/accessibility work, D7.6 release work, or unrelated
feature work is included.

## 10. Evidence commands and conclusion

Repository and validation commands used for this phase included:

```text
git status --short --branch
git rev-parse HEAD
git log -20 --oneline --decorate
git fetch github main
git diff --check
npm exec vitest run ...
npm run test:unit
npm exec playwright test ...
npm run test:e2e
npm run typecheck:client
npm run typecheck:server
npm run typecheck
npm run build
```

The final D7.4 conclusion is:

```text
D7.4 = IN PROGRESS
D7.4 Round 1 = REVIEW-CLOSED
Independent Review = PASS
Independent Review P0/P1/P2 = 0/0/0
GitHub CI #544 = PASS
Self-review P0/P1/P2 = 0/0/0

D7.5 = NOT STARTED
D7.6 = NOT STARTED
D7 Mood release = NOT STARTED
```

D7.4 Round 1 is independently reviewed and closed. Do not start D7.5 in
this phase.

## 11. Round 2 — Conflict + Guard Continuity

Round 2 is a focused D7.4 follow-up for conflict continuity and rejected-date
guard continuity. It does not reopen Round 1 and does not start D7.5.

```text
Starting HEAD:       658b25fb0edd2e8b5d4e61a8ec3d02c3f52dd479
Test commit:         b8d721ee5c957b0097a1e22d9602822262754867
Production fix:      c029408d0e7e44e94f6e3c1c068e07749a82da27
Round 2 final code:  c029408d0e7e44e94f6e3c1c068e07749a82da27
```

The Round 2 change set keeps the frozen ownership model: SQLite remains the
live Mood authority, `useDiaryMoodCommand` remains the CAS mutation owner,
the native editor remains the raw/dirty/save owner, and `useDiaryDateCommand`
remains the canonical Diary create/open and future-date guard. No new Mood
conflict pipeline, metadata cache, route, tab store, recovery owner, or
server API was introduced.

### 11.1 Missing-future guard and FileTree query

The regression was written and run before the production change. With the
pre-fix `VaultView` handler, a missing future date changed the persisted
FileTree query from a generated user query to the rejected date. The browser
test observed the failure as:

```text
Expected query: custom D7.4 Round 2 query
Received query: YYYY-MM-DD future date
```

The minimal fix in `VaultView.vue` now commits `diaryFilterSeed` and
`filesFilter` only when the canonical date command returns `opened` or
`created`. The server future guard is unchanged. A rejected, invalid, or
future result therefore leaves the user's in-memory and persisted FileTree
query untouched.

The final browser test,
`missing future Diary does not overwrite the user FileTree filter`, verifies
all of the following against a real authenticated app:

- no `POST /api/diary/dates`;
- no Mood metadata mutation;
- the future Diary remains absent;
- no native Diary tab is created;
- the route and Calendar Home remain unchanged;
- the custom FileTree query remains in the input and localStorage;
- the expected future probe is the only accepted 404 diagnostic.

### 11.2 Clean external metadata conflict

`external metadata conflict keeps the Calendar winner and allows a fresh
retry` seeds a real Diary with body `A` and Mood `happy`, loads that summary
into Calendar, then performs an external authoritative CAS to `sad`. The
browser still holds the old `metadataUpdatedAt`; selecting `angry` through the
real Calendar picker returns `409`.

The test verifies that the external `sad` value wins, body `A` and the stable
document identity remain unchanged, Calendar refreshes to `sad`, no route or
Diary tab is created, and a subsequent fresh explicit retry changes the Mood
to `angry` without navigation.

The expected 409 network diagnostic is asserted explicitly; no unexpected
page error or console error is ignored.

### 11.3 Dirty native body plus metadata conflict

`external metadata conflict leaves a dirty native body untouched` opens the
same real Diary in the native editor, creates a persisted dirty draft with
body `B` while disk remains body `A`, and then performs an external Mood CAS
from `happy` to `sad`. A stale `angry` metadata request returns `409`.

While that conflict is present, the test verifies that:

- the server-side raw body is still `A`;
- the native editor still visibly contains dirty body `B`;
- the tab and dirty indicator remain present;
- no tab-close confirmation, reload, discard, or route change occurs;
- the stable document identity remains unchanged;
- a fresh authoritative retry changes Mood to `angry` without touching the
  dirty editor buffer;
- the existing native `Ctrl+S` owner later persists `B` and removes the
  draft, with Mood still `angry`.

The stale request is sent through the authenticated metadata route because
Native Mood context UI is intentionally not present in this D7.4 contract.
This keeps the test at the real CAS authority without adding a second native
Mood editor or a test-only production path.

### 11.4 External body conflict and Mood continuity

The existing D7.4 divergent Recovery browser scenario remains the body
conflict evidence. It creates local draft body `B`, mutates disk to `C`, and
updates the authoritative Mood externally to `sad` before entering the native
Recovery flow. View Diff, Open Recovered Content, and Use Disk Version remain
owned by the generic Recovery lifecycle. The final disk body follows the
selected resolution while the durable Mood remains `sad` and the document
identity remains stable.

Round 2 did not change the body conflict engine or duplicate its lifecycle;
it adds the dirty metadata-CAS case above to prove that the two authorities
can coexist.

### 11.5 Unknown Mood preservation

Unknown Mood values are constructed only through the existing server test DB
fixture; the public canonical Mood mutation route correctly rejects unknown
IDs. The new server coverage verifies that `unknown-mood-v1`:

- is returned exactly by the detail document endpoint;
- is returned exactly by the bulk `/api/posts` summary seam with its document
  identity and metadata version;
- can be explicitly replaced with canonical `happy` using CAS;
- can be explicitly cleared to `NULL` using CAS after it is reintroduced by
  the fixture;
- never changes the Markdown body or stable document identity.

Existing body-save coverage additionally confirms that an opaque SQL Mood is
preserved through a real body `PUT` and returned in the resulting post. The
Calendar unit test verifies that an unknown Mood renders as the current `?`
affordance, that opening and cancelling the picker emits no mutation, and
that only explicit canonical selection or Clear emits replacement/clear.
Existing projection tests continue to prove that unknown values are joined
from bulk summaries rather than fetched per day.

The Native workspace intentionally has no separate Mood UI in this contract;
unknown preservation across native body save and subsequent detail/bulk
reads is therefore verified at the existing document/metadata authorities,
without adding a new UI owner.

### 11.6 Round 2 matrix

| Round 2 contract | Evidence | Result |
| --- | --- | --- |
| Missing future preserves user FileTree query | `diary-calendar-surface.spec.ts`: `missing future Diary does not overwrite the user FileTree filter` | PASS |
| Missing future creates no Diary | Same browser test plus existing future no-op test | PASS |
| Missing future writes no Mood | Same browser test request tracker | PASS |
| Clean external metadata CAS conflict | `diary-mood-lifecycle-regression.spec.ts`: Calendar winner + fresh retry | PASS |
| Dirty external metadata CAS conflict | Same file: dirty native body untouched | PASS |
| Raw/original/dirty separation | Dirty editor buffer, dirty indicator, server raw baseline, and final native save | PASS |
| Authoritative Mood winner and fresh retry | Clean/dirty CAS tests and server metadata suite | PASS |
| External body conflict + Mood | Existing divergent Recovery E2E | PASS |
| Unknown durable detail/bulk read | `server/__tests__/diary-mood-metadata.test.ts` | PASS |
| Unknown Calendar projection | `DiaryCalendar.test.ts` and `diaryCalendarProjection.test.ts` | PASS |
| Unknown body save/read continuity | Existing server body-save test plus detail/bulk read coverage | PASS |
| Unknown open/cancel preservation | `DiaryCalendar.test.ts` | PASS |
| Unknown explicit replacement | Calendar and server tests | PASS |
| Unknown explicit Clear | Calendar and server tests | PASS |
| No N+1 metadata reads | Existing bulk projection seam; no Calendar fetch change in Round 2 | PASS |
| Ordinary Vault conflict behavior | Native editor lifecycle E2E, full unit, and full browser suites | PASS |

### 11.7 Round 2 validation

The focused and regression commands were run after the final code changes:

| Validation | Result |
| --- | --- |
| Focused unit/server: 8 files | **111 passed** |
| Focused Calendar + Mood lifecycle browser suites before focused test remediation | **18 passed** |
| Native editor lifecycle browser suite | **9 passed** |
| `npm run test:unit` | **235 files, 3523 passed, 2 skipped** |
| `npm run test:e2e` before focused test remediation | **129 passed** |
| `npm run typecheck:client` | **PASS** |
| `npm run typecheck:server` | **PASS** |
| `npm run typecheck` | **PASS** |
| `npm run build` | **PASS** |
| `git diff --check` | **PASS** |

The browser suites used the repository's permitted local web-server
environment. Build output contained only existing dependency annotation and
large-chunk warnings; browser output contained known Monaco cancellation
messages, and no test failed.

### 11.8 Scope audit and lifecycle

Round 2 changed production only in the existing `VaultView` orchestration
seam, moving the FileTree seed after successful canonical date navigation.
The test commit added the future guard, clean/dirty CAS, and unknown-value
coverage. No production server, `shared`, router, schema/migration, package,
lockfile, or dependency change was made.

```text
Production code changed: YES — VaultView orchestration only
Server production changed: NO
Server tests changed: YES — authoritative metadata characterization
Shared changed: NO
Router changed: NO
Schema/migration changed: NO
Dependencies changed: NO
Calendar fetch/N+1 path changed: NO
D7.5 started: NO
```

Round 2 self-review:

```text
P0 = 0
P1 = 0
P2 = 0
```

No new GitHub status was queried for Round 2. The previously recorded Round 1
CI #544 success remains historical evidence for Round 1; it is not reused as
a new Round 2 CI claim. Independent Review remains pending until a separate
reviewer verifies this Round 2 evidence.

Current Round 2 lifecycle:

```text
D7.4 = IN PROGRESS
D7.4 Round 1 = REVIEW-CLOSED
D7.4 Round 1 Independent Review = PASS (0/0/0)
D7.4 Round 2 = REVIEW-READY
D7.4 Round 2 Independent Review = PENDING
D7.5 = NOT STARTED
```

Round 2 is ready for independent review. Do not start D7.5 in this phase.

### 11.9 Focused test-only remediation after Independent Review

The post-`7532a27` review identified two evidence gaps. The remediation is
test-only and is recorded in:

```text
Starting HEAD: 7532a27b08280851003385fd03fa9d63f4fb83e6
Test-only remediation: b87cc2acedd23f116a37922a6ae173eac25523e0
```

The first added browser case,
`native body conflict preserves Mood while resolving through the existing save
owner`, directly exercises the native document path. It keeps a dirty local
body in the editor, changes the disk body externally, changes the authoritative
Mood externally, releases the real autosave into a 409 conflict, and resolves
through the existing Keep Local save owner. The final assertions prove that
the local body is saved, the external Mood remains authoritative, the stable
document identity is preserved, and closing the native tab returns Calendar
with the winning Mood. No second body or metadata lifecycle is introduced.

The second added browser case,
`unknown Mood survives native save, refresh, close, and reopen`, uses the
existing E2E database only as a test fixture to seed an opaque stored Mood.
It verifies the value in Calendar as `?`, saves the body through the native
editor, refreshes the native route, closes the tab to Calendar, reopens the
same Diary, and closes it again. Detail reads, body content, stable identity,
and the opaque Mood remain unchanged throughout. The public Mood mutation
route still accepts only canonical IDs; no production escape hatch was added.

The focused test-only re-run produced:

| Validation | Result |
| --- | --- |
| New native body-conflict + unknown-Mood lifecycle cases | **2 passed** |
| Full D7.4 Calendar/Mood browser specs | **20 passed** |
| Full browser suite after remediation | **131 passed** |

The earlier `18` focused-browser and `129` full-browser counts in §11.7 are
retained as the pre-remediation Round 2 baseline. The existing unit,
typecheck, and build evidence was not invalidated by this E2E-only change;
no production file was modified by the remediation.

CI `#546` was reported as `completed / success` for the pre-remediation
Round 2 HEAD `7532a27`. It does not cover the later test-only commit
`b87cc2a`; no new GitHub status was queried for that commit, so no new CI
pass is claimed here.

The focused remediation self-review is:

```text
P0 = 0
P1 = 0
P2 = 0
```

At the time of the test-only evidence commit, the independent re-review was
pending. The subsequent independent re-review confirmed that both evidence
gaps were closed, with `P0 = 0`, `P1 = 0`, and `P2 = 0`. GitHub CI `#547`
then completed successfully for final HEAD `8433d865aa69300bed95a41658e079c3ae621e10`,
including all required platform verification, browser, unit/integration,
typecheck, build, and supporting jobs.

This docs-only closure sync records:

```text
D7.4 Round 2 = REVIEW-CLOSED
D7.4 Round 2 Independent Re-review = PASS
P0 = 0
P1 = 0
P2 = 0
GitHub CI #547 = PASS
D7.5 = NOT STARTED
```

D7.4 remains `IN PROGRESS` because this closure sync does not start a later
D7 phase. D7.5 remains `NOT STARTED`.

## 12. Round 3 — Navigation / Workspace Lifecycle Continuity

Round 3 is a navigation and workspace-continuity follow-up. It does not
reopen the independently closed Round 1 or Round 2, and it does not start
D7.5. The starting baseline was the Round 2 closure HEAD:

```text
Starting HEAD: ab34ed4d9b598422b7c8f9fbb0cc4bda861980d2
```

The implementation/test commits were:

```text
8909970 test(diary): cover D7.4 navigation continuity
59e8655 fix(diary): preserve query across scope navigation
60778db test(diary): cover dirty navigation continuity
e829df7 fix(diary): distinguish seeded and user queries
```

The final production behavior keeps the existing ownership boundaries. The
Calendar date command, generic route/tab lifecycle, Diary presentation owner,
and FileTree remain separate. No server, shared domain, router, generic tab
store, schema, migration, package, lockfile, or dependency change was made.

### 12.1 Characterization and defect remediation

The new browser characterization covered same-date reopen, multiple managed
Diary tabs, tab selection and close, scope exit/re-entry, refresh, canonical
deep links, real Browser Back/Forward, dirty-body continuity, Mood/identity
continuity, and persisted FileTree query ownership.

The characterization exposed one real P2 in the existing `VaultView` scope
watcher: it unconditionally cleared `filesFilter` whenever Diary scope was
left. That erased a query the user had entered while switching between Diary,
Note, and Ledger contexts. The first minimal change stopped clearing the
query, but the existing D6.5 lifecycle tests then demonstrated why a Calendar
date seed must still be cleared when it is only presentation context. The
final fix therefore clears `filesFilter` only while it still equals the
current `diaryFilterSeed`; once the query is user-owned, it survives scope
transitions. This is the only Round 3 production change.

```text
D7.4-R3-P2-1
Root cause: system-seeded Diary date and user-owned FileTree query were
treated as the same state on Diary-scope exit.
Final rule: clear an unchanged Calendar seed; preserve a user query.
Result: CLOSED by e829df7.
```

The Round 3 independent re-review found one additional lifecycle hole
(D7.4-R3-P2-2, see §12.6) that the original Round 3 evidence did not
exercise; the focused remediation commit `57ba3409` closes it without
reopening the existing Round 1 / Round 2 contracts or the Round 3
characterization captured by `e829df7`.

The existing D7.3 Calendar tests continue to cover the separate picker/intent
boundary: picker closes before date or month navigation and the stale
Mood-first presentation intent cannot resurrect Native Diary navigation.
Round 3 did not redesign that owner.

### 12.2 Round 3 browser evidence

The focused Round 3 command ran the new Mood lifecycle scenarios together
with the existing D6.5 lifecycle regressions:

```text
e2e/diary-mood-lifecycle-regression.spec.ts
e2e/diary-lifecycle-regression.spec.ts
e2e/diary-editor-lifecycle.spec.ts
e2e/diary-calendar-surface.spec.ts
```

It produced **40 passed**. The complete Diary browser set was also included
in the full Playwright run and passed: Calendar (11), Editor lifecycle (9),
generic lifecycle (7), Mood lifecycle (13), Reader (7), release (7), and
responsive/accessibility (8), for **62 Diary tests passed**.

The new Round 3 scenarios prove:

- existing same-date reopen reuses one canonical tab and the same stable
  `documentId` and Mood;
- two managed Diary tabs can be selected and closed through the generic tab
  owner, with Calendar hidden until the final managed Diary tab closes;
- a Diary tab plus an ordinary Note follows the generic workspace route and
  tab lifecycle, without synthesizing Calendar intent or Diary writes;
- a dirty Diary body remains in the native editor buffer while another tab is
  selected and reselected, with the original disk body, Mood, and identity
  preserved until the existing save owner is invoked;
- a user-entered FileTree query survives ordinary tab selection, Diary scope
  exit/re-entry, Calendar visibility changes, refresh, deep link, and real
  Back/Forward traversal;
- refresh, deep link, and history traversal do not create a duplicate tab,
  create a Diary, or issue an unauthorized Mood mutation;
- the Calendar remains one attached, hidden-but-mounted surface while a
  managed Diary document is open and becomes visible again after the final
  managed Diary closes.

The tests use real authenticated pages, real route/tab transitions, real
metadata reads, deterministic unused Diary dates, and the existing
`Asia/Shanghai` browser date authority. They do not use fixed sleeps,
production test branches, Vue/Pinia internals, or broad error suppression.

### 12.3 Round 3 exit matrix

| Contract | Result | Evidence |
| --- | --- | --- |
| Same-date reopen | PASS | New navigation continuity E2E |
| No duplicate same-date tab | PASS | New navigation continuity E2E |
| Stable `documentId` across reopen | PASS | New navigation continuity E2E |
| Two Diary tabs select correctly | PASS | New navigation continuity E2E |
| Calendar hidden with any Diary tab | PASS | New navigation continuity E2E |
| Calendar visible after final Diary close | PASS | New navigation continuity E2E |
| Diary plus ordinary Note generic behavior | PASS | New scope/query E2E + D6.5 lifecycle suite |
| Calendar visibility is not derived only from `activePath` | PASS | Multi-tab close/select E2E |
| Dirty Diary survives tab selection | PASS | New dirty navigation E2E |
| `raw`/`originalRaw`/dirty owner unchanged | PASS | New dirty navigation E2E |
| Scope exit/re-entry coherent | PASS | New scope/query E2E + D6.5 suite |
| No stale picker after navigation | PASS | Existing Calendar navigation regressions |
| No stale Mood-first intent | PASS | Existing failed-repair-intent regression |
| Calendar Home refresh coherent | PASS | Full Diary browser suite |
| Native Diary refresh coherent | PASS | New refresh/deep-link E2E + D6.5 suite |
| No duplicate tab after refresh | PASS | New refresh/deep-link E2E |
| FileTree query survives refresh | PASS | New refresh/deep-link E2E |
| Canonical Diary deep link | PASS | New refresh/deep-link E2E + D6.5 suite |
| No unauthorized create or Mood mutation | PASS | Request assertions in new E2E |
| Browser Back continuity | PASS | New refresh/deep-link E2E + D6.5 suite |
| Browser Forward continuity | PASS | New refresh/deep-link E2E + D6.5 suite |
| Generic tab owner during history traversal | PASS | New refresh/deep-link E2E |
| No duplicate history tabs | PASS | New refresh/deep-link E2E |
| Query survives ordinary file/tab navigation | PASS | New scope/query E2E + D6.5 suite |
| Query survives Back/Forward | PASS | New refresh/deep-link E2E |
| Future-reject query guard remains closed | PASS | Existing Round 2 browser regression |
| Mood continuity across transitions | PASS | New navigation/dirty E2E and existing Mood suite |
| Identity continuity across transitions | PASS | New navigation/refresh E2E and existing suites |
| One keep-mounted Calendar surface | PASS | New navigation E2E and existing D7.3 proof |
| No N+1 metadata reads | PASS | Existing bulk `PostSummary[]` projection seam |
| Ordinary Vault navigation | PASS | Existing D6.5 suite + full browser suite |
| Calendar seed cleared on scope exit after refresh | PASS | Round 3 refresh-seed provenance E2E |

### 12.4 Validation

Validation was run after the final Round 3 production fix:

| Command | Result |
| --- | --- |
| Focused Round 3 + D6.5 Diary browser suites | **40 passed** |
| Complete main Playwright suite (`npm run test:e2e`) | **135 passed** |
| Draft Store Playwright suite (`npm run test:e2e:draft-store`) | **38 passed** |
| `npm run test:unit` | **235 files, 3523 passed, 2 skipped** |
| `npm run test:history-integration` | **5 files, 174 passed** |
| `npm run test:recovery-integration` | **5 files, 193 passed** |
| `npm run test` | **PASS** |
| `npm run typecheck:client` | **PASS** |
| `npm run typecheck:server` | **PASS** |
| `npm run typecheck` | **PASS** |
| `npm run build` | **PASS** |
| `git diff ab34ed4d9b598422b7c8f9fbb0cc4bda861980d2...HEAD --check` | **PASS** |

The first unprivileged local browser and unit attempts were blocked by the
environment's `listen EPERM` restrictions while starting the local web server
or temporary test IPC. The same commands were rerun in the repository's
permitted elevated local environment and passed. Build output retained only
existing dependency annotation and large-chunk warnings; browser output
retained known Monaco cancellation messages, with no failing test or
unexpected error in the Round 3 diagnostics.

### 12.5 Scope audit and lifecycle state

```text
Production code changed: YES — src/views/VaultView.vue orchestration only
Tests changed: YES — e2e/diary-mood-lifecycle-regression.spec.ts only
Server production changed: NO
Shared changed: NO
Router changed: NO
Generic tab store changed: NO
Schema/migration changed: NO
Package/lock/dependencies changed: NO
D7.5 started: NO
```

Round 3 self-review:

```text
P0 = 0
P1 = 0
P2 = 0
```

Independent Review remains pending. This evidence does not self-close Round
3 or D7.4, and it does not reuse Round 2 CI `#547` as a Round 3 result. The
GitHub status for the final evidence HEAD is to be recorded after that HEAD
is pushed; no CI result is inferred from the local runs above.

The resulting lifecycle is:

```text
D7.4 = IN PROGRESS
D7.4 Round 1 = REVIEW-CLOSED
D7.4 Round 2 = REVIEW-CLOSED
D7.4 Round 3 = REVIEW-READY
D7.4 Round 3 Independent Review = PENDING
D7.4 Round 3 Self-review P0/P1/P2 = 0/0/0
D7.5 = NOT STARTED
```

Round 3 is ready for independent review. Do not start D7.5 in this phase.

### 12.6 Round 3 P2-2 remediation — refresh loses Calendar-seed provenance

The Round 3 independent re-review (`HEAD f2ccccc0`) found one additional P2
that the original Round 3 characterization did not exercise:

```text
D7.4-R3-P2-2
Root cause: diaryFilterSeed was a plain ref('') while filesFilter survived
refresh via useStorage('nuvyn.file-tree.filter', ''). The two lifecycles
diverged after reload, so the scope-exit check `filesFilter === diaryFilterSeed`
could no longer distinguish a Calendar seed from a user query, and a Calendar
date leaked into the ordinary Note tree.
Repro chain:
  1. Calendar click Diary A → diaryFilterSeed=A, filesFilter=A
  2. Native Diary A opens
  3. page.reload()
  4. filesFilter=A (useStorage), diaryFilterSeed='' (lost)
  5. switch Diary scope → Note scope
  6. scope watcher: A === '' → false → filter NOT cleared
  7. Note FileTree still filtered by Diary date A
Final rule: persist diaryFilterSeed alongside filesFilter so the scope-exit
check survives refresh. No router/tab/server owner or FileTree rule change.
Result: CLOSED by 57ba3409 (new focused E2E + one-line production fix in
VaultView).
```

The focused remediation commit `57ba3409` adds:

- `test(diary)` — new E2E
  `'refresh preserves Calendar-seed provenance so Diary scope exit clears it'`
  in `e2e/diary-mood-lifecycle-regression.spec.ts`. The new scenario seeds
  Diary A, clicks A on Calendar, reloads, switches to Note scope, and asserts
  that the FileTree query is cleared (`''`). It also navigates to an ordinary
  Note path after scope exit and asserts the query stays cleared. It was
  verified to fail against the pre-remediation `f2ccccc` HEAD and to pass
  after `57ba3409` lands.
- `fix(diary)` — `VaultView.vue` orchestration only. `diaryFilterSeed`
  changes from a local `ref('')` to
  `useStorage('nuvyn.diary.filter-seed', '')`. The seed and `filesFilter`
  now share the same `useStorage` lifecycle, so the scope-exit check
  `filesFilter === diaryFilterSeed` can still recognise a Calendar seed
  after refresh.

The remediation does not reopen the Round 1 / Round 2 contracts. The existing
D7.3 picker/intent boundary, the existing D6.5 lifecycle suite, and the
existing scope/navigation continuity tests all still pass on `57ba3409`. The
Round 3 navigation/dirty/refresh/deep-link/Back-Forward characterization
(`8909970` / `59e8655` / `60778db` / `e829df7`) is unchanged: the
remediation only makes the scope-exit seed clearing work after refresh. The
remediation is intentionally narrow and is owned by the same
`VaultView` FileTree/Diary orchestration owner; no router, generic tab store,
server, schema, migration, package, lockfile, or dependency changed.

The focused remediation validation was run after `57ba3409`:

| Command | Result |
| --- | --- |
| `npx playwright test e2e/diary-mood-lifecycle-regression.spec.ts --grep "refresh preserves Calendar-seed provenance"` | **1 passed** |
| `npx playwright test e2e/diary-mood-lifecycle-regression.spec.ts` | **14 passed** (13 existing + 1 new) |
| `npx vitest run src/views/__tests__ src/components/vault/__tests__ src/composables/vault/__tests__` | **75 files, 871 tests passed** |
| `npm run typecheck:client` | **PASS** |
| `npm run typecheck:server` | **PASS** |
| `npm run typecheck` | **PASS** |

The new focused E2E was first executed against the pre-remediation HEAD
with the production change temporarily reverted; it failed on the
`expect(search).toHaveValue('')` assertion with the persisted Diary date
still in the input, confirming the test catches the lifecycle hole. The
same scenario passed after the production change was restored.

The new evidence updates only the Round 3 remediation section. Round 1
(`8017594d` / `ec4b190a`) and Round 2 (`b8d721ee` / `c029408d` /
`b87cc2ac`) remain `REVIEW-CLOSED` and are not reopened. `D7.5` is still
`NOT STARTED`. The GitHub CI status for `57ba3409` is to be recorded after
that HEAD is pushed; no CI result is inferred from the local runs above.

The resulting lifecycle after the remediation is:

```text
D7.4 = IN PROGRESS
D7.4 Round 1 = REVIEW-CLOSED
D7.4 Round 2 = REVIEW-CLOSED
D7.4 Round 3 = REMEDIATION-READY
D7.4 Round 3 Independent Re-review = FAIL (P0=0, P1=0, P2=1)
D7.4-R3-P2-2 = CLOSED (by 57ba3409)
D7.5 = NOT STARTED
```

Round 3 is now ready for a second independent review with the refresh-seed
provenance fix applied. Do not start D7.5 in this phase.

### 12.7 Round 3 P2-3 remediation — user-edit provenance must not be inferred by value

The second Round 3 independent re-review (`HEAD 2e853ae`) found one further
P2 in the FileTree ownership boundary:

```text
D7.4-R3-P2-3
Root cause: `filesFilter === diaryFilterSeed` only compared values. A user
could edit a Calendar-seeded query away and then type the same Diary date
again, leaving the persisted seed intact. Scope exit could then clear that
user-owned query, and `diaryExactPathFilter` could still treat it as a
Calendar exact-path projection.
```

The focused remediation commit `5f4bda4b313e641dca116017d401bb9a5a9b9b37`
(`fix(diary): track user-owned FileTree query`) keeps the refresh-safe seed
from `57ba3409` and makes the user edit an explicit boundary:

- `FileTree` is bound with `:filter` and `@update:filter` rather than an
  opaque parent `v-model` shortcut;
- the `update:filter` handler clears `diaryFilterSeed` before assigning the
  user value, even when that value equals the previous Calendar date;
- `diaryExactPathFilter` requires both the matching date value and matching
  active Calendar-seed provenance, so retyping a date does not recreate the
  Diary presentation constraint;
- Calendar/system navigation continues to write the query and seed together,
  while ordinary FileTree navigation does not rewrite either one.

This is still a narrow `VaultView` FileTree/Diary orchestration fix. It does
not change the FileTree component contract, generic tab/router ownership,
server/shared code, metadata, schema, package, lockfile, or dependencies.
The existing refresh provenance remediation remains intact.

The new browser regression is:

```text
Calendar click Diary A
→ query = A
→ user edits query to a temporary value
→ user edits query back to A
→ leave Diary scope
→ query remains A as user-owned state
→ ordinary Note whose path contains A remains visible
```

It passed together with the existing Round 3, D6.5, D7.3, and Calendar
lifecycle regressions. The test is a real authenticated browser flow and
does not use production-only branches or internal Vue state.

Validation after `5f4bda4`:

| Command | Result |
| --- | --- |
| `npx playwright test e2e/diary-mood-lifecycle-regression.spec.ts --project=chromium` | **15 passed** |
| Round 3 + D6.5 Diary browser suites | **42 passed** |
| `npx vitest run src/views/__tests__/VaultView.test.ts` | **40 passed** |
| `npm run test:unit` | **235 files, 3523 passed, 2 skipped** |
| `npm run typecheck:client` | **PASS** |
| `npm run typecheck` | **PASS** |
| `npm run build` | **PASS** |

The first unprivileged browser/unit attempts were blocked by the environment
with local server/IPC `EPERM`; the same commands were rerun in the permitted
elevated local environment and passed. Build output retains only existing
dependency annotation and large-chunk warnings; test output retains known
jsdom/browser-environment informational warnings.

The current Round 3 lifecycle remains:

```text
D7.4 = IN PROGRESS
D7.4 Round 1 = REVIEW-CLOSED
D7.4 Round 2 = REVIEW-CLOSED
D7.4 Round 3 = REVIEW-READY
D7.4 Round 3 Independent Re-review = PENDING
D7.4 Round 3 Self-review P0/P1/P2 = 0/0/0
D7.4-R3-P2-2 = CLOSED (by 57ba3409)
D7.4-R3-P2-3 = CLOSED (by 5f4bda4)
D7.5 = NOT STARTED
```

This remediation is ready for independent re-review. Do not start D7.5 in
this phase.

### 12.8 Round 3 P2-4 remediation — user-owned empty query must survive refresh

The independent re-review of `d28c2ab` found one narrower continuation of the
FileTree ownership boundary:

```text
D7.4-R3-P2-4
Root cause: a user-cleared query and a fresh empty query both ended as
`diaryFilterSeed = ''` and `filesFilter = ''`. After refresh, Diary bootstrap
could therefore treat the active Diary document as permission to seed its
date again.
```

The focused remediation commit `f461496`
(`fix(diary): preserve user-owned empty query`) adds an explicit persisted
ownership state without changing the FileTree component contract:

- `DiaryFilterOwnership` is persisted as `none`, `calendar`, or `user` under
  `nuvyn.diary.filter-ownership`;
- the existing `@update:filter` boundary marks every user edit as `user`,
  including an empty string, and clears the Calendar seed;
- Diary bootstrap and `selectedDiaryDate` follow-up watchers do not seed while
  the query is user-owned, so a cleared query remains empty after refresh and
  Diary scope re-entry;
- Calendar/date navigation writes the query and seed together and marks the
  state `calendar`; scope exit clears only an unchanged Calendar seed and
  returns that state to `none`;
- Diary exact-path projection now also requires `calendar` ownership, so a
  user who types the same date again does not recreate the projection;
- intact pre-ownership seed/query pairs migrate to `calendar`; a previously
  user-edited non-empty query remains ordinary user state.

The fix remains local to `VaultView` orchestration and its regression
coverage. It does not modify the FileTree component, router, generic tab
store, server, shared protocol, metadata, schema, package, lockfile, or
dependencies.

The new browser regression is:

```text
Calendar click Diary A
→ query = A
→ user clears the query
→ persisted ownership = user
→ refresh
→ query remains empty
→ another Diary is visible, proving exact-path projection is off
→ leave Diary scope
→ ordinary Note tree still has an empty query
```

It is a real authenticated browser flow. It also asserts that refresh,
scope transition, and the empty query do not create a Diary or issue a Mood
mutation.

Validation after `f461496`:

| Command | Result |
| --- | --- |
| Focused empty-query E2E: `diary-mood-lifecycle-regression.spec.ts --grep "user-owned empty query"` | **1 passed** |
| D7.4 + D6.5/D7.3 Diary browser suites | **43 passed** |
| `npx vitest run src/views/__tests__/VaultView.test.ts` | **41 passed** |
| `npm run test:unit` | **235 files, 3524 passed, 2 skipped** |
| `npm run typecheck` | **PASS** (client and server) |
| `npm run build` | **PASS** |
| `git diff --check` | **PASS** |

The first unprivileged focused browser attempt was blocked by the local
environment's `127.0.0.1:4174` server-bind `EPERM`; the same test passed in the
permitted local E2E environment. Unit tests were also run in the permitted
local environment. Build output retains the repository's existing dependency
annotation and large-chunk warnings; test output retains known environment
informational warnings.

The final Round 3 lifecycle is:

```text
D7.4 = IN PROGRESS
D7.4 Round 1 = REVIEW-CLOSED
D7.4 Round 2 = REVIEW-CLOSED
D7.4 Round 3 = REVIEW-CLOSED
D7.4 Round 3 Independent Re-review = PASS (0/0/0)
D7.4 Round 3 Self-review P0/P1/P2 = 0/0/0
D7.4-R3-P2-2 = CLOSED (by 57ba3409)
D7.4-R3-P2-3 = CLOSED (by 5f4bda4)
D7.4-R3-P2-4 = CLOSED (by f461496)
D7.4 Round 3 GitHub CI #552 = PASS
D7.5 = NOT STARTED
```

Round 3 independent re-review passed with no remaining findings. This
docs-only closure sync marks Round 3 `REVIEW-CLOSED`; D7.4 remains
`IN PROGRESS`, and D7.5 has not started.

### 12.9 Round 3 closure sync

The final Round 3 independent re-review confirmed that all Round 3 findings
were closed:

```text
D7.4 Round 3 Independent Re-review = PASS
P0 = 0
P1 = 0
P2 = 0

D7.4 Round 3 = REVIEW-CLOSED
D7.5 = NOT STARTED
```

The closed findings are:

```text
D7.4-R3-P2-1 = CLOSED
D7.4-R3-P2-2 = CLOSED
D7.4-R3-P2-3 = CLOSED
D7.4-R3-P2-4 = CLOSED
```

The final evidence HEAD was validated by GitHub Actions CI #552:

```text
Run ID: 33172432195
HEAD: 1efb18fe6b0c2693c8d9531ec0417eec8db0df45
Status: completed
Conclusion: success
Required jobs: PASS
```

This closure changes documentation only. It does not reopen D7.4 Round 1 or
Round 2, start D7.5, or change the production, test, server, shared, schema,
router, package, or dependency boundary.

## 13. D7.4 final gate and closure sync

The final D7.4 gate reviewed the official lifecycle and conflict exit criteria
against the characterization matrix above. All required cases have direct
browser, integration, unit, or existing-owner regression evidence: clean and
dirty body coexistence with Mood set/change/clear; body save ordering and
draft removal; History Comparison/Restore; baseline and divergent Recovery;
external body and metadata conflicts; unknown Mood values; delete/recreate
generation isolation; same-date reopen; scope, tab, refresh, deep-link,
Back/Forward, identity, raw, dirty, metadata, Calendar, and ordinary Vault
continuity; and the bulk projection/no-N+1 boundary.

The final gate result is:

```text
D7.4 Final Gate = PASS
P0 = 0
P1 = 0
P2 = 0

D7.4 = REVIEW-CLOSED
D7.4 Round 1 = REVIEW-CLOSED
D7.4 Round 2 = REVIEW-CLOSED
D7.4 Round 3 = REVIEW-CLOSED
D7.4 Round 3 Independent Re-review = PASS (0/0/0)
GitHub CI #552 = PASS
D7.5 = NOT STARTED
D7.6 = NOT STARTED
D7 Mood release = NOT STARTED
```

GitHub CI #552 validated the final production/test evidence HEAD
`1efb18fe6b0c2693c8d9531ec0417eec8db0df45` with all required jobs successful.
The current closure commit is documentation-only, so it does not require a
new production or test run. Historical Round 0–3 snapshots that record
`IN PROGRESS`, `REVIEW-READY`, `PENDING`, or earlier findings remain preserved
as historical lifecycle evidence and are not the current D7.4 state.

This final closure sync changes only this evidence document. It does not
start D7.5 or D7.6, reopen any closed D7.4 round, or modify production, test,
server, shared, schema, router, package, or dependency scope.
