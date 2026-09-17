# D7.0A — Generic History Metadata Revision Foundation

> **Historical lineage — not current runtime authority.** Current behavior is
> defined by [Diary Architecture](../architecture/diary.md) and [Diary User
> Guide](../user-guide/diary.md). This file is retained for D7 traceability.

状态：**REVIEW-CLOSED**
Independent Review：**PASS**
P0/P1/P2：**0/0/0**
Starting HEAD：`e38505cda16e7dcd4d5b9335e9165ded3f86547d`

本文件记录 D7.0A 的 implementation/evidence 结果及 Independent Review closure。
D7.0A 已完成并正式关闭；D7.0 的 storage blocker 仍然保留，必须先完成后续
D7.0 revalidation，不能由本阶段自动解除。

Implementation commits：

1. `6ac78658f6e732afacd230852438ee7d3d0a03f1` — `feat(history): add generic metadata revision storage`
2. `f06a1756eb9c85af297c542983cac958c9641d75` — `feat(history): bind metadata snapshots to revisions`
3. `5edd105e646ad0104cbc05f95e3ca144596d12f5` — `feat(history): restore generic metadata revisions`
4. `081884581f6892a93afa5575f9550dfb5f720fbc` — `test(history): cover metadata revision lifecycle`
5. `256c30c43c9a5a268abdd5fc1a317ea82109d3fa` — `fix(history): close D7.0A metadata journal findings`

## 1. Scope and lifecycle boundary

D7.0A 只实现 generic History metadata revision foundation，当前 controlled
metadata 仅为：

- `title`
- `summary`
- `tags`

本阶段没有实现 `mood`、Mood registry、Mood API、Calendar marker、picker、Native
Mood context 或 D7.1 UI。D7.0A 也没有改变 Diary、Calendar、Vault、tab、route、
Recovery 或 History Comparison 的 ownership。

当前 lifecycle：

```text
D7 Plan Amendment = REVIEW-CLOSED
D7.0              = BLOCKED
D7.0A             = REVIEW-CLOSED
D7.0A IR          = PASS (P0/P1/P2 = 0/0/0)
D7.1              = NOT STARTED
D7 Mood production = NOT STARTED
```

D7.0A `REVIEW-CLOSED` 后仍必须回到 D7.0 做独立 revalidation；本阶段不会进入
D7.0 revalidation 或 D7.1。

## 2. Changed architecture and files

本阶段只扩展现有 server History/metadata owner：

| Area | Implementation | Boundary |
| --- | --- | --- |
| SQLite schema | `server/migrations/0009_history_metadata_revisions.sql` | 同一个 Nuvyn SQLite DB；additive migration；不删除或替换 live metadata |
| Historical codec/journal | `server/history/metadataRevisions.ts` | generic payload、coverage、capture/restore journal、reconciliation |
| Live metadata owner | `server/documentMetadata.ts` | transaction-local create、validated historical field apply、identity tombstone provenance |
| Git binding seam | `server/history/git.ts` | `commit-tree` 后绑定 immutable proof、保持 capture `prepared`；`update-ref` 成功后才标记 `committed`；test hooks 仍独立 |
| History routes | `server/history/routes.ts` | `/commits` capture、`/restore` result/error、`/drop` withdrawal retirement |
| Restore owner | `server/history/restore.ts` | covered body + metadata restore；legacy body-only branch |
| Startup reconciliation | `server/prod.ts`、`server/vite-plugin.ts` | crash recovery 后、接收请求前检查 unresolved journals |
| Existing client result surface | `src/lib/history-api.ts`、`src/composables/vault/useHistoryRestore.ts`、`src/views/VaultView.vue`、`src/composables/useI18n.ts` | 只增加 legacy metadata-unavailable typed result/toast；没有新 History UI |

对应测试包括新的 `server/__tests__/history-metadata-revisions.test.ts` 以及
migration schema-version 回归断言。没有修改 D7 PRD、原 D7 Implementation Plan、
已关闭 Amendment 或 D7.0 blocker evidence。

