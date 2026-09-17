import { expect, test, type APIRequestContext, type Page } from './fixtures/diary'
import {
  CALENDAR_TEST_DATE,
  CALENDAR_TEST_MONTH,
  CALENDAR_TEST_TIME_ZONE,
  calendarDay,
  calendarMoodButton,
  freezeCalendarClock,
} from './helpers/calendar-clock'

const TEST_TIME_ZONE = CALENDAR_TEST_TIME_ZONE

test.use({
  timezoneId: TEST_TIME_ZONE,
  trace: 'off',
  screenshot: 'only-on-failure',
})

async function expectDiaryTestTimeZone(page: Page): Promise<void> {
  expect(
    await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
  ).toBe(TEST_TIME_ZONE)
}

function localCivilDate(): string {
  return CALENDAR_TEST_DATE
}

function nextCivilDate(value: string): string {
  const [yearText, monthText, dayText] = value.split('-')
  let year = Number(yearText)
  let month = Number(monthText)
  let day = Number(dayText) + 1
  const leap = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0)
  const daysInMonth = month === 2
    ? (leap ? 29 : 28)
    : [4, 6, 9, 11].includes(month) ? 30 : 31
  if (day > daysInMonth) {
    day = 1
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function previousCivilDate(value: string): string {
  const [yearText, monthText, dayText] = value.split('-')
  let year = Number(yearText)
  let month = Number(monthText)
  let day = Number(dayText) - 1
  if (day < 1) {
    month -= 1
    if (month < 1) {
      month = 12
      year -= 1
    }
    const leap = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0)
    day = month === 2
      ? (leap ? 29 : 28)
      : [4, 6, 9, 11].includes(month) ? 30 : 31
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function diaryPath(date: string): string {
  return `diary/${date}`
}

async function deleteDiaryDate(request: APIRequestContext, date: string): Promise<void> {
  const response = await request.delete(`/api/posts/${diaryPath(date)}`)
  expect([200, 404, 422]).toContain(response.status())
}

async function seedExistingDiary(request: APIRequestContext, date: string, raw: string): Promise<void> {
  await deleteDiaryDate(request, date)
  const created = await request.post('/api/diary/dates', {
    data: { date, timeZone: TEST_TIME_ZONE },
  })
  expect(created.status(), await created.text()).toBe(201)
  const saved = await request.put(`/api/posts/${diaryPath(date)}`, {
    data: { raw, baseRaw: `# ${date}\n` },
  })
  expect(saved.status(), await saved.text()).toBe(200)
}

async function setDiaryMood(request: APIRequestContext, date: string, mood: string | null): Promise<void> {
  const postResponse = await request.get(`/api/posts/${diaryPath(date)}`)
  expect(postResponse.status(), await postResponse.text()).toBe(200)
  const post = await postResponse.json() as { metadata: { updatedAt: number } }
  const response = await request.patch(`/api/metadata/documents/${diaryPath(date)}`, {
    data: { mood, expectedUpdatedAt: post.metadata.updatedAt },
  })
  expect(response.status(), await response.text()).toBe(200)
}

async function findUnusedDiaryDate(request: APIRequestContext): Promise<string> {
  let candidate = localCivilDate()
  for (let attempt = 0; attempt < 45; attempt += 1) {
    const response = await request.get(`/api/posts/${diaryPath(candidate)}`)
    if (response.status() === 404) return candidate
    expect(response.status(), await response.text()).toBe(200)
    candidate = previousCivilDate(candidate)
  }
  throw new Error('unable to find an unused Diary date for Mood-first regression')
}

async function moveCalendarToMonth(page: Page, date: string): Promise<void> {
  const calendar = page.getByTestId('diary-calendar')
  const targetMonth = date.slice(0, 7)
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const currentMonth = await calendar.getAttribute('data-month')
    if (currentMonth === targetMonth) {
      await expect(calendarDay(calendar, date)).toHaveCount(1)
      return
    }
    if (!currentMonth) throw new Error('Calendar did not expose its current month')
    await page.getByTestId(currentMonth < targetMonth ? 'diary-calendar-next' : 'diary-calendar-previous').click()
  }
  throw new Error(`Calendar did not reach ${targetMonth}`)
}

function browserDiagnostics(page: Page): {
  pageErrors: string[]
  consoleErrors: string[]
  notFoundResponses: Array<{ method: string; pathname: string; status: number }>
} {
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  const notFoundResponses: Array<{ method: string; pathname: string; status: number }> = []
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('response', (response) => {
    if (response.status() !== 404) return
    const url = new URL(response.url())
    notFoundResponses.push({
      method: response.request().method(),
      pathname: url.pathname,
      status: response.status(),
    })
  })
  return { pageErrors, consoleErrors, notFoundResponses }
}

test('Diary scope shows the Calendar-first surface and month navigation', async ({ page }) => {
  await page.goto('/vault')
  await expect(page.locator('.file-tree')).toBeVisible()
  await page.locator('.scope-chip').filter({ hasText: 'diary' }).click()

  const surface = page.getByTestId('diary-calendar-surface')
  const calendar = page.getByTestId('diary-calendar')
  await expect(surface).toBeVisible()
  await expect(calendar).toBeVisible()
  await expect(page.getByTestId('diary-calendar-surface-empty')).toHaveCount(0)

  const monthBefore = await calendar.getAttribute('data-month')
  expect(monthBefore).toBe(CALENDAR_TEST_MONTH)
  await page.getByTestId('diary-calendar-next').click()
  await expect(calendar).not.toHaveAttribute('data-month', monthBefore ?? '')
  await page.getByTestId('diary-calendar-previous').click()
  await expect(calendar).toHaveAttribute('data-month', monthBefore ?? '')

  await page.setViewportSize({ width: 375, height: 812 })
  await expect(surface).toBeVisible()
  // Phone-sized Diary Calendar-first mode gives the seven-column surface the
  // full primary width; the side panel is restored when leaving Diary or
  // opening a document.
  await expect(page.locator('.file-tree')).toBeHidden()
  await expect.poll(async () => page.evaluate(() => (
    document.documentElement.scrollWidth <= window.innerWidth + 1
  ))).toBe(true)
})

test('Calendar date identity stays stable through a frozen month boundary', async ({ page, request }) => {
  const edgeDate = '2026-08-31'

  try {
    await seedExistingDiary(request, edgeDate, '# Frozen month boundary\n')
    await freezeCalendarClock(page, '2026-08-31T12:00:00+08:00')
    await page.goto('/vault')
    await expect(page.locator('.file-tree')).toBeVisible()
    await page.locator('.scope-chip').filter({ hasText: 'diary' }).click()

    const calendar = page.getByTestId('diary-calendar')
    await expect(calendar).toHaveAttribute('data-month', '2026-08')
    await expect(calendarDay(calendar, edgeDate)).toHaveCount(1)

    await page.getByTestId('diary-calendar-next').click()
    await expect(calendar).toHaveAttribute('data-month', '2026-09')
    await page.getByTestId('diary-calendar-previous').click()
    await expect(calendar).toHaveAttribute('data-month', '2026-08')

    const edgeDay = calendarDay(calendar, edgeDate)
    await expect(edgeDay).toHaveCount(1)
    await edgeDay.click()
    await expect(page).toHaveURL(/\/vault\/diary\/2026-08-31(?:[?#]|$)/)
  } finally {
    await deleteDiaryDate(request, edgeDate)
  }
})

test('Calendar year navigation remains deterministic at a frozen December boundary', async ({ page }) => {
  await freezeCalendarClock(page, '2026-12-31T12:00:00+08:00')
  await page.goto('/vault')
  await expect(page.locator('.file-tree')).toBeVisible()
  await page.locator('.scope-chip').filter({ hasText: 'diary' }).click()

  const calendar = page.getByTestId('diary-calendar')
  await expect(calendar).toHaveAttribute('data-month', '2026-12')
  await expect(calendarDay(calendar, '2026-12-31')).toHaveCount(1)
  await page.getByTestId('diary-calendar-next').click()
  await expect(calendar).toHaveAttribute('data-month', '2027-01')
  await expect(calendarDay(calendar, '2027-01-01')).toHaveCount(1)
  await page.getByTestId('diary-calendar-previous').click()
  await expect(calendar).toHaveAttribute('data-month', '2026-12')
  await expect(calendarDay(calendar, '2026-12-31')).toHaveCount(1)
})

test('Calendar click opens an existing Diary through the native Vault reading surface', async ({ page, request }) => {
  const date = localCivilDate()
  const path = diaryPath(date)
  const raw = '# Existing Diary\n\nD4 lifecycle integration evidence.\n'
  const diagnostics = browserDiagnostics(page)
  const createMethods: string[] = []
  page.on('request', (requestEvent) => {
    const url = new URL(requestEvent.url())
    if (url.pathname === '/api/diary/dates') createMethods.push(requestEvent.method())
  })

  try {
    await seedExistingDiary(request, date, raw)
    await page.goto('/vault')
    await expect(page.locator('.file-tree')).toBeVisible()
    await page.locator('.scope-chip').filter({ hasText: 'diary' }).click()

    const surface = page.getByTestId('diary-calendar-surface')
    await expect(surface).toBeVisible()
    const dateButton = calendarDay(surface, date)
    await expect(dateButton).toBeVisible()
    const unsetMoodButton = calendarMoodButton(surface, date)
    await expect(unsetMoodButton).toHaveCount(1)
    await expect(unsetMoodButton).toHaveText('?')
    await unsetMoodButton.click()
    await expect(page.getByTestId('diary-mood-picker')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('diary-mood-picker')).toHaveCount(0)
    await dateButton.click()

    await expect(page).toHaveURL(new RegExp(`/vault/${path.replace('/', '\\/')}(?:[?#]|$)`), { timeout: 15_000 })
    const tab = page.locator(`[role="tab"][data-tab-id="${path}"]`)
    await expect(tab).toHaveCount(1)
    await expect(tab).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('diary-reader-dialog')).toHaveCount(0)
    await expect(page.locator('.reading-pane .article').first())
      .toContainText('D4 lifecycle integration evidence.', { timeout: 15_000 })
    await expect(page.locator('.reading-pane')).toHaveCount(1)
    await expect(page.locator('.file-tree')).toBeVisible()
    await expect(page.locator('.search-input')).toHaveValue(date)

    const calendar = page.getByTestId('diary-calendar')
    await expect(calendar).toBeAttached()
    await expect(calendar).toBeHidden()

    expect(createMethods).toEqual([])
    expect((await request.get(`/api/posts/${diaryPath(`${date}-2`)}`)).status()).toBe(404)

    await tab.locator('.tab-close').click()
    await expect(tab).toHaveCount(0)
    await expect(calendar).toBeVisible()
    await expect(page).toHaveURL(/\/vault(?:[?#]|$)/)
  } finally {
    await deleteDiaryDate(request, date)
  }

  expect(diagnostics.pageErrors).toEqual([])
  expect(diagnostics.consoleErrors).toEqual([])
  expect(diagnostics.notFoundResponses).toEqual([])
})

test('Calendar Mood picker closes before existing-date navigation hides Calendar Home', async ({ page, request }) => {
  const date = localCivilDate()
  const dayOfMonth = Number(date.slice(8))
  const neighbor = dayOfMonth > 1
    ? `${date.slice(0, 8)}01`
    : previousCivilDate(date)
  const raw = '# Calendar navigation\n\nExisting Diary navigation evidence.\n'

  try {
    await seedExistingDiary(request, date, raw)
    await setDiaryMood(request, date, 'happy')
    await seedExistingDiary(request, neighbor, raw)
    await page.goto('/vault')
    await expect(page.locator('.file-tree')).toBeVisible()
    await page.locator('.scope-chip').filter({ hasText: 'diary' }).click()

    const surface = page.getByTestId('diary-calendar-surface')
    const moodButton = calendarMoodButton(surface, date)
    await moodButton.click()
    const picker = page.getByTestId('diary-mood-picker')
    await expect(picker).toBeVisible()

    await calendarDay(surface, neighbor).click()
    await expect(page).toHaveURL(new RegExp(`/vault/diary/${neighbor.replace('-', '\\-')}`))
    await expect(picker).toHaveCount(0)
  } finally {
    await deleteDiaryDate(request, date)
    await deleteDiaryDate(request, neighbor)
  }
})

test('Calendar Mood picker closes when month navigation changes the Calendar context', async ({ page, request }) => {
  const date = localCivilDate()
  const raw = '# Calendar month navigation\n\nExisting Diary month evidence.\n'

  try {
    await seedExistingDiary(request, date, raw)
    await setDiaryMood(request, date, 'happy')
    await page.goto('/vault')
    await expect(page.locator('.file-tree')).toBeVisible()
    await page.locator('.scope-chip').filter({ hasText: 'diary' }).click()

    const surface = page.getByTestId('diary-calendar-surface')
    await calendarMoodButton(surface, date).click()
    const picker = page.getByTestId('diary-mood-picker')
    await expect(picker).toBeVisible()

    const calendar = page.getByTestId('diary-calendar')
    const monthBefore = await calendar.getAttribute('data-month')
    await page.getByTestId('diary-calendar-next').click()
    await expect(calendar).not.toHaveAttribute('data-month', monthBefore ?? '')
    await expect(picker).toHaveCount(0)
  } finally {
    await deleteDiaryDate(request, date)
  }
})

test('Calendar click on a missing future Diary is a browser-visible no-op', async ({ page, request }) => {
  const today = localCivilDate()
  const future = nextCivilDate(today)
  const futurePath = diaryPath(future)
  const diagnostics = browserDiagnostics(page)
  const createMethods: string[] = []
  page.on('request', (requestEvent) => {
    const url = new URL(requestEvent.url())
    if (url.pathname === '/api/diary/dates') createMethods.push(requestEvent.method())
  })

  try {
    await deleteDiaryDate(request, future)
    await page.goto('/vault')
    await expect(page.locator('.file-tree')).toBeVisible()
    await page.locator('.scope-chip').filter({ hasText: 'diary' }).click()

    const surface = page.getByTestId('diary-calendar-surface')
    await expect(surface).toBeVisible()
    const routeBefore = new URL(page.url()).pathname
    const tabsBefore = await page.locator('.tabs').count()
    await moveCalendarToMonth(page, future)
    const dateButton = calendarDay(surface, future)
    await expect(dateButton).toBeVisible()
    const probeResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return response.request().method() === 'GET'
        && url.pathname === `/api/posts/${futurePath}`
    })
    await dateButton.click()
    expect((await probeResponse).status()).toBe(404)
    await expect.poll(() => createMethods).toEqual([])

    expect(new URL(page.url()).pathname).toBe(routeBefore)
    expect(await page.locator('.tabs').count()).toBe(tabsBefore)
    expect((await request.get(`/api/posts/${futurePath}`)).status()).toBe(404)
  } finally {
    await deleteDiaryDate(request, future)
  }

  expect(diagnostics.pageErrors).toEqual([])
  expect(diagnostics.consoleErrors).toEqual([
    'Failed to load resource: the server responded with a status of 404 (Not Found)',
  ])
  expect(diagnostics.notFoundResponses).toEqual([{
    method: 'GET',
    pathname: `/api/posts/${futurePath}`,
    status: 404,
  }])
})

test('missing future Diary does not overwrite the user FileTree filter', async ({ page, request }) => {
  await expectDiaryTestTimeZone(page)
  const today = localCivilDate()
  const future = nextCivilDate(today)
  const futurePath = diaryPath(future)
  const customQuery = `d74-r2-query-${Date.now()}`
  const diagnostics = browserDiagnostics(page)
  const mutationRequests: string[] = []
  page.on('request', (requestEvent) => {
    const url = new URL(requestEvent.url())
    if (url.pathname === '/api/diary/dates' || url.pathname === `/api/metadata/documents/${futurePath}`) {
      mutationRequests.push(`${requestEvent.method()} ${url.pathname}`)
    }
  })

  try {
    await deleteDiaryDate(request, future)
    await page.goto('/vault')
    await expect(page.locator('.file-tree')).toBeVisible()
    const search = page.locator('.file-tree .search-input')
    await search.fill(customQuery)
    await expect(search).toHaveValue(customQuery)
    await expect.poll(() => page.evaluate(() => localStorage.getItem('nuvyn.file-tree.filter')))
      .toBe(customQuery)
    await page.locator('.scope-chip').filter({ hasText: 'diary' }).click()

    const routeBefore = new URL(page.url()).pathname
    const dateButton = calendarDay(page.getByTestId('diary-calendar'), future)
    await moveCalendarToMonth(page, future)
    await expect(dateButton).toBeVisible()
    const probeResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return response.request().method() === 'GET'
        && url.pathname === `/api/posts/${futurePath}`
    })
    await dateButton.click()
    expect((await probeResponse).status()).toBe(404)

    await expect.poll(() => mutationRequests).toEqual([])
    // Calendar Home intentionally occupies the full workspace without the
    // explorer sidebar. The user-owned filter still remains persisted for
    // when the explorer is restored after leaving Calendar.
    await expect(search).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => localStorage.getItem('nuvyn.file-tree.filter')))
      .toBe(customQuery)
    await expect(page).toHaveURL(new RegExp(`${routeBefore.replace('/', '\\/')}(?:[?#]|$)`))
    await expect(page.getByTestId('diary-calendar')).toBeVisible()
    await expect(page.getByTestId('diary-mood-picker')).toHaveCount(0)
    await expect(page.locator(`[role="tab"][data-tab-id="${futurePath}"]`)).toHaveCount(0)
  } finally {
    await deleteDiaryDate(request, future)
  }

  expect(diagnostics.pageErrors).toEqual([])
  expect(diagnostics.consoleErrors).toEqual([
    'Failed to load resource: the server responded with a status of 404 (Not Found)',
  ])
})

