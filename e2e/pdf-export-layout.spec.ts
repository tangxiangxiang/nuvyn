import { promises as fs } from 'node:fs'
import { expect, test } from './fixtures/auth'

const slug = 'inbox/pdf-export-layout-e2e'

type LayoutBlockSnapshot = {
  text: string
  width: number
  height: number
  clientWidth: number
  scrollWidth: number
  breakInside: string
}

type PdfLayoutSnapshot = {
  textContent: string
  printablePageWidth: number
  printablePageHeight: number
  root: LayoutBlockSnapshot
  article: LayoutBlockSnapshot
  longLine: LayoutBlockSnapshot
  shortCode: LayoutBlockSnapshot
  oversizedCode: LayoutBlockSnapshot
  table: LayoutBlockSnapshot & { columnCount: number }
  mermaid: {
    width: number
    height: number
    viewBox: string | null
    svgMarkup: string
  }
  markmap: {
    width: number
    height: number
    viewBox: string | null
    rootTransform: string | null
    svgMarkup: string
  }
}

function hasInvalidSvgNumber(value: string | null | undefined): boolean {
  return /(?:NaN|Infinity)/.test(value ?? '')
}

function hasFiniteViewBox(value: string | null): boolean {
  if (!value) return false
  const numbers = value.trim().split(/[\s,]+/).map(Number)
  return numbers.length === 4
    && numbers.every(Number.isFinite)
    && numbers[2] > 0
    && numbers[3] > 0
}

