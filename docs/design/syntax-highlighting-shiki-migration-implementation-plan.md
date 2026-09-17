# Nuvyn Shiki Syntax Highlighting Migration Implementation Plan

## 1. 文档信息

| 项目 | 内容 |
| --- | --- |
| 文档状态 | MIGRATION COMPLETE |
| 产品 PRD | [Shiki Syntax Highlighting Migration PRD](syntax-highlighting-shiki-migration-prd.md) |
| Implementation baseline | 2be6b2c57b5d7cb76b359220f361bacb55661099 |
| 计划日期 | 2026-08-21 |
| 当前阶段 | SHIKI-H8 — COMPLETE；migration complete |
| 当前实现状态 | H0 审计、H1 runtime foundation、H2 language preparation、H3 Markdown renderer cutover、H4 style-to-class/security closure、H5 reader theme integration、H6 PDF compatibility、H7 Nuvyn-owned highlight.js cleanup 与 H8 full regression/release gate 已完成；正常已知 fence 输出带 `nuvyn-shiki-*` class 的 Shiki HTML，完整 dual-theme transformer CSS snapshot 由 `document.head` 下唯一的 `style#nuvyn-shiki-generated-styles` owner 管理，`src/shiki.css` 通过 Nuvyn `data-theme`/OS selectors 消费 light/dark variables；PDF 每次导出从 `getGeneratedShikiCss()` 捕获一次可信 snapshot，合并到唯一的 `style#nuvyn-pdf-download-styles`，clone 内的 `.pdf-document` selector 强制 `--shiki-light` token/background；主题切换只改变 computed style，不重新 render/tokenize，DOMPurify 的 `FORBID_ATTR: ['style']` 未改变；Nuvyn direct highlight.js dependency 与 `src/hljs-dark.css` 已删除，MarkMap 所需的 transitive highlight.js 仍保留；H8 release gate 全部通过；不存在 H9 |
| H0 审计证据 | [Shiki H0 Baseline & Contract Audit](syntax-highlighting-shiki-h0-audit.md) |
| H1 实施证据 | [Shiki H1 Dependency & Runtime Foundation](syntax-highlighting-shiki-h1-runtime-foundation.md) |
| H2 实施证据 | [Shiki H2 Fence Discovery & Dynamic Language Loading](syntax-highlighting-shiki-h2-language-loading.md) |
| H3 实施证据 | [Shiki H3 Markdown Renderer Cutover](syntax-highlighting-shiki-h3-renderer-cutover.md) |
| H4 实施证据 | [Shiki H4 Style-to-Class & Security Closure](syntax-highlighting-shiki-h4-security-closure.md) |
| H5 实施证据 | [Shiki H5 Theme Integration](syntax-highlighting-shiki-h5-theme-integration.md) |
| H6 实施证据 | [Shiki H6 PDF Compatibility](syntax-highlighting-shiki-h6-pdf-compatibility.md) |
| H7 实施证据 | [Shiki H7 highlight.js Cleanup](syntax-highlighting-shiki-h7-highlightjs-cleanup.md) |
| H8 实施证据 | [Shiki H8 Full Regression, Bundle Audit & Release Gate](syntax-highlighting-shiki-h8-release-gate.md) |
| 本任务范围 | H0 baseline/contract audit、H1 runtime foundation、H2 fence discovery/language loading、H3 normal Markdown renderer cutover、H4 style-to-class/security closure、H5 reader theme integration、H6 PDF compatibility、H7 Nuvyn-owned highlight.js cleanup 与 H8 full regression/release gate 已完成；MarkMap transitive highlight.js ownership 保持不变 |
| 目标 | 用可回滚、可验证的阶段性步骤完成 Shiki 4.x 迁移，同时保持 Markdown、DOMPurify、主题、Mermaid、MarkMap 和 PDF 合同 |

本计划描述接下来如何实施产品 PRD，不代表任何 Shiki 能力已经存在。未来实现必须以产品 PRD 为最高约束；如果本计划与 PRD 发生冲突：

~~~
STOP
→ update/review PRD first
→ only then continue implementation
~~~

不得为了减少实现工作而静默改变 PRD 的安全、主题、PDF、未知语言或特殊 fence 语义。

H0 审计证据已记录在 [Shiki H0 Baseline & Contract Audit](syntax-highlighting-shiki-h0-audit.md)。审计发现：如果在同一个带 `wikiResolver` 的 env 上先调用 `md.parse()`、再调用 `md.render()`，当前 wiki-link 路径会触发 resolver 双调用。H2 已通过“isolated discovery env + fresh real render env”关闭该 blocker；后续阶段不得退回 same-env parse/render。

H1 已完成并记录在 [Shiki H1 Dependency & Runtime Foundation](syntax-highlighting-shiki-h1-runtime-foundation.md)：Shiki 4.4.3 和 matching transformer 4.4.3 已加入，runtime singleton 已独立初始化双主题，`transformerStyleToClass` CSS snapshot API 已验证。H2 已在 [Shiki H2 Fence Discovery & Dynamic Language Loading](syntax-highlighting-shiki-h2-language-loading.md) 中记录：MarkdownIt 只发现 `fence` tokens，使用官方 registry/aliases 进行 canonical language preparation，并保持正常 renderer 为 highlight.js；没有新增 Shiki token HTML、DOM stylesheet、主题、PDF 或 Markdown renderer cutover。

H2 follow-up 已修正 failure boundary：`getShikiRuntime()` / `createHighlighter()` 的初始化失败沿 async render surface reject；只有单个 `runtime.loadLanguage()` grammar failure 转换为 `unavailable`。H3 已在 [Shiki H3 Markdown Renderer Cutover](syntax-highlighting-shiki-h3-renderer-cutover.md) 中完成：正常 fence callback 只读取已准备的 Shiki runtime 并同步调用 `codeToHtml()`；normal known output 不再是 `hljs`，unknown/empty/unavailable/codeToHtml failure 统一使用 escaped `nuvyn-shiki-plain` fallback。H4 已在 [Shiki H4 Style-to-Class & Security Closure](syntax-highlighting-shiki-h4-security-closure.md) 中完成：production `codeToHtml()` 使用唯一 `transformerStyleToClass`，完整 CSS snapshot 同步到唯一 head owner，sanitized article 保留 class-based token markup 且不放开 `style`。H5 已在 [Shiki H5 Theme Integration](syntax-highlighting-shiki-h5-theme-integration.md) 中完成：新增静态 `src/shiki.css` 消费 dual-theme variables，显式 `data-theme` 覆盖 OS fallback，reader theme switch 不重新 render/tokenize。H6 已在 [Shiki H6 PDF Compatibility](syntax-highlighting-shiki-h6-pdf-compatibility.md) 中完成：PDF 不重新解析或 tokenization，而是按 export transaction 捕获可信 CSS snapshot，使用唯一 PDF style owner 和 clone repair 强制 printable-light token/background；reader/global theme、Mermaid/MarkMap 和 H7 cleanup boundary 未改变。

## 2. 计划目标与约束

本计划回答以下问题：

- 接下来具体改什么，以及哪些文件只在后续阶段修改。
- 为什么先建立 runtime，再做 renderer cutover，最后才清理 highlight.js。
- 每一阶段的依赖顺序、风险、测试、人工验收和独立回滚边界。
- 如何在同步 MarkdownIt 渲染之前完成异步语言加载。
- 如何让 Shiki 的 token 样式变成 class，而不放开 Markdown 的 style 属性。
- 什么时候可以删除 highlight.js、旧 CSS 和旧测试契约。
- 什么时候才允许根据 PRD Definition of Done 宣布 migration Done。

以下约束记录的是本 implementation plan 首次落盘时的 documentation-only task，
不是 H1/H2 实施阶段的当前 scope。当前 phase/status 以本节顶部和对应 phase
evidence 为准。首次落盘 task 当时不得修改：

- package.json 或 package-lock.json；
- src/、server/、shared/、e2e/ 下的 production source、tests、CSS 或 fixture；
- PDF implementation；
- Markdown parser 或既有主题 UI。

后续实现也必须保持以下纪律：

1. 先完成 H0 的真实基线审计，再进入行为变更。
2. H3 才切换正常 code fence 的 renderer。
3. H4 必须单独完成安全收口，不能因为代码已经“能亮”就跳过。
4. H6 必须证明 PDF 的可打印浅色 token palette。
5. H7 才能删除 highlight.js、旧 CSS 和旧兼容引用。
6. 每个阶段都要有可审查的退出条件；没有退出证据就不能进入下一阶段。

## 3. 冻结架构决策

下表是实现期间不应被临时实现便利重新打开的决策。

| 主题 | 冻结决策 |
| --- | --- |
| Markdown parser | 保留 markdown-it；不迁移 Markdown parser |
| Render API | 保留 async render(markdown, options): Promise<string> |
| Syntax engine | Shiki 4.x |
| Themes | github-light + github-dark |
| Shiki styles | class-based；不把用户可见 token 样式作为 Markdown inline style |
| Transformer | @shikijs/transformers 的 transformerStyleToClass，或经过同等证明的 class transformer |
| Sanitizer | 不削弱 DOMPurify |
| style attribute | Markdown HTML 仍禁止；FORBID_ATTR: ['style'] 必须保留 |
| Highlighter lifecycle | 一个 long-lived singleton；不能按文档、render、fence 或 editor update 创建 |
| Languages | 按当前文档 fence lazy/dynamic load；不 eager load 全语言目录 |
| Unknown languages | escaped plain-code fallback；不抛出、不执行、不改变整篇文档 |
| Language aliases | 优先使用 Shiki bundled language registry/aliases；只保留必要的少量归一化 |
| MarkMap | bypass Shiki，保持现有 placeholder 和 mount lifecycle |
| Mermaid | bypass Shiki，保持现有 placeholder 和 mount lifecycle |
| Theme switching | CSS-driven；切换主题不重新 Markdown render、不重新 tokenization |
| Theme precedence | data-theme='light' 覆盖 OS dark；data-theme='dark' 强制 dark |
| PDF theme | 无论 reader、OS 或 data-theme 如何，PDF 强制 printable light |
| Generated CSS | 一个 runtime transformer、一个 CSS owner、一个稳定 ID；不能每个 code block 注入 style |
| Generated CSS trust | 只允许由 bundled Shiki themes 生成；放在 article sanitized HTML 之外 |
| Markdown parser migration | out of scope；不引入 markdown-it-async |
| line numbers / copy button etc. | out of scope；本迁移不添加产品功能 |