## 3. Migration and historical model

Migration `0009_history_metadata_revisions.sql` 创建四类历史/审计表：

1. `history_metadata_operations`：capture/restore operation、vault、状态、
   expected parent、commit/tree/body proof、错误和时间。
2. `history_metadata_revisions`：每个 affected path 的 immutable commit/tree/parent
   绑定、stable document/generation identity、coverage kind、schema、payload、
   digest 和 body hash。
3. `history_metadata_restore_journal`：restore 前后的 body 与 metadata image、
   target digest 和跨 filesystem/SQLite compensation 状态。
4. `history_metadata_document_tombstones`：删除 generation 的 identity-only provenance，
   仅用于 create-only historical rehydrate，不是 live metadata owner。

`documents`、`document_tags`、`tags` 仍是唯一 current/live metadata source of truth。
历史表不被 Calendar、普通 document read、metadata panel 或普通 write 当作 current
state 读取。

## 4. Canonical payload and schema policy

当前 payload 是受控、可版本化、可 digest 的 envelope：

```json
{
  "schemaVersion": 1,
  "fields": {
    "title": "Title",
    "summary": "Summary",
    "tags": ["alpha", "future-opaque-tag"]
  }
}
```

编码器复用现有 metadata/tag normalization；title/summary 使用现有长度和非空
约束，tags 以 normalized-name 顺序稳定序列化。digest 是 canonical JSON bytes 的
SHA-256。解码器要求 envelope 和 fields 使用 exact keys，并验证 schema、shape、
canonical values 和 digest。

- supported schema + valid digest：允许 covered restore；
- `schemaVersion` 更高或不支持：`HISTORY_METADATA_UNSUPPORTED_SCHEMA`，在 body
  mutation 前拒绝；
- unknown controlled field、缺失字段、错误 shape 或 digest mismatch：稳定的
  corrupt/unknown-field error，在 body mutation 前拒绝；
- 当前 known field 的 unknown value（例如未来字段 value 的 generic fixture）不因
  registry 不认识而被清空；payload 作为 opaque known-field value 保留并按原语义
  restore；
- 不读取或解析 historical Markdown Frontmatter 作为 metadata snapshot source。

## 5. Coverage model

coverage 不是“查不到 snapshot 就当 legacy”的隐式判断，而由 durable capture
operation 和 per-path row 共同证明：

| State | Meaning | Restore policy |
| --- | --- | --- |
| no capture operation for SHA | pre-coverage/external legacy revision | existing body-only restore；current metadata preserved；返回 metadata unavailable |
| committed capture, selected path has `legacy` row | commit captured the path while no live metadata row existed | body-only legacy policy；不从 Frontmatter 推断 |
| committed capture, selected path has `covered` row | trusted snapshot-covered revision | validate row, payload, digest, identity and body binding；restore body + matching metadata |
| capture operation prepared/non-committed | pending/unpublished operation | unbound capture aborts；SHA-bound capture 依据 reachable SHA 或 unchanged expected parent 确定性地 commit/abort，否则才 ambiguous；不当作 trusted coverage |
| committed capture row missing/corrupt | covered evidence is incomplete | `HISTORY_METADATA_CORRUPT`/stable repair error；不降级成 legacy |
| committed capture SHA unreachable from current Git HEAD | cross-store publication cannot be proven | `HISTORY_METADATA_JOURNAL_AMBIGUOUS`；fail closed |

因此，外部/pre-coverage revision 与 Nuvyn 已开始 capture 但 evidence 损坏的 revision
保持可区分。

## 6. Capture flow and locking

History `/commits` 的 production flow 为：

```text
withVaultMutation
  → reconcile pending History metadata journals
  → sorted logical document write locks
  → prepare live metadata capture journal
  → existing git.addAndCommit(expected body hashes)
      → temporary index / write-tree
      → commit-tree creates immutable commit SHA
      → bind metadata rows and verify SHA/parent/tree/body while capture remains prepared
      → update-ref HEAD with expected-parent CAS
      → mark capture committed only after update-ref succeeds
      → existing index synchronization/repair
```

