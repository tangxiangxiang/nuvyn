# Edit-01：保存链路架构审计与状态所有权梳理

> 审计日期：2026-07-16  
> 范围：当前工作区代码，只分析，不修改业务行为。  
> 结论中的路径均为 Vault 相对路径（前端不带 `.md`）；History API 的 Git 路径会补 `.md`。

## 1. Executive Summary

当前 Edit 保存链路已经不是旧版单体 `useEditorTabs`：`useEditorTabs()` 是装配层，Tab/Vault 状态由 `useTabWorkspace()` 持有，保存事务由 `useDocumentSave()` 持有。现有实现已经具备三项关键能力：

1. 每个 path 独立的 800ms timer（`saveTimers: Map<path, timer>`）；
2. 同 path 串行保存（`savePromises: Map<path, Promise>`）；
3. 保存 immutable 快照（`sentRevision` + `sentVersion`），并用 `revision/savedRevision/savingRevision` 保留“保存期间又编辑”的信息。

因此，当前不存在同一文档 S1/S2 HTTP 请求乱序返回；`doSave()` 会等 S1 完成后才发 S2。A、B 两个文档也不会互相取消 debounce。

“编辑后 History Changes 不立即出现”的直接原因非常明确：

```text
EditorPane onDidChangeModelContent
→ emit update:modelValue
→ VaultView onEditorChange(activeTab.path, raw)
→ useDocumentSave.scheduleSave(path, 800)
→ PUT /api/posts/:path
→ 更新 Tab 基线
→ refresh()（GET tree + GET posts）
→ 结束

缺失：fileChanges.publish({ path, kind: 'write', ... })
→ useHistory 的 fileChanges watcher 没有事件
→ refreshStatus() 不执行
```

可信持久化边界是 `PUT /api/posts/*` 返回 HTTP 2xx：路由在响应前已经完成目标文件写入、SQLite metadata 更新（失败时尝试回写旧内容）和 `stat`；link index 更新是 best-effort，不属于成功条件。该写入使用 `fs.writeFile` 直接覆盖，并非临时文件 + 原子 rename。

下一任务不需要重写 Edit 状态机。最小正确边界应位于 `useDocumentSave.saveLatest()`：把“磁盘 PUT 成功”与“后续派生状态刷新”分开，并在成功落盘、更新基线后由同一个保存协调器统一发布带 `source: 'editor-save'`、但不带 `newRaw` 的 VaultFileChanges。这个来源标记是必要的回路隔离：History、LinksPanel、LinkIndex 等派生消费者仍应收到事件，但 `useExternalFileChanges` 必须把同一编辑器产生的保存事件视为 acknowledgement，只同步必要的 mtime，不能重新覆盖 Tab 内容或重置保存展示状态；省略 `newRaw` 则保证 `useCurrentNote` 不会用较旧的已保存快照覆盖实时 `Tab.raw`。Rename/Delete/Move 还缺少与 pending/in-flight save 的协调，建议作为紧随其后的独立生命周期任务处理。

## 2. Current Ownership Map

### 2.1 状态所有权表

| 状态 | 当前所有者 | 生命周期 | 有权写入者 | 主要读取者 |
| --- | --- | --- | --- | --- |
| `tree: Ref<TreeNode[]>` | `useTabWorkspace()` (`useTabWorkspace.ts:16`) | VaultView mount | 仅 `refresh()` 在请求序号仍最新时替换 | FileTree、VaultView |
| `posts: Ref<PostSummary[]>` | `useTabWorkspace()` (`:17`) | VaultView mount | 仅 `refresh()` (`:38-44`) | FileTree、CommandPalette、TOC、`activeSize`、保存后的 mtime 同步 |
| `tabs: Ref<Tab[]>` | `useTabWorkspace()` (`:18`) | VaultView mount；单 Tab 跨打开/关闭 | workspace 的 open/close；`useDocumentSave` 的编辑/保存；外部变化与 Restore 协调器 | VaultView、EditorTabs、EditorPane、StatusBar、VaultContext consumers |
| `activePath` | `useTabWorkspace()` (`:19`) | VaultView mount | `openPost`、`selectTab`、close fallback、route restore、外部 rename | VaultView、route sync、StatusBar、快捷键 |
| `activeTab` | `useTabWorkspace()` computed (`:22-24`) | 派生 | 无直接写入 | EditorPane、StatusBar、VaultContext |
| `raw` | 每个 `Tab` (`tabs.ts:6`) | Tab | load/open、`onEditorChange`、保存响应规范化、外部变化、Restore | EditorPane、dirty、ReadingPane、AI current note |
| `originalRaw` | 每个 `Tab` (`tabs.ts:7`) | Tab | load/open；成功保存快照；外部变化；Restore | `isDirty`、close dirty check、编辑回退判断 |
| `revision` | 每个 `Tab` (`tabs.ts:8`) | Tab | 每次 `onEditorChange`；磁盘/Restore 内容替换 | 保存调度与 dirty 判定 |
| `savedRevision` | 每个 `Tab` (`tabs.ts:9`) | Tab | 成功保存；内容回到基线；外部/Restore 内容替换 | 保存循环、beforeunload、状态判定 |
| `savingRevision` | 每个 `Tab` (`tabs.ts:10`) | 单次请求 | `saveLatest()` 请求前设置、finally 清空；Restore 清空 | 当前没有 UI 读取方；用于表达 in-flight revision |
| `saveStatus` | 每个 `Tab` (`tabs.ts:11`) | Tab | save coordinator、外部磁盘协调器、Restore、外部事件协调器 | tab dirty 点、StatusBar、beforeunload、保存循环 |
| `error/loadError/loading` | 每个 `Tab` (`tabs.ts:12-14`) | Tab | load、save、external/restore coordinators | EditorPane、StatusBar、close/unload |
| `serverMtime` / `externalRaw` | 每个 `Tab` (`tabs.ts:15-21`) | Tab | load/save refresh、外部轮询/事件、Restore | 外部文件变化检测与冲突 UI |
| `saveTimers` | `useDocumentSave()` (`useDocumentSave.ts:14`) | composable mount | `scheduleSave`、barrier/close/restore/dispose | save coordinator only |
| `savePromises` | `useDocumentSave()` (`:15`) | composable mount | `doSave()` | save、close、Restore barrier |
| `commitBarriers` | `useDocumentSave()` (`:16`) | Create Version transaction | `prepareHistoryCommit()` / release | schedule/save snapshot selection |
| `fileChanges.events` | `createVaultFileChanges()` (`fileChanges.ts:13-30`) | VaultView mount | 任何持有该实例的 producer 调 `publish()` | Editor external changes、History、LinkIndex、LinksPanel、CurrentNote |

