# D8.4 Independent Planning Review

> **Historical lineage — not current runtime authority.** Current behavior is
> defined by [Diary Architecture](../architecture/diary.md) and [Diary User
> Guide](../user-guide/diary.md). This file is retained for D8 review
> traceability.

## 1. Status / verdict

This is an independent planning review of D8.4 only. It is not an
implementation, remediation, approval sync, or closure record. No production
code, tests, schemas, data, IndexedDB state, SQLite state, or Git history was
changed during this review.

Verdict:

```text
D8.4 Independent Planning Review = CHANGES REQUIRED (0/5/3)
```

The findings are planning defects, not a rejection of the D8.4 direction. The
largest blockers are the locked-startup authentication gap, an unspecified
cross-platform ownership/publication primitive, confirmation scope for items
discovered after consent, an unaccounted-for persistent AI history store, and
an ambiguous `frontmatter_backup` identity rule.

## 2. Review target and provenance

The requested planning baseline and target were independently checked:

| Item | Verified value |
| --- | --- |
| Baseline | `c88e99554c291181c6e3f17e695aa228f34d40b2` (`docs(diary): close D8.3 privacy enforcement`) |
| Planning HEAD | `cbd5424ebe82737604b621a1be58f1c1b965e5f0` (`docs(diary): plan D8.4 migration and release closure`) |
| Branch | `main` |
| `github/main` | `cbd5424ebe82737604b621a1be58f1c1b965e5f0` |
| Working tree at review start | clean |
| Planning diff | docs-only: the two D8.4 documents plus 25 lines in the canonical lifecycle plan; 3 files, 1111 insertions, 2 deletions |
| `git diff --check` | passed |

The planning diff did not include implementation, test, configuration, schema,
or data changes. The review file itself is the only file added by this review.

## 3. Planning CI verification

The exact planning run was queried independently from GitHub:

| Field | Value |
| --- | --- |
| Workflow | `CI` |
| Run number | `598` |
| Run ID | `33396383314` |
| Attempt | `1` |
| Event | `push` |
| Head SHA | `cbd5424ebe82737604b621a1be58f1c1b965e5f0` |
| Status / conclusion | `completed / success` |

All eight jobs concluded `success`:

| Job | Conclusion |
| --- | --- |
| `tags-scale` | success |
| `verify (macos-latest, 24)` | success |
| `auth-browser` | success |
| `docker-smoke` | success |
| `verify (ubuntu-latest, 24)` | success |
| `verify (ubuntu-latest, 22)` | success |
| `visual` | success |
| `verify (windows-latest, 24)` | success |

This run proves that the docs-only planning commit did not regress the current
repository. It does not prove an unimplemented D8.4 migration protocol.

## 4. Methodology and limitations

I read the canonical D8 implementation plan, D8.0 architecture verification,
D8.1 session foundation, D8.2 body storage, and the complete D8.3 chain:
privacy PRD, implementation plan, implementation evidence, independent review,
remediation evidence, independent re-review, and closure/lifecycle update. I
then read both D8.4 planning documents in full and compared their claims with
the current source owners.

The source audit used repository searches and line-level inspection of the
path classifier, Diary body/service/guard, startup entrypoints, atomic writers,
safe-path and directory-identity helpers, mutation/document locks, metadata and
frontmatter owners, SQLite migrations, Draft Store, AI history/tools, Git
history, tree/list, search, and LinkIndex. The exact GitHub run was available;
the initial unauthorised network attempt was retried with the required
escalated read-only command and did not limit the review. No D8.4 runtime tests
were expected because implementation has not started; the review instead tests
whether the future test/evidence plan can prove the frozen contracts.

## 5. Source-owner verification

| Boundary | Current source owner and observed compatibility |
| --- | --- |
| Diary identity | `shared/diaryProtocol.ts` is the classifier used by routes and projections. Compatible with one canonical date/path contract. |
| Live key/body access | `server/diaryAccess/service.ts` stores the DEK only in its in-memory capability map and exposes lease-local `encrypt`/`decrypt`/`read` callbacks (`service.ts:96-103`, `501-559`). A configured service reports `LOCKED` unless a current capability is presented (`404-412`). |
| V1 authentication | `server/diaryAccess/body.ts:93-121` parses envelope structure; `148-173` checks identity and performs AES-GCM tag/AAD authentication with the DEK. Parsing is not authentication. |
| Startup | `server/prod.ts:60-101` and `server/vite-plugin.ts:27-57` initialise auth, run generic recovery, then metadata/history work before HTTP. They do not unlock Diary at startup. |
| Safe paths | `server/paths.ts:140-218` is lstat/identity revalidation; `220-270` opens with `O_NOFOLLOW ?? 0`, so Windows has no equivalent no-follow flag in this helper. |
| Atomic filesystem | `server/atomicTextWrite.ts:470-553` publishes creates with `fs.link`; `632-642` swallows directory-fsync errors; `644-658` retries `fs.rename` on Windows; `1233-1236` acknowledges a remaining pathname check/use window. |
| Mutation locks | `server/vaultMutation.ts:48-73` and `server/documentWriteLock.ts:31-87` are process-local async queues. They do not expose a non-blocking migration-owner query. |
| Primary routes | `server/routes/posts.ts:343-370` uses the document lock for content PUT; managed PUT is wrapped by the Diary body lease. `server/routes/diary.ts:170-220` uses structure + document locks for creation. |
| Metadata/frontmatter | `server/metadataMigration.ts:61-85` upserts by path and permits `document_id` to remain `NULL`; schema migration `0004_metadata_document_identity.sql:3-13` confirms the nullable column. `server/frontmatterArchive.ts:193-210` cleans only an exact non-null document ID today. |
| SQLite private stores | Migrations include `documents`, tags, embeddings, history metadata and tag-undo stores, but also `server/migrations/0001_ai_history.sql:1-21` with durable `sessions` and `messages.content`. |
| AI history | `server/ai/messages.ts:175-234` reads/writes durable message content; `server/ai/chat.ts:232-247,328-378,411-427` persists user text and tool results, including the result of legacy `read_file`; current `server/ai/tools.ts:1207-1224` guards new managed-Diary reads but does not remove old rows. |
| Draft/Recovery | The D8.3 client store remains the owner of `nuvyn-draft-recovery` v2 and its conditional family operations; the D8.4 two-action bridge is source-compatible but not yet implemented. |
| Git | `server/history/git.ts` is the Git owner; D8.3 rejects new managed History before Git mutation. The current Git owner can create temporary indexes for ordinary history operations, so D8.4 inventory must remain read-only and must not reuse mutation paths. |
| Tree/search/LinkIndex | Tree/list and LinkIndex classify managed paths and skip managed body parsing. The tree still obtains filesystem `stat.size`; LinkIndex/search do not persist managed body edges. Reserved D8.4 names are not `.md`, but explicit exclusion/recovery ownership still needs implementation proof. |

