import { promises as fs } from 'node:fs'
import { expect, test } from './fixtures/auth'

const slug = 'inbox/pdf-export-e2e'
const printableAlertBackgrounds: Record<string, string> = {
  'callout-note': 'rgb(241, 242, 244)',
  'callout-tip': 'rgb(238, 240, 255)',
  'callout-important': 'rgb(243, 237, 255)',
  'callout-warning': 'rgb(255, 247, 227)',
  'callout-caution': 'rgb(255, 233, 236)',
}
const printableContainerBackgrounds: Record<string, string> = {
  'markdown-container-info': 'rgb(241, 242, 244)',
  'markdown-container-tip': 'rgb(238, 240, 255)',
  'markdown-container-warning': 'rgb(255, 247, 227)',
  'markdown-container-danger': 'rgb(255, 233, 236)',
  'markdown-container-details': 'rgb(241, 242, 244)',
}

type PdfSurfaceSnapshot = {
  surfaceCount: number
  textContent: string
  codeText: string
  preCount: number
  tableText: string
  hasStrong: boolean
  hasEm: boolean
  inlineCodeText: string
  hasCallout: boolean
  calloutTypes: string[]
  calloutEvidence: Array<{
    type: string
    title: string
    background: string
    borderWidth: string
    borderTopWidth: string
    radius: string
    shadow: string
    paddingTop: string
    paddingLeft: string
    fontWeight: string
    lineHeight: string
    hasIcon: boolean
  }>
  hasContainer: boolean
  containerTypes: string[]
  containerEvidence: Array<{
    type: string
    title: string
    background: string
    borderWidth: string
    borderTopWidth: string
    radius: string
    shadow: string
    paddingTop: string
    paddingLeft: string
    fontWeight: string
    lineHeight: string
    open: boolean | null
  }>
  taskCheckboxCount: number
  checkedTaskCount: number
  footnoteMarkerCount: number
  footnoteText: string
  mathStates: Array<string | null>
  mathKinds: string[]
  katexCount: number
  mermaid: Array<{
    state: string | null
    viewBox: string | null
    dataViewBox: string | null
    svgMarkup: string
  }>
  preparedMermaid: Array<{
    viewBox: string | null
    svgMarkup: string
    preserveAspectRatio: string | null
  }>
  markmap: Array<{
    state: string | null
    viewport: string | null
    fitTransform: string | null
    rootTransform: string | null
    hasRootGroup: boolean
    svgMarkup: string
  }>
  image: {
    src: string | null
    complete: boolean
    naturalWidth: number
  } | null
  globalTheme: string | null
}

type PdfShikiTokenEvidence = {
  light: string
  dark: string
  computed: string
}

type PdfShikiCloneEvidence = {
  tokens: PdfShikiTokenEvidence[]
  lightBackground: string
  darkBackground: string
  computedBackground: string
  ownerCount: number
  copiedHeadOwnerCount: number
  globalTheme: string | null
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
  return numbers.length === 2
    && numbers.every(Number.isFinite)
    && numbers[0] > 0
    && numbers[1] > 0
}

