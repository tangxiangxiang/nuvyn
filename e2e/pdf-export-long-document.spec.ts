import { promises as fs } from 'node:fs'
import type { APIRequestContext, Download, Page, TestInfo } from '@playwright/test'
import { expect, test } from './fixtures/auth'

test.describe.configure({
  mode: 'serial',
  // This is an infrastructure guard for the browser transaction, not a PDF
  // performance budget. Duration is collected as diagnostics below.
  timeout: 180_000,
})

type LongDocumentLevel = {
  name: string
  slug: string
  sectionCount: number
  minimumEstimatedPages: number
  maximumEstimatedPages: number
}

const LEVELS: LongDocumentLevel[] = [
  {
    name: '1-page',
    slug: 'inbox/pdf-export-long-1',
    sectionCount: 2,
    minimumEstimatedPages: 1,
    maximumEstimatedPages: 4,
  },
  {
    name: '5-page',
    slug: 'inbox/pdf-export-long-5',
    sectionCount: 10,
    minimumEstimatedPages: 4,
    maximumEstimatedPages: 10,
  },
  {
    name: '20-page',
    slug: 'inbox/pdf-export-long-20',
    sectionCount: 40,
    minimumEstimatedPages: 16,
    maximumEstimatedPages: 30,
  },
  {
    name: '50-page',
    slug: 'inbox/pdf-export-long-50',
    sectionCount: 100,
    minimumEstimatedPages: 40,
    maximumEstimatedPages: 70,
  },
]

type LongDocumentSnapshot = {
  rootCount: number
  hostCount: number
  surfaceCount: number
  textContent: string
  sectionIds: number[]
  sectionBeginCount: number
  sectionEndCount: number
  articleHeight: number
  articleWidth: number
  articleClientWidth: number
  articleScrollWidth: number
  printablePageHeight: number
  estimatedPrintablePages: number
}

type LongDocumentSnapshotWindow = Window & {
  __pdfLongDocumentSnapshot: LongDocumentSnapshot | null
  __pdfPrintCalled: boolean
}

function paddedSectionId(section: number): string {
  return String(section).padStart(3, '0')
}

function buildLongDocument(level: LongDocumentLevel): string {
  const sections = Array.from({ length: level.sectionCount }, (_, index) => {
    const id = paddedSectionId(index + 1)
    return `## H7 Section ${id}

H7-SECTION-${id}-BEGIN

This deterministic section keeps the long-document validation focused on length scaling. It contains ordinary prose, stable markers, and enough repeated flow to cross printable page boundaries without adding a large widget workload.

Nuvyn long-document validation checks that the first, middle, and final sections survive the real browser export transaction. 中文内容、日本語の確認、English text, and a stable section identifier remain in the prepared PDF article.

The section remains intentionally small and predictable. The browser must preserve its order, its tail marker, and its surrounding layout while the document grows from the one-page baseline to the fifty-page validation level.

| Field | Value | Marker |
| --- | --- | --- |
| Section | ${id} | H7-${id} |
| Scale | ${level.name} | stable |

\`\`\`text
H7-CODE-${id}
long document section ${id}
\`\`\`

H7-SECTION-${id}-END
`
  }).join('\n')

  return `---
title: PDF Export Long Document ${level.name}
---

# PDF Export Long Document ${level.name}

H7_DOCUMENT_BEGIN

This is a deterministic browser-side PDF length validation document. It is generated from one small section template multiplied by a bounded section count.

${sections}

H7_DOCUMENT_END
`
}

function countOccurrences(text: string, marker: string): number {
  return text.split(marker).length - 1
}

function extractSectionIds(text: string, suffix: 'BEGIN' | 'END'): number[] {
  return Array.from(text.matchAll(new RegExp(`H7-SECTION-(\\d{3})-${suffix}`, 'g')))
    .map((match) => Number(match[1]))
}

