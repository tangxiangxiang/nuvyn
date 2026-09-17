# Nuvyn Edit Feature — Final Closure

This document records the formal closure of the Nuvyn Edit feature
development program and the Round-17 folder move / crash-recovery audit.

It is the authoritative closure record. Future changes must respect
the maintenance-mode rules in §8.

---

## 1. Final Baseline

```text
Repository: tangxiangxiang/nuvyn
Branch:     main
Final Code SHA:         83abbf336785290a667321a8817ff6898176a678
Closure Date:           2026-07-30
```

The Final Code SHA above is the last production commit. The closure
documentation itself is a separate, subsequent commit (the "Final
Closure Documentation SHA") and contains no production code or test
changes — see §6 and §7.

---

## 2. Final Status

```text
EDIT FEATURE DEVELOPMENT:  CLOSED
ROUND-17 AUDIT:            CLOSED
FROZEN AUDIT BLOCKERS:     CLOSED
DIRECTORY ABA:             CLOSED
WINDOWS TEST ISOLATION:    CLOSED
STATUS:                    MAINTENANCE MODE
```

---

## 3. Closed Issues

### P0 — Round-17 audit blockers

- **P0-1 — Cross-artifact transaction and owner handoff**
  Folder move, reference journal, metadata snapshot, and crash recovery
  now share a single owner handoff protocol. Reference companions cannot
  outlive or bypass their owner protocol.

- **P0-2 — Idempotent metadata CAS recovery**
  Metadata snapshot/restore is now a strict, validated CAS operation.
  Snapshot/restore rollback is scoped at parse time (every restored path
  inside the restored subtree; cross-references declared; migrations
  reference only transaction paths/ids). Forged or stale journals cannot
  touch unrelated metadata.

- **P0-3 — Directory ownership and ABA protection**
  Source and destination directories now carry explicit ownership proofs.
  Inode-reuse ABA is closed by binding directory identity to
  `dev + ino + birthtimeNs`.

### P1 — Round-17 audit findings

- **P1-1 — Create-only incumbent preservation**
  `rename(2)` is no longer used to commit moves. All physical file
  commits use create-only `link(2)` so an incumbent destination is
  preserved. External generation always wins with a typed 409.

- **P1-2 — Strict metadata snapshot schema and graph closure**
  The persisted delete-rollback snapshot is scoped at parse time
  (`isValidDeleteRollbackSnapshot`); restored subtree paths, document
  cross-references, tags, embeddings, migrations are all validated
  against the durable graph. A malicious or malformed journal cannot
  reach unrelated metadata.

- **P1-3 — Weak legacy journal fail-closed**
  Weak legacy journals are parseable but not automatically recoverable.
  They are quarantined under `.nuvyn-delete-*` rather than silently
  replayed. Filesystems without stable positive `birthtimeNs` fail
  closed.

### Additional closures

- **Directory ABA on inode reuse** — closed by binding folder directories
  to `dev + ino + birthtimeNs` identity (`fix(server): bind folder
  directories to birthtime identity`, `2eb50d2`).
- **Windows integration test isolation** — closed by waiting for
  in-flight requests before teardown (`test(server): wait for in-flight
  integration requests before teardown`, `83abbf3`).
- **Directory ABA recovery matrix** — closed with a deterministic
  state-machine seed suite (`test(server): close directory ABA recovery
  matrix`, `6a6a838`).

---

## 4. Final Safety Invariants

The closed system preserves the following invariants. Any future change
that weakens any of them is a Round-17 reopen.

- **External generation always wins.** An incumbent destination cannot
  be overwritten by a move commit. External content takes precedence
  and is reported with a typed 409.
- **Unknown ownership fails closed.** If a physical artifact cannot
  be proven owned by the protocol, recovery halts and the artifact is
  quarantined.
- **Journal is removed last.** The on-disk journal is only removed
  after the durable ownership footprint is committed and replayed
  forward; a crashed recovery can finish forward.
- **SQLite restore is limited to the durable ownership footprint.**
  A restore cannot touch rows, tags, embeddings, or migrations outside
  what the validated journal declares.
- **Recovery is idempotent.** Re-running recovery on an already-recovered
  state is a no-op. No second recovery can mutate durable state.
- **Reference companion cannot outlive or bypass its owner protocol.**
  A reference journal is bound to its owner move; if the owner move is
  absent or invalidated, the reference cannot act independently.
- **Weak legacy journals are parseable but not automatically recoverable.**
  They are quarantined for manual review; they cannot silently mutate
  the durable tree.

---

## 5. Final Test Results

Captured locally on the final code SHA `83abbf3`:

| Command                  | Result |
| ------------------------ | ------ |
| `npm run typecheck`      | PASS   |
| `npm run build`          | PASS   |
| `npm test -- --run`      | PASS   |

Test run summary (from the final local run):

```text
Test Files: 153 passed (153)
Tests:      2366 passed | 2 skipped (2368)
Failed:     0
Duration:   84.03s
```

---

## 6. Platform CI

The final code SHA `83abbf336785290a667321a8817ff6898176a678` is
verified green by the cross-platform CI matrix. All jobs bound to this
SHA are part of the same workflow run.

```text
Workflow:     CI
Run ID:       30502302076
URL:          https://github.com/tangxiangxiang/nuvyn/actions/runs/30502302076
Head SHA:     83abbf336785290a667321a8817ff6898176a678
Conclusion:   success

  verify (ubuntu-latest)   — job 90744382854 — success
  verify (macos-latest)    — job 90744382846 — success
  verify (windows-latest)  — job 90744382804 — success
  visual                   — job 90744382790 — success
```

---

## 7. Accepted Non-Blocking Risks

The closed system accepts the following risks as out of scope for the
Edit feature closure:

- No defense against a malicious local administrator who can forge
  all artifacts.
- Path-based `lstat` / syscall TOCTOU remains outside the current
  threat model.
- Directory `fsync` is best effort on unsupported platforms.
- Filesystems without stable positive `birthtimeNs` fail closed (no
  silent recovery).
- Conservative quarantine may require manual recovery in pathological
  cases.

---

## 8. Maintenance-Mode Rules

After closure, any future change touching folder move, crash recovery,
metadata snapshot, reference journal, directory identity, or cleanup
semantics must:

1. Include a written protocol impact analysis (what invariant is
   preserved, weakened, or strengthened).
2. Add crash / recovery regression tests on the affected path.
3. Run the complete cross-platform CI matrix (Ubuntu, macOS, Windows,
   Visual) on the commit before merge.
4. Preserve backward fail-closed behavior — a partial fix must not
   leave the system silently open.
5. Not reopen Round-17 unless an actual regression is demonstrated
   with a reproducible failing test.

Out-of-scope by default:

- Architecture refactors without a stated requirement.
- Additional audit items beyond the closed Round-17 set.
- Modification of the closed recovery protocols for "more complete"
  coverage.
- Expansion of the durable protocol footprint beyond what the closure
  baseline established.

In-scope by default:

- Clearly reproducible bug fixes.
- Platform compatibility fixes.
- Security vulnerability fixes.
- Performance issue fixes.
- Approved new feature requirements.

---

## 9. 2026-08-01 Focused Maintenance Reopening Addendum

The History/folder-move cross-feature audit demonstrated a real
maintenance regression against the closed protocol boundary. At RED
commit `36fed44dbf0276ee876f1d2a1f8d6c51c6bc7be9`, deterministic tests
showed that Restore, Withdraw, Create Version, Index Repair, and startup
recovery could enter independently of a durable folder-move
transaction. A two-process test also showed that two Vite mutation
servers could become active for one canonical Vault.

The affected invariant was not a folder-move v4 journal transition. It
was the absence of one outer Vault mutation boundary: an unrelated
History writer could touch a source or destination generation owned by
the journal and thereby risk an overwrite, an impossible old/new Index
Repair snapshot, or false parity quarantine.

Production correction `1a065bb0c2517f8a1fe1886b806e6945c2830538`
adds process-lifetime single-writer ownership, a shared process-local
Vault mutation coordinator, and an atomic/CAS History Restore writer.
It does not change `folderMoveV4Executor`, `folderMoveV4Metadata`, the
journal schema, phases, generation rules, quarantine rules, or durable
SQLite footprint. Therefore the closed v4 invariants remain unchanged:

- external generation always wins;
- unknown ownership fails closed;
- the journal is removed last;
- replay remains idempotent;
- create-only destination ownership is preserved; and
- SQLite mutation remains inside the durable ownership footprint.

Local verification on that production SHA passed the focused History
coordination suites (4 files, 145 tests), the complete suite (156 files,
2,476 passed, 2 skipped), typecheck, build, and `git diff --check`.
Ubuntu, Windows, and Visual CI have not yet run on this SHA; macOS has
only the local evidence above. Accordingly this is a focused
maintenance correction, and Edit maintenance closure is temporarily
reopened for cross-platform verification. The historical closure and
its evidence remain valid for their recorded SHA and are not rewritten
by this addendum.
