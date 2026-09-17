# D7.0 — Storage / Metadata Ownership Verification

> **Historical lineage — not current runtime authority.** Current behavior is
> defined by [Diary Architecture](../architecture/diary.md) and [Diary User
> Guide](../user-guide/diary.md). This file is retained for D7 traceability.

状态（D7.0 Revalidation）：**REVIEW-CLOSED**

Independent Revalidation Review（本次 revalidation）：`PASS`
Review result（本次 revalidation）：`P0 = 0 / P1 = 0 / P2 = 0`
Self-review（本次 revalidation）：`P0 = 0 / P1 = 0 / P2 = 0`

历史 D7.0 gate：`BLOCKED`
历史 Independent Review：`PASS on the BLOCKED determination`
历史 Review result：`P0 = 0 / P1 = 1 / P2 = 0`

日期：2026-08-27（Asia/Shanghai）

本文件第 1–23 节保留原始 D7.0 blocker、characterization 和 review 记录；第 24 节
记录 D7.0A 完成后的当前 revalidation 结果。当前状态更新不改写历史结论。

## 1. Starting HEAD（原始 D7.0 gate）

本阶段开始时：

```text
696ccf9654e62ff57c356ffffdd2573410cade15
docs(diary): close D7 implementation plan review
```

开始时分支为 `main`，工作区干净，HEAD 与要求的 baseline 精确一致。

本轮最小 characterization test commit：

```text
03507ac871779f29c4a50bfae869acd8b2815263
test(diary): characterize metadata history restore
```

该提交只增加 History Restore 的行为取证测试，不含生产代码。

## 2. Scope

本轮是 D7.0 architecture verification gate，目标是确认 D7 Mood 是否能安全
接入当前 metadata/document lifecycle。范围包括 repository tracing、现有行为
characterization 和 evidence；不实现 Mood registry、schema、API、picker、marker、
migration 或 UI。

## 3. Repository findings

当前代码的事实与 closed D7 design 的关系如下：

| Area | Current fact | D7.0 consequence |
| --- | --- | --- |
| Generic metadata authority | SQLite `documents` / `document_tags`；`PostDetail.frontmatter` 是兼容读取视图 | SQLite 是最接近现有 owner 的 candidate，不是已经扩展好的 Mood storage |
| Body authority | Markdown bytes，由 `/api/posts/*` 和 `savePost(raw, baseRaw)` 处理 | Mood 不能通过 stale raw 重写来实现 |
| Identity | SQLite `documents.id` 稳定，`path` 是当前可移动位置 | Mood 应跟 stable document identity / canonical Diary date 关联 |
| History | Git raw + text diff/restore | 当前不携带 SQLite metadata revision |
| Recovery | IndexedDB body draft/conflict records | 当前不携带 metadata fields |
| Calendar data | `getTree()` 与一次 `listPosts()` 全量刷新；Calendar projection 当前只投影合法 Diary 文件 | 存在单请求 bulk seam，但还没有 mood 字段或按月 metadata 查询 |

## 4. Metadata ownership and storage

### 4.1 Current source of truth

`server/documentMetadata.ts` 的 `DocumentMetadata` 当前只有：

```text
id, path, title, summary, tags, createdAt, updatedAt
```

`server/migrations/0002_document_metadata.sql` 的 `documents` 表以 `id` 为主键、
以 `path` 为唯一当前位置；`document_tags` 是独立的关联图。读取 owner 是
`getDocumentMetadata()` / `getDocumentMetadataById()`，写入 owner 是
`createDocumentMetadata()`、`patchDocumentMetadata()` 及其 transaction variant。

`server/routes/metadata.ts` 的：

```text
GET   /api/metadata/documents/:id
PATCH /api/metadata/documents/*
```

是当前 metadata HTTP authority。客户端对应的是 `src/lib/api.ts` 的
`getDocumentMetadataById()` / `updateDocumentMetadata()`。

### 4.2 Identity, locks, and transaction boundary

- `documents.id` 在 rename/move 中保留；`path` 会更新为当前位置。
- metadata PATCH 通过 `withDocumentWriteLock(documentPath, ...)` 串行化同一路径的
  metadata mutation，并由 SQLite transaction 提交字段和 tag association。
- body write、History Restore、Diary create、rename/delete 也使用相应的
  document/structure lock 及 metadata snapshot/rollback helper。
- `snapshotDocumentMetadataMutation()` / `restoreDocumentMetadataMutation()` 能为
  现有 SQLite graph 做原子补偿和 identity-preserving rollback；它们不是 Git
  metadata history。

结论：SQLite owner 具备 D7 所需的 identity、锁和 transaction 基础，但当前 schema
和 DTO 尚未包含 `mood`。

## 5. CAS findings

`updatedAt` 是现有 metadata version token，`nextMetadataUpdatedAt()` 保证版本单调
递增。当前实现的精确边界是：

- 显式 `tags` patch 必须带 `expectedUpdatedAt`；stale token 返回
  `METADATA_VERSION_CONFLICT`，HTTP 为 409。
- title/summary-only patch 当前不要求 expected token。
- mixed title + tags patch 在 tag token stale 时整体拒绝，不会静默落下 title。
- SQLite `UPDATE` 只改变 title、summary、updated_at；tag association 只按 set diff
  修改，未涉及的字段和关系不会被普通 partial patch 清掉。

现有 test evidence：

```text
server/__tests__/documentMetadata.test.ts
server/__tests__/metadata-api.test.ts
```

已证明 stale tag token 的 409、mixed patch atomic rejection、strict version advance
和 equal-set no-op。

