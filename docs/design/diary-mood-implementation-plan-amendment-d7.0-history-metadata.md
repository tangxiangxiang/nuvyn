# D7 Implementation Plan Amendment — D7.0A Generic History Metadata Revision Foundation

> **Historical lineage — not current runtime authority.** Current behavior is
> defined by [Diary Architecture](../architecture/diary.md) and [Diary User
> Guide](../user-guide/diary.md). This file is retained for D7 traceability.

状态：**REVIEW-CLOSED**
Independent Review：`PASS (0/0/0)`
日期：2026-08-26（Asia/Shanghai）
Starting HEAD：`b1b0fd39517862b1f1f6f1206c7410516fbdfd12`

本文件是 D7 Implementation Plan 的独立 **docs-only plan amendment**。它只为
D7.0 已确认的 generic History metadata revision blocker 增加合法的 remediation
phase；本文件本身不实现 D7.0A，也不实现 Mood。

## 1. Title and status

```text
D7 Implementation Plan Amendment
Generic History Metadata Revision / Restore Foundation

Amendment                  = REVIEW-CLOSED
Amendment Independent Review = PASS (P0/P1/P2 = 0/0/0)
D7.0                       = BLOCKED
D7.0 Independent Review    = PASS on the BLOCKED determination
D7.0A                      = NOT STARTED
D7.1                       = NOT STARTED
D7 Mood production         = NOT STARTED
```

D7 PRD 与原 D7 Implementation Plan 仍为 `REVIEW-CLOSED`。Amendment review
已通过并关闭；D7.0A 仍须独立执行、复审和关闭；这不是把 D7.0 直接改成通过，
也不是绕过 predecessor gate 进入 D7.1。

## 2. Starting HEAD and scope

本 Amendment 以当前真实仓库为准，基线为：

```text
b1b0fd39517862b1f1f6f1206c7410516fbdfd12
docs(diary): record D7.0 metadata ownership evidence
```

本轮只规划一个 generic production remediation phase，并同步两个现有 evidence
文档的指针/状态。不会在本轮修改 production code、tests、PRD、package、lockfile
或 dependencies。

允许的文档：

- `docs/design/diary-mood-implementation-plan-amendment-d7.0-history-metadata.md`
- `docs/design/diary-mood-implementation-plan.md`（最小 amendment pointer）
- `docs/design/diary-mood-d7.0-storage-metadata-verification.md`（最小 review/link sync）

## 3. Background and confirmed D7.0 blocker

D7.0 的 characterization 已证明：当前 metadata owner 是 SQLite
`documents`/`document_tags`，而不是 Markdown frontmatter；当前
`DocumentMetadata` 只有 `id`、`path`、`title`、`summary`、`tags`、`createdAt`、
`updatedAt`，尚无 `mood`。

当前 History Restore 对已有文件的真实链路是：

```text
resolve Git ref
→ read historical Markdown raw
→ ensure current SQLite metadata row
→ atomic replace current file bytes
→ recordCommittedDocumentMutation()
```

`recordCommittedDocumentMutation()` 对已有 row 只推进当前 `updatedAt`，不会从
历史 raw 重建或恢复 SQLite metadata。现有 rollback snapshot 是本次 mutation
之前的补偿快照，也不是 Git revision metadata snapshot。

当前 History commit 的真实链路是：

```text
saveSelected()
→ POST /api/history/content-hashes
→ POST /api/history/commits
→ git.addAndCommit()
```

server 目前只把选定的 working-tree bytes 交给 Git；没有 capture generic metadata
snapshot，也没有把 SQLite revision 与 resolved commit SHA 绑定。

当前 Recovery 的 `UnsavedDraft` / `DraftConflictRecord` 只保存正文 content、
baseline/hash/mtime、path 和 stable document identity，不保存 title、summary、
tags 或未来 mood 的 metadata snapshot。因此 Recovery 只能是 body draft recovery，
不能被误写成 metadata revision restore。

这构成唯一的 D7.0 P1 architecture blocker：如果现在把 Mood 写入 SQLite，选择
旧 History revision 后 body 与 metadata 可能来自不同 revision；而原 Plan 没有
承载 generic History extension 的 production phase。D7.4 已冻结为 regression /
verification phase，不能偷偷承载该缺失实现。

## 4. Why this Plan Amendment is required

合法生命周期必须是：

```text
D7.0 = BLOCKED
  ↓
D7 Implementation Plan Amendment = REVIEW-CLOSED
  ↓
D7.0A = NOT STARTED → IN PROGRESS → REVIEW-READY
  ↓
D7.0A Independent Review → REVIEW-CLOSED
  ↓
D7.0 Revalidation
  ↓
D7.0 = REVIEW-READY → Independent Review → REVIEW-CLOSED
  ↓
D7.1
```

Amendment review 通过本身只表示计划缺口已被合法承载。它不改变 D7.0 的
`BLOCKED`，也不授权 D7.0A implementation 在本轮开始。

## 5. Frozen PRD and D6 constraints

本 Amendment 不修改 closed D7 PRD，也不重新定义产品需求。以下 contract 继续
冻结：

