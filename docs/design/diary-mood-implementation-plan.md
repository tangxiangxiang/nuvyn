# D7 — Mood Diary Implementation Plan

> **Historical implementation lineage — not current runtime authority.** Use
> [Diary Architecture](../architecture/diary.md) and [Diary User
> Guide](../user-guide/diary.md) for current behavior. This file records the
> closed D7 implementation lineage; its old `NOT STARTED` wording is historical.

状态：**REVIEW-CLOSED**
Independent Review：PASS
P0/P1/P2：0/0/0
Starting HEAD：`a071a5f090f5a576d3dcd90e7750bb9d9f79a888`
PRD：[`diary-mood-prd.md`](./diary-mood-prd.md)，已 `REVIEW-CLOSED`

本文件只规划 D7，不实现生产代码、测试或依赖。D7 Implementation 仍为 `NOT STARTED`。

## 1. Current Repository Findings

以下结论来自当前代码，而非仅依据 PRD：

| Concern | Current fact | Evidence |
| --- | --- | --- |
| Metadata source of truth | SQLite `documents` / `document_tags` 图；前端 `PostDetail.frontmatter` 是兼容读取字段，不是当前 generic metadata 写入 owner | `server/documentMetadata.ts:11-42`, `src/lib/api.ts:40-72` |
| Metadata identity | 稳定 `documents.id`，并以 `path` 做当前定位 | `server/migrations/0002_document_metadata.sql`, `src/lib/api.ts:210-230` |
| Metadata read/write | `getDocumentMetadata*`, `patchDocumentMetadata`; route 为 `GET /api/metadata/documents/:id` 与 `PATCH /api/metadata/documents/*` | `server/documentMetadata.ts:856-1030`, `server/routes/metadata.ts:105-164` |
| Metadata fields today | `title`, `summary`, `tags`, `createdAt`, `updatedAt`；没有 `mood` | `server/documentMetadata.ts:11-42` |
| Metadata versioning | `updatedAt` 与 `expectedUpdatedAt` 对显式 tag patch 提供版本冲突保护；实现需为 mood 明确 CAS 语义 | `server/documentMetadata.ts:961-1022`, `server/routes/metadata.ts:137-155` |
| Metadata draft | `metadataDrafts` 是 session-only `Map`，按 stable id/path 识别，不持久化，也不连接 recovery | `src/components/vault/metadataDraftStore.ts:1-35` |
| Body save | body 通过 `savePost(raw, baseRaw)` 与现有 CAS/save lifecycle；metadata route 不重写 Markdown | `src/lib/api.ts:178-206`, `src/views/metadataPostSummary.ts:1-18` |
| Diary creation | Diary route owns date creation and returns `created`; mood 不得另造 create path | `server/routes/diary.ts:120-216`, `src/lib/api.ts:276-299` |
| File lifecycle | rename/delete/move 通过 posts/document metadata transaction 同步维护 metadata identity | `server/routes/posts.ts:504-664`, `server/documentMetadata.ts:1106-1354` |
| History/recovery | existing History and draft-recovery owners live in VaultView/composables; this Plan has not yet proven a new metadata field is included in every restore path | `src/views/VaultView.vue:225-320`, `src/views/VaultView.vue:525-545` |

### Consequence

`mood` 不能直接被实现为 frontmatter rewrite、sidecar 或第二个数据库。当前最安全的 candidate 是扩展现有 SQLite metadata owner，但它必须先通过 D7.0 验证：未知字段保留、History/Restore、Recovery、CAS 及 dirty body coexistence 都不能被破坏。

## 2. Frozen Product Contract

