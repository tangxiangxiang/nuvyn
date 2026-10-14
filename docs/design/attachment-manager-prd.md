# PRD — Nuvyn 全局附件管理

**产品：** Nuvyn\
**模块：** Attachment Manager\
**版本：** V1.0\
**状态：** DRAFT — Phase 1–3 的受控能力已实现；完整 V1 仍待评审，清理保持只读\
**优先级：** P1\
**日期：** 2026-10-12

---

## Implementation status — 2026-10-12

Phase 1 now provides a read-only catalog for Board Assets, visible Vault attachment files, and Board Materials. The catalog is built from the existing stores; it does not copy or move resource data and does not add a second source of truth.

- Authenticated APIs provide stable server-side search, filters, pagination, summary statistics, index status, and explicit refresh.
- The Vault adapter uses a bounded in-memory snapshot, reads file metadata only, skips Markdown documents, hidden and temporary entries, symlinks, and the entire managed `diary/` subtree.
- Board Asset references use the existing `asset_references` table. A zero count is displayed as unknown, not as proof of an unused or deletable resource. Vault file and Board Material references also remain unknown.
- Settings includes a wide Attachment Manager surface with a real list, summary, filters, pagination, metadata details, and copyable logical identity. There are no upload, delete, move, or rename controls.
+ Rich previews, uploads, insertion, audited cleanup, and cross-module reuse remain future work; they are not represented as completed capabilities.

Phase 2 adds a rebuildable, bounded in-memory reference projection for current non-Diary Notes and live Board Asset relations. It understands the existing Markdown image, snippet, Include, and `board:<id>` semantics, distinguishes direct from Include/Board-mediated use, and exposes authenticated paginated reference queries plus a read-only cleanup-risk preflight. Reference navigation uses the existing Note and Board routes. No cleanup permission or mutation endpoint is provided.

Coverage remains intentionally incomplete: protected Diary bodies are never scanned; Git history, browser drafts, unsaved editor buffers, Board checkpoints, and changes made externally after a scan are not verified. Board Material usage remains unknown. A zero current-reference result is therefore not a deletion-safety conclusion. The reference projection is lazy and does not block Phase 1 catalog loading.

The PRD remains marked DRAFT because the broader V1 product scope includes later-phase capabilities that have not been implemented or reviewed yet.

---

## 1. 产品定义

Attachment Manager（全局附件管理）是 Nuvyn 内置的统一资源管理功能。

它用于帮助用户回答以下问题：

- 我在 Nuvyn 中保存了哪些附件？
- 这些附件占用了多少存储空间？
- 哪些附件被哪些笔记或画布使用？
- 是否存在未被当前内容引用的附件？
- 如何在不破坏现有文档的前提下管理这些资源？

Attachment Manager 不是新的 Workspace，也不是独立网盘。

它属于 Nuvyn 的基础设施管理能力，负责跨 Workspace 查看、检索、预览和追踪资源。

Nuvyn 各 Workspace 的职责保持不变：

- **Note**：知识与文档
- **Diary**：个人经历与记录
- **Board**：视觉表达与画布
- **Ledger**：个人财务
- **Attachment Manager**：资源管理与可追溯性

核心原则：

**资源在哪里使用，由 Workspace 决定；资源在哪里管理，由 Attachment Manager 统一提供入口。**

---

## 2. 背景与现状

### 2.1 现有资源已经分散在不同模块

Nuvyn 当前具有多种资源存储机制。

**Board Asset**

- 已有 `assets` 数据表。
- 已有 `asset_references` 引用表。
- 二进制文件存放在 Nuvyn Data Directory 下的 `assets` 目录。
- 资源使用 UUID 标识。
- 已支持图片上传、读取、引用关联和受控清理。
- 资源元数据包含 MIME、大小、SHA-256 和创建时间。
- 现有 Asset 不一定保留原始文件名。

**Vault 本地资源**

- 已支持 Markdown 中的本地图片、代码片段和 Markdown Include 等资源引用。
- 资源通过 Vault 相对路径定位。
- 已有路径验证、安全读取和资源大小限制。
- 资源并不统一登记在 `assets` 表中。
- 当前缺少全局资源目录和使用情况查看能力。

**Board Materials**

- 已有自定义 SVG 素材管理。
- 素材内容保存在 `board_materials` 中。
- 具有独立的命名、归档与删除语义。
- 不等同于 Board 画布的图片 Asset。