## 6. Review of the 23 frozen decisions

The following classifications are planning classifications, not claims that
D8.4 runtime code exists. `PROVEN` means the current authority/source boundary
already supports the stated direction; `SUPPORTED BUT NEEDS IMPLEMENTATION
PROOF` means the direction is compatible but its future proof is required;
`AMBIGUOUS` means a security-relevant contract is not frozen; `CONTRADICTED`
means the wording conflicts with an existing frozen boundary.

| # | Frozen decision | Classification | Independent review result |
| ---: | --- | --- | --- |
| 1 | Explicit migration trigger / UX | PROVEN | The PRD and D8.3 boundaries support explicit Settings/banner initiation; no automatic migration is required. |
| 2 | Sole server-side `DiaryMigrationService` | SUPPORTED BUT NEEDS IMPLEMENTATION PROOF | A new orchestrator can compose existing owners, but it must not become a second key/session owner and must register migration ownership with routes. |
| 3 | Item/run state machine | AMBIGUOUS | The state list is useful, but `PUBLISHING`/`PUBLISHED` cannot be reconciled while locked from envelope structure alone; see P1-1. |
| 4 | SQLite 0012 structural ledger | AMBIGUOUS | The proposed schema has privacy/provenance gaps (`size`, nullable identity, and omitted AI history scope); see P1-4, P1-5 and P2-1. |
| 5 | Vault/document/path/schema identity | SUPPORTED BUT NEEDS IMPLEMENTATION PROOF | The tuple is a good logical key, but it is not by itself generation ownership or destructive authorization. |
| 6 | Ciphertext-only/no-copy primary protocol | AMBIGUOUS | “Create-only link/rename” and pathname lstat/re-open checks do not define one safe cross-platform primitive; see P1-2. |
| 7 | Encrypted publication commit point | AMBIGUOUS | Publication, authenticated readback and durable `PUBLISHED` journal are described as adjacent but not one locked-recovery-observable event; see P1-1. |
| 8 | Monotonic rollback | SUPPORTED BUT NEEDS IMPLEMENTATION PROOF | The forward-only rule is compatible with D8.2, subject to an authenticated/deferred recovery state. |
| 9 | No-new-plaintext artifacts | SUPPORTED BUT NEEDS IMPLEMENTATION PROOF | The one moved pre-existing source is a coherent exception; ownership, watcher and cleanup proofs remain future work. |
| 10 | Explicit metadata adoption | SUPPORTED BUT NEEDS IMPLEMENTATION PROOF | The missing-row stop is sound, but adoption must bind the current generation and avoid nullable/path-only cleanup. |
| 11 | Malformed/unknown/AAD fail closed | PROVEN | Existing body parsing/authentication and D8.3 guards support fail-closed classification; the locked scan must not call structural parsing “valid”. |
| 12 | External generation wins | AMBIGUOUS | The required result is correct, but current pathname move/open primitives leave a check/use race and no specified platform refusal; see P1-2. |
| 13 | Draft/Recovery import-or-typed-discard | SUPPORTED BUT NEEDS IMPLEMENTATION PROOF | Existing conditional IDB ownership supports it; confirmation scope for newly discovered families remains unresolved (P1-3). |
| 14 | No encrypted Draft Store V2 | PROVEN | This carries forward the D8.3 disabled-write boundary. |
| 15 | Private SQLite metadata cleanup | AMBIGUOUS | The listed tables have owners, but the inventory does not account for every durable private SQLite store; see P1-4. |
| 16 | `frontmatter_backup` cleanup | CONTRADICTED | “Optional `document_id`” and “never path-only” are incompatible when the source row has `NULL` identity; see P1-5. |
| 17 | Git disclose-and-retain | SUPPORTED BUT NEEDS IMPLEMENTATION PROOF | The policy itself is coherent and preserves the index/history residual; command coverage and read-only evidence must be implemented. |
| 18 | No remote Git mutation | PROVEN | The plan explicitly forbids rewrite, prune, force-push and remote mutation. |
| 19 | Per-document + `ATTENTION_REQUIRED` semantics | AMBIGUOUS | Per-item attention is sound, but run-level confirmations can authorize later rows without a consent snapshot; see P1-3. |
| 20 | Completion guarantee | AMBIGUOUS | The wording depends on an exhaustive private-store inventory and precise acknowledged-residual semantics; AI history is not accounted for (P1-4). |
| 21 | Residual-risk disclosure | AMBIGUOUS | Git and external residuals are disclosed, but an omitted Nuvyn-controlled AI store would not be represented accurately (P1-4). |
| 22 | Release gate | SUPPORTED BUT NEEDS IMPLEMENTATION PROOF | The gate is broad and includes cross-platform/CI/evidence, but its crash hooks and privacy proof are not concrete enough (P2-3). |
| 23 | Final D8 closure lifecycle | PROVEN | The canonical lifecycle remains review-before-implementation and separate closure; this review does not alter it. |

