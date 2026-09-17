import { expect, test } from './fixtures/auth'
import {
  assertPdfCleanup,
  assertPdfUiResponsive,
  attachPdfDiagnostics,
  captureFileTreePdfExport,
  pdfPrintWasCalled,
  seedPdfDocument,
} from './helpers/pdf-export'

test.describe.configure({
  mode: 'serial',
  timeout: 180_000,
})

const slug = 'inbox/pdf-export-h9-compat-representative'

const raw = `---
title: PDF Export H9 Compatibility Representative
---

# PDF Export H9 Compatibility Representative

H9_COMPAT_BEGIN

中文 English 日本語 Emoji 🚀

\`\`\`text
H9_COMPAT_CODE
\`\`\`

| A | B | C |
| --- | --- | --- |
| 1 | 2 | 3 |

Inline math $x^2 + y^2 = z^2$.

\`\`\`mermaid
flowchart LR
A[Start] --> B[Export] --> C[Done]
\`\`\`

\`\`\`markmap
# H9 Compatibility
## Source
### Browser
## Output
### PDF
\`\`\`

![Nuvyn logo](/logo.svg?h9=compat)

H9_COMPAT_END
`

test('representative PDF export remains usable across the dedicated compatibility projects', async ({
  page,
  request,
  browserName,
}, testInfo) => {
  try {
    await seedPdfDocument(request, {
      slug,
      title: 'PDF Export H9 Compatibility Representative',
      raw,
    })
    const result = await captureFileTreePdfExport(
      page,
      slug,
      {
        beginMarker: 'H9_COMPAT_BEGIN',
        endMarker: 'H9_COMPAT_END',
        requireSourceWidgetsReady: true,
        requireSourceImagesLoaded: true,
      },
      testInfo,
      `h9-${testInfo.project.name}.pdf`,
    )
    const sourceMermaid = result.snapshot.sourceMermaid[0]
    const sourceMarkmap = result.snapshot.sourceMarkmap[0]
    const preparedMermaid = result.snapshot.preparedMermaid[0]
    const preparedMarkmap = result.snapshot.preparedMarkmap[0]

    expect(result.snapshot.surfaceCount).toBe(1)
    expect(result.snapshot.rootCount).toBe(1)
    expect(result.snapshot.hostCount).toBe(1)
    expect(result.snapshot.textContent).toContain('H9_COMPAT_END')
    expect(result.snapshot.sourceMathStates).toEqual(['ready'])
    expect(sourceMermaid?.state).toBe('ready')
    expect(sourceMarkmap?.state).toBe('ready')
    expect(preparedMermaid?.svgMarkup).not.toBe('')
    expect(preparedMarkmap?.svgMarkup).not.toBe('')
    expect(result.snapshot.sourceImages[0]?.complete).toBe(true)
    expect(result.snapshot.sourceImages[0]?.naturalWidth).toBeGreaterThan(0)
    expect(result.download.suggestedFilename()).toBe('PDF Export H9 Compatibility Representative.pdf')
    expect(result.downloadBytes).toBeGreaterThan(1_000)
    expect(await pdfPrintWasCalled(page)).toBe(false)

    const memory = await page.evaluate(() => {
      const performanceWithMemory = performance as Performance & {
        memory?: { usedJSHeapSize: number }
      }
      return performanceWithMemory.memory?.usedJSHeapSize ?? null
    })
    await attachPdfDiagnostics(testInfo, 'h9-compat-diagnostics', {
      project: testInfo.project.name,
      browser: browserName,
      deviceScaleFactor: result.snapshot.devicePixelRatio,
      durationMs: result.durationMs,
      downloadBytes: result.downloadBytes,
      sourceMathStates: result.snapshot.sourceMathStates,
      mermaidState: sourceMermaid?.state,
      markmapState: sourceMarkmap?.state,
      preparedMermaidViewBox: preparedMermaid?.viewBox,
      preparedMarkmapViewBox: preparedMarkmap?.viewBox,
      usedJSHeapSize: memory,
      memoryThreshold: null,
    })

    if (testInfo.project.name === 'chromium-dpi2') {
      expect(result.snapshot.devicePixelRatio).toBeGreaterThanOrEqual(2)
    }
    await assertPdfCleanup(page)
    await assertPdfUiResponsive(page, slug)
  } finally {
    await request.delete(`/api/posts/${slug}`).catch(() => {})
  }
})
