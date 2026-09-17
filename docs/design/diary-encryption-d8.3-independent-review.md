# D8.3 Independent Review

> **Historical lineage — not current runtime authority.** Current behavior is
> defined by [Diary Architecture](../architecture/diary.md) and [Diary User
> Guide](../user-guide/diary.md). This file is retained for D8 review
> traceability.

Status: `CHANGES REQUIRED`

Independent result: `D8.3 Independent Review = CHANGES REQUIRED (0/2/0)`

This review is intentionally separate from implementation/remediation. No production code or test code was modified by this review.

## 1. Review target

```text
Planning baseline:
99f693b02080127c16911869c17edcb2fa38fe3c

Core implementation:
584cf770111bc2f5ee86be08ecda7ea50586bc87

Final implementation HEAD:
6308947cd6fd758cd6055a687a1d4e49891a5e2c

Evidence HEAD / pre-review repository HEAD:
2ae404e5132c7bda7852ee6b37a5e8265d1304c6

Primary implementation review range:
99f693b02080127c16911869c17edcb2fa38fe3c..6308947cd6fd758cd6055a687a1d4e49891a5e2c
```

The evidence commit is docs-only and is reviewed as evidence, not as a replacement for the implementation checkpoint validated by CI #592.

## 2. Provenance

Repository ancestry and compare metadata independently confirm that `6308947` is two commits ahead of planning baseline `99f693b`, consisting of the core D8.3 implementation followed by the router-test stabilization commit. The evidence commit `2ae404e` follows the final implementation checkpoint and was the repository `main` HEAD when this review began.

CI provenance independently checked:

```text
#591
HEAD: 584cf770111bc2f5ee86be08ecda7ea50586bc87
Result: failure
Observed failure stage: Windows Node 24 / complete unit and integration suite
Typecheck/build before that stage: passed
Browser steps after the failed stage: skipped

#592
Run ID: 33369599249
Attempt: 1
HEAD: 6308947cd6fd758cd6055a687a1d4e49891a5e2c
Result: 8/8 PASS

#593 (docs-only evidence HEAD)
Run ID: 33371440512
Attempt: 1
HEAD: 2ae404e5132c7bda7852ee6b37a5e8265d1304c6
Result: PASS
```

For #591, the exact full job log was not retrievable from the review environment. The stabilization diff was independently inspected and is limited to the router-unit `VaultView.vue` stub plus evidence text. The implementation evidence's stronger statement that no D8.3 assertion failed in #591 is therefore only partially independently proven; this does not affect the two source-proven P1 findings below.

## 3. Review methodology

The review traced dangerous surfaces from route/UI entry points through service/lifecycle layers to the owner that performs persistence, publication, mutation, or body-derived caching. It did not accept route checks or aggregate test counts as proof.

The review independently inspected the D8.3 implementation diff and the principal owners for Git/history mutation and restore, Draft/Recovery IndexedDB ownership, tree/list/metadata projection, LinkIndex cold/warm/incremental behavior, search/body cache and stale epochs, Diary session generation and teardown, conflict/raw holders, rename/move/reference/delete ownership, AI routes and AI tools, Markdown resource reads, PDF/clipboard generation fences, diagnostics/evidence/CI lineage, path classification, and ordinary Note regressions.

The review also inspected changed tests, router stabilization, and exact-head GitHub Actions metadata/jobs.

A fresh local checkout and rerun of the full command matrix could not be completed in the review execution environment because outbound Git clone failed through the available network path. No test retries, timeout changes, skips, or implementation edits were made. Exact-head CI #592 and source-level adversarial inspection were used as runtime/provenance evidence; this limitation prevents over-claiming runtime proof but is not the basis of either P1 finding.

## 4. Source ownership audit

### Git / History

`server/history/git.ts::addAndCommit` preflights the complete input path batch for managed Diary identity before repository mutation, so mixed Note+Diary input is rejected before temporary Git/index/plumbing work. `server/history/restore.ts` rejects managed Diary before historical raw publication, filesystem write, metadata journal, or LinkIndex mutation. No P0/P1 bypass was found in the inspected Git/restore owner paths.

### Draft / Recovery

