# Attachment Manager Phase 4 — Recoverable Note image trash

Scope: authenticated, Nuvyn-uploaded `attachments/images/<uuid>.<ext>` images
(PNG, JPEG, GIF, WebP, AVIF, sanitized SVG). Board resources, arbitrary Vault
files and Diary are excluded. Permanent deletion remains disabled.

## Persistence and identity

Migration 0038 adds `note_image_identity` and `attachment_trash`, independently
of the 500-row audit. Upload provenance records UUID, canonical relative path,
MIME, length, SHA-256, device/inode and modification generation. Every upload
entry uses the existing validation/durable-write pipeline. If provenance
cannot be stored, the image remains usable but cannot be recycled. Existing
images without original provenance are **not** retroactively trusted merely
because their names look like UUIDs.

Binaries live under `VAULT_DIR/.nuvyn/attachment-trash/<record-id>.<ext>`.
SQLite stays in the existing persistent data volume. Both volumes must be
backed up together, including hidden Vault directories. Neither audit nor
client state is a lifecycle source of truth. Absolute NAS paths and image
bytes are not stored in audit or lifecycle records; a Vault root digest binds
records to the configured Vault. Relocating a Vault or changing file identities
requires administrator review rather than silently adopting new generations.

## State and crash recovery

`recycling → trashed → restoring → restored`.

The SQLite journal is committed before the first filesystem mutation. A
same-filesystem, exclusive hard link publishes the destination without
overwriting it or changing the file generation. File and directory sync and
identity/hash checks precede unlinking the source directory entry. The binary
always remains at the other entry. Filesystems without hard-link or directory
fsync support fail closed; lifecycle journal writes temporarily require SQLite
synchronous FULL or stronger, restoring the connection's previous setting
after the coordinated operation. Ordinary module settings remain unchanged.

Dev and production startup reconcile pending journals before serving requests.
Source only: retry publication; both matching entries: finish source removal;
destination only: commit completed state. Missing or conflicting generations
are preserved, remain pending and visible, and can be retried after storage
issues are resolved. No unknown incumbent is removed. Restore never overwrites
an occupied original path, even if bytes match. Repeated restore is idempotent.
Recovery successes/failures are recorded in the bounded audit separately.

## Eligibility and concurrency

Risk preview distinguishes `quarantineAllowed` from `deletionAllowed: false`.
Eligibility requires verified upload identity, complete current catalog and
reference scans, no current use, nonstale evidence and safe storage. A signed,
60-second confirmation token binds owner session, Vault, snapshot and file
generation. Restart invalidates tokens. Under the existing Vault mutation
coordinator, execution verifies the token/snapshot and reruns scans before
moving anything. Failed, partial, stale or changed evidence denies recycling.
Existing authentication and Origin/CSRF checks protect all endpoints.

The global application writer ownership and Vault mutation lock coordinate
Nuvyn writes, including uploads. They cannot serialize an independent NAS
writer. Portable check/unlink operations retain a narrow external-writer
race, as existing durable-file helpers do. Do not externally mutate managed
image directories during operations. NAS power-loss durability also depends
on the filesystem correctly implementing hard links/fsync; automated process
crash tests cannot prove that property.

## Historical reads and UI

Authenticated Markdown reads retain the original logical URL. Active paths
have priority; an existing live trash record verifies their generation and
rejects replacements. When missing, the matching trash binary is safely read
and hash checked. SVG still passes the existing sanitizer. History restores,
browser drafts and later Notes can continue using original URLs; these
sources are not described as proven unused. Trash is excluded from catalog,
picker, file tree and Git history (explicit `info/exclude` entry).

Settings → Storage & attachments has an active/trash switch, risk-qualified
confirmation, search, pagination, authenticated preview and original-path
restore. Storage is reported separately. Recycling does **not** release NAS
space. No expiration, auto-cleanup or permanent-delete endpoint exists.

## Verification and manual acceptance

Automated tests cover formats, identity replacement, symlinks, path conflicts,
reference changes, auth, SVG validation, persisted paging and real SIGKILL
before linking/after linking/after unlinking in both directions. Chromium
covers confirmation, preview, refresh persistence, original Markdown reads,
restore and desktop/tablet/mobile geometry.

Before NAS rollout: back up both volumes; test a newly uploaded unused image;
recycle and read its old Markdown URL; restart the container with the same
mounts; preview/restore; test path conflict without overwriting; confirm that
the NAS provides hard links and directory fsync; verify paired backup restore.
Power failure and SMB/NFS mount durability require platform-specific manual
acceptance. Permanent cleanup still needs a separate history/draft/checkpoint
coverage design.

