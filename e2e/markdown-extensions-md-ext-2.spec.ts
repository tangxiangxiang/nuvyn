import { expect, test } from '@playwright/test'

test('MD-EXT-2 displays only explicit aliases without empty title space in Reader and PDF', async ({ page }) => {
  await page.goto('/__markdown-test?mode=reading')

  const result = await page.evaluate(async () => {
    const { render } = await import('/src/lib/markdown.ts')
    const { __testing__, buildPdfDownloadDocument, preparePdfArticleHtml } = await import('/src/lib/pdfExport.ts')
    const types = ['info', 'tip', 'warning', 'danger', 'details']
    const article = document.createElement('article')
    article.className = 'article reading'
    article.innerHTML = await render(types.flatMap((type) => [
      `::: ${type}`, `${type} without an alias.`, ':::', '',
      `::: ${type} 自定义 **${type}**`, `${type} with an alias.`, ':::', '',
    ]).join('\n'))
    document.body.append(article)
    const source = article.outerHTML
    const exported = document.createElement('div')
    exported.innerHTML = `<style>${__testing__.PDF_DOWNLOAD_STYLES}</style>${buildPdfDownloadDocument(preparePdfArticleHtml(article))}`
    document.body.append(exported)
    try {
      const readCards = (root: HTMLElement) => types.map((type) => {
        const cards = root.querySelectorAll<HTMLElement>(`.markdown-container-${type}`)
        const unnamed = cards[0]!
        const named = cards[1]!
        const paragraph = unnamed.querySelector<HTMLElement>('p')!
        const title = named.querySelector<HTMLElement>('.markdown-container-title')!
        const styles = getComputedStyle(unnamed)
        return {
          type,
          unnamedTag: unnamed.tagName,
          unnamedTitle: unnamed.querySelector('.markdown-container-title, summary') !== null,
          unnamedBody: paragraph.textContent,
          unnamedBodyHeight: paragraph.getBoundingClientRect().height,
          topSpace: paragraph.getBoundingClientRect().top - unnamed.getBoundingClientRect().top,
          paddingTop: parseFloat(styles.paddingTop),
          marginTop: getComputedStyle(paragraph).marginTop,
          marginBottom: getComputedStyle(paragraph).marginBottom,
          namedTitle: named.querySelector('.markdown-container-title')?.textContent,
          namedTitleBorder: getComputedStyle(title).borderBottomWidth,
          namedTitlePadding: getComputedStyle(title).paddingBottom,
          namedOpen: named instanceof HTMLDetailsElement ? named.open : null,
        }
      })
      return { reader: readCards(article), pdf: readCards(exported), readerUnchanged: article.outerHTML === source }
    } finally {
      exported.remove()
      article.remove()
    }
  })

  expect(result.readerUnchanged).toBe(true)
  for (const surface of [result.reader, result.pdf]) {
    expect(surface).toHaveLength(5)
    for (const card of surface) {
      expect(card.unnamedTag).toBe('DIV')
      expect(card.unnamedTitle).toBe(false)
      expect(card.unnamedBody).toBe(`${card.type} without an alias.`)
      expect(card.unnamedBodyHeight).toBeGreaterThan(0)
      expect(card.topSpace).toBeCloseTo(card.paddingTop, 1)
      expect(card.marginTop).toBe('0px')
      expect(card.marginBottom).toBe('0px')
      expect(card.namedTitle).toBe(`自定义 ${card.type}`)
      const expandedDetails = surface === result.pdf && card.type === 'details'
      expect(card.namedTitleBorder).toBe(expandedDetails ? '1px' : '0px')
      expect(card.namedTitlePadding).toBe(expandedDetails ? '8px' : '0px')
    }
  }
  expect(result.reader.find((card) => card.type === 'details')?.namedOpen).toBe(false)
  expect(result.pdf.find((card) => card.type === 'details')?.namedOpen).toBe(true)
})

