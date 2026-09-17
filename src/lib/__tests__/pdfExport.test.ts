// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const pdfMocks = vi.hoisted(() => ({
  html2pdf: vi.fn(),
  set: vi.fn(),
  from: vi.fn(),
  save: vi.fn(),
}))

const shikiMocks = vi.hoisted(() => ({
  getGeneratedShikiCss: vi.fn(() => ''),
}))

vi.mock('html2pdf.js', () => ({ default: pdfMocks.html2pdf }))
vi.mock('../shiki', () => ({
  getGeneratedShikiCss: shikiMocks.getGeneratedShikiCss,
}))

import {
  __testing__,
  buildPdfDownloadDocument,
  downloadPdfDocument,
  preparePdfArticleHtml,
  resolvePdfDocumentLabel,
  sanitizePdfFileName,
} from '../pdfExport'

describe('PDF export helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    shikiMocks.getGeneratedShikiCss.mockReturnValue(`
.nuvyn-shiki-test-keyword {
  --shiki-light: rgb(10, 20, 30);
  --shiki-dark: rgb(220, 230, 240);
  --shiki-light-bg: rgb(255, 255, 255);
  --shiki-dark-bg: rgb(36, 41, 46);
}`)
    pdfMocks.save.mockResolvedValue(undefined)
    pdfMocks.from.mockReturnValue({ save: pdfMocks.save })
    pdfMocks.set.mockReturnValue({ from: pdfMocks.from })
    pdfMocks.html2pdf.mockReturnValue({ set: pdfMocks.set })
  })

  it('sanitizes a title into a filesystem-safe PDF filename', () => {
    expect(sanitizePdfFileName('  sprint / q1?.md  ')).toBe('sprint - q1-.md')
    expect(sanitizePdfFileName('   ')).toBe('nuvyn-document')
    expect(sanitizePdfFileName('报告')).toBe('报告')
  })

  it('prefers the rendered document title when choosing the filename', () => {
    expect(resolvePdfDocumentLabel({
      raw: '---\ntitle: 项目计划\n---\n正文',
      documentTitle: '旧标题',
      documentPath: 'inbox/plan.md',
    })).toBe('项目计划')

    expect(resolvePdfDocumentLabel({
      raw: '# Sprint Plan\n\n正文',
      documentPath: 'inbox/plan.md',
    })).toBe('Sprint Plan')

    expect(resolvePdfDocumentLabel({
      raw: '正文',
      documentTitle: '项目计划',
      documentPath: 'inbox/plan.md',
    })).toBe('项目计划')

    expect(resolvePdfDocumentLabel({
      raw: '正文',
      documentPath: 'inbox/plan.md',
    })).toBe('plan')
  })

  it('builds the download document with the PDF layout wrapper', () => {
    const html = buildPdfDownloadDocument('<article class="article reading"><h1>Q1</h1></article>')

    expect(html).toContain('<main class="pdf-document vault">')
    expect(html).toContain('<article class="article reading"><h1>Q1</h1></article>')
    expect(html).toContain('<div class="reading-pane">')
    expect(__testing__.PDF_DOWNLOAD_STYLES).toContain('.pdf-download-root')
    expect(__testing__.PDF_DOWNLOAD_STYLES).not.toContain('\nbody {')
    expect(__testing__.PDF_DOWNLOAD_STYLES).toContain('size: A4')
  })

  it('keeps Alerts and custom containers printable as shared Nuvyn pastel cards', () => {
    const styles = __testing__.PDF_DOWNLOAD_STYLES

    expect(styles).toContain('.pdf-document .article .callout,')
    expect(styles).toContain('.pdf-document .article .markdown-container {')
    expect(styles).toContain('background: var(--notice-bg) !important;')
    expect(styles).toContain('padding: 0.75rem 1rem !important;')
    expect(styles).toContain('border-radius: 12px !important;')
    expect(styles).toContain('box-shadow: none !important;')
    expect(styles).toContain('font-size: 0.875rem !important;')
    expect(styles).toContain('font-weight: 700 !important;')
    expect(styles).toContain('line-height: 1.4 !important;')
    expect(styles).not.toContain('callout-icon')
    expect(styles).not.toContain('mask-image')
    expect(styles).not.toMatch(/[ⓘ✦‼⚠⛔]/u)
    for (const color of [
      '#f1f2f4', '#eef0ff', '#f3edff', '#fff7e3', '#ffe9ec',
    ]) {
      expect(styles).toContain(color)
    }
    for (const type of ['note', 'tip', 'important', 'warning', 'caution']) {
      expect(styles).toContain(`.pdf-document .article .callout-${type}`)
    }
    for (const type of ['info', 'tip', 'warning', 'danger', 'details']) {
      expect(styles).toContain(`.pdf-document .article .markdown-container-${type}`)
    }
    expect(styles).not.toContain('.pdf-document .article .callout-info')
    expect(styles).not.toContain('.pdf-document .article .callout-success')
    expect(styles).not.toContain('.pdf-document .article .callout-danger')
  })

  it('composes one trusted PDF stylesheet from the Shiki snapshot', async () => {
    const liveOwner = document.createElement('style')
    liveOwner.id = 'nuvyn-shiki-generated-styles'
    liveOwner.textContent = '.nuvyn-shiki-live { --shiki-light: blue; }'
    document.head.append(liveOwner)

    try {
      await downloadPdfDocument({
        title: 'Shiki PDF',
        articleHtml: `<article class="article reading">
          <pre class="shiki nuvyn-shiki-root"><code><span class="nuvyn-shiki-test-keyword">const</span> NUVYN_H6_USER_SOURCE_SENTINEL</code></pre>
        </article>`,
      })

      const source = pdfMocks.from.mock.calls[0]?.[0] as HTMLElement
      const owner = source.querySelector<HTMLStyleElement>('style#nuvyn-pdf-download-styles')
      expect(owner).not.toBeNull()
      expect(source.querySelectorAll('style#nuvyn-pdf-download-styles')).toHaveLength(1)
      expect(source.querySelector('style#nuvyn-shiki-generated-styles')).toBeNull()
      expect(owner?.textContent).toContain('.nuvyn-shiki-test-keyword')
      expect(owner?.textContent).toContain('--shiki-light')
      expect(owner?.textContent).toContain('--shiki-dark')
      expect(owner?.textContent).toContain('.pdf-document .article pre.shiki')
      expect(owner?.textContent).toContain('.pdf-document .article pre.shiki.nuvyn-line-numbers')
      expect(owner?.textContent).toContain('.nuvyn-line-number')
      expect(owner?.textContent).toContain('grid-template-columns: max-content minmax(0, 1fr)')
      expect(owner?.textContent).toContain('var(--shiki-light)')
      expect(owner?.textContent).toContain('.pdf-document .article pre.shiki .line.highlighted')
      expect(owner?.textContent).toContain('.pdf-document .article pre.shiki .line.focused')
      expect(owner?.textContent).toContain('.pdf-document .article pre.shiki .line.error')
      expect(owner?.textContent).toMatch(
        /\.pdf-document \.article pre\.shiki:not\(\.nuvyn-shiki-plain\) span \{\s*color: var\(--shiki-light\) !important;\s*\}/u,
      )
      expect(owner?.textContent).not.toMatch(
        /\.pdf-document \.article pre\.shiki:not\(\.nuvyn-shiki-plain\) span \{[^}]*background-color/u,
      )
      expect(owner?.textContent).not.toContain('NUVYN_H6_USER_SOURCE_SENTINEL')
      expect(source.querySelector('article')?.textContent).toContain('NUVYN_H6_USER_SOURCE_SENTINEL')
      expect(liveOwner.textContent).toBe('.nuvyn-shiki-live { --shiki-light: blue; }')
      expect(shikiMocks.getGeneratedShikiCss).toHaveBeenCalledTimes(1)
      expect(__testing__.buildPdfDownloadStyles()).toContain('.nuvyn-shiki-test-keyword')
    } finally {
      liveOwner.remove()
    }
  })

  it('repairs a missing or stale PDF stylesheet in the html2canvas clone', async () => {
    await downloadPdfDocument({
      title: 'Clone repair',
      articleHtml: '<article class="article reading"><pre class="shiki"><code>code</code></pre></article>',
    })

    const options = pdfMocks.set.mock.calls[0]?.[0] as {
      html2canvas: { onclone: (clonedDocument: Document) => void }
    }
    const expectedStyles = __testing__.buildPdfDownloadStyles()

    const makeClone = (styleText?: string): { document: Document; root: HTMLElement } => {
      const clonedDocument = document.implementation.createHTMLDocument('pdf clone')
      const root = clonedDocument.createElement('div')
      root.dataset.nuvynPdfDownloadRoot = 'true'
      root.innerHTML = '<main class="pdf-document"><article class="article"><pre class="shiki"><code>code</code></pre></article></main>'
      if (styleText !== undefined) {
        const style = clonedDocument.createElement('style')
        style.id = 'nuvyn-pdf-download-styles'
        style.textContent = styleText
        root.prepend(style)
      }
      clonedDocument.body.append(root)
      return { document: clonedDocument, root }
    }

    for (const styleText of [undefined, 'STALE_PDF_STYLES']) {
      const clone = makeClone(styleText)
      options.html2canvas.onclone(clone.document)
      const owner = clone.root.querySelector<HTMLStyleElement>('style#nuvyn-pdf-download-styles')
      expect(clone.root.querySelectorAll('style#nuvyn-pdf-download-styles')).toHaveLength(1)
      expect(owner?.textContent).toBe(expectedStyles)
      expect(clone.root.dataset.nuvynPdfDownloadRoot).toBe('true')
    }
  })

  it('preserves Shiki article classes without moving the PDF stylesheet into article HTML', () => {
    const article = document.createElement('article')
    article.className = 'article reading'
    article.innerHTML = '<pre class="shiki nuvyn-shiki-root nuvyn-line-numbers"><code><span class="line"><span class="nuvyn-line-number" aria-hidden="true">98</span><span class="nuvyn-line-content"><span class="nuvyn-shiki-token">const</span></span></span></code></pre>'

    const prepared = preparePdfArticleHtml(article)
    const exported = document.createElement('div')
    exported.innerHTML = prepared

    expect(exported.querySelector('pre.shiki')).not.toBeNull()
    expect(exported.querySelector('span.line')).not.toBeNull()
    expect(exported.querySelector('.nuvyn-line-number')?.textContent).toBe('98')
    expect(exported.querySelector('.nuvyn-line-number')?.getAttribute('aria-hidden')).toBe('true')
    expect(exported.querySelector('.nuvyn-line-content')).not.toBeNull()
    expect(exported.querySelector('[class~="nuvyn-shiki-token"]')).not.toBeNull()
    expect(exported.querySelector('style#nuvyn-pdf-download-styles')).toBeNull()
    expect(prepared).not.toContain('nuvyn-pdf-download-styles')
  })

  it('preserves final heading IDs and lazy Markdown images without an inline TOC', () => {
    const article = document.createElement('article')
    article.className = 'article reading'
    article.innerHTML = `
      <h2 id="java-guide"><a class="header-anchor" href="#java-guide">Java Guide</a></h2>
      <p><img src="image.png" alt="Example" loading="lazy"></p>`

    const exported = document.createElement('div')
    exported.innerHTML = preparePdfArticleHtml(article)

    expect(exported.querySelector('nav.nuvyn-toc')).toBeNull()
    expect(exported.querySelector('a[href="#java-guide"]')).not.toBeNull()
    expect(exported.querySelector('h2#java-guide')).not.toBeNull()
    expect(exported.querySelector('img[loading="lazy"]')).not.toBeNull()
    expect(__testing__.PDF_DOWNLOAD_STYLES).not.toContain('.pdf-document .article .nuvyn-toc')
  })

  it('fails closed for a local resource image when PDF snapshotting fails', () => {
    const article = document.createElement('article')
    article.className = 'article reading'
    article.innerHTML = '<p><img src="/api/markdown-resources?kind=image&amp;path=docs%2Flogo.png" srcset="/api/markdown-resources?kind=image&amp;path=docs%2Flogo.png 1x" sizes="100vw" alt="Local resource"></p>'
    const image = article.querySelector<HTMLImageElement>('img')!
    Object.defineProperties(image, {
      complete: { configurable: true, value: true },
      naturalWidth: { configurable: true, value: 1 },
      naturalHeight: { configurable: true, value: 1 },
    })
    const originalSrc = image.getAttribute('src')

    const prepared = preparePdfArticleHtml(article)

    expect(prepared).not.toContain('/api/markdown-resources')
    expect(prepared).not.toContain('srcset=')
    expect(prepared).not.toContain('sizes=')
    expect(article.querySelector('img')?.getAttribute('src')).toBe(originalSrc)
  })

  it('expands generated details only in the PDF clone and preserves reader state', () => {
    const article = document.createElement('article')
    article.className = 'article reading'
    article.innerHTML = `
      <details class="markdown-container markdown-container-details">
        <summary class="markdown-container-title">Generated details</summary>
        <p id="generated-body">Exported body</p>
      </details>
      <details class="author-details">
        <summary>Raw details</summary>
        <p>Raw body</p>
      </details>`

    const generated = article.querySelector<HTMLDetailsElement>('.markdown-container-details')!
    const raw = article.querySelector<HTMLDetailsElement>('.author-details')!
    generated.open = false
    raw.open = false

    const exported = document.createElement('div')
    exported.innerHTML = preparePdfArticleHtml(article)

    expect(generated.open).toBe(false)
    expect(raw.open).toBe(false)
    expect(exported.querySelector<HTMLDetailsElement>('.markdown-container-details')?.open).toBe(true)
    expect(exported.querySelector('.markdown-container-details #generated-body')?.textContent)
      .toBe('Exported body')
    expect(exported.querySelector<HTMLDetailsElement>('.author-details')?.open).toBe(false)
    expect(__testing__.PDF_DOWNLOAD_STYLES).toContain('.pdf-document .article .markdown-container')
    expect(__testing__.PDF_DOWNLOAD_STYLES).toContain('.markdown-container-details > summary')
  })

  it('exports every code-group panel in source order without mutating the reader', () => {
    const article = document.createElement('article')
    article.className = 'article reading'
    article.innerHTML = `
      <div class="nuvyn-code-group" role="group">
        <div class="nuvyn-code-group-tabs" role="tablist">
          <button role="tab" id="tab-ts" aria-controls="panel-ts" aria-selected="false" tabindex="-1">TypeScript</button>
          <button role="tab" id="tab-js" aria-controls="panel-js" aria-selected="true" tabindex="0">JavaScript</button>
        </div>
        <div class="nuvyn-code-group-panels">
          <div id="panel-ts" class="nuvyn-code-group-panel" role="tabpanel" aria-labelledby="tab-ts" aria-hidden="true"><pre class="shiki"><code>ts</code></pre></div>
          <div id="panel-js" class="nuvyn-code-group-panel is-active" role="tabpanel" aria-labelledby="tab-js" aria-hidden="false"><pre class="shiki"><code>js</code></pre></div>
        </div>
      </div>`
    const liveHtml = article.innerHTML

    const exported = document.createElement('div')
    exported.innerHTML = preparePdfArticleHtml(article)
    const group = exported.querySelector<HTMLElement>('.nuvyn-code-group')!
    const items = Array.from(group.querySelectorAll<HTMLElement>('.nuvyn-code-group-pdf-item'))

    expect(article.innerHTML).toBe(liveHtml)
    expect(group.querySelector('.nuvyn-code-group-tabs')).toBeNull()
    expect(items).toHaveLength(2)
    expect(items.map((item) => item.querySelector('.nuvyn-code-group-pdf-label')?.textContent))
      .toEqual(['TypeScript', 'JavaScript'])
    expect(items.every((item) => item.querySelector('.nuvyn-code-group-panel')?.getAttribute('aria-hidden') === 'false'))
      .toBe(true)
    expect(items[0]?.textContent).toContain('ts')
    expect(items[1]?.textContent).toContain('js')
    expect(__testing__.PDF_DOWNLOAD_STYLES).toContain('.nuvyn-code-group-pdf-item')
    expect(__testing__.PDF_DOWNLOAD_STYLES).toContain('.nuvyn-code-group-tabs')
  })

  it('leaves malformed code-group-like PDF markup untouched', () => {
    const article = document.createElement('article')
    article.className = 'article reading'
    article.innerHTML = `
      <div class="nuvyn-code-group">
        <div class="nuvyn-code-group-tabs" role="tablist">
          <button role="tab" aria-controls="missing">Untrusted</button>
        </div>
        <div class="nuvyn-code-group-panels">
          <div id="actual" role="tabpanel">Keep me</div>
        </div>
      </div>`

    const exported = document.createElement('div')
    exported.innerHTML = preparePdfArticleHtml(article)
    expect(exported.querySelector('.nuvyn-code-group-tabs')).not.toBeNull()
    expect(exported.querySelector('.nuvyn-code-group-pdf-item')).toBeNull()
    expect(exported.textContent).toContain('Keep me')
  })

  it('keeps short text blocks together and only splits oversized blocks', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <article class="article reading">
        <p id="short-paragraph">short paragraph</p>
        <p id="long-paragraph">long paragraph</p>
        <ul>
          <li id="short-list-item">short list item</li>
          <li id="long-list-item">long list item</li>
        </ul>
        <pre id="short"><code>short</code></pre>
        <pre id="long"><code>long</code></pre>
        <div class="table-scroll"><table><tr><td>cell</td></tr></table></div>
      </article>`

    const shortParagraph = root.querySelector<HTMLElement>('#short-paragraph')!
    const longParagraph = root.querySelector<HTMLElement>('#long-paragraph')!
    const shortListItem = root.querySelector<HTMLElement>('#short-list-item')!
    const longListItem = root.querySelector<HTMLElement>('#long-list-item')!
    const short = root.querySelector<HTMLElement>('#short')!
    const long = root.querySelector<HTMLElement>('#long')!
    const tableScroll = root.querySelector<HTMLElement>('.table-scroll')!
    vi.spyOn(shortParagraph, 'getBoundingClientRect').mockReturnValue({ height: 100 } as DOMRect)
    vi.spyOn(longParagraph, 'getBoundingClientRect').mockReturnValue({ height: 1200 } as DOMRect)
    vi.spyOn(shortListItem, 'getBoundingClientRect').mockReturnValue({ height: 100 } as DOMRect)
    vi.spyOn(longListItem, 'getBoundingClientRect').mockReturnValue({ height: 1200 } as DOMRect)
    vi.spyOn(short, 'getBoundingClientRect').mockReturnValue({ height: 100 } as DOMRect)
    vi.spyOn(long, 'getBoundingClientRect').mockReturnValue({ height: 1200 } as DOMRect)
    vi.spyOn(tableScroll, 'getBoundingClientRect').mockReturnValue({ height: 160 } as DOMRect)

    __testing__.markOversizedPdfBlocks(root)

    expect(shortParagraph.classList.contains('pdf-allow-split')).toBe(false)
    expect(longParagraph.classList.contains('pdf-allow-split')).toBe(true)
    expect(shortListItem.classList.contains('pdf-allow-split')).toBe(false)
    expect(longListItem.classList.contains('pdf-allow-split')).toBe(true)
    expect(short.classList.contains('pdf-allow-split')).toBe(false)
    expect(long.classList.contains('pdf-allow-split')).toBe(true)
    expect(tableScroll.classList.contains('pdf-allow-split')).toBe(false)
    expect(__testing__.PDF_PRINTABLE_PAGE_HEIGHT_MM).toBe(263)
    expect(__testing__.PDF_DOWNLOAD_STYLES).toContain('.pdf-document .article pre code')
    expect(__testing__.PDF_DOWNLOAD_STYLES).toContain('.pdf-document .article p')
    expect(__testing__.PDF_DOWNLOAD_STYLES).toContain('.pdf-document .article li')
    expect(__testing__.PDF_DOWNLOAD_STYLES).toContain('break-inside: avoid')
    expect(__testing__.PDF_DOWNLOAD_STYLES).toContain('page-break-inside: avoid')
    expect(__testing__.PDF_DOWNLOAD_STYLES).toContain('overflow-wrap: anywhere !important')
    expect(__testing__.PDF_DOWNLOAD_STYLES).toContain('table-layout: fixed !important')
    expect(__testing__.PDF_DOWNLOAD_STYLES).toContain('.pdf-document .article tbody tr:nth-child(even)')
    expect(__testing__.PDF_DOWNLOAD_STYLES).toContain('.pdf-document .article .pdf-allow-split')
  })

  it('generates a direct download and removes the temporary render surface', async () => {
    await downloadPdfDocument({
      title: 'Q1 / notes',
      articleHtml: '<article class="article reading"><h1>Q1</h1></article>',
    })

    expect(pdfMocks.html2pdf).toHaveBeenCalledTimes(1)
    const options = pdfMocks.set.mock.calls[0]?.[0] as {
      filename: string
      margin: [number, number, number, number]
      pagebreak: { mode: string[] }
      html2canvas: { useCORS: boolean; allowTaint: boolean }
    }
    expect(options.filename).toBe('Q1 - notes.pdf')
    expect(options.margin).toEqual([16, 18, 18, 18])
    expect(options.pagebreak.mode).toEqual(['css', 'legacy'])
    expect(options.html2canvas.useCORS).toBe(true)
    expect(options.html2canvas.allowTaint).toBe(false)
    const source = pdfMocks.from.mock.calls[0]?.[0] as HTMLElement
    expect(source.querySelector('.pdf-document.vault')).not.toBeNull()
    expect(source.style.display).toBe('block')
    expect(source.style.width).toBe('100%')
    expect(source.parentElement?.className).toBe('pdf-download-host')
    expect(source.parentElement?.style.width).toBe('174mm')
    expect(source.parentElement?.style.width).not.toBe('720px')
    expect(__testing__.PDF_PRINTABLE_PAGE_WIDTH_MM).toBe(174)
    expect(pdfMocks.save).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.pdf-download-root')).toBeNull()
    expect(document.querySelector('.pdf-download-host')).toBeNull()
  })

  it('converts an interactive Mermaid widget into a static, print-sized SVG', () => {
    const article = document.createElement('article')
    article.className = 'article reading'
    article.innerHTML = `
      <div class="mermaid-widget-host">
        <div class="mermaid-widget">
          <div class="mermaid-svg">
            <svg id="diagram-1" width="100%" height="100%" style="overflow: hidden; width: 100%; height: 100%; max-width: none" data-pan-zoom-bound="1" data-mermaid-viewbox="0 0 320 180">
              <style>#diagram-1 .node rect { fill: #1f2020; }</style>
              <g class="svg-pan-zoom_viewport" transform="matrix(1.7,0,0,1.7,-42,-16)" style="transform: matrix(1.7, 0, 0, 1.7, -42, -16)">
                <g class="node"><rect width="80" height="30" /></g>
              </g>
            </svg>
          </div>
          <div class="mermaid-toolbar-area"><button>Zoom</button></div>
        </div>
      </div>`

    const html = preparePdfArticleHtml(article)
    const exported = document.createElement('div')
    exported.innerHTML = html
    const host = exported.querySelector('.mermaid-widget-host')
    const svg = exported.querySelector<SVGSVGElement>('.pdf-mermaid > svg')

    expect(host?.querySelector('.mermaid-toolbar-area')).toBeNull()
    expect(exported.querySelector('.mermaid-widget')).toBeNull()
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('width')).toBeNull()
    expect(svg?.getAttribute('height')).toBeNull()
    expect(svg?.getAttribute('style')).toBeNull()
    expect(svg?.getAttribute('data-pan-zoom-bound')).toBeNull()
    expect(svg?.getAttribute('data-mermaid-viewbox')).toBeNull()
    expect(svg?.getAttribute('viewBox')).toBe('0 0 320 180')
    expect(svg?.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet')
    const viewport = svg?.querySelector('g')
    expect(svg?.querySelector('.svg-pan-zoom_viewport')).toBeNull()
    expect(viewport?.getAttribute('transform')).toBeNull()
    expect(viewport?.getAttribute('style')).toBeNull()
    expect(__testing__.PDF_DOWNLOAD_STYLES).toContain('.pdf-document .article .pdf-mermaid > svg')
  })

  it('converts a settled MarkMap widget into a static, fit-sized SVG', () => {
    const article = document.createElement('article')
    article.className = 'article reading'
    article.innerHTML = `
      <h2>MarkMap</h2>
      <pre><code class="language-markmap">
        <div class="markmap-widget-host">
          <div class="markmap-widget" data-markmap-state="ready" data-markmap-ready="true">
            <svg class="markmap-svg markmap mm-test" data-markmap-fit-transform="translate(17,240) scale(1.84)" data-markmap-viewport="720 480">
              <style>.markmap{font:16px sans-serif}</style>
              <g transform="translate(900,900) scale(4)">
                <g class="markmap-node"><text>Root</text></g>
              </g>
            </svg>
            <div class="markmap-toolbar-area"><button>Reset</button></div>
          </div>
        </div>
      </code></pre>`

    const html = preparePdfArticleHtml(article)
    const exported = document.createElement('div')
    exported.innerHTML = html
    const host = exported.querySelector('.markmap-widget-host')
    const headingGroup = exported.querySelector('.pdf-heading-group')
    const svg = exported.querySelector<SVGSVGElement>('.pdf-markmap > svg')
    const rootGroup = svg?.querySelector(':scope > g')

    expect(headingGroup?.querySelector('h2')?.textContent).toBe('MarkMap')
    expect(headingGroup?.querySelector('.markmap-widget-host')).toBe(host)
    expect(exported.querySelector('pre')).toBeNull()
    expect(host?.querySelector('.markmap-toolbar-area')).toBeNull()
    expect(exported.querySelector('.markmap-widget')).toBeNull()
    expect(svg).not.toBeNull()
    expect(svg?.classList.contains('markmap-svg')).toBe(false)
    expect(svg?.classList.contains('markmap')).toBe(true)
    expect(svg?.getAttribute('viewBox')).toBe('0 0 720 480')
    expect(svg?.getAttribute('width')).toBe('720')
    expect(svg?.getAttribute('height')).toBe('480')
    expect(svg?.getAttribute('data-markmap-fit-transform')).toBeNull()
    expect(svg?.getAttribute('data-markmap-viewport')).toBeNull()
    expect(svg?.getAttribute('data-markmap-static')).toBe('true')
    expect(rootGroup?.getAttribute('transform')).toBe('translate(17,240) scale(1.84)')
    expect(__testing__.PDF_DOWNLOAD_STYLES).toContain('.pdf-document .article .pdf-markmap > svg')
  })

  it('keeps an image-only paragraph with its section heading', () => {
    const article = document.createElement('article')
    article.className = 'article reading'
    article.innerHTML = '<h2>Image</h2><p><img src="/logo.svg" alt="Nuvyn logo"></p>'

    const exported = document.createElement('div')
    exported.innerHTML = preparePdfArticleHtml(article)
    const group = exported.querySelector('.pdf-heading-group')

    expect(group?.querySelector('h2')?.textContent).toBe('Image')
    expect(group?.querySelector('p > img')).not.toBeNull()
  })

  it('keeps only the first ordinary content block with its section heading', () => {
    const article = document.createElement('article')
    article.className = 'article reading'
    article.innerHTML = `
      <h2>Paragraph section</h2>
      <p>H6_FIRST_PARAGRAPH</p>
      <p>H6_SECOND_PARAGRAPH</p>
      <h2>List section</h2>
      <ul><li>H6_FIRST_LIST_ITEM</li><li>H6_SECOND_LIST_ITEM</li></ul>`

    const exported = document.createElement('div')
    exported.innerHTML = preparePdfArticleHtml(article)
    const groups = Array.from(exported.querySelectorAll<HTMLElement>('.pdf-heading-group'))

    expect(groups).toHaveLength(2)
    expect(groups[0]?.querySelector('h2')?.textContent).toBe('Paragraph section')
    expect(groups[0]?.querySelector('p')?.textContent).toBe('H6_FIRST_PARAGRAPH')
    expect(groups[0]?.nextElementSibling?.textContent).toBe('H6_SECOND_PARAGRAPH')
    expect(Array.from(exported.querySelectorAll('p')).map((paragraph) => paragraph.textContent)).toEqual([
      'H6_FIRST_PARAGRAPH',
      'H6_SECOND_PARAGRAPH',
    ])
    expect(groups[1]?.querySelector('h2')?.textContent).toBe('List section')
    expect(groups[1]?.querySelector('ul')?.textContent).toContain('H6_FIRST_LIST_ITEM')
    expect(groups[0]?.querySelector('.pdf-heading-group')).toBeNull()
    expect(groups[1]?.querySelector('.pdf-heading-group')).toBeNull()
  })

  it('keeps a table with its section heading', () => {
    const article = document.createElement('article')
    article.className = 'article reading'
    article.innerHTML = '<h2>Wide Table</h2><div class="table-scroll"><table><tr><td>content</td></tr></table></div>'

    const exported = document.createElement('div')
    exported.innerHTML = preparePdfArticleHtml(article)
    const group = exported.querySelector('.pdf-heading-group')

    expect(group?.querySelector('h2')?.textContent).toBe('Wide Table')
    expect(group?.querySelector('.table-scroll table td')?.textContent).toBe('content')
  })

  it('removes the temporary render surface when PDF generation fails', async () => {
    pdfMocks.save.mockRejectedValueOnce(new Error('generation failed'))

    await expect(downloadPdfDocument({
      title: 'Failed export',
      articleHtml: '<article class="article reading"><p>content</p></article>',
    })).rejects.toThrow('generation failed')

    expect(document.querySelector('.pdf-download-root')).toBeNull()
    expect(document.querySelector('.pdf-download-host')).toBeNull()
  })
})
