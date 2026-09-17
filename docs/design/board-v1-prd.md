# PRD - Board 白板

**日期：** 2026-09-14
**模块：** Board
**状态：** 📋 规划中
**版本：** V1
**优先级：** P1

---

## 1. 产品定义

Board 是 Nuvyn Personal OS 内置的无限白板一级 Workspace，负责视觉化思考、设计与探索。

它用于承载不适合以线性文档表达的内容，例如：

* 思维整理
* 灵感草稿
* 流程设计
* 系统架构
* 关系梳理
* 自由绘制
* Note 之间的空间组织

Nuvyn 当前的四个核心一级 Workspace 定义为：

```text
Note    → 我知道什么
Diary   → 我经历了什么
Ledger  → 我的钱发生了什么
Board   → 我正在思考和构思什么
```

Board 与 Note 属于 Personal OS 下的平级 Workspace。

Board 不是 Note 的一种类型，也不依附于 Note 存在。它在交互和数据模型上保持领域独立，但不是脱离 Nuvyn 的独立软件；跨 Workspace 的引用和关系属于 Nuvyn 的长期系统能力。

---

## 2. 背景

Note 擅长表达具有明确阅读顺序的线性内容。

例如：

```text
标题

段落

段落

代码

图片

列表
```

但在以下场景中，线性文档并不是最合适的表达方式：

```text
需求
  ↓
设计 ─────→ 数据库
  │           │
  ↓           ↓
前端 ←────── API
```

或者：

```text
          Ledger
             │
      ┌──────┴──────┐
      ↓             ↓
   Account      Transaction
      │             │
      └──────┬──────┘
             ↓
          Statistics
```

这些内容更依赖：

* 空间位置
* 连线关系
* 分组
* 图形
* 自由布局

因此 Nuvyn 需要一个独立的空间型 Workspace。

Board 即承担这一职责。

---

## 3. 产品目标

Board V1 的目标不是构建完整的专业设计工具。

第一阶段只需要实现一个：

> 简单、可靠、可长期保存，并且与 Nuvyn 整体体验一致的个人无限白板。

V1 应完成以下完整闭环：

```text
创建 Board
    ↓
进入白板
    ↓
绘制 / 编辑
    ↓
自动保存
    ↓
退出
    ↓
重新打开
    ↓
恢复上一次内容
```

同时支持：

```text
重命名
删除
搜索
导出
深色模式
```

---

## 4. 非目标

以下能力不属于 Board V1：

* 多人实时协作
* 在线共享编辑
* 评论系统
* Board 权限系统
* Presentation Mode
* Board Template
* AI 自动生成白板
* Mind Map 自动布局
* Mermaid 转白板
* Kanban
* Database View
* 富交互 Note Card
* Ledger Card
* Diary Card
* Query Card
* Board 嵌套
* Board 历史版本
* 实时云同步冲突解决

这些功能可以在后续版本中单独规划。

---

## 5. 技术方案

Board V1 使用：

```text
@excalidraw/excalidraw
```

作为底层 Infinite Canvas Engine。

### 5.1 Excalidraw

Excalidraw 负责：

```text
Canvas
├── Shape
├── Rectangle
├── Diamond
├── Ellipse
├── Arrow
├── Line
├── Free Draw
├── Text
├── Image
├── Selection
├── Multi Selection
├── Resize
├── Rotate
├── Zoom
├── Pan
├── Undo
├── Redo
└── Export Scene
```

Nuvyn 不重新实现上述基础能力，外围只负责 Board 的产品边界和 Nuvyn 集成。

### 5.2 Vue / React Island

Nuvyn 前端主体为 Vue 3、Vue Router、Vite 和 TypeScript；Excalidraw 为 React Component。两者必须通过明确的 React Island 边界集成，不在 Vue 组件体系中无边界混用 React 状态。

```text
BoardEditor.vue
      │
      ▼
ExcalidrawHost
      │
      ▼
React createRoot()
      │
      ▼
<Excalidraw />
```

React Island 只负责 Excalidraw 的渲染、API 调用和 Scene 事件桥接。Vue 负责 Board 生命周期、路由、Metadata、标题、保存状态、Board Service 以及 Nuvyn Theme。

Excalidraw 的高频 `onChange` 只能更新 Board Editor 局部的内存状态，不能经由全局 Store 驱动整个 Nuvyn 响应式更新。Vue Host 负责 React Root 的创建、卸载、Vue ↔ React 事件桥接和 fallback container；React Error Boundary 位于 React Island 内部，不由 Vue 直接承担。

React Island 内部结构为：

```text
BoardEditor.vue
      ↓
ExcalidrawHost
      ↓
React Root
      ↓
BoardReactErrorBoundary
      ↓
<Excalidraw />
```

`BoardReactErrorBoundary` 负责捕获 React / Excalidraw 的渲染异常，并通知 Vue Host；Vue Host 再使用 fallback container 展示 Nuvyn 统一的 Board Error UI。

### 5.3 按需加载

React、React DOM 和 Excalidraw 必须按需加载，仅在进入：

```text
/board/:boardId
```

的 Board Editor 时承担加载成本。Board Gallery、Note、Diary、Ledger、Login 和 Setup 等页面不应因为 Board 编辑器而加载 Excalidraw 初始 Bundle。实现应使用 dynamic import、lazy loading 或 Vite code splitting 达成这一边界。

## 6. 架构原则

### 6.1 Excalidraw 只是画布引擎

Board 的产品模型不能直接等同于 Excalidraw。

整体关系：

