# D7.6 — Release and Closure Evidence

> **Historical lineage — not current runtime authority.** Current behavior is
> defined by [Diary Architecture](../architecture/diary.md) and [Diary User
> Guide](../user-guide/diary.md). This file is retained for D7 traceability.

## Status

`D7.6 = REVIEW-CLOSED`

`D7.6 Self-review = PASS`

Self-review findings: `P0 = 0`, `P1 = 0`, `P2 = 0`

`D7.6 Independent Review = PASS`

Independent Review findings: `P0 = 0`, `P1 = 0`, `P2 = 0`

Independent Review PASS and GitHub CI #560 PASS are recorded by this separate
docs-only closure sync. `D7 overall` is now `REVIEW-CLOSED`.

The closed phases remain:

```text
D7.0A = REVIEW-CLOSED
D7.0  = REVIEW-CLOSED
D7.1  = REVIEW-CLOSED
D7.2  = REVIEW-CLOSED
D7.3  = REVIEW-CLOSED
D7.4  = REVIEW-CLOSED
D7.5  = REVIEW-CLOSED
D7.6  = REVIEW-CLOSED
```

## Starting HEAD

The required D7.6 baseline was verified before any work:

```text
7e9f2cf64de55dca882dd4b6c66174f4d4daac72
docs(diary): close D7.5 responsive accessibility review
```

Local `HEAD` and `github/main` both pointed to this SHA and the starting
worktree was clean. No commits were present after the required baseline at
pre-flight.

The only D7.6 coverage-gap commit is:

```text
af3dd6c4fbd5d54fc40346aedfbfbb709fa08bb1
test(diary): cover literature ordinary vault release gate
```

Its parent is the exact D7.6 starting HEAD. It adds one existing ordinary Vault
release case for `Literature`; it contains no production change.

The release evidence commit is:

```text
f8aa61c32048fadf4edc6b0dc1ebb5fcf9630ac7
docs(diary): record D7.6 release evidence
```

The lifecycle-boundary remediation commit is:

```text
379f4e0d5c034c5b383118673f6eb6afad0598ca
docs(diary): align D7.6 lifecycle boundary
```

It removed the stale reference to a nonexistent later phase. This final
closure commit is a separate docs-only change; its exact SHA is reported from
Git after commit and push rather than guessed inside its own contents.

## D7 Release Lineage Matrix

The matrix below records the closed D7 lineage from the canonical evidence and
Git history. Historical review failures and remediations remain historical;
they are not reclassified as fresh D7.6 findings.

