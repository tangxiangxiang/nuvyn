import { promises as fs } from 'node:fs'
import type { APIRequestContext, Page, TestInfo } from '@playwright/test'
import { expect, test } from './fixtures/auth'
import { assertPdfCleanup, seedPdfDocument } from './helpers/pdf-export'

type Block = {
  tag: string
  text: string
  top: number
  left: number
  height: number
  width: number
  breakInside: string
  allowSplit: boolean
}

type Layout = {
  pageHeight: number
  width: number
  height: number
  blocks: Block[]
  flex: Array<Block & { direction: string; wrap: string; justify: string; items: string; gap: string }>
  scopes: Block[]
  padding: Block[]
}

type ExportWindow = Window & { flexPdfEvidence?: { before: Layout; after: Layout } }

const colors = [
  '#c95050', '#579369', '#557cbb', '#aa7c38', '#9760b3', '#38999d',
  '#d681aa', '#9f4230', '#839d32', '#454b9f', '#a34279', '#365e51',
]

async function makeImages(page: Page, count: number): Promise<string[]> {
  return page.evaluate((palette) => palette.map((color) => {
    const canvas = document.createElement('canvas')
    canvas.width = 240
    canvas.height = 210
    const context = canvas.getContext('2d')!
    context.fillStyle = color
    context.fillRect(0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/png')
  }), colors.slice(0, count))
}

function flexMarkdown(images: string[], paragraphs: number, nested = false): string {
  const imageBlocks = images.flatMap((image, index) => [`![Flex image ${index + 1}](${image})`, ''])
  return [
    '# 测试', '',
    nested
      ? ':::::: flex direction=row-reverse wrap=nowrap justify=space-between items=flex-start gap=24'
      : ':::::: flex direction=row wrap=nowrap gap=16',
    '',
    '::::: flex direction=column grow=1 basis=0', '',
    ...(nested ? ['::: flex direction=column gap=16', '', ...imageBlocks, ':::', ''] : imageBlocks),
    ':::::', '',
    `::::: flex direction=column grow=${nested ? 2 : 1} basis=0`, '',
    ...Array.from({ length: paragraphs }, (_, index) => [
      `FLEX_PARAGRAPH_${String(index + 1).padStart(3, '0')} 海客谈瀛洲，烟涛微茫信难求。`, '',
    ]).flat(),
    ':::::', '', '::::::',
  ].join('\n')
}

async function exportFixture(
  page: Page,
  request: APIRequestContext,
  testInfo: TestInfo,
  raw: string,
): Promise<{ path: string; before: Layout; after: Layout }> {
  const slug = 'inbox/pdf-flex-pagination-e2e'
  try {
    await seedPdfDocument(request, { slug, title: 'Flex pagination', raw })
    await page.goto('/vault')
    await page.evaluate(async () => {
      const { __testing__ } = await import('/src/lib/pdfExport.ts')
      const readLayout = (root: HTMLElement): Layout => {
        const article = root.querySelector<HTMLElement>('.article')!
        const origin = root.getBoundingClientRect()
        const describe = (element: HTMLElement): Block => {
          const box = element.getBoundingClientRect()
          return {
            tag: element.tagName,
            text: element.textContent?.trim() ?? '',
            top: box.top - origin.top,
            left: box.left - origin.left,
            height: box.height,
            width: box.width,
            breakInside: getComputedStyle(element).breakInside,
            allowSplit: element.classList.contains('pdf-allow-split'),
          }
        }
        const probe = root.ownerDocument.createElement('div')
        probe.style.cssText = 'position:absolute;visibility:hidden;height:263mm;width:1px'
        root.append(probe)
        // html2pdf's pagebreak plugin floors physical units to CSS pixels.
        const pageHeight = Math.floor(probe.getBoundingClientRect().height)
        probe.remove()
        return {
          pageHeight,
          width: article.getBoundingClientRect().width,
          height: article.getBoundingClientRect().height,
          blocks: Array.from(article.querySelectorAll<HTMLElement>('h1, h2, p, li, img, pre')).map(describe),
          flex: Array.from(article.querySelectorAll<HTMLElement>('.nuvyn-flex')).map((element) => {
            const style = getComputedStyle(element)
            return {
              ...describe(element), direction: style.flexDirection, wrap: style.flexWrap,
              justify: style.justifyContent, items: style.alignItems, gap: style.gap,
            }
          }),
          scopes: Array.from(article.querySelectorAll<HTMLElement>('.nuvyn-flex-scope')).map(describe),
          padding: Array.from(article.querySelectorAll<HTMLElement>('div[style]'))
            .filter((element) => !element.className && element.style.height)
            .map(describe),
        }
      }
      __testing__.setPdfCloneObserver((clonedDocument) => {
        // html2canvas clones BOTH the source and html2pdf's paginated overlay.
        // Inspect the latter, not the first matching offscreen source root.
        const paginated = clonedDocument.querySelector<HTMLElement>(
          '.html2pdf__container [data-nuvyn-pdf-download-root="true"]',
        )!
        const source = document.querySelector<HTMLElement>('.pdf-download-host .pdf-download-root')!
        const win = window as ExportWindow
        win.flexPdfEvidence = { before: readLayout(source), after: readLayout(paginated) }
      })
    })
    await page.locator('.tree-row[data-tree-kind="folder"][data-tree-path="inbox"] > .row-line .chevron').click()
    const row = page.locator(`.tree-row[data-tree-kind="file"][data-tree-path="${slug}"]`)
    await expect(row).toBeVisible()
    await row.locator(':scope > .row-line').click({ button: 'right' })
    const downloadPromise = page.waitForEvent('download')
    await page.locator('.tree-context-menu button').filter({ hasText: /Export PDF|导出 PDF/ }).click()
    const download = await downloadPromise
    const path = testInfo.outputPath('export.pdf')
    await download.saveAs(path)
    const evidence = await page.evaluate(() => (window as ExportWindow).flexPdfEvidence)
    expect(evidence).toBeDefined()
    if (!evidence) throw new Error('Missing actual paginated PDF clone')
    await testInfo.attach('pagination-layout', {
      body: JSON.stringify(evidence, null, 2), contentType: 'application/json',
    })
    await assertPdfCleanup(page)
    return { path, ...evidence }
  } finally {
    await request.delete(`/api/posts/${slug}`).catch(() => {})
  }
}

/**
 * html2pdf's actual download contains one DCT/JPEG raster per PDF page. Decode
 * those exact byte streams in the browser, without a second rendering library
 * or OCR. Reject an unexpected PDF format rather than accepting a DOM-only
 * assertion as evidence that the downloaded pages contain the images/text.
 */
async function inspectPdfPixels(page: Page, path: string, palette: string[]) {
  const bytes = await fs.readFile(path)
  const pdf = bytes.toString('latin1')
  expect(pdf.startsWith('%PDF-')).toBe(true)
  const mediaBox = /\/MediaBox \[([\d. ]+)\]/u.exec(pdf)?.[1]?.split(/\s+/u).map(Number)
  expect(mediaBox).toEqual([0, 0, 595.28, 841.89])
  const pageCount = [...pdf.matchAll(/\/Type \/Page\b/gu)].length
  const rasters: string[] = []
  const headerPattern = /\/Subtype \/Image\s+([\s\S]*?)stream\r?\n/gu
  let header: RegExpExecArray | null
  while ((header = headerPattern.exec(pdf))) {
    expect(header[1]).toContain('/Filter /DCTDecode')
    const length = Number(/\/Length (\d+)/u.exec(header[1]!)?.[1])
    expect(length).toBeGreaterThan(0)
    const start = header.index + header[0].length
    rasters.push(`data:image/jpeg;base64,${bytes.subarray(start, start + length).toString('base64')}`)
    headerPattern.lastIndex = start + length
  }
  expect(rasters).toHaveLength(pageCount)
  return page.evaluate(async ({ rasters, palette }) => {
    const targets = palette.map((hex) => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)))
    const pages = []
    for (const source of rasters) {
      const image = new Image()
      image.src = source
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')!
      context.drawImage(image, 0, 0)
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data
      const colors = targets.map(() => ({ count: 0, left: canvas.width, right: -1, top: canvas.height, bottom: -1 }))
      let ink = 0
      let textOnLeft = 0
      let textOnRight = 0
      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          const offset = (y * canvas.width + x) * 4
          const r = data[offset]!, g = data[offset + 1]!, b = data[offset + 2]!
          if (Math.min(r, g, b) < 220) ink++
          if (Math.max(r, g, b) < 100) {
            if (x < canvas.width / 2) textOnLeft++
            else textOnRight++
          }
          const colorIndex = targets.findIndex(([red, green, blue]) => (
            Math.abs(r - red!) < 12 && Math.abs(g - green!) < 12 && Math.abs(b - blue!) < 12
          ))
          if (colorIndex < 0) continue
          const color = colors[colorIndex]!
          color.count++
          color.left = Math.min(color.left, x)
          color.right = Math.max(color.right, x)
          color.top = Math.min(color.top, y)
          color.bottom = Math.max(color.bottom, y)
        }
      }
      pages.push({ width: canvas.width, height: canvas.height, ink, textOnLeft, textOnRight, colors })
      canvas.width = canvas.height = 0
    }
    return pages
  }, { rasters, palette })
}

