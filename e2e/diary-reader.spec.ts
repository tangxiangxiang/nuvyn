import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type APIRequestContext, type Page } from './fixtures/diary'
import { CALENDAR_TEST_DATE, CALENDAR_TEST_TIME_ZONE, calendarDay } from './helpers/calendar-clock'

const TEST_TIME_ZONE = CALENDAR_TEST_TIME_ZONE

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

async function deleteDiaryDate(request: APIRequestContext, date: string): Promise<void> {
  const response = await request.delete(`/api/posts/${diaryPath(date)}`)
  if (response.status() === 503) {
    expect(await response.json()).toMatchObject({ code: 'diary-metadata-unavailable' })
    const vault = process.env.NUVYN_DRAFT_E2E_VAULT
    if (!vault) throw new Error('NUVYN_DRAFT_E2E_VAULT is not configured')
    // A deliberately injected physical-only future file has no authoritative
    // identity, so the production owner correctly refuses to adopt/delete it.
    // Remove only that test-owned fixture directly from the temporary vault.
    await rm(join(vault, 'diary', `${date}.md`), { force: true })
    return
  }
  expect([200, 404]).toContain(response.status())
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

async function seedOrdinaryNote(request: APIRequestContext, path: string): Promise<void> {
  const removed = await request.delete(`/api/posts/${path}`)
  expect([200, 404]).toContain(removed.status())
  const created = await request.post('/api/posts', { data: { path, title: path.split('/').at(-1) } })
  expect([200, 201]).toContain(created.status())
}

async function deletePost(request: APIRequestContext, path: string): Promise<void> {
  const response = await request.delete(`/api/posts/${path}`)
  expect([200, 404]).toContain(response.status())
}

async function seedExistingFutureDiary(date: string, raw: string): Promise<void> {
  const vault = process.env.NUVYN_DRAFT_E2E_VAULT
  if (!vault) throw new Error('NUVYN_DRAFT_E2E_VAULT is not configured')
  const diaryDirectory = join(vault, 'diary')
  const file = join(diaryDirectory, `${date}.md`)
  await mkdir(diaryDirectory, { recursive: true })
  await rm(file, { force: true })
  await writeFile(file, raw, 'utf8')
}

async function openDiaryScope(page: Page): Promise<void> {
  // Closing the current Diary tab already returns this test to Calendar Home;
  // avoid replacing the browser process with a redundant same-route reload.
  if (new URL(page.url()).pathname !== '/vault') await page.goto('/vault')
  const surface = page.getByTestId('diary-calendar-surface')
  if (await surface.count() === 0) {
    await page.locator('.scope-chip').filter({ hasText: 'note' }).click()
    await page.locator('.scope-chip').filter({ hasText: 'diary' }).click()
  }
  await expect(surface).toBeVisible({ timeout: 15_000 })
}

async function ensureDiaryScope(page: Page): Promise<void> {
  const diaryChip = page.locator('.scope-chip').filter({ hasText: 'diary' })
  if (await diaryChip.getAttribute('aria-pressed') !== 'true') await diaryChip.click()
  await expect(page.getByTestId('diary-calendar-surface')).toBeVisible({ timeout: 15_000 })
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
  // DiaryCalendar exposes the canonical civil date on its native button.
  const button = calendarDay(page.getByTestId('diary-calendar'), date)
  await expect(button).toBeVisible()
  await button.click()
}

function diagnostics(page: Page, ignoredConsoleErrors: string[] = []): { pageErrors: string[]; consoleErrors: string[] } {
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' && !ignoredConsoleErrors.some((part) => message.text().includes(part))) {
      consoleErrors.push(message.text())
    }
  })
  return { pageErrors, consoleErrors }
}

async function assertNativeReader(page: Page, date: string): Promise<void> {
  const path = diaryPath(date)
  await expect(page).toHaveURL(new RegExp(`/vault/${path.replace('/', '\\/')}(?:[?#]|$)`))
  await expect(page.getByTestId('diary-reader-dialog')).toHaveCount(0)
  await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.reading-pane')).toHaveCount(1)
  await expect(page.locator('.reading-pane')).toBeVisible()
  await expect(page.locator('.file-tree')).toBeVisible()
  await expect(page.locator('.search-input')).toHaveValue(date)
  await expect(page.locator(`[data-tree-key="file:${path}"]`)).toHaveCount(1)
  await expect(page.getByTestId('diary-calendar')).toBeAttached()
  await expect(page.getByTestId('diary-calendar')).toBeHidden()
  await expect(page.getByTestId('view-toggle')).toHaveAttribute('aria-label', /edit/i)
}

