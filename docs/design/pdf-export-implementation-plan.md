# Nuvyn PDF Export Implementation Plan

## 1. 文档信息

| 项目                           | 内容                                                     |
| ---------------------------- | ------------------------------------------------------ |
| 文档状态                         | PDF-H10 audit DONE；post-H10 H6 pagination follow-up verified；PDF Export V1 implemented and verified |
| 产品 PRD                       | [`docs/design/pdf-export-prd.md`](./pdf-export-prd.md) |
| Original hardening baseline | `4e62bba441eb2ac7c426485154fd1226caa0edbf`             |
| Original H10 audit baseline | `77445cfe415a0e40937c6a00edfd914aae4ca576`             |
| Core PDF pagination/export baseline | `352a47b34b5ffc8da0489210b2c81037cbb3b37a`             |
| Final verified V1 application baseline | `390791da4acefcdc58f110e66f469224c18feeeb`             |
| 计划日期                         | 2026-08-21                                             |
| 当前阶段                         | PDF-H10 — Final Documentation & Release Gate           |
| 当前实现状态                       | H1–H9 implementation complete；H4 evidence repaired；post-H10 H6 pagination regression verified；H10 release gate re-confirmed |
| 最终 UI scope                     | File Tree context menu only；Reading Pane 不包含 PDF Export UI |
| 目标                           | 让文档、真实实现、既有验证证据和 PRD acceptance criteria 保持一致 |

本文回答：

> PDF Export 接下来具体改什么、按什么顺序改、每一步修改哪些文件、如何验证、什么时候才允许宣布 PDF Export V1 Done。

产品行为以：

```text
docs/design/pdf-export-prd.md
```

为最高约束。

如果 Implementation Plan 与 PRD 冲突：

```text
STOP
→ 修订 PRD
→ review
→ 再继续 implementation
```

不得为了实现方便自行改变产品语义。

---

# 2. 本计划不重新讨论的冻结决策

以下决策已经由 PDF Export PRD 确定。

实现阶段不得重新打开为临时技术选择。

| 主题                        | 冻结决策                                                 |
| ------------------------- | ---------------------------------------------------- |
| 导出目标                      | 当前 Markdown document                                 |
| 输出格式                      | `.pdf`                                               |
| PDF engine                | Browser-side `html2pdf.js` / `html2canvas` / `jsPDF` |
| Paper                     | A4                                                   |
| Orientation               | Portrait                                             |
| Print dialog              | 不使用 `window.print()`                                 |
| Open document authority   | 当前 live tab buffer                                   |
| Closed document authority | authoritative server document                        |
| Save behavior             | 导出不得强制保存                                             |
| Theme                     | PDF 固定 printable light theme                         |
| Markdown                  | 复用 Nuvyn 当前 renderer                                 |
| Mermaid                   | 必须导出 static representation                           |
| MarkMap                   | 必须导出 static representation                           |
| Math                      | KaTeX 最终渲染结果进入 PDF                                   |
| Async widgets             | 必须 explicit settled，不能依赖 sleep                       |
| Export concurrency        | 同时最多 1 个                                             |
| Render surface            | offscreen real-layout surface                        |
| Security                  | 不放宽 DOMPurify / URI policy                           |
| Remote PDF API            | 不允许                                                  |
| Server Chromium           | V1 不采用                                               |
| PDF custom options UI     | V1 不做                                                |
| Multi-document PDF        | V1 不做                                                |
| PDF Import / Editor       | V1 不做                                                |

实施阶段如发现 browser-side architecture 无法满足 V1 correctness，应记录 architecture ceiling，并另立 RFC。

不得直接在本阶段切换到 server Chromium。

---

# 3. 当前基线状态

Original implementation baseline：

```text
4e62bba441eb2ac7c426485154fd1226caa0edbf
```

Original H10 audit baseline：

```text
77445cfe415a0e40937c6a00edfd914aae4ca576
```

Final verified PDF Export V1 baseline：

```text
390791da4acefcdc58f110e66f469224c18feeeb
```

当前仓库已经拥有：

```text
html2pdf.js
PdfExportSurface
RenderedMarkdown
pdfExport.ts
VaultView PDF orchestration
File Tree → Export PDF
Mermaid explicit state
MarkMap explicit state
Mermaid static SVG normalization
MarkMap static SVG normalization
PDF filename resolution
PDF light document stylesheet
Kitchen Sink fixture
PDF helper tests
PDF browser E2E
```

H1–H7、H9 hardening commits 和 H4 focused evidence repair 已完成；H8 的 Read Mode 入口决定已按最终 V1 scope 移除。原始 H10 release gate 在 `77445cfe…` 关闭后，真实导出的 PDF 又暴露了普通段落分页的 correctness regression；该问题由后续 H6 focused follow-up 在 `352a47b…` 修复并通过 focused browser regression 与真实 PDF 人工复验。当前最终 release gate 已重新确认关闭。

---

# 4. 已完成能力盘点

## 4.1 PDF transaction（Final implementation snapshot）

当前基本链路：

```text
File Tree context menu only
    ↓
exportPdfDocument(path)
    ↓
resolve source raw
    ↓
PdfExportRequest
    ↓
PdfExportSurface
    ↓
RenderedMarkdown
    ↓
waitForPdfWidgets
    ↓
waitForPdfImages
    ↓
preparePdfArticleHtml
    ↓
downloadPdfDocument
    ↓
html2pdf.js
    ↓
browser download
```

该共享 pipeline 当前由 File Tree context menu 唯一调用。

---

## 4.2 Source authority

当前已实现：

```text
open + loaded tab
→ tab.raw
```

否则：

```text
getPost(path)
→ post.raw
```

这一设计符合 PRD。

后续不得改回：

```text
always getPost()
```

否则会丢失用户未保存编辑。

---

## 4.3 MarkMap P0（DONE）

原有风险：

```text
<svg> exists
→ incorrectly treated as ready
```

当前已经修正为：

```text
pending
→ setData
→ fit
→ stable layout
→ ready
```

并通过：

```text
data-markmap-state
data-markmap-ready
data-markmap-error
```

暴露生命周期。

因此 PDF-H3 的统一 readiness contract 已把 MarkMap 的 `ready|error` 作为 settled，SVG 存在性不再单独决定 readiness。后续只保留 regression，不重新设计。

---

## 4.4 Mermaid readiness（DONE）

Mermaid 当前同样有：

```text
pending
ready
error
```

PDF waiter 已使用 explicit state。

继续保留。

---

## 4.5 Kitchen Sink fixture

当前已有：

```text
e2e/fixtures/pdf-export-kitchen-sink.md
```

覆盖：

* Frontmatter title；
* H1；
* 中文；
* English；
* 日本語；
* Emoji；
* paragraph；
* bold；
* italic；
* inline code；
* link；
* task list；
* blockquote；
* callout；
* code block；
* table；
* inline math；
* display math；
* Mermaid；
* MarkMap；
* local image；
* footnote。

该 fixture 作为后续 PDF regression fixture。

不得删除或退化成简单 demo。

---

# 5. Historical gap register and resolution status