function assertSafeBlocks(layout: Layout): void {
  for (const block of layout.blocks) {
    expect(block.left).toBeGreaterThanOrEqual(-1)
    expect(block.left + block.width).toBeLessThanOrEqual(layout.width + 1)
    if (block.height > layout.pageHeight || block.tag === 'H1' || block.tag === 'H2') continue
    expect(block.breakInside, `${block.tag}: ${block.text}`).toBe('avoid')
    expect(Math.floor((block.top + 1) / layout.pageHeight), `${block.tag}: ${block.text}`)
      .toBe(Math.floor((block.top + block.height - 1) / layout.pageHeight))
  }
}

for (const scenario of [
  { name: 'short row stays with its title', images: 1, paragraphs: 3, nested: false },
  { name: 'near-page row starts below its title and splits between images', images: 4, paragraphs: 14, nested: false },
  { name: 'long row flows beyond two pages without missing or repeated content', images: 12, paragraphs: 64, nested: false },
  { name: 'nested reverse row preserves its alignment and unequal column widths', images: 4, paragraphs: 24, nested: true },
]) {
  test(`Flex PDF: ${scenario.name}`, async ({ page, request }, testInfo) => {
    await page.goto('/__markdown-test?mode=reading')
    const images = await makeImages(page, scenario.images)
    const raw = flexMarkdown(images, scenario.paragraphs, scenario.nested)
    const reader = await page.evaluate(async (raw) => {
      const { render } = await import('/src/lib/markdown.ts')
      const article = document.createElement('article')
      article.className = 'article reading'
      article.style.width = '720px'
      article.innerHTML = await render(raw)
      document.body.append(article)
      await Promise.all(Array.from(article.querySelectorAll('img')).map((image) => image.decode()))
      const columns = Array.from(article.querySelector('.nuvyn-flex')!.children)
        .map((element) => element.getBoundingClientRect().x)
      const direction = getComputedStyle(article.querySelector('.nuvyn-flex')!).flexDirection
      article.remove()
      return { direction, columns }
    }, raw)
    expect(reader.direction).toBe(scenario.nested ? 'row-reverse' : 'row')
    expect(reader.columns[0]! < reader.columns[1]!).toBe(!scenario.nested)

    const { path, before, after } = await exportFixture(page, request, testInfo, raw)
    if (scenario.images === 4 && !scenario.nested) {
      expect(before.flex[0]!.height).toBeLessThan(before.pageHeight)
      expect(before.flex[0]!.top + before.flex[0]!.height).toBeGreaterThan(before.pageHeight)
    }
    expect(after.flex[0]!.top).toBeCloseTo(before.flex[0]!.top, 0)
    expect(after.flex.map(({ direction, wrap, justify, items, gap }) => ({ direction, wrap, justify, items, gap })))
      .toEqual(before.flex.map(({ direction, wrap, justify, items, gap }) => ({ direction, wrap, justify, items, gap })))
    after.flex.forEach((flex, index) => expect(flex.width).toBeCloseTo(before.flex[index]!.width, 0))
    after.scopes.forEach((scope, index) => {
      expect(scope.left).toBeCloseTo(before.scopes[index]!.left, 0)
      expect(scope.width).toBeCloseTo(before.scopes[index]!.width, 0)
    })
    expect(after.scopes.every((scope) => scope.breakInside === 'auto')).toBe(true)
    assertSafeBlocks(after)
    const imageBlocks = after.blocks.filter((block) => block.tag === 'IMG')
    expect(imageBlocks).toHaveLength(scenario.images)
    const paragraphs = after.blocks.filter((block) => block.tag === 'P' && block.text.startsWith('FLEX_PARAGRAPH_'))
    expect(paragraphs.map((block) => block.text.match(/FLEX_PARAGRAPH_\d+/u)?.[0]))
      .toEqual(Array.from({ length: scenario.paragraphs }, (_, index) => `FLEX_PARAGRAPH_${String(index + 1).padStart(3, '0')}`))
    expect(imageBlocks[0]!.top).toBeLessThan(after.pageHeight / 4)

    const pages = await inspectPdfPixels(page, path, colors.slice(0, scenario.images))
    await testInfo.attach('downloaded-page-pixels', { body: JSON.stringify(pages), contentType: 'application/json' })
    if (scenario.images === 1) expect(pages).toHaveLength(1)
    if (scenario.images === 12) expect(pages.length).toBeGreaterThan(2)
    expect(pages[0]!.colors[0]!.count).toBeGreaterThan(10_000)
    expect(scenario.nested ? pages[0]!.textOnLeft : pages[0]!.textOnRight).toBeGreaterThan(1_000)
    for (const pdfPage of pages) expect(pdfPage.ink).toBeGreaterThan(1_000)
    for (let index = 0; index < scenario.images; index++) {
      const appearances = pages.flatMap((pdfPage) => pdfPage.colors[index]!.count > 100 ? [pdfPage] : [])
      // Each uniquely colored image is present exactly once and wholly on
      // one downloaded page, not cut between two raster page streams.
      expect(appearances).toHaveLength(1)
      const pdfPage = appearances[0]!
      const color = pdfPage.colors[index]!
      const scale = pdfPage.width / after.width
      expect(color.left).toBeCloseTo((imageBlocks[index]!.left + 1) * scale, -1)
      expect(color.right - color.left + 1).toBeCloseTo((imageBlocks[index]!.width - 2) * scale, -1)
      expect(color.bottom - color.top + 1).toBeCloseTo((imageBlocks[index]!.height - 2) * scale, -1)
    }
  })
}

