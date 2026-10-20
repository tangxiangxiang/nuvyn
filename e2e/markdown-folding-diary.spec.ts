import { expect, test } from './fixtures/diary'
import { CALENDAR_TEST_TIME_ZONE } from './helpers/calendar-clock'

test('managed Diary folding stays document-local and lock removes decrypted structure', async ({ page, request }) => {
  const dates = ['2026-08-21', '2026-08-22']
  for (const date of dates) {
    const created = await request.post('/api/diary/dates', { data: { date, timeZone: CALENDAR_TEST_TIME_ZONE } })
    expect(created.status(), await created.text()).toBe(201)
    const path = `diary/${date}`
    const original = await (await request.get(`/api/posts/${path}`)).json()
    const saved = await request.put(`/api/posts/${path}`, { data: { raw: `# Diary\n\n## Private section\n\nPRIVATE_FOLD_${date}`, baseRaw: original.raw } })
    expect(saved.ok()).toBe(true)
  }
  await page.goto(`/vault/diary/${dates[0]}`)
  await expect(page.locator('.monaco-editor')).toBeVisible()
  await page.getByTestId('view-toggle').click()
  const article = page.locator('.reading-pane .article')
  const toggle = article.locator('#private-section > .nuvyn-fold-toggle')
  await toggle.click()
  await expect(article.getByText(`PRIVATE_FOLD_${dates[0]}`, { exact: true })).toBeHidden()
  await page.locator(`[data-tree-key="file:diary/${dates[1]}"] > .row-line`).click()
  await expect(article.getByText(`PRIVATE_FOLD_${dates[1]}`, { exact: true })).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(article).toHaveCount(1)
  await expect(article.getByText(`PRIVATE_FOLD_${dates[0]}`, { exact: true })).toHaveCount(0)
  await page.getByTestId('account-button').click()
  await page.getByTestId('account-lock-diary').click()
  await expect(page.locator('.reading-pane .nuvyn-fold-toggle')).toHaveCount(0)
  await expect(page.getByText(`PRIVATE_FOLD_${dates[1]}`, { exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('PRIVATE_FOLD_')
})