```text
Nuvyn
  │
  └── Board
        │
        ├── Board List
        ├── Board Metadata
        ├── Board Service
        ├── Board Storage
        ├── Search
        ├── Autosave
        ├── Resource Reference
        │
        └── Excalidraw
              │
              └── Canvas Engine
```

> Board 属于 Nuvyn。

> Excalidraw 属于 Board 的编辑器实现。

### 6.2 BoardEngineAdapter

Board Service 不得在各处直接依赖 Excalidraw API 或类型。通过最小必要的 `BoardEngineAdapter` 隔离 Canvas Engine：

```text
Board Service
      │
      ▼
BoardEngineAdapter
      │
      ▼
Excalidraw Engine
```

Adapter 至少覆盖：

```text
load scene
deserialize scene
serialize scene
normalize persistent app state
export PNG
export SVG
generate thumbnail
```

V1 只需要 `ExcalidrawBoardEngineAdapter`。Adapter 的目标是隔离领域边界，不是提前建设第二套 Canvas 平台。

### 6.3 Domain Boundary

`Board` 是 Nuvyn Domain；Excalidraw 是当前 Engine。Board Metadata、Scene Version、保存、恢复、资源引用和生命周期由 Nuvyn 定义，Engine-specific data 由 Adapter 序列化。

```text
Board
├── BoardMetadata
└── BoardSceneRecord
    ├── Engine
    ├── Scene Schema Version
    ├── Server Revision
    ├── Engine Data
    └── Asset References
```

`engine`、`sceneVersion` 和服务端 `revision` 都只属于 `BoardSceneRecord`，不能复制到 `BoardMetadata` 或其他业务对象中形成第二个 Source of Truth。Board Domain、Board Service 和 Storage Contract 不应泄漏 Excalidraw 专有类型。持久化可以使用 Metadata Store、Scene Store 和 Asset Store，也可以在现有存储中采用其他物理组织方式，但逻辑边界必须保持。

## 7. Board 信息架构

Board 作为 Nuvyn Personal OS 的一级 Workspace。

侧边栏：

```text
Home

Note
Diary
Ledger
Board

────────────

Search
Settings
```

点击：

```text
Board
```

进入 Board 列表。

---

## 8. Board 列表

### 8.1 页面结构

Board Home 是纯 Gallery Home，负责管理所有白板；V1 不提供 Folder、FileTree、Board Directory、左侧文件树或 Board 拖入文件夹。

页面固定包含：

```text
Board                         + New Board

[ Search boards... ]

Recent
────────────────────────────────────────────
[ Thumbnail ]  [ Thumbnail ]  [ Thumbnail ]

All Boards
────────────────────────────────────────────
[ Thumbnail ]  [ Thumbnail ]  [ Thumbnail ]
[ Thumbnail ]  [ Thumbnail ]  [ Thumbnail ]
```

Recent 展示最近编辑的若干 Board；All Boards 展示全部 Board，默认按 `updatedAt DESC` 排序。Search V1 只匹配 Board Title。

Board Home 不复用 `src/components/vault/FileTree.vue` 作为 UI。FileTree 属于 Vault 领域，包含 Note、Tag、Diary、Archive、Metadata 和 Document Lifecycle 等逻辑；Board Home 与 FileTree 是两个不同的产品模型。

## 9. Board Card

每一个 Board 以 Card 展示。

Card 包含：

```text
Thumbnail

Title

Updated Time
```

例如：

```text
┌─────────────────────────┐
│                         │
│        Thumbnail        │
│                         │
├─────────────────────────┤
│ Ledger Architecture     │
│ Updated 2 minutes ago   │
└─────────────────────────┘
```

---

## 10. Thumbnail

Board 应支持生成预览图。

Thumbnail 用于 Board 列表快速识别内容，属于 Scene 的派生数据，不是 Scene 持久化成功的前置条件。

生成时机：

```text
Scene 保存成功
      ↓
Thumbnail 标记为 dirty
      ↓
Debounce 2 ~ 5 seconds 或进入 idle
      ↓
BoardEngineAdapter.generateThumbnail()
      ↓
保存新的 Thumbnail Metadata
```

Thumbnail 不要求每次 Scene 改变立即刷新，也不能在每次 Pointer Move 或每次 `onChange` 生成。

Thumbnail 生成失败时，Scene 仍保持已保存状态；可以保留旧 Thumbnail 或显示 fallback，不得把派生数据失败报告为 Scene 保存失败。

## 11. 创建 Board

点击：

```text
+ New Board
```

直接创建空 Board。

默认名称：

```text
Untitled Board
```

随后立即进入编辑器。

流程：

```text
New Board

   ↓

Create board record

   ↓

Generate board id

   ↓

Open Board Editor
```

不弹出创建 Modal。

目标是降低创建成本。

---

## 12. Board Editor

编辑器整体采用沉浸式设计。

建议：

```text
┌───────────────────────────────────────────────┐
│ ←  Untitled Board                    ···      │
├───────────────────────────────────────────────┤
│                                               │
│                                               │
│                                               │
│                Excalidraw                     │
│                                               │
│                                               │
│                                               │
└───────────────────────────────────────────────┘
```

进入 Board 后，应尽可能减少 Nuvyn 自身 UI 对画布空间的占用。

---

## 13. Header

Board 顶部仅保留必要操作。

左侧：

```text
←

Board Title
```

右侧：

```text
Saved

...

```

禁止在 Header 中堆积大量按钮。

Excalidraw 已有的工具，不应在 Nuvyn Header 中重复。

---

## 14. Board 标题

标题支持直接编辑。

例如：

```text
Ledger Architecture
```

点击标题：

```text
Ledger Architecture
        ↓
[input]
```

