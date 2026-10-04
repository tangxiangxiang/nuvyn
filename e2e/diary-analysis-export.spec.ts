import { readFile } from 'node:fs/promises'
import { expect, test, type APIRequestContext } from './fixtures/diary'
import type { Download, Page } from '@playwright/test'
import { CALENDAR_TEST_TIME_ZONE, calendarDay } from './helpers/calendar-clock'
import type { DiaryAnalysisExportDto } from '../src/features/diary/diaryAnalysisExport'
import { ensureLedgerDashboardFixtures } from './helpers/ledger-live'

test.use({ timezoneId: CALENDAR_TEST_TIME_ZONE, locale: 'zh-CN', trace: 'off', screenshot: 'only-on-failure' })

const dates = ['2026-07-31', '2026-08-01', '2026-08-02', '2026-08-04', '2026-08-05']
const activeDate = dates[4]!
const rawFor = (date: string) => `# ${date}\n\nDiaryAnalysisSentinel：**完整正文**\n\n- 工作\n- 生活\n\n`
const diaryChip = (page: Page) => page.locator('.scope-chip').filter({ hasText: 'diary' })

async function seed(request: APIRequestContext, selectedDates = dates): Promise<void> {
  for (const date of selectedDates) {
    const created = await request.post('/api/diary/dates', { data: { date, timeZone: CALENDAR_TEST_TIME_ZONE } })
    expect(created.status(), await created.text()).toBe(201)
    const initial = await (await request.get(`/api/posts/diary/${date}`)).json() as { raw: string }
    const saved = await request.put(`/api/posts/diary/${date}`, { data: { raw: rawFor(date), baseRaw: initial.raw } })
    expect(saved.status(), await saved.text()).toBe(200)
  }
}

async function openDocument(page: Page, date = activeDate): Promise<void> {
  await page.goto(`/vault/diary/${date}`)
  const toggle = page.getByTestId('view-toggle')
  await expect(toggle).toBeVisible()
  if (/read|阅读/i.test(await toggle.getAttribute('aria-label') ?? '')) await toggle.click()
  await expect(page.locator('.reading-pane article')).toContainText('DiaryAnalysisSentinel')
  await expect(diaryChip(page)).toHaveAttribute('aria-pressed', 'true')
}

async function setFilter(page: Page, filter: string): Promise<void> {
  await page.locator('.search-input').fill(filter)
  // Hover does not move keyboard focus. Explicitly leave text entry before E.
  await page.locator('.vault').focus()
}

async function trigger(page: Page, key = 'e'): Promise<void> {
  await diaryChip(page).hover()
  await page.keyboard.press(key)
}

async function readExport(download: Download): Promise<DiaryAnalysisExportDto> {
  const file = await download.path()
  expect(file).toBeTruthy()
  const json = await readFile(file!, 'utf8')
  const data = JSON.parse(json) as DiaryAnalysisExportDto
  expect(json).toBe(JSON.stringify(data, null, 2))
  expect(json.charCodeAt(0)).not.toBe(0xfeff)
  expect(Object.keys(data)).toEqual(['version', 'exportedAt', 'filter', 'entries'])
  expect(data.version).toBe(1)
  for (const entry of data.entries) expect(Object.keys(entry)).toEqual(['date', 'mood', 'content'])
  return data
}

async function exportNow(page: Page, key = 'e'): Promise<{ data: DiaryAnalysisExportDto; download: Download }> {
  const pending = page.waitForEvent('download')
  await trigger(page, key)
  const download = await pending
  return { data: await readExport(download), download }
}

function observe(page: Page) {
  const reads: string[] = []
  let downloads = 0
  page.on('download', () => { downloads += 1 })
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (request.method() === 'GET' && path.startsWith('/api/posts/diary/')) reads.push(path)
  })
  return { reads, downloads: () => downloads }
}

