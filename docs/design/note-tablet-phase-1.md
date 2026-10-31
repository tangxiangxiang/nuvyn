# Note Tablet Phase 1：阅读与导航

基准：远程 `main` 的 `245d4c22903785167441eb1047d8e0427602bf63`。本阶段不提交、推送或发布。

## 呈现策略

| CSS 视口宽度 | Note 呈现 |
| --- | --- |
| ≤600px | 保持现有手机导航策略和直接路由能力 |
| 601–899px | 正文单列；左右临时覆盖面板；紧凑图标导航 |
| 900–1199px | 正文单列；左右临时覆盖面板；保留导航文字 |
| ≥1200px | 保持桌面 Grid 布局与持久化侧栏 |

仅 CSS 视口宽度参与判断，不使用 UA 或触摸能力。`workspaceMobileNavigationQuery` 和手机 Note/Board 入口隐藏策略保持不变。

## 状态与数据流

`VaultView` 将“601–1199px、Note scope、工作区 chrome 可见”作为 `useVaultLayout` 的呈现输入。NavBar 与 VaultView 通过同一个模块级来源读取实际呈现状态，而不是各自判断是否打开。

`useVaultLayout` 持有一个互斥的临时抽屉值（left/right/null），以及临时的左右面板内容选择。它们不进入持久化序列化。桌面的 activePanel、左右折叠偏好、宽度和 rightRailTab 继续使用原有数据；平板操作不会覆盖它们。退出平板范围、Note scope、进入 Zen 或卸载所有者时关闭抽屉；返回桌面立即恢复其布局。

平板 Grid 仅保留正文列与可选 StatusBar 行，不为 ActivityBar、面板或 splitter 保留占位。左抽屉宽度为 `min(380px, 85vw)`，右抽屉为 `min(420px, 85vw)`。所有 FileTree、TagPanel、HistoryPanel、RecoveryCenter 和 RightRail 均复用原组件。

支持顶部按钮切换、遮罩关闭、Escape、面板内部 Tab 焦点循环及关闭后返回触发按钮。显式处理 Safari 点击按钮不一定获得焦点的差异。抽屉层级低于现有全局搜索、确认、恢复和 Diary 解锁弹窗，键盘处理仅作用于抽屉或其按钮。

成功打开文档后收起抽屉。TOC 使用 ReadingPane 已发布的导航回调，调用后发出完成事件收起右抽屉；没有第二份目录或 Markdown 渲染。

## 阅读与导航

- 平板导航使用 48px 高的顶部行、至少 40px 的操作按钮；紧凑档隐藏非必要文字，保留可访问名称。
- Tab 栏高度为 44px，单行横向滚动，激活标签滚入可见范围。Preview/Pin、保存状态和数量限制保持原协议。
- Reader 保留现有正文宽度、滚动容器、TOC Scroll Spy 和章节定位机制。没有修改 ReadingPane、Markdown 解析器、文档保存或 Monaco 生命周期。
- 表格、代码块、Flex 与图表控件在其容器内部处理横向溢出；图片和 SVG 保持自适应。没有覆盖 Flex 的 `mobile` 语义。
- 修正全局搜索已有的 Escape 监听问题：外部 host 接管打开快捷键时，仍注册关闭监听；打开快捷键的禁用语义保持不变。
- 保留 Diary 手机覆盖样式对现有 FileTree 的作用，兼容新增的 `display: contents` 包装层。

## 验证

浏览器测试使用真实认证、Note API 和 Reader，测试数据仅写入 Playwright 配置的隔离临时 Vault。覆盖十个要求的视口、768/1024 交互、九个固定标签滚动、搜索层级、Files/Tags/History、Preview/Pin、目录定位、桌面状态恢复、Monaco Model 身份、表格/代码/图片、Mermaid/MarkMap、Flex、Include/Snippet、Board 静态预览、任务列表和章节折叠。

复现命令：

```powershell
npm run typecheck
npm run build
npm run test:unit -- --maxWorkers=2
npm run test:e2e -- --config=playwright.note-tablet.config.ts
git diff --check
```

Windows Playwright WebKit 是引擎回归，不等同于真实 iPad Safari。未执行 iPad/Android 真机、软键盘、触控笔或系统长按菜单验证。

### 验证记录（2026-10-27）

