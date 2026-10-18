# Nuvyn Document Export V2 — 核心设计

**状态：** V2.1 / V2.2 implemented（V2.2 边界和验证记录见第 10 节）

**日期：** 2026-10-18

**模块：** Note / Vault

## 1. 产品定位

Nuvyn 的文档导出不再以 PDF 为中心，而是由三种格式承担不同职责：

| 格式 | 目的 | 重要性 |
| --- | --- | --- |
| Markdown | 保留原始内容、编辑和迁移 | P0 |
| HTML | 保留排版、独立阅读和分享 | P1 |
| PDF | 固定版式和打印 | 保留现有功能 |

**Markdown 保留内容，HTML 保留呈现，PDF 固定页面。**

## 2. 统一导出入口

文件树右键中的「导出 PDF」改为「导出…」。

点击后可选择 Markdown、HTML 或 PDF，不向编辑器顶部增加额外按钮。

分阶段交付：V2.1 仅显示 Markdown 和 PDF 两种可用格式，不提供 HTML 占位按钮。Managed Diary 保留原有「导出 PDF」入口，不进入格式选择框。

V2.2 已增加可用的 HTML 格式；默认选项仍为 Markdown，Managed Diary 继续只提供原有 PDF。

## 3. Markdown 导出

直接下载文档的原始 Markdown 文本。

- 保留 Frontmatter 和 Nuvyn 扩展语法。
- 优先使用未保存的编辑器内容。
- 不展开 Include，不转换 Flex，不重新格式化。
- 使用原始文件名。
- 单文件导出不包含图片、附件和 Board 数据。

## 4. HTML 导出

默认生成可离线阅读的独立 HTML 文件。

- 保留 Flex、Callout、Shiki、KaTeX 等阅读效果。
- Mermaid 和 MarkMap 转换为静态 SVG。
- Board 嵌入转换为静态预览。
- 受支持的本地图片和样式内嵌。
- 不依赖 Nuvyn API、登录、NAS 或在线 CDN。
- 不包含可执行 JavaScript 或用户会话信息。
- 不允许静默丢失图片或重要内容后仍报告成功。

## 5. 实施范围

第一期只扩展普通 Note 的单篇文档导出。

暂不增加 managed Diary 的 Markdown/HTML 导出，保持现有加密边界。Ledger 的 JSON 导出保持不变。

不做文件夹批量导出、完整 Vault 备份或附件 ZIP。

## 6. 分阶段实现

### V2.1 — Markdown Export

实现统一导出入口、原始 Markdown 下载和共享源快照。优先交付并独立验收。

### V2.2 — HTML Export

实现静态化渲染、资源内嵌、自包含 HTML、离线安全验证和真实浏览器测试。

### 后续阶段

根据使用需求，再评估 Markdown + Assets ZIP、HTML + Assets ZIP 与批量导出。

## 7. 成功标准

用户能够将一篇 Note 以可编辑的 Markdown、可离线阅读的 HTML 或现有 PDF 格式带离 Nuvyn，同时不破坏源文档、不泄露内部资源，也不影响原有功能。

## 8. 下一步

以下保留 V2.1 时的阶段决策；V2.2 的实施记录见第 10 节。

先实现 V2.1 Markdown Export，不同时推进 HTML。

Markdown 导出可以最大程度复用现有 `VaultView.vue` 的源数据读取逻辑，修改范围小，作为统一导出体系的第一步。

HTML 则需要认真处理图片、字体、Board 快照和离线安全，不适合仓促实现。

V2.1 已实现；下一阶段仅在单独确认后推进 V2.2 HTML。

## 9. V2.1 实施记录（2026-10-18）