test('exports exactly the final FileTree scope for empty, month, day, and exact-path filters', async ({ page, request }) => {
  await seed(request)
  const body = await (await request.get('/api/posts/diary/2026-08-01')).json() as { metadata: { updatedAt: number } }
  const mood = await request.patch('/api/metadata/documents/diary/2026-08-01', {
    data: { mood: 'happy', expectedUpdatedAt: body.metadata.updatedAt },
  })
  expect(mood.status(), await mood.text()).toBe(200)
  await page.addInitScript(() => {
    const state = window as typeof window & { diaryAnalysisPersistenceWrites: number }
    state.diaryAnalysisPersistenceWrites = 0
    const check = (value: unknown) => {
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      if (text?.includes('DiaryAnalysisSentinel') && text.includes('"entries"')) state.diaryAnalysisPersistenceWrites += 1
    }
    const setItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) { check(value); return setItem.call(this, key, value) }
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value, key) {
      check(value)
      return key === undefined ? put.call(this, value) : put.call(this, value, key)
    }
    const add = IDBObjectStore.prototype.add
    IDBObjectStore.prototype.add = function (value, key) {
      check(value)
      return key === undefined ? add.call(this, value) : add.call(this, value, key)
    }
  })
  // Calendar navigation owns the exact-path seed; direct routes can instead
  // legitimately restore an empty/user-owned filter. Exercise the real seed.
  await page.goto('/vault')
  await diaryChip(page).click()
  await expect(page.getByTestId('diary-calendar')).toBeVisible()
  await calendarDay(page.getByTestId('diary-calendar'), activeDate).click()
  await expect(page.locator('.reading-pane article')).toContainText('DiaryAnalysisSentinel')
  await expect(page.locator('.search-input')).toHaveValue(activeDate)
  const route = page.url()
  await diaryChip(page).hover()
  await diaryChip(page).evaluate(async (element) => {
    getComputedStyle(element).color
    await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {})))
  })
  const appearance = await diaryChip(page).evaluate((element) => {
    const style = getComputedStyle(element)
    return { className: element.className, title: element.getAttribute('title'), cursor: style.cursor, padding: style.padding, font: style.font, border: style.border, color: style.color }
  })

  const exact = await exportNow(page)
  expect(exact.data.filter).toBe(activeDate)
  expect(exact.data.entries.map(({ date }) => date)).toEqual([activeDate])
  expect(exact.data.entries[0]?.content).toBe(rawFor(activeDate))

  for (const [filter, expectedDates] of [
    ['', dates],
    ['2026-08', dates.slice(1)],
    ['2026-08-01', ['2026-08-01']],
  ] as const) {
    await setFilter(page, filter)
    const visible = (await page.locator('[data-tree-key^="file:diary/"]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-tree-path')!.slice('diary/'.length)))).sort()
    expect(visible).toEqual(expectedDates)
    const { data, download } = await exportNow(page, 'Shift+E')
    expect(data.filter).toBe(filter)
    expect(data.entries.map(({ date }) => date)).toEqual(visible)
    for (const entry of data.entries) expect(entry.content).toBe(rawFor(entry.date))
    expect(data.entries.find(({ date }) => date === '2026-08-01')?.mood).toEqual({ id: 'happy', label: '开心' })
    expect(download.suggestedFilename()).toBe('nuvyn-diary-2026-08-15_12-00-00.json')
  }
  expect(page.url()).toBe(route)
  await expect(page.locator('.tabs')).toBeHidden()
  await expect(page.locator('[role="tab"][data-tab-id^="diary/"]')).toHaveCount(1)
  await expect(page.locator('a[download]')).toHaveCount(0)
  expect(await diaryChip(page).evaluate((element) => {
    const style = getComputedStyle(element)
    return { className: element.className, title: element.getAttribute('title'), cursor: style.cursor, padding: style.padding, font: style.font, border: style.border, color: style.color }
  })).toEqual(appearance)
  expect(await page.evaluate(() => [localStorage, sessionStorage].some((storage) => Object.values(storage).some((value: string) => value.includes('DiaryAnalysisSentinel'))))).toBe(false)
  expect(await page.evaluate(() => (window as typeof window & { diaryAnalysisPersistenceWrites: number }).diaryAnalysisPersistenceWrites)).toBe(0)
})

test('does not download for zero matches, text-entry focus, no hover, or locked Diary', async ({ page, request }) => {
  await seed(request, [activeDate])
  await openDocument(page)
  const state = observe(page)
  await setFilter(page, 'no-matching-diary')
  await trigger(page)
  await page.evaluate(() => Promise.resolve())
  expect(state.reads).toEqual([])
  expect(state.downloads()).toBe(0)
  await setFilter(page, '')
  await page.mouse.move(0, 0)
  await page.keyboard.press('e')
  await diaryChip(page).hover()
  await page.locator('.search-input').focus()
  await page.keyboard.press('e')
  expect(state.reads).toEqual([])
  expect(state.downloads()).toBe(0)
  await page.getByTestId('account-button').click()
  await page.getByTestId('account-lock-diary').click()
  await expect(page.locator('.scope-chip').filter({ hasText: 'note' })).toHaveAttribute('aria-pressed', 'true')
  await page.locator('.vault').focus()
  await trigger(page)
  await page.evaluate(() => Promise.resolve())
  expect(state.reads).toEqual([])
  expect(state.downloads()).toBe(0)
  await expect(page.locator('#diary-access-password')).toHaveCount(0)
})