### D7 implication

未来 `mood` 的 set/change/clear 必须成为同一 metadata transaction 中的 controlled
field，并且必须使用明确的 `expectedUpdatedAt`。当前 tags-only CAS 不能直接宣称
“generic metadata CAS 已经支持 mood”；需要在既有 owner 内增加字段验证和 CAS
语义。这可以是 D7.1 的 generic owner extension，但不能新增第二个 version source。

## 6. Dirty body coexistence

当前正文状态由 `useTabWorkspace` 的 `Tab.raw` / `originalRaw` / revisions 和
`useDocumentSave` 的 `savePost(path, raw, baseRaw)` 负责；draft persistence 由
`UnsavedDraftPersistence` 负责。

metadata PATCH 的真实路径是：

```text
read file only to ensure the SQLite row
→ patch SQLite metadata transaction
→ return metadata
```

它不会调用 `savePost()`，不会写回 Markdown bytes，不会改变 tab raw、Monaco model、
body revision 或 dirty state。`src/views/metadataPostSummary.ts` 也明确把 metadata
视为 SQLite-owned，而不是 Markdown rewrite。

这证明了以下安全边界：

```text
dirty body A → B
metadata patch
```

不会因为 metadata patch 把 body 恢复为 stale A，也不会清除 B 的 dirty 状态。

但这只是现有 title/summary/tags 的 persistence-boundary evidence；它不能替代
未来 mood field 的真实 CAS/dirty characterization。

## 7. Metadata draft decision

`src/components/vault/metadataDraftStore.ts` 的 `metadataDrafts` 是 session-only
`Map`，只承载 title/summary/tags 表单草稿；注释和实现都表明它不持久化，也不接入
body Recovery。

D7 的 provisional direction 是：

- mood 的 set/change/clear 是用户明确触发的原子 metadata command；
- 不把 mood 强行放进现有 metadata form draft；
- 不创建 mood-specific persistent draft；
- command 直接调用同一个 SQLite metadata write/CAS owner；
- 已经 durable 的 mood 不由 body Recovery 重新推导或覆盖。

这保持单一 metadata persistence owner，但在 History/Recovery contract 尚未闭合
前仍是 provisional，不构成 D7.0 PASS。

## 8. History Comparison findings

当前 History Comparison 的 source 是 Git historical Markdown raw 与当前工作树 raw：
`useHistoryComparisons()` 的模型只包含 `beforeRaw`、`afterRaw`、text diff 和
`currentDirty`，没有 SQLite metadata snapshot 或 mood value。

因此：

- body comparison 语义沿用 D6，当前 owner 正确；
- History Comparison 不会显示 title/summary/tags/mood 的 metadata diff；
- 不能把 body diff PASS 当成 Mood metadata history PASS。

## 9. History Restore findings — blocking

`server/history/restore.ts` 的现有文件恢复流程对已有 target 是：

```text
read historical Git raw
→ ensureDocumentMetadata(current path, current raw)
→ replace current file bytes with historical raw
→ recordCommittedDocumentMutation()
```

对已有 SQLite row，`ensureDocumentMetadata()` 不从 raw 重建 title/summary/tags；
`recordCommittedDocumentMutation()` 只 touch 当前 row 的 `updatedAt`。客户端
`useHistoryRestore()` 也只把返回的 raw 写入 tab，未读取或恢复 metadata。

因此当前可证明的是：

```text
History Restore = body restore + stable identity preservation
History Restore != SQLite metadata revision restore
```

本轮 characterization test `server/__tests__/history-routes.test.ts` 实际验证了：

- 历史 Diary raw（包括历史 frontmatter）被恢复到磁盘；
- 当前 SQLite document id 保留；
- 当前 SQLite title/summary/tags 保留，而不是被历史 raw 重建；
- metadata `updatedAt` 被推进。

该测试通过，但它固定的是当前 body-only 行为，不是 D7 所需的 Mood restore 能力。

如果未来把 Mood 放在 SQLite metadata，执行“恢复到旧 revision”后，mood 会继续
保持当前值。这样无法满足 closed PRD 对“History/Restore 恢复文件 metadata 时
metadata 一致性”的要求，也无法满足 closed Plan 的 D7.0 gate。

这是本轮唯一的 P1 architecture blocker：现有 History Restore owner 没有 generic
metadata revision restore，而 closed Implementation Plan 没有明确承载该 production
extension 的 phase。D7.4 是 regression evidence phase，不能把这个缺失偷偷推迟到
D7.4 才发现。

## 10. Recovery findings

当前 Recovery 明确是 body-only：

- `UnsavedDraft` / `DraftConflictRecord` 只保存 `content`、baseline hash/mtime、
  path、stable document id 和 draft timestamps；
- IndexedDB `nuvyn-draft-recovery` 只维护 drafts/conflicts；
- `DraftBufferSnapshot` 只含 body content/authoritativeContent/revision；
- `useUnsavedDraftRecovery` / `useUnsavedDraftPersistence` 没有 SQLite metadata
  snapshot、mood value 或 metadata conflict channel；
- `useDocumentSave.applyRecoveredDraft()` 只重新赋予 tab body dirty state，未写 metadata。

因此当前 recovery 能证明的是：body Recovery 不会主动覆盖一个独立 durable metadata
值；但它不能恢复或比较一个 metadata revision，也没有 divergent metadata recovery
语义。若 D7 选择 SQLite，必须在 D7.1 之前明确采用“Recovery 只恢复 body、保留当前
durable mood”还是扩展 generic draft/recovery owner 携带 metadata。不能在 D7.4
用测试掩盖这个 architecture decision。

