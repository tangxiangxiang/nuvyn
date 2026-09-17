# D8 — Diary Encryption Implementation Plan

> **Historical implementation lineage — not current runtime authority.** Use
> [Diary Architecture](../architecture/diary.md) and [Diary User
> Guide](../user-guide/diary.md) for current behavior. This file records D8
> planning and review history; current encryption and migration behavior is
> described by the maintained Diary Architecture.

状态：`D8.0 REVIEW-CLOSED`；`D8.0 Self-review = PASS (P0/P1/P2 = 0/0/0)`；`D8.0 Independent Review = PASS (P0/P1/P2 = 0/0/0)`；`D8.1 REVIEW-CLOSED`；`D8.1 Independent Review = PASS (P0/P1/P2 = 0/0/0)`；`D8.2 REVIEW-CLOSED`；`D8.2 Self-review = PASS (P0/P1/P2 = 0/0/0)`；`D8.2 Independent Review = PASS (P0/P1/P2 = 0/0/0)`；`D8.3 original closure = REVIEW-CLOSED (historical)`；`D8.3 post-closure follow-up = IMPLEMENTED / REVIEW-READY`；`D8.3 independent follow-up review = NOT YET PERFORMED`；`D8.4 Planning = REVIEW-READY / NOT APPROVED`；`D8.4 Independent Planning Review = CHANGES REQUIRED (0/5/3) [historical]`；`D8.4 Planning Remediation Round 1 = COMPLETE`；`D8.4 Independent Planning Re-review = CHANGES REQUIRED (0/1/1) [historical]`；`D8.4 Planning Remediation Round 2 = COMPLETE`；`D8.4 Independent Planning Re-review Round 2 = CHANGES REQUIRED (0/1/0) [historical]`；`D8.4 Planning Remediation Round 3 = COMPLETE`；`D8.4 Independent Planning Re-review Round 3 = PENDING`；`D8.4 implementation = BLOCKED / NOT STARTED`。

基线：`1fb1389cab053d5ff72630253f509f0170e588c2`（`docs(diary): close D7 mood implementation`）。D7.0A、D7.0、D7.1、D7.2、D7.3、D7.4、D7.5、D7.6 均保持 `REVIEW-CLOSED`。D8 只从 Diary 加密边界开始，不重开 D7，也不创建独立 Private Vault。

## 1. Stage definition

D8 的目标是给现有 managed Diary 增加一个明确的 secondary-password privacy boundary，同时继续复用 D7 已关闭的 Calendar、Native Vault workspace、DocumentMetadata、tab、route 和 lifecycle owner。

```text
D8.0  Architecture / security-boundary verification
D8.1  Secondary password + Diary session foundation
D8.2  Encrypted Diary body read/write
D8.3  Privacy enforcement across existing lifecycle surfaces
D8.4  Migration, full regression, release and closure
```

本计划没有 D8.5 或其他未定义的后续阶段。D8.0 只完成当前行为取证与实现前约束；不实现加密、不实现解锁、不修改生产代码。

## 2. Product and security boundary

### 2.1 What D8 protects

- D8 生效后，新的 managed Diary body 在 D8 控制的静态磁盘和应用可恢复 durable storage 中只以密文持久化；
- 新的 managed Diary body revisions 完全不进入新的 vault Git commit，无论应用层 representation 是明文还是密文；
- legacy Git history 与 legacy external backups 可能继续包含旧 plaintext；D8 不宣称追溯删除、重写或保护这些 legacy copies；
- 未解锁时不能通过 Calendar、FileTree、route、persisted tabs、History、Recovery 或搜索间接拿到 Diary 正文；
- 解锁后仍使用现有 Native ReadingPane / EditorPane、单一 tab、现有 save/dirty/CAS/History/Recovery seam；
- Mood、日期、Diary 是否存在和稳定 document identity 继续由现有 SQLite DocumentMetadata owner 管理，不把 Mood 复制到正文加密层。

### 2.2 Threat model limits

D8 MVP 保护的是“没有 secondary password 的本地文件/数据库/Git 备份读取者”。它不承诺抵抗已经控制 Nuvyn server 进程、已经解锁的浏览器进程、浏览器开发者工具、用户主动复制/导出内容或操作系统已授权读写进程的攻击。解锁后的正文可以暂时存在于服务端/浏览器内存和 UI DOM 中，这是工作所需的 ephemeral plaintext；它不能被写进新的持久化 plaintext channel。