test('freezes the range while reading and refuses concurrent or repeated E', async ({ page, request }) => {
  await seed(request)
  await openDocument(page)
  await setFilter(page, '2026-08')
  const state = observe(page)
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let started!: () => void
  const readStarted = new Promise<void>((resolve) => { started = resolve })
  await page.route('**/api/posts/diary/2026-08-01', async (route) => {
    const response = await route.fetch()
    started()
    await held
    await route.fulfill({ response })
  })
  try {
    const pending = page.waitForEvent('download')
    await trigger(page)
    await readStarted
    await diaryChip(page).dispatchEvent('keydown', { key: 'e', repeat: true, bubbles: true })
    await trigger(page)
    expect(state.reads).toHaveLength(1)
    await setFilter(page, '2026-07')
    await expect(page.locator('[data-tree-key^="file:diary/"]')).toHaveCount(1)
    release()
    const data = await readExport(await pending)
    expect(data.filter).toBe('2026-08')
    expect(data.entries.map(({ date }) => date)).toEqual(dates.slice(1))
    expect(state.downloads()).toBe(1)
  } finally {
    release()
    await page.unroute('**/api/posts/diary/2026-08-01')
  }
})

test('prefers a valid unsaved live buffer without an export-induced save or body request', async ({ page, request }) => {
  await seed(request, [activeDate])
  await openDocument(page)
  const path = `diary/${activeDate}`
  let writes = 0
  await page.route(`**/api/posts/${path}`, async (route) => {
    if (route.request().method() === 'PUT') {
      writes += 1
      await route.abort()
    } else await route.continue()
  })
  try {
    await page.getByTestId('view-toggle').click()
    const liveRaw = '# live unsaved\n\n刚刚写入，尚未保存。\n'
    const editor = page.getByRole('textbox', { name: 'Editor content' })
    await expect(editor).toBeVisible()
    await editor.focus()
    await page.keyboard.press('Control+a')
    await page.keyboard.insertText(liveRaw)
    await page.getByTestId('view-toggle').click()
    await expect(page.locator('.reading-pane article')).toContainText('刚刚写入')
    await page.locator('.vault').focus()
    const state = observe(page)
    const writesBefore = writes
    const { data } = await exportNow(page)
    expect(data.entries[0]?.content).toBe(liveRaw)
    expect(state.reads).toEqual([])
    expect(writes).toBe(writesBefore)
    const server = await (await request.get(`/api/posts/${path}`)).json() as { raw: string }
    expect(server.raw).toBe(rawFor(activeDate))
  } finally {
    await page.unroute(`**/api/posts/${path}`)
  }
})

test('a lock after the first body read prevents later aggregation and download', async ({ page, request }) => {
  await seed(request)
  await openDocument(page)
  await setFilter(page, '2026-08')
  const state = observe(page)
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let started!: () => void
  const secondReadStarted = new Promise<void>((resolve) => { started = resolve })
  await page.route('**/api/posts/diary/2026-08-02', async (route) => {
    const response = await route.fetch()
    started()
    await held
    await route.fulfill({ response })
  })
  try {
    await trigger(page)
    await secondReadStarted
    expect(state.reads).toEqual(['/api/posts/diary/2026-08-01', '/api/posts/diary/2026-08-02'])
    await page.getByTestId('account-button').click()
    await page.getByTestId('account-lock-diary').click()
    await expect(page.locator('.scope-chip').filter({ hasText: 'note' })).toHaveAttribute('aria-pressed', 'true')
    const finished = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/posts/diary/2026-08-02')
    release()
    await finished
    await page.evaluate(() => Promise.resolve())
    expect(state.reads).toHaveLength(2)
    expect(state.downloads()).toBe(0)
    await expect(page.locator('a[download]')).toHaveCount(0)
  } finally {
    release()
    await page.unroute('**/api/posts/diary/2026-08-02')
  }
})

test('Calendar Home can export the empty-filter scope without opening a document', async ({ page, request }) => {
  await seed(request)
  await page.goto('/vault')
  await diaryChip(page).click()
  await expect(page.getByTestId('diary-calendar')).toBeVisible()
  const { data } = await exportNow(page)
  expect(data.filter).toBe('')
  expect(data.entries.map(({ date }) => date)).toEqual(dates)
  await expect(page.locator('[role="tab"][data-tab-id^="diary/"]')).toHaveCount(0)
  await expect(page.getByTestId('diary-calendar')).toBeVisible()
  expect(new URL(page.url()).pathname).toBe('/vault')
})

