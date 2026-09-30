import { expect, test, type APIRequestContext, type Page } from './fixtures/auth'
import { test as diaryTest } from './fixtures/diary'

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const MOBILE_VIEWPORT = { width: 375, height: 812 }
const DESKTOP_VIEWPORT = { width: 1280, height: 800 }

async function createNote(request: APIRequestContext, path: string): Promise<void> {
  const response = await request.post('/api/posts', {
    data: { path, title: 'Mobile navigation contract', content: '# Mobile navigation contract\n' },
  })
  expect([200, 201], await response.text()).toContain(response.status())
}

async function deleteNote(request: APIRequestContext, path: string): Promise<void> {
  const response = await request.delete(`/api/posts/${path}`)
  expect([200, 404], await response.text()).toContain(response.status())
}

async function expectMobileNavigation(page: Page): Promise<void> {
  const navigation = page.locator('.workspace-navigation')
  await expect(navigation.locator('.scope-chip')).toHaveCount(2)
  await expect(navigation.locator('.scope-chip').filter({ hasText: 'note' })).toHaveCount(0)
  await expect(navigation.locator('.workspace-board-link')).toHaveCount(0)
  await expect(navigation.locator('.scope-chip').filter({ hasText: 'diary' })).toBeVisible()
  await expect(navigation.locator('.scope-chip').filter({ hasText: 'ledger' })).toBeVisible()
}

test('mobile nav shows Diary and Ledger at the 600px boundary and common phone widths', async ({ page }) => {
  await page.setViewportSize(DESKTOP_VIEWPORT)
  await page.goto('/vault')

  const navigation = page.locator('.workspace-navigation')
  await expect(navigation.locator('.scope-chip')).toHaveCount(3)
  await expect(navigation.locator('.workspace-board-link')).toBeVisible()

  for (const width of [375, 390, 430, 600]) {
    await page.setViewportSize({ width, height: MOBILE_VIEWPORT.height })
    await expectMobileNavigation(page)
  }
})

test('workspace navigation entries restore on resize without reloading', async ({ page }) => {
  await page.setViewportSize(DESKTOP_VIEWPORT)
  await page.goto('/vault')
  const navigation = page.locator('.workspace-navigation')

  await expect(navigation.locator('.scope-chip')).toHaveCount(3)
  await expect(navigation.locator('.workspace-board-link')).toBeVisible()

  await page.setViewportSize(MOBILE_VIEWPORT)
  await expectMobileNavigation(page)
  await expect(navigation.locator('.scope-chip').filter({ hasText: 'diary' })).toHaveAttribute('aria-pressed', 'false')
  await expect(navigation.locator('.scope-chip').filter({ hasText: 'ledger' })).toHaveAttribute('aria-pressed', 'false')

  await page.setViewportSize(DESKTOP_VIEWPORT)
  await expect(navigation.locator('.scope-chip')).toHaveCount(3)
  await expect(navigation.locator('.workspace-board-link')).toBeVisible()
  await expect(navigation.locator('.scope-chip[aria-pressed="true"]')).toHaveCount(1)
})

test('mobile direct Note route remains open with no falsely active Diary or Ledger entry', async ({ page, request }) => {
  const path = `inbox/mobile-nav-${RUN_ID}`
  try {
    await createNote(request, path)
    await page.setViewportSize(MOBILE_VIEWPORT)
    await page.goto(`/vault/${path}`)

    await expect(page).toHaveURL(new RegExp(`/vault/${path}$`))
    await expect(page.locator('.vault')).toBeVisible()
    await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toBeVisible()
    await expectMobileNavigation(page)
    await expect(page.locator('.scope-chip[aria-pressed="true"]')).toHaveCount(0)
  } finally {
    await deleteNote(request, path)
  }
})

test('mobile direct Board route remains open while its navigation entry stays absent', async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT)
  await page.goto('/board')

  await expect(page).toHaveURL(/\/board(?:[/?#]|$)/)
  await expect(page.getByTestId('board-home')).toBeVisible()
  await expectMobileNavigation(page)
  await expect(page.locator('.scope-chip[aria-pressed="true"]')).toHaveCount(0)
})

diaryTest('Diary and Ledger entries remain usable from the mobile navigation', async ({ page }) => {
  // Let the Diary fixture complete its supported unlock/bootstrap flow on
  // desktop, where Note is still present, then exercise the mobile nav.
  await page.setViewportSize(DESKTOP_VIEWPORT)
  await page.goto('/vault')
  await page.setViewportSize(MOBILE_VIEWPORT)
  await expectMobileNavigation(page)

  const diary = page.locator('.scope-chip').filter({ hasText: 'diary' })
  await diary.click()
  await expect(diary).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 })
  await expect(page.getByTestId('diary-calendar-surface')).toBeVisible()

  await page.locator('.scope-chip').filter({ hasText: 'ledger' }).click()
  await expect(page).toHaveURL(/\/ledger(?:[/?#]|$)/)
  await expect(page.getByTestId('ledger-page')).toBeVisible()
})