test('exports wide and oversized content without horizontal overflow', async ({ page, request }, testInfo) => {
  const layoutRaw = await fs.readFile(new URL('./fixtures/pdf-export-layout.md', import.meta.url), 'utf8')
  await request.delete(`/api/posts/${slug}`).catch(() => {})
  const created = await request.post('/api/posts', {
    data: { path: slug, title: 'PDF Layout Regression' },
  })
  expect(created.status()).toBe(201)
  const initial = await (await request.get(`/api/posts/${slug}`)).json() as { raw: string }
  const updated = await request.put(`/api/posts/${slug}`, {
    data: { baseRaw: initial.raw, raw: layoutRaw },
  })
  expect(updated.ok()).toBe(true)

  await page.addInitScript(() => {
    type LayoutSnapshotWindow = Window & {
      __pdfLayoutSnapshot: PdfLayoutSnapshot | null
      __pdfPrintCalled: boolean
    }

    const win = window as unknown as LayoutSnapshotWindow
    win.__pdfLayoutSnapshot = null
    win.__pdfPrintCalled = false
    window.print = () => { win.__pdfPrintCalled = true }

    function readBlock(element: HTMLElement): LayoutBlockSnapshot {
      const box = element.getBoundingClientRect()
      return {
        text: element.textContent ?? '',
        width: box.width,
        height: box.height,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        breakInside: getComputedStyle(element).breakInside,
      }
    }

    function readSnapshot(): PdfLayoutSnapshot | null {
      const host = document.querySelector<HTMLElement>('.pdf-download-host')
      const root = document.querySelector<HTMLElement>('.pdf-download-root')
      const article = root?.querySelector<HTMLElement>('.article')
      if (!host || !root || !article) return null

      const preBlocks = Array.from(article.querySelectorAll<HTMLElement>('pre'))
      const longLine = preBlocks.find((element) => element.textContent?.includes('H6_LONG_UNBROKEN_TOKEN'))
      const shortCode = preBlocks.find((element) => element.textContent?.includes('H6_SHORT_CODE_MARKER'))
      const oversizedCode = preBlocks.find((element) => element.textContent?.includes('H6_OVERSIZED_CODE_BEGIN'))
      const table = article.querySelector<HTMLTableElement>('table')
      const mermaidSvg = root.querySelector<SVGSVGElement>('.pdf-mermaid > svg')
      const markmapSvg = root.querySelector<SVGSVGElement>('.pdf-markmap > svg')
      const markmapRoot = markmapSvg
        ? Array.from(markmapSvg.children).find((child) => child.tagName.toLowerCase() === 'g') as SVGGElement | undefined
        : undefined
      if (!longLine || !shortCode || !oversizedCode || !table || !mermaidSvg || !markmapSvg) return null

      // Use the same A4-relative CSS physical height as the production
      // oversized-block marker, without hard-coding a browser viewport px.
      const pageProbe = document.createElement('div')
      pageProbe.style.cssText = 'position:absolute;visibility:hidden;height:263mm;width:1px;'
      root.appendChild(pageProbe)
      const printablePageHeight = pageProbe.getBoundingClientRect().height
      pageProbe.remove()

      // Measure the same physical CSS unit used by the production download
      // host. This keeps the regression independent of Chromium's px/mm
      // conversion and proves the source layout is A4-printable-width based.
      const widthProbe = document.createElement('div')
      widthProbe.style.cssText = 'position:absolute;visibility:hidden;width:174mm;height:1px;'
      document.body.appendChild(widthProbe)
      const printablePageWidth = widthProbe.getBoundingClientRect().width
      widthProbe.remove()

      // The snapshot is captured only after the production marker has run.
      // Without it, a future removal of markOversizedPdfBlocks would hang
      // this evidence rather than silently accepting break-inside: avoid.
      if (!oversizedCode.classList.contains('pdf-allow-split')) return null

      const mermaidBox = mermaidSvg.getBoundingClientRect()
      const markmapBox = markmapSvg.getBoundingClientRect()
      return {
        textContent: article.textContent ?? '',
        printablePageWidth,
        printablePageHeight,
        root: readBlock(root),
        article: readBlock(article),
        longLine: readBlock(longLine),
        shortCode: readBlock(shortCode),
        oversizedCode: readBlock(oversizedCode),
        table: {
          ...readBlock(table),
          columnCount: table.rows[0]?.cells.length ?? 0,
        },
        mermaid: {
          width: mermaidBox.width,
          height: mermaidBox.height,
          viewBox: mermaidSvg.getAttribute('viewBox'),
          svgMarkup: mermaidSvg.outerHTML,
        },
        markmap: {
          width: markmapBox.width,
          height: markmapBox.height,
          viewBox: markmapSvg.getAttribute('viewBox'),
          rootTransform: markmapRoot?.getAttribute('transform') ?? null,
          svgMarkup: markmapSvg.outerHTML,
        },
      }
    }

    const observer = new MutationObserver(() => {
      if (win.__pdfLayoutSnapshot) return
      const snapshot = readSnapshot()
      if (snapshot) win.__pdfLayoutSnapshot = snapshot
    })
    observer.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'data-markmap-fit-transform', 'data-markmap-viewport'],
    })
  })

  try {
    await page.goto('/vault')
    const inbox = page.locator('.tree-row[data-tree-kind="folder"][data-tree-path="inbox"]')
    await inbox.locator('.chevron').click()
    const row = page.locator(`.tree-row[data-tree-kind="file"][data-tree-path="${slug}"]`)
    await expect(row).toBeVisible()
    await row.click({ button: 'right' })

    const downloadPromise = page.waitForEvent('download')
    const snapshotPromise = page
      .waitForFunction(() => (
        (window as typeof window & { __pdfLayoutSnapshot?: PdfLayoutSnapshot | null }).__pdfLayoutSnapshot !== null
      ))
      .then(() => page.evaluate(() => (
        (window as typeof window & { __pdfLayoutSnapshot: PdfLayoutSnapshot }).__pdfLayoutSnapshot
      )))
    const clickPromise = page.locator('.tree-context-menu button').filter({ hasText: /Export PDF|导出 PDF/ }).click()
    const [download, snapshot] = await Promise.all([
      downloadPromise,
      snapshotPromise,
      clickPromise.then(() => undefined),
    ]) as [Awaited<typeof downloadPromise>, PdfLayoutSnapshot, void]

    expect(snapshot.textContent).toContain('H6_LONG_UNBROKEN_TOKEN')
    expect(snapshot.textContent).toContain('H6_BEFORE_OVERSIZED_BLOCK')
    expect(snapshot.textContent).toContain('H6_AFTER_OVERSIZED_BLOCK')
    expect(snapshot.textContent).toContain('PDF_LAYOUT_END_MARKER')

    const widthTolerance = 2
    expect(Math.abs(snapshot.root.width - snapshot.printablePageWidth)).toBeLessThanOrEqual(widthTolerance)
    expect(Math.abs(snapshot.article.width - snapshot.printablePageWidth)).toBeLessThanOrEqual(widthTolerance)
    expect(Math.abs(snapshot.root.width - snapshot.article.width)).toBeLessThanOrEqual(widthTolerance)
    expect(snapshot.root.scrollWidth).toBeLessThanOrEqual(snapshot.root.clientWidth + widthTolerance)
    expect(snapshot.article.scrollWidth).toBeLessThanOrEqual(snapshot.article.clientWidth + widthTolerance)
    expect(snapshot.longLine.scrollWidth).toBeLessThanOrEqual(snapshot.longLine.clientWidth + widthTolerance)
    expect(snapshot.oversizedCode.scrollWidth).toBeLessThanOrEqual(snapshot.oversizedCode.clientWidth + widthTolerance)

    expect(snapshot.shortCode.height).toBeLessThan(snapshot.printablePageHeight)
    expect(snapshot.shortCode.breakInside).toBe('avoid')
    expect(snapshot.oversizedCode.height).toBeGreaterThan(snapshot.printablePageHeight)
    expect(snapshot.oversizedCode.breakInside).toBe('auto')
    expect(snapshot.oversizedCode.text).toContain('H6_OVERSIZED_CODE_BEGIN')
    expect(snapshot.oversizedCode.text).toContain('H6_OVERSIZED_CODE_END')

    expect(snapshot.table.columnCount).toBe(10)
    expect(snapshot.table.text).toContain('宽内容测试')
    expect(snapshot.table.text).toContain('印刷レイアウト')
    expect(snapshot.table.scrollWidth).toBeLessThanOrEqual(snapshot.table.clientWidth + widthTolerance)

    expect(snapshot.mermaid.width).toBeLessThanOrEqual(snapshot.article.width + widthTolerance)
    expect(snapshot.mermaid.height).toBeGreaterThan(0)
    expect(hasFiniteViewBox(snapshot.mermaid.viewBox)).toBe(true)
    expect(hasInvalidSvgNumber(snapshot.mermaid.svgMarkup)).toBe(false)

    expect(snapshot.markmap.width).toBeLessThanOrEqual(snapshot.article.width + widthTolerance)
    expect(snapshot.markmap.height).toBeGreaterThan(0)
    expect(hasFiniteViewBox(snapshot.markmap.viewBox)).toBe(true)
    expect(snapshot.markmap.rootTransform).not.toBeNull()
    expect(hasInvalidSvgNumber(snapshot.markmap.svgMarkup)).toBe(false)
    expect(hasInvalidSvgNumber(snapshot.markmap.rootTransform)).toBe(false)

    const outputPath = testInfo.outputPath('pdf-layout-regression.pdf')
    await download.saveAs(outputPath)
    expect(download.suggestedFilename()).toBe('PDF Layout Regression.pdf')
    expect((await fs.stat(outputPath)).size).toBeGreaterThan(10_000)
    expect(await page.evaluate(() => (
      (window as typeof window & { __pdfPrintCalled?: boolean }).__pdfPrintCalled
    ))).toBe(false)
    await expect(page.locator('.pdf-export-surface')).toHaveCount(0)
    await expect(page.locator('.pdf-download-root')).toHaveCount(0)
    await expect(page.locator('.pdf-download-host')).toHaveCount(0)
  } finally {
    await request.delete(`/api/posts/${slug}`).catch(() => {})
  }
})