安全不变量必须逐字落实：

~~~
FORBID_ATTR: ['style']
~~~

如果 Shiki 的某个输出属性需要改变这条不变量，必须停止实现并先 review PRD；不能直接扩大 ALLOWED_ATTR。

## 4. 当前实现基线

### 4.1 当前真实调用流

当前 repository 在 H7/H8 release state 的主要路径如下：

~~~
raw Markdown
    ↓
useMarkdownRender()
    ↓
parseDoc()：frontmatter title / content
    ↓
render(body, options): Promise<string>
    ↓
getMd()
    ↓
md.parse(markdown, isolated discovery env)
    ↓
collect actual fence tokens / first info token
    ↓
prepareShikiLanguages()
    ↓
Shiki official bundled registry / alias resolution
lazy singleton runtime + grammar preparation when needed
    ↓
fresh real WikiLinkEnv
    ↓
md.render(markdown, render env)
    ↓
MarkdownIt synchronous fence callback
    ↓
MarkMap / Mermaid placeholder
OR
Shiki codeToHtml() + transformerStyleToClass class-based HTML
OR
escaped <pre class="shiki nuvyn-shiki-plain"><code>
    ↓
syncGeneratedShikiStylesheet()
    → document.head
      style#nuvyn-shiki-generated-styles
      complete trusted CSS snapshot
    + src/shiki.css (static bundle after style.css)
      .shiki / token span variable consumption
      data-theme / prefers-color-scheme precedence
    ↓
sanitizeMarkdownHtml()
    ↓
DOMPurify
    ↓
useMarkdownRender.html
    ↓
RenderedMarkdown v-html
    ↓
ReadingPane / preview / PdfExportSurface
    ↓ (PDF export branch)
preparePdfArticleHtml()
    ↓
getGeneratedShikiCss() snapshot once per export
    + PDF_DOWNLOAD_STYLES
    ↓
one style#nuvyn-pdf-download-styles
    ↓
html2canvas.onclone() repair + layout normalization
    ↓
.pdf-document light token/background selectors
    ↓
printable PDF
~~~

当前 render API 仍然是异步的，但 MarkdownIt 的 highlight callback 必须同步返回 HTML。H3 已在 render() 外层完成语言预加载，并在 callback 内同步调用 ready Shiki runtime；callback 不会 await、load grammar 或初始化 runtime。H5 的 `src/shiki.css` 是全局静态 CSS 层，主题切换只改变 selector/variable consumption，不回到这个 render flow。

### 4.2 文件与职责盘点

| 文件 | 当前真实职责 | 迁移注意点 |
| --- | --- | --- |
| package.json | 声明 Shiki/transformer、markdown-it 及其他 runtime dependencies；不再直接声明 highlight.js | H7 已通过 npm 删除 Nuvyn direct edge；不要把 MarkMap transitive dependency 当成 root dependency |
| package-lock.json | root dependency edge 已移除；`node_modules/highlight.js` 仍由 `markmap-lib@0.18.12` 传递保留 | 只能由 npm 正常更新，不能手改依赖图 |
| pnpm-lock.yaml | 非规范 npm workflow 的历史 importer 仍记录 highlight.js；本阶段按任务要求不重生成它 | 以 package.json/package-lock.json 和 npm graph 为 H7 规范证据；该非规范 lock hit 在 H7 evidence 中单独分类 |
| src/lib/markdown.ts | DOMPurify 配置、sanitizer hook、MarkdownIt singleton、所有 Markdown plugins、fence callback、render API | 建议保留 parser/sanitizer；将 Shiki lifecycle 抽到专用 module |
| src/lib/__tests__/markdown.test.ts | MarkMap/Mermaid fence、当前 Shiki contract、Markdown extensions、HTML sanitizer、resolver concurrency | H3 已迁移 normal code fence 断言；其余回归不得丢 |
| src/lib/__tests__/markmapSecurity.test.ts | MarkMap transformer 自身的 HTML/security/feature 断言 | 其中 features.hljs 是 MarkMap 内部契约，不能盲目当成 Nuvyn renderer 引用删除 |
| src/hljs-dark.css | H7 已删除的 Nuvyn-owned legacy GitHub highlight.js token CSS | 不创建兼容替代文件；reader Shiki theme 由 `src/shiki.css` 负责 |
| src/style.css | 全局、vault article、pre/code layout；OS media query；data-theme selector | 继续拥有通用布局；不要在这里复制每个 Shiki token |
| src/main.ts | 入口，导入 style.css、src/shiki.css 和 KaTeX CSS | 静态 Shiki theme bridge 在 generic Nuvyn CSS 后加载 |
| src/composables/vault/useMarkdownRender.ts | parseDoc、frontmatter title 注入、调用 render、heading extraction、取消过时 render | 保持 async contract；不要为 Shiki 改造成第二套 Markdown pipeline |
| src/components/vault/RenderedMarkdown.vue | 通过 v-html 插入 html，并挂载 MarkMap/Mermaid/Math | 正常代码仍必须适配这个 sanitized HTML surface |
| src/components/vault/ReadingPane.vue | read mode scroll/TOC，使用 RenderedMarkdown tag=article | 不应因为高亮切换改变 TOC 或阅读生命周期 |
| src/components/vault/PdfExportSurface.vue | 隐藏但有真实布局的 RenderedMarkdown，传 render-theme='light' | 保持 widget 的 forced light；H6 不改此组件 |
| src/lib/pdfExport.ts | PDF_DOWNLOAD_STYLES、article clone、Mermaid/MarkMap staticization、A4 layout、分页、html2pdf；H6 snapshot/clone owner | 只读取 trusted `getGeneratedShikiCss()`，不重做 PDF architecture |
| src/lib/__tests__/pdfExport.test.ts | PDF HTML/CSS、filename、Mermaid/MarkMap clone 及布局 helper 的单元回归 | 覆盖 snapshot composition、owner repair、Shiki markup contract |
| e2e/markdown-visual.spec.ts | light/dark reader visual regression | H5 扩展 system/forced theme coverage |
| e2e/markdown-shiki-theme.spec.ts | computed Shiki token/pre colors、六种 selector cases、CSS-only switch DOM identity | H5 evidence |
| e2e/pdf-export.spec.ts | dark reader 下 export、theme 不被改变、download snapshot | H6 验证 PDF light palette 和 global theme isolation |
| e2e/pdf-export-shiki.spec.ts | 五种 reader/OS 组合下真实 html2canvas clone computed token/background evidence | H6 dedicated clone/theme matrix |
| e2e/pdf-export-layout.spec.ts | code、table、Mermaid、MarkMap 的宽度/分页布局 | 保持 long-line wrapping、no clipping |
| e2e/pdf-export-pagination.spec.ts | 普通段落和 list item 的 A4 page boundary | 证明 Shiki 不破坏 block pagination |
| e2e/pdf-export-stress.spec.ts | huge code、100-page、diagram/table/image stress | 证明 code-heavy export 不 throw 且 oversized code 可 split |

### 4.3 Sanitizer 的当前安全边界

src/lib/markdown.ts 当前的 DOMPurify 配置已经明确：

- ALLOWED_TAGS 包含 pre、code、span、div 等 Markdown、mount 和 token 输出所需元素；
- ALLOWED_ATTR 包含 class、data-content、data-target 等 Nuvyn 合同属性；
- ALLOW_DATA_ATTR 开启后由 hook 限制到 data-anchor、data-content、data-missing、data-target；
- 以 on 开头的属性由 hook 删除；
- FORBID_ATTR: ['style']；
- FORBID_TAGS 包含 script、style、svg、iframe、object 等；
- URI policy 只接受当前安全协议/相对路径规则。

因此当前普通 raw HTML 的 style、onclick、onerror、javascript URL 会被清理。KaTeX/MarkMap 有各自受控的后续 mount 或 transformer 路径；不要把它们当成放宽 Markdown sanitizer 的理由。

### 4.4 当前 code fence HTML contract

H3 的 `renderFence()` 按以下顺序处理传入的 fence info：

1. exact `markmap`：输出 `div.markmap-mount`，并把 source 放入
   `encodeURIComponent()` 后的 `data-content`。
2. exact `mermaid`：输出 `div.mermaid-mount`，并把 source 放入
   `encodeURIComponent()` 后的 `data-content`。
3. 已由 H2 准备的 canonical Shiki language：同步输出 Shiki 的
   `pre.shiki > code > span.line` structural HTML。
4. empty、unknown、unavailable 或单 fence `codeToHtml()` failure：输出
   `pre.shiki.nuvyn-shiki-plain > code` 的 escaped source。

当前 normal fence 不再由 highlight.js renderer 产生。H7 已删除 Nuvyn direct
`highlight.js` dependency 和 `src/hljs-dark.css`；MarkMap-owned
`features.hljs` 仍保留并已在 H7 evidence 中单独分类。它们都不是 H3 normal
fence output contract。

### 4.5 当前主题行为

当前主题相关实现不是一个完整的 system/forced 三态模型：

- index.html 的 boot script 只有在 localStorage 有 nuvyn.theme=light/dark 时才提前写 data-theme；
- useTheme.ts 的 readSaved() 没有保存值时读取 prefers-color-scheme；
- useTheme.ts 在 module load 时把读到的 light/dark 写回 html[data-theme]；
- set() 保存用户选择并同步 data-theme；
- src/style.css 既有 prefers-color-scheme media query，也有 :root[data-theme='light'] 和 :root[data-theme='dark'] 覆盖；
- H0/H6 historical evidence 记录过旧 `hljs-dark.css` 的 OS dark/forced dark
  selector；H7 已删除该 stylesheet，当前 token palette 由 `src/shiki.css`
  和 trusted generated Shiki CSS owner 提供。

H5 已在不改变上述产品模型的前提下，把事实和 PRD 的 system light/system dark/forced light/forced dark acceptance 对齐：`src/shiki.css` 覆盖 explicit data-theme 与 no-attribute media-query fallback，浏览器证据证明四种 explicit/OS precedence 和两种 no-attribute fallback。没有新增主题 UI 或改变 `useTheme` 的产品语义；no-attribute 路径仍只是初始 CSS fallback，不是持久 system state。

