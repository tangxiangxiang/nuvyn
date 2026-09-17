import html2pdf from 'html2pdf.js'
import { parseDoc } from './frontmatter'
import { getGeneratedShikiCss } from './shiki'

export interface PdfDownloadOptions {
  /** The default filename used by the browser download. */
  title: string
  /** Already-prepared article HTML from the rendered reading surface. */
  articleHtml: string
}

const A4_PAGE_WIDTH_MM = 210
const A4_PAGE_HEIGHT_MM = 297
const PDF_PAGE_MARGIN_TOP_MM = 16
const PDF_PAGE_MARGIN_RIGHT_MM = 18
const PDF_PAGE_MARGIN_BOTTOM_MM = 18
const PDF_PAGE_MARGIN_LEFT_MM = 18
const PDF_PRINTABLE_PAGE_WIDTH_MM = A4_PAGE_WIDTH_MM
  - PDF_PAGE_MARGIN_LEFT_MM
  - PDF_PAGE_MARGIN_RIGHT_MM
const PDF_PRINTABLE_PAGE_HEIGHT_MM = A4_PAGE_HEIGHT_MM
  - PDF_PAGE_MARGIN_TOP_MM
  - PDF_PAGE_MARGIN_BOTTOM_MM
const CSS_PX_PER_MM = 96 / 25.4
const PDF_PRINTABLE_PAGE_HEIGHT_PX = PDF_PRINTABLE_PAGE_HEIGHT_MM * CSS_PX_PER_MM