test('exports the Kitchen Sink with settled content from the file-tree menu', async ({ page, request }, testInfo) => {
  const kitchenSinkRaw = await fs.readFile(new URL('./fixtures/pdf-export-kitchen-sink.md', import.meta.url), 'utf8')
  await request.delete(`/api/posts/${slug}`).catch(() => {})
  const created = await request.post('/api/posts', {
    data: { path: slug, title: 'PDF Export E2E' },
  })
  expect(created.status()).toBe(201)
  const initial = await (await request.get(`/api/posts/${slug}`)).json() as { raw: string }
  const updated = await request.put(`/api/posts/${slug}`, {
    data: {
      baseRaw: initial.raw,
      raw: kitchenSinkRaw,
    },
  })
  expect(updated.ok()).toBe(true)

  await page.addInitScript(() => {
    localStorage.setItem('nuvyn.theme', 'dark')

    type PdfSurfaceSnapshotWindow = Window & {
      __pdfPrintCalled: boolean
      __pdfSurfaceSnapshot: PdfSurfaceSnapshot | null
    }

    const win = window as unknown as PdfSurfaceSnapshotWindow
    win.__pdfPrintCalled = false
    win.__pdfSurfaceSnapshot = null
    window.print = () => {
      win.__pdfPrintCalled = true
    }

    function readSnapshot(): PdfSurfaceSnapshot | null {
      const surface = document.querySelector<HTMLElement>('.pdf-export-surface')
      const article = surface?.querySelector<HTMLElement>('.article')
      const downloadRoot = document.querySelector<HTMLElement>('.pdf-download-root')
      const preparedArticle = downloadRoot?.querySelector<HTMLElement>('.article')
      if (!surface || !article || !downloadRoot || !preparedArticle) return null

      const math = Array.from(article.querySelectorAll<HTMLElement>('.math-mount'))
      const mermaidWidgets = Array.from(article.querySelectorAll<HTMLElement>('.mermaid-widget'))
      const markmapWidgets = Array.from(article.querySelectorAll<HTMLElement>('.markmap-widget'))
      const preparedMermaid = Array.from(
        preparedArticle.querySelectorAll<SVGSVGElement>('.pdf-mermaid > svg'),
      ).map((svg) => ({
        viewBox: svg.getAttribute('viewBox'),
        svgMarkup: svg.outerHTML,
        preserveAspectRatio: svg.getAttribute('preserveAspectRatio'),
      }))
      const image = Array.from(article.querySelectorAll<HTMLImageElement>('img'))
        .find((candidate) => candidate.getAttribute('src')?.endsWith('/logo.svg'))

      const snapshot: PdfSurfaceSnapshot = {
        surfaceCount: document.querySelectorAll('.pdf-export-surface').length,
        textContent: article.textContent ?? '',
        codeText: article.querySelector('pre code')?.textContent ?? '',
        preCount: article.querySelectorAll('pre').length,
        tableText: article.querySelector('table')?.textContent ?? '',
        hasStrong: article.querySelector('strong') !== null,
        hasEm: article.querySelector('em') !== null,
        inlineCodeText: article.querySelector('p code')?.textContent ?? '',
        hasCallout: article.querySelector('.callout') !== null,
        calloutTypes: Array.from(preparedArticle.querySelectorAll<HTMLElement>('.callout'))
          .map((callout) => Array.from(callout.classList).find((name) => name.startsWith('callout-') && name !== 'callout') ?? ''),
        calloutEvidence: Array.from(preparedArticle.querySelectorAll<HTMLElement>('.callout')).map((callout) => {
          const type = Array.from(callout.classList)
            .find((name) => name.startsWith('callout-') && name !== 'callout') ?? ''
          const title = callout.querySelector<HTMLElement>('.callout-title')
          const calloutStyle = getComputedStyle(callout)
          return {
            type,
            title: title?.querySelector('.callout-title-text')?.textContent ?? '',
            background: calloutStyle.backgroundColor,
            borderWidth: calloutStyle.borderLeftWidth,
            borderTopWidth: calloutStyle.borderTopWidth,
            radius: calloutStyle.borderRadius,
            shadow: calloutStyle.boxShadow,
            paddingTop: calloutStyle.paddingTop,
            paddingLeft: calloutStyle.paddingLeft,
            fontWeight: title ? getComputedStyle(title).fontWeight : '',
            lineHeight: title ? getComputedStyle(title).lineHeight : '',
            hasIcon: callout.querySelector('.callout-icon') !== null,
          }
        }),
        hasContainer: preparedArticle.querySelector('.markdown-container') !== null,
        containerTypes: Array.from(preparedArticle.querySelectorAll<HTMLElement>('.markdown-container'))
          .map((container) => Array.from(container.classList)
            .find((name) => name.startsWith('markdown-container-') && name !== 'markdown-container') ?? ''),
        containerEvidence: Array.from(preparedArticle.querySelectorAll<HTMLElement>('.markdown-container')).map((container) => {
          const type = Array.from(container.classList)
            .find((name) => name.startsWith('markdown-container-') && name !== 'markdown-container') ?? ''
          const title = container.querySelector<HTMLElement>('.markdown-container-title')
          const containerStyle = getComputedStyle(container)
          return {
            type,
            title: title?.textContent ?? '',
            background: containerStyle.backgroundColor,
            borderWidth: containerStyle.borderLeftWidth,
            borderTopWidth: containerStyle.borderTopWidth,
            radius: containerStyle.borderRadius,
            shadow: containerStyle.boxShadow,
            paddingTop: containerStyle.paddingTop,
            paddingLeft: containerStyle.paddingLeft,
            fontWeight: title ? getComputedStyle(title).fontWeight : '',
            lineHeight: title ? getComputedStyle(title).lineHeight : '',
            open: container instanceof HTMLDetailsElement ? container.open : null,
          }
        }),
        taskCheckboxCount: article.querySelectorAll('input.task-list-item-checkbox').length,
        checkedTaskCount: article.querySelectorAll('input.task-list-item-checkbox:checked').length,
        footnoteMarkerCount: article.querySelectorAll('.footnote-ref').length,
        footnoteText: article.querySelector('.footnotes')?.textContent ?? '',
        mathStates: math.map((element) => element.dataset.mathState ?? null),
        mathKinds: math.map((element) => element.classList.contains('math-block') ? 'block' : 'inline'),
        katexCount: article.querySelectorAll('.katex').length,
        mermaid: mermaidWidgets.map((widget) => {
          const svg = widget.querySelector<SVGSVGElement>('.mermaid-svg svg')
          return {
            state: widget.dataset.mermaidState ?? null,
            viewBox: svg?.getAttribute('viewBox') ?? null,
            dataViewBox: svg?.getAttribute('data-mermaid-viewbox') ?? null,
            svgMarkup: svg?.outerHTML ?? '',
          }
        }),
        preparedMermaid,
        markmap: markmapWidgets.map((widget) => {
          const svg = widget.querySelector<SVGSVGElement>('.markmap-svg')
          const rootGroup = svg
            ? Array.from(svg.children).find((child) => child.tagName.toLowerCase() === 'g') as SVGGElement | undefined
            : undefined
          return {
            state: widget.dataset.markmapState ?? null,
            viewport: svg?.dataset.markmapViewport ?? null,
            fitTransform: svg?.dataset.markmapFitTransform ?? null,
            rootTransform: rootGroup?.getAttribute('transform') ?? null,
            hasRootGroup: rootGroup !== undefined,
            svgMarkup: svg?.outerHTML ?? '',
          }
        }),
        image: image
          ? {
              src: image.getAttribute('src'),
              complete: image.complete,
              naturalWidth: image.naturalWidth,
            }
          : null,
        globalTheme: document.documentElement.getAttribute('data-theme'),
      }

      const allMathReady = math.length > 0 && math.every((element) => element.dataset.mathState === 'ready')
      const allMermaidReady = mermaidWidgets.length > 0
        && mermaidWidgets.every((element) => element.dataset.mermaidState === 'ready')
      const allMarkmapReady = markmapWidgets.length > 0
        && markmapWidgets.every((element) => element.dataset.markmapState === 'ready')
      const noEnhancementPlaceholders = article.querySelector('.math-mount:not([data-math-mounted]), .mermaid-mount, .markmap-mount') === null
      const imageReady = image !== undefined && image.complete && image.naturalWidth > 0

      if (
        !allMathReady
        || !allMermaidReady
        || !allMarkmapReady
        || !noEnhancementPlaceholders
        || !imageReady
        || preparedMermaid.length !== mermaidWidgets.length
      ) return null
      return snapshot
    }

    const check = () => {
      if (win.__pdfSurfaceSnapshot) return
      const snapshot = readSnapshot()
      if (snapshot) win.__pdfSurfaceSnapshot = snapshot
    }

    const observer = new MutationObserver(check)
    observer.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        'data-math-state',
        'data-mermaid-state',
        'data-markmap-state',
        'data-markmap-fit-transform',
        'data-markmap-viewport',
        'data-mermaid-viewbox',
      ],
    })
    check()
  })

  await page.goto('/vault')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  const themeBeforeExport = await page.locator('html').getAttribute('data-theme')
  await page.evaluate(async () => {
    const { __testing__ } = await import('/src/lib/pdfExport.ts')
    const win = window as Window & { __pdfShikiCloneEvidence?: PdfShikiCloneEvidence | null }
    win.__pdfShikiCloneEvidence = null
    __testing__.setPdfCloneObserver((clonedDocument, clonedRoot) => {
      const article = clonedRoot.querySelector<HTMLElement>('.article')
      const pre = article?.querySelector<HTMLElement>('pre.shiki:not(.nuvyn-shiki-plain)')
      if (!article || !pre) throw new Error('PDF clone did not retain a Shiki code block')
      const view = clonedDocument.defaultView ?? window
      const normalize = (value: string): string => {
        const probe = clonedDocument.createElement('span')
        probe.style.color = value.trim()
        article.append(probe)
        const normalized = view.getComputedStyle(probe).color
        probe.remove()
        return normalized
      }
      const tokens = Array.from(pre.querySelectorAll<HTMLElement>('span'))
        .filter((element) => Array.from(element.classList).some((name) => name.startsWith('nuvyn-shiki-')))
        .map((token) => {
          const style = view.getComputedStyle(token)
          return {
            light: normalize(style.getPropertyValue('--shiki-light')),
            dark: normalize(style.getPropertyValue('--shiki-dark')),
            computed: style.color,
          }
        })
        .filter((token) => token.light !== token.dark)
      const preStyle = view.getComputedStyle(pre)
      const owner = clonedRoot.querySelector<HTMLStyleElement>('style#nuvyn-pdf-download-styles')
      win.__pdfShikiCloneEvidence = {
        tokens,
        lightBackground: normalize(preStyle.getPropertyValue('--shiki-light-bg')),
        darkBackground: normalize(preStyle.getPropertyValue('--shiki-dark-bg')),
        computedBackground: preStyle.backgroundColor,
        ownerCount: clonedRoot.querySelectorAll('style#nuvyn-pdf-download-styles').length,
        copiedHeadOwnerCount: clonedRoot.querySelectorAll('style#nuvyn-shiki-generated-styles').length,
        globalTheme: clonedDocument.documentElement.getAttribute('data-theme'),
      }
      if (!owner?.textContent?.includes('var(--shiki-light)')) {
        throw new Error('PDF clone stylesheet is missing the printable Shiki override')
      }
    })
  })

  const inbox = page.locator('.tree-row[data-tree-kind="folder"][data-tree-path="inbox"]')
  await inbox.locator('.chevron').click()
  const row = page.locator(`.tree-row[data-tree-kind="file"][data-tree-path="${slug}"]`)
  await expect(row).toBeVisible()
  await row.click({ button: 'right' })

  const downloadPromise = page.waitForEvent('download')
  const snapshotPromise = page
    .waitForFunction(() => (
      (window as typeof window & { __pdfSurfaceSnapshot?: PdfSurfaceSnapshot | null }).__pdfSurfaceSnapshot !== null
    ))
    .then(() => page.evaluate(() => (
      (window as typeof window & { __pdfSurfaceSnapshot: PdfSurfaceSnapshot }).__pdfSurfaceSnapshot
    )))
  const clickPromise = page.locator('.tree-context-menu button').filter({ hasText: /Export PDF|导出 PDF/ }).click()
  const [download, snapshot] = await Promise.all([
    downloadPromise,
    snapshotPromise,
    clickPromise.then(() => undefined),
  ]) as [Awaited<typeof downloadPromise>, PdfSurfaceSnapshot, void]

  expect(snapshot).not.toBeNull()
  expect(snapshot.surfaceCount).toBe(1)
  expect(snapshot.globalTheme).toBe('dark')
  expect(snapshot.textContent).toContain('PDF Export Kitchen Sink')
  expect(snapshot.textContent).toContain('中文')
  expect(snapshot.textContent).toContain('English')
  expect(snapshot.textContent).toContain('日本語')
  expect(snapshot.textContent).toContain('Emoji 🚀')
  expect(snapshot.hasStrong).toBe(true)
  expect(snapshot.hasEm).toBe(true)
  expect(snapshot.inlineCodeText).toBe('inline code')
  expect(snapshot.hasCallout).toBe(true)
  expect(snapshot.calloutTypes).toEqual([
    'callout-note',
    'callout-tip',
    'callout-important',
    'callout-warning',
    'callout-caution',
  ])
  expect(snapshot.calloutEvidence.map((alert) => alert.title)).toEqual([
    '注意', '提示', '重要', '警告', '小心',
  ])
  expect(snapshot.calloutEvidence).toHaveLength(5)
  for (const alert of snapshot.calloutEvidence) {
    expect(alert.background).toBe(printableAlertBackgrounds[alert.type])
    expect(alert.borderWidth).toBe('0px')
    expect(alert.borderTopWidth).toBe('0px')
    expect(alert.radius).toBe('12px')
    expect(alert.shadow).toBe('none')
    expect(alert.fontWeight).toBe('700')
    expect(alert.paddingTop).toBe('12px')
    expect(alert.paddingLeft).toBe('16px')
    expect(Number.parseFloat(alert.lineHeight)).toBeCloseTo(19.6, 1)
    expect(alert.hasIcon).toBe(false)
  }
  expect(snapshot.hasContainer).toBe(true)
  expect(snapshot.containerTypes).toEqual([
    'markdown-container-info',
    'markdown-container-tip',
    'markdown-container-warning',
    'markdown-container-danger',
    'markdown-container-details',
  ])
  expect(snapshot.containerEvidence.map((container) => container.title)).toEqual([
    'Information', 'Tip', 'Warning', 'Danger', 'Details',
  ])
  expect(snapshot.containerEvidence).toHaveLength(5)
  for (const container of snapshot.containerEvidence) {
    expect(container.background).toBe(printableContainerBackgrounds[container.type])
    expect(container.borderWidth).toBe('0px')
    expect(container.borderTopWidth).toBe('0px')
    expect(container.radius).toBe('12px')
    expect(container.shadow).toBe('none')
    expect(container.paddingTop).toBe('12px')
    expect(container.paddingLeft).toBe('16px')
    expect(container.fontWeight).toBe('700')
    expect(Number.parseFloat(container.lineHeight)).toBeCloseTo(19.6, 1)
  }
  expect(snapshot.containerEvidence.find((container) => container.type === 'markdown-container-details')?.open)
    .toBe(true)
  expect(snapshot.taskCheckboxCount).toBe(2)
  expect(snapshot.checkedTaskCount).toBe(1)
  expect(snapshot.footnoteMarkerCount).toBeGreaterThan(0)
  expect(snapshot.footnoteText).toContain('PDF export kitchen-sink regression fixture.')

  expect(snapshot.preCount).toBeGreaterThan(0)
  expect(snapshot.codeText).toContain('Hello PDF')
  expect(snapshot.tableText).toContain('A')
  expect(snapshot.tableText).toContain('B')
  expect(snapshot.tableText).toContain('C')
  expect(snapshot.tableText).toContain('1')
  expect(snapshot.tableText).toContain('2')
  expect(snapshot.tableText).toContain('3')

  expect(snapshot.mathStates.length).toBeGreaterThanOrEqual(2)
  expect(snapshot.mathStates.every((state) => state === 'ready')).toBe(true)
  expect(snapshot.mathKinds).toEqual(expect.arrayContaining(['inline', 'block']))
  expect(snapshot.katexCount).toBeGreaterThanOrEqual(2)

  expect(snapshot.mermaid).toHaveLength(1)
  const mermaid = snapshot.mermaid[0]
  expect(mermaid.state).toBe('ready')
  expect(mermaid.svgMarkup).not.toBe('')
  if (mermaid.viewBox !== null) {
    expect(hasFiniteViewBox(mermaid.viewBox)).toBe(true)
  }
  expect(hasFiniteViewBox(mermaid.dataViewBox)).toBe(true)
  expect(hasInvalidSvgNumber(mermaid.svgMarkup)).toBe(false)

  expect(snapshot.preparedMermaid).toHaveLength(1)
  const preparedMermaid = snapshot.preparedMermaid[0]
  expect(preparedMermaid.svgMarkup).not.toBe('')
  expect(hasFiniteViewBox(preparedMermaid.viewBox)).toBe(true)
  expect(preparedMermaid.preserveAspectRatio).toBe('xMidYMid meet')
  expect(hasInvalidSvgNumber(preparedMermaid.svgMarkup)).toBe(false)

  expect(snapshot.markmap).toHaveLength(1)
  const markmap = snapshot.markmap[0]
  expect(markmap.state).toBe('ready')
  expect(markmap.svgMarkup).not.toBe('')
  expect(markmap.hasRootGroup).toBe(true)
  expect(markmap.fitTransform).not.toBeNull()
  expect(markmap.rootTransform).not.toBeNull()
  expect(hasFiniteViewport(markmap.viewport)).toBe(true)
  expect(hasInvalidSvgNumber(markmap.svgMarkup)).toBe(false)
  expect(hasInvalidSvgNumber(markmap.fitTransform)).toBe(false)
  expect(hasInvalidSvgNumber(markmap.rootTransform)).toBe(false)

  expect(snapshot.image).not.toBeNull()
  expect(snapshot.image?.src).toMatch(/\/logo\.svg$/)
  expect(snapshot.image?.complete).toBe(true)
  expect(snapshot.image?.naturalWidth).toBeGreaterThan(0)

  const outputPath = testInfo.outputPath('file-tree-export.pdf')
  await download.saveAs(outputPath)

  expect(download.suggestedFilename()).toBe('PDF Export Kitchen Sink.pdf')
  expect((await fs.stat(outputPath)).size).toBeGreaterThan(10_000)
  expect(await page.evaluate(() => (
    window as typeof window & { __pdfPrintCalled?: boolean }
  ).__pdfPrintCalled)).toBe(false)
  const shikiEvidence = await page.evaluate(() => (
    window as typeof window & { __pdfShikiCloneEvidence?: PdfShikiCloneEvidence | null }
  ).__pdfShikiCloneEvidence)
  expect(shikiEvidence).not.toBeNull()
  expect(shikiEvidence?.ownerCount).toBe(1)
  expect(shikiEvidence?.copiedHeadOwnerCount).toBe(0)
  expect(shikiEvidence?.globalTheme).toBe('dark')
  expect(shikiEvidence?.tokens.length).toBeGreaterThanOrEqual(2)
  expect(new Set(shikiEvidence?.tokens.map((token) => token.light)).size).toBeGreaterThanOrEqual(2)
  for (const token of shikiEvidence?.tokens.slice(0, 2) ?? []) {
    expect(token.computed).toBe(token.light)
    expect(token.computed).not.toBe(token.dark)
  }
  expect(shikiEvidence?.computedBackground).toBe(shikiEvidence?.lightBackground)
  expect(shikiEvidence?.computedBackground).not.toBe(shikiEvidence?.darkBackground)
  expect(await page.locator('html').getAttribute('data-theme')).toBe(themeBeforeExport)
  await expect(page.locator('.pdf-export-surface')).toHaveCount(0)
})