test('Mood-first creation keeps Calendar visible until Mood CAS succeeds', async ({ page, request }) => {
  await expectDiaryTestTimeZone(page)
  const date = await findUnusedDiaryDate(request)
  const path = diaryPath(date)
  let patchAttempts = 0
  let releaseBlockedPatch!: () => void
  let markPatchStarted!: () => void
  const patchStarted = new Promise<void>((resolve) => { markPatchStarted = resolve })
  const blockedPatch = new Promise<void>((resolve) => { releaseBlockedPatch = resolve })
  const moodRoute = `**/api/metadata/documents/${path}`

  await page.route(moodRoute, async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.continue()
      return
    }
    patchAttempts += 1
    if (patchAttempts === 1) {
      markPatchStarted()
      await blockedPatch
      try {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'D7.4 forced Mood CAS failure' }),
        })
      } catch {
        // If the assertion above fails, Playwright may dispose the request
        // before the gate is released. Keep that teardown race from masking
        // the intended pre-fix presentation failure.
      }
      return
    }
    await route.continue()
  })

  try {
    await page.goto('/vault')
    await expect(page.locator('.file-tree')).toBeVisible()
    await page.locator('.scope-chip').filter({ hasText: 'diary' }).click()
    const surface = page.getByTestId('diary-calendar-surface')
    await expect(surface).toBeVisible()
    await moveCalendarToMonth(page, date)

    const dateButton = calendarDay(surface, date)
    await expect(dateButton).toBeVisible()
    await dateButton.click()
    const picker = page.getByTestId('diary-mood-picker')
    await expect(picker).toBeVisible()
    expect((await request.get(`/api/posts/${path}`)).status()).toBe(404)

    await picker.getByRole('radio', { name: '开心 / Happy' }).click()
    await patchStarted

    try {
      await expect(surface).toBeVisible()
      await expect(page).toHaveURL(/\/vault(?:[?#]|$)/)
      await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveCount(0)
    } finally {
      releaseBlockedPatch()
    }

    await expect.poll(() => patchAttempts).toBe(1)
    await expect(surface).toBeVisible()
    const created = await request.get(`/api/posts/${path}`)
    expect(created.status(), await created.text()).toBe(200)
    const createdBody = await created.json() as { metadata?: { mood?: string | null } }
    expect(createdBody.metadata?.mood ?? null).toBeNull()

    const repairMood = calendarMoodButton(surface, date)
    await expect(repairMood).toHaveText('?')
    await repairMood.click()
    await expect(page.getByTestId('diary-mood-picker')).toBeVisible()
    await page.getByTestId('diary-mood-picker').getByRole('radio', { name: '开心 / Happy' }).click()
    await expect.poll(async () => {
      const response = await request.get(`/api/posts/${path}`)
      if (response.status() !== 200) return null
      const body = await response.json() as { metadata?: { mood?: string | null } }
      return body.metadata?.mood ?? null
    }).toBe('happy')
    await expect(page).toHaveURL(new RegExp(`/vault/${path.replace('/', '\\/')}(?:[?#]|$)`))
    await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveAttribute('aria-selected', 'true')
    await expect(surface).toBeHidden()
    await expect(page.locator('.search-input')).toHaveValue(date)
  } finally {
    await page.unroute(moodRoute)
    await deleteDiaryDate(request, date)
  }
})

test('failed Mood-first repair intent is invalidated by explicit Diary navigation', async ({ page, request }) => {
  await expectDiaryTestTimeZone(page)
  const date = await findUnusedDiaryDate(request)
  const path = diaryPath(date)
  let patchAttempts = 0
  let releaseBlockedPatch!: () => void
  let markPatchStarted!: () => void
  const patchStarted = new Promise<void>((resolve) => { markPatchStarted = resolve })
  const blockedPatch = new Promise<void>((resolve) => { releaseBlockedPatch = resolve })
  const moodRoute = `**/api/metadata/documents/${path}`
  const diagnostics = browserDiagnostics(page)

  await page.route(moodRoute, async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.continue()
      return
    }
    patchAttempts += 1
    if (patchAttempts === 1) {
      markPatchStarted()
      await blockedPatch
      try {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'D7.4 forced Mood CAS failure' }),
        })
      } catch {
        // If the assertion above fails, Playwright may dispose the request
        // before the gate is released. Keep that teardown race from masking
        // the intended pre-fix lifecycle failure.
      }
      return
    }
    await route.continue()
  })

  try {
    await page.goto('/vault')
    await expect(page.locator('.file-tree')).toBeVisible()
    await page.locator('.scope-chip').filter({ hasText: 'diary' }).click()
    const surface = page.getByTestId('diary-calendar-surface')
    await expect(surface).toBeVisible()
    await moveCalendarToMonth(page, date)

    const dateButton = calendarDay(surface, date)
    await expect(dateButton).toBeVisible()
    await dateButton.click()
    const picker = page.getByTestId('diary-mood-picker')
    await expect(picker).toBeVisible()
    await picker.getByRole('radio', { name: '开心 / Happy' }).click()
    await patchStarted
    releaseBlockedPatch()

    await expect.poll(() => patchAttempts).toBe(1)
    await expect(surface).toBeVisible()
    await expect(page).toHaveURL(/\/vault(?:[?#]|$)/)
    await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveCount(0)
    const created = await request.get(`/api/posts/${path}`)
    expect(created.status(), await created.text()).toBe(200)
    const createdBody = await created.json() as { metadata?: { mood?: string | null } }
    expect(createdBody.metadata?.mood ?? null).toBeNull()

    const repairMood = calendarMoodButton(surface, date)
    await expect(repairMood).toHaveText('?')

    // Explicit date navigation abandons the failed repair intent. Closing the
    // native tab returns to Calendar Home without changing that ownership.
    await dateButton.click()
    await expect(page).toHaveURL(new RegExp(`/vault/${path.replace('/', '\\/')}(?:[?#]|$)`))
    const tab = page.locator(`[role="tab"][data-tab-id="${path}"]`)
    await expect(tab).toHaveAttribute('aria-selected', 'true')
    await tab.locator('.tab-close').click()
    await expect(tab).toHaveCount(0)
    await expect(surface).toBeVisible()
    await expect(page).toHaveURL(/\/vault(?:[?#]|$)/)

    // This is now an ordinary existing-Diary Mood edit. It must persist the
    // Mood while staying on Calendar Home; the old failed create cannot make
    // this later edit reopen the Native Diary.
    await repairMood.click()
    await expect(picker).toBeVisible()
    await picker.getByRole('radio', { name: '开心 / Happy' }).click()
    await expect.poll(async () => {
      const response = await request.get(`/api/posts/${path}`)
      if (response.status() !== 200) return null
      const body = await response.json() as { metadata?: { mood?: string | null } }
      return body.metadata?.mood ?? null
    }).toBe('happy')
    await expect(picker).toHaveCount(0)
    await expect(surface).toBeVisible()
    await expect(page).toHaveURL(/\/vault(?:[?#]|$)/)
    await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveCount(0)
  } finally {
    await page.unroute(moodRoute)
    await deleteDiaryDate(request, date)
  }

  expect(diagnostics.pageErrors).toEqual([])
  expect(diagnostics.consoleErrors).toEqual([
    'Failed to load resource: the server responded with a status of 404 (Not Found)',
    'Failed to load resource: the server responded with a status of 500 (Internal Server Error)',
  ])
  expect(diagnostics.notFoundResponses).toEqual([{
    method: 'GET',
    pathname: `/api/posts/${path}`,
    status: 404,
  }])
})

test('missing today and past dates require Mood before create and then open the native Diary', async ({ page, request }) => {
  await expectDiaryTestTimeZone(page)
  const today = localCivilDate()
  const past = previousCivilDate(today)
  const dates = [today, past]
  const createMethods: string[] = []
  page.on('request', (requestEvent) => {
    const url = new URL(requestEvent.url())
    if (url.pathname === '/api/diary/dates') createMethods.push(requestEvent.method())
  })

  async function readMood(date: string): Promise<string | null> {
    const response = await request.get(`/api/posts/${diaryPath(date)}`)
    if (response.status() !== 200) {
      await response.text()
      return null
    }
    const body = await response.json() as { metadata?: { mood?: string | null } }
    return body.metadata?.mood ?? null
  }

  try {
    for (const date of dates) await deleteDiaryDate(request, date)
    await page.goto('/vault')
    await expect(page.locator('.file-tree')).toBeVisible()
    await page.locator('.scope-chip').filter({ hasText: 'diary' }).click()

    const surface = page.getByTestId('diary-calendar-surface')
    for (const date of dates) {
      const dateButton = calendarDay(surface, date)
      await expect(dateButton).toBeVisible()
      await dateButton.click()
      const picker = page.getByTestId('diary-mood-picker')
      await expect(picker).toBeVisible()
      expect((await request.get(`/api/posts/${diaryPath(date)}`)).status()).toBe(404)
      await picker.getByRole('radio', { name: '开心 / Happy' }).click()
      await expect.poll(() => readMood(date)).toBe('happy')
      await expect(picker).toHaveCount(0)
      await expect(page).toHaveURL(new RegExp(`/vault/diary/${date}`))
      await expect(surface).toBeHidden()
      await expect(page.locator(`[role="tab"][data-tab-id="${diaryPath(date)}"]`)).toHaveAttribute('aria-selected', 'true')
      await expect(page.locator('.search-input')).toHaveValue(date)
      const tab = page.locator(`[role="tab"][data-tab-id="${diaryPath(date)}"]`)
      await tab.locator('.tab-close').click()
      await expect(tab).toHaveCount(0)
      await expect(surface).toBeVisible()
      await expect(page).toHaveURL(/\/vault(?:[?#]|$)/)
    }
  } finally {
    for (const date of dates) await deleteDiaryDate(request, date)
  }

  expect(createMethods).toEqual(['POST', 'POST'])
})

test('cancelling Mood-first creation leaves a missing date untouched', async ({ page, request }) => {
  await expectDiaryTestTimeZone(page)
  const date = localCivilDate()
  const path = diaryPath(date)
  const createMethods: string[] = []
  page.on('request', (requestEvent) => {
    if (new URL(requestEvent.url()).pathname === '/api/diary/dates') createMethods.push(requestEvent.method())
  })

  try {
    await deleteDiaryDate(request, date)
    await page.goto('/vault')
    await page.locator('.scope-chip').filter({ hasText: 'diary' }).click()
    const surface = page.getByTestId('diary-calendar-surface')
    await calendarDay(surface, date).click()
    const picker = page.getByTestId('diary-mood-picker')
    await expect(picker).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(picker).toHaveCount(0)
    expect((await request.get(`/api/posts/${path}`)).status()).toBe(404)
    expect(createMethods).toEqual([])
  } finally {
    await deleteDiaryDate(request, date)
  }
})

test('Calendar Mood emoji is the only picker entry and never navigates the date', async ({ page, request }) => {
  const date = localCivilDate()
  const path = diaryPath(date)
  const raw = '# Calendar Mood\n\nCalendar integration evidence.\n'
  const diagnostics = browserDiagnostics(page)
  const createMethods: string[] = []
  const dateNavigationRequests: string[] = []
  page.on('request', (requestEvent) => {
    const url = new URL(requestEvent.url())
    if (url.pathname === '/api/diary/dates') createMethods.push(requestEvent.method())
    if (url.pathname === `/api/posts/${path}`) dateNavigationRequests.push(requestEvent.method())
  })

  async function readMood(): Promise<string | null> {
    const response = await request.get(`/api/posts/${path}`)
    expect(response.status(), await response.text()).toBe(200)
    const body = await response.json() as { metadata?: { mood?: string | null } }
    return body.metadata?.mood ?? null
  }

  try {
    await seedExistingDiary(request, date, raw)
    await setDiaryMood(request, date, 'sad')
    await page.goto('/vault')
    await expect(page.locator('.file-tree')).toBeVisible()
    await page.locator('.scope-chip').filter({ hasText: 'diary' }).click()

    const surface = page.getByTestId('diary-calendar-surface')
    const moodButton = calendarMoodButton(surface, date)
    await expect(moodButton).toBeVisible()
    await expect(moodButton).toBeEnabled()
    await expect(moodButton.locator('img')).toHaveCount(1)
    expect(await surface.locator('button button').count()).toBe(0)
    await expect(surface.locator('text=+')).toHaveCount(0)
    await expect(surface.locator('text=✎')).toHaveCount(0)

    const dateButton = calendarDay(surface, date)
    await expect(dateButton.locator('[data-testid="diary-calendar-mood"]')).toHaveCount(0)
    const hoverBox = await dateButton.boundingBox()
    expect(hoverBox).not.toBeNull()
    await dateButton.hover({ position: { x: hoverBox!.width / 2, y: 4 } })
    expect(await dateButton.evaluate((element) => getComputedStyle(element).boxShadow)).toBe('none')
    await moodButton.hover()
    expect(await moodButton.evaluate((element) => getComputedStyle(element).boxShadow)).toBe('none')

    await moodButton.click()
    const picker = page.getByTestId('diary-mood-picker')
    await expect(picker).toBeVisible()
    await expect(picker.locator('[role="radio"]')).toHaveCount(24)
    await expect(moodButton).toHaveAttribute('aria-expanded', 'true')
    await picker.getByRole('radio', { name: '开心 / Happy' }).click()

    await expect.poll(() => readMood()).toBe('happy')
    await expect(picker).toHaveCount(0)
    await expect(moodButton.locator('img')).toHaveAttribute('src', '/emoji/开心.svg')

    for (const viewport of [{ width: 1280, height: 720 }, { width: 375, height: 812 }, { width: 320, height: 700 }]) {
      await page.setViewportSize(viewport)
      await expect(surface).toBeVisible()
      const dateBox = await calendarDay(surface, date).boundingBox()
      const moodBox = await moodButton.boundingBox()
      expect(dateBox).not.toBeNull()
      expect(moodBox).not.toBeNull()
      expect(moodBox!.x + moodBox!.width / 2).toBeCloseTo(dateBox!.x + dateBox!.width / 2, 0)
      expect(moodBox!.y + moodBox!.height / 2).toBeGreaterThan(dateBox!.y + dateBox!.height / 2)
      expect(
        dateBox!.y + dateBox!.height,
        `${JSON.stringify({ viewport, dateBox, moodBox })}`,
      ).toBeLessThanOrEqual(moodBox!.y + 0.01)
    }
    await page.setViewportSize({ width: 1280, height: 720 })
    expect(createMethods).toEqual([])
    expect(new URL(page.url()).pathname).toBe('/vault')
    expect(dateNavigationRequests).toEqual([])

    await moodButton.click()
    await expect(page.getByTestId('diary-mood-picker')).toBeVisible()
    await page.getByTestId('diary-mood-picker').getByTestId('diary-mood-clear').click()
    await expect.poll(() => readMood()).toBeNull()
    await expect(page.getByTestId('diary-mood-picker')).toHaveCount(0)
    const clearedMoodButton = calendarMoodButton(surface, date)
    await expect(clearedMoodButton).toHaveCount(1)
    await expect(clearedMoodButton).toHaveText('?')
    await clearedMoodButton.click()
    await expect(page.getByTestId('diary-mood-picker')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('diary-mood-picker')).toHaveCount(0)
  } finally {
    await deleteDiaryDate(request, date)
  }

  expect(diagnostics.pageErrors).toEqual([])
  expect(diagnostics.consoleErrors).toEqual([])
  expect(diagnostics.notFoundResponses).toEqual([])
})