`draftStore.ts` classifies managed paths before durable write/transaction entry and filters managed legacy records on read/list paths rather than silently migrating or deleting them. Higher-level pagehide/dispose/recovery paths use the same classification contract. No direct store bypass was found in the inspected D8.3 paths.

### Tree / metadata

Managed Diary projection is structural-only in the inspected paths; generic body/frontmatter parsing is bypassed for managed identity. Legacy private metadata is filtered rather than claimed deleted. No actionable finding was found here.

### LinkIndex

Cold rebuild and per-file snapshot classification skip managed Diary body parsing. Managed incremental writes reduce to structural/purge behavior, and published managed body-derived edges are suppressed. Ordinary `Note -> Note` indexing remains implemented. No actionable finding was found here.

### Search

Managed Diary body/title/summary/tags do not enter the generic searchable body cache/index in the inspected implementation; stale search publication is fenced by the Diary session/search epoch. No actionable finding was found here.

### Teardown / conflicts / UI holders

The authoritative Diary generation advances before subscriber cleanup, and inspected holders are cleared/fenced against stale completion. No independent evidence of post-lock body republishing was found.

### Rename / move / delete

Public managed rename/move/delete routes generally fail closed before mutation. Two owner-policy defects remain: the generic atomic delete owner exposes a caller-controlled bypass intended only for failed-create rollback, and AI ordinary Note rename applies a vault-wide Diary-existence rejection before computing the actual reference footprint. These are Findings D8.3-IR-P1-1 and D8.3-IR-P1-2.

### AI / resources

Managed AI context/summary/commit-message collection and managed body tools are guarded before generic body/provider work in the inspected paths. Markdown-resource body access reuses the Diary authorization/body-operation path. No provider-call plaintext bypass was found.

### PDF / clipboard / diagnostics

Inspected UI generation fencing is generation-aware. No source-proven stale PDF download or clipboard write was found. No fresh diagnostic-canary artifact exercise was possible without the local checkout, so the review does not claim independent runtime canary proof.

## 5. Security surface audit

No P0 plaintext/key/session escape was identified in the inspected D8.3 implementation. However, closure still fails because the frozen policy also requires dangerous mutation rules to be enforced by the actual owner and ordinary Note behavior to remain unchanged outside the explicitly approved exception.

The two P1 findings violate those owner/compatibility contracts even though neither demonstrates a plaintext disclosure.

## 6. Adversarial test results

| Scenario | Independent result |
| --- | --- |
| direct managed Git commit | Source-proven reject before Git mutation |
| mixed Note+Diary commit | Source-proven complete preflight rejection |
| managed History restore | Source-proven reject before raw/fs mutation |
| managed Draft durable write | Source-proven reject before durable store write |
| legacy managed Draft read while locked | Source-proven filtered/no render path |
| cold LinkIndex rebuild | Source-proven no managed body parse |
| Note -> Diary LinkIndex edge | Source-proven suppressed |
| Note -> Note LinkIndex edge | Source/test evidence preserved |
| managed search body cache | Source-proven excluded |
| stale search completion | Source-proven generation/epoch drop |
| managed AI body/provider path | Source-proven fail closed before provider/body collection on inspected routes |
| managed rename public route | Source-proven fail closed |
| managed delete public route | Source-proven fail closed |
| generic atomic managed delete owner with `allowManagedDiary: true` | **FAIL: owner bypass exists — P1-1** |
| ordinary AI Note rename with unrelated Diary elsewhere in vault | **FAIL: over-broad rejection — P1-2** |
| router stabilization | Test-only lazy `VaultView` stub; exact-head #592 real browser lanes passed |
| diagnostic canary | Not freshly exercised in this review environment |

## 7. Ordinary Note regression

The implementation preserves the majority of inspected ordinary Note behavior, including Note body operations, History, search, LinkIndex, and the intentional `Note -> managed Diary` edge suppression exception.

It does not preserve all approved Note rename behavior. `server/ai/tools.ts::executeGuardedRename` enumerates all managed Diary files on disk and rejects any `rename_file` with reference updating enabled whenever that list is non-empty, before discovering whether the actual backlink/reference footprint contains a managed Diary. Therefore a completely unrelated Diary elsewhere in the vault disables an otherwise Note-only AI rename. This is outside the approved exception and is Finding D8.3-IR-P1-2.

