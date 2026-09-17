# D6 — Diary Home Workspace PRD

> **Historical implementation lineage — not current runtime authority.** Use
> [Diary Architecture](../architecture/diary.md) and [Diary User
> Guide](../user-guide/diary.md) for current behavior. This file records the
> closed D6 planning decisions and evidence.

状态：`REVIEW-CLOSED`（原始 D6 产品 contract baseline）；2026-08-26 Native Document Workspace superseding amendment = `REVIEW-CLOSED`，Independent Review = `PASS`（P0/P1/P2 = 0/0/0）。

已有状态保持不变：D0–D5、D6.0、D6.1、D6.2、D6.2.1、D6.3、D6.4、D6.5、D6.6、D6.7 均为 `REVIEW-CLOSED`。D6.4、D6.5、D6.6 与 D6.7 Independent Review 均为 `PASS`（P0/P1/P2 = 0/0/0）。整个 D6 已正式关闭。

状态分层：原始 D6 产品 contract baseline = `REVIEW-CLOSED`；Native Document Workspace superseding amendment = `REVIEW-CLOSED`；Independent Review = `PASS`（P0/P1/P2 = 0/0/0）；D6.3 replacement implementation = `REVIEW-CLOSED`。

日期：2026-08-26（Asia/Shanghai）

## 1. Superseding product decision

旧 D6.3 的 Diary Reader Dialog / future Editor Dialog 方向，在 D6.3 review closure 前被产品决定替换。旧实现和独立 review PASS 只作为历史 evidence 保留，不再是 canonical D6 product contract。

新的原则是：

> Calendar does navigation. Vault does documents.

```text
Diary Calendar Home
        │ select date
        ▼
existing openDiaryDate()
        ▼
existing openPost() / tab lifecycle
        ▼
Native Vault Document
        ├─ READ: existing ReadingPane
        └─ EDIT: existing EditorPane / Monaco
```

Calendar 是 Diary 的日期导航首页。日期成功打开后，用户回到 Nuvyn 原生 Vault 文档工作区，不进入 Diary 专用 Reader/Editor Dialog。

## 2. Product position

Diary 是 Nuvyn Personal OS 中以日期为入口的 Markdown / Diary Workspace，不是独立日记 App：

- Markdown 文件和 Vault 仍是 source of truth；
- `DiaryDate` 与 `diary/YYYY-MM-DD` 仍是 identity contract；
- Calendar 负责日期浏览、存在标记和 date intent；
- 原生 Vault 负责 tabs、active document、Reader、Editor、save、dirty、History、Recovery、route 和 shortcuts；
- 不新增 Diary database、Reader engine、Editor、save pipeline 或 route。

## 3. Router, scope and presentation layers

D6 沿用 `/vault` 与 `/vault/:pathMatch(.*)*`。不新增 `/diary`、Reader route 或 Editor route。

```text
Router layer
  owns /vault/<path> and browser history

Document lifecycle layer
  owns tabs, activePath, raw, save, dirty, History, Recovery

Diary date command layer
  owns openDiaryDate(date)

Diary presentation layer
  owns HOME / DOCUMENT, selected date/path and Calendar focus return

Calendar layer
  owns month navigation, date markers and date-selected emit
```

Diary 是 Vault scope，不是 router identity。READ / EDIT 继续由 existing `VaultViewModeKey` / global `viewMode` 拥有；Diary presentation 不保存 Reader/Editor mode。

## 4. User journeys

### 4.1 Enter Diary

进入 `diary` scope 默认显示 full-bleed Calendar Home。Calendar 保持当前 D6.2.1 视觉和 VCalendar compatibility contract。

### 4.2 Open a date

点击已有日期，或成功创建今天/过去的缺失日期：

1. 只调用 existing `openDiaryDate(date)`；
2. command 继续调用 existing `openPost()`；
3. existing tab/document lifecycle 完成并使 exact path active；
4. Diary presentation 记录 selected date/backing path，进入 `DOCUMENT`；
5. global view mode 切为 `READ`；
6. ordinary Vault `ReadingPane`、`EditorTabs`、FileTree、RightRail 和 StatusBar 按既有规则显示。

不允许额外 `getPost`、fetch、create、`openPost()` 或第二份 raw。

### 4.3 Missing future and errors

缺失 future 仍不创建；invalid、busy、failed 也不能进入 `DOCUMENT`。用户停留在 Calendar Home。已经存在的 future Diary 仍可通过既有 command 打开。

### 4.4 Read and edit

成功日期点击总是进入 existing READ。用户通过现有 view toggle 或快捷键进入 existing EDIT。Editor 使用同一个 active tab、Monaco model、save/dirty/draft/History/Recovery lifecycle。