- Mood 是某个合法 `DiaryDate` 的可选单值 metadata，不改变
  `diary/YYYY-MM-DD.md` 的 one-date-one-file contract。
- Calendar 负责导航，Vault 负责文档；existing route、tab、activePath、raw、save、
  dirty、History、Recovery ownership 不改变。
- D7 MVP 不创建 Mood-specific History、Recovery、Reader、Editor、Dialog、route、
  second tab store、second live metadata owner、second database 或 sidecar。
- History Comparison UI 仍然可以是 Markdown/body diff only；D7 不要求 metadata
  diff viewer 或 mood timeline。
- Recovery 继续由现有 body draft owner 负责，不从正文草稿猜测或覆盖 durable metadata。
- D7.0A 不实现 mood schema、registry、picker、Calendar marker、Native Mood context
  或任何 4×6 UI。

closed PRD 中的 frontmatter 示例仍是产品层的推荐表达；D7.0 evidence 已证明当前
frontmatter 不能安全充当 generic Mood read/write owner。此 Amendment 不静默修改
PRD 或把 frontmatter 重新设为 source of truth。若后续 review 认为改用 SQLite
metadata 已经改变 closed product storage semantics，而不只是落实既有 metadata
owner capability，则必须 STOP 并单独提出 PRD amendment。

## 6. Repository evidence used by this amendment

| Concern | Current repository fact | Evidence |
| --- | --- | --- |
| Live metadata owner | SQLite `documents` / `document_tags`; current DTO has no `mood` | `server/documentMetadata.ts:11-40`, `server/migrations/0002_document_metadata.sql` |
| Stable identity | `documents.id` is stable across rename; `path` is current location | `server/documentMetadata.ts:863-875`, rename helpers in `server/documentMetadata.ts` |
| Current metadata CAS | `updatedAt` is current version token; explicit tags use `expectedUpdatedAt` | `server/documentMetadata.ts:961-1027`, `server/metadataVersion.ts:25-46` |
| Existing metadata rollback | SQLite graph snapshots and `BEGIN IMMEDIATE` CAS/idempotent restore exist | `server/documentMetadata.ts:419-690` |
| History commit owner | Client flushes body then server calls Git commit; no metadata capture | `src/composables/vault/useHistoryCommit.ts:152-243`, `server/history/routes.ts:318-373`, `server/history/git.ts:1304-1450` |
| History Restore owner | Reads resolved Git raw, replaces bytes, touches current metadata, and compensates on failure | `server/history/restore.ts:73-307` |
| History Comparison | Model contains raw/diff/current dirty state, not metadata snapshots | `src/composables/vault/useHistoryComparisons.ts:43-75` |
| Body Recovery | Draft records contain body content and baseline identity, not metadata fields | `src/composables/vault/draft-recovery/draftTypes.ts:1-74`, `src/composables/vault/editor-tabs/useDocumentSave.ts:307-380` |
| Existing lock order | Vault mutation, structure/document locks, and repository mutation primitives already exist | `server/vaultMutation.ts:48-73`, `server/documentWriteLock.ts:31-87` |
| Delete provenance | Metadata deletion quarantines migration provenance and includes deleted document identity in its tombstone path | `server/documentMetadata.ts:1106-1118`, `server/documentMetadata.ts:1354-1375` |
| Frontmatter boundary | Existing rows are not rebuilt from stale raw frontmatter; `mood` is not a current SQLite field | `server/documentMetadata.ts:1030-1104`, D7.0 evidence §16 |

这些是 current facts，不是本 Amendment 声称已经实现的能力。D7.0A 必须在实现和
测试中重新验证关键行为。

## 7. History versus Recovery contract

两种操作必须保持不同的 revision 语义：

| Operation | Input | Body | Generic metadata | Owner |
| --- | --- | --- | --- | --- |
| History Comparison | explicit Git revision | compare historical raw and current/other raw | no metadata diff UI in D7 MVP | existing History Comparison |
| History Restore (snapshot-covered) | explicit resolved Git revision with a trusted snapshot | restore selected body revision | restore the matching generic snapshot; this is the full revision-consistent path | existing History Restore extended generically by D7.0A |
| History Restore (legacy pre-coverage) | explicit resolved Git revision without a trusted snapshot | preserve existing body-only restore semantics | preserve current durable metadata and return an explicit metadata-unavailable result; never claim metadata was restored | existing History Restore with an explicit legacy branch |
| Draft Recovery | unsaved local browser draft | recover unsaved body | preserve current durable metadata; do not infer or roll it back | existing draft-recovery + document-save owners |

因此：

```text
History Restore (snapshot-covered) = historical body + matching generic metadata revision
History Restore (legacy)           = historical body only + current durable metadata preserved
Draft Recovery                     = unsaved body recovery + current durable metadata preserved
```

不得把两者合并成一个 Mood revision model，也不得通过 Mood-specific draft store
弥补 generic History 的缺口。

## 8. Architecture options

### Option A — Historical generic snapshots in the existing SQLite database