`Tab` 的完整字段定义见 `src/components/vault/tabs.ts:1-21`；初值由 `makeEmptyTab()` 在 `editor-tabs/tabState.ts:9-24` 创建。

### 2.2 状态层级

- Vault 级：`tree`、`posts`、`tabs` 集合、`activePath`、`VaultFileChanges`。
- Tab 级：buffer、基线、revision、保存/加载/外部冲突状态。
- 组件级：`EditorPane` 持有 Monaco editor/model、composition flag、view state 和 decorations，但不持有第二份业务 raw。Monaco model 是编辑表面缓存；变更立即 emit，父级 `Tab.raw` 才是业务内存内容。`props.modelValue` 变化通过 watcher 回写 model，并用 `suppressChange` 防止 echo（`EditorPane.vue:516-521`）。

### 2.3 posts/tree 是否重复

生产 VaultView 中只有 `useTabWorkspace()` 的一份 `posts/tree`，由 `useEditorTabs()` 返回并下传。History 在 `VaultView.vue:162` 通过同一个 `vaultContext` 创建，但 History changes 的数据源是 Git Status，不是 `posts`；`HistoryPanel` 只用共享 `posts` 做标题/展示元数据。fallback bus 只用于脱离 VaultContext 的兼容挂载，不是生产 VaultView 的实例。

## 3. Current Save State Machine

### 3.1 实际转换

```text
load success
  → idle (revision=0, savedRevision=0)

idle/saved/error/offline → dirty
  trigger: onEditorChange; raw != originalRaw
  action: revision++, scheduleSave(path, 800)

dirty → idle
  trigger: 输入恰好回到 originalRaw
  action: savedRevision = current revision

dirty → saving
  trigger: saveLatest 捕获 sentRevision/sentVersion 并发出 PUT

saving → dirty
  trigger: PUT 期间继续输入
  action: onEditorChange 直接把 saveStatus 改为 dirty；savingRevision 仍非 null

saving → saved
  trigger: PUT 和随后 refresh 均成功，且 current revision == sentRevision

saving → dirty
  trigger: PUT 成功但已有更新 revision；保存循环随后发送下一快照

saving/dirty → error 或 offline
  trigger: PUT、response JSON 或 refresh 任一步抛错

external → idle/dirty/saved
  trigger: 用户选择磁盘/本地冲突策略
```

`saved → dirty` 会在下一次输入同步发生（`useDocumentSave.ts:86-93`），因此不会保留虚假的 saved。当前 `saveStatus` 单字段无法同时显示 `saving + newer dirty content`，但内部并非完全无法表达：此时 `saveStatus='dirty'` 且 `savingRevision !== null`。UI 只读取 `saveStatus`，所以请求仍在进行时会从“正在保存”提前变成“未保存”。

### 3.2 状态语义与实现差异

| 理想含义 | 当前实际含义 |
| --- | --- |
| dirty = 内存不同于最近成功落盘 | 大体成立；核心判断还分散在 `raw !== originalRaw` 和 `revision !== savedRevision` 两套表达 |
| saving = 存在进行中的写盘 | 不完全成立；保存期间继续输入会立即显示 dirty，实际 in-flight 只能从 `savingRevision` 得知 |
| saved = 最近一次请求成功且当前内容已落盘 | PUT 与 refresh 都成功且无更新编辑时成立 |
| error = 最近一次写盘失败 | 不准确；PUT 已成功但 `refresh()` 失败也会进入 error |

## 4. Actual Call Chains

### A. 自动保存成功

```text
Monaco editor.onDidChangeModelContent
  EditorPane.vue:373-377
→ emit('update:modelValue', model.getValue())
→ VaultView.vue:674-682
  onEditorChange(activeTab.path, value)
→ useDocumentSave.onEditorChange(path, value)
  useDocumentSave.ts:86-94
  tab.raw=value; revision++; saveStatus=dirty
→ scheduleSave(path, 800)
  :18-25（每 path 重置 timer）
→ doSave(path)
  :69-84（每 path single-flight + while loop）
→ saveLatest(path)
  :28-67（捕获 sentRevision/sentVersion）
→ fetch PUT /api/posts/{encodeURI(path)} { raw: sentVersion }
→ server/routes/posts.ts:95-120
  fs.writeFile → metadata/cleanup bookkeeping → best-effort link index → 200
→ originalRaw=sentVersion; savedRevision=sentRevision
→ refresh() = Promise.all(GET /api/tree, GET /api/posts)
  useTabWorkspace.ts:38-44
→ 从 posts 更新 serverMtime
→ UI 读取 activeTab.saveStatus = saved
```

断点：此链没有 `fileChanges.publish()`。

### B. 手动保存

```text
window/vault keydown
→ VaultView.onVaultKeydown
→ useEditorShortcuts.onKeydown (useEditorShortcuts.ts:18-23)
→ preventDefault(); void doSaveNow()
→ useDocumentSave.doSaveNow() (:105-107)
→ doSave(activePath)
→ 与自动保存相同的 PUT / 基线 / refresh 链
```

手动保存不会清除该 path 已排队的 800ms timer。它会立即保存；旧 timer 到时再次调用 `doSave()`，通常因 revision 已等于 savedRevision 而 no-op，不会重复 PUT，但会保留一次无意义调度。Cmd/Ctrl+S 的调用方使用 `void`，错误通过 Tab 状态/toast 表达。

### C. 连续编辑与连续保存

