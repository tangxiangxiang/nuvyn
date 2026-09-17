# Board V1 Implementation Plan

**日期：** 2026-09-14
**模块：** Board
**状态：** Frozen for B0 / Ready for Implementation
**依据：** `docs/design/board-v1-prd.md`
**目标版本：** Board V1

---

## 1. 实现目标

Board V1 只完成以下核心闭环：

```
Board Home
    ↓
Create Board
    ↓
Open Editor
    ↓
Draw / Edit / Insert Image
    ↓
Autosave
    ↓
Close / Refresh
    ↓
Reopen
    ↓
Exact Scene Restored
```

同时完成：

```
Gallery Home
Rename
Delete
Search by title
Thumbnail
PNG / SVG Export
Light / Dark Theme
Crash Checkpoint
Revision Conflict Protection
Image Asset Persistence
```

不扩大到：

```
Folder
FileTree
Collaboration
Sharing
Templates
AI Board
Mind Map
Resource Card
Custom Shape
Version History
Cloud Sync
Full Asset GC
```

---

# 2. 总体架构

最终结构：

```
Nuvyn
│
├── Vue App Shell
│   │
│   ├── GlobalSearchHost
│   │
│   ├── BoardHomeView
│   │
│   └── BoardEditorView
│       │
│       └── ExcalidrawHost.vue
│                    │
│                    ▼
│              React Island
│                    │
│            BoardReactErrorBoundary
│                    │
│                    ▼
│               Excalidraw
│
├── Board Feature
│   ├── API
│   ├── Domain
│   ├── Save Coordinator
│   ├── Checkpoint
│   ├── Engine Adapter
│   └── Thumbnail
│
└── Server
    ├── Board Domain
    ├── Asset Domain
    ├── SQLite
    └── data/assets/
```

核心原则：

```
Vue owns Board product lifecycle

React owns Excalidraw rendering

BoardEngineAdapter owns Excalidraw translation

SQLite owns Board metadata / scene metadata

data/assets owns binary bytes

IndexedDB owns unsaved crash recovery
```

---

# 3. Dependency Strategy

新增：

```
@excalidraw/excalidraw
react
react-dom
@types/react
@types/react-dom
```

不要默认增加：

```
@vitejs/plugin-react
```

第一版 React Island 不使用 JSX。

使用：

```
React.createElement(...)
createRoot(...)
```

实现 Island。

原因：

```
现有 Vite
  +
Vue Plugin
  +
dynamic Board Editor chunk
```

已经足够承载一个隔离的 React subtree。

这样不需要改变整个 Nuvyn 的 Vite 编译体系。

只有实际安装后的兼容性 Spike 证明必须增加 React Vite Plugin 时才能调整。

Excalidraw CSS 也从 React Island chunk 内按需加载。

---

# 4. Shared Protocol

新增：

```
shared/boardProtocol.ts
shared/assetProtocol.ts
```

Board Domain：

```
interface BoardMetadata {
  id: string
  title: string
  thumbnailAssetId: string | null
  createdAt: number
  updatedAt: number
}

interface BoardSceneRecord {
  boardId: string
  engine: 'excalidraw'
  sceneVersion: number
  revision: number
  scene: BoardScene
}

interface BoardScene {
  engineData: unknown
  persistentAppState: BoardPersistentAppState
  assetRefs: readonly string[]
}

interface BoardPersistentAppState {
  zoom?: number
  scrollX?: number
  scrollY?: number
  gridSize?: number | null
  viewBackgroundColor?: string
}
```

`thumbnailAssetId` 的语义固定为 Nuvyn Asset ID：

```
Asset ID
≠ URL
≠ Data URL
≠ File Path
```

没有 Thumbnail 时返回 `null`。Board Domain 不保存 Server URL；UI 通过
Asset URL resolver 将 Asset ID 转换为 `/api/assets/:assetId`。

Server authoritative fields：

```
engine
sceneVersion
revision
```

只能属于：

```
BoardSceneRecord
```

---

# 5. Asset ID 与 Excalidraw File ID 必须分离

不要：

```
Excalidraw fileId
=
Nuvyn assetId
```

Nuvyn 自己生成：

```
assetId = crypto.randomUUID()
```

Excalidraw Engine Adapter 内部维护：

```
interface ExcalidrawEngineDataV1 {
  elements: unknown[]

  fileMap: Record<
    string, // Excalidraw fileId
    string  // Nuvyn assetId
  >
}
```

例如：

```
Excalidraw fileId
       │
       ▼
   fileMap
       │
       ▼
Nuvyn Asset ID
```

这样未来替换 Canvas Engine 时：

```
Nuvyn Asset ID
```

不会依赖 Excalidraw 的 ID 规则。

`BoardScene.assetRefs`：

```
=
unique(fileMap.values())
```

Adapter serialize 时必须校验二者一致。

---

# 6. Database Migration

当前 migration 到 `0029`。

预定新增：

```
0030_asset_foundation.sql
0031_board_foundation.sql
```

实施前重新检查 main 最新 migration。

如果届时已有新的 migration：

```
只向后顺延编号
不得修改已经存在的 migration
```

---

## 6.1 assets

```
CREATE TABLE assets (
  id TEXT PRIMARY KEY NOT NULL,

  mime_type TEXT NOT NULL,

  byte_size INTEGER NOT NULL,

  sha256 TEXT NOT NULL,

  storage_key TEXT NOT NULL UNIQUE,

  created_at INTEGER NOT NULL
);
```

Binary 本身：

```
不存 SQLite BLOB
```

保存到：

```
data/assets/
```

例如：

```
data/assets/<asset-id>
```

文件名不使用用户原始 filename。

---

## 6.2 asset_references

建立通用引用表：

```
CREATE TABLE asset_references (
  asset_id TEXT NOT NULL
    REFERENCES assets(id) ON DELETE RESTRICT,

  owner_type TEXT NOT NULL,

  owner_id TEXT NOT NULL,

  purpose TEXT NOT NULL,

  created_at INTEGER NOT NULL,

  PRIMARY KEY (
    asset_id,
    owner_type,
    owner_id,
    purpose
  )
);
```

Board V1 使用：

```
owner_type = board

purpose =
  scene
  thumbnail
```

不要把表命名成：

```
board_assets
```

因为这是 Nuvyn Asset Layer。

未来：

```
Note
Diary
Board
...
```

都可以使用它。

---

# 7. Board Tables

## boards

```
CREATE TABLE boards (
  id TEXT PRIMARY KEY NOT NULL,

  title TEXT NOT NULL,

  created_at INTEGER NOT NULL,

  updated_at INTEGER NOT NULL
);
```

不保存：

```
engine
sceneVersion
revision
```

---

## board_scenes

```
CREATE TABLE board_scenes (
  board_id TEXT PRIMARY KEY NOT NULL
    REFERENCES boards(id) ON DELETE CASCADE,

  engine TEXT NOT NULL,

  scene_version INTEGER NOT NULL,

  revision INTEGER NOT NULL,

  engine_data_json TEXT NOT NULL,

  persistent_app_state_json TEXT NOT NULL
);
```

约束：

```
engine = excalidraw

sceneVersion = 1

revision initial = 0
```

`engine_data_json` 是 `NOT NULL`，因此 Empty Scene 也必须写入合法的
Excalidraw V1 Engine Data，不能使用 `null`：

```text
engine_data_json = '{"elements":[],"fileMap":{}}'
persistent_app_state_json = '{}'
```

在 `engine = 'excalidraw'` 且 `sceneVersion = 1` 时，`BoardScene.engineData`
始终是 `ExcalidrawEngineDataV1` 形状，即使没有任何元素或图片。

第一笔成功 Scene Save：

```
0 → 1
```

---

# 8. 为什么 assetRefs 不再存 JSON Column