## 11. External conflict and channel isolation

现有两条冲突通道独立：

```text
body:     PUT /api/posts/* + raw/baseRaw → EDIT_CONFLICT (409)
metadata: PATCH /api/metadata/documents/* + expectedUpdatedAt → METADATA_VERSION_CONFLICT (409 for tag changes)
```

body conflict 不会回滚已经成功的 metadata transaction；metadata patch 也不会把
Tab 标成 body external、替换 raw 或清理 body draft。两者共享路径锁和最终 metadata
version 更新，因此未来 mood patch 必须把 body commit 造成的 `updatedAt` 推进视为
可检测的版本变化。

当前 metadata CAS 的 tags-only 边界仍意味着 mood 的 metadata conflict 尚未被真实
证明；这是上面的 generic owner extension，而不是新的 conflict pipeline。

## 12. Rename / move / delete / recreate

### Rename and move

普通 document rename/move 由 posts/document lifecycle 和
`renameDocumentWithMetadata()` 共同处理。现有 metadata row 的 stable id、tags、
summary 会随当前 path 迁移；Diary managed identity 的 rename/move 仍由 domain
policy 拒绝。D7 不得绕过这些 owner。

### Delete

普通 delete 在文件 mutation 前保存 metadata snapshot；成功后
`deleteDocumentMetadata()` 删除 `documents` row，关联 tags/embeddings 按 SQLite
foreign-key 语义处理，migration record 可留下 orphan/quarantine provenance。

### Recreate same path

Diary date create 是 `server/routes/diary.ts` 的唯一创建 authority。成功创建新的
exact path 时会清理不能主张新 generation 的旧 row，再创建新的 metadata identity。
删除后重新创建同一 `DiaryDate` 不应自动继承旧 mood；新 generation 应获得新的
document id 和空的 mood，除非未来产品明确另行规定并实现可验证的 provenance。

这些文件生命周期结论与现有 stable identity / no-orphan 方向一致；但 Mood column
尚不存在，所以本轮只证明 owner seam，不宣称 Mood 已通过 delete/recreate 测试。

## 13. Missing today/past/future authority

当前 `useDiaryDateCommand.openDiaryDate()`：

- 用 `parseDiaryDate()` 和 `diaryLogicalPathForDate()` 验证日期和 exact path；
- existing Diary 直接走 `openPost()`；
- missing today/past 调用既有 `POST /api/diary/dates`；
- missing future 在 command/server 两侧都拒绝；
- 不创建 suffix、替代日期或第二 Diary path。

未来 Mood command 必须依赖这一 authority：先确保合法 Diary document 存在，再做
metadata set/change/clear。Mood 不得自行创建 missing Diary，也不得绕过 future guard。

## 14. Month bulk-read findings

当前 `useTabWorkspace.refresh()` 一次并行请求 `getTree()` 与 `listPosts()`；
`GET /api/posts` 返回全 Vault `PostSummary[]`。server `listPostsFlat()` 在构建这
个单一响应时对文件逐个读取现有 metadata，但客户端没有对 35–42 个 Calendar cell
逐个发 metadata GET。当前 `PostSummary` 没有 `documentId` 或 `mood`，Calendar
projection 也只消费 tree 中 exact `diary/YYYY-MM-DD` 文件。

### Preferred future seam

优先扩展现有 `listPosts()` / `PostSummary` bulk response：对 canonical managed
Diary path 提供可选的 `mood`（以及实现需要时的 stable `documentId`），由现有
workspace refresh 产生一个 `Map<DiaryDate, MoodId | null>`。普通 note 的字段保持
undefined/不展示，server 只对严格合法 Diary path 输出 Mood。

该 seam 的理由：

- 复用现有 Vault refresh 和 reactive patch owner；
- Calendar 不需要 35–42 次 GET，也不需要 picker 自己维护 cache；
- 不新增 Diary-specific route 或第二 metadata owner；
- ordinary note 语义和权限边界可保持不变；
- 若全量列表在大 Vault 上成为性能问题，可在同一 metadata owner 内优化成按
  Diary date range 的单次 SQL query，而不改变客户端 ownership。

这是 D7.1/D7.3 的 future production seam，本轮未实现。

## 15. Unknown field and unknown mood preservation

当前 patch SQL 是 field-specific 的，不会因为 title/summary/tags partial patch 删除
其它已存在的 SQLite graph rows；metadata mutation snapshot 也覆盖 documents、tags、
associations、embeddings 和 migrations。

但当前 schema 没有通用 JSON/unknown-field column，也没有 `mood`。因此需要区分：

- unknown mood ID：未来读取时必须作为 opaque string 保留，旧客户端不得因为 registry
  不认识就清空；只有 canonical selection 或 Clear 才能替换/删除；
- unknown metadata field：当前 SQLite owner 不能自动承诺保存尚未建模的任意新字段，
  需要 generic schema/DTO/patch preservation 设计。

D7 不得把 SVG path 或 asset filename 写进 metadata；只保存 stable Mood ID。

## 16. Frontmatter interaction

当前 `GET /api/posts/*` 会把 raw frontmatter 作为兼容视图返回，并用 SQLite 已知字段
覆盖 title/summary/tags/created/updated。`observeDocumentMetadata()` 只导入这些
已知字段；`readFrontmatter()` 也不把 mood 作为 metadata 返回。

如果用户已有：

```yaml
mood: future-value
```

