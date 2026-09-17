# D8.4 Independent Planning Re-review

> **Historical lineage — not current runtime authority.** Current behavior is
> defined by [Diary Architecture](../architecture/diary.md) and [Diary User
> Guide](../user-guide/diary.md). This file is retained for D8 review
> traceability.

## 1. Verdict

```text
D8.4 Independent Planning Re-review = CHANGES REQUIRED (0/1/1)

Historical findings still OPEN:
- D8.4-IPR-P1-2
- D8.4-IPR-P2-3

New P0 = 0
New P1 = 0
New P2 = 0
```

This is a planning-only re-review. It does not implement or remediate D8.4, it does not rewrite the immutable historical review, and it does not approve implementation merely because the remediation describes the intended safe outcome.

Six historical findings are closed by the remediated planning contract. Two are not. The remaining P1 is implementation-critical: the plan still does not freeze a concrete/restart-safe primitive that proves the destructive source transition mutates the exact captured plaintext generation rather than a replacement. The remaining P2 is evidence-critical: the deterministic crash-hook oracle still omits semantically distinct durability/disposition boundaries required to prove quarantine removal and AI disposition.

Because any historical P1/P2 remains open:

```text
D8.4 Planning = NOT APPROVED
D8.4 implementation = BLOCKED / NOT STARTED
D8.4 = NOT REVIEW-CLOSED
```

## 2. Review target and provenance

The repository was independently re-queried before this record was created.

| Item | Verified value |
| --- | --- |
| Repository | `tangxiangxiang/nuvyn` |
| Branch | `main` |
| Review starting HEAD | `4c90b46c1bdb37626530fc63529bf3903a6f151d` |
| Immediate parent | `9ae44929765662a62905279ade2351bacf381e5c` |
| Historical initial D8.4 planning | `cbd5424ebe82737604b621a1be58f1c1b965e5f0` |
| Historical independent planning review | `9f8d06d1f0dd2223dfc2ccc3d313f4a30053c386` |
| Planning remediation authority | `9ae44929765662a62905279ade2351bacf381e5c` |
| Calendar baseline remediation | `4c90b46c1bdb37626530fc63529bf3903a6f151d` |

The commit relationship is linear:

```text
cbd5424  docs(diary): plan D8.4 migration and release closure
  -> 9f8d06d  docs(diary): independently review D8.4 planning
  -> 9ae4492  docs(diary): remediate D8.4 planning review
  -> 4c90b46  test(e2e): make calendar date baseline deterministic
```

The `9f8d06d..9ae4492` comparison contains only:

```text
docs/design/diary-encryption-d8.4-implementation-plan.md
docs/design/diary-encryption-d8.4-migration-release-prd.md
docs/design/diary-encryption-d8.4-planning-remediation-evidence.md
docs/design/diary-encryption-implementation-plan.md
```

Therefore the Planning Remediation did not silently implement D8.4.

The `9ae4492..4c90b46` comparison is one commit and changes only `e2e/**`, including the Calendar clock helper and Calendar-dependent browser fixtures/specs. No production source, planning authority, schema, dependency, workflow, migration owner, or security boundary changed after the Planning Remediation.

Repository search at the starting HEAD found no current implementation of `DiaryMigration`, `RECOVERY_AUTH_REQUIRED`, or `inventoryRevision` in production source. The reviewed lifecycle is therefore still:

```text
D8.4 implementation = NOT STARTED
```

## 3. Independence / methodology

The historical remediation evidence was treated as a claim source, not as proof. For each historical finding this re-review used the following chain:

```text
historical defect
-> exact invariant
-> remediated PRD / implementation-plan contract
-> current source-owner compatibility
-> adversarial trace
-> future executable proof
-> CLOSED or OPEN
```

The source audit included the existing Diary access/body owner, process/vault ownership, process-local mutation/document locks, safe-path and generic atomic writers, primary routes, metadata/frontmatter owners, all current SQLite migrations, AI durable history/tool envelopes, Draft/Recovery store ownership, tree/list behavior, and the D8.3 independent closure state.