在现有 SQLite metadata database 中增加 generic historical revision tables 和
必要的 capture/restore journal。live `documents`、`document_tags` 等当前 graph
继续是 live source of truth；历史表只服务于 History evidence/restore。

Conceptual payload：

```text
(vault identity,
 resolved Git revision SHA,
 parent revision identity,
 stable document id,
 document generation,
 path at revision,
 controlled metadata schema version,
 canonical generic metadata snapshot,
 payload digest,
 capture/restore state)
```

优点：复用现有 SQLite transaction、stable id、metadata CAS、same-database
rollback 和 migration；可以一次 capture 多个选中文件；History Restore 不需要
解析不可信 frontmatter。风险是 Git 与 SQLite 不是天然同一事务，必须增加 durable
journal、commit binding、补偿和 crash recovery。

### Option B — Git-owned revision metadata

把 generic metadata snapshot 作为 Git commit trailer、blob、note 或其它 Git-owned
revision artifact。

优点是 body 与 metadata revision 天然靠近同一个 Git SHA，导出/复制 Git repo 时
便携性较好。风险是 current SQLite owner 与 Git artifact 形成跨系统读取协议；需要
额外的 Git object/note 管理、权限/清理/历史 rewrite 语义，restore 时仍要把结果
原子地写回 SQLite；stable document id、generation、unknown fields 和 crash repair
测试成本更高。它不能直接解决 live metadata CAS。

### Option C — Reconstruct SQLite metadata from historical Markdown frontmatter

Restore historical raw 后解析 frontmatter，再重建 title/summary/tags/未来 mood。

这与当前 repository fact 冲突：existing SQLite row 不会从 stale raw 重建，历史
raw 可能缺字段、包含 legacy/custom values，且 frontmatter cleanup/migration 已有
独立语义。它无法可靠证明 stable id、generation、unknown controlled fields 或
跨 store atomicity；还可能把 custom `mood` 当成 canonical metadata。该选项不选。

### Options comparison

| Dimension | A: same SQLite history tables | B: Git-owned artifact | C: frontmatter reconstruction |
| --- | --- | --- | --- |
| live source consistency | history is separate read-only artifact; live graph unchanged | requires Git↔SQLite projection | historical raw becomes competing source |
| backup / portability | DB backup must include history tables | Git carries the artifact | raw is portable but not authoritative |
| cross-store atomicity | journal + compensation required | Git artifact + SQLite write still requires compensation | raw and SQLite can diverge |
| restore rollback | reuse existing SQLite snapshot/CAS + file rollback | same rollback plus Git reads | parser failures and partial projection |
| stable identity | explicit document id/generation columns | must encode/resolve identity in Git artifact | path/raw cannot prove it |
| delete/recreate | database tombstone/generation checks are testable | Git history must encode generation | path collision is unsafe |
| unknown controlled fields | versioned canonical payload can preserve opaque fields | artifact can preserve bytes but clients need protocol | unknown raw fields can be lost/rewritten |
| migration compatibility | additive SQLite migration, one owner | Git protocol migration plus DB projection | legacy raw ambiguity |
| security | server-controlled DB payload and path validation | Git object/note authorization surface | parser/custom-field injection surface |
| testability | existing DB/lock/rollback test seams | requires Git and DB fault matrix | difficult to prove source consistency |

## 9. Recommended architecture for D7.0A

推荐 **Option A**：在现有 SQLite database 内增加 generic historical metadata
revision capability，并在现有 History owner 内接入 capture/restore journal。

这只是 D7.0A 的 recommended remediation architecture；它不把当前 SQLite live
Mood storage 在 D7.0 revalidation 前提前标记为 `SELECTED STORAGE DIRECTION`。
前者解决“历史 metadata 如何与 Git revision 对齐”，后者仍需 D7.0 重新验证。

### 9.1 Conceptual history model

最终 schema 名称由 D7.0A implementation 决定，但必须表达以下关系：

```text
HistoryMetadataRevision
  vaultId
  resolvedRevisionSha
  parentRevisionSha (nullable)
  documentId
  generationId
  pathAtRevision
  schemaVersion
  controlledMetadataPayload
  payloadDigest
  capturedAt

HistoryMetadataCapture / RestoreJournal
  operationId
  resolvedRevisionSha (nullable until Git commit resolves)
  affected document identities
  expected body/tree proof
  before live metadata snapshot
  target historical metadata snapshot
  state: prepared | committed | compensating | recovered | failed
```

历史表不是第二个 live `DocumentMetadata` owner。Calendar、Mood picker、Native
Vault READ/EDIT 只能读取 live metadata owner；只有 generic History service 在
明确的 History Comparison/Restore workflow 中读取历史表。

### 9.2 Generic payload and schema version

payload 必须是受控 generic metadata envelope，而不是只保存 `mood`：

- D7.0A 至少覆盖现有 `title`、`summary`、`tags`；
- 未来 `mood` 和其它受控字段通过同一 envelope 自然加入；
- `schemaVersion` 与 canonical digest 必须随 snapshot 保存；
- 对“已知 controlled field 的未知 value”（例如当前 registry 尚未列出的
  `mood` ID），supported decoder 必须按 opaque value 保留并原样 restore；old client
  不得因为不认识该 value 就清空或改写它；
