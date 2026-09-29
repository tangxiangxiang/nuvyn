import { expect, test, type APIRequestContext, type Page } from './fixtures/diary'
import { clearDraftDatabase, gotoVaultReady } from './helpers/edit-program'
import {
  CALENDAR_TEST_DATE,
  CALENDAR_TEST_TIME_ZONE,
  calendarDay,
  freezeCalendarClock,
} from './helpers/calendar-clock'

test.use({ timezoneId: CALENDAR_TEST_TIME_ZONE, trace: 'off', screenshot: 'only-on-failure' })

const RUN_ID = String(Date.now())
const firstDate = CALENDAR_TEST_DATE
const secondDate = '2026-08-14'

function diaryPath(date: string): string {
  return `diary/${date}`
}

async function seedDiary(request: APIRequestContext, date: string, content: string): Promise<void> {
  const path = diaryPath(date)
  await request.delete(`/api/posts/${path}`)
  const created = await request.post('/api/diary/dates', {
    data: { date, timeZone: CALENDAR_TEST_TIME_ZONE },
  })
  expect(created.status(), await created.text()).toBe(201)
  const initial = await request.get(`/api/posts/${path}`)
  expect(initial.status()).toBe(200)
  const body = await initial.json() as { raw: string }
  const saved = await request.put(`/api/posts/${path}`, {
    data: { raw: content, baseRaw: body.raw },
  })
  expect(saved.status(), await saved.text()).toBe(200)
}

async function seedNote(request: APIRequestContext, path: string, content: string): Promise<void> {
  await request.delete(`/api/posts/${path}`)
  const created = await request.post('/api/posts', {
    data: { path, title: path.split('/').at(-1) },
  })
  expect([200, 201]).toContain(created.status())
  const initial = await request.get(`/api/posts/${path}`)
  expect(initial.status()).toBe(200)
  const body = await initial.json() as { raw: string }
  const saved = await request.put(`/api/posts/${path}`, {
    data: { raw: content, baseRaw: body.raw },
  })
  expect(saved.status(), await saved.text()).toBe(200)
}

async function selectScope(page: Page, scope: 'note' | 'diary'): Promise<void> {
  const chip = page.locator('.scope-chip').filter({ hasText: scope })
  if (await chip.getAttribute('aria-pressed') !== 'true') await chip.click()
}

async function openNote(page: Page, path: string): Promise<void> {
  await selectScope(page, 'note')
  const row = page.locator(`[data-tree-key="file:${path}"]`)
  if (!(await row.isVisible())) {
    const folder = page.locator(`[data-tree-key="folder:${path.split('/')[0]}"]`)
    await expect(folder).toBeVisible()
    await folder.locator('.row-line').click()
  }
  await expect(row).toBeVisible()
  await row.locator('.row-line').click()
  await expect(page).toHaveURL(new RegExp(`/vault/${path.replace('/', '\\/')}(?:[?#]|$)`))
}

test.beforeEach(async ({ page }) => {
  await freezeCalendarClock(page)
  await page.goto('/__markdown-test?mode=reading')
  await page.evaluate(() => localStorage.clear())
  await clearDraftDatabase(page)
  await gotoVaultReady(page)
})