以下 gap register 保留早期 `4e62bba…` hardening baseline 的设计背景。它不再表示当前 open work；GAP-3 已由 H4 focused browser repair 解决，详见 PDF-H10。

| Historical gap | Resolution | Current status |
| --- | --- | --- |
| GAP-1 — PDF render surface 未固定 Light Theme | PDF-H1：`PdfExportSurface` 使用 light render theme，global app theme 不变 | Resolved by H1 |
| GAP-2 — KaTeX 没有 explicit settled contract | PDF-H2/H3：Math 使用 `pending → ready\|error`，统一 waiter 只在 settled 后继续 | Resolved by H2/H3 |
| GAP-3 — Kitchen Sink 未证明内容完整 | PDF-H4：验证 source `data-mermaid-viewbox` 与 prepared static Mermaid finite `viewBox`，并保留 live `viewBox` optional | Resolved by H4 |
| GAP-4 — Image settlement 未定义 | PDF-H5：`waitForPdfImages()` 等待 `loaded\|error\|timeout` 后再准备 snapshot | Resolved by H5 |
| GAP-5 — Long document 未形成正式验证 | PDF-H6/H7：A4 layout、短段落/列表项分页保护、oversized textual fallback、1/5/20/50 页级验证和尾部/恢复性检查 | Resolved by H6/H7 + post-H10 H6 follow-up |
| GAP-6 — Read Mode 入口未补齐 | 最终产品决定不在 Read Mode 增加 PDF UI；File Tree context menu 保持唯一入口 | Removed from V1 scope |

---

# 6. Final architecture snapshot

最终目标：

```text
File Tree context menu
     ↓
Capture immutable PdfExportRequest
     ↓
Resolve authoritative source
     ↓
PdfExportSurface
renderTheme = light
     ↓
RenderedMarkdown
     ↓
┌─────────────────────────────┐
│ standard Markdown rendered  │
│ KaTeX settled               │
│ Mermaid settled             │
│ MarkMap settled             │
│ images settled              │
└─────────────────────────────┘
     ↓
preparePdfArticleHtml()
     ↓
static PDF snapshot
short textual blocks keep together;
genuinely oversized blocks may split
     ↓
html2pdf.js
     ↓
download
     ↓
finally cleanup
```

核心原则：

```text
visible reader state
≠
PDF export rendering context
```

但：

```text
Markdown semantics
==
PDF export semantics
```

---

# 7. Work Package 总览

最终 work package 状态如下：

| Work Package | Priority | 内容 | Status |
| ------------ | -------- | ----- | ------ |
| PDF-H1       | P0       | Export Light Theme isolation | DONE |
| PDF-H2       | P0       | Math explicit readiness | DONE |
| PDF-H3       | P0       | Unified settled validation regression | DONE |
| PDF-H4       | P0/P1    | Kitchen Sink browser correctness | DONE |
| PDF-H5       | P1       | Image settlement | DONE |
| PDF-H6       | P1       | Pagination + wide content | DONE |
| PDF-H7       | P1       | Long-document validation | DONE |
| PDF-H8       | P1       | Read Mode export entry（历史候选） | REMOVED FROM V1 SCOPE |
| PDF-H9       | P2       | Extreme/stress/browser compatibility | DONE |
| PDF-H10      | Release  | Final docs + DoD | DONE |

执行顺序不得随意颠倒。

特别是：

```text
H1
→ H2
→ H3
→ H4
```

必须优先于新增 UI。

---

# 8. PDF-H1 — Export Light Theme Isolation

Priority：

```text
P0
```

## 8.1 目标

PDF hidden render surface 中：

```text
Markdown
KaTeX
Mermaid
MarkMap
```

全部在：

```text
light
```

export context 下完成。

无论用户当前：

```text
light
dark
```

PDF 结果一致。

---

## 8.2 禁止方案

禁止：

```ts
setTheme('light')
await exportPdf()
setTheme(previous)
```

因为它会：

* 修改全局用户状态；
* 触发 visible Mermaid/MarkMap rebuild；
* 产生 UI 闪烁；
* 引入 export/theme toggle race；
* 可能污染 local storage；
* 违反“导出不得改变当前 UI 状态”。

---

## 8.3 推荐方案

为 Markdown enhancement 增加**局部 render theme override**。

建议：

```text
PdfExportSurface
      ↓
renderTheme="light"
      ↓
RenderedMarkdown
      ↓
useMermaidMount
useMarkmapMount
      ↓
Mermaid / MarkMap
      ↓
effectiveTheme
```

正常 Reader：

```text
renderTheme = undefined
→ follow global useTheme()
```

PDF：

```text
renderTheme = light
→ ignore global dark theme
```

---

## 8.4 `RenderedMarkdown.vue`

增加：

```ts
renderTheme?: 'light' | 'dark'
```

但默认：

```ts
undefined
```

保证正常 Reader 不改变行为。

调用：

```text
useMermaidMount(...)
useMarkmapMount(...)
```

时将 optional override 传下去。

不要创建：

```text
generic rendering context framework
```

当前只需要一个最小 theme override。

---

## 8.5 `useMermaidMount.ts`

当前：

```ts
createApp(Mermaid, { code })
```

改为概念上：

```ts
createApp(Mermaid, {
  code,
  renderTheme,
})
```

正常 caller 不传值。

---

## 8.6 `useMarkmapMount.ts`

同样：

```ts
createApp(MarkMap, {
  content,
  renderTheme,
})
```

---

## 8.7 `Mermaid.vue`

Props：

```ts
code: string
renderTheme?: 'light' | 'dark'
```

定义：

```text
effectiveTheme =
  renderTheme
  ?? global theme
```

后续所有：

```text
targetTheme
theme watch
rerender
```

必须基于：

```text
effectiveTheme
```

而不是直接基于 global `theme.value`。

---

## 8.8 `MarkMap.vue`

同样增加：

```text
effectiveTheme
```

包括：

```text
palette selection
theme-change rebuild
```

都基于 effective theme。

PDF：

```text
light forever
```

因此全局 Dark/Light toggle 不应导致 offscreen PDF widget 在 export transaction 中被重建。

---

## 8.9 `PdfExportSurface.vue`

明确：

```vue
<RenderedMarkdown
  ...
  render-theme="light"
/>
```

这应该成为 PDF light policy 的唯一入口。

---

## 8.10 H1 Tests

### Mermaid component

增加：

```text
global dark + renderTheme light
→ Mermaid uses default/light theme
```

以及：

```text
renderTheme undefined
→ still follows global theme
```

---

### MarkMap component

增加：

```text
global dark + renderTheme light
→ light palette
```

并验证：

```text
normal reader theme toggle
→ existing behavior preserved
```

---

### PdfExportSurface

验证它明确传入：

```text
light
```

而不是依赖当前 App theme。

---

## 8.11 H1 Definition of Done

```text
Dark App
→ export
→ light Mermaid
→ light MarkMap
→ light PDF
```

且：

```text
global theme unchanged
```

---

# 9. PDF-H2 — KaTeX Explicit Readiness

Priority：

```text
P0
```

---

## 9.1 目标

