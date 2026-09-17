import { expect, test, type Page } from '@playwright/test'

const source = [
  '```js',
  'const message = "hello"',
  'function demo(value) {',
  '  return value',
  '}',
  '```',
  '',
  '```totally-unknown',
  'plain fallback',
  '```',
  '',
  'Inline `code` remains inline.',
].join('\n')

type Palette = 'light' | 'dark'

async function renderFixture(page: Page) {
  await page.evaluate(async (markdown: string) => {
    const { render } = await import('/src/lib/markdown.ts')
    document.querySelector('[data-h5-theme-fixture]')?.remove()
    const article = document.createElement('article')
    article.className = 'article reading'
    article.dataset.h5ThemeFixture = 'true'
    article.innerHTML = await render(markdown)
    document.body.append(article)
  }, source)
  await expect(page.locator('[data-h5-theme-fixture] pre.shiki').first()).toBeVisible()
}

async function setExplicitTheme(page: Page, theme: Palette, colorScheme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme })
  await page.evaluate(async (value: Palette) => {
    const { useTheme } = await import('/src/composables/useTheme.ts')
    useTheme().set(value)
  }, theme)
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
}

async function readThemeState(page: Page) {
  return page.evaluate(() => {
    const article = document.querySelector<HTMLElement>('[data-h5-theme-fixture]')
    if (!article) throw new Error('H5 theme fixture is missing')
    const pre = article.querySelector<HTMLElement>('pre.shiki:not(.nuvyn-shiki-plain)')
    const token = Array.from(article.querySelectorAll<HTMLElement>('pre.shiki:not(.nuvyn-shiki-plain) span'))
      .find((element) => Array.from(element.classList).some((className) => className.startsWith('nuvyn-shiki-')))
    const fallback = article.querySelector<HTMLElement>('pre.nuvyn-shiki-plain')
    const inlineCode = article.querySelector<HTMLElement>('p > code')
    const owner = document.head.querySelector<HTMLStyleElement>('style#nuvyn-shiki-generated-styles')
    if (!pre || !token || !fallback || !inlineCode || !owner) {
      throw new Error('H5 theme fixture did not produce the expected Shiki nodes')
    }

    const normalize = (property: 'color' | 'backgroundColor', value: string) => {
      const probe = document.createElement('span')
      probe.style[property] = value.trim()
      document.body.append(probe)
      const normalized = getComputedStyle(probe)[property]
      probe.remove()
      return normalized
    }

    const tokenStyle = getComputedStyle(token)
    const preStyle = getComputedStyle(pre)
    const lightToken = normalize('color', tokenStyle.getPropertyValue('--shiki-light'))
    const darkToken = normalize('color', tokenStyle.getPropertyValue('--shiki-dark'))
    const lightBackground = normalize('backgroundColor', preStyle.getPropertyValue('--shiki-light-bg'))
    const darkBackground = normalize('backgroundColor', preStyle.getPropertyValue('--shiki-dark-bg'))
    const tokenColor = tokenStyle.color
    const preBackground = preStyle.backgroundColor
    const palette: 'light' | 'dark' | 'unresolved' =
      tokenColor === lightToken && preBackground === lightBackground
        ? 'light'
        : tokenColor === darkToken && preBackground === darkBackground
          ? 'dark'
          : 'unresolved'

    const state = {
      palette,
      tokenColor,
      lightToken,
      darkToken,
      preBackground,
      lightBackground,
      darkBackground,
      fallbackColor: getComputedStyle(fallback).color,
      fallbackBackground: getComputedStyle(fallback).backgroundColor,
      inlineClassName: inlineCode.className,
      inlineInsideShiki: Boolean(inlineCode.closest('.shiki')),
      articleHtml: article.innerHTML,
      tokenClassName: token.className,
      ownerText: owner.textContent ?? '',
    }

    return state
  })
}

