import { expect, test } from './fixtures/auth'
import {
  assertPdfCleanup,
  assertPdfUiResponsive,
  attachPdfDiagnostics,
  captureFileTreePdfExport,
  pdfPrintWasCalled,
  seedPdfDocument,
  type PdfExportSnapshot,
} from './helpers/pdf-export'

test.describe.configure({
  mode: 'serial',
  // This is an infrastructure guard for bounded browser stress lanes, not a
  // product performance budget.
  timeout: 300_000,
})

const LONG_SLUG = 'inbox/pdf-export-h9-100-page'
const MERMAID_SLUG = 'inbox/pdf-export-h9-extreme-mermaid'
const MARKMAP_SLUG = 'inbox/pdf-export-h9-extreme-markmap'
const TABLE_SLUG = 'inbox/pdf-export-h9-wide-table'
const CODE_SLUG = 'inbox/pdf-export-h9-huge-code'
const MATH_SLUG = 'inbox/pdf-export-h9-many-math'
const IMAGES_SLUG = 'inbox/pdf-export-h9-many-images'

function countOccurrences(text: string, marker: string): number {
  return text.split(marker).length - 1
}

function paddedId(value: number): string {
  return String(value).padStart(3, '0')
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

function hasFiniteViewport(value: string | null): boolean {
  if (!value) return false
  const numbers = value.trim().split(/[\s,]+/).map(Number)
  return numbers.length >= 2
    && numbers.every(Number.isFinite)
    && numbers[0] > 0
    && numbers[1] > 0
}

function buildHundredPageDocument(): string {
  const sectionCount = 160
  const sections = Array.from({ length: sectionCount }, (_, index) => {
    const id = paddedId(index + 1)
    return `## H9 Section ${id}

H9-SECTION-${id}-BEGIN

This bounded H9 length lane multiplies one deterministic section template. It is intentionally free of diagrams and image pressure so a failure identifies document-length behavior rather than a combined widget workload.

中文内容、日本語の確認、English text and a stable section identifier remain in the prepared PDF article. The browser must preserve the section order and the final tail marker while the document approaches one hundred printable pages.

| Field | Value | Marker |
| --- | --- | --- |
| Section | ${id} | H9-${id} |

\`\`\`text
H9-CODE-${id}
stable long-document section ${id}
\`\`\`

H9-SECTION-${id}-END
`
  }).join('\n')

  return `---
title: PDF Export H9 100 Page Stress
---

# PDF Export H9 100 Page Stress

H9_DOCUMENT_BEGIN

This document is generated from a small deterministic section template. Its purpose is bounded browser-side length validation with complete marker accounting.

${sections}

H9_DOCUMENT_END
`
}

function buildExtremeMermaidDocument(): string {
  const nodeCount = 60
  const nodes = Array.from({ length: nodeCount }, (_, index) => {
    const id = paddedId(index + 1)
    return `N${id}["Node ${id} - bounded long label for H9 diagram stress"]`
  })
  const chain = Array.from({ length: nodeCount - 1 }, (_, index) => {
    const from = paddedId(index + 1)
    const to = paddedId(index + 2)
    return `N${from} --> N${to}`
  })
  const branches = Array.from({ length: 10 }, (_, index) => {
    const from = paddedId(index * 5 + 1)
    const to = paddedId(index * 5 + 6)
    return `N${from} -. branch ${index + 1} .-> N${to}`
  })

  return `---
title: PDF Export H9 Extreme Mermaid
---

# PDF Export H9 Extreme Mermaid

H9_MERMAID_BEGIN

\`\`\`mermaid
flowchart LR
${nodes.join('\n')}
${chain.join('\n')}
${branches.join('\n')}
\`\`\`

H9_MERMAID_AFTER
H9_MERMAID_END
`
}

function buildExtremeMarkmapDocument(): string {
  const branches = Array.from({ length: 16 }, (_, branchIndex) => {
    const branch = String(branchIndex + 1).padStart(2, '0')
    return [
      `## Branch ${branch}`,
      `### Branch ${branch} API`,
      `#### Branch ${branch} Service`,
      `##### Branch ${branch} Storage`,
      `###### Branch ${branch} Leaf`,
    ].join('\n')
  }).join('\n')

  return `---
title: PDF Export H9 Extreme MarkMap
---

# PDF Export H9 Extreme MarkMap

H9_MARKMAP_BEGIN

\`\`\`markmap
# H9 MarkMap Root
${branches}
\`\`\`

H9_MARKMAP_AFTER
H9_MARKMAP_END
`
}

function buildWideTableDocument(): string {
  const columns = Array.from({ length: 24 }, (_, index) => `C${paddedId(index + 1)}`)
  const values = columns.map((_, index) => {
    const number = index + 1
    if (number === 1) return 'H9_TABLE_FIRST'
    if (number === 12) return 'H9_TABLE_MIDDLE'
    if (number === 24) return 'H9_TABLE_LAST'
    return `value-${paddedId(number)} 中文 日本語`
  })
  return `---
title: PDF Export H9 Wide Table
---

# PDF Export H9 Wide Table

H9_TABLE_BEGIN

| ${columns.join(' | ')} |
| ${columns.map(() => '---').join(' | ')} |
| ${values.join(' | ')} |

H9_TABLE_AFTER
H9_TABLE_END
`
}

function buildHugeCodeDocument(): string {
  const lineCount = 600
  const lines = Array.from({ length: lineCount }, (_, index) => {
    const id = String(index + 1).padStart(3, '0')
    if (index === 0) return 'H9_HUGE_CODE_BEGIN'
    if (index === 299) return 'H9_HUGE_CODE_MIDDLE 中文 comment in the middle of the oversized block'
    if (index === lineCount - 2) return 'H9_HUGE_CODE_FINAL_LINE'
    if (index === lineCount - 1) return 'H9_HUGE_CODE_END'
    if (index === 40) return `H9_LONG_UNBROKEN_TOKEN_${'x'.repeat(420)}`
    return `line-${id} preserve the complete bounded oversized code block`
  })

  return `---
title: PDF Export H9 Huge Code
---

# PDF Export H9 Huge Code

H9_CODE_BEFORE

\`\`\`text
${lines.join('\n')}
\`\`\`

H9_CODE_AFTER
H9_HUGE_CODE_TAIL
`
}

function buildManyMathDocument(): string {
  const inline = Array.from({ length: 50 }, (_, index) => {
    const id = paddedId(index + 1)
    return `H9_MATH_INLINE_${id}: $x_{${index + 1}}^2 + y_{${index + 1}}^2 = z_{${index + 1}}^2$`
  }).join('\n\n')
  const display = Array.from({ length: 25 }, (_, index) => {
    const id = paddedId(index + 1)
    return `H9_MATH_DISPLAY_${id}

$$
a_{${index + 1}}^2 + b_{${index + 1}}^2 = c_{${index + 1}}^2
$$`
  }).join('\n\n')

  return `---
title: PDF Export H9 Many Math
---

# PDF Export H9 Many Math

H9_MATH_BEGIN

${inline}

${display}

H9_MATH_FIRST
H9_MATH_MIDDLE
H9_MATH_LAST
H9_MATH_END
`
}

function buildManyImagesDocument(): string {
  const images = Array.from({ length: 30 }, (_, index) => {
    const id = paddedId(index + 1)
    return `![H9 image ${id}](/logo.svg?h9=${id})`
  }).join('\n\n')

  return `---
title: PDF Export H9 Many Images
---

# PDF Export H9 Many Images

H9_IMAGES_BEGIN

${images}

H9_IMAGES_AFTER
H9_IMAGES_END
`
}

function expectNoHorizontalOverflow(snapshot: PdfExportSnapshot): void {
  expect(snapshot.articleScrollWidth).toBeLessThanOrEqual(snapshot.articleClientWidth + 2)
  for (const pre of snapshot.preBlocks) {
    expect(pre.scrollWidth).toBeLessThanOrEqual(pre.clientWidth + 2)
  }
  for (const table of snapshot.tables) {
    expect(table.scrollWidth).toBeLessThanOrEqual(table.clientWidth + 2)
  }
}

test('H9 100-page lane preserves every section through the tail', async ({ page, request }, testInfo) => {
  try {
    await seedPdfDocument(request, {
      slug: LONG_SLUG,
      title: 'PDF Export H9 100 Page Stress',
      raw: buildHundredPageDocument(),
    })
    const result = await captureFileTreePdfExport(
      page,
      LONG_SLUG,
      {
        beginMarker: 'H9_DOCUMENT_BEGIN',
        endMarker: 'H9_DOCUMENT_END',
        requireSourceWidgetsReady: true,
      },
      testInfo,
      'h9-100-page.pdf',
    )
    const { snapshot } = result
    const sectionCount = 160
    const expectedIds = Array.from({ length: sectionCount }, (_, index) => index + 1)
    const beginIds = Array.from(snapshot.textContent.matchAll(/H9-SECTION-(\d{3})-BEGIN/g))
      .map((match) => Number(match[1]))
    const endIds = Array.from(snapshot.textContent.matchAll(/H9-SECTION-(\d{3})-END/g))
      .map((match) => Number(match[1]))

    expect(countOccurrences(snapshot.textContent, 'H9_DOCUMENT_BEGIN')).toBe(1)
    expect(countOccurrences(snapshot.textContent, 'H9_DOCUMENT_END')).toBe(1)
    expect(beginIds).toEqual(expectedIds)
    expect(endIds).toEqual(expectedIds)
    expect(new Set(beginIds).size).toBe(sectionCount)
    expect(new Set(endIds).size).toBe(sectionCount)
    expect(snapshot.estimatedPrintablePages).toBeGreaterThanOrEqual(80)
    expect(snapshot.estimatedPrintablePages).toBeLessThan(140)
    for (const id of [1, 40, 80, 120, sectionCount]) {
      const marker = `H9-SECTION-${paddedId(id)}`
      expect(countOccurrences(snapshot.textContent, `${marker}-BEGIN`)).toBe(1)
      expect(countOccurrences(snapshot.textContent, `${marker}-END`)).toBe(1)
    }
    expectNoHorizontalOverflow(snapshot)
    expect(result.download.suggestedFilename()).toBe('PDF Export H9 100 Page Stress.pdf')
    expect(result.downloadBytes).toBeGreaterThan(1_000)
    expect(await pdfPrintWasCalled(page)).toBe(false)
    await attachPdfDiagnostics(testInfo, 'h9-100-page-diagnostics', {
      lane: '100-page',
      sectionCount,
      articleHeight: snapshot.articleHeight,
      printablePageHeight: snapshot.printablePageHeight,
      estimatedPrintablePages: snapshot.estimatedPrintablePages,
      beginCount: beginIds.length,
      endCount: endIds.length,
      downloadBytes: result.downloadBytes,
      durationMs: result.durationMs,
    })
    await assertPdfCleanup(page)
    await assertPdfUiResponsive(page, LONG_SLUG)
  } finally {
    await request.delete(`/api/posts/${LONG_SLUG}`).catch(() => {})
  }
})

test('H9 extreme Mermaid stays ready and printable', async ({ page, request }, testInfo) => {
  try {
    await seedPdfDocument(request, {
      slug: MERMAID_SLUG,
      title: 'PDF Export H9 Extreme Mermaid',
      raw: buildExtremeMermaidDocument(),
    })
    const result = await captureFileTreePdfExport(
      page,
      MERMAID_SLUG,
      { beginMarker: 'H9_MERMAID_BEGIN', endMarker: 'H9_MERMAID_END', requireSourceWidgetsReady: true },
      testInfo,
      'h9-extreme-mermaid.pdf',
    )
    const source = result.snapshot.sourceMermaid[0]
    const prepared = result.snapshot.preparedMermaid[0]
    expect(result.snapshot.sourceMermaid).toHaveLength(1)
    expect(source?.state).toBe('ready')
    expect(prepared?.svgMarkup).not.toBe('')
    expect(hasFiniteViewBox(prepared?.viewBox ?? null)).toBe(true)
    expect(prepared?.width).toBeLessThanOrEqual(result.snapshot.articleWidth + 2)
    expect(hasInvalidSvgNumber(prepared?.svgMarkup)).toBe(false)
    expect(result.snapshot.textContent).toContain('H9_MERMAID_AFTER')
    expect(result.download.suggestedFilename()).toBe('PDF Export H9 Extreme Mermaid.pdf')
    expect(result.downloadBytes).toBeGreaterThan(1_000)
    expect(await pdfPrintWasCalled(page)).toBe(false)
    await attachPdfDiagnostics(testInfo, 'h9-mermaid-diagnostics', {
      lane: 'extreme-mermaid',
      nodeCount: 60,
      state: source?.state,
      viewBox: prepared?.viewBox,
      width: prepared?.width,
      height: prepared?.height,
      downloadBytes: result.downloadBytes,
      durationMs: result.durationMs,
    })
    await assertPdfCleanup(page)
    await assertPdfUiResponsive(page, MERMAID_SLUG)
  } finally {
    await request.delete(`/api/posts/${MERMAID_SLUG}`).catch(() => {})
  }
})

test('H9 extreme MarkMap stays fitted and printable', async ({ page, request }, testInfo) => {
  try {
    await seedPdfDocument(request, {
      slug: MARKMAP_SLUG,
      title: 'PDF Export H9 Extreme MarkMap',
      raw: buildExtremeMarkmapDocument(),
    })
    const result = await captureFileTreePdfExport(
      page,
      MARKMAP_SLUG,
      { beginMarker: 'H9_MARKMAP_BEGIN', endMarker: 'H9_MARKMAP_END', requireSourceWidgetsReady: true },
      testInfo,
      'h9-extreme-markmap.pdf',
    )
    const source = result.snapshot.sourceMarkmap[0]
    const prepared = result.snapshot.preparedMarkmap[0]
    expect(result.snapshot.sourceMarkmap).toHaveLength(1)
    expect(source?.state).toBe('ready')
    expect(source?.hasRootGroup).toBe(true)
    expect(hasFiniteViewport(source?.viewport)).toBe(true)
    expect(hasInvalidSvgNumber(source?.svgMarkup)).toBe(false)
    expect(hasInvalidSvgNumber(source?.fitTransform)).toBe(false)
    expect(prepared?.svgMarkup).not.toBe('')
    expect(prepared?.hasRootGroup).toBe(true)
    expect(hasFiniteViewBox(prepared?.viewBox ?? null)).toBe(true)
    expect(hasInvalidSvgNumber(prepared?.svgMarkup)).toBe(false)
    expect(hasInvalidSvgNumber(prepared?.rootTransform)).toBe(false)
    expect(prepared?.width).toBeLessThanOrEqual(result.snapshot.articleWidth + 2)
    expect(result.snapshot.textContent).toContain('H9_MARKMAP_AFTER')
    expect(result.download.suggestedFilename()).toBe('PDF Export H9 Extreme MarkMap.pdf')
    expect(result.downloadBytes).toBeGreaterThan(1_000)
    expect(await pdfPrintWasCalled(page)).toBe(false)
    await attachPdfDiagnostics(testInfo, 'h9-markmap-diagnostics', {
      lane: 'extreme-markmap',
      nodeCount: 81,
      depth: 6,
      state: source?.state,
      viewport: source?.viewport,
      fitTransform: source?.fitTransform,
      viewBox: prepared?.viewBox,
      downloadBytes: result.downloadBytes,
      durationMs: result.durationMs,
    })
    await assertPdfCleanup(page)
    await assertPdfUiResponsive(page, MARKMAP_SLUG)
  } finally {
    await request.delete(`/api/posts/${MARKMAP_SLUG}`).catch(() => {})
  }
})

test('H9 24-column table remains within printable width', async ({ page, request }, testInfo) => {
  try {
    await seedPdfDocument(request, {
      slug: TABLE_SLUG,
      title: 'PDF Export H9 Wide Table',
      raw: buildWideTableDocument(),
    })
    const result = await captureFileTreePdfExport(
      page,
      TABLE_SLUG,
      { beginMarker: 'H9_TABLE_BEGIN', endMarker: 'H9_TABLE_END' },
      testInfo,
      'h9-wide-table.pdf',
    )
    const table = result.snapshot.tables[0]
    expect(table?.columnCount).toBe(24)
    expect(table?.text).toContain('H9_TABLE_FIRST')
    expect(table?.text).toContain('H9_TABLE_MIDDLE')
    expect(table?.text).toContain('H9_TABLE_LAST')
    expectNoHorizontalOverflow(result.snapshot)
    expect(result.snapshot.textContent).toContain('H9_TABLE_AFTER')
    expect(result.download.suggestedFilename()).toBe('PDF Export H9 Wide Table.pdf')
    expect(result.downloadBytes).toBeGreaterThan(1_000)
    expect(await pdfPrintWasCalled(page)).toBe(false)
    await attachPdfDiagnostics(testInfo, 'h9-wide-table-diagnostics', {
      lane: 'wide-table',
      columns: table?.columnCount,
      articleWidth: result.snapshot.articleWidth,
      tableClientWidth: table?.clientWidth,
      tableScrollWidth: table?.scrollWidth,
      downloadBytes: result.downloadBytes,
      durationMs: result.durationMs,
    })
    await assertPdfCleanup(page)
    await assertPdfUiResponsive(page, TABLE_SLUG)
  } finally {
    await request.delete(`/api/posts/${TABLE_SLUG}`).catch(() => {})
  }
})

test('H9 huge code block preserves long lines, split state, and tail', async ({ page, request }, testInfo) => {
  try {
    await seedPdfDocument(request, {
      slug: CODE_SLUG,
      title: 'PDF Export H9 Huge Code',
      raw: buildHugeCodeDocument(),
    })
    const result = await captureFileTreePdfExport(
      page,
      CODE_SLUG,
      { beginMarker: 'H9_CODE_BEFORE', endMarker: 'H9_HUGE_CODE_TAIL' },
      testInfo,
      'h9-huge-code.pdf',
    )
    const code = result.snapshot.preBlocks.find((block) => block.text.includes('H9_HUGE_CODE_BEGIN'))
    expect(code).toBeDefined()
    expect(code?.lineCount).toBeGreaterThanOrEqual(600)
    expect(code?.text).toContain('H9_HUGE_CODE_MIDDLE')
    expect(code?.text).toContain('H9_HUGE_CODE_FINAL_LINE')
    expect(code?.text).toContain('H9_HUGE_CODE_END')
    expect(code?.breakInside).toBe('auto')
    expectNoHorizontalOverflow(result.snapshot)
    expect(result.snapshot.textContent).toContain('H9_HUGE_CODE_TAIL')
    expect(result.download.suggestedFilename()).toBe('PDF Export H9 Huge Code.pdf')
    expect(result.downloadBytes).toBeGreaterThan(1_000)
    expect(await pdfPrintWasCalled(page)).toBe(false)
    await attachPdfDiagnostics(testInfo, 'h9-huge-code-diagnostics', {
      lane: 'huge-code',
      lineCount: code?.lineCount,
      breakInside: code?.breakInside,
      clientWidth: code?.clientWidth,
      scrollWidth: code?.scrollWidth,
      downloadBytes: result.downloadBytes,
      durationMs: result.durationMs,
    })
    await assertPdfCleanup(page)
    await assertPdfUiResponsive(page, CODE_SLUG)
  } finally {
    await request.delete(`/api/posts/${CODE_SLUG}`).catch(() => {})
  }
})

test('H9 many KaTeX formulas all settle ready', async ({ page, request }, testInfo) => {
  try {
    await seedPdfDocument(request, {
      slug: MATH_SLUG,
      title: 'PDF Export H9 Many Math',
      raw: buildManyMathDocument(),
    })
    const result = await captureFileTreePdfExport(
      page,
      MATH_SLUG,
      {
        beginMarker: 'H9_MATH_BEGIN',
        endMarker: 'H9_MATH_END',
        requireSourceWidgetsReady: true,
      },
      testInfo,
      'h9-many-math.pdf',
    )
    expect(result.snapshot.sourceMathStates).toHaveLength(75)
    expect(result.snapshot.sourceMathStates.every((state) => state === 'ready')).toBe(true)
    expect(result.snapshot.sourceMathKatexCount).toBeGreaterThanOrEqual(75)
    expect(result.snapshot.textContent).toContain('H9_MATH_INLINE_001')
    expect(result.snapshot.textContent).toContain('H9_MATH_INLINE_025')
    expect(result.snapshot.textContent).toContain('H9_MATH_DISPLAY_025')
    expect(result.snapshot.textContent).toContain('H9_MATH_FIRST')
    expect(result.snapshot.textContent).toContain('H9_MATH_MIDDLE')
    expect(result.snapshot.textContent).toContain('H9_MATH_LAST')
    expect(result.download.suggestedFilename()).toBe('PDF Export H9 Many Math.pdf')
    expect(result.downloadBytes).toBeGreaterThan(1_000)
    expect(await pdfPrintWasCalled(page)).toBe(false)
    await attachPdfDiagnostics(testInfo, 'h9-many-math-diagnostics', {
      lane: 'many-math',
      total: result.snapshot.sourceMathStates.length,
      ready: result.snapshot.sourceMathStates.filter((state) => state === 'ready').length,
      error: result.snapshot.sourceMathStates.filter((state) => state === 'error').length,
      katexCount: result.snapshot.sourceMathKatexCount,
      downloadBytes: result.downloadBytes,
      durationMs: result.durationMs,
    })
    await assertPdfCleanup(page)
    await assertPdfUiResponsive(page, MATH_SLUG)
  } finally {
    await request.delete(`/api/posts/${MATH_SLUG}`).catch(() => {})
  }
})

test('H9 many same-origin images settle and remain in prepared DOM', async ({ page, request }, testInfo) => {
  try {
    await seedPdfDocument(request, {
      slug: IMAGES_SLUG,
      title: 'PDF Export H9 Many Images',
      raw: buildManyImagesDocument(),
    })
    const result = await captureFileTreePdfExport(
      page,
      IMAGES_SLUG,
      {
        beginMarker: 'H9_IMAGES_BEGIN',
        endMarker: 'H9_IMAGES_END',
        requireSourceImagesLoaded: true,
      },
      testInfo,
      'h9-many-images.pdf',
    )
    expect(result.snapshot.sourceImages).toHaveLength(30)
    expect(result.snapshot.sourceImages.every((image) => image.complete && image.naturalWidth > 0)).toBe(true)
    expect(result.snapshot.preparedImages).toHaveLength(30)
    expect(result.snapshot.textContent).toContain('H9_IMAGES_AFTER')
    expect(result.download.suggestedFilename()).toBe('PDF Export H9 Many Images.pdf')
    expect(result.downloadBytes).toBeGreaterThan(1_000)
    expect(await pdfPrintWasCalled(page)).toBe(false)
    await attachPdfDiagnostics(testInfo, 'h9-many-images-diagnostics', {
      lane: 'many-images',
      total: result.snapshot.sourceImages.length,
      loaded: result.snapshot.sourceImages.filter((image) => image.complete && image.naturalWidth > 0).length,
      failed: result.snapshot.sourceImages.filter((image) => image.complete && image.naturalWidth === 0).length,
      timedOut: 0,
      preparedCount: result.snapshot.preparedImages.length,
      downloadBytes: result.downloadBytes,
      durationMs: result.durationMs,
    })
    await assertPdfCleanup(page)
    await assertPdfUiResponsive(page, IMAGES_SLUG)
  } finally {
    await request.delete(`/api/posts/${IMAGES_SLUG}`).catch(() => {})
  }
})