**其他资源**

Diary、Ledger 等模块也可能持有各自的资源或配置，但部分资源受到专门的数据安全与生命周期规则约束。

### 2.2 当前问题

现有资源功能服务于具体业务场景，但用户缺少统一的管理视角。

主要问题：

1. 不容易了解 Nuvyn 保存了多少资源。
2. 无法统一查看资源的实际存储占用。
3. 很难根据文件名找到过去保存的附件。
4. 难以确定一个资源被哪些内容使用。
5. 资源不再被当前内容引用后，缺少可见的检查入口。
6. 无法清晰区分可以清理的资源和需要保留的资源。

随着 Note 和 Board 的使用量增加，这些问题会更加明显。

---

## 3. 产品目标

### 3.1 V1 核心目标

建立可靠的全局资源目录，使用户能够：

1. 查看已纳入管理范围的附件。
2. 查看资源类型、大小、来源和基本元数据。
3. 按类型、来源、引用状态进行筛选。
4. 根据名称、路径搜索资源。
5. 安全预览支持的资源。
6. 查看资源的已知直接引用关系。
7. 从引用关系跳转至对应 Note 或 Board。
8. 查看当前未发现引用、需要进一步检查的资源。
9. 了解资源索引是否完整、是否需要刷新。

### 3.2 长期目标

逐步实现：

- 跨 Workspace 的统一附件上传。
- 从资源中心向 Note 和 Board 插入附件。
- 更可靠的历史引用追踪。
- 附件重复检测。
- 可审计的安全清理。
- 存储空间分析。
- 受安全边界约束的 Diary 资源管理。

### 3.3 成功标准

V1 成功不以删除了多少附件衡量。

而以以下能力衡量：

**用户可以快速找到一个附件，知道它来自哪里、当前有哪些已知引用，以及哪些信息还无法确认。**

---

## 4. 非目标

V1 明确不包含：

1. 新建第五个顶级 Workspace。
2. 独立网盘或通用文件管理器。
3. 新的文件夹组织系统。
4. 统一附件上传。
5. 拖放上传。
6. 从附件管理器直接插入 Note 或 Board。
7. 附件内容编辑。
8. 附件重命名、移动。
9. 批量永久删除。
10. 自动垃圾回收。
11. 自动 SHA-256 去重。
12. 自动迁移旧资源至新存储结构。
13. 资源跨设备云同步。
14. 历史版本资源的完整引用解析。
15. 对加密 Diary 的全局附件扫描。
16. 新增独立的附件权限系统。

V1 是**只读资源管理中心**，不是新的资源写入层。

---

## 5. 产品入口与信息架构

### 5.1 入口位置

推荐：

**设置 → 存储与附件 → 附件管理**

不在顶级导航增加 Attachment Workspace。

理由：

- 附件管理不属于高频写作行为。
- 不需要长期占用主导航。
- 属于系统级存储管理。
- 与 Nuvyn 的简洁界面设计保持一致。

### 5.2 展示形式

附件管理采用独立的大尺寸管理页面，而不是直接嵌入狭窄的设置内容区。

从设置进入附件管理后：

- 主界面提供足够空间展示附件列表。
- 支持返回原设置位置。
- 保留现有 Nuvyn 主题风格。
- 不干扰已打开的 Note、Diary、Board 标签页。
- 不触发正在编辑文档的重新挂载。

具体采用独立路由还是全屏管理层，由实现方案阶段确定。

### 5.3 页面结构

页面由四部分组成：

**顶部**

- 页面标题：附件管理
- 返回入口
- 刷新资源目录入口

**统计区域**

- 资源总数
- 已统计的存储占用
- 当前引用状态待检查数量

**工具区域**

- 搜索框
- 资源类型筛选
- 来源筛选
- 引用状态筛选
- 排序选项

**内容区域**

- 附件列表
- 资源详情
- 预览
- 引用位置

V1 默认采用列表视图。

暂不要求网格与列表切换。

---

## 6. 资源范围

### 6.1 V1 纳入范围

