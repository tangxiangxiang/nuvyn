import { promises as fs } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

const fixture = await fs.readFile(
  new URL('./fixtures/pdf-export-shiki-code.md', import.meta.url),
  'utf8',
)

type Theme = 'light' | 'dark'
type ColorScheme = 'light' | 'dark'

type TokenEvidence = {
  className: string
  light: string
  dark: string
  computed: string
}

type PaletteEvidence = {
  tokens: TokenEvidence[]
  pre: {
    lightBackground: string
    darkBackground: string
    computedBackground: string
  }
  plain: {
    color: string
    background: string
  }
}

type PdfCloneEvidence = PaletteEvidence & {
  ownerCount: number
  copiedHeadOwnerCount: number
  ownerText: string
  articleText: string
  articleStylesheetCount: number
  cloneTheme: string | null
}

type H6ExportEvidence = {
  reader: PaletteEvidence
  clone: PdfCloneEvidence
  liveTheme: string | null
  liveHeadOwnerCount: number
  liveHeadOwnerText: string
}

function assertLightPdfEvidence(
  evidence: H6ExportEvidence,
  expectedReader: Theme,
  expectedLiveTheme: string | null,
): void {
  expect(evidence.liveTheme).toBe(expectedLiveTheme)
  expect(evidence.liveHeadOwnerCount).toBe(1)
  expect(evidence.reader.tokens.length).toBeGreaterThan(0)

  const liveToken = evidence.reader.tokens.find((token) => token.light !== token.dark)
  expect(liveToken).toBeDefined()
  expect(liveToken?.computed).toBe(expectedReader === 'light' ? liveToken?.light : liveToken?.dark)

  expect(evidence.clone.ownerCount).toBe(1)
  expect(evidence.clone.copiedHeadOwnerCount).toBe(0)
  expect(evidence.clone.articleStylesheetCount).toBe(0)
  expect(evidence.clone.ownerText).toContain('.nuvyn-shiki-')
  expect(evidence.clone.ownerText).toContain('--shiki-light')
  expect(evidence.clone.ownerText).toContain('--shiki-dark')
  expect(evidence.clone.ownerText).toContain('var(--shiki-light)')
  expect(evidence.clone.ownerText).not.toContain('NUVYN_H6_USER_SOURCE_SENTINEL')
  expect(evidence.clone.articleText).toContain('NUVYN_H6_USER_SOURCE_SENTINEL')

  const cloneTokens = evidence.clone.tokens.filter((token) => token.light !== token.dark)
  expect(cloneTokens.length).toBeGreaterThanOrEqual(2)
  expect(new Set(cloneTokens.map((token) => token.light)).size).toBeGreaterThanOrEqual(2)
  for (const token of cloneTokens.slice(0, 2)) {
    expect(token.computed).toBe(token.light)
    expect(token.computed).not.toBe(token.dark)
  }

  expect(evidence.clone.pre.computedBackground).toBe(evidence.clone.pre.lightBackground)
  expect(evidence.clone.pre.computedBackground).not.toBe(evidence.clone.pre.darkBackground)
  expect(evidence.clone.plain.color).not.toBe('')
  expect(evidence.clone.plain.color).not.toBe('rgba(0, 0, 0, 0)')
  expect(evidence.clone.plain.background).not.toBe('')
  expect(evidence.clone.plain.background).not.toBe('rgba(0, 0, 0, 0)')
}