Blur 或 Enter：

```text
Save title
```

如果标题为空：

```text
Untitled Board
```

---

## 15. 自动保存

Board 不提供手动 Save 按钮。所有 Scene 修改和 Board Title 修改都自动保存。

包括：

* 新增 Element
* 删除 Element
* 移动 Element
* Resize
* 修改文本
* 修改颜色
* 修改连线
* 修改图片
* 修改 Board Title

### 15.1 Debounce

Excalidraw `onChange` 先更新 Board Editor 局部的 `latestSceneRef`，递增本地 `localRevision` 并标记 dirty，再写入 Crash Checkpoint，最后由 Debounce 触发服务端持久化：

```text
Excalidraw onChange
        ↓
latestSceneRef
        ↓
localRevision++
        ↓
Crash Checkpoint
        ↓
Debounce
        ↓
Client Save Queue
        ↓
Server Scene Update
```

禁止每次 Pointer Move 立即写数据库。Scene 保存 Debounce 建议为 `500ms ~ 1000ms`，具体值由实现阶段结合性能验证确定。

`localRevision` 只表示当前 Editor Session 的本地 Scene 变更序号，不等同于服务端 `revision`。

### 15.2 Save Queue / Server Revision

Client Save Queue 与 Server Revision 并不是二选一：

```text
Client Save Queue
→ 保证当前 Board Editor Session 内部保存有序

Server revision / expectedRevision
→ 防止跨请求、跨 Tab、跨窗口和跨 Session 的 stale write
```

每个 Scene 保存请求至少携带：

```text
scene snapshot
localRevision
expectedRevision = currentServerRevision
```

其中 `currentServerRevision` 是当前 Editor 已读取或由服务端成功响应确认的最新服务端 `revision`。`revision` 表示当前 Board Scene 的服务端持久化版本号，初始值可由实现选择 `0` 或 `1`，但必须单调递增；每次成功提交新的 Scene 后递增一次。

Server Scene Update 必须校验 `expectedRevision`。例如：

```text
Server current revision = 12

expectedRevision = 12
→ 接受更新
→ 保存新 Scene
→ 返回 revision = 13

expectedRevision = 12，但 Server current revision = 13
→ 拒绝旧更新
→ 返回 Conflict（可使用 409 或项目统一冲突协议）
```

完整的正常保存流程为：

```text
Excalidraw onChange
        ↓
latestSceneRef
        ↓
localRevision++
        ↓
Crash Checkpoint
        ↓
Debounce
        ↓
Client Save Queue
        ↓
Persist newly referenced Assets
        ↓
PUT Scene
expectedRevision = currentServerRevision
        ↓
Server validates expectedRevision
        ↓
Success
        ↓
Server revision++
        ↓
update currentServerRevision
        ↓
clear / advance Checkpoint
        ↓
Saved
```

Client Save Queue 仍必须保证当前 Editor Session 内部不会因请求完成顺序而覆盖新 Scene：

```text
Save A 发出
Save B 发出
B 先完成，A 后完成
```

A 完成后不得把旧快照写回并覆盖 B。保存期间产生的新修改必须继续保留为待保存的最新 `localRevision`，`flush()` 必须等待队列处理到最新 `localRevision`，并获得成功、失败或 Conflict 的明确结果。任何 Conflict 都不得静默覆盖 Server Scene 或丢弃本地 Scene；V1 不要求自动合并或实时冲突解决，但必须保留本地 Scene 和 Checkpoint。

### 15.3 Save Status

Header 状态必须以真实持久化结果为准：

```text
Save request       → Saving...
Server success     → Saved
Server failure     → Save failed
```

Debounce timer 执行本身不能触发 `Saved`。Asset Persist 失败、Revision Conflict 或 Scene Save 失败都必须显示 `Save failed`，保留当前 Scene 和本地 Checkpoint，并允许后续变化或重试再次保存。Thumbnail 生成失败不影响已成功的 Scene Save，也不应把已保存的 Scene 降级为失败。

失败流程为：

```text
Asset Failure
or Revision Conflict
or Scene Save Failure
        ↓
Save failed
        ↓
Keep local Scene
Keep Crash Checkpoint
Do not report Saved
```

### 15.4 Crash Checkpoint

除 Server Autosave 外，Board 需要维护本地 Crash Checkpoint，以覆盖 Browser Refresh、Tab Close、Process Kill 等异步保存来不及完成的场景。

Checkpoint 至少包含以下逻辑字段：

```text
key: nuvyn:board:checkpoint:{boardId}
boardId
sceneVersion
baseRevision
localRevision
BoardScene
savedAt
```

推荐概念模型为：

```ts
interface BoardCheckpoint {
  boardId: string
  sceneVersion: number
  baseRevision: number
  localRevision: number
  scene: BoardScene
  savedAt: number
}
```

其中：

```text
sceneVersion
→ Checkpoint 中 Scene 快照所使用的 Schema Version；Source of Truth 仍是 BoardSceneRecord.sceneVersion

baseRevision
→ 该本地快照基于哪个 Server Scene revision 产生

localRevision
→ 当前本地 Scene 变更序号；不承担 Server Revision 含义
```

Checkpoint 应在最新本地 Scene 更新后及时写入，不得等待 Server Save 成功。Server 成功接受对应 `localRevision` 的 Scene 后，客户端应更新 `currentServerRevision`，并清理已确认的 Checkpoint；若期间已有更新的本地 revision，则只能推进或重写 Checkpoint，不能清理更新中的本地修改。保存失败、保存中、Conflict 或 Board 被正常关闭但未确认成功时保留 Checkpoint。删除 Board 时必须清理对应 Checkpoint。