Domain 仍然暴露：

```
BoardScene.assetRefs
```

但 physical persistence 使用：

```
asset_references
```

作为关系型 Source of Truth。

`BoardMetadata.thumbnailAssetId` 是 `asset_references` 中
`owner_type = board`、`purpose = thumbnail` 的投影：存在引用时返回 Asset
ID，没有引用时返回 `null`。不在 Board metadata 中另存 URL、Data URL 或
filesystem path。

Server 读取：

```
board_scenes
+
asset_references
      ↓
BoardScene
```

保存：

```
Scene JSON
+
assetRefs
      ↓
SQLite transaction
      ↓
update board_scenes
replace scene asset references
update boards.updated_at
```

替换引用时必须在事务中记录旧引用与新引用的差集。事务成功提交后，已知
被移除的 Asset 才可以进入统一的 eager cleanup。cleanup 不得采用独立的
`reference count == 0` 查询再删除 metadata 或 binary 的 check-then-delete
流程；必须先通过原子 metadata claim 获得删除权。cleanup 失败不能回滚已经
成功的 Scene、Thumbnail 或 Board Delete，且必须记录或返回非致命 cleanup
结果。

这样可以直接回答：

```
一个 Asset 是否仍被引用？
```

而不需要扫描所有 Scene JSON。

---

# 9. Asset Storage Service

新增建议：

```
server/assets/
├── repository.ts
├── service.ts
├── storage.ts
├── routes.ts
└── types.ts
```

`storage.ts` 保存：

```
data/assets/
```

Asset Storage 初始化属于 B1：

```
ensure data/assets exists
      ↓
lstat data/assets
      ↓
必须是普通目录，且不能是 symlink
```

初始化必须复用现有 filesystem 安全模型；目录检查失败时禁止继续写入。

Binary 写入复用：

```
writeCreateOnlyDurableFile()
```

确保：

```
create only
fsync
sha256
no accidental overwrite
```

Asset Persist 是两个阶段，不是跨 filesystem / SQLite 的原生事务：

```
1. durable create binary
2. BEGIN SQLite transaction
3. INSERT asset metadata
4. COMMIT
```

如果 binary 已创建但 metadata INSERT 或 COMMIT 失败，并且能够确认该文件
属于本次调用，则调用 `removeCreatedDurableFile()`。补偿删除也失败时允许
留下 orphan file，但不得留下指向不确定 binary 的 DB metadata；成功的
Board / Scene 保存不能因此被回滚。

## Unreferenced Asset Cleanup

所有已知移除引用的 cleanup 都使用同一个概念 primitive（具体函数名由
实现决定）：

```ts
tryClaimUnreferencedAssetForDeletion(assetId): {
  claimed: boolean
  storageKey?: string
}
```

它必须在独立的 SQLite 写事务中原子完成 metadata deletion 与 zero-reference
判断：

```sql
BEGIN IMMEDIATE;

DELETE FROM assets
WHERE id = :assetId
  AND NOT EXISTS (
    SELECT 1
    FROM asset_references
    WHERE asset_id = :assetId
  );

COMMIT;
```

只有 `DELETE` 成功影响一行并提交，当前 cleanup 才取得该 Asset 的 physical
binary 删除权，并可以根据返回的 `storageKey` 删除文件。metadata deletion
未发生时，不得删除 binary；这表示 Asset 仍有引用，或已经被其他 cleanup
claim。

`asset_references.asset_id` 继续通过 `REFERENCES assets(id)` 保护。metadata
delete 先提交后，新的 reference insert 将因外键约束失败，因此并发 Save
只能在 claim 之前保留 Asset，或在 claim 之后失败，不能提交 dangling
reference。metadata 已成功删除但 physical delete 失败时允许留下 orphan
binary；不得重建 metadata、回滚已成功的数据保存，或把 orphan 当成失败的
Scene / Thumbnail / Board Delete。

以下路径必须复用该 primitive，不得各自实现 `count → delete`：

```text
Scene removedAssetIds
Thumbnail oldAssetId
Board Delete candidateAssets
```

---

# 10. Asset API

挂载：

```
/api/assets
```

所有接口继续受现有：

```
authBoundary
```

保护。

---

## PUT /api/assets/:assetId

客户端提前生成 UUID。

Server 必须先验证 raw `assetId` 满足 UUID 格式，再生成 `storage_key` 和
filesystem path。禁止把未验证的 route param 直接传给 `path.join`，也不允许
`../`、`/`、`\\`、URI 或任意文件名进入路径逻辑。

请求：

```
PUT /api/assets/{assetId}

Content-Type: image/png
<body binary>
```

支持 V1 图片 MIME：

```
image/png
image/jpeg
image/webp
image/gif
image/avif
```

上传必须受 Server-side hard byte limit 保护：

```
Content-Length 已超限 → 立即拒绝
未知或不可信 Content-Length → streaming 过程中按字节数限制
超限 → 413 ASSET_TOO_LARGE
```

Server 不能先无限 buffering 再检查大小。`Content-Type` 只代表客户端声明，
不能单独作为内容可信依据；allow-list 是强制要求，B1/B2 还必须明确评估
并测试 magic-byte validation，并拒绝声明 MIME 与可识别文件签名不一致的
情况（具体检测库或实现方式属于 implementation detail）。

V1 不接受 SVG Asset。

SVG Export 不受影响。

创建成功：

```json
{
  "id": "...",
  "mimeType": "image/png",
  "byteSize": 123456,
  "sha256": "..."
}
```

---

## Idempotency

Crash Recovery 可能重复上传同一个 asset。

所以：

```
assetId already exists
+
sha256 same
→ return existing asset success
```

如果：

```
assetId same
+
hash different
→ 409 ASSET_ID_CONFLICT
```

相同 `assetId` 的 retry 必须核对已有 metadata、物理 binary 和 hash。任何
retry 都不得覆盖旧 binary；已有记录但 metadata、binary 或 hash 无法一致
验证时返回失败结果，不得伪造成功。

---

## GET /api/assets/:assetId

读取：

```
Asset metadata
   ↓
safe storage path
   ↓
binary stream
```

设置：

```
Content-Type
X-Content-Type-Options: nosniff
```

---

# 11. Board Server Domain

新增：

```
server/board/
├── repository.ts
├── service.ts
├── validation.ts
├── errors.ts
└── routes/
    ├── index.ts
    └── shared.ts
```

不要塞进：

```
server/routes/posts.ts
```

或 Vault Domain。

在：

```
server/index.ts
```

挂载：

```ts
app.route('/api/board', boardRoutes)
app.route('/api/assets', assetRoutes)
```

## Asset Reference Trust Boundary

浏览器提交的 `assetRefs` 只是待校验的输入，不是 Server 的可信事实。Scene
Save 在进入 repository 或 SQLite reference transaction 之前，必须独立执行：

```
接收 scene.assetRefs
      ↓
验证是 array
      ↓
验证每个 assetId 是 UUID
      ↓
去重并形成 normalizedAssetIds
      ↓
验证每个 Asset metadata 存在
      ↓
验证每个 physical binary 可读取
      ↓
继续 Scene reference transaction
```

非法形状、非法 ID 或不可引用的 Asset 必须 fail closed（例如返回
`400 INVALID_ASSET_REFERENCE` 或统一 validation error）。如果 preflight 之后
Asset 在并发 cleanup 中被 claim，后续 reference transaction 仍必须因
`REFERENCES assets(id)` 或等价的事务保护而失败；Scene 不得提交 dangling
reference。

Server 不解析或修复 Excalidraw `engineData`、elements 或 fileMap。Adapter
负责 `engineData` 与 `assetRefs` 的 extraction consistency；Server 只负责
`assetRefs` 的 shape、ID、去重、Asset 存在性和 binary 可读性，并保证实际
写入 `asset_references` 的 ID 全部已通过这些检查。