selected `*.md` path 会先转换为同一 document owner 使用的 logical path，避免
`.md` key 与 metadata key 分裂。全局顺序保持为：

```text
Vault mutation coordinator
  → sorted document locks
  → History repository mutation queue
  → Git index/filesystem boundary
```

formal production seam 是 `afterCommitObjectCreatedBeforeRefUpdate` 加上
`afterRefUpdated`：前者只绑定 immutable proof，后者只在 `update-ref` 成功后提交
durable capture 状态。它与 `beforeCommitTreeForTesting`、`beforeUpdateRefForTesting`
等 test-only hooks 分开；不会把 testing hook 当成 production protocol。

Capture snapshot 来自 live `DocumentMetadata` row，并且一个 multi-file commit 使用
一个 capture operation、每个 affected path 一条独立 revision row。body hash、tree
和 parent 都在 immutable SHA 绑定时再次验证。

## 7. Capture journal and crash reconciliation

capture journal 使用 `prepared`、`committed`、`aborted`、`ambiguous` 等状态；restore
journal 还使用 `compensating`、`recovered`、`failed` 等状态。reconciliation 入口
有两层：

- History capture/restore/drop mutation 开始前；
- `server/prod.ts` 和 `server/vite-plugin.ts` 在 filesystem crash recovery 后、
  metadata migration/请求处理前。

reconciliation 规则是确定性的：

- prepared capture 没有 durable SHA binding：abort；
- prepared capture 已绑定 SHA 且该 SHA 从当前 HEAD reachable：验证 immutable
  commit/tree/parent/body/revision proof 后标记 committed；
- prepared capture 已绑定 SHA、该 SHA 不可达且当前 HEAD 仍等于 expected parent：证明
  `update-ref` 未发布，abort；
- prepared capture 已绑定 SHA，但既不能证明已发布也不能证明未发布：标记 ambiguous
  并 fail closed；
- committed capture 仍可由当前 HEAD reach：保留；
- committed capture 不可达：标记 ambiguous 并 fail closed；
- prepared restore：逐项比较 before/target body 与 metadata image，只在能证明完整
  target、完整 before 或安全 compensation 时结束；否则保留 ambiguous journal；
- History withdrawal 成功后退休对应 capture record，避免有意移除的 HEAD 被下一次
  reconciliation 误判为未知丢失；突发中断导致无法证明时仍保持 repair/ambiguous，
  不猜测、不自动删除用户 Git history。

## 8. Snapshot-covered Restore

covered restore 先在 filesystem mutation 前完成：

1. existing path/ref policy 和 immutable resolved commit SHA；
2. historical body 存在且与 captured body hash 相同；
3. capture coverage、schema、payload digest；
4. stable document id、generation id、path-at-revision；
5. 当前 live metadata identity/version，以及 delete/recreate tombstone proof。

通过 preflight 后，Restore journal 保存 before/target body 和 metadata image。body 使用
existing atomic create/replace protocol；metadata 使用现有 `documents` / tags owner
的 transaction-local validated field apply，恢复 title/summary/tags，但不直接写回
historical `updatedAt`、tag numeric ID 或 derived rows。成功时由 current metadata
version owner mint 一个严格更新的 fresh `updatedAt`；即使恢复后的
title/summary/tags 与当前值语义相同，也必须产生新的 current metadata version，
因为 body revision 已发生变化。普通 metadata PATCH 的 no-op 语义保持不变。

如果 body 已替换但 metadata CAS/identity apply 失败，body 只在仍等于 target 的情况
下 rollback；外部 bytes/identity 赢得竞争时保留外部结果并返回稳定 conflict，保留
journal，不静默覆盖。prepared restore 的 startup reconciliation 覆盖 body-only
partial、metadata-only partial、complete target 和 ambiguous 状态。