| 资源类型                 | 纳入 V1 | 说明               |
| -------------------- | ----- | ---------------- |
| Board 图片 Asset       | 是     | 使用现有 Asset 元数据   |
| Vault 本地图片           | 是     | 读取允许的 Vault 相对路径 |
| Vault 本地代码、文本资源      | 是     | 作为资源文件展示         |
| Vault 中的普通 PDF 等附件文件 | 条件纳入  | 可列入目录，预览能力另行限制   |
| Board SVG Materials  | 是     | 独立资源类型           |
| Board 缩略图对应 Asset    | 是     | 通过现有引用关系展示       |
| 加密 Diary 私有资源        | 否     | 不突破现有安全边界        |
| Ledger 专用图标          | 否     | 后续通过独立适配器接入      |
| 系统内置图标与静态资源          | 否     | 不属于用户附件          |
| Markdown 主文档本身       | 否     | Note 不是附件        |

### 6.2 Vault 文件判定

V1 不应将整个 Vault 中的所有文件都当成附件。

应通过明确的受支持资源类型白名单识别用户资源。

要求：

- 普通 Markdown 主文档不作为附件重复统计。
- Markdown Include 的目标文档可作为引用依赖记录，但不能因此重复成为普通附件。
- 系统配置、内部元数据、临时文件不纳入。
- 不跟随文件系统符号链接越过 Vault 根目录。
- 隐藏目录和 Nuvyn 内部目录遵循现有隔离规则。
- 无法安全判定的文件不自动纳入可预览范围。

资源枚举不得放宽现有路径安全约束。

### 6.3 统一管理不等于统一物理存储

V1 不迁移现有文件。

继续保留：

- Board Asset 的 UUID 与二进制存储。
- Vault 资源的路径身份。
- Board Material 的独立数据表。

Attachment Manager 只建立统一管理视图。

---

## 7. 资源身份与数据模型

### 7.1 统一资源身份

每个资源必须具有一个无歧义的管理身份。

建议区分三类：

- `asset`：UUID 标识的 Board Asset。
- `vault-file`：Vault 相对路径标识的本地文件。
- `board-material`：素材 ID 标识的 Board SVG Material。

不同类型即使具有相同名称或相同 SHA-256，也不能默认视为同一个资源。

### 7.2 资源展示模型

每条资源至少支持以下字段：

| 字段                 | 说明              |
| ------------------ | --------------- |
| Resource Key       | 稳定且带类型命名空间的资源标识 |
| Display Name       | 显示名称            |
| Resource Type      | 图片、文件、素材等       |
| MIME Type          | 可确认时返回          |
| Byte Size          | 可确认时返回          |
| Source Kind        | 来源存储类型          |
| Location           | 逻辑路径或资源 ID      |
| Created At         | 有可靠来源时提供        |
| Modified At        | 有可靠来源时提供        |
| Reference Status   | 引用状态            |
| Preview Available  | 是否允许预览          |
| Download Available | 是否允许下载          |
| Indexed At         | 最近完成索引的时间或快照信息  |

### 7.3 缺失元数据

不得伪造元数据。

例如：

- 旧 Board Asset 没有原始文件名，则显示“未命名图片”及可区分的短 ID。
- 无法确认创建时间，则显示“未知”。
- 文件系统修改时间不能冒充上传时间。
- 无法计算文件大小时，不得显示为 0 KB。
- SHA-256 不要求对所有 Vault 文件立即计算。

---

## 8. 附件列表

### 8.1 默认展示

每条资源展示：

- 文件图标或缩略图
- 显示名称
- 类型
- 文件大小
- 来源
- 引用状态

桌面端采用信息密度适中的列表。

不要默认显示完整 UUID、完整 SHA-256 或过长路径。

### 8.2 排序

V1 支持：

- 名称
- 大小
- 时间（仅当元数据可用）
- 来源类型

默认排序以稳定、可重复为原则。

排序键相同时，使用 Resource Key 保证确定性。

### 8.3 搜索

支持：

- 文件名搜索
- Vault 逻辑路径搜索
- Board Material 名称搜索
- 资源 ID 精确搜索

搜索应忽略常见的大小写差异。

对于没有文件名的资源，可通过资源类型、来源或 ID 查找。

### 8.4 筛选

支持以下维度：

**类型**

- 全部
- 图片
- 文件
- 素材

**来源**

- 全部
- Board Asset
- Vault 文件
- Board Material

**状态**

- 全部
- 已确认引用
- 当前未发现引用
- 引用状态未知