### 4.6 当前 PDF code-block contract

src/lib/pdfExport.ts 当前已拥有：

- PDF_DOWNLOAD_STYLES，根节点 .pdf-download-root 和 .pdf-document.vault 强制白色、A4、浅色 Nuvyn variables；
- .pdf-document .article pre 的 white-space: pre-wrap、overflow-wrap、浅色背景、边框和 printable text color；
- .pdf-document .article pre code 继承换行规则；
- short block break-inside: avoid；
- markOversizedPdfBlocks() 为高于 printable A4 height 的 block 加 pdf-allow-split；
- preparePdfArticleHtml() 只 clone article，不改 live reader；
- Mermaid/MarkMap 先转换为静态 SVG，再由 html2pdf 导出；
- createPdfDownloadElement() 在 .pdf-download-root 内放置受信任的 nuvyn-pdf-download-styles style element；
- download 后 finally 移除 export host，不改变全局 data-theme。

H0 handoff 的历史结论是：当时的通用 `pre`/`code` 浅色 surface 只证明代码块背景和继承文本色，不证明深色 root theme 下嵌套 highlight.js token span 已切换到浅色 syntax palette；`PdfExportSurface` 的 `render-theme='light'` 由 RenderedMarkdown 的 Mermaid/MarkMap mount 路径消费，也不会独立修改 `document.documentElement[data-theme]` 或强制 hljs token 色。H6 现已在 reader light、reader dark、forced dark 和 OS dark 四类状态下检查实际 printable surface 的 token computed colors，并保留该历史 gap 的证据边界。该补充不改变 Mermaid/MarkMap staticization、A4 margins、long-code split 或 concurrency 规则。

### 4.7 基线验证记录

以下结果是在本计划落盘前、HEAD 为 7f79d00447ce0c867c580a5bf9404cb16c2d5bb2 时记录的本地结果：

| 命令 | 结果 | 解释 |
| --- | --- | --- |
| npm run typecheck | PASS，exit 0 | client 和 server typecheck 均完成 |
| npm run build | PASS，exit 0 | Vite build 完成；有现存 Rolldown INVALID_ANNOTATION 和大 chunk warning |
| npm run test:unit | 3053 passed、2 skipped、22 failed；206 files passed、4 files failed | 失败来自当前沙箱 socket/IPC EPERM，以及 auth smoke fixture 缺失；不是 Shiki 变更，因为 Shiki 尚未实现 |

unit 失败的具体环境信号包括 server openai-http 和 crash-recovery 子进程无法 listen，以及 auth-middleware 找不到 src/content/post-smoke.md。H0 退出前应在正常 CI/可用 fixture 环境重新记录完整基线，不能把这次沙箱结果当作 release evidence。

## 5. Target architecture

### 5.1 最终 Markdown pipeline

目标实现应保持现有 async render 边界，先准备语言，再进入同步 MarkdownIt render：

~~~
render(markdown, options)
    ↓
getMd() + getShikiRuntime()
    ↓
discover fenced languages from MarkdownIt fence tokens
    ↓
resolve aliases / exclude markmap, mermaid, empty fences
    ↓
await missing Shiki language loads
    ↓
MarkdownIt.render(markdown, env)
    ↓
special fences:
    markmap  → encoded .markmap-mount placeholder
    mermaid  → encoded .mermaid-mount placeholder
    normal fence → Shiki codeToHtml / synchronous callback
    unknown     → escaped plain <pre><code>
    ↓
transformerStyleToClass output + trusted CSS synchronization
    ↓
DOMPurify with existing config
    ↓
useMarkdownRender.html
    ↓
RenderedMarkdown v-html
    ↓
ReadingPane / preview
~~~

MarkdownIt 仍然是 parser 和 renderer。Shiki 只接管普通 fenced code 的 HTML 生成；不接管 inline code、Markdown extension、Mermaid 或 MarkMap。

### 5.2 Theme path

最终 code fence HTML 携带 light/dark dual-theme token data，Nuvyn CSS 决定当前显示的 palette：

~~~
Shiki dual-theme token data
    ↓
transformerStyleToClass generated trusted classes
    ↓
generated class CSS in document.head
    ↓
static src/shiki.css (bundled after generic style.css)
    ↓
:root / prefers-color-scheme / data-theme selectors
    ↓
system light / system dark / forced light / forced dark
~~~

主题切换只改变 CSS variables/selectors。rendered article.innerHTML、Shiki token class、已加载语言和 transformer CSS 不应因为主题切换而重新生成。

### 5.3 PDF path

~~~
Shiki-rendered article HTML
    ↓
PdfExportSurface light widget render
    ↓
preparePdfArticleHtml() clone
    ↓
trusted PDF stylesheet with .pdf-document light token overrides
    ↓
existing A4 wrapping / pagination / static diagram preparation
    ↓
html2pdf
~~~

PDF 的 light override 必须在 .pdf-document scope 内生效，并且不能修改 reader 的 global theme 或 live article。

## 6. Proposed module boundaries

### 6.1 推荐新增 src/lib/shiki.ts

推荐把 Shiki runtime 抽到 src/lib/shiki.ts，而不是继续把所有生命周期塞进 src/lib/markdown.ts。原因是：

- markdown.ts 已经同时承担 sanitizer、MarkdownIt plugins、link resolver、custom fence placeholder 和 render API；
- singleton highlighter、language load dedup、transformer CSS owner 是独立的生命周期问题；
- 专用模块可以在 H1/H2 先独立测试，降低 H3 cutover 的复杂度；
- 既有 render(markdown): Promise<string> 对调用者保持不变；
- H7 可以用清晰的 direct import/search 结果证明旧实现已删除。

不要创建没有使用场景的 generic HighlightEngine abstraction。专用 module 只暴露实现所需的具体能力，例如：

~~~
getShikiRuntime()
discoverFenceLanguageIdentifiers(md, markdown)  // isolated env in markdown.ts
resolveShikiLanguage(identifier)
prepareShikiLanguages(languageIds)
ensureShikiLanguage(identifier)
highlightShikiFence(source, info)                 // H3 synchronous callback API
syncGeneratedShikiStylesheet(runtime)
getGeneratedShikiCss(runtime)       // PDF trusted snapshot / tests
~~~

实际函数名可以调整，但行为合同不能弱化。

### 6.2 src/lib/markdown.ts 的边界

markdown.ts 继续负责：

- MarkdownIt import 和 plugin registration；
- DOMPurify config、hook、sanitizeMarkdownHtml；
- frontmatter 以外的 Markdown render；
- resolver env；
- markmap/mermaid placeholder 的 source encoding；
- 通过 async render 先调用 Shiki preflight，再调用 md.render；
- 将 Shiki callback 绑定到正常 fence。

markdown.ts 不再负责：

- highlighter singleton 的创建/重试；
- language in-flight map；
- transformer instance；
- generated stylesheet 的 DOM owner。

### 6.3 CSS 边界

当前 main.ts 已导入 src/style.css、src/shiki.css 和 KaTeX CSS；H5 已完成静态 Shiki theme bridge，H7 不改变这条 CSS 入口：

- src/style.css 继续拥有 .vault .article pre/code 的布局、字号、边框、换行和 Nuvyn variables；
- src/shiki.css 只拥有 .shiki 结构、light/dark token variables、Shiki background 和 theme selector；
- generated transformer CSS 由 src/lib/shiki.ts 在 document.head 的稳定 style element 管理；
- PDF-specific light override 仍由 src/lib/pdfExport.ts 的 PDF_DOWNLOAD_STYLES 管理；
- src/hljs-dark.css 已在 H7 删除，不再有 Nuvyn-owned `.hljs` token CSS。

如果实现验证后发现现有 style.css 更适合承载少量结构规则，可以保留在 style.css，但不得把 generic pre layout 和 generated token rules 重复写两遍。

## 7. Language discovery design

### 7.1 在同步 render 前发现 fence token

不要对整个 Markdown source 做 unrestricted regex，因为代码内容、nested fence、indentation 和 raw text 会制造误识别。首选使用同一个 MarkdownIt 实例的 tokenization：

1. 创建本次 discovery 专用的空 env；不得放入 caller 的 `wikiResolver`。
2. 调用 md.parse(markdown, discoveryEnv) 得到 token list；parse 阶段只做 tokenization，不调用 renderer highlight callback。
3. 只选择 token.type === 'fence' 的 token。
4. 读取 token.info 的第一段作为 language identifier；后续内容保留为 fence meta，不参与语言解析。
5. 归一化后交给 Shiki bundled language registry。
6. 语言准备完成后，创建新的 real render env，再调用 md.render(markdown, renderEnv)。

这会让文档被 parse 两次，但不会引入 markdown-it-async，也不会让 highlighter callback 异步化。H2 已验证 discovery parse 不调用 caller resolver；每次 parse/render 都使用 render-scoped env。后续如果发现 plugin 有新的 parse/render 副作用，也只能沿 MarkdownIt fence 规则 review，不能回到 unrestricted regex。

### 7.2 归一化规则

| 输入 | 处理 |
| --- | --- |
| 空 info 或只有 whitespace | 不加载语言；正常 plain-code |
| js / javascript | 解析为 JavaScript registry entry |
| ts / typescript | 解析为 TypeScript registry entry |
| py / python | 解析为 Python registry entry |
| sh / bash / shell | 使用 registry alias；必要时归一到同一 canonical entry |
| yml / yaml | 使用 YAML registry alias |
| md / markdown | 使用 Markdown registry alias |
| tsx、jsx、vue、html、css、scss、json、java、sql 等 | 通过 Shiki registry/alias resolution |
| markmap | 特殊 placeholder；不进入语言集合 |
| mermaid | 特殊 placeholder；不进入语言集合 |
| 首字母大写或全大写 | 对 registry lookup 使用 lower-case canonical key；不改变 code source |
| 前后 whitespace | trim；例如 fence info 为 py 时视为 py |
| language 后的 meta | 只取第一个 whitespace-delimited identifier；例如 js title=demo 只加载 js |
| unknown-lang | registry lookup 失败；不 load，走 escaped fallback |

当前 MarkdownIt 传给 highlight callback 的 lang 可能已经经过 info trimming，也可能包含 parser 保留的 token 形态。H3 必须在 discovery 和 callback 两处都通过同一套 normalization helper，不能假设 callback 永远只传 canonical id。