重新打开 Board 时，必须按 Server `revision` 对 Checkpoint 做 reconciliation：

```text
Load Server SceneRecord
        ↓
读取 server revision = N
        ↓
Load Local Checkpoint
        ↓
比较 baseRevision / localRevision
```

恢复判断至少遵循以下规则：

* Checkpoint 不存在：直接打开 Server Scene。
* Checkpoint 的 `baseRevision` 等于当前 Server `revision`，且存在未确认提交的本地修改：提示用户恢复。
* Server `revision` 已领先于 Checkpoint 的 `baseRevision`：不得自动用旧 Checkpoint 覆盖 Server Scene，进入 Recovery / Conflict flow。
* Checkpoint 损坏或无法校验：保留 Server Scene，忽略自动写回，进入恢复错误提示；不得用空 Scene 覆盖 Server 数据。

Checkpoint recovery 不得绕过 Server `expectedRevision` 校验。Checkpoint 复用 Draft / Recovery 的思想即可，不强行复用整个 Note 领域实现。

## 16. 编辑器状态边界

Board Editor 自己持有当前 Scene、`latestSceneRef`、dirty 标记和保存队列。完整 `elements[]` 及高频 Scene 变化不得长期放入 Nuvyn 全局 Pinia 或全局 reactive state。

全局层只保留页面和导航所需的最小状态，例如：

```text
boardId
title
saveStatus
updatedAt
```

这样可以避免拖动 Shape 时触发整个 Nuvyn App 重渲染；React Island 与 Vue Host 之间只传递必要事件和快照。

## 17. 离开页面时保存

如果用户在 Debounce 尚未触发或保存队列仍有待处理 `localRevision` 时离开 Board：

```text
Board
 ↓
Navigation
 ↓
await flush()
```

对于 Nuvyn 内部 Route Leave、Back 和 Close Board，必须主动等待 `flush()`，尽量确保最后一次 Scene Change 被持久化。`flush()` 以保存队列中最新 `localRevision` 获得成功、失败或 Conflict 的明确结果为准，并在失败或 Conflict 时保留 Checkpoint。

`beforeunload` 只能作为 Browser Refresh、Tab Close 等场景下的 Best Effort，不能作为数据安全机制；突发关闭由第 15.4 节的本地 Crash Checkpoint 提供额外恢复能力。

## 18. Scene 数据

Excalidraw 原始编辑器通常包含：

```text
elements
appState
files
```

Nuvyn 不直接把这份对象作为持久化业务模型。Board Scene 由 Board Domain 和 `BoardEngineAdapter` 共同定义，持久化范围为可恢复的 `engineData`、Nuvyn 通用的 `persistentAppState` 和资源引用 `assetRefs`。

### 18.1 Engine Data

`engineData` 是由 Adapter 序列化的 Engine-specific data，必须包含恢复 Board 所需的元素数据。其具体格式不向 Board Service 泄漏 Excalidraw 类型，并随 `sceneVersion` 迁移和校验。

### 18.2 Persistent AppState

禁止直接 `JSON.stringify(appState)` 完整写入持久层。应通过 `BoardPersistentAppState` 只保存适合恢复工作环境的字段，例如：

```text
viewBackgroundColor
gridSize
zoom
scrollX
scrollY
```

不得保存以下运行时状态：

```text
selectedElementIds
contextMenu
openDialog
draggingElement
editingElement
```

`persistentAppState` 必须保持为 Nuvyn 通用 Canvas 状态。如果未来出现 Excalidraw 专有字段，应放回 `engineData`，而不是让领域模型依赖 Excalidraw AppState。`theme` 不属于 Scene 持久状态；Canvas Background 等 Board-owned 字段可以保留。

### 18.3 Loading / Hydration

打开 Board 时必须明确区分：

```text
loading → hydrating → ready
                     ↘ error
```

正确顺序为：

```text
Load Board Metadata
        ↓
Load Server BoardSceneRecord
        ↓
读取 engine、sceneVersion、revision
        ↓
Load referenced Assets
        ↓
Migrate Scene
        ↓
Validate Scene
        ↓
Load local Crash Checkpoint
        ↓
Reconcile Checkpoint against Server revision
        ↓
Hydrate Board Editor state
        ↓
Mount React Island / Excalidraw
        ↓
ready
        ↓
Enable Autosave
```

在 `ready` 之前禁止业务 Autosave；不得先 Mount 一个可编辑 Empty Scene，再异步替换为已保存内容。Checkpoint recovery 必须继续通过 Server `expectedRevision` 并发保护，不能绕过服务端版本校验。

### 18.4 Fail Closed

Parse、Migration、校验、必要 Asset 组装或 Checkpoint reconciliation 失败时，必须停止加载并展示错误恢复 UI：

```text
Load / Validate Scene
        ↓
Failed
        ↓
STOP + Error UI
```

失败状态下不 Mount 可编辑的空 Scene、不启用 Autosave，也不允许将空数据写回原 Board。Referenced Asset 缺失属于数据完整性错误，必须遵循同样的 Fail Closed 规则。原始 Server Scene 和本地 Checkpoint 必须保留。

## 19. Files / Assets

### 19.1 Asset Source of Truth

图片等二进制资源长期持久化时必须以 Nuvyn Asset Layer 作为唯一真相源。

```text
Board
  │
  └── Image Element
          │
          ↓
        fileId
          │
          ↓
     Nuvyn Asset
```

Scene 只保存 `fileId` 对应的 `assetRefs`。Board 不重新建立一套完全独立于 Nuvyn 的附件体系。