- 基线：`98a0912`；文件树事件为 `TreeRow → FileTree → VaultView`，始终携带用户选中的精确逻辑路径。
- 普通 Note 使用 Naive UI 格式选择框，仅提供 Markdown/PDF，默认 Markdown；支持键盘、Esc、焦点恢复和移动端宽度。导出中禁用重复提交；失败保留选择框以便重试。
- `DocumentExportSnapshot` 包含只读 `path/raw/title/filename`，返回冻结对象。已加载且无加载错误的目标 Tab 优先使用 `tab.raw`（空字符串也是有效缓冲区）；否则调用已认证的 `getPost(path)`，不创建可见 Tab。
- Markdown 直接使用原文构造 `text/markdown;charset=utf-8` Blob，不展开 Include、不解析 Frontmatter、不修改换行、不强制保存、不打包附件。
- 文件名基于原始 basename，保留 Unicode 和空格；替换常见非法字符，处理 Windows 保留设备名，限制扩展名前的 UTF-8 长度为 200 字节。空名称回退 `nuvyn-document.md`；已有 `.md` 不重复添加。
- 下载临时链接立即移除；成功触发下载的 ObjectURL 保留 60 秒后释放，以兼容 Safari 的异步消费时序。未触发或点击失败时立即释放 URL。
- PDF 复用共享源快照，继续调用既有 `PdfExportSurface → widgets/images settlement → preparePdfArticleHtml → downloadPdfDocument`；PDF 命名、渲染引擎、分页和样式不变。下载工具仅增加可选的 `beforeDownload` 生命周期回调：异步生成后、触发浏览器下载前再次校验 Session/请求代次，防止生成期间锁定 Diary 后继续下载。
- Markdown 编排与下载函数双重拒绝 managed Diary。原有 Diary PDF 入口和 Session 检查保留；锁定、认证失效或卸载会作废尚未完成的源读取及 UI 事务，过期响应不能启动下载。
- 未修改 Markdown Parser、附件管理、Board 生命周期、Diary 加密协议、Ledger、数据库或 Docker/CI Workflow。HTML、ZIP 和批量导出不在本次实施范围。

### 验证记录

- Chromium：`npm run test:e2e -- e2e/document-export.spec.ts e2e/document-export-diary.spec.ts e2e/pdf-export.spec.ts e2e/pdf-export-flex.spec.ts e2e/pdf-export-layout.spec.ts e2e/pdf-export-pagination.spec.ts e2e/pdf-export-long-document.spec.ts --project=chromium` — 20 项通过，包括真实下载、未保存缓冲区逐字比对、错误重试、移动端焦点、Diary 源读取取消和画布生成期间锁定，以及 Kitchen Sink/Flex/布局/分页/1–50 页级长文档回归。
- WebKit：`npm run test:e2e -- --config=playwright.pdf-compat.config.ts --project=webkit` — 10 项通过（Markdown 4 项，PDF/Flex 6 项）。不等同于真实 Safari/真机完整验收。
- `npm run test:history-integration` — 5 文件、183 项通过；`npm run test:recovery-integration` — 5 文件、198 项通过。
- 完整测试中同步修正一条此前单行代码标记引入后过期的 Shiki 测试断言：验证实际嵌套代码元素及语言，不再要求 `class="shiki"` 字符串完全相等；未修改解析器。
- `npm run test:unit -- --maxWorkers=1` — 最终 348 文件通过，5181 项通过、9 项既有跳过、0 失败（共 5190 项）；未新增跳过或重试。
- `npm run typecheck`、`npm run build`、`git diff --check` — 通过。构建仍有既有第三方 PURE 注释/包体积提示，不影响退出状态。
- Markdown 四项测试在采用正式 Include/Snippet/Board 引用语法后，另在 Chromium 和 WebKit 各复验 4 项通过，保留实际下载逐字节比较。

### 限制与人工验收

- Markdown 仅为文本文件，不包含引用资源；HTML 尚未实现。
- 已检查移动端导出框截图和实际生成的 PDF 页面。真实 macOS/iOS Safari 的系统下载行为仍需人工验收。
- WebKit PDF 任务出现了部分无堆栈的 `Event` / `Load failed` 未处理拒绝日志，所有功能与布局断言通过；本次未将其定性为已修复问题，也未扩大范围修改 PDF 资源加载器。

### 修改文件范围