```text
v1 → revision=R1 → doSave(path)
   → sentRevision=R1, sentVersion=v1, savingRevision=R1, PUT S1

S1 in flight 时输入 v2
   → revision=R2, raw=v2, saveStatus=dirty, timer 重置

再次 doSave(path)
   → savePromises 中已有 promise，返回同一个 S1 chain，不发送并行 S2

S1 返回
   → originalRaw=v1（不是 current raw v2）
   → savedRevision=R1
   → while loop 发现 R2 != R1
   → 捕获 v2，发送 S2

S2 返回
   → raw/originalRaw=v2, savedRevision=R2, saveStatus=saved
```

结论：同 path 不存在“S2 先返回、S1 后返回”，因为 S2 在 S1 完成前不会发出。磁盘最终不会因前端同 path 请求乱序回退到 v1。不同 path 使用不同 promise，可并行写盘。

### D. 切换或关闭文档

切换：

```text
dirty/pending/saving A
→ selectTab(B) / openPost(B)
→ 只修改 activePath + route（useTabWorkspace.ts:46-76,164-170）
→ A 的 timer/in-flight save 继续按 A path 执行
```

关闭：

```text
closeTab(path)
→ useEditorTabs wrapper
→ prepareDocumentClose([path]) (useDocumentSave.ts:167-185)
   cancel queued timer
   await serialized in-flight chain
   cancel possible trailing timer
→ closeTabState(path)
→ 若仍 raw != originalRaw，弹 dirty confirm
→ 删除 Tab + Monaco model
```

因此正常 UI close 不会让已开始请求在删除 Tab 后回写状态；但 queued debounce 被取消而非 flush，用户确认后可放弃它。VaultView 卸载只取消 timers/barriers，不等待或取消 `savePromises`（`:187-191`），已开始的 PUT 会继续，并且其闭包仍可能更新旧 Tab 和调用 refresh。

这里还有一个取消关闭缺口：`prepareDocumentClose()` 在 dirty confirmation 之前就清除了 queued timer。如果用户在随后出现的“放弃修改”确认中选择取消，Tab 会保留且仍然 dirty，但先前的自动保存不会恢复；只有再次输入或手动保存才会落盘。关闭协调需要记住哪些 path 原本有 queued timer，并在关闭未完成且仍 dirty 时重新 schedule。

### E. 保存完成通知 History

当前实际链：

```text
disk write success
→ useDocumentSave 更新 Tab + refresh posts/tree
→ [链路终止]

VaultFileChanges 没有新 seq
→ useHistory watcher 不运行
→ getStatus 不调用
→ history.status / history-changes-list 保持旧值
```

已有可工作的事件链（例如 Restore）：

```text
restoreFile success
→ useHistoryRestore.applyRestoredContent
→ fileChanges.publish({ path, kind:'write', source:'history-restore' })
  useHistoryRestore.ts:99-114
→ createVaultFileChanges 替换 events 数组并递增 seq
  fileChanges.ts:18-23
→ useHistory watcher
  useHistory.ts:101-112
→ refreshStatus()
→ history-api getStatus()
→ history.status 更新（statusRequestId 拒绝旧响应）
```

## 5. Persistence Boundary

### 5.1 前端请求

保存路径没有复用 `src/lib/api.ts` 的 API wrapper，而是在 `useDocumentSave.saveLatest()` 中直接：

```ts
fetch('/api/posts/' + encodeURI(path), {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ raw: sentVersion }),
})
```

响应期望 `{ ok: true, raw: string }`。path 是无 `.md` 的 Vault 相对路径。

### 5.2 服务端成功语义

`server/routes/posts.ts:95-120` 顺序为：

1. 校验路径且要求文件已存在；
2. 读取旧 raw/stat，并导入遗留 metadata；
3. `fs.writeFile(abs, body.raw, 'utf8')` 直接覆盖；
4. `stat` 后更新 SQLite metadata / migration tracking；失败则尝试回写 `previousRaw` 并让请求失败；
5. best-effort 更新内存 link index，失败不影响响应；
6. 返回 `{ ok: true, raw: body.raw }`。

所以 HTTP 2xx 表示 Worktree 文件写入 promise 已完成，且 metadata 后处理未抛错。它不表示 fsync 到物理介质，也不表示 link index 必然更新；路由也不是 atomic replace。对本应用的“成功落盘”协议而言，2xx 是当前唯一可信边界。

PUT 不解析并重写 Frontmatter；raw 字节按提交内容覆盖。服务端会解析旧/新内容以维护 SQLite metadata，但不向正文注入字段。mtime/size 由后续 `/api/posts` refresh 获得；PUT 响应本身不返回 mtime/size/title。

### 5.3 写盘成功后的真实顺序与错误归类

当前顺序（`useDocumentSave.ts:48-65`）：

1. parse PUT JSON；
2. 根据 current raw 是否仍等于 sentVersion，更新 `raw/originalRaw`；
3. 更新 `savedRevision/saveStatus`；
4. `await refresh()`，同时全量拉 tree + posts；
5. 从 posts 找 mtime；
6. 任一步异常统一 catch 为 save error/offline。

缺失项：`fileChanges.publish()`、明确的保存 API wrapper、派生刷新失败的独立状态。

关键异常：若 PUT 已 2xx，但 tree/posts refresh 失败，Tab 基线和 `savedRevision` 已经更新，随后又被标成 `error`。这会误报“写盘失败”；点击重试时 `saveLatest()` 看到 revision 已保存，只把状态改回 idle，不会重试 refresh。磁盘内容正确，但 posts/size/mtime 可能继续陈旧。

`refresh()` 每次同时全量刷新 tree + posts；对普通内容保存，tree 结构通常不变，属于可优化但不是本任务修复范围。其 `refreshRequestId` 能阻止旧全量刷新覆盖新结果（`useTabWorkspace.ts:20,38-44`）。

## 6. Concurrency and Race Analysis

### 6.1 debounce 并发语义