## 7. Primary migration protocol audit

The high-level no-copy sequence is internally understandable: read one legacy
generation into authorized memory, encrypt to a ciphertext-only temp, move the
pre-existing plaintext inode to a reserved name, publish ciphertext
create-only, and clean forward. The sequence is not yet implementation-ready
for two independent reasons.

First, the plan says both “same-filesystem create-only link/rename” (PRD
§9.1(10), Plan §8) and “re-open/`lstat` immediately before the rename” (PRD
§9.1(9)). A normal `rename` is not create-only on all supported systems, while
an lstat followed by a pathname rename is still a check/use window. The current
portable atomic owner explicitly documents that a directory-handle-relative
operation would be needed to eliminate such a window
(`server/atomicTextWrite.ts:1233-1236`). The plan does not choose a primitive,
define a fail-closed response for unsupported filesystems, or prove that a
source move cannot take an external replacement.

Second, the existing no-follow helper is not the required Windows proof:
`server/paths.ts:241-243` uses `O_NOFOLLOW ?? 0`. On Windows this opens without
that flag; an intermediate path/junction can change between lstat and open,
and the content has already entered process memory before the later identity
check rejects it. The existing `syncParentDirectoryBestEffort` also swallows
directory-fsync failures (`server/atomicTextWrite.ts:632-642`). A future
implementation may add a new safe helper, but the planning contract must say
which primitive is authoritative and when a platform/filesystem is refused.
These gaps are Finding `D8.4-IPR-P1-2`.

The target-occupied branch is correctly intended to preserve the occupant, and
the move-vs-copy distinction is conceptually sound. However, “external
generation wins” is not source-proven merely by comparing `dev`/`ino` before a
pathname operation. The source move, ciphertext publication, source-quarantine
deletion, and directory durability all need an explicit ownership proof at the
operation that actually changes the directory.

## 8. Crash/restart and startup-recovery audit

The planned startup order is compatible with the existing entrypoints:

```text
writer ownership -> seed -> existing recovery -> D8.4 recovery
-> history reconcile -> Note metadata -> tag health -> HTTP
```

But a configured `DiaryAccessService` starts locked after process restart. Its
capabilities (including the live DEK) are process-memory entries; `status()`
returns `LOCKED` unless a current capability is presented. AES-GCM
authentication is performed only by `decryptDiaryBody` with the DEK. The V1
envelope's `documentId`, `logicalPath`, version, nonce, ciphertext and tag are
not a substitute for tag/AAD verification.

The adversarial crash is therefore not resolved by the current wording:

```text
source moved -> ciphertext target published/fsynced -> process dies
-> PUBLISHED journal/ledger is absent -> restart is locked
```

PRD §9.2 says this gap is recoverable by “structural ownership plus the V1
envelope”; PRD §15 and Plan §13 say recovery validates “V1 envelope identity”
and reconciles to `PUBLISHED`/`CLEANUP_PENDING`. At this point recovery can
parse only attacker-writable structure. It cannot prove the GCM tag or AAD
(`vaultId` is not authenticated without the DEK), and the plan does not define
a durable deferred state that blocks cleanup until unlock. An external actor
could place a syntactically valid V1-looking target before recovery. Refusing
to advance and restoring plaintext are both unsafe without a specified
post-unlock reconciliation rule. This is Finding `D8.4-IPR-P1-1`.

The same issue affects the boundary immediately after a successful target
link/fsync but before authenticated readback. The plan calls publication the
irreversible point, yet the recovery matrix treats structural target
inspection as enough to prove the phase. The required invariant is monotonic
forward progress with cryptographic confirmation deferred safely when the
service is locked; it is not currently frozen.

Authorization fencing itself is source-compatible for work performed inside a
`withBodyOperation` lease (`service.ts:501-559`), including `assertCurrent()`
around crypto. It does not answer what to do after source move when the lease
expires before publish, or after publish when authenticated readback cannot
run. The plan needs a deterministic pre-publish abort/deferred recovery state,
not only a generic “resume after unlock” sentence.

## 9. Migration locking and external-writer audit

The intended order—vault mutation, structure, document, then body lease—is
compatible with the documented process-local order in `server/vaultMutation.ts`
and `server/documentWriteLock.ts`. It is not yet a complete API contract.

The plan says ordinary managed `PUT` returns `409 diary-migration-in-progress`
“while the document lock is held” (Plan §8). The current `PUT` path acquires
`withDocumentWriteLock` and waits; that lock has no owner identity or
non-blocking `tryAcquire`/migration query. A migration holding the lock would
therefore make a normal PUT queue rather than return that 409 unless a new
registry/gate is introduced. No such owner, route gate, cross-process behavior,
or deadlock proof is specified. This is Finding `D8.4-IPR-P2-2`.

The external-writer matrix has the right policy (external generation wins),
but the following traces remain dependent on the unresolved primitive in
P1-2: replacement between final lstat and source move; junction replacement
before open on Windows; target appearance between an attempted publish and a
rename fallback; and quarantine pathname replacement before cleanup. Each must
either be atomically ownership-bound or fail closed with the artifact retained.

## 10. Legacy Draft/Recovery audit

