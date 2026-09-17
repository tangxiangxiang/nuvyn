# D8.4 Independent Planning Re-review Round 2

> **Historical lineage — not current runtime authority.** Current behavior is
> defined by [Diary Architecture](../architecture/diary.md) and [Diary User
> Guide](../user-guide/diary.md). This file is retained for D8 review
> traceability.

## 1. Verdict

```text
D8.4 Independent Planning Re-review Round 2
= CHANGES REQUIRED (0/1/0)

D8.4-IPR-P1-2 = OPEN
D8.4-IPR-P2-3 = CLOSED

Previously closed findings remain CLOSED:
D8.4-IPR-P1-1
D8.4-IPR-P1-3
D8.4-IPR-P1-4
D8.4-IPR-P1-5
D8.4-IPR-P2-1
D8.4-IPR-P2-2

New P0 = 0
New P1 = 0
New P2 = 0
```

This is a planning-only independent re-review. It does not implement or remediate D8.4, does not edit either historical independent review, and does not change the reviewed PRD or Implementation Plan.

Round 2 successfully closes the remaining deterministic crash-oracle finding. It does **not** close exact-source ownership. The Round-2 planning text is precise about the semantics it wants, but the mandatory Linux and macOS source-transition/removal ABIs it names are not backed by corresponding supported stock operating-system namespace-mutation primitives. On those platforms the documented public rename/unlink interfaces still identify the source by a directory fd plus a pathname. A native C/Rust addon can wrap those interfaces, but cannot manufacture a kernel atomicity condition the kernel does not expose.

The Linux restart path is additionally incompatible with Nuvyn's current default production deployment: `open_by_handle_at(2)` requires `CAP_DAC_READ_SEARCH`, while the shipped Docker runtime runs as non-root UID 1000 with `no-new-privileges:true` and does not add that capability.

Therefore:

```text
D8.4 Planning = NOT APPROVED
D8.4 implementation = BLOCKED / NOT STARTED
D8.4 = NOT REVIEW-CLOSED
```

## 2. Review target / provenance

```text
Repository: tangxiangxiang/nuvyn
Branch:     main
HEAD:       250aeec9036dd69aa9538ccf57373b4cb6d0d41f
Commit:     docs(diary): remediate D8.4 planning re-review
Parent:     1be58a317c121a5fd676cd709174de7fbb6b72b7
```

Immutable lineage:

```text
cbd5424  Initial D8.4 Planning
  -> 9f8d06d  Independent Planning Review
               CHANGES REQUIRED (0/5/3)
  -> 9ae4492  Planning Remediation Round 1
  -> 4c90b46  Calendar E2E baseline maintenance only
  -> 1be58a3  Independent Planning Re-review
               CHANGES REQUIRED (0/1/1)
  -> 250aeec  Planning Remediation Round 2
```

The exact `1be58a3..250aeec` comparison is one commit and modifies only:

```text
docs/design/diary-encryption-d8.4-implementation-plan.md
docs/design/diary-encryption-d8.4-migration-release-prd.md
docs/design/diary-encryption-d8.4-planning-remediation-evidence.md
docs/design/diary-encryption-implementation-plan.md
```

No production source, tests, schemas, dependencies, workflow, or runtime implementation are part of Round 2. The canonical lifecycle remains `D8.4 implementation = BLOCKED / NOT STARTED`.

## 3. Baseline CI

```text
Workflow:   CI
Run number: 603
Run ID:     33457485616
Attempt:    1
HEAD:       250aeec9036dd69aa9538ccf57373b4cb6d0d41f
Status:     completed
Conclusion: success
Result:     8/8 PASS
```

Successful jobs:

```text
verify (ubuntu-latest, 22)
verify (ubuntu-latest, 24)
verify (macos-latest, 24)
verify (windows-latest, 24)
auth-browser
tags-scale
visual
docker-smoke
```

This establishes repository health only, not future D8.4 filesystem correctness.