Primary Nuvyn login password、`NUVYN_MASTER_KEY`、`NUVYN_MASTER_KEY_FILE` 和 `data/.nuvyn-master-key` 都不等同于 Diary secondary password。现有 AI key encryption 是另一项 server-side credential 功能，不能直接复用其持久化密钥或作为 Diary 解锁凭据。

## 3. Frozen D7 contracts

以下 contract 在 D8 中继续有效：

| Contract | D8 policy |
| --- | --- |
| Diary identity | `diary/YYYY-MM-DD.md`，one date = one managed Diary document |
| Calendar ownership | Calendar 只负责日期导航和 Mood presentation；不创建第二套文档生命周期 |
| Native workspace | READ、EDIT、tab、Monaco、save、dirty、external conflict、History、Recovery 继续由 Vault owner 负责 |
| Metadata | SQLite `documents` 是 stable `documentId`、title/summary/tags、`mood`、`updated_at` 的现有 owner |
| Route / activePath | 仍不能因为 metadata 或 scope 自动打开 DOCUMENT；explicit intent 仍是打开条件 |
| FileTree | 继续是 generic tree/exact-context projection，不把 Diary policy 硬编码为 generic tree contract |
| Scope | Diary 是现有 scope 的一部分，但在 D8.1 起只有已建立的 Diary unlock session 才能进入正文可见状态 |
| History / Recovery | 不创建 Diary 专属 dialog/lifecycle；Note History 保持不变；D8 生效后的 managed Diary body 不进入新的 Git History，直到有单独批准的非 Git 加密历史方案；未覆盖时 fail closed |

D7 的 Git-backed Diary History 在旧 contract 下是正确的；D8 只为 managed Diary 引入新的 privacy contract：D8 生效后新的 Diary 正文 revision 无论是明文还是密文，都不得进入新的 vault Git commit。这个有意 supersede D7 Diary body History 的决定不重开 D7；新的非 Git 加密正文历史若需要，必须另行设计、批准并指定 owner。

## 4. Current ownership and plaintext graph

D8.0 取证详情记录在 [D8.0 architecture verification](./diary-encryption-d8.0-architecture-verification.md)。实现计划必须覆盖完整 body graph，而不是只包住 `PUT /api/posts`：

| Area | Current owner / seam | D8 required disposition |
| --- | --- | --- |
| Primary body read | `GET /api/posts/*` → `fs.readFile` → `gray-matter` | 由 Diary storage adapter 读取并认证解密；locked 请求 fail closed |
| Primary body write | `PUT /api/posts/*` → `readStableTextSnapshot` / `prepareAtomicTextWrite` | compare plaintext in memory, pass ciphertext bytes to atomic durable writer |
| Diary create | `POST /api/diary/dates` | create plaintext only in memory, persist encrypted envelope, return plaintext only to authorized unlocked caller |
| Recovery create | `PUT /api/recover/*` | encrypted Diary adapter required; no plaintext recovery payload on disk |
| Rename / folder move | generic document lifecycle and reference rewrite | opaque ciphertext may move only with identity proof; any reference rewrite must decrypt/re-encrypt transactionally or be rejected for managed Diary |
| History | nested vault Git and `/api/history/*` | D8 生效后的 managed Diary body 完全排除在新的 Git commit 之外；现有 legacy plaintext History 只作 legacy exposure 处理，不自动 rewrite/purge；新的 Diary body History 暂停/不可用，直到单独批准的非 Git 加密历史 owner 存在 |
| Draft / Recovery | browser IndexedDB `drafts` / `draftConflicts` | no plaintext managed-Diary body in IndexedDB; MVP may disable persistent Diary draft/recovery until encrypted adapter exists |
| Search | `primeBody()` and module `bodyCache` | exclude locked Diary; after unlock use a bounded, memory-only adapter and clear on lock |
| Link index | server `LinkIndex` reads every `.md` and stores links/title | generic index must not parse ciphertext as Markdown or retain decrypted Diary links after lock |
| Tree/list | `walk`, `readFrontmatter`, `listPostsFlat`, `buildTree` | use an explicit SQLite structural Diary projection; never parse encrypted bytes as frontmatter/body |
| Atomic temp/staging | `.nuvyn-save-*`, `.nuvyn-staged-*`, rename/reference payloads | only ciphertext may reach durable temp/staging/payload APIs; journal metadata may contain hashes/identity, never body |
| UI and export | tab raw, Monaco, ReadingPane, diff/confirm, PDF | ephemeral plaintext only while authorized; lock clears/invalidates Diary views; explicit PDF/clipboard export remains a user-created copy and is outside automatic D8 storage control |

