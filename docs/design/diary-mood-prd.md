# D7 — Mood Diary PRD

> **Historical implementation lineage — not current runtime authority.** Use
> [Diary Architecture](../architecture/diary.md) and [Diary User
> Guide](../user-guide/diary.md) for current behavior. This file records the
> closed D7 planning lineage.

状态：`REVIEW-CLOSED`（D7 PRD；未开始实现）

Independent Review：`PASS`（P0 = 0，P1 = 0，P2 = 0）

日期：2026-08-26（Asia/Shanghai）

## 1. Background

Nuvyn 的 Diary 以严格的 Gregorian 日期作为入口，并以 Vault 中的 Markdown
文件作为正文 source of truth。D6 已正式关闭，确立了以下原则：

> Calendar does navigation. Vault does documents.

D7 在此基础上增加轻量的每日心情元数据。Mood 用于表达某一天的情绪状态，
不替代 Diary 正文，也不把 Diary 变成独立的数据库或新的编辑工作区。

## 2. Goal

用户可以为某一天选择一个心情图标，并在之后修改或清空它；Calendar 能以
低干扰方式显示已有 mood，Native Vault 文档上下文也能查看和编辑该日期的
mood。

D7 MVP 的明确目标是：

- 每个 `DiaryDate` 最多一个 mood；
- 提供固定的 24 个候选图标；
- picker 使用固定 4 列 × 6 行网格（每行 4 项，共 6 行）；
- mood 与现有 `diary/YYYY-MM-DD.md` 日期 identity 协同；
- 不改变既有 Diary 文件、路由、tab、编辑、保存和恢复 contract。

## 3. Non-goals

D7 MVP 不包含：

- 一天多个 mood、多选、排序或自定义分类；
- 用户上传或制作图标；
- mood 统计 dashboard、月/年趋势图或分析报告；
- mood 与任务、标签、评分或 AI 分析联动；
- 新 Reader/Editor/Dialog、第二套 Markdown renderer 或 editor lifecycle；
- 重做 D6 Calendar 架构、VCalendar 版本或 Native Vault 工作区；
- 跨设备同步策略重构；
- 完整的历史版本 UI 或恢复策略重构。

## 4. Product summary

Mood 是绑定在一个 `DiaryDate` 上的单选元数据。用户可以选择一个固定
集合中的图标，也可以清空选择。选择可以被后续修改，最新选择覆盖此前选择。
没有选择时，该日期没有 mood，而不是隐式使用 “普通” 或其它默认值。

Mood 不属于普通 note，也不改变 one-date-one-file：

```text
DiaryDate 2026-08-24
    ├─ optional mood metadata
    └─ diary/2026-08-24.md (at most one Diary document)
```

## 5. User stories

1. 作为用户，我希望为今天的日记选择一个心情图标，以便快速记录当天情绪。
2. 作为用户，我希望一天只能选择一个 mood，避免状态混乱。
3. 作为用户，我希望以后可以修改或清空当天的 mood，因为选择可能改变。
4. 作为用户，我希望在 Calendar 上看到某天是否有 mood，以便快速浏览。
5. 作为用户，我希望 24 个图标整齐地显示为 4 列 × 6 行，方便快速选择。
6. 作为用户，我希望在打开 Diary 文档后仍能看到并编辑 mood，而正文继续
   使用 Nuvyn 原生文档体验。

## 6. Scope

### 6.1 Mood picker

- 固定 24 项、单选、固定视觉顺序和 4 列 × 6 行产品布局；每行 4 项、共 6 行，
  不得转置为 6 列 × 4 行；
- 当前选项有明确 selected state；
- 提供清空/不选能力；
- 支持 hover、keyboard focus、selected、disabled state；
- 每项有中英文可访问名称；
- 选择成功后立即反映在当前日期的 Calendar 和 Native document context，
  具体持久化时机由实现阶段依据现有 metadata owner 落定。

### 6.2 Calendar Home

Calendar 可在日期格内显示轻量 mood marker。marker 只表达“已有 mood”及其
图标，不改变日期点击仍由现有 `openDiaryDate()` 负责的语义。它不得与已有
Diary marker 形成难以区分的双重视觉噪声；实现阶段应优先采用同一日期格内的
组合标记或清晰的层级关系。

### 6.3 Native Vault document context

打开 `diary/YYYY-MM-DD.md` 后，用户应能在轻量的原生 Vault 上下文中查看当前
mood 并进入 picker。入口可以是已有 document context/header action 或等价的
轻量 presentation affordance，但不得创建 Diary 专用 Reader/Editor/Dialog。