const PDF_DOWNLOAD_STYLES = `
@page {
  size: A4;
  margin: 16mm 18mm 18mm;
}

.pdf-download-root {
  margin: 0;
  padding: 0;
  color-scheme: light;
  background: #ffffff;
  color: #202124;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

/* Keep the vault's markdown selectors active while removing the app chrome
   and the scroll container that only makes sense in the live reader. */
.pdf-document.vault {
  display: block !important;
  width: auto !important;
  height: auto !important;
  min-height: 0 !important;
  overflow: visible !important;
  background: #ffffff !important;
  color: #202124 !important;
  --vs-bg-1: #ffffff !important;
  --vs-bg-2: #f5f6f8 !important;
  --vs-bg-3: #e9edf2 !important;
  --vs-border: #d7dce2 !important;
  --vs-text-1: #202124 !important;
  --vs-text-2: #4b5563 !important;
  --vs-text-3: #6b7280 !important;
  --vs-accent: #005fb8 !important;
  --vs-accent-hover: #0258a8 !important;
  --vs-hover-bg: #eef3f8 !important;
  --vs-table-border: #d7dce2 !important;
  --text: #202124 !important;
  --text-h: #111827 !important;
  --text-muted: #4b5563 !important;
  --bg: #ffffff !important;
  --bg-soft: #f5f6f8 !important;
  --border: #d7dce2 !important;
  --code-bg: #f5f6f8 !important;
  --accent: #005fb8 !important;
}

.pdf-document .reading-pane {
  display: block !important;
  width: auto !important;
  height: auto !important;
  min-height: 0 !important;
  overflow: visible !important;
  padding: 0 !important;
}

.pdf-document .article.reading {
  display: block !important;
  width: auto !important;
  max-width: none !important;
  min-width: 0 !important;
  margin: 0 !important;
  padding: 0 !important;
  color: #202124 !important;
  font-size: 11.5pt !important;
  line-height: 1.68 !important;
}

.pdf-document .article :where(h1, h2, h3, h4, h5, h6) {
  color: #111827 !important;
  break-inside: avoid;
  page-break-inside: avoid;
  break-after: avoid;
  page-break-after: avoid;
}

.pdf-document .article h1 {
  margin-top: 0 !important;
  font-size: 25pt !important;
}

.pdf-document .article h2 {
  font-size: 17pt !important;
}

.pdf-document .article h3 {
  font-size: 13.5pt !important;
}

.pdf-document .article h4,
.pdf-document .article h5,
.pdf-document .article h6 {
  font-size: 11.5pt !important;
}

.pdf-document .article a {
  color: inherit !important;
  text-decoration: none !important;
}

.pdf-document .article pre,
.pdf-document .article blockquote,
.pdf-document .article p,
.pdf-document .article li,
.pdf-document .article .table-scroll,
.pdf-document .article .nuvyn-code-group-pdf-item,
.pdf-document .article img,
.pdf-document .article .markmap-widget,
.pdf-document .article .mermaid-widget-host {
  break-inside: avoid;
  page-break-inside: avoid;
}

.pdf-document .article pre {
  overflow: visible !important;
  white-space: pre-wrap !important;
  overflow-wrap: anywhere;
  background: #f5f6f8 !important;
  border: 1px solid #d7dce2 !important;
  color: #202124 !important;
}

.pdf-document .article pre code {
  white-space: inherit !important;
  overflow-wrap: anywhere !important;
  word-break: break-word !important;
}

/* MD-EXT-4 numbered fences reuse the already-rendered structural gutter. The
   printable layout keeps the gutter intrinsic, lets the content column wrap,
   and never derives CSS from the author-supplied start value. */
.pdf-document .article pre.shiki.nuvyn-line-numbers {
  white-space: pre-wrap !important;
}

.pdf-document .article pre.shiki.nuvyn-line-numbers code {
  display: block !important;
  width: 100% !important;
  min-width: 0 !important;
}

.pdf-document .article pre.shiki.nuvyn-line-numbers .line {
  display: grid !important;
  grid-template-columns: max-content minmax(0, 1fr) !important;
  column-gap: 0.75rem;
  align-items: start;
  width: 100%;
  min-width: 0;
}

.pdf-document .article pre.shiki:not(.nuvyn-line-numbers):not(.nuvyn-shiki-plain) .line {
  display: inline-block !important;
  width: 100% !important;
  min-width: 100% !important;
}

.pdf-document .article pre.shiki.nuvyn-line-numbers .nuvyn-line-number {
  display: block;
  min-width: max-content;
  padding-right: 0.6rem;
  border-right: 1px solid #b8c0ca;
  color: #6b7280 !important;
  background-color: transparent !important;
  text-align: right;
  user-select: none;
  white-space: pre;
}

.pdf-document .article pre.shiki.nuvyn-line-numbers .nuvyn-line-content {
  display: block;
  min-width: 0;
  overflow-wrap: anywhere !important;
  word-break: break-word !important;
  white-space: inherit !important;
  background-color: transparent !important;
}

/* Shiki's generated CSS contains trusted light/dark variables, while the
   reader's static stylesheet selects one palette from the live root theme.
   PDF is a separate printable boundary: consume the light variables here so
   a dark reader or a dark html2canvas clone cannot leak dark token colors. */
.pdf-document .article pre.shiki:not(.nuvyn-shiki-plain) {
  color: var(--shiki-light) !important;
  background-color: var(--shiki-light-bg) !important;
}

.pdf-document .article pre.shiki:not(.nuvyn-shiki-plain) span {
  color: var(--shiki-light) !important;
}

/* Plain/unknown fences do not have Shiki variables. Keep their established
   printable fallback surface explicit instead of resolving undefined vars. */
.pdf-document .article pre.shiki.nuvyn-shiki-plain,
.pdf-document .article pre.shiki.nuvyn-shiki-plain span {
  color: #202124 !important;
  background-color: #f5f6f8 !important;
}

/* The generic Shiki span rule above intentionally forces token colors to the
   printable-light palette. Reassert the non-token structural surfaces after
   it so the gutter stays muted and annotation backgrounds remain visible. */
.pdf-document .article pre.shiki.nuvyn-line-numbers .nuvyn-line-number {
  color: #6b7280 !important;
  background-color: transparent !important;
}

.pdf-document .article pre.shiki.nuvyn-line-numbers .nuvyn-line-content {
  background-color: transparent !important;
}

/* MD-EXT-3 annotation classes remain structural in print. These selectors
   add printable-light line cues without overriding Shiki token foregrounds;
   token colors continue to come from the trusted light variables above. */
.pdf-document .article pre.shiki .line.highlighted {
  background-color: #fff3c4 !important;
  box-shadow: inset 3px 0 0 #8a6400;
}

.pdf-document .article pre.shiki .line.focused {
  background-color: #dcecff !important;
  box-shadow: inset 3px 0 0 #005fb8;
}

.pdf-document .article pre.shiki .line.diff.add {
  background-color: #e1f4e5 !important;
  box-shadow: inset 3px 0 0 #217a37;
}

.pdf-document .article pre.shiki .line.diff.remove {
  background-color: #fde7e9 !important;
  box-shadow: inset 3px 0 0 #b42318;
}

.pdf-document .article pre.shiki .line.warning {
  background-color: #fff3c4 !important;
  box-shadow: inset 3px 0 0 #8a6400;
}

.pdf-document .article pre.shiki .line.error {
  background-color: #fde7e9 !important;
  box-shadow: inset 3px 0 0 #b42318;
}

.pdf-document .article pre.shiki .line.info {
  background-color: #dcecff !important;
  box-shadow: inset 3px 0 0 #005fb8;
}

/* Code groups are interactive in the reader, but a PDF is a complete
   source-order export. preparePdfArticleHtml() removes the tablist and puts
   every labeled panel into this printable surface. Keep the panel contents
   themselves responsible for Shiki token and line-number colors. */
.pdf-document .article .nuvyn-code-group {
  box-sizing: border-box;
  margin: 1em 0 !important;
  border: 1px solid #d7dce2 !important;
  border-radius: 4px;
  overflow: visible !important;
  background: #ffffff !important;
  color: #202124 !important;
}

.pdf-document .article .nuvyn-code-group-tabs {
  display: none !important;
}

.pdf-document .article .nuvyn-code-group-panels {
  display: block !important;
}

.pdf-document .article .nuvyn-code-group-pdf-item {
  display: block !important;
  break-inside: avoid;
  page-break-inside: avoid;
  padding: 0.7em 0.8em 0.8em;
}

.pdf-document .article .nuvyn-code-group-pdf-item + .nuvyn-code-group-pdf-item {
  border-top: 1px solid #d7dce2;
}

.pdf-document .article .nuvyn-code-group-pdf-label {
  margin: 0 0 0.45em !important;
  color: #005fb8 !important;
  font: 600 10.5pt/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
}

.pdf-document .article .nuvyn-code-group-panel {
  display: block !important;
  min-width: 0;
}

.pdf-document .article blockquote {
  background: #f5f6f8 !important;
  border-left-color: #005fb8 !important;
  color: #4b5563 !important;
}

/* Resolve the shared Nuvyn notice-card palette at the printable boundary.
   Reader theme variables never leak into the printable document. */
.pdf-document .article .callout,
.pdf-document .article .markdown-container {
  --notice-bg: #f1f2f4 !important;
  margin: 1rem 0 !important;
  padding: 0.75rem 1rem !important;
  border: 0 !important;
  border-radius: 12px !important;
  background: var(--notice-bg) !important;
  box-shadow: none !important;
  color: #202124 !important;
  font-size: 0.875rem !important;
  line-height: 1.5 !important;
}
.pdf-document .article .callout-note,
.pdf-document .article .markdown-container-info,
.pdf-document .article .markdown-container-details {
  --notice-bg: #f1f2f4 !important;
}
.pdf-document .article .callout-tip,
.pdf-document .article .markdown-container-tip {
  --notice-bg: #eef0ff !important;
}
.pdf-document .article .callout-important {
  --notice-bg: #f3edff !important;
}
.pdf-document .article .callout-warning,
.pdf-document .article .markdown-container-warning {
  --notice-bg: #fff7e3 !important;
}
.pdf-document .article .callout-caution,
.pdf-document .article .markdown-container-danger {
  --notice-bg: #ffe9ec !important;
}
.pdf-document .article .callout-title,
.pdf-document .article .markdown-container-title {
  margin: 0 0 0.35rem !important;
  color: #202124 !important;
  font-size: 0.875rem !important;
  font-weight: 700 !important;
  line-height: 1.4 !important;
  break-after: avoid;
  page-break-after: avoid;
}
.pdf-document .article .callout-content { color: inherit !important; }
.pdf-document .article .callout-content > :first-child { margin-top: 0 !important; }
.pdf-document .article .callout-content > :last-child { margin-bottom: 0 !important; }
.pdf-document .article .markdown-container > .markdown-container-title + :not(.markdown-container-title) {
  margin-top: 0 !important;
}
.pdf-document .article .markdown-container > :last-child { margin-bottom: 0 !important; }
.pdf-document .article .markdown-container-details > summary { cursor: default !important; }

.pdf-document .article .table-scroll {
  box-sizing: border-box;
  width: 100% !important;
  max-width: 100% !important;
  min-width: 0 !important;
  overflow: visible !important;
  border-color: #d7dce2 !important;
  background: #ffffff !important;
}

.pdf-document .article .table-scroll > table {
  width: 100% !important;
  min-width: 0 !important;
  max-width: 100% !important;
  table-layout: fixed !important;
  font-size: 10.5pt !important;
}

.pdf-document .article th {
  background: #eef1f4 !important;
}

.pdf-document .article th,
.pdf-document .article td {
  border-color: #d7dce2 !important;
  white-space: normal !important;
  overflow-wrap: anywhere !important;
  word-break: break-word !important;
}

/* Resolve the reader's alternating-row color-mix() before html2canvas
   parses the PDF clone. The PDF keeps a quiet printable row background and
   never relies on the interactive hover state. */
.pdf-document .article tbody tr,
.pdf-document .article tbody tr:nth-child(even),
.pdf-document .article tbody tr:hover {
  background: #ffffff !important;
}

.pdf-document .article thead {
  display: table-header-group;
}

.pdf-document .article img {
  max-width: 100% !important;
  height: auto !important;
}

/* Mermaid is interactive in the reader: the live widget has a fixed
   height, svg-pan-zoom transforms, and a hover toolbar. Those rules are
   useful on screen but make a PDF snapshot easy to clip or scale twice.
   preparePdfArticleHtml() turns the widget into a static SVG; these rules
   give that SVG a document-width, viewBox-driven layout for the download. */
.pdf-document .article .mermaid-widget-host,
.pdf-document .article .pdf-mermaid {
  break-inside: avoid !important;
  page-break-inside: avoid !important;
}

.pdf-document .article .mermaid-widget-host {
  display: block !important;
  width: 100% !important;
  min-height: 0 !important;
  margin: 1.15em 0 !important;
  font-size: 1em !important;
  line-height: normal !important;
}

.pdf-document .article .pdf-mermaid {
  display: block !important;
  width: 100% !important;
  margin: 0 !important;
  padding: 0 !important;
  overflow: visible !important;
  background: #ffffff !important;
  text-align: center !important;
}

.pdf-document .article .pdf-mermaid > svg {
  display: block !important;
  width: 100% !important;
  height: auto !important;
  max-width: 100% !important;
  margin: 0 auto !important;
  overflow: visible !important;
  background: transparent !important;
}

/* MarkMap's reader SVG has no stable viewBox: Markmap uses a root-group
   transform for auto-fit and keeps the widget at a fixed screen height. The
   export surface captures that settled fit transform, and the static clone
   below reuses it in a document-width box without the reader toolbar. */
.pdf-document .article .pdf-markmap {
  display: block !important;
  width: 100% !important;
  height: 480px !important;
  margin: 1.15em 0 !important;
  overflow: visible !important;
  break-inside: avoid !important;
  page-break-inside: avoid !important;
}

/* html2pdf.js understands break-inside: avoid on a block, but it does not
   interpret break-after: avoid on a heading. Keep a diagram heading in the
   same pagination unit as its widget so a widget that moves to the next page
   cannot leave its heading behind. */
.pdf-document .article .pdf-heading-group {
  display: block !important;
  break-inside: avoid !important;
  page-break-inside: avoid !important;
}

/* Keep short blocks together, but let a block that is taller than the
   printable A4 page continue onto the next page. The class is added only to
   the PDF clone after its real browser geometry is available. */
.pdf-document .article .pdf-allow-split {
  break-inside: auto !important;
  page-break-inside: auto !important;
}

.pdf-document .article .pdf-markmap > svg {
  display: block !important;
  width: 100% !important;
  height: 480px !important;
  max-width: 100% !important;
  overflow: visible !important;
  background: transparent !important;
}

.pdf-document .article .pdf-markmap-error {
  box-sizing: border-box;
  min-height: 3em;
  padding: 0.8em 1em;
  color: #4b5563 !important;
  background: #f5f6f8 !important;
  border: 1px solid #d7dce2 !important;
}

.pdf-document .article .markmap-toolbar-area,
.pdf-document .article .mermaid-toolbar-area,
.pdf-document .article button {
  display: none !important;
}
`