### 19.2 Asset / Scene 写入顺序

插入新图片或其他二进制资源时，必须先完成 Asset 持久化，再允许 Scene 提交对该资源的引用：

```text
New Asset
    ↓
Persist Asset
    ↓
Asset becomes readable / committed
    ↓
Scene may commit assetRef
```

`Scene revision` 不得成功提交对尚未持久化成功 Asset 的引用。如果 Asset Persist 失败，不得提交包含该 `assetRef` 的 Scene revision；UI 必须显示资源保存失败，保留本地 Scene / Checkpoint 并允许重试，不能显示 `Saved`。

V1 不要求 Asset 与 Scene 一定使用数据库级跨表事务。允许采用 `Asset first → Scene second` 的顺序，因此 Scene 保存失败时可能产生 orphan Asset；这属于可由未来 GC / cleanup 回收的问题。必须优先保证不产生 dangling asset reference：

```text
Orphan Asset
→ 可回收问题

Missing Referenced Asset
→ 数据完整性问题，必须 Fail Closed
```

### 19.3 Runtime BinaryFiles

打开 Board 时由 Scene 和 Nuvyn Assets 组装 Excalidraw 所需的运行时 `BinaryFiles`；关闭或保存时通过 Adapter 将资源引用和 Engine Data 持久化。不得同时长期保存完整的 Scene `BinaryFiles` 副本和 Asset Store 副本。

```text
Board Scene assetRefs
        +
Nuvyn Asset Store
        ↓
Runtime BinaryFiles
```

### 19.4 Asset Ownership / Cleanup

Asset 删除必须基于引用关系，而不是简单按 Board 删除所有图片。共享 Asset 不得因为某个 Board 被删除而失效；只有确认 Asset 为 Board-private 且不存在其他引用时，才允许随 Board 清理。

未被任何 Scene、Note 或其他 Nuvyn Resource 引用的 Asset 可以在未来由 GC / cleanup 回收；V1 不提前建设完整 Asset GC Framework。删除 Board 时至少处理 Metadata、Scene、符合上述条件的 Board-private Assets、Thumbnail 和 Crash Checkpoint。若现有 Nuvyn 已有统一 Trash，则优先遵循统一 Trash 规则；否则按第 20 节的永久删除流程执行。

## 20. 删除 Board

Card Context Menu：

```text
Rename
Delete
```

删除属于破坏性操作。

必须确认：

```text
Delete board?

This board will be permanently deleted.

Cancel
Delete
```

V1 暂不提供：

```text
Trash
Restore
```

如果 Nuvyn 已经存在统一 Trash 系统，则应接入统一 Trash。永久删除时按第 19.4 节执行引用检查，并清理 Board Metadata、Scene、可安全回收的 Board-private Assets、Thumbnail 和本地 Crash Checkpoint。

## 21. 重命名

支持两处重命名：

```text
Board Card
    ↓
Context Menu
    ↓
Rename
```

以及：

```text
Board Editor
    ↓
Title
```

二者修改的是同一 Metadata。

---

## 22. 搜索

Board List 支持标题搜索。

V1：

```text
Search by Board Title
```

不要求搜索：

```text
Element Text
```

原因：

Scene 内全文搜索需要额外建立索引机制。

后续再加入。

---

## 23. 排序

Board 默认：

```text
updatedAt DESC
```

即最近编辑的 Board 排在最前面。

V1 暂不提供复杂排序切换。

---

## 24. 导出

Board 支持：

```text
Export PNG
Export SVG
```

入口：

```text
...
  ↓
Export
  ├── PNG
  └── SVG
```

可以优先复用 Excalidraw 官方导出能力。

---

## 25. Excalidraw UI

原则：

> 优先使用 Excalidraw 自己成熟的编辑器 UI。

不要为了追求 Nuvyn 风格而过早重写：

```text
Toolbar
Color Picker
Stroke Settings
Shape Picker
Text Settings
Zoom
Selection UI
```

V1 保持 Excalidraw 原生行为。

Nuvyn 仅对外围 UI 做统一。

---

## 26. Theme

Board 必须适配 Nuvyn：

```text
Light
Dark
System
```

当 Nuvyn Theme 改变：

```text
Nuvyn Theme
     ↓
Board
     ↓
Excalidraw Theme
```

Excalidraw Theme 应同步变化。

Theme 的 Source of Truth 是 Nuvyn 全局主题，不属于 Board Scene 持久状态。
Board 只拥有用户主动设置的 Canvas Background 等 Board-owned 字段。

---

## 27. Board 背景

Board Background 默认应与当前 Theme 协调。

Light：

```text
light canvas
```

Dark：

```text
dark canvas
```

用户修改 Canvas Background 后：

```text
User Setting
```

优先级高于默认 Theme。

具体行为需避免切换 Theme 时覆盖用户主动设置的背景颜色。

---

## 28. Fullscreen 思维

Board 属于强空间型 Workspace。

因此在 Board Editor 中，侧边栏可以考虑自动收起。

建议：

```text
进入 Board

     ↓

保持 Nuvyn Sidebar 状态

或者

提供沉浸模式
```

V1 不强制全屏。

但设计时必须确保：

> Canvas 是页面视觉主体。

---

## 29. 键盘快捷键

优先继承 Excalidraw 自身快捷键。

Nuvyn 不应重复拦截常用 Canvas Shortcut。

特别需要检查：

```text
Cmd / Ctrl + Z
Cmd / Ctrl + Shift + Z
Cmd / Ctrl + C
Cmd / Ctrl + V
Cmd / Ctrl + A
Delete
Backspace
Space
```

Board 激活状态下：

