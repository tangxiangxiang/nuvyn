import { test, expect } from '@playwright/test'

test('Naive UI Calendar browser compatibility across desktop and narrow viewports', async ({ browser, page }) => {
  const pageErrors: string[] = []
  const consoleErrors: string[] = []

  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })

  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/e2e/naive-calendar-compatibility/')

  const probe = page.getByTestId('naive-calendar-probe')
  const calendar = page.locator('.n-calendar')
  const title = page.locator('.n-calendar-header__title')
  const targetDay = page.locator('[data-date="2026-08-24"]')

  await expect(calendar).toBeVisible()
  await expect(probe).toHaveAttribute('data-page', '2026-08')
  await expect(page.getByTestId('custom-marker')).toHaveText('mood-probe')
  await expect(page.locator('[data-date^="2026-08-"]')).toHaveCount(31)
  await expect(title).toBeVisible()

  await page.getByTestId('next-page').click()
  await expect(probe).toHaveAttribute('data-page', '2026-09')
  await page.getByTestId('prev-page').click()
  await expect(probe).toHaveAttribute('data-page', '2026-08')

  await page.getByTestId('toggle-indicator').click()
  await expect(page.getByTestId('custom-marker')).toHaveCount(0)
  await page.getByTestId('toggle-indicator').click()
  await expect(page.getByTestId('custom-marker')).toHaveCount(1)

  await targetDay.click()
  await expect(page.getByTestId('selected-date')).toHaveText('2026-08-24')
  await expect(page.getByTestId('clicked-date')).toHaveText('2026-08-24')

  await page.getByTestId('toggle-locale').click()
  await expect(probe).toHaveAttribute('data-locale', 'zh')
  await expect(calendar).toBeVisible()

  await page.getByTestId('toggle-theme').click()
  await expect(probe).toHaveAttribute('data-theme', 'dark')
  await expect(calendar).toBeVisible()

  await page.getByTestId('toggle-calendar').click()
  await expect(calendar).toHaveCount(0)
  await page.getByTestId('toggle-calendar').click()
  await expect(calendar).toBeVisible()

  await page.setViewportSize({ width: 375, height: 812 })
  await expect(calendar).toBeVisible()
  await expect(page.getByTestId('custom-marker')).toHaveText('mood-probe')
  await page.locator('[data-date="2026-08-24"]').click()
  await expect(page.getByTestId('selected-date')).toHaveText('2026-08-24')

  for (const timezoneId of ['Pacific/Kiritimati', 'Etc/GMT+12', 'America/New_York']) {
    const boundaryContext = await browser.newContext({ timezoneId, viewport: { width: 800, height: 600 } })
    const boundaryPage = await boundaryContext.newPage()
    await boundaryPage.goto('/e2e/naive-calendar-compatibility/')
    await boundaryPage.locator('[data-date="2026-08-24"]').click()
    await expect(boundaryPage.getByTestId('selected-date')).toHaveText('2026-08-24')
    await boundaryContext.close()
  }

  expect(pageErrors).toEqual([])
  expect(consoleErrors).toEqual([])
})