async function exportFixture(
  page: Page,
  options: { theme: Theme | null; colorScheme: ColorScheme },
): Promise<H6ExportEvidence> {
  await page.emulateMedia({ colorScheme: options.colorScheme })
  const downloadPromise = page.waitForEvent('download')
  const evidencePromise = page.evaluate(async ({ markdown, theme }) => {
    const win = window as Window & { __nuvynH6PdfEvidence?: H6ExportEvidence }
    const { useTheme } = await import('/src/composables/useTheme.ts')
    if (theme) {
      useTheme().set(theme)
    } else {
      localStorage.removeItem('nuvyn.theme')
      document.documentElement.removeAttribute('data-theme')
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    const { render } = await import('/src/lib/markdown.ts')
    const pdf = await import('/src/lib/pdfExport.ts')
    document.querySelector('[data-h6-pdf-fixture]')?.remove()

    const article = document.createElement('article')
    article.className = 'article reading'
    article.dataset.h6PdfFixture = 'true'
    article.innerHTML = await render(markdown)
    document.body.append(article)

    const readPalette = (ownerDocument: Document, root: ParentNode): PaletteEvidence => {
      const view = ownerDocument.defaultView ?? window
      const normalize = (property: 'color' | 'backgroundColor', value: string): string => {
        const probe = ownerDocument.createElement('span')
        probe.style[property] = value.trim()
        ;(root as HTMLElement).append(probe)
        const normalized = view.getComputedStyle(probe)[property]
        probe.remove()
        return normalized
      }

      const pre = root.querySelector<HTMLElement>('pre.shiki:not(.nuvyn-shiki-plain)')
      const plain = root.querySelector<HTMLElement>('pre.nuvyn-shiki-plain')
      if (!pre || !plain) throw new Error('H6 PDF fixture did not produce Shiki and plain fences')

      const tokens = Array.from(pre.querySelectorAll<HTMLElement>('span'))
        .filter((element) => Array.from(element.classList).some((name) => name.startsWith('nuvyn-shiki-')))
        .map((token) => {
          const style = view.getComputedStyle(token)
          return {
            className: token.className,
            light: normalize('color', style.getPropertyValue('--shiki-light')),
            dark: normalize('color', style.getPropertyValue('--shiki-dark')),
            computed: style.color,
          }
        })

      const preStyle = view.getComputedStyle(pre)
      return {
        tokens,
        pre: {
          lightBackground: normalize('backgroundColor', preStyle.getPropertyValue('--shiki-light-bg')),
          darkBackground: normalize('backgroundColor', preStyle.getPropertyValue('--shiki-dark-bg')),
          computedBackground: preStyle.backgroundColor,
        },
        plain: {
          color: view.getComputedStyle(plain).color,
          background: view.getComputedStyle(plain).backgroundColor,
        },
      }
    }

    const reader = readPalette(document, article)
    const liveOwner = document.head.querySelector<HTMLStyleElement>('style#nuvyn-shiki-generated-styles')
    if (!liveOwner) throw new Error('H6 PDF fixture did not produce the Shiki head owner')

    pdf.__testing__.setPdfCloneObserver((clonedDocument, clonedRoot) => {
      const cloneArticle = clonedRoot.querySelector<HTMLElement>('.article')
      const owner = clonedRoot.querySelector<HTMLStyleElement>('style#nuvyn-pdf-download-styles')
      if (!cloneArticle || !owner) throw new Error('H6 PDF clone is missing trusted stylesheet/article')
      const clone = readPalette(clonedDocument, cloneArticle)
      win.__nuvynH6PdfEvidence = {
        reader,
        clone: {
          ...clone,
          ownerCount: clonedRoot.querySelectorAll('style#nuvyn-pdf-download-styles').length,
          copiedHeadOwnerCount: clonedRoot.querySelectorAll('style#nuvyn-shiki-generated-styles').length,
          ownerText: owner.textContent ?? '',
          articleText: cloneArticle.textContent ?? '',
          articleStylesheetCount: cloneArticle.querySelectorAll('style#nuvyn-pdf-download-styles').length,
          cloneTheme: clonedDocument.documentElement.getAttribute('data-theme'),
        },
        liveTheme: document.documentElement.getAttribute('data-theme'),
        liveHeadOwnerCount: document.head.querySelectorAll('style#nuvyn-shiki-generated-styles').length,
        liveHeadOwnerText: liveOwner.textContent ?? '',
      }
    })

    const liveThemeBefore = document.documentElement.getAttribute('data-theme')
    try {
      await pdf.downloadPdfDocument({
        title: 'Shiki PDF Compatibility',
        articleHtml: pdf.preparePdfArticleHtml(article),
      })
      const evidence = win.__nuvynH6PdfEvidence
      if (!evidence) throw new Error('html2canvas clone observer did not run')
      if (document.documentElement.getAttribute('data-theme') !== liveThemeBefore) {
        throw new Error('PDF export changed the live document theme')
      }
      if (liveOwner.textContent !== document.head.querySelector<HTMLStyleElement>('style#nuvyn-shiki-generated-styles')?.textContent) {
        throw new Error('PDF export changed the live Shiki stylesheet')
      }
      return evidence
    } finally {
      pdf.__testing__.setPdfCloneObserver(null)
      article.remove()
    }
  }, { markdown: fixture, theme: options.theme })

  const [download, evidence] = await Promise.all([downloadPromise, evidencePromise])
  expect(download.suggestedFilename()).toBe('Shiki PDF Compatibility.pdf')
  await download.delete()
  return evidence
}

test('PDF clone forces printable-light Shiki tokens across the theme matrix', async ({ page }) => {
  await page.goto('/__markdown-test?mode=reading')

  const cases: Array<{
    label: string
    theme: Theme | null
    colorScheme: ColorScheme
    expectedReader: Theme
  }> = [
    { label: 'explicit light + OS light', theme: 'light', colorScheme: 'light', expectedReader: 'light' },
    { label: 'explicit light + OS dark', theme: 'light', colorScheme: 'dark', expectedReader: 'light' },
    { label: 'explicit dark + OS light', theme: 'dark', colorScheme: 'light', expectedReader: 'dark' },
    { label: 'explicit dark + OS dark', theme: 'dark', colorScheme: 'dark', expectedReader: 'dark' },
    { label: 'no attribute + OS dark', theme: null, colorScheme: 'dark', expectedReader: 'dark' },
  ]

  for (const testCase of cases) {
    const evidence = await exportFixture(page, testCase)
    assertLightPdfEvidence(evidence, testCase.expectedReader, testCase.theme)
    expect(evidence.clone.cloneTheme, testCase.label).toBe(evidence.liveTheme)
  }
})