`asset_references` 保持通用表，`owner_type` 与 `purpose` 不由浏览器控制：

```text
Browser 只提交：assetId / assetRefs

Scene Save：
  owner_type = board
  owner_id   = boardId
  purpose    = scene

Thumbnail：
  owner_type = board
  owner_id   = boardId
  purpose    = thumbnail
```

这些语义由 Board Domain Service 在内部注入。Route 不接受也不透传
`owner_type`、`owner_id` 或 `purpose`；Repository 不向 Route 暴露任意
reference write API，而提供语义化能力，例如：

```ts
BoardService.replaceSceneAssetRefs(boardId, normalizedAssetIds)
BoardService.replaceThumbnailAsset(boardId, assetId)
```

具体函数名可以在实现阶段调整，但不能改变上述信任边界。通用表可以继续
支持未来的 Note、Diary 等 owner，不为了 Board V1 加上只允许 `board` 的
CHECK；通用的非空约束仍可作为 B1 implementation detail。

---

# 12. Board API

## GET /api/board

返回：

```ts
BoardMetadata[]
```

Server：

```
ORDER BY updated_at DESC, id DESC
```

Board Home：

```
Recent = first N
All Boards = all
```

建议：

```
Recent = first 6
```

---

## POST /api/board

无 request body 或空 body。

Server transaction：

```
Generate Board ID

INSERT boards
  title = Untitled Board

INSERT board_scenes
  engine = excalidraw
  scene_version = 1
  revision = 0
  engine_data_json = '{"elements":[],"fileMap":{}}'
  persistent_app_state_json = '{}'
```

Canonical Empty Scene：

```json
{
  "engineData": {
    "elements": [],
    "fileMap": {}
  },
  "persistentAppState": {},
  "assetRefs": []
}
```

当 `engine = 'excalidraw'` 且 `sceneVersion = 1` 时，Empty Scene 的
`engineData` 不使用 `null` 表示。创建 Board 和 Adapter 初始化必须使用同一
个 Canonical Empty Engine Data。

注意：

```
POST /board
```

不能因为创建空白 Board 而加载 Excalidraw。

---

## GET /api/board/:id

返回：

```ts
{
  metadata: BoardMetadata
  sceneRecord: BoardSceneRecord
}
```

不返回 binary asset bytes。

---

## PATCH /api/board/:id

V1：

```json
{
  "title": "Ledger Architecture"
}
```

空标题统一 normalize：

```
Untitled Board
```

更新：

```
boards.title
boards.updated_at
```

---

# 13. Scene Save API

## PUT /api/board/:id/scene

Request：

```ts
interface SaveBoardSceneRequest {
  expectedRevision: number

  engine: 'excalidraw'
  sceneVersion: number

  scene: BoardScene
}
```

服务端执行：

```
1. Validate request envelope

2. Validate scene.assetRefs is an array

3. Validate every assetRef as UUID

4. Deduplicate assetRefs into normalizedAssetIds

5. Verify every referenced Asset metadata exists

6. Verify every referenced Asset binary is readable

7. BEGIN SQLite transaction

8. SELECT current revision

9. currentRevision != expectedRevision
      → Conflict

10. UPDATE board_scenes
      revision = revision + 1

11. Replace asset_references using normalizedAssetIds
      purpose = scene

12. UPDATE boards.updated_at

13. COMMIT
```

Reference writes use the Server-injected `owner_type = board`、`owner_id =
boardId`、`purpose = scene`，不读取请求中的同名字段。若 Asset 在 preflight
与 transaction 之间消失，外键或等价的 transaction guard 必须使整个 Scene
Save 失败，不得提交部分 reference 或 Scene。

Response：

```json
{
  "revision": 13,
  "updatedAt": 1789370000000
}
```

---

# 14. Optimistic Concurrency

使用：

```
expectedRevision
```

而不是只依赖客户端 Queue。

推荐数据库更新：

```sql
UPDATE board_scenes
SET
  ...
  revision = revision + 1
WHERE
  board_id = ?
  AND revision = ?;
```

检查：

```
changes === 1
```

否则：

```
409 BOARD_SCENE_CONFLICT
```

Response：

```json
{
  "code": "BOARD_SCENE_CONFLICT",
  "currentRevision": 13
}
```

Server 不自动 merge。

---

# 15. Thumbnail API

Thumbnail 作为 Nuvyn Asset 保存。

流程：

```
Scene Save success
      ↓
mark thumbnail dirty
      ↓
3s debounce / idle
      ↓
Adapter generate PNG
      ↓
PUT /api/assets/:thumbnailAssetId
      ↓
PUT /api/board/:id/thumbnail
```

新增：

```
PUT /api/board/:id/thumbnail
```

Body：

```json
{
  "assetId": "..."
}
```

Server：

```
validate assetId and referenced Asset
replace asset reference
owner_type = board
owner_id = boardId
purpose = thumbnail
```

Thumbnail Asset 是 create-only binary，因此每次内容变化都必须显式处理旧
引用：

```
oldAssetId = current thumbnail reference

newAssetId uploaded
        ↓
BEGIN SQLite transaction
        ↓
replace thumbnail reference with newAssetId
        ↓
COMMIT
        ↓
tryClaimUnreferencedAssetForDeletion(oldAssetId)
        ↓
if claimed
    delete physical binary
```

只有新引用事务成功提交后，才允许对旧 Asset 执行 metadata claim。必须使用
第 9 节的统一原子 cleanup primitive；不能先查询 reference count，也不能先
删 binary。claim 失败时保留 Asset；claim 成功但 physical delete 失败时保留
orphan binary。任一 cleanup 失败都只记录或返回非致命结果，不能回滚已经
成功的 Thumbnail 或 Scene 保存。这属于对已知移除引用的 eager release，不
建设 background GC、periodic scanner 或 mark-and-sweep。

非常重要：

```
更新 Thumbnail
不得更新 boards.updated_at
```

否则：

```
Scene Save
   ↓
3 秒后 Thumbnail Save
   ↓
updatedAt 再变化
   ↓
Board 排序无意义漂移
```

Thumbnail 失败：

```
Scene 仍是 Saved
```

---

# 16. Delete API

## DELETE /api/board/:id

V1 当前没有跨 Workspace 通用 Trash。

所以：

```
Permanent Delete
```

Server transaction：

```
collect board asset refs
delete asset_references
delete board
  ↓ cascade board_scene
commit
```

Commit 后：

```
for candidate assets
  claim unreferenced metadata atomically
  if claimed
    delete physical binary
```

Cleanup 结果：

```
metadata claim 未成功
→ 不删除 physical binary，Asset 保留

metadata claim 成功但 physical delete 失败
→ 允许留下 orphan binary
```

Cleanup failure 只返回或记录非致命结果，不回滚已经成功的 Board Delete。

不能：

```
回滚已经成功的 Board Delete
```

因为：

```
orphan > dangling reference
```

Scene `assetRefs` 也遵循同一生命周期：事务中用旧集合与新集合计算
`removedAssetIds`，提交成功后逐个调用统一的 metadata claim；只有 claim
成功才尝试删除 physical binary。cleanup 失败保留 orphan Asset，不回滚成功
的 Scene 或 Board Delete。Scene、Thumbnail 和 Board Delete 都禁止各自实现
`count → delete`。

---

## Client-side recovery cleanup

用户确认删除后，客户端严格按以下顺序处理：

```
DELETE /api/board/:id
        ↓
Server delete success
        ↓
delete IndexedDB checkpoint for boardId
delete IndexedDB pending-assets for boardId
        ↓
navigate back to Board Home
```

如果 Server Delete 失败，必须保留该 Board 的 checkpoint 和 pending-assets，
不得先清理本地 Recovery 数据。