当前代码会把它作为 raw/custom frontmatter 保留在 `PostDetail.frontmatter`，但不会
进入 SQLite `DocumentMetadata`。同时 `frontmatterArchive` 的 `STANDARD_FIELDS`
没有 `mood`，所以清理流程会把它视为 custom field 处理，而 canonical export 不会
把它作为已知数据库 mood 导出。

结论：frontmatter 不能在当前代码中同时充当 Mood 的可靠 read/write owner；把它
作为第二 source of truth 会造成冲突。closed PRD 把 frontmatter 写法描述为推荐示例
并要求先验证现有能力，因此本轮不改 PRD；实际实现前应以 SQLite candidate 的
architecture decision 和 generic History decision 为准。

## 17. Storage decision

```text
SQLite-owned DocumentMetadata = CANDIDATE / NOT SELECTED
Frontmatter                  = NOT SELECTED
Sidecar / second database    = NOT APPROVED
```

SQLite 仍是最小改动、最符合当前 source-of-truth/identity/CAS/lifecycle 的候选，
但在 History metadata revision restore 和 Recovery semantics 未闭合前，不能写成
`Selected Storage Direction`，也不能进入 D7.1 实现。

## 18. Required future production changes

在允许 D7.1 前，必须先由 architecture/product review 明确并安排：

1. 在现有 SQLite metadata owner 内增加 nullable/controlled `mood` schema、DTO、
   read/write validation 和 stable-ID-only wire contract。
2. 在同一 `updatedAt` CAS owner 内定义 mood set/change/clear 的 stale-token 行为，
   不新增第二版本源。
3. 扩展现有 bulk `PostSummary`/query seam，以一次响应提供 Calendar 所需的 Diary
   month mood 数据；不得采用 per-cell GET。
4. 在现有 History Restore owner 内增加 **generic metadata revision snapshot/restore**
   语义，且与 body restore 共用 identity、lock、transaction 和 rollback boundary。
   这必须能回答历史 mood 如何随选定 revision 恢复；不能新建 Mood-specific history
   pipeline。
5. 在现有 Recovery owner 内明确“body recovery 保留 durable mood”或批准 generic
   draft metadata extension；不得默默把 mood 放进第二个 draft store。

第 4 项是当前 D7.0 blocker。现有 closed Plan 没有明确的 production phase 承载
该 generic History extension；因此需要 **Implementation Plan amendment required**。
若产品坚持 frontmatter 历史语义而不接受 SQLite metadata history extension，则还
需要显式 PRD/storage decision，而不能在 D7.1 临时切换 source of truth。

## 19. Tests / evidence

### Existing suites run

在新增 characterization 前，以下 focused suite 通过：

```text
npm exec vitest run \
  server/__tests__/documentMetadata.test.ts \
  server/__tests__/metadata-api.test.ts \
  server/__tests__/history-routes.test.ts
→ 3 files / 109 tests passed
```

新增 test 后，History route suite 通过：

```text
npm exec vitest run server/__tests__/history-routes.test.ts
→ 1 file / 71 tests passed
```

新增 characterization 覆盖：

```text
existing Diary raw/history frontmatter restored
stable SQLite document id preserved
current SQLite title/summary/tags retained
metadata updatedAt advanced
```

没有把这些 body-only tests 宣称为 Mood history/recovery PASS。

### Not run

本阶段没有修改 production/client code，因此未运行 `typecheck`、`build` 或完整
browser suite；D7.0 的 blocker 是 architecture evidence，不是编译/运行失败。

## 20. Risks

- 选择 SQLite 但没有 generic History metadata revision，会产生 body revision 与
  mood revision 不一致。
- tags-only CAS 不能直接证明 mood CAS；无 token 的 metadata field update 可能造成
  silent overwrite，必须在 generic owner 内收紧。
- raw frontmatter 中的 `mood` 当前只是 custom field，可能被 migration cleanup
  归档/移除；不能与 SQLite mood 混用。
- 当前 bulk seam 是全 Vault `listPosts()`，不是专门的按月接口；它避免了客户端
  N+1，但未来应在同一 owner 内评估大 Vault 的 SQL/query 成本。
- body Recovery 与 metadata recovery 没有共同 revision model；在 contract 明确
  前不能宣称完整 lifecycle compatibility。

## 21. STOP conditions checked

已触发：

```text
History/Recovery semantics cannot yet restore or define Mood safely
Implementation Plan amendment required
```

未触发：

```text
new dependency
new Diary route
second tab/document lifecycle
Calendar/Dialog/Editor implementation
production fix required to prove this phase
```

因此本轮停止在 architecture evidence，不进入 D7.1。

## 22. D7.0 exit criteria

| Gate | Result | Evidence |
| --- | --- | --- |
| Existing metadata source/read/write owner identified | PASS | SQLite owner and metadata routes traced |
| Stable document identity and path role | PASS | `documents.id` survives rename; path is moving attribute |
| Existing CAS behavior identified | PASS / LIMITED | stale tag CAS proven; generic mood CAS not yet available |
| Metadata draft decision | PROVISIONAL PASS | explicit command should bypass session-only form draft |
| Dirty body + metadata boundary | PASS | metadata route does not write Markdown or call body save |
| History Comparison behavior | PASS / BODY-ONLY | Git raw/text diff only |
| History Restore behavior for Mood | **BLOCKED** | existing row metadata is retained, not restored from historical raw |
| Recovery behavior for Mood | **BLOCKED / DECISION REQUIRED** | body-only drafts have no metadata revision semantics |
| External body/metadata isolation | PASS / LIMITED | separate CAS channels; future mood CAS unproven |
| Rename/delete/recreate owner behavior | PASS / LIMITED | existing identity lifecycle traced; Mood column absent |
| Missing today/past/future authority | PASS | existing Diary command/route is sole create authority |
| Month bulk-read strategy | PASS / FUTURE SEAM | extend existing `listPosts` bulk response; no client N+1 |
| Unknown-field preservation | PASS / LIMITED | existing modeled fields preserved; arbitrary unknown fields unsupported |
| Frontmatter interaction | PASS | not a viable current generic Mood owner |
| Selected storage direction | **NOT SELECTED** | SQLite remains Candidate pending blocker resolution |
| No closed-PRD conflict | PASS / conditional | frontmatter is a recommendation pending verification; History contract still needs decision |
| No closed-Plan contradiction | **FAIL** | generic History metadata extension has no explicit production phase |