### 7.3 需要加载什么

预加载集合只包括：

- 非空；
- 非 markmap、非 mermaid；
- 能由 Shiki bundled registry 解析到的语言；
- 当前文档中实际出现的 unique canonical language。

不要在 application startup 载入完整语言目录。不要为未知 identifier 调用无限制的动态 import。unknown 结果可以按 normalized id 缓存为 unavailable，但该缓存只能影响该语言 fallback，不能让全局 highlighter 进入 rejected 状态。

### 7.4 Fence source 的边界

source 内容不用于语言 lookup，也不参与 class name 生成。以下输入都必须只影响 fence token：

- fence delimiter 出现在代码正文中；
- indented code block；
- raw HTML 中的字符串 js；
- fence meta；
- unknown language 中的 HTML-like source。

如果 MarkdownIt tokenization 对某个边界无法给出稳定 token，应在 H0 建立 fixture 并先 review；不能用更宽的 regex 静默补洞。

## 8. Singleton and concurrency design

这是迁移的关键正确性边界。

### 8.1 Runtime state contract

src/lib/shiki.ts 建议在 module scope 维护以下状态，具体变量名可以改变：

~~~
highlighterPromise: Promise<Highlighter> | null
loadedLanguageSet: Set<CanonicalLanguage>
inFlightLanguageLoads: Map<CanonicalLanguage, Promise<void>>
unsupportedLanguageSet: Set<NormalizedLanguage>
styleTransformer: one transformerStyleToClass instance
generatedCssText: last transformer.getCSS() snapshot
~~~

初始化使用 github-light 和 github-dark 两个 theme，不能在每次 render 时重新 createHighlighter。highlighterPromise 的初始化必须是 single-flight：

~~~
if (highlighterPromise) return highlighterPromise
highlighterPromise = createRuntime()
highlighterPromise.catch(() => { highlighterPromise = null })
return highlighterPromise
~~~

初始化失败只允许当前准备调用失败；必须清空 rejected promise，使下一次准备可以重试。H2 的历史 Markdown render 对已知 grammar preparation failure 保持旧 highlight.js 路径可用；H3 之后同一状态映射为当前 fence 的 escaped plain fallback。一个未知语言或单个 grammar load 失败不得把 highlighterPromise 置为 rejected。

### 8.2 Language load dedup

ensureLanguage(language) 的行为：

1. canonical language 已在 loadedLanguageSet：立即返回。
2. canonical language 已在 inFlightLanguageLoads：返回同一个 Promise。
3. 否则创建一次 loadLanguage promise，放入 map。
4. 成功后加入 loadedLanguageSet。
5. 无论成功失败都在 finally 删除 inFlightLanguageLoads entry。
6. H2 只报告该 language unavailable；H3 当前 renderer 将该状态映射为该 fence 的 Shiki-compatible escaped plain fallback，不再回到 highlight.js。

因此以下并发 sequence：

~~~
render A → load js
render B → load js
render C → load java
~~~

必须最多只有一次 js grammar load、一次 java grammar load 和一个 highlighter。A/B 的 render 可以各自使用自己的 Markdown env，但不得共享可变 resolver state。

### 8.3 Transformer 与 render 并发

MarkdownIt.render 的 highlight callback 是同步的；JavaScript event loop 不会同时执行两个 callback，但不同 async render 可能在预加载阶段交错。因此：

- 所有 callback 使用同一个 transformer；
- 每次完整 md.render 后同步一次 CSS snapshot；
- CSS update 是 compare-before-write，不能 append；
- 同一份 CSS 只允许一个 document.head owner；
- 不要在 callback 内创建 style element；
- 不要把 source、language 或 user-provided meta 拼入 class name。

若 Shiki transformer 本身要求在同一 runtime 上串行调用，H1 必须提供一个小的 render critical section 或使用文档化的线程安全调用方式；不能用第二个 transformer 绕开竞态。

### 8.4 Failure semantics

| 故障 | 当前 render | 后续 render |
| --- | --- | --- |
| highlighter 初始化失败 | 保持 render rejection，沿用现有 useMarkdownRender error surface | rejected highlighter promise 已清空，可重试 |
| 单个已知 language load 失败 | 该 language 的 fence escaped plain code；其他语言继续 | 其他语言不受影响；该 id 可重试或使用 unavailable cache |
| unknown language | 直接 escaped fallback，不调用 loadLanguage | 不影响 runtime |
| generated CSS sync 失败或无 document | HTML 仍可返回；记录受控诊断，不把 user content 送入 style | 浏览器有 document 时可再次同步；测试用 getCSS 断言 |
| transformer 单次 codeToHtml 失败 | 该 fence fallback；整篇 render 不因单个 code block 失败 | runtime 保持可用 |

不允许 catch 一个全局 Error 后返回不安全的 raw HTML。fallback 也必须走 escaped source 和最终 DOMPurify。

## 9. Security design

### 9.1 Trust boundary

不可信输入包括：

- Markdown source；
- Markdown raw HTML；
- 每个 code fence 的 source；
- fence language 和 fence meta；
- wiki link、image、URI 等作者可控内容。

可信输入包括：

- Shiki bundled github-light/github-dark theme definitions；
- 由可信 theme 和 transformer 产生的 CSS；
- Nuvyn 自己维护的 src/shiki.css；
- Nuvyn PDF trusted stylesheet。

Markdown source 不能成为 CSS、class name、style text 或 DOM node 的直接输入。

### 9.2 必须保持的安全要求

- 不允许任意 Markdown style attribute；
- 不允许 event handler attribute；
- 不允许 sanitizer bypass；
- 不把 Shiki 生成的 style element 插入 article HTML；
- generated CSS 只能在 document.head 或受控 PDF export surface 管理；
- unknown source 仍然必须 HTML-escaped；
- class name 只来自固定 Nuvyn prefix 和 transformer 计算结果，不能包含 raw user source；
- 不扩展 ALLOWED_ATTR 以保留 incidental Shiki attributes；
- DOMPurify 仍是进入 v-html 前的最后一道 Markdown HTML 边界。

### 9.3 为什么必须 transformerStyleToClass

默认 Shiki 输出可能用 inline style 表示 token color/background。当前 DOMPurify 明确以 FORBID_ATTR: ['style'] 删除这些属性；直接把 style 加入 ALLOWED_ATTR 会让作者 raw HTML 也获得同样能力，扩大 XSS/CSS injection 边界。

transformerStyleToClass 将可信 token style 转为 class，并把对应声明放入由 Nuvyn 管理的可信 CSS。这样：

- sanitized article 只依赖 pre、code、span、class；
- user-authored style 仍被删除；
- token color 由外部可信 stylesheet 提供；
- CSS 的生命周期可以被 singleton runtime 去重；
- theme switching 可以使用 variables，而不用重新生成文章 HTML。

### 9.4 安全测试合同

H4 必须直接断言：

- normal Shiki HTML 不含 Shiki-generated style attribute；
- FORBID_ATTR: ['style'] 源码合同仍在；
- raw <span style="color:red" onclick="..."> 的 style/onclick 仍被删除；
- code fence 中 <script>、<a onclick> 等内容只作为 escaped text；
- token class 在 sanitize 后仍存在；
- generated style element 不在 article querySelector 内；
- generated CSS text 不包含任何 user code source。

## 10. Theme integration design

### 10.1 文件落点

当前全局 CSS 入口是 src/main.ts 的 src/style.css、src/shiki.css 和 KaTeX CSS；
当前 normal renderer 不再有 highlight.js CSS 动态 import。H7 完成后的结构是：

- src/shiki.css：静态结构和 dual-theme variables；
- src/main.ts：静态导入 src/shiki.css；
- src/lib/shiki.ts：动态 generated class stylesheet owner；
- src/style.css：继续保留 .vault .article pre/code layout 和 Nuvyn theme tokens；
- src/lib/pdfExport.ts：PDF-specific forced-light selectors；
- src/hljs-dark.css：已删除；不创建 Nuvyn-owned `.hljs` compatibility CSS。

不要把 generated token CSS 写入 sanitized Markdown HTML，也不要在每次主题切换时重新 import 或重新生成整篇 Markdown。

### 10.2 CSS selector 设计

静态 CSS 要为 Shiki 输出提供以下结构：

~~~
.shiki {
  color: var(--shiki-light);
  background-color: var(--shiki-light-bg);
}

system dark:
  :root:not([data-theme='light']) .shiki ...

forced light:
  :root[data-theme='light'] .shiki ...

forced dark:
  :root[data-theme='dark'] .shiki ...
~~~

具体 declarations 以 Shiki 4 dual-theme output 为准，但必须同时覆盖 pre 和 token span 的最终 token color/background。不要用单纯的 .shiki { color: ... } 以为可以覆盖每个 token class。

selector precedence 必须继续满足：

1. explicit data-theme='light' beats OS dark；
2. explicit data-theme='dark' beats OS light；
3. no explicit override 时由 prefers-color-scheme 选择；
4. reader theme switch 不改变 article HTML。

当前 useTheme.ts 的事实是 module load 时会把 OS-derived light/dark 写入 data-theme，因此 H5 的测试必须既覆盖现有行为，也覆盖 PRD 所说的 system/no explicit override 路径。如果需要改变 useTheme 的 state model，先 review PRD，不要在 CSS 迁移中隐藏这个产品差异。

### 10.3 不改变 generic code layout

保留 src/style.css 中现有：

- vault article code font-size 和 line-height；
- pre margin/background/border；
- inline code chip；
- reading layout；
- overflow/wrap 基本行为。

src/shiki.css 只负责 Shiki structural class 和 color variables。若同一个 selector 同时设置 layout 和 token color，必须记录优先级原因，并避免复制 style.css 的 generic pre rules。

## 11. Generated CSS lifecycle

### 11.1 Owner 和稳定 ID

runtime module 是唯一 owner：

~~~
one highlighter
one transformerStyleToClass
one transformer.getCSS() snapshot
one document.head style#nuvyn-shiki-generated-styles
~~~

style element 的要求：

- stable ID，例如 nuvyn-shiki-generated-styles；
- parent 必须是 document.head 或明确受控的 trusted stylesheet container；
- 不能位于 sanitized article；
- 已存在则复用；
- CSS text 未改变时不写 DOM；
- 新语言带来新 token combination 时，用完整 CSS snapshot 替换旧 text，不 append 重复规则；
- 只写 transformer.getCSS() 的可信结果，不写 Markdown source。