The current Draft Store is the correct browser owner. D8.3 blocks new managed
persistent Draft writes and filters managed rows from ordinary recovery. The
D8.4 import flow correctly puts encrypted server save/readback before
conditional IDB family deletion, and the typed phrase is not by itself an
ownership proof. Conditional row identity/version checks are still required
for both actions.

The missing contract is consent scope. PRD §7.1 stores three booleans at run
start, while Plan §14 says a scan “refreshes” an active run and `resume` accepts
only `runId`. There is no immutable inventory generation or per-store action
confirmation. A second browser tab can reveal a newer draft family, or an
external process can create a new legacy primary, after the user has confirmed
the original counts. Reusing `legacy_primary_removal_confirmed` or a broad
cleanup confirmation would authorize a row/generation the user never reviewed;
typed discard does not protect primary removal or later SQLite cleanup. This is
Finding `D8.4-IPR-P1-3`.

The required import/discard outcomes on stale, changed, missing, or mismatched
families are otherwise appropriately attention-oriented. A lost response after
an encrypted save must leave the IDB family for a conditional retry, and an
IDB deletion that succeeds before the response must not be replayed as a new
destructive action; the plan should retain those properties in the final
action-level contract.

## 11. SQLite and `frontmatter_backup` audit

The listed `documents`, tags, embeddings, history metadata, and tag-undo
owners are real and the proposed `BEGIN IMMEDIATE` cleanup ordering is
compatible with their ownership. Mixed operations correctly remain attention
instead of broad-deleting Note state. The inventory is not exhaustive,
however: `server/migrations/0001_ai_history.sql` creates durable `sessions` and
`messages.content`, while the D8.4 owner table starts at migrations 0002-0011
and contains no AI-history owner or disposition.

Before D8.3, the AI `read_file` tool read raw Markdown (`server/ai/tools.ts:112-131`)
and returned `content` in its tool result (`339-360`). `runChat` persists user
messages and assistant tool-call records, including `r.content`, in
`messages.content` (`server/ai/chat.ts:328-378,411-427`), and the row is
durable in SQLite (`0001_ai_history.sql:8-14`). D8.3 blocks new managed reads
but does not erase old AI history. The D8.4 table, cleanup workstream, residual
risk, and acceptance evidence never say whether those rows are cleaned,
retained-by-policy, or outside scope. This leaves the release claim about
“every supported ... auxiliary private store” untestable and can leave
Nuvyn-controlled Diary plaintext unreported. This is Finding
`D8.4-IPR-P1-4`.

The `frontmatter_backup` contract has a separate identity contradiction. The
schema permits `metadata_migrations.document_id` to be `NULL`, and the current
writer can preserve that null through a path upsert
(`server/metadataMigration.ts:61-85`; migration 0004, lines 3-13). PRD §12
says an “optional `document_id`” may match but also says the service “never
clears it by path-only equality”; Plan §11 repeats “exact path/document ID”
without defining the null case. For a managed row with null identity, a query
that accepts the optional value is path-only; a query that rejects it leaves a
private backup without a disposition. If the path is reused, path-only cleanup
can clear the prior generation's only rollback/frontmatter backup. This is
Finding `D8.4-IPR-P1-5`.

The planned field table correctly clears `source_hash`, `cleaned_hash` and
error only after publication, and current frontmatter clean/restore already
uses non-null document-ID and hash predicates. The D8.4 plan must preserve that
strict identity rather than weaken it for legacy null rows.

## 12. Ledger privacy and provenance

The proposed tuple is suitable as a logical idempotency key, but it is not
generation authorization. `source_generation_json` is mutable proof attached
to an item and currently contains `size` alongside device, inode, mtime and
directory identity (Plan §6, lines 197-206). For a legacy plaintext primary,
`size` is the exact body byte length; for a V1 envelope it remains a close
length side channel. D8.3 freezes body length as private in the locked
projection (PRD §5, lines 87-92) and D8.4 says locked scans do not display it
(PRD §7.1, lines 136-148), but nowhere authorizes persisting it in a durable
ledger or status-adjacent response. The plan's “no body hash/digest” rule does
not cover this body-derived field. This is Finding `D8.4-IPR-P2-1`.

Generation fields such as mtime can be operational provenance when kept out of
locked user projections, but the plan should state that boundary. More
importantly, retries must re-prove current device/inode/directory ownership;
the tuple or an old `COMPLETE` row must never stand in for a current source
generation.

## 13. Git/history audit

D8.3's `addAndCommit` owner rejects managed paths before Git/index mutation,
and D8.4's “disclose and retain” policy is coherent. The plan explicitly
includes HEAD tree, index, refs, stash, reachable/unreachable objects and
reflogs, forbids `addAndCommit`, `update-ref`, rewrite, prune and push, and
requires retention acknowledgment. A worktree whose current ciphertext is
paired with an older plaintext staged index is therefore a policy-retained
local exposure, not something the migration may silently reset.

The proposed command family (`for-each-ref`, `rev-list --all --objects`,
`fsck --no-reflogs --unreachable`) can support a read-only inventory when the
implementation also records index and reflog classifications without emitting
blob content. `--no-reflogs` must not be treated as proof that reflog-only
objects disappeared; it is an enumeration input for the unreachable class.
The plan's no-new-plaintext canary must compare pre-existing Git objects/index
state with the post-run state and must not invoke the current mutation owner.
This is a supported policy requiring implementation proof, not an additional
finding.

## 14. Ordinary Note, projection, and quarantine audit