正文打开、编辑、保存、dirty、draft、History、Recovery 和 tab 生命周期
继续由现有 Native Vault owner 负责。

### 6.4 Empty state

没有 mood 时显示可理解的未选择状态，例如无 marker、空的 picker selection
或明确的“未设置”标签。不能用某个图标冒充默认 mood。

## 7. Mood catalog contract

24 个候选是仓库中已经存在的固定内置 SVG 集合。D7 MVP 冻结每项的 stable ID、
中文 label、English label、canonical SVG asset、accessibility name 以及网格
位置。下表按行优先顺序定义唯一的产品目录：4 列 × 6 行，每行 4 项，共 6 行。
桌面、平板和移动端都必须保持这个方向、顺序和 asset 映射，不得转置为 6 列 ×
4 行。任何替换 asset、改名、换语义或调整顺序都需要新的产品复审。

Stable ID 是 metadata 中唯一允许持久化的 mood 值；SVG 路径只是实现阶段的
registry 映射，不能写入 Diary 文档数据。

| Order | Grid position | Stable ID | 中文 label | English label | Canonical SVG asset | Accessibility name |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1C1 | `kiss` | 亲亲 | Kiss | `public/emoji/亲亲.svg` | 亲亲 / Kiss |
| 2 | R1C2 | `sad` | 伤心 | Sad | `public/emoji/伤心.svg` | 伤心 / Sad |
| 3 | R1C3 | `surprised-big` | 吃惊-大 | Big surprise | `public/emoji/吃惊-大.svg` | 大幅吃惊 / Big surprise |
| 4 | R1C4 | `surprised-small` | 吃惊-小 | Small surprise | `public/emoji/吃惊-小.svg` | 小幅吃惊 / Small surprise |
| 5 | R2C1 | `watching` | 吃瓜 | Watching the drama | `public/emoji/吃瓜.svg` | 吃瓜 / Watching the drama |
| 6 | R2C2 | `like` | 喜欢 | Like | `public/emoji/喜欢.svg` | 喜欢 / Like |
| 7 | R2C3 | `laughing` | 大笑 | Laughing | `public/emoji/大笑.svg` | 大笑 / Laughing |
| 8 | R2C4 | `disappointed` | 失落 | Disappointed | `public/emoji/失落.svg` | 失落 / Disappointed |
| 9 | R3C1 | `afraid` | 害怕 | Afraid | `public/emoji/害怕.svg` | 害怕 / Afraid |
| 10 | R3C2 | `shy` | 害羞 | Shy | `public/emoji/害羞.svg` | 害羞 / Shy |
| 11 | R3C3 | `happy` | 开心 | Happy | `public/emoji/开心.svg` | 开心 / Happy |
| 12 | R3C4 | `smiling` | 微笑 | Smiling | `public/emoji/微笑.svg` | 微笑 / Smiling |
| 13 | R4C1 | `amazed` | 惊讶 | Amazed | `public/emoji/惊讶.svg` | 惊讶 / Amazed |
| 14 | R4C2 | `angry` | 愤怒 | Angry | `public/emoji/愤怒.svg` | 愤怒 / Angry |
| 15 | R4C3 | `flirty` | 放电 | Flirty | `public/emoji/放电.svg` | 放电 / Flirty |
| 16 | R4C4 | `speechless` | 无语 | Speechless | `public/emoji/无语.svg` | 无语 / Speechless |
| 17 | R5C1 | `dizzy` | 晕 | Dizzy | `public/emoji/晕.svg` | 晕 / Dizzy |
| 18 | R5C2 | `indignant` | 气愤 | Indignant | `public/emoji/气愤.svg` | 气愤 / Indignant |
| 19 | R5C3 | `frowning` | 皱眉 | Frowning | `public/emoji/皱眉.svg` | 皱眉 / Frowning |
| 20 | R5C4 | `mysterious` | 神秘 | Mysterious | `public/emoji/神秘.svg` | 神秘 / Mysterious |
| 21 | R6C1 | `laughing-tears` | 笑哭 | Laughing with tears | `public/emoji/笑哭.svg` | 笑哭 / Laughing with tears |
| 22 | R6C2 | `playful` | 调皮 | Playful | `public/emoji/调皮.svg` | 调皮 / Playful |
| 23 | R6C3 | `unwell` | 难受 | Unwell | `public/emoji/难受.svg` | 难受 / Unwell |
| 24 | R6C4 | `devilish` | 魔鬼 | Devilish | `public/emoji/魔鬼.svg` | 魔鬼 / Devilish |