## 5. Recommended target architecture

### 5.1 One logical document, one storage adapter

Keep the logical path and stable identity unchanged. Add one Diary-aware storage adapter below the route/lifecycle layer and above filesystem/Git primitives. The adapter owns:

1. envelope detection and authenticated decrypt on reads;
2. plaintext-to-envelope encryption before any durable write;
3. body hash/CAS comparison in memory;
4. encrypted representation for create, save, recovery and any approved rename/move transaction; enforce managed-Diary exclusion at the History/Git mutation owner rather than storing Diary body revisions in Git;
5. fail-closed behavior for unknown envelope versions, invalid authentication tags, missing identity binding and locked sessions.

The adapter must be the only route into a managed Diary body. A caller must not choose between raw `fs.readFile` and the adapter based on a loose `startsWith('diary/')`; it must use the already normalized logical path and the shared `classifyDiaryPath()` authority.

Generic ordinary Note behavior remains unchanged. Generic structural code may see a Diary path and the SQLite structural projection, but it must never treat encrypted bytes as Markdown.

### 5.2 Key hierarchy and runtime owner

Recommended minimal construction:

- D8.1 creates a random 256-bit Diary data-encryption key (DEK) and wraps it with a key-encryption key (KEK) derived from the secondary password. The wrapped DEK, KDF parameters, salt, format version and verifier metadata are not plaintext body and may live in the existing metadata authority only after a schema/ownership review.
- Use a versioned, bounded KDF. The existing Node `scrypt` implementation is an available vetted building block (`server/auth/password.ts`), but Diary must use its own salt/context and must not reuse the primary auth password hash. Argon2id is an alternative only if the runtime/dependency decision is explicitly approved; D8.0 adds no dependency.
- Use an AEAD such as AES-256-GCM with a fresh random 96-bit nonce per write and a verified 128-bit authentication tag. The envelope must carry an explicit version/algorithm identifier and reject unknown versions before returning body bytes.
- Bind authenticated associated data to the vault identity, stable `documentId`, canonical logical path and envelope version. Any path change therefore must be an explicit re-encryption/identity transaction, never a generic ciphertext move that silently changes the binding.
- `useDiaryLockSession` (name illustrative) is the single client-facing session state owner. A server-side `DiaryCryptoSession`/service is the single crypto/storage capability owner. Calendar, FileTree, VaultView, History and Recovery receive read-only capability/state; they do not hold independent password booleans or keys.
- Password, unwrapped DEK and decrypted body exist only in the current application/server session memory. Do not place them in `localStorage`, `sessionStorage`, IndexedDB, SQLite, Git, URL/query parameters, logs, telemetry or error messages.

This server-side adapter is the minimal direction because the current server already owns file I/O, atomic writes, History, metadata, and recovery. It protects at-rest vault files without replacing the Native workspace. If the deployment threat model requires the server process itself to be unable to decrypt, D8.1 must stop and explicitly select a client-side Web Crypto design; that is a materially larger API/search/history change and is not implicit in this plan.

### 5.3 Envelope and durable representation

The exact wire encoding is a D8.2 implementation decision, but it must satisfy this contract:

```text
versioned envelope
  algorithm = approved AEAD
  key reference / identity binding = stable document identity
  nonce = unique per write
  ciphertext + authentication tag = body bytes only
```

The physical file may retain the logical `.md` path for compatibility, but its bytes must be unambiguously opaque to generic Markdown readers. A plaintext fallback must not be silently accepted after migration. Unknown/newer envelopes fail closed before any body mutation. The encrypted envelope is a file representation only; it is not permission to add managed Diary body revisions to a new vault Git commit.

### 5.4 Metadata and Mood separation

Calendar needs a small structural projection: canonical date/path, existence, stable document identity, and Mood state. D8 does not move Mood into the body envelope and does not save an SVG path or decrypted body in `documents.mood`.