- 延迟：默认 800ms（`useDocumentSave.ts:18`）。
- 实现：原生 `setTimeout`，不是 `useDebounceFn`。
- 粒度：每 path 一个 timer；A/B 在 800ms 内编辑互不取消。
- A 切到 B：A timer 继续执行。
- 同 path 每次输入：清除旧 timer 并重建。
- 手动保存：不取消 timer；立即保存后，timer 通常 no-op。
- 正常 close：取消 queued timer，等待 in-flight chain，然后再次取消 trailing timer。
- Vault unmount：取消 queued timer，不 flush；in-flight 不 cancel/await。
- History Restore：取消 queued timer并等待当前 chain，之后再清 timer。
- Create Version：清 selected path timers，建立 click-time snapshot barrier，保存 snapshot；release 后保存 barrier 后产生的新编辑。

### 6.2 同文档请求乱序

每 path 的 `savePromises` 使前端同 path 最多一个 serialized chain。`doSave()` 内 while loop 依次保存最新 revision，具备 snapshot 和 generation 概念，但没有 AbortController、网络 CAS 或服务端版本 CAS。对“仅由当前 VaultView 的 Edit 协调器发起”的请求，S1/S2 不会并行，旧响应不会覆盖新状态。

仍可能绕过该串行器的来源：另一个浏览器窗口、AI/server tool、FileTree rename/delete、metadata cleanup、History Restore（Restore 自身有 editor barrier）。普通 Edit PUT 服务端没有 expected mtime/hash，因此外部写入与 Edit PUT 之间是 last-writer-wins。

### 6.3 保存期间继续输入

实现正确使用 `sentVersion` 更新基线，而不是无条件 `originalRaw = tab.raw`（`:49-55`）。S1 成功而 current raw=v2 时，基线设 v1、savedRevision=R1，循环继续保存 v2。这里不会错误清除 v2 dirty。

### 6.4 refresh 并发

每个成功快照都会全量 `refresh()`。同 path save 串行，但不同 path 可同时完成并发 refresh；`refreshRequestId` 仅采用最后发起的响应，避免旧响应覆盖新响应。它不保证“最后发起的响应”包含另一并行写入的最新磁盘状态，但后发请求通常在后写入之后取数；严格跨操作一致性没有事务保证。

## 7. Document Lifecycle Analysis

### 7.1 open/select/route

- `openPost(path)` 若 Tab 已存在只切 active + route，不 flush/wait；新 Tab 先插入 loading placeholder，再 GET 内容，最后全量 refresh（`useTabWorkspace.ts:46-76`）。
- `selectTab(path)` 只切 active + route（`:164-170`）。
- `useRouteSync` 的 route 变化调用同一 `openPost`；切换不影响旧 path 的保存 timer。
- path 被传入 `onEditorChange(activeTab.path, value)`；EditorPane 以 `:key="activeTab.path"` 挂载，切换会销毁旧组件。正常 emit 使用当时 active Tab path；未知/已关闭 path 在 `onEditorChange` 中找不到 Tab即 no-op。

### 7.2 close

正常 close 已有 in-flight 等待屏障，且确认发生在等待之后。这避免“请求其实马上成功，但先弹出丢弃确认”的竞态。关闭后重新打开同 path 时，正常 close 已等旧 chain 结束，因此旧请求不会再写新 Tab 状态。

缺口：Vault unmount 不等待 in-flight；浏览器 hard unload 只能使用 `beforeunload` 提示，不能可靠 flush async fetch。`disposeDocumentSave()` 也不会阻止 in-flight promise 的完成回调继续 `refresh()`。

### 7.3 Rename / Move

FileTree 的 file rename/move 直接调用 `patchPost()`，成功后仅 `emit('refresh')`，只对部分引用重写发布 `write` 事件；它没有调用 Edit save barrier，也没有为被重命名文件发布 `rename`（`FileTree.vue:383-433,479-510`）。

后果：

```text
旧路径 dirty + queued save
→ rename old → new 成功
→ old Tab 仍存在，timer 后 PUT old
→ 通常服务端 404，Tab 进入 error；新路径另开 Tab
```

更危险时序：Edit PUT 已在服务端通过 `exists(old)` 检查，但尚未 `fs.writeFile(old)`；同时 rename 将 old 移到 new；随后 PUT 对旧绝对路径 `writeFile`，可能重新创建旧文件。若 PUT 已写完后 rename，则新文件会包含保存内容，取决于文件系统时序。当前没有统一 path mutation lock 覆盖 Edit 与 FileTree。

Folder rename/move 对其下所有打开 Tab 也没有 path remap 或保存屏障。

### 7.4 Delete

FileTree delete 直接 DELETE 后 refresh，不发布 delete 事件，也不关闭 Tab/取消 timer（`FileTree.vue:454-476`）。queued timer 通常在 DELETE 后 PUT 404；但与 Rename 类似，已通过服务端 existence check 的 in-flight PUT 可在 staged rename/unlink 后再次 `writeFile` 原路径，从而复活文件。外部/AI delete 若发布 bus 会把 Tab 标记 `loadError`，但 FileTree 自己当前没有发布。

### 7.5 Restore

Restore 是目前保护最完整的外部 Worktree mutation：

1. 用户确认包含 current dirty 提示；
2. 获取 History path mutation lock；
3. `prepareHistoryRestore(path)` 清 queued timer、等待 serialized in-flight chain、再清 trailing timer；
4. server restore；
5. 同步更新打开 Tab 的 raw/originalRaw/revisions/status；
6. publish `source:'history-restore'`；
7. 并行 refresh Vault 与 comparison。

因此 pending save 不会在 Restore 后覆盖 restored bytes。确认期间仍可输入；确认后 barrier 会取消其 timer，Restore 按用户已确认的 destructive 语义覆盖当前 buffer。该交互是否需要确认内容快照冻结属于产品策略，不是当前链路缺失。

## 8. posts/tree/FileChanges Integration

### 8.1 posts/tree 来源与刷新