test('Diary click still returns Home, and retained hover can export without re-entering the chip', async ({ page, request }) => {
  await seed(request)
  await openDocument(page)
  await setFilter(page, '')
  await diaryChip(page).click()
  await expect(page.getByTestId('diary-calendar')).toBeVisible()
  await expect(page.locator('[role="tab"][data-tab-id^="diary/"]')).toHaveCount(0)
  const pending = page.waitForEvent('download')
  await page.keyboard.press('e')
  const data = await readExport(await pending)
  expect(data.entries.map(({ date }) => date)).toEqual(dates)
  expect(new URL(page.url()).pathname).toBe('/vault')
})

test('inactive navigation items cannot export another module or switch its workspace', async ({ page, request }) => {
  await seed(request, [activeDate])
  await ensureLedgerDashboardFixtures(request)
  await openDocument(page)
  await page.locator('.vault').focus()
  const state = observe(page)
  const ledgerReads: string[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path.startsWith('/api/ledger/')) ledgerReads.push(path)
  })
  const route = page.url()
  const ledgerChip = page.locator('.scope-chip').filter({ hasText: 'ledger' })
  await ledgerChip.hover()
  await page.keyboard.press('e')
  await page.evaluate(() => Promise.resolve())
  expect(state.downloads()).toBe(0)
  expect(ledgerReads).toEqual([])
  expect(page.url()).toBe(route)
  await expect(diaryChip(page)).toHaveAttribute('aria-pressed', 'true')

  await ledgerChip.click()
  await expect(page.getByTestId('ledger-dashboard')).toBeVisible()
  await expect(ledgerChip).toHaveAttribute('aria-pressed', 'true')
  const ledgerRoute = page.url()
  await diaryChip(page).hover()
  await page.keyboard.press('Shift+E')
  await page.evaluate(() => Promise.resolve())
  expect(state.downloads()).toBe(0)
  expect(state.reads).toEqual([])
  expect(page.url()).toBe(ledgerRoute)
  await expect(page.locator('#diary-access-password')).toHaveCount(0)
})

test('leaving Diary permanently cancels an export while preserving its unlocked document context', async ({ page, request }) => {
  await seed(request)
  await openDocument(page)
  await setFilter(page, '2026-08')
  const state = observe(page)
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let started!: () => void
  const readStarted = new Promise<void>((resolve) => { started = resolve })
  let intercepted = false
  await page.route('**/api/posts/diary/2026-08-01', async (route) => {
    if (intercepted) {
      await route.continue()
      return
    }
    intercepted = true
    const response = await route.fetch()
    started()
    await held
    await route.fulfill({ response })
  })
  try {
    await trigger(page)
    await readStarted
    await page.locator('.scope-chip').filter({ hasText: 'note' }).click()
    await expect(page.locator('.scope-chip').filter({ hasText: 'note' })).toHaveAttribute('aria-pressed', 'true')
    await diaryChip(page).click()
    await expect(page.locator('.reading-pane article')).toContainText('DiaryAnalysisSentinel')
    await expect(page.locator('#diary-access-password')).toHaveCount(0)
    release()
    await page.waitForLoadState('networkidle')
    expect(state.downloads()).toBe(0)
    expect(state.reads.some((path) => path.endsWith('/2026-08-02'))).toBe(false)
    const { data } = await exportNow(page)
    expect(data.entries.map(({ date }) => date)).toEqual(dates.slice(1))
    expect(state.downloads()).toBe(1)
  } finally {
    release()
    await page.unroute('**/api/posts/diary/2026-08-01')
  }
})

test.describe('browser-local filename', () => {
  test.use({ timezoneId: 'Pacific/Honolulu' })
  test('uses the full browser-local timestamp rather than UTC for the filename', async ({ page, request }) => {
    await seed(request, [activeDate])
    await openDocument(page)
    const { download } = await exportNow(page)
    expect(download.suggestedFilename()).toBe('nuvyn-diary-2026-08-14_18-00-00.json')
  })
})

test.describe('touch pointer', () => {
  test.use({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } })
  test('does not enable any hidden export on mobile/touch', async ({ page, request }) => {
    await seed(request, [activeDate])
    await openDocument(page)
    expect(await page.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches)).toBe(false)
    const state = observe(page)
    await diaryChip(page).dispatchEvent('mouseenter')
    await diaryChip(page).dispatchEvent('touchstart')
    await page.keyboard.press('e')
    expect(state.reads).toEqual([])
    expect(state.downloads()).toBe(0)
  })
})