The existing `documents` SQLite row remains the single live metadata owner. Title/summary/tags must be classified as privacy-sensitive metadata during D8.1; if they are not required by the locked Calendar/tree surface, the locked projection must not expose them. Existing `metadata_migrations.frontmatter_backup` is a potential plaintext metadata retention path and must not become a hidden Diary body/metadata backup. D8.4 migration must classify, preserve, encrypt or remove it according to the selected metadata policy before release closure.

## 6. Scope, startup and transactional unlock

The current `activeScope` is a module-level `ScopeKey | null` persisted in `localStorage`, and the current tab persistence stores paths/active path without knowing whether a path is Diary. That is not a sufficient privacy gate. D8.1 must replace the nullable toggle semantics with the following frozen target contract:

```ts
type ScopeKey = 'note' | 'diary' | 'ledger'
activeScope: ScopeKey
```

`activeScope` is always exactly one of `note`, `diary` or `ledger`; `null` and a fourth neutral scope are forbidden. Selecting the already-selected scope is a NO-OP. The public operation is selection (`selectScope(scope)` / `requestScopeChange(scope)`), not toggle/deselection.

D8.1 must establish the lock/session state machine at application-shell scope, above `VaultView` because `NavBar` is also above `RouterView`:

```text
UNINITIALIZED
  ├─ Diary request ─► password setup ─► generate DEK / wrap DEK
  │                                  └─► establish UNLOCKED(sessionEpoch)
  ├─ cancel/setup failure ─► UNINITIALIZED
  └─ no scope change, no migration

LOCKED
  ├─ unlock request ─► UNLOCKING ─► UNLOCKED(sessionEpoch)
  ├─ invalid password ─► LOCKED
  └─ lock / logout / expiry ─► LOCKING ─► LOCKED
```

First use is distinct from verification of an existing installation. `UNINITIALIZED` remains the state until the user requests Diary, completes secondary-password setup, derives the approved KEK, generates a random Diary DEK, wraps it, persists only approved wrapped-key/KDF metadata, and establishes the first in-memory unlocked capability/session epoch. Only after that successful setup may authorized legacy plaintext migration run. Cancel or setup failure leaves `activeScope` unchanged, remains `UNINITIALIZED`, performs no body migration and leaves no partial durable success state. An initialized installation starts `LOCKED` on every application/session restart; successful password verification reaches `UNLOCKED(sessionEpoch)`.

Required scope and startup rules:

- `requestScopeChange('diary')` authenticates or initializes first; only successful setup/unlock may commit `activeScope = 'diary'`.
- Wrong password or cancellation leaves the current selected scope, route, tabs and presentation unchanged. `activeScope === 'diary'` implies an active `UNLOCKED` Diary session.
- A persisted `activeScope = 'diary'` on a new application session is normalized and persisted to `note` before Diary content is mounted. It does not fetch/restore Diary body; explicit Diary intent later opens the unlock/setup flow. Persisted `note` and `ledger` retain ordinary behavior.
- Do not restore/open persisted managed-Diary tabs or Diary deep links until the unlock capability is established. Ordinary Note tab restore may proceed independently, but the persisted tab list must be filtered before any Diary `getPost`/body fetch.
- A locked Diary deep link shows the unlock surface and does not fetch, decrypt, render or search body bytes.
- lock/logout/expiry invalidates the session epoch, clears Diary body views/models/caches, prevents late async results from rehydrating a tab, and returns to `note`.
- The unlock/lock operation is serialized with body reads/writes. A body transaction captures the current epoch; lock either waits for its durable encrypted commit or aborts before mutation. A stale capability cannot commit after lock.

## 7. Phase plan and gates

### D8.0 — Architecture / security-boundary verification

Scope: source-backed read/write graph, plaintext persistence audit, scope/startup audit, crypto/runtime inventory, migration policy, Mood separation and STOP conditions.

Deliverables: this implementation plan and the evidence document. No production encryption, no unlock UI, no schema migration, no dependency change, no D8.1 work.

Exit gate: every current body path has an owner and target disposition; no key reuse is implied; startup and draft/history boundaries are explicit; D8.1–D8.4 remain `NOT STARTED`.

### D8.1 — Secondary password + Diary session foundation

Scope: one shell-level lock/session owner, persisted locked/unlocked semantics, scope gate, deep-link gate, tab-restore quarantine, session epoch and capability invalidation.

Must not yet claim encrypted body storage is complete. Exit requires no managed-Diary body GET/restore before unlock and no persistent key material.