任一关键 gate 失败即按 closed Plan 将 D7.0 标记为 `BLOCKED`。

## 23. Historical final lifecycle state（原始 D7.0 gate）

```text
D6                         = REVIEW-CLOSED
D7 PRD                     = REVIEW-CLOSED
D7 Implementation Plan     = REVIEW-CLOSED (scope unchanged)
D7.0                      = BLOCKED
D7.0 Independent Review    = PASS on the BLOCKED determination (P0/P1/P2 = 0/1/0)
D7 Plan Amendment          = `diary-mood-implementation-plan-amendment-d7.0-history-metadata.md`
D7 Plan Amendment status   = REVIEW-READY (Independent Review = PENDING)
D7.0A                     = NOT STARTED
D7 Implementation         = NOT STARTED
D7.1                      = NOT STARTED
```

原始 D7.0 gate 没有实现 Mood，也没有开始 D7.1；当时下一步是完成
Implementation Plan amendment / generic History metadata decision。该历史 blocker
随后由已关闭的 Amendment 与 D7.0A foundation 承载，不得把原始 blocker 静默推入 D7.4。

## 24. D7.0 Revalidation after D7.0A

### 24.1 Revalidation scope and starting point

本次 revalidation 基于当前真实 production code、已关闭的 D7.0A foundation 以及
closed Amendment，目标是重新判断 SQLite-owned `DocumentMetadata` 能否作为 D7 Mood
的 storage direction。没有实现 Mood field、Mood registry、API、picker、Calendar
marker、frontmatter writer 或 D7.1；没有修改 production code、tests、dependencies，
也没有开始 D7.1。

```text
Starting HEAD:
e4fbff0d08e9efbe0e5b13bf76ccce9399a53968
docs(diary): close D7.0A history metadata review

Current branch: main
Worktree at start: clean
```

本次读取的 canonical design/evidence 文档为 `diary-mood-prd.md`、
`diary-mood-implementation-plan.md`、`diary-mood-d7.0-storage-metadata-verification.md`、
`diary-mood-implementation-plan-amendment-d7.0-history-metadata.md` 和
`diary-mood-d7.0a-history-metadata-foundation.md`。代码取证覆盖
`server/documentMetadata.ts`、`server/metadataVersion.ts`、
`server/history/metadataRevisions.ts`、`server/history/restore.ts`、migration 0009、
Diary routes/command、`server/tree.ts`、`src/lib/api.ts`、`useTabWorkspace` 与 draft
recovery owner。

原始 `696ccf...` gate 的 BLOCKED evidence、`03507ac...` characterization 和原始
`P0/P1/P2 = 0/1/0` review 结论仍保留在前面章节；本节只记录 blocker 关闭后的
revalidation facts。

### 24.2 Live metadata owner and identity

当前 `server/documentMetadata.ts` 的 live `DocumentMetadata` owner 仍是 SQLite
`documents` / `document_tags`，字段为：

```text
id, path, title, summary, tags, createdAt, updatedAt
```

`documents.id` 是稳定 identity，`path` 是可移动的当前位置；rename/move 保留 id，
delete/recreate 由现有 document lifecycle 产生新的 generation。metadata HTTP owner
仍是 `/api/metadata/documents/:id` 与 `/api/metadata/documents/*`，客户端仍通过
`getDocumentMetadataById()` / `updateDocumentMetadata()` 消费它。

`server/migrations/0009_history_metadata_revisions.sql` 明确把 history tables 与
`documents` / `document_tags` 分开：history tables 是 revision-bound evidence 与
durable operation journal，不是第二个 live metadata source of truth。

结论：SQLite 仍是唯一现有 live metadata owner；D7.0A 没有创建第二 owner，也没有
把 history snapshot 误当成当前 metadata。

### 24.3 D7.0A covered History Restore result

D7.0A 已在现有 History Restore owner 内建立 generic title/summary/tags snapshot：

```text
schemaVersion: 1
fields: { title, summary, tags }
```

当前 `resolveHistoryMetadataRevision()` 和 restore path 的事实为：

- covered revision 必须证明 capture 已 committed、document id/generation 一致、
  payload digest/schema 有效，并以 `bodySha` 绑定选定的 Git body；
- body restore 与 covered metadata apply 通过既有 identity、path safety、lock、restore
  journal、rollback 与 SQLite transaction boundary 协调；metadata apply 本身在
  `BEGIN IMMEDIATE` 内完成，不把 filesystem 与 SQLite 误称为一个 ACID transaction；
- `applyCoveredHistoricalMetadata()` 使用专用 CAS restore seam，即使 title/summary/
  tags 语义值与当前值相同，也会通过 `nextMetadataUpdatedAt()` 生成新的 metadata
  version；普通 metadata PATCH 的 equal-value no-op 语义没有改变；