## 9. Legacy Restore

没有 trusted generic snapshot 的 ordinary Note revision 继续走既有 body-only Restore：

- historical Markdown body 可以恢复；
- current durable SQLite metadata fields 保持，不从 historical Frontmatter 导入；
- metadata row 原本不存在时，不因 Frontmatter 自动创建 row；
- API result 明确返回：

```json
{
  "metadataMode": "unavailable",
  "metadataRestored": false,
  "metadataPreserved": true
}
```

客户端只在现有 toast surface 显示 metadata-unavailable/preserved-current 提示；没有
新增 History panel、metadata diff 或 Mood UI。

## 10. Identity, rename, delete and recreate

schema v1 使用 `documents.id` 作为 stable document identity 和 generation proof：

- rename/move 继续保留 id，历史 row 同时保存 path-at-revision；
- delete 通过现有 lifecycle 写入 identity tombstone provenance；
- same path recreate 获得新 id/generation；
- covered create-only Restore 只有在 matching tombstone、目标 id 未在其它 path
  占用且 path/file preflight 通过时才允许 rehydrate；
- current row id/generation 与 historical row 不匹配时，在 body mutation 前返回
  identity conflict；
- delete/recreate test 证明旧 generation metadata 不会写入新 generation。

历史 tombstone 只证明 generation identity，不成为第二 live metadata owner。

## 11. Failure and conflict evidence

新的 D7.0A integration suite 实际覆盖：

| Boundary | Observed behavior |
| --- | --- |
| SQLite capture preparation failure | no published Git ref；live metadata/body unchanged |
| `commit-tree` failure | no ref publication；prepared capture 可被 reconciliation abort |
| metadata finalization failure after commit object | no ref publication；unreachable object 不冒充 History success |
| known `update-ref` failure after durable SHA binding | capture remains `prepared` + bound；route aborts the known unpublished operation；若进程在此处中断，reconciliation uses reachability/expected-parent proof instead of permanently guessing ambiguous |
| `update-ref` succeeded but committed mark was interrupted | capture remains `prepared` + bound；reachable immutable SHA and complete proof let reconciliation mark it `committed` |
| bound SHA is unreachable while expected parent is unchanged | publication is proven absent；reconciliation aborts the bound capture and permits the next commit |
| bound SHA publication cannot be proven | reconciliation marks the capture explicitly `ambiguous` and fails closed |
| missing selected covered row | `HISTORY_METADATA_CORRUPT` before body mutation |
| unsupported/newer schema | stable rejection before body/metadata mutation |
| unknown controlled field | stable rejection before body mutation；不能 mixed restore |
| external body race | body conflict；external bytes remain；metadata remains unchanged |
| external metadata/identity race | metadata conflict；body rollback或保持安全 before-state |
| body-only partial restore journal | safe body rollback and journal abort |
| metadata-only partial restore journal | safe metadata compensation and journal abort |

这些 failure paths 都不自动 drop/rewrite 用户 Git commit，也不通过 commit message
猜测 snapshot 归属。

## 12. History Comparison and Recovery regression

History Comparison 仍然只比较 body/raw/diff；没有 metadata diff UI 或 mood history。
Recovery 仍然只处理 Markdown body draft；没有扩展 IndexedDB/draft schema，也没有
metadata draft snapshot。现有 behavior 通过既有 integration suites 回归：

- `npm run test:history-integration`：5 files，174 passed；
- `npm run test:recovery-integration`：5 files，193 passed；
- 新 `server/__tests__/history-metadata-revisions.test.ts`：27 passed；
- `npm run test:unit`：229 files，3455 passed，2 skipped。

Recovery 与 History Comparison 不读取 `history_metadata_*` tables 作为 current state；
D6 Diary lifecycle 也没有新增 route/tab/document owner。

## 13. Validation commands and results

已执行：