筛选结果必须与当前统计范围一致，不能暗示未纳入的资源已经被检查。

### 8.5 分页

列表必须支持服务端分页或游标查询。

不允许为了展示第一页而将全部二进制资源读取到浏览器。

---

## 9. 附件详情

点击资源后打开详情面板。

### 9.1 基本信息

展示：

- 名称
- 类型
- 文件大小
- 来源
- 逻辑位置
- 可用时间信息
- 引用情况

对于 Board Asset，可展示完整 UUID 和 SHA-256。

对于 Vault 文件，可展示经授权的 Vault 相对路径。

禁止暴露 NAS 绝对路径和服务器内部存储位置。

### 9.2 复制信息

支持：

- 复制资源 ID
- 复制 Vault 逻辑路径（适用时）

V1 不默认生成全新的公开分享链接。

### 9.3 下载

允许下载已有安全读取能力的资源。

要求：

- 使用现有认证机制。
- 不开放任意服务器路径下载。
- 下载失败必须明确反馈。
- 不修改文件内容。
- 不改变引用关系。

不支持安全下载的类型应禁用此操作。

---

## 10. 附件预览

### 10.1 图片

支持当前受信任图片类型的预览。

原则上包括：

- PNG
- JPEG
- WebP
- GIF
- AVIF
- 经安全处理的 SVG

预览尺寸适应容器，不拉伸变形。

### 10.2 代码与文本

在现有安全读取能力允许的情况下，支持只读文本预览。

要求：

- 限制文件大小。
- 不执行文件内容。
- 不自动加载外部依赖。
- 不提供编辑器保存能力。

### 10.3 PDF

V1 允许将符合资源目录规则的 PDF 识别为附件。

但不强制实现完整 PDF 在线阅读器。

如果没有安全、可靠的预览能力，则只显示文件信息并按权限提供下载。

### 10.4 不支持预览的文件

展示：

- 文件类型
- 文件大小
- 无法预览的说明
- 可用时的下载入口

不得因为不支持预览而从附件列表中静默移除有效资源。

### 10.5 内容安全

SVG、HTML 等主动内容不得直接以内联可执行方式渲染。

所有预览复用或加强现有 MIME、CSP、`nosniff` 和来源验证规则。

---

## 11. 引用关系管理

### 11.1 定义

引用关系表示：

**某个已知 Nuvyn 对象在当前可检查状态下依赖一个资源。**

引用对象可能包括：

- Note 文档
- Board Scene
- Board Thumbnail
- Markdown Include 的资源依赖

### 11.2 Board 引用

直接复用 `asset_references` 中已经存在的引用事实。

不再建立第二份 Board Asset 引用权威数据。

需要展示：

- 所属 Board
- 引用用途
- 可访问时的 Board 名称
- 跳转入口

### 11.3 Note 引用

对于 Markdown 资源，引用索引必须与现有 Markdown 资源解析语义一致。

需要识别：

- 本地图片
- 代码片段资源
- 被包含的 Markdown 文档所产生的资源依赖

不能仅使用普通正则扫描 Markdown 原文。

不能把代码围栏中的示例路径误认为真实引用。

对于 Include 链形成的间接依赖，应区分直接与间接引用。

### 11.4 Board Material

Board Material 是用户维护的素材库条目。

即使暂时无法确认哪个 Board 使用了该素材，也不能直接视为垃圾附件。

必须保留其素材库归属语义。

### 11.5 引用详情

用户点击一个附件时，可以查看：

- 当前已知引用数量
- 引用对象类型
- 引用对象名称
- 引用用途
- 跳转入口

当前版本无法定位到具体 Markdown 行号时，可以先跳转到所属文档。

不得伪造行号或锚点。

间接引用的主入口跳转到界面显示的所属 Note；当实际引用源是依赖链中可确认的另一篇 Note 时，提供单独的“查看引用源”入口。

---

## 12. 引用状态

V1 使用以下状态：

### 12.1 已确认引用

在当前可靠数据源中找到了至少一条有效引用。

展示：

**引用中**

### 12.2 当前未发现引用

本次已完成的索引范围内，没有找到直接引用。

展示：

**当前未发现引用**

此状态不代表永久删除安全。

### 12.3 引用状态未知

发生以下情况时使用：

