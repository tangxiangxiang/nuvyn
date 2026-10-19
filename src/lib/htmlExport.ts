import { parse as parseCss } from 'postcss'
import { canExportMarkdownDocument, markdownExportFilename, type DocumentExportSnapshot } from './documentExport'
import { getGeneratedShikiCss } from './shiki'
import { pdfEnhancementsReady } from './pdf-readiness'
import { prepareMermaidSvg, prepareMarkmapSvg, prepareStaticCodeGroups, unwrapStandaloneFenceWidget } from './staticDocumentSnapshot'
import { HTML_KATEX_FONTS, HTML_KATEX_STYLES, HTML_READING_STYLES } from './htmlExportStyles'
import { auditStaticCss, bytesDataUrl, checkExportSignal, createHtmlResourceReader, decodeImageDataUrl, exportError, HTML_EXPORT_LIMITS, localImageUrl } from './htmlExportResources'

export const HTML_EXPORT_CSP = "default-src 'none'; script-src 'none'; connect-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"

function assertHtmlExportElementLimit(root: Element, signal?: AbortSignal): void {
  if (signal) checkExportSignal(signal)
  if (root.querySelectorAll('*').length > HTML_EXPORT_LIMITS.elements) exportError('COMPLEXITY')
}

export function waitForHtmlWidgets(article: HTMLElement, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const observer = new MutationObserver(check)
    const timer = setTimeout(() => finish(new Error('HTML_EXPORT_WIDGET_TIMEOUT')), HTML_EXPORT_LIMITS.timeoutMs)
    function finish(error?: Error) {
      clearTimeout(timer); observer.disconnect(); signal.removeEventListener('abort', abort)
      if (error) reject(error); else resolve()
    }
    function abort() { finish(new DOMException('Export cancelled', 'AbortError')) }
    function check() {
      if (signal.aborted) { abort(); return }
      if (article.querySelector('.markdown-resource-error, [data-math-state="error"], [data-mermaid-state="error"], [data-markmap-state="error"], [data-board-state="error"]')) { finish(new Error('HTML_EXPORT_RENDER_FAILED')); return }
      if (pdfEnhancementsReady(article)) finish()
    }
    observer.observe(article, { childList: true, subtree: true, attributes: true })
    signal.addEventListener('abort', abort, { once: true })
    check()
  })
}

// Snapshot generated diagram paint, not its runtime CSS or interactions. This
// also preserves rich Mermaid/MarkMap labels without trusting foreignObject
// from an uploaded SVG. The latter has its own stricter validator.
function diagramSnapshot(source: SVGSVGElement, markmap: boolean): SVGSVGElement {
  const svg = markmap ? prepareMarkmapSvg(source) : prepareMermaidSvg(source)
  const originals = [source, ...source.querySelectorAll('*')]
  const copies = [svg, ...svg.querySelectorAll('*')]
  const properties = ['color', 'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-opacity', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'text-anchor', 'dominant-baseline', 'white-space', 'background-color', 'border-color', 'border-width', 'border-style', 'border-radius', 'padding', 'margin', 'display', 'vertical-align', 'text-align']
  for (let index = 0; index < copies.length; index += 1) {
    const copy = copies[index] as SVGElement | HTMLElement
    const original = originals[index]
    if (!original || copy.localName === 'style') continue
    const computed = getComputedStyle(original)
    for (const property of properties) {
      const value = computed.getPropertyValue(property)
      if (value && !value.includes('url(')) copy.style.setProperty(property, value)
    }
    copy.style.removeProperty('cursor')
    copy.style.removeProperty('transition')
    copy.style.removeProperty('animation')
  }
  svg.querySelectorAll('style').forEach((style) => style.remove())
  svg.removeAttribute('style')
  prepareHtmlDiagramMath(svg)
  if (markmap) {
    // HTML has no A4/fixed widget viewport. Fit the complete graph, not the
    // Reader's generous interactive canvas, so mobile labels remain legible.
    const bounds = source.getBBox()
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) exportError('DIAGRAM_BOUNDS')
    svg.setAttribute('viewBox', `${bounds.x - 16} ${bounds.y - 16} ${bounds.width + 32} ${bounds.height + 32}`)
    svg.removeAttribute('width')
    svg.removeAttribute('height')
  }
  return svg
}