Math 和 Mermaid / MarkMap 一样，拥有正式 settled contract：

```text
pending
ready
error
```

---

## 9.2 `useMathMount.ts`

当前 marker：

```text
data-math-mounted
```

继续保留用于：

```text
duplicate-scan guard
```

新增：

```text
data-math-state
```

生命周期：

```text
before katex.render
→ pending

katex.render success
→ ready

katex error / katex-error
→ error
```

---

## 9.3 KaTeX malformed source

PRD 不要求 malformed math 阻止整个 PDF。

所以：

```text
math error
```

属于：

```text
settled
```

而不是：

```text
PDF transaction failure
```

也就是说：

```text
ready OR error
→ exporter can continue
```

---

## 9.4 `VaultView.pdfWidgetsReady()`

增加：

```text
Math
```

正式检测。

建议：

```text
for every .math-mount
    state ∈ { ready, error }
```

否则：

```text
return false
```

---

## 9.5 `waitForPdfWidgets()`

MutationObserver：

增加：

```text
data-math-state
```

attribute filter。

禁止：

```text
setTimeout(50)
```

等固定 sleep。

---

## 9.6 Math tests

扩展：

```text
src/composables/__tests__/useMathMount.test.ts
```

至少：

### success

```text
pending
→ ready
```

### invalid TeX

```text
pending
→ error
```

### duplicate scan

第二次 scan：

```text
不重新 render
state 保持
```

---

## 9.7 H2 Definition of Done

```text
PDF settled =
Markdown ready
AND Math settled
AND Mermaid settled
AND MarkMap settled
```

---

# 10. PDF-H3 — Settled Contract Regression

Priority：

```text
P0
```

H1 / H2 完成后，需要正式固定一份 PDF enhancement readiness contract。

---

## 10.1 Settled 状态

统一产品语义：

```text
ready
error
```

都是：

```text
settled
```

而：

```text
pending
missing state
placeholder still present
```

都是：

```text
not settled
```

---

## 10.2 Mermaid

必须满足：

```text
data-mermaid-state=ready|error
```

---

## 10.3 MarkMap

必须满足：

```text
data-markmap-state=ready|error
```

禁止回归：

```text
querySelector('svg')
→ ready
```

---

## 10.4 Math

必须满足：

```text
data-math-state=ready|error
```

---

## 10.5 Placeholder guard

如果仍存在：

```text
.mermaid-mount
.markmap-mount
```

说明 enhancer 尚未 mount。

必须：

```text
not ready
```

Math 如果仍存在没有 mounted/state 的 placeholder：

同样：

```text
not ready
```

---

## 10.6 Timeout

维持 bounded timeout。

Baseline：

```text
5 seconds
```

暂时继续采用。

只有 browser evidence 证明正常内容稳定超过 5 秒，才允许调整。

不得因为偶发测试失败直接增加：

```text
5s → 15s → 30s
```

掩盖 readiness bug。

---

# 11. PDF-H4 — Kitchen Sink Browser Correctness

Priority：

```text
P0/P1
```

它是 PDF V1 宣布 Done 前的 release blocker。

---

## 11.1 当前不足

仅验证：

```text
PDF > 10KB
```

不等于内容正确。

---

## 11.2 第一层：Export Surface Assertions

在浏览器中对：

```text
.pdf-export-surface
```

进行真实观察。

在 surface 被清理之前至少证明：

### Text

包含：

```text
PDF Export Kitchen Sink
中文
English
日本語
Emoji
```

### Code

存在：

```text
Hello PDF
```

### Table

存在：

```text
A / B / C
1 / 2 / 3
```

### KaTeX

存在：

```text
.katex
```

并且：

```text
data-math-state
```

已经 settled。

### Mermaid

必须：

```text
data-mermaid-state=ready
```

且有：

```text
svg
valid viewBox
```

### MarkMap

必须：

```text
data-markmap-state=ready
```

且有：

```text
svg
root <g>
no NaN
```

### Image

local `/logo.svg`：

```text
complete = true
naturalWidth > 0
```

---

## 11.3 第二层：Static normalization unit tests

继续使用：

```text
src/lib/__tests__/pdfExport.test.ts
```

证明：

```text
interactive DOM
→ prepared static HTML
```

正确。

必须覆盖：

### Mermaid

```text
toolbar removed
pan transform removed
original viewBox restored
```

### MarkMap

```text
toolbar removed
fit transform restored
viewport converted to viewBox
```

### Heading grouping

```text
heading + diagram
```

进入：

```text
.pdf-heading-group
```

### Image grouping

image-only section：

```text
heading + image paragraph
```

同组。

---

## 11.4 第三层：Final download

继续验证：

```text
download occurred
filename correct
file non-empty
window.print never called
```

---

## 11.5 是否立即引入 PDF parser

P0 不建议为了测试加入新的大型：

```text
pdfjs
PDF parser
raster comparison stack
```

除非现有测试无法建立足够 correctness evidence。

V1 可以采用组合证据：

```text
real browser rendered surface
+
static normalization unit tests
+
real PDF download
```

以后如引入 stable PDF parser：

再添加：

```text
PDF text extraction
page count
visual snapshot
```

作为 P2。

---

# 12. PDF-H5 — Image Settlement

Priority：

```text
P1
```

---

## 12.1 目标

在 snapshot 前确保：

```text
所有 image
```

已经达到：

```text
loaded
or
failed
```

而不是：

```text
loading
```

---

## 12.2 新增 helper

建议在：

```text
src/lib/pdfExport.ts
```

或 PDF-specific composable/helper 中实现：

```text
waitForPdfImages(article)
```

不要放入普通 Markdown renderer。

---

## 12.3 Image algorithm

对于每个：

```html
<img>
```

### Already loaded

```text
complete=true
naturalWidth>0
→ ready
```

### Already failed

```text
complete=true
naturalWidth=0
→ settled error
```

### Loading

等待：

```text
load
error
timeout
```

---

## 12.4 Broken image policy

单张 broken image：

```text
不得导致整个 PDF failure
```

它属于：

```text
settled error
```

正文继续。

---

## 12.5 Same-origin image

是 V1 mandatory。

Kitchen Sink：

```text
/logo.svg
```

必须进入测试。

---

## 12.6 Remote CORS image

如果资源：

```text
CORS-compatible
```

best effort included。

如果：

```text
no CORS
```

不能：

```text
allowTaint=true
```

绕过 browser security。

---

# 13. PDF-H6 — Pagination 和 Wide Content

Priority：

```text
P1
```

---

## 13.1 Heading orphan

继续验证：

```text
Heading
Diagram
```

以及：

```text
Heading
Image
```

不会轻易被拆开。

---

## 13.2 Code block

添加：

```text
very long line
multiline block
```

验证：

```text
wrap
not horizontally clipped
```

---

## 13.3 Wide table

增加 fixture：

```text
8–12 columns
long cell
mixed CJK
```

目标：

```text
fit printable width
```

不能：

```text
silent right-side clipping
```

---

## 13.4 Oversized block

测试：

```text
block height > one A4 page
```

必须确认：

```text
break-inside: avoid
```

不会导致：

