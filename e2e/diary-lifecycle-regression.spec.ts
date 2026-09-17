import { expect, test, type APIRequestContext, type Page } from './fixtures/diary'
import { clearDraftDatabase, gotoVaultReady } from './helpers/edit-program'
import { CALENDAR_TEST_DATE, CALENDAR_TEST_TIME_ZONE, calendarDay } from './helpers/calendar-clock'

const TEST_TIME_ZONE = CALENDAR_TEST_TIME_ZONE
const RUN_ID = String(Date.now())

test.use({ timezoneId: TEST_TIME_ZONE, trace: 'off', screenshot: 'only-on-failure' })

function civilParts(value: string): { year: number; month: number; day: number } {
  const [year, month, day] = value.split('-').map(Number)
  return { year, month, day }
}

function daysInMonth(year: number, month: number): number {
  const leap = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0)
  if (month === 2) return leap ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

function localCivilDate(): string {
  return CALENDAR_TEST_DATE
}

function shiftCivilDate(value: string, amount: -1 | 1): string {
  let { year, month, day } = civilParts(value)
  day += amount
  if (day > daysInMonth(year, month)) {
    day = 1
    month += 1
    if (month > 12) { month = 1; year += 1 }
  } else if (day === 0) {
    month -= 1
    if (month === 0) { month = 12; year -= 1 }
    day = daysInMonth(year, month)
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function diaryPath(date: string): string {
  return `diary/${date}`
}

async function deletePost(request: APIRequestContext, path: string): Promise<void> {
  const response = await request.delete(`/api/posts/${path}`)
  expect(path.startsWith('diary/') ? [200, 404, 422] : [200, 404]).toContain(response.status())
}

async function seedDiary(request: APIRequestContext, date: string, raw: string): Promise<string> {
  await deletePost(request, diaryPath(date))
  const created = await request.post('/api/diary/dates', {
    data: { date, timeZone: TEST_TIME_ZONE },
  })
  expect(created.status(), await created.text()).toBe(201)

  const path = diaryPath(date)
  const initial = await request.get(`/api/posts/${path}`)
  expect(initial.status()).toBe(200)
  const initialBody = await initial.json() as { raw: string }
  const saved = await request.put(`/api/posts/${path}`, {
    data: { raw, baseRaw: initialBody.raw },
  })
  expect(saved.status(), await saved.text()).toBe(200)

  const detail = await request.get(`/api/posts/${path}`)
  expect(detail.status()).toBe(200)
  const body = await detail.json() as { metadata?: { id?: string } }
  expect(body.metadata?.id).toEqual(expect.any(String))
  return body.metadata!.id!
}

async function seedNote(request: APIRequestContext, path: string, raw: string): Promise<void> {
  await deletePost(request, path)
  const created = await request.post('/api/posts', {
    data: { path, title: path.split('/').at(-1) },
  })
  expect([200, 201]).toContain(created.status())
  const initial = await request.get(`/api/posts/${path}`)
  expect(initial.status()).toBe(200)
  const initialBody = await initial.json() as { raw: string }
  const saved = await request.put(`/api/posts/${path}`, {
    data: { raw, baseRaw: initialBody.raw },
  })
  expect(saved.status(), await saved.text()).toBe(200)
}

function diagnostics(page: Page): { pageErrors: string[]; consoleErrors: string[] } {
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  return { pageErrors, consoleErrors }
}

async function selectScope(page: Page, scope: 'note' | 'diary'): Promise<void> {
  const chip = page.locator('.scope-chip').filter({ hasText: scope })
  if (await chip.getAttribute('aria-pressed') !== 'true') await chip.click()
}

async function openDiaryHome(page: Page): Promise<void> {
  await page.goto('/vault')
  await selectScope(page, 'diary')
  await expect(page.getByTestId('diary-calendar-surface')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('diary-calendar')).toBeVisible()
}

async function ensureExplorerVisible(page: Page): Promise<void> {
  const fileTree = page.locator('.file-tree')
  if (!(await fileTree.isVisible())) {
    const explorer = page.locator('button.ab-btn[aria-label^="Explorer"], button.ab-btn[aria-label^="文件资源管理器"]').first()
    await expect(explorer).toBeVisible()
    if (await explorer.getAttribute('aria-pressed') !== 'true') await explorer.click()
  }
  await expect(fileTree).toBeVisible({ timeout: 15_000 })
}

async function moveToMonth(page: Page, date: string): Promise<void> {
  const targetMonth = date.slice(0, 7)
  const calendar = page.getByTestId('diary-calendar')
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const currentMonth = await calendar.getAttribute('data-month')
    if (currentMonth === targetMonth) return
    if (!currentMonth) throw new Error('Calendar did not expose its current month')
    await page.getByTestId(currentMonth < targetMonth ? 'diary-calendar-next' : 'diary-calendar-previous').click()
  }
  throw new Error(`Calendar did not reach ${targetMonth}`)
}

async function clickDiaryDate(page: Page, date: string): Promise<void> {
  await moveToMonth(page, date)
  const button = calendarDay(page.getByTestId('diary-calendar'), date)
  await expect(button).toBeVisible()
  await button.click()
}

async function assertDiaryHome(page: Page): Promise<void> {
  await expect(page.getByTestId('diary-workspace-shell')).toHaveAttribute('data-presentation-mode', 'home')
  await expect(page.getByTestId('diary-calendar')).toBeVisible()
  // Calendar Home is a full-viewport presentation, so the workspace sidebar
  // is intentionally absent until a native document is opened.
  await expect(page.locator('.activity-bar')).toHaveCount(0)
  await expect(page.locator('.file-tree')).toHaveCount(0)
}

async function assertNativeDiary(page: Page, date: string, expectedFilter?: string): Promise<void> {
  const path = diaryPath(date)
  await expect(page).toHaveURL(new RegExp(`/vault/${path.replace('/', '\\/')}(?:[?#]|$)`))
  await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveCount(1)
  await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.reading-pane')).toHaveCount(1)
  await expect(page.locator('.reading-pane')).toBeVisible()
  await ensureExplorerVisible(page)
  if (expectedFilter !== undefined) await expect(page.locator('.search-input')).toHaveValue(expectedFilter)
  await expect(page.getByTestId('diary-calendar')).toBeAttached()
  await expect(page.getByTestId('diary-calendar')).toBeHidden()
}

async function openNote(page: Page, path: string): Promise<void> {
  await selectScope(page, 'note')
  await ensureExplorerVisible(page)
  const row = page.locator(`[data-tree-key="file:${path}"]`)
  if (!(await row.isVisible())) {
    const folder = page.locator(`[data-tree-key="folder:${path.split('/')[0]}"]`)
    await expect(folder).toBeVisible()
    await folder.locator('.row-line').click()
    await expect(row).toBeVisible()
  }
  // The filename button is intentionally hidden when the note title is the
  // filename. Activate the row's visible line so this helper exercises the
  // same FileTree selection path regardless of title presentation.
  await row.locator('.row-line').click()
  await expect(page).toHaveURL(new RegExp(`/vault/${path.replace('/', '\\/')}(?:[?#]|$)`))
  await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveAttribute('aria-selected', 'true')
}

async function selectTab(page: Page, path: string): Promise<void> {
  const tab = page.locator(`[role="tab"][data-tab-id="${path}"]`)
  await expect(tab).toBeVisible()
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
}

test.beforeEach(async ({ page }) => {
  await page.goto('/__markdown-test?mode=reading')
  await page.evaluate(() => localStorage.clear())
  await clearDraftDatabase(page)
  await gotoVaultReady(page)
})

test('scope exit and re-entry preserve the document lifecycle without reopening Diary presentation', async ({ page, request }) => {
  const date = localCivilDate()
  const path = diaryPath(date)
  const state = diagnostics(page)
  try {
    await seedDiary(request, date, `# Scope regression ${RUN_ID}\n`)
    await openDiaryHome(page)
    await clickDiaryDate(page, date)
    await assertNativeDiary(page, date)
    const routeBefore = new URL(page.url()).pathname

    await selectScope(page, 'note')
    await expect(page.getByTestId('diary-calendar')).toHaveCount(0)
    await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveCount(1)
    expect(new URL(page.url()).pathname).toBe(routeBefore)

    await selectScope(page, 'diary')
    await expect(page.getByTestId('diary-calendar')).toBeHidden()
    await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveCount(1)

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await selectScope(page, 'note')
      await expect(page.getByTestId('diary-calendar')).toHaveCount(0)
      await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveCount(1)
      await selectScope(page, 'diary')
      await assertNativeDiary(page, date)
    }
  } finally {
    await deletePost(request, path)
  }
  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test('manual multi-tab selection cannot synthesize Calendar intent or retarget the user filter', async ({ page, request }) => {
  const today = localCivilDate()
  const dates = [today, shiftCivilDate(today, -1)]
  const paths = dates.map(diaryPath)
  const note = `inbox/d65-manual-${RUN_ID}`
  const filterValue = `d65-${RUN_ID}`
  const state = diagnostics(page)
  try {
    await seedDiary(request, dates[0], `# Diary A ${RUN_ID}\n`)
    await seedDiary(request, dates[1], `# Diary B ${RUN_ID}\n`)
    await seedNote(request, note, `# Note ${RUN_ID}\n`)
    await openDiaryHome(page)
    await clickDiaryDate(page, dates[0])
    await assertNativeDiary(page, dates[0])

    await openNote(page, note)
    await page.locator('.file-tree .search-input').fill(filterValue)
    await selectScope(page, 'diary')
    await expect(page.getByTestId('diary-calendar')).toBeHidden()

    await page.goto(`/vault/${paths[1]}`)
    await assertNativeDiary(page, dates[1], filterValue)
    await selectScope(page, 'note')
    await page.locator('.file-tree .search-input').fill(filterValue)
    await selectTab(page, note)
    expect(new URL(page.url()).pathname).toBe(`/vault/${note}`)
    await selectTab(page, paths[0])
    expect(new URL(page.url()).pathname).toBe(`/vault/${paths[0]}`)
    await expect(page.getByTestId('diary-calendar')).toHaveCount(0)

    await selectScope(page, 'diary')
    await expect(page.getByTestId('diary-calendar')).toBeHidden()

    await assertNativeDiary(page, dates[0])
    await selectScope(page, 'note')
    await ensureExplorerVisible(page)
    await page.locator('.file-tree .search-input').fill(filterValue)
    await expect(page.locator('.file-tree .search-input')).toHaveValue(filterValue)
    expect(await page.locator(`[role="tab"][data-tab-id="${paths[0]}"]`).count()).toBe(1)
    expect(await page.locator(`[role="tab"][data-tab-id="${paths[1]}"]`).count()).toBe(1)
    expect(await page.locator(`[role="tab"][data-tab-id="${note}"]`).count()).toBe(1)
  } finally {
    for (const path of [...paths, note]) await deletePost(request, path)
  }
  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test('tab close and reopen use existing fallback and stable document identity', async ({ page, request }) => {
  const date = localCivilDate()
  const path = diaryPath(date)
  const note = `inbox/d65-close-${RUN_ID}`
  const state = diagnostics(page)
  try {
    const documentId = await seedDiary(request, date, `# Close regression ${RUN_ID}\n`)
    await seedNote(request, note, `# Close fallback ${RUN_ID}\n`)
    await openDiaryHome(page)
    await clickDiaryDate(page, date)
    await assertNativeDiary(page, date)
    await openNote(page, note)
    await selectScope(page, 'diary')
    await selectTab(page, path)
    await assertNativeDiary(page, date)

    await selectScope(page, 'note')
    await page.locator(`[role="tab"][data-tab-id="${path}"] .tab-close`).click()
    await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveCount(0)
    await expect(page.locator(`[role="tab"][data-tab-id="${note}"]`)).toHaveAttribute('aria-selected', 'true')
    await expect(page).toHaveURL(new RegExp(`/vault/${note.replace('/', '\\/')}(?:[?#]|$)`))

    await selectScope(page, 'diary')
    await assertDiaryHome(page)
    await clickDiaryDate(page, date)
    await assertNativeDiary(page, date)
    await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveCount(1)
    const reopened = await request.get(`/api/posts/${path}`)
    expect((await reopened.json()).metadata.id).toBe(documentId)

    await selectScope(page, 'note')
    await page.locator(`[role="tab"][data-tab-id="${note}"] .tab-close`).click()
    await expect(page.locator(`[role="tab"][data-tab-id="${note}"]`)).toHaveCount(0)
    await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveAttribute('aria-selected', 'true')
    await page.locator(`[role="tab"][data-tab-id="${path}"] .tab-close`).click()
    await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveCount(0)
    await expect(page).toHaveURL(/\/vault(?:[?#]|$)/)

    await selectScope(page, 'diary')
    await assertDiaryHome(page)
  } finally {
    await deletePost(request, path)
    await deletePost(request, note)
  }
  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test('closing a non-active tab preserves Diary DOCUMENT and the user filter', async ({ page, request }) => {
  const date = localCivilDate()
  const path = diaryPath(date)
  const note = `inbox/d65-non-active-${RUN_ID}`
  const state = diagnostics(page)
  try {
    await seedDiary(request, date, `# Non-active close ${RUN_ID}\n`)
    await seedNote(request, note, `# Non-active note ${RUN_ID}\n`)
    await openDiaryHome(page)
    await clickDiaryDate(page, date)
    await assertNativeDiary(page, date)

    await openNote(page, note)
    await selectScope(page, 'diary')
    const filterValue = `d65-filter-${RUN_ID}`
    await page.locator('.file-tree .search-input').fill(filterValue)
    await selectTab(page, path)
    await assertNativeDiary(page, date)

    // The note tab is non-active while the Diary document remains active.
    await page.locator(`[role="tab"][data-tab-id="${note}"] .tab-close`).click()
    await expect(page.locator(`[role="tab"][data-tab-id="${note}"]`)).toHaveCount(0)
    await assertNativeDiary(page, date)
    await expect(page.locator('.search-input')).toHaveValue(filterValue)
  } finally {
    await deletePost(request, path)
    await deletePost(request, note)
  }
  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test('clean refresh restores unique tabs but not Diary DOCUMENT presentation', async ({ page, request }) => {
  const today = localCivilDate()
  const dates = [today, shiftCivilDate(today, -1)]
  const paths = dates.map(diaryPath)
  const note = `inbox/d65-refresh-${RUN_ID}`
  const state = diagnostics(page)
  try {
    await seedDiary(request, dates[0], `# Refresh A ${RUN_ID}\n`)
    await seedDiary(request, dates[1], `# Refresh B ${RUN_ID}\n`)
    await seedNote(request, note, `# Refresh Note ${RUN_ID}\n`)
    await openDiaryHome(page)
    await clickDiaryDate(page, dates[0])
    await assertNativeDiary(page, dates[0])
    await openNote(page, note)
    await selectScope(page, 'diary')
    await page.goto(`/vault/${paths[1]}`)
    await assertNativeDiary(page, dates[1])

    await page.reload()
    await expect(page.locator('.vault')).toBeVisible({ timeout: 15_000 })
    await expect.poll(async () => page.locator('[role="tab"][data-tab-id]').count(), { timeout: 15_000 }).toBe(3)
    await expect(page.locator(`[role="tab"][data-tab-id="${paths[0]}"]`)).toHaveCount(1)
    await expect(page.locator(`[role="tab"][data-tab-id="${paths[1]}"]`)).toHaveCount(1)
    await expect(page.locator(`[role="tab"][data-tab-id="${note}"]`)).toHaveCount(1)
    await expect(page.locator(`[role="tab"][data-tab-id="${paths[1]}"]`)).toHaveAttribute('aria-selected', 'true')
    await assertNativeDiary(page, dates[1])
    await expect(page.locator('[role="tab"][data-tab-id]')).toHaveCount(3)
  } finally {
    for (const path of [...paths, note]) await deletePost(request, path)
  }
  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test('direct Diary deep link opens the native Vault lifecycle without Calendar presentation', async ({ page, request }) => {
  const date = localCivilDate()
  const path = diaryPath(date)
  const state = diagnostics(page)
  try {
    await seedDiary(request, date, `# Deep link ${RUN_ID}\n`)
    await page.evaluate(() => localStorage.setItem('nuvyn.vault.activeScope', 'diary'))
    await page.goto(`/vault/${path}`)
    await expect(page.locator('.vault')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('diary-calendar-surface')).toBeHidden({ timeout: 15_000 })
    await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveCount(1)
    await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveAttribute('aria-selected', 'true')
    await expect(page).toHaveURL(new RegExp(`/vault/${path.replace('/', '\\/')}(?:[?#]|$)`))
    await expect(page.locator('.search-input')).toHaveCount(1)
    await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveCount(1)
  } finally {
    await deletePost(request, path)
  }
  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test('real Browser Back and Forward reconcile route lifecycle without reopening Diary presentation', async ({ page, request }) => {
  const date = localCivilDate()
  const path = diaryPath(date)
  const first = `inbox/d65-back-first-${RUN_ID}`
  const second = `inbox/d65-back-second-${RUN_ID}`
  const state = diagnostics(page)
  const historyDiagnostics: string[] = []
  const cdp = await page.context().newCDPSession(page)
  page.on('console', (message) => {
    if (message.type() === 'debug' && message.text().startsWith('[nuvyn-history-diag]')) {
      historyDiagnostics.push(message.text())
    }
  })
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) historyDiagnostics.push(`[frame] ${frame.url()}`)
  })
  const recordNavigationHistory = async (label: string): Promise<void> => {
    const snapshot = await cdp.send('Page.getNavigationHistory') as {
      currentIndex: number
      entries: Array<{ id: number; url: string; userTypedURL?: string; transitionType?: string }>
    }
    historyDiagnostics.push(`[cdp] ${label} ${JSON.stringify({
      pageUrl: page.url(),
      currentIndex: snapshot.currentIndex,
      entries: snapshot.entries.map((entry) => ({
        id: entry.id,
        url: entry.url,
        userTypedURL: entry.userTypedURL,
        transitionType: entry.transitionType,
      })),
    })}`)
  }
  await page.addInitScript(() => {
    const win = window as typeof window & { __nuvynHistoryDiagInstalled?: boolean }
    if (win.__nuvynHistoryDiagInstalled) return
    win.__nuvynHistoryDiagInstalled = true

    const snapshot = () => {
      let state = 'null'
      try {
        state = JSON.stringify(window.history.state) ?? 'null'
      } catch {
        state = '[unserializable]'
      }
      return { href: window.location.href, length: window.history.length, state }
    }
    const report = (type: string, extra: Record<string, unknown> = {}) => {
      let stack = ''
      try {
        stack = new Error().stack?.split('\n').slice(0, 8).join('\n') ?? ''
      } catch {
        // Diagnostics must never affect navigation.
      }
      console.debug('[nuvyn-history-diag]', JSON.stringify({
        type,
        time: Math.round(performance.now()),
        ...snapshot(),
        ...extra,
        stack,
      }))
    }

    const originalPushState = window.history.pushState
    window.history.pushState = function (...args) {
      const result = Reflect.apply(originalPushState, window.history, args)
      report('pushState', { requestedUrl: String(args[2] ?? '') })
      return result
    }
    const originalReplaceState = window.history.replaceState
    window.history.replaceState = function (...args) {
      const result = Reflect.apply(originalReplaceState, window.history, args)
      report('replaceState', { requestedUrl: String(args[2] ?? '') })
      return result
    }
    window.addEventListener('popstate', (event) => {
      let eventState = 'null'
      try {
        eventState = JSON.stringify(event.state) ?? 'null'
      } catch {
        eventState = '[unserializable]'
      }
      report('popstate', { eventState })
    })
    report('init')
  })
  try {
    await seedDiary(request, date, `# Browser navigation ${RUN_ID}\n`)
    await seedNote(request, first, `# First ${RUN_ID}\n`)
    await seedNote(request, second, `# Second ${RUN_ID}\n`)
    if (new URL(page.url()).pathname !== '/vault') await page.goto('/vault')
    await selectScope(page, 'note')
    await page.goto(`/vault/${first}`)
    await expect(page.locator(`[role="tab"][data-tab-id="${first}"]`)).toHaveAttribute('aria-selected', 'true')
    await page.goto(`/vault/${second}`)
    await expect(page.locator(`[role="tab"][data-tab-id="${second}"]`)).toHaveAttribute('aria-selected', 'true')
    await selectScope(page, 'diary')
    await clickDiaryDate(page, date)
    await assertNativeDiary(page, date)

    await recordNavigationHistory('before-goBack')
    const historyBefore = await page.evaluate(() => history.length)
    await page.goBack()
    await recordNavigationHistory('after-goBack-wrapper')
    await expect(page).toHaveURL(new RegExp(`/vault/${first.replace('/', '\\/')}(?:[?#]|$)`))
    await expect(page.locator(`[role="tab"][data-tab-id="${first}"]`)).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('diary-calendar')).toBeHidden()

    await recordNavigationHistory('before-goForward')
    await page.goForward()
    await recordNavigationHistory('after-goForward-wrapper')
    await expect(page).toHaveURL(new RegExp(`/vault/${path.replace('/', '\\/')}(?:[?#]|$)`))
    await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('diary-calendar')).toBeHidden()
    expect(await page.evaluate(() => history.length)).toBe(historyBefore)
  } finally {
    await test.info().attach('browser-history-diagnostics', {
      body: historyDiagnostics.join('\n'),
      contentType: 'text/plain',
    })
    console.error(`HISTORY_DIAG_BEGIN\n${historyDiagnostics.join('\n')}\nHISTORY_DIAG_END`)
    for (const path of [diaryPath(date), first, second]) await deletePost(request, path)
  }
  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})