| Phase | Starting HEAD | Implementation / test and remediation lineage | Evidence / closure | Final review |
| --- | --- | --- | --- | --- |
| D7.0A | `e38505cda16e7dcd4d5b9335e9165ded3f86547d` | `6ac78658f6e732afacd230852438ee7d3d0a03f1`, `f06a1756eb9c85af297c542983cac958c9641d75`, `5edd105e646ad0104cbc05f95e3ca144596d12f5`, `081884581f6892a93afa5575f9550dfb5f720fbc`, remediation `256c30c43c9a5a268abdd5fc1a317ea82109d3fa` | evidence `224832afa67434273bbe07c7894bf8d4e1e536b0`; closure `e4fbff0d08e9efbe0e5b13bf76ccce9399a53968` | Independent Re-review `PASS`; `P0/P1/P2 = 0/0/0` |
| D7.0 | `696ccf9654e62ff57c356ffffdd2573410cade15` | characterization `03507ac871779f29c4a50bfae869acd8b2815263`; v1 remediation `67546d79d3e19c683b807b72e3d4116d16e705bc` | initial evidence `b1b0fd39517862b1f1f6f1206c7410516fbdfd12`; revalidation evidence `2b4333adaff550cfc0885807ea8175f43ad47cb4`; closure `63f4100b64bdef1e354217bf489c8f45f2ed9879` | blocker determination `PASS`; revalidation `PASS`; final `P0/P1/P2 = 0/0/0` |
| D7.1 | `63f4100b64bdef1e354217bf489c8f45f2ed9879` | implementation `c9e909dbc98bd63175fdfde2eb652603f60f1e1a`; remediation `199fbe4a8de6af151f47f268abb3ff4616db405b` | evidence `b56c2576b6e2111d72be653fa1de1f3f14bb4b4f`; closure `b5794392ed5dae8235ea4018f443ff89d2b35a89` | Independent Re-review `PASS`; `P0/P1/P2 = 0/0/0` |
| D7.2 | `b5794392ed5dae8235ea4018f443ff89d2b35a89` | implementation `1f8148d187e6268d3a7c6088e1150b11de203ea7`; mobile remediation `80db14794116b690ecc8654a8b108dcea0422e96`; keyboard remediation `f066164d0bbca972fc225767b79cacd6ea778eb1` | evidence `0c602bbb4ae1ddcea865cb65215632bb86d9db06`; closure `5d14967e2a1de829c084cf1cc6a08ade10cdcc3c` | Independent Re-review `PASS`; CI #529 `PASS`; `P0/P1/P2 = 0/0/0` |
| D7.3 | `5d14967e2a1de829c084cf1cc6a08ade10cdcc3c` | implementation `e1a5b6c61373a99f42fb3b1d4af22d8805409b1e`; Calendar remediation `b0f8cdafcfacd7f1f2135f552ad125b6dcf606f0`; post-closure UX remediation ended at `1226b1700741017e0a93368d47b6ce9d7454108f` | evidence `3fd8497a37e47ffd17a568990391a2181c22a190`; historical closure `98cd94bdd1c7f9bb3bf445242f2d7ad41beae2a1`; post-closure closure evidence `79020855945745f561498e6936ef332b2c78a503` | Independent reviews `PASS`; CI #539 `PASS`; final `P0/P1/P2 = 0/0/0` |
| D7.4 | `14b1efdf03a13063420fe344dc36eafc40c61dc8` (Round 0) | Round 0 test `ed8524b46e40fb15b38fd39320bfd7f3af2f442c`; Round 1 `8017594d9da4f7ac2e6ab8482fdefdaa3838781f`, `ec4b190a4ad89871021afa46906a77c18ec2fc61`; Round 2 tests/remediation `b8d721ee5c957b0097a1e22d9602822262754867`, `b87cc2acedd23f116a37922a6ae173eac25523e0`; Round 3 lineage `89099702f8710335bb537f04d8eff9101a500c94`, `57ba340964cfa935756657be0b841a3f742972e4`, `5f4bda4b313e641dca116017d401bb9a5a9b9b37`, `f46149642aa6547687efa9bb75b2de5b7fa52d9c` | Round 0 evidence `4202fc25f78415f062af1c13c290bf994836b92c`; Round 3 closure `4ec6f197686f826fe28e30ff56d25e822fc65f35`; overall closure `93dca2729003069beffc6060336a72a737771b87` | Final Gate `PASS`; CI #544/#547/#552 `PASS`; `P0/P1/P2 = 0/0/0` |
| D7.5 | `93dca2729003069beffc6060336a72a737771b87` | Round 1 `f48c77fe4638f176e58418a09e96618467d1e499`, `3b43867e21f7af2e137c379621a775a6d37d04c0`; Round 2 `ceb2b554f4b1b0c49efeb32c52f3f32d0355fa51`, `d53f1d9cc29f75f826227b6bf24e0faa162083ea`, `48447be39833cc3c2ad0a832531e6c53f16f3a2a` | Round 1 evidence `5838773095d3468630c0789b7152cb8a48825b16`; Round 2 evidence `3e1a392d575b15492e30df26f28a8bb67a4be9b5`; closure `7e9f2cf64de55dca882dd4b6c66174f4d4daac72` | Final Gate `PASS`; CI #555/#557 `PASS`; `P0/P1/P2 = 0/0/0` |
| D7.6 | `7e9f2cf64de55dca882dd4b6c66174f4d4daac72` | coverage-only commit `af3dd6c4fbd5d54fc40346aedfbfbb709fa08bb1`; lifecycle remediation `379f4e0d5c034c5b383118673f6eb6afad0598ca` | release evidence `f8aa61c32048fadf4edc6b0dc1ebb5fcf9630ac7`; final closure is this docs-only commit | Independent Review `PASS`; CI #560 `PASS`; `P0/P1/P2 = 0/0/0` |