Excalidraw 应拥有这些快捷键的优先处理权。

---

## 30. Nuvyn Shortcut 冲突

如果 Nuvyn 存在全局快捷键：

```text
Cmd + K
Cmd + P
Cmd + N
...
```

需要明确：

```text
Global Shortcut
vs
Board Shortcut
```

的优先级。

原则：

Board 正在进行文本编辑时：

```text
Input / Text Editing
```

Nuvyn 不得错误拦截键盘输入。

---

## 31. Board 与 Note 的关系

V1 中：

```text
Board
```

和：

```text
Note
```

是两个领域独立、但同属 Personal OS 的一级 Workspace。

不要求第一版实现 Note Card。

但是 Board 的技术设计必须为未来 Resource Reference 留出能力。

---

## 32. Resource Reference

未来 Nuvyn 应具有统一资源引用模型：

```text
Resource Reference
├── Note
├── Diary
├── Ledger
├── Board
└── File
```

建议使用：

```ts
interface NuvynResourceReference {
  type: 'note' | 'diary' | 'ledger' | 'board' | 'file'
  id: string
}
```

---

## 33. Excalidraw customData

未来需要将 Nuvyn Resource 与 Element 绑定时，可以使用：

```text
customData
```

例如：

```ts
{
  customData: {
    nuvyn: {
      type: 'resource',
      resourceType: 'note',
      resourceId: 'xxx'
    }
  }
}
```

但是：

> V1 不实现该能力。

当前只预留设计，不进入开发范围。

---

## 34. Internal Link

未来可以设计 Nuvyn Internal Link：

```text
nuvyn://note/{id}
nuvyn://board/{id}
nuvyn://diary/{id}
nuvyn://ledger/{id}
```

Board 点击内部链接时由 Nuvyn Router 接管。

该能力同样不属于 V1 必须项。

---

## 35. 数据模型

Board Domain 由 Metadata 与 Scene 组成。以下是逻辑模型，实际实现应根据 Nuvyn 当前 Storage Architecture 调整。

### 35.1 Board Metadata

```ts
interface BoardMetadata {
  id: string
  title: string
  thumbnail?: string
  createdAt: number
  updatedAt: number
}
```

`BoardMetadata` 只描述 Board 本身及其 Gallery 所需信息，不包含 Canvas Engine、Scene Schema Version 或服务端 Scene Revision。

### 35.2 Domain Aggregate 与存储边界

```ts
interface Board {
  metadata: BoardMetadata
  sceneRecord: BoardSceneRecord
}

interface BoardSceneRecord {
  boardId: string
  engine: 'excalidraw'
  sceneVersion: number
  revision: number
  scene: BoardScene
}
```

`BoardSceneRecord` 是服务端 Scene 持久化记录，统一拥有 `engine`、`sceneVersion`、`revision` 和 `scene`。其中 `sceneVersion` 是 Board Scene Schema Version，`revision` 是当前 Board Scene 的服务端持久化版本号；`revision` 的初始值可由实现选择 `0` 或 `1`，但必须单调递增，每次成功提交新的 Scene 后递增。

Scene Update 请求必须携带 `expectedRevision`，用于服务端校验并发版本：服务端当前 `revision` 等于 `expectedRevision` 才能接受更新并返回递增后的 `revision`；不相等时必须拒绝旧更新并返回 Conflict（可使用 `409` 或项目统一冲突协议）。`expectedRevision` 是请求条件，不是另一个持久化 Source of Truth。

`Board` 可以作为业务层聚合返回，但 Metadata Store、Scene Store 和 Asset Store 是否拆成独立表或记录由实现决定。不得因为物理存储方便，把所有内容做成没有边界的巨大 JSON；Metadata 与 Scene 的更新、revision、并发校验和错误处理边界必须清晰。

## 36. BoardScene

建议：

```ts
interface BoardScene {
  engineData: unknown
  persistentAppState: BoardPersistentAppState
  assetRefs: readonly string[]
}
```

`engineData` 的具体格式由 `BoardEngineAdapter` 管理；`persistentAppState` 只包含 Nuvyn 通用、适合恢复的 Canvas 状态；`assetRefs` 只保存 Nuvyn Asset 引用。Board Service 不直接依赖 Excalidraw 类型，`BinaryFiles` 仅在运行时组装。

`BoardSceneRecord.sceneVersion` 表示当前 Board Scene Schema 版本，是该版本的唯一持久化 Source of Truth。Checkpoint 中的 `sceneVersion` 只是对应本地快照的 Schema Version 副本，不改变上述归属。不能假定未来 Scene Schema、Asset 映射或 Engine 数据永远不变化。

## 37. Scene Version

`sceneVersion` 只表示 Board Scene Schema Version，唯一归属于 `BoardSceneRecord`；它不是服务端保存次数，也不承担本地未保存变更序号。

初始：

```text
sceneVersion = 1
```

未来升级：

```text
V1 Scene
   ↓
Migration
   ↓
V2 Scene
```

例如：

```ts
migrateBoardScene(scene)
```

避免以后升级 Excalidraw 或 Board 数据模型时无法迁移已有白板。

---

## 38. 数据兼容原则

不要把数据库里的 Scene 当成不可控 JSON 黑盒。

需要明确：

```text
Board Schema Version

Nuvyn Version

Excalidraw Data
```

之间的边界。服务端 `revision` 是 Scene 持久化并发版本，与 `sceneVersion` 的 Schema 迁移版本相互独立；`localRevision` 只属于 Editor Session 的本地变更追踪。

未来升级 `@excalidraw/excalidraw` 时必须验证已有 Scene 的兼容性。

---

