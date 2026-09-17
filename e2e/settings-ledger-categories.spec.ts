import { expect, test } from './fixtures/auth'

test('uploaded category icon creates a category in the matching Settings list', async ({ page, request }) => {
  const settingsResponse = await request.get('/api/ledger/settings')
  if (settingsResponse.status() === 404) {
    const initialize = await request.post('/api/ledger/settings', {
      data: { baseCurrency: 'CNY', timezone: 'Asia/Shanghai' },
      headers: { 'Idempotency-Key': `settings-categories-${Date.now()}` },
    })
    expect(initialize.status(), await initialize.text()).toBe(201)
  }

  await page.goto('/vault')
  await expect(page.locator('.vault')).toBeVisible({ timeout: 15_000 })
  await page.locator('.navbar [data-testid="account-button"]').click()
  await page.locator('[data-testid="account-settings"]').click()

  const settings = page.locator('.settings-modal')
  await expect(settings).toBeVisible()
  await settings.getByRole('button', { name: /交易分类|Transaction categories/i }).click()

  await settings.getByRole('button', { name: '＋ 添加图标' }).click()
  await page.getByText('支出图标', { exact: true }).click()
  await settings.locator('input[type="file"]').setInputFiles({
    name: 'travel.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>'),
  })

  await expect(settings.locator('[data-category-kind="expense"]')).toContainText('travel')
  await expect(settings.locator('[data-category-kind="expense"] img')).toHaveAttribute('src', /^data:image\/svg\+xml;charset=utf-8,/)
  await settings.getByRole('button', { name: /Account icons/i }).click()
  await expect(settings.locator('.settings-ledger-icon-options')).not.toContainText('travel')
})