- 索引尚未完成。
- 数据源访问失败。
- 扫描范围不完整。
- 引用解析失败。
- 受保护资源无法检查。
- 当前数据已失效且不能确认。

展示：

**待确认**

### 12.4 状态原则

任何情况下：

**当前未发现引用 ≠ 可以安全删除。**

索引状态也不能作为判断 Git 历史、未保存草稿或加密 Diary 中不存在引用的证明。

---

## 13. 存储空间统计

### 13.1 顶部统计

V1 显示：

- 已纳入范围的资源总数
- 已确认的资源存储字节总量
- 当前引用状态待检查数量

### 13.2 统计口径

- 同一个资源被多个对象引用时，物理空间只计一次。
- 不同资源即使 SHA-256 相同，也不自动合并统计身份。
- Board Material 的 SVG 存储字节应按实际存储内容计算。
- 缺失大小信息的资源单独标记，不按零字节计。
- 统计仅覆盖已纳入的资源来源。

### 13.3 部分统计

当某个资源来源不可用时：

- 保留已成功取得的结果。
- 显示统计不完整。
- 不将部分统计误称为 Nuvyn 全部存储占用。
- 提供刷新或重试入口。

附件占用也不等于整个 Nuvyn Data Directory 的占用。

SQLite、Git、Checkpoint、日志及备份等存储不应隐式算入附件大小。

---

## 14. 资源索引架构

### 14.1 统一 Catalog

Attachment Manager 使用统一资源目录聚合不同来源。

V1 至少需要：

- Board Asset Adapter
- Vault File Adapter
- Board Material Adapter

各 Adapter 只负责读取其有权访问的数据。

### 14.2 数据所有权

资源索引不是附件本体。

原则：

- 原始二进制继续由原有 Asset Storage 管理。
- Vault 文件继续由现有 Vault 文件系统管理。
- Board Material 继续由其领域模型管理。
- Attachment Manager 不成为第四套资源权威存储。

### 14.3 可重建索引

若实现需要持久化索引：

- 索引必须能够重建。
- 不能因为删除索引而删除附件。
- 不应将派生索引当成真实引用权威。
- 索引失败不得自动改写任何原始资源。

### 14.4 增量刷新

当以下操作发生时，相关索引应能够更新：

- Board Scene 保存
- Board 删除
- Board Thumbnail 更新
- Note 文档保存
- Note 文件重命名
- Vault 文件夹移动或重命名
- 外部修改 Vault 文件

允许使用局部失效与重新扫描。

对于不能即时感知的外部文件变化，至少提供主动刷新能力，并明确索引快照时间。

### 14.5 并发一致性

索引刷新期间：

- 旧请求不得覆盖新请求。
- 部分失败不得伪装成完整扫描。
- 刷新失败不得替换最后一次成功快照；保留的快照必须明确标为过期，当前引用结论和目录投影按未知处理。
- 路由离开后应能取消不必要的工作。
- 不能因索引任务导致编辑器保存明显阻塞。

---

## 15. API 边界

建议建立独立的管理 API。

V1 包含以下只读能力：

| API                                 | 用途            |
| ----------------------------------- | ------------- |
| `GET /api/attachments/summary`      | 资源统计          |
| `GET /api/attachments`              | 列表、筛选与分页      |
| `GET /api/attachments/index-status` | 索引状态          |
| 资源引用查询接口                            | 获取指定资源的已知引用关系 |
| 资源详情查询接口                            | 获取已授权的资源元数据   |

具体路径与请求协议在 Implementation Plan 中确定。

### 15.1 API 安全要求

- 复用现有认证机制。
- 不引入公开资源访问。
- 不接受文件系统绝对路径。
- 严格校验资源身份与资源类型。
- 不允许客户端直接指定任意服务器目录。
- 不允许通过通用附件 API 读取受保护 Diary 内容。
- 不暴露服务器目录布局、密钥或内部异常栈。

### 15.2 V1 不提供的 API

V1 不新增通用：

- 删除附件 API
- 移动附件 API
- 重命名附件 API
- 跨模块写入 API
- 任意文件上传 API

现有 Board 生命周期中的清理机制不因本功能而取消，但不得直接作为全局永久删除入口复用。

---

## 16. 删除与数据安全

### 16.1 V1 不开放永久删除

尽管长期目标包含安全清理，但第一版仅提供资源目录和状态检查。

不提供：