| 文件 | 目的 |
| --- | --- |
| `src/lib/documentExport.ts` | 共享原文快照、Markdown 权限、文件命名、Blob 下载及 URL 清理 |
| `src/composables/vault/useDocumentExport.ts` | 格式选择事务、重复提交保护、重试与生命周期作废 |
| `src/components/vault/DocumentExportDialog.vue` | Naive UI Markdown/PDF 选择框 |
| `src/views/VaultView.vue` | 文件树入口、共享快照和既有 PDF 链路接线及 Session/卸载防护 |
| `src/components/vault/TreeRow.vue`、`src/components/vault/FileTree.vue` | 精确路径事件转发、菜单名称及焦点恢复；Diary 保留 PDF |
| `src/composables/useI18n.ts` | 新增中英文导出文案 |
| `src/lib/pdfExport.ts` | 仅新增可选最终下载前生命周期检查；渲染参数与布局不变 |
| `src/lib/__tests__/documentExport.test.ts`、`src/composables/vault/__tests__/useDocumentExport.test.ts`、`src/components/vault/__tests__/DocumentExportDialog.test.ts` | 新能力单元测试 |
| `src/lib/__tests__/pdfExport.test.ts`、`src/views/__tests__/VaultView.test.ts`、`src/components/vault/__tests__/context-menu.test.ts` | 既有 PDF/菜单接线及下载前取消回归 |
| `src/lib/__tests__/markdownContainers.test.ts` | 更新已过期的 Shiki 严格类字符串断言 |
| `e2e/document-export.spec.ts`、`e2e/document-export-diary.spec.ts` | 原文真实下载、编辑状态、移动端和 Diary 安全回归 |
| `e2e/helpers/document-export.ts`、`e2e/helpers/pdf-export.ts` | 复用真实格式选择流程 |
| `e2e/pdf-export.spec.ts`、`e2e/pdf-export-flex.spec.ts`、`e2e/pdf-export-layout.spec.ts`、`e2e/pdf-export-pagination.spec.ts`、`e2e/pdf-export-long-document.spec.ts` | 仅更新入口操作，保留 PDF 内容/几何/分页断言 |
| `playwright.pdf-compat.config.ts` | 复用已有 WebKit 项目运行 Markdown 下载测试 |
| `docs/design/document-export-v2-prd.md`、`docs/user-guide/editor.md` | 产品边界、实现及验证记录、用户说明 |

### V2.2 前置事项

HTML 仍需单独实现静态 SVG/Board 快照、本地图片与字体内嵌、离线资源完整性、安全策略及无 API/CDN 依赖的真实浏览器验收；V2.1 的共享源快照只是原文入口，不代表已实现这些能力。

## 10. V2.2 实施记录（2026-10-19）

### 架构与安全边界

- 复用 V2.1 精确目标路径、冻结源快照、未保存缓冲区优先级、单事务 busy、错误重试和格式框焦点恢复。HTML 格式在捕获源、构建文件和最终下载阶段均受普通 Note 权限及认证/取消代次保护。
- `HtmlExportSurface` 按需加载，使用现有 `RenderedMarkdown` / `useMarkdownRender` 在独立、真实宽度、Light Theme 离屏面渲染，不触碰 Reader/Monaco，也不强制保存或打开目标 Tab。
- HTML 使用自己的响应式阅读样式和显式变量。仅按结构选取现有受控 Flex/通知卡片规则，并复用 Shiki 规则及其可信 token CSS；没有把整个应用 CSS 或 PDF/A4 分页规则复制进文件。
- `staticDocumentSnapshot.ts` 提取既有 Mermaid/MarkMap 静态规范化和 Code Group 展开助手。PDF 继续使用原来的入口、参数、图片策略、命名和分页；HTML 不调用 `preparePdfArticleHtml()`。HTML 的 MarkMap 另按真实图形包围盒收紧 viewBox，避免手机上保留大块交互画布空白。
- 普通图片在插入离屏 DOM 前放入 inert template 并移除活动 `src`；之后只接受规范化且受认证的 `/api/markdown-resources?kind=image&path=…`、安全 base64 data URL、当前 Board 预览 Blob。拒绝远程图片，不主动下载任意 URL。按规范资源 URL 去重、串行读取、校验 MIME/签名及实际解码，保留原始图片字节。
- SVG 校验核心从 `server/noteSvg.ts` 提取到 `shared/noteSvg.ts`：规则与限制不变，只将 Buffer 字节操作改为标准 Uint8Array/TextEncoder/DataView。服务端原路径继续以 Buffer 包装并重新导出同一错误类。HTML 中的本地、data URL、Board SVG 全部使用同一策略，没有新增较宽松的上传 SVG 白名单。
- 已渲染 Mermaid/MarkMap 的 SVG 单独进行结构审计，保留受控的 XHTML 富标签、MathML 和静态图形；只复制必要的生成绘制样式，移除脚本、动画、交互工具栏和运行时元数据。上传 SVG 不因此获得 foreignObject 权限。
- HTML 导出专用 MarkMap 使用既有解析器、应用本地 KaTeX/Shiki，关闭该分支的 CDN 插件自动加载；Reader/PDF 原插件链不变。KaTeX CSS 中的 WOFF2 字体读取自已捆绑的可信资源并全部内嵌，离线不访问 `/assets/`。
- WebKit 对 SVG foreignObject 中相对定位的 KaTeX HTML 有实际绘制偏移（client rect 仍正常）。HTML 的静态图表副本保留 KaTeX 生成的完整语义 MathML，移除该处重复的 HTML 定位层；正文 KaTeX、Reader 和 PDF 不变。此分支通过实际截图复核，不只检查元素存在。
- 文内有效 `#anchor` 和脚注链接保留；Wiki/Vault 链接降为不可导航的可读内容。普通 HTTP(S) 链接仅供用户主动打开，去除凭证 URL 并规范化安全 rel。
- 最终文件有 HTML5 doctype、charset、viewport、转义标题、固定 Light Theme、内联 CSS、article 及离线 CSP。下载前重新解析并审计完整文件；禁用 script/connect/frame/object/base/form，只允许 data 图片/字体和必要内联样式。不复制 Cookie、认证 token、CSRF 或内部组件状态。

