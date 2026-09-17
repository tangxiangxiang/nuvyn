# D8.3 Independent Review Remediation Evidence

> **Historical lineage — not current runtime authority.** Current behavior is
> defined by [Diary Architecture](../architecture/diary.md) and [Diary User
> Guide](../user-guide/diary.md). This file is retained for D8 review
> traceability.

Status: `Remediation implemented; finding closure pending Independent Re-review.`

This record documents the narrow remediation of `D8.3-IR-P1-1` and
`D8.3-IR-P1-2`. It is not an Independent Re-review and does not change the
historical review verdict.

## Lifecycle and immutable review evidence

```text
D8.3 implementation           = COMPLETE
D8.3 Independent Review       = CHANGES REQUIRED (0/2/0) [historical]
D8.3 remediation              = COMPLETE (implementation + exact-head CI)
D8.3 remediation self-review  = PASS
D8.3 Independent Re-review    = PENDING
D8.3 closure                  = BLOCKED / PENDING
D8.4                          = NOT STARTED
```

The frozen review document is
`docs/design/diary-encryption-d8.3-independent-review.md`. It was recorded
unchanged in review-evidence commit `50683a4` (`docs(diary): record D8.3
independent review`). Its verdict remains `D8.3 Independent Review = CHANGES
REQUIRED (0/2/0)` and it still contains both findings. No section in that
historical document has been edited to claim PASS or CLOSED.
The repository copy and the supplied review artifact are byte-identical
(`sha256=564b50272d7f4f03f89df5b72614457c30f27af269abfd92822622972c5b0688`).

The remediation started from review-evidence HEAD:

```text
starting remediation HEAD: 50683a4ed46b57a7159ee6c6151f9efd26809d9c
historical Independent Review commit: 50683a4ed46b57a7159ee6c6151f9efd26809d9c
implementation commit: b49b51d5a56608479f0b46086eef739d77308d20
```

## Findings addressed

### D8.3-IR-P1-1 — caller-controlled managed-Diary delete override

The finding identified a caller-controlled `allowManagedDiary` escape hatch in
the durable `atomicRemoveTextIfUnchanged` owner. The remediation changed the
owner contract as follows:

- The exported generic `atomicRemoveTextIfUnchanged(targetPath, expectedRaw)`
  has no override argument and always rejects a managed Diary target with
  `ManagedDiaryDeleteUnsupportedError`.
- The create owner retains a closure-bound
  `rollbackCreatedGenerationIfStillOwned()` capability only after its real
  create-only `fs.link` succeeds. The capability captures the committed target
  path, file identity, parent identity, and encrypted raw for that one create
  transaction, and is one-shot.
- Rollback revalidates the exact generation before staging/removing it. A
  pre-existing Diary generation, a caller-constructed token, or a path/raw pair
  cannot acquire this deletion authority.
- `server/routes/diary.ts` uses that capability only while unwinding a failed
  create; if no physical generation was committed it falls back to temporary
  file cleanup. Public managed delete behavior remains unsupported.

The negative reproduction is covered by the owner tests: a legitimate managed
Diary plus its current encrypted bytes passed to the generic owner is rejected,
including a JavaScript caller that supplies the removed third argument. The
file and bytes remain unchanged. Ordinary Note atomic removal continues to use
the existing generic path.

The intended rollback proof forces a failure after the managed create has
committed its encrypted generation. The Diary route returns the failure, the
metadata snapshot is restored, and the final file is absent. A path-reuse test
replaces that generation with an external generation; rollback raises the
existing ownership error and preserves the replacement rather than deleting
it. No plaintext staging is introduced.

### D8.3-IR-P1-2 — vault-wide false positive for ordinary Note AI rename

The finding identified a `managedDiaryPathsOnDisk().length > 0` guard that
blocked every ordinary Note rename whenever any Diary existed in the vault.
The remediation removed that vault-wide decision and keeps authorization tied
to the actual structural reference footprint:

- Pre-lock and in-lock discovery use the structural LinkIndex snapshot only;
  managed Diary bodies are not read to decide whether a Note rename is safe.
- The canonical `sourcePaths` footprint is checked for managed Diary identity.
  If the footprint contains one, the operation fails closed before body read,
  reference rewrite, journal, or filesystem mutation.
- The existing two-phase safety protocol is preserved: pre-lock discovery,
  complete lock set, in-lock re-discovery, footprint drift comparison, guard,
  and execution of that same guarded plan.

