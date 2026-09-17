import { promises as fs } from 'node:fs'
import type { APIRequestContext, Download, Page, TestInfo } from '@playwright/test'
import { expect } from '@playwright/test'

export type PdfWidgetSnapshot = {
  state: string | null
  svgMarkup: string
  viewBox: string | null
  dataViewBox: string | null
  viewport: string | null
  fitTransform: string | null
  rootTransform: string | null
  hasRootGroup: boolean
  width: number
  height: number
}

export type PdfImageSnapshot = {
  src: string | null
  complete: boolean
  naturalWidth: number
  naturalHeight: number
}

export type PdfExportSnapshot = {
  surfaceCount: number
  rootCount: number
  hostCount: number
  sourceTextContent: string
  textContent: string
  articleHeight: number
  articleWidth: number
  articleClientWidth: number
  articleScrollWidth: number
  printablePageWidth: number
  printablePageHeight: number
  estimatedPrintablePages: number
  sourceMathStates: Array<string | null>
  sourceMathKatexCount: number
  sourceMermaid: PdfWidgetSnapshot[]
  sourceMarkmap: PdfWidgetSnapshot[]
  preparedMermaid: PdfWidgetSnapshot[]
  preparedMarkmap: PdfWidgetSnapshot[]
  sourceImages: PdfImageSnapshot[]
  preparedImages: PdfImageSnapshot[]
  preBlocks: Array<{
    text: string
    lineCount: number
    clientWidth: number
    scrollWidth: number
    breakInside: string
  }>
  tables: Array<{
    text: string
    columnCount: number
    clientWidth: number
    scrollWidth: number
  }>
  globalTheme: string | null
  devicePixelRatio: number
}

export type PdfExportCaptureOptions = {
  beginMarker: string
  endMarker: string
  requireSourceWidgetsReady?: boolean
  requireSourceImagesLoaded?: boolean
}

export type PdfExportCapture = {
  download: Download
  snapshot: PdfExportSnapshot
  downloadBytes: number
  durationMs: number
}

type SeedPdfDocumentInput = {
  slug: string
  title: string
  raw: string
}

type PdfExportWindow = Window & {
  __pdfExportSnapshot: PdfExportSnapshot | null
  __pdfPrintCalled: boolean
}

export async function seedPdfDocument(
  request: APIRequestContext,
  input: SeedPdfDocumentInput,
): Promise<void> {
  await request.delete(`/api/posts/${input.slug}`).catch(() => {})
  const created = await request.post('/api/posts', {
    data: { path: input.slug, title: input.title },
  })
  expect(created.status(), await created.text()).toBe(201)

  const initial = await (await request.get(`/api/posts/${input.slug}`)).json() as { raw: string }
  const updated = await request.put(`/api/posts/${input.slug}`, {
    data: { baseRaw: initial.raw, raw: input.raw },
  })
  expect(updated.ok(), await updated.text()).toBe(true)
}