- 一日最多一个 mood，支持 set/change/clear；无值为 absent/null。
- 固定 24 项，stable ID 与 SVG 映射继承 closed PRD，不得改 catalog。
- Picker 固定 **4 columns × 6 rows**、row-major，不得转置为 6 × 4；desktop/tablet/mobile 均保持该方向与顺序。
- 文档只持久化 stable ID，例如 `mood: happy`；绝不持久化 SVG 路径或中文文件名。
- `DiaryDate ↔ diary/YYYY-MM-DD.md` 不变；Mood 不可产生 orphan record。
- Calendar 负责导航，Vault 负责文档；D6 的 Native Workspace、route、tab、raw、save、dirty、History、Recovery ownership 全部保持。

## 3. D7.0 — Storage / Metadata Ownership Verification

这是进入 UI 前的 architecture gate，预期不改生产代码，以 investigation/tests/evidence 为主。必须确认：

1. SQLite generic metadata 是否扩展 `mood`，以及 API/schema/version/validation 位置。
2. metadata identity、CAS token、未知字段和 unrelated fields 的保留语义。
3. dirty body + mood write 不 GET 后重写 stale Markdown，不覆盖 raw/model，不清 dirty。
4. History Comparison/Restore、baseline/divergent Recovery、external metadata/body conflict 对 mood 的完整语义。
5. delete、rename/move、recreate 后 metadata 的处理。
6. Calendar month 是否已有 bulk metadata/post-summary seam；不得为 35–42 个 cell 做 N+1 请求。
7. missing today/past 必须复用 existing Diary date command；missing future 禁止创建或保存 mood。

任一项无法证明，D7.0 = `BLOCKED`，需要 product/architecture review；不得进入 D7.1。

本次 D7.0 取证已完成并记录于
[`diary-mood-d7.0-storage-metadata-verification.md`](./diary-mood-d7.0-storage-metadata-verification.md)。
现有 History Restore 只恢复 Markdown/body，不恢复 SQLite metadata revision；现有
Recovery 也只持久化 body draft。因此 SQLite 仍是 candidate，D7.0 当前为
`BLOCKED`，并需要在 D7.1 前完成 generic History metadata decision 与
Implementation Plan amendment。D7.1–D7.6 的既有 scope 未静默改变。

### D7.0 blocker-resolution amendment

D7.0 的 generic History metadata revision 缺口由独立 Amendment 承载：

[`diary-mood-implementation-plan-amendment-d7.0-history-metadata.md`](./diary-mood-implementation-plan-amendment-d7.0-history-metadata.md)

Amendment 当前为 `REVIEW-READY`、Independent Review `PENDING`；它定义
`D7.0A — Generic History Metadata Revision Foundation`，但不实现 D7.0A。
`D7.0A = NOT STARTED`。D7.0 继续 `BLOCKED`，SQLite 继续
`CANDIDATE / NOT SELECTED`，D7.1 继续 `NOT STARTED`。

## 4. Recommended Storage Direction

**Candidate：扩展现有 SQLite-owned `DocumentMetadata`。** 这是当前推荐方向，因为它已有稳定 document identity、server authority、metadata patch seam、version token、rename/delete transaction 和前端 metadata API。

但在 D7.0 关闭前不标记为最终 selected storage：当前类型没有 mood，当前 metadata draft/recovery 与 History 对新增字段的覆盖范围仍需证据。若只能通过独立 sidecar 或重写 Markdown 才实现，则触发 STOP，不静默批准第二 source of truth。

## 5. Data and Domain Model

### Mood registry

由单一 registry owner 提供恰好 24 个定义，每项包含 `id`, `zhLabel`, `enLabel`, `asset`, `row`, `column`, `ariaLabel`。顺序固定为 PRD 的 R1C1–R6C4：

`kiss, sad, surprised-big, surprised-small`; `watching, like, laughing, disappointed`; `afraid, shy, happy, smiling`; `amazed, angry, flirty, speechless`; `dizzy, indignant, frowning, mysterious`; `laughing-tears, playful, unwell, devilish`。