The D7.0A–D7.5 rows are historical phase evidence. The D7.6 row is the only
fresh release phase in this document.

## Final Runtime / Ownership Matrix

The release retains the existing ownership boundaries:

| Concern | Final owner | D7 extension and release result | Forbidden duplicate absent |
| --- | --- | --- | --- |
| Live metadata source of truth | SQLite `documents` metadata | `mood TEXT NULL` remains the one live Mood owner; focused metadata and browser lifecycle checks pass | No sidecar/frontmatter Mood owner |
| Metadata CAS | existing metadata version / `updatedAt` owner and `useDiaryMoodCommand` | set/change/clear uses the expected version; conflict tests pass | No direct Calendar write or CAS bypass |
| Generic metadata History revisions | generic History metadata revision foundation | covered revisions bind and restore body plus matching metadata; v1 policy is explicit | No Mood-specific History store |
| History Restore | existing generic restore transaction | v2 restores matching Mood; pre-Mood covered revisions preserve current durable Mood; ordinary Note compatibility passes | No Diary-only restore lifecycle |
| Draft Recovery | existing body draft persistence/recovery | body recovery keeps current durable metadata/Mood | No metadata snapshot in body draft owner |
| DiaryDate/create/future guards | `useDiaryDateCommand` / canonical date API | missing today/past Mood-first and missing-future guard pass | No client-only path or future bypass |
| Mood registry | shared canonical registry | exactly 24 stable IDs, canonical assets, fixed 4 columns × 6 rows | No picker-local catalog |
| Mood command | `useDiaryMoodCommand` | Calendar and native flows use the same mutation seam | No second mutation owner |
| Month read | existing bulk `PostSummary[]` seam | Calendar joins summaries without per-cell reads/N+1 | No `/api/diary/dates` per-cell loop |
| Calendar presentation | Calendar surface / `VaultView` orchestration | marker/action, missing-date lifecycle, keep-mounted behavior, and VCalendar compatibility pass | No Calendar-owned document/tab lifecycle |
| Mood Picker presentation | single shared `DiaryMoodPicker` | native and Calendar entry paths preserve one picker and 4×6 semantics | No second picker/dialog |
| Route / history | existing Vault route and History surfaces | deep link, Back/Forward, History, and Recovery remain native | No Mood route |
| Tabs / `activePath` | existing Vault tab workspace | identity, close/fallback, selection, and refresh continuity pass | No Diary tab source of truth |
| Body raw/save/dirty | existing native Vault editor/save/draft owners | dirty body and metadata conflict boundaries pass | No Mood raw/frontmatter rewrite |
| FileTree query ownership | existing generic FileTree plus explicit Vault seed provenance | system seed, user edits, user-cleared query, refresh, and ordinary navigation pass | No Diary policy in generic FileTree |
| Ordinary Vault | existing generic Vault | Inbox, Literature, Archive, and Ledger remain native and outside Mood policy | No Calendar/Mood inheritance |

## D7 Production Footprint

The runtime baseline immediately before the first D7 production implementation
is `e38505cda16e7dcd4d5b9335e9165ded3f86547d`, the D7 Plan Amendment closure.
The audited D7 runtime footprint from that baseline through the D7.6
coverage-only HEAD contains the intentional closed D7 categories:

- server metadata, History metadata revisions, migrations, routes, and their
  tests;