### 11.2 同步时机

推荐顺序：

1. 初始化 runtime 时创建 transformer，但不创建 article style；
2. 每次 codeToHtml 完成后让 transformer 累积需要的 class；
3. 当前 md.render 完成后调用一次 syncGeneratedShikiStylesheet；
4. sync 函数 compare generatedCssText 与 style.textContent；
5. 只有 CSS 有新增/变化时更新 style element。

因为 md.render 是同步的，完整 document render 后同步一次可以避免每个 fence 写 DOM。第一次 render 没有 code fence 时不应创建空的 stylesheet，除非 transformer API 需要且有测试证明。

### 11.3 document / jsdom / SSR

| 环境 | 处理 |
| --- | --- |
| Browser document/head 存在 | 创建或复用稳定 style element |
| jsdom document 存在 | 同样使用稳定 ID；测试 style count 和 CSS text |
| document undefined | 不触碰 DOM；保留 CSS snapshot 供测试/调用方读取 |
| document.head 暂时不存在 | 不把 CSS 放进 article；延后 sync，或使用明确的受控 head hook |
| 新语言生成新 class | 下次完整 render 后更新同一个 style element |

不能把 typeof document guard 当作忽略 CSS contract 的理由。jsdom 测试要覆盖可用 document，non-browser 单元测试要覆盖无 document。

### 11.4 PDF 的 CSS 可见性

html2pdf 会 clone export surface；不能假设 document.head 的 runtime style 在 clone 中一定可见。H6 必须验证实际 computed color。

H6 已采用并验证以下实现：

- `pdfExport.ts` 只读取 `getGeneratedShikiCss()`，在每次 export transaction 开始时捕获一次 immutable snapshot；
- `createPdfDownloadElement()` 在 root 内继续只维护一个 `style#nuvyn-pdf-download-styles`，其 text 由 trusted generated snapshot 和 Nuvyn-owned `PDF_DOWNLOAD_STYLES` 组成；
- `html2canvas.onclone` 使用同一份 snapshot 检查并修复 clone 内缺失或过期的 PDF style owner，再执行 layout normalization；
- `.pdf-document .article pre.shiki` 和 nested token spans 消费 `--shiki-light` / `--shiki-light-bg`，plain fallback 使用固定 printable light surface；
- 不创建第二个 transformer/highlighter，不按 code block 注入 style，snapshot 不进入 `articleHtml`，也不修改 `document.documentElement[data-theme]`。

H6 unit/E2E 已证明 PDF clone 中 nested token 的 computed color 等于 light variable、不同 token 保持多色，reader dark/forced dark 不会泄漏到 PDF。

## 12. Unknown-language fallback

### 12.1 稳定 HTML 合同

unknown、malformed、空 language 和失败 grammar 都优先保持普通 code block 语义：

<pre class="shiki nuvyn-shiki-plain"><code>escaped source</code></pre>

外层可保留 Shiki-compatible shiki class，以便通用 layout 生效；nuvyn-shiki-plain 仅表示没有 token coloring。不要保留 hljs compatibility class。

### 12.2 安全与行为

例如 source 是一个名为 totally-unknown 的 fence，内容为 <a onclick="alert(1)">hello</a>。它必须：

- render() resolve，不抛出；
- 输出 readable escaped text；
- DOMParser 不会看到 author anchor；
- 不执行 onclick；
- 不触发 MarkMap/Mermaid；
- 不生成破损 Shiki markup；
- 不影响同一文档其他已知语言 fence；
- 不因为单个未知 fence 使整篇文档进入 error。

fallback helper 只能调用统一 escapeHtml，不能把 source 直接插入 HTML。source 的尾部 newline 和 pre/code 文本语义应与 MarkdownIt 当前 fence output 一致。

## 13. MarkMap and Mermaid compatibility

### 13.1 必须先分支

normal Shiki lookup 前必须检查 normalized language：

~~~
markmap → <div class="markmap-mount" data-content="encodeURIComponent(source)"></div>
mermaid → <div class="mermaid-mount" data-content="encodeURIComponent(source)"></div>
~~~

这两个分支不能调用 Shiki loadLanguage 或 codeToHtml。不得用“Shiki 也支持类似语言”替代 Nuvyn mount contract。

### 13.2 现有 lifecycle 要保留

- RenderedMarkdown.vue 仍通过 v-html 插入 placeholder；
- useMarkmapMount 和 useMermaidMount 仍负责后续 mount；
- data-content 仍通过 encodeURIComponent 传递；
- pdf-readiness.ts 仍把未完成的 placeholder 当作 not ready；
- pdfExport.ts 仍将 settled widget 转为静态 representation；
- MarkMap/ Mermaid 的主题 remount 规则不在本迁移中重做；
- MarkMap 自己使用的 feature/highlight contract 必须和 Nuvyn normal fence contract 分开审计。

### 13.3 回归测试范围

至少保留并重新运行：

- src/lib/__tests__/markdown.test.ts 的 markmap、mmap negative case、mermaid、merm negative case；
- src/lib/__tests__/markmapSecurity.test.ts；
- src/lib/__tests__/pdf-readiness.test.ts；
- MarkMap 和 Mermaid component tests；
- e2e/markmap-math.spec.ts；
- e2e PDF tests 中 Mermaid/MarkMap static export lanes。

如果 H7 的全仓库 hljs 搜索命中 MarkMap dependency/test 的 features.hljs，必须注明这是外部 MarkMap contract，并确认 PRD 要求的是删除 Nuvyn-owned highlight.js runtime，而不是破坏 MarkMap。若无法区分，STOP → review PRD。

## 14. PDF integration plan

### 14.1 当前 PDF surface

PDF 不是另一个 Markdown parser。它复用 RenderedMarkdown，随后：

1. PdfExportSurface 传 render-theme='light' 给 Mermaid/MarkMap；
2. 等待 widgets/images settle；
3. 读取 article；
4. preparePdfArticleHtml() clone article；
5. 去掉 toolbar、静态化 Mermaid/MarkMap；
6. 为 oversized blocks 增加 split class；
7. createPdfDownloadElement() 建立 A4 trusted surface，并将本次 `getGeneratedShikiCss()` snapshot 与 `PDF_DOWNLOAD_STYLES` 合并到唯一 PDF style owner；
8. html2pdf 在 `onclone` 中使用同一 snapshot 修复 clone owner，再 save；
9. finally 移除 surface。

Shiki 迁移不能绕过这条流程，也不能在导出时重新解析 Markdown。

### 14.2 Printable light token selectors

H6 已在 `PDF_DOWNLOAD_STYLES` 中加入与最终 HTML contract 相符的 selector：

~~~
.pdf-document .shiki {
  color: var(--shiki-light) !important;
  background-color: var(--shiki-light-bg) !important;
}

.pdf-document .shiki span {
  color: light token value / light variable !important;
  background-color: light token background if present !important;
}
~~~

不能简单把所有 token span 设为同一个 body color；实际实现使用每个 token 自己继承的 `--shiki-light`，并由浏览器 computed-style evidence 证明不同 token 保持不同颜色。

### 14.3 PDF must preserve

- reader dark → PDF light；
- reader forced dark → PDF light；
- OS dark → PDF light；
- white/light background；
- GitHub-light-readable token colors；
- long-line wrapping；
- pre/code no horizontal clipping；
- short blocks keep together；
- oversized code can split across pages；
- code-heavy documents export without throw；
- Mermaid and MarkMap static PDF behavior unchanged；
- export does not mutate document.documentElement[data-theme]；
- export surface/root cleanup still occurs on failure。

### 14.4 PDF tests

单元层：

- src/lib/__tests__/pdfExport.test.ts 断言 PDF_DOWNLOAD_STYLES 包含 .pdf-document .shiki / token light override、pre/code wrapping 和 existing pagination selectors；
- 用实际 Shiki-like sanitized markup 调用 build/prepare helper，确认 class 保留、style contract 不被误判；
- 保留 Mermaid/MarkMap clone tests。

浏览器层：

- e2e/pdf-export.spec.ts：dark reader、theme unchanged、download exists、PDF snapshot token style；
- e2e/pdf-export-layout.spec.ts：long line、short code、oversized code、Mermaid、MarkMap、wide table；
- e2e/pdf-export-pagination.spec.ts：ordinary paragraph/list page boundary；
- e2e/pdf-export-stress.spec.ts：huge code、100-page、diagram/table stress；
- 如已有 PDF fixture 适合，增加含 JS/TS/Java/SQL/Python 的 code-heavy document。

## 15. Implementation phases

以下阶段严格顺序执行。每阶段完成后才能进入下一阶段；H0-H2 不应改变用户可见正常高亮，H3 是 renderer cutover，H7 才做旧依赖清理。

### SHIKI-H0 — Baseline & Contract Audit

不改变行为。

动作：

- 记录 package.json range 与 package-lock 实际版本；
- inventory src/lib/markdown.ts、所有 renderer surface、theme selectors、PDF selectors；
- 分类所有 highlight.js、hljs、.hljs、github.css 引用；
- 记录 Markdown、sanitizer、MarkMap、Mermaid、PDF 现有测试；
- 在可用 CI/正常 fixture 环境记录 typecheck、unit、build 基线；
- 把发现的当前主题 state gap 标记出来，不在 H0 私自修复。

退出条件：

- migration surface 有完整 file map；
- 已确认当前 normal fence contract 是 pre.hljs > code；
- 已确认 sanitizer 的 FORBID_ATTR 不可改；
- 已确认 PDF 的 trusted stylesheet 和 pagination 入口；
- baseline evidence 可被后续 H8 对比。

### SHIKI-H1 — Dependency & Runtime Foundation

状态：`COMPLETE`；证据：[Shiki H1 Dependency & Runtime Foundation](syntax-highlighting-shiki-h1-runtime-foundation.md)。

动作：

- 通过 npm 添加 Shiki 4.x 和 matching @shikijs/transformers 4.x；
- 新建 src/lib/shiki.ts；
- 初始化一个 highlighter singleton，加载 github-light/github-dark theme；
- 创建一个 style-to-class transformer；
- 先保留 highlight.js dependency 和旧 CSS，确保可回滚；
- 先不把正常 Markdown renderer 切换到 Shiki。

退出条件：

