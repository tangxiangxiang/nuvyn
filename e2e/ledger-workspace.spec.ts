import { expect, test } from './fixtures/auth'

test('canonical Ledger renders inside the shared Nuvyn App Shell', async ({ page }) => {
  await page.goto('/ledger')

  await expect(page.getByTestId('ledger-page')).toBeVisible()
  await expect(page.locator('.navbar')).toHaveCount(1)
  await expect(page.locator('.scope-chips')).toBeVisible()
  await expect(page.locator('.scope-chip').filter({ hasText: 'ledger' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('body')).toHaveClass(/ledger-mode/)
  await expect(page.locator('html')).toHaveClass(/ledger-mode/)
  await expect(page.locator('body')).not.toHaveClass(/bills-mode/)
  await expect(page.locator('html')).not.toHaveClass(/bills-mode/)

  // Ledger is a body workspace, not a second Vault shell. The global actions
  // stay in the single navbar while Vault-only controls and sidebars do not.
  await expect(page.getByTestId('account-button')).toHaveCount(1)
  await expect(page.locator('.theme-toggle')).toHaveCount(1)
  await expect(page.getByTestId('view-toggle')).toHaveCount(0)
  await expect(page.locator('.right-rail-toggle')).toHaveCount(0)
  await expect(page.locator('.activity-bar')).toHaveCount(0)
  await expect(page.locator('.navbar + .navbar')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('billsMockData')
  await expect(page.locator('body')).not.toContainText('Bills')
})

test('legacy Bills URLs redirect to the canonical Ledger routes', async ({ page }) => {
  await page.goto('/bills/transactions?period=month#recent')
  await expect(page).toHaveURL(/\/ledger\/transactions\?period=month#recent$/)
  await expect(page.getByTestId('ledger-transactions-page')).toBeVisible()

  await page.goto('/bills?period=month#summary')
  await expect(page).toHaveURL(/\/ledger\?period=month#summary$/)
  await expect(page.getByTestId('ledger-page')).toBeVisible()
})

test('Ledger scope switches back to the shared Vault body', async ({ page }) => {
  await page.goto('/ledger')
  await page.locator('.scope-chip').filter({ hasText: 'note' }).click()

  await expect(page).toHaveURL(/\/vault(?:[/?#]|$)/)
  await expect(page.locator('body')).not.toHaveClass(/ledger-mode/)
  await expect(page.locator('html')).not.toHaveClass(/ledger-mode/)
  await expect(page.locator('.navbar')).toHaveCount(1)
  await expect(page.locator('.scope-chip').filter({ hasText: 'note' })).toHaveAttribute('aria-pressed', 'true')
})

test('Ledger keeps the shared theme readable', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('nuvyn.theme', 'dark')
  })
  await page.goto('/ledger')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.getByTestId('ledger-page')).toBeVisible()
  await expect(page.locator('body')).not.toContainText('Bills')
})

test('shared workspace navbar keeps the Board entry usable at phone width', async ({ page }) => {
  await page.goto('/vault')
  await page.setViewportSize({ width: 320, height: 700 })

  const boardLink = page.locator('.workspace-board-link')
  await expect(boardLink).toBeVisible()
  await expect(boardLink).toHaveAttribute('aria-label', /board/i)

  const metrics = await page.evaluate(() => {
    const navbar = document.querySelector<HTMLElement>('.navbar')
    const board = document.querySelector<HTMLElement>('.workspace-board-link')
    return {
      viewportWidth: window.innerWidth,
      navbarClientWidth: navbar?.clientWidth ?? 0,
      navbarScrollWidth: navbar?.scrollWidth ?? 0,
      navbarRight: navbar?.getBoundingClientRect().right ?? 0,
      boardRight: board?.getBoundingClientRect().right ?? 0,
    }
  })

  expect(metrics.navbarScrollWidth).toBeLessThanOrEqual(metrics.navbarClientWidth + 1)
  expect(metrics.navbarRight).toBeLessThanOrEqual(metrics.viewportWidth + 1)
  expect(metrics.boardRight).toBeLessThanOrEqual(metrics.viewportWidth + 1)

  await boardLink.click()
  await expect(page).toHaveURL(/\/board(?:[/?#]|$)/)
})