Assets 必须分别映射到 `public/emoji/亲亲.svg`、`伤心.svg`、`吃惊-大.svg`、`吃惊-小.svg`、`吃瓜.svg`、`喜欢.svg`、`大笑.svg`、`失落.svg`、`害怕.svg`、`害羞.svg`、`开心.svg`、`微笑.svg`、`惊讶.svg`、`愤怒.svg`、`放电.svg`、`无语.svg`、`晕.svg`、`气愤.svg`、`皱眉.svg`、`神秘.svg`、`笑哭.svg`、`调皮.svg`、`难受.svg`、`魔鬼.svg`。文档值只保存 ID。

### Unknown IDs

旧客户端读取未知 mood 时必须保留原值和其它 metadata；可显示 unavailable/unknown。只有用户明确选择 canonical ID 或 Clear 才能替换/删除未知值。

## 6. Read / Write Flows

Month read：`Calendar → month bulk query → existing metadata read authority → Map<DiaryDate, MoodId>`；不得逐 cell GET。

Native read：`active legal Diary document → existing metadata owner → mood context`。普通 Note、Inbox、Literature、Archive、Ledger 不出现 Mood UI。

Write：`MoodPicker → Diary mood command → validate DiaryDate + canonical ID → existing metadata write owner/CAS → reactive invalidation → Calendar + Native context`。Picker 不直接 fetch、写 fs、写 raw 或 mutate SQLite。

missing today/past 必须先走 `openDiaryDate()`/既有 Diary create authority；Mood 不得自行创建。missing future 拒绝；已有 future 按既有 Diary 规则处理。

## 7. Integration Boundaries

### Native Vault

仅在合法 Diary document context 增加轻量 mood action/picker；READ 与 EDIT 读取同一 metadata state。不得新建 MoodReader/MoodEditor/Dialog、第二套 Monaco、raw/save/dirty owner。

### Calendar

Mood 只作为摘要 marker，不改变 day button/date-click semantic，不制造第二 navigation owner。Calendar picker entry 是必需能力，不是可选项；它必须由合法的非嵌套 interactive structure（例如 date button 与 sibling mood action）承载。date button 继续拥有日期导航，mood action 只打开 picker，不调用 `openDiaryDate()`，不改变 route/tab/activePath；marker 本身保持非交互。若现有 VCalendar slot 无法安全提供该结构，D7.3 必须 STOP 并进入 architecture review。

### Reactive state

D7.1 应确定单一客户端 query/invalidation owner，避免 Calendar、Native context、Picker 各自维护 mutable cache。

## 8. Lifecycle, History, Recovery, and CAS

D7.0 必须用证据覆盖 clean/dirty body 与 mood set/change/clear、body save ordering、History Comparison/Restore、baseline/divergent Recovery、external body/metadata conflict、delete/recreate、same-date reopen、scope/tab/refresh/deep-link。Mood write 的 persistence boundary 必须与 body raw 明确分离，但结果必须有一致的 identity、revision 与 restore 语义。

如果当前 History/Recovery 只保存 Markdown body 而不保存 SQLite metadata，不能直接实现 D7；必须先做 architecture/product decision。未知字段和 unrelated metadata 必须保留。

## 9. Ownership Matrix

