import { expect, test } from './fixtures/auth'
import type { Page, Route } from '@playwright/test'

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function holdFirstRequest(page: Page, url: string): Promise<{
  entered: Promise<void>
  release: () => void
}> {
  const entered = deferred<void>()
  const gate = deferred<void>()
  await page.route(url, async (route: Route) => {
    entered.resolve()
    await gate.promise
    await route.continue()
  }, { times: 1 })
  return { entered: entered.promise, release: () => gate.resolve() }
}

const coldStartRoutes = [
  { path: '/vault', gate: '**/api/auth/status', workspace: 'vault' },
  { path: '/vault/inbox/example', gate: '**/api/vault/identity', workspace: 'vault' },
  { path: '/ledger', gate: '**/api/vault/identity', workspace: 'ledger' },
  { path: '/board', gate: '**/api/auth/status', workspace: 'board' },
] as const

for (const scenario of coldStartRoutes) {
  test(`keeps the initial shell on Bootstrap Loading while ${scenario.path} resolves`, async ({ page }) => {
    const gate = await holdFirstRequest(page, scenario.gate)
    const navigation = page.goto(scenario.path)
    await gate.entered

    await expect(page.locator('.auth-bootstrap-surface')).toBeVisible()
    await expect(page.locator('.navbar')).toHaveCount(0)
    await expect(page.locator('main.container')).toHaveCount(0)

    gate.release()
    await navigation
    await expect(page).toHaveURL(new RegExp(`${scenario.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[?#])`))
    await expect(page.locator(`.navbar.is-workspace.${scenario.workspace === 'board' ? 'board-nav-mode' : scenario.workspace === 'ledger' ? 'ledger-nav-mode' : 'is-vault'}`)).toBeVisible()
    await expect(page.locator('.auth-bootstrap-surface')).toHaveCount(0)
  })
}

test('holds an unauthenticated direct /login visit until its route commits', async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  const page = await context.newPage()
  try {
    const gate = await holdFirstRequest(page, '**/api/auth/status')
    const navigation = page.goto('/login')
    await gate.entered

    await expect(page.locator('.auth-bootstrap-surface')).toBeVisible()
    await expect(page.locator('.navbar')).toHaveCount(0)
    await expect(page.locator('main.container')).toHaveCount(0)

    gate.release()
    await navigation
    await expect(page).toHaveURL(/\/login(?:$|[?#])/)
    await expect(page.locator('.auth-page')).toBeVisible()
    await expect(page.locator('.navbar')).toHaveCount(0)
  } finally {
    await context.close()
  }
})

test('keeps the bootstrap recovery surface after auth initialization fails, then retries the route', async ({ page }) => {
  let attempts = 0
  await page.route('**/api/auth/status', async (route) => {
    attempts += 1
    if (attempts === 1) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'auth-unavailable', error: 'Authentication is unavailable.' }),
      })
      return
    }
    await route.continue()
  })

  await page.goto('/vault')
  await expect(page.locator('.auth-bootstrap-surface.is-error')).toBeVisible()
  await expect(page.locator('.navbar')).toHaveCount(0)
  await expect(page.locator('main.container')).toHaveCount(0)
  await page.getByRole('button', { name: /retry|重试/i }).click()
  await expect(page).toHaveURL(/\/vault(?:$|[?#])/)
  await expect(page.locator('.vault')).toBeVisible()
  await expect(page.locator('.navbar.is-workspace.is-vault')).toBeVisible()
})

test('keeps the Vault Identity retry path available without showing the wrong navbar', async ({ page }) => {
  let attempts = 0
  await page.route('**/api/vault/identity', async (route) => {
    attempts += 1
    if (attempts === 1) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })
      return
    }
    await route.continue()
  })

  await page.goto('/vault')
  await expect(page.locator('.auth-bootstrap-surface.is-error')).toBeVisible()
  await expect(page.locator('.navbar')).toHaveCount(0)
  await expect(page.locator('main.container')).toHaveCount(0)
  await page.getByRole('button', { name: /retry|重试/i }).click()
  await expect(page.locator('.vault')).toBeVisible()
  await expect(page.locator('.navbar.is-workspace.is-vault')).toBeVisible()
})