## 39. 错误恢复

Board Scene 的加载、迁移、校验、必要 Asset 组装或 Checkpoint reconciliation 失败时，遵循第 18.4 节的 Fail Closed 规则：停止加载、展示错误恢复 UI、保留原始 Server Scene 与本地 Checkpoint，并禁用 Autosave。

禁止将失败结果转换成可编辑 Empty Scene 后自动保存。

## 40. 保存异常

保存状态与失败处理遵循第 15.3 节：状态必须来自真实持久化结果。

如果 Autosave 失败：

```text
Header: Save failed
Memory latestSceneRef: 保留
Local Crash Checkpoint: 保留
```

不得显示 `Saved`。Revision Conflict、Asset Persist 失败和 Scene Save 失败都遵循此规则；后续变化或重试可以再次发起保存，具体冲突恢复交互不在 V1 自动合并范围内。

## 41. Loading

Board 打开时展示 Loading 状态，并按第 18.3 节完成 Metadata、SceneRecord（含 `engine`、`sceneVersion`、`revision`）、Assets 的读取、迁移、校验、Checkpoint reconciliation 和 Hydration。

Scene 未达到 `ready` 之前：

```text
不 Mount 可编辑 Empty Excalidraw
不启用业务 Autosave
```

## 42. Empty State

没有任何 Board：

```text
No boards yet

Turn ideas into a visual space.

[Create Board]
```

避免放过多说明。

---

## 43. Board List Context Menu

V1：

```text
Open

Rename

────────

Delete
```

如果单击 Card 已经负责 Open，则 Context Menu 中可以省略 Open。

---

## 44. Editor Menu

Editor 顶部：

```text
...
```

V1：

```text
Export
 ├── PNG
 └── SVG

────────

Delete Board
```

重命名直接点击 Title，不需要重复放入菜单。

---

## 45. 页面刷新

Web 环境刷新页面：

```text
F5
```

Board 必须能够：

```text
boardId
   ↓
Load Metadata
   ↓
Load Scene
   ↓
Restore Canvas
```

刷新不能导致 Board 状态丢失。

---

## 46. URL

Board 建议拥有独立 Route。

例如：

```text
/board
```

Board List。

具体 Board：

```text
/board/:boardId
```

例如：

```text
/board/01K...
```

这样 Board 可以：

* 浏览器刷新
* Back / Forward
* Bookmark
* 后续 Internal Link

---

## 47. 搜索系统集成

如果 Nuvyn 已经存在全局 Search：

V1 至少应允许搜索到：

```text
Board Title
```

搜索结果：

```text
Board

Ledger Architecture
Updated yesterday
```

点击直接：

```text
/board/:boardId
```

---

## 48. 性能目标

普通个人 Board 应保持流畅。

需要避免：

```text
onChange
  ↓
React global state
  ↓
整个 Nuvyn rerender
```

Excalidraw Scene 更新不能频繁触发无关 Workspace 重渲染。

Board State 应尽量局部化。

---

## 49. 大型 Board

V1 不需要针对超大型 Scene 做复杂虚拟化。

但是需要避免人为制造性能问题：

* 不在每次 Pointer Move 写数据库
* 不在每次 Change 生成 Thumbnail
* 不在每次 Change JSON Deep Clone 多次
* 不在 Scene 变化时触发整个应用状态树更新

---

## 50. 可访问性

Board 自身复杂 Canvas Accessibility 主要依赖 Excalidraw。

Nuvyn 外围 UI 必须保证：

```text
Button
Menu
Title Input
Delete Dialog
Board Card
```

具备正常 Keyboard Focus。

---

## 51. V1 功能范围

Board V1 最终 Scope：

```text
Board
├── Board 一级导航
│
├── Board List
│   ├── List / Grid
│   ├── Thumbnail
│   ├── Title
│   ├── Updated Time
│   ├── Search
│   ├── Create
│   ├── Rename
│   └── Delete
│
├── Board Editor
│   ├── Excalidraw
│   ├── Rename
│   ├── Autosave
│   ├── Save Status
│   ├── Dark Mode
│   └── Export
│       ├── PNG
│       └── SVG
│
├── Storage
│   ├── Metadata
│   ├── Scene
│   ├── Assets
│   ├── Schema Version
│   └── Error Recovery
│
└── Nuvyn Integration
    ├── Router
    ├── Search
    └── Theme
```

---

## 52. V1 不包含

明确排除：

```text
❌ Collaboration

❌ Share Link

❌ Comments

❌ Note Card

❌ Diary Card

❌ Ledger Card

❌ Board Card

❌ Custom Shape

❌ AI Board

❌ Template

❌ Mind Map

❌ Kanban

❌ Presentation

❌ Version History

❌ Element Full Text Search

❌ Mobile Advanced Editing

❌ Cloud Conflict Resolution
```

---

## 53. 后续版本方向

### V1.1

优先考虑：

```text
Insert Note
```

用户：

```text
Board
  ↓
Insert
  ↓
Note
```

选择一个 Note：

```text
REQ-002 Ledger
```

生成一个简单的 Board Element：

```text
┌─────────────────────────────┐
│ 📝 REQ-002 Ledger           │
└─────────────────────────────┘
```

点击：

```text
Open Note
```

此阶段仍不需要富 React Card。

---

## 54. V1.2

可以进一步支持：

```text
Resource Reference
```

包括：

```text
Note
Board
Diary
Ledger
```

形成 Nuvyn Workspace 之间的空间关联能力。

---

## 55. 长期方向

如果未来 Board 演变成：

```text
Canvas Application
```

而不仅仅是：

```text
Whiteboard
```