| Concern | Existing owner | D7 extension | Forbidden duplicate |
| --- | --- | --- | --- |
| DiaryDate validation / creation | `shared/diaryProtocol.ts` (`parseDiaryDate`, `isValidDiaryDate`, `diaryLogicalPathForDate`); `src/composables/diary/useDiaryDateCommand.ts` (`useDiaryDateCommand`); `server/routes/diary.ts` (`POST /api/diary/dates`) | Reuse for mood target and missing-date guards | Mood-specific date parser/create route |
| Document open / route / tab / activePath | `src/composables/vault/editor-tabs/useRouteSync.ts` (`useRouteSync`); `src/composables/vault/editor-tabs/useTabWorkspace.ts` (`useTabWorkspace`, `openPost`); `src/composables/vault/useEditorTabs.ts` (`useEditorTabs`) | Observe document identity only | Mood-driven navigation, second tab store, or mood-owned route |
| Body raw / save / dirty / draft recovery | `src/composables/vault/editor-tabs/useTabWorkspace.ts` (`Tab.raw`, `originalRaw`, `isDirty`); `src/composables/vault/editor-tabs/useDocumentSave.ts` (`useDocumentSave`, save scheduling, `DocumentMutationBarrier`); `src/composables/vault/draft-recovery/useUnsavedDraftPersistence.ts` (`UnsavedDraftPersistence`, `createUnsavedDraftPersistence`); `src/composables/vault/draft-recovery/useUnsavedDraftRecovery.ts` (`UnsavedDraftRecovery`, `createUnsavedDraftRecovery`); `src/views/VaultView.vue` (wiring) | Keep body raw/save/dirty/draft recovery unchanged; prove mood writes do not mutate body state | Metadata draft store, mood raw rewrite, or second body save/dirty/draft owner |
| Metadata draft | `src/components/vault/metadataDraftStore.ts` (`MetadataDraft`, `metadataDrafts`, `getMetadataDraft`, `setMetadataDraft`); explicitly session-only, not persisted, and not connected to Recovery | D7.0 must determine whether mood enters this draft, bypasses it, or requires an approved extension; do not decide before evidence | Second metadata draft store or mood-specific persistent draft owner |
| Document file mutation lifecycle | `src/composables/vault/useDocumentLifecycle.ts` (`DocumentLifecycle`, `useDocumentLifecycle`); `src/composables/vault/draft-recovery/useDraftFileTransactions.ts` (`DraftFileMutationBarrier`) | Reuse existing create/rename/delete and mutation-barrier seams only | Treating file lifecycle as the body draft store or mood metadata owner |
| Metadata read/write | `server/documentMetadata.ts` (`getDocumentMetadata`, `patchDocumentMetadata`); `server/routes/metadata.ts` (metadata GET/PATCH routes); `src/lib/api.ts` (`getDocumentMetadataById`, `updateDocumentMetadata`) | Add mood only after D7.0 proves schema/CAS semantics | Sidecar, frontmatter rewrite, second metadata API |
| Mood registry | New D7 single registry (D7.1) | Exactly 24 IDs/assets/positions | Per-view catalogs or asset-path persistence |
| Mood command / month read | New D7 command/query seam using existing metadata authority | Validate canonical ID, set/change/clear, bulk month read | Picker-owned fetch/write or per-cell N+1 |
| History / Recovery / conflict | `src/views/VaultView.vue` (`useHistoryComparisons`, `useHistoryRestore`, `createUnsavedDraftRecovery`, surface precedence); `src/composables/vault/useHistoryComparisons.ts` (`useHistoryComparisons`); `src/composables/vault/useHistoryRestore.ts` (`useHistoryRestore`); `src/composables/vault/draft-recovery/useUnsavedDraftRecovery.ts` (`UnsavedDraftRecovery`); `src/composables/vault/draft-recovery/useUnsavedDraftPersistence.ts` (`UnsavedDraftPersistence` conflict methods); `src/composables/vault/draft-recovery/draftTypes.ts` (`DraftConflictRecord`) | Prove mood preservation/restoration before implementation | Mood-specific history/recovery/conflict pipeline |
| Calendar marker / picker entry | `src/components/diary/DiaryCalendar.vue` (`DiaryCalendar`); `src/components/diary/DiaryCalendarSurface.vue` (`DiaryCalendarSurface`) | Marker summary plus required sibling picker action | Nested buttons or second date-navigation owner |
| Native picker | Existing Native Vault READ/EDIT context (`src/components/vault/ReadingPane.vue` `ReadingPane`, `src/components/vault/EditorPane.vue` `EditorPane`) | One shared 4×6 picker presentation | MoodReader/MoodEditor/Dialog or duplicate state |
| FileTree / ordinary Vault | `src/components/vault/FileTree.vue` (`FileTree`) and existing tree policy | No Mood UI for ordinary notes | Diary logic hardcoded into generic tree contract |