安全得多。

---

# 17. Frontend Feature Structure

新增：

```
src/features/board/
├── api.ts
├── domain.ts
├── boardErrors.ts
├── boardMetadataSource.ts
├── boardSearchProvider.ts
├── saveCoordinator.ts
├── checkpointStore.ts
├── checkpointReconciliation.ts
├── assetClient.ts
├── thumbnailScheduler.ts
│
└── engine/
    ├── BoardEngineAdapter.ts
    └── excalidraw/
        ├── adapter.ts
        ├── engineData.ts
        ├── reactIsland.ts
        └── ReactErrorBoundary.ts
```

Vue components：

```
src/components/search/
└── GlobalSearchHost.vue

src/components/board/
├── BoardCard.vue
├── BoardGallery.vue
├── BoardEditorHeader.vue
└── ExcalidrawHost.vue
```

Views：

```
src/views/
├── BoardHomeView.vue
└── BoardEditorView.vue
```

---

# 18. BoardEngineAdapter

Domain interface：

```ts
interface BoardEngineAdapter {
  deserialize(
    scene: BoardScene,
    assets: ResolvedAsset[],
  ): EngineInitialData

  serialize(
    runtimeScene: unknown,
  ): BoardSceneSerializationResult

  generateThumbnail(...): Promise<Blob>

  exportPng(...): Promise<Blob>

  exportSvg(...): Promise<string>
}
```

Domain 层不能 import：

```
ExcalidrawElement
AppState
BinaryFiles
```

这些只能存在于：

```
engine/excalidraw/*
```

内部。

对于 `engine = 'excalidraw'`、`sceneVersion = 1` 的输入，
`deserialize()` 必须能直接处理 Canonical Empty Engine Data：

```ts
{
  elements: [],
  fileMap: {},
}
```

Adapter 初始化不得把 Empty Scene 转换成 `null`，也不得在加载失败时用
空 Scene 覆盖已获取的 Server Scene。

---

# 19. Excalidraw Adapter V1

内部格式：

```ts
interface ExcalidrawEngineDataV1 {
  elements: unknown[]

  fileMap: Record<string, string>
}
```

其中：

```
key   = Excalidraw fileId
value = Nuvyn assetId
```

Adapter 负责：

```
Excalidraw elements
Excalidraw AppState
Excalidraw BinaryFiles
        ↕
BoardScene
```

---

# 20. Persistent AppState

只持久化：

```
zoom
scrollX
scrollY
gridSize
viewBackgroundColor
```

不持久化：

```
selectedElementIds
editingElement
draggingElement
contextMenu
openDialog
theme
```

Theme：

```
Nuvyn Theme
      ↓
Excalidraw prop
```

Canvas Background：

```
Board Scene
```

`BoardPersistentAppState` 只表示 Nuvyn 通用 Canvas 状态。若某个字段最终
属于 Excalidraw 专有运行时状态，应放入 `engineData` 并由 Adapter 转换，
不能逐步把 Excalidraw 专有 AppState 字段扩散到 Domain Model。

---

# 21. React Island

`ExcalidrawHost.vue` 不直接 import React。

Mount 时：

```ts
const island = await import(
  '@/features/board/engine/excalidraw/reactIsland'
)
```

如果当前项目没有 `@` alias，使用从
`src/components/board/ExcalidrawHost.vue` 到目标模块的正确相对路径：

```ts
const island = await import(
  '../../features/board/engine/excalidraw/reactIsland'
)
```

Plan 不得保留 `../features/...` 这一层级错误的路径。

所以：

```
Board Home
```

不会下载：

```
React
React DOM
Excalidraw
```

React Island：

```
React Root
   ↓
BoardReactErrorBoundary
   ↓
Excalidraw
```

Vue → React：

```
initialData
theme
callbacks
```

React → Vue：

```
onSceneChange
onAssetsChanged
onFatalError
```

---

# 22. Router

新增：

```
/board
/board/:boardId
```

App Shell 使用明确的 Workspace identity：

```ts
type WorkspaceKind =
  | 'vault'
  | 'ledger'
  | 'board'
  | null
```

Route 到 Workspace 的映射固定为：

```
/vault/*
→ vault

/ledger/*
→ ledger

/board
→ board

/board/:boardId
→ board
```

Board Editor 另外使用 `immersive` Chrome style。Workspace identity 与 Chrome
style 是两个独立概念：

```
Chrome style
≠
Workspace identity
```

建议：

```ts
{
  path: '/board',
  name: 'board',
  component: () => import('../views/BoardHomeView.vue'),
  meta: {
    fullWidth: true,
    workspace: true,
    workspaceKind: 'board',
    chromeStyle: 'workspace',
    sidebar: false,
  },
}

{
  path: '/board/:boardId',
  name: 'board-editor',
  component: () => import('../views/BoardEditorView.vue'),
  meta: {
    fullWidth: true,
    workspace: true,
    workspaceKind: 'board',
    chromeStyle: 'immersive',
    sidebar: false,
    immersive: true,
  },
}
```

给 RouteMeta 增加：

```ts
immersive?: boolean
workspaceKind?: WorkspaceKind
chromeStyle?: 'workspace' | 'immersive'
```

---

# 23. App Shell

Board Home：

```
使用 compact Nuvyn workspace navbar
```

Board Editor：

```
隐藏 global NavBar
```

因为 Editor 自己拥有：

```
Back
Title
Save status
Menu
```

App.vue：

```
Vault
Ledger
Board Home
→ workspace chrome

Board Editor
→ immersive chrome
```

`isWorkspaceChrome` 或等价字段只决定 Chrome style，不能再作为
`NavBar.isVault` 的替代值。App Shell 必须根据真实 `workspaceKind` 传递
NavBar 状态；Board 不得通过 `isVault = true` 表示“使用 compact workspace
chrome”。

NavBar 的显示规则：

```
workspaceKind === 'vault'
→ Vault-only controls

workspaceKind === 'ledger'
→ Ledger-only controls

workspaceKind === 'board' 且 route = /board
→ 通用 Workspace Chrome + Board navigation state

workspaceKind === 'board' 且 route = /board/:boardId
→ 不显示 Global NavBar
```

Editor 页面：

```
--navbar-h = 0
```

最大化 Canvas。

---

## Global Search Host

Nuvyn Global Search 属于 App Shell，不属于 `VaultView`。`App.vue` 只挂载一个
全局 Host，路由切换时保持同一实例：

```text
App.vue
   ├── NavBar
   ├── RouterView
   └── GlobalSearchHost.vue
```

`GlobalSearchHost` 负责：

```text
Open / Close
Keyboard shortcut
Focus trap
Result rendering
Provider coordination
Result commit / navigation
```

它不能拥有 Vault-specific domain，也不能 import `VaultView`。现有
`CommandPalette.vue` 的搜索 UI 应抽取、重命名或等价迁移为该 Host，避免并行
实现第二套搜索 UI；Vault document provider 则从 `VaultView` 的私有创建逻辑
中移出，由 App-level provider registry 或独立 Search feature 提供。

Provider Registry：

```text
GlobalSearchHost
        ↓
Search Provider Registry
        ├── Document Search Provider
        └── Board Search Provider
```

继续使用现有 `SearchProvider`、`SearchResultSection`、`searchEverywhere()`
和 `createLatestSearchRunner()`。NavBar 的 Search button 与 Cmd/Ctrl + P
必须调用 App-level 的 `openGlobalSearch()`（通过现有 App Shell context 或
等价的 `GlobalSearchContext`），不得再依赖 `VaultView.paletteRef`。

Host 在 `/vault/*`、`/ledger/*` 和 `/board` 都可打开；Board Editor 的
immersive route 可以按 B3/B4 的实现细节决定是否禁用 shortcut，但 Board Home
必须可用。Result commit 统一由 Host 处理：