- 初始：`useEditorTabs.onMounted()` 首先 `refresh()`（`useEditorTabs.ts:167-171`）。
- 普通保存：每次成功快照后全量 refresh。
- Command Palette 新建：create → refresh → open。
- FileTree create/rename/move/delete：组件 emit `refresh`，VaultView 将其接回共享 `refresh()`。
- Restore：`useHistoryRestore` 调共享 `refreshVault()`。
- posts 与 tree 当前总是绑定刷新；没有单独 metadata-only refresh。
- title：打开时从 `post.metadata.title` /兼容 frontmatter读取，保存后不会用 refreshed posts 更新已打开 `tab.title`。正文 H1 改变并不等价于 metadata title 改变。
- size/mtime：StatusBar size 从 posts 派生；保存后 refresh 才更新。`serverMtime` 也从 refreshed post 拷贝。

### 8.2 VaultFileChanges 注入链

生产链确保同一实例：

```text
VaultView.createVaultFileChanges() (VaultView.vue:138)
├─ useEditorTabs({ fileChanges }) (:147)
├─ createVaultContext({ fileChanges }) (:148)
│  └─ provideVaultContext(context) (:149)
├─ useHistory(vaultContext) (:162)
├─ useHistoryRestore({ fileChanges }) (:244-250)
└─ useLinkIndexSubscription(fileChanges)（VaultView 中调用）
```

`useHistory(contextOverride)` 明确从 `context.fileChanges` 创建 Vault-scoped instance（`useHistory.ts:163-172`），不是 fallback。FileTree/Settings/AI 在有 context 时也优先拿 context bus。fallback 仅用于测试或独立挂载兼容。

### 8.3 所有生产调用点

| Producer | 操作 | 发布时间 | event |
| --- | --- | --- | --- |
| `useAiHistory.handleEvent()` (`useAiHistory.ts:272-282`) | AI write/delete/rename | server SSE 已报告 tool mutation 后 | 原样 path/kind/newRaw/newMtime/oldPath；无 `.md` |
| `FileTree.onRename()` (`FileTree.vue:412-426`) | rename 时被连带改写的引用文件 | PATCH 成功后 | `write`；只发布 updatedReferences，不发布主文件 rename |
| `SettingsModal.publishChanges()` (`SettingsModal.vue:80-83`) | Frontmatter cleanup/restore | API 返回 changed 后 | `write` + newRaw/newMtime |
| `useHistoryRestore.restore()` (`useHistoryRestore.ts:108-114`) | Restore | restore API 成功、Tab 同步更新后 | `write` + source/history raw/mtime |

普通 editor save、FileTree create、主文件 rename/move/delete当前均不 publish。

### 8.4 Edit 保存事件的来源与回路隔离要求

当前 `FileChangeEvent.source` 在 `src/lib/ai-api.ts:69-76` 只允许 `'history-restore'`。Edit-02 不能直接发布一个无来源的普通 `write`，因为生产 Vault 中 `useDocumentSave` 与 `useExternalFileChanges` 使用同一个 VaultFileChanges 实例，后者也会消费该事件。

危险时序：

```text
输入 v1 → 发 S1
S1 期间输入 v2（raw=v2, saveStatus=dirty）
S1 成功 → publish write(newRaw=v1)
watch(flush:'post') 稍后执行
→ useExternalFileChanges 把它当外部 write
→ dirty 分支弹覆盖确认
→ 用户确认可能用 v1 覆盖 v2
```

即使没有后续编辑，保存函数先设置 `saveStatus='saved'`，post-flush watcher 随后处理自己的 write，又会在 `useExternalFileChanges.ts:78` 把状态改成 `idle`。不能依赖 `if (tab.saveStatus === 'saving') return`：watcher 执行时保存函数通常已经离开 saving。

因此事件协议必须扩展为：

```ts
source?: 'history-restore' | 'editor-save'
```

Edit 保存成功发布：

```ts
fileChanges.publish({
  path,
  kind: 'write',
  source: 'editor-save',
  newMtime,
})
```

`useExternalFileChanges.applyExternalChange()` 应在通用 saving/dirty/write 逻辑之前处理 acknowledgement：

```ts
if (event.source === 'editor-save') {
  tab.serverMtime = event.newMtime ?? tab.serverMtime
  return
}
```

这只阻止事件反向修改其所属 Tab；History、LinksPanel、LinkIndex 和其他 Vault 派生消费者仍收到同一 seq。`editor-save` 不应携带 `newRaw`：该事件的职责是通知磁盘状态已变化，不是把保存快照镜像回同一个编辑器体系。若未来存在多个独立 Edit producer，仅 `source` 可能不足以区分“本实例自身”与“另一窗口的 editor save”，届时应增加 producer/instance id；当前单 VaultView 协议下 `editor-save` 已是最小方案。

### 8.5 消费者

| Consumer | 行为 |
| --- | --- |
| `useExternalFileChanges` | 更新/冲突提示/删除错误/rename Tab 迁移；History restore source 特判 |
| `useHistory` | 每个新 seq 调 `refreshStatus()`；status request ID 防旧响应覆盖 |
| `useLinkIndexSubscription` | 400ms debounce 后刷新 client link index |
| `LinksPanel` | bus 变化后刷新当前文档链接数据 |
| `useCurrentNote` | 活跃文档收到带 newRaw 的 write/rename 时镜像 AI context |

History 实时刷新断在 producer：Edit 保存从未 publish，consumer 和 Vault 实例注入链是完整的。

### 8.6 useCurrentNote 的实时内容优先级

`useCurrentNote` 的目标是优先读取打开 Tab 的实时内容，包括尚未保存的输入（`useCurrentNote.ts:59-79`）。它还监听 fileChanges，并对活跃 path 上任何带 `newRaw` 的 write 无条件执行 `content.value = e.newRaw`（`:107-127`）。

因此如果 `editor-save` 携带 S1 的 `newRaw=v1`，而保存期间 Tab 已编辑到 v2，事件会把 AI 当前文档上下文回退到 v1。编辑 buffer 本身不丢失，但下一次 AI 请求可能拿到旧上下文；如果 S2 保存失败或没有新的 live-tabs watch 触发，该旧值可能持续存在。

