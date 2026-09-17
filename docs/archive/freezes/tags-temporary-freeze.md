# Tags Temporary Freeze

- 封板日期：2026-07-30
- 当前基线 commit：`d746a464e3efc8ee62acff4c376b81c8edebc054`
- 状态：**Temporarily Frozen**
- 性质：临时冻结。**不代表 Phase 2 已完成。**

> 本文档不是最终功能完成声明。它记录 Tag 功能当前的稳定状态，
> 冻结后续 Tag 改动，待未来使用更合适的模型重新开发 Phase 2 时解除。

---

## 1. 封板目的

- Phase 1（`7bd502e`）与 Phase 1.1（`8a5b452`）已完成并经过代码审查。
- 随后完成了三项 TagPanel 的局部视觉优化：
  - 移除搜索框右侧总数量（`57786ba`）
  - 标签列表改为紧凑 chip 样式（`fe863fd`）
  - chip 改为等宽自适应 Grid（`d746a46`，当前基线）
- 当前查询、筛选、选中和结果展示已达到可用状态。
- Phase 2 涉及数据库事务、全局标签身份、并发控制、Preview/Apply 一致性。
- 当前暂不继续实现高风险部分。
- 因此将当前状态冻结，等待后续使用更合适的模型重新开启。

---

## 2. 当前已完成范围

### 2.1 标签规范化与查询

客户端使用 `normalizeTag`：

- trim
- 移除最多一个前导 `#`
- 再次 trim
- lowercase
- 保留中文、`/`、`-`、`_`
- 不执行 NFKC

FileTree 支持：

- `#tag` 包含
- `-#tag` 排除
- 多个普通文本 token 使用 AND 语义
- 文本匹配范围为 `path` + `title`
- **不**匹配 `summary`

TagPanel 标签过滤支持：

- 大小写不敏感的子串匹配
- 输入 `#mat` 可匹配 `Math`
- 输入裸 `#` 时，`normalizeTag("#")` 返回空字符串；
  TagPanel 当前返回空标签列表并显示无匹配状态，
  **不等同于**清空搜索框后的完整标签列表

### 2.2 标签索引（纯客户端，`src/lib/tags.ts`）

> `src/lib/tags.ts` 是纯客户端函数库，**不是**服务端索引。

- `buildTagIndex`
- `updateDocumentTags`
- 正向索引（`documentTags`）
- 反向索引（`tagDocuments`）
- 标签计数（`tags`）
- Phase 1.1 的一致性修复（三向不变量，`updateDocumentTags` 改用索引内 oldTags）

### 2.3 TagPanel

- 标签列表
- 标签筛选（`#tag` 前缀 + 大小写不敏感子串）
- Escape 清除筛选
- 清除按钮（搜索框右侧 ×）
- active / `aria-selected`
- selected-tag results 区域（在 TagPanel 内部显示所选标签关联的笔记）
- 每个标签关联的笔记数量（`.tag-count`）
- 搜索框右侧总标签数量已移除（`57786ba`）

### 2.4 当前视觉状态

- 标签列表使用等宽 Grid：

  ```text
  grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
  ```

- 通常可显示 2 列
- 窄侧栏退化为 1 列
- 宽侧栏扩展为 3+ 列
- chip 使用中性低饱和 pill（`background: var(--vs-bg-2)`，`border: 1px solid var(--vs-border)`，`border-radius: 999px`）
- active 使用 accent 强调（`color-mix(in srgb, var(--vs-accent) 18%, transparent)` + `border-color: var(--vs-accent)`）
- 标签计数位于 chip 右侧（`margin-left: auto`）
- 长标签使用 ellipsis 截断
- 现有 `title` 属性提供完整标签提示

---

## 3. 明确未完成范围

以下功能 **NOT STARTED**：

- Rename
- Merge
- Remove
- 批量标签操作
- Preview
- Apply
- Undo
- 标签操作日志
- 数据库标签规范化统一
- 历史 `java` / `#java` 冲突清理
- 标签自定义排序
- 标签颜色
- 标签层级
- 标签多选
- 标签拖拽

正确状态：

```text
Phase 2 implementation: NOT STARTED
```

之前的架构讨论、Prompt 与调查 **不** 算作实现。

---

## 4. 当前已知边界

### 4.1 VaultView 选择切换

当前仍存在 raw string 比较边界：

```ts
selectedTag = selectedTag === $event ? null : $event
```

未使用 `normalizeTag` 比较。这导致两个规范身份相同但大小写不同的字符串
（如 `Math` 与 `math`）在切换时可能不会取消选择。

TagPanel 内部 active 行已使用 `normalizeTag`，但 `VaultView` 的 toggle 仍是
raw 比较。该边界已记录，**不在本次封板中修复**。