```text
element disappear
huge blank page
```

---

## 13.5 Mermaid oversized

至少增加：

```text
tall graph
wide graph
```

验证：

```text
viewBox remains valid
```

---

## 13.6 MarkMap oversized

增加：

```text
deep tree
wide sibling tree
```

验证：

```text
no NaN
not clipped
```

---

# 14. PDF-H7 — Long Document Validation

Priority：

```text
P1
```

---

## 14.1 Test levels

正式验证：

```text
1 page
5 pages
20 pages
50 pages
```

100 页放 P2。

---

## 14.2 Fixture strategy

不要提交一个巨大的：

```text
50-page markdown fixture
```

推荐：

```text
small deterministic section
× N
```

在 test 内生成。

例如：

```text
SECTION-001-BEGIN
...
SECTION-001-END

...

SECTION-050-BEGIN
...
SECTION-050-END
```

---

## 14.3 Browser validation

至少确认：

```text
export completes
first marker rendered
middle marker rendered
last marker rendered
download generated
page remains responsive
```

---

## 14.4 不设置脆弱时间阈值

不要立即写：

```text
must finish < 5s
```

CI hardware 不稳定。

先记录：

```text
duration diagnostics
```

观察真实数据后再决定是否设 performance budget。

---

## 14.5 Architecture ceiling

如果发现：

```text
20 pages stable
50 pages unstable
```

需要记录：

```text
browser-side ceiling
```

然后决定：

```text
optimize current pipeline
```

还是未来：

```text
server PDF RFC
```

不能直接在 Hardening commit 内换架构。

---

# 15. PDF-H8 — Read Mode Export Entry（Historical / Removed from V1 scope）

Priority：

```text
P1
```

状态：`REMOVED FROM V1 SCOPE`。Read Mode PDF action 曾在 hardening 期间实现，但最终产品要求是阅读窗口零污染，因此该入口已移除。共享 exporter 保持不变，File Tree context menu 是 V1 唯一用户入口。

---

## 15.1 当前函数命名

早期 baseline 曾有 tree-specific naming；当前真实实现为：

```text
exportPdfDocument(path)
```

---

## 15.2 Entry architecture

最终入口必须是：

```text
File Tree context menu
        ↓
exportPdfDocument(path)
```

禁止在 Read Mode 增加 PDF button、busy state、PDF props 或 PDF event。禁止为不同 UI 入口复制 exporter implementation。

---

## 15.3 Final Read Mode boundary

Read Mode 最终行为：

```text
Reading Pane
→ no PDF Export UI
```

ReadingPane 不接收 `showPdfExport` / `exportingPdf`，不 emit `export-pdf`，不包含 PDF 专用 CSS 或 icon。File Tree 仍调用同一个 `exportPdfDocument(path)`。

---

# 16. PDF-H9 — Stress / Compatibility

Priority：

```text
P2
```

内容包括：

* 100-page stress；
* extreme Mermaid；
* extreme MarkMap；
* extremely wide table；
* huge code block；
* many images；
* many KaTeX formulas；
* Playwright WebKit compatibility；
* image CORS matrix；
* high-DPI memory behavior。

这些不是 P0 blocker。

但如果其中发现：

```text
data loss
blank PDF
browser crash
```

则需要重新提升 priority。

---

# 17. PDF-H10 — Final Documentation & Release Gate

Priority：

```text
Release
```

PDF-H10 不是新的 PDF 产品能力，也不是新的 renderer 或 export pipeline 阶段。

它只在 PDF-H1 至 PDF-H9 的实现、验证和 review 都完成后执行，负责把真实实现、PRD acceptance criteria、最终验证证据和用户文档收敛为一个可审计的 release gate。

当前 H10 状态：

```text
DONE
```

Original H10 audit baseline：

```text
77445cfe415a0e40937c6a00edfd914aae4ca576
```

Final verified PDF Export V1 baseline：

```text
390791da4acefcdc58f110e66f469224c18feeeb
```

原始 H10 audit 不重新运行 H1–H9 全矩阵；H4 focused browser repair 已验证 source canonical geometry 与 prepared static geometry，且未修改 production code。`e2e/pdf-export.spec.ts:254` 的 live `viewBox` 要求已改为 optional；source `data-mermaid-viewbox` 和 prepared static `viewBox` 现在是正式 evidence。

随后真实导出的 PDF 暴露了普通 paragraph 在 A4 page boundary 被 glyph 中间切开的 H6 correctness regression。该 post-H10 follow-up 只修改 PDF pagination implementation 和对应 focused regressions；`352a47b…` 之后通过 dedicated pagination browser E2E、真实 browser download 和实际 PDF 人工检查，最终重新确认 H10 release gate。此次文档更新不声称 H1–H9 全矩阵在 `352a47b…` 之后重新执行。

---

## 17.1 Entry condition

进入 H10 前必须确认：

```text
H1 complete
H2 complete
H3 complete
H4 browser evidence complete
H5 complete
H6 complete
H7 complete
H8 scope decision complete
H9 complete
```

H10 不得被用来掩盖任何尚未完成的 H1–H9 correctness work。

如果任一 required gate 仍然失败：

```text
STOP
→ 不标记 PDF Export V1 Done
→ 返回对应的 H1–H9 work package
→ 修复并重新验证
```

---

## 17.2 Final documentation update

在最终真实实现已经稳定后，更新：

### `docs/user-guide/editor.md`

补齐 PDF Export 的最终用户行为，包括：

* 用户从哪里触发 Export PDF；
* 导出使用当前 live buffer 还是 authoritative server document；
* 导出不会强制保存；
* 导出的文件格式、默认文件名和下载行为；
* Mermaid、MarkMap、KaTeX、图片和分页的用户可见结果；
* 导出失败时用户看到的行为。

用户指南只能描述已经在生产实现中验证过的行为，不得提前承诺 H1–H9 尚未完成的能力。

### `docs/design/pdf-export-implementation-plan.md`

根据最终真实实现更新：

* 当前 implementation baseline；
* PDF-1 / PDF-2 historical status and H1–H10 final status；
* 各 H1–H9 work package 的完成状态；
* Test Matrix 和 Phase Gate 的结果；
* 最终 release evidence；
* `PDF Export V1 = Done` 是否成立。

如果实现仍有未关闭的 requirement，必须保留真实的 `TODO`、`Partial` 或未完成状态，不得为了关闭文档而改成完成。

---

## 17.3 PRD acceptance audit

逐项对照：

```text
docs/design/pdf-export-prd.md
```

至少核验以下 acceptance categories：

| Acceptance area | Required evidence |
| --- | --- |
| Direct PDF download | browser download succeeds with the expected `.pdf` filename |
| Live buffer authority | dirty open document exports current `tab.raw` without forced save |
| Closed document authority | closed document exports authoritative server content |
| Markdown fidelity | headings, text, lists, code, tables, task lists, callouts and footnotes are present |
| Unicode | Chinese, English, Japanese and Emoji remain readable |
| KaTeX | inline and display math are settled and present |
| Mermaid | widget reaches an explicit settled state and static representation is present |
| MarkMap | widget reaches an explicit settled state and static representation is present |
| Theme isolation | Dark Mode in Nuvyn produces a printable Light PDF without changing global theme state |
| Images | local image settlement and the documented failure policy are verified |
| Pagination | A4 portrait output preserves headings, code, tables and wide content across pages |
| Failure handling | timeout or widget failure does not produce a misleading successful export |
| Cleanup | export surface, observers and busy state are cleaned up after success and failure |
| Concurrency | at most one export transaction is active and duplicate activation is rejected or disabled |