## 本次交付验证记录

- `npm run typecheck`、`npm run build`、`git diff --check`：通过。
- `npm run test:unit -- --maxWorkers=1`：344 文件通过，5,098 测试通过，
  9 项既有跳过。此后补充“活动目录不存在时仍读取历史图片”测试，相关
  生命周期/API/Markdown 回归共 47 项通过；最终 UI 回归 14 项通过。
- `npm run test:history-integration`：183 项通过。
- `npm run test:recovery-integration`：198 项通过。
- `npm run test:tags-scale`：6 项通过。
- Chromium 附件管理、回收站、Note 图片插入：12 项通过；Board 图片选择器
  与 Diary/Note 生命周期定向回归：3 项通过。
- 初次沙箱内执行出现本地端口/tsx IPC 权限错误；申请权限后已复验通过，
  没有新增 retries、跳过测试或放宽业务断言。
- `npm run test:deployment-auth`：未通过，Docker daemon 未启动，容器无法
  创建。没有将该项报告为通过。WebKit/Safari 与真实 NAS 断电未验证。

上线结论：功能与本地自动化验证完成；尚不能宣称 NAS 生产验收完成。
必须完成 Docker 重启与实际 NAS 文件系统、双卷备份恢复的手动验收。
独立外部写入者不受进程内锁控制；此场景不在安全回收支持范围内。
复制备份/更换挂载后 inode 或设备身份改变会拒绝读取/恢复，需要管理员
核对原始文件代际，不能自动把相同内容视作同一资源。

## 修改文件清单

| 文件 | 目的 |
| --- | --- |
| `server/migrations/0038_attachment_trash.sql` | 上传身份、独立回收日志、审计操作扩展；保留旧审计 |
| `server/attachments/trash.ts` | 资格凭证、同文件系统独占移动、恢复、协调、身份与内容验证 |
| `server/attachments/routes.ts` | 回收/恢复/分页 API 与执行前引用重扫 |
| `server/routes/noteImages.ts` | 在既有上传链路记录上传代际并接入 Vault 写锁 |
| `server/markdownResources.ts` | 认证读取原路径回退，保留 SVG 校验并拒绝冲突代际 |
| `server/prod.ts`, `server/vite-plugin.ts` | 请求服务前协调未完成的日志 |
| `server/history/repo.ts` | 已有 Git 仓库也显式排除回收站目录 |
| `shared/attachmentProtocol.ts` | 独立回收资格、回收列表和审计契约 |
| `src/lib/attachments-api.ts` | 复用 authFetch 的客户端 API |
| `src/components/vault/SettingsAttachmentManagerSection.vue` | 风险确认、低干扰回收站入口、分开统计空间 |
| `src/components/vault/AttachmentTrashView.vue` | 搜索、预览、恢复、分页和响应式布局 |
| `src/composables/useI18n.ts` | 中英文功能、风险及审计文案 |
| `server/__tests__/attachmentTrash.test.ts` | 格式、安全、冲突、并发、持久化与实际 Git 历史读取 |
| `server/__tests__/fixtures/attachment-trash-crash.ts` | 六个真实 SIGKILL 文件/数据库中断点 |
| `server/__tests__/attachments.test.ts` | API、当前引用新增、认证与 Origin 回归 |
| `src/components/vault/__tests__/SettingsAttachmentManagerSection.test.ts` | 同步新 API mock，保留原 UI 业务断言 |
| `e2e/attachment-trash.spec.ts` | 完整回收、刷新、预览、恢复和阅读渲染流程 |
| `server/__tests__/auth.migration.test.ts`, `server/__tests__/crashRecovery.test.ts` | 同步总 schema 版本 38 |
| `server/__tests__/ledger-migration.test.ts`, `server/__tests__/ledger-persistence.test.ts` | 仅同步总 schema 版本，不改 Ledger 契约 |
| `server/__tests__/tagManagement.scale.test.ts`, `server/__tests__/tagUndoFoundation.test.ts` | 同步最新迁移与健康检查版本断言 |
| `server/board/materialApi.test.ts` | 同步总 schema 版本，不改 Board 契约 |
| `docs/design/attachment-manager-phase4.md` | 生命周期方案、安全边界和验收记录 |
| `docs/design/attachment-manager-implementation-plan.md`, `docs/design/attachment-manager-prd.md` | 保留历史决策并追加 Phase 4 范围 |
| `docs/user-guide/vault.md` | 回收、恢复、空间语义与备份说明 |