function installLongDocumentObserver(page: Page): Promise<void> {
  return page.addInitScript(() => {
    const win = window as LongDocumentSnapshotWindow
    win.__pdfLongDocumentSnapshot = null
    win.__pdfPrintCalled = false
    window.print = () => { win.__pdfPrintCalled = true }

    function readSnapshot(): LongDocumentSnapshot | null {
      const root = document.querySelector<HTMLElement>('.pdf-download-root')
      const article = root?.querySelector<HTMLElement>('.article')
      if (!root || !article) return null

      const textContent = article.textContent ?? ''
      if (!textContent.includes('H7_DOCUMENT_BEGIN') || !textContent.includes('H7_DOCUMENT_END')) {
        return null
      }

      const pageProbe = document.createElement('div')
      pageProbe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;width:1px;height:263mm;'
      root.appendChild(pageProbe)
      const printablePageHeight = pageProbe.getBoundingClientRect().height
      pageProbe.remove()

      const articleHeight = article.getBoundingClientRect().height
      const sectionIds = Array.from(textContent.matchAll(/H7-SECTION-(\d{3})-BEGIN/g))
        .map((match) => Number(match[1]))

      return {
        rootCount: document.querySelectorAll('.pdf-download-root').length,
        hostCount: document.querySelectorAll('.pdf-download-host').length,
        surfaceCount: document.querySelectorAll('.pdf-export-surface').length,
        textContent,
        sectionIds,
        sectionBeginCount: countMarker(textContent, 'H7-SECTION-', '-BEGIN'),
        sectionEndCount: countMarker(textContent, 'H7-SECTION-', '-END'),
        articleHeight,
        articleWidth: article.getBoundingClientRect().width,
        articleClientWidth: article.clientWidth,
        articleScrollWidth: article.scrollWidth,
        printablePageHeight,
        estimatedPrintablePages: printablePageHeight > 0
          ? Math.ceil(articleHeight / printablePageHeight)
          : 0,
      }
    }

    function countMarker(text: string, prefix: string, suffix: string): number {
      return Array.from(text.matchAll(new RegExp(`${prefix}\\d{3}${suffix}`, 'g'))).length
    }

    const observer = new MutationObserver(() => {
      if (win.__pdfLongDocumentSnapshot) return
      const snapshot = readSnapshot()
      if (snapshot) win.__pdfLongDocumentSnapshot = snapshot
    })
    observer.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style'],
    })
  })
}

async function seedLongDocument(
  request: APIRequestContext,
  level: LongDocumentLevel,
): Promise<void> {
  await request.delete(`/api/posts/${level.slug}`).catch(() => {})
  const created = await request.post('/api/posts', {
    data: {
      path: level.slug,
      title: `PDF Export Long Document ${level.name}`,
    },
  })
  expect(created.status(), await created.text()).toBe(201)

  const initial = await (await request.get(`/api/posts/${level.slug}`)).json() as { raw: string }
  const updated = await request.put(`/api/posts/${level.slug}`, {
    data: {
      baseRaw: initial.raw,
      raw: buildLongDocument(level),
    },
  })
  expect(updated.ok(), await updated.text()).toBe(true)
}

async function captureLongDocumentExport(
  page: Page,
  level: LongDocumentLevel,
  testInfo: TestInfo,
): Promise<{ download: Download; snapshot: LongDocumentSnapshot }> {
  await installLongDocumentObserver(page)
  await page.goto('/vault')

  const inbox = page.locator('.tree-row[data-tree-kind="folder"][data-tree-path="inbox"]')
  await inbox.locator('.chevron').click()
  const row = page.locator(`.tree-row[data-tree-kind="file"][data-tree-path="${level.slug}"]`)
  await expect(row).toBeVisible()
  await row.click({ button: 'right' })

  const startedAt = Date.now()
  const downloadPromise = page.waitForEvent('download')
  const snapshotPromise = page
    .waitForFunction(() => (
      (window as LongDocumentSnapshotWindow).__pdfLongDocumentSnapshot !== null
    ))
    .then(() => page.evaluate(() => (
      (window as LongDocumentSnapshotWindow).__pdfLongDocumentSnapshot
    )))
  const clickPromise = page.locator('.tree-context-menu button')
    .filter({ hasText: /Export PDF|导出 PDF/ })
    .click()

  const [download, snapshot] = await Promise.all([
    downloadPromise,
    snapshotPromise,
    clickPromise.then(() => undefined),
  ]) as [Download, LongDocumentSnapshot | null, void]

  expect(snapshot).not.toBeNull()
  if (!snapshot) throw new Error('PDF long-document surface snapshot was not captured')
  expect(snapshot.rootCount).toBe(1)
  expect(snapshot.hostCount).toBe(1)

  const durationMs = Date.now() - startedAt
  const outputPath = testInfo.outputPath(`pdf-long-${level.name}.pdf`)
  await download.saveAs(outputPath)
  const downloadBytes = (await fs.stat(outputPath)).size
  const diagnostics = {
    level: level.name,
    sectionCount: level.sectionCount,
    preparedArticleHeightPx: snapshot.articleHeight,
    printablePageHeightPx: snapshot.printablePageHeight,
    estimatedPrintablePages: snapshot.estimatedPrintablePages,
    markerCount: snapshot.sectionIds.length,
    downloadBytes,
    durationMs,
  }
  await testInfo.attach('pdf-long-document-diagnostics', {
    body: Buffer.from(JSON.stringify(diagnostics, null, 2)),
    contentType: 'application/json',
  })
  console.info(`[pdf-h7] ${JSON.stringify(diagnostics)}`)

  expect(download.suggestedFilename()).toBe(`PDF Export Long Document ${level.name}.pdf`)
  expect(downloadBytes).toBeGreaterThan(1_000)
  expect(await page.evaluate(() => (window as LongDocumentSnapshotWindow).__pdfPrintCalled)).toBe(false)
  return { download, snapshot }
}

