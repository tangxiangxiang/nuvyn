import { expect, test } from '@playwright/test'

const mode = 'reading'
const alertTypes = ['note', 'tip', 'important', 'warning', 'caution'] as const
const containerTypes = ['info', 'tip', 'warning', 'danger', 'details'] as const
const noticePair: Record<(typeof containerTypes)[number], (typeof alertTypes)[number]> = {
  info: 'note',
  tip: 'tip',
  warning: 'warning',
  danger: 'caution',
  details: 'note',
}
const noticeBackgrounds = {
  light: {
    note: 'rgb(241, 242, 244)',
    tip: 'rgb(238, 240, 255)',
    important: 'rgb(243, 237, 255)',
    warning: 'rgb(255, 247, 227)',
    caution: 'rgb(255, 233, 236)',
  },
  dark: {
    note: 'rgb(36, 38, 43)',
    tip: 'rgb(34, 38, 58)',
    important: 'rgb(41, 35, 56)',
    warning: 'rgb(48, 41, 29)',
    caution: 'rgb(53, 34, 38)',
  },
} as const
const alertBorders = {
  note: 'rgb(141, 157, 170)',
  tip: 'rgb(124, 141, 204)',
  important: 'rgb(155, 131, 196)',
  warning: 'rgb(195, 160, 90)',
  caution: 'rgb(197, 131, 144)',
} as const
const alertBodies = [
  '强调用户在快速浏览文档时也不应忽略的重要信息。',
  '有助于用户更顺利达成目标的建议性信息。',
  '对用户达成目标至关重要的信息。',
  '因为可能存在风险，所以需要用户立即关注的关键内容。',
  '行为可能带来的负面影响。',
]