任何 acceptance criterion 如果缺少真实证据，都不能在 H10 中被推断为通过。

---

## 17.4 Final verification evidence

Release evidence 至少汇总：

```text
typecheck
unit tests
integration tests
browser E2E
Kitchen Sink
Dark Mode → Light PDF
KaTeX
Mermaid
MarkMap
local image
pagination
long document
failure cleanup
```

证据必须记录实际执行的 command、结果和必要的 fixture / browser context。不能只用：

```text
download event happened
PDF file size > 10KB
```

代替内容正确性证明。

---

## 17.5 Cleanup and release decision

在宣布 V1 完成前，确认生产代码和导出 transaction 没有残留：

* temporary export DOM；
* stale observer；
* unresolved widget waiter；
* busy state；
* debug hooks；
* test-only production code；
* hidden test harness 被误当成正式入口。

如果 release gate 发现 PRD acceptance criteria 尚未满足：

```text
PDF Export V1 != Done
```

必须返回对应的 H1–H9 work package，完成修复、测试和 review 后重新进入 H10。

只有全部 required gate 通过，并且文档与证据已经和真实实现一致，才能写入：

```text
PDF Export V1 = Done
```

H10 本身不得增加新的 PDF 产品能力、custom options、multi-document export、PDF editor 或其它 V1 scope 之外的工作。

---

## 17.6 Final architecture snapshot

```text
File Tree context menu
                  ↓
          exportPdfDocument(path)
                  ↓
       immutable PdfExportRequest
                  ↓
             source authority
          ┌───────┴────────┐
          │ open tab.raw   │
          │ getPost(path)  │  closed document
          └───────┬────────┘
                  ↓
            PdfExportSurface
            renderTheme=light
                  ↓
          RenderedMarkdown
                  ↓
     Math / Mermaid / MarkMap settled
                  ↓
             Images settled
                  ↓
       preparePdfArticleHtml()
                  ↓
        A4 printable static layout
                  ↓
               html2pdf.js
                  ↓
                Download
                  ↓
                Cleanup
```

当前实现的关键事实：打开且已加载的文档使用 `tab.raw`，不强制保存；未打开文档通过 `getPost(path)` 读取 authoritative server raw；File Tree context menu 调用 `exportPdfDocument(path)` transaction。Reading Pane 不参与 PDF UI 或事件 wiring。

---

## 17.7 Final work package result summary

| Work package | Final result |
| --- | --- |
| H1 | `PdfExportSurface` 使用 light render theme；global app theme 不被修改 |
| H2 | Math 使用 `pending → ready\|error`，error 属于 settled |
| H3 | Math、Mermaid、MarkMap 统一使用 explicit settled contract；SVG 存在性不是 readiness |
| H4 | Kitchen Sink 内容、Unicode、代码、表格、KaTeX、MarkMap、图片和下载证据已加入；source canonical `data-mermaid-viewbox` 与 prepared static finite `viewBox` 均通过 |
| H5 | `waitForPdfImages()` 在 `preparePdfArticleHtml()` 前等待图片 terminal outcome；CORS policy 不放宽 |
| H6 | A4 printable geometry、宽表、长代码和 oversized block layout 已验证；短 paragraph/list item keep-together、oversized textual fallback、heading + first content block orphan protection 及真实分页回归已通过（post-H10 follow-up: `352a47b…`） |
| H7 | 1/5/20/50 页级长文档验证已通过 |
| H8 | Read Mode PDF action 已移出 V1；File Tree 保持唯一 PDF UI 入口 |
| H9 | 100-page stress、极端 widget、CORS、Playwright WebKit、Chromium DPI2 和 post-export UI recovery 已验证 |
| H10 | 文档、acceptance audit、evidence matrix 和 DoD 已收口，release gate DONE |

---

## 17.8 Final PRD Acceptance Audit

以下状态基于 H1–H7、H9 已有执行记录、H4 focused repair、post-H10 H6 pagination follow-up、H8 scope correction 和当前代码审计；本次文档收尾不重复运行整套验证。

| Requirement | Evidence | Status |
| --- | --- | --- |
| Direct PDF download / `.pdf` / no print dialog | `e2e/pdf-export.spec.ts` | PASS |
| File Tree entry | `TreeRow.vue` context action；`src/components/vault/__tests__/context-menu.test.ts` | PASS |
| Reading surface has no PDF export control | `src/components/vault/__tests__/ReadingPane.test.ts`；`src/views/__tests__/VaultView.test.ts` | PASS |
| Live dirty buffer, no forced save | `VaultView.vue` source authority branch and existing workspace behavior | PASS |
| Closed document authority | `VaultView.vue` `getPost(path)` fallback | PASS |
| Immutable snapshot / duplicate guard | `PdfExportRequest` and `pdfExportBusy` in `VaultView.vue` | PASS |
| Filename priority and sanitization | `resolvePdfDocumentLabel()` / `sanitizePdfFileName()` in `src/lib/pdfExport.ts` | PASS |
| Markdown basics, code, tables, tasks, callouts, footnotes | Kitchen Sink browser snapshot in `e2e/pdf-export.spec.ts` | PASS |
| Chinese, English, Japanese, Emoji | Kitchen Sink browser snapshot | PASS |
| KaTeX | `data-math-state`, `.katex`, H9 many-math lane | PASS |
| Mermaid explicit state and static normalization | H3 readiness tests and `preparePdfArticleHtml()` tests | PASS |
| Mermaid Kitchen Sink browser geometry evidence | source `data-mermaid-viewbox` + prepared static `.pdf-mermaid > svg[viewBox]` | PASS |
| MarkMap explicit state and static normalization | H3 readiness tests and `preparePdfArticleHtml()` tests | PASS |
| Local images | H5 delayed-image E2E and H9 many-images lane | PASS |
| Remote image CORS policy | `e2e/pdf-export-cors.spec.ts` same-origin / ACAO / no-ACAO matrix | PASS |
| Printable light theme | H1 tests and dark-app browser evidence | PASS |
| A4 portrait and wide-content behavior | `e2e/pdf-export-layout.spec.ts` | PASS |
| Pagination and long documents | `e2e/pdf-export-long-document.spec.ts` 1/5/20/50-page lanes | PASS |
| Paragraph pagination regression | `src/lib/__tests__/pdfExport.test.ts` + `e2e/pdf-export-pagination.spec.ts` + manual real-PDF verification | PASS — focused post-H10 H6 follow-up |
| Failure cleanup and retry state | VaultView `finally` cleanup and existing export tests | PASS |
| Single active export transaction | `pdfExportBusy` guard and File Tree context action | PASS |
| 100-page stress | `e2e/pdf-export-stress.spec.ts` | PASS |
| WebKit compatibility | `e2e/pdf-export-compat.spec.ts` with `playwright.pdf-compat.config.ts` | PASS — Playwright WebKit only |
| High-DPI stability | dedicated Chromium `deviceScaleFactor=2` project | PASS |
| Security | DOMPurify path retained; `useCORS=true`, `allowTaint=false`; no server PDF | PASS |

