import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import nodePath from 'node:path'
import Database from 'better-sqlite3'
import { expect, test, type APIRequestContext, type Page } from './fixtures/diary'
import {
  appendEditorText,
  clearDraftDatabase,
  draftRowCount,
  gotoVaultReady,
  interceptAutosaveAborted,
  interceptAutosaveHeld,
  reloadApp,
} from './helpers/edit-program'
import { CALENDAR_TEST_DATE, CALENDAR_TEST_TIME_ZONE, calendarDay } from './helpers/calendar-clock'

const TEST_TIME_ZONE = CALENDAR_TEST_TIME_ZONE
const RUN_ID = String(Date.now())
const E2E_VAULT = process.env.NUVYN_DRAFT_E2E_VAULT ?? nodePath.join('src', 'content')

test.use({
  timezoneId: TEST_TIME_ZONE,
  trace: 'off',
  screenshot: 'only-on-failure',
})

type DiaryMetadata = {
  id: string
  mood: string | null
  updatedAt: number
}

type DiaryPost = {
  path: string
  raw: string
  metadata: DiaryMetadata
}

function localCivilDate(): string {
  return CALENDAR_TEST_DATE
}

function civilParts(value: string): { year: number; month: number; day: number } {
  const [year, month, day] = value.split('-').map(Number)
  return { year, month, day }
}

function daysInMonth(year: number, month: number): number {
  const leap = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0)
  if (month === 2) return leap ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

function shiftCivilDate(value: string, amount: -1 | 1): string {
  let { year, month, day } = civilParts(value)
  day += amount
  if (day > daysInMonth(year, month)) {
    day = 1
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  } else if (day === 0) {
    month -= 1
    if (month === 0) {
      month = 12
      year -= 1
    }
    day = daysInMonth(year, month)
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function diaryPath(date: string): string {
  return `diary/${date}`
}

function normalizeLineEndings(raw: string): string {
  return raw.replace(/\r\n?/g, '\n')
}

async function readPost(request: APIRequestContext, path: string): Promise<DiaryPost> {
  const response = await request.get(`/api/posts/${path}`)
  const body = await response.text()
  expect(response.status(), body).toBe(200)
  return JSON.parse(body) as DiaryPost
}

async function readDiary(request: APIRequestContext, date: string): Promise<DiaryPost> {
  return readPost(request, diaryPath(date))
}

async function deletePost(request: APIRequestContext, path: string): Promise<void> {
  const response = await request.delete(`/api/posts/${path}`)
  expect(path.startsWith('diary/') ? [200, 404, 422] : [200, 404]).toContain(response.status())
}

async function findUnusedDiaryDate(
  request: APIRequestContext,
  excluded: readonly string[] = [],
): Promise<string> {
  const excludedSet = new Set(excluded)
  let candidate = localCivilDate()
  for (let attempt = 0; attempt < 45; attempt += 1) {
    if (!excludedSet.has(candidate)) {
      const response = await request.get(`/api/posts/${diaryPath(candidate)}`)
      if (response.status() === 404) return candidate
      const body = await response.text()
      expect(response.status(), body).toBe(200)
    }
    candidate = shiftCivilDate(candidate, -1)
  }
  throw new Error('unable to find an unused Diary date for D7.4 E2E')
}

async function seedDiary(
  request: APIRequestContext,
  date: string,
  raw: string,
): Promise<{ documentId: string; raw: string }> {
  const path = diaryPath(date)
  const existing = await request.get(`/api/posts/${path}`)
  if (existing.status() !== 404) {
    const body = await existing.text()
    throw new Error(`D7.4 test date was not unused: ${path} (${existing.status()}): ${body}`)
  }

  const created = await request.post('/api/diary/dates', {
    data: { date, timeZone: TEST_TIME_ZONE },
  })
  expect(created.status(), await created.text()).toBe(201)

  const initial = await readDiary(request, date)
  const saved = await request.put(`/api/posts/${path}`, {
    data: { raw, baseRaw: initial.raw },
  })
  expect(saved.status(), await saved.text()).toBe(200)

  const detail = await readDiary(request, date)
  return {
    documentId: detail.metadata.id,
    raw: detail.raw,
  }
}

async function seedNote(
  request: APIRequestContext,
  path: string,
  raw: string,
): Promise<void> {
  await deletePost(request, path)
  const created = await request.post('/api/posts', {
    data: { path, title: path.split('/').at(-1) },
  })
  expect([200, 201]).toContain(created.status())
  const initial = await request.get(`/api/posts/${path}`)
  expect(initial.status(), await initial.text()).toBe(200)
  const initialBody = await initial.json() as { raw: string }
  const saved = await request.put(`/api/posts/${path}`, {
    data: { raw, baseRaw: initialBody.raw },
  })
  expect(saved.status(), await saved.text()).toBe(200)
}

async function setDiaryMood(
  request: APIRequestContext,
  date: string,
  mood: string | null,
  expectedUpdatedAt?: number,
): Promise<DiaryPost['metadata']> {
  const current = await readDiary(request, date)
  const response = await request.patch(`/api/metadata/documents/${diaryPath(date)}`, {
    data: {
      mood,
      expectedUpdatedAt: expectedUpdatedAt ?? current.metadata.updatedAt,
    },
  })
  const body = await response.text()
  expect(response.status(), body).toBe(200)
  return JSON.parse(body) as DiaryPost['metadata']
}

async function setOpaqueMoodFixture(path: string, mood: string): Promise<void> {
  const databasePath = process.env.NUVYN_E2E_DB_PATH
  if (!databasePath) throw new Error('NUVYN_E2E_DB_PATH is required for Mood E2E fixtures')
  const db = new Database(databasePath)
  try {
    db.pragma('busy_timeout = 5000')
    const result = db.prepare('UPDATE documents SET mood = ? WHERE path = ?').run(mood, path)
    expect(result.changes).toBe(1)
  } finally {
    db.close()
  }
}

async function commitDiaryRevision(
  request: APIRequestContext,
  date: string,
  raw: string,
  subject: string,
): Promise<string> {
  const historyPath = `${diaryPath(date)}.md`
  const response = await request.post('/api/history/commits', {
    data: {
      paths: [historyPath],
      message: subject,
      expected: {
        [historyPath]: createHash('sha256').update(raw).digest('hex'),
      },
    },
  })
  const body = await response.text()
  expect(response.status(), body).toBe(201)
  const result = JSON.parse(body) as { sha?: unknown }
  expect(result.sha).toEqual(expect.stringMatching(/^[0-9a-f]{40}$/))
  return result.sha as string
}

function diagnostics(page: Page, ignoredConsoleFragments: string[] = []): {
  pageErrors: string[]
  consoleErrors: string[]
} {
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    if (ignoredConsoleFragments.some((fragment) => message.text().includes(fragment))) return
    consoleErrors.push(message.text())
  })
  return { pageErrors, consoleErrors }
}