for (const theme of ['light', 'dark'] as const) {
  test(`${mode} ${theme} Markdown visual regression`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('nuvyn.theme', value), theme)
    await page.goto(`/__markdown-test?mode=${mode}`)
    const article = page.locator(`.article.${mode}`)
    await expect(article).toBeVisible()
    await expect(article).toContainText('Emoji: 😄 🚀 👍')
    await expect(article).toContainText('完成 🚀')
    await expect(article).toContainText('Unknown :not_an_emoji:')
    await expect(article.locator('code').filter({ hasText: ':smile:' }).first()).toBeVisible()
    await expect(article.locator('a').filter({ hasText: '😄' }).first()).toHaveAttribute('href', 'https://example.com')
    await expect(article.locator('table')).toBeVisible()
    await expect(article.locator('.wiki-link-missing')).toBeVisible()
    await expect(article.locator('.callout-note')).toBeVisible()
    await expect(article.locator('.callout-tip')).toBeVisible()
    await expect(article.locator('.callout-important')).toBeVisible()
    await expect(article.locator('.callout-warning')).toBeVisible()
    await expect(article.locator('.callout-caution')).toBeVisible()
    for (const type of containerTypes) {
      await expect(article.locator(`.markdown-container-${type}`)).toBeVisible()
    }

    const alerts = await article.evaluate((root, { types, palette }) => types.map((type) => {
      const callout = root.querySelector<HTMLElement>(`.callout-${type}`)
      const content = callout?.querySelector<HTMLElement>('.callout-content')
      const calloutStyle = callout ? getComputedStyle(callout) : null
      const contentStyle = content ? getComputedStyle(content) : null
      const probe = document.createElement('div')
      probe.style.backgroundColor = `color-mix(in srgb, ${palette[type]} 60%, transparent)`
      root.append(probe)
      const expectedBackground = getComputedStyle(probe).backgroundColor
      probe.remove()
      return {
        type,
        hasTitle: callout?.querySelector('.callout-title, .callout-title-text') !== null,
        body: content?.textContent?.trim() ?? '',
        foreground: contentStyle?.color ?? '',
        borderLeftWidth: calloutStyle?.borderLeftWidth ?? '',
        borderLeftColor: calloutStyle?.borderLeftColor ?? '',
        borderLeftStyle: calloutStyle?.borderLeftStyle ?? '',
        borderTopWidth: calloutStyle?.borderTopWidth ?? '',
        borderRightWidth: calloutStyle?.borderRightWidth ?? '',
        borderBottomWidth: calloutStyle?.borderBottomWidth ?? '',
        background: calloutStyle?.backgroundColor ?? '',
        expectedBackground,
        radius: calloutStyle?.borderRadius ?? '',
        shadow: calloutStyle?.boxShadow ?? '',
        paddingTop: calloutStyle?.paddingTop ?? '',
        paddingLeft: calloutStyle?.paddingLeft ?? '',
        fontSize: contentStyle?.fontSize ?? '',
        fontWeight: contentStyle?.fontWeight ?? '',
        lineHeight: contentStyle?.lineHeight ?? '',
        topSpace: callout && content ? content.getBoundingClientRect().top - callout.getBoundingClientRect().top : null,
        leftSpace: callout && content ? content.getBoundingClientRect().left - callout.getBoundingClientRect().left : null,
        bodyHeight: content?.getBoundingClientRect().height ?? 0,
        cardHeight: callout?.getBoundingClientRect().height ?? 0,
        hasIcon: callout?.querySelector('.callout-icon') !== null,
      }
    }), { types: alertTypes, palette: noticeBackgrounds[theme] })

    const containers = await article.evaluate((root, values) => values.map((type) => {
      const container = root.querySelector<HTMLElement>(`.markdown-container-${type}`)
      const title = container?.querySelector<HTMLElement>('.markdown-container-title')
      const containerStyle = container ? getComputedStyle(container) : null
      return {
        type,
        title: title?.textContent ?? '',
        background: containerStyle?.backgroundColor ?? '',
        borderLeftWidth: containerStyle?.borderLeftWidth ?? '',
        borderTopWidth: containerStyle?.borderTopWidth ?? '',
        radius: containerStyle?.borderRadius ?? '',
        shadow: containerStyle?.boxShadow ?? '',
        paddingTop: containerStyle?.paddingTop ?? '',
        paddingLeft: containerStyle?.paddingLeft ?? '',
        fontSize: title ? getComputedStyle(title).fontSize : '',
        fontWeight: title ? getComputedStyle(title).fontWeight : '',
        lineHeight: title ? getComputedStyle(title).lineHeight : '',
        open: container instanceof HTMLDetailsElement ? container.open : null,
      }
    }), containerTypes)

    expect(alerts).toHaveLength(5)
    alerts.forEach((alert, index) => {
      expect(alert.hasTitle).toBe(false)
      expect(alert.body).toBe(alertBodies[index])
      expect(alert.foreground).toBe(theme === 'light' ? 'rgb(31, 31, 31)' : 'rgb(212, 212, 212)')
      expect(alert.background).toBe(alert.expectedBackground)
      expect(alert.borderLeftWidth).toBe('2px')
      expect(alert.borderLeftColor).toBe(alertBorders[alert.type])
      expect(alert.borderLeftStyle).toBe('solid')
      expect(alert.borderTopWidth).toBe('0px')
      expect(alert.borderRightWidth).toBe('0px')
      expect(alert.borderBottomWidth).toBe('0px')
      expect(alert.radius).toBe('12px')
      expect(alert.shadow).toBe('none')
      expect(Number.parseFloat(alert.paddingTop)).toBeCloseTo(10.4, 1)
      expect(alert.paddingLeft).toBe('16px')
      expect(alert.fontSize).toBe('14px')
      expect(alert.fontWeight).toBe('400')
      expect(Number.parseFloat(alert.lineHeight)).toBeCloseTo(21, 1)
      expect(alert.topSpace).toBeCloseTo(10.4, 1)
      expect(alert.leftSpace).toBeCloseTo(18, 1)
      expect(alert.bodyHeight).toBeGreaterThan(0)
      expect(alert.cardHeight).toBeCloseTo(alert.bodyHeight + 20.8, 1)
      expect(alert.hasIcon).toBe(false)
    })

    expect(containers.map((container) => container.title)).toEqual(['信息', '提示', '警告', '危险', '查看详情'])
    containers.forEach((container) => {
      const alert = alerts.find((candidate) => candidate.type === noticePair[container.type])
      expect(alert).toBeDefined()
      expect(container.background).toBe(noticeBackgrounds[theme][noticePair[container.type]])
      expect(container.borderLeftWidth).toBe('0px')
      expect(container.borderTopWidth).toBe('0px')
      expect(container.radius).toBe(alert?.radius)
      expect(container.shadow).toBe('none')
      expect(container.paddingTop).toBe('12px')
      expect(container.paddingLeft).toBe(alert?.paddingLeft)
      expect(container.fontSize).toBe(alert?.fontSize)
      expect(container.fontWeight).toBe('700')
      expect(Number.parseFloat(container.lineHeight)).toBeCloseTo(19.6, 1)
    })
    const quote = article.locator(':scope > blockquote').first()
    await expect(quote).toHaveCSS('border-left-width', '2px')
    await expect(quote).toHaveCSS('border-left-color', 'rgb(141, 157, 170)')
    await expect(quote).toHaveCSS('background-color', alerts[0]!.background)
    await expect(quote).toHaveCSS('padding-left', '16px')
    await expect(quote).toHaveCSS('font-size', '14px')
    await expect(quote).toHaveCSS('line-height', '21px')
    expect((await quote.boundingBox())?.height).toBeCloseTo(alerts[0]!.cardHeight, 1)
    const codeSurface = await article.evaluate((root) => {
      const pre = Array.from(root.querySelectorAll<HTMLElement>('pre.shiki'))
        .find((candidate) => candidate.textContent?.includes('metaFirst'))
      const highlighted = pre?.querySelector<HTMLElement>('.line.highlighted')
      if (!pre || !highlighted) return null
      const preStyle = getComputedStyle(pre)
      const lineStyle = getComputedStyle(highlighted)
      return {
        language: pre.getAttribute('data-language'),
        borderTopWidth: preStyle.borderTopWidth,
        borderRadius: preStyle.borderRadius,
        labelTop: getComputedStyle(pre.querySelector('.nuvyn-code-copy')!).top,
        labelTransform: getComputedStyle(pre.querySelector('.nuvyn-code-copy')!).transform,
        background: preStyle.backgroundColor,
        marginTop: preStyle.marginTop,
        marginBottom: preStyle.marginBottom,
        lineBackground: lineStyle.backgroundColor,
        lineShadow: lineStyle.boxShadow,
      }
    })
    expect(codeSurface).not.toBeNull()
    expect(codeSurface?.language).toBe('typescript')
    expect(codeSurface?.borderTopWidth).toBe('0px')
    expect(codeSurface?.borderRadius).toBe('12px')
    expect(codeSurface?.labelTop).toBe('12px')
    expect(codeSurface?.labelTransform).toBe('none')
    expect(codeSurface?.marginTop).toBe('16px')
    expect(codeSurface?.marginBottom).toBe('16px')
    expect(codeSurface?.background).not.toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/u)
    expect(codeSurface?.lineBackground).not.toBe(codeSurface?.background)
    expect(codeSurface?.lineShadow).toBe('none')
    const singleLineCode = await page.evaluate(async () => {
      const { render } = await import('/src/lib/markdown.ts')
      const host = document.createElement('article')
      host.className = 'article reading'
      const fence = String.fromCharCode(96, 96, 96)
      host.innerHTML = await render([fence + 'java', 'System.out.println("Hello, world");', fence].join('\n'))
      const mountRoot = document.querySelector('.vault') ?? document.body
      mountRoot.append(host)
      const pre = host.querySelector<HTMLElement>('pre.shiki')
      const code = pre?.querySelector<HTMLElement>('code')
      const line = pre?.querySelector<HTMLElement>('.line')
      const preStyle = pre ? getComputedStyle(pre) : null
      const lineStyle = line ? getComputedStyle(line) : null
      const result = pre && code && line && preStyle && lineStyle
        ? {
            preHeight: pre.getBoundingClientRect().height,
            labelTop: getComputedStyle(pre, '::after').top,
            labelHeight: getComputedStyle(pre, '::after').lineHeight,
            labelTransform: getComputedStyle(pre, '::after').transform,
            lineHeight: line.getBoundingClientRect().height,
            codeHeight: code.getBoundingClientRect().height,
            paddingTop: preStyle.paddingTop,
            paddingBottom: preStyle.paddingBottom,
            marginTop: preStyle.marginTop,
            marginBottom: preStyle.marginBottom,
          }
        : null
      host.remove()
      return result
    })
    expect(singleLineCode).not.toBeNull()
    expect(Number.parseFloat(singleLineCode!.labelTop)).toBeCloseTo(singleLineCode!.preHeight / 2, 1)
    expect(singleLineCode?.labelTransform).toBe(`matrix(1, 0, 0, 1, 0, ${-Number.parseFloat(singleLineCode!.labelHeight) / 2})`)
    expect(singleLineCode?.paddingTop).toBe('16px')
    expect(singleLineCode?.paddingBottom).toBe('16px')
    expect(singleLineCode?.marginTop).toBe('16px')
    expect(singleLineCode?.marginBottom).toBe('16px')
    expect(singleLineCode?.preHeight).toBeCloseTo((singleLineCode?.lineHeight ?? 0) + 32, 1)
    expect(singleLineCode?.codeHeight).toBeCloseTo(singleLineCode?.lineHeight ?? 0, 1)
    expect(containers.find((container) => container.type === 'details')?.open).toBe(false)
    const detailsSpacing = await article.evaluate((root) => {
      const details = root.querySelector<HTMLDetailsElement>('.markdown-container-details')
      const summary = details?.querySelector<HTMLElement>('summary.markdown-container-title')
      if (!details || !summary) return null
      const readStyle = () => {
        const style = getComputedStyle(summary)
        return { margin: style.marginBottom, padding: style.paddingBottom, border: style.borderBottomWidth }
      }
      const closed = readStyle()
      details.open = true
      const open = readStyle()
      details.open = false
      return { closed, open }
    })
    expect(detailsSpacing).not.toBeNull()
    expect(detailsSpacing?.closed).toEqual({ margin: '0px', padding: '0px', border: '0px' })
    expect(detailsSpacing?.open).toEqual({ margin: '8px', padding: '8px', border: '1px' })

    await expect(article.locator('.math-inline .katex')).toBeVisible()
    await expect(article.locator('.math-block .katex-display')).toBeVisible()
    await expect(article.locator('.mermaid-svg > svg')).toBeVisible()
    await expect(article.locator('svg.markmap-svg')).toBeVisible()
    const markmap = article.locator('.markmap-widget-host')
    await expect(markmap).toBeVisible()
    /* The page also contains ordinary Markdown math. Scope this assertion
       to the Markmap host so it proves browser KaTeX autoload → retransform
       → setData, rather than accidentally matching the article's math. */
    await expect(markmap.locator('.katex').first()).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await expect(page).toHaveScreenshot(`markdown-${mode}-${theme}.png`, {
      fullPage: true,
      animations: 'disabled',
      mask: [article.locator('.mermaid-widget-host'), article.locator('.markmap-widget-host')],
      maxDiffPixelRatio: 0.01,
    })
  })
}