test('does not download until a delayed same-origin image settles', async ({ page, request }) => {
  const delayedSlug = 'inbox/pdf-export-image-delay-e2e'
  const raw = `---
title: Delayed PDF Image
---

# Delayed PDF Image

![Nuvyn logo](/logo.svg)
`

  await request.delete(`/api/posts/${delayedSlug}`).catch(() => {})
  const created = await request.post('/api/posts', {
    data: { path: delayedSlug, title: 'Delayed PDF Image' },
  })
  expect(created.status()).toBe(201)
  const initial = await (await request.get(`/api/posts/${delayedSlug}`)).json() as { raw: string }
  const updated = await request.put(`/api/posts/${delayedSlug}`, {
    data: { baseRaw: initial.raw, raw },
  })
  expect(updated.ok()).toBe(true)

  let releaseImage!: () => void
  const imageReleased = new Promise<void>((resolve) => { releaseImage = resolve })
  let resolveImageRequest!: () => void
  const imageRequestSeen = new Promise<void>((resolve) => { resolveImageRequest = resolve })
  let downloadStarted = false
  page.on('download', () => { downloadStarted = true })

  await page.route('**/logo.svg', async (route) => {
    resolveImageRequest()
    await imageReleased
    await route.continue()
  })

  try {
    await page.goto('/vault')
    const inbox = page.locator('.tree-row[data-tree-kind="folder"][data-tree-path="inbox"]')
    await inbox.locator('.chevron').click()
    const row = page.locator(`.tree-row[data-tree-kind="file"][data-tree-path="${delayedSlug}"]`)
    await expect(row).toBeVisible()
    await row.click({ button: 'right' })

    const downloadPromise = page.waitForEvent('download')
    await page.locator('.tree-context-menu button').filter({ hasText: /Export PDF|导出 PDF/ }).click()

    await imageRequestSeen
    await expect(page.locator('.pdf-export-surface')).toHaveCount(1)
    const image = page.locator('.pdf-export-surface img[src$="/logo.svg"]')
    await expect(image).toHaveCount(1)
    await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).complete)).toBe(false)
    // html2canvas also waits for images. Assert the PDF download phase has
    // not started, so this test cannot pass without the pre-capture waiter.
    await expect(page.locator('.pdf-download-host')).toHaveCount(0)
    expect(downloadStarted).toBe(false)
    await expect(page.locator('.pdf-export-surface')).toHaveCount(1)

    releaseImage()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toBe('Delayed PDF Image.pdf')
    await expect(page.locator('.pdf-export-surface')).toHaveCount(0)
    await expect(page.locator('.pdf-download-host')).toHaveCount(0)
  } finally {
    releaseImage()
    await page.unroute('**/logo.svg').catch(() => {})
    await request.delete(`/api/posts/${delayedSlug}`).catch(() => {})
  }
})