## 4. Methodology / independence

Round-2 remediation evidence was treated as a claim source, not proof. The review reconstructed the historical finding, read the current PRD/Plan, compared the hook sets, inspected current source owners needed for D8.0-D8.3 compatibility, and independently audited the OS primitives the plan says will implement exact-source ownership.

Evidence classes used:

```text
SOURCE-PROVEN
PLATFORM-DOC-PROVEN
PLANNING-FROZEN
FUTURE-IMPLEMENTATION-PROOF-REQUIRED
CONTRADICTED
```

The decisive rule is that naming `D8_DIARY_RENAME_BY_HANDLE` or `D8_DIARY_RENAME_BY_VNODE` is not evidence that a corresponding kernel operation exists.

## 5. P1-2 closure decision

**ID:** `D8.4-IPR-P1-2`  
**Severity:** `P1`  
**Status:** `OPEN`  
**Title:** Round 2 freezes exact-source ownership to Linux/macOS handle/vnode namespace operations that stock supported OS interfaces do not provide.

**Affected planning sections:** D8.4 PRD §9.1/§9.1a-§9.1e, restart/durability rules; Implementation Plan Workstream B, cross-platform validation, failure/recovery matrix and release gate; canonical D8.4 migration authority.

**Affected platform/source owners:** future `DiaryMigrationFs`; Linux `renameat2/openat2/name_to_handle_at/open_by_handle_at/unlinkat`; macOS `renameat/renameatx_np/getfh/fhopen`; Windows `CreateFileW/SetFileInformationByHandle/FILE_RENAME_INFO/FILE_ID_INFO/OpenFileById`; current Nuvyn Docker deployment; D8.3 generic rename/delete guards.

**Invariant violated:** the actual namespace mutation must be tied to the exact captured source/quarantine generation and expected parent, with external replacements winning, no overwrite, no pathname check/use fallback, no copy/delete fallback, and restart never treating matching metadata as destructive authority.

**Exact planning claim:** `transitionOwnedSource(capturedSourceAuthority, expectedParentAuthority, reservedQuarantineName)` is frozen as one kernel-authoritative conditional mutation. Linux requires `D8_DIARY_RENAME_BY_HANDLE`; macOS requires `D8_DIARY_RENAME_BY_VNODE`; matching handle/vnode-bound removal and restart-reacquisition operations are required.

**Independent evidence:**

- **Linux — CONTRADICTED.** `renameat2(2)` takes `olddirfd + oldpath` and `newdirfd + newpath`. The source remains a pathname relative to a directory fd. `RENAME_NOREPLACE` protects only the destination. `openat2` strengthens resolution but is not rename-by-open-file. `name_to_handle_at/open_by_handle_at` can obtain/reopen a file handle, but reopening does not supply a syscall that renames that directory entry by the captured source handle. `unlinkat(2)` likewise removes a pathname relative to a directory fd; it is not unlink-by-captured-file-fd. A later pathname rename/unlink therefore retains the source-dirent replacement window the plan forbids.
- **Linux restart privilege — CONTRADICTED for default deployment.** `open_by_handle_at(2)` requires `CAP_DAC_READ_SEARCH`; file-handle support is filesystem-dependent and handles can become stale. Nuvyn's production Docker runs as user `node`/UID 1000, compose sets `user: "1000:1000"` and `no-new-privileges:true`, and no required capability is granted.
- **macOS — CONTRADICTED.** Public `renameatx_np(int fromfd, const char *from, int tofd, const char *to, flags)` still chooses source by directory fd + pathname. `RENAME_EXCL` protects destination occupancy only. Apple's `getfh/fhopen` are super-user-only/NFS-oriented and, even when an object is reopened, the public rename API still lacks a source-vnode/file-handle operand. No supported public `rename/unlink-by-vnode` API matching the frozen ABI was found.
- **Windows live transition — PLATFORM-DOC-PROVEN.** `SetFileInformationByHandle` operates on the file represented by `hFile`; `FILE_RENAME_INFO.RootDirectory` can bind relative destination resolution; `ReplaceIfExists=FALSE` fails on an occupied target. Omitting `FILE_SHARE_DELETE` blocks later opens requesting delete access, and Windows documents rename as requiring delete access. The live handle-based transition is feasible in principle.
- **Windows restart identity — FUTURE-IMPLEMENTATION-PROOF-REQUIRED.** `FILE_ID_INFO` provides volume + file ID and `OpenFileById` exists on supported filesystems, but Microsoft documents file IDs as filesystem-specific and not guaranteed unique over time. A restart destructive authority therefore needs an explicit filesystem/generation support contract. This remains within P1-2 rather than opening a second finding.