```text
file
→ 打开 Vault document

board
→ router.push({
    name: 'board-editor',
    params: { boardId },
  })
```

Board 不得通过 import `VaultView` 获得搜索能力。

---

# 24. NavBar

不要修改：

```
shared/scopeProtocol.ts
```

不要添加：

```
ScopeKey = board
```

因为：

```
ScopeKey
=
Vault content roots
```

而：

```
Board
=
Independent Workspace
```

Scope selection 与 Workspace navigation 是两个概念。NavBar 中：

```
Note / Diary
→ 选择 Vault Scope

Ledger / Board
→ 导航到 Workspace Route
```

Board 仍然不能进入 `ScopeKey`；不能把 `ScopeKey` 扩展为 `board` 来表达
Workspace identity。

当前：

```
Note
Diary
Ledger
```

的 Navbar 区域增加一个视觉一致的：

```
Board
```

route button。

逻辑上分成：

```
Note / Diary
→ Vault Scope

Ledger / Board
→ Workspace Route
```

Board 激活时：

```
只高亮 Board
```

不要因为 `activeScope = note` 而同时高亮 Note。

---

# 25. Board Home

`BoardHomeView.vue`：

```
Header
Search
Recent
All Boards
```

数据：

```
GET /api/board
```

该请求由轻量的 `Board Metadata Source` 负责，不由 Board Home 和 Global
Search 各自维护一份列表。Source 可以是 module-level cache、small reactive
source 或 feature-level metadata repository，不要求引入 Pinia 或新的大型
全局状态框架。它只保存当前 Board metadata，不加载 Scene 或 Asset bytes。

概念契约：

```ts
interface BoardMetadataSource {
  getSnapshot(): readonly BoardMetadata[]
  ensureLoaded(): Promise<void>
  refresh(): Promise<void>
  upsert(metadata: BoardMetadata): void
  remove(boardId: string): void
  invalidate(): void
}
```

具体接口名称可以调整，但生命周期必须固定：

```text
首次 Board Home 或 Search 需要 metadata
→ GET /api/board（并复用 in-flight request）
→ populate snapshot

POST /api/board success
→ upsert returned metadata

PATCH title success
→ update metadata in snapshot

DELETE board success
→ remove metadata from snapshot

recovery / uncertain state
→ invalidate
→ next access refetch
```

Board Home Gallery 与 `createBoardSearchProvider()` 必须读取同一个 snapshot。
因此 create、rename、delete 的成功结果会立即反映在两个消费者中；每次
Global Search query 只在内存 snapshot 上过滤标题，不得因为 query keystroke
执行 `GET /api/board`。

搜索：

```
client-side title filtering
```

这是 Board Home 内的本地列表过滤，不等于 Nuvyn Global Search。V1 不需要
为 Board Scene 建全文索引。

## Nuvyn Global Search

Board 必须接入现有 Search Provider 架构：

```
SearchProvider
SearchResultSection
searchEverywhere()
createLatestSearchRunner()
```

新增：

```
createBoardSearchProvider()
```

数据来源为共享 Board Metadata snapshot，V1 只搜索：

```
Board Title
```

明确不搜索：

```
Shape Text
Scene JSON
OCR
Assets
```

Search Result 类型增加 Board：

```ts
type SearchResultType =
  | ...
  | 'board'
```

Board Result 至少包含：

```ts
{
  id: `board:${board.id}`,
  type: 'board',
  title: board.title,
  subtitle: 'Board',
  payload: {
    boardId: board.id,
  },
}
```

`createBoardSearchProvider()` 每次调用只读取当前 metadata snapshot 并过滤
标题，不发起网络请求。Provider 注册到 App-level registry，由
`searchEverywhere()` 统一运行，并通过独立的 `Boards` Section 展示。
`GlobalSearchHost` 的 commit 逻辑必须区分：

```
file
→ 打开 Vault document

board
→ router.push({
    name: 'board-editor',
    params: { boardId },
  })
```

Global Search 中点击或提交 Board 结果必须能直接进入 Board Editor。

创建：

```
POST /api/board
   ↓
router.push('/board/{id}')
```

卡片 Context Menu：

```
Rename
Delete
```

---

# 26. Editor Loading State Machine

BoardEditorView：

```
idle
 ↓
loading
 ↓
hydrating
 ↓
ready
```

错误：

```
error
conflict
```

完整 Load：

```
GET Board
    ↓
Read engine
sceneVersion
revision
    ↓
migrateBoardScene()
    ↓
Validate BoardScene
    ↓
Load referenced Assets
    ↓
Load local Checkpoint
    ↓
Reconcile Checkpoint
    ↓
Adapter.deserialize()
    ↓
Mount ExcalidrawHost
    ↓
ready
    ↓
Enable Autosave
```

禁止：

```
先 mount empty Excalidraw
然后再 load Scene
```

---

# 27. Crash Checkpoint 存储选择

不要使用：

```
localStorage
```

Scene 可能很大，而且图片恢复还需要 Blob。

Board 使用：

```
IndexedDB
```

不增加第三方 dependency。

DB：

```
nuvyn-board-recovery
```

Object Stores：

```
checkpoints
pending-assets
```

---

# 28. Checkpoint

逻辑对象：

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

key：

```
boardId
```

---

# 29. Pending Asset Recovery

图片刚加入 Canvas 时，可能发生：

```
Image added
   ↓
Browser crashes
   ↓
Asset upload 还没完成
```

只保存 `BoardScene` 不够。

因此 IndexedDB 同时保存：

```ts
interface PendingBoardAsset {
  assetId: string
  boardId: string

  engineFileId: string

  mimeType: string

  blob: Blob

  createdAt: number
}
```

流程：

```
Excalidraw new BinaryFile
      ↓
Generate Nuvyn assetId
      ↓
Update engine fileMap
      ↓
Persist Pending Asset to IndexedDB
      ↓
Write Checkpoint
      ↓
Async Asset Upload
```

Asset Server upload 成功：

```
Pending Asset 可以删除
```

因为 binary 已经成为 Server Asset。

Pending Asset 生命周期：

```
Asset upload success
→ delete pending Blob

Asset upload failure
→ keep pending Blob

Asset upload success but Scene Save failure
→ pending Blob 可以删除
→ Server Asset 作为 orphan candidate 保留
→ 允许稍后重试 Scene reference save

Server Board Delete success
→ delete 该 boardId 的全部 pending-assets

Server Board Delete failure
→ 保留 checkpoint 和 pending-assets
```

本地 Recovery 清理必须以 Server 操作成功为前提，不能因本地预期的删除
结果提前丢失可恢复数据。

---

# 30. Recovery Asset Resolution

打开 Board：

```
for each assetRef
    ↓
try Server Asset
```

如果 Server Asset 不存在，但：

```
IndexedDB pending asset exists
```

则：

```
re-upload
```

之后继续 Recovery。

如果：

```
Server missing
AND
Local pending missing
```

则：

```
Fail Closed
```

不能删除 Image Element 后继续打开。

---

# 31. Save Coordinator

不要把 Save 逻辑塞进：

```
BoardEditorView.vue
```

建立：

```
saveCoordinator.ts
```

内部状态：

```text
currentServerRevision
localRevision

latestRuntimeSceneRef
latestSceneSnapshot
dirty

saveInFlight
conflict
lastSavedLocalRevision
```

---

# 32. Save Coalescing

不需要保存每一个 localRevision。

例如：

```
Revision 21
Revision 22
Revision 23
Revision 24
```

发生在一个 Save 请求期间。

完成当前 Save 后：

```
直接保存最新 24
```

不需要：

```
22
23
24
```

逐个写库。

即：

```
queue ordering
+
latest snapshot coalescing
```