## 8. Information architecture and data contract

### 8.1 Binding key

推荐 binding key 为严格的 `DiaryDate`，物理关联可解析为：

```text
DiaryDate = 2026-08-24
document identity = diary/2026-08-24.md
mood identity = DiaryDate + stable mood ID
```

Mood 不应绑定当前 tab、route、activePath 或文件显示标题，因为这些是
presentation/document lifecycle state，不是日期 identity。

### 8.2 Recommended storage direction

推荐在现有 Diary 文档 metadata 能力上扩展受控 frontmatter 字段，例如：

```yaml
mood: happy
```

该方向的优点是 mood 与既有 Markdown 文件同生命周期、易于备份和导出，且
不会引入第二个 Diary 数据库。它也能自然地让 History、Recovery、draft 和
外部文件变更沿用现有文档 source-of-truth 语义。

实现前必须确认现有 frontmatter/metadata parser、写入原子性、未知字段保留、
CAS/dirty 行为和历史恢复能力。若当前 metadata 系统无法安全保留字段，则
应在 D7 implementation plan 中提出 sidecar/index 作为正式替代方案；本 PRD
不授权直接创建新的索引或 database。

### 8.3 Existence rule

MVP 建议：mood 不能脱离 Diary 文档长期存在。用户从 Calendar 选择 mood 时，
若日期文件不存在，应先遵循既有 Diary date command 的 future/create policy；
不允许单独创建一个“只有 mood、没有 Diary 文件”的孤立记录。对于缺失 future
日期，既有规则仍优先，不能因 mood 选择绕过 future guard。

### 8.4 Delete, recovery and history

- 删除 Diary 文件时，随文件保存的 mood metadata 一并消失；不得留下孤立 mood。
- 既有 History/Recovery/Restore 若恢复文件 metadata，应按同一事务恢复 mood；
  若实现无法保证，应在实现前 STOP 并提出明确数据一致性方案。
- D7 不新建 History/Recovery UI；现有 owner 继续拥有冲突、草稿和恢复语义。
- 外部编辑、导入/导出、同步和未来跨设备场景需要保留未知 metadata 字段，
  并在实现计划中补充兼容性验证。

## 9. Interaction design

### 9.1 Opening and selection

用户可从 Calendar 日期上下文或 Native Diary document context 打开 picker。
Picker 打开时显示当前 mood；点击另一项立即成为新的唯一选择；点击清空动作
则删除选择。提交成功后关闭或收起 picker，并更新当前日期的 marker/context。

Picker 是轻量 presentation surface（优先 popover 或紧凑 sheet），不是新的
route、tab、Reader 或 Editor。它不能通过 close action 改变 route、activePath、
tab 或正文 dirty state。

### 9.2 Keyboard and touch

每个 mood 是真正可聚焦、可激活的交互项。键盘用户可以进入、遍历、选择和
清空；选中态必须同时有非颜色线索。触控目标应保持可用尺寸，不能为了塞入
4 列 × 6 行而牺牲可操作性。

### 9.3 Calendar marker

Calendar 只显示摘要 marker，不在日期格中展开完整 label。详情由 picker 或
Native document context 提供。没有 mood 的日期不显示误导性占位图标。

## 10. Accessibility and responsive requirements

D7 实现需遵守 D6.6 已建立的响应式和可访问性交互基线；本 PRD 不宣称任何
认证结果。

目标视口为 `1280 × 800`、`768 × 1024`、`375 × 812`、`320 × 700`：

- canonical picker 在四类视口均为 4 列 × 6 行，每行 4 项、共 6 行，并保持表中
  的 row-major 顺序；
- 320 宽度下允许缩小 icon、gap 和 padding，但不能使目标不可点击或 label
  不可访问；
- 若实现发现 320 下严格 4 列 × 6 行无法同时满足可用触控尺寸，必须暂停并
  提交产品复审，不得静默转置成 6 列 × 4 行、无限滚动或多页；
- picker 在 light/dark、zh/en 下都应有清晰的 selected/focus/disabled state；
- 图标不能成为唯一信息来源，屏幕阅读器名称和可见 label 需可用；
- 不能把 disabled、selected 或 error 只表达为颜色变化。

## 11. Technical constraints and architecture boundaries

必须继承 D6 的 ownership：