**Adversarial trace:**

```text
capture source G1 by fd
-> external writer replaces source dirent with G2 in same captured parent
-> wrapper calls stock renameat2/renameatx_np(parentFd, sourceName, ...)
-> kernel resolves sourceName at mutation time
```

A preceding fd/vnode comparison cannot make that pathname mutation conditional on G1.

Quarantine removal has the same problem:

```text
reacquire/check quarantine G1
-> external replacement installs G2 at reserved name
-> unlink/remove by parent + pathname
```

The check and destructive mutation are separate authority events.

**Impact:** implementing the frozen contract on Linux/macOS would require protocol redesign, private/new kernel functionality, a privileged service/capability architecture, narrowing supported platforms/filesystems, or weakening the invariant. Those are implementation-critical security/data-integrity/platform choices.

**Why planned tests are insufficient:** tests can validate a real primitive but cannot create kernel atomicity absent from the actual OS API. A mock/native wrapper with idealized semantics proves the wrapper contract, not stock platform support.

**Required planning remediation:** choose a platform-real protocol. Remove/replace the fictional Linux/macOS exact rename/unlink-by-handle/vnode requirement; explicitly freeze any privilege/capability architecture or supported-filesystem restriction; define restart generation semantics against real OS identity rules; preserve D8.3 generic guards; then align the crash oracle to the replacement real protocol. Do not implement this remediation during review.

Decision:

```text
D8.4-IPR-P1-2 = OPEN
```

## 6. Linux feasibility audit

| Question | Result | Class |
| --- | --- | --- |
| `renameat2` source selected by captured source fd? | No; `olddirfd + oldpath` | PLATFORM-DOC-PROVEN |
| `RENAME_NOREPLACE` protects source generation? | No; destination only | PLATFORM-DOC-PROVEN |
| `openat2` closes later rename source race? | No; safe open/resolution only | PLATFORM-DOC-PROVEN |
| `open_by_handle_at` reopens exact handle? | Yes on supporting FS | PLATFORM-DOC-PROVEN |
| Reopened fd can be passed to stock rename-by-handle? | No supported public regular-file syscall found | CONTRADICTED |
| `open_by_handle_at` privilege | `CAP_DAC_READ_SEARCH` required | PLATFORM-DOC-PROVEN |
| Nuvyn default Docker has it? | No; non-root UID 1000/no-new-privileges | SOURCE-PROVEN |
| `unlinkat` exact captured quarantine fd? | No; pathname relative to dirfd | PLATFORM-DOC-PROVEN |

Fail-closed is safe, but a plan cannot call ordinary Linux a supported migration target if the mandatory source primitive itself is unavailable on stock deployment.

## 7. macOS feasibility audit

| Question | Result | Class |
| --- | --- | --- |
| `renameatx_np` source selected by captured source vnode/fd? | No; parent fd + source pathname | PLATFORM-DOC-PROVEN |
| `RENAME_EXCL` | Fails if destination exists | PLATFORM-DOC-PROVEN |
| `RENAME_EXCL` proves prior source generation? | No | PLATFORM-DOC-PROVEN |
| Public handle reopen | `getfh/fhopen` are super-user-only | PLATFORM-DOC-PROVEN |
| Public `rename-by-vnode` matching plan | No supported API found | CONTRADICTED |
| Public exact `unlink-by-vnode` | No supported API found | CONTRADICTED |