### 4.5 Return to Calendar

Native Diary document 的 FileTree compact context 提供“返回日历”。这个动作只把 Diary presentation 切回 `HOME`：

- route 不变；
- `activePath` 不变；
- backing tab 不关闭；
- dirty/raw/model 不丢失；
- 不触发 discard confirmation；
- exact-path FileTree constraint 清除；
- Calendar 恢复同一月份和 semantic date focus。

再次选择同一天时，existing `openPost()` 复用同一 tab/document identity；未保存 raw 不能因重开而被额外 fetch 覆盖。

## 5. Calendar Home

Calendar Home 继续保持 D6.2.1 frozen visual contract：

- full-bleed/full-height；
- `YYYY-MM` title；
- Prev/Next；
- Today action absent；
- 44×44 navigation targets 与 focus-visible ring；
- Diary marker、locale、theme 和 responsive spacing 不变。

`isDiaryCalendarMounted = isDiaryScope` 是硬约束。进入 Native Document 时 Calendar hidden but mounted；不得同步 unmount，避免重新引入 `v-calendar@3.1.2` 的 `dayIndex` regression。

## 6. Native Vault Document

Native Diary document 不是 Diary-specific surface。它必须使用：

- existing `EditorTabs`；
- exactly one existing Vault `ReadingPane` in READ；
- existing `EditorPane` / Monaco in EDIT；
- existing view-mode toggle；
- existing FileTree、RightRail 和 StatusBar behavior；
- existing route/tab/save/dirty/draft/History/Recovery/external-change lifecycle。

禁止新增 Diary Reader header、close X、Edit button、Reader Dialog、Editor Dialog、第二个 ReadingPane、第二 Monaco 或第二套 persistence。

## 7. FileTree exact-path context

Native Diary document 时，FileTree 使用 generic `exactPathFilter` presentation constraint。FileTree 不理解 DiaryDate、Calendar 或 Diary filename contract。

若 filter 为 `diary/2026-08-25`，渲染结果只能是：

```text
diary
└── 2026-08-25
```

只保留 exact file 和 tree rendering 所需 ancestors；不得 fuzzy match。若 exact path 暂时不存在，显示 empty filtered tree，不回退完整 Diary tree。

Exact filter 比普通 text/tag search 优先。用户原有 `filesFilter` 必须保持原值；exact context 内不能因旧 query 隐藏当前 Diary，返回 Calendar 后原 query 仍在。

FileTree 可显示轻量 selected-date context 和“返回日历”，但不得新增 full-width Diary document chrome。普通 note/archive/ledger 的 FileTree、search、expanded、keyboard、currentPath 行为不变。

## 8. State machine

```text
DiaryHome
  │ explicit Calendar date intent
  ▼
DateIntentPending
  ├─ opened|created + activePath === path ──► NativeDocument(READ)
  ├─ missing future ─────────────────────────► DiaryHome + feedback
  └─ invalid|busy|error|stale ───────────────► DiaryHome

NativeDocument
  ├─ existing view toggle ──────────────────► READ ⇄ EDIT
  ├─ Calendar Home action ──────────────────► DiaryHome
  ├─ activePath mismatch ───────────────────► DiaryHome
  ├─ backing tab removed ───────────────────► DiaryHome
  └─ special surface active ────────────────► DiaryHome
```

`activePath` 只能 passive close stale `DOCUMENT`，不能自动打开。`DOCUMENT` 的唯一 opening signal 是 explicit Calendar intent 的 successful result。

## 9. Browser history boundary

Browser Back 继续属于 Vue Router 与 existing route/tab lifecycle：

```text
Browser Back
  -> router history transition
  -> useRouteSync / existing openPost reconciliation
  -> activePath result
  -> Diary presentation observes mismatch
  -> HOME
```

禁止拦截 `popstate`、fake history、Dialog URL、`router.back()` as close 或 `router.replace('/vault')`。

“返回日历”是 presentation-only action，不是 Browser Back。它允许 route 仍表示 backing document，而 UI 已显示 Calendar Home。Refresh 不承诺恢复 presentation-only `DOCUMENT`; restoration 继续由 existing route/document lifecycle 决定。未来 deep-link presentation 需要独立 ADR。

## 10. Reconciliation and precedence

History Comparison、Working Tree Diff 和 Recovery 拥有高于 Diary presentation 的 visible-surface precedence。它们激活时：

- Diary presentation reset HOME；
- exact filter 清除；
- Calendar 在 Diary scope 仍 mounted；
- special surface 退出后不自动重开 Native Diary document。