- runtime 可以独立初始化；
- theme availability 有测试；
- singleton promise/retry contract 有测试；
- transformer 可以产生 CSS snapshot；
- 初始 bundle/lazy chunk 形状有记录。

### SHIKI-H2 — Fence Discovery & Dynamic Language Loading

状态：`COMPLETE`；证据：[Shiki H2 Fence Discovery & Dynamic Language Loading](syntax-highlighting-shiki-h2-language-loading.md)。

动作：

- 基于 MarkdownIt fence tokens 实现 language discovery；
- 统一 trim/lowercase/alias/special-fence normalization；
- 实现 loadedLanguageSet 和 inFlightLanguageLoads；
- 实现 unknown/unavailable language semantics；
- 只在需要时调用 Shiki loadLanguage；
- 在正常 renderer 仍使用 highlight.js 的前提下先完成 runtime/discovery contract 测试，避免半切换状态。
- preflight 使用 fresh isolated env，final render 使用 fresh real env，关闭 wikiResolver double-call blocker；
- 使用 Shiki 4.4.3 官方 bundled registry，不构造 user-controlled module path；
- H2 build 已记录 full registry 的 async grammar/theme chunk 形状，未证明 startup eager 加载全语言。

退出条件：

- js/javascript、ts/typescript、py、sh、yml alias 通过；
- repeated language 只加载一次；
- concurrent render 不创建第二 highlighter；
- unknown、empty、meta、whitespace 和 special fence 都有确定结果；
- grammar chunks 没有在启动时全部 eager；
- 带 resolver 的 wiki link preflight 调用数保持为 0，最终 render 只调用真实 resolver 一次/语义位置；
- Markdown normal fence 仍通过 highlight.js，H3 renderer cutover 尚未开始。

### SHIKI-H3 — Markdown Renderer Cutover

状态：`COMPLETE`；证据：[Shiki H3 Markdown Renderer Cutover](syntax-highlighting-shiki-h3-renderer-cutover.md)。

动作：

- render() 先 discovery/preload，再同步 md.render；
- normal fence 已从 highlight.js callback 切换到 Shiki；
- markmap/mermaid 检查保持在 Shiki 前；
- 保留 render(): Promise<string>；
- normal HTML 使用 pre.shiki > code；
- unknown/empty/unavailable/codeToHtml error 使用 escaped plain-code fallback；
- 暂不删除 highlight.js package、src/hljs-dark.css 或旧文档引用，以保留独立 rollback。

退出条件：

- JS/TS/Java/SQL/Python normal fence 实际走 Shiki；
- hljs class 不再是 Nuvyn normal fence contract；
- MarkMap/Mermaid placeholder 完全不经过 Shiki；
- unknown/empty/unavailable/codeToHtml failure 不会破坏整篇文章；
- Markdown existing extensions、resolver isolation、heading extraction 仍通过；
- transformerStyleToClass production integration、generated CSS owner、theme 和 PDF 仍未开始。

### SHIKI-H4 — Style-to-Class & Security Closure — COMPLETE

动作：

- 在 normal Shiki output 中启用 transformerStyleToClass；
- 同步 generated CSS 到单一 trusted owner；
- 检查 sanitize 前后 HTML；
- 保持 FORBID_ATTR: ['style']；
- 确认 generated style 不在 article HTML；
- 增加 raw style/event/code injection regressions；
- 不因为 Shiki incidental attributes 扩大 ALLOWED_ATTR。

已完成并记录在 [Shiki H4 Style-to-Class & Security Closure](syntax-highlighting-shiki-h4-security-closure.md)。

退出条件：

- sanitized Shiki HTML 中没有 Shiki-generated style attribute；
- token classes 在 sanitizer 后存在；
- raw user style、onclick、javascript URI 仍被删除；
- CSS class 不包含 raw source；
- H4 security tests 在 jsdom 和 browser path 都通过。

当前 H4 handoff：production transformer 已启用，generated CSS 使用唯一的
`document.head` owner；H5 仍负责 theme selector/variable integration，H6 仍负责
PDF printable-light palette。

### SHIKI-H5 — Theme Integration

动作：

- 新增/导入静态 src/shiki.css；
- 实现 github-light/github-dark dual variables；
- 覆盖 system light、system dark、forced light、forced dark；
- 维持 data-theme explicit precedence；
- 验证 theme switch 不调用 render/tokenization；
- 保留 .vault .article pre/code layout；
- 只有在 PRD review 明确需要时才调整 useTheme system state。

退出条件：

- reader 四类 theme case 有自动化证据；
- data-theme='light' 能压过 OS dark；
- data-theme='dark' 能强制 dark；
- article.innerHTML 和 token classes 在主题切换前后不变；
- src/hljs-dark.css 不再是活跃 token CSS，但仍保留到 H7 清理。

### SHIKI-H6 — PDF Compatibility — COMPLETE

动作：

- 将 final Shiki generated CSS/variables 接入 trusted PDF style boundary；
- 在 .pdf-document scope 强制 github-light token palette；
- 保留 PdfExportSurface render-theme='light'；
- 保留 pre/code wrapping、A4 margins、break-inside 和 oversized split；
- 运行 unit、PDF layout、pagination、stress 和 dark-reader export tests；
- 检查 PDF clone 真实 computed colors，而不是只看 source string。

证据：[Shiki H6 PDF Compatibility](syntax-highlighting-shiki-h6-pdf-compatibility.md)。

退出条件：

- reader/OS/forced dark 都生成 light PDF；
- PDF 保留多色 syntax token；
- long code wrap、no clipping、pagination 均通过；
- Mermaid/MarkMap PDF 不回归；
- global data-theme、live reader article 和 export cleanup 不回归。
- H5 plain fallback 在 reader light/dark 下均显式断言可读；H6 PDF plain fallback 在 clone 中保持 printable。

### SHIKI-H7 — Cleanup & highlight.js Removal — COMPLETE

H3-H6 的 parity、security、theme、PDF 和回归证据均已完成后，H7 已完成
Nuvyn-owned cleanup。H7 证据见 [Shiki H7 highlight.js Cleanup](syntax-highlighting-shiki-h7-highlightjs-cleanup.md)。

已执行：

- 通过 npm 删除 package.json 的直接 `highlight.js` dependency，并由 npm 更新 package-lock.json；
- 删除 `src/hljs-dark.css`，不创建兼容替代 stylesheet；
- 确认正常 Nuvyn Markdown runtime 没有 `highlight.js`/GitHub CSS import；
- 保留 Markdown tests 中证明旧 `hljs` contract 已消失的 negative assertions；
- 保留并单独分类 MarkMap 的 `features.hljs`、`markmap-lib → highlight.js` 和非规范 `pnpm-lock.yaml` 历史 importer；
- 更新仍面向当前行为的 AI prompt，不改写 H0-H6 historical evidence。

H7 completion snapshot（`d584abf2c64b8b46767cba72fbfc22f5b6606798`）记录的当时状态如下；H8 随后在独立 release-gate 阶段完成：

- Nuvyn direct highlight.js dependency：REMOVED；
- npm package-lock root edge：REMOVED；
- MarkMap transitive `highlight.js@11.11.1`：PRESERVED；
- Nuvyn-owned `.hljs` application CSS 与 `src/hljs-dark.css`：REMOVED；
- normal Markdown renderer：仍为 Shiki；
- H8 full regression/bundle/release gate：at the H7 completion snapshot，NOT STARTED；现已由 H8 evidence 完成并通过。

### SHIKI-H8 — Full Regression, Bundle Audit & Release Gate — COMPLETE

动作：

- 运行 npm run typecheck；
- 运行 npm run test:unit；
- 运行 npm run build；
- 运行 relevant Markdown/PDF/MarkMap/Mermaid/E2E；
- 对比 H0/H8 bundle；
- 检查 initial、Shiki runtime、language grammar、theme CSS chunks；
- 人工验证五种代表语言、unknown、四种 theme 和 code-heavy PDF；
- 记录所有 warning、chunk size 和 test evidence。

已完成并记录在 [Shiki H8 Full Regression, Bundle Audit & Release Gate](syntax-highlighting-shiki-h8-release-gate.md)：

- npm dependency/package-lock graph、MarkMap transitive ownership 和 npm-only package-manager policy 已审计；非规范且无 live consumer 的 `pnpm-lock.yaml` 已删除并记录原因；
- focused、extended client、Markdown/PDF/MarkMap/Mermaid、Chromium、history/recovery integration、`npm test`、typecheck、clean build 和 `npm ci` 均通过；
- H0 → H8 bundle comparison 已记录，main entry 未吸收完整语言目录，grammar/theme capability 仍按需拆分；
- PRD Definition of Done 已逐项绑定到 source audit、unit/browser evidence 或 build evidence。

退出条件：

- PRD Definition of Done 每一项都有证据；
- 没有 accidental eager language inclusion；
- 没有 highlighter recreation 或 repeated load；
- 没有 theme-triggered retokenization；
- highlight.js cleanup search 已完成；
- Release Gate checklist 全部关闭。

H8 结果：`PASS`。迁移已完成；H8 后不存在 H9 或其他 syntax-highlighting migration phase。

## 16. Per-phase implementation tables

### SHIKI-H0 table

| Item | Content |
| --- | --- |
| Goal | 形成不改变行为的完整 baseline 和 migration surface inventory |
| Files likely changed | implementation work 中不应改 production files；审计对象为 package.json、package-lock.json、src/lib/markdown.ts、src/lib/__tests__/markdown.test.ts、src/hljs-dark.css、src/style.css、src/main.ts、RenderedMarkdown、ReadingPane、pdfExport.ts、PDF/Markdown E2E |
| Behavior changed | none |
| Main risk | 漏掉 v-html、PDF clone、MarkMap/Mermaid 或 transitive hljs contract |
| Tests required | typecheck、test:unit、build；Markdown/PDF focused tests；正常 CI fixture 基线 |
| Manual validation | 逐项核对调用流、data-theme precedence、PDF trusted style、direct search 分类 |
| Exit criteria | 真实代码路径和现存测试地图完成，所有后续 phase 的文件边界明确 |
| Can rollback independently? | Yes；H0 不产生行为变更 |

### SHIKI-H1 table