- 对 unknown controlled field 或 unsupported/newer `schemaVersion`，decoder 不得
  只恢复自己认识的字段再拼接当前 live 值；历史 payload 可以继续 durable 保存，但
  Restore 必须在任何 body mutation 前 fail closed；
- arbitrary custom frontmatter field 不自动变成 controlled field，也不由本方案
  承诺任意保留；
- SVG path、asset filename 或 emoji 中文文件名永远不是 metadata value。

## 10. Revision identity and generation semantics

历史 metadata snapshot 的 identity 至少是：

```text
(vault identity,
 resolved commit SHA,
 stable document id,
 document generation,
 path at revision)
```

规则：

1. `documents.id` 在 rename/move 中保持；`pathAtRevision` 只是该 revision 的位置。
2. 当前实现若没有独立 generation column，可暂以 stable `documentId` 作为 generation
   proof；若 D7.0A 发现这不足，必须在同一 generic metadata owner 中增加显式
   generation/provenance，而不能退回只按 path。
3. delete 后同一路径 recreate 必须产生新的 document identity/generation；新生成
   的 document 不得继承旧 generation 的 mood 或其它 history snapshot。
4. current row 与 historical snapshot 的 identity 不匹配时，History Restore
   必须 fail closed，不能把旧 metadata 写入新 generation。
5. create-only restore 只有在 server 能用现有 tombstone/provenance 证明 selected
   revision 属于可恢复的旧 generation 时才允许 rehydrate；否则在任何文件写入
   前返回 generation conflict。不得用“同一路径”代替 identity proof。

## 11. History commit capture semantics

### 11.1 Current boundary

当前 commit flow 只验证 body bytes：客户端在 `useHistoryCommit.submit()` 中先
flush selected body，再取 content hashes；server `/api/history/commits` 随后调用
`git.addAndCommit()`。当前 Git commit 由 `commit-tree` 创建并通过 `update-ref`
绑定到当时的 HEAD；没有 SQLite metadata capture。

### 11.2 D7.0A target flow

D7.0A 必须在 server History owner 中实现并证明以下顺序：

```text
existing Vault mutation coordinator
→ sorted document write locks for selected identities
→ re-check body content/tree proof
→ read live generic metadata after body save
→ canonicalize snapshot + digest
→ persist SQLite capture journal (prepared)
→ create Git commit through existing History owner
→ resolve immutable commit SHA and verify tree/body proof
→ finalize SQLite history snapshot rows bound to SHA
→ mark capture recovered/committed and release locks
```

capture 必须来自 live metadata owner 的 durable rows，不能从 historical raw
frontmatter 猜测。多文件 commit 必须为每个 document identity 保存独立 snapshot，
并共享一个 commit capture operation。

Git commit message/trailer、durable operation id 或等价 server-side proof 可以用来
在 crash 后把已经成功的 Git SHA 与 pending SQLite journal 重新绑定；具体编码在
D7.0A implementation 中确定，但不得依赖聊天上下文或不可验证的时间窗口。

### 11.3 Concurrent writes

History capture 与 metadata write 必须遵循现有全局锁顺序；metadata patch 不能在
snapshot 已 capture、Git 尚未绑定时静默改写同一 document。若 external writer 或
body tree proof 在 commit 前变化，整个 capture 必须 abort，不能提交一个无法解释
的 partial revision。

## 12. Git / SQLite partial-failure strategy

Git 与 SQLite 不能共享一个 native transaction，所以 D7.0A 必须使用 durable
journal + idempotent reconciliation，而不是假装它们原子提交。

| Failure point | Required result |
| --- | --- |
| SQLite prepare/capture fails before Git | no Git commit is created; pending journal is aborted/recoverable; live metadata unchanged |
| body/tree proof changes before staging | reject before commit; no snapshot is finalized |
| Git commit fails | pending journal is compensated/marked aborted; no success reported |
| Git commit succeeds but SQLite finalize fails | do not report normal success; retain durable pending journal and reconcile by operation proof/SHA; block ambiguous follow-up until repaired |
| process crashes after Git SHA but before finalize | restart/retry discovers immutable SHA, verifies tree/digest, then idempotently finalizes or reports a stable repair state |
| repository changes between capture and ref update | reject as repository conflict; never bind snapshot to a different SHA |
| reconciliation cannot prove identity/tree | leave Git history untouched, keep explicit failure/repair record, do not guess or delete another commit |

除非用户显式执行既有 History withdraw policy，server 不得自动 drop、rewrite 或
rollback 一个已经成功创建的 Git commit 来“伪造”跨 store atomicity。

## 13. History Restore contract

D7.0A 的 generic Restore 必须以 immutable resolved commit SHA 查找历史 snapshot，
并在 filesystem mutation 前完成：