The canonical classifier and current managed-path gates leave ordinary Note
body, frontmatter, tags, History, LinkIndex, and Draft behavior structurally
isolated. New Diary creation already acquires structure then document locks
and emits an encrypted body through the D8.2 owner; a valid V1 date should be
a byte-preserving no-op. The planned mixed Note/Diary rules appropriately
avoid splitting shared history/tag-undo ownership.

Current tree/list and LinkIndex enumerate only `.md` documents and skip managed
body parsing; a reserved quarantine name without `.md` is not put into those
document lists. That is source-compatible, but the implementation must still
explicitly make the reserved pattern invisible to any watcher, metadata scan,
Git mutation path, or generic recovery branch. A dot prefix alone is not a
security boundary. No source evidence currently establishes a D8.4 watcher
owner, so this remains an implementation proof requirement.

The completion wording is directionally precise: an explicitly acknowledged
`NEEDS_ATTENTION` item remains visible and is included in the summary. It must
not be presented as “all plaintext removed,” especially for retained
quarantine, IDB rows, mixed SQLite rows, malformed bytes, and Git index/history
residuals. The omitted AI store in P1-4 currently prevents that guarantee from
being exhaustive.

## 15. API, state, error, and evidence audit

The listed `status`, `scan`, `start`, `resume`, and per-item `resolve`
endpoints have a useful baseline: authenticated application session,
`no-store`, structural responses, stable 400/401/404/409/422/423/503 classes,
and explicit unlock for body work. The server still has to parse and
reconstruct `itemKey` under the authenticated vault and current metadata; an
opaque client-supplied tuple cannot be authorization by itself.

Two contracts are not frozen enough for implementation:

* The `409 diary-migration-in-progress` behavior does not follow from the
  existing waiting document lock (P2-2).
* Run-level confirmation booleans are not bound to an immutable inventory,
  source generation, or auxiliary-store action (P1-3).

The plan also says “server restart at every hook” and “after every hook” for
the canary/evidence proof, but it never defines deterministic fault-injection
hooks or a process-kill mechanism for the boundaries in its own matrix. A
test that relies on sleeps/retry timing cannot prove the source-move,
publication, authenticated-readback, journal, SQLite, IDB, quarantine-unlink,
and `COMPLETE` crash cases. This is Finding `D8.4-IPR-P2-3`.

## 16. Findings

### D8.4-IPR-P1-1

**Severity:** P1 — High

**Title:** Locked startup cannot authenticate the published V1 target before the `PUBLISHED` ledger update

**Affected planning sections:** PRD §§9.1(10), 9.2, 15; Plan §§4 decisions 7–8, §5 transitions, §13 recovery, §19 failure matrix.

**Affected owners:** `server/diaryAccess/service.ts`, `server/diaryAccess/body.ts`, `server/prod.ts`, `server/vite-plugin.ts`, future `DiaryMigrationService.recover`.

**Frozen invariant violated:** The server-side Diary access service is the sole live DEK owner; a V1 envelope is authoritative only after AES-GCM/AAD authentication; after publication no recovery may restore plaintext or delete an unproven generation.

**Exact planning statements:** PRD §9.2 says the publication-to-ledger crash is recoverable by “inspecting only structural ownership plus the V1 envelope.” PRD §15 says “Journal and target prove phase” and recovery reconciles to `PUBLISHED`/`CLEANUP_PENDING`. Plan §13 says recovery validates “V1 envelope identity” without body access.

**Independent source evidence:** `DiaryAccessService` stores `dek` only in its in-memory capability map (`service.ts:96-103`) and reports `LOCKED` after restart without a capability (`404-412`). `parseEnvelope` only validates structure (`body.ts:93-121`); `decryptDiaryBody` needs the DEK to set AAD/tag and authenticate (`148-173`). Startup initializes auth and recovery but does not unlock Diary (`prod.ts:70-92`, `vite-plugin.ts:35-52`).

**Adversarial trace:** Move the source, publish and fsync ciphertext, then crash before the `PUBLISHED` journal/ledger write. On locked restart, recovery can compare names, inode data and envelope fields but cannot authenticate the tag or `vaultId` AAD. A syntactically valid V1-looking target inserted before recovery is indistinguishable from the authenticated target. Advancing permits unsafe cleanup; restoring plaintext risks overwriting a valid ciphertext target. Deferring is not specified.

**Impact:** The implementation engineer must invent a security-critical deferred/authenticated recovery rule at the exact filesystem/SQLite split. A false advance can authorize cleanup of the wrong generation; a false rollback can violate the monotonic no-plaintext rule.

**Why planned tests do or do not catch it:** The matrix includes locked startup and restart, but its expected result treats structural target inspection as phase proof and supplies no locked `ENVELOPE_CANDIDATE`/deferred state or post-unlock authentication test. Green planning CI cannot exercise unimplemented recovery.

**Required planning remediation:** Freeze a distinct unauthenticated/deferred recovery state and the post-unlock cryptographic reconciliation rule. Persist only non-secret provenance, block cleanup/normal mutation until authentication is available, and specify deterministic behavior for forged or replaced targets. Do not equate envelope parsing with authentication.

### D8.4-IPR-P1-2

**Severity:** P1 — High

**Title:** No single cross-platform primitive proves no-copy source ownership and create-only ciphertext publication

**Affected planning sections:** PRD §§9.1(4), 9.1(8–12), 9.2, 9.3, 15; Plan decisions 6, 8, 12, Workstream B §8, §18.

**Affected owners:** `server/paths.ts`, `server/atomicTextWrite.ts`, directory-identity helpers, future migration filesystem owner.

**Frozen invariant violated:** External generations always win; the migration may move/delete only the exact pre-existing source inode; ciphertext publication must never overwrite an occupied target; no copy+delete fallback may create a second plaintext body.