- `npm exec vitest run server/__tests__/history-metadata-revisions.test.ts --reporter=verbose`：PASS，27 tests；
- `npm run test:history-integration`：PASS，174 tests；
- `npm run test:recovery-integration`：PASS，193 tests；
- `npm run test:unit`：PASS，3455 passed，2 skipped；
- `npm run typecheck`：PASS，client/server typecheck 均通过；
- `npm run build`：PASS；构建仅有既存 Rolldown `@vueuse/core` PURE annotation 和 chunk-size warnings；
- `git diff --check`：implementation/test changes 已通过，最终 evidence commit 前会再次执行。

History/Recovery 的本地集成 server 在受限 sandbox 中曾被 `listen EPERM` 阻断；按
环境要求提升本地执行权限后，相关真实 suite 全部通过。此环境事实不作为 feature
failure。

本阶段没有运行 E2E；没有新增 UI 或 browser behavior，故不以 E2E 结果证明本阶段
capability。

GitHub status：**not queried**。

## 14. Risks and STOP conditions

仍保留以下真实边界：

- Git 与 SQLite 无法共享 native transaction；durable journal 采用 fail-closed
  reconciliation，不宣称不可证明的跨 store atomicity；
- legacy revision 的 metadata 仍明确 unavailable，不能被误读为历史 metadata 为空；
- schema v1 的 stable generation proof 依赖现有 `documents.id` + tombstone provenance；
  identity 不可证明时拒绝 restore；
- unexpected process loss in a cross-store boundary is recoverable when the bound SHA is
  reachable or the expected parent proves non-publication；only an unprovable publication
  state can leave an explicit ambiguous repair state；startup 不会猜测或自动删改用户内容；
- D7.0 storage decision 尚未因 D7.0A implementation 自动升级为 selected；Mood 仍未
  实现。

本阶段没有触发 STOP condition：没有 Mood-specific History、第二数据库、sidecar、
Recovery metadata schema、第二 live owner、新 History UI、frontmatter rewrite、
新 route/tab lifecycle、依赖变更或 closed PRD/Amendment 修改。

## 15. D7.0A exit checklist

- [x] generic historical metadata revision model and additive v9 migration
- [x] existing SQLite `DocumentMetadata` remains live authority
- [x] title/summary/tags canonical payload, schema and digest
- [x] covered / legacy / pending / corrupt / ambiguous coverage distinction
- [x] immutable Git SHA + parent/tree/body binding
- [x] capture remains prepared until ref publication, with deterministic reachable/unpublished/ambiguous reconciliation
- [x] sorted document lock and existing History Git seam
- [x] capture/restore durable journal and startup reconciliation
- [x] snapshot-covered body + generic metadata Restore
- [x] fresh current `updatedAt` and existing metadata CAS semantics, including semantically unchanged covered restores
- [x] body/metadata compensation and external conflict handling
- [x] legacy body-only Restore with current metadata preserved and explicit limitation
- [x] unsupported schema/unknown field fail-closed policy
- [x] known-field opaque-value preservation fixture
- [x] rename identity and delete/recreate generation isolation
- [x] History Comparison remains body-only
- [x] Recovery remains body-only with no metadata draft schema expansion
- [x] no Mood code, Mood UI, second DB, sidecar or second live owner
- [x] ordinary History and D6 Diary regressions pass
- [x] focused tests, integration tests, unit tests, typecheck and build pass
- [x] final diff scope remains within D7.0A implementation/evidence

## 16. Conclusion and next gate

D7.0A generic History metadata foundation 已完成实现和 evidence，停止在：

```text
D7.0A = REVIEW-CLOSED
D7.0A Independent Review = PASS
D7.0A P0/P1/P2 = 0/0/0
D7.0   = BLOCKED
D7.1   = NOT STARTED
D7 Mood production = NOT STARTED
```

Independent Review 已通过，本 closure sync 将 D7.0A 标记为 `REVIEW-CLOSED`；仍然
必须先回到 D7.0 做独立 revalidation。不得在本 closure commit 后自动开始 D7.0
revalidation 或 D7.1。