- covered restore 成功返回 `metadataMode = restored`，stable id 保持不变；
- capture 缺失、path 未被 capture、或其它没有可信 snapshot 的 revision 仍走
  legacy body-only 分支，保留当前 durable metadata，返回明确的
  `metadataMode = unavailable`，不从历史 raw/frontmatter 推断 metadata；
- unknown field、unsupported/newer schema、digest/body mismatch、identity mismatch
  在 body mutation 前 fail closed；不会产生 body 与 metadata 混合的“成功”结果。

上述 covered v1 结论对 ordinary/non-Diary document 仍然成立；Mood 引入后的 canonical
Diary 兼容例外由下方 24.6 的 domain-scoped policy 单独定义，不会回溯性削弱普通 Note
的 metadata-aware History Restore。

这解决了原始 D7.0 blocker：covered generic History Restore 现在可以在同一 live
SQLite owner 中恢复已覆盖的 metadata，而不是只恢复 body 后继续冒充完整 revision
restore。

### 24.4 History Comparison and Recovery boundary

History Comparison 仍然是 D6 既有 body-only owner：Git raw、text diff、dirty state，
不虚构 SQLite metadata diff。它不会宣称 mood metadata comparison。

Recovery 仍然是 body-only：当前 `UnsavedDraft`、`DraftConflictRecord`、
`DraftBufferSnapshot` 与 IndexedDB draft records 都只承载正文、baseline、mtime、
path 和 stable document id，不承载 metadata snapshot。这个边界现在是明确的兼容
策略，而不是未决 blocker：

```text
body Recovery
→ 恢复正文 dirty state
→ 保留当前 durable SQLite metadata（包括未来的 mood）
→ 不把 body draft 当作 metadata revision
```

因此 Recovery 不会让 mood 从 stale raw 或 draft 中漂移；未来若要支持 metadata
recovery，必须扩展 generic owner 并重新审计，不得建立 Mood-specific recovery store。

### 24.5 CAS, dirty body, and lifecycle revalidation

- 当前 `updatedAt` 仍是同一 metadata version token；未来 mood set/change/clear 必须
  在这个 owner 内使用明确的 `expectedUpdatedAt`，不能新增版本源；
- body `raw/originalRaw`、`savePost(raw, baseRaw)` 与 draft persistence 仍由现有
  tab/document save owner 持有；metadata PATCH/covered restore 不写回 Markdown bytes，
  不复制 Monaco raw，也不清除 body dirty state；
- body CAS conflict 与 metadata CAS conflict 仍是两条独立通道；任何未来 mood
  mutation 都必须沿用同一 document identity、lock 与 transaction seam；
- Diary create 仍只由 `parseDiaryDate()`、`diaryLogicalPathForDate()`、
  `POST /api/diary/dates` 与现有 `openDiaryDate()` / `openPost()` 链路拥有；future
  Diary 不创建，existing path 不产生第二文件；
- delete/recreate 不继承旧 generation 的 mood。History rehydrate 只有在既有 tombstone
  与 stable identity proof 成立时才允许，不能按 path 猜 identity。

### 24.6 Pre-Mood v1 and future Mood schema policy

这是本次 revalidation 的关键 schema decision。

当前 v1 的 pre-Mood provenance 是确定的，而不是从 frontmatter 或当前 row 猜测：

1. `HISTORY_METADATA_SCHEMA_VERSION = 1` 的 canonical payload 只有
   `title`、`summary`、`tags`；
2. migration 0009 和已关闭 D7.0A scope 明确只建立 generic metadata foundation，
   D7.1 Mood 尚未进入 `DocumentMetadata` 或 v1 payload；
3. 当前 live `DocumentMetadata` 也没有 `mood`；
4. 因此在 D7.1 引入 Mood 前产生的 v1 capture 可以被严格标记为 pre-Mood v1。

但 v1 **没有显式保存 `mood: absent/null`**。为遵守已关闭 Amendment 的
“不能由缺失字段推断清空”规则，不能把“pre-Mood”偷换成“历史 mood 一定是 null”，
也不能把 v1 body/title/tags 与当前 mood 拼成 mixed revision。这个限制只适用于
Mood-applicable 的 canonical Diary document，不得扩散到普通 Note。

Mood applicability 必须使用现有 canonical Diary domain authority：只有
`classifyDiaryPath(path) === 'managed'` 的严格 `diary/YYYY-MM-DD` document 才进入
Mood 语义；`diary` root、`diary/*` unmanaged content 和其它 ordinary paths 都不是
Mood-capable document。不能用宽松的 `startsWith("diary/")` 来决定 schema policy。

最终冻结以下 domain-scoped compatibility matrix：

```text
A. v1 + ordinary/non-Diary document
→ v1 remains a supported covered schema
→ restore body + title + summary + tags
→ existing stable identity/CAS/journal semantics
→ metadataMode = restored
→ Mood is not applicable
→ ordinary Note History behavior remains unchanged

B. v1 + canonical managed Diary document after Mood exists
→ v1 has no explicit historical Mood value
→ do not infer mood = null
→ do not restore historical title/summary/tags + current mood as full success
→ legacy-compatible BODY-ONLY restore
→ preserve ALL current durable SQLite metadata: title, summary, tags, mood
→ return metadataMode = unavailable with typed reason pre-mood-schema
→ pre-mood-schema is distinct from pre-coverage / no-snapshot

C. v2 + canonical managed Diary document
→ exact payload includes title, summary, tags, mood: string | null
→ full body + generic metadata + Mood restore in one generic metadata transaction
→ metadataMode = restored

D. unsupported/newer schema for any document domain
→ fail closed before body mutation
→ never downgrade to legacy and never produce a mixed revision
```