- 单项永久删除
- 批量删除
- 自动清理
- 一键清理未引用附件

### 16.2 暂不允许删除的原因

无法仅通过当前引用索引确认以下情况：

- Git 历史版本是否仍引用资源。
- 未保存 Monaco 缓冲区是否引用资源。
- Board Checkpoint 是否引用资源。
- Draft Recovery 是否存在相关内容。
- 加密 Diary 是否具有受保护引用。
- 索引快照后是否发生并发引用写入。

### 16.3 后续清理原则

未来引入删除能力时，必须满足：

1. 预览待删除资源及风险。
2. 服务端重新执行删除资格检查。
3. 校验当前资源身份与引用状态。
4. 避免检查与实际删除之间的并发竞态。
5. 不允许删除被已确认引用使用的资源。
6. 遇到未知状态必须拒绝删除。
7. 明确历史版本与草稿的保护策略。
8. 提供失败恢复或明确的操作结果。
9. 不允许仅靠前端确认框完成安全校验。

**无法证明安全时，保留附件。**

---

## 17. Diary 安全边界

V1 不为加密 Diary 建立统一附件扫描器。

要求：

- 不读取加密 Diary 正文来构建普通资源索引。
- 不通过附件列表泄露受保护的正文、路径或元数据。
- 不将普通资源管理权限等同于 Diary 解锁能力。
- 不提供绕过现有 Diary Body Access 的预览入口。
- 不改变 Diary 加密、锁定、单文档与恢复机制。

对于无法排除受保护引用的资源，不得通过管理功能执行破坏性清理。

未来支持 Diary 附件时，需要独立的安全设计评审。

---

## 18. UI 与交互要求

### 18.1 视觉原则

继续使用 Nuvyn 现有的 Naive UI 体系和设计 Token。

整体风格：

- 简洁
- 克制
- 信息清晰
- 不增加装饰性大面积留白
- 不追求传统网盘的复杂工具栏

### 18.2 Desktop

桌面端优先采用：

- 顶部统计
- 搜索与筛选
- 资源列表
- 详情面板

详情面板可按现有窗口空间以侧栏或弹层呈现。

### 18.3 Mobile

移动端提供：

- 资源列表
- 搜索筛选
- 基础详情
- 支持类型的预览

不要求手机端复刻完整桌面双栏。

避免：

- 横向溢出
- 双重滚动
- 过多常驻按钮
- 密集表格列

### 18.4 空状态

至少包括：

- 当前没有附件
- 搜索没有结果
- 当前类型没有资源
- 索引正在构建
- 部分来源加载失败
- 当前资源无法预览
- 引用状态暂时无法确认

不应将网络错误或扫描失败展示为“没有附件”。

---

## 19. 错误处理与恢复

### 19.1 资源不存在

附件可能被外部程序删除。

应展示资源不可用状态，而不是造成整个列表崩溃。

### 19.2 资源损坏

Board Asset 已有完整性校验机制。

发生校验失败时：

- 不继续展示可能不可信的内容。
- 不自动删除或覆盖资源。
- 提供安全的错误提示。

### 19.3 索引失败

某个来源扫描失败时：

- 其他已成功来源仍可查看。
- 明确显示部分结果。
- 提供重试操作。
- 不把未知引用标记为无引用。

### 19.4 资源引用失效

附件与引用对象之间可能存在不一致。

应清楚区分：

- 附件不存在
- 引用对象不存在
- 引用对象不可访问
- 引用索引尚未完成

不允许因为引用目标不存在就自动修改文档。

---

## 20. 性能要求

### 20.1 列表

- 服务端分页。
- 首屏不加载附件二进制。
- 按需生成或获取预览。
- 搜索尽可能在服务器端完成。
- 列表滚动不触发全量资源扫描。

### 20.2 索引

- 索引构建不得阻塞正常编辑与保存。
- 对大量 Vault 文件采用有界扫描和可取消任务。
- 不要求为每个文件计算 SHA-256 才能显示列表。
- 可以缓存可重建的资源元数据。

### 20.3 预览

- 同屏只加载必要的缩略图。
- 大文件不得直接完整读入前端列表。
- 资源预览应遵循明确的大小限制。
- 关闭详情后释放不再需要的临时 Blob URL。

### 20.4 性能验收

需要覆盖至少以下规模：