test('Shiki reader themes select computed token/background palettes without rerendering', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('nuvyn.theme', 'light'))
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/__markdown-test?mode=reading')
  await renderFixture(page)

  await setExplicitTheme(page, 'light', 'dark')
  const forcedLightState = await readThemeState(page)
  expect(forcedLightState.palette).toBe('light')
  expect(forcedLightState.tokenColor).toBe(forcedLightState.lightToken)
  expect(forcedLightState.preBackground).toBe(forcedLightState.lightBackground)
  expect(forcedLightState.fallbackColor).not.toBe('')
  expect(forcedLightState.fallbackColor).not.toBe('rgba(0, 0, 0, 0)')
  expect(forcedLightState.fallbackBackground).not.toBe('')
  expect(forcedLightState.fallbackBackground).not.toBe('rgba(0, 0, 0, 0)')

  const beforeSwitch = await page.evaluate(() => {
    const article = document.querySelector<HTMLElement>('[data-h5-theme-fixture]')
    const token = article?.querySelector<HTMLElement>('pre.shiki:not(.nuvyn-shiki-plain) span[class^="nuvyn-shiki-"]')
    const pre = article?.querySelector<HTMLElement>('pre.shiki:not(.nuvyn-shiki-plain)')
    const owner = document.head.querySelector<HTMLStyleElement>('style#nuvyn-shiki-generated-styles')
    if (!article || !token || !pre || !owner) throw new Error('H5 switch nodes are missing')
    const globals = window as Window & {
      __nuvynH5Pre?: HTMLElement
      __nuvynH5Token?: HTMLElement
      __nuvynH5Owner?: HTMLStyleElement
    }
    globals.__nuvynH5Pre = pre
    globals.__nuvynH5Token = token
    globals.__nuvynH5Owner = owner
    return {
      html: article.innerHTML,
      tokenClassName: token.className,
      ownerText: owner.textContent ?? '',
      tokenColor: getComputedStyle(token).color,
      preBackground: getComputedStyle(pre).backgroundColor,
    }
  })

  await page.evaluate(async () => {
    const { useTheme } = await import('/src/composables/useTheme.ts')
    useTheme().set('dark')
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
  const afterSwitch = await readThemeState(page)
  const switchIdentity = await page.evaluate(() => {
    const article = document.querySelector<HTMLElement>('[data-h5-theme-fixture]')
    const pre = article?.querySelector<HTMLElement>('pre.shiki:not(.nuvyn-shiki-plain)')
    const token = article?.querySelector<HTMLElement>('pre.shiki:not(.nuvyn-shiki-plain) span[class^="nuvyn-shiki-"]')
    const owner = document.head.querySelector<HTMLStyleElement>('style#nuvyn-shiki-generated-styles')
    const globals = window as Window & {
      __nuvynH5Pre?: HTMLElement
      __nuvynH5Token?: HTMLElement
      __nuvynH5Owner?: HTMLStyleElement
    }
    return {
      preSame: pre === globals.__nuvynH5Pre,
      tokenSame: token === globals.__nuvynH5Token,
      ownerSame: owner === globals.__nuvynH5Owner,
      ownerCount: document.head.querySelectorAll('style#nuvyn-shiki-generated-styles').length,
    }
  })
  expect(afterSwitch.palette).toBe('dark')
  expect(afterSwitch.tokenColor).toBe(afterSwitch.darkToken)
  expect(afterSwitch.preBackground).toBe(afterSwitch.darkBackground)
  expect(afterSwitch.articleHtml).toBe(beforeSwitch.html)
  expect(afterSwitch.tokenClassName).toBe(beforeSwitch.tokenClassName)
  expect(afterSwitch.ownerText).toBe(beforeSwitch.ownerText)
  expect(afterSwitch.tokenColor).not.toBe(beforeSwitch.tokenColor)
  expect(afterSwitch.preBackground).not.toBe(beforeSwitch.preBackground)
  expect(switchIdentity).toEqual({ preSame: true, tokenSame: true, ownerSame: true, ownerCount: 1 })
  expect(afterSwitch.fallbackColor).not.toBe('')
  expect(afterSwitch.fallbackColor).not.toBe('rgba(0, 0, 0, 0)')
  expect(afterSwitch.fallbackBackground).not.toBe('')
  expect(afterSwitch.fallbackBackground).not.toBe('rgba(0, 0, 0, 0)')

  const explicitCases: Array<{ theme: Palette; os: 'light' | 'dark'; expected: Palette }> = [
    { theme: 'light', os: 'light', expected: 'light' },
    { theme: 'light', os: 'dark', expected: 'light' },
    { theme: 'dark', os: 'light', expected: 'dark' },
    { theme: 'dark', os: 'dark', expected: 'dark' },
  ]
  for (const testCase of explicitCases) {
    await setExplicitTheme(page, testCase.theme, testCase.os)
    expect((await readThemeState(page)).palette).toBe(testCase.expected)
  }

  for (const testCase of [
    { os: 'light' as const, expected: 'light' as const },
    { os: 'dark' as const, expected: 'dark' as const },
  ]) {
    await page.emulateMedia({ colorScheme: testCase.os })
    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'))
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    const state = await readThemeState(page)
    expect(state.palette, JSON.stringify(state)).toBe(testCase.expected)
  }

  const fallback = await readThemeState(page)
  expect(fallback.fallbackColor).not.toBe('')
  expect(fallback.fallbackColor).not.toBe('rgba(0, 0, 0, 0)')
  expect(fallback.fallbackBackground).not.toBe('')
  expect(fallback.fallbackBackground).not.toBe('rgba(0, 0, 0, 0)')
  expect(fallback.inlineClassName).toBe('')
  expect(fallback.inlineInsideShiki).toBe(false)
})