function assertLongDocumentSnapshot(snapshot: LongDocumentSnapshot, level: LongDocumentLevel): void {
  const expectedIds = Array.from({ length: level.sectionCount }, (_, index) => index + 1)
  const endIds = extractSectionIds(snapshot.textContent, 'END')

  expect(countOccurrences(snapshot.textContent, 'H7_DOCUMENT_BEGIN')).toBe(1)
  expect(countOccurrences(snapshot.textContent, 'H7_DOCUMENT_END')).toBe(1)
  expect(snapshot.sectionBeginCount).toBe(level.sectionCount)
  expect(snapshot.sectionEndCount).toBe(level.sectionCount)
  expect(snapshot.sectionIds).toEqual(expectedIds)
  expect(endIds).toEqual(expectedIds)
  expect(new Set(snapshot.sectionIds).size).toBe(level.sectionCount)
  expect(new Set(endIds).size).toBe(level.sectionCount)
  expect(snapshot.estimatedPrintablePages).toBeGreaterThanOrEqual(level.minimumEstimatedPages)
  expect(snapshot.estimatedPrintablePages).toBeLessThan(level.maximumEstimatedPages)
  expect(snapshot.articleScrollWidth).toBeLessThanOrEqual(snapshot.articleClientWidth + 2)

  const middleId = Math.ceil(level.sectionCount / 2)
  for (const id of [1, middleId, level.sectionCount]) {
    const padded = paddedSectionId(id)
    expect(countOccurrences(snapshot.textContent, `H7-SECTION-${padded}-BEGIN`)).toBe(1)
    expect(countOccurrences(snapshot.textContent, `H7-SECTION-${padded}-END`)).toBe(1)
  }
}

for (const level of LEVELS) {
  test(`exports the ${level.name} deterministic long document`, async ({ page, request }, testInfo) => {
    try {
      await seedLongDocument(request, level)
      const { snapshot } = await captureLongDocumentExport(page, level, testInfo)
      assertLongDocumentSnapshot(snapshot, level)

      await expect(page.locator('.pdf-export-surface')).toHaveCount(0)
      await expect(page.locator('.pdf-download-root')).toHaveCount(0)
      await expect(page.locator('.pdf-download-host')).toHaveCount(0)

      // Collapse and re-open the existing folder after cleanup. This is a real
      // UI interaction proving the export did not leave the workspace busy.
      const inbox = page.locator('.tree-row[data-tree-kind="folder"][data-tree-path="inbox"]')
      const row = page.locator(`.tree-row[data-tree-kind="file"][data-tree-path="${level.slug}"]`)
      await inbox.locator('.chevron').click()
      await expect(row).toHaveCount(0)
      await inbox.locator('.chevron').click()
      await expect(row).toBeVisible()
    } finally {
      await request.delete(`/api/posts/${level.slug}`).catch(() => {})
    }
  })
}