### D8.2 — Encrypted body read/write

Scope: versioned envelope, key wrapping, authenticated read/write, Diary create/save/recover, atomic ciphertext temp/staging, identity/CAS handling and negative tests for tamper/unknown version/wrong key.

Exit requires that the primary file, save temp, staged generation and recovery payload never contain requested plaintext body. Existing ordinary Note save semantics must remain unchanged.

### D8.3 — Privacy enforcement across existing lifecycle surfaces

Scope: History/Git, Recovery/Draft, search/body cache, LinkIndex, tree/list, rename/folder moves, external conflict, PDF/clipboard policy, logs and lock teardown.

Exit requires every surfaced Diary body path to use the adapter or fail closed, every persistent/plaintext cache path to be either encrypted, disabled for Diary, or explicitly outside the automatic storage guarantee with user-visible semantics, and the actual History/Git mutation owner to exclude new managed-Diary body revisions entirely.

### D8.4 — Migration, full regression, release and closure

Scope: idempotent plaintext-to-envelope migration, legacy History policy, metadata cleanup/classification, rollback/recovery proof, full D7 regression, responsive/a11y regression, CI, complete evidence and separate docs-only closure. Rekey/password change remains out of scope.

Exit requires every Nuvyn-controlled current private store to be resolved/cleaned, valid-encrypted no-op, policy-retained or explicit attention (not an unreviewed legacy-plaintext claim), and an independent review followed by a separate closure commit. D8 overall is not closed by an implementation/evidence commit.

## 8. Migration and compatibility policy

Migration must be explicit and fail closed:

| Existing state | D8 policy |
| --- | --- |
| plaintext canonical Diary file with live identity | prepare/authenticate one ciphertext-only candidate after unlock; Windows may use `AUTOMATIC_HANDLE_BOUND`, Linux/macOS stop at `USER_FINALIZE_REQUIRED` and perform no Nuvyn plaintext rename/delete; verify exact candidate identity before `PUBLISHED`; disclose external backups |
| plaintext body in existing browser Draft/Recovery stores | do not auto-read into a locked session; offer an explicit user-authorized migration or discard path; never copy it into a new plaintext store |
| plaintext Diary in nested Git history | classify as legacy exposure; do not claim retroactive purge or silently rewrite/delete it. New managed-Diary body revisions must not enter Git at all; any history rewrite/purge needs an explicit user-controlled operation and backup policy |
| encrypted envelope with supported version | verify tag, identity binding and metadata association before exposing body |
| unknown/newer/corrupt envelope | fail closed before body mutation; preserve evidence for repair, never guess a plaintext format |
| missing file or missing stable generation | retain D7 identity rules; do not create a path-only encrypted identity during migration |

The migration must be resumable and idempotent per stable document identity. A failed migration must not leave a success-looking metadata status while the file remains plaintext. Existing plaintext is not retroactively erased by D8.0 documentation; D8.4 must state exactly what the user opted into and what legacy copies remain.

### 8.1 D8.4 planning-remediation constraints

The D8.4 planning entry point is governed by the companion PRD and Plan. The
current Round-3 contract is platform-real and docs-only:

```text
Windows supported handle/reparse/sharing/durability contract
    -> AUTOMATIC_HANDLE_BOUND
Linux/macOS supported stock filesystem
    -> USER_FINALIZE_REQUIRED
Candidate durability/authentication unavailable
    -> UNSUPPORTED
Windows guarantee lost at runtime
    -> USER_FINALIZE_REQUIRED (never pathname fallback)
```

Nuvyn guarantees race-safe behavior only for mutations it performs. Linux and
macOS public namespace APIs select a source by parent/directory fd plus
pathname; observation or reopening by handle does not add a captured-source
conditional rename/unlink primitive. Nuvyn therefore creates and authenticates
one same-filesystem ciphertext-only candidate, proves candidate/file/parent
durability, and stops before destructive plaintext namespace mutation. It
never claims a missing kernel CAS primitive, and it never replaces the
decision with a userspace helper, pathname revalidation, advisory lock,
watcher or timing retry.