| Item | Content |
| --- | --- |
| Goal | 建立可复用的 Shiki singleton、双 theme 和 transformer 基础 |
| Files likely changed | package.json、package-lock.json、src/lib/shiki.ts、新的 runtime unit test；必要时仅加入测试 hook |
| Behavior changed | 不切换当前 Markdown renderer；用户仍看到 highlight.js |
| Main risk | Shiki API/version、Node/browser compatibility、初始 bundle 变大 |
| Tests required | one highlighter、theme availability、transformer CSS、rejected init retry、no document |
| Manual validation | inspect build chunks，确认不是将所有 grammar 放入 initial entry |
| Exit criteria | runtime 独立可用，且不会改变当前页面 |
| Can rollback independently? | Yes；删除新增依赖/module 即可恢复 |

### SHIKI-H2 table

| Item | Content |
| --- | --- |
| Goal | 在 MarkdownIt 同步 render 前可靠准备需要的 language |
| Files likely changed | src/lib/shiki.ts、必要的 src/lib/markdown.ts preflight seam、新增 Shiki/discovery tests |
| Behavior changed | render 增加 isolated token discovery 和按需 Shiki preparation；正常 renderer 仍输出 highlight.js |
| Main risk | double parse、info/meta 解析、alias registry、concurrent load race |
| Tests required | js/javascript、ts/typescript、py、sh、yml；whitespace/meta；empty；unknown；special fences；concurrent renders；resolver call count |
| Manual validation | 连续打开多个不同语言文档，观察只加载所需 grammar；确认正常 HTML 仍为 `hljs` |
| Exit criteria | unique canonical language load、failure isolation 和 isolated resolver env 通过 |
| Can rollback independently? | Yes；旧 renderer 未切换 |

### SHIKI-H3 table

| Item | Content |
| --- | --- |
| Goal | 将 normal code fence renderer 切换为 Shiki |
| Files likely changed | src/lib/markdown.ts、src/lib/shiki.ts、src/lib/__tests__/markdown.test.ts、new Shiki regression tests |
| Behavior changed | normal `pre.hljs` 变为 `pre.shiki`；unknown/empty/unavailable/error 变为 escaped `nuvyn-shiki-plain`；special fences 和 render API 不变 |
| Main risk | Shiki callback 必须同步、fallback escaping、MarkdownIt env 复用、DOMPurify 暂时吞掉 styles |
| Tests required | JS/TS/Java/SQL/Python、aliases/meta、unknown/empty、grammar/codeToHtml failure、runtime retry、MarkMap、Mermaid、sanitizer、existing Markdown suite |
| Manual validation | 代表语言、malformed/unknown fence、light/dark Markdown visual、PDF export/layout/pagination regression |
| Exit criteria | normal fence 真实使用 Shiki；per-fence failures安全 fallback；旧 hljs normal output 消失；非高亮 Markdown、special fences、resolver 和 PDF regressions 通过 |
| Can rollback independently? | Yes；恢复 markdown.ts renderer path，旧依赖仍在 |

### SHIKI-H4 table

| Item | Content |
| --- | --- |
| Goal | 关闭 style-to-class 和 sanitizer security gap |
| Files likely changed | src/lib/shiki.ts、必要的 markdown integration、Markdown/security unit tests |
| Behavior changed | token colors 从 inline style contract 转为 trusted generated classes |
| Main risk | style 被 sanitizer 删除、generated CSS 放错位置、class/CSS dedup 失败 |
| Tests required | no Shiki style、user style stripped、onclick stripped、class survives、single style owner、no article style |
| Manual validation | DevTools 检查 article HTML、head style ID 和 raw HTML injection |
| Exit criteria | DOMPurify unchanged；token classes survive；trusted CSS snapshot has one head owner；article has no Shiki/user inline style；最终主题可见色留给 H5 |
| Can rollback independently? | Yes；但不能以跳过 H4 作为 release shortcut |

### SHIKI-H5 table

| Item | Content |
| --- | --- |
| Goal | 用 CSS dual-theme 接入 Nuvyn light/dark precedence |
| Files likely changed | src/shiki.css、src/main.ts、e2e/markdown-shiki-theme.spec.ts；必要时 visual snapshots |
| Behavior changed | theme switch 改变 Shiki palette，但不重新 render |
| Main risk | selector specificity、OS/forced precedence、当前 useTheme snapshot semantics |
| Tests required | system light/dark、forced light/dark、data-theme precedence、innerHTML unchanged、tokenization count unchanged |
| Manual validation | reader 在四类主题下切换，确认 code/background/layout 与 Nuvyn 一致 |
| Exit criteria | explicit light/dark precedence、no-attribute OS fallback、computed token/pre colors、readable plain fallback and CSS-only no-rerender contract all proven |
| Can rollback independently? | Yes；恢复 CSS/import 即可，Shiki renderer 仍可保留 |

### SHIKI-H6 table

| Item | Content |
| --- | --- |
| Goal | 让 printable PDF 始终使用 light Shiki palette |
| Files likely changed | src/lib/pdfExport.ts、src/lib/__tests__/pdfExport.test.ts、e2e/pdf-export.spec.ts、e2e/pdf-export-shiki.spec.ts、e2e/fixtures/pdf-export-shiki-code.md、e2e/markdown-shiki-theme.spec.ts |
| Behavior changed | PDF clone 新增 Shiki light overrides；reader 不变 |
| Main risk | head stylesheet 不在 html2pdf clone、token color 被统一 body color、分页/宽度回归 |
| Tests required | PDF unit 14/14；Shiki/Markdown/MarkMap/PDF-readiness focused 123/123；H6 clone matrix 1/1；existing PDF export 2/2；layout/pagination/stress 9/9；H4 security、H5 theme、Markdown visual |
| Manual validation | 保存真实 PDF，检查 token colors、white background、long lines、page transitions |
| Exit criteria | PDF light/color/wrap/pagination/cleanup all pass；actual html2canvas clone computed token evidence exists；H7 cleanup was pending at H6 completion and is now recorded separately as complete |
| Can rollback independently? | Yes；只回滚 PDF overrides，不回滚 reader |

### SHIKI-H7 table — COMPLETE

| Item | Content |
| --- | --- |
| Goal | 删除已经没有消费者的 Nuvyn-owned highlight.js runtime/CSS/test contract |
| Files changed | package.json、package-lock.json、删除 src/hljs-dark.css、server/ai/prompt.md、H6 metadata/typo、H7 evidence、README、implementation plan |
| Behavior changed | no intended visual behavior change；只删除旧 implementation surface，normal renderer 仍为 Shiki |
| Main risk | hidden import、MarkMap-owned hljs contract、非规范 pnpm lock importer、rollback 变难 |
| Tests required | full pre/post rg ownership audit、Shiki/Markdown/security/MarkMap/PDF tests、typecheck、build、full unit suite |
| Manual validation | `npm ls/explain highlight.js`、inspect emitted assets、确认 no .hljs application CSS、检查 direct root edge |
| Exit criteria | Nuvyn-owned runtime/CSS references clean；MarkMap/transitive/noncanonical/historical hits 全部分类；H8 仍未开始 |
| Can rollback independently? | Yes；作为单独 reviewable cleanup commit |

### SHIKI-H8 table — COMPLETE

| Item | Content |
| --- | --- |
| Goal | 完成全回归、bundle audit 和 release evidence |
| Files changed | H8 evidence、PRD/Implementation Plan/README 状态收口、H7 completion metadata、已证明非规范且未使用的 pnpm-lock.yaml 删除 |
| Behavior changed | none beyond already verified migration |
| Main risk | eager language chunks、跨平台差异、PDF browser-only regression |
| Tests required | typecheck、focused/extended client、unit、history/recovery integration、build、relevant E2E、npm ci、bundle inspection |
| Manual validation | `pdf-export-shiki-code.md` 覆盖 JS/TS/Java/SQL/Python/unknown；四 theme、MarkMap/Mermaid、code-heavy PDF 和 lazy asset audit 均有证据 |
| Exit criteria | Release Gate 全部关闭，PRD DoD 每项均为 PASS |
| Can rollback independently? | Yes；H8 只收口证据/文档与已证明的 lock hygiene，生产行为未改 |

## 17. Test matrix

| Area | Case | Expected result | Real test file / evidence |
| --- | --- | --- | --- |
| JS | normal highlight | pre.shiki > code，token classes，no inline style | src/lib/__tests__/markdown.test.ts；new Shiki regression test |
| TS | normal highlight | TypeScript grammar loads on demand | new Shiki regression test |
| Java | normal highlight | Java grammar loads on demand | new Shiki regression test |
| SQL | normal highlight | SQL token colors remain readable | new Shiki regression test |
| Python | normal highlight | Python token colors remain readable | new Shiki regression test |
| alias | js / ts / py / sh / yml | aliases resolve to canonical grammar | new discovery/runtime test |
| language whitespace | fence info 为 py and upper-case identifiers | trim/lowercase works | new discovery/runtime test |
| fence meta | js title=demo | only js is loaded; meta is not language | new discovery/runtime test |
| empty language | empty info fence | normal escaped plain code | src/lib/__tests__/markdown.test.ts plus new test |
| unknown language | totally-unknown | escaped fallback，render resolves | new Shiki regression test |
| HTML injection | code contains script/a/onclick | source displayed as text，never HTML | markdown/security tests |
| Markdown HTML style | raw span style=color:red | style stripped | src/lib/__tests__/markdown.test.ts |
| event handler | onclick/onerror/onload | attribute stripped | src/lib/__tests__/markdown.test.ts；markmapSecurity |
| URI | javascript URL | URL removed/rejected | markdown/security tests |
| Shiki style | highlighted output | zero Shiki inline style attributes | new security test |
| Shiki classes | sanitized output | token class survives DOMPurify | new security test |
| MarkMap | markmap fence | .markmap-mount/data-content unchanged；Shiki not called | markdown.test、markmapSecurity、MarkMap tests |
| Mermaid | mermaid fence | .mermaid-mount/data-content unchanged；Shiki not called | markdown.test、Mermaid tests |
| similar special lang | mmap / merm | not treated as special mount | markdown.test |
| system light | no explicit dark override + light OS | light palette | theme unit/E2E |
| system dark | no explicit light override + dark OS | dark palette | theme unit/E2E |
| forced light | data-theme=light under dark OS | light wins | e2e/markdown-visual.spec.ts plus selector test |
| forced dark | data-theme=dark under light OS | dark wins | e2e/markdown-visual.spec.ts plus selector test |
| theme switching | flip theme | HTML/tokenization unchanged；CSS changes only | new runtime/theme test |
| concurrent renders | A/B render simultaneously | one highlighter，isolated resolver env | markdown.test plus runtime test |
| duplicate language loading | ten JS fences / repeated renders | one JS load | runtime test with load spy |
| initialization failure | highlighter init rejects | current call fails，next call can retry | runtime test |
| language failure | one grammar load rejects | only that fence falls back | runtime test |
| generated CSS | multiple renders/languages | one stable owner ID，no duplicate styles | jsdom runtime test |
| generated CSS growth | new token combination | same style element gets complete updated CSS | jsdom runtime test |
| no document | runtime in non-browser context | no DOM access，CSS snapshot still testable | runtime test |
| PDF | reader light/dark/forced dark | PDF always light | e2e/pdf-export.spec.ts |
| PDF token colors | Shiki code in clone | light token colors survive | pdfExport unit + browser snapshot |
| PDF background | Shiki pre | white/light background | pdfExport.test.ts / E2E |
| PDF long code | long unbroken line | wraps，no horizontal clipping | e2e/pdf-export-layout.spec.ts |
| PDF code-heavy document | many/huge code fences | exports without throw，oversized block can split | e2e/pdf-export-stress.spec.ts |
| PDF pagination | ordinary paragraph/list boundary | existing keep-together behavior | e2e/pdf-export-pagination.spec.ts |
| PDF widgets | Mermaid/MarkMap | static representation unchanged | PDF layout/stress suites |
| Markdown extensions | tasks/headings/footnotes/deflist/mark/callout/math/emoji/table/wiki links | behavior unchanged | src/lib/__tests__/markdown.test.ts and existing extension tests |
| bundle | language grammar chunks | no eager all-language inclusion | H8 Vite output inspection |