例如出现大量：

```text
Interactive Note Card
Database Card
Ledger Widget
Query Result
Task Widget
Embedded App
```

届时应重新评估 Excalidraw 是否仍然适合作为底层 Canvas Engine。

但 V1 不为这个假设提前增加复杂度。

---

## 56. 产品原则

Board 开发过程中遵循以下原则：

### 1. Board 是 Nuvyn 的产品，Excalidraw 是实现

不能反过来。

### 2. 先完成可靠白板，再做知识关联

不要第一版就开发复杂 Note Card。

### 3. 数据安全优先于交互炫技

任何加载和保存逻辑都不能存在静默覆盖用户数据的风险。

### 4. 优先复用 Excalidraw

不要重复开发已经成熟的 Canvas 能力。

### 5. 保持 Workspace 边界

```text
Note ≠ Board
```

两者互相引用，但互不从属。

---

## 57. 验收标准

### 首页

* Board Home 是纯 Gallery Home。
* 首页包含 Recent 和 All Boards 两个区域。
* All Boards 默认按 `updatedAt DESC` 排序。
* V1 不出现 Folder、FileTree 或 Board Directory。
* 不直接复用 `src/components/vault/FileTree.vue` 作为 Board UI。

### 创建

* 可以从 Board 首页创建新 Board。
* 创建后自动进入 Editor。
* 默认标题为 `Untitled Board`。
* 不需要填写 Modal。

### 编辑

* 可以正常使用 Excalidraw 基础绘图工具。
* 可以移动、删除、修改 Element。
* Undo / Redo 正常。
* 图片插入正常。
* Vue 与 React 通过局部 Host 边界协作，Scene 高频变化不会导致整个 Nuvyn 重渲染。
* React、React DOM 和 Excalidraw 不进入 Board Gallery 的初始加载路径。
* React Error Boundary 位于 React Island 内部；React / Excalidraw 失败可以通知 Vue Host，并展示 Nuvyn Board Error UI。

### 保存

* Scene 修改后自动保存。
* 用户不需要点击 Save。
* 保存期间可以显示 `Saving...`。
* 完成后仅在真实持久化成功后显示 `Saved`。
* 旧 Save 请求不能覆盖更新的 Scene。
* 离开页面前最后一次修改不会因为 Debounce 丢失。

### Revision 与并发保护

* Server Scene 只有一个持久化 `revision`，成功保存后单调递增。
* Scene Save 请求携带 `expectedRevision`；stale revision 会被拒绝并返回 Conflict（如 `409`）。
* Client Save Queue 保证当前 Editor Session 内保存有序，Server Revision 防止跨 Tab、跨窗口或跨 Session 的 stale write。
* 旧请求无法覆盖较新的 Scene，Conflict 不会静默丢弃本地 Scene。

### 恢复

* 关闭 Board 后重新进入，内容完全恢复。
* 刷新页面后内容完全恢复。
* Viewport 在合理范围内恢复。
* Server Save 未完成时突然关闭，重新进入可发现并处理较新的本地 Crash Checkpoint。
* Checkpoint 明确记录其 `baseRevision`，Server Scene 已领先时不会自动覆盖 Server Scene。
* Checkpoint recovery 不会绕过 `expectedRevision` 校验。

### Assets

* Scene 不会成功提交对尚未成功持久化 Asset 的引用。
* Asset 保存失败时 Scene 不显示 `Saved`，本地 Scene / Checkpoint 可以保留并重试。
* Asset 成功但 Scene 保存失败时允许产生 orphan Asset，且 orphan asset 不影响 Scene 数据正确性。
* 未被引用的 orphan Asset 可由未来 GC / cleanup 回收；V1 不要求完整 Asset GC Framework。
* referenced Asset 缺失时 Load 遵循 Fail Closed，不挂载可编辑空 Scene，也不自动写回。

### 数据安全

* Scene 加载、迁移、校验或必要 Asset 组装失败不能覆盖原数据。
* Scene 未加载完成前不能触发空 Scene Autosave。
* 保存失败不能错误显示 `Saved`。
* Nuvyn Asset 是二进制资源的唯一持久化真相源。
* Thumbnail 生成失败不影响 Scene 已保存状态。

### Board 管理

* 可以重命名。
* 可以删除。
* 删除需要确认。
* 删除会清理 Scene、Thumbnail、Checkpoint，并按引用关系处理 Board-private Assets。
* 默认按最近更新时间排序。

### 搜索

* Board List 可以按照标题搜索。
* Nuvyn Global Search 可以找到 Board Title。

### Theme

* Light Mode 正常。
* Dark Mode 正常。
* 跟随 Nuvyn Theme。
* Nuvyn Theme 不会被 Board Scene 中的持久字段覆盖。

### Export

* 可以导出 PNG。
* 可以导出 SVG。

### 性能

* 正常规模 Board 编辑过程中无明显卡顿。
* 拖动 Element 不会持续写入数据库。
* Scene Change 不会导致整个 Nuvyn 页面频繁重渲染。
* Thumbnail 不会在每次 Scene Change 或 Pointer Move 时生成。

## 58. 最终定义

Board V1 可以概括为：

```text
一个属于 Nuvyn 的、
以 Excalidraw 为画布引擎的、
本地持久化的、
独立无限白板 Workspace。
```

它首先解决：

> 「我需要一个空间来组织和连接我的想法。」

而不是第一版就解决：

> 「我要构建一个完整的可编程 Canvas 平台。」

先把白板本身做到稳定、自然、可靠，再逐步让：

```text
Note
Diary
Ledger
Board
```

在这个空间中真正产生连接。