The POSIX item state is exactly `USER_FINALIZE_REQUIRED` with stable API code
`diary-migration-user-finalize-required` (HTTP 409). The legacy canonical
plaintext remains authoritative; body display while locked, managed-Diary
search/AI/History/LinkIndex and automatic save remain blocked. The candidate
`.nuvyn-diary-migration-ciphertext-<transactionId>` is ciphertext-only,
same-filesystem, excluded from projections and safe across restart. Resume
performs no POSIX rename/unlink/replace: it verifies canonical regular safe
path, exact candidate fingerprint, vault/document/path AAD authentication and
durability, then may write `PUBLISHED`. Different plaintext generation is
`CONSENT_REQUIRED`; different encrypted bytes, malformed/unknown, missing or
unsafe canonical state are exact attention codes. A new inode after external
replacement is expected; same-inode continuity is not required.

The explicit user procedure requires stopping Nuvyn body mutation, closing
external editors/sync writers, replacing the canonical file with the prepared
candidate using the documented OS operation, disclosing any retained plaintext
copy, and resuming verification. Nuvyn never asks for envelope editing/body
copying or executes `mv`/`rename`/`rm` for the user. A user-moved backup is
`USER_CONTROLLED_PLAINTEXT_RESIDUAL`; Nuvyn never claims to erase or auto-delete
it. If a stale candidate was installed after an unobserved external writer,
Nuvyn can authenticate only the resulting bytes and discloses that residual
limitation.

Windows retains the real captured-handle `SetFileInformationByHandle` source
operation, fail-if-exists publication, reparse/sharing and durability rules.
If those guarantees are unavailable, it falls back to `USER_FINALIZE_REQUIRED`.

The authoritative 19-hook crash oracle remains closed under P2-3. All 19 hooks
remain exact for automatic Windows finalize and SQLite/IDB cleanup. POSIX
candidate preparation uses the applicable journal/candidate-durability hooks;
post-user verification uses readback/journal/cleanup hooks. Automatic source-
transition, ciphertext-publication and plaintext-quarantine hooks are not
applicable on POSIX and are not simulated around the external user action.

## 9. STOP conditions

Stop before the next phase if any of these occur:

- a managed-Diary body can reach `fs.writeFile`, atomic temp/staging, rename-reference payload, Git commit, IndexedDB Draft/Recovery, server LinkIndex or browser search cache as plaintext;
- a locked route/scope/tab restore can fetch or render Diary body;
- a component owns a second unlock/key/session state;
- a save/restore/History operation cannot bind ciphertext to stable identity and generation;
- a generic parser receives encrypted bytes as if they were Markdown and derives title/links/search data from them;
- unknown envelope versions/tags/identity mismatch are tolerated or followed by body mutation;
- password/decrypted DEK is persisted or reused from primary auth/AI key material;
- migration would silently delete legacy copies or claim existing plaintext Git history was purged;
- D8 implementation would require a new Reader/Editor/Dialog or would change ordinary Note semantics without a separately reviewed contract.

## 10. Acceptance criteria for D8.0

- [x] D7 baseline and closed architecture boundaries are recorded.
- [x] Current primary read/write, create, recover, rename/move, History and metadata seams are mapped.
- [x] Current plaintext persistence/leakage paths include disk, Git, IndexedDB, search, LinkIndex, temp/staging, UI and export handling.
- [x] A single recommended crypto/runtime owner and a separate secondary-password/key hierarchy are documented.
- [x] Scope, startup, persisted tabs, deep links and transactional lock invalidation requirements are explicit.
- [x] New D8 managed-Diary body is excluded from Git commits entirely; Note History remains unchanged and legacy Diary Git history has a non-destructive policy.
- [x] `UNINITIALIZED` / `LOCKED` / `UNLOCKED` semantics, first-use setup ordering and migration ordering are frozen.
- [x] `activeScope` is exactly one of `note` / `diary` / `ledger`; current-scope selection is a NO-OP; locked persisted Diary startup normalizes to `note`; `activeScope === 'diary'` implies `UNLOCKED`.
- [x] Migration, legacy History, unknown envelope and mixed-state STOP policies are explicit.
- [x] No production code, tests, dependencies, migration or D8.1 implementation was started.

## 11. D8.0 Independent Review remediation record

The first independent review identified three documentation contract findings. This remediation changes only the canonical plan; it does not claim independent review approval:

```text
D8.0-IR-P1-1  Git / History contract drift       = REMEDIATED
D8.0-IR-P1-2  Missing UNINITIALIZED first-use    = REMEDIATED
D8.0-IR-P2-1  Incomplete exactly-one scope       = REMEDIATED
```