这意味着 D7 Mood 的引入不会削弱 ordinary Note 的既有 History contract；只有 canonical
Diary 的 pre-Mood v1 需要显式的 metadata-unavailable limitation。一个可信 v1 snapshot
仍然是 covered snapshot，只是在 Diary/Mood 语义上缺少完整性，不得被错误标记成
pre-coverage。

D7.1 若引入 Mood，必须同时把 canonical Diary 的 Mood-aware capture schema 升级为 v2，
并保证 Mood 启用后不会继续写新的 v1 capture。v1/v2 不能混用字段，也不能通过“当前
没有 mood”补齐历史 v1。只有 v2 的显式 `mood` 值（包括显式 `null`）可以参与完整
Mood-aware restore。

未来 v2 的兼容规则：

- ordinary/non-Diary document 继续按 v1/v2 中其适用的 generic metadata schema restore，
  不产生 Mood 语义；
- canonical Diary document 的 v2 exact payload includes `mood: string | null`，full
  restore 必须在同一 generic metadata transaction 内完成；
- known field + unknown mood **value**（仍为合法 opaque string）必须原样保存、读取和
  restore；旧 registry 不认识该 ID 时不得清空；
- unknown field 或 unsupported newer schema 必须在任何 body mutation 前 fail closed；
- 不允许生成“历史 v1 body/metadata + 当前 mood”或其它 mixed revision success；
- frontmatter 中的 `mood` 仍不是 controlled source，不能为 v1/v2 补 metadata，也不能
  覆盖 SQLite owner。

这套策略同时满足：

- ordinary Note v1 covered restore 不退化；
- canonical Diary v1 不会产生 historical fields + current mood 的 mixed revision；
- v1 的 `pre-mood-schema` limitation 与真正的 pre-coverage legacy branch 清楚分离；
- v2 成为第一个完整 Mood-aware History schema。

该策略依赖真实的 Diary classification 和 schema provenance，而不是 frontmatter 或
当前 metadata 状态猜测；它也不通过改变 D1/D2 contract 或新建 Mood history pipeline
来绕过问题。

### 24.7 Metadata draft and frontmatter decision

当前 `metadataDraftStore` 仍是 session-only 的 title/summary/tags form draft，不接入
body Recovery。D7 Mood 的推荐实现方向保持为显式 set/change/clear command，直接进入
同一个 SQLite metadata CAS owner；不创建 Mood-specific persistent draft，除非未来
另有已审计的 generic metadata draft contract。

frontmatter 仍只是兼容 raw/custom view，不是 controlled Mood read/write owner。SQLite
selected direction 不要求把 stable Mood ID 写入 Markdown，也不要求从 raw frontmatter
反向导入 Mood。

### 24.8 Calendar month bulk-read and reactive ownership

当前 `useTabWorkspace.refresh()` 通过一次 `listPosts()` bulk response 获取全 Vault
`PostSummary[]`，而不是为 35–42 个 Calendar cells 发起逐项 metadata GET。当前 response
尚未包含 mood，但接入 D7 时应在同一 `PostSummary` / query owner 内为严格合法
`diary/YYYY-MM-DD` 增加可选 `mood`（必要时带 stable document id），由现有 workspace
reactive collection 派生 Calendar month map。

这保留：

- 单一 bulk read / invalidation seam，不新增 Diary-specific metadata route；
- 一个 reactive owner，不让 Calendar picker 自己持有第二份 cache；
- ordinary note 与 Archive/Inbox/Literature/Ledger 语义不变；
- D7.1/D7.3 可在同一 owner 内优化为按日期范围的单次 SQL，而不改变 ownership。

本次没有实现 `mood` 字段或改变 `PostSummary`，所以这只是通过 gate 的 future seam，不是
production implementation evidence。

### 24.9 Revalidation tests actually run

本次实际运行的 focused evidence：

```text
npm exec vitest run \
  server/__tests__/documentMetadata.test.ts \
  server/__tests__/metadata-api.test.ts \
  server/__tests__/history-metadata-revisions.test.ts
→ 3 files / 66 tests passed

npm run test:history-integration
→ 5 files / 174 tests passed

npm run test:recovery-integration
→ 5 files / 193 tests passed

npm exec vitest run \
  server/__tests__/diary-routes.test.ts \
  server/__tests__/documentFileLifecycle.test.ts \
  src/composables/diary/__tests__/useDiaryDateCommand.test.ts \
  shared/__tests__/diaryProtocol.test.ts \
  src/composables/vault/__tests__/useHistoryRestore.test.ts \
  src/composables/vault/__tests__/useHistoryComparisons.test.ts
→ 6 files / 91 tests passed
```

Recovery integration 的第一次无提升权限调用只遇到子进程 IPC pipe 的环境性
`listen EPERM`；按仓库既有环境约定，以同一命令提升权限重跑后 5 files / 193 tests
全部通过。没有发生 feature assertion failure。

本次没有修改 TypeScript/client/test code，因此没有把 `typecheck`、`build` 或 browser
suite 的历史结果冒充为本次新运行结果；D7.0A 文档中已有的历史 typecheck/build 记录
仍作为历史证据保留。

### 24.10 Current exit matrix