test('MD-EXT-2 renders fixed containers, nested bodies, and existing Markdown features', async ({ page }) => {
  await page.goto('/__markdown-test?mode=reading')

  const result = await page.evaluate(async () => {
    const { render } = await import('/src/lib/markdown.ts')
    const article = document.createElement('article')
    article.className = 'article reading md-ext-2-browser-fixture'
    article.innerHTML = await render([
      '## Container heading {#container-heading}',
      '',
      '::::: info Information',
      'Body with [external](https://example.com) and ![image](image.png).',
      '',
      ':::: warning Outer',
      '::: details Inner',
      'Hidden inner body.',
      ':::',
      '::::',
      '',
      '> [!NOTE]',
      '> Existing callout.',
      ':::::',
      '',
      '::: tip **Tip**',
      'Tip body.',
      ':::',
      '',
      '::: warning',
      'Warning body.',
      ':::',
      '',
      '::: danger STOP',
      '',
      '<div>',
      '::::',
      '</div>',
      '',
      'After raw HTML.',
      ':::',
      '',
      '::: info Paragraph context',
      'Before',
      '<span>inline</span>',
      ':::',
      'After paragraph context.',
      '',
      '::: details Closed',
      'Closed body.',
      ':::',
      '',
      '::: details Open {open}',
      'Open body.',
      ':::',
    ].join('\n'))
    document.body.append(article)

    const closed = article.querySelector<HTMLDetailsElement>('.markdown-container-details:not([open])')
    const opened = article.querySelector<HTMLDetailsElement>('.markdown-container-details[open]')
    const external = article.querySelector<HTMLAnchorElement>('a[href="https://example.com"]')
    const paragraphContextContainer = Array.from(article.querySelectorAll('.markdown-container'))
      .find((container) => container.querySelector('span')?.textContent === 'inline'
        && container.querySelector('.markdown-container') === null)
    const paragraphContextAfter = Array.from(article.querySelectorAll('p'))
      .find((paragraph) => paragraph.textContent?.includes('After paragraph context.'))
    const result = {
      types: ['info', 'tip', 'warning', 'danger', 'details']
        .map((type) => article.querySelector(`.markdown-container-${type}`) !== null),
      nested: article.querySelector('.markdown-container-warning .markdown-container-details') !== null,
      callout: article.querySelector('.markdown-container-info .callout-note') !== null,
      heading: article.querySelector('h2#container-heading') !== null,
      closed: closed?.open === false,
      opened: opened?.open === true,
      rawHtmlTail: article.querySelector('.markdown-container-danger')?.textContent?.includes('After raw HTML.') ?? false,
      paragraphContextSpan: paragraphContextContainer?.querySelector('span')?.textContent ?? null,
      paragraphContextAfterOutside: paragraphContextAfter
        ? !paragraphContextContainer?.contains(paragraphContextAfter)
        : false,
      external: external ? { target: external.target, rel: external.rel } : null,
      imageLoading: article.querySelector('img')?.getAttribute('loading') ?? null,
      genericAttrs: article.querySelectorAll('[style], [onclick], [onerror], [id="foo"]').length,
    }
    article.remove()
    return result
  })

  expect(result.types).toEqual([true, true, true, true, true])
  expect(result.nested).toBe(true)
  expect(result.callout).toBe(true)
  expect(result.heading).toBe(true)
  expect(result.closed).toBe(true)
  expect(result.opened).toBe(true)
  expect(result.rawHtmlTail).toBe(true)
  expect(result.paragraphContextSpan).toBe('inline')
  expect(result.paragraphContextAfterOutside).toBe(true)
  expect(result.external).toEqual({ target: '_blank', rel: 'noopener noreferrer' })
  expect(result.imageLoading).toBe('lazy')
  expect(result.genericAttrs).toBe(0)
})

test('MD-EXT-2 expands generated details only in the PDF clone', async ({ page }) => {
  await page.goto('/__markdown-test?mode=reading')

  const result = await page.evaluate(async () => {
    const { render } = await import('/src/lib/markdown.ts')
    const { preparePdfArticleHtml } = await import('/src/lib/pdfExport.ts')
    const article = document.createElement('article')
    article.className = 'article reading'
    article.innerHTML = await render([
      '::: details Exported details',
      'PDF-only visible body.',
      ':::',
    ].join('\n'))
    document.body.append(article)
    const live = article.querySelector<HTMLDetailsElement>('.markdown-container-details')!
    live.open = false
    const prepared = document.createElement('div')
    prepared.innerHTML = preparePdfArticleHtml(article)
    const clone = prepared.querySelector<HTMLDetailsElement>('.markdown-container-details')
    const result = {
      liveOpenAfterPrepare: live.open,
      cloneOpen: clone?.open ?? false,
      cloneBody: clone?.textContent?.includes('PDF-only visible body.') ?? false,
    }
    article.remove()
    return result
  })

  expect(result).toEqual({
    liveOpenAfterPrepare: false,
    cloneOpen: true,
    cloneBody: true,
  })
})

