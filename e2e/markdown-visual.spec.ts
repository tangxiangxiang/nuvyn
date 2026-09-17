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
const alertBackgrounds = {
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
const alertTitles = ['注意', '提示', '重要', '警告', '小心']

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

    const alerts = await article.evaluate((root, values) => values.map((type) => {
      const callout = root.querySelector<HTMLElement>(`.callout-${type}`)
      const title = callout?.querySelector<HTMLElement>('.callout-title')
      const calloutStyle = callout ? getComputedStyle(callout) : null
      return {
        type,
        title: title?.querySelector('.callout-title-text')?.textContent ?? '',
        foreground: title ? getComputedStyle(title).color : '',
        borderLeftWidth: calloutStyle?.borderLeftWidth ?? '',
        borderTopWidth: calloutStyle?.borderTopWidth ?? '',
        background: calloutStyle?.backgroundColor ?? '',
        radius: calloutStyle?.borderRadius ?? '',
        shadow: calloutStyle?.boxShadow ?? '',
        paddingTop: calloutStyle?.paddingTop ?? '',
        paddingLeft: calloutStyle?.paddingLeft ?? '',
        fontSize: title ? getComputedStyle(title).fontSize : '',
        fontWeight: title ? getComputedStyle(title).fontWeight : '',
        lineHeight: title ? getComputedStyle(title).lineHeight : '',
        hasIcon: callout?.querySelector('.callout-icon') !== null,
      }
    }), alertTypes)

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
      const background = alertBackgrounds[theme][alert.type]
      expect(alert.title).toBe(alertTitles[index])
      expect(alert.foreground).toBe(theme === 'light' ? 'rgb(31, 31, 31)' : 'rgb(212, 212, 212)')
      expect(alert.background).toBe(background)
      expect(alert.borderLeftWidth).toBe('0px')
      expect(alert.borderTopWidth).toBe('0px')
      expect(alert.radius).toBe('12px')
      expect(alert.shadow).toBe('none')
      expect(alert.paddingTop).toBe('12px')
      expect(alert.paddingLeft).toBe('16px')
      expect(alert.fontSize).toBe('14px')
      expect(alert.fontWeight).toBe('700')
      expect(Number.parseFloat(alert.lineHeight)).toBeCloseTo(19.6, 1)
      expect(alert.hasIcon).toBe(false)
    })

    expect(containers.map((container) => container.title)).toEqual(['信息', '提示', '警告', '危险', '查看详情'])
    containers.forEach((container) => {
      const alert = alerts.find((candidate) => candidate.type === noticePair[container.type])
      expect(alert).toBeDefined()
      expect(container.background).toBe(alert?.background)
      expect(container.borderLeftWidth).toBe('0px')
      expect(container.borderTopWidth).toBe('0px')
      expect(container.radius).toBe(alert?.radius)
      expect(container.shadow).toBe('none')
      expect(container.paddingTop).toBe(alert?.paddingTop)
      expect(container.paddingLeft).toBe(alert?.paddingLeft)
      expect(container.fontSize).toBe(alert?.fontSize)
      expect(container.fontWeight).toBe(alert?.fontWeight)
      expect(Number.parseFloat(container.lineHeight)).toBeCloseTo(19.6, 1)
    })
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
    expect(codeSurface?.borderRadius).toBe('8px')
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
      const closedMarginBottom = getComputedStyle(summary).marginBottom
      details.open = true
      const openMarginBottom = getComputedStyle(summary).marginBottom
      details.open = false
      return { closedMarginBottom, openMarginBottom }
    })
    expect(detailsSpacing).not.toBeNull()
    expect(Number.parseFloat(detailsSpacing?.closedMarginBottom ?? '')).toBe(0)
    expect(Number.parseFloat(detailsSpacing?.openMarginBottom ?? '')).toBeCloseTo(5.6, 1)

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

test('reading forced Alert theme overrides the operating-system color scheme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.addInitScript(() => localStorage.setItem('nuvyn.theme', 'light'))
  await page.goto('/__markdown-test?mode=reading')
  const noteTitle = page.locator('.article.reading .callout-note .callout-title')
  const infoCard = page.locator('.article.reading .markdown-container-info')
  await expect(noteTitle).toBeVisible()
  await expect(noteTitle).toHaveCSS('color', 'rgb(31, 31, 31)')
  await expect(infoCard).toHaveCSS('background-color', 'rgb(241, 242, 244)')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

  const forcedDarkPage = await page.context().newPage()
  try {
    await forcedDarkPage.emulateMedia({ colorScheme: 'light' })
    await forcedDarkPage.addInitScript(() => localStorage.setItem('nuvyn.theme', 'dark'))
    await forcedDarkPage.goto('/__markdown-test?mode=reading')
    const darkNoteTitle = forcedDarkPage.locator('.article.reading .callout-note .callout-title')
    const darkInfoCard = forcedDarkPage.locator('.article.reading .markdown-container-info')
    await expect(darkNoteTitle).toBeVisible()
    await expect(darkNoteTitle).toHaveCSS('color', 'rgb(212, 212, 212)')
    await expect(darkInfoCard).toHaveCSS('background-color', 'rgb(36, 38, 43)')
    await expect(forcedDarkPage.locator('html')).toHaveAttribute('data-theme', 'dark')
  } finally {
    await forcedDarkPage.close()
  }
})