Audit total：

```text
PASS: 25
BLOCKED: 0
FAIL: 0
```

H4 evidence now distinguishes live interactive geometry from the canonical static PDF geometry.

---

## 17.9 Final release evidence matrix

这些是 H1–H9 阶段已经执行的 release evidence；本次不重新运行：

| Area | Evidence / command record | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | PASS |
| PDF unit regressions | `pdfExport.test.ts`, `pdf-readiness.test.ts`, `pdf-images.test.ts`, `pdf-export-h9.test.ts`；47 tests | PASS |
| Integration / orchestration | `src/views/__tests__/VaultView.test.ts` and existing export seams | PASS — prior phase evidence |
| Kitchen Sink | `npm run test:e2e -- e2e/pdf-export.spec.ts --reporter=line`；2/2 tests | PASS |
| Layout | `e2e/pdf-export-layout.spec.ts` | PASS |
| Paragraph pagination | `src/lib/__tests__/pdfExport.test.ts` + `e2e/pdf-export-pagination.spec.ts` + manual real-PDF verification | PASS |
| Long documents | `e2e/pdf-export-long-document.spec.ts` | PASS |
| PDF entry scope | File Tree context-menu coverage + ReadingPane no-PDF regression | PASS |
| H9 stress | `e2e/pdf-export-stress.spec.ts`；7/7 lanes | PASS |
| CORS | `e2e/pdf-export-cors.spec.ts`；3/3 lanes | PASS |
| Compatibility | `e2e/pdf-export-compat.spec.ts`；WebKit 1/1 | PASS |
| High DPI | `e2e/pdf-export-compat.spec.ts`；Chromium DPI2 1/1 | PASS |
| Static normalization | `src/lib/__tests__/pdfExport.test.ts` | PASS |

WebKit wording仅为：

```text
Playwright WebKit compatibility verified
```

不等同于真实 Apple Safari matrix verified。

---

## 17.10 Residual V1 limitations and non-goals

以下是 V1 scope boundary，不是当前 bug：

* 不提供 custom paper size、landscape UI 或 custom margin UI；
* 不提供 header/footer、watermark、PDF merge、batch export、PDF editor/import；
* 不提供 server-side PDF 或 PDF/A；
* remote images 继续受浏览器 CORS policy 约束；
* Playwright WebKit evidence 不代表完整真实 Safari matrix；
* V1 不要求 PDF binary text extraction 或 pixel-perfect visual diff；
* 100-page-scale stress validation 不代表任意文档大小都得到保证。

报告的 paragraph clipping regression 已通过实际导出的 reproduction PDF 人工打开检查；该人工验证不等同于 automated pixel-level raster diff。

在已验证的 H9 矩阵中没有发现 data loss、blank PDF、browser crash、OOM 或永久 busy state，因此没有识别出 correctness-level browser architecture ceiling；这不构成 unlimited-size guarantee。

---

## 17.11 H10 Definition of Done

```text
[x] PRD acceptance criteria 已完成逐项审计
[x] File Tree context menu 是唯一 PDF Export UI 入口
[x] live buffer / closed document authority 已记录
[x] user guide 已更新为最终用户行为
[x] H1、H2、H3、H5、H6、H7、H9 release evidence 已汇总；H8 scope decision 已记录
[x] Reading Pane 零 PDF UI；对应 production wiring、CSS 和 regression tests 已收口
[x] residual limitations / non-goals 已记录
[x] H4 Kitchen Sink browser evidence 完整通过
[x] ordinary paragraph page-clipping regression 已修复并通过 focused regression
[x] list-item pagination contract 和 oversized textual fallback 已验证
[x] heading + first content block orphan protection 已验证
[x] 实际 reproduction PDF 已人工检查，没有 half-glyph clipping
[x] PDF Export V1 = Done
```

最终决定：

```text
PDF-H10 = DONE
PDF Export V1 = DONE
```

H4 evidence、post-H10 H6 pagination follow-up 和 H10 documentation are complete. The release gate was re-confirmed after the `352a47b…` pagination fix. Do not enter PDF-H11 or PDF Export V2 as part of this task.

---

## 17.12 Post-H10 Pagination Correctness Follow-up

原始 H10 audit 在 `77445cfe…` 关闭后，用户在真实导出的 PDF 中发现普通正文可能被 A4 page boundary 从 rendered glyph 中间切开。该问题属于 H6 pagination correctness regression，不是新的产品阶段。

Root cause：普通 `<p>` / `<li>` 尚未纳入 PDF keep-together 与 oversized-fallback contract。

Focused fix：

* short paragraph / list item 使用 `break-inside: avoid`；
* paragraph / list item 纳入 oversized block classification；
* 真正高于 printable A4 page 的 block 使用 `.pdf-allow-split` 继续跨页；
* PDF clone 中 heading 与 first ordinary content block 组合，减少 heading orphan；
* A4 geometry、font size、line-height、PDF engine、widget/image readiness contract 均未改变。

Evidence：

* `src/lib/__tests__/pdfExport.test.ts` 覆盖 styles、short/oversized paragraph 和 list item，以及 heading grouping；
* `e2e/fixtures/pdf-export-pagination.md` 与 `e2e/pdf-export-pagination.spec.ts` 通过真实 File Tree → Export PDF 流程验证 boundary geometry、prepared DOM 和真实 download；
* 实际 reproduction PDF 已人工打开检查，未再观察到 half Chinese glyph、half English glyph 或 line-box bisect。

最终 verified baseline：

```text
390791da4acefcdc58f110e66f469224c18feeeb
```

该 follow-up 没有重新执行完整 H1–H9 matrix；它只重新确认 H6 pagination regression 和最终 release gate 所需的直接证据。

## 17.13 Final PDF UI entry-scope correction

H8 期间曾加入 Read Mode PDF action，但最终产品要求是“阅读窗口零污染”。`390791da4acefcdc58f110e66f469224c18feeeb` 移除了该入口及其专用 wiring、CSS、组件回归和 Read Mode E2E。

最终用户入口只有：

```text
File Tree → right-click Markdown document → Export PDF
```

`ReadingPane.vue` 不接收 PDF props、不 emit PDF event、不显示 PDF busy/loading 状态，也不包含 PDF 专用 UI。`exportPdfDocument(path)`、live-buffer authority、busy guard 和整个 PDF exporter pipeline 保持不变。

# 18. Historical File-Level Change Map（pre-H1 planning）