| 检查 | 真实结果 |
| --- | --- |
| `npm run typecheck` | 通过，客户端与服务端 |
| `npm run build` | 通过 |
| 受影响的 7 组单元测试 | 167 通过 |
| 最后整理模板后的 Vault/Diary wiring 复验 | 52 通过 |
| 完整 `test:unit -- --maxWorkers=2` | 5342 通过，34 失败，13 跳过；共 5389 项 |
| Chromium 相关回归 | 28 通过：Note 平板、Preview/Pin、Diary 响应式、Zen |
| 手机工作区导航完整套件 | 5 通过：包括直接 Note/Board、Diary/Ledger 入口 |
| 最终 WebKit 平板套件 | 14 通过：全部十个视口、长链路交互、九标签与富内容 |
| `git diff --check` | 通过 |

全量单测没有全绿，失败位于未修改的 8 组服务器测试：`server/board/storage.test.ts`、`server/routes/markdownResources.test.ts`、`server/routes/noteImages.test.ts`、`server/__tests__/attachments.test.ts`、`server/__tests__/attachmentTrash.test.ts`、`server/attachments/catalog.test.ts`、`server/__tests__/paths.test.ts`、`server/__tests__/round17Closure.test.ts`。日志包含 Windows 创建 symlink 的 EPERM、附件身份/存储校验和附件回收 crash fixture 前置检查失败；本阶段没有修改相关服务器逻辑。完整证据保存在工作区 `.tablet-unit-final.log`。

开发服务器在部分现有及新增浏览器流程中记录了 `ResizeObserver loop completed with undelivered notifications`；上述交互断言全部通过，但不将这些日志等同于“无运行时告警”。本阶段未重写图表或 Monaco 的 ResizeObserver。

Chromium 和 WebKit 的 768/1024 阅读、左导航、右目录截图分别位于 `test-results/note-tablet-*chromium/` 和 `test-results/note-tablet-webkit/note-tablet-*webkit/`。最终浏览器日志为 `.tablet-chromium-final.log`、`.tablet-mobile-navigation.log`、`.tablet-webkit-final.log`，定向单元日志为 `.tablet-unit-layout-final.log`；均为未跟踪的本地验证产物。

## 文件清单

- `src/lib/workspace.ts`：Note 平板媒体查询。
- `src/composables/vault/useVaultLayout.ts`：共享临时抽屉、桌面隔离、单列 Grid。
- `src/views/VaultView.vue`：呈现输入、复用面板包装、遮罩、焦点和导航完成关闭。
- `src/components/NavBar.vue`：读取真实面板状态并标记平板导航样式。
- `src/components/vault/EditorTabs.vue`：激活标签滚入可见区域。
- `src/components/vault/RightRail.vue`：TOC 导航完成事件。
- `src/components/vault/CommandPalette.vue`：外部打开模式下保留 Escape。
- `src/style.css`：仅 Note 平板的抽屉、触摸尺寸与内容约束；兼容 Diary 原有选择器。
- `src/composables/vault/__tests__/useVaultLayout.test.ts`：状态共享、互斥与持久化隔离。
- `src/components/vault/__tests__/RightRail.test.ts`：目录回调及关闭事件条件。
- `src/components/vault/__tests__/CommandPalette.test.ts`：关闭与打开快捷键隔离。
- `src/views/__tests__/VaultView.test.ts`：适配共享布局状态并规范化 CRLF 源码读取。
- `e2e/helpers/edit-program.ts`：不再依赖默认展开的 ActivityBar 判断启动完成。
- `e2e/note-preview-tabs.spec.ts`：通过平板现有按钮打开导航后执行原触摸测试。
- `e2e/note-tablet.spec.ts`：平板边界、交互和富内容回归。
- `playwright.note-tablet.config.ts`：Chromium/WebKit 双引擎入口。
- 本文档：实现与验证记录。

## Phase 2 边界

Monaco 软键盘、IME、触控笔、系统长按菜单与更完善的触屏固定标签交互留待 Phase 2。未新增手势系统或常驻/浮动模式，未改变 Diary、Ledger、Board 业务策略。

## 后续修订（2026-10-31）

统一平板的全局导航表现：601–899px 的 Note 不再隐藏 Nuvyn 品牌文字及 Note / Diary / Ledger / Board 标签；Diary Calendar 在 601–900px 也保留文字。手机端（≤600px）继续使用紧凑图标导航。较窄 Note 平板的 Workspace 导航可局部横向滚动，右侧操作按钮始终保留在视口内。该修订仅影响导航 CSS 和回归测试，不改变 Phase 1 的 Note 单列、抽屉、阅读、编辑和数据协议。

## 文件树简化（2026-10-31）

Note 平板模式的 FileTree 移除“已打开文档”区域，仅保留搜索与目录树。文件树选择依然可以打开/切换文档；切回桌面时仍恢复此前保留的多标签。此次只是取消平板的 UI 入口，不改变底层多标签、保存或草稿恢复协议。真正的手机/平板单文档状态策略将在单独实现与验证后启用。