Edit-02 采用最小方案：`editor-save` 事件不携带 `newRaw`。History、LinkIndex、LinksPanel 只需要变化通知即可自行刷新；`useCurrentNote` 因事件没有内容 payload，不会覆盖从 live Tab 得到的 v2。相比在 `useCurrentNote` 增加 source 特判，这让事件语义更清晰，也减少一个消费者分支。

## 9. Findings by Severity

### P0

本次静态审计未发现“仅通过正常 Edit 输入 + 当前 save coordinator”即可稳定造成永久内容丢失的 P0。现有同 path 串行化与 snapshot 基线处理避免了最典型的旧响应覆盖新 buffer。

### P1

#### P1-0 editor-save 事件若无来源隔离会被 Edit 自己重新消费

- 文件/函数：拟修改的 `useDocumentSave.saveLatest`；现有 `useExternalFileChanges.applyExternalChange`；`FileChangeEvent` in `src/lib/ai-api.ts`。
- 触发：Edit-02 在 PUT 成功后发布无来源的 `write`；尤其 S1 期间已经输入 v2。
- 实际：post-flush external watcher 可能弹外部覆盖确认并以 v1 覆盖 v2；无后续编辑时也会把刚设置的 saved 改回 idle。
- 期望：事件标记 `source:'editor-save'`；Edit consumer 只同步 mtime并 return，其他派生 consumers 正常处理。
- 推荐修改边界：扩展共享 event type；在 `useExternalFileChanges` 通用处理之前增加 editor-save acknowledgement 分支；保存 producer 必须显式带 source。
- 后续：Edit-02 的阻塞项，必须与 publish 同时实现和测试，不能先发布后补过滤。

#### P1-1 Rename/Move 与 pending/in-flight Edit save 无统一屏障

- 文件/函数：`FileTree.vue:onRename/onMove/onDropRoot`；`useDocumentSave.saveLatest`；`server/routes/posts.ts:PUT/PATCH`。
- 触发：打开文档正在 queued 或 in-flight save 时从文件树 rename/move（folder cascade 同样成立）。
- 实际：Tab/path 不迁移；queued PUT 404；更窄的服务端 TOCTOU 可在 rename 后重新创建旧路径，或让最终内容依时序变化。
- 期望：同路径 mutation 先 cancel queued、等待/阻止 in-flight，再原子迁移 Tab identity/model/timer ownership，发布 rename。
- 推荐边界：新增 Edit document lifecycle coordinator，FileTree mutation 经 VaultView/VaultContext 请求屏障；不要在 FileTree 内复制 save internals。
- 后续：应处理，建议 Edit-03（Edit-02 先修成功通知和错误边界）。

#### P1-2 Delete 与 pending/in-flight Edit save 无统一屏障

- 文件/函数：`FileTree.vue:onDelete`；`useDocumentSave.saveLatest`；`server/routes/posts.ts:DELETE/PUT`。
- 触发：打开文档存在 queued/in-flight PUT 时删除文件或包含它的 folder。
- 实际：Tab 保留且不收到 delete event；queued PUT 404；已通过 existence check 的 PUT 有机会在 DELETE 后重建旧路径。
- 期望：删除前获取文档 mutation barrier，取消 queued、等待/拒绝 in-flight，关闭或明确标记 Tab，再 publish delete。
- 推荐边界：与 P1-1 同一 lifecycle coordinator + path mutation protocol。
- 后续：应处理，Edit-03。

#### P1-3 Vault 卸载不等待或隔离 in-flight save completion

- 文件/函数：`useEditorTabs.onBeforeUnmount`；`useDocumentSave.disposeDocumentSave/saveLatest`。
- 触发：PUT 已发出时 VaultView 卸载/路由离开。
- 实际：请求继续，闭包仍更新旧 Tab 并可能发起全量 refresh；无法保证新 Vault 实例与旧完成回调隔离（bus 尚未接入所以当前不会污染新 bus）。
- 期望：标记 disposed，禁止完成回调写 UI/refresh；写盘本身可完成。可选使用 AbortController，但不能把 abort 当作服务端未写盘证明。
- 推荐边界：save coordinator lifecycle token/disposed guard。
- 后续：应处理，Edit-03 或 Edit-02 同步加入最小 guard。

### P2

#### P2-1 普通 Edit 保存不发布 VaultFileChanges

- 文件/函数：`useDocumentSave.saveLatest`。
- 触发：自动或手动 PUT 成功。
- 实际：History、client LinkIndex、LinksPanel 等 bus consumers 不刷新；History Changes 需页面/其他操作刷新后出现。
- 期望：仅在确认 PUT 2xx 后发布一次 `{ path, kind:'write', source:'editor-save', newMtime? }`，并明确不得携带 `newRaw`。
- 推荐边界：由 `useDocumentSave` 的成功事务尾部统一 publish；通过 options 注入当前 VaultFileChanges，不能直接用 fallback。
- 后续：Edit-02 必须处理。

#### P2-2 派生 refresh 失败被误报为写盘失败

- 文件/函数：`useDocumentSave.saveLatest` (`:41-65`)。
- 触发：PUT 2xx 后 `refresh()` reject。
- 实际：磁盘和 savedRevision 已成功，UI 变 error/offline；retry 只会变 idle，posts/mtime 仍旧。
- 期望：持久化成功不可被派生 refresh 降级为 save failure；refresh failure 单独记录/重试或 best-effort。
- 推荐边界：拆分 persistence try/catch 与 post-save integration；publish 不应依赖 tree/posts refresh 成功。
- 后续：Edit-02 必须处理。

#### P2-3 保存状态 UI 不能准确显示 in-flight + newer dirty

- 文件/函数：`useDocumentSave.onEditorChange`；`StatusBar.vue`; `VaultView.workspaceTabs`。
- 触发：saving 时继续输入。
- 实际：`saveStatus` 从 saving 变 dirty，尽管 `savingRevision` 非 null；Tab dirty 点只判断 `saveStatus==='dirty'`，StatusBar 只显示未保存。
- 期望：状态可同时表达请求进行中和仍有更新内容；dirty 点基于 revision/baseline，而非单一枚举值。
- 推荐边界：保留现有 revision 字段，增加 computed presentation state 或将 request state 与 dirty 派生分离，无需引入 store 框架。
- 后续：Edit-04 状态反馈任务；不阻塞 Edit-02。