**Exact planning statements:** PRD §9.1(9–10) requires an immediate lstat comparison, a move “never a copy,” and “create-only link/rename.” Plan §8 requires `fs.open` with no-follow semantics, then “same-filesystem create-only link/rename ... where supported.”

**Independent source evidence:** `resolveSafeRelativePathDetailed`/`verifySafePathResolution` use path lstat and later re-lstat (`server/paths.ts:140-218`). `readSafeRelativeFile` uses `O_NOFOLLOW ?? 0` (`241-243`), which is no flag on Windows. The current create-only helper uses `fs.link` (`atomicTextWrite.ts:495-517`), while the existing recovery helper falls back to `fs.rename` when link fails (`669-708`); ordinary `rename` is not create-only. Directory fsync errors are swallowed (`632-642`), and the code documents a remaining pathname check/use window (`1233-1236`).

**Adversarial trace:** After the final lstat, an external writer replaces the source with a new file or junction. A pathname `rename` can move the unowned generation. If `fs.link` returns `EPERM`/`EOPNOTSUPP` and code falls back to rename, a target race can overwrite or claim the wrong path. Windows open-handle/antivirus behavior and unavailable directory fsync leave publication durability unresolved.

**Impact:** The stated no-copy/external-wins protocol is not deterministic across Linux, macOS and Windows and can lose an external generation or overwrite an unowned target if an implementer chooses the permissive fallback.

**Why planned tests do or do not catch it:** The plan requests Windows/link/rename tests, but does not specify the one permitted primitive, platform refusal, handle-relative ownership, or expected result for link failure, no-follow unavailability, and directory-fsync failure. A happy-path cross-platform job cannot prove the race boundary.

**Required planning remediation:** Select one create-only publication primitive and one source-move ownership proof. Define fail-closed behavior for unsupported filesystems/platforms, Windows junction/open-handle/AV races, cross-device errors and directory durability loss. The protocol must never fall back to a non-create-only rename or copy+delete path.

### D8.4-IPR-P1-3

**Severity:** P1 — High

**Title:** Run-level confirmations are not scoped to the inventory or generation they authorize

**Affected planning sections:** PRD §§7.1–7.3, 9.1(11–13), 14; Plan decisions 1, 19–20, §§5, 8–11, 14.

**Affected owners:** future `DiaryMigrationService`, migration ledger/API/UI, DraftStore bridge, SQLite cleanup owner.

**Frozen invariant violated:** No destructive source, Draft, IDB or private-state action occurs without explicit user consent for the exact current item/generation; typed confirmation is not ownership proof; new discoveries require new review.

**Exact planning statements:** PRD §7.1 stores `confirmMigration`, `confirmLegacyPrimaryRemoval` and `acknowledgeGitRetention` at run start. Plan §14 says `scan` refreshes an active run, while `resume` accepts only `{runId}` and the run-level booleans remain durable.

**Independent source evidence:** The proposed ledger has run-level confirmation columns but no inventory snapshot/version, generation confirmation, or action-specific confirmation record. Item `user_action` is not defined as a consent scope. Draft deletion is conditional, but primary removal and SQLite cleanup rely on the run contract.

**Adversarial trace:** User scans A and confirms all three booleans. Before completion, another tab or process creates legacy primary B, a new IDB family, or a new private SQLite exposure. A subsequent explicit scan refreshes the active run; `resume` can process B under A's legacy-primary-removal/cleanup acknowledgment even though B was never shown or confirmed. A changed source generation at A can receive the old removal consent as well.

**Impact:** A later-discovered or changed private generation can be destructively removed or its metadata cleared under stale consent, violating explicit UX and user-data preservation.

**Why planned tests do or do not catch it:** Rerun/idempotency and changed-family cases are listed, but no test asserts that post-confirmation rows/generations require a new consent scope. The typed discard test does not cover primary removal or auxiliary cleanup.

**Required planning remediation:** Bind every destructive action to an immutable reviewed inventory/generation snapshot and action scope. New or changed rows must remain attention/new-consent until explicitly reviewed; confirmation must not authorize a later path occupant, IDB family, or SQLite row.

### D8.4-IPR-P1-4

**Severity:** P1 — High

**Title:** Durable AI `sessions/messages` can retain legacy Diary plaintext but has no D8.4 inventory or disposition

**Affected planning sections:** PRD §§6, 11, 18–20; Plan §§3, 7, 10, 20–21.

**Affected owners:** `server/migrations/0001_ai_history.sql`, `server/ai/messages.ts`, `server/ai/chat.ts`, `server/ai/tools.ts`, future migration inventory/cleanup owner.

**Frozen invariant violated:** D8.4 completion must cover or explicitly surface every supported Nuvyn-controlled current private store; D8.3 blocks new managed Diary AI body reads but does not retroactively erase durable legacy state.

**Exact planning statements:** PRD §6 calls its table the “source-backed starting point” and PRD §18 guarantees that every supported Nuvyn-controlled auxiliary private store is migrated/cleaned or surfaced as `NEEDS_ATTENTION`. Plan §7 says to “inventory all SQLite private tables,” but its owner inventory names only migrations 0002–0011 and never specifies AI-history identity, cleanup, retention, or residual treatment.

**Independent source evidence:** `server/migrations/0001_ai_history.sql:1-14` creates durable `sessions` and `messages.content`. `server/ai/tools.ts:112-131,339-360` reads raw Markdown and serializes its content into a tool result. `server/ai/chat.ts:328-378,411-427` stores tool results in the assistant envelope in `messages.content`; `server/ai/messages.ts:175-234` reads and writes those rows. The current managed-Diary guard in `tools.ts:1207-1224` blocks new calls, not historical rows.