test('reading code language labels copy only code with mouse and keyboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/__markdown-test?mode=reading')
  const article = page.locator('.article.reading')
  const blocks = [
    article.locator('pre.shiki.nuvyn-code-single-line[data-language]').first(),
    article.locator('pre.shiki').filter({ hasText: 'metaFirst' }).first(),
    article.locator('pre.shiki.nuvyn-line-numbers[data-language]').first(),
  ]
  for (const [index, block] of blocks.entries()) {
    const button = block.locator(':scope > button.nuvyn-code-copy')
    await expect(button).toBeVisible()
    const expected = await block.locator(':scope > code').evaluate((code) => {
      const clone = code.cloneNode(true) as HTMLElement
      clone.querySelectorAll('.nuvyn-line-number').forEach((number) => number.remove())
      return clone.textContent ?? ''
    })
    await page.evaluate(() => navigator.clipboard.writeText('sentinel'))
    if (index === 0) {
      const position = await button.evaluate((label) => {
        const pre = label.parentElement!.getBoundingClientRect()
        const rect = label.getBoundingClientRect()
        return { label: rect.y + rect.height / 2, pre: pre.y + pre.height / 2 }
      })
      expect(position.label).toBeCloseTo(position.pre, 1)
      await button.click()
    } else {
      await button.focus()
      await button.press(index === 1 ? 'Enter' : 'Space')
    }
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expected)
  }
})