#### P2-4 手动保存不清 queued timer

- 文件/函数：`useDocumentSave.doSaveNow/scheduleSave`。
- 触发：800ms 内 Cmd/Ctrl+S。
- 实际：立即保存后 timer 仍触发一次 no-op `doSave`；通常不重复 PUT。
- 期望：manual save cancel/consume 当前 path debounce，再保存。
- 推荐边界：save coordinator 暴露 `flushPath(path)`。
- 后续：Edit-02 可顺手处理并加测试。

#### P2-5 FileTree 主 mutation 不完整发布事件

- 文件/函数：`FileTree.vue` create/rename/move/delete handlers。
- 触发：用户从文件树变更文件。
- 实际：History/LinkIndex/Edit 只得到 refresh props，bus consumers 不一定更新；rename 只发布被重写的引用文件。
- 期望：成功 mutation 统一发布 create/write/rename/delete（当前 event kind 无 create，可用 write 或扩展协议）。
- 推荐边界：与 lifecycle coordinator 合并，避免组件直接拼事件。
- 后续：Edit-03；不要在 History 补轮询。

#### P2-6 每次保存全量刷新 tree + posts

- 文件/函数：`useDocumentSave.saveLatest` → `useTabWorkspace.refresh`。
- 触发：每个成功保存快照，多 Tab 可并发。
- 实际：两个 GET；tree 结构在正文保存时通常不变，且 refresh failure污染 save state。
- 期望：至少将刷新从持久化成功判定中解耦；是否改为单文档 summary/mtime 响应可后续评估。
- 推荐边界：优先让 PUT 返回 mtime/size 或复用单 post result；结构变化才刷新 tree。
- 后续：性能优化，不必与 Edit-02 强绑定。

#### P2-7 取消关闭后 queued 自动保存不会恢复

- 文件/函数：`useEditorTabs.closeTab/confirmCloseMany`；`useDocumentSave.prepareDocumentClose`；`useTabWorkspace.closeTab/confirmCloseMany`。
- 触发：dirty Tab 已有 800ms timer，用户点击关闭；prepare 阶段清 timer，随后在 dirty confirmation 选择取消。
- 实际：Tab 保留且 dirty，但已无自动保存 timer；除非再次输入或手动保存，否则内容不会自动落盘。批量关闭取消同样受影响。
- 期望：记录进入 close preparation 前哪些 path 有 queued timer；关闭最终取消且 Tab 仍 dirty 时重新 schedule。已经开始的 PUT 仍应等待，不能把 cancel fetch 当成安全回滚。
- 推荐修改边界：让 close preparation 返回可 `commit()` / `rollback()` 的小型 barrier，或返回需要恢复 timer 的 path 集合；由 `useEditorTabs` 在 close 结果确定后完成或恢复。
- 后续：生命周期任务必须处理；也可纳入 Edit-02 的 debounce/close correctness 子任务，但不应与 event publish 混成无测试的顺手修改。

#### P2-8 editor-save 若携带 newRaw 会回退 AI 当前文档上下文

- 文件/函数：拟修改的 `useDocumentSave.saveLatest`；现有 `useCurrentNote` fileChanges watcher (`useCurrentNote.ts:107-127`)。
- 触发：S1 保存 v1 期间继续输入 v2；S1 发布 `editor-save` 且携带 `newRaw:v1`。
- 实际：`CurrentNote.content` 从实时 v2 回退为已保存 v1；AI 后续请求可能读取旧上下文。
- 期望：editor-save 只作为磁盘变化通知，不携带内容 payload；CurrentNote 继续以 live `Tab.raw` 为最高优先级。
- 推荐修改边界：producer 省略 `newRaw`，无需给 `useCurrentNote` 增加特殊分支；增加 CurrentNote 回归测试锁定该协议。
- 后续：Edit-02 必须处理并测试。

## 10. Recommended Minimal Architecture

当前已有 `revision/savedRevision/savingRevision`，不建议再平行引入一套重复 `SaveState`。最小方案是强化现有 `useDocumentSave` 为每文档保存协调器：

```ts
type DocumentSaveRuntime = {
  timer: ReturnType<typeof setTimeout> | null
  chain: Promise<void> | null
  disposed: boolean
}

type SaveSnapshot = {
  path: string
  revision: number
  raw: string
}
```

建议协议：

1. **保存捕获 immutable snapshot**：保留当前 `sentRevision/sentVersion` 做法。
2. **每 Tab/path 独立 debounce**：保留 `Map<path,timer>`；A/B 不互相影响。
3. **同 path 串行**：保留 `savePromises` while loop；不并发 S1/S2。
4. **新编辑保留 dirty**：成功只推进到 snapshot revision；current revision 更大则继续 dirty/queued。
5. **手动保存 flush debounce**：清当前 path timer后进入同一个 serialized `doSave`。
6. **统一成功事务尾部**：
   - PUT 2xx；
   - 更新 snapshot 基线/revisions；
   - 发布 `fileChanges.publish({ path, kind:'write', source:'editor-save', newMtime })`，明确不携带 `newRaw`；
   - posts/tree refresh 独立 best-effort，失败不回滚 saveStatus。
7. **自事件 acknowledgement**：扩展 `FileChangeEvent.source`；`useExternalFileChanges` 对 `editor-save` 不走 dirty confirm/内容覆盖/saveStatus reset，只同步 mtime。该过滤必须先于通用 `saving`/`write` 分支。producer 不携带 `newRaw`，避免 `useCurrentNote` 把实时内容回退到保存快照。
8. **PUT 响应增强（可选但推荐）**：返回 `mtime/size`，减少为更新 serverMtime 而全量 refresh 的需要。若暂不改服务端，可 publish 不带 mtime，之后 best-effort refresh。
9. **关闭/Rename/Delete**：统一暴露可 commit/rollback 的 `prepareDocumentMutation(paths, mode)`；queued 可暂时取消，in-flight 必须 wait。用户取消 close 时 rollback 会为仍 dirty 的 path 恢复 timer；Rename/Delete 成功时 commit，随后迁移或关闭 Tab并 publish。
10. **Restore/Create Version**：复用现有 barrier，不另建第二套锁；可逐步归一到统一 mutation API。
11. **卸载**：cancel timers并设置 disposed；允许已发 PUT 完成，但忽略旧 UI/refresh side effects。