本节保留早期 implementation plan 的预计文件范围。这里的“计划”不是当前 TODO；H1–H9 已按后续提交完成。原始 H10 提交只更新文档：`docs/design/pdf-export-prd.md`、`docs/design/pdf-export-implementation-plan.md`、`docs/user-guide/editor.md`；没有 source 或 test change。随后用户发现真实分页 correctness regression，`352a47b…` 的 post-H10 H6 follow-up 才修改了 `src/lib/pdfExport.ts`、对应 unit test 和 dedicated pagination E2E；本次 final docs follow-up 只记录该历史并刷新 release baseline。

预计主要涉及以下文件。

---

## `docs/design/pdf-export-implementation-plan.md`

新增本文。

---

## `docs/README.md`

增加：

```text
PDF Export V1 Implementation Plan
```

入口。

---

## `src/components/vault/PdfExportSurface.vue`

计划：

* 固定 PDF render theme 为 light；
* 不修改全局 theme；
* 保持 offscreen real layout。

---

## `src/components/vault/RenderedMarkdown.vue`

计划：

* optional `renderTheme`；
* 传递给 Mermaid / MarkMap enhancer；
* 不影响普通 caller。

---

## `src/composables/useMermaidMount.ts`

计划：

* 接收 optional render theme；
* createApp 时传给 Mermaid。

---

## `src/composables/useMarkmapMount.ts`

计划：

* 接收 optional render theme；
* createApp 时传给 MarkMap。

---

## `src/components/Mermaid.vue`

计划：

* 增加 optional renderTheme；
* 引入 effective theme；
* export surface 可固定 light；
* normal reader 保持当前 global theme behavior。

---

## `src/components/MarkMap.vue`

计划：

* 增加 optional renderTheme；
* palette 使用 effective theme；
* theme remount watch 使用 effective theme。

---

## `src/composables/useMathMount.ts`

计划：

* 增加 `data-math-state`；
* ready/error contract；
* 保留原有 mounted marker。

---

## `src/views/VaultView.vue`

计划：

* readiness 增加 Math；
* image settlement；
* 后期重命名 export entry function；
* 保持 immutable request。

---

## `src/lib/pdfExport.ts`

计划：

* image settlement helper（如果最终落在这里）；
* static normalization；
* pagination；
* image / diagram export hardening。

---

## `src/components/__tests__/MarkMap.test.ts`

继续覆盖：

* explicit ready；
* error；
* renderTheme override；
* normal theme switch regression。

---

## Mermaid tests

增加：

* forced light override；
* normal global theme behavior。

---

## `src/composables/__tests__/useMathMount.test.ts`

增加：

* math pending / ready；
* math error；
* duplicate scan state。

---

## `src/lib/__tests__/pdfExport.test.ts`

继续覆盖：

* static Mermaid；
* static MarkMap；
* image heading grouping；
* wide content normalization；
* cleanup。

---

## `e2e/pdf-export.spec.ts`

升级为：

```text
Kitchen Sink browser correctness test
```

而不仅是 download smoke test。

---

## `e2e/fixtures/pdf-export-kitchen-sink.md`

保留为稳定 regression fixture。

除非 PRD 改变，不应随意删减 feature coverage。

---

# 19. Historical Recommended Commit Sequence

建议不要再把所有 hardening 塞进一个大 commit。

推荐：

### Commit 1

```text
docs(pdf-export): add implementation plan
```

仅：

```text
docs/design/pdf-export-implementation-plan.md
docs/README.md
```

---

### Commit 2

```text
fix(pdf-export): isolate light export rendering theme
```

处理：

```text
H1
```

---

### Commit 3

```text
fix(pdf-export): add explicit math readiness
```

处理：

```text
H2 + H3 math portion
```

---

### Commit 4

```text
test(pdf-export): harden kitchen sink browser coverage
```

处理：

```text
H4
```

---

### Commit 5

```text
fix(pdf-export): settle images before capture
```

处理：

```text
H5
```

---

### Commit 6

```text
test(pdf-export): cover pagination and long documents
```

处理：

```text
H6 + H7
```

---

### Commit 7

```text
feat(pdf-export): add read-mode download entry
```

处理：

```text
H8
```

这样 Code Review 可以逐笔判断：

```text
spec
correctness
test
performance
UI
```

而不是一次 review 一个超大 diff。

---

# 20. Test Matrix

## Unit

必须覆盖：

```text
filename
title resolution
PDF wrapper
light theme
Mermaid normalization
MarkMap normalization
Math states
heading grouping
image grouping
cleanup
```

---

## Component

必须覆盖：

```text
Mermaid forced theme
MarkMap forced theme
MarkMap explicit ready
MarkMap error
Math ready/error
```

---

## Integration

必须覆盖：

```text
open clean tab
open dirty tab
closed document
busy duplicate
render timeout
widget timeout
generation failure
cleanup
```

---

## E2E

必须覆盖：

```text
Kitchen Sink
dark mode export
local image
download
no print dialog
first/middle/last long-doc marker
```

---

# 21. Dirty Buffer Regression

这是必须单独保留的测试。

Given：

```text
server raw = Version A
```

用户当前 editor：

```text
tab.raw = Version B
dirty = true
```

When：

```text
Export PDF
```

Then export surface：

```text
Version B
```

After export：

```text
dirty = true
```

不得：

```text
save
autosave side effect
Version A export
```

---

# 22. Snapshot Consistency Regression

建立测试：

```text
T0 click export
T1 PdfExportRequest captures raw
T2 editor changes
T3 PDF rendering continues
```

最终：

```text
PDF = T1
```

不得出现：

```text
title=T1
paragraph=T2
diagram=T3
```

---

# 23. Error Matrix

| Stage          | Failure        | Expected                         |
| -------------- | -------------- | -------------------------------- |
| source         | getPost failed | export_failed                    |
| Markdown       | render failed  | export_failed                    |
| render surface | timeout        | export_not_ready                 |
| Mermaid        | explicit error | settled, preserve error          |
| MarkMap        | explicit error | settled, preserve error          |
| Math           | explicit error | settled, preserve fallback/error |
| Image          | load failed    | settled, continue                |
| Widget         | never settled  | timeout, abort                   |
| html2pdf       | save failed    | export_failed                    |
| cleanup        | always         | finally                          |

---

# 24. Cleanup Requirements

所有路径：

```text
success
failure
timeout
exception
```

必须确保：

```text
pdfRenderWaiter = null
pdfExportRequest = null
pdfExportBusy = false
observer disconnected
temporary PDF host removed
```

不得留下：

```text
.pdf-download-host
.pdf-download-root
stale PdfExportSurface
```

---

# 25. Security Review

Hardening 不得修改：

```text
DOMPurify allowlist
DOMPurify URI policy
raw HTML policy
iframe policy
script policy
SVG user HTML policy
```

PDF static SVG 来源必须仍然是：

```text
Nuvyn controlled Mermaid / MarkMap output
```

而不是重新允许用户任意 raw SVG。

---

# 26. Performance Review

PDF stack 不属于 startup critical path。

实施期间检查：

```text
html2pdf
html2canvas
jsPDF
```

是否显著进入首屏 bundle。

如果当前已经 eager bundled 且影响明显：

后续可将 PDF generation dependency：

```text
dynamic import
```

列为 P1。

但：

```text
bundle refactor
```