- shared Mood domain/registry and tests;
- client metadata/history APIs;
- Diary registry, commands, Calendar, Picker, Calendar projection, and tests;
- Vault integration, FileTree/provenance wiring, native lifecycle tests;
- D7 browser evidence and canonical design evidence.

The full audit is `70 files changed, 14,020 insertions, 450 deletions` from
the runtime baseline to the coverage-only HEAD. These are the accumulated,
intentional D7 changes; they are not presented as D7.6 changes.

The D7.6 delta is separately and exactly:

```text
7e9f2cf64de55dca882dd4b6c66174f4d4daac72..af3dd6c4fbd5d54fc40346aedfbfbb709fa08bb1
 e2e/diary-reader.spec.ts | 1 +
 1 file changed, 1 insertion(+)
```

The release evidence, lifecycle remediation, and final closure commits add
only this document. D7.6 therefore changes no
production code, server code, shared code, migration, package, lockfile,
dependency, or test behavior beyond the one ordinary Literature coverage
case.

## D7 Exit-Criteria Coverage Matrix

| Release area | Fresh direct coverage | Result |
| --- | --- | --- |
| D7.0A generic History metadata revision / restore / legacy semantics | `server/__tests__/history-metadata-revisions.test.ts`, History integration, D7.4 History/Restore browser cases | PASS |
| D7.0 storage, metadata owner, dirty-body separation, lifecycle ownership | metadata unit/integration files, native Editor/History/Recovery browser cases | PASS |
| D7.1 registry, validation, CAS, unknown/unrelated metadata, bulk read, guards | shared/server/component/composable focused set and Mood browser suites | PASS |
| D7.2 one Picker, 4×6, selection/clear, dirty body preservation | Picker/Calendar component tests and Mood accessibility/responsive/lifecycle browser suites | PASS |
| D7.3 Calendar marker/action, Mood-first creation, no N+1, keep-mounted Calendar, VCalendar | Calendar component tests, `diary-calendar-surface.spec.ts`, projection/bulk tests, VCalendar suite | PASS |
| D7.4 History/Recovery/conflict/unknown/delete-recreate/scope/tab/refresh/deep-link/query | 16-test `diary-mood-lifecycle-regression.spec.ts` plus D6 lifecycle suites | PASS |
| D7.5 four viewports, keyboard, touch, focus-visible, ARIA, selected cue, Clear, zh/en, light/dark, overflow | 2 responsive tests, 9 accessibility tests, D6.6 responsive suite | PASS |

No D7.6 feature behavior was invented or duplicated. Existing direct evidence
was reused and rerun fresh; the only real gap was ordinary Literature coverage.

## D7.0A–D7.5 Fresh Focused Validation

The focused release set was derived from the existing D7 evidence and included
registry/assets/order, validation, metadata schema/read/write, CAS, unknown and
unrelated metadata, History revisions/restore, DiaryDate/path/future guards,
bulk month projection, Mood command, Calendar projection, Picker behavior,
Vault integration, and FileTree query ownership.

```text
30 test files
526 tests passed
```

The focused set included the relevant server, shared, Diary component,
Calendar/Vault composable, History/Recovery, FileTree, and `VaultView` test
files. No focused assertion failed.

## D6 Diary Regression

The fresh D6 Diary target matrix was run from the current tree:

```text
e2e/diary-calendar-surface.spec.ts
e2e/diary-reader.spec.ts
e2e/diary-editor-lifecycle.spec.ts
e2e/diary-lifecycle-regression.spec.ts
e2e/diary-responsive-accessibility.spec.ts
e2e/diary-release.spec.ts
e2e/vcalendar-compatibility.spec.ts

50 passed
```

This covers Calendar, native Reader, Editor lifecycle, History/Recovery,
conflict, tab/route continuity, responsive/accessibility, release behavior,
and VCalendar compatibility. The Reader suite now directly includes the
ordinary Literature case required by the release gate.

## Ordinary Vault Regression