/** WebKit paints relatively positioned KaTeX HTML outside transformed SVG
 * foreignObjects, despite reporting correct client rects. Its generated
 * semantic MathML needs no positioning layer and remains fully static. */
export function prepareHtmlDiagramMath(svg: SVGSVGElement): void {
  for (const katex of svg.querySelectorAll('.katex')) {
    const math = katex.querySelector('math')
    if (!math) exportError('DIAGRAM_MATH')
    for (const node of [math, ...math.querySelectorAll('*')]) node.removeAttribute('style')
    katex.replaceWith(math)
  }
}

const HTML_TAGS = new Set('article a abbr b blockquote br caption code col colgroup dd del details div dl dt em h1 h2 h3 h4 h5 h6 hr i img input kbd label li mark nav ol p pre q s samp section small span strong sub summary sup table tbody td tfoot th thead tr u ul'.split(' '))
const SVG_TAGS = new Set('svg g path rect circle ellipse line polyline polygon text tspan image defs clipPath linearGradient radialGradient stop title desc symbol use mask marker foreignObject filter feGaussianBlur feOffset feMerge feMergeNode feColorMatrix feFlood feComposite feBlend feDropShadow'.split(' '))
const MATH_TAGS = new Set('math semantics annotation mrow mi mn mo ms mtext mspace mfrac msqrt mroot mstyle merror mpadded mphantom mfenced menclose msub msup msubsup munder mover munderover mmultiscripts mprescripts none mtable mtr mtd'.split(' '))
const ATTRS = new Set('id class title alt width height colspan rowspan open checked disabled type role aria-label aria-hidden xmlns viewBox preserveAspectRatio x y x1 x2 y1 y2 dx dy d cx cy r rx ry points transform opacity fill fill-opacity fill-rule stroke stroke-opacity stroke-width stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset clip-path mask color font-family font-size font-weight font-style text-anchor dominant-baseline offset stop-color stop-opacity gradientUnits gradientTransform spreadMethod fx fy fr clipPathUnits marker-start marker-mid marker-end markerWidth markerHeight markerUnits refX refY orient pathLength textLength lengthAdjust direction white-space display overflow text-decoration encoding mathvariant stretch stretchy fence separator lspace rspace accent accentunder columnalign rowalign columnspacing rowspacing displaystyle scriptlevel scriptminsize minsize maxsize movablelimits linethickness notation bevelled'.split(' '))

