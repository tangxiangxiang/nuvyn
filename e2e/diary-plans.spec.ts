import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { expect, goBackFromDiaryDocument, test } from './fixtures/diary'
import { CALENDAR_TEST_DATE, CALENDAR_TEST_TIME_ZONE, calendarDay } from './helpers/calendar-clock'

test.use({ timezoneId: CALENDAR_TEST_TIME_ZONE, locale: 'en-US', trace: 'off', screenshot: 'off' })

const base = '/api/diary/plans'
const tomorrow = '2026-08-16'
const past = '2026-08-14'

function sheet(page: Page) {
  return page.getByTestId('diary-day-plan-sheet')
}

function marker(page: Page, date: string) {
  return page.locator(`[data-testid="diary-calendar-plan"][data-date="${date}"]`)
}

async function openCalendar(page: Page) {
  await page.goto('/vault')
  const diary = page.locator('.scope-chip').filter({ hasText: /diary/i })
  if (await diary.getAttribute('aria-pressed') !== 'true') await diary.click()
  await expect(page.getByTestId('diary-calendar')).toBeVisible()
}

async function newItem(page: Page, title: string) {
  await sheet(page).getByRole('button', { name: /Add item/ }).click()
  const input = sheet(page).getByLabel('Item name')
  await expect(input).toBeFocused()
  await expect(input).toHaveCSS('border-top-width', '1px')
  await expect(input).toHaveCSS('outline-style', 'solid')
  await sheet(page).getByLabel('Planned time (optional)').click()
  await input.click()
  await expect(input).toBeFocused()
  await input.pressSequentially(title)
  await expect(input).toHaveValue(title)
}

async function enterTitle(page: Page, title: string) {
  const input = sheet(page).getByLabel('Item name')
  await input.fill(title)
  await expect(input).toHaveValue(title)
}

test('creates a future plan, safely retries a lost response and persists through reload', async ({ page, request }) => {
  const title = 'Bring project materials'
  const createDiaryRequests: string[] = []
  page.on('request', (event) => {
    if (new URL(event.url()).pathname === '/api/diary/dates') createDiaryRequests.push(event.method())
  })
  await openCalendar(page)
  const dateButton = calendarDay(page.getByTestId('diary-calendar'), tomorrow)
  await dateButton.click()
  await expect(sheet(page)).toBeVisible()
  await newItem(page, title)
  await sheet(page).getByLabel('Planned time (optional)').fill('09:30')
  // Commit once on the server but lose the response on the browser side.
  let intercepted = false
  await page.route(`**${base}`, async (route) => {
    if (route.request().method() !== 'POST' || intercepted) return route.continue()
    intercepted = true
    const response = await route.fetch()
    expect(response.status()).toBe(201)
    await route.abort()
  })
  try {
    await sheet(page).getByRole('button', { name: 'Save' }).click()
    await expect(sheet(page).getByRole('alert')).toContainText('Could not confirm')
    await expect(sheet(page).getByText(title, { exact: false }).filter({ hasText: '09:30' })).toBeVisible()
    await sheet(page).getByRole('button', { name: 'Save' }).click()
    await expect(sheet(page).getByLabel('Item name')).toHaveCount(0)
    await sheet(page).getByRole('button', { name: 'Close plan' }).click()
    await expect(dateButton).toBeFocused()
    await expect(marker(page, tomorrow)).toBeVisible()
    await expect(page.getByTestId('diary-calendar-plan-home')).toHaveClass(/has-plans/)
    expect(createDiaryRequests).toEqual([])
    expect((await request.get(`/api/posts/diary/${tomorrow}`)).status()).toBe(404)
    const items = (await (await request.get(`${base}?date=${tomorrow}`)).json()).items
    expect(items.filter((item: { title: string }) => item.title === title)).toHaveLength(1)

    await page.reload()
    await expect(marker(page, tomorrow)).toBeVisible()
    await marker(page, tomorrow).click()
    await expect(sheet(page).getByText(title, { exact: false }).filter({ hasText: '09:30' })).toBeVisible()
    await sheet(page).getByRole('button', { name: 'Close plan' }).click()
    await page.getByTestId('account-button').click()
    await page.getByTestId('account-lock-diary').click()
    await expect(sheet(page)).toHaveCount(0)
    expect(await page.evaluate(async (url) => (await fetch(url)).status, `${base}?date=${tomorrow}`)).toBe(423)
    await openCalendar(page)
    await marker(page, tomorrow).click()
    await expect(sheet(page).getByText(title, { exact: false }).filter({ hasText: '09:30' })).toBeVisible()
  } finally {
    const { items } = await (await request.get(`${base}?date=${tomorrow}`)).json()
    for (const item of items.filter((entry: { title: string }) => entry.title === title)) {
      await request.delete(`${base}/${item.id}?version=${item.version}`)
    }
  }
})