## 10. Picker Interaction Contract

The picker uses a `radiogroup` containing 24 `radio` options in the frozen 4-column × 6-row row-major order. This matches the single-select nullable domain: arrow-key navigation moves within the grid, selection is announced by `aria-checked`, and a separate labelled **Clear mood** button represents the absent value. Options have stable zh/en accessible names, visible focus, and a non-color selected cue. The picker is the only mood mutation UI; Calendar markers remain non-interactive summaries.

## 11. Phase Plan

| Phase | Scope | Status before implementation |
| --- | --- | --- |
| D7.0 | Storage/metadata owner verification and evidence | BLOCKED |
| D7.0A | Generic History Metadata Revision Foundation (D7.0 blocker remediation) | NOT STARTED |
| D7.1 | Registry, schema/validation, existing owner integration, set/change/clear, bulk read seam | NOT STARTED |
| D7.2 | Native Diary context and 4×6 picker; preserve dirty body | NOT STARTED |
| D7.3 | Calendar month markers/entry and missing-date guards; no N+1 | NOT STARTED |
| D7.4 | Full lifecycle regression including History/Recovery/CAS/unknown IDs | NOT STARTED |
| D7.5 | 1280×800, 768×1024, 375×812, 320×700; keyboard/touch/zh-en/light-dark | NOT STARTED |
| D7.6 | Full regression, evidence, independent review, closure | NOT STARTED |

Each phase independently follows `NOT STARTED → IN PROGRESS → REVIEW-READY → Independent Review → REVIEW-CLOSED`; no phase may begin before its predecessor is closed.

## 12. Phase Exit Criteria

### D7.1 — Registry and Metadata Foundation

- [ ] exactly 24 registry items, unique stable IDs/assets/row-column positions
- [ ] stable row-major order and stable ID-only persistence
- [ ] set/change/clear, unknown-value preservation, unrelated metadata preservation
- [ ] no orphan mood for missing Diary; missing future rejected; existing future allowed
- [ ] dirty body/raw/state untouched; CAS semantics proven; bulk read avoids N+1
- [ ] ordinary Note contract unchanged

### D7.2 — Native Diary Context and Picker

- [ ] Native Diary only; ordinary Note has no Mood UI
- [ ] READ/EDIT share one mood state and exactly one picker
- [ ] 24 items, 4×6 canonical order/assets, selected and clear states
- [ ] keyboard, focus-visible, accessible names, zh/en usable
- [ ] dirty body preserved; route, activePath, tab identity unchanged
- [ ] no Reader/Editor/Dialog lifecycle introduced

### D7.3 — Calendar Integration

- [ ] required Calendar picker entry with legal non-nested interactive DOM
- [ ] month bulk load with no per-cell N+1
- [ ] Diary existence and mood markers preserved; marker non-interactive
- [ ] date button remains navigation owner; mood action does not navigate
- [ ] existing missing today/past creation and missing-future guards reused
- [ ] keep-mounted Calendar and VCalendar `dayIndex` compatibility invariants preserved

### D7.4 — Lifecycle and Conflict Regression

- [ ] clean and dirty body with mood set/change/clear
- [ ] body save ordering, History Comparison/Restore, baseline/divergent Recovery
- [ ] external body/metadata conflict, unknown mood, delete/recreate, same-date reopen
- [ ] scope exit/re-entry, tab close/select, refresh, deep link, Back/Forward
- [ ] identity, raw, dirty, metadata, and Calendar continuity proven

### D7.5 — Responsive and Accessibility Validation

- [ ] 1280×800, 768×1024, 375×812, 320×700 all retain 4 columns × 6 rows
- [ ] keyboard, touch, focus-visible, selected non-color cue, and clear action
- [ ] zh/en and light/dark behavior; no horizontal page overflow