for (const theme of ['light', 'dark'] as const) {
  test(`MD-EXT-2 ${theme} details shows an inset divider only while expanded`, async ({ page }, testInfo) => {
    await page.addInitScript((value) => localStorage.setItem('nuvyn.theme', value), theme)
    await page.goto('/__markdown-test?mode=reading')

    await page.evaluate(async () => {
      const { render } = await import('/src/lib/markdown.ts')
      const article = document.createElement('article')
      article.className = 'article reading md-ext-2-summary-click-fixture'
      article.style.cssText = 'position:fixed; inset:16px auto auto 16px; z-index:999999; width:480px; background:var(--vs-bg-1,var(--bg)); padding:16px;'
      article.innerHTML = await render([
        '::: details Click to open',
        'Native details body.',
        ':::',
        '',
        '::: details',
        'Untitled body.',
        ':::',
        '',
        '::: info Ordinary title',
        'Ordinary container body.',
        ':::',
      ].join('\n'))
      document.body.append(article)
    })

    const details = page.locator('.md-ext-2-summary-click-fixture details.markdown-container-details')
    const summary = details.locator('summary')
    await expect(details).toHaveJSProperty('open', false)
    await expect(summary).toHaveCSS('border-bottom-width', '0px')
    await expect(summary).toHaveCSS('padding-bottom', '0px')
    await expect(summary).toHaveCSS('margin-bottom', '0px')
    await summary.click()
    await expect(details).toHaveJSProperty('open', true)
    await expect(summary).toHaveCSS('border-bottom-width', '1px')
    await expect(summary).toHaveCSS('border-bottom-style', 'solid')
    await expect(summary).toHaveCSS('border-bottom-color', 'rgba(127, 127, 127, 0.16)')
    await expect(summary).toHaveCSS('padding-bottom', '8px')
    await expect(summary).toHaveCSS('margin-bottom', '8px')
    await expect(details.locator('p')).toBeVisible()
    const geometry = await details.evaluate((node) => {
      const title = node.querySelector('summary')!
      const body = node.querySelector('p')!
      const card = node.getBoundingClientRect()
      const heading = title.getBoundingClientRect()
      return {
        leftInset: heading.left - card.left,
        rightInset: card.right - heading.right,
        bodyGap: body.getBoundingClientRect().top - heading.bottom,
      }
    })
    expect(geometry.leftInset).toBeCloseTo(16, 1)
    expect(geometry.rightInset).toBeCloseTo(16, 1)
    expect(geometry.bodyGap).toBeCloseTo(8, 1)
    await details.screenshot({ path: testInfo.outputPath(`details-${theme}-expanded.png`) })

    const fixture = page.locator('.md-ext-2-summary-click-fixture')
    await expect(fixture.locator('div.markdown-container-details summary')).toHaveCount(0)
    await expect(fixture.locator('div.markdown-container-details p')).toHaveCSS('border-bottom-width', '0px')
    await expect(fixture.locator('.markdown-container-info .markdown-container-title')).toHaveCSS('border-bottom-width', '0px')
    await summary.click()
    await expect(details).toHaveJSProperty('open', false)
    await expect(summary).toHaveCSS('border-bottom-width', '0px')
    await expect(summary).toHaveCSS('padding-bottom', '0px')
    await expect(summary).toHaveCSS('margin-bottom', '0px')
    await summary.press('Enter')
    await expect(details).toHaveJSProperty('open', true)
    await expect(summary).toHaveCSS('border-bottom-width', '1px')
    await summary.press('Enter')
    await expect(details).toHaveJSProperty('open', false)

    await page.locator('.md-ext-2-summary-click-fixture').evaluate((article) => article.remove())
  })
}