The ordinary Vault release gate directly exercises all four required scopes in
the current `diary-reader.spec.ts` test:

```text
Inbox      → inbox/d6-native-note-smoke
Literature → literature/d6-native-literature-smoke
Archive    → archive/d6-native-archive-smoke
Ledger     → ledger/d6-native-ledger-smoke
```

Each remains a native ReadingPane/FileTree document, has no Diary Reader
Dialog or Mood policy, and uses ordinary route/tab ownership. The focused
ordinary Vault test passed as part of the D6 matrix and the full Chromium run.

## Fresh D7 Browser Regression

The fresh D7-specific browser target matrix was:

```text
e2e/diary-mood-lifecycle-regression.spec.ts  16 passed
e2e/diary-mood-responsive.spec.ts             2 passed
e2e/diary-mood-accessibility.spec.ts          9 passed
e2e/diary-calendar-surface.spec.ts           11 passed

38 passed
```

The Calendar file is intentionally shared with the D6 matrix; these 38 tests
are the direct D7 browser release set, not historical counts. They cover clean
and dirty Mood set/change/clear, external body and metadata conflict,
unknown Mood, v2 History Restore, baseline/divergent Recovery, delete/recreate
identity, missing/future dates, Calendar/Native presentation, query
provenance, refresh/deep-link/Back/Forward, 4×6 geometry, keyboard/touch,
ARIA/focus-visible, locales, themes, and overflow.

## Full Chromium Regression

```text
npm run test:e2e
149 passed
```

The full current Chromium suite passed, including the fresh D7 and D6 target
files and all unrelated repository browser coverage.

## Draft Store Regression

```text
npm run test:e2e:draft-store
38 passed
```

The Draft Store suite passed independently. Its existing non-D7 mounted-hook
warning is recorded under Diagnostics and was not treated as a D7 failure.

## Full Unit Regression

The repository aggregate command was run fresh:

```text
npm run test

test:unit                 235 files passed; 3524 passed; 2 skipped
test:history-integration  5 files passed; 174 passed
test:recovery-integration 5 files passed; 193 passed
```

The standalone full unit result is `235 test files passed; 3524 passed; 2
skipped (3526 total)`. No assertion failure remained.

Additional fresh release regression:

```text
npm run test:tags-scale
2 files passed; 6 passed
```

## Typecheck / Build

```text
npm run typecheck:client  PASS
npm run typecheck:server  PASS
npm run typecheck          PASS
npm run build              PASS
```

The build completed successfully. It emitted existing dependency annotation
and large-chunk warnings from the Vite/Rolldown toolchain; no build error or
application source error occurred.

## Diagnostics

The relevant D7 and D6 Diary browser specs collect `pageerror` and
`console.error` and assert their expected state. Those assertions passed in
the fresh target matrix and full Chromium run. Expected conflict/404 cases are
owned by the corresponding tests rather than broadly filtered.

The full local runs also printed known, non-D7 harness diagnostics:

- Monaco/webserver cancellation output during the full Chromium run;
- an existing Draft Store Vue mounted-hook warning during its passing suite;
- jsdom `scrollTo`, CSS parsing, and canvas `getContext()` warnings during
  unit tests;
- Vite/Rolldown dependency annotation and chunk-size warnings during build.

These did not produce a failing D7/D6 assertion, a retained page error, or an
unexpected console error in the relevant Diary release cases. No broad console
filter or swallowed failure was added.

## Findings / Failure Classification

One real D7.6 coverage gap was found during the pre-test audit:

```text
D7.6-P2-1 (coverage gap, resolved)
ordinary Literature Vault release coverage was absent from the direct
ordinary-scope matrix even though Inbox, Archive, and Ledger were covered.
```

Classification: `B. COVERAGE/HARNESS BUG`, not a product regression. The
smallest characterization change was the single Literature case in
`e2e/diary-reader.spec.ts`; it passed without production changes.