A native addon using `fstat` followed by `renameatx_np` would reintroduce the forbidden check/use gap. Private kernel APIs or a privileged extension are new product architecture, not implied by a wrapper name.

## 8. Windows feasibility audit

| Question | Result | Class |
| --- | --- | --- |
| Rename acts on captured source handle | Yes, `SetFileInformationByHandle` | PLATFORM-DOC-PROVEN |
| Destination relative to parent handle | `FILE_RENAME_INFO.RootDirectory` | PLATFORM-DOC-PROVEN |
| Target collision fails | `ReplaceIfExists=FALSE` | PLATFORM-DOC-PROVEN |
| External rename/delete while owned handle lives | Can be blocked by omitting `FILE_SHARE_DELETE` | PLATFORM-DOC-PROVEN |
| File identity | volume serial + 128-bit `FILE_ID_INFO` | PLATFORM-DOC-PROVEN |
| Restart by ID | `OpenFileById`, constrained by FS/protocol | PLATFORM-DOC-PROVEN |
| ID reuse over time | possible / filesystem-specific | PLATFORM-DOC-PROVEN |

The Windows live path is feasible in principle, but Windows success cannot compensate for required Linux/macOS failure. Restart exactness still needs filesystem-specific proof.

## 9. Restart authority audit

Round 2 correctly separates live mutation authority from restart recovery authority and refuses to treat path/metadata equality as ownership. That conceptual contract is sound.

Platform reality is not uniform:

- Linux can reopen by file handle only with required privilege/support and still lacks rename/unlink-by-that-handle.
- macOS public file handles are super-user-only and do not provide rename/unlink-by-vnode.
- Windows can reopen by identifier on supported filesystems, but file-ID reuse/change prevents treating numeric identity as universally lifetime-unique.

`QUARANTINE_OWNERSHIP_UNPROVEN -> NEEDS_ATTENTION` remains the correct fail-closed result whenever exact reacquisition cannot be established. Pre-publication restoration and post-publication quarantine deletion inherit the same P1-2 platform constraint.

## 10. P2-3 closure decision

```text
D8.4-IPR-P2-3 = CLOSED
```

Round 2 now separates quarantine unlink from parent-directory durability and explicitly maps `DISCARD_AI_SESSION` to named SQLite before/after-commit hooks with exact durable-state, consent and restart expectations. No implementation-time choice remains about whether these crash boundaries exist.

## 11. Hook-set equivalence

PRD and Implementation Plan expose the same authoritative 19 hooks in the same order:

```text
01 AFTER_JOURNAL_PREPARED
02 AFTER_CIPHERTEXT_TEMP_FSYNC
03 BEFORE_SOURCE_TRANSITION
04 AFTER_SOURCE_TRANSITION
05 BEFORE_CIPHERTEXT_PUBLISH
06 AFTER_CIPHERTEXT_PUBLISH_SYSCALL
07 AFTER_TARGET_DURABILITY
08 AFTER_AUTHENTICATED_READBACK
09 BEFORE_PUBLISHED_JOURNAL
10 AFTER_PUBLISHED_JOURNAL
11 BEFORE_SQLITE_CLEANUP_COMMIT
12 AFTER_SQLITE_CLEANUP_COMMIT
13 BEFORE_IDB_DISPOSITION_COMMIT
14 AFTER_IDB_DISPOSITION_COMMIT
15 BEFORE_SOURCE_QUARANTINE_UNLINK
16 AFTER_SOURCE_QUARANTINE_UNLINK_BEFORE_DIR_DURABILITY
17 AFTER_SOURCE_QUARANTINE_DIR_DURABILITY
18 BEFORE_ITEM_COMPLETE
19 AFTER_ITEM_COMPLETE
```