不要与 H1/H2 correctness commit 混在一起。

---

# 27. 不允许的实现方式

以下方案 Code Review 应直接拒绝。

### 不允许固定 sleep

```ts
await sleep(500)
```

代替：

```text
widget readiness
```

---

### 不允许 SVG existence

```ts
querySelector('svg') !== null
```

代表 MarkMap ready。

---

### 不允许全局 theme toggle

```text
dark
→ set light
→ export
→ restore dark
```

---

### 不允许强制保存

```text
save()
→ export()
```

---

### 不允许复制 renderer

```text
pdfMarkdownRenderer
```

重新维护 Markdown semantics。

---

### 不允许远程 PDF API

```text
POST document content
→ third-party converter
```

---

### 不允许安全降级

```text
allowTaint=true
disable sanitizer
```

---

### 不允许只检查文件大小

```text
PDF > 10KB
```

不能成为唯一 correctness test。

---

# 28. Phase Gate

## Gate A — P0 Correctness

必须全部：

```text
MarkMap explicit ready      DONE
Mermaid explicit state      DONE
Forced light export theme   DONE
Math explicit state         DONE
Kitchen Sink assertions     DONE
Failure cleanup             DONE / regression
```

Gate A 未通过：

```text
不得宣布 PDF V1 Done
```

---

## Gate B — P1 Reliability

必须：

```text
local image
image settlement
pagination
wide code
wide table
20-page document
50-page reasonable validation
```

---

## Gate C — UX

Gate A + Gate B 基本稳定后：

```text
Reading Pane remains free of PDF Export controls
```

---

# 29. CI / Verification Commands

每个 implementation commit 至少执行仓库对应的：

```bash
npm run typecheck
npm test
```

PDF browser phase再执行项目现有 Playwright 命令。

如果 package script 为独立：

```text
test:e2e
```

或其它名称，以 `package.json` 当前定义为准。

不得为了让 PDF test 通过：

```text
skip
retries
arbitrary timeout increase
```

掩盖错误。

---

# 30. Manual Acceptance Checklist

正式关闭 PDF V1 前人工检查一次真实 PDF：

* [ ] 中文正常；
* [ ] 英文正常；
* [ ] Emoji 正常；
* [ ] heading 正常；
* [ ] code 正常；
* [ ] table 正常；
* [ ] task list 正常；
* [ ] callout 正常；
* [ ] footnote 正常；
* [ ] KaTeX 正常；
* [ ] Mermaid 正常；
* [ ] MarkMap 正常；
* [ ] local image 正常；
* [ ] dark Nuvyn → light PDF；
* [ ] 没有 toolbar；
* [ ] 没有 NaN SVG；
* [ ] 没有明显裁图；
* [ ] 第一页正常；
* [ ] 最后一页正常；
* [ ] export 后 Nuvyn UI 状态未变化。

---

# 31. PDF Export V1 Definition of Done

以下是 release gate 的必要条件；当前 H4 browser evidence 已满足：

```text
PRD approved
Implementation Plan approved
P0 correctness complete
P1 reliability complete
typecheck pass
unit pass
integration pass
browser E2E pass
Kitchen Sink pass
Dark Mode export pass
Math pass
Mermaid pass
MarkMap pass
local image pass
long-document validation pass
failure cleanup pass
```

只有全部通过后才能：

```text
PDF Export V1 = Done
```

---

# 32. Historical Baseline Status Table

以：

```text
4e62bba441eb2ac7c426485154fd1226caa0edbf
```

为原始 hardening baseline；下表保留历史状态，不代表当前实现：

| Requirement                     | Status     |
| ------------------------------- | ---------- |
| PRD                             | ✅          |
| Direct PDF download             | ✅          |
| File Tree entry                 | ✅          |
| Live buffer authority           | ✅          |
| Filename resolution             | ✅          |
| A4 light document shell         | ✅          |
| Mermaid static export           | ✅          |
| Mermaid explicit state          | ✅          |
| MarkMap static export           | ✅          |
| MarkMap explicit ready          | ✅          |
| MarkMap readiness tests         | ✅          |
| Kitchen Sink fixture            | ✅          |
| Generation cleanup test         | ✅          |
| Forced light widget rendering   | ❌          |
| KaTeX explicit readiness        | ❌          |
| Kitchen Sink content assertions | ⚠️ Partial |
| Local image settlement          | ❌          |
| Remote image matrix             | ❌          |
| Wide table/code validation      | ❌          |
| 20-page validation              | ❌          |
| 50-page validation              | ❌          |
| Read Mode export entry          | REMOVED FROM V1 SCOPE |

---

# 33. Historical Next Implementation Start

本节记录 H1 开始前的历史下一步，不是当前工作指令。H1–H9 已完成，当前停止在 H10 release gate。

当时的下一笔代码提交只做：

```text
PDF-H1 — Export Light Theme Isolation
```

范围限定：

```text
PdfExportSurface.vue
RenderedMarkdown.vue
useMermaidMount.ts
useMarkmapMount.ts
Mermaid.vue
MarkMap.vue
相关 tests
```

目标只有一个：

> PDF export rendering context 固定使用 light theme，而普通 Reader 继续遵循用户当前主题，并且整个过程绝不修改全局 theme。

H1 完成并 review 后，再进入：

```text
PDF-H2 — KaTeX Explicit Readiness
```

不得把：

```text
image
pagination
read-mode UI
large document
```

顺便塞进 H1。

---

# 34. Final Execution Order

最终执行顺序固定为：

```text
Implementation Plan
        ↓
H1 Export Light Theme
        ↓
H2 Math Readiness
        ↓
H3 Settled Contract Regression
        ↓
H4 Kitchen Sink Correctness
        ↓
H5 Images
        ↓
H6 Pagination / Wide Content
        ↓
H7 Long Documents
        ↓
H8 Read Mode Entry decision (removed from V1 scope)
        ↓
H9 Stress / Compatibility
        ↓
H10 Final Documentation & Release Gate
        ↓
PDF Export V1 Done（仅在 H10 gate 全部通过后）
```

原始执行在 H10 audit 关闭后，因真实 PDF 暴露的 paragraph clipping regression 短暂返回 H6；`352a47b…` 修复并完成 focused verification 后，H10 release gate 已重新确认。当前不进入 PDF-H11 或 PDF Export V2。

当前最重要的原则：

> **先保证 PDF 内容永远正确，再增加 PDF 功能入口和高级能力。**

PDF Export V1 的 Hardening 不应继续以“能下载”为目标，而应以：

```text
deterministic
complete
isolated
testable
```

作为完成标准。

这份计划和 Nuvyn 现有 Implementation Plan 的职责划分是一致的：**PRD 管产品行为，Implementation Plan 管文件、顺序、验证和 review gate**。现有 Emoji 实施计划也是采用这种方式，并明确“若计划与 PRD 冲突，应先修 PRD，而不是代码自行改变产品语义”。

最终 H10 文档收尾只包含 PRD 和 Implementation Plan；不夹带新的 source 或 test change。历史上的 H4 blocker 和 post-H10 H6 pagination regression 均已分别由对应提交关闭。