The canonical D8 lifecycle authority, D8.0 architecture record, D8.1 session foundation, D8.2 encrypted body record, D8.3 privacy authority/review chain, both D8.4 planning authorities, the immutable historical D8.4 review, and the remediation evidence were reviewed as the authority set. The historical review remains `CHANGES REQUIRED (0/5/3)` and is not rewritten by this document.

One execution limitation applies to command provenance: this review was performed against the connected GitHub repository rather than a model-owned local checkout, so GitHub branch/commit/compare/file/workflow APIs were used as the read/write authority instead of fabricating local `git status` output. The review record itself could not be committed because the integration denied repository writes.

## 4. Baseline and CI verification

The supplied Calendar-baseline run was independently verified:

```text
Workflow:   CI
Run number: 601
Run ID:     33424959591
Attempt:    2
HEAD:       4c90b46c1bdb37626530fc63529bf3903a6f151d
Event:      push
Status:     completed
Conclusion: success
```

Attempt 2 has eight successful jobs:

```text
verify (ubuntu-latest, 22)   success
verify (ubuntu-latest, 24)   success
verify (macos-latest, 24)    success
verify (windows-latest, 24)  success
auth-browser                 success
tags-scale                   success
visual                       success
docker-smoke                 success
```

Attempt 1 was also independently inspected rather than erased. It concluded `failure`; the failing job was `verify (macos-latest, 24)`, and within that job typecheck, build, the complete unit/integration suite, and the cross-platform browser E2E all passed. The failure occurred specifically in `Run Draft Store browser E2E`. That is consistent with classifying attempt 1 as a macOS Draft Store lane failure after Calendar coverage, not a Calendar semantic failure.

This CI is baseline evidence only. It does not prove any unimplemented D8.4 migration behavior.

## 5. Historical finding closure matrix

| Finding | Historical severity | Re-review status | Evidence | Result |
| --- | --- | --- | --- | --- |
| D8.4-IPR-P1-1 | P1 | CLOSED | `RECOVERY_AUTH_REQUIRED`; structural-only locked startup; post-unlock exact target/generation/fingerprint revalidation through the existing body lease and D8.2 AES-GCM/AAD owner | The original publish/crash/locked-startup forged-V1 trace can no longer advance to `PUBLISHED` or cleanup without cryptographic authentication. |
| D8.4-IPR-P1-2 | P1 | OPEN | `DiaryMigrationFs` freezes intended semantics, but the source-transition primitive is still described as a future handle-/directory-relative native helper without a concrete atomic captured-generation mutation contract; the live ownership token is non-durable although restart recovery requires exact quarantine ownership | Implementation must still invent a security-sensitive source ownership primitive and restart token/reacquisition rule. |
| D8.4-IPR-P1-3 | P1 | CLOSED | immutable `inventoryRevision`, server-created action-specific consent, reviewed item-set fingerprint, exact generation/row revalidation, rescan creates a new revision | R1 consent cannot authorize a new/changed R2 primary, Draft family, SQLite row, AI session, or frontmatter row. |
| D8.4-IPR-P1-4 | P1 | CLOSED | current AI history persists structured tool envelopes with tool name/input/result; plan classifies only authoritative structured managed-Diary `read_file` provenance, requires unlock, and freezes whole-session discard/retention | Free-text resemblance is not deletion authority; mixed sessions are never substring-edited; Nuvyn-controlled retained AI history remains disclosed. |
| D8.4-IPR-P1-5 | P1 | CLOSED | `NULL document_id` remains unresolved; binding is separate/non-destructive/exact-CAS; cleanup requires non-null exact identity, authenticated publication and no rollback dependency | Path reuse or metadata recreation cannot turn a null-ID legacy backup into path-only delete authority. |
| D8.4-IPR-P2-1 | P2 | CLOSED | proposed generation records omit plaintext size/hash; only transient authorized byte count is permitted; ciphertext fingerprint is separately classified and hidden from locked/status surfaces | D8.4 no longer durably records managed plaintext body length. |
| D8.4-IPR-P2-2 | P2 | CLOSED | ordinary managed PUT queues behind existing `withDocumentWriteLock`, then revalidates access/CAS/current state; migration-only 409 is not promised for an ordinary queued PUT | Planning now matches the actual FIFO owner and does not invent a try-lock. |
| D8.4-IPR-P2-3 | P2 | OPEN | exact hook enum/process-kill harness exists, but the hook/oracle set still collapses quarantine unlink and removal durability and does not explicitly map AI whole-session disposition to a named hook/oracle | There are still semantically distinct crash points for which the reviewer cannot write an exact kill/restart/observe/resume oracle without implementation-time choice. |