/** A structural second boundary on the static clone. Fail closed on active or
// unfamiliar elements rather than silently dropping document content. */
export function auditHtmlArticle(root: HTMLElement): void {
  const ids = new Set(Array.from(root.querySelectorAll('[id]'), (e) => e.id))
  for (const el of [root, ...root.querySelectorAll('*')]) {
    const ns = el.namespaceURI
    const allowed = ns === 'http://www.w3.org/2000/svg' ? SVG_TAGS : ns === 'http://www.w3.org/1998/Math/MathML' ? MATH_TAGS : HTML_TAGS
    if (!allowed.has(el.localName)) exportError(`UNSAFE_ELEMENT_${el.localName}`)
    if (el.localName === 'input' && el.getAttribute('type') !== 'checkbox') exportError('UNSAFE_INPUT')
    if (el.localName === 'input') el.setAttribute('disabled', '')
    for (const attr of Array.from(el.attributes)) {
      const name = attr.localName
      if (/^on/iu.test(name)) exportError('UNSAFE_ATTRIBUTE')
      if (name === 'style') { auditStaticCss(`x{${attr.value}}`); continue }
      if (name === 'src') {
        if (el.localName !== 'img') exportError('UNSAFE_SOURCE')
        const image = decodeImageDataUrl(attr.value)
        el.setAttribute(attr.name, bytesDataUrl(image.bytes, image.mime))
        continue
      }
      if (name === 'href') {
        const href = attr.value
        let fragment = ''
        try { if (href.startsWith('#')) fragment = decodeURIComponent(href.slice(1)) } catch { /* Invalid anchors become readable text. */ }
        if (fragment && ids.has(fragment)) continue
        if (el.localName === 'a' && /^https?:\/\//iu.test(href) && !el.classList.contains('wiki-link') && !href.startsWith(location.origin + '/')) {
          const url = new URL(href)
          if (url.username || url.password) exportError('UNSAFE_LINK')
          el.setAttribute('rel', 'noopener noreferrer')
          continue
        }
        if (el.localName === 'image' && href.startsWith('data:')) {
          const image = decodeImageDataUrl(href)
          el.setAttribute(attr.name, bytesDataUrl(image.bytes, image.mime))
          continue
        }
        el.removeAttribute(attr.name)
        continue
      }
      if (name === 'rel') { el.setAttribute('rel', 'noopener noreferrer'); continue }
      if (name === 'data-language') continue
      if (el.namespaceURI === 'http://www.w3.org/2000/svg' && ['filter', 'filterUnits', 'in', 'in2', 'result', 'stdDeviation', 'mode', 'operator', 'values', 'flood-color', 'flood-opacity'].includes(name)) continue
      if (name.startsWith('data-') || !ATTRS.has(name)) { el.removeAttribute(attr.name); continue }
      if (/url\(/iu.test(attr.value)) auditStaticCss(`x{fill:${attr.value}}`)
    }
  }
}

export async function buildHtmlDocument(options: {
  snapshot: DocumentExportSnapshot
  article: HTMLElement
  signal: AbortSignal
  lang?: string
}): Promise<string> {
  const { snapshot, article, signal } = options
  if (!canExportMarkdownDocument(snapshot.path)) exportError('NOT_ALLOWED')
  checkExportSignal(signal)
  await waitForHtmlWidgets(article, signal)
  assertHtmlExportElementLimit(article, signal)
  const clone = article.cloneNode(true) as HTMLElement
  prepareStaticCodeGroups(clone)
  clone.querySelectorAll('button, .mermaid-toolbar-area, .markmap-toolbar-area').forEach((el) => el.remove())
  clone.querySelectorAll('details').forEach((el) => { el.open = true })
  clone.querySelectorAll('.has-code-copy').forEach((el) => el.classList.remove('has-code-copy'))
  for (const kind of ['mermaid', 'markmap'] as const) {
    const liveHosts = article.querySelectorAll(`.${kind}-widget-host`)
    const hosts = clone.querySelectorAll<HTMLElement>(`.${kind}-widget-host`)
    for (let index = 0; index < hosts.length; index += 1) {
      const source = liveHosts[index]?.querySelector<SVGSVGElement>('svg')
      if (!source) exportError('DIAGRAM_MISSING')
      const host = hosts[index]
      host.className = 'html-diagram'
      host.replaceChildren(diagramSnapshot(source, kind === 'markmap'))
      unwrapStandaloneFenceWidget(host)
    }
  }
  assertHtmlExportElementLimit(clone, signal)
  const reader = createHtmlResourceReader(signal)
  // Sequential, deduplicated reads bound peak memory and in-flight requests.
  for (const image of clone.querySelectorAll<HTMLImageElement>('img')) {
    const board = Boolean(image.closest('.board-embed'))
    const source = image.dataset.htmlImageSource ?? image.getAttribute('src') ?? ''
    const resource = await reader.read(localImageUrl(source, board))
    checkExportSignal(signal)
    image.src = bytesDataUrl(resource.bytes, resource.mime)
    image.removeAttribute('loading')
  }
  let mathCss = ''
  if (clone.querySelector('.katex')) {
    const css = parseCss(HTML_KATEX_STYLES)
    // Bundle WOFF2 only. All font families/styles stay available offline,
    // including formula fonts not currently selected by the browser.
    for (const rule of css.nodes) {
      if (rule.type !== 'atrule' || rule.name !== 'font-face') continue
      const src = rule.nodes?.find((node) => node.type === 'decl' && node.prop === 'src')
      if (!src || src.type !== 'decl') exportError('FONT')
      const font = /fonts\/([A-Za-z0-9_-]+\.woff2)/u.exec(src.value)?.[1]
      const url = font && HTML_KATEX_FONTS[`/node_modules/katex/dist/fonts/${font}`]
      if (!url) exportError('FONT')
      const resource = await reader.read(url, true)
      src.value = `url(${bytesDataUrl(resource.bytes, resource.mime)}) format('woff2')`
    }
    mathCss = css.toString()
  }
  auditHtmlArticle(clone)
  checkExportSignal(signal)
  const doc = document.implementation.createHTMLDocument('')
  doc.documentElement.lang = options.lang === 'en' ? 'en' : 'zh-CN'
  doc.documentElement.setAttribute('data-theme', 'light')
  doc.head.replaceChildren()
  for (const attrs of [{ charset: 'utf-8' }, { name: 'viewport', content: 'width=device-width,initial-scale=1' }, { 'http-equiv': 'Content-Security-Policy', content: HTML_EXPORT_CSP }]) {
    const meta = doc.createElement('meta')
    for (const [key, value] of Object.entries(attrs)) meta.setAttribute(key, value)
    doc.head.append(meta)
  }
  const title = doc.createElement('title')
  title.textContent = article.querySelector('h1')?.textContent?.trim() || snapshot.title || markdownExportFilename(snapshot.path).slice(0, -3)
  const style = doc.createElement('style')
  style.textContent = HTML_READING_STYLES + getGeneratedShikiCss() + mathCss
  if (/<\/style/iu.test(style.textContent)) exportError('UNSAFE_CSS')
  doc.head.append(title, style)
  doc.body.append(clone)
  assertHtmlExportElementLimit(clone, signal)
  const result = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML
  if (new TextEncoder().encode(result).length > HTML_EXPORT_LIMITS.totalBytes) exportError('DOCUMENT_SIZE')
  return result
}

export function downloadHtmlDocument(snapshot: DocumentExportSnapshot, html: string, isCurrent: () => boolean): void {
  if (!canExportMarkdownDocument(snapshot.path)) exportError('NOT_ALLOWED')
  if (!isCurrent()) return
  if (new TextEncoder().encode(html).length > HTML_EXPORT_LIMITS.totalBytes) exportError('DOCUMENT_SIZE')
  // Audit the serialized/reparsed document too: namespace/HTML parser changes
  // cannot introduce active content between the clone and the download sink.
  const checked = new DOMParser().parseFromString(html, 'text/html')
  const article = checked.body.firstElementChild
  if (checked.doctype?.name !== 'html' || checked.body.children.length !== 1 || article?.localName !== 'article'
    || checked.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') !== HTML_EXPORT_CSP) exportError('INVALID_DOCUMENT')
  for (const node of checked.head.children) {
    if (!['meta', 'title', 'style'].includes(node.localName)) exportError('INVALID_DOCUMENT')
    if (node.localName === 'meta' && node.hasAttribute('http-equiv') && node.getAttribute('http-equiv') !== 'Content-Security-Policy') exportError('INVALID_DOCUMENT')
    if (node.localName === 'style') auditStaticCss(node.textContent ?? '', true)
  }
  assertHtmlExportElementLimit(article)
  auditHtmlArticle(article as HTMLElement)
  const url = URL.createObjectURL(new Blob(['<!DOCTYPE html>\n' + checked.documentElement.outerHTML], { type: 'text/html;charset=utf-8' }))
  const anchor = document.createElement('a')
  let started = false
  try {
    anchor.href = url
    anchor.download = markdownExportFilename(snapshot.path).slice(0, -3) + '.html'
    anchor.hidden = true
    document.body.append(anchor)
    if (!isCurrent()) return
    anchor.click()
    started = true
  } finally {
    anchor.remove()
    if (started) window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
    else URL.revokeObjectURL(url)
  }
}