1. path/ref validation 与 existing History policy；
2. document id/generation/path-at-revision binding validation；
3. current live metadata expected snapshot/version/CAS validation；
4. historical generic payload schema validation；
5. missing-snapshot/backward-compatibility policy validation。

只有所有 preflight 成功后，snapshot-covered revision 才可进入 existing atomic
body restore + generic metadata restore transaction。该路径的成功结果必须满足：

```text
selected Git revision body
+
the generic metadata snapshot bound to that same revision/generation
```

Restore preflight 必须先按 coverage/schema 分支：

```text
trusted snapshot + supported schema
  → exact body + generic metadata restore

no trusted snapshot because the revision predates metadata-history coverage
  → existing body-only restore
  → preserve current durable SQLite metadata
  → return explicit legacy / metadata-unavailable result

snapshot exists but schema is unsupported/newer, or contains an unknown field
  → fail closed before body mutation
  → retain the historical payload for later compatible readers
  → never mix known historical fields with current live fields
```

Legacy body-only success is deliberately not a generic metadata-aware success. The result
contract must expose the legacy limitation (for example, a stable metadata-unavailable
status/reason) so callers and UI cannot claim that metadata was restored. No new History
UI is required for this boundary; an existing-style result, message, or toast is enough
if it carries the explicit limitation.

History Comparison 仍不显示 metadata diff；它只把选定 revision 交给 existing
Restore owner。Restore API/UI 可增加“metadata snapshot unavailable/conflict”等
稳定错误或结果字段，但不得新建 Mood-specific History UI。

## 14. Restore atomicity and compensation

D7.0A 必须复用并扩展现有：

- `withVaultMutation()`；
- `withVaultStructureLock()` 与 `withDocumentWriteLock(s)`；
- `snapshotDocumentMetadataMutation()`；
- `restoreDocumentMetadataMutationCAS()` 或
  `restoreDocumentMetadataMutationCASIdempotent()`；
- `atomicReplaceTextIfUnchanged()` / `atomicRemoveTextIfUnchanged()`；
- existing editor mutation barrier 和 History Restore rollback boundary。

推荐的 logical transaction 是：

```text
lock + preflight
→ durable restore journal with before/target metadata images
→ atomic file prepare/replace
→ SQLite BEGIN IMMEDIATE metadata restore
→ mint fresh current version
→ verify file + live metadata
→ mark journal complete
→ release
```

如果 body 已换成 historical raw 但 metadata restore 失败，必须 rollback body，或
进入已有可证明的 recoverable failure state；不能返回 success。metadata 写入后
body replace 失败时同样必须 rollback metadata。若外部 mutation 使 rollback 无法
安全执行，应保留外部 bytes、保留可审计 journal、返回 stable conflict/error，不能
静默覆盖或谎报一致。

## 15. CAS and `updatedAt` semantics

- historical snapshot 中的历史 `updatedAt`（如果 payload 需要记录）是历史值，不是
  当前 CAS token；不得原样写回 live current version。
- Restore 成功后，live metadata owner 必须通过现有 version owner 生成一个新的、
  严格大于当前版本的 `updatedAt`。
- Restore preflight 必须校验 current identity 与 expected live metadata；如果外部
  metadata/body writer 在锁边界内改变了目标，必须 409/conflict，不得覆盖新值。
- title、summary、tags、未来 mood 和其它受控 fields 的 restore 必须在同一 generic
  metadata transaction 中完成；不能只恢复 mood 或只恢复 tags。
- 新的 metadata revision write 必须继续使用现有 CAS/lock owner，不得增加第二个
  version source。

## 16. Backward compatibility and metadata-history coverage boundary

“没有 trusted snapshot”与“有 snapshot 但 schema 不受支持”是两个不同的状态，必须
由不同的 policy 处理。metadata-history coverage 以 **History commit 已完成可信
generic snapshot capture 的 revision** 为边界，而不是以 Diary/Mood 是否已经上线
为边界。

```text
snapshot-covered revision
  → validate supported schema and identity binding
  → restore body + matching generic metadata snapshot
  → report full revision-consistent restore

legacy pre-coverage revision with no trusted snapshot
  → preserve existing ordinary History body-only Restore
  → preserve current durable SQLite metadata
  → return explicit legacy / metadata-unavailable result
  → do not infer metadata from raw frontmatter
  → do not claim metadata was restored

revision has a snapshot but its schema is unsupported/newer
  → fail closed before filesystem mutation
  → preserve the historical payload for later compatible tooling
  → do not restore a partial known-field/current-field mixture
```

因此，D7.0A 不得因为 legacy snapshot 缺失而让现有普通 Note History Restore 退化为
不可用；legacy body-only restore 不是 generic metadata-aware restore，也不是隐式的
“metadata 保持不变所以算成功”。它必须有稳定、可审计的 metadata-unavailable
limitation。History Comparison 仍可读取所有旧 raw；只有 unsupported snapshot
schema 才在 Restore preflight 中明确拒绝。

Legacy branch 仍禁止从 raw frontmatter 猜测 title、summary、tags 或未来 mood，也
不要求新增 History UI；实现可复用现有 error/result surface，但必须让调用方知道
metadata snapshot 不可用。

