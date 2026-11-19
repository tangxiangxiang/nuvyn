import type { Locator, Page, Request, Response } from '@playwright/test'
import { expect } from '../fixtures/auth'

export function diaryMonthLabel(month: string, locale: 'zh' | 'en' = 'en'): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month)
  if (!match) return month
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)))
}

export async function openEmptyDiaryDay(page: Page, cell: Locator, open = () => cell.click()) {
  const date = await cell.getAttribute('data-date')
  if (!date) throw new Error('Cannot open Diary day: target calendar cell has no data-date')

  const path = `/api/diary/life/days/${date}`
  const observed: string[] = []
  const matchesDayRequest = (url: string) => {
    try { return new URL(url).pathname === path } catch { return false }
  }
  const onRequest = (request: Request) => {
    if (matchesDayRequest(request.url())) observed.push(`${request.method()} ${path}`)
  }
  const onResponse = (response: Response) => {
    if (matchesDayRequest(response.url())) observed.push(`response ${response.status()}`)
  }
  const onRequestFailed = (request: Request) => {
    if (matchesDayRequest(request.url())) observed.push(`request failed: ${request.failure()?.errorText ?? 'unknown error'}`)
  }
  page.on('request', onRequest)
  page.on('response', onResponse)
  page.on('requestfailed', onRequestFailed)

  let response: Response
  try {
    const [dayResponse] = await Promise.all([
      page.waitForResponse(response => response.request().method() === 'GET' && matchesDayRequest(response.url()), { timeout: 10_000 }),
      open(),
    ])
    response = dayResponse
  } catch (error) {
    const state = await page.evaluate(date => {
      const cell = document.querySelector<HTMLElement>(`.diary-life-calendar [data-date="${date}"]`)
      return {
        month: document.querySelector('.life-month-label, .life-month')?.textContent?.trim() ?? null,
        selected: cell?.getAttribute('aria-pressed') ?? null,
        dayDialog: Boolean(document.querySelector('[data-testid="diary-day-dialog"]')),
        editor: Boolean(document.querySelector('[data-testid="diary-bullet-editor"]')),
        viewMode: document.querySelector<HTMLElement>('[data-testid="diary-view-toggle"]')?.getAttribute('aria-label') ?? null,
      }
    }, date)
    throw new Error(`Failed to open Diary day ${date} (${path}); page state: ${JSON.stringify(state)}; matching requests: ${observed.join(', ') || 'none'}; cause: ${(error as Error).message}`)
  } finally {
    page.off('request', onRequest)
    page.off('response', onResponse)
    page.off('requestfailed', onRequestFailed)
  }

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

export async function selectNaiveOption(page: Page, label: string, optionName: string, touch = false) {
  const control = page.locator(`.n-select[aria-label="${label}"] .n-base-selection`)
  if (touch) await control.tap()
  else await control.click()
  const menu = page.locator('.n-base-select-menu').last()
  const option = page.getByText(optionName, { exact: true }).last()
  for (let attempt = 0; attempt < 30 && await option.count() === 0; attempt += 1) {
    await menu.hover()
    await page.mouse.wheel(0, 160)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
  }
  await expect(option).toHaveCount(1)
  if (touch) await option.tap()
  else await option.click()
}

export function diaryTaskDateInput(page: Page, label: string) {
  return page.locator(`.diary-task-date-picker[aria-label="${label}"] input`)
}

export async function fillDiaryTaskDate(page: Page, label: string, value: string) {
  const input = diaryTaskDateInput(page, label)
  await input.fill(value)
  await input.press('Tab')
}

export async function clearDiaryTaskDate(page: Page, label: string) {
  const picker = page.locator(`.diary-task-date-picker[aria-label="${label}"]`)
  await picker.hover()
  await picker.locator('.n-base-clear').click()
}

export function diaryTaskTimeInput(page: Page, label: string) {
  return page.locator(`.diary-task-time-picker[aria-label="${label}"] input`)
}

export async function fillDiaryTaskTime(page: Page, label: string, value: string) {
  const input = diaryTaskTimeInput(page, label)
  await input.fill(value)
  await input.press('Tab')
}

export function diaryEventDateInput(page: Page, label: string) {
  return page.locator(`.event-date-picker[aria-label="${label}"] input`)
}

export async function fillDiaryEventDate(page: Page, label: string, value: string) {
  const input = diaryEventDateInput(page, label)
  await input.fill(value)
  await input.press('Tab')
}

export function diaryEventTimeInput(page: Page, label: string) {
  return page.locator(`.event-time-picker[aria-label="${label}"] input`)
}

export async function fillDiaryEventTime(page: Page, label: string, value: string) {
  const input = diaryEventTimeInput(page, label)
  await input.fill(value)
  await input.press('Tab')
}

export function chooseDiaryDayAction(page: Page, action: string, touch = false) {
  return chooseDiaryAction(page, page.getByRole('button', { name: '更多日记操作' }), action, touch)
}

export function saveDiaryDay(page: Page, touch = false) {
  return chooseDiaryDayAction(page, '保存日记', touch)
}
