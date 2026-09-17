import { expect, test } from './fixtures/auth'
import {
  assertPdfCleanup,
  attachPdfDiagnostics,
  captureFileTreePdfExport,
  pdfPrintWasCalled,
  seedPdfDocument,
} from './helpers/pdf-export'

test.describe.configure({
  mode: 'serial',
  timeout: 180_000,
})

const SAME_ORIGIN_SLUG = 'inbox/pdf-export-h9-cors-same-origin'
const CORS_SLUG = 'inbox/pdf-export-h9-cors-allowed'
const NO_CORS_SLUG = 'inbox/pdf-export-h9-cors-denied'

const CORS_IMAGE = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="48" viewBox="0 0 96 48"><rect width="96" height="48" fill="#dbeafe"/><text x="8" y="30" font-size="14" fill="#1e3a8a">H9 CORS</text></svg>`

async function routeCrossOriginImage(
  page: Parameters<typeof captureFileTreePdfExport>[0],
  path: string,
  allowOrigin: boolean,
): Promise<{ requestCount: () => number; cleanup: () => Promise<void> }> {
  let requests = 0
  const url = `http://localhost:4174/${path}`
  await page.route(`${url}*`, async (route) => {
    requests += 1
    await route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      headers: allowOrigin
        ? { 'Access-Control-Allow-Origin': '*' }
        : undefined,
      body: CORS_IMAGE,
    })
  })
  return {
    requestCount: () => requests,
    cleanup: () => page.unroute(`${url}*`),
  }
}

test('H9 CORS same-origin image remains in the normal lifecycle', async ({ page, request }, testInfo) => {
  try {
    await seedPdfDocument(request, {
      slug: SAME_ORIGIN_SLUG,
      title: 'PDF Export H9 CORS Same Origin',
      raw: `---
title: PDF Export H9 CORS Same Origin
---

# PDF Export H9 CORS Same Origin

H9_CORS_SAME_BEGIN

![same origin](/logo.svg?h9=cors-same-origin)

H9_CORS_SAME_END
`,
    })
    const result = await captureFileTreePdfExport(
      page,
      SAME_ORIGIN_SLUG,
      {
        beginMarker: 'H9_CORS_SAME_BEGIN',
        endMarker: 'H9_CORS_SAME_END',
        requireSourceImagesLoaded: true,
      },
      testInfo,
      'h9-cors-same-origin.pdf',
    )
    expect(result.snapshot.sourceImages).toHaveLength(1)
    expect(result.snapshot.sourceImages[0]?.complete).toBe(true)
    expect(result.snapshot.sourceImages[0]?.naturalWidth).toBeGreaterThan(0)
    expect(result.snapshot.preparedImages).toHaveLength(1)
    expect(result.snapshot.textContent).toContain('H9_CORS_SAME_END')
    expect(result.download.suggestedFilename()).toBe('PDF Export H9 CORS Same Origin.pdf')
    expect(result.downloadBytes).toBeGreaterThan(1_000)
    expect(await pdfPrintWasCalled(page)).toBe(false)
    await attachPdfDiagnostics(testInfo, 'h9-cors-same-origin-diagnostics', {
      lane: 'same-origin',
      requestCount: 0,
      image: result.snapshot.sourceImages[0],
      downloadBytes: result.downloadBytes,
      durationMs: result.durationMs,
    })
    await assertPdfCleanup(page)
  } finally {
    await request.delete(`/api/posts/${SAME_ORIGIN_SLUG}`).catch(() => {})
  }
})

test('H9 CORS cross-origin image with ACAO loads and exports', async ({ page, request }, testInfo) => {
  const route = await routeCrossOriginImage(page, 'h9-cors-allowed.svg', true)
  try {
    await seedPdfDocument(request, {
      slug: CORS_SLUG,
      title: 'PDF Export H9 CORS Allowed',
      raw: `---
title: PDF Export H9 CORS Allowed
---

# PDF Export H9 CORS Allowed

H9_CORS_ALLOWED_BEGIN

![cross origin with CORS](http://localhost:4174/h9-cors-allowed.svg?case=allowed)

H9_CORS_ALLOWED_END
`,
    })
    const result = await captureFileTreePdfExport(
      page,
      CORS_SLUG,
      {
        beginMarker: 'H9_CORS_ALLOWED_BEGIN',
        endMarker: 'H9_CORS_ALLOWED_END',
        requireSourceImagesLoaded: true,
      },
      testInfo,
      'h9-cors-allowed.pdf',
    )
    expect(route.requestCount()).toBeGreaterThan(0)
    expect(result.snapshot.sourceImages).toHaveLength(1)
    expect(result.snapshot.sourceImages[0]?.complete).toBe(true)
    expect(result.snapshot.sourceImages[0]?.naturalWidth).toBeGreaterThan(0)
    expect(result.snapshot.textContent).toContain('H9_CORS_ALLOWED_END')
    expect(result.download.suggestedFilename()).toBe('PDF Export H9 CORS Allowed.pdf')
    expect(result.downloadBytes).toBeGreaterThan(1_000)
    expect(await pdfPrintWasCalled(page)).toBe(false)
    await attachPdfDiagnostics(testInfo, 'h9-cors-allowed-diagnostics', {
      lane: 'cross-origin-with-acao',
      requestCount: route.requestCount(),
      image: result.snapshot.sourceImages[0],
      downloadBytes: result.downloadBytes,
      durationMs: result.durationMs,
    })
    await assertPdfCleanup(page)
  } finally {
    await route.cleanup()
    await request.delete(`/api/posts/${CORS_SLUG}`).catch(() => {})
  }
})

test('H9 CORS cross-origin image without ACAO does not abort the document', async ({ page, request }, testInfo) => {
  const route = await routeCrossOriginImage(page, 'h9-cors-denied.svg', false)
  try {
    await seedPdfDocument(request, {
      slug: NO_CORS_SLUG,
      title: 'PDF Export H9 CORS Denied',
      raw: `---
title: PDF Export H9 CORS Denied
---

# PDF Export H9 CORS Denied

H9_CORS_DENIED_BEGIN

![cross origin without CORS](http://localhost:4174/h9-cors-denied.svg?case=denied)

H9_CORS_DENIED_TAIL
H9_CORS_DENIED_END
`,
    })
    const result = await captureFileTreePdfExport(
      page,
      NO_CORS_SLUG,
      {
        beginMarker: 'H9_CORS_DENIED_BEGIN',
        endMarker: 'H9_CORS_DENIED_END',
      },
      testInfo,
      'h9-cors-denied.pdf',
    )
    expect(route.requestCount()).toBeGreaterThan(0)
    expect(result.snapshot.sourceImages).toHaveLength(1)
    expect(result.snapshot.textContent).toContain('H9_CORS_DENIED_TAIL')
    expect(result.snapshot.textContent).toContain('H9_CORS_DENIED_END')
    expect(result.download.suggestedFilename()).toBe('PDF Export H9 CORS Denied.pdf')
    expect(result.downloadBytes).toBeGreaterThan(1_000)
    expect(await pdfPrintWasCalled(page)).toBe(false)
    await attachPdfDiagnostics(testInfo, 'h9-cors-denied-diagnostics', {
      lane: 'cross-origin-without-acao',
      requestCount: route.requestCount(),
      image: result.snapshot.sourceImages[0],
      policy: 'best effort: image may be omitted, document tail must survive',
      downloadBytes: result.downloadBytes,
      durationMs: result.durationMs,
    })
    await assertPdfCleanup(page)
  } finally {
    await route.cleanup()
    await request.delete(`/api/posts/${NO_CORS_SLUG}`).catch(() => {})
  }
})