async function openDiaryHome(page: Page): Promise<void> {
  await page.goto('/vault')
  const diaryChip = page.locator('.scope-chip').filter({ hasText: 'diary' })
  if (await diaryChip.getAttribute('aria-pressed') !== 'true') await diaryChip.click()
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

async function assertNativeReader(page: Page, date: string, expectedFilter = date): Promise<void> {
  const path = diaryPath(date)
  await expect(page).toHaveURL(new RegExp(`/vault/${path.replace('/', '\\/')}(?:[?#]|$)`))
  await expect(page.getByTestId('diary-reader-dialog')).toHaveCount(0)
  await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.reading-pane')).toHaveCount(1)
  await expect(page.locator('.reading-pane')).toBeVisible()
  await ensureExplorerVisible(page)
  await expect(page.locator('.search-input')).toHaveValue(expectedFilter)
  await expect(page.getByTestId('diary-calendar')).toBeAttached()
  await expect(page.getByTestId('diary-calendar')).toBeHidden()
}

async function selectScope(page: Page, scope: 'note' | 'diary'): Promise<void> {
  const chip = page.locator('.scope-chip').filter({ hasText: scope })
  if (await chip.getAttribute('aria-pressed') !== 'true') await chip.click()
}

async function selectWorkspaceTab(page: Page, path: string): Promise<void> {
  const tab = page.locator(`[role="tab"][data-tab-id="${path}"]`)
  await expect(tab).toHaveCount(1)
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
}

async function enterEditor(page: Page): Promise<void> {
  const toggle = page.getByTestId('view-toggle')
  const label = await toggle.getAttribute('aria-label')
  if (/edit|编辑/i.test(label ?? '')) await toggle.click()
  await expect(page.getByRole('textbox', { name: 'Editor content' })).toBeVisible()
  await expect(page.locator('.editor-pane .monaco-editor')).toHaveCount(1)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/__markdown-test?mode=reading')
  await clearDraftDatabase(page)
  await gotoVaultReady(page)
})