---

# 33. Save Algorithm

Excalidraw `onChange` 只更新最新运行时引用和 revision，并安排两个相互
独立的 scheduler：

```
Excalidraw onChange
        ↓
latestRuntimeSceneRef = latest runtime scene
localRevision++
dirty = true
        │
        ├── Checkpoint Scheduler
        │      trailing 250ms debounce
        │
        └── Server Save Scheduler
               trailing 800ms debounce
```

`onChange` 不得直接执行完整的 `Adapter.serialize()` 和 IndexedDB write。
Checkpoint Scheduler 触发时才 capture 当前最新 Scene 与 `localRevision`，
Server Save Scheduler 同样只提交捕获到的最新 snapshot；两个 scheduler 都
必须允许在一次写入期间继续累积新的 change。

Checkpoint Scheduler：

```
timer fires
    ↓
capture latest runtime scene + localRevision
    ↓
Adapter.serialize()
    ↓
write one coalesced checkpoint
```

如果 checkpoint 写入过程中产生新的 Scene Change：

```
旧 checkpoint 完成
        ↓
发现 localRevision 已更新
        ↓
再次安排最新 revision 的 checkpoint
```

旧 snapshot 不能被当作当前最新状态。安全性来自编辑过程中的持续
coalesced checkpoint，而不是 `beforeunload` 时的异步 IndexedDB write。

Checkpoint debounce 固定为：

```
250ms trailing
```

Server Save debounce 固定为：

```
800ms
```

Checkpoint 比 Server Save 更积极，但绝不按每个 pointer event 写盘。

---

## Save execution

```
capture:
  scene
  localRevision
  currentServerRevision

      ↓

ensure pending assets persisted

      ↓

PUT scene
expectedRevision = currentServerRevision

      ↓

success

      ↓

currentServerRevision = response.revision
```

---

# 34. Checkpoint Advance

假设：

```
save localRevision = 10
```

保存过程中用户继续编辑：

```
localRevision = 11
```

Server 10 成功后：

```
不能删除整个 Checkpoint
```

应该：

```
baseRevision = returned server revision

keep localRevision = 11
keep latest local Scene
rewrite checkpoint
```

如果旧 checkpoint write 或旧 Server Save 完成时已经有更高
`localRevision`，必须继续安排最新 revision；旧 completion 不能清掉或覆盖
更新后的 checkpoint。

只有：

```
lastSavedLocalRevision
==
current localRevision
```

才清理 Checkpoint。

---

# 35. Conflict State

收到：

```
409 BOARD_SCENE_CONFLICT
```

之后：

```
STOP automatic scene saves
```

不能自动不停重试。

状态：

```
conflict
```

保存：

```
local Scene
Checkpoint
```

V1 不自动 merge。

Recovery UI 至少：

```
Server changed elsewhere.

Reload server version
Keep local recovery copy
```

如果选择 reload：

```
明确确认后
清理 local checkpoint
重新 load Server Scene
```

绝对不能 silent overwrite。

---

# 36. Route Leave

Vue Router：

```ts
onBeforeRouteLeave
```

执行：

```ts
await saveCoordinator.flush()
```

结果：

### success

```
leave
```

### failure / conflict

显示确认：

```
Changes could not be saved to the server.
A local recovery copy is available.

Stay
Leave Anyway
```

如果：

```
Leave Anyway
```

Checkpoint 必须保留。

---

# 37. beforeunload

不把网络 Save 寄托于：

```
beforeunload
```

只做：

```
Best Effort
```

核心安全依赖：

```
250ms trailing、coalesced IndexedDB Checkpoint
```

---

# 38. Image Asset Pipeline

用户插入图片：

```
Excalidraw file
    ↓
Adapter detects new engineFileId
    ↓
Generate Nuvyn assetId
    ↓
fileMap[engineFileId] = assetId
    ↓
IndexedDB pending asset
    ↓
Asset upload
    ↓
Server asset committed
    ↓
Scene may save assetRef
```

Scene Save 前：

```ts
await ensureAssetsReady(assetRefs)
```

任一失败：

```
Scene 不发送
Save failed
Checkpoint 保留
```

---

# 39. Theme

BoardEditor：

```ts
useTheme()
```

把：

```
light / dark
```

作为 React Island prop。

Theme 改变：

```
rerender React Root props
```

不能修改：

```
BoardScene.theme
```

Canvas background：

```
viewBackgroundColor
```

---

# 40. Shortcut Boundary

React Island active：

```
Ctrl/Cmd+Z
Ctrl/Cmd+C
Ctrl/Cmd+V
Ctrl/Cmd+A
Delete
Backspace
Space
```

由 Excalidraw 优先处理。

Nuvyn global shortcut：

```
如果 event target 在
input
textarea
contenteditable
Excalidraw root
```

不能抢事件。

重点增加自动测试：

```
Excalidraw text editing
不会触发 Nuvyn shortcut
```

---

# 41. Export

Editor Menu：

```
Export PNG
Export SVG
Delete
```

Export：

```
BoardEngineAdapter
```

完成。

不经过 Server。

文件名：

```
{sanitized-board-title}.png
{sanitized-board-title}.svg
```

---

# 42. Thumbnail Scheduler

新增：

```
thumbnailScheduler.ts
```

触发：

```
Scene server save success
```

而不是：

```
onChange
```

采用：

```
3000ms debounce
```

如果浏览器支持：

```
requestIdleCallback
```

可以在 debounce 后进一步 idle 执行。

没有则直接执行。

---

# 43. Implementation Slices

整个 V1 不建议一次性编码完成。

按以下 Slice 实现。

---

## B0 — Compatibility Spike

目标：

```
证明 Vue + React Island + Excalidraw 可构建
```

改动：

```
package.json
package-lock.json

最小 React Island spike
```

验证：

```
npm run typecheck
npm run build
```

必须证明：

```
Board Home chunk 不包含 Excalidraw
Board Editor 才加载 React / Excalidraw
```

完成后删除临时 Spike UI，只留下确认后的正式集成基础。

建议 commit：

```
chore(board): validate excalidraw react island
```

---

## B1 — Storage Foundation

实现：

```
0030_asset_foundation.sql
0031_board_foundation.sql

shared/assetProtocol.ts
shared/boardProtocol.ts

server/assets/*
server/board/repository.ts
server/board/service.ts
```

本 Slice 同时冻结 Asset Storage 的物理安全与补偿规则：

```
初始化并校验 data/assets 普通目录（拒绝 symlink）
验证 UUID assetId 后才生成 storage path
Server-side hard byte limit，超限返回 413 ASSET_TOO_LARGE
allow-list MIME，并明确 magic-byte validation 策略
durable binary + SQLite metadata 的双阶段补偿
same assetId retry 的 metadata / binary / hash 校验
atomic claim-unreferenced-asset metadata deletion primitive
concurrent-safe asset cleanup semantics
server-side assetRefs shape / UUID validation and deduplication
server-injected owner_type / owner_id / purpose semantics
```

完成：

```
Asset persistence
Board CRUD storage
Scene revision CAS
```

测试：

```
migration
repository
asset durable write
revision conflict
asset directory initialization and path traversal rejection
oversized upload and MIME validation
binary / metadata failure compensation
same assetId idempotent retry and hash conflict
asset cleanup metadata claim race
assetRefs normalization and trust-boundary validation
```

建议 commit：

```
feat(board): add storage foundation
```

---

## B2 — Board HTTP API

实现：

```
server/board/routes/*
server/assets/routes.ts
server/index.ts
```

完成：

```
GET boards
POST board
GET board
PATCH title
PUT scene
PUT thumbnail
DELETE board
PUT asset
GET asset
```

测试：