## 17. Pre-Mood historical revisions

“没有 snapshot”不等于“历史 mood 明确为空”。对于 Mood 上线前的 revision：

- 只有 generic snapshot 明确保存了 controlled `mood` absent/null，Restore 才能把
  mood 恢复为 absent；
- 只有 raw frontmatter 没有 `mood`，不能证明 SQLite controlled mood 当时为空；
- 没有可信 snapshot 且 revision 属于 pre-coverage legacy branch 时，遵循既有
  body-only Restore，保留当前 durable metadata，并返回 metadata-unavailable；禁止
  猜测 happy、把当前值冒充历史值或静默清空；
- 如果 snapshot 存在但 schema 不受支持，按“unsupported snapshot schema”分支在
  body mutation 前 fail closed；不得把它降级成 legacy branch；
- D7.1 引入 mood 前，D7.0A 只实现 generic foundation，不添加 mood field 或
  backfill 假设。

## 18. Unknown metadata preservation

generic payload 必须带 versioned controlled-field envelope：

- **Known field + unknown value**：字段 key/schema 是当前 decoder 支持的，但 value
  不在当前 registry（例如 future-new `mood` ID）。必须将 value 作为 opaque data
  保留并原样 restore；writer 使用 read-modify-write 或等价的 opaque preservation，
  old client 不得清空、规范化成别的 value 或删除它；
- **Unknown field or unsupported/newer schema**：snapshot 含当前 decoder 不认识的
  controlled field，或 `schemaVersion` 高于当前支持范围。历史 payload/bytes 可以
  原样 durable 保留，但当前 decoder 必须在任何 body mutation 前 fail closed；不得
  只恢复已知 fields 再保留当前 live field，也不得删除 unknown field。这样不会
  产生 mixed historical/current metadata revision；
- arbitrary custom frontmatter 仍与 controlled metadata 分离；不把其内容自动
  导入历史表；
- supported schema migration 必须能读取兼容的旧 envelope；对于暂时无法理解的
  新 envelope，migration 只能保留 opaque payload，不能宣称已经完成 Restore；
- 不允许通过 asset path、emoji filename 或 UI label 作为稳定 metadata identity。

## 19. D7.0A scope

D7.0A 是 generic foundation production phase，范围固定为：

1. generic historical metadata revision model；
2. same SQLite database 的 additive schema/migration；
3. generic controlled metadata snapshot serialization/version/digest；
4. Git resolved revision ↔ metadata snapshot identity binding；
5. existing History commit capture integration；
6. existing History Restore generic metadata restore integration；
7. capture/restore journal、crash reconciliation 和 compensation；
8. stable document identity、tombstone 和 delete/recreate generation semantics；
9. metadata-history coverage boundary 与 legacy body-only restore result semantics；
10. supported/unsupported snapshot schema policy 与 known-field unknown-value preservation；
11. title、summary、tags 的 unit/integration/route characterization；
12. existing History Comparison body-only 与 Recovery body-only regression proof。

D7.0A 必须留在现有 generic owner seam 内，并为 D7.0 revalidation 提供可审计的
evidence。

## 20. D7.0A non-goals

明确不属于 D7.0A：

- `mood` schema、Mood registry、stable Mood ID validation；
- Mood set/change/clear command、CAS field、DTO 或 API 产品实现；
- Mood picker、Calendar marker、Native Mood context、4×6 UI、emoji rendering；
- D7.1、D7.2、D7.3、D7.4、D7.5、D7.6 implementation；
- Mood-specific History/Recovery pipeline 或第二套 draft store；
- 第二 SQLite database、JSON/per-document sidecar、隐藏 Markdown metadata file；
- 新 Diary route、Reader/Editor/Dialog、第二 tab/document lifecycle；
- History metadata diff viewer 或新的 History UI；
- 修改 D6 lifecycle、Calendar/Vault ownership、D1/D2/D3/D4/D5 contracts；
- 从 frontmatter 重建 generic metadata；
- dependency、library、VCalendar、Popper 或 parser replacement。

## 21. D7.0A exit criteria

所有项目必须在 D7.0A implementation/review 中以真实 evidence 关闭；任一失败则
`D7.0A = BLOCKED`：