test('reading forced Alert theme overrides the operating-system color scheme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.addInitScript(() => localStorage.setItem('nuvyn.theme', 'light'))
  await page.goto('/__markdown-test?mode=reading')
  const noteContent = page.locator('.article.reading .callout-note .callout-content')
  const infoCard = page.locator('.article.reading .markdown-container-info')
  await expect(noteContent).toBeVisible()
  await expect(noteContent).toHaveCSS('color', 'rgb(31, 31, 31)')
  await expect(noteContent.locator('..')).toHaveCSS('background-color', await page.locator('.article.reading > blockquote').first()
    .evaluate((node) => getComputedStyle(node).backgroundColor))
  await expect(noteContent.locator('..')).toHaveCSS('border-left-color', 'rgb(141, 157, 170)')
  await expect(page.locator('.article.reading .callout-title')).toHaveCount(0)
  await expect(infoCard).toHaveCSS('background-color', 'rgb(241, 242, 244)')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

  const forcedDarkPage = await page.context().newPage()
  try {
    await forcedDarkPage.emulateMedia({ colorScheme: 'light' })
    await forcedDarkPage.addInitScript(() => localStorage.setItem('nuvyn.theme', 'dark'))
    await forcedDarkPage.goto('/__markdown-test?mode=reading')
    const darkNoteContent = forcedDarkPage.locator('.article.reading .callout-note .callout-content')
    const darkInfoCard = forcedDarkPage.locator('.article.reading .markdown-container-info')
    await expect(darkNoteContent).toBeVisible()
    await expect(darkNoteContent).toHaveCSS('color', 'rgb(212, 212, 212)')
    await expect(darkNoteContent.locator('..')).toHaveCSS('background-color', await forcedDarkPage.locator('.article.reading > blockquote').first()
      .evaluate((node) => getComputedStyle(node).backgroundColor))
    await expect(darkNoteContent.locator('..')).toHaveCSS('border-left-color', 'rgb(141, 157, 170)')
    await expect(forcedDarkPage.locator('.article.reading .callout-title')).toHaveCount(0)
    await expect(darkInfoCard).toHaveCSS('background-color', 'rgb(36, 38, 43)')
    await expect(forcedDarkPage.locator('html')).toHaveAttribute('data-theme', 'dark')
  } finally {
    await forcedDarkPage.close()
  }
})