At the remediation checkpoint, the resulting self-review was `P0/P1/P2 = 0/0/0` and independent re-review remained pending.

A subsequent residual wording review identified two further documentation findings. This cleanup changes only the two D8.0 documents and does not claim independent review approval:

```text
D8.0-IR-P2-2  Legacy Git security-boundary wording  = REMEDIATED
D8.0-IR-P2-3  Mood encryption lifecycle wording      = REMEDIATED
```

At the cleanup checkpoint, self-review remained `P0/P1/P2 = 0/0/0` and independent re-review remained pending.

## 12. D8.0 closure record

The independent re-review verified the remediation at `cc2d6df0c92a3e85962a605ed6674e39bb6b031d` and passed with no remaining findings:

```text
D8.0 Independent Re-review = PASS
D8.0 Independent Review P0/P1/P2 = 0/0/0
```

This closure sync changes only the D8.0 lifecycle state. It does not start D8.1 or change production code, tests or dependencies.

## 13. Current lifecycle

```text
D7.0A–D7.6       = REVIEW-CLOSED
D8 overall        = IN PROGRESS
D8.0              = REVIEW-CLOSED
D8.0 Self-review  = PASS (0/0/0)
D8.0 Independent Review = PASS (0/0/0)
D8.1             = REVIEW-CLOSED
D8.2             = REVIEW-CLOSED
D8.2 Self-review = PASS (0/0/0)
D8.2 Independent Review = PASS (0/0/0)
D8.2 closure     = REVIEW-CLOSED
D8.3 Planning    = APPROVED
D8.3 implementation = COMPLETE
D8.3 Self-review = PASS (0/0/0)
D8.3 Independent Review = CHANGES REQUIRED (0/2/0) [historical]
D8.3 remediation = COMPLETE
D8.3 Independent Re-review = PASS (0/0/0)
D8.3-IR-P1-1 = CLOSED
D8.3-IR-P1-2 = CLOSED
D8.3             = REVIEW-CLOSED
D8.4 Planning    = REVIEW-READY / NOT APPROVED
D8.4 Independent Planning Review = CHANGES REQUIRED (0/5/3) [historical]
D8.4 Planning Remediation Round 1 = COMPLETE
D8.4 Independent Planning Re-review = CHANGES REQUIRED (0/1/1) [historical]
D8.4 Planning Remediation Round 2 = COMPLETE
D8.4 Independent Planning Re-review Round 2 = CHANGES REQUIRED (0/1/0) [historical]
D8.4 Planning Remediation Round 3 = COMPLETE
D8.4 Independent Planning Re-review Round 3 = PENDING
D8.4 implementation = BLOCKED / NOT STARTED
D8.4             = NOT REVIEW-CLOSED
```

The canonical D8.3 entry point is now the final closure record below. The
earlier D8.2 boundary and D8.3 planning/implementation documents remain
historical checkpoints; they are not rewritten to erase their creation-time
states.

## 14. D8.3 final closure record

This docs-only synchronization records the already-completed implementation,
independent review, remediation, and independent re-review chain. It changes
the authoritative current lifecycle to `D8.3 = REVIEW-CLOSED`; it does not
change production code, tests, dependencies, CI configuration, or the D8.3
product/security contract.

```text
D8.3 — REVIEW-CLOSED

Planning:
APPROVED
Planning remediation baseline: 99f693b02080127c16911869c17edcb2fa38fe3c

Implementation:
584cf770111bc2f5ee86be08ecda7ea50586bc87
Final original implementation checkpoint:
6308947cd6fd758cd6055a687a1d4e49891a5e2c
CI #592 / 33369599249 / attempt 1 / 8/8 PASS

Independent Review:
CHANGES REQUIRED (P0/P1/P2 = 0/2/0) [historical]
Review evidence: 50683a4ed46b57a7159ee6c6151f9efd26809d9c

Remediation:
b49b51d5a56608479f0b46086eef739d77308d20
CI #594 / 33378116031 / attempt 1 / 8/8 PASS
Remediation evidence:
8e346c776d6f11152e58f0106836f252306aa77a

Independent Re-review:
PASS (P0/P1/P2 = 0/0/0)
D8.3-IR-P1-1 = CLOSED
D8.3-IR-P1-2 = CLOSED
Re-review evidence:
1a8ef24ce32a7f7185ef8de25897680ca6b17c20
Re-review evidence CI:
#596 / 33388268886 / attempt 1 / 8/8 PASS

Final lifecycle:
D8.3 = REVIEW-CLOSED
D8.4 = NOT STARTED
```