## 8. CI/evidence audit

### Exact implementation CI

CI #592 is independently confirmed as:

```text
Run ID: 33369599249
Attempt: 1
HEAD: 6308947cd6fd758cd6055a687a1d4e49891a5e2c
Jobs: 8
Result: 8/8 PASS
```

The verify jobs execute typecheck, build, complete unit/integration suites and browser/Draft Store E2E; specialized auth-browser, tags-scale, visual and docker-smoke jobs also completed successfully. Failure-evidence upload steps being skipped on green jobs are expected and are not treated as omitted validation.

### Router stabilization

`6308947` adds a local `VaultView.vue` stub to router guard policy tests. The change removes unrelated lazy workspace module transformation from that unit surface. Real workspace/browser execution remained present in #592, so no independent P2 is assigned to the stub itself.

### Evidence-vs-source classification

| Major implementation-evidence claim | Review classification |
| --- | --- |
| no new managed Git body revision through inspected mutation owner | PROVEN |
| no managed persistent Draft/Recovery write through inspected store | PROVEN by source; exact-head CI supports runtime behavior |
| no generic Markdown parsing of inspected managed paths | PROVEN by source |
| no managed body/title/edges in LinkIndex | PROVEN by source |
| no managed body search cache | PROVEN by source |
| stale managed search completions ignored | PROVEN by source |
| all relevant raw/UI holders cleared | PARTIALLY PROVEN; broad source inspection, no fresh local runtime matrix |
| AI blocked before provider on managed body contexts | PROVEN by source |
| delete/rename reject before dangerous mutation under the frozen owner contract | CONTRADICTED by P1-1 at the atomic delete owner |
| existing Note behavior intact except `Note -> managed Diary` LinkIndex suppression | CONTRADICTED by P1-2 |
| no silent D8.4 migration | PROVEN by inspected paths |
| #591 failure contained no D8.3 assertion failure | PARTIALLY PROVEN; failure stage and stabilization diff verified, full log unavailable |

Overall implementation evidence assessment: **partially overstated / materially contradicted**.

## 9. Findings

### D8.3-IR-P1-1

ID:
`D8.3-IR-P1-1`

Severity:
`P1`

Title:
Caller-controlled `allowManagedDiary` escapes the failed-create rollback boundary at the durable delete owner

Affected owner:
`server/atomicTextWrite.ts::atomicRemoveTextIfUnchanged`

Source evidence:
`atomicRemoveTextIfUnchanged(targetPath, expectedRaw, { allowManagedDiary?: boolean })` rejects managed Diary only when `allowManagedDiary !== true`. Once `true`, the owner proceeds to capture the current artifact, compare current raw bytes, stage/rename, and remove it. The Diary create route invokes this generic exported owner with `{ allowManagedDiary: true }` for rollback.

Security invariant violated:
D8.3 freezes managed delete as unsupported except for the one narrowly scoped internal failed-create rollback. That exception must not be invocable as a generic managed delete API, must operate only on the internal failed-create artifact, and must not be able to delete an existing legitimate Diary document. Dangerous policy must be enforced by the actual mutation owner rather than by caller convention.

Reproduction:
An internal caller obtains the current encrypted raw bytes of an existing legitimate managed Diary file and calls `atomicRemoveTextIfUnchanged(path, currentRaw, { allowManagedDiary: true })`. The owner skips `ManagedDiaryDeleteUnsupportedError`; the compare-and-swap raw check succeeds because the caller supplied the current bytes, and the helper proceeds into its normal staging/removal transaction.

Observable impact:
A legitimate managed Diary can be durably deleted through an alternate internal caller without receiving the frozen managed-delete policy. This is an owner/mutation bypass and potential data-loss path. It is not classified P0 because it does not independently demonstrate plaintext/key disclosure.

Why existing tests did not catch it:
Existing managed-delete tests exercise public/default callers where `allowManagedDiary` is absent, and create rollback exercises the intended `true` caller. Those tests do not establish that the actual durable owner can distinguish a just-created rollback artifact from an arbitrary pre-existing managed Diary artifact.