**Adversarial trace:** A pre-D8.3 AI turn reads `diary/2025-01-01` and persists its body in a tool-result envelope. D8.4 migrates the primary and listed metadata/History/IDB stores, but no workstream identifies or changes that `messages` row. The row remains a Nuvyn-controlled at-rest plaintext copy and is absent from the completion summary/residual list.

**Impact:** Final D8.4 closure can overstate current private-state coverage while a server SQLite store retains Diary plaintext. A later authenticated AI-history read can surface it even though current managed reads are blocked.

**Why planned tests do or do not catch it:** The SQLite canary language and generic “all private tables” wording do not define the expected pre-existing-AI-row outcome, ownership identity, or action. The test matrix has no `sessions/messages` fixture, inventory assertion, retention decision, or cleanup/retry proof.

**Required planning remediation:** Explicitly classify AI sessions/messages and the tool-result envelope in the authoritative inventory. Choose an identity-bound cleanup/retention/attention policy and update the completion guarantee, residual disclosure, API/UI, and tests accordingly. If it is intentionally outside D8.4, say so and weaken the “every auxiliary private store” claim; do not silently delete unrelated AI history.

### D8.4-IPR-P1-5

**Severity:** P1 — High

**Title:** `frontmatter_backup` cleanup has no safe contract for a managed row with `NULL` `document_id`

**Affected planning sections:** PRD §§6, 11–12, 14–15; Plan §§3, 10–11.

**Affected owners:** `server/metadataMigration.ts`, `server/frontmatterArchive.ts`, `server/documentMetadata.ts`, future SQLite cleanup transaction.

**Frozen invariant violated:** Destructive private-metadata cleanup must be identity-bound and must never use path-only equality across path reuse or mixed Note/Diary ownership; rollback material must remain until its owner is proven safe to clear.

**Exact planning statements:** PRD §12 says D8.4 identifies a row when canonical path and “optional `document_id`” match, but also says “the service never clears it by path-only equality.” Plan §11 says it queries “by exact path/document ID,” calls a mismatched/shared row attention, and gives no rule for `NULL` identity.

**Independent source evidence:** `metadata_migrations.document_id` is nullable in `server/migrations/0004_metadata_document_identity.sql:3-13`. `server/metadataMigration.ts:61-85` writes/upserts a row with `document?.id ?? null` and preserves the prior ID with `COALESCE`; a legacy row can therefore legitimately have `NULL`. Current `frontmatterArchive.ts:193-210` only updates with `WHERE path = ? AND document_id = ?`, demonstrating that the existing safe owner requires a non-null ID.

**Adversarial trace:** A legacy managed path has a `frontmatter_backup` row with `document_id=NULL`. The user adopts or recreates metadata for the same canonical path and the primary reaches `PUBLISHED`. If D8.4 accepts the “optional” ID, cleanup becomes `WHERE path=?` and clears the old row's only rollback backup; if it rejects the null row, the plan has no disposition and cannot meet its cleanup/attention contract. Path reuse makes the wrong-row deletion concrete.

**Impact:** A future implementation can silently destroy a still-needed rollback/private frontmatter record or invent a path-only exception that contradicts D8.3 identity rules.

**Why planned tests do or do not catch it:** The matrix mentions `frontmatter_backup` idempotency and hash mismatch, but does not include a null-document-ID managed row, path reuse, or the required safe attention result. Existing Note tests do not cover D8.4's managed cleanup owner.

**Required planning remediation:** Freeze the null-identity outcome (normally retain as `NEEDS_ATTENTION` until explicit identity adoption) and require a non-null, current document identity plus generation/rollback proof for every destructive update. State how adoption changes the row without path-only matching.

### D8.4-IPR-P2-1

**Severity:** P2 — Moderate

**Title:** Durable `source_generation_json.size` conflicts with the D8.3 body-length privacy boundary

**Affected planning sections:** PRD §§5–9, 16; Plan §§4 decision 4, §6 ledger, §7, §8.

**Affected owners:** migration ledger/status API, `server/paths.ts`, tree/list projection, SQLite canary/evidence owner.

**Frozen invariant violated:** Locked managed projections and durable D8.4 state must not expose body length or other body-derived private metadata; ledger fields are structural ownership only.

**Exact planning statements:** Plan §6 says generation JSON contains “regular-file type, device, inode, **size**, mtime/mtimeNs and directory identity.” PRD §9.1(4) captures byte size and PRD §7.1 says the workflow displays no body length. D8.3's carried-forward current projection explicitly marks body length private (PRD §5, lines 87-92).

**Independent source evidence:** The legacy source is a plaintext Markdown file, so `lstat.size` is its exact byte length; the V1 envelope's file size remains a body-length side channel. The current tree/list owner reads `fs.stat` and includes `size` (`server/tree.ts:154-180,255-267`), so “structural” cannot be assumed to mean non-sensitive without an explicit boundary.

**Adversarial trace:** A locked status/ledger inspection reveals `source_generation_json.size` for a legacy primary. The exact value distinguishes short/long private entries even though no body is returned. The implementation clears hashes but retains this durable body-derived value.

**Impact:** D8.4 introduces a new persistent privacy signal inconsistent with D8.3's locked projection and its own “no body-derived” ledger intent. A canary that searches only body strings will pass.

**Why planned tests do or do not catch it:** The test matrix checks forbidden values/body canaries and “no body hash,” but has no assertion that size is absent or treated as secret in ledger/status responses.

**Required planning remediation:** Decide explicitly whether size is private. If private, remove it from durable/locked migration state and use a non-body-derived ownership representation; if retained, amend the D8.3/D8.4 privacy contract and every locked response consistently. Do not leave the classification to implementation.

