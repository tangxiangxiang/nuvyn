import type { Locator, Page } from '@playwright/test'
import { expect } from '../fixtures/auth'

export async function openEmptyDiaryDay(page: Page, cell: Locator, open = () => cell.click()) {
  const date = await cell.getAttribute('data-date')
  const [response] = await Promise.all([
    page.waitForResponse(response => response.request().method() === 'GET'
      && new URL(response.url()).pathname === `/api/diary/life/days/${date}`),
    open(),
  ])
  expect(response.ok(), `read Diary fixture for ${date}`).toBe(true)
  expect(await response.json(), `Diary fixture for ${date} must be empty`).toMatchObject({ day: null, attachments: [] })
  await expect(page.getByTestId('diary-bullet-editor')).toBeVisible()
}

export async function unlockDiary(page: Page) {
  const password = page.locator('#diary-access-password')
  const calendar = page.locator('.diary-life-calendar')
  await expect(password.or(calendar).first()).toBeVisible()
  if (await calendar.isVisible()) return
  await password.fill('e2e-diary-access-password-strong-123')
  const confirmation = page.locator('#diary-access-confirm')
  if (await confirmation.count()) await confirmation.fill('e2e-diary-access-password-strong-123')
  await page.locator('.diary-access-dialog').getByRole('button', { name: /Set up and unlock|Unlock|设置并解锁|解锁/, exact: true }).click()
  await expect(calendar).toBeVisible()
}

export async function chooseDiaryAction(page: Page, trigger: Locator, action: string | RegExp, touch = false) {
  if (touch) await trigger.tap()
  else await trigger.click()
  const menu = page.getByRole('menu')
  const option = menu.getByRole('menuitem', { name: action, exact: true })
  if (touch) await option.tap()
  else await option.click()
  await expect(menu).toHaveCount(0)
}

export function chooseDiaryDayAction(page: Page, action: string, touch = false) {
  return chooseDiaryAction(page, page.getByRole('button', { name: '更多日记操作' }), action, touch)
}

export function saveDiaryDay(page: Page, touch = false) {
  return chooseDiaryDayAction(page, '保存日记', touch)
}