- [ ] generic historical metadata revision model exists;
- [ ] no Mood-specific history pipeline;
- [ ] existing generic metadata authority remains the live owner;
- [ ] stable document identity and generation are preserved;
- [ ] each historical snapshot is tied to a resolved Git revision;
- [ ] commit metadata snapshot capture timing and locking are proven;
- [ ] Git/SQLite partial failure behavior is proven;
- [ ] body + generic metadata restore is logically atomic;
- [ ] restore rollback/compensation is proven;
- [ ] title history restore is proven;
- [ ] summary history restore is proven;
- [ ] tags history restore is proven;
- [ ] restore mints a valid new current `updatedAt` token;
- [ ] stale external metadata cannot be silently overwritten;
- [ ] delete/recreate generation isolation is proven;
- [ ] revision-without-snapshot policy is explicit and tested;
- [ ] metadata-history coverage boundary is explicit and tested;
- [ ] legacy pre-coverage ordinary Note body-only History Restore remains usable;
- [ ] legacy restore preserves current durable SQLite metadata;
- [ ] legacy restore exposes an explicit metadata-unavailable limitation;
- [ ] legacy restore never infers metadata from historical frontmatter or claims metadata restore;
- [ ] snapshot-covered revision restores body and matching generic metadata exactly;
- [ ] unsupported/newer snapshot schema fails before body mutation;
- [ ] known-field unknown-value snapshots round-trip opaquely;
- [ ] no mixed historical/current metadata revision can report success;
- [ ] pre-Mood revision behavior is explicit and tested;
- [ ] History Comparison remains body-only;
- [ ] Recovery remains body-only and preserves current durable metadata;
- [ ] no second database;
- [ ] no sidecar;
- [ ] no second live metadata source of truth;
- [ ] ordinary Note History remains usable with the explicit legacy policy;
- [ ] existing History regression passes;
- [ ] D6 Diary lifecycle is unaffected;
- [ ] no new route/tab/document lifecycle is introduced;
- [ ] no Mood UI or D7.1 code is present.

## 22. D7.0A test and evidence matrix

这是未来 D7.0A 的 implementation plan，不是本 Amendment 的测试结果：

| Layer | Required proof |
| --- | --- |
| Unit | canonical generic payload, schema version, digest, unknown-field round-trip, identity/generation validation |
| SQLite integration | snapshot capture, same-DB journal, current/live separation, fresh `updatedAt`, CAS conflict, idempotent finalize/restore |
| History route | commit capture bound to immutable SHA; multi-file capture; legacy coverage result; unsupported schema error; ref/tree mismatch; crash/retry reconciliation |
| Restore integration | snapshot-covered body + title/summary/tags restore; legacy body-only restore with current metadata preserved; unsupported schema preflight rejection; known-field unknown-value restore; create-only/tombstone path; delete/recreate conflict; body rollback; metadata rollback; external mutation conflict |
| Existing regression | History Comparison body-only, baseline/divergent Recovery body-only, ordinary Note History, existing D6 Diary lifecycle |
| Failure injection | Git failure, SQLite prepare/finalize failure, process boundary, repository change, rollback conflict; no false success and no partial silent mutation |

## 23. D7.0 revalidation after D7.0A

D7.0A `REVIEW-CLOSED` 后必须回到 D7.0 做独立 revalidation，不能直接进入 D7.1。

Revalidation 至少重新确认：

1. History Restore 能否按 resolved revision 恢复 generic metadata；
2. History Comparison 仍是 body-only；
3. Recovery 仍是 body-only 并保留 current durable metadata；
4. current CAS/updatedAt 与 restore 后新版本方向；
5. dirty body 与 metadata write/restore 的隔离；
6. delete/recreate identity/generation；
7. legacy no-snapshot coverage、unsupported snapshot schema、pre-Mood absence、known-field unknown values；
8. Calendar month bulk-read seam 与 D7.1 storage direction；
9. no second source of truth、no sidecar、no PRD/D6 contract drift。

只有所有 gate 通过，SQLite 才能从：

```text
CANDIDATE / NOT SELECTED
```

升级为 D7.0 review 中明确记录的 selected storage direction。然后 D7.0 仍需
`REVIEW-READY → Independent Review → REVIEW-CLOSED`，完成后才允许 D7.1。

## 24. D7.1 impact

D7.1 仍然是：

- 24-item registry；
- `mood` schema/DTO/validation；
- set/change/clear 与同一 current metadata CAS owner；
- bulk month read；
- unknown Mood ID preservation；
- Calendar/Native context 的后续接入 seam。

D7.1 不再负责 generic History metadata foundation；该 foundation 完整属于
D7.0A。D7.1 仍为 `NOT STARTED`，在 D7.0 revalidation 和 closure 前不得开始。

## 25. D7.4 impact

D7.4 继续严格是 **Lifecycle Regression / Verification**，不是实现阶段。它未来
验证已经完成的 generic foundation 与 Mood lifecycle：

- History Comparison/Restore；
- baseline/divergent Recovery；
- CAS、dirty body、external conflict；
- unknown Mood ID、delete/recreate、same-date reopen；
- Calendar/Native continuity。

D7.4 不得再次承载 generic History metadata implementation，也不得把 D7.0A
blocker 延迟到 D7.4 才首次发现。

## 26. STOP conditions

D7.0A implementation 或 review 遇到以下任一项必须 STOP，并回到 architecture /
product review：