Focused tests prove both sides of the contract. With an unrelated encrypted
Diary elsewhere in the vault, an ordinary Note rename with default
`update_references=true` succeeds, ordinary Note references are handled, and
the Diary is neither read nor changed. With a structural backlink footprint
that includes a managed Diary, the rename fails closed before managed body
access or mutation. The `update_references=false` and ordinary Note-to-Note
regressions remain covered, as does the existing footprint-drift race guard.

## Files changed in the implementation commit

`b49b51d5a56608479f0b46086eef739d77308d20` changes exactly these six files:

```text
server/atomicTextWrite.ts
server/routes/diary.ts
server/ai/tools.ts
server/__tests__/atomicTextWrite.test.ts
server/__tests__/diary-routes.test.ts
server/__tests__/tools.test.ts
```

No D8.2 crypto, envelope, DEK/session ownership, Draft/Recovery policy,
Search/LinkIndex privacy policy, public managed delete/rename policy, metadata
privacy policy, PDF/clipboard policy, or D8.4 migration behavior was changed.

## Validation evidence

Focused remediation suites:

```text
npx vitest run server/__tests__/atomicTextWrite.test.ts \
  server/__tests__/diary-routes.test.ts server/__tests__/tools.test.ts
  3 files passed, 166 tests passed

npx vitest run server/__tests__/linkIndex.test.ts \
  server/__tests__/renameReferences.test.ts server/__tests__/ai-routes.test.ts
  3 files passed, 103 tests passed

npm run typecheck
  passed

npm run build
  passed (existing Rolldown annotation/chunk-size warnings only)

git diff --check
  passed
```

Transitive lifecycle evidence:

```text
npm run test:history-integration
  5 files passed, 175 tests passed

npm run test:unit
  239 files passed, 3,587 tests passed, 9 skipped
  3 files / 21 tests failed only because the restricted local sandbox rejects
  localhost/tsx IPC listeners with listen EPERM; no changed-area assertion
  failed. The affected suites are openai-http and folder move/recovery
  subprocess tests.

npm run test:recovery-integration
  could not execute its subprocess crash/recovery assertions in this
  restricted sandbox: tsx child IPC startup failed with listen EPERM on the
  temporary pipe. This is recorded as an environment limitation, not a pass.
```

## Exact-head CI

The remediation implementation was pushed to `main` at the exact
implementation HEAD below. The required CI matrix is run `#594` / run ID
`33378116031`, attempt 1:

```text
HEAD: b49b51d5a56608479f0b46086eef739d77308d20
Ubuntu Node 22: PASS
Ubuntu Node 24: PASS
macOS Node 24: PASS
Windows Node 24: PASS
auth-browser: PASS
tags-scale: PASS
visual: PASS
docker-smoke: PASS
Result: 8/8 PASS
```

CI URL: https://github.com/tangxiangxiang/nuvyn/actions/runs/33378116031

The subsequent evidence-sync commit is docs-only and does not replace the
implementation checkpoint validated by this exact-head run.

## Self-review conclusion

The fresh remediation diff review found no P0/P1/P2 issue beyond the two
specified historical findings. In particular, there is no generic managed
delete bypass, no forgeable provenance token, no path-only or raw-only rollback
authority, no body read before the managed-reference guard, no lock-set drift,
and no vault-wide unrelated-Diary Note-rename block.

This is remediation evidence only. `D8.3-IR-P1-1` and `D8.3-IR-P1-2` remain
historical findings awaiting an Independent Re-review.

## Final D8.3 closure

The remediation checkpoint above remains historical evidence and is not
rewritten. This appended section records the subsequent independent
re-review and docs-only lifecycle closure.

```text
D8.3 Independent Review       = CHANGES REQUIRED (0/2/0) [historical]
D8.3 remediation               = COMPLETE
D8.3 Independent Re-review     = PASS (0/0/0)
D8.3-IR-P1-1                  = CLOSED
D8.3-IR-P1-2                  = CLOSED
Re-review evidence             = 1a8ef24ce32a7f7185ef8de25897680ca6b17c20
Re-review evidence CI          = #596 / 33388268886 / attempt 1 / 8/8 PASS
D8.3                          = REVIEW-CLOSED
D8.4                          = NOT STARTED
```

D8.3 is `REVIEW-CLOSED`. The original Independent Review remains the separate
historical `CHANGES REQUIRED (0/2/0)` event; the two findings were remediated
at `b49b51d` and independently re-reviewed as closed with no new P0/P1/P2
findings. This closure does not restore intentionally disabled D8.3 surfaces
or imply legacy cleanup. Legacy plaintext, Git/history, IndexedDB,
SQLite/private-metadata and mixed-state migration responsibilities remain
D8.4 scope. This docs-only closure changes no production code, tests,
dependencies, CI configuration, or security contract.