| Area | D7 may extend | D7 must not take ownership of |
| --- | --- | --- |
| Calendar Home | mood marker、轻量 picker entry | router、date command、server mutation directly |
| Native READ/EDIT | mood context action | second Reader/Editor、raw、Monaco、save pipeline |
| Diary metadata | one controlled mood field | ordinary note metadata semantics |
| FileTree | existing exact Diary context if needed | generic tree contract、Diary path parsing |
| History/Recovery/Draft | preserve metadata through existing owners | copied state or new recovery workflow |
| Route/tab/activePath | observe current Diary document | route creation、tab creation/close、activePath mutation |

Calendar 仍只负责导航和 marker；合法日期打开仍只通过现有
`openDiaryDate()`。Native Vault 仍负责文档、tab、Reader/Editor、save、dirty、
History、Recovery、route 和 shortcut。D7 不新增 `/diary` 路由、Diary-specific
workspace、Dialog、editor 或 server API；普通 note、archive、inbox、literature、
ledger 语义不改变。

## 12. Risks and open questions

- 现有 metadata/frontmatter 是否能在未知字段、CAS、draft、History/Recovery
  和外部修改中安全保留 `mood`，需在 implementation plan 前验证。
- 删除、恢复、导入和旧版本文件的 mood 一致性需要真实 lifecycle 测试。
- Calendar marker 与现有 Diary marker 叠加时可能造成视觉噪声，需在实现阶段
  固定视觉层级和暗色主题表现。
- 320 视口下 4 列 × 6 行与最小触控目标可能存在空间冲突，需以真实 browser
  evidence 固定缩放参数；不能用改变方向来规避该风险。
- 24 个现有 SVG 的语义、stable ID、label、路径和位置已经是 D7 MVP 产品
  contract；任何替换或重排都需要产品复审。
- 当前建议不允许无文件 mood；如果产品未来需要“先记录 mood 后建正文”，
  必须单独修改 data contract，不得在实现中隐式放开。
- sync/import/export 的未知字段保留和跨设备冲突合并属于后续设计，不得由
  D7 MVP 临时发明第二套同步 identity。

## 13. Acceptance criteria

### Product contract

- [ ] 每个合法 `DiaryDate` 最多一个 mood，可修改、可清空。
- [ ] 候选集合恰好为表中 24 个 `public/emoji/*.svg`，每项 stable ID、zh/en
      label、canonical asset 和 accessible name 齐全，顺序固定。
- [ ] picker 的产品布局固定为 4 列 × 6 行，不得转置为 6 列 × 4 行；不支持
      自定义图标、多选或排序。
- [ ] mood 绑定日期，不改变 `diary/YYYY-MM-DD.md` one-date-one-file。
- [ ] 无 Diary 文件时不能留下孤立的 mood 记录，future guard 不被绕过。

### D6 compatibility

- [ ] Calendar 继续只负责导航和 marker；`openDiaryDate()` ownership 不变。
- [ ] Native Vault 继续拥有 route、tab、raw、model、save、dirty、History、
      Recovery、Draft 和 external conflict。
- [ ] 不新增 Diary route、Reader/Editor/Dialog、第二套 lifecycle 或普通 note
      语义变化。
- [ ] 删除和恢复遵循明确的 mood metadata 一致性规则。

### Interaction and accessibility

- [ ] 每项可见、可聚焦、可键盘激活，并有中英文可访问名称。
- [ ] selected、focus、disabled 和 empty state 不只依赖颜色。
- [ ] Calendar marker 与现有 marker 协同，且不覆盖日期点击语义。
- [ ] 1280×800、768×1024、375×812、320×700 均完成响应式验证，并保持 4 列
      × 6 行；若 320 下无法满足可用触控尺寸，必须先进行产品复审。

## 14. Phase recommendation

D7 PRD 已完成独立复审并正式关闭，实现尚未开始。下一步可单独创建
D7 Implementation Plan。Implementation Plan 至少应先确认现有
metadata owner、frontmatter 写入/保留能力、History/Recovery/CAS 语义和
Calendar marker seam；在此之前不得修改 production code。

推荐阶段顺序：

```text
D7 PRD
  -> independent review
  -> D7 Implementation Plan
  -> metadata/storage seam confirmation
  -> picker + Calendar marker implementation
```

当前最终状态：

```text
D6   = REVIEW-CLOSED
D7 PRD = REVIEW-CLOSED
D7 PRD Independent Review = PASS (0/0/0)
D7 Implementation Plan = NOT STARTED
D7 Implementation = NOT STARTED
```