The historical Independent Review remains `CHANGES REQUIRED (0/2/0)`; the
later Independent Re-review is the separate `PASS (0/0/0)` event. That closure
record remains historical. The post-closure direct managed-document delete
follow-up is a separate `IMPLEMENTED / REVIEW-READY` checkpoint and has not
received an independent follow-up review. Legacy plaintext migration, legacy
Git/history cleanup, legacy Draft/Recovery cleanup, SQLite private-metadata
cleanup, mixed-state migration, migration rollback/idempotency, and
release/migration closure remain D8.4 scope. Intentional D8.3 feature
degradations remain in force for managed generic History, persistent
Draft/Recovery, body search, body-derived LinkIndex projections, managed
rename/move, folder/bulk delete, and managed body AI surfaces; direct managed
document delete is owned by the follow-up.

## 14.1 D8.3 post-closure follow-up checkpoint

The current D8.3 follow-up is implementation-complete and review-ready, but it
does not reopen or rewrite the historical independent review/re-review records.
It adds the adapter-aware opaque direct managed-Diary delete owner, filters
managed physical Diary paths from History Changes discovery, and hides the
unsupported file-History TreeRow capability. History log/file/diff/restore/
content-hashes/commit guards remain fail-closed. The follow-up evidence and
exact test/CI limitations are recorded in
[diary-encryption-d8.3-post-closure-followup.md](./diary-encryption-d8.3-post-closure-followup.md).

```text
D8.3 original closure:          REVIEW-CLOSED (historical)
D8.3 post-closure follow-up:    IMPLEMENTED / REVIEW-READY
Independent follow-up review:   NOT YET PERFORMED
Starting HEAD:                  fec4860488ba5c032931ec62d15e07ea09971e59
Implementation/Test commit:     e895217956577b69c627a7a640202bcbc8ba153a
Evidence/Docs commit:            recorded by the follow-up docs commit
D8.4:                            NOT REVIEW-CLOSED / NOT STARTED
```

## 15. D8.4 planning entry point

The D8.4 Planning PRD and Implementation Plan are the current entry point for
the final planned phase. Their historical planning baseline was the exact
closure commit `c88e99554c291181c6e3f17e695aa228f34d40b2`; subsequent
remediation/review commits remain docs-only and do not imply Planning approval
or implementation:

```text
D8.4 Planning = REVIEW-READY / NOT APPROVED
D8.4 Independent Planning Review = CHANGES REQUIRED (0/5/3) [historical]
D8.4 Planning Remediation Round 1 = COMPLETE
D8.4 Independent Planning Re-review = CHANGES REQUIRED (0/1/1) [historical]
D8.4 Planning Remediation Round 2 = COMPLETE
D8.4 Independent Planning Re-review Round 2 = CHANGES REQUIRED (0/1/0) [historical]
D8.4 Planning Remediation Round 3 = COMPLETE
D8.4 Independent Planning Re-review Round 3 = PENDING
D8.4 implementation = BLOCKED / NOT STARTED
D8.4 = NOT REVIEW-CLOSED
```

See [D8.4 Migration, Legacy Cleanup & Release Closure PRD](./diary-encryption-d8.4-migration-release-prd.md)
and [D8.4 Implementation Plan](./diary-encryption-d8.4-implementation-plan.md).
The historical Independent Planning Review at
`9f8d06d1f0dd2223dfc2ccc3d313f4a30053c386` returned
`CHANGES REQUIRED (0/5/3)`. The subsequent independent re-review record at
`1be58a317c121a5fd676cd709174de7fbb6b72b7` returned
`CHANGES REQUIRED (0/1/1)`. The docs-only Planning Remediation Round 3 now
replaces the impossible POSIX automatic exact-source mutation with a platform
capability model: `AUTOMATIC_HANDLE_BOUND` on supported Windows,
`USER_FINALIZE_REQUIRED` on supported Linux/macOS, and `UNSUPPORTED` only when
safe candidate durability is unavailable. It retains the 19-hook crash oracle
and all closed D8.4 findings, does not alter either historical review record
or authorize implementation, and requires a separate D8.4 Independent
Planning Re-review Round 3. The next authorized action is that re-review.