export async function installPdfExportObserver(
  page: Page,
  options: PdfExportCaptureOptions,
): Promise<void> {
  await page.addInitScript((config: PdfExportCaptureOptions) => {
    const win = window as PdfExportWindow
    win.__pdfExportSnapshot = null
    win.__pdfPrintCalled = false
    window.print = () => { win.__pdfPrintCalled = true }

    function readImages(root: ParentNode): PdfImageSnapshot[] {
      return Array.from(root.querySelectorAll<HTMLImageElement>('img')).map((image) => ({
        src: image.getAttribute('src'),
        complete: image.complete,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
      }))
    }

    function readSvg(
      svg: SVGSVGElement | null,
      state: string | null,
      dataViewBox: string | null,
      viewport: string | null,
      fitTransform: string | null,
    ): PdfWidgetSnapshot {
      const rootGroup = svg
        ? Array.from(svg.children).find((child) => child.tagName.toLowerCase() === 'g') as SVGGElement | undefined
        : undefined
      const box = svg?.getBoundingClientRect()
      return {
        state,
        svgMarkup: svg?.outerHTML ?? '',
        viewBox: svg?.getAttribute('viewBox') ?? null,
        dataViewBox,
        viewport,
        fitTransform,
        rootTransform: rootGroup?.getAttribute('transform') ?? null,
        hasRootGroup: rootGroup !== undefined,
        width: box?.width ?? 0,
        height: box?.height ?? 0,
      }
    }

    function readSourceMermaid(article: HTMLElement): PdfWidgetSnapshot[] {
      return Array.from(article.querySelectorAll<HTMLElement>('.mermaid-widget')).map((widget) => {
        const svg = widget.querySelector<SVGSVGElement>('.mermaid-svg > svg')
          ?? widget.querySelector<SVGSVGElement>('svg')
        return readSvg(
          svg,
          widget.dataset.mermaidState ?? null,
          svg?.getAttribute('data-mermaid-viewbox') ?? null,
          null,
          null,
        )
      })
    }

    function readSourceMarkmap(article: HTMLElement): PdfWidgetSnapshot[] {
      return Array.from(article.querySelectorAll<HTMLElement>('.markmap-widget')).map((widget) => {
        const svg = widget.querySelector<SVGSVGElement>('.markmap-svg')
        return readSvg(
          svg,
          widget.dataset.markmapState ?? null,
          null,
          svg?.getAttribute('data-markmap-viewport') ?? null,
          svg?.getAttribute('data-markmap-fit-transform') ?? null,
        )
      })
    }

    function readPreparedMermaid(article: HTMLElement): PdfWidgetSnapshot[] {
      return Array.from(article.querySelectorAll<HTMLElement>('.pdf-mermaid')).map((diagram) => {
        const svg = diagram.querySelector<SVGSVGElement>('svg')
        return readSvg(svg, null, null, null, null)
      })
    }

    function readPreparedMarkmap(article: HTMLElement): PdfWidgetSnapshot[] {
      return Array.from(article.querySelectorAll<HTMLElement>('.pdf-markmap')).map((diagram) => {
        const svg = diagram.querySelector<SVGSVGElement>('svg')
        return readSvg(svg, null, null, null, null)
      })
    }

    function readSnapshot(): PdfExportSnapshot | null {
      const surface = document.querySelector<HTMLElement>('.pdf-export-surface')
      const sourceArticle = surface?.querySelector<HTMLElement>('.article')
      const root = document.querySelector<HTMLElement>('.pdf-download-root')
      const article = root?.querySelector<HTMLElement>('.article')
      if (!root || !article || !sourceArticle) return null

      const textContent = article.textContent ?? ''
      if (!textContent.includes(config.beginMarker) || !textContent.includes(config.endMarker)) return null

      const sourceMathStates = Array.from(sourceArticle.querySelectorAll<HTMLElement>('.math-mount'))
        .map((element) => element.dataset.mathState ?? null)
      const sourceMermaid = readSourceMermaid(sourceArticle)
      const sourceMarkmap = readSourceMarkmap(sourceArticle)
      const sourceImages = readImages(sourceArticle)
      if (config.requireSourceWidgetsReady) {
        const allStatesSettled = [
          ...sourceMathStates,
          ...sourceMermaid.map((widget) => widget.state),
          ...sourceMarkmap.map((widget) => widget.state),
        ].every((state) => state === 'ready' || state === 'error')
        if (!allStatesSettled) return null
      }
      if (config.requireSourceImagesLoaded && sourceImages.some((image) => (
        !image.complete || image.naturalWidth <= 0
      ))) return null

      const pageProbe = document.createElement('div')
      pageProbe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;width:1px;height:263mm;'
      root.appendChild(pageProbe)
      const printablePageHeight = pageProbe.getBoundingClientRect().height
      pageProbe.remove()

      const widthProbe = document.createElement('div')
      widthProbe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;width:174mm;height:1px;'
      document.body.appendChild(widthProbe)
      const printablePageWidth = widthProbe.getBoundingClientRect().width
      widthProbe.remove()

      const preBlocks = Array.from(article.querySelectorAll<HTMLElement>('pre')).map((pre) => ({
        text: pre.textContent ?? '',
        lineCount: (pre.textContent ?? '').split(/\r?\n/).length,
        clientWidth: pre.clientWidth,
        scrollWidth: pre.scrollWidth,
        breakInside: getComputedStyle(pre).breakInside,
      }))
      const tables = Array.from(article.querySelectorAll<HTMLTableElement>('table')).map((table) => ({
        text: table.textContent ?? '',
        columnCount: table.rows[0]?.cells.length ?? 0,
        clientWidth: table.clientWidth,
        scrollWidth: table.scrollWidth,
      }))

      return {
        surfaceCount: document.querySelectorAll('.pdf-export-surface').length,
        rootCount: document.querySelectorAll('.pdf-download-root').length,
        hostCount: document.querySelectorAll('.pdf-download-host').length,
        sourceTextContent: sourceArticle.textContent ?? '',
        textContent,
        articleHeight: article.getBoundingClientRect().height,
        articleWidth: article.getBoundingClientRect().width,
        articleClientWidth: article.clientWidth,
        articleScrollWidth: article.scrollWidth,
        printablePageWidth,
        printablePageHeight,
        estimatedPrintablePages: printablePageHeight > 0
          ? Math.ceil(article.getBoundingClientRect().height / printablePageHeight)
          : 0,
        sourceMathStates,
        sourceMathKatexCount: sourceArticle.querySelectorAll('.katex').length,
        sourceMermaid,
        sourceMarkmap,
        preparedMermaid: readPreparedMermaid(article),
        preparedMarkmap: readPreparedMarkmap(article),
        sourceImages,
        preparedImages: readImages(article),
        preBlocks,
        tables,
        globalTheme: document.documentElement.getAttribute('data-theme'),
        devicePixelRatio: window.devicePixelRatio,
      }
    }

    const check = () => {
      if (win.__pdfExportSnapshot) return
      const snapshot = readSnapshot()
      if (snapshot) win.__pdfExportSnapshot = snapshot
    }

    const observer = new MutationObserver(check)
    observer.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        'class',
        'style',
        'data-math-state',
        'data-mermaid-state',
        'data-markmap-state',
        'data-markmap-fit-transform',
        'data-markmap-viewport',
        'data-mermaid-viewbox',
      ],
    })
    check()
  }, options)
}

