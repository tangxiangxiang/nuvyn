import { expect, test } from './fixtures/auth'
import { selectWorkspace } from './helpers/workspace-navigation'

test('canonical Ledger renders inside the shared Nuvyn App Shell', async ({ page }) => {
  await page.goto('/ledger')

  await expect(page.getByTestId('ledger-page')).toBeVisible()
  await expect(page.locator('.navbar')).toHaveCount(1)
  await expect(page.getByTestId('mobile-workspace-selector')).toHaveText('账本')
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
  await selectWorkspace(page, 'note')

  await expect(page).toHaveURL(/\/vault(?:[/?#]|$)/)
  await expect(page.locator('body')).not.toHaveClass(/ledger-mode/)
  await expect(page.locator('html')).not.toHaveClass(/ledger-mode/)
  await expect(page.locator('.navbar')).toHaveCount(1)
  await expect(page.getByTestId('mobile-workspace-selector')).toHaveText('笔记')
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

test('shared workspace navbar keeps the workspace navigation at phone width', async ({ page }) => {
  await page.goto('/vault')
  await page.setViewportSize({ width: 320, height: 700 })

  await expect(page.locator('.workspace-board-link')).toHaveCount(0)
  await expect(page.locator('.scope-chip')).toHaveCount(0)
  await expect(page.getByTestId('mobile-workspace-selector')).toHaveText('笔记')
  await selectWorkspace(page, 'ledger')
  await expect(page.getByTestId('mobile-workspace-selector')).toHaveText('账本')

  const metrics = await page.evaluate(() => {
    const navbar = document.querySelector<HTMLElement>('.navbar')
    return {
      viewportWidth: window.innerWidth,
      navbarClientWidth: navbar?.clientWidth ?? 0,
      navbarScrollWidth: navbar?.scrollWidth ?? 0,
      navbarRight: navbar?.getBoundingClientRect().right ?? 0,
    }
  })

  expect(metrics.navbarScrollWidth).toBeLessThanOrEqual(metrics.navbarClientWidth + 1)
  expect(metrics.navbarRight).toBeLessThanOrEqual(metrics.viewportWidth + 1)
})