### D8.4-IPR-P2-2

**Severity:** P2 — Moderate

**Title:** Planned `409 diary-migration-in-progress` is not provided by the current document-lock owner

**Affected planning sections:** Plan §3 owner inventory, §8, §14.1–14.2; PRD §§9.1, 14.

**Affected owners:** `server/documentWriteLock.ts`, `server/vaultMutation.ts`, `server/routes/posts.ts`, future migration route/registry.

**Frozen invariant violated:** Migration and ordinary writes must have one deterministic lock/ownership contract; ordinary Note and Diary routes must not deadlock or silently wait when the API promises a stable migration conflict.

**Exact planning statement:** Plan §8 says normal `PUT /api/posts/:path` for the locked document “returns `409 diary-migration-in-progress` while the document lock is held.”

**Independent source evidence:** `withDocumentWriteLock` is an async FIFO queue that waits for the previous operation (`server/documentWriteLock.ts:39-73`); it has no owner identity or try-lock result. The managed PUT route acquires that lock inside `server/routes/posts.ts:363-370` and otherwise waits. `withVaultMutation` is a separate process-local queue (`server/vaultMutation.ts:48-73`).

**Adversarial trace:** D8.4 holds the document lock through source move/publication. A normal PUT for that path enters `withDocumentWriteLock`, waits, and eventually runs after migration; it cannot produce the promised 409. Adding a route-side migration check requires a new shared owner/registry and ordering rules, which the plan expressly says should not become a second global lock.

**Impact:** API clients cannot rely on the frozen status/error contract, and an ad hoc second gate could create lock-order deadlocks or cross-process races.

**Why planned tests do or do not catch it:** The plan lists concurrent API behavior but no owner-registration, non-blocking acquisition, cross-process, or lock-order test. Existing lock tests only prove queue serialization.

**Required planning remediation:** Freeze whether the API waits or rejects, then name the single migration ownership authority and its relationship to the existing queues/vault-writer ownership. Require route and service to observe the same ownership decision without a second conflicting lock.

### D8.4-IPR-P2-3

**Severity:** P2 — Moderate

**Title:** Crash matrix refers to undefined “hooks,” so deterministic durability evidence is not frozen

**Affected planning sections:** PRD §§15–16, 20; Plan §§15–19, 21.

**Affected owners:** future `DiaryMigrationService`, filesystem/journal/SQLite/IDB owners, crash-test harness.

**Frozen invariant violated:** Every durability boundary must be crash-tested deterministically, without sleeps or timing luck, and must converge to one safe state.

**Exact planning statements:** Plan §17.1 says “Server restart at every hook”; §17.2 says “After every hook, inspect ...”; §21 requires crash/restart proof. Neither the PRD nor Plan defines the hook names, injection API, child-process kill point, or expected observation for the boundary list in §19.

**Independent source evidence:** Existing repository code has owner-specific test hooks, but they are not D8.4 migration hooks. The plan's matrix distinguishes source move, target publish, fsync, authenticated readback, journal `PUBLISHED`, SQLite commit, IDB disposition, quarantine unlink and `COMPLETE`; no deterministic seam is specified for any of them.

**Adversarial trace:** An implementation test uses a sleep or kills a process opportunistically around publication. It cannot establish whether the syscall, fsync, authentication, or journal write happened, so the same test result can represent incompatible crash histories. The suite may report green while missing the locked publish/ledger gap.

**Impact:** The release gate's crash/idempotency claim would not be reproducible or strong enough to prove linearizable forward-only cleanup.

**Why planned tests do or do not catch it:** The test names are present, but an undefined “hook” is not an executable test contract. CI #598 is docs-only and supplies no D8.4 runtime evidence.

**Required planning remediation:** Define mandatory deterministic fault-injection seams and the observable durable state at each pre/post syscall boundary, including process-kill/restart behavior. Require evidence for each seam and forbid sleep-based inference.

## 17. P0 / P1 / P2 totals

```text
P0 = 0
P1 = 5
P2 = 3
```

No P0 finding was recorded because D8.4 production code does not exist yet and
the review found planning defects rather than an already-deployed bypass. The
P1 findings nevertheless block implementation approval because they leave
security-critical ownership, consent, recovery, and private-store contracts
to be invented by the implementation engineer.

## 18. Residual risks (not findings)

The following are intentionally retained or outside the planned guarantee and
are not findings by themselves:

- Local Git history, the current index, reflogs, reachable/unreachable objects,
  remote-tracking refs, remote clones and third-party backups retain whatever
  legacy plaintext they already contain under the explicit disclose-and-retain
  policy.
- Explicit PDF/clipboard exports, external editor copies, browser profiles,
  unlocked process memory and prior-release filesystem media remain outside
  secure-erasure guarantees.
- Valid V1 encrypted bytes are intended to be byte-preserving no-ops, and
  ordinary Note behavior is intended to remain unchanged.

These residuals must remain clearly distinguished from unresolved
Nuvyn-controlled current stores; P1-4 is about that distinction, not about
challenging the frozen Git-retention policy.

## 19. Verdict

```text
D8.4 Independent Planning Review = CHANGES REQUIRED (0/5/3)
```

The planning documents are not eligible for an approval sync until the five P1
and three P2 contracts above are resolved in a separate Planning Remediation
commit and independently re-reviewed. No D8.4 implementation work is
authorized by this document.

## 20. Lifecycle

```text
D8.4 Planning = REVIEW-READY / NOT APPROVED
D8.4 Independent Planning Review = CHANGES REQUIRED (0/5/3)
D8.4 Planning Remediation = REQUIRED
D8.4 implementation = NOT STARTED
D8.4 = NOT REVIEW-CLOSED
```