An initial unprivileged recovery-integration run and the initial build attempt
were not used as release results: the recovery failures were exclusively local
`listen EPERM` IPC/service permission errors, and the build process handle was
lost before a completion status could be observed. The unchanged elevated
recovery rerun passed all 193 tests, and the verified elevated build passed.
No product failure was promoted from those environment/process issues.

No unresolved D7.6 product finding remains:

```text
D7.6-P0-1 = none
D7.6-P1-1 = none
D7.6-P2-1 = CLOSED by af3dd6c4fbd5d54fc40346aedfbfbb709fa08bb1
```

The later lifecycle-document finding was also resolved before closure:

```text
D7.6-P2-2 = CLOSED by 379f4e0d5c034c5b383118673f6eb6afad0598ca
```

## STOP-condition Audit

The fresh release audit found no need for:

- a second metadata/document lifecycle;
- a raw rewrite that can overwrite dirty content;
- a new database, sidecar, parser, or Mood-specific History/Recovery store;
- an orphan Mood record or future-guard bypass;
- a new Diary route or Reader/Editor/Dialog workspace;
- Diary hardcoding in the generic FileTree contract;
- per-cell/N+1 month reads;
- a 6×4 layout, catalog change, or SVG-path persistence;
- a package, dependency, migration, or unrelated generic Vault change.

## Dependency / Package Audit

The D7 runtime footprint intentionally includes the D7.0A History metadata
foundation and D7.1 metadata migration/shared domain work. It is incorrect to
describe all D7 history as server/shared-free.

The D7.6 delta after the required starting HEAD contains only:

```text
e2e/diary-reader.spec.ts
```

The release evidence, remediation, and final closure commits contain only this
documentation file. D7.6 adds or
changes no `package.json`, lockfile, dependency, migration, server, shared,
router, Calendar, Vault production, or metadata owner file.

## Repository Cleanliness

Before the evidence document was created:

```text
git diff --check = PASS
git status      = clean except intentional af3dd6c4fbd5d54fc40346aedfbfbb709fa08bb1
```

No generated test Diary, fixture, screenshot/trace, Draft DB, History artifact,
temporary content, or coverage artifact was tracked. The final post-commit
status and exact `github/main` SHA are reported after push.

## CI

This document does not reuse historical D7.5 CI #555 or #557. The exact-head
GitHub Actions result for the D7.6 release evidence commit was:

```text
CI #560
Run ID      = 33195176529
Attempt     = 1
HEAD        = f8aa61c32048fadf4edc6b0dc1ebb5fcf9630ac7
Status      = completed
Conclusion  = success
```

All required platform and auxiliary jobs passed. The subsequent remediation and
closure commits are docs-only and do not change the tested production or test
scope, so CI #560 remains the release validation result.

## Self-review

The self-review of `7e9f2cf64de55dca882dd4b6c66174f4d4daac72..HEAD` confirms:

- the only D7.6 test delta is the Literature ordinary Vault case;
- the only other D7.6 delta is this evidence document;
- no production, dependency, package, lockfile, or duplicate framework scope
  was introduced;
- all D7.0A–D7.5 evidence remains historical and closed;
- no historical PASS count is presented as a D7.6 fresh result;
- the release evidence commit did not prematurely mark the D7.6 lifecycle
  closed.

```text
P0 = 0
P1 = 0
P2 = 0
```

## Current Lifecycle

```text
D7.0A = REVIEW-CLOSED
D7.0  = REVIEW-CLOSED
D7.1  = REVIEW-CLOSED
D7.2  = REVIEW-CLOSED
D7.3  = REVIEW-CLOSED
D7.4  = REVIEW-CLOSED
D7.5  = REVIEW-CLOSED

D7.6 = REVIEW-CLOSED
D7.6 Self-review = PASS (0/0/0)
D7.6 Independent Review = PASS (0/0/0)

D7 overall = REVIEW-CLOSED
```

The final closure commit is separate from the release evidence and remediation
commits, and does not start any later D7 phase.