test('Calendar opens the native Vault reader with the Diary date filter', async ({ page, request }) => {
  const date = localCivilDate()
  const other = shiftCivilDate(date, -1)
  const path = diaryPath(date)
  const state = diagnostics(page)

  try {
    await seedExistingDiary(request, date, '# Native Reader\n\nCurrent Diary body.\n')
    await seedExistingDiary(request, other, '# Other Diary\n')
    await openDiaryScope(page)
    const monthBefore = await page.getByTestId('diary-calendar').getAttribute('data-month')
    await clickDiaryDate(page, date)
    await assertNativeReader(page, date)
    await expect(page.locator('.reading-pane article')).toContainText('Current Diary body')
    await expect(page.locator(`[data-tree-key="file:${diaryPath(other)}"]`)).toHaveCount(0)
    await expect(page.locator('.status-bar-row')).toBeVisible()

    const tab = page.locator(`[role="tab"][data-tab-id="${path}"]`)
    await tab.locator('.tab-close').click()
    await expect(tab).toHaveCount(0)
    await expect(page.getByTestId('diary-calendar')).toBeVisible()
    await expect(page.getByTestId('diary-calendar')).toHaveAttribute('data-month', monthBefore ?? '')
    // Calendar Home hides the explorer sidebar while preserving its filter
    // state for the next native-document presentation.
    await expect(page.locator('.search-input')).toHaveCount(0)
    await expect(page.locator('.activity-bar')).toHaveCount(0)
  } finally {
    await deleteDiaryDate(request, date)
    await deleteDiaryDate(request, other)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test('mobile native Diary documents fill the viewport when the side panel is closed', async ({ page, request }) => {
  const date = localCivilDate()
  const other = shiftCivilDate(date, -1)
  const path = diaryPath(date)
  const otherPath = diaryPath(other)
  const state = diagnostics(page)

  try {
    await seedExistingDiary(request, date, '# Mobile Native Diary\n\nThe document stays usable without the side panel.\n')
    await seedExistingDiary(request, other, '# Other Mobile Diary\n')
    await openDiaryScope(page)
    await clickDiaryDate(page, date)
    await assertNativeReader(page, date)

    const filesButton = page.getByRole('button', { name: /Explorer|文件资源管理器/i })
    await expect(filesButton).toHaveAttribute('aria-pressed', 'true')

    await page.setViewportSize({ width: 375, height: 812 })
    const openMetrics = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>('.vault')
      const activityBar = document.querySelector<HTMLElement>('.activity-bar')
      const fileTree = document.querySelector<HTMLElement>('.file-tree')
      const editorArea = document.querySelector<HTMLElement>('.editor-area')
      return {
        rootClass: root?.className ?? '',
        fileTreeWidth: fileTree?.getBoundingClientRect().width ?? 0,
        activityBarWidth: activityBar?.getBoundingClientRect().width ?? 0,
        editorLeft: editorArea?.getBoundingClientRect().left ?? 0,
        editorRight: editorArea?.getBoundingClientRect().right ?? 0,
        editorWidth: editorArea?.getBoundingClientRect().width ?? 0,
        viewportWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }
    })
    expect(openMetrics.rootClass).toMatch(/side-panel-open/)
    expect(openMetrics.fileTreeWidth).toBeGreaterThan(100)
    expect(openMetrics.editorWidth).toBeGreaterThan(0)
    expect(openMetrics.editorLeft).toBeGreaterThanOrEqual(openMetrics.activityBarWidth - 1)
    expect(openMetrics.scrollWidth).toBeLessThanOrEqual(openMetrics.viewportWidth + 1)

    await filesButton.click()
    await expect(filesButton).toHaveAttribute('aria-pressed', 'false')
    await expect(page.locator('.vault')).not.toHaveClass(/side-panel-open/)
    await expect(page.locator('.file-tree')).toBeHidden()
    await expect(page.locator('.reading-pane')).toBeVisible()

    for (const viewport of [
      { width: 375, height: 812 },
      { width: 320, height: 700 },
    ]) {
      await page.setViewportSize(viewport)
      const closedMetrics = await page.evaluate(() => {
        const activityBar = document.querySelector<HTMLElement>('.activity-bar')
        const editorArea = document.querySelector<HTMLElement>('.editor-area')
        const editor = editorArea?.getBoundingClientRect()
        const activity = activityBar?.getBoundingClientRect()
        return {
          editorLeft: editor?.left ?? 0,
          editorRight: editor?.right ?? 0,
          editorWidth: editor?.width ?? 0,
          activityRight: activity?.right ?? 0,
          viewportWidth: window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
        }
      })
      expect(closedMetrics.editorLeft, `${viewport.width}px editor starts after Activity Bar`)
        .toBeGreaterThanOrEqual(closedMetrics.activityRight - 1)
      expect(closedMetrics.editorRight, `${viewport.width}px editor reaches viewport edge`)
        .toBeGreaterThanOrEqual(closedMetrics.viewportWidth - 1)
      expect(closedMetrics.editorWidth, `${viewport.width}px editor uses remaining width`)
        .toBeGreaterThanOrEqual(closedMetrics.viewportWidth - closedMetrics.activityRight - 2)
      expect(closedMetrics.scrollWidth, `${viewport.width}px horizontal overflow`)
        .toBeLessThanOrEqual(closedMetrics.viewportWidth + 1)
      await expect(page.locator('.reading-pane')).toBeVisible()
    }

    await page.setViewportSize({ width: 375, height: 812 })
    await page.getByTestId('view-toggle').click()
    await expect(page.getByRole('textbox', { name: 'Editor content' })).toBeVisible()
    await page.getByTestId('view-toggle').click()
    await expect(page.locator('.reading-pane')).toBeVisible()

    await filesButton.click()
    await expect(filesButton).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.file-tree')).toBeVisible()
    await expect(page.locator('.search-input')).toHaveValue(date)
    await expect(page.locator(`[data-tree-key="file:${path}"]`)).toHaveCount(1)
    await expect(page.locator(`[data-tree-key="file:${otherPath}"]`)).toHaveCount(0)
  } finally {
    await deleteDiaryDate(request, date)
    await deleteDiaryDate(request, other)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test('existing today/past enter native READ while unsupported future files and missing future stay Home', async ({ page, request }) => {
  const today = localCivilDate()
  const past = shiftCivilDate(today, -1)
  const existingFuture = shiftCivilDate(today, 1)
  const missingFuture = shiftCivilDate(existingFuture, 1)
  const state = diagnostics(page, ['status of 503 (Service Unavailable)'])
  const createdDates = [today, past]

  try {
    for (const date of [...createdDates, existingFuture, missingFuture]) await deleteDiaryDate(request, date)
    for (const date of createdDates) await seedExistingDiary(request, date, `# Existing ${date}\n`)

    for (const date of createdDates) {
      await openDiaryScope(page)
      await clickDiaryDate(page, date)
      await assertNativeReader(page, date)
      const tab = page.locator(`[role="tab"][data-tab-id="${diaryPath(date)}"]`)
      await tab.locator('.tab-close').click()
      await expect(tab).toHaveCount(0)
      await expect(page.getByTestId('diary-calendar')).toBeVisible()
    }

    await seedExistingFutureDiary(existingFuture, `# Existing future\n\n${existingFuture}\n`)
    await openDiaryScope(page)
    await clickDiaryDate(page, existingFuture)
    // A direct future file without SQLite identity is intentionally not an
    // existing Diary under D8.2. The encrypted body route must fail closed
    // rather than let the browser synthesize a document identity from path.
    await expect(page.getByTestId('diary-calendar')).toBeVisible()
    await expect(page.locator(`[role="tab"][data-tab-id="${diaryPath(existingFuture)}"]`)).toHaveCount(0)

    await clickDiaryDate(page, missingFuture)
    await expect(page.getByTestId('diary-calendar')).toBeVisible()
    await expect(page.locator(`[role="tab"][data-tab-id="${diaryPath(missingFuture)}"]`)).toHaveCount(0)
  } finally {
    for (const date of [...createdDates, existingFuture, missingFuture]) await deleteDiaryDate(request, date)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors.filter((message) => !message.includes('404'))).toEqual([])
})

test('real Browser Back passively ends native Diary presentation without retargeting', async ({ page, request }) => {
  const date = localCivilDate()
  const source = 'inbox/d6-native-back-source'
  const intermediate = 'inbox/d6-native-back-intermediate'
  const state = diagnostics(page)

  try {
    await seedExistingDiary(request, date, '# Browser Back Diary\n')
    await seedOrdinaryNote(request, source)
    await seedOrdinaryNote(request, intermediate)
    await page.goto('/vault')
    await page.goto(`/vault/${source}`)
    await page.goto(`/vault/${intermediate}`)
    await ensureDiaryScope(page)
    await clickDiaryDate(page, date)
    await assertNativeReader(page, date)

    await page.goBack()

    await expect(page).toHaveURL(new RegExp(`/vault/${source.replace('/', '\\/')}(?:[?#]|$)`))
    await expect(page.locator(`[role="tab"][data-tab-id="${source}"]`)).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('diary-calendar')).toBeHidden()
    await expect(page.locator(`[role="tab"][data-tab-id="${diaryPath(date)}"]`)).toHaveCount(1)
  } finally {
    await deleteDiaryDate(request, date)
    await deletePost(request, source)
    await deletePost(request, intermediate)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test('native Edit keeps the same tab and unsaved raw across presentation toggles', async ({ page, request }) => {
  const date = localCivilDate()
  const path = diaryPath(date)
  const marker = `unsaved-native-${Date.now()}`
  const state = diagnostics(page)
  const documentGets: string[] = []
  page.on('request', (event) => {
    const url = new URL(event.url())
    if (event.method() === 'GET' && url.pathname === `/api/posts/${path}`) documentGets.push(url.pathname)
  })

  try {
    await seedExistingDiary(request, date, '# Native Edit\n\nOriginal body.\n')
    await openDiaryScope(page)
    await clickDiaryDate(page, date)
    await assertNativeReader(page, date)
    const getsAfterOpen = documentGets.length

    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 768, height: 1024 },
      { width: 375, height: 812 },
      { width: 320, height: 700 },
    ]) {
      await page.setViewportSize(viewport)
      await expect(page.locator('.reading-pane')).toBeVisible()
      const overflow = await page.evaluate(() => ({
        viewport: window.innerWidth,
        document: document.documentElement.scrollWidth,
        offenders: [...document.querySelectorAll<HTMLElement>('body *')]
          .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1)
          .slice(0, 8)
          .map((element) => ({
            tag: element.tagName,
            className: element.className,
            right: Math.round(element.getBoundingClientRect().right),
            width: Math.round(element.getBoundingClientRect().width),
          })),
      }))
      expect(overflow.document, JSON.stringify({ viewport, ...overflow })).toBeLessThanOrEqual(overflow.viewport + 1)
    }

    await page.setViewportSize({ width: 1280, height: 800 })
    await page.getByTestId('view-toggle').click()
    const editor = page.getByRole('textbox', { name: 'Editor content' })
    await expect(editor).toBeVisible()
    await editor.focus()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.insertText(`\n${marker}`)
    await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveCount(1)

    await expect(page.getByTestId('diary-calendar')).toBeHidden()
    await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveCount(1)

    await page.getByTestId('view-toggle').click()
    await expect(page.locator('.reading-pane')).toBeVisible()
    await expect(page.locator('.reading-pane article')).toContainText(marker)
    // Switching the native surface does not re-run the date command or replace
    // the existing tab raw, so the unsaved marker remains local to the tab.
    await expect.poll(() => documentGets.length).toBe(getsAfterOpen)
  } finally {
    await deleteDiaryDate(request, date)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test('ordinary note, archive, and ledger documents retain the native Vault workspace', async ({ page, request }) => {
  const cases = [
    { scope: 'note', path: 'inbox/d6-native-note-smoke' },
    { scope: 'note', path: 'literature/d6-native-literature-smoke' },
    { scope: 'note', path: 'archive/d6-native-archive-smoke' },
    { scope: 'ledger', path: 'ledger/d6-native-ledger-smoke' },
  ]
  const state = diagnostics(page)

  try {
    for (const item of cases) await seedOrdinaryNote(request, item.path)

    for (const item of cases) {
      await page.goto(`/vault/${item.path}`)
      const scopeChip = page.locator('.scope-chip').filter({ hasText: item.scope })
      if (await scopeChip.getAttribute('aria-pressed') !== 'true') await scopeChip.click()
      await expect(page.locator(`[role="tab"][data-tab-id="${item.path}"]`)).toHaveAttribute('aria-selected', 'true')
      const toggle = page.getByTestId('view-toggle')
      if ((await toggle.getAttribute('aria-label'))?.match(/read|阅读/i)) await toggle.click()
      await expect(page.locator('.reading-pane')).toHaveCount(1)
      await expect(page.locator('.file-tree')).toBeVisible()
      await expect(page.locator('.search-input')).toHaveCount(1)
      await expect(page.getByTestId('diary-reader-dialog')).toHaveCount(0)
    }
  } finally {
    for (const item of cases) await deletePost(request, item.path)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test('native document handoff remains stable across five cycles without dayIndex errors', async ({ page, request }) => {
  const date = localCivilDate()
  const state = diagnostics(page)
  await seedExistingDiary(request, date, '# Repeated native document\n')

  try {
    await openDiaryScope(page)
    for (let cycle = 0; cycle < 5; cycle += 1) {
      await clickDiaryDate(page, date)
      await assertNativeReader(page, date)
      const tab = page.locator(`[role="tab"][data-tab-id="${diaryPath(date)}"]`)
      await tab.locator('.tab-close').click()
      await expect(tab).toHaveCount(0)
      await expect(page.getByTestId('diary-calendar')).toBeVisible()
    }
  } finally {
    await deleteDiaryDate(request, date)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})
