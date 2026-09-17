import { promises as fs } from 'node:fs'
import { expect, test } from './fixtures/auth'
import { seedPdfDocument } from './helpers/pdf-export'

const slug = 'inbox/pdf-export-pagination-e2e'

type PaginationBlockSnapshot = {
  text: string
  top: number
  height: number
  breakInside: string
  pageBreakInside: string
  allowSplit: boolean
}

type BoundaryProbeSnapshot = PaginationBlockSnapshot & {
  marker: string
  distanceToNextPage: number
  wouldCrossPageBoundary: boolean
}

type PaginationSnapshot = {
  textContent: string
  printablePageHeight: number
  articleHeight: number
  targetParagraph: PaginationBlockSnapshot
  targetListItems: PaginationBlockSnapshot[]
  boundaryProbes: BoundaryProbeSnapshot[]
  headingGroup: {
    exists: boolean
    text: string
    breakInside: string
    containsTarget: boolean
  }
  secondParagraphInHeadingGroup: boolean
  horizontalOverflow: boolean
}

type PaginationWindow = Window & {
  __pdfPaginationSnapshot: PaginationSnapshot | null
  __pdfPaginationPrintCalled: boolean
}

test('keeps ordinary paragraphs and list items intact at an A4 page boundary', async ({ page, request }, testInfo) => {
  const raw = await fs.readFile(new URL('./fixtures/pdf-export-pagination.md', import.meta.url), 'utf8')

  try {
    await seedPdfDocument(request, {
      slug,
      title: 'PDF Pagination Regression',
      raw,
    })

    await page.addInitScript(() => {
      const win = window as PaginationWindow
      win.__pdfPaginationSnapshot = null
      win.__pdfPaginationPrintCalled = false
      window.print = () => { win.__pdfPaginationPrintCalled = true }

      function readSnapshot(): void {
        if (win.__pdfPaginationSnapshot) return

        const root = document.querySelector<HTMLElement>('.pdf-download-root')
        const article = root?.querySelector<HTMLElement>('.article')
        if (!root || !article) return

        const textContent = article.textContent ?? ''
        if (!textContent.includes('H6_PAGINATION_BEGIN') || !textContent.includes('H6_PAGINATION_END')) return

        const targetParagraph = Array.from(article.querySelectorAll<HTMLElement>('p'))
          .find((paragraph) => paragraph.textContent?.includes('H6_TARGET_PARAGRAPH_BEGIN'))
        const targetHeading = Array.from(article.querySelectorAll<HTMLElement>('h2'))
          .find((heading) => heading.textContent?.includes('H6_TARGET_HEADING'))
        const targetListItems = Array.from(article.querySelectorAll<HTMLElement>('li'))
          .filter((item) => item.textContent?.includes('H6_LIST_ITEM_'))
        const boundaryProbeElements = Array.from(article.querySelectorAll<HTMLElement>('p'))
          .filter((paragraph) => paragraph.textContent?.includes('H6_BOUNDARY_PROBE_'))
        if (!targetParagraph || !targetHeading || targetListItems.length !== 3 || boundaryProbeElements.length < 3) return

        const pageProbe = document.createElement('div')
        pageProbe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;width:1px;height:263mm;'
        root.appendChild(pageProbe)
        const printablePageHeight = pageProbe.getBoundingClientRect().height
        pageProbe.remove()
        if (printablePageHeight <= 0) return

        const articleTop = article.getBoundingClientRect().top
        const readBlock = (element: HTMLElement): PaginationBlockSnapshot => {
          const box = element.getBoundingClientRect()
          const styles = getComputedStyle(element)
          return {
            text: element.textContent ?? '',
            top: box.top - articleTop,
            height: box.height,
            breakInside: styles.breakInside,
            pageBreakInside: styles.pageBreakInside,
            allowSplit: element.classList.contains('pdf-allow-split'),
          }
        }

        const withPageGeometry = (
          block: PaginationBlockSnapshot,
        ): Omit<BoundaryProbeSnapshot, 'marker'> => {
          const pageOffset = ((block.top % printablePageHeight) + printablePageHeight) % printablePageHeight
          const distanceToNextPage = printablePageHeight - pageOffset
          return {
            ...block,
            distanceToNextPage,
            wouldCrossPageBoundary: distanceToNextPage < block.height,
          }
        }

        const target = readBlock(targetParagraph)
        const boundaryProbes = boundaryProbeElements.map((element) => {
          const marker = element.textContent?.match(/H6_BOUNDARY_PROBE_\d+/)?.[0] ?? 'unknown'
          return {
            ...withPageGeometry(readBlock(element)),
            marker,
          }
        })
        const headingGroup = targetHeading.parentElement?.classList.contains('pdf-heading-group')
          ? targetHeading.parentElement
          : null
        const secondParagraph = Array.from(article.querySelectorAll<HTMLElement>('p'))
          .find((paragraph) => paragraph.textContent?.includes('H6_AFTER_TARGET'))

        win.__pdfPaginationSnapshot = {
          textContent,
          printablePageHeight,
          articleHeight: article.getBoundingClientRect().height,
          targetParagraph: target,
          targetListItems: targetListItems.map(readBlock),
          boundaryProbes,
          headingGroup: {
            exists: headingGroup !== null,
            text: headingGroup?.textContent ?? '',
            breakInside: headingGroup ? getComputedStyle(headingGroup).breakInside : '',
            containsTarget: headingGroup?.contains(targetParagraph) ?? false,
          },
          secondParagraphInHeadingGroup: secondParagraph !== undefined
            && (headingGroup?.contains(secondParagraph) ?? false),
          horizontalOverflow: article.scrollWidth > article.clientWidth + 2,
        }
      }

      const observer = new MutationObserver(() => {
        readSnapshot()
      })
      observer.observe(document, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style'],
      })
      readSnapshot()
    })

    await page.goto('/vault')
    const inbox = page.locator('.tree-row[data-tree-kind="folder"][data-tree-path="inbox"]')
    await inbox.locator('.chevron').click()
    const row = page.locator(`.tree-row[data-tree-kind="file"][data-tree-path="${slug}"]`)
    await expect(row).toBeVisible()
    await row.click({ button: 'right' })

    const downloadPromise = page.waitForEvent('download')
    const snapshotPromise = page
      .waitForFunction(() => (
        (window as PaginationWindow).__pdfPaginationSnapshot !== null
      ))
      .then(() => page.evaluate(() => (
        (window as PaginationWindow).__pdfPaginationSnapshot
      )))
    const clickPromise = page.locator('.tree-context-menu button')
      .filter({ hasText: /Export PDF|导出 PDF/ })
      .click()

    const [download, snapshot] = await Promise.all([
      downloadPromise,
      snapshotPromise,
      clickPromise.then(() => undefined),
    ]) as [Awaited<typeof downloadPromise>, PaginationSnapshot | null, void]

    expect(snapshot).not.toBeNull()
    if (!snapshot) throw new Error('PDF pagination snapshot was not captured')

    expect(snapshot.textContent).toContain('H6_TARGET_PARAGRAPH_BEGIN')
    expect(snapshot.textContent).toContain('H6_TARGET_PARAGRAPH_END')
    expect(snapshot.textContent).toContain('H6_LIST_ITEM_003')
    console.log('[pdf-pagination]', JSON.stringify({
      printablePageHeight: snapshot.printablePageHeight,
      boundaryProbes: snapshot.boundaryProbes.map((probe) => ({
        marker: probe.marker,
        top: probe.top,
        height: probe.height,
        distanceToNextPage: probe.distanceToNextPage,
        wouldCrossPageBoundary: probe.wouldCrossPageBoundary,
        breakInside: probe.breakInside,
        pageBreakInside: probe.pageBreakInside,
        allowSplit: probe.allowSplit,
      })),
    }))
    for (const probe of snapshot.boundaryProbes) {
      expect(probe.height).toBeLessThan(snapshot.printablePageHeight)
    }
    const crossingProbe = snapshot.boundaryProbes.find((probe) => probe.wouldCrossPageBoundary)
    expect(
      crossingProbe,
      JSON.stringify(snapshot.boundaryProbes.map((probe) => ({
        marker: probe.marker,
        top: probe.top,
        height: probe.height,
        distanceToNextPage: probe.distanceToNextPage,
        wouldCrossPageBoundary: probe.wouldCrossPageBoundary,
      }))),
    ).toBeDefined()
    if (!crossingProbe) throw new Error('No short boundary probe crosses an A4 page boundary')
    expect(crossingProbe.wouldCrossPageBoundary).toBe(true)
    expect(crossingProbe.breakInside).toBe('avoid')
    expect(crossingProbe.pageBreakInside).toBe('avoid')
    expect(crossingProbe.allowSplit).toBe(false)
    expect(snapshot.targetParagraph.height).toBeLessThan(snapshot.printablePageHeight)
    expect(snapshot.targetParagraph.breakInside).toBe('avoid')
    expect(snapshot.targetParagraph.pageBreakInside).toBe('avoid')
    expect(snapshot.targetParagraph.allowSplit).toBe(false)
    expect(snapshot.headingGroup.exists).toBe(true)
    expect(snapshot.headingGroup.text).toContain('H6_TARGET_HEADING')
    expect(snapshot.headingGroup.containsTarget).toBe(true)
    expect(snapshot.headingGroup.breakInside).toBe('avoid')
    expect(snapshot.secondParagraphInHeadingGroup).toBe(false)
    for (const item of snapshot.targetListItems) {
      expect(item.height).toBeLessThan(snapshot.printablePageHeight)
      expect(item.breakInside).toBe('avoid')
      expect(item.pageBreakInside).toBe('avoid')
      expect(item.allowSplit).toBe(false)
    }
    expect(snapshot.horizontalOverflow).toBe(false)

    const outputPath = testInfo.outputPath('pdf-pagination-regression.pdf')
    await download.saveAs(outputPath)
    expect(download.suggestedFilename()).toBe('PDF Pagination Regression.pdf')
    expect((await fs.stat(outputPath)).size).toBeGreaterThan(1_000)
    expect(await page.evaluate(() => (
      (window as PaginationWindow).__pdfPaginationPrintCalled
    ))).toBe(false)

    await expect(page.locator('.pdf-export-surface')).toHaveCount(0)
    await expect(page.locator('.pdf-download-root')).toHaveCount(0)
    await expect(page.locator('.pdf-download-host')).toHaveCount(0)
  } finally {
    await request.delete(`/api/posts/${slug}`).catch(() => {})
  }
})