export async function captureFileTreePdfExport(
  page: Page,
  slug: string,
  options: PdfExportCaptureOptions,
  testInfo: TestInfo,
  artifactName: string,
): Promise<PdfExportCapture> {
  await installPdfExportObserver(page, options)
  await page.goto('/vault')

  const inbox = page.locator('.tree-row[data-tree-kind="folder"][data-tree-path="inbox"]')
  await inbox.locator('.chevron').click()
  const row = page.locator(`.tree-row[data-tree-kind="file"][data-tree-path="${slug}"]`)
  await expect(row).toBeVisible()
  await row.click({ button: 'right' })

  const startedAt = Date.now()
  const downloadPromise = page.waitForEvent('download')
  const snapshotPromise = page
    .waitForFunction(() => (
      (window as PdfExportWindow).__pdfExportSnapshot !== null
    ), undefined, { timeout: 0 })
    .then(() => page.evaluate(() => (
      (window as PdfExportWindow).__pdfExportSnapshot
    )))
  const clickPromise = page.locator('.tree-context-menu button')
    .filter({ hasText: /Export PDF|导出 PDF/ })
    .click()

  const [download, snapshot] = await Promise.all([
    downloadPromise,
    snapshotPromise,
    clickPromise.then(() => undefined),
  ]) as [Download, PdfExportSnapshot | null, void]

  expect(snapshot).not.toBeNull()
  if (!snapshot) throw new Error('PDF export snapshot was not captured')

  const outputPath = testInfo.outputPath(artifactName)
  await download.saveAs(outputPath)
  const downloadBytes = (await fs.stat(outputPath)).size
  const durationMs = Date.now() - startedAt
  return { download, snapshot, downloadBytes, durationMs }
}

export async function assertPdfCleanup(page: Page): Promise<void> {
  await expect(page.locator('.pdf-export-surface')).toHaveCount(0)
  await expect(page.locator('.pdf-download-root')).toHaveCount(0)
  await expect(page.locator('.pdf-download-host')).toHaveCount(0)
}

export async function assertPdfUiResponsive(page: Page, slug: string): Promise<void> {
  const inbox = page.locator('.tree-row[data-tree-kind="folder"][data-tree-path="inbox"]')
  const row = page.locator(`.tree-row[data-tree-kind="file"][data-tree-path="${slug}"]`)

  await expect(inbox).toBeVisible()
  await expect(row).toBeVisible()
  await inbox.locator('.chevron').click()
  await expect(row).toHaveCount(0)
  await inbox.locator('.chevron').click()
  await expect(row).toBeVisible()
}

export async function attachPdfDiagnostics(
  testInfo: TestInfo,
  name: string,
  diagnostics: unknown,
): Promise<void> {
  console.info(`[pdf-h9] ${JSON.stringify({ name, diagnostics })}`)
  await testInfo.attach(name, {
    body: Buffer.from(JSON.stringify(diagnostics, null, 2)),
    contentType: 'application/json',
  })
}

export async function pdfPrintWasCalled(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as PdfExportWindow).__pdfPrintCalled)
}