### D7.6 — Release and Closure

- [ ] full D7 plus existing D6 Diary and ordinary Vault regression passes
- [ ] evidence is complete and no unresolved P0/P1/P2 remains
- [ ] Independent Review is PASS before closure sync
- [ ] closure is a separate docs-only lifecycle commit

## 13. Test Matrix (Plan Only)

- Unit: registry count/IDs/assets/positions/order; mood validation; unknown and unrelated metadata preservation.
- Component: exact 4×6 DOM/order, selected/clear/focus/accessibility, ordinary Note exclusion.
- Integration: metadata CAS, missing/future guards, dirty body coexistence, rename/delete/recreate, bulk month read.
- E2E: Calendar marker/navigation, Native READ/EDIT picker, set/change/clear, save/History/Restore/Recovery/conflict, refresh/back/tab behavior, responsive and a11y matrix.
- Existing D6 Diary suites and ordinary Inbox/Literature/Archive/Ledger smoke remain regression gates.

## 14. Responsive and Accessibility Contract

All target viewports retain 4 columns × 6 rows; at 320px padding/icon sizing may be reduced only while touch targets remain usable. Every option is a real keyboard-focusable activator with accessible zh/en name, selected state not conveyed by color alone, visible focus, and clear action. Do not claim certification in advance.

## 15. Security and Ordinary Vault Boundary

Server validation must use existing path/domain normalization and DiaryDate authority; never rely on client `startsWith('diary/')`. Reject traversal, absolute, encoded, non-Diary and arbitrary paths as appropriate. Generic ordinary-note semantics and metadata remain unchanged.

## 16. STOP Conditions

Stop and request review if implementation needs a second metadata/document lifecycle, raw rewrite that can overwrite dirty content, a new database/sidecar/parser without approval, orphan mood records, future-guard bypass, new Diary route, Reader/Editor/Dialog workspace, FileTree Diary hardcoding, N+1 month reads, 6×4 layout, changed catalog, SVG-path persistence, or History/Recovery semantics that cannot restore mood safely.

## 17. Rollback

Each D7.x is independently revertible. D7.0 evidence-only changes revert as docs. D7.1 schema/API changes require migration/backward-read and unknown-value preservation; rollback must not delete newer mood values or unrelated metadata. UI phases can be reverted independently while existing Diary navigation/document lifecycle remains intact.

## 18. D7.0 Readiness Gate

当前 gate 未通过：History/Recovery 对 SQLite metadata revision 的语义尚未闭合，
因此不能把 candidate 升级为 selected storage，也不能开始 D7.1。

- [ ] source/read/write metadata owner proven
- [ ] identity and CAS proven
- [ ] draft, History, Recovery, delete, rename behavior proven
- [ ] dirty body + mood safety proven
- [ ] Calendar HOME and missing-date behavior proven
- [ ] bulk month-read strategy proven
- [ ] storage decision recorded without second source of truth
- [ ] no closed-PRD conflict

## 19. Final Lifecycle State

```text
D6                         = REVIEW-CLOSED
D7 PRD                     = REVIEW-CLOSED
D7 Implementation Plan    = REVIEW-CLOSED
D7 Implementation Plan IR  = PASS (P0/P1/P2 = 0/0/0)
D7.0                      = BLOCKED
D7.0 Evidence              = `diary-mood-d7.0-storage-metadata-verification.md`
D7.0 Independent Review    = PASS on the BLOCKED determination (P0/P1/P2 = 0/1/0)
D7 Plan Amendment          = REVIEW-READY (Independent Review = PENDING)
D7.0A                     = NOT STARTED
D7 Implementation          = NOT STARTED
```

本轮完成 D7.0 architecture evidence 与一项 test-only characterization；未实现
picker、未修改 production/dependency。由于 History metadata revision 语义仍需
generic owner decision，D7.0 保持 `BLOCKED`，D7.1 继续 `NOT STARTED`。