- 空资源库
- 100 个资源
- 1,000 个资源
- 10,000 个资源的合成索引场景

重点验证分页、搜索、内存增长和编辑保存响应。

具体延迟指标由实施前的基准测试确定，不在 PRD 阶段凭空承诺。

---

## 21. 兼容性要求

V1 必须保持以下既有行为：

- Note 编辑、保存和阅读。
- Markdown 本地资源解析。
- Markdown Include。
- Board Asset 上传与恢复。
- Board Scene 引用持久化。
- Board Thumbnail。
- Board Materials 管理。
- Vault 文件移动与重命名。
- Git History。
- Draft Recovery。
- Diary 加密与单文档策略。
- Ledger 业务与统计。

### 21.1 数据兼容

不要求迁移现有 Asset UUID。

不要求迁移 Vault 本地图片路径。

不要求重写 Board Scene。

不要求重新保存所有 Note。

不要求为老资源补造文件名。

### 21.2 NAS 部署

必须兼容 Nuvyn 当前 NAS Docker 部署。

新增索引或数据库结构不得破坏现有数据目录映射和备份流程。

如果引入新表，应使用现有迁移机制。

---

## 22. 测试与验收标准

### A. 资源目录

- 能列出已有 Board Asset。
- 能列出受支持的 Vault 资源文件。
- 能列出 Board Materials。
- 不重复将 Note 主文档作为普通附件统计。
- 不展示系统内置静态资源。
- 旧 Board Asset 无原始名称时正常显示。
- 同名但身份不同的资源不会合并。

### B. 搜索与筛选

- 可以按名称搜索。
- 可以按 Vault 相对路径搜索。
- 可以按来源筛选。
- 可以按类型筛选。
- 可以按引用状态筛选。
- 服务端分页结果稳定。

### C. 预览

- 支持的图片正常预览。
- 不支持预览的文件正常显示元数据。
- 预览失败不会导致页面崩溃。
- SVG 不执行不可信脚本。
- 不可访问的资源不能借管理 API 绕过限制。

### D. 引用

- Board Asset 能显示已有 Scene 引用。
- Board Thumbnail 引用能够区分。
- Note 本地资源引用可以识别。
- Markdown Include 的依赖不会被错误解释。
- 代码块中的示例路径不会被当作有效引用。
- 可以从已知引用跳转到 Note 或 Board。
- 不可确定引用状态时显示“待确认”。

### E. 安全

- 全局管理页面不能永久删除资源。
- 索引构建不修改附件内容。
- 不读取受保护的 Diary 正文。
- 不暴露 NAS 绝对路径。
- 不允许路径穿越。
- 不跟随越界符号链接。
- 不通过错误消息泄露文件内容。
- 无权限时无法读取资源内容。

### F. 可靠性

- 外部删除文件后能发现资源不可用。
- 部分扫描失败能保留其他来源结果。
- 索引失败不影响 Note、Board 正常使用。
- 重复刷新不会形成竞争结果。
- 索引可重建。
- 不因管理界面打开而重建 Monaco 实例。

### G. 响应式

- Desktop 布局正常。
- Mobile 不出现横向溢出。
- Light / Dark 主题正常。
- 键盘可以操作搜索、筛选和详情。
- 焦点管理与返回行为正确。

---

## 23. 版本规划

### V1 — 全局资源目录

**本 PRD 的交付范围。**

交付：

- 统一资源目录
- 资源搜索筛选
- 存储统计
- 资源详情
- 安全预览
- 已知引用展示
- 跳转到引用位置
- 索引状态和刷新

不提供永久删除。

### V2 — 引用完整性与受控清理

在 V1 稳定之后：

- 更完整的引用索引。
- 历史与草稿风险分析。
- 失效引用检测。
- 清理资格预检。
- 安全删除。
- 审计与失败恢复。
- 重复资源分析。

### V3 — 统一上传与复用

支持：

- 通用附件上传。
- 更多资源类型。
- Note 插入附件。
- 从已有资源库插入 Board。
- 拖放附件。
- 跨 Workspace 复用。
- 上传命名与格式校验。
- 可选的去重策略。

### 后续方向

- 受控 Diary 附件管理。
- Ledger 专用资源接入。
- 更完整的存储占用分析。
- 附件导出和备份检查。

---

## 24. 产品设计原则

### 24.1 不新增不必要的 Workspace