| Gate | Current result | Evidence |
| --- | --- | --- |
| SQLite live metadata owner identified | PASS | `DocumentMetadata` / `documents` / `document_tags` traced |
| Stable identity, path, generation | PASS | rename/delete/recreate owner and lifecycle tests |
| Covered generic History metadata restore | PASS | D7.0A schema v1, body binding, identity, CAS and journal evidence |
| Legacy/pre-coverage restore policy | PASS | body-only, current metadata preserved, explicit unavailable result |
| History Comparison boundary | PASS | remains body-only; no false metadata claim |
| Recovery boundary | PASS | body-only recovery preserves durable metadata |
| Metadata CAS for future Mood | PASS / implementation pending | same `updatedAt` owner and explicit token required |
| Dirty body isolation | PASS | metadata paths do not write body/draft state |
| Pre-Mood v1 policy | PASS | domain-scoped; ordinary Note remains covered, Diary has explicit pre-mood limitation |
| Ordinary Note v1 compatibility | PASS | v1 restores body + title/summary/tags with no Mood semantics |
| Future v2 Mood schema policy | PASS / implementation pending | explicit `mood: string \| null`; unknown value opaque; unknown schema fail closed |
| No mixed historical/current revision | PASS | Diary v1 never combines with current Mood; v2 restores atomically |
| Delete/recreate/generation boundary | PASS / Mood implementation pending | existing identity proof and Diary lifecycle authority |
| Diary date authority and future guard | PASS | existing command/route tests |
| Calendar month bulk-read seam | PASS / future seam | one `listPosts()` bulk owner; no per-cell GET |
| Reactive single-owner direction | PASS / future seam | `useTabWorkspace.posts` / refresh owner |
| Frontmatter as controlled Mood source | PASS | explicitly rejected; SQLite remains owner |
| No second metadata/history/recovery owner | PASS | D7.0A tables are revision evidence only |
| Selected Storage Direction | **PASS — SQLite-owned `DocumentMetadata`** | all blocker gates revalidated |

所有当前 gate 均通过；尚未实现的内容是 D7.1 production work，不是 D7.0 storage
ownership blocker。

### 24.11 Current lifecycle and D7.1 readiness

本节 revalidation evidence 提交时先停在以下状态；该历史状态保留，表示当时仍在等待
Independent Revalidation Review：

```text
D7.0                      = REVIEW-READY
D7.0 Independent Review   = PENDING
```

Independent Revalidation Review 通过后，本 closure sync 的当前生命周期为：

```text
D6                         = REVIEW-CLOSED
D7 PRD                     = REVIEW-CLOSED
D7 Implementation Plan     = REVIEW-CLOSED
D7 Plan Amendment          = REVIEW-CLOSED
D7.0A                     = REVIEW-CLOSED
D7.0                      = REVIEW-CLOSED
D7.0 Independent Revalidation Review = PASS (P0/P1/P2 = 0/0/0)
D7.0 self-review           = P0/P1/P2 = 0/0/0
Selected storage           = SQLite-owned DocumentMetadata
D7.1                      = NOT STARTED
D7 Mood production         = NOT STARTED
```

D7.1 readiness gate：

```text
[x] live SQLite metadata owner and stable identity confirmed
[x] D7.0A covered History Restore confirmed
[x] legacy/pre-coverage body-only limitation explicit
[x] History Comparison remains body-only
[x] Recovery preserves durable metadata
[x] CAS/version and dirty-body boundaries confirmed
[x] pre-Mood v1 policy is deterministic, domain-scoped, and non-mixed
[x] ordinary Note v1 covered restore remains metadata-aware
[x] Diary v1 has an explicit pre-mood-schema limitation distinct from pre-coverage
[x] future Mood-aware v2 is the first full Mood schema
[x] unknown mood value and unknown field behavior separated
[x] Diary date/create/future authority unchanged
[x] single bulk-read/reactive seam identified
[x] no second metadata/history/recovery owner required
[x] frontmatter is not controlled Mood source
[x] no D6/D1/D2 contract changed
[x] no D7.1 code written
```

### 24.12 STOP conditions checked

本次没有触发 STOP condition：

```text
no new Diary route
no second tab/document store
no second metadata/history/recovery owner
no Mood-specific History or Recovery pipeline
no frontmatter source-of-truth switch
no D1/D2 contract change
no server Diary API change
no dependency change
no mixed revision success
no unsupported schema accepted after body mutation
no D7.1 implementation
```

D7.0A 已经解决 generic History metadata foundation；本次 revalidation 也已把
pre-Mood v1、future Mood schema、CAS、Recovery、bulk-read 与 no-mixed-revision policy
固定下来。因此原始 P1 blocker 已关闭。revalidation evidence commit 当时停在
`REVIEW-READY` / Independent Revalidation Review `PENDING`；在 Independent
Revalidation Review 以 `PASS (P0/P1/P2 = 0/0/0)` 通过后，本 closure sync 将 D7.0
更新为 `REVIEW-CLOSED`。

### 24.13 Conclusion

```text
D7.0                               = REVIEW-CLOSED
Independent Revalidation Review    = PASS (P0/P1/P2 = 0/0/0)
Self-review                       = P0/P1/P2 = 0/0/0
Selected Storage Direction        = SQLite-owned DocumentMetadata
D7.1                             = NOT STARTED
```

SQLite 现在可以作为 D7.1 的 selected storage direction：它沿用当前 live metadata
owner、stable identity、CAS、transaction、History Restore foundation、body-only
Recovery boundary 和单一 bulk-read seam。后续只能在 D7.1 implementation phase 内按
本节 schema policy 接入 Mood；本 closure commit 不开始 D7.1，当前 D7.1 仍为
`NOT STARTED`。
