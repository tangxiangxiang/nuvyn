import { expect, type Page } from '../fixtures/auth'

export async function unlockDiary(page: Page) {
  const password = page.locator('#diary-access-password')
  const calendar = page.locator('.diary-life-calendar')
  await expect(password.or(calendar).first()).toBeVisible()
  if (await calendar.isVisible()) return
  await password.fill('e2e-diary-access-password-strong-123')
  const confirmation = page.locator('#diary-access-confirm')
  if (await confirmation.count()) await confirmation.fill('e2e-diary-access-password-strong-123')
  await page.locator('.diary-access-dialog').getByRole('button', { name: /Set up and unlock|Unlock|设置并解锁|解锁/, exact: true }).click()
}