Attachment Manager 是管理能力，不是新的内容创作场所。

### 24.2 统一管理，不强制统一存储

不为界面统一而迁移成熟的存储系统。

### 24.3 原始资源优先

附件本体永远比管理索引更重要。

索引可以丢失和重建，用户附件不能因索引操作丢失。

### 24.4 引用必须可信

能确定的显示确定结果。

无法确定的明确标记未知。

### 24.5 删除必须有证据

不把“扫描不到引用”视为安全删除证明。

### 24.6 保持安全边界

不能因为全局管理便利而削弱 Diary、Vault 路径或资源读取的已有安全机制。

### 24.7 先可靠，再丰富

V1 优先完成准确的资源目录。

上传、去重、批量清理等功能在引用与所有权模型稳定后再扩展。

---

## 25. V1 完成定义

当用户能够从 Nuvyn 设置进入附件管理页面，并完成以下操作时，V1 达到产品层面的交付标准：

1. 查看当前已纳入管理范围的资源。
2. 搜索和筛选这些资源。
3. 查看资源的来源与可靠元数据。
4. 预览受支持的资源。
5. 查看当前已知引用。
6. 跳转至对应 Note 或 Board。
7. 了解当前未发现引用或引用状态未知的资源。
8. 在不影响现有内容和存储生命周期的情况下退出管理页面。

同时：

- 不修改原始附件。
- 不改变现有 Workspace 的数据模型。
- 不绕过 Diary 加密边界。
- 不因索引不完整产生错误的安全删除判断。
- 不影响 NAS 生产环境中的既有资源。

**最终定义：**

Attachment Manager V1 是 Nuvyn 的统一资源观察与管理入口。

它首先让资源变得可见、可查找、可追溯。

在这些能力足够可靠之前，不赋予它任意删除用户数据的权力。

## Phase 4 实施补充（2026-10-14）

在保留 P1–P3 历史决策的基础上，增加受管理 Note 图片的可恢复回收站。
永久删除仍禁用。仅具有原始上传身份记录、可靠当前扫描且未发现引用的
图片可经二次校验回收。旧图片缺少身份记录时保持不可回收，不自动补认。
历史 Markdown 路径继续通过认证读取，SVG 校验不变。恢复不覆盖任何冲突文件。
回收不释放 NAS 空间，回收站占用单独统计。二进制与独立恢复日志分别存于
Vault 隐藏目录与 SQLite 数据卷，备份和升级必须同时保留两者。
详见 [Phase 4](attachment-manager-phase4.md)，包括文件生命周期、崩溃恢复、
NAS 外部写入边界及永久清理尚未覆盖的风险。

---

## 26. Phase 3 实施补充（2026-10-14）

本节记录 Phase 3 对原始 V1 范围的受控扩展；原有条款保留作为决策背景，冲突处以本补充为准。

### 26.1 预览与选择

- 预览仅在用户选中资源后按需读取，不将二进制加入目录索引。
- PNG、JPEG、WebP、GIF、AVIF 与 SVG 通过各自的认证资源读取边界获取；SVG 预览使用既有清理器。
- 选择变化、关闭或卸载时取消过期请求并释放临时 Object URL。
- Note 图片选择器可直接引用 Vault Note 图片；Board Asset 导入 Note 时生成 Vault 副本并使用现有上传校验和 Monaco Tracked Range。
- Board 图片选择使用 Board Asset Session。复用资源保留其 Board Asset ID；Vault 图片导入会创建新的 Board Asset 并经过本地 Pending Blob、上传、保存与恢复流程。

### 26.2 写入范围

- 附件管理器只允许上传 Note 支持的图片至 Note 图片库，不开放任意文件上传。
- Note 与 Board 的插入入口复用各自既有写入边界，不改变物理存储和资源身份协议。
- Diary 不进入附件目录、预览、引用或跨 Workspace 导入流程。

### 26.3 审计和清理

- 记录受控上传、跨 Workspace 图片导入及 Board Asset 复用的有限操作元数据，最多保留 500 条。
- 审计不存储文件二进制、Diary 正文、认证信息或绝对路径；读取接口使用现有认证会话。
- 清理预检仍然只读，`deletionAllowed` 固定为 `false`。零引用、索引不完整、历史版本、草稿或受保护来源未知都不构成删除授权。