## 6. D8.4-IPR-P1-1 re-review

The original defect was a locked restart after ciphertext publication: structural V1 parsing is not AES-GCM/AAD authentication. The remediation now freezes `RECOVERY_AUTH_REQUIRED`, keeps startup structural-only while locked, blocks cleanup and plaintext restore, preserves target/quarantine generations, and requires post-unlock exact target path/generation/fingerprint revalidation through the existing `DiaryBodyOperation`. Auth failure, syntactically forged V1, target replacement or session invalidation remains attention. `D8.4-IPR-P1-1 = CLOSED`.

## 7. D8.4-IPR-P1-2 re-review

### Finding ID / severity / title

```text
D8.4-IPR-P1-2
Severity: P1
Status: OPEN
Title: Cross-platform exact-source ownership is still not frozen to an executable, restart-safe primitive
```

The remediation correctly forbids path-only check/use authority, copy/delete fallback and overwrite publication, and it names target-side no-replace primitives. But the destructive **source transition** still stops at a future “handle-/directory-relative native helper.” Linux/macOS planning does not freeze the actual atomic condition that makes the directory mutation apply only to the captured source generation rather than a replacement. Directory-relative pathname rename plus prior handle verification is not, by itself, that atomic conditional mutation.

There is also a restart ownership gap. The live helper token is explicitly process-memory-only, but crash recovery is required to restore/remove only the exact owned quarantine generation and defeat quarantine-name reuse. The plan does not freeze how a new process re-establishes destructive authority after that token is gone, nor when such recapture must fail closed.

Current owners do not supply the missing primitive: `server/paths.ts` is a safe-read/revalidation helper; `server/atomicTextWrite.ts` is a generic Note-oriented pathname/link/rename owner; JS locks are process-local; `vaultWriterOwnership` excludes cooperating Nuvyn writers but not arbitrary external writers.

Required planning remediation is to freeze the exact source-side native semantic per OS/filesystem, its failure behavior, and the restart re-acquisition/attention rule for quarantine ownership. `D8.4-IPR-P1-2 = OPEN`.

## 8. D8.4-IPR-P1-3 re-review

Immutable inventory revisions plus server-created action-specific consent now bind destructive authority to the exact reviewed item/generation/row/action. Rescan creates R2 without mutating R1; new or changed primaries, Draft families, SQLite rows, AI sessions and frontmatter rows cannot inherit old consent. `D8.4-IPR-P1-3 = CLOSED`.

## 9. D8.4-IPR-P1-4 re-review

Current AI persistence provides structured tool envelopes with tool name/input/result provenance. The plan requires exact structured `read_file` provenance to a canonical managed Diary path, authorized unlock for content inspection, whole-session discard or explicit retention, no substring surgery and no ledger copy of message content. Arbitrary text that merely resembles a Diary path remains ordinary AI history. `D8.4-IPR-P1-4 = CLOSED`.

## 10. D8.4-IPR-P1-5 re-review

A null `metadata_migrations.document_id` remains unresolved and never becomes path-only cleanup authority. Binding is separate, non-destructive and exact-CAS; cleanup later requires exact non-null identity, authenticated publication, no rollback dependency and unchanged row state. `D8.4-IPR-P1-5 = CLOSED`.

## 11. D8.4-IPR-P2-1 re-review

The proposed ledger no longer persists legacy body length or plaintext digest. Byte count is transient only; the internal ciphertext fingerprint is classified as encrypted-artifact provenance and is not a locked-visible plaintext-derived projection. `D8.4-IPR-P2-1 = CLOSED`.

## 12. D8.4-IPR-P2-2 re-review

The plan now matches the real FIFO document lock: ordinary managed PUT waits, then revalidates session/CAS/current primary state. A migration-specific 409 is reserved for competing migration-control ownership, not ordinary lock wait. `D8.4-IPR-P2-2 = CLOSED`.

## 13. D8.4-IPR-P2-3 re-review

### Finding ID / severity / title