1. 必须创建 Mood-specific History pipeline；
2. 必须创建第二 live metadata source；
3. 必须创建第二 database；
4. 必须创建 per-document sidecar 或隐藏 Markdown metadata file；
5. History Restore 无法形成 body + generic metadata 的 logical atomicity；
6. Git/SQLite partial failure 无法 rollback 或进入可证明的 recoverable state；
7. 只能用 path 作为 historical identity；
8. delete/recreate 会串 generation；
9. 必须修改 D6 document lifecycle owner；
10. 必须创建新 History UI 或 metadata diff viewer；
11. Recovery 必须创建 Mood-specific draft store；
12. 只能从不可信 frontmatter 猜 historical metadata；
13. 需要修改 closed PRD product semantics；
14. D7.0A 无法限制为 generic metadata capability；
15. known-field unknown values 无法被 opaque 保留/restore，或 unknown field / unsupported
    schema 无法在 body mutation 前 fail closed；
16. Restore 只能通过 historical known fields + current live fields 的 mixed revision
    取得“成功”；
17. legacy pre-coverage revision 无法继续 ordinary Note body-only Restore，或无法
    返回明确的 metadata-unavailable limitation；

## 27. Rollback and operational safety

- Amendment 与 pointer sync 是 docs-only，可作为独立文档提交回滚；不得回滚/删除
  D7.0 evidence 或 characterization test 来掩盖 blocker。
- D7.0A schema 应是同一 SQLite DB 的 additive migration；失败或代码回滚不得删除
  newer history snapshots、live metadata、tombstone 或 unrelated metadata。
- capture/restore journal 必须可重试、可审计、可区分 `prepared`、`committed`、
  `compensating`、`recovered` 和 `failed`；不能用进程重启后的猜测清理。
- Git 已成功创建的 commit 不由 server 自动 rewrite/drop；若 journal 无法绑定，
  必须保留 Git history 并报告稳定 repair state。
- UI/Calendar 后续阶段可独立回滚，且不影响 existing Diary navigation/document
  lifecycle。

## 28. Lifecycle and ownership after the amendment

```text
D6                         = REVIEW-CLOSED
D7 PRD                     = REVIEW-CLOSED
D7 Implementation Plan     = REVIEW-CLOSED
D7 Plan Amendment          = REVIEW-CLOSED
D7 Plan Amendment IR       = PASS (P0/P1/P2 = 0/0/0)
D7.0                       = BLOCKED
D7.0 Independent Review    = PASS on BLOCKED determination
D7.0A                      = NOT STARTED
D7.1                       = NOT STARTED
D7 Mood production         = NOT STARTED
D7.4                       = NOT STARTED (regression-only)
```

本 Amendment 的 implementation/evidence commit 停止在 `REVIEW-READY`；Independent
Review PASS 后，本 closure sync 将 Amendment 标记为 `REVIEW-CLOSED`。本 closure
不把 D7.0A 标记为 `IN PROGRESS`。

## 29. Files inspected and evidence commands

本 Amendment 编写前读取/核对：

- `docs/design/diary-mood-prd.md`
- `docs/design/diary-mood-implementation-plan.md`
- `docs/design/diary-mood-d7.0-storage-metadata-verification.md`
- `server/history/restore.ts`
- `server/history/routes.ts`
- `server/history/git.ts`
- `server/documentMetadata.ts`
- `server/metadataVersion.ts`
- `server/migrations/0002_document_metadata.sql`
- `server/migrations/0004_metadata_document_identity.sql`
- `src/composables/vault/useHistoryCommit.ts`
- `src/composables/vault/useHistoryRestore.ts`
- `src/composables/vault/useHistoryComparisons.ts`
- `src/composables/vault/draft-recovery/draftTypes.ts`
- `src/composables/vault/draft-recovery/useUnsavedDraftRecovery.ts`
- `src/composables/vault/draft-recovery/useUnsavedDraftPersistence.ts`
- `src/composables/vault/editor-tabs/useDocumentSave.ts`
- `src/components/vault/metadataDraftStore.ts`
- `src/views/VaultView.vue`

本轮执行的取证类命令包括：

```text
git status --short --branch
git rev-parse HEAD
git log -20 --oneline --decorate
rg --files ...
rg -n "history|restore|metadata|draft|updatedAt|documentId|generation"
nl -ba <relevant-file> | sed -n '<relevant-range>p'
```

命令确认当前 HEAD 为 `b1b0fd...`、分支为 `main`、工作区干净；本 Amendment
没有运行 unit、typecheck、build 或 E2E，也没有把历史 D7.0 test run 重新宣称为
本轮新测试结果。

## 30. Conclusion and readiness gate

本 Amendment 正式为已确认的 D7.0 P1 blocker 增加 D7.0A generic remediation
phase，并冻结以下关键决定：

```text
History Restore = generic revision-aware body + metadata restore
Recovery       = body-only, preserve current durable metadata
Recommended    = same SQLite DB historical generic snapshots + durable journal
Mood           = out of scope for D7.0A
Second DB      = NO
Sidecar        = NO
Second live owner = NO
```

因此本文件达到：

```text
INDEPENDENT REVIEW PASSED
Amendment = REVIEW-CLOSED
Amendment Independent Review = PASS (P0/P1/P2 = 0/0/0)
D7.0A = NOT STARTED
D7.0 = BLOCKED
D7.1 = NOT STARTED
```

Amendment closure complete。不要开始 D7.0A、D7.1 或 Mood implementation。
