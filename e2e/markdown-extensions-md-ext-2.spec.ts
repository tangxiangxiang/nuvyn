import { expect, test } from '@playwright/test'

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

test('MD-EXT-2 uses native summary click interaction for closed details', async ({ page }) => {
  await page.goto('/__markdown-test?mode=reading')

  await page.evaluate(async () => {
    const { render } = await import('/src/lib/markdown.ts')
    const article = document.createElement('article')
    article.className = 'article reading md-ext-2-summary-click-fixture'
    article.style.cssText = 'position:fixed; inset:16px auto auto 16px; z-index:999999; background:white; padding:16px;'
    article.innerHTML = await render([
      '::: details Click to open',
      'Native details body.',
      ':::',
    ].join('\n'))
    document.body.append(article)
  })

  const details = page.locator('.md-ext-2-summary-click-fixture details.markdown-container-details')
  const summary = details.locator('summary')
  await expect(details).toHaveJSProperty('open', false)
  await summary.click()
  await expect(details).toHaveJSProperty('open', true)
  await summary.click()
  await expect(details).toHaveJSProperty('open', false)

  await page.locator('.md-ext-2-summary-click-fixture').evaluate((article) => article.remove())
})