Count difference: none. Name/set difference: none. Order difference: none. Semantic difference for the remediated quarantine/AI seams: none found.

## 12. Quarantine unlink/durability oracle

Three distinct stages are now frozen:

1. `BEFORE_SOURCE_QUARANTINE_UNLINK`: exact owned quarantine exists; unlink not invoked; exact native authority required.
2. `AFTER_SOURCE_QUARANTINE_UNLINK_BEFORE_DIR_DURABILITY`: unlink returned; parent barrier not complete; durability unknown. Restart inspects namespace, never recreates plaintext; absent -> fsync parent/record absence; same exact generation -> retry exact removal; different generation -> external wins/attention.
3. `AFTER_SOURCE_QUARANTINE_DIR_DURABILITY`: unlink and parent barrier completed; absence is committed and forward-only.

The unresolved P1-2 primitive affects whether real unlink can satisfy exact-generation authority, but it no longer means the crash **oracle definition** is missing. Thus P2-3 closes independently.

## 13. AI whole-session crash oracle

Round 2 explicitly maps:

```text
DISCARD_AI_SESSION
-> BEFORE_SQLITE_CLEANUP_COMMIT
-> AFTER_SQLITE_CLEANUP_COMMIT
operationClass=DISCARD_AI_SESSION
```

Before commit, kill/rollback leaves the reviewed session/messages durably present and the migration item pending; consent remains reusable only for the exact same inventory/session/message generation.

After commit, the exact session and reviewed messages are absent while the migration ledger may lag; restart reconciles idempotently, never recreates data, and never deletes a changed/replacement session under old consent.

Current source supports whole-session transactional ownership: `messages.session_id REFERENCES sessions(id) ON DELETE CASCADE`, and Nuvyn enables `PRAGMA foreign_keys = ON`.

Implementation placement must ensure the true before-commit hook is after conditional delete statements and before `COMMIT`; the post-kill durable oracle is rollback-restored rows. This is future implementation proof, not a missing planning boundary.

IDB remains a separate browser transaction oracle and is not used as AI/SQLite proof.

## 14. Six closed-finding regression

| Finding | Result |
| --- | --- |
| `D8.4-IPR-P1-1` | REMAINS CLOSED — `RECOVERY_AUTH_REQUIRED`, no structural-envelope authentication |
| `D8.4-IPR-P1-3` | REMAINS CLOSED — immutable revision/exact CAS/action consent |
| `D8.4-IPR-P1-4` | REMAINS CLOSED — structured AI provenance, whole-session discard/retain, no substring deletion |
| `D8.4-IPR-P1-5` | REMAINS CLOSED — NULL identity unresolved, no path-only cleanup |
| `D8.4-IPR-P2-1` | REMAINS CLOSED — restart provenance forbids body size/plaintext digest/message content |
| `D8.4-IPR-P2-2` | REMAINS CLOSED — ordinary PUT FIFO wait + revalidation, no false immediate 409 |

No Round-2 provenance value becomes destructive authority by itself.

## 15. New-finding audit

The stronger platform evidence belongs to the already-open historical P1-2 rather than a separate finding.

```text
New P0 = 0
New P1 = 0
New P2 = 0
```

Mandatory checks found no independent blocker beyond P1-2: durability UNKNOWN cannot advance cleanup; AI replacement sessions cannot inherit old consent; publication-possible recovery cannot recreate plaintext; the native helper remains scoped by planning to migration transaction authority rather than generic D8.3 bypass.

Windows file-ID reuse/stability and Linux privilege/support limitations are recorded under P1-2's restart/platform invariant.

## 16. D8.0-D8.3 preservation

```text
D8.0 = REVIEW-CLOSED
D8.1 = REVIEW-CLOSED
D8.2 = REVIEW-CLOSED
D8.3 = REVIEW-CLOSED
D8.0-D8.3 contract preservation = PASS
```