test('reading narrow Alerts retain quote borders without overflowing the content width', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto('/__markdown-test?mode=reading')
  const article = page.locator('.article.reading')
  await expect(article.locator('.callout')).toHaveCount(5)
  const cards = await article.evaluate((root) => {
    const bounds = root.getBoundingClientRect()
    return Array.from(root.querySelectorAll<HTMLElement>('.callout')).map((card) => ({
      left: card.getBoundingClientRect().left - bounds.left,
      right: bounds.right - card.getBoundingClientRect().right,
      width: card.getBoundingClientRect().width,
      scrollWidth: card.scrollWidth,
      clientWidth: card.clientWidth,
      border: getComputedStyle(card).borderLeftWidth,
      hasTitle: card.querySelector('.callout-title, .callout-title-text') !== null,
    }))
  })
  for (const card of cards) {
    expect(card.left).toBeGreaterThanOrEqual(0)
    expect(card.right).toBeGreaterThanOrEqual(0)
    expect(card.width).toBeGreaterThan(0)
    expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth)
    expect(card.border).toBe('2px')
    expect(card.hasTitle).toBe(false)
  }
})

for (const theme of ['light', 'dark'] as const) {
  test(`reading ${theme} quotes match Alert density for single-line and wrapped content`, async ({ page }, testInfo) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.addInitScript((value) => localStorage.setItem('nuvyn.theme', value), theme)
    await page.goto('/__markdown-test?mode=reading')
    await expect(page.locator('.article.reading')).toBeVisible()
    await page.evaluate(async () => {
      const { render } = await import('/src/lib/markdown.ts')
      const bodies = [
        'Same short content.',
        'This longer paragraph wraps naturally without a fixed height. '.repeat(8).trim(),
        '**Rich content** with a [link](https://example.com).\n\n- First item\n- Second item\n\nFinal paragraph.',
      ]
      const fixture = document.createElement('div')
      fixture.className = 'quote-density-fixture'
      fixture.innerHTML = await render(bodies.flatMap((body) => {
        const quoted = body.split('\n').map((line) => `> ${line}`).join('\n')
        return [quoted, '', `> [!NOTE]\n${quoted}`, '']
      }).join('\n'))
      document.querySelector('.article.reading')!.prepend(fixture)
    })

    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: 900 })
      const result = await page.evaluate(async () => {
        const { __testing__, buildPdfDownloadDocument, preparePdfArticleHtml } = await import('/src/lib/pdfExport.ts')
        const fixture = document.querySelector<HTMLElement>('.quote-density-fixture')!
        const measure = (element: HTMLElement) => {
          const style = getComputedStyle(element)
          const bounds = element.getBoundingClientRect()
          return {
            text: element.textContent?.replace(/\s+/gu, ' ').trim(),
            width: bounds.width,
            height: bounds.height,
            fontSize: style.fontSize,
            lineHeight: style.lineHeight,
            paddingTop: parseFloat(style.paddingTop),
            paddingBottom: parseFloat(style.paddingBottom),
            paddingLeft: style.paddingLeft,
            paddingRight: style.paddingRight,
            border: style.borderLeftWidth,
            radius: style.borderRadius,
          }
        }
        const readPairs = (root: HTMLElement) => {
          const quotes = Array.from(root.querySelectorAll<HTMLElement>(':scope > blockquote'))
          const alerts = Array.from(root.querySelectorAll<HTMLElement>(':scope > .callout-note'))
          return quotes.map((quote, index) => ({ quote: measure(quote), alert: measure(alerts[index]!) }))
        }
        const reader = readPairs(fixture)
        const source = fixture.outerHTML
        const pdfArticle = document.createElement('article')
        pdfArticle.className = 'article reading'
        pdfArticle.innerHTML = fixture.innerHTML
        const exported = document.createElement('div')
        exported.innerHTML = `<style>${__testing__.PDF_DOWNLOAD_STYLES}</style>${buildPdfDownloadDocument(preparePdfArticleHtml(pdfArticle))}`
        document.body.append(exported)
        try {
          return { reader, pdf: readPairs(exported.querySelector<HTMLElement>('.article')!), readerUnchanged: source === fixture.outerHTML }
        } finally {
          exported.remove()
        }
      })

      expect(result.readerUnchanged).toBe(true)
      for (const surface of [result.reader, result.pdf]) {
        expect(surface).toHaveLength(3)
        for (const { quote, alert } of surface) {
          expect(quote.text).toBe(alert.text)
          expect(quote.fontSize).toBe('14px')
          expect(quote.lineHeight).toBe('21px')
          expect(quote.paddingTop).toBeCloseTo(10.4, 1)
          expect(quote.paddingBottom).toBeCloseTo(10.4, 1)
          expect(quote.paddingLeft).toBe('16px')
          expect(quote.paddingRight).toBe('16px')
          expect(quote.border).toBe('2px')
          expect(quote.radius).toBe('12px')
          expect(quote.width).toBeCloseTo(alert.width, 1)
          expect(quote.height).toBeCloseTo(alert.height, 1)
        }
        expect(surface[0]!.quote.height).toBeCloseTo(41.8, 1)
        expect(surface[1]!.quote.height).toBeGreaterThan(surface[0]!.quote.height)
        expect(surface[2]!.quote.height).toBeGreaterThan(surface[0]!.quote.height)
      }

      await page.locator('.quote-density-fixture > blockquote').first().scrollIntoViewIfNeeded()
      const clip = await page.evaluate(() => {
        const fixture = document.querySelector('.quote-density-fixture')!
        const quote = fixture.querySelector(':scope > blockquote')!.getBoundingClientRect()
        const alert = fixture.querySelector(':scope > .callout-note')!.getBoundingClientRect()
        return { x: quote.left, y: quote.top, width: quote.width, height: alert.bottom - quote.top }
      })
      await page.screenshot({ path: testInfo.outputPath(`quotes-and-alerts-${theme}-${width}.png`), clip })
    }
    expect(pageErrors).toEqual([])
  })
}