是否抽 `useDocumentSaveCoordinator`：当前 `useDocumentSave` 已经就是该角色，建议改名可延后，Edit-02 不必为命名制造大 diff。是否抽统一 `savePost()` API：建议在 `src/lib/api.ts` 增加 typed `savePost(path, raw)`，让 URL encoding、错误 body 和响应类型统一；但事务编排仍属于 `useDocumentSave`，不能放进纯 API wrapper。

## 11. Proposed Follow-up Tasks

### Edit-02：保存成功事务与 VaultFileChanges 集成

最小修改范围：

- `src/composables/vault/editor-tabs/useDocumentSave.ts`
- `src/composables/vault/editor-tabs/useExternalFileChanges.ts`
- `src/composables/vault/useEditorTabs.ts`（注入 fileChanges）
- `src/lib/ai-api.ts`（扩展 `FileChangeEvent.source`）
- `src/lib/api.ts`（可选 typed `savePost`）
- `server/routes/posts.ts`（仅当响应补 mtime/size；不改变写盘语义）
- 对应 `useEditorTabs` / `useDocumentSave` / `useHistory` integration tests
- `src/composables/vault/__tests__/useCurrentNote.test.ts`（新增实时 v2 不被旧保存快照回退的协议测试；方案 A 下不要求修改 `useCurrentNote.ts`）

验收重点：PUT 2xx 后恰好 publish 一次且 `source='editor-save'`、payload 不含 `newRaw`；PUT 失败不 publish；自身事件不触发外部覆盖确认、不重写 Tab buffer、不把 saved 改回 idle；S1 完成时 v2 buffer 与 `CurrentNote.content` 均保持不变并继续正常保存 S2；refresh 失败不误报 save failure；History 自动 getStatus；manual save 消费 debounce。

### Edit-03：文档生命周期 mutation barrier

覆盖 Rename/Move/Delete/folder cascade/Vault dispose；将 FileTree mutation 与 pending/in-flight saves、Tab path/model 迁移、事件发布接入同一协调边界。

### Edit-04：保存状态展示语义

从 `revision/savedRevision/savingRevision/error` 派生 dirty/inFlight/presentation status，使“正在保存 + 有更新内容”可表达；Tab dirty 点不再仅依赖 `saveStatus==='dirty'`。

### Edit-05：保存元数据刷新优化

评估 PUT 返回 summary/mtime/size，正文保存避免全量 tree refresh；确保并发刷新不覆盖较新 metadata。

## 12. Existing Test Coverage and Gaps

| 场景 | 当前覆盖 | 证据 / 缺口 |
| --- | --- | --- |
| 800ms 自动保存 | 有 | `useEditorTabs.test.ts:618-639`，连续三次输入只 PUT 一次 |
| 手动保存 | 有（基础） | `:360-380`, `:670-688`；缺 manual save 取消/消费 timer 断言 |
| 保存失败 | 有 | `:494` 起；History commit save failure 也覆盖 |
| 保存期间继续编辑 | 有 | `:382-408`，断言 A1/A2 串行并最终 saved |
| 同文档请求乱序 | 由串行测试间接覆盖 | 无“并行 response reorder”测试，因为生产协议不会并行；应增加明确断言第二 PUT 在第一完成前未发 |
| 多 Tab 交替输入 | 无 | 需断言 A/B timers 不互相取消、可独立保存 |
| close 时 pending debounce | 部分 | in-flight close 等待有 `:437-464`；queued debounce 被取消后，取消关闭是否恢复 timer 无覆盖，当前也不会恢复 |
| Vault unmount 时 pending/in-flight | 部分 | bus unsubscribe 有覆盖；save timer cancel/in-flight side-effect isolation 无覆盖 |
| Rename/Delete 时 pending save | 无 | 只有 bus event 后 Editor 行为测试，不覆盖 FileTree mutation 与 Save 协调 |
| Restore 时 pending/in-flight | 部分 | Restore success/duplicate/partial refresh 有覆盖；`prepareHistoryRestore` 与 queued/in-flight save 的集成时序缺失 |
| Create Version save barrier | 有 | `useDocumentSave.historyCommit.test.ts:28-157`，含 click snapshot + barrier 后编辑 |
| 保存成功后 publish | 无，且生产代码不存在 | Edit-02 必加 |
| editor-save 自事件隔离 | 无，event source 尚不支持 | 必须覆盖“不 confirm、不改 buffer、不清 saved” |
| S1 publish(v1) 时保留 v2 | 无 | 必须覆盖 v2 保持 dirty并随后串行保存 S2 |
| CurrentNote 不被旧保存快照回退 | 无 | CurrentNote=v2 收到 editor-save 后仍为 v2；同时断言事件不含 newRaw |
| History 收到 publish 自动刷新 | 现有 History/bus 单元语义有覆盖，但缺 Edit→History integration | Edit-02 必加端到端 composable test |
| PUT 持久化/Frontmatter | 有 | `server/__tests__/put.test.ts:40-129`，验证 raw verbatim、metadata、无 Frontmatter 注入 |
| refresh 乱序 | 有 | `useEditorTabs.test.ts:410-435` |
| PUT 成功但 refresh 失败 | 无 | 当前会误报 error；Edit-02 必加 |

本审计未修改生产代码或测试。建议在 Edit-02 开始前，把上述缺口中的“多 Tab debounce、manual timer、refresh failure、editor-save 自事件隔离、S1 acknowledgement 不覆盖 v2、CurrentNote 实时内容不回退、publish/History integration”作为第一批回归测试；关闭取消后的 timer 恢复进入 lifecycle 测试清单。