### 容量与生命周期

| 边界 | 实际限制 |
| --- | --- |
| 单图片 | 沿用 20 MiB；SVG 沿用 8 MiB 静态策略 |
| 资源数 | 每次 128 个不同资源，包含字体 |
| 异步图表/Board | 初始渲染前最多 32 个 |
| 初始渲染元素 | 最多 100,000 个 |
| 资源字节总量 / 最终文件 | 分别最多 64 MiB / 64 MiB UTF-8 |
| 单资源及 widget 等待 | 最多 15 秒 |
| HTML 总事务 | 最多 45 秒，包含源快照与渲染 |

Include/Snippet 继续受已有 256/512 KiB 单资源、2 MiB 展开、8 层深度限制。达到限制、资源缺失/403/500、无效 SVG、解码失败或重要 widget 出错时，整个 HTML 导出失败，不静默丢内容或降质。

离开 Workspace、认证失效、卸载会取消等待和资源请求、清除观察器/定时器并移除离屏面。每次离屏请求有独立 key，避免快速取消/重试复用上轮组件。下载链接立即移除；下载成功的 Blob URL 按现有 Safari 兼容策略在 60 秒后释放，未下载即失败时立即释放。

### 已知边界与人工验收

- 只支持普通 Note 的单篇 HTML，不增加 managed Diary HTML、批量、ZIP 或 Vault 备份，不修改 Ledger 或附件生命周期。
- 静态导出不是 Reader 的逐像素截图，也没有交互图表运行时；Code Groups/Details 在导出副本中全部展开。
- base64 图像 data URL 受同样 MIME/签名/SVG 校验。MarkMap 的图片标签目前拒绝导出；Mermaid 源中含资源/外部 URL 的保守预检也会拒绝。可将本地 Markdown 图片置于图表旁。失败会保留格式选择框，不会伪装为成功。
- WebKit 的 transport `offline: true` 会使 `file://` 自身报 internal navigation error，已用独立浏览器调用复现。WebKit 文件验收改为阻断所有 HTTP(S)；Chromium 同时启用 offline 标志与 HTTP(S) 阻断。两者都打开真正下载的文件，而不是 `setContent()`。
- WebKit 自动化不等于 macOS/iOS Safari 真机验收。既有 WebKit PDF/Flex 任务仍输出部分无堆栈 `Event` / `Load failed` 日志；HTML 离线页面没有脚本错误或 HTTP(S) 资源请求。本次未声称修复 PDF 的这些日志。

### 修改文件范围

