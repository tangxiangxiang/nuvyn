# D8.3 Independent Re-review

> **Historical lineage — not current runtime authority.** Current behavior is
> defined by [Diary Architecture](../architecture/diary.md) and [Diary User
> Guide](../user-guide/diary.md). This file is retained for D8 review
> traceability.

Status: `PASS`

This document records the independent closure verification for the two findings
raised by the historical D8.3 independent review. It is a new review artifact;
the historical review is intentionally left unchanged.

```text
D8.3 Independent Re-review

P0 = 0
P1 = 0
P2 = 0

Original findings:
D8.3-IR-P1-1 = CLOSED
D8.3-IR-P1-2 = CLOSED

Result = PASS
```

## 1. Scope and decision rule

The review is limited to closure of `D8.3-IR-P1-1` and `D8.3-IR-P1-2`, plus
adjacent regression checks that could reopen either finding. It is not a new
implementation review, a D8.4 review, or a replacement for the historical
review. No production code, tests, or historical review text was modified for
this re-review; the only new artifact is this evidence document.

The re-review passes only when both historical findings are closed and no new
P0, P1, or P2 finding remains.

## 2. Review target and provenance

The reviewed repository state was `main` at:

```text
8e346c776d6f11152e58f0106836f252306aa77a
```

The implementation/remediation target was:

```text
b49b51d5a56608479f0b46086eef739d77308d20
```

The reviewed `8e346c` commit is documentation-only and records the remediation
evidence. The implementation target is an ancestor of the reviewed state, as
is the historical independent-review commit:

```text
50683a4ed46b57a7159ee6c6151f9efd26809d9c  (historical independent review)
b49b51d5a56608479f0b46086eef739d77308d20  (implementation/remediation)
8e346c776d6f11152e58f0106836f252306aa77a  (review target)
```

The implementation diff from `50683a4` to `b49b51d` is exactly six files:

```text
server/atomicTextWrite.ts
server/routes/diary.ts
server/ai/tools.ts
server/__tests__/atomicTextWrite.test.ts
server/__tests__/diary-routes.test.ts
server/__tests__/tools.test.ts
```

The historical review file in the repository is byte-identical to the supplied
review artifact (`cmp` exit 0; SHA-256
`564b50272d7f4f03f89df5b72614457c30f27af269abfd92822622972c5b0688`). No
historical finding or wording was rewritten.

## 3. Finding D8.3-IR-P1-1 — managed Diary delete owner bypass

### Original finding

The original review identified a caller-controlled `allowManagedDiary` escape
in the generic durable-delete owner. A caller could therefore appear to opt
the generic owner into deleting a managed Diary generation, outside the
Diary-specific transaction boundary.

### Remediation verified

`server/atomicTextWrite.ts` now exposes the generic owner as:

```ts
atomicRemoveTextIfUnchanged(targetPath, expectedRaw)
```

The owner has no `allowManagedDiary` option and rejects every managed Diary
target before entering the ordinary removal path with
`ManagedDiaryDeleteUnsupportedError`. The old JavaScript-shaped third argument
was also exercised directly; it is ignored by the current two-argument API and
the managed target remains rejected with its bytes unchanged.

Managed Diary delete is consequently not enabled by a route-level convention.
The generic post-create/recovery callers, history restore path, and AI delete
dispatcher were inspected; they do not pass an override. Their managed-target
guards remain in place. The Diary route uses the separate, closure-bound
`rollbackCreatedGenerationIfStillOwned()` capability returned by its create
transaction, rather than the generic delete owner.

### Transaction and ownership checks

The closure capability is created only after a create-only `fs.link` succeeds.
It records the committed file and parent identity, is one-shot, and can remove
only that exact committed generation. A pre-existing managed target causes the
create link to fail with `EEXIST`; the rollback capability then returns `null`
and the existing envelope bytes remain untouched. If another writer replaces a
path after commit, the ownership check raises
`AtomicTextWriteOwnershipError` and preserves the replacement generation.

The direct probes produced:

```text
first={"removed":true,"restored":false,"externalMutationDetected":false,"quarantined":false}
second=null
exists=false

commit="EEXIST"
rollback=null
bytes="NUVYN-DIARY-ENC-V1\\nexisting"
temps=[]
```

### Closure decision

**Is there any caller that can delete an existing legitimate managed Diary
through the generic durable owner without a real committed create transaction?**

`NO`.

`D8.3-IR-P1-1 = CLOSED`.

## 4. Finding D8.3-IR-P1-2 — AI ordinary Note rename blocked by vault-wide Diary existence

### Original finding

The original review identified a vault-wide `managedDiaryPathsOnDisk().length >
0` check in the AI rename path. An unrelated managed Diary could therefore
block an otherwise ordinary Note-only rename, even when the rename had no
Diary footprint.

### Remediation verified

`server/ai/tools.ts` no longer performs a vault-wide Diary-existence check.
`discoverRenameReferenceSnapshot` is structural-only: it obtains LinkIndex
paths and backlinks without reading Diary bodies. `executeGuardedRename`
rejects managed source and destination paths, computes the discovered structural
footprint, checks any actual managed footprint before `buildRenamePlan` can
read a body, and re-discovers under the complete lock set. Drift in that
footprint fails closed. The candidate plan produced under the lock is the same
plan passed to the dispatcher.

`executeRenameFile` consumes only the passed `RenamePlan.references`; it does
not independently discover backlinks or rewrite a managed Diary body.

### LinkIndex interaction

D8.3 intentionally suppresses Diary body-derived projections. LinkIndex skips
managed Diary body parsing during cold rebuild, returns no backlinks for a
managed target or managed source, and purges managed state from snapshots.
Therefore a suppressed `Note -> Diary` edge is absent from both the guarded
rename plan and the executor's writes. It cannot be converted into an unsafe
managed-body rewrite. Ordinary Note-to-Note projections remain available.

### Closure decisions

**Can an unrelated managed Diary block an otherwise Note-only AI rename?**

`NO`.

**Can a rename with an actual managed-Diary footprint proceed into managed body
read/rewrite?**

`NO`.

`D8.3-IR-P1-2 = CLOSED`.

## 5. Adjacent regression audit

| Surface | Verification | Result |
| --- | --- | --- |
| Generic atomic delete | Managed target rejected; ordinary Note removal and external-writer cleanup remain covered | PASS |
| Diary create failure | Post-commit failure returns 500, leaves no metadata, and removes only the created generation | PASS |
| Existing target/path reuse | `EEXIST` and ownership mismatch preserve the external generation | PASS |
| AI Note rename with unrelated Diary | Rename succeeds; Diary body is not read or changed | PASS |
| AI rename with protected footprint | Locked access returns the Diary-locked error; accessible access returns encrypted-reference unsupported; no body read or mutation | PASS |
| Rename races | Before-execute added backlink is not rewritten; pre-lock/in-lock footprint drift fails closed without extending the lock set | PASS |
| `update_references=false` | Empty reference footprint and protected-backlink behavior remain explicit | PASS |
| LinkIndex | Envelope is not parsed; Note-to-Diary is suppressed; Note-to-Note remains projected | PASS |

## 6. Validation performed

Focused closure suites:

```text
npx vitest run server/__tests__/atomicTextWrite.test.ts \\
  server/__tests__/diary-routes.test.ts server/__tests__/tools.test.ts
  3 files passed, 166 tests passed

npx vitest run server/__tests__/linkIndex.test.ts \\
  server/__tests__/renameReferences.test.ts server/__tests__/ai-routes.test.ts
  3 files passed, 103 tests passed
```

Broader checks:

```text
npm run typecheck
  PASS

npm run build
  PASS (existing Rolldown invalid-annotation and chunk-size warnings only)

npm run test:history-integration
  PASS (5 files, 175 tests)
```

Two local lanes were exercised but are recorded as environment-limited rather
than falsely marked green:

* `npm run test:recovery-integration`: 5 files, 4 passed; 161 tests passed and
  35 failed because the restricted sandbox denied the `tsx` child IPC pipe
  listener (`listen EPERM`). The service-restart probe exits for the same
  reason.
* `npm run test:unit`: 242 files, 239 passed; 3,587 tests passed, 21 failed,
  and 9 skipped. The 21 failures are environment-only: 19 OpenAI HTTP tests
  cannot listen on `127.0.0.1`, and two `tsx` subprocess closure tests hit the
  same IPC `listen EPERM` restriction. No changed-area assertion failed.

No local E2E result was substituted for the restricted lanes. `git diff --check`
passed.

## 7. Exact-head CI evidence

The implementation/remediation target was verified by GitHub Actions run
`#594` (run ID `33378116031`), at exact HEAD
`b49b51d5a56608479f0b46086eef739d77308d20`:

<https://github.com/tangxiangxiang/nuvyn/actions/runs/33378116031>

Status was `completed / success`, with all 8 jobs successful:

```text
verify (ubuntu-latest, 22)   PASS
verify (ubuntu-latest, 24)   PASS
verify (macos-latest, 24)    PASS
verify (windows-latest, 24)  PASS
auth-browser                 PASS
tags-scale                   PASS
visual                       PASS
docker-smoke                 PASS
```

The four verify jobs actually ran typecheck, build, the complete unit and
integration suite, cross-platform browser E2E, and Draft Store browser E2E.
The specialized jobs ran authentication browser smoke, Tags scale evidence,
macOS visual baselines, production-image build, and packaged authentication
smoke. Thus the exact implementation head has full CI coverage for the
changed-area contract; the local IPC limitations above are not being presented
as local test success.

The prior documentation-only evidence-sync run was `#595` (run ID
`33380286438`), also `completed / success` with 8/8 jobs:

<https://github.com/tangxiangxiang/nuvyn/actions/runs/33380286438>

That run is recorded separately and is not used as a substitute for the exact
implementation-head run.

## 8. Evidence classification

| Claim | Evidence class |
| --- | --- |
| Generic durable delete has no managed-Diary override | Proven by current source, caller search, and focused tests |
| Rollback is closure-bound to the Diary create transaction | Proven by current source and Diary route tests |
| Rollback is one-shot and generation-specific | Proven by source and direct probes/tests |
| Path reuse preserves an external generation | Proven by source, direct probe, and focused tests |
| Vault-wide AI rename Diary check is removed | Proven by current source and focused tests |
| Structural footprint controls the guarded rename | Proven by source, race tests, and focused tests |
| Managed footprint is rejected before body read/rewrite | Proven by source and locked/accessible footprint tests |
| Guarded two-phase plan is the executor input | Proven by current source and race tests |
| Remediation implementation head passed exact-head CI | Proven by GitHub Actions run #594 |
| Broader local recovery/unit behavior | Partially proven: exercised, but sandbox IPC/listener restrictions prevented the affected subprocess/network assertions |

No claim in this re-review depends on the environment-limited local failures.

## 9. New-finding audit

No new P0, P1, or P2 finding was identified. In particular, the re-review did
not find a remaining caller-controlled managed-delete escape, a vault-wide
Diary blocker for Note-only rename, a new managed-body read/rewrite path, or a
regression that would require widening the lock set. The evidence claims above
are deliberately classified so the restricted local lanes are not overstated.

```text
New P0 = 0
New P1 = 0
New P2 = 0
```

## 10. Lifecycle state

```text
D8.3 implementation          = COMPLETE
D8.3 Self-review             = PASS (historical)
D8.3 Independent Review      = CHANGES REQUIRED (0/2/0) [historical]
D8.3 remediation             = COMPLETE
D8.3 Independent Re-review   = PASS (0/0/0)
D8.3 closure                 = PENDING
D8.3                         = REVIEW-READY / closure pending
D8.4                         = NOT STARTED
```

This PASS does not by itself mark D8.3 `REVIEW-CLOSED`. A separate, docs-only
lifecycle-closure commit must record the closure decision after this re-review.