test('keeps today and past Diary entries separate from plans and discards stale date loads', async ({ page, request }) => {
  const postPath = `/api/posts/diary/${past}`
  const created = await request.post('/api/diary/dates', { data: { date: past, timeZone: CALENDAR_TEST_TIME_ZONE } })
  expect([200, 201]).toContain(created.status())
  const before = (await (await request.get(postPath)).json()).raw
  const id = randomUUID()
  expect((await request.post(base, { data: { id, date: past, title: 'Past item' } })).status()).toBe(201)
  try {
    await openCalendar(page)
    await expect(marker(page, past)).toBeVisible()
    await marker(page, past).click()
    await sheet(page).getByRole('button', { name: 'Edit', exact: true }).click()
    await enterTitle(page, 'Edited past item')
    await sheet(page).getByRole('button', { name: 'Save' }).click()
    await expect(sheet(page).getByText('Edited past item', { exact: true })).toBeVisible()
    const completed = sheet(page).getByRole('checkbox', { name: 'Edited past item' })
    await completed.click()
    await expect(completed).toBeChecked()
    await expect(marker(page, past)).toHaveClass(/is-completed/)
    await completed.click()
    await expect(completed).not.toBeChecked()
    expect((await (await request.get(postPath)).json()).raw).toBe(before)
    await sheet(page).getByRole('button', { name: 'Close plan' }).click()

    const calendar = page.getByTestId('diary-calendar')
    await calendarDay(calendar, past).click()
    await expect(page.locator(`[role="tab"][data-tab-id="diary/${past}"]`)).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.reading-pane')).toBeVisible()
    await expect(page.getByTestId('diary-calendar-plan-home')).toHaveCount(0)
    await goBackFromDiaryDocument(page)
    await expect(calendar).toBeVisible()
    await page.getByTestId('diary-calendar-plan-home').click()
    const date = sheet(page).getByLabel('Choose a plan date')
    await expect(date).toHaveValue(CALENDAR_TEST_DATE)
    await newItem(page, 'Today item')
    await sheet(page).getByRole('button', { name: 'Save' }).click()
    const todayItem = sheet(page).getByRole('listitem').filter({ hasText: 'Today item' })
    await expect(todayItem).toBeVisible()
    await todayItem.getByRole('button', { name: 'Delete', exact: true }).click()
    await todayItem.getByRole('button', { name: 'Confirm delete' }).click()
    await expect(todayItem).toHaveCount(0)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let requested!: () => void
    const started = new Promise<void>((resolve) => { requested = resolve })
    await page.route(`**${base}?date=${past}`, async (route) => {
      requested()
      await gate
      await route.continue().catch(() => undefined)
    })
    await date.fill(past)
    await started
    await date.fill(CALENDAR_TEST_DATE)
    release()
    await expect(sheet(page).getByRole('button', { name: /Add item/ })).toBeEnabled()
    await expect(sheet(page).getByText('Edited past item', { exact: true })).toHaveCount(0)
  } finally {
    const { items } = await (await request.get(`${base}?date=${past}`)).json()
    for (const item of items.filter((entry: { id: string }) => entry.id === id)) {
      await request.delete(`${base}/${id}?version=${item.version}`)
    }
    if (created.status() === 201) await request.delete(postPath)
    const { items: todayItems } = await (await request.get(`${base}?date=${CALENDAR_TEST_DATE}`)).json()
    for (const item of todayItems.filter((entry: { title: string }) => entry.title === 'Today item')) {
      await request.delete(`${base}/${item.id}?version=${item.version}`)
    }
  }
})

test('keeps the Plan icon and form accessible across viewports and themes', async ({ page }) => {
  await openCalendar(page)
  const entry = page.locator('.nav-actions').getByRole('button', { name: 'Open plans', exact: true })
  const tooltip = page.getByTestId('diary-calendar-plan-tooltip')
  const toggle = page.locator('.theme-toggle')
  await expect(page.getByTestId('diary-calendar').getByTestId('diary-calendar-plan-home')).toHaveCount(0)
  for (const viewport of [
    { width: 320, height: 640 }, { width: 390, height: 844 }, { width: 768, height: 1024 },
    { width: 1280, height: 800 }, { width: 599, height: 320 },
  ]) {
    await page.setViewportSize(viewport)
    await expect(entry).toHaveText('')
    await expect(entry.locator('svg')).toBeVisible()
    const iconBounds = (await entry.boundingBox())!
    const toggleBounds = (await toggle.boundingBox())!
    expect(iconBounds.width).toBeCloseTo(toggleBounds.width)
    expect(iconBounds.height).toBeCloseTo(toggleBounds.height)
    expect(iconBounds.x + iconBounds.width).toBeLessThan(viewport.width)
    expect(iconBounds.y + iconBounds.height / 2).toBeCloseTo(toggleBounds.y + toggleBounds.height / 2, 0)
    if (viewport.width === 1280) {
      const root = page.locator('html')
      if (await root.getAttribute('data-theme') !== 'dark') await toggle.click()
      await expect(root).toHaveAttribute('data-theme', 'dark')
      await expect(tooltip).toBeHidden()
      await entry.hover()
      await expect(tooltip).toHaveText('Plans')
      await expect(tooltip).toBeVisible()
      await page.mouse.move(0, 0)
      await expect(tooltip).toBeHidden()
      await page.getByTestId('diary-calendar-next').click()
      await page.getByTestId('diary-calendar-previous').click()
      await entry.focus()
      await page.keyboard.press('Shift+Tab')
      await page.keyboard.press('Tab')
      await expect(entry).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(sheet(page)).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(entry).toBeFocused()
      await page.keyboard.press('Space')
    } else {
      await entry.click()
    }
    const panel = sheet(page)
    await expect(panel).toBeVisible()
    await newItem(page, 'Responsive plan')
    const save = panel.getByRole('button', { name: 'Save' })
    await save.scrollIntoViewIfNeeded()
    await expect(save).toBeInViewport()
    const bounds = (await panel.boundingBox())!
    expect(bounds.x).toBeGreaterThanOrEqual(-1)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1)
    expect(bounds.y).toBeGreaterThanOrEqual(-1)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width)
    await panel.getByRole('button', { name: 'Close plan' }).click()
    await expect(panel).toHaveCount(0)
  }
})