| 文件 | 目的 |
| --- | --- |
| `src/lib/htmlExport.ts` | HTML 静态构建、图表内容边界、结构审计、CSP、下载前复检 |
| `src/lib/htmlExportResources.ts` | URL 权限、去重、原始字节、解码、SVG 共用策略、容量/超时/取消 |
| `src/lib/htmlExportStyles.ts` | 独立响应式 Light 样式、可信 Flex/通知/Shiki 子集及内嵌 KaTeX 字体 |
| `src/lib/staticDocumentSnapshot.ts`、`src/lib/pdfExport.ts` | 提取并复用静态快照小助手，保留 PDF 业务契约 |
| `shared/noteSvg.ts`、`server/noteSvg.ts` | 共用原 SVG 安全核心，保留服务端 Buffer API |
| `src/components/vault/HtmlExportSurface.vue`、`src/composables/vault/useHtmlDocumentExport.ts` | 独立按需离屏面及有界请求生命周期 |
| `src/composables/vault/useDocumentExport.ts`、`src/lib/documentExport.ts`、`src/views/VaultView.vue` | 现有导出事务接线、认证取消及 HTML 格式支持 |
| `src/components/vault/DocumentExportDialog.vue`、`src/composables/useI18n.ts` | 在现有选择框增加中英文 HTML 选项 |
| `src/components/vault/RenderedMarkdown.vue`、`src/composables/vault/useMarkdownRender.ts` | 仅离线分支启用图片惰性授权和复杂度预检 |
| `src/components/MarkMap.vue`、`src/lib/offlineMarkmap.ts`、`src/composables/useMarkmapMount.ts`、`src/composables/useMermaidMount.ts` | 离线图表安全预检与本地解析资源；普通 Reader/PDF 不改行为 |
| `src/lib/__tests__/htmlExport.test.ts`、`src/lib/__tests__/offlineMarkmap.test.ts`、`src/composables/vault/__tests__/useHtmlDocumentExport.test.ts` | HTML 安全、字节、失败、取消、时限及本地 MarkMap 单元测试 |
| `src/composables/vault/__tests__/useDocumentExport.test.ts`、`src/components/vault/__tests__/DocumentExportDialog.test.ts` | HTML 事务、认证代次、重试及中英文选项回归 |
| `e2e/html-export.spec.ts`、`e2e/document-export.spec.ts`、`e2e/helpers/document-export.ts`、`playwright.pdf-compat.config.ts` | 真下载/断网 file://、移动几何、资源失败与既有导出回归 |
| `docs/user-guide/editor.md`、本文档 | 当前使用方法、限制、架构及验收记录 |

### 最终验证（2026-10-19）

- `npm run typecheck`、`npm run build`、`git diff --cached --check`：通过。构建保留第三方 PURE 注释、包体积及 PostCSS 的 Node 内置模块浏览器外置警告；未将这些警告报告为已修复。
- `npm run test:unit -- --maxWorkers=1`：351 个文件通过，5227 项通过、9 项既有跳过、0 失败（共 5236 项）。未新增跳过或 retries。
- 定向运行 `htmlExport`、`pdfExport`、`offlineMarkmap`、`useDocumentExport`、`useHtmlDocumentExport`、`server/noteSvg`：6 文件、95 项通过。
- `npm run test:e2e -- e2e/html-export.spec.ts e2e/document-export.spec.ts e2e/document-export-diary.spec.ts e2e/pdf-export.spec.ts e2e/pdf-export-flex.spec.ts --project=chromium`：25 项通过、0 失败，覆盖 HTML 11 项、Markdown 4 项、Diary PDF 3 项及 PDF/Flex 7 项。
- `npm run test:e2e -- --config=playwright.pdf-compat.config.ts --project=webkit`：21 项通过、0 失败，覆盖 HTML 11 项、Markdown 4 项及既有 PDF/Flex 6 项。未增加测试 timeout、retries 或跳过。
- 两个浏览器均验证真正下载的独立文件、阻断 HTTP(S) 后的资源完整性，以及 1440/768/375px 几何。人工检查 Chromium/WebKit 截图，确认静态 MarkMap 公式在对应节点旁、代码底色、Board、SVG 和 Flex 响应式正常；这不替代真实 Safari 真机验收。
- 验证为上述本地任务，不代表整个 GitHub Actions CI、NAS 部署或真实系统下载行为已经验收。