test('ordinary PDF paragraphs keep their existing short-block and oversized fallback rules', async ({ page, request }, testInfo) => {
  const raw = [
    '# Ordinary Markdown', '',
    ...Array.from({ length: 30 }, (_, index) => [`ORDINARY_${index} 短段落保持完整，不从字形中间截断。`, '']).flat(),
    '## Long paragraph', '',
    `LONG_BEGIN ${'A genuinely oversized paragraph continues across A4 pages. '.repeat(500)} LONG_END`, '',
    '## Following section', '', 'FINAL_PARAGRAPH The final content remains present.',
  ].join('\n')
  const { path, after } = await exportFixture(page, request, testInfo, raw)
  expect(after.flex).toHaveLength(0)
  expect(after.blocks.filter((block) => block.tag === 'P' && block.text.startsWith('ORDINARY_'))).toHaveLength(30)
  const long = after.blocks.find((block) => block.tag === 'P' && block.text.startsWith('LONG_BEGIN'))!
  expect(long.height).toBeGreaterThan(after.pageHeight)
  expect(long.allowSplit).toBe(true)
  expect(long.breakInside).toBe('auto')
  expect(long.text).toContain('LONG_END')
  expect(after.blocks.at(-1)!.text).toContain('FINAL_PARAGRAPH')
  assertSafeBlocks(after)
  const pages = await inspectPdfPixels(page, path, [])
  expect(pages.length).toBeGreaterThan(2)
  for (const pdfPage of pages) expect(pdfPage.ink).toBeGreaterThan(1_000)
})