No second password/KEK/DEK/session/capability/AES-GCM/AAD owner is introduced. D8.2 remains the body crypto owner, D8.3 generic managed-Diary History/Draft/Search/LinkIndex/rename/delete gates remain fail closed, and ordinary Note behavior is not intentionally changed.

## 17. Implementation-readiness decision

D8.4 is **not** implementation-ready.

P2-3 is planning-complete, but P1-2 fails the required-platform feasibility test. The implementation author cannot implement the Linux/macOS contract merely by binding the named ABI because the underlying public namespace mutations do not have the required source-handle/vnode conditional operand.

```text
D8.4 Planning = NOT APPROVED
D8.4 implementation = BLOCKED / NOT STARTED
```

## 18. Evidence / limitations

Repository evidence reviewed includes the canonical D8 plan, D8.4 PRD/Plan, both historical independent reviews, remediation evidence, D8.0-D8.3 predecessor authorities/source owners, `server/migrations/0001_ai_history.sql`, `server/db.ts`, `Dockerfile`, and `docker-compose.yml`.

Platform documentation used:

Linux:
- https://man7.org/linux/man-pages/man2/renameat2.2.html
- https://man7.org/linux/man-pages/man2/openat2.2.html
- https://man7.org/linux/man-pages/man2/open_by_handle_at.2.html
- https://man7.org/linux/man-pages/man2/unlink.2.html
- https://man7.org/linux/man-pages/man7/capabilities.7.html

macOS:
- https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/APFS_Guide/ToolsandAPIs/ToolsandAPIs.html
- https://developer.apple.com/documentation/foundation/urlresourcevalues/volumesupportsexclusiverenaming
- https://man.freebsd.org/cgi/man.cgi?manpath=macOS+26.6.1&query=rename&sektion=2
- https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/getfh.2.html
- https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fhopen.2.html

Windows:
- https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle
- https://learn.microsoft.com/windows/win32/api/winbase/ns-winbase-file_rename_info
- https://learn.microsoft.com/windows/win32/api/winbase/ns-winbase-file_id_info
- https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-openfilebyid
- Microsoft CreateFile sharing documentation (`FILE_SHARE_DELETE`).

Limitations:
- No D8.4 runtime implementation exists; no runtime migration behavior is claimed.
- Public platform documentation proves the supported API surface reviewed. A private/internal kernel mechanism, future kernel feature, or new privileged helper architecture is outside the reviewed plan and cannot be assumed.
- The connected GitHub repository is the authoritative working surface. There is no model-owned local checkout, so local `git status`/`git diff --check` output is not fabricated; branch/commit/diff/CI provenance was verified through GitHub APIs.
- Repository write attempts from this review were denied by the GitHub integration; this document therefore could not be committed/pushed by the reviewer in this session.

## 19. Lifecycle

```text
D8.0 = REVIEW-CLOSED
D8.1 = REVIEW-CLOSED
D8.2 = REVIEW-CLOSED
D8.3 = REVIEW-CLOSED

D8.4 Independent Planning Review
= CHANGES REQUIRED (0/5/3) [historical]

D8.4 Planning Remediation Round 1
= COMPLETE

D8.4 Independent Planning Re-review
= CHANGES REQUIRED (0/1/1) [historical]

D8.4 Planning Remediation Round 2
= COMPLETE

D8.4 Independent Planning Re-review Round 2
= CHANGES REQUIRED (0/1/0)

D8.4-IPR-P1-2 = OPEN
D8.4-IPR-P2-3 = CLOSED

D8.4 Planning = NOT APPROVED
D8.4 implementation = BLOCKED / NOT STARTED
D8.4 = NOT REVIEW-CLOSED
```

Do not start implementation. The next authorized action is planning remediation of `D8.4-IPR-P1-2`, followed by another independent planning re-review.