## 18. Performance budget / bundle audit

目标不是让 Shiki 完全没有 bundle 增长。目标是证明增长来自按需能力，而不是错误地把全语言目录、重复 highlighter 或重复 tokenization 放入初始路径。

### 18.1 H0/H8 对比内容

在同一 Node、同一 npm lock 和 clean dist 条件下记录：

- initial application JS entry 的 raw/gzip size；
- VaultView / Markdown runtime chunk 的 raw/gzip size；
- Shiki runtime chunk 的 raw/gzip size；
- language grammar chunks 的数量和大小；
- github-light/github-dark theme 相关 chunk 或 CSS；
- generated Shiki CSS 的大小；
- 当前 baseline 的 github-*.css、hljs-dark-*.css 与 H8 的替代 CSS；
- 首次加载没有打开 Markdown code fence 时的 network/chunk 请求；
- 首次打开 JS、再打开 Java/SQL 后新增的 chunks。

### 18.2 需要证明的 invariants

- initial JS 不包含所有 Shiki language grammar；
- 未使用的 grammar 不会因 import bundled catalog 而全部落入 initial chunk；
- highlighter 只创建一次；
- 同一种 grammar 不会重复加载；
- theme switch 不再次调用 codeToHtml/tokenization；
- generated CSS 不会按 render/code block 无限增长；
- render A/B/C 不创建多个 style owner；
- unknown language 不触发无界 dynamic import。

### 18.3 H8 evidence

H8 必须保存：

1. npm run build 的完整 asset summary；
2. initial entry 与 Shiki/language lazy chunks 的大小对比；
3. 代表语言首次出现时的 chunk/load 证据；
4. highlighter/language/style owner 的 test output；
5. theme switch 无 retokenization 的 test output；
6. 如存在预期 warning，说明 warning 是否来自本迁移或原有依赖。

## 19. Rollback strategy

阶段必须保持可回滚，不永久维护两套 highlighting engine。

### H0-H2

- H0 无行为变更，直接停止即可。
- H1/H2 可以移除 Shiki dependencies/module；highlight.js 仍是 active renderer。
- H2 discovery/runtime 的失败不会影响旧页面，因为未切换 normal fence。

### H3 cutover

- H3 是 renderer cutover 点；
- 如果 normal Shiki HTML、unknown fallback 或 Markdown regression 不满足退出条件，恢复 markdown.ts 到 highlight.js callback；
- 保留或回滚 H1/H2 helper 不应阻止恢复旧 renderer；
- 不得先删除旧 dependency 再尝试回滚。

### H4 security closure

- H4 不能被跳过；
- 如果 token colors 依赖 style 或 generated CSS 不安全，先修复 transformer/CSS owner，或回滚 H3；
- 不能为了让测试变绿而加入 style 到 ALLOWED_ATTR。

### H5-H6

- H5 只回滚 Shiki static CSS/theme selectors，保持 H3/H4 的 HTML contract；
- H6 只回滚 PDF token overrides/clone wiring，不能改变 reader theme 或 Mermaid/MarkMap；
- 若 PDF clone 无法看到 generated CSS，停在 H6 修复可见性，不得宣布 PDF Done。

### H7 cleanup

- H7 应作为独立、可审查的 cleanup boundary；
- 只有 H3-H6 parity 后才删除 highlight.js；
- 若 H7 后发现遗漏，优先恢复 H7 cleanup commit，而不是永久保留未使用的双 engine；
- MarkMap external/internal hljs 命中必须分类处理，不能破坏 MarkMap 以满足机械 grep。

## 20. Release Gate

migration 不能因为 JavaScript fence 看起来高亮就关闭。以下全部必须有 evidence：

- [x] package.json 已使用 Shiki 4.x 和 matching transformer；
- [x] package-lock.json 由 npm 正常更新；
- [x] highlighter 是 singleton/cached；
- [x] highlighter init failure 不会永久 poison global renderer；
- [x] language discovery 只读取 fence tokens；
- [x] common aliases 和 fence meta/whitespace 已验证；
- [x] languages 按需加载，没有 eager all-language grammar；
- [x] unknown language 是 escaped plain-code fallback；
- [x] normal output 是 Shiki semantic pre/code contract；
- [x] transformerStyleToClass 或等价 class-based transformer 已使用；
- [x] sanitized Markdown HTML 没有 Shiki inline style；
- [x] FORBID_ATTR: ['style'] 未移除；
- [x] raw user style/on* 仍被 DOMPurify 删除；
- [x] generated CSS 只有一个 runtime owner 和稳定 ID；
- [x] generated CSS 不进入 sanitized article；
- [x] system light/system dark/forced light/forced dark 都有证据；
- [x] data-theme='light' 覆盖 OS dark；
- [x] data-theme='dark' 强制 dark；
- [x] theme switch 不重新 render/tokenize；
- [x] MarkMap 仍 bypass Shiki；
- [x] Mermaid 仍 bypass Shiki；
- [x] PDF 永远使用 light token palette；
- [x] PDF background、syntax colors、wrapping、pagination、cleanup 均通过；
- [x] Markdown extensions、resolver isolation、security regressions 均通过；
- [x] existing Markdown/PDF/MarkMap/Mermaid tests 通过；
- [x] new Shiki regression tests 通过；
- [x] npm run typecheck 通过；
- [x] npm run test:unit 通过；
- [x] npm run build 通过；
- [x] Vite bundle audit 证明语言仍 lazy；
- [x] Nuvyn-owned highlight.js/hljs/.hljs runtime/CSS references 已清理；
- [x] no unrelated parser/UI/PDF redesign slipped in。

H8 evidence 已逐项关闭上述 Release Gate；计划状态现为 MIGRATION COMPLETE。
H7 的 cleanup checkbox 仍由 H7 evidence 单独证明，但 H8 已复核其直接依赖、
source ownership 和 MarkMap transitive boundary。

## 21. Explicit non-goals

实现阶段不得顺便计划以下功能：

- line numbers；
- copy-code button；
- filename/title bar；
- line highlighting；
- code folding；
- diff UI/diff annotations；
- focus/highlight lines；
- Twoslash；
- Monaco code blocks/Monaco integration；
- editable code blocks；
- new Markdown syntax；
- user-selectable syntax themes；
- code-specific theme selector；
- Markdown parser migration；
- markdown-it-async migration；
- PDF redesign；
- Mermaid/MarkMap lifecycle redesign。

这些能力可以作为独立后续需求，但不应混入本次 Shiki foundation migration。

## 22. 首次文档落盘范围（历史记录）

本节保留 implementation plan 首次创建时的 allowed-change 记录；它不覆盖
已经完成的 H1/H2 source/runtime changes。

本次 task 的 allowed changes 只有：

1. 清理 docs/design/syntax-highlighting-shiki-migration-prd.md 的 H1 之前聊天前言，保留 H1 之后的 PRD requirement 原文；
2. 新增本文件；
3. 在 docs/README.md 的 Design 下保留 PRD link，并紧邻增加本 implementation plan link。

索引顺序应为：

1. Shiki Syntax Highlighting Migration PRD；
2. Shiki Syntax Highlighting Migration Implementation Plan；
3. PDF Export V1 PRD；
4. PDF Export V1 Implementation Plan；
5. 其他 design documents。

首次 plan task 不修改 package.json、package-lock.json、src/**、server/**、shared/** 或 e2e/**。当时提交完成后的期望状态：

~~~
PRD: CLEAN
Implementation Plan: READY
Shiki implementation: NOT STARTED（initial plan task 的历史状态）
~~~

## 23. Documentation-only validation and commit boundary

计划提交前必须执行：

~~~bash
head -n 1 docs/design/syntax-highlighting-shiki-migration-prd.md
test -f docs/design/syntax-highlighting-shiki-migration-implementation-plan.md
grep -n "Shiki Syntax Highlighting" docs/README.md
git diff --check
git diff -- docs/README.md \
  docs/design/syntax-highlighting-shiki-migration-prd.md \
  docs/design/syntax-highlighting-shiki-migration-implementation-plan.md
~~~

预期：

- head 第一行严格为 Nuvyn — Replace highlight.js with Shiki；
- implementation plan file 存在；
- README 同时列出 PRD 和 Implementation Plan；
- git diff --check 无 whitespace error；
- diff 只包含三个允许的文档文件；
- 不运行或声称已完成 Shiki implementation。

建议提交信息：

~~~text
docs(shiki): add migration implementation plan
~~~

提交后停止，不要在同一 task 中开始 H1 或修改任何 Shiki production code。
