import { expect, test, type Locator, type Page } from '@playwright/test'

type FocusSnapshot = {
  active: boolean
  nuvynOutline: {
    color: string
    offset: string
    style: string
    width: string
  }
  naive: {
    borderColor: string
    borderStyle: string
    borderWidth: string
    boxShadow: string
  }
  rootClass: string
}

async function focusSnapshot(locator: Locator): Promise<FocusSnapshot> {
  return locator.evaluate((element) => {
    const root = element.closest('[data-testid]') ?? element
    const focusOwner = element.matches('input, textarea, select') ? element : root
    const nuvynStyle = getComputedStyle(focusOwner)
    const naiveIndicator = root.querySelector('.n-button__state-border, .n-input__state-border') ?? root
    const naiveStyle = getComputedStyle(naiveIndicator)
    return {
      active: document.activeElement === element,
      nuvynOutline: {
        color: nuvynStyle.outlineColor,
        offset: nuvynStyle.outlineOffset,
        style: nuvynStyle.outlineStyle,
        width: nuvynStyle.outlineWidth,
      },
      naive: {
        borderColor: naiveStyle.borderColor,
        borderStyle: naiveStyle.borderStyle,
        borderWidth: naiveStyle.borderWidth,
        boxShadow: naiveStyle.boxShadow,
      },
      rootClass: root.className,
    }
  })
}

async function tabUntil(page: Page, selector: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await page.locator(selector).evaluate((element) => document.activeElement === element)) return
    await page.keyboard.press('Tab')
  }
  throw new Error(`Keyboard Tab did not reach ${selector}`)
}

function colorAlpha(color: string): number {
  const match = color.match(/rgba?\(([^)]+)\)/)
  if (!match) return 0
  const channels = match[1].split(',').map((channel) => channel.trim())
  return channels.length === 4 ? Number(channels[3]) : 1
}

function hasClearlyVisibleNaiveBorder(snapshot: FocusSnapshot): boolean {
  return snapshot.naive.borderStyle !== 'none'
    && snapshot.naive.borderWidth !== '0px'
    && colorAlpha(snapshot.naive.borderColor) > 0.05
}

function hasVisibleNuvynOutline(snapshot: FocusSnapshot): boolean {
  return snapshot.nuvynOutline.style !== 'none' && snapshot.nuvynOutline.width !== '0px'
}

test('production focus authority stays single for Naive button and input', async ({ page }) => {
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  const consoleWarnings: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
    if (message.type() === 'warning') consoleWarnings.push(message.text())
  })

  await page.goto('/e2e/naive-ui-foundation/')
  await expect(page.getByTestId('naive-provider-fixture')).toBeAttached()
  // Freeze only Naive's visual transitions so computed-style sampling observes
  // the settled focus state rather than an animation frame.
  await page.addStyleTag({
    content: '.n-button, .n-button *, .n-input, .n-input * { transition: none !important; }',
  })

  const nuvynFocusRuleLoaded = await page.locator('style').evaluateAll((styles) =>
    styles.some((style) => style.textContent?.includes(':focus-visible')),
  )
  expect(nuvynFocusRuleLoaded).toBe(true)

  const button = page.getByTestId('icon-only-button')
  const input = page.getByTestId('input').locator('input')

  await button.click()
  const mouseButton = await focusSnapshot(button)
  await input.click()
  const mouseInput = await focusSnapshot(input)

  await page.getByTestId('keyboard-start').focus()
  await tabUntil(page, '[data-testid="icon-only-button"]')
  const keyboardButton = await focusSnapshot(button)

  await page.getByTestId('keyboard-start').focus()
  await tabUntil(page, '[data-testid="input"] input')
  const keyboardInput = await focusSnapshot(input)

  console.log(JSON.stringify({ mouseButton, keyboardButton, mouseInput, keyboardInput }))
  expect(keyboardButton.active).toBe(true)
  expect(keyboardInput.active).toBe(true)
  expect(hasVisibleNuvynOutline(mouseButton)).toBe(false)
  expect(hasVisibleNuvynOutline(mouseInput)).toBe(false)
  expect(hasVisibleNuvynOutline(keyboardButton)).toBe(false)
  expect(hasClearlyVisibleNaiveBorder(keyboardButton)).toBe(true)
  expect(hasVisibleNuvynOutline(keyboardInput)).toBe(false)
  expect(hasClearlyVisibleNaiveBorder(keyboardInput)).toBe(true)
  expect(pageErrors).toEqual([])
  expect(consoleErrors).toEqual([])
  expect(consoleWarnings).toEqual([])
})

test('explicit Nuvyn theme tokens override the OS fallback', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/e2e/naive-ui-foundation/')

  const token = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--nuvyn-bg').trim())
  expect(await token()).toBe('#1e1e1e')

  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
  expect(await token()).toBe('#ffffff')

  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  expect(await token()).toBe('#1e1e1e')

  await page.emulateMedia({ colorScheme: 'light' })
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'))
  expect(await token()).toBe('#ffffff')
})