Scope exit、backing tab close 或 activePath mismatch 同样 passive reset HOME，不关闭其它 tab、不改变 route。

## 11. Dirty state invariant

```text
Calendar -> Native READ -> existing EDIT -> dirty
         -> Return to Calendar
```

结果必须是 Calendar Home + backing tab/model/raw/dirty state 保留，且无 discard confirmation。只有 existing tab/document close 才使用既有 dirty confirmation、save-in-flight、draft/recovery contract。

## 12. Responsive and accessibility

验证 1280×800、768×1024、375×812、320×700：

- Calendar visual 不变且无 horizontal overflow；
- Native Vault FileTree/current-date context 可用；
- existing ReadingPane 与 Editor smoke 可用；
- compact Calendar Home action 可通过 keyboard 激活；
- Calendar hidden 时不获取 focus；返回 Home 后 semantic date focus 可恢复；
- light/dark、zh/en 可读；
- Native Document 使用 ordinary Vault shortcut policy（Cmd/Ctrl+E、Cmd/Ctrl+S、Cmd/Ctrl+W）。

## 13. Domain and security boundaries

D1/D2/D4 contract 全部不变：one-date-one-Diary、strict `DiaryDate`、local civil date、exact path、future guard、server authority、mutation policy、auth、filesystem confinement、atomic write、lock、History/Recovery 都不能由本 presentation replacement 绕过。

不修改 server、shared Diary protocol、router、VCalendar version 或 dependencies。

## 14. Non-goals

D6 不包含：

- Diary Reader/Editor Dialog；
- Diary-specific Reader、Editor、Monaco、save、dirty、History、Recovery、shortcut 或 route；
- Mood/task/event/timeline/year-review/AI summary；
- 新 metadata contract、database 或 sync identity；
- Calendar visual redesign、Today 恢复、VCalendar upgrade；
- 全局 Vault layout redesign。

## 15. Phase status

```text
D6.0   REVIEW-CLOSED
D6.1   REVIEW-CLOSED
D6.2   REVIEW-CLOSED
D6.2.1 REVIEW-CLOSED
D6.3   REVIEW-CLOSED — Native Document Workspace replacement
D6.4   REVIEW-CLOSED — Native Editor Lifecycle Verification
D6.5   REVIEW-CLOSED — Lifecycle Regression; Independent Review PASS (0/0/0)
D6.6   REVIEW-CLOSED — Responsive / Accessibility; Independent Review PASS (0/0/0)
D6.7   REVIEW-CLOSED — Release Closure; Final Independent Review PASS (P0/P1/P2 = 0/0/0)
```

D6.6 evidence：[Responsive / Accessibility](diary-home-workspace-d6.6-responsive-accessibility.md)。
D6.7 evidence：[Release Closure](diary-home-workspace-d6.7-release-closure.md)。

旧 D6.3 Reader Dialog implementation 为 `SUPERSEDED BEFORE REVIEW CLOSURE`。新的 D6.3 production/tests/evidence 已完成并以 `REVIEW-CLOSED` 关闭；旧 Reader Dialog review 不能转移。

## 16. Acceptance criteria

- [x] Calendar date success opens existing native Vault READ surface.
- [x] No DiaryReaderDialog or Diary Editor Dialog runtime remains.
- [x] ReadingPane instance count is exactly one.
- [x] Existing view toggle enters same-tab EditorPane/Monaco.
- [x] FileTree exact filter renders only current Diary plus ancestors.
- [x] User `filesFilter` is preserved.
- [x] Calendar Home action is presentation-only and preserves tab/route/activePath/dirty.
- [x] Same-date reopen reuses tab and preserves unsaved raw.
- [x] activePath mismatch, backing close, scope exit and special surfaces reset HOME without auto-open.
- [x] Calendar remains mounted throughout Diary scope.
- [x] Browser Back remains router-owned.
- [x] note/archive/ledger, RightRail, StatusBar and EditorTabs retain native behavior.
- [x] focused tests, browser matrix, typecheck and build pass with no `dayIndex`/pageerror.
- [x] D6.3 independent review P0/P1/P2 = 0/0/0; Independent Review = PASS.
- [x] D6.5 lifecycle regression evidence recorded for scope/tab/route/close/reopen/refresh/deep-link/browser-history boundaries; Independent Review = PASS (P0/P1/P2 = 0/0/0).
- [x] D6.6 responsive/accessibility evidence passed independent review with P0/P1/P2 = 0/0/0.
- [x] D6.7 fresh release evidence covers the final browser/unit/domain/type/build matrix; Final Independent Review = PASS (P0/P1/P2 = 0/0/0).