test('Diary date navigation keeps one document, preserves FileTree search, and retains Note tabs', async ({ page, request }) => {
  const first = diaryPath(firstDate)
  const second = diaryPath(secondDate)
  const noteA = `inbox/diary-single-a-${RUN_ID}`
  const noteB = `literature/diary-single-b-${RUN_ID}`

  try {
    await seedDiary(request, firstDate, `# First ${RUN_ID}\n\nFirst Diary entry.\n`)
    await seedDiary(request, secondDate, `# Second ${RUN_ID}\n\nSecond Diary entry.\n`)
    await seedNote(request, noteA, `# Note A ${RUN_ID}\n`)
    await seedNote(request, noteB, `# Note B ${RUN_ID}\n`)
    await page.goto('/vault')
    await expect(page.locator('.file-tree')).toBeVisible({ timeout: 15_000 })

    await openNote(page, noteA)
    await openNote(page, noteB)
    await expect(page.locator('.tabs')).toBeVisible()
    await expect(page.locator(`[role="tab"][data-tab-id="${noteA}"]`)).toHaveCount(1)
    await expect(page.locator(`[role="tab"][data-tab-id="${noteB}"]`)).toHaveCount(1)

    await selectScope(page, 'diary')
    await expect(page.getByTestId('diary-calendar')).toBeVisible()
    await calendarDay(page.getByTestId('diary-calendar'), firstDate).click()
    await expect(page).toHaveURL(new RegExp(`/vault/${first.replace('/', '\\/')}(?:[?#]|$)`))
    await expect(page.locator('.reading-pane .article').first()).toContainText(`First Diary entry.`)
    await expect(page.locator('.tabs')).toBeHidden()
    await expect(page.locator('.editor-area')).toHaveClass(/is-no-tab-strip/)
    expect(await page.locator('.editor-area').evaluate((el) => getComputedStyle(el).gridTemplateRows.split(' ').length)).toBe(1)

    const filter = '2026-08'
    await page.locator('.file-tree .search-input').fill(filter)
    const secondRow = page.locator(`[data-tree-key="file:${second}"]`)
    await expect(secondRow).toBeVisible()
    await secondRow.locator('.row-line').click()

    await expect(page).toHaveURL(new RegExp(`/vault/${second.replace('/', '\\/')}(?:[?#]|$)`))
    await expect(page.locator('.reading-pane .article').first()).toContainText('Second Diary entry.')
    await expect(page.locator('.file-tree .search-input')).toHaveValue(filter)
    await expect(page.locator('.tabs')).toBeHidden()
    await expect(page.locator(`[role="tab"][data-tab-id="${first}"]`)).toHaveCount(0)
    await expect(page.locator(`[role="tab"][data-tab-id="${second}"]`)).toHaveCount(1)
    await expect(page.locator(`[role="tab"][data-tab-id="${noteA}"]`)).toHaveCount(1)
    await expect(page.locator(`[role="tab"][data-tab-id="${noteB}"]`)).toHaveCount(1)

    const diaryCyclePrevented = await page.locator('.vault').evaluate((element) => {
      const event = new KeyboardEvent('keydown', {
        key: 'Tab',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      })
      element.dispatchEvent(event)
      return event.defaultPrevented
    })
    expect(diaryCyclePrevented).toBe(false)
    await expect(page).toHaveURL(new RegExp(`/vault/${second.replace('/', '\\/')}(?:[?#]|$)`))

    await selectScope(page, 'note')
    await expect(page.locator('.tabs')).toBeVisible()
    await page.locator(`[role="tab"][data-tab-id="${noteA}"]`).click()
    const noteCyclePrevented = await page.locator('.vault').evaluate((element) => {
      const event = new KeyboardEvent('keydown', {
        key: 'Tab',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      })
      element.dispatchEvent(event)
      return event.defaultPrevented
    })
    expect(noteCyclePrevented).toBe(true)
    await expect(page).toHaveURL(new RegExp(`/vault/${noteB.replace('/', '\\/')}(?:[?#]|$)`))
    await expect(page.locator(`[role="tab"][data-tab-id="${noteA}"]`)).toHaveCount(1)
    await expect(page.locator(`[role="tab"][data-tab-id="${noteB}"]`)).toHaveCount(1)

    await selectScope(page, 'diary')
    await expect(page.getByTestId('diary-calendar')).toBeVisible()
    await expect(page.locator('.tabs')).toBeHidden()
    await expect(page.locator(`[role="tab"][data-tab-id="${second}"]`)).toHaveCount(1)
    await expect(page.locator(`[role="tab"][data-tab-id="${noteA}"]`)).toHaveCount(1)
    await expect(page.locator(`[role="tab"][data-tab-id="${noteB}"]`)).toHaveCount(1)

    await selectScope(page, 'note')
    await expect(page.locator('.file-tree .search-input')).toHaveValue(filter)
    await expect(page.locator('.tabs')).toBeVisible()
  } finally {
    for (const date of [firstDate, secondDate]) {
      const response = await request.delete(`/api/posts/${diaryPath(date)}`)
      expect([200, 404, 422]).toContain(response.status())
    }
    for (const path of [noteA, noteB]) {
      const response = await request.delete(`/api/posts/${path}`)
      expect([200, 404]).toContain(response.status())
    }
  }
})