### 4.2 `updateDocumentTags` 空标签边界

未知 path 配合 `newTags === []` 时会走 no-op 短路，**不会**为该 path 新建空集合。

这是当前实际行为，**不在本次封板中修改**。

### 4.3 客户端与服务端规范化不一致

客户端（`normalizeTag`）会移除一个前导 `#`。

服务端标签保存逻辑当前只做 `trim` 和 `lowercase`，不保证移除前导 `#`。

因此 SQLite 中理论上可能同时存在：

```text
java
#java
```

二者规范身份相同但数据库行不同。Phase 2 重新开启前必须处理此问题。

### 4.4 标签顺序

当前数据库没有 `document-tag position` 字段。

标签返回按稳定数据库排序处理，**不**承诺用户自定义顺序，**不**承诺
"插入到最早 source 位置"。

### 4.5 极窄侧栏

Grid 使用 `minmax(110px, 1fr)`。在极端窄侧栏下存在理论上的横向溢出边界。
未来需要人工视觉验证。

**不**将其描述为已确认 bug，仅作为待验证边界记录。

### 4.6 CI 状态

相关提交未找到可用的 GitHub Actions Workflow Run。

提交说明中声称本地测试、`typecheck`、`build` 通过的部分仅代表本地验证，
**不**等于 GitHub CI 独立验证。

---

## 5. 不可变约束（Phase 2 重启必须遵守）

以下约束用于未来 Phase 2 设计参考，**本文档不设计代码或 SQL**：

- SQLite 是标签权威数据源
- 不通过批量标签操作修改 Markdown / frontmatter
- `tags.name` 是全局显示名称
- 不支持 per-document 独立显示名称
- Preview 与 Apply 必须共享同一 planner 语义
- Apply 必须在一个 `BEGIN IMMEDIATE` 事务内完成
- 禁止跨事务 chunking
- Rename、Merge、Remove 必须更新受影响文档的 metadata version
- 操作成功后客户端只 refresh 一次
- 不伪造 Markdown fileChanges
- Undo 不能通过简单反向操作实现
- Future Undo 必须保存精确 before/after 状态并使用冲突校验

---

## 6. 冻结规则

临时封板期间，**禁止**进行：

- Tag 数据模型修改
- Tag 查询语义修改
- TagIndex 修改
- TagPanel 交互修改
- TagPanel 样式微调
- Rename / Merge / Remove 开发
- Preview / Apply / Undo 开发
- 服务端标签规范化修改
- 标签数据库 migration

只有以下情况可以重新打开：

1. 出现影响当前功能使用的明确 bug
2. 有可复现步骤
3. 有独立修复范围
4. 修复不会顺带启动 Phase 2
5. 或项目明确决定正式启动 Phase 2

**纯个人审美微调也暂时不继续修改**，避免长期陷入 TagPanel 局部打磨。

---

## 7. Phase 2 重启前置条件

未来重启 Phase 2 前必须完成：

- 重新审查数据库 schema
- 重新确认客户端 / 服务端统一 normalize contract
- 确认 Rename 三分支
- 确认 Merge 事务顺序
- 确认 Remove 孤立标签清理
- 确认 `documents.updated_at` / version 更新策略
- 设计专用 Preview planner
- 设计冲突检测
- 明确 Apply 原子事务
- 单独设计 Undo 操作日志
- 为历史脏标签准备迁移或兼容策略
- 制定分任务、分提交和测试计划

---

## 8. 当前验收状态

| Area                              | Status      |
| --------------------------------- | ----------- |
| Client normalize / query          | Accepted    |
| TagIndex                          | Accepted    |
| FileTree tag query                | Accepted    |
| TagPanel filtering                | Accepted    |
| TagPanel selected results         | Accepted    |
| Compact equal-width chip UI       | Accepted    |
| Server normalization unification  | Deferred    |
| Rename / Merge / Remove           | Not started |
| Preview / Apply                   | Not started |
| Undo                              | Not started |
| Phase 2                           | Frozen      |

---

## 9. 最终声明

- 当前 Tag 功能以基线 commit `d746a464e3efc8ee62acff4c376b81c8edebc054` 为准。
- 当前状态允许正常使用。
- 本文档 **不** 代表标签管理功能完整。
- Phase 2 尚未实现。
- 除明确 bug 外，Tag 模块暂时不再接受修改。
- 重启时必须先阅读本文档与现有 Tag closure / spec 文档：

  - `docs/superpowers/specs/2026-07-30-tags-query-index-refactor-design.md`
  - `docs/superpowers/plans/2026-07-30-tags-query-index-refactor-implementation-plan.md`
  - `docs/tags-query-index-refactor-implementation-record.md`
  - `docs/tags-query-index-refactor-final-closure.md`