test('Mood set/change/clear stays separate from a dirty native Diary body', async ({ page, request }) => {
  const date = await findUnusedDiaryDate(request)
  const path = diaryPath(date)
  const baseRaw = `# D7.4 metadata/body separation ${RUN_ID}\n`
  const dirtyMarker = `D74_DIRTY_${RUN_ID}`
  const dirtyRaw = `${baseRaw}\n${dirtyMarker}`
  const state = diagnostics(page, ['net::ERR_FAILED'])
  let autosaveInstalled = false

  try {
    const document = await seedDiary(request, date, baseRaw)
    const first = await setDiaryMood(request, date, 'happy')
    const second = await setDiaryMood(request, date, 'sad', first.updatedAt)
    expect(second.id).toBe(document.documentId)
    const cleared = await setDiaryMood(request, date, null, second.updatedAt)
    expect(cleared.id).toBe(document.documentId)
    expect((await readDiary(request, date)).metadata.mood).toBeNull()

    await openDiaryHome(page)
    await clickDiaryDate(page, date)
    await assertNativeReader(page, date)
    await enterEditor(page)
    await interceptAutosaveAborted(page, path)
    autosaveInstalled = true
    await appendEditorText(page, dirtyMarker)
    await expect(page.locator(`[data-tab-id="${path}"][data-save-status="dirty"]`)).toBeVisible({ timeout: 15_000 })
    // Managed Diary drafts are memory-only in D8.3; no IndexedDB row may be
    // created while the tab is dirty.
    await expect.poll(() => draftRowCount(page, dirtyMarker), { timeout: 15_000 }).toBe(0)

    const dirtySet = await setDiaryMood(request, date, 'happy')
    const dirtyChanged = await setDiaryMood(request, date, 'angry', dirtySet.updatedAt)
    const dirtyCleared = await setDiaryMood(request, date, null, dirtyChanged.updatedAt)
    expect(dirtyCleared.id).toBe(document.documentId)

    const whileDirty = await readDiary(request, date)
    expect(normalizeLineEndings(whileDirty.raw)).toBe(normalizeLineEndings(baseRaw))
    expect(whileDirty.metadata.mood).toBeNull()
    expect(whileDirty.metadata.id).toBe(document.documentId)
    await expect(page).toHaveURL(new RegExp(`/vault/${path.replace('/', '\\/')}(?:[?#]|$)`))
    const dirtyTab = page.locator(`[data-tab-id="${path}"]`)
    await expect(dirtyTab).toHaveCount(1)
    await expect(dirtyTab.locator('.tab-dirty-indicator')).toHaveCount(1)
    await expect(page.locator('.n-dialog[role="dialog"]')).toHaveCount(0)

    await page.unroute(`**/api/posts/${path}`)
    autosaveInstalled = false
    await page.locator('.vault').focus()
    await page.keyboard.press('Control+s')
    await expect(page.locator(`[data-tab-id="${path}"][data-save-status="saved"]`)).toBeVisible({ timeout: 15_000 })
    const saved = await readDiary(request, date)
    expect(normalizeLineEndings(saved.raw)).toBe(normalizeLineEndings(dirtyRaw))
    expect(saved.metadata.mood).toBeNull()
    expect(saved.metadata.id).toBe(document.documentId)
    await expect.poll(() => draftRowCount(page, dirtyMarker), { timeout: 15_000 }).toBe(0)
  } finally {
    if (autosaveInstalled) await page.unroute(`**/api/posts/${path}`)
    await deletePost(request, path)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test('external metadata conflict keeps the Calendar winner and allows a fresh retry', async ({ page, request }) => {
  const date = await findUnusedDiaryDate(request)
  const path = diaryPath(date)
  const baseRaw = `# D7.4 clean metadata conflict ${RUN_ID}\n`
  const state = diagnostics(page)

  try {
    const document = await seedDiary(request, date, baseRaw)
    const localMood = await setDiaryMood(request, date, 'happy')

    await openDiaryHome(page)
    await moveToMonth(page, date)
    const moodButton = page.locator(`[data-testid="diary-calendar-mood"][data-date="${date}"]`)
    await expect(moodButton).toBeVisible()
    await expect(moodButton.locator('img')).toHaveAttribute('src', '/emoji/开心.svg')

    // Keep the browser's Calendar projection at the old version while an
    // external writer wins the authoritative metadata CAS.
    const external = await setDiaryMood(request, date, 'sad', localMood.updatedAt)
    expect(external.id).toBe(document.documentId)
    expect(external.updatedAt).toBeGreaterThan(localMood.updatedAt)

    await moodButton.click()
    const picker = page.getByTestId('diary-mood-picker')
    await expect(picker).toBeVisible()
    const staleResponse = page.waitForResponse((response) => (
      response.request().method() === 'PATCH'
      && new URL(response.url()).pathname === `/api/metadata/documents/${path}`
    ))
    await picker.getByRole('radio', { name: '愤怒 / Angry' }).click()
    expect((await staleResponse).status()).toBe(409)

    await expect.poll(async () => (await readDiary(request, date)).metadata.mood).toBe('sad')
    const winner = await readDiary(request, date)
    expect(winner.raw).toBe(baseRaw)
    expect(winner.metadata.id).toBe(document.documentId)
    expect(winner.metadata.mood).toBe('sad')
    expect(winner.metadata.updatedAt).toBe(external.updatedAt)
    await expect(moodButton.locator('img')).toHaveAttribute('src', '/emoji/伤心.svg')
    await expect(page).toHaveURL(/\/vault(?:[?#]|$)/)
    await expect(page.getByTestId('diary-calendar')).toBeVisible()
    await expect(page.locator('[role="tab"][data-tab-id^="diary/"]')).toHaveCount(0)

    await page.keyboard.press('Escape')
    await expect(picker).toHaveCount(0)
    await moodButton.click()
    await page.getByTestId('diary-mood-picker').getByRole('radio', { name: '愤怒 / Angry' }).click()
    await expect.poll(async () => (await readDiary(request, date)).metadata.mood).toBe('angry')
    await expect(moodButton.locator('img')).toHaveAttribute('src', '/emoji/愤怒.svg')
    await expect(page).toHaveURL(/\/vault(?:[?#]|$)/)
    await expect(page.locator('[role="tab"][data-tab-id^="diary/"]')).toHaveCount(0)
  } finally {
    await deletePost(request, path)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([
    'Failed to load resource: the server responded with a status of 409 (Conflict)',
  ])
})

test('external metadata conflict leaves a dirty native body untouched', async ({ page, request }) => {
  const date = await findUnusedDiaryDate(request)
  const path = diaryPath(date)
  const baseRaw = `# D7.4 dirty metadata conflict ${RUN_ID}\n`
  const dirtyMarker = `D74_METADATA_CONFLICT_DIRTY_${RUN_ID}`
  const dirtyRaw = `${baseRaw}\n${dirtyMarker}`
  const state = diagnostics(page, ['net::ERR_FAILED'])
  let autosaveInstalled = false

  try {
    const document = await seedDiary(request, date, baseRaw)
    await setDiaryMood(request, date, 'happy')

    await openDiaryHome(page)
    await clickDiaryDate(page, date)
    await assertNativeReader(page, date)
    await enterEditor(page)
    await interceptAutosaveAborted(page, path)
    autosaveInstalled = true
    await appendEditorText(page, dirtyMarker)
    await expect(page.locator(`[data-tab-id="${path}"][data-save-status="dirty"]`)).toBeVisible({ timeout: 15_000 })
    // Managed Diary drafts are memory-only in D8.3; no IndexedDB row may be
    // created while the tab is dirty.
    await expect.poll(() => draftRowCount(page, dirtyMarker), { timeout: 15_000 }).toBe(0)

    const stale = await readDiary(request, date)
    expect(stale.metadata.mood).toBe('happy')
    const external = await setDiaryMood(request, date, 'sad', stale.metadata.updatedAt)
    expect(external.id).toBe(document.documentId)

    // Native Mood UI is intentionally not reintroduced for this phase. The
    // API request below is the external/stale CAS boundary while the native
    // editor keeps the unsaved body buffer mounted and dirty.
    const conflict = await request.patch(`/api/metadata/documents/${path}`, {
      data: { mood: 'angry', expectedUpdatedAt: stale.metadata.updatedAt },
    })
    expect(conflict.status(), await conflict.text()).toBe(409)

    const whileDirty = await readDiary(request, date)
    expect(normalizeLineEndings(whileDirty.raw)).toBe(normalizeLineEndings(baseRaw))
    expect(whileDirty.metadata.id).toBe(document.documentId)
    expect(whileDirty.metadata.mood).toBe('sad')
    const dirtyTab = page.locator(`[data-tab-id="${path}"]`)
    await expect(dirtyTab).toHaveCount(1)
    await expect(dirtyTab.locator('.tab-dirty-indicator')).toHaveCount(1)
    await expect(page.locator('.editor-pane .monaco-editor .view-lines').first()).toContainText(dirtyMarker)
    await expect(page.locator('.n-dialog[role="dialog"]')).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(`/vault/${path.replace('/', '\\/')}(?:[?#]|$)`))
    await expect(page.getByTestId('diary-calendar')).toBeHidden()

    const retry = await setDiaryMood(request, date, 'angry', external.updatedAt)
    expect(retry.id).toBe(document.documentId)
    expect(retry.updatedAt).toBeGreaterThan(external.updatedAt)
    const afterRetry = await readDiary(request, date)
    expect(afterRetry.metadata.mood).toBe('angry')
    expect(afterRetry.raw).toBe(baseRaw)
    await expect(dirtyTab.locator('.tab-dirty-indicator')).toHaveCount(1)

    await page.unroute(`**/api/posts/${path}`)
    autosaveInstalled = false
    await page.locator('.vault').focus()
    await page.keyboard.press('Control+s')
    await expect(page.locator(`[data-tab-id="${path}"][data-save-status="saved"]`)).toBeVisible({ timeout: 15_000 })

    const saved = await readDiary(request, date)
    expect(normalizeLineEndings(saved.raw)).toBe(normalizeLineEndings(dirtyRaw))
    expect(saved.metadata.id).toBe(document.documentId)
    expect(saved.metadata.mood).toBe('angry')
    await expect.poll(() => draftRowCount(page, dirtyMarker), { timeout: 15_000 }).toBe(0)
  } finally {
    if (autosaveInstalled) await page.unroute(`**/api/posts/${path}`)
    await deletePost(request, path)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test('native body conflict preserves Mood while resolving through the existing save owner', async ({ page, request }) => {
  const date = await findUnusedDiaryDate(request)
  const path = diaryPath(date)
  const baseRaw = `# D7.4 native body conflict ${RUN_ID}\n`
  const localMarker = `D74_NATIVE_LOCAL_${RUN_ID}`
  const localRaw = `${baseRaw}\n${localMarker}`
  const externalRaw = `# D7.4 native external body ${RUN_ID}\n`
  const state = diagnostics(page, ['status of 409 (Conflict)'])
  const autosave = { seen: false, statuses: [] as number[] }
  let releaseAutosave: () => void = () => {}
  let browserAutosaveInstalled = false

  try {
    const document = await seedDiary(request, date, baseRaw)
    const initialMood = await setDiaryMood(request, date, 'happy')
    await openDiaryHome(page)
    await clickDiaryDate(page, date)
    await assertNativeReader(page, date)
    await enterEditor(page)

    const gate = new Promise<void>((resolve) => { releaseAutosave = resolve })
    await interceptAutosaveHeld(page, path, autosave, gate)
    browserAutosaveInstalled = true
    await appendEditorText(page, localMarker)
    await expect(page.locator(`[data-tab-id="${path}"][data-save-status="dirty"]`)).toBeVisible({ timeout: 15_000 })
    await expect.poll(() => autosave.seen, { timeout: 15_000 }).toBe(true)

    const externalWrite = await request.put(`/api/posts/${path}`, {
      data: { raw: externalRaw, baseRaw },
    })
    expect(externalWrite.status(), await externalWrite.text()).toBe(200)
    const afterExternalBody = await readDiary(request, date)
    expect(afterExternalBody.metadata.id).toBe(document.documentId)
    const externalMood = await setDiaryMood(request, date, 'sad', afterExternalBody.metadata.updatedAt)
    expect(externalMood.id).toBe(document.documentId)
    expect(externalMood.updatedAt).toBeGreaterThan(initialMood.updatedAt)

    releaseAutosave()
    await expect.poll(() => autosave.statuses.length, { timeout: 15_000 }).toBe(1)
    expect(autosave.statuses[0]).toBe(409)
    await expect(page.locator(`[data-tab-id="${path}"][data-save-status="external"]`)).toBeVisible({ timeout: 15_000 })

    const conflicted = await readDiary(request, date)
    expect(conflicted.raw).toBe(externalRaw)
    expect(conflicted.metadata.id).toBe(document.documentId)
    expect(conflicted.metadata.mood).toBe('sad')
    await expect(page.locator('.editor-pane .monaco-editor .view-lines').first()).toContainText(localMarker)
    await expect(page.getByTestId('diary-calendar')).toBeHidden()
    await expect(page.locator('.n-dialog[role="dialog"]')).toHaveCount(0)

    const readToggle = page.getByTestId('view-toggle')
    if (/read|阅读/i.test(await readToggle.getAttribute('aria-label') ?? '')) await readToggle.click()
    await expect(page.locator('.reading-pane')).toBeVisible()
    await expect(page.locator('.reading-pane article')).toContainText(localMarker)
    await enterEditor(page)
    const keepLocal = page.locator('button[aria-label="Keep local version and overwrite disk"]')
    await expect(keepLocal).toBeVisible({ timeout: 15_000 })
    await keepLocal.click()
    await expect(page.locator(`[data-tab-id="${path}"][data-save-status="saved"]`)).toBeVisible({ timeout: 15_000 })

    const resolved = await readDiary(request, date)
    expect(normalizeLineEndings(resolved.raw)).toBe(normalizeLineEndings(localRaw))
    expect(resolved.metadata.id).toBe(document.documentId)
    expect(resolved.metadata.mood).toBe('sad')

    const tab = page.locator(`[role="tab"][data-tab-id="${path}"]`)
    await tab.locator('.tab-close').click()
    await expect(tab).toHaveCount(0)
    await expect(page.getByTestId('diary-calendar')).toBeVisible()
    await expect(page.locator(`[data-testid="diary-calendar-mood"][data-date="${date}"] img`)).toHaveAttribute('src', '/emoji/伤心.svg')
  } finally {
    if (browserAutosaveInstalled) await page.unroute(`**/api/posts/${path}`)
    await deletePost(request, path)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test('unknown Mood survives native save, refresh, close, and reopen', async ({ page, request }) => {
  const date = await findUnusedDiaryDate(request)
  const path = diaryPath(date)
  const baseRaw = `# D7.4 unknown Mood lifecycle ${RUN_ID}\n`
  const savedMarker = `Saved body ${RUN_ID}`
  const savedRaw = `${baseRaw}\n${savedMarker}`
  const unknownMood = 'unknown-mood-v3'
  const state = diagnostics(page)

  try {
    const document = await seedDiary(request, date, baseRaw)
    await setOpaqueMoodFixture(path, unknownMood)
    const fixture = await readDiary(request, date)
    expect(fixture.metadata.id).toBe(document.documentId)
    expect(fixture.metadata.mood).toBe(unknownMood)

    await openDiaryHome(page)
    await moveToMonth(page, date)
    const moodButton = page.locator(`[data-testid="diary-calendar-mood"][data-date="${date}"]`)
    await expect(moodButton).toBeVisible()
    await expect(moodButton).toHaveText('?')

    await clickDiaryDate(page, date)
    await assertNativeReader(page, date)
    await enterEditor(page)
    await appendEditorText(page, savedMarker)
    await expect(page.locator(`[data-tab-id="${path}"][data-save-status="saved"]`)).toBeVisible({ timeout: 15_000 })

    const saved = await readDiary(request, date)
    expect(normalizeLineEndings(saved.raw)).toBe(normalizeLineEndings(savedRaw))
    expect(saved.metadata.id).toBe(document.documentId)
    expect(saved.metadata.mood).toBe(unknownMood)

    await page.reload()
    await expect(page).toHaveURL(new RegExp(`/vault/${path.replace('/', '\\/')}(?:[?#]|$)`))
    await expect(page.getByTestId('diary-reader-dialog')).toHaveCount(0)
    await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveAttribute('aria-selected', 'true')
    await ensureExplorerVisible(page)
    await expect(page.locator('.search-input')).toHaveValue(date)
    await expect(page.getByTestId('diary-calendar')).toBeAttached()
    await expect(page.getByTestId('diary-calendar')).toBeHidden()
    await expect(page.locator('.editor-pane, .reading-pane')).toHaveCount(1)
    const refreshed = await readDiary(request, date)
    expect(normalizeLineEndings(refreshed.raw)).toBe(normalizeLineEndings(savedRaw))
    expect(refreshed.metadata.id).toBe(document.documentId)
    expect(refreshed.metadata.mood).toBe(unknownMood)

    const tab = page.locator(`[role="tab"][data-tab-id="${path}"]`)
    await tab.locator('.tab-close').click()
    await expect(tab).toHaveCount(0)
    await expect(page.getByTestId('diary-calendar')).toBeVisible()
    const closedMoodButton = page.locator(`[data-testid="diary-calendar-mood"][data-date="${date}"]`)
    await expect(closedMoodButton).toHaveText('?')

    await clickDiaryDate(page, date)
    await assertNativeReader(page, date)
    const reopened = await readDiary(request, date)
    expect(normalizeLineEndings(reopened.raw)).toBe(normalizeLineEndings(savedRaw))
    expect(reopened.metadata.id).toBe(document.documentId)
    expect(reopened.metadata.mood).toBe(unknownMood)

    await page.locator(`[role="tab"][data-tab-id="${path}"] .tab-close`).click()
    await expect(page.getByTestId('diary-calendar')).toBeVisible()
    await expect(page.locator(`[data-testid="diary-calendar-mood"][data-date="${date}"]`)).toHaveText('?')
  } finally {
    await deletePost(request, path)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test.skip('D8.2: managed Diary Mood History restore waits for an adapter-aware owner', async ({ page, request }) => {
  const date = await findUnusedDiaryDate(request)
  const path = diaryPath(date)
  const historicalRaw = `# D7.4 history A ${RUN_ID}\nHistorical body ${RUN_ID}\n`
  const currentRaw = `# D7.4 history B ${RUN_ID}\nCurrent body ${RUN_ID}\n`
  const subject = `D7.4 Mood history ${RUN_ID}`
  const state = diagnostics(page)

  try {
    const document = await seedDiary(request, date, historicalRaw)
    await setDiaryMood(request, date, 'happy')
    const revisionId = await commitDiaryRevision(request, date, historicalRaw, subject)

    const changed = await request.put(`/api/posts/${path}`, {
      data: { raw: currentRaw, baseRaw: historicalRaw },
    })
    expect(changed.status(), await changed.text()).toBe(200)
    const changedMood = await setDiaryMood(request, date, 'sad')
    const current = await readDiary(request, date)
    expect(current.metadata.id).toBe(document.documentId)
    expect(current.metadata.mood).toBe('sad')

    await openDiaryHome(page)
    await clickDiaryDate(page, date)
    await assertNativeReader(page, date)
    await page.locator('button.ab-btn[aria-label="History"], button.ab-btn[aria-label="历史"]').first().click()
    const history = page.locator('.history-panel')
    await expect(history).toBeVisible()
    const day = history.locator('.history-timeline-group-header').first()
    await expect(day).toBeVisible({ timeout: 15_000 })
    if (await day.getAttribute('aria-expanded') !== 'true') await day.click()
    const commit = history.locator('.history-commit-row').filter({ hasText: subject })
    await expect(commit).toBeVisible({ timeout: 15_000 })
    if (await commit.getAttribute('aria-expanded') !== 'true') await commit.click()
    const file = history.locator('.history-file-row').filter({ hasText: date }).first()
    await expect(file).toBeVisible({ timeout: 15_000 })
    await file.click()

    const comparison = page.locator('.history-comparison-pane')
    await expect(comparison).toBeVisible({ timeout: 15_000 })
    await expect(comparison).toContainText('Historical body')
    await comparison.getByRole('button', { name: 'More actions' }).click()
    const restoreAction = page.getByRole('menuitem', { name: /Restore to this version/ })
    await expect(restoreAction).toBeVisible()
    await restoreAction.click()
    const confirmation = page.locator('.n-dialog[role="dialog"]')
    await expect(confirmation).toBeVisible()
    await confirmation.getByRole('button').last().click()

    await expect.poll(async () => (await readDiary(request, date)).raw).toBe(historicalRaw)
    const restored = await readDiary(request, date)
    expect(restored.metadata.id).toBe(document.documentId)
    expect(restored.metadata.mood).toBe('happy')
    expect(restored.metadata.updatedAt).toBeGreaterThan(current.metadata.updatedAt)
    expect(changedMood.id).toBe(document.documentId)
    expect(revisionId).toMatch(/^[0-9a-f]{40}$/)

    const diffTab = page.locator(`[data-tab-id="diff:${path}"]`)
    await expect(diffTab).toHaveCount(1)
    await diffTab.locator('.tab-close').click()
    const diaryTab = page.locator(`[role="tab"][data-tab-id="${path}"]`)
    await expect(diaryTab).toHaveCount(1)
    await diaryTab.locator('.tab-close').click()
    await expect(page.getByTestId('diary-calendar')).toBeVisible()
    await expect(page.locator(`[data-testid="diary-calendar-mood"][data-date="${date}"] img`)).toHaveAttribute('src', '/emoji/开心.svg')
  } finally {
    await deletePost(request, path)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test.skip('D8.2: managed Diary Mood baseline Recovery waits for an encrypted recovery adapter', async ({ page, request }) => {
  const date = await findUnusedDiaryDate(request)
  const path = diaryPath(date)
  const baseRaw = `# D7.4 baseline recovery ${RUN_ID}\n`
  const recoveredMarker = `D74_RECOVERED_${RUN_ID}`
  const recoveredRaw = `${baseRaw}\n${recoveredMarker}`
  const state = diagnostics(page, ['net::ERR_FAILED'])
  let autosaveInstalled = false

  try {
    const document = await seedDiary(request, date, baseRaw)
    await setDiaryMood(request, date, 'happy')
    await openDiaryHome(page)
    await clickDiaryDate(page, date)
    await assertNativeReader(page, date)
    await enterEditor(page)
    await interceptAutosaveAborted(page, path)
    autosaveInstalled = true
    await appendEditorText(page, recoveredMarker)
    await expect(page.locator(`[data-tab-id="${path}"][data-save-status="dirty"]`)).toBeVisible({ timeout: 15_000 })
    await expect.poll(() => draftRowCount(page, recoveredMarker), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)

    await page.reload()
    await expect(page.getByTestId('diary-calendar')).toBeHidden({ timeout: 15_000 })
    await expect(page.locator('.draft-recovery-backdrop')).toHaveCount(0)
    await expect(page.locator('.editor-pane .monaco-editor .view-lines').first()).toContainText(recoveredMarker, { timeout: 15_000 })
    await expect(page.locator(`[data-tab-id="${path}"][data-save-status="dirty"]`)).toHaveCount(1)

    const adopted = await readDiary(request, date)
    expect(adopted.metadata.id).toBe(document.documentId)
    expect(adopted.metadata.mood).toBe('happy')
    expect(normalizeLineEndings(adopted.raw)).toBe(normalizeLineEndings(baseRaw))

    await page.unroute(`**/api/posts/${path}`)
    autosaveInstalled = false
    await page.locator('.vault').focus()
    await page.keyboard.press('Control+s')
    await expect(page.locator(`[data-tab-id="${path}"][data-save-status="saved"]`)).toBeVisible({ timeout: 15_000 })
    const saved = await readDiary(request, date)
    expect(normalizeLineEndings(saved.raw)).toBe(normalizeLineEndings(recoveredRaw))
    expect(saved.metadata.id).toBe(document.documentId)
    expect(saved.metadata.mood).toBe('happy')
  } finally {
    if (autosaveInstalled) await page.unroute(`**/api/posts/${path}`)
    await deletePost(request, path)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test.skip('D8.2: managed Diary Mood divergent Recovery waits for an encrypted recovery adapter', async ({ page, request }) => {
  const date = await findUnusedDiaryDate(request)
  const path = diaryPath(date)
  const baseRaw = `# D7.4 divergent recovery ${RUN_ID}\n`
  const draftMarker = `D74_DRAFT_${RUN_ID}`
  const diskMarker = `D74_DISK_${RUN_ID}`
  const diskRaw = `${baseRaw}\n${diskMarker}\n`
  const state = diagnostics(page, ['net::ERR_FAILED'])
  let autosaveInstalled = false

  try {
    const document = await seedDiary(request, date, baseRaw)
    await setDiaryMood(request, date, 'happy')
    await openDiaryHome(page)
    await clickDiaryDate(page, date)
    await assertNativeReader(page, date)
    await enterEditor(page)
    await interceptAutosaveAborted(page, path)
    autosaveInstalled = true
    await appendEditorText(page, draftMarker)
    await expect(page.locator(`[data-tab-id="${path}"][data-save-status="dirty"]`)).toBeVisible({ timeout: 15_000 })
    await expect.poll(() => draftRowCount(page, draftMarker), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)

    await fs.appendFile(nodePath.join(E2E_VAULT, `${path}.md`), `\n${diskMarker}\n`, 'utf8')
    const current = await readDiary(request, date)
    await setDiaryMood(request, date, 'sad', current.metadata.updatedAt)
    await page.reload()

    const dialog = page.locator('.draft-recovery-dialog')
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await expect(dialog).toContainText('The draft and disk version may both have changed.')
    await dialog.getByRole('button', { name: 'View Diff' }).click()
    const pane = page.locator('.draft-recovery-pane')
    await expect(pane).toBeVisible({ timeout: 15_000 })
    await expect(pane).toContainText(draftMarker)
    await expect(pane).toContainText(diskMarker)
    await expect(page.getByTestId('diary-calendar')).toBeHidden()
    await pane.getByRole('button', { name: 'Open Recovered Content' }).click()
    await expect(pane).toContainText(draftMarker)
    await pane.getByRole('button', { name: 'Use Disk Version' }).click()
    await expect(pane).toHaveCount(0)
    await expect.poll(() => draftRowCount(page, draftMarker), { timeout: 15_000 }).toBe(0)

    const resolved = await readDiary(request, date)
    expect(resolved.metadata.id).toBe(document.documentId)
    expect(resolved.metadata.mood).toBe('sad')
    expect(normalizeLineEndings(resolved.raw)).toBe(normalizeLineEndings(diskRaw))

    await page.unroute(`**/api/posts/${path}`)
    autosaveInstalled = false
    await reloadApp(page)
    await expect(page.getByTestId('diary-calendar')).toBeHidden()
    await expect(page.locator(`[data-tab-id="${path}"]`)).toHaveCount(1)
    const reopened = await readDiary(request, date)
    expect(reopened.metadata.id).toBe(document.documentId)
    expect(reopened.metadata.mood).toBe('sad')
    expect(normalizeLineEndings(reopened.raw)).toBe(normalizeLineEndings(diskRaw))
  } finally {
    if (autosaveInstalled) await page.unroute(`**/api/posts/${path}`)
    await deletePost(request, path)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test('Mood CAS rejects stale metadata and managed direct delete removes the same identity', async ({ request }) => {
  const date = await findUnusedDiaryDate(request)
  const path = diaryPath(date)

  try {
    const original = await seedDiary(request, date, `# D7.4 CAS ${RUN_ID}\n`)
    const happy = await setDiaryMood(request, date, 'happy')
    const changed = await setDiaryMood(request, date, 'sad', happy.updatedAt)
    const stale = await request.patch(`/api/metadata/documents/${path}`, {
      data: { mood: null, expectedUpdatedAt: happy.updatedAt },
    })
    const staleBody = await stale.text()
    expect(stale.status(), staleBody).toBe(409)

    const current = await readDiary(request, date)
    expect(current.raw).toBe(original.raw)
    expect(current.metadata.id).toBe(original.documentId)
    expect(current.metadata.mood).toBe('sad')
    expect(changed.id).toBe(original.documentId)

    const deleted = await request.delete(`/api/posts/${path}`)
    expect(deleted.status(), await deleted.text()).toBe(200)
    expect(await deleted.json()).toEqual({ ok: true })
    expect((await request.get(`/api/posts/${path}`)).status()).toBe(404)
  } finally {
    await deletePost(request, path)
  }
})

test('navigation preserves same-date Diary identity and Calendar visibility across managed tabs', async ({ page, request }) => {
  const firstDate = await findUnusedDiaryDate(request)
  const secondDate = await findUnusedDiaryDate(request, [firstDate])
  const firstPath = diaryPath(firstDate)
  const secondPath = diaryPath(secondDate)
  const state = diagnostics(page)
  let diaryCreateRequests = 0
  let moodPatchRequests = 0

  page.on('request', (outgoing) => {
    const pathname = new URL(outgoing.url()).pathname
    if (outgoing.method() === 'POST' && pathname === '/api/diary/dates') diaryCreateRequests += 1
    if (outgoing.method() === 'PATCH' && pathname === `/api/metadata/documents/${firstPath}`) moodPatchRequests += 1
    if (outgoing.method() === 'PATCH' && pathname === `/api/metadata/documents/${secondPath}`) moodPatchRequests += 1
  })

  try {
    const first = await seedDiary(request, firstDate, `# Round 3 Diary A ${RUN_ID}\n`)
    const second = await seedDiary(request, secondDate, `# Round 3 Diary B ${RUN_ID}\n`)
    await setDiaryMood(request, firstDate, 'happy')
    await setDiaryMood(request, secondDate, 'sad')
    const firstStored = await readDiary(request, firstDate)
    const secondStored = await readDiary(request, secondDate)
    expect(firstStored.metadata.id).toBe(first.documentId)
    expect(secondStored.metadata.id).toBe(second.documentId)

    await openDiaryHome(page)
    await clickDiaryDate(page, firstDate)
    await assertNativeReader(page, firstDate)
    await expect(page.locator(`[role="tab"][data-tab-id="${firstPath}"]`)).toHaveCount(1)
    await expect(page.getByTestId('diary-calendar')).toBeHidden()

    // Opening another existing Diary follows the generic route/tab owner and
    // must not create a second copy of the first document.
    await page.goto(`/vault/${secondPath}`)
    await assertNativeReader(page, secondDate, firstDate)
    await expect(page.locator(`[role="tab"][data-tab-id="${firstPath}"]`)).toHaveCount(1)
    await expect(page.locator(`[role="tab"][data-tab-id="${secondPath}"]`)).toHaveCount(1)
    await expect(page.getByTestId('diary-calendar')).toBeHidden()

    await selectWorkspaceTab(page, firstPath)
    await assertNativeReader(page, firstDate, firstDate)
    await expect(page.getByTestId('diary-calendar')).toBeHidden()
    await selectWorkspaceTab(page, secondPath)
    await assertNativeReader(page, secondDate, firstDate)
    await expect(page.getByTestId('diary-calendar')).toBeHidden()

    await page.locator(`[role="tab"][data-tab-id="${secondPath}"] .tab-close`).click()
    await expect(page.locator(`[role="tab"][data-tab-id="${secondPath}"]`)).toHaveCount(0)
    await expect(page.locator(`[role="tab"][data-tab-id="${firstPath}"]`)).toHaveAttribute('aria-selected', 'true')
    await assertNativeReader(page, firstDate, firstDate)
    await expect(page.getByTestId('diary-calendar')).toBeHidden()

    // Only the final managed Diary close may reveal Calendar Home.
    await page.locator(`[role="tab"][data-tab-id="${firstPath}"] .tab-close`).click()
    await expect(page.locator(`[role="tab"][data-tab-id="${firstPath}"]`)).toHaveCount(0)
    await expect(page.getByTestId('diary-calendar')).toBeVisible()
    await expect(page.getByTestId('diary-calendar')).toHaveCount(1)

    // Reopening the same date reuses the canonical document and its Mood;
    // it does not create or mutate anything merely by navigating.
    await clickDiaryDate(page, firstDate)
    await assertNativeReader(page, firstDate, firstDate)
    await expect(page.locator(`[role="tab"][data-tab-id="${firstPath}"]`)).toHaveCount(1)
    await expect(page.getByTestId('diary-calendar')).toBeHidden()
    await expect(page.getByTestId('diary-calendar')).toHaveCount(1)
    await page.locator(`[role="tab"][data-tab-id="${firstPath}"] .tab-close`).click()
    await expect(page.getByTestId('diary-calendar')).toBeVisible()

    const reopened = await readDiary(request, firstDate)
    expect(reopened.metadata.id).toBe(first.documentId)
    expect(reopened.metadata.mood).toBe('happy')
    expect(secondStored.metadata.mood).toBe('sad')
    expect(diaryCreateRequests).toBe(0)
    expect(moodPatchRequests).toBe(0)
  } finally {
    await deletePost(request, firstPath)
    await deletePost(request, secondPath)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test('scope switching and ordinary tab selection preserve the user FileTree query', async ({ page, request }) => {
  const firstDate = await findUnusedDiaryDate(request)
  const secondDate = await findUnusedDiaryDate(request, [firstDate])
  const firstPath = diaryPath(firstDate)
  const secondPath = diaryPath(secondDate)
  const notePath = `inbox/d74-round3-query-${RUN_ID}`
  const customQuery = `round3-custom-${RUN_ID}`
  const state = diagnostics(page)
  let diaryCreateRequests = 0
  let moodPatchRequests = 0

  page.on('request', (outgoing) => {
    const pathname = new URL(outgoing.url()).pathname
    if (outgoing.method() === 'POST' && pathname === '/api/diary/dates') diaryCreateRequests += 1
    if (outgoing.method() === 'PATCH' && pathname.startsWith('/api/metadata/documents/diary/')) moodPatchRequests += 1
  })

  try {
    await seedDiary(request, firstDate, `# Round 3 query A ${RUN_ID}\n`)
    await seedDiary(request, secondDate, `# Round 3 query B ${RUN_ID}\n`)
    await setDiaryMood(request, firstDate, 'happy')
    await setDiaryMood(request, secondDate, 'sad')
    await seedNote(request, notePath, `# Round 3 ordinary note ${RUN_ID}\n`)

    await openDiaryHome(page)
    await clickDiaryDate(page, firstDate)
    await assertNativeReader(page, firstDate)
    await page.goto(`/vault/${secondPath}`)
    await assertNativeReader(page, secondDate, firstDate)
    await page.goto(`/vault/${notePath}`)
    await expect(page.locator(`[role="tab"][data-tab-id="${notePath}"]`)).toHaveAttribute('aria-selected', 'true')

    await selectScope(page, 'note')
    await ensureExplorerVisible(page)
    const search = page.locator('.file-tree .search-input')
    await search.fill(customQuery)
    await expect(search).toHaveValue(customQuery)

    // Selecting a native Diary tab is generic workspace navigation, not a
    // Calendar date intent, so the user query must remain untouched.
    await selectWorkspaceTab(page, firstPath)
    expect(new URL(page.url()).pathname).toBe(`/vault/${firstPath}`)
    await expect(search).toHaveValue(customQuery)
    await selectWorkspaceTab(page, secondPath)
    expect(new URL(page.url()).pathname).toBe(`/vault/${secondPath}`)
    await expect(search).toHaveValue(customQuery)

    // Leaving and re-entering Diary must not erase ordinary user-owned
    // FileTree state. Existing managed Diary tabs still keep Calendar hidden.
    await selectScope(page, 'diary')
    await expect(page.getByTestId('diary-calendar')).toBeHidden()
    await ensureExplorerVisible(page)
    await expect(page.locator('.file-tree .search-input')).toHaveValue(customQuery)
    await selectScope(page, 'note')
    await ensureExplorerVisible(page)
    await expect(page.locator('.file-tree .search-input')).toHaveValue(customQuery)
    await selectScope(page, 'diary')
    await expect(page.getByTestId('diary-calendar')).toBeHidden()
    await ensureExplorerVisible(page)
    await expect(page.locator('.file-tree .search-input')).toHaveValue(customQuery)

    await page.locator(`[role="tab"][data-tab-id="${secondPath}"] .tab-close`).click()
    await expect(page.locator(`[role="tab"][data-tab-id="${secondPath}"]`)).toHaveCount(0)
    await page.locator(`[role="tab"][data-tab-id="${firstPath}"] .tab-close`).click()
    await expect(page.locator(`[role="tab"][data-tab-id="${firstPath}"]`)).toHaveCount(0)
    await expect(page.getByTestId('diary-calendar')).toBeVisible()
    expect(diaryCreateRequests).toBe(0)
    expect(moodPatchRequests).toBe(0)
  } finally {
    await deletePost(request, firstPath)
    await deletePost(request, secondPath)
    await deletePost(request, notePath)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test('a user query stays owned after being edited back to the Calendar date', async ({ page, request }) => {
  const date = await findUnusedDiaryDate(request)
  const path = diaryPath(date)
  const noteName = `d74-round3-query-${date}-${RUN_ID}`
  const notePath = `inbox/${noteName}`
  const state = diagnostics(page)

  try {
    await seedDiary(request, date, `# Round 3 repeated query ${RUN_ID}\n`)
    await seedNote(request, notePath, `# Ordinary note ${RUN_ID}\n`)

    await openDiaryHome(page)
    await clickDiaryDate(page, date)
    await assertNativeReader(page, date)
    await ensureExplorerVisible(page)
    const search = page.locator('.file-tree .search-input')
    await expect(search).toHaveValue(date)

    // The first edit transfers ownership from the Calendar seed to the user.
    // Typing the original date again must not recreate system provenance.
    await search.fill(`round3-temporary-${RUN_ID}`)
    await search.fill(date)
    await expect(search).toHaveValue(date)

    await selectScope(page, 'note')
    await ensureExplorerVisible(page)
    await expect(search).toHaveValue(date)
    await expect(page.locator('.file-tree')).toContainText(noteName)
  } finally {
    await deletePost(request, path)
    await deletePost(request, notePath)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test('a user-owned empty query survives refresh without re-seeding Diary context', async ({ page, request }) => {
  const date = await findUnusedDiaryDate(request)
  const otherDate = await findUnusedDiaryDate(request, [date])
  const path = diaryPath(date)
  const otherPath = diaryPath(otherDate)
  const noteName = `d74-round3-empty-query-${date}-${RUN_ID}`
  const notePath = `inbox/${noteName}`
  const state = diagnostics(page)
  let diaryCreateRequests = 0
  let moodPatchRequests = 0

  page.on('request', (outgoing) => {
    const pathname = new URL(outgoing.url()).pathname
    if (outgoing.method() === 'POST' && pathname === '/api/diary/dates') diaryCreateRequests += 1
    if (outgoing.method() === 'PATCH' && pathname.startsWith('/api/metadata/documents/diary/')) moodPatchRequests += 1
  })

  try {
    await seedDiary(request, date, `# Round 3 empty query ${RUN_ID}\n`)
    await seedDiary(request, otherDate, `# Round 3 second Diary ${RUN_ID}\n`)
    await seedNote(request, notePath, `# Ordinary empty query note ${RUN_ID}\n`)

    await openDiaryHome(page)
    await clickDiaryDate(page, date)
    await assertNativeReader(page, date)
    await ensureExplorerVisible(page)
    const search = page.locator('.file-tree .search-input')
    await expect(search).toHaveValue(date)

    // Clearing the query is still an explicit user edit. Persist that
    // ownership separately from the empty value so refresh cannot infer a
    // new Calendar seed from the active Diary document.
    await search.fill('')
    await expect(search).toHaveValue('')
    await expect.poll(() => page.evaluate(() =>
      localStorage.getItem('nuvyn.diary.filter-ownership'),
    )).toBe('user')

    await page.reload()
    await assertNativeReader(page, date, '')
    await expect.poll(() => page.evaluate(() =>
      localStorage.getItem('nuvyn.diary.filter-ownership'),
    )).toBe('user')

    // With Calendar exact-path projection disabled, another Diary remains
    // visible even though the active native document is still `date`.
    await expect(page.locator(`[data-tree-key="file:${otherPath}"]`)).toBeVisible()

    // Leaving Diary scope must preserve the intentionally empty, user-owned
    // query rather than clearing or re-seeding it for the ordinary tree.
    await selectScope(page, 'note')
    await ensureExplorerVisible(page)
    await expect(search).toHaveValue('')
    const inbox = page.locator('[data-tree-key="folder:inbox"]')
    if (await inbox.getAttribute('aria-expanded') !== 'true') await inbox.locator('.row-line').click()
    await expect(page.locator(`[data-tree-key="file:${notePath}"]`)).toBeVisible()
    await expect(page.locator('.file-tree')).toContainText(noteName)
    expect(diaryCreateRequests).toBe(0)
    expect(moodPatchRequests).toBe(0)
  } finally {
    await deletePost(request, path)
    await deletePost(request, otherPath)
    await deletePost(request, notePath)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test('refresh, deep link, and browser Back/Forward preserve Diary identity, Mood, and query', async ({ page, request }) => {
  const date = await findUnusedDiaryDate(request)
  const path = diaryPath(date)
  const notePath = `inbox/d74-round3-history-${RUN_ID}`
  const customQuery = `round3-refresh-query-${RUN_ID}`
  const state = diagnostics(page)
  let diaryCreateRequests = 0
  let moodPatchRequests = 0

  page.on('request', (outgoing) => {
    const pathname = new URL(outgoing.url()).pathname
    if (outgoing.method() === 'POST' && pathname === '/api/diary/dates') diaryCreateRequests += 1
    if (outgoing.method() === 'PATCH' && pathname === `/api/metadata/documents/${path}`) moodPatchRequests += 1
  })

  try {
    const seeded = await seedDiary(request, date, `# Round 3 refresh ${RUN_ID}\n`)
    await setDiaryMood(request, date, 'happy')
    await seedNote(request, notePath, `# Round 3 history note ${RUN_ID}\n`)
    const before = await readDiary(request, date)
    expect(before.metadata.id).toBe(seeded.documentId)

    await openDiaryHome(page)
    await clickDiaryDate(page, date)
    await assertNativeReader(page, date)
    await ensureExplorerVisible(page)
    await page.locator('.file-tree .search-input').fill(customQuery)
    await expect(page.locator('.file-tree .search-input')).toHaveValue(customQuery)

    await page.reload()
    await assertNativeReader(page, date, customQuery)
    await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveCount(1)
    await expect(page.getByTestId('diary-calendar')).toBeHidden()
    const afterRefresh = await readDiary(request, date)
    expect(afterRefresh.metadata.id).toBe(seeded.documentId)
    expect(afterRefresh.metadata.mood).toBe('happy')

    // Closing the only Diary tab reveals Home, but the query remains ordinary
    // FileTree state and is not replaced by a route-derived date.
    await page.locator(`[role="tab"][data-tab-id="${path}"] .tab-close`).click()
    await expect(page.getByTestId('diary-calendar')).toBeVisible()
    await expect(page.locator('.file-tree .search-input')).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => localStorage.getItem('nuvyn.file-tree.filter')))
      .toBe(customQuery)

    // A direct canonical route is handled by the generic Vault lifecycle.
    await page.goto(`/vault/${path}`)
    await assertNativeReader(page, date, customQuery)
    await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveCount(1)
    const deepLinked = await readDiary(request, date)
    expect(deepLinked.metadata.id).toBe(seeded.documentId)
    expect(deepLinked.metadata.mood).toBe('happy')

    // Build a real generic history sequence and traverse it. The existing
    // route/tab owner selects the already-open Diary without duplicating it.
    await page.goto(`/vault/${notePath}`)
    await expect(page.locator(`[role="tab"][data-tab-id="${notePath}"]`)).toHaveAttribute('aria-selected', 'true')
    await page.goto(`/vault/${path}`)
    await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveCount(1)

    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`/vault/${notePath.replace('/', '\\/')}(?:[?#]|$)`))
    await expect(page.locator(`[role="tab"][data-tab-id="${notePath}"]`)).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveCount(1)
    await expect(page.getByTestId('diary-calendar')).toBeHidden()
    await expect(page.locator('.file-tree .search-input')).toHaveValue(customQuery)

    await page.goForward()
    await assertNativeReader(page, date, customQuery)
    await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveCount(1)
    await expect(page.getByTestId('diary-calendar')).toBeHidden()
    const afterHistory = await readDiary(request, date)
    expect(afterHistory.metadata.id).toBe(seeded.documentId)
    expect(afterHistory.metadata.mood).toBe('happy')

    await page.locator(`[role="tab"][data-tab-id="${path}"] .tab-close`).click()
    await expect(page.getByTestId('diary-calendar')).toBeVisible()
    expect(diaryCreateRequests).toBe(0)
    expect(moodPatchRequests).toBe(0)
  } finally {
    await deletePost(request, path)
    await deletePost(request, notePath)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test('dirty Diary body survives generic tab selection without losing Mood or identity', async ({ page, request }) => {
  const firstDate = await findUnusedDiaryDate(request)
  const secondDate = await findUnusedDiaryDate(request, [firstDate])
  const firstPath = diaryPath(firstDate)
  const secondPath = diaryPath(secondDate)
  const baseRaw = `# Round 3 dirty selection ${RUN_ID}\n`
  const dirtyMarker = `D74_ROUND3_DIRTY_${RUN_ID}`
  const state = diagnostics(page, ['net::ERR_FAILED'])
  let autosaveInstalled = false

  try {
    const first = await seedDiary(request, firstDate, baseRaw)
    const second = await seedDiary(request, secondDate, `# Round 3 second Diary ${RUN_ID}\n`)
    await setDiaryMood(request, firstDate, 'happy')
    await setDiaryMood(request, secondDate, 'sad')

    await openDiaryHome(page)
    await clickDiaryDate(page, firstDate)
    await assertNativeReader(page, firstDate)
    await page.goto(`/vault/${secondPath}`)
    await assertNativeReader(page, secondDate, firstDate)
    await selectWorkspaceTab(page, firstPath)
    await assertNativeReader(page, firstDate, firstDate)

    await enterEditor(page)
    await interceptAutosaveAborted(page, firstPath)
    autosaveInstalled = true
    await appendEditorText(page, dirtyMarker)
    await expect(page.locator(`[data-tab-id="${firstPath}"][data-save-status="dirty"]`)).toBeVisible({ timeout: 15_000 })
    // Managed Diary drafts are memory-only in D8.3; no IndexedDB row may be
    // created while the tab is dirty.
    await expect.poll(() => draftRowCount(page, dirtyMarker), { timeout: 15_000 }).toBe(0)

    const beforeSelection = await readDiary(request, firstDate)
    expect(beforeSelection.raw).toBe(baseRaw)
    expect(beforeSelection.metadata.id).toBe(first.documentId)
    expect(beforeSelection.metadata.mood).toBe('happy')

    await selectWorkspaceTab(page, secondPath)
    await expect(page).toHaveURL(new RegExp(`/vault/${secondPath.replace('/', '\\/')}(?:[?#]|$)`))
    await expect(page.locator(`[data-tab-id="${firstPath}"] .tab-dirty-indicator`)).toHaveCount(1)
    await expect(page.getByTestId('diary-calendar')).toBeHidden()

    await selectWorkspaceTab(page, firstPath)
    await expect(page).toHaveURL(new RegExp(`/vault/${firstPath.replace('/', '\\/')}(?:[?#]|$)`))
    await expect(page.locator(`[data-tab-id="${firstPath}"] .tab-dirty-indicator`)).toHaveCount(1)
    await expect(page.locator('.editor-pane .monaco-editor .view-lines').first()).toContainText(dirtyMarker)
    await expect(page.getByTestId('diary-calendar')).toBeHidden()

    const afterSelection = await readDiary(request, firstDate)
    expect(afterSelection.raw).toBe(baseRaw)
    expect(afterSelection.metadata.id).toBe(first.documentId)
    expect(afterSelection.metadata.mood).toBe('happy')
    const secondAfterSelection = await readDiary(request, secondDate)
    expect(secondAfterSelection.metadata.id).toBe(second.documentId)
    expect(secondAfterSelection.metadata.mood).toBe('sad')

    await page.unroute(`**/api/posts/${firstPath}`)
    autosaveInstalled = false
    await page.locator('.vault').focus()
    await page.keyboard.press('Control+s')
    await expect(page.locator(`[data-tab-id="${firstPath}"][data-save-status="saved"]`)).toBeVisible({ timeout: 15_000 })
    const saved = await readDiary(request, firstDate)
    expect(normalizeLineEndings(saved.raw)).toContain(dirtyMarker)
    expect(saved.metadata.id).toBe(first.documentId)
    expect(saved.metadata.mood).toBe('happy')
    await expect.poll(() => draftRowCount(page, dirtyMarker), { timeout: 15_000 }).toBe(0)
  } finally {
    if (autosaveInstalled) await page.unroute(`**/api/posts/${firstPath}`)
    await deletePost(request, firstPath)
    await deletePost(request, secondPath)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test('refresh preserves Calendar-seed provenance so Diary scope exit clears it', async ({ page, request }) => {
  const date = await findUnusedDiaryDate(request)
  const path = diaryPath(date)
  const notePath = `inbox/d74-round3-seed-refresh-${RUN_ID}`
  const state = diagnostics(page)
  let diaryCreateRequests = 0
  let moodPatchRequests = 0

  page.on('request', (outgoing) => {
    const pathname = new URL(outgoing.url()).pathname
    if (outgoing.method() === 'POST' && pathname === '/api/diary/dates') diaryCreateRequests += 1
    if (outgoing.method() === 'PATCH' && pathname.startsWith('/api/metadata/documents/diary/')) moodPatchRequests += 1
  })

  try {
    await seedDiary(request, date, `# Round 3 refresh seed provenance ${RUN_ID}\n`)
    await seedNote(request, notePath, `# Round 3 refresh seed note ${RUN_ID}\n`)

    // Enter Diary scope through Calendar, so the date becomes a Calendar seed.
    await openDiaryHome(page)
    await clickDiaryDate(page, date)
    await assertNativeReader(page, date)
    await ensureExplorerVisible(page)
    const search = page.locator('.file-tree .search-input')
    await expect(search).toHaveValue(date)

    // Refresh the page while the Calendar-seeded query is still in place.
    // `filesFilter` survives via useStorage; the seed must survive too so the
    // scope-exit check can still recognise it as a system seed.
    await page.reload()
    await assertNativeReader(page, date)
    await expect(search).toHaveValue(date)

    // Leaving Diary scope after refresh must still classify the persisted
    // query as a Calendar seed (not a user query) and clear it. Otherwise the
    // ordinary Note tree inherits a Diary presentation filter — that is the
    // Round 3 refresh-provenance P2 the independent review found.
    await selectScope(page, 'note')
    await ensureExplorerVisible(page)
    await expect(search).toHaveValue('')

    // Navigating to an ordinary Note path after scope exit must not re-seed
    // the FileTree query with the previously persisted Diary date either.
    await page.goto(`/vault/${notePath}`)
    await expect(page.locator(`[role="tab"][data-tab-id="${notePath}"]`)).toHaveAttribute('aria-selected', 'true')
    await ensureExplorerVisible(page)
    await expect(search).toHaveValue('')

    expect(diaryCreateRequests).toBe(0)
    expect(moodPatchRequests).toBe(0)
  } finally {
    await deletePost(request, path)
    await deletePost(request, notePath)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})