```text
D8.4-IPR-P2-3
Severity: P2
Status: OPEN
Title: Deterministic crash oracle still omits distinct durability/disposition boundaries
```

The remediation now has a real enum, parent/child kill harness, no-sleep rule and detailed oracle table. Two distinct evidence gaps remain.

First, quarantine unlink and quarantine-removal directory durability are distinct crash boundaries. The enum only has `BEFORE_SOURCE_QUARANTINE_REMOVE` and `AFTER_SOURCE_QUARANTINE_REMOVE`, without freezing whether the latter is before or after the parent-directory durability barrier and without the complementary seam. A crash after unlink but before directory durability therefore lacks one exact restart oracle.

Second, AI whole-session deletion is a separately consented destructive SQLite action, but the hook enum does not explicitly map `BEFORE_SQLITE_CLEANUP_COMMIT` / `AFTER_SQLITE_CLEANUP_COMMIT` to `DISCARD_AI_SESSION`, nor give exact `sessions`/`messages`/consent observations for both sides. “AI crash/retry/idempotency will be tested” is not yet an executable named seam.

Required remediation: split or explicitly place quarantine removal vs directory durability hooks/oracles, and explicitly map AI session disposition to named SQLite hooks (or add AI-specific before/after hooks) with exact persisted-state restart expectations. `D8.4-IPR-P2-3 = OPEN`.

## 14. New-finding audit

No additional P0/P1/P2 finding is opened beyond the two still-open historical findings.

```text
New P0 = 0
New P1 = 0
New P2 = 0
```

The audit also checked D8.2 crypto/session authority, D8.3 privacy exclusions, legacy primary states, Git retain/disclose policy, Draft/Recovery exact-family ownership, all current migrations `0001`–`0011`, ledger privacy, reserved artifacts, process/cross-process concurrency and completion semantics.

## 15. D8.0–D8.3 contract preservation

```text
D8.0 = REVIEW-CLOSED
D8.1 = REVIEW-CLOSED
D8.2 = REVIEW-CLOSED
D8.3 = REVIEW-CLOSED
D8.0-D8.3 contract preservation = PASS
```

D8.4 does not create a second key/session/body owner, does not reopen managed-Diary History/Draft/Search/LinkIndex privacy surfaces, and does not change ordinary Note behavior in planning.

## 16. D8.4 implementation-readiness assessment

D8.4 is not implementation-ready. P1-2 still requires a security-sensitive native ownership/restart design choice, and P2-3 still requires evidence-critical crash-seam choices. These decisions must be frozen in planning rather than delegated to implementation.

## 17. Lifecycle decision

```text
D8.0 = REVIEW-CLOSED
D8.1 = REVIEW-CLOSED
D8.2 = REVIEW-CLOSED
D8.3 = REVIEW-CLOSED

D8.4 Planning = NOT APPROVED
D8.4 Independent Planning Review =
  CHANGES REQUIRED (0/5/3) [historical]
D8.4 Planning Remediation = COMPLETE AS A DOCS CHANGE, BUT INSUFFICIENT FOR APPROVAL
D8.4 Independent Planning Re-review = CHANGES REQUIRED (0/1/1)

D8.4 implementation = BLOCKED / NOT STARTED
D8.4 = NOT REVIEW-CLOSED
```

## 18. Evidence / commands executed

GitHub-backed equivalents were used for branch/HEAD/parent verification, commit provenance, compare ranges, authority/source reads, migration-directory enumeration and CI attempt/job inspection. Baseline exact-head CI `33424959591` attempt 2 was verified as 8/8 success; attempt 1 was preserved as a macOS Draft Store browser failure.

## 19. Limitations

- No D8.4 runtime implementation exists, so no implementation behavior is claimed.
- Baseline CI is repository-health evidence only.
- The connected GitHub repository was the authoritative read surface. There was no separate model-owned local checkout, so local `git status`/`git diff --check` output was not fabricated.
- The GitHub integration denied repository writes with HTTP 403 when this re-review document was submitted to `main`. Therefore no review commit, push state, or re-review-head CI exists from this execution. The document is complete and preserved as a local artifact for manual commit or a later write-enabled connection.

Final planning decision:

```text
CHANGES REQUIRED
```