```
auth protected
404
validation
409 revision conflict
missing asset
idempotent asset upload
asset reference replacement and post-commit atomic cleanup claim
cleanup failure leaves orphan without rolling back saved data
concurrent reference insertion cannot create dangling reference
routes cannot control owner_type or purpose
```

建议 commit：

```
feat(board): add board and asset APIs
```

---

## B3 — Gallery Home + Workspace Navigation + Global Search Host

实现：

```
BoardHomeView.vue
BoardCard.vue
BoardGallery.vue
src/features/board/api.ts
src/features/board/boardMetadataSource.ts

router
App.vue
NavBar.vue
src/components/search/GlobalSearchHost.vue
i18n
```

完成：

```
Board nav
Recent
All Boards
Search
Create
Rename
Delete
WorkspaceKind-aware App Shell / NavBar
App-level GlobalSearchHost mounted once outside VaultView
Document Search provider extraction / migration from CommandPalette
Shared Board Metadata Source for Gallery and Search
BoardSearchProvider without per-keystroke fetch
Board title appears in Nuvyn Global Search
Global Search can navigate directly to Board Editor
```

不得：

```
修改 FileTree.vue
把 Board 加到 ScopeKey
```

Board Home 的列表搜索仍然是 client-side title filtering；Global Search 则
必须通过 App-level `GlobalSearchHost`、共享 metadata source、
`createBoardSearchProvider()`、独立 `Boards` Section 和 `board` result type
接入现有搜索架构。Board Home 不能以 `isVault = true` 伪装 Workspace
identity，Vault-only controls 不能在 Board 上显示。

建议 commit：

```
feat(board): add gallery workspace
```

---

## B4 — Canvas Engine / React Island

实现：

```
BoardEngineAdapter
Excalidraw adapter
React Island
Error Boundary
ExcalidrawHost
BoardEditorView
BoardEditorHeader
```

此 Slice 只要求：

```
Load empty Board
Draw
Serialize
Basic theme
```

Empty Board 必须从
`{ elements: [], fileMap: {} }` 初始化，不得从 `null` 初始化。React
Island dynamic import 使用项目 alias；无 alias 时使用
`../../features/board/engine/excalidraw/reactIsland`。

暂时可以手动触发 Save。

目的：

```
先证明 Engine Boundary
```

再做复杂 Autosave。

建议 commit：

```
feat(board): integrate excalidraw editor
```

---

## B5 — Autosave + Revision

实现：

```
saveCoordinator.ts
debounce
coalescing queue
expectedRevision
save status
flush
route leave
conflict state
```

Server Save 使用 800ms trailing debounce；Checkpoint Scheduler 在 B6 实现，
使用独立的 250ms trailing debounce，不能把完整 IndexedDB write 放在每次
Excalidraw `onChange` 中。

重点测试：

```
changes during save
old response
conflict
flush latest revision
save failure
```

建议 commit：

```
feat(board): add revision-safe autosave
```

---

## B6 — Crash Recovery

实现：

```
IndexedDB checkpoint
checkpoint reconciliation
pending asset store
recovery UI
fail closed
checkpoint trailing coalescing scheduler
delete success 后清理 board checkpoint 与 pending-assets
```

测试：

```
newer checkpoint
older checkpoint
server ahead
damaged checkpoint
refresh during unsaved work
checkpoint writes are coalesced and latest revision wins
server delete failure preserves local recovery data
```

建议 commit：

```
feat(board): add crash recovery
```

---

## B7 — Image Assets

实现：

```
Excalidraw BinaryFiles
fileMap
asset upload
asset reload
pending asset recovery
asset reference transaction
```

Scene / Thumbnail 引用替换成功提交后，对已知移除引用执行统一的原子
metadata deletion claim；只有 claim 成功才删除 physical binary。cleanup
失败只留下 orphan，不回滚成功保存。Pending Asset 按 upload success、upload
failure、Scene save failure 和 Board delete success 分别执行对应清理规则。

测试：

```
insert image
save
refresh
image survives

asset upload failure
scene not committed

missing referenced asset
fail closed
removed scene / thumbnail asset cleanup uses metadata claim
cleanup failure does not roll back Scene / Thumbnail save
concurrent reference insertion cannot produce dangling reference
```

建议 commit：

```
feat(board): persist canvas assets
```

---

## B8 — Thumbnail / Export / Polish

实现：

```
Thumbnail Scheduler
PNG Export
SVG Export
Dark Mode polish
keyboard ownership
loading/error surfaces
```

建议 commit：

```
feat(board): complete v1 editor experience
```

---

## B9 — E2E Closure

增加真实浏览器测试：

```
Create Board
Draw
Wait Saved
Reload
Scene restored

Rename
Return Gallery
Title updated

Insert image
Reload
Image restored

Dark mode
Export
Delete

Global Search
Board result
Open Board Editor
```

同时运行：

```
npm run typecheck
npm run test
npm run build
npm run test:e2e
```

如果项目完整 E2E 太重，至少新增：

```
Board-specific Playwright suite
```

建议 commit：

```
test(board): close v1 lifecycle
```

---

# 44. Unit Test Matrix

至少覆盖：

## Domain

```
BoardScene validation
sceneVersion migration
persistentAppState normalization
fileMap ↔ assetRefs consistency
Canonical Empty Scene uses { elements: [], fileMap: {} }
BoardMetadata uses thumbnailAssetId: string | null
```

## Save Coordinator

```
single save
debounced save
save coalescing
edit while saving
save failure
revision conflict
flush
checkpoint scheduler does not write on every onChange
checkpoint scheduler latest revision wins
```

## Search and App Shell

```
createBoardSearchProvider searches title only
Board result uses type = board and board:<id> result id
Boards SearchResultSection is registered in searchEverywhere()
GlobalSearchHost mounts once at App level, outside VaultView
NavBar opens the App-level Search Host from Vault, Ledger and Board Home
Document provider remains available after CommandPalette migration
Board provider reads shared metadata snapshot
Board create / rename / delete update the shared metadata snapshot
Board Search does not fetch /api/board per query keystroke
GlobalSearchHost board result navigates to board-editor
GlobalSearchHost document result continues opening Vault document
Vault route can find and open a document
Board Home can find and open a Board
Ledger route can open the same Search Host
Board uses workspaceKind = board, never isVault = true
Vault-only controls are hidden on Board Home
Board Editor hides Global NavBar
```

## Checkpoint

```
create
advance
clear
server ahead
corrupt checkpoint
pending asset
delete Board clears checkpoint and pending-assets only after server success
```

## Server

```
create
list ordering
rename
delete
revision increment
expectedRevision conflict
missing asset rejection
assetRefs non-array rejection
invalid assetRef UUID rejection
duplicate assetRefs are normalized before persistence
missing Asset metadata rejection
missing Asset binary rejection
client cannot control owner_type, owner_id or purpose
asset ref replacement
thumbnail does not update updatedAt
create Board stores non-null canonical empty engine data
Board delete failure preserves local recovery data
```

## Asset

```
durable create
same ID same hash retry
same ID different hash conflict
missing physical file
unreferenced cleanup uses atomic metadata claim
failed metadata claim does not delete binary
successful metadata claim permits binary deletion
binary deletion failure leaves an orphan without restoring metadata
concurrent reference insertion cannot create dangling reference
two cleanup workers have one deletion owner
asset directory initialization and symlink rejection
assetId path validation
hard byte limit
allow-list MIME and magic-byte mismatch handling
binary / metadata compensation
```

---

# 45. Integration Tests

特别增加：

```
两个客户端读取 revision 3

Client A save
→ revision 4

Client B expectedRevision 3
→ 409
```

必须证明：

```
B 无法覆盖 A
```

Asset cleanup 并发也必须覆盖：