/** Make a browser-friendly filename while preserving Unicode titles. */
export function sanitizePdfFileName(value: string): string {
  const sanitized = value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
  return (sanitized || 'nuvyn-document').slice(0, 120)
}

/** Pick the same human-facing title a reader sees when the caller has no tab title. */
export function resolvePdfDocumentLabel(input: {
  raw: string
  documentTitle?: string
  documentPath?: string
}): string {
  const parsed = parseDoc(input.raw)
  const frontmatterTitle = typeof parsed.frontmatter.title === 'string'
    ? parsed.frontmatter.title.trim()
    : ''
  if (frontmatterTitle) return frontmatterTitle

  const headingTitle = parsed.content.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim() ?? ''
  if (headingTitle) {
    return headingTitle
      .replace(/[`*_~]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  }

  const documentTitle = input.documentTitle?.trim() ?? ''
  if (documentTitle) return documentTitle

  const basename = input.documentPath?.split('/').pop()?.replace(/\.md$/i, '').trim() ?? ''
  return basename || 'nuvyn-document'
}

function stripPanZoomViewport(svg: SVGSVGElement): void {
  for (const viewport of svg.querySelectorAll<SVGGElement>('.svg-pan-zoom_viewport')) {
    /* svg-pan-zoom stores the current fit/pan state as both an SVG
       transform attribute and an inline CSS transform. A PDF clone
       has a different width from the reader, so carrying that matrix over
       would make the diagram look offset, tiny, or clipped. */
    viewport.removeAttribute('transform')
    viewport.style.removeProperty('transform')
    if (!viewport.style.cssText.trim()) viewport.removeAttribute('style')
    const classNames = (viewport.getAttribute('class') ?? '')
      .split(/\s+/)
      .filter((name) => name && name !== 'svg-pan-zoom_viewport')
    if (classNames.length > 0) viewport.setAttribute('class', classNames.join(' '))
    else viewport.removeAttribute('class')
  }
}

function prepareMermaidSvg(source: SVGSVGElement): SVGSVGElement {
  const svg = source.cloneNode(true) as SVGSVGElement
  const originalViewBox = svg.getAttribute('data-mermaid-viewbox')
    ?? svg.getAttribute('viewBox')
  if (originalViewBox) svg.setAttribute('viewBox', originalViewBox)
  /* Mermaid's live component and svg-pan-zoom both write inline sizing
     metadata. Let the PDF stylesheet size the clone from its viewBox. */
  svg.removeAttribute('width')
  svg.removeAttribute('height')
  svg.removeAttribute('style')
  svg.removeAttribute('data-pan-zoom-bound')
  svg.removeAttribute('data-mermaid-viewbox')
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
  stripPanZoomViewport(svg)
  return svg
}

function prepareMarkmapSvg(source: SVGSVGElement): SVGSVGElement {
  const svg = source.cloneNode(true) as SVGSVGElement
  /* MarkMap has no diagram viewBox. Its settled auto-fit lives on the direct
     root <g>; restore the fit captured by the isolated export surface so a
     reader-side pan/zoom can never leak into the PDF clone. */
  const fitTransform = source.getAttribute('data-markmap-fit-transform')
  const rootGroup = Array.from(svg.children).find((child) => child.tagName.toLowerCase() === 'g')
  if (rootGroup?.tagName.toLowerCase() === 'g' && fitTransform) {
    rootGroup.setAttribute('transform', fitTransform)
  }

  /* The live MarkMap SVG is CSS-sized and intentionally has no viewBox. Give
     the clone the export surface's user coordinate system; otherwise canvas
     renderers use SVG's 300x150 fallback and the graph collapses into a tiny
     clipped corner. */
  const viewport = source.getAttribute('data-markmap-viewport')?.trim() ?? ''
  const [width, height] = viewport.split(/\s+/).map(Number)
  if (!svg.getAttribute('viewBox') && Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
    svg.setAttribute('width', String(width))
    svg.setAttribute('height', String(height))
  }

  svg.removeAttribute('style')
  svg.removeAttribute('data-markmap-fit-transform')
  svg.removeAttribute('data-markmap-viewport')
  const classNames = (svg.getAttribute('class') ?? '')
    .split(/\s+/)
    .filter((name) => name && name !== 'markmap-svg' && !name.startsWith('mm-'))
  if (!classNames.includes('markmap')) classNames.push('markmap')
  svg.setAttribute('class', classNames.join(' '))
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
  svg.setAttribute('data-markmap-static', 'true')
  return svg
}

function unwrapStandaloneFenceWidget(host: HTMLElement): void {
  /* markdown-it emits custom fences as <pre><code>...</code></pre>. The
     post-mount Vue widget replaces the fence contents but intentionally keeps
     that source wrapper in the reader DOM. A PDF snapshot must remove the
     wrapper: its code-block pagination rule would otherwise separate the
     heading from the static diagram and add an unrelated code background. */
  const code = host.parentElement
  const fence = code?.parentElement
  if (!code || !fence || code.tagName !== 'CODE' || fence.tagName !== 'PRE') return

  const containsOnly = (parent: HTMLElement, child: HTMLElement) =>
    Array.from(parent.childNodes).every((node) => (
      node === child || (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim())
    ))
  if (!containsOnly(code, host) || !containsOnly(fence, code)) return
  fence.replaceWith(host)
}

function isOwnedCodeGroupElement(group: HTMLElement, element: Element): boolean {
  return element.closest('.nuvyn-code-group') === group
}

/**
 * Convert the interactive code-group surface into a complete printable
 * source-order surface. The live reader is never passed to this function;
 * callers invoke it on the already-cloned article. Malformed hand-written
 * lookalikes are left alone rather than losing code content or trusting a
 * source-derived label/ID.
 */
export function preparePdfCodeGroups(root: HTMLElement): void {
  for (const group of Array.from(root.querySelectorAll<HTMLElement>('.nuvyn-code-group'))) {
    const tabsHost = Array.from(group.querySelectorAll<HTMLElement>('.nuvyn-code-group-tabs'))
      .find((element) => isOwnedCodeGroupElement(group, element))
    const panelsHost = Array.from(group.querySelectorAll<HTMLElement>('.nuvyn-code-group-panels'))
      .find((element) => isOwnedCodeGroupElement(group, element))
    if (!tabsHost || !panelsHost) continue

    const tabs = Array.from(tabsHost.querySelectorAll<HTMLElement>('[role="tab"]'))
      .filter((tab) => isOwnedCodeGroupElement(group, tab))
    const panels = Array.from(panelsHost.querySelectorAll<HTMLElement>('[role="tabpanel"]'))
      .filter((panel) => isOwnedCodeGroupElement(group, panel))
    if (tabs.length === 0 || panels.length === 0) continue

    const tabByPanelId = new Map<string, HTMLElement>()
    let valid = true
    for (const tab of tabs) {
      const panelId = tab.getAttribute('aria-controls')
      if (!panelId || tabByPanelId.has(panelId)) {
        valid = false
        break
      }
      tabByPanelId.set(panelId, tab)
    }
    if (
      !valid
      || tabs.length !== panels.length
      || panels.some((panel) => !panel.id || !tabByPanelId.has(panel.id))
    ) continue

    const fragment = group.ownerDocument.createDocumentFragment()
    for (const panel of panels) {
      const tab = tabByPanelId.get(panel.id)
      if (!tab) {
        valid = false
        break
      }

      const item = group.ownerDocument.createElement('div')
      item.className = 'nuvyn-code-group-pdf-item'
      const label = group.ownerDocument.createElement('div')
      label.className = 'nuvyn-code-group-pdf-label'
      // textContent is deliberate: labels are author input and must never
      // become trusted HTML merely because the tab was generated by Nuvyn.
      label.textContent = tab.textContent ?? ''
      panel.classList.add('is-active')
      panel.setAttribute('aria-hidden', 'false')
      panel.removeAttribute('aria-labelledby')
      item.append(label, panel)
      fragment.append(item)
    }
    if (!valid) continue

    panelsHost.replaceChildren(fragment)
    tabsHost.remove()
  }
}

function groupHeadingWithBlock(block: HTMLElement): void {
  if (block.parentElement?.classList.contains('pdf-heading-group')) return

  const heading = block.previousElementSibling
  if (!(heading instanceof HTMLElement) || !/^H[1-6]$/.test(heading.tagName)) return
  const parent = heading.parentElement
  if (!parent || parent !== block.parentElement) return

  const group = block.ownerDocument.createElement('div')
  group.className = 'pdf-heading-group'
  parent.insertBefore(group, heading)
  group.append(heading, block)
}

const PDF_LAYOUT_BLOCK_SELECTOR = [
  '.article pre',
  '.article p',
  '.article li',
  '.article .table-scroll',
  '.article blockquote',
  '.article .mermaid-widget-host',
  '.article .pdf-mermaid',
  '.article .markmap-widget-host',
  '.article .pdf-markmap',
  '.article .nuvyn-code-group-pdf-item',
  '.article .pdf-heading-group',
].join(', ')

function measurePdfPrintablePageHeight(root: HTMLElement): number {
  const probe = root.ownerDocument.createElement('div')
  probe.style.cssText = [
    'position: absolute',
    'visibility: hidden',
    'pointer-events: none',
    `height: ${PDF_PRINTABLE_PAGE_HEIGHT_MM}mm`,
    'width: 1px',
  ].join(';')
  root.appendChild(probe)
  const measured = probe.getBoundingClientRect().height
  probe.remove()
  return measured > 0 ? measured : PDF_PRINTABLE_PAGE_HEIGHT_PX
}

/**
 * Allow only genuinely oversized PDF blocks to split across pages.
 *
 * The measurement is made after the download root is attached, so it uses
 * the same CSS width and font metrics that html2canvas will capture. The
 * threshold is expressed as the A4 printable height from the PDF margins,
 * not a developer viewport height. Short blocks retain their keep-together
 * rule.
 */
export function markOversizedPdfBlocks(root: HTMLElement): void {
  const printablePageHeight = measurePdfPrintablePageHeight(root)

  for (const block of root.querySelectorAll<HTMLElement>(PDF_LAYOUT_BLOCK_SELECTOR)) {
    if (block.getBoundingClientRect().height <= printablePageHeight) continue
    block.classList.add('pdf-allow-split')
    block.closest<HTMLElement>('.pdf-heading-group')?.classList.add('pdf-allow-split')
  }
}

function isLocalMarkdownResourceImage(image: HTMLImageElement): boolean {
  const source = image.getAttribute('src')
  if (!source) return false
  try {
    const url = new URL(source, image.ownerDocument.baseURI)
    const origin = image.ownerDocument.defaultView?.location.origin
    return Boolean(origin)
      && url.origin === origin
      && url.pathname === '/api/markdown-resources'
      && url.searchParams.get('kind') === 'image'
  } catch {
    return false
  }
}

/**
 * The settled reader image is already an authenticated, same-origin resource.
 * html2pdf creates another DOM from articleHtml and would otherwise ask the
 * resource endpoint for the same image again. Materialize only this narrow
 * local-resource surface in the export clone; remote/raw images keep their
 * existing behavior and the live reader is never modified.
 */
function snapshotSettledMarkdownResourceImage(image: HTMLImageElement): string | null {
  if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) return null
  try {
    const canvas = image.ownerDocument.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(image, 0, 0)
    const dataUrl = canvas.toDataURL('image/png')
    return dataUrl.startsWith('data:image/') ? dataUrl : null
  } catch {
    return null
  }
}

function clonePdfNode(node: Node): Node {
  if (node.nodeType !== Node.ELEMENT_NODE) return node.cloneNode(true)
  const element = node as HTMLElement
  if (element.tagName === 'IMG') {
    const sourceImage = element as HTMLImageElement
    const clone = element.ownerDocument.createElement('img')
    const dataUrl = isLocalMarkdownResourceImage(sourceImage)
      ? snapshotSettledMarkdownResourceImage(sourceImage)
      : null

    // Do not clone a local resource src first and replace it later: the
    // browser can schedule that endpoint request before the export clone is
    // attached. Copy attributes into a fresh image instead.
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name === 'src' || attribute.name === 'srcset' || attribute.name === 'sizes') continue
      clone.setAttribute(attribute.name, attribute.value)
    }
    if (dataUrl) {
      clone.setAttribute('src', dataUrl)
    } else if (!isLocalMarkdownResourceImage(sourceImage)) {
      const src = element.getAttribute('src')
      if (src) clone.setAttribute('src', src)
      const srcset = element.getAttribute('srcset')
      if (srcset) clone.setAttribute('srcset', srcset)
      const sizes = element.getAttribute('sizes')
      if (sizes) clone.setAttribute('sizes', sizes)
    }
    return clone
  }

  const clone = element.cloneNode(false) as HTMLElement
  for (const child of Array.from(node.childNodes)) clone.appendChild(clonePdfNode(child))
  return clone
}

/**
 * Clone the live article and remove reader-only Mermaid runtime state.
 *
 * The original DOM is deliberately left untouched: the reader may have a
 * user-selected zoom/pan position, while the export must start from the
 * diagram's own viewBox and fit the PDF column.
 */
export function preparePdfArticleHtml(article: HTMLElement): string {
  const clone = clonePdfNode(article) as HTMLElement

  preparePdfCodeGroups(clone)

  // Details are interactive in the reader, but PDF is a complete document
  // export. Expand only the generated Nuvyn container surface on the clone so
  // raw author <details> elements retain their existing behavior and the live
  // reader disclosure state is never mutated.
  clone.querySelectorAll<HTMLDetailsElement>('details.markdown-container-details')
    .forEach((details) => { details.open = true })

  clone.querySelectorAll('.mermaid-toolbar-area, .markmap-toolbar-area')
    .forEach((toolbar) => toolbar.remove())

  for (const host of clone.querySelectorAll<HTMLElement>('.mermaid-widget-host')) {
    const sourceSvg = host.querySelector<SVGSVGElement>('.mermaid-svg > svg')
    if (!sourceSvg) {
      unwrapStandaloneFenceWidget(host)
      continue
    }

    const staticDiagram = clone.ownerDocument.createElement('div')
    staticDiagram.className = 'pdf-mermaid'
    staticDiagram.appendChild(prepareMermaidSvg(sourceSvg))
    host.replaceChildren(staticDiagram)
    unwrapStandaloneFenceWidget(host)
  }

  for (const host of clone.querySelectorAll<HTMLElement>('.markmap-widget-host')) {
    const widget = host.querySelector<HTMLElement>('.markmap-widget')
    const sourceSvg = widget?.querySelector<SVGSVGElement>('.markmap-svg')
    const error = widget?.querySelector<HTMLElement>('.markmap-error')
    if (!sourceSvg || !sourceSvg.querySelector('g')) {
      if (error) {
        const errorBox = clone.ownerDocument.createElement('div')
        errorBox.className = 'pdf-markmap-error'
        errorBox.textContent = error.textContent?.trim() || '思维导图加载失败'
        host.replaceChildren(errorBox)
      }
      unwrapStandaloneFenceWidget(host)
      continue
    }

    const staticDiagram = clone.ownerDocument.createElement('div')
    staticDiagram.className = 'pdf-markmap'
    staticDiagram.appendChild(prepareMarkmapSvg(sourceSvg))
    host.replaceChildren(staticDiagram)
    unwrapStandaloneFenceWidget(host)
  }

  /* A CSS `break-after: avoid` on a heading is not acted on by html2pdf.js's
     page-break plugin. Wrap diagram headings with their now-static widget so
     the plugin can move the complete pair when the widget would cross a page. */
  const widgetHosts = Array.from(clone.querySelectorAll<HTMLElement>(
    '.mermaid-widget-host, .markmap-widget-host',
  ))
  for (const host of widgetHosts) groupHeadingWithBlock(host)

  /* Images inside a paragraph have the same pagination hazard: html2pdf.js
     moves the image paragraph to the next page while the preceding heading
     remains in place. Keep an image-only paragraph with its heading as well. */
  for (const paragraph of clone.querySelectorAll<HTMLElement>('p')) {
    if (paragraph.children.length !== 1 || paragraph.firstElementChild?.tagName !== 'IMG') continue
    groupHeadingWithBlock(paragraph)
  }

  /* A wide table can be short enough to keep together but still be moved by
     the page-break plugin when the remaining page space is small. Group its
     heading with the table so the heading does not become an orphan at the
     bottom of the previous page. */
  for (const table of clone.querySelectorAll<HTMLElement>('.table-scroll')) {
    groupHeadingWithBlock(table)
  }

  /* Keep the first ordinary content block with a section heading. Do not
     wrap an entire section: later paragraphs remain independently pageable,
     while a short opening paragraph/list/blockquote cannot leave its heading
     orphaned at the bottom of a page. groupHeadingWithBlock() is a no-op for
     blocks already wrapped by the image/widget/table passes above. */
  for (const block of clone.querySelectorAll<HTMLElement>('p, ul, ol, blockquote')) {
    groupHeadingWithBlock(block)
  }

  return clone.outerHTML
}

/** Build the DOM fragment passed to html2pdf.js. */
export function buildPdfDownloadDocument(articleHtml: string): string {
  return `<main class="pdf-document vault">
    <div class="reading-pane">
      ${articleHtml}
    </div>
  </main>`
}

interface PdfDownloadSurface {
  host: HTMLElement
  root: HTMLElement
}

export type PdfCloneObserver = (clonedDocument: Document, clonedRoot: HTMLElement) => void

let pdfCloneObserverForTesting: PdfCloneObserver | null = null

function buildPdfDownloadStyles(generatedShikiCss = getGeneratedShikiCss()): string {
  return [generatedShikiCss, PDF_DOWNLOAD_STYLES]
    .filter(Boolean)
    .join('\n')
}

function ensurePdfDownloadStylesheet(root: HTMLElement, stylesText: string): HTMLStyleElement {
  const directOwners = Array.from(root.children)
    .filter((element): element is HTMLStyleElement => (
      element.tagName === 'STYLE' && element.id === 'nuvyn-pdf-download-styles'
    ))
  const stylesheet = directOwners[0] ?? root.ownerDocument.createElement('style')
  stylesheet.id = 'nuvyn-pdf-download-styles'
  for (const duplicate of directOwners.slice(1)) duplicate.remove()
  if (!stylesheet.parentElement) root.prepend(stylesheet)
  if (stylesheet.textContent !== stylesText) stylesheet.textContent = stylesText
  return stylesheet
}

function createPdfDownloadElement(
  articleHtml: string,
  stylesText = buildPdfDownloadStyles(),
): PdfDownloadSurface {
  const host = document.createElement('div')
  host.className = 'pdf-download-host'
  host.style.cssText = [
    'position: fixed',
    'top: 0',
    'left: -100000px',
    `width: ${PDF_PRINTABLE_PAGE_WIDTH_MM}mm`,
    'height: 1px',
    'overflow: visible',
    'visibility: visible',
    'pointer-events: none',
    'z-index: -1',
  ].join(';')

  const root = document.createElement('div')
  root.className = 'pdf-download-root'
  root.dataset.nuvynPdfDownloadRoot = 'true'
  root.setAttribute('aria-hidden', 'true')
  root.style.cssText = [
    'display: block',
    'width: 100%',
    'min-height: 1px',
    'overflow: visible',
    'visibility: visible',
    'pointer-events: none',
  ].join(';')
  root.innerHTML = buildPdfDownloadDocument(articleHtml)

  ensurePdfDownloadStylesheet(root, stylesText)
  host.appendChild(root)
  return { host, root }
}

function pdfFileName(title: string): string {
  const safeTitle = sanitizePdfFileName(title)
  return safeTitle.toLowerCase().endsWith('.pdf') ? safeTitle : `${safeTitle}.pdf`
}

/** Render the prepared article to a PDF blob and trigger a browser download. */
export async function downloadPdfDocument(options: PdfDownloadOptions): Promise<void> {
  /* Keep one immutable trusted Shiki snapshot for the complete export. A
     concurrent Markdown render may grow the live head owner later, but it
     must not change this PDF transaction halfway through html2canvas. */
  const pdfStylesText = buildPdfDownloadStyles()
  const surface = createPdfDownloadElement(options.articleHtml, pdfStylesText)
  document.body.appendChild(surface.host)

  try {
    markOversizedPdfBlocks(surface.root)
    const pdfOptions = {
      margin: [
        PDF_PAGE_MARGIN_TOP_MM,
        PDF_PAGE_MARGIN_RIGHT_MM,
        PDF_PAGE_MARGIN_BOTTOM_MM,
        PDF_PAGE_MARGIN_LEFT_MM,
      ] as [number, number, number, number],
      filename: pdfFileName(options.title),
      image: { type: 'jpeg' as const, quality: 0.98 },
      enableLinks: true,
      pagebreak: { mode: ['css', 'legacy'] },
      html2canvas: {
        scale: 2,
        useCORS: true,
        allowTaint: false,
        backgroundColor: '#ffffff',
        imageTimeout: 15000,
        logging: false,
        // html2canvas clones the whole document before selecting the export
        // root. Ignore live reader articles outside that root so settled
        // resource images are not requested a second time during cloning.
        ignoreElements: (element: Element) => (
          element.classList.contains('article')
          && element.closest('[data-nuvyn-pdf-download-root="true"]') === null
        ),
        onclone: (clonedDocument: Document) => {
          const clonedRoot = clonedDocument.querySelector<HTMLElement>('[data-nuvyn-pdf-download-root="true"]')
          if (!clonedRoot) return
          ensurePdfDownloadStylesheet(clonedRoot, pdfStylesText)
          // html2pdf clones the source into a hidden overlay. Keep the
          // cloned document in normal flow so html2canvas measures its full
          // content height instead of inheriting any host positioning.
          clonedRoot.style.position = 'static'
          clonedRoot.style.top = 'auto'
          clonedRoot.style.left = 'auto'
          clonedRoot.style.width = '100%'
          clonedRoot.style.visibility = 'visible'
          clonedRoot.style.pointerEvents = 'auto'
          pdfCloneObserverForTesting?.(clonedDocument, clonedRoot)
        },
      },
      jsPDF: {
        unit: 'mm',
        format: 'a4',
        orientation: 'portrait' as const,
      },
    }
    const worker = html2pdf().set(pdfOptions).from(surface.root)

    await worker.save()
  } finally {
    surface.host.remove()
    // The observer is a narrow test-only seam. Clear it even when html2pdf
    // rejects so one export cannot leak callbacks into a later test/export.
    pdfCloneObserverForTesting = null
  }
}

export const __testing__ = {
  PDF_DOWNLOAD_STYLES,
  buildPdfDownloadStyles,
  PDF_PRINTABLE_PAGE_WIDTH_MM,
  PDF_PRINTABLE_PAGE_HEIGHT_MM,
  markOversizedPdfBlocks,
  preparePdfCodeGroups,
  prepareMarkmapSvg,
  setPdfCloneObserver(observer: PdfCloneObserver | null): void {
    pdfCloneObserverForTesting = observer
  },
}