Required remediation:
Bind the encrypted-delete exception to unforgeable transaction/provenance state for the exact failed-create artifact. A generic caller must not be able to opt into managed deletion with a boolean or equivalent caller assertion, and the actual delete owner must preserve the frozen fail-closed policy for every existing legitimate managed Diary document.

### D8.3-IR-P1-2

ID:
`D8.3-IR-P1-2`

Severity:
`P1`

Title:
AI ordinary Note rename is blocked by vault-wide Diary existence instead of the actual reference footprint

Affected owner:
`server/ai/tools.ts::executeGuardedRename`

Source evidence:
After rejecting a managed source/destination, `executeGuardedRename` calls `managedDiaryPathsOnDisk()`. When `update_references !== false` (the default) and that vault-wide list is non-empty, it immediately returns the encrypted-reference unsupported error. Actual backlink/reference discovery happens only afterward, including a later precise `discovered.sourcePaths.some(canonicalManagedDiaryPath)` check.

Security invariant violated:
The frozen D8.3 contract allows fail-closed rename/reference behavior when the operation's actual managed Diary footprint is involved. Ordinary Note semantics must remain unchanged except for the explicit `Note -> managed Diary` LinkIndex edge suppression. Conservative fail-closed behavior is not authorized merely because an unrelated Diary exists somewhere in the vault.

Reproduction:
1. Create/retain any managed Diary file in the vault.
2. Have ordinary Note `notes/a` with no managed Diary backlink/reference footprint and an unused destination `notes/b`.
3. Invoke AI `rename_file` from `notes/a` to `notes/b` without setting `update_references` (therefore default `true`).
4. `managedDiaryPathsOnDisk().length > 0` causes rejection before `discoverRenameReferenceSnapshot()` can prove the operation is Note-only.

Observable impact:
AI ordinary Note rename/reference update is disabled vault-wide whenever any managed Diary exists, including cases with no managed Diary in the operation footprint. This is a material ordinary-Note regression outside the approved exception.

Why existing tests did not catch it:
The inspected `tools.test.ts` covers normal Note rename/reference behavior in a Note-only vault and managed Diary body access guards, but does not cover the cross-product case: unrelated managed Diary exists + rename footprint is entirely ordinary Notes + `update_references` remains enabled.

Required remediation:
Preserve preflight-before-body-read safety while deriving the actual canonical structural rename/reference footprint first. Reject the operation only when that footprint contains a managed Diary (or when the footprint cannot be safely determined), and preserve Note-only rename behavior when unrelated managed Diaries exist elsewhere in the vault.

### Severity totals

```text
P0 = 0
P1 = 2
P2 = 0
```

## 10. Residual risks

- The full independent command matrix and fresh diagnostics canary were not rerun locally because the review environment could not clone the repository through its network path. Exact-head #592 remains valid CI evidence but is not substituted for claims that require a fresh independent runtime probe.
- The exact #591 failure log could not be retrieved; only job-stage metadata and the stabilization diff were independently verified.
- D8.4 legacy migration/cleanup remains deferred. This review found no reason to pull D8.4 scope into D8.3 remediation.
- The two P1 findings should be remediated independently, followed by exact-head validation and an independent re-review that exercises both original reproductions plus owner-adjacent regressions.

## 11. Verdict

```text
CHANGES REQUIRED
```

Reason:

```text
P0 = 0
P1 = 2
P2 = 0

D8.3 Independent Review = CHANGES REQUIRED (0/2/0)
```

Lifecycle after this review:

```text
D8.3 implementation        = COMPLETE, but not closable
D8.3 Self-review           = PASS (0/0/0) as historical implementation evidence
D8.3 Independent Review    = CHANGES REQUIRED (0/2/0)
D8.3 remediation           = REQUIRED
D8.3 exact-head validation = REQUIRED after remediation
D8.3 Independent Re-review = REQUIRED after remediation
D8.3 closure               = BLOCKED / PENDING
D8.3                       = NOT REVIEW-CLOSED
D8.4                       = NOT STARTED
```