```text
Asset X 无引用

Cleanup A 与 Save B 同时处理 X
→ B 先建立 reference：Cleanup A 的 metadata claim 失败，X 保留
或
→ Cleanup A 先 claim metadata：B 的 reference insert 失败，Scene 不提交
```

以及：

```text
Cleanup A 与 Cleanup B 同时处理 X
→ 至多一个 DELETE FROM assets 成功
→ 只有该 worker 可以尝试删除 physical binary
```

---

# 46. Data Safety Tests

这是 Board V1 最重要的一组测试。

必须模拟：

```
Load Scene parse failure
Migration failure
Asset missing
Checkpoint corrupt
Asset upload failure
Scene save failure
Thumbnail failure
Route leave during debounce
Browser reload before autosave
Board delete success clears local recovery data
Board delete failure preserves local recovery data
```

每个测试都验证：

```
旧 Server Scene 没有被 Empty Scene 覆盖
```

---

# 47. Performance Gate

V1 不需要 Benchmark Framework。

但必须手动/自动确认：

```
拖动 Shape
→ 不产生连续 HTTP Save

拖动 Shape
→ 不产生每个 onChange 一次的完整 IndexedDB write

onChange
→ 不更新 App global reactive state

Board Home
→ 不加载 Excalidraw chunk

Thumbnail
→ 不在 Pointer Move 过程中生成

Global Search query keystroke
→ 不触发 GET /api/board
```

---

# 48. Files Explicitly Not To Reuse

不要复用或改造成 Board：

```
src/components/vault/FileTree.vue
src/composables/vault/useScopeFilter.ts
Vault document lifecycle
Note draft domain
Diary namespace
Ledger Store
```

可以复用：

```
authFetch
useTheme
useToast
useConfirm
usePrompt
router auth guards
SQLite migration runner
durable file utilities
Naive UI foundation
App Shell
```

---

# 49. Implementation Decisions Already Closed

Implementation 时不要重新讨论：

```
Board 是否独立 Workspace
→ Yes

Workspace identity 是否通过 isVault 表示
→ No；使用 WorkspaceKind

Board 是否加入 ScopeKey
→ No

Excalidraw 是否采用
→ Yes

Board Home 是否 FileTree
→ No

V1 是否 Folder
→ No

是否 React Island
→ Yes

是否自动保存
→ Yes

是否 Scene Revision
→ Yes

是否 Crash Checkpoint
→ Yes

是否 Nuvyn Asset 为 binary Source of Truth
→ Yes

Thumbnail Domain 字段
→ thumbnailAssetId，仅保存 Asset ID

Global Search 是否支持 Board Title
→ Yes；接入现有 SearchProvider

Global Search Host ownership
→ App-level；不属于 VaultView，且只挂载一个 Host

Board Search metadata source
→ Board Home 与 Search Provider 共用轻量 snapshot；query 不发请求

Asset eager cleanup ownership
→ 先原子 claim Asset metadata，再删除 physical binary；宁可 orphan，不得 dangling

Server assetRefs trust boundary
→ Server 验证 shape / UUID / existence / binary、去重；owner_type / owner_id / purpose 由 Board Service 注入

Empty Excalidraw Scene
→ { elements: [], fileMap: {} }，不使用 null

Checkpoint 是否每次 onChange 完整写入
→ No；250ms trailing coalescing scheduler
```

---

# 50. Implementation Plan 仍允许自行决定的事项

下面属于 implementation detail，可以在编码阶段根据实际 API 调整：

```
Excalidraw 当前版本的具体 API 名称

Persistent AppState 精确字段转换

Thumbnail export 参数

Board Card 精确尺寸

Recent 响应式显示数量

具体 Error UI 文案

Asset / Scene JSON 最终 size limit

requestIdleCallback fallback 细节

magic-byte validation 的具体检测实现

GlobalSearchContext 或 AppShellContext 的具体实现

BoardMetadataSource 的具体 reactive / cache 形态

GlobalSearchHost / CommandPalette 的最终文件命名

tryClaimUnreferencedAssetForDeletion 的具体函数名
```

但不得改变已经冻结的领域边界。

---

# 51. Definition of Done

Board V1 只有满足以下条件才能关闭：

```
[ ] /board 是独立 Gallery Home

[ ] Board 使用 workspaceKind = board，不伪装成 Vault

[ ] Board 不加入 ScopeKey

[ ] 不依赖 FileTree

[ ] /board/:id 使用隔离 React Island

[ ] Board Home 不加载 React / Excalidraw

[ ] Board Home 不显示 Vault-only controls

[ ] Board Editor 不显示 Global NavBar

[ ] 创建 Board 无 Modal

[ ] Draw 正常

[ ] Text / Shape / Arrow / Free Draw 正常

[ ] Image 可以插入并持久化

[ ] Autosave 有真实 Saved 状态

[ ] 高频 drag 不持续请求 Server

[ ] 高频 onChange 不产生逐事件完整 IndexedDB write

[ ] Server revision 单调递增

[ ] stale expectedRevision 返回 Conflict

[ ] Crash Checkpoint 可以恢复

[ ] Missing Asset Fail Closed

[ ] Empty Scene 无法覆盖损坏/加载失败的数据

[ ] 新建 Board 持久化 { elements: [], fileMap: {} }，不写入 null

[ ] Refresh 恢复 Scene

[ ] Viewport 恢复

[ ] Theme 跟随 Nuvyn

[ ] Canvas Background 独立保存

[ ] Thumbnail 正常生成

[ ] Thumbnail failure 不影响 Scene Saved

[ ] Thumbnail 与 Scene 移除引用在提交后执行 eager cleanup

[ ] Asset cleanup 先原子 claim metadata，再删除 physical binary

[ ] 并发 reference insertion 无法提交 dangling asset reference

[ ] 两个 cleanup worker 至多一个获得 Asset deletion ownership

[ ] Cleanup failure 不回滚成功的保存

[ ] PNG Export

[ ] SVG Export

[ ] Rename

[ ] Delete + Confirm

[ ] Search Title

[ ] Nuvyn Global Search 可以找到 Board Title

[ ] Global Search Board result 可以直接进入 Board Editor

[ ] GlobalSearchHost 在 App-level 挂载且不属于 VaultView

[ ] Vault / Ledger / Board Home 都能打开同一个 Global Search Host

[ ] Board Home 与 Board Search 共用 metadata source

[ ] Board Search 不在每次 query 时 GET /api/board

[ ] Document Search provider 在 Host 迁移后不回归

[ ] Server 独立验证并 deduplicate assetRefs

[ ] Server 拒绝不存在或 binary 不可读的 Asset reference

[ ] Browser 无法控制 asset_references.owner_type / owner_id / purpose

[ ] Server 删除成功后清理对应 checkpoint 与 pending-assets

[ ] Server 删除失败时保留对应本地 Recovery 数据

[ ] CI typecheck / unit / integration / build 通过

[ ] Board lifecycle E2E 通过
```

---

# 52. 实施顺序

严格按照：

```
B0 Compatibility
        ↓
B1 Storage
        ↓
B2 HTTP API
        ↓
B3 Gallery
        ↓
B4 Canvas
        ↓
B5 Autosave
        ↓
B6 Recovery
        ↓
B7 Assets
        ↓
B8 Polish
        ↓
B9 Closure
```

不要：

```
一口气实现整个 Board V1
```

每一个 Slice：

```
实现
→ Test
→ Build
→ Review
→ Commit
→ 再进入下一 Slice
```

这样如果 Excalidraw、Asset 或 Recovery 某一层出现问题，不会把整个 Board 功能一起拖进不可审查的大提交。

本轮收口后 Implementation Plan 冻结。只有 B0 Compatibility Spike 发现真实的
Excalidraw API 或 bundling blocker 时，才允许针对该 blocker 重新打开相关
决策；不得借此扩大 Board V1 Scope。
