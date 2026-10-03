import { closeCurrentWorkspaceDocument, expect, goBackFromDiaryDocument, test, type APIRequestContext, type Page } from './fixtures/diary'
import {
  appendEditorText,
  clearDraftDatabase,
  gotoVaultReady,
  openRecoveryDialog,
  seedRecoveryDraft,
} from './helpers/edit-program'
import { CALENDAR_TEST_DATE, CALENDAR_TEST_TIME_ZONE, calendarDay } from './helpers/calendar-clock'

const TEST_TIME_ZONE = CALENDAR_TEST_TIME_ZONE
const RUN_ID = String(Date.now())

test.use({ timezoneId: TEST_TIME_ZONE, trace: 'off', screenshot: 'only-on-failure' })

type Viewport = { name: string; width: number; height: number }

const CALENDAR_VIEWPORTS: Viewport[] = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 375, height: 812 },
  { name: 'narrow', width: 320, height: 700 },
]

const CALENDAR_BREAKPOINT_VIEWPORTS: Viewport[] = [
  { name: 'right-rail-visible-boundary', width: 601, height: 812 },
  { name: 'right-rail-hidden-boundary', width: 600, height: 812 },
  { name: 'compact-title-boundary', width: 421, height: 812 },
  { name: 'compact-title-active', width: 420, height: 812 },
]

const DOCUMENT_VIEWPORTS: Viewport[] = [
  ...CALENDAR_VIEWPORTS,
  { name: 'mobile-390', width: 390, height: 844 },
  { name: 'desktop-1440', width: 1440, height: 900 },
  { name: 'wide', width: 2560, height: 1440 },
]

function localCivilDate(): string {
  return CALENDAR_TEST_DATE
}

function nextCivilDate(value: string): string {
  const date = new Date(`${value}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}

function diaryPath(date: string): string {
  return `diary/${date}`
}

async function deletePost(request: APIRequestContext, path: string): Promise<void> {
  const response = await request.delete(`/api/posts/${path}`)
  expect(path.startsWith('diary/') ? [200, 404, 422] : [200, 404]).toContain(response.status())
}

async function seedDiary(
  request: APIRequestContext,
  date: string,
  raw: string,
): Promise<{ documentId: string; raw: string }> {
  const path = diaryPath(date)
  await deletePost(request, path)
  const created = await request.post('/api/diary/dates', {
    data: { date, timeZone: TEST_TIME_ZONE },
  })
  expect(created.status(), await created.text()).toBe(201)

  const initialResponse = await request.get(`/api/posts/${path}`)
  expect(initialResponse.status()).toBe(200)
  const initial = await initialResponse.json() as { raw: string }
  const saved = await request.put(`/api/posts/${path}`, {
    data: { raw, baseRaw: initial.raw },
  })
  expect(saved.status(), await saved.text()).toBe(200)

  const detailResponse = await request.get(`/api/posts/${path}`)
  expect(detailResponse.status()).toBe(200)
  const detail = await detailResponse.json() as { raw: string; metadata?: { id?: string } }
  expect(detail.metadata?.id).toEqual(expect.any(String))
  return { documentId: detail.metadata!.id!, raw: detail.raw }
}

async function setDiaryMood(
  request: APIRequestContext,
  date: string,
  mood: string,
): Promise<void> {
  const current = await request.get(`/api/posts/${diaryPath(date)}`)
  expect(current.status(), await current.text()).toBe(200)
  const metadata = await current.json() as { metadata: { updatedAt: number } }
  const response = await request.patch(`/api/metadata/documents/${diaryPath(date)}`, {
    data: { mood, expectedUpdatedAt: metadata.metadata.updatedAt },
  })
  expect(response.status(), await response.text()).toBe(200)
}

async function seedNote(request: APIRequestContext, path: string): Promise<void> {
  await deletePost(request, path)
  const created = await request.post('/api/posts', {
    data: { path, title: path.split('/').at(-1) },
  })
  expect([200, 201]).toContain(created.status())
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

async function activateDiaryDate(page: Page, date: string, method: 'mouse' | 'keyboard' = 'mouse'): Promise<void> {
  await moveToMonth(page, date)
  const day = calendarDay(page.getByTestId('diary-calendar'), date)
  await expect(day).toBeVisible()
  if (method === 'mouse') await day.click()
  else {
    await day.focus()
    await page.keyboard.press('Enter')
  }
}

test('active Diary re-selection returns to Calendar Home on desktop and mobile', async ({ page, request }) => {
  const date = localCivilDate()
  const path = diaryPath(date)

  try {
    await seedDiary(request, date, `# Diary re-select ${RUN_ID}\n`)
    await gotoVaultReady(page)

    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 375, height: 812 },
    ]) {
      await page.setViewportSize(viewport)
      await openDiaryHome(page)
      const calendar = page.getByTestId('diary-calendar')
      const initialMonth = await calendar.getAttribute('data-month')
      await expect(page).toHaveURL(/\/vault(?:[?#]|$)/)

      // Re-selecting Calendar Home is a no-op: it preserves route/month and
      // does not open or close a managed Diary document.
      await page.locator('.scope-chip').filter({ hasText: 'diary' }).click()
      await expect(page).toHaveURL(/\/vault(?:[?#]|$)/)
      await expect(calendar).toBeVisible()
      await expect(calendar).toHaveAttribute('data-month', initialMonth!)
      await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveCount(0)

      await activateDiaryDate(page, date)
      await assertNativeRead(page, date)
      const diaryTab = page.locator(`[role="tab"][data-tab-id="${path}"]`)
      await expect(diaryTab).toHaveAttribute('aria-selected', 'true')

      // The exact same active navigation item invokes Diary Back on both
      // viewport sizes; no extra mobile control or close policy is involved.
      await page.locator('.scope-chip').filter({ hasText: 'diary' }).click()
      await expect(diaryTab).toHaveCount(0)
      await expect(calendar).toBeVisible()
      await expect(page.getByTestId('diary-workspace-home')).toBeVisible()
      await expect(page).toHaveURL(/\/vault(?:[?#]|$)/)
    }
  } finally {
    await deletePost(request, path)
  }
})

test('active Diary re-selection after a direct route reload returns to Calendar Home', async ({ page, request }) => {
  const date = localCivilDate()
  const path = diaryPath(date)

  try {
    await seedDiary(request, date, `# Direct route Diary re-select ${Date.now()}\n`)
    await openDiaryHome(page)
    await page.goto(`/vault/${path}`)
    const diaryTab = page.locator(`[role="tab"][data-tab-id="${path}"]`)
    await expect(diaryTab).toHaveAttribute('aria-selected', 'true')
    await page.reload()
    await expect(diaryTab).toHaveAttribute('aria-selected', 'true')

    await goBackFromDiaryDocument(page)
    await expect(page.getByTestId('diary-calendar')).toBeVisible()
    await expect(page).toHaveURL(/\/vault(?:[?#]|$)/)

    await page.goto(`/vault/${path}`)
    await expect(diaryTab).toHaveAttribute('aria-selected', 'true')
    await page.locator('.scope-chip').filter({ hasText: 'diary' }).click()

    await expect(diaryTab).toHaveCount(0)
    await expect(page.getByTestId('diary-calendar')).toBeVisible()
    await expect(page.getByTestId('diary-workspace-home')).toBeVisible()
    await expect(page).toHaveURL(/\/vault(?:[?#]|$)/)
  } finally {
    await deletePost(request, path)
  }
})

test('Diary Back remains available after consecutive FileTree Diary switches', async ({ page, request }) => {
  const dates = [
    '2026-08-16',
    '2026-08-17',
    '2026-08-18',
    '2026-08-19',
    '2026-08-20',
  ]
  const paths = dates.map(diaryPath)

  try {
    for (const date of dates) {
      await seedDiary(request, date, `# Sequential Diary Back ${date} ${RUN_ID}\n`)
    }

    await openDiaryHome(page)
    await activateDiaryDate(page, dates[0])
    await assertNativeRead(page, dates[0])
    await page.keyboard.press('g')
    await page.keyboard.press('b')
    await expect(page.getByTestId('diary-calendar')).toBeVisible()
    await expect(page).toHaveURL(/\/vault(?:[?#]|$)/)

    for (let targetIndex = 1; targetIndex < dates.length; targetIndex += 1) {
      const sourceDate = dates[targetIndex - 1]!
      const date = dates[targetIndex]!
      const path = diaryPath(date)
      await activateDiaryDate(page, sourceDate)
      await assertNativeRead(page, sourceDate)
      await ensureExplorerVisible(page)

      const filter = page.locator('.file-tree .search-input').first()
      await expect(filter).toBeVisible()
      await filter.fill('')
      const row = page.locator(`[data-tree-key="file:${path}"]`)
      await expect(row).toBeVisible()
      await row.locator('.row-line').click()

      await assertNativeRead(page, date, '')
      await expect.poll(() => page.evaluate(() => (
        (document.activeElement as HTMLElement | null)?.dataset.treeKey ?? null
      ))).toBe(`file:${path}`)
      await expect(page.locator('[role="tab"][data-tab-id^="diary/"]')).toHaveCount(1)

      // The Diary fixture pins Date.now. Move the mocked wall clock forward
      // by one millisecond so this keyboard chord is a distinct browser event
      // from the nested FileTree row activation.
      const browserNow = await page.evaluate(() => Date.now())
      await page.clock.setSystemTime(new Date(browserNow + 1))
      await page.keyboard.press('g')
      await page.keyboard.press('b')

      await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveCount(0)
      await expect(page.locator('[role="tab"][data-tab-id^="diary/"]')).toHaveCount(0)
      await expect(page.getByTestId('diary-calendar')).toBeVisible()
      await expect(page.getByTestId('diary-workspace-shell'))
        .toHaveAttribute('data-presentation-mode', 'home')
      await expect(page).toHaveURL(/\/vault(?:[?#]|$)/)
    }
  } finally {
    for (const path of paths) await deletePost(request, path)
  }
})

async function ensureExplorerVisible(page: Page): Promise<void> {
  const fileTree = page.locator('.file-tree')
  if (!(await fileTree.isVisible())) {
    const diaryScope = page.locator('.scope-chip').filter({ hasText: 'diary' })
    if (await diaryScope.getAttribute('aria-pressed') === 'true') {
      const leftPanelToggle = page.getByTestId('left-panel-toggle')
      await expect(leftPanelToggle).toBeVisible()
      if (await leftPanelToggle.getAttribute('aria-pressed') !== 'true') await leftPanelToggle.click()
    } else {
      const explorer = page.getByRole('button', { name: /Explorer|文件资源管理器/i })
      await expect(explorer).toBeVisible()
      if (await explorer.getAttribute('aria-pressed') !== 'true') await explorer.click()
    }
  }
  await expect(fileTree).toBeVisible({ timeout: 15_000 })
}

async function openNoteDocument(page: Page, path: string): Promise<void> {
  await page.goto('/vault')
  await selectScope(page, 'note')
  await ensureExplorerVisible(page)
  const row = page.locator(`[data-tree-key="file:${path}"]`)
  if (!(await row.isVisible())) {
    const folder = page.locator(`[data-tree-key="folder:${path.split('/')[0]}"]`)
    await expect(folder).toBeVisible()
    await folder.locator('.row-line').click()
  }
  await expect(row).toBeVisible()
  await row.locator('.row-line').click()
  await expect(page).toHaveURL(new RegExp(`/vault/${path.replace('/', '\\/')}(?:[?#]|$)`))
  await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveAttribute('aria-selected', 'true')
}

async function assertNativeRead(page: Page, date: string, expectedFilter = date): Promise<void> {
  const path = diaryPath(date)
  await expect(page).toHaveURL(new RegExp(`/vault/${path.replace('/', '\\/')}(?:[?#]|$)`))
  await expect(page.getByTestId('diary-reader-dialog')).toHaveCount(0)
  await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.reading-pane')).toHaveCount(1)
  await expect(page.locator('.reading-pane')).toBeVisible()
  const width = page.viewportSize()?.width ?? 1280
  if (width > 600) {
    await ensureExplorerVisible(page)
    const search = page.locator('.file-tree .search-input')
    await expect(search).toBeVisible()
    await expect(search).toHaveValue(expectedFilter)
  } else {
    const leftPanelToggle = page.getByTestId('left-panel-toggle')
    await expect(leftPanelToggle).toHaveAttribute('aria-pressed', 'false')
    await expect(page.locator('.file-tree')).toHaveCount(0)
    await expect(page.locator('.search-input')).toHaveCount(0)
  }
  await expect(page.getByTestId('diary-calendar')).toBeAttached()
  await expect(page.getByTestId('diary-calendar')).toBeHidden()
}

async function ensureNativeReadMode(page: Page): Promise<void> {
  const toggle = page.getByTestId('view-toggle')
  await expect(toggle).toBeVisible()
  if (/read|阅读/i.test(await toggle.getAttribute('aria-label') ?? '')) await toggle.click()
  await expect(page.locator('.reading-pane')).toBeVisible()
}

async function captureDiagnostics(page: Page): Promise<{
  pageErrors: string[]
  consoleErrors: string[]
}> {
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  return { pageErrors, consoleErrors }
}

async function assertFocusRing(
  locator: ReturnType<Page['locator']>,
  options: { targetSize?: boolean; outlineOffset?: string } = {},
): Promise<void> {
  const style = await locator.evaluate((element) => {
    const computed = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return {
      outlineStyle: computed.outlineStyle,
      outlineWidth: computed.outlineWidth,
      outlineColor: computed.outlineColor,
      outlineOffset: computed.outlineOffset,
      rect: { width: rect.width, height: rect.height },
    }
  })
  expect(style.outlineStyle).toBe('solid')
  expect(style.outlineWidth).toBe('2px')
  expect(style.outlineOffset).toBe(options.outlineOffset ?? '2px')
  expect(style.outlineColor).not.toMatch(/transparent|rgba?\(0,\s*0,\s*0(?:,\s*0)?\)/i)
  if (options.targetSize !== false) {
    expect(style.rect.width).toBeGreaterThanOrEqual(40)
    expect(style.rect.height).toBeGreaterThanOrEqual(40)
  }
}

async function focusWithKeyboard(page: Page, locator: ReturnType<Page['locator']>): Promise<void> {
  await page.locator('.vault').focus()
  for (let attempt = 0; attempt < 64; attempt += 1) {
    await page.keyboard.press('Tab')
    if (await locator.evaluate((element) => element === document.activeElement)) return
  }
  throw new Error('control did not receive focus through keyboard Tab navigation')
}

async function calendarMetrics(page: Page): Promise<{
  viewportWidth: number
  viewportHeight: number
  scrollWidth: number
  surface: { left: number; right: number; top: number; bottom: number; width: number; height: number } | null
  host: { left: number; right: number; top: number; bottom: number; width: number; height: number } | null
  container: { left: number; right: number; top: number; bottom: number; width: number; height: number } | null
  title: { left: number; right: number; top: number; bottom: number; width: number; height: number } | null
  previous: { left: number; right: number; top: number; bottom: number; width: number; height: number } | null
  next: { left: number; right: number; top: number; bottom: number; width: number; height: number } | null
  dayCount: number
  minDayWidth: number
  minDayHeight: number
  maxDayBottom: number
  titleText: string
  titleFits: boolean
}> {
  return page.evaluate(() => {
    type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number }
    const box = (element: Element | null): Box | null => {
      if (!(element instanceof HTMLElement)) return null
      const rect = element.getBoundingClientRect()
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      }
    }
    const visible = (element: HTMLElement): boolean => {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0
    }
    const days = [...document.querySelectorAll<HTMLElement>('[data-diary-day-content]')]
      .filter(visible)
      .map((element) => box(element))
      .filter((value): value is Box => value !== null)
    const titleElement = document.querySelector<HTMLElement>('[data-testid="diary-calendar-month"]')
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      surface: box(document.querySelector('[data-testid="diary-calendar-surface"]')),
      host: box(document.querySelector('.diary-calendar-host')),
      container: box(document.querySelector('.diary-calendar-host .n-calendar')),
      title: box(titleElement),
      previous: box(document.querySelector('[data-diary-calendar-nav="previous"]')),
      next: box(document.querySelector('[data-diary-calendar-nav="next"]')),
      dayCount: days.length,
      minDayWidth: days.length ? Math.min(...days.map((value) => value.width)) : 0,
      minDayHeight: days.length ? Math.min(...days.map((value) => value.height)) : 0,
      maxDayBottom: days.length ? Math.max(...days.map((value) => value.bottom)) : 0,
      titleText: titleElement?.textContent?.trim() ?? '',
      titleFits: titleElement ? titleElement.scrollWidth <= titleElement.clientWidth + 1 : false,
    }
  })
}

async function assertNoDocumentOverflow(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }))
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.viewportWidth + 1)
}

async function documentMetrics(page: Page): Promise<{
  viewportWidth: number
  scrollWidth: number
  editorAreaWidth: number
  editorAreaLeft: number
  editorAreaRight: number
  activityRight: number
  fileTreeWidth: number
  rightRailVisible: boolean
}> {
  return page.evaluate(() => {
    const rect = (selector: string) => document.querySelector<HTMLElement>(selector)?.getBoundingClientRect()
    const editorArea = rect('.editor-area')
    const activity = rect('.activity-bar')
    const fileTree = rect('.file-tree')
    const rightRail = document.querySelector<HTMLElement>('.right-rail-slot')
    const rightRailStyle = rightRail ? getComputedStyle(rightRail) : null
    return {
      viewportWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      editorAreaWidth: editorArea?.width ?? 0,
      editorAreaLeft: editorArea?.left ?? 0,
      editorAreaRight: editorArea?.right ?? 0,
      activityRight: activity?.right ?? 0,
      fileTreeWidth: fileTree?.width ?? 0,
      rightRailVisible: Boolean(rightRail && rightRailStyle?.display !== 'none' && rightRailStyle?.visibility !== 'hidden'),
    }
  })
}

test.beforeEach(async ({ page }) => {
  await page.goto('/__markdown-test?mode=reading')
  await page.evaluate(() => localStorage.clear())
  await clearDraftDatabase(page)
  await gotoVaultReady(page)
})

test('Calendar Home semantics and layout pass the full responsive matrix', async ({ page, request }) => {
  const date = localCivilDate()
  const state = await captureDiagnostics(page)

  try {
    await seedDiary(request, date, `# D6.6 Calendar ${RUN_ID}\n`)
    await openDiaryHome(page)

    const surface = page.getByTestId('diary-calendar-surface')
    const calendar = page.getByTestId('diary-calendar')
    const previous = page.locator('[data-diary-calendar-nav="previous"]')
    const next = page.locator('[data-diary-calendar-nav="next"]')
    const dateButton = calendarDay(page.getByTestId('diary-calendar'), date)

    await expect(surface).toHaveAttribute('role', 'region')
    await expect(surface).toHaveAccessibleName(/Diary calendar workspace|日记日历工作区/i)
    await expect(calendar).toHaveAttribute('role', 'region')
    await expect(calendar).toHaveAccessibleName(/Diary calendar|日记日历/i)
    await expect(previous).toHaveAccessibleName(/Previous month|上个月/i)
    await expect(next).toHaveAccessibleName(/Next month|下个月/i)
    await expect(dateButton).toBeEnabled()
    await expect(dateButton).toHaveAccessibleName(/Diary exists|有日记/i)
    await expect(page.locator('.diary-calendar-surface-header')).toHaveCount(0)
    await expect(page.locator('.diary-calendar-toolbar')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Today|今天/i, exact: true })).toHaveCount(0)

    const nestedControlAudit = await page.evaluate(() => {
      const cells = [...document.querySelectorAll<HTMLElement>('.n-calendar-cell')]
        .filter((cell) => getComputedStyle(cell).display !== 'none')
      return cells.map((cell) => {
        const content = cell.querySelector<HTMLElement>('.diary-calendar-day-content')
        const dateButton = content?.querySelector<HTMLElement>(
          ':scope > [data-diary-day-content]',
        ) ?? null
        const moodButton = content?.querySelector<HTMLElement>(
          ':scope > [data-testid="diary-calendar-mood"]',
        ) ?? null

        return {
          dateButtons: content?.querySelectorAll(':scope > [data-diary-day-content]').length ?? 0,
          moodButtons: content?.querySelectorAll(
            ':scope > [data-testid="diary-calendar-mood"]',
          ).length ?? 0,
          sameParent: Boolean(
            dateButton &&
            moodButton &&
            dateButton.parentElement === moodButton.parentElement,
          ),
          moodNestedInDate: Boolean(dateButton && moodButton && dateButton.contains(moodButton)),
        }
      })
    })
    expect(nestedControlAudit.length).toBeGreaterThan(0)
    expect(
      nestedControlAudit.every((cell) =>
        cell.dateButtons === 1 &&
        cell.moodButtons <= 1 &&
        (cell.moodButtons === 0 || cell.sameParent) &&
        !cell.moodNestedInDate,
      ),
    ).toBe(true)

    for (const viewport of [...CALENDAR_VIEWPORTS, ...CALENDAR_BREAKPOINT_VIEWPORTS]) {
      await page.setViewportSize(viewport)
      await expect(calendar).toBeVisible()
      const metrics = await calendarMetrics(page)
      expect(metrics.scrollWidth, `${viewport.name} horizontal overflow`).toBeLessThanOrEqual(viewport.width + 1)
      expect(metrics.surface?.width, `${viewport.name} surface width`).toBeGreaterThan(0)
      expect(metrics.surface?.height, `${viewport.name} surface height`).toBeGreaterThan(0)
      expect(metrics.host?.right, `${viewport.name} host right edge`).toBeLessThanOrEqual(viewport.width + 1)
      expect(metrics.container?.right, `${viewport.name} calendar right edge`).toBeLessThanOrEqual(viewport.width + 1)
      expect(metrics.host?.width, `${viewport.name} host fills surface`).toBeGreaterThanOrEqual((metrics.surface?.width ?? 0) * 0.95)
      expect(metrics.container?.width, `${viewport.name} Naive Calendar fills host`).toBeGreaterThanOrEqual((metrics.host?.width ?? 0) * 0.95)
      expect(metrics.container?.height, `${viewport.name} Naive Calendar fills host height`).toBeGreaterThanOrEqual((metrics.host?.height ?? 0) * 0.85)
      expect(metrics.dayCount, `${viewport.name} date buttons`).toBeGreaterThan(0)
      expect(metrics.minDayWidth, `${viewport.name} day width`).toBeGreaterThanOrEqual(36)
      expect(metrics.minDayHeight, `${viewport.name} day height`).toBeGreaterThanOrEqual(44)
      expect(metrics.maxDayBottom, `${viewport.name} clipped week`).toBeLessThanOrEqual((metrics.host?.bottom ?? viewport.height) + 1)
      expect(metrics.titleText, `${viewport.name} month title`).toMatch(/^\d{4}-\d{2}$/)
      expect(metrics.titleFits, `${viewport.name} month title clipping`).toBe(true)
      expect(metrics.previous?.width, `${viewport.name} previous target`).toBeGreaterThanOrEqual(40)
      expect(metrics.previous?.height, `${viewport.name} previous target`).toBeGreaterThanOrEqual(40)
      expect(metrics.next?.width, `${viewport.name} next target`).toBeGreaterThanOrEqual(40)
      expect(metrics.next?.height, `${viewport.name} next target`).toBeGreaterThanOrEqual(40)
      expect(metrics.previous?.right, `${viewport.name} previous/title overlap`).toBeLessThanOrEqual(metrics.title?.left ?? 0)
      expect(metrics.next?.left, `${viewport.name} title/next overlap`).toBeGreaterThanOrEqual(metrics.title?.right ?? viewport.width)
    }

    await page.setViewportSize({ width: 320, height: 700 })
    const before = await calendar.getAttribute('data-month')
    await focusWithKeyboard(page, previous)
    await assertFocusRing(previous)
    await page.keyboard.press('Enter')
    await expect(calendar).not.toHaveAttribute('data-month', before ?? '')
    await focusWithKeyboard(page, next)
    await assertFocusRing(next)
    await page.keyboard.press('Space')
    await expect(calendar).toHaveAttribute('data-month', before ?? '')

    await page.keyboard.press('Tab')
    await dateButton.focus()
    await assertFocusRing(dateButton, { targetSize: false })
    await page.keyboard.press('Enter')
    await assertNativeRead(page, date)
  } finally {
    await deletePost(request, diaryPath(date))
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test('mobile Calendar-to-native keyboard journey preserves focus, shortcuts, and identity', async ({ page, request }) => {
  const date = localCivilDate()
  const path = diaryPath(date)
  const state = await captureDiagnostics(page)

  try {
    const seeded = await seedDiary(request, date, `# D6.6 Keyboard ${RUN_ID}\nInitial body.\n`)
    await openDiaryHome(page)
    await page.setViewportSize({ width: 375, height: 812 })
    await activateDiaryDate(page, date, 'keyboard')
    await assertNativeRead(page, date)

    const tab = page.locator(`[role="tab"][data-tab-id="${path}"]`)
    const calendar = page.getByTestId('diary-calendar')
    await expect(tab).toHaveCount(1)
    await expect(calendar).toBeAttached()
    expect(await page.evaluate(() => {
      const calendarRoot = document.querySelector<HTMLElement>('[data-testid="diary-calendar"]')
      const active = document.activeElement
      const hidden = calendarRoot
        ? getComputedStyle(calendarRoot).display === 'none' || calendarRoot.getClientRects().length === 0
        : false
      return { hidden, activeInside: Boolean(active && calendarRoot?.contains(active)) }
    })).toEqual({ hidden: true, activeInside: false })

    const hiddenTabStops = await page.evaluate(() => {
      const calendarRoot = document.querySelector<HTMLElement>('[data-testid="diary-calendar"]')
      if (!calendarRoot) return null
      if (calendarRoot.getClientRects().length === 0) return true
      const focusable = [...calendarRoot.querySelectorAll<HTMLElement>('button, [tabindex]')]
      return focusable.every((element) => {
        const style = getComputedStyle(element)
        return style.display === 'none' || style.visibility === 'hidden' || element.tabIndex < 0
      })
    })
    expect(hiddenTabStops).toBe(true)

    await page.locator('.vault').focus()
    await page.keyboard.press('ControlOrMeta+e')
    await expect(page.getByRole('textbox', { name: 'Editor content' })).toBeVisible()
    await expect(page.locator('.editor-pane .monaco-editor')).toHaveCount(1)
    await expect(tab).toHaveAttribute('aria-selected', 'true')

    const editorMarker = `KEYBOARD_SAVE_${RUN_ID}`
    await appendEditorText(page, editorMarker)
    await expect(tab).toHaveCount(1)
    await expect(tab).toHaveAttribute('data-save-status', 'dirty', { timeout: 15_000 })
    await page.locator('.vault').focus()
    await page.keyboard.press('ControlOrMeta+s')
    await expect(tab).toHaveAttribute('data-save-status', 'saved', { timeout: 15_000 })
    const saved = await (await request.get(`/api/posts/${path}`)).json() as { raw: string; metadata?: { id?: string } }
    expect(saved.raw).toContain(editorMarker)
    expect(saved.metadata?.id).toBe(seeded.documentId)

    await page.keyboard.press('ControlOrMeta+e')
    await expect(page.locator('.reading-pane')).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Editor content' })).toHaveCount(0)

    await goBackFromDiaryDocument(page)
    await expect(tab).toHaveCount(0)
    await expect(page.getByTestId('diary-calendar')).toBeVisible()
    await expect(page.getByTestId('diary-workspace-shell')).toHaveAttribute('data-presentation-mode', 'home')
    await expect(calendar).toHaveAttribute('data-month', date.slice(0, 7))
    await expect(calendarDay(calendar, date)).not.toHaveClass(/is-selected/)
    await expect(calendarDay(calendar, date)).toHaveAttribute('aria-pressed', 'false')
    await expect(calendarDay(calendar, date)).toHaveClass(/is-today/)
    await expect(calendarDay(calendar, date)).toHaveAttribute('aria-current', 'date')
    await expect(page).toHaveURL(/\/vault(?:[?#]|$)/)
    await expect(page.locator('.activity-bar')).toHaveCount(0)
    await expect(page.locator('.file-tree')).toHaveCount(0)

    const rawBeforeHomeShortcuts = (await (await request.get(`/api/posts/${path}`)).json() as { raw: string }).raw
    await page.locator('.vault').focus()
    for (const shortcut of ['ControlOrMeta+w', 'ControlOrMeta+s', 'ControlOrMeta+e', 'ControlOrMeta+Tab']) {
      await page.keyboard.press(shortcut)
    }
    await page.keyboard.press('ControlOrMeta+b')
    await expect(page.getByTestId('diary-calendar')).toBeVisible()
    await expect(tab).toHaveCount(0)
    await expect(page.locator('.activity-bar')).toHaveCount(0)
    await expect(page.locator('.file-tree')).toHaveCount(0)
    expect(new URL(page.url()).pathname).toBe('/vault')
    expect((await (await request.get(`/api/posts/${path}`)).json() as { raw: string }).raw).toBe(rawBeforeHomeShortcuts)
    await expect(page.getByRole('textbox', { name: 'Editor content' })).toHaveCount(0)
  } finally {
    await deletePost(request, path)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test('Note scope hides the Diary document and Cmd/Ctrl+W keeps its normal Note behavior', async ({ page, request }) => {
  const date = localCivilDate()
  const diary = diaryPath(date)
  const note = `inbox/d66-close-focus-${RUN_ID}`
  const state = await captureDiagnostics(page)

  try {
    await seedDiary(request, date, `# D6.6 Close Focus ${RUN_ID}\n`)
    await seedNote(request, note)
    await openNoteDocument(page, note)

    await selectScope(page, 'diary')
    await expect(page.getByTestId('diary-calendar')).toBeVisible()
    await expect(calendarDay(page.getByTestId('diary-calendar'), date)).not.toHaveClass(/is-selected/)
    await expect(calendarDay(page.getByTestId('diary-calendar'), date)).toHaveAttribute('aria-pressed', 'false')
    await activateDiaryDate(page, date)
    await assertNativeRead(page, date)

    const diaryTab = page.locator(`[role="tab"][data-tab-id="${diary}"]`)
    const fallbackTab = page.locator(`[role="tab"][data-tab-id="${note}"]`)
    // Leaving Diary safely saves and hides the managed document, restoring
    // the previously open Note while retaining Diary's own context.
    await selectScope(page, 'note')
    await expect(page.getByTestId('diary-calendar')).toHaveCount(0)
    await expect(diaryTab).toHaveCount(0)
    await expect(fallbackTab).toHaveAttribute('aria-selected', 'true')
    await expect(page).toHaveURL(new RegExp(`/vault/${note.replace('/', '\\/')}(?:[?#]|$)`))
    await closeCurrentWorkspaceDocument(page)

    await expect(fallbackTab).toHaveCount(0)
    await expect(page).toHaveURL(/\/vault(?:[?#]|$)/)
    await expect(page.locator('.n-dialog[role="dialog"]')).toHaveCount(0)

    await selectScope(page, 'diary')
    await assertNativeRead(page, date)
    await page.locator('.vault').focus()
    await page.keyboard.press('ControlOrMeta+e')
    await expect(page.getByRole('textbox', { name: 'Editor content' })).toBeVisible()
    await appendEditorText(page, `D66_DIRTY_CLOSE_${RUN_ID}`)
    await expect(diaryTab).toHaveAttribute('data-save-status', 'dirty')

    await page.locator('.vault').focus()
    await page.keyboard.press('ControlOrMeta+w')
    const confirmation = page.locator('.n-dialog[role="dialog"]')
    await expect(confirmation).toBeVisible()
    await expect(diaryTab).toHaveCount(1)
    await expect(diaryTab).toHaveAttribute('aria-selected', 'true')
    await expect(page).toHaveURL(new RegExp(`/vault/${diary.replace('/', '\\/')}(?:[?#]|$)`))
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(confirmation).not.toBeVisible()
    await expect(diaryTab).toHaveAttribute('data-save-status', 'dirty')
    await expect(calendarDay(page.getByTestId('diary-calendar'), date)).not.toHaveClass(/is-selected/)
    await expect(calendarDay(page.getByTestId('diary-calendar'), date)).toHaveAttribute('aria-pressed', 'false')
    // Let the intentionally retained dirty edit settle before fixture
    // cleanup deletes the server document. Otherwise the delayed autosave
    // can race the cleanup DELETE and report a misleading 404 in the page.
    await expect(diaryTab).toHaveAttribute('data-save-status', 'saved', { timeout: 15_000 })
    await page.locator('.vault').focus()
    await page.keyboard.press('ControlOrMeta+w')
    await expect(diaryTab).toHaveCount(0)
    await expect(page.getByTestId('diary-calendar')).toBeVisible()
    await expect(calendarDay(page.getByTestId('diary-calendar'), date)).not.toHaveClass(/is-selected/)
    await expect(calendarDay(page.getByTestId('diary-calendar'), date)).toHaveAttribute('aria-pressed', 'false')
  } finally {
    await deletePost(request, diary)
    await deletePost(request, note)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test('Diary G B shortcut returns from the active diary to the same calendar month', async ({ page, request }) => {
  const date = '2026-08-15'
  const diary = diaryPath(date)
  const state = await captureDiagnostics(page)

  try {
    await seedDiary(request, date, `# G B back integration ${RUN_ID}\n`)
    await setDiaryMood(request, date, 'happy')
    await openDiaryHome(page)
    await moveToMonth(page, date)

    const calendar = page.getByTestId('diary-calendar')
    const day = calendarDay(calendar, date)
    const mood = page.locator(`[data-testid="diary-calendar-mood"][data-date="${date}"]`)
    await expect(calendar).toHaveAttribute('data-month', '2026-08')
    await expect(day).not.toHaveClass(/is-selected/)
    await expect(day).toHaveAttribute('aria-pressed', 'false')
    await expect(mood).toBeVisible()
    await expect(mood.locator('img')).toHaveAttribute('src', '/emoji/开心.svg')

    await day.click()
    await assertNativeRead(page, date)
    const diaryTab = page.locator(`[role="tab"][data-tab-id="${diary}"]`)
    await expect(diaryTab).toHaveAttribute('aria-selected', 'true')
    const timeOriginBeforeClose = await page.evaluate(() => performance.timeOrigin)

    await page.locator('.vault').focus()
    await page.keyboard.press('d')
    await page.keyboard.press('c')
    await expect(diaryTab).toHaveCount(1)
    await expect(diaryTab).toHaveAttribute('aria-selected', 'true')

    await page.keyboard.press('g')
    await page.keyboard.press('b')

    await expect(diaryTab).toHaveCount(0)
    await expect(page.getByTestId('diary-workspace-shell')).toHaveAttribute('data-presentation-mode', 'home')
    await expect(page.getByTestId('diary-workspace-home')).toBeVisible()
    await expect(calendar).toBeVisible()
    await expect(calendar).toHaveAttribute('data-month', '2026-08')
    await expect(page.locator('.scope-chip').filter({ hasText: 'diary' })).toHaveAttribute('aria-pressed', 'true')
    await expect(day).not.toHaveClass(/is-selected/)
    await expect(day).not.toHaveAttribute('aria-pressed', 'true')
    await expect(day).toHaveAttribute('aria-pressed', 'false')
    await expect(mood).toBeVisible()
    await expect(mood.locator('img')).toHaveAttribute('src', '/emoji/开心.svg')
    await expect(page).toHaveURL(/\/vault(?:[?#]|$)/)
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOriginBeforeClose)
  } finally {
    await deletePost(request, diary)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test('clicking a Diary FileTree row transfers focus out of Monaco for G B', async ({ page, request }) => {
  const date = '2026-08-16'
  const path = diaryPath(date)

  try {
    await seedDiary(request, date, `# FileTree focus handoff ${RUN_ID}\n`)
    await openDiaryHome(page)
    await moveToMonth(page, date)
    await calendarDay(page.getByTestId('diary-calendar'), date).click()
    await assertNativeRead(page, date)

    const diaryTab = page.locator(`[role="tab"][data-tab-id="${path}"]`)
    await page.locator('.vault').focus()
    await page.keyboard.press('ControlOrMeta+e')
    const editor = page.locator('.editor-pane .monaco-editor').first()
    await expect(editor).toBeVisible()
    await editor.click()
    await expect.poll(() => page.evaluate(() => Boolean(
      document.activeElement?.closest('.monaco-editor'),
    ))).toBe(true)

    const row = page.locator(`[data-tree-key="file:${path}"]`)
    await expect(row).toBeVisible()
    await row.locator('.row-line').click()
    await expect.poll(() => page.evaluate(() => (
      (document.activeElement as HTMLElement | null)?.dataset.treeKey ?? null
    ))).toBe(`file:${path}`)
    await expect(row).toHaveAttribute('tabindex', '0')

    // The shared Diary E2E fixture freezes Date.now. Advance it by 1 ms so
    // Vue's nested-listener timestamp guard behaves as it does during normal
    // elapsed browser time before sending keyboard events through FileTree.
    await page.clock.setSystemTime(new Date('2026-08-15T12:00:00.001+08:00'))

    await page.keyboard.press('g')
    await page.keyboard.press('b')

    await expect(diaryTab).toHaveCount(0)
    await expect(page.getByTestId('diary-workspace-shell')).toHaveAttribute('data-presentation-mode', 'home')
    await expect(page.getByTestId('diary-calendar')).toBeVisible()
  } finally {
    await deletePost(request, path)
  }
})

test('Diary has no contextual rail and preserves the Note rail selection', async ({ page, request }) => {
  const date = localCivilDate()
  const note = `inbox/diary-rail-contract-${RUN_ID}`
  try {
    await seedDiary(request, date, '# Quiet Diary\n')
    expect((await request.post('/api/posts', { data: { path: note, title: 'Rail contract', content: '## Note heading\n' } })).ok()).toBe(true)
    await openNoteDocument(page, note)
    await expect(page.locator('.right-rail-slot')).toBeVisible()
    await page.locator('.right-rail [data-tab="history"]').click()
    await selectScope(page, 'diary')
    await expect(page.getByTestId('diary-calendar')).toBeVisible()
    await expect(page.locator('.right-rail-slot, .splitter-toc, .right-rail-toggle')).toHaveCount(0)
    await activateDiaryDate(page, date)
    await expect(page.locator('.reading-pane')).toBeVisible()
    await expect(page.locator('.right-rail-slot, .splitter-toc, .right-rail-toggle')).toHaveCount(0)
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.locator('.file-tree')).toHaveCount(0)
    const metrics = await documentMetrics(page)
    expect(metrics.editorAreaLeft).toBeLessThanOrEqual(1)
    expect(metrics.editorAreaRight).toBeGreaterThanOrEqual(389)
    await assertNoDocumentOverflow(page)
    await goBackFromDiaryDocument(page)
    await page.setViewportSize({ width: 1280, height: 800 })
    await selectScope(page, 'note')
    await expect(page.locator('.right-rail-toggle')).toBeVisible()
    await expect(page.locator('.right-rail [data-tab="history"]')).toHaveAttribute('aria-selected', 'true')
    for (const tab of ['ai', 'toc', 'links', 'properties', 'history']) {
      await expect(page.locator(`.right-rail [data-tab="${tab}"]`)).toHaveCount(1)
    }
  } finally {
    await deletePost(request, note)
    await deletePost(request, diaryPath(date))
  }
})

test('mobile direct Diary route and reload keep FileTree as a full-width overlay', async ({ page, request }) => {
  const dates = [localCivilDate(), nextCivilDate(localCivilDate())]
  const paths = dates.map(diaryPath)
  const state = await captureDiagnostics(page)

  try {
    for (const date of dates) await seedDiary(request, date, `# Mobile direct Diary ${date} ${RUN_ID}\n`)
    await page.setViewportSize({ width: 375, height: 812 })
    await page.evaluate(() => localStorage.setItem('nuvyn.vault.activeScope', 'diary'))
    await page.goto(`/vault/${paths[0]}`)

    await ensureNativeReadMode(page)
    await expect(page.locator('.vault')).toHaveClass(/diary-native-document-mode/)
    await assertNativeRead(page, dates[0])
    await expect(page.locator('.right-rail-slot, .splitter-toc, .right-rail-toggle')).toHaveCount(0)
    const directMetrics = await documentMetrics(page)
    expect(directMetrics.editorAreaLeft).toBeLessThanOrEqual(1)
    expect(directMetrics.editorAreaRight).toBeGreaterThanOrEqual(374)
    await assertNoDocumentOverflow(page)

    await page.reload()
    await ensureNativeReadMode(page)
    await expect(page.locator('.vault')).toHaveClass(/diary-native-document-mode/)
    await assertNativeRead(page, dates[0])
    await expect(page.locator('.right-rail-slot, .splitter-toc, .right-rail-toggle')).toHaveCount(0)
    const reloadedMetrics = await documentMetrics(page)
    expect(reloadedMetrics.editorAreaLeft).toBeLessThanOrEqual(1)
    expect(reloadedMetrics.editorAreaRight).toBeGreaterThanOrEqual(374)
    await assertNoDocumentOverflow(page)

    const leftPanelToggle = page.getByTestId('left-panel-toggle')
    await leftPanelToggle.click()
    await expect(leftPanelToggle).toHaveAttribute('aria-pressed', 'true')
    const fileTree = page.locator('.file-tree')
    await expect(fileTree).toBeVisible()
    const overlayMetrics = await fileTree.evaluate((element) => ({
      position: getComputedStyle(element).position,
      left: element.getBoundingClientRect().left,
    }))
    expect(overlayMetrics.position).toBe('absolute')
    expect(overlayMetrics.left).toBeLessThanOrEqual(1)
    const openMetrics = await documentMetrics(page)
    expect(openMetrics.editorAreaLeft).toBeLessThanOrEqual(1)
    expect(openMetrics.editorAreaRight).toBeGreaterThanOrEqual(374)
    await assertNoDocumentOverflow(page)

    await fileTree.locator(`[data-tree-key="file:${paths[1]}"] .row-line`).click()
    await expect(page).toHaveURL(new RegExp(`/vault/${paths[1].replace('/', '\\/')}(?:[?#]|$)`))
    await expect(page.locator('.vault')).toHaveClass(/diary-native-document-mode/)
    await assertNativeRead(page, dates[1])
    await expect(page.locator('.right-rail-slot, .splitter-toc, .right-rail-toggle')).toHaveCount(0)
    const selectedMetrics = await documentMetrics(page)
    expect(selectedMetrics.editorAreaLeft).toBeLessThanOrEqual(1)
    expect(selectedMetrics.editorAreaRight).toBeGreaterThanOrEqual(374)
    await assertNoDocumentOverflow(page)
  } finally {
    for (const path of paths) await deletePost(request, path)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test('mobile Recovery surface does not inherit ordinary Diary document layout', async ({ page, request }) => {
  const date = localCivilDate()
  const diary = diaryPath(date)
  const note = `inbox/diary-recovery-layout-${RUN_ID}`
  const marker = `RECOVERY_LAYOUT_${RUN_ID}`
  const state = await captureDiagnostics(page)

  try {
    await seedDiary(request, date, `# Diary under Recovery ${RUN_ID}\n`)
    await seedNote(request, note)
    const noteResponse = await request.get(`/api/posts/${note}`)
    expect(noteResponse.status()).toBe(200)
    const noteDetail = await noteResponse.json() as { metadata?: { id?: string } }
    expect(noteDetail.metadata?.id).toEqual(expect.any(String))
    const identityResponse = await request.get('/api/vault/identity')
    expect(identityResponse.status()).toBe(200)
    const identity = await identityResponse.json() as { vaultId: string }
    await seedRecoveryDraft(page, {
      vaultId: identity.vaultId,
      documentId: noteDetail.metadata!.id!,
      documentPath: note,
      content: marker,
    })

    await page.setViewportSize({ width: 375, height: 812 })
    await page.evaluate(() => localStorage.setItem('nuvyn.vault.activeScope', 'diary'))
    await page.goto(`/vault/${diary}`)
    await expect(page.locator(`[role="tab"][data-tab-id="${diary}"]`)).toHaveAttribute('aria-selected', 'true')
    const recoveryDialog = await openRecoveryDialog(page)
    await recoveryDialog.getByRole('button', { name: 'Open Recovered Content' }).click()

    await expect(page.locator('.draft-recovery-pane')).toBeVisible()
    await expect(page.locator('.vault')).not.toHaveClass(/diary-native-document-mode/)
    await expect(page.locator('.right-rail-slot, .splitter-toc, .right-rail-toggle')).toHaveCount(0)
  } finally {
    await deletePost(request, note)
    await deletePost(request, diary)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test('native READ and EDIT remain usable across panel states, breakpoints, and resize', async ({ page, request }) => {
  const date = localCivilDate()
  const path = diaryPath(date)
  const state = await captureDiagnostics(page)

  try {
    const seeded = await seedDiary(request, date, `# D6.6 Responsive Document ${RUN_ID}\n`)
    await openDiaryHome(page)
    await activateDiaryDate(page, date)
    await assertNativeRead(page, date)
    const tab = page.locator(`[role="tab"][data-tab-id="${path}"]`)

    for (const viewport of DOCUMENT_VIEWPORTS) {
      await page.setViewportSize(viewport)
      await assertNativeRead(page, date)
      const readMetrics = await documentMetrics(page)
      expect(readMetrics.editorAreaWidth, `${viewport.name} READ width`).toBeGreaterThan(0)
      expect(readMetrics.editorAreaLeft, `${viewport.name} READ starts after Activity Bar`).toBeGreaterThanOrEqual(readMetrics.activityRight - 1)
      expect(readMetrics.editorAreaRight, `${viewport.name} READ reaches viewport`).toBeGreaterThanOrEqual(viewport.width - 1)
      await expect(page.locator('.right-rail-slot, .splitter-toc, .right-rail-toggle')).toHaveCount(0)
      expect(readMetrics.rightRailVisible).toBe(false)
      if (viewport.width > 600 && await page.getByTestId('left-panel-toggle').getAttribute('aria-pressed') === 'true') {
        expect(readMetrics.fileTreeWidth).toBeGreaterThan(0)
      }
      await assertNoDocumentOverflow(page)

      const toggle = page.getByTestId('view-toggle')
      await page.locator('.vault').focus()
      await page.keyboard.press('ControlOrMeta+e')
      await expect(page.getByRole('textbox', { name: 'Editor content' })).toBeVisible()
      await expect(page.locator('.editor-pane .monaco-editor')).toHaveCount(1)
      const editMetrics = await documentMetrics(page)
      expect(editMetrics.editorAreaWidth, `${viewport.name} EDIT width`).toBeGreaterThan(0)
      if (viewport.width <= 600) {
        expect(editMetrics.editorAreaRight, `${viewport.name} EDIT reaches viewport`).toBeGreaterThanOrEqual(viewport.width - 1)
      } else {
        expect(editMetrics.editorAreaRight, `${viewport.name} EDIT has usable right edge`).toBeGreaterThan(editMetrics.editorAreaLeft)
      }
      await assertNoDocumentOverflow(page)
      await expect(tab).toHaveAttribute('aria-selected', 'true')
      await expect(toggle).toBeVisible()

      await page.locator('.vault').focus()
      await page.keyboard.press('ControlOrMeta+e')
      await expect(page.locator('.reading-pane')).toBeVisible()
      await expect(page.getByRole('textbox', { name: 'Editor content' })).toHaveCount(0)
    }

    await page.setViewportSize({ width: 375, height: 812 })
    await assertNativeRead(page, date)
    const leftPanelToggle = page.getByTestId('left-panel-toggle')
    await expect(leftPanelToggle).toBeVisible()
    await ensureExplorerVisible(page)
    await expect(leftPanelToggle).toHaveAttribute('aria-pressed', 'true')
    await leftPanelToggle.click()
    await expect(leftPanelToggle).toHaveAttribute('aria-pressed', 'false')
    await expect(page.locator('.file-tree')).toBeHidden()
    await expect(page.locator('.reading-pane')).toBeVisible()
    for (const viewport of [
      { width: 375, height: 812 },
      { width: 320, height: 700 },
    ]) {
      await page.setViewportSize(viewport)
      const closed = await documentMetrics(page)
      expect(closed.editorAreaWidth, `${viewport.width}px closed-panel width`).toBeGreaterThan(0)
      expect(closed.editorAreaLeft, `${viewport.width}px closed-panel left`).toBeGreaterThanOrEqual(closed.activityRight - 1)
      expect(closed.editorAreaRight, `${viewport.width}px closed-panel right`).toBeGreaterThanOrEqual(viewport.width - 1)
      expect(closed.fileTreeWidth, `${viewport.width}px no phantom FileTree`).toBe(0)
      await assertNoDocumentOverflow(page)
      await page.locator('.vault').focus()
      await page.keyboard.press('ControlOrMeta+e')
      await expect(page.getByRole('textbox', { name: 'Editor content' })).toBeVisible()
      await assertNoDocumentOverflow(page)
      await page.keyboard.press('ControlOrMeta+e')
      await expect(page.locator('.reading-pane')).toBeVisible()
    }

    await ensureExplorerVisible(page)
    await page.locator('.file-tree [role="treeitem"]').filter({ hasText: date }).first().click()
    await expect(page.locator('.file-tree')).toHaveCount(0)
    await expect(page.locator('.reading-pane')).toBeVisible()
    await expect(leftPanelToggle).toHaveAttribute('aria-pressed', 'false')

    await page.setViewportSize({ width: 1280, height: 800 })
    await expect(page.locator('.file-tree')).toBeHidden()
    await expect(page.locator('.reading-pane')).toBeVisible()
    const closedWide = await documentMetrics(page)
    expect(closedWide.fileTreeWidth).toBe(0)
    expect(closedWide.rightRailVisible).toBe(false)

    await leftPanelToggle.click()
    await expect(page.locator('.file-tree')).toBeVisible()
    const routeBeforeResize = new URL(page.url()).pathname
    const sequence = [
      { width: 1280, height: 800 },
      { width: 375, height: 812 },
      { width: 320, height: 700 },
      { width: 768, height: 1024 },
      { width: 1280, height: 800 },
    ]
    let leftPanelOpen = true
    for (const viewport of sequence) {
      await page.setViewportSize(viewport)
      await expect(page.locator('.workspace-navigation .scope-chip')).toHaveCount(viewport.width <= 600 ? 2 : 3)
      await expect(page.locator('.workspace-board-link')).toHaveCount(viewport.width <= 600 ? 0 : 1)
      // Entering a mobile Diary viewport collapses the panel; resizing back
      // to desktop preserves that choice instead of automatically reopening it.
      if (viewport.width <= 600) leftPanelOpen = false
      await expect(leftPanelToggle).toHaveAttribute('aria-pressed', String(leftPanelOpen))
      await expect(tab).toHaveCount(1)
      await expect(tab).toHaveAttribute('aria-selected', 'true')
      await expect(page.locator('.reading-pane')).toBeVisible()
      if (leftPanelOpen) {
        await expect(page.locator('.file-tree')).toBeVisible()
        await expect(page.locator('.search-input')).toHaveValue(date)
      } else {
        await expect(page.locator('.file-tree, .search-input')).toHaveCount(0)
      }
      await assertNoDocumentOverflow(page)
      expect(new URL(page.url()).pathname).toBe(routeBeforeResize)
      expect((await (await request.get(`/api/posts/${path}`)).json() as { metadata?: { id?: string } }).metadata?.id).toBe(seeded.documentId)
    }
    await ensureExplorerVisible(page)
    await expect(page.locator('.search-input')).toHaveValue(date)
  } finally {
    await deletePost(request, path)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test('FileTree search keeps keyboard semantics and the user filter across Diary presentation', async ({ page, request }) => {
  const date = localCivilDate()
  const diary = diaryPath(date)
  const state = await captureDiagnostics(page)

  try {
    await seedDiary(request, date, `# D6.6 FileTree filter ${RUN_ID}\n`)
    await openDiaryHome(page)

    await selectScope(page, 'diary')
    await expect(page.getByTestId('diary-calendar')).toBeVisible()
    await activateDiaryDate(page, date)
    await assertNativeRead(page, date)
    await expect(page.locator('[data-tree-key="folder:diary"]')).toHaveCount(0)
    const fileItem = page.locator(`[data-tree-key="file:${diary}"]`)
    await expect(fileItem).toHaveAttribute('data-tree-path', diary)
    const search = page.locator('.search-input')
    const userQuery = date.slice(0, 7)
    await search.fill(userQuery)
    await expect(search).toHaveValue(userQuery)

    await expect(fileItem).toBeVisible()
    await fileItem.focus()
    await expect(fileItem).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.locator(`[role="tab"][data-tab-id="${diary}"]`)).toHaveAttribute('aria-selected', 'true')
    await expect(search).toHaveValue(userQuery)
    await expect(page.locator('.vault')).toHaveClass(/diary-native-document-mode/)

    const tab = page.locator(`[role="tab"][data-tab-id="${diary}"]`)
    await goBackFromDiaryDocument(page)
    await expect(page.getByTestId('diary-calendar')).toBeVisible()
    await expect(tab).toHaveCount(0)
    await expect(search).toHaveCount(0)
    await expect(page.locator('.activity-bar')).toHaveCount(0)
  } finally {
    await deletePost(request, diary)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test('ten mixed Calendar focus cycles remain stable without runtime errors', async ({ page, request }) => {
  test.setTimeout(60_000)

  const date = localCivilDate()
  const path = diaryPath(date)
  const state = await captureDiagnostics(page)

  try {
    await seedDiary(request, date, `# D6.6 Repeated Focus ${RUN_ID}\n`)
    await openDiaryHome(page)
    const calendar = page.getByTestId('diary-calendar')
    const tab = page.locator(`[role="tab"][data-tab-id="${path}"]`)
    const day = calendarDay(calendar, date)

    for (let cycle = 0; cycle < 10; cycle += 1) {
      await page.setViewportSize(cycle % 2 === 0
        ? { width: 375, height: 812 }
        : { width: 320, height: 700 })
      await expect(day).toBeVisible()
      if (cycle % 2 === 0) {
        await day.focus()
        await page.keyboard.press('Enter')
      } else {
        const dayBox = await day.boundingBox()
        if (!dayBox) throw new Error('Diary day button did not expose a bounding box')
        // The post-closure Mood emoji sits below the date number. Use an
        // upper-center point so this lifecycle smoke always activates the
        // date owner rather than the optional sibling Mood control.
        await day.click({
          force: true,
          position: {
            x: dayBox.width / 2,
            y: 4,
          },
        })
      }
      await assertNativeRead(page, date)
      await expect(calendar).toBeHidden()
      expect(await page.evaluate(() => {
        const root = document.querySelector<HTMLElement>('[data-testid="diary-calendar"]')
        return Boolean(root && document.activeElement && root.contains(document.activeElement))
      })).toBe(false)
      await goBackFromDiaryDocument(page)
      await expect(tab).toHaveCount(0)
      await expect(calendar).toBeVisible()
      await expect(page.getByTestId('diary-workspace-shell')).toHaveAttribute('data-presentation-mode', 'home')
    }
  } finally {
    await deletePost(request, path)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test.describe('English Calendar accessibility labels', () => {
  test.use({ locale: 'en-US' })

  test('exposes meaningful English names for Calendar controls', async ({ page, request }) => {
    const date = localCivilDate()
    const state = await captureDiagnostics(page)
    try {
      await seedDiary(request, date, `# D6.6 English ${RUN_ID}\n`)
      await openDiaryHome(page)
      const calendar = page.getByTestId('diary-calendar')
      await expect(calendar).toHaveAttribute('data-locale', 'en-US')
      await expect(calendar).toHaveAccessibleName('Diary calendar')
      await expect(page.locator('[data-diary-calendar-nav="previous"]')).toHaveAccessibleName('Previous month')
      await expect(page.locator('[data-diary-calendar-nav="next"]')).toHaveAccessibleName('Next month')
      await expect(calendarDay(calendar, date)).toHaveAccessibleName(/Diary exists/)

      await expect(calendar).toHaveAttribute('data-theme', 'light')
      await page.getByRole('button', { name: /Theme: Light/ }).click()
      await expect(calendar).toHaveAttribute('data-theme', 'dark')
      await expect(calendar).toHaveAttribute('data-theme', 'dark')
      await activateDiaryDate(page, date)
      await assertNativeRead(page, date)
      await assertNoDocumentOverflow(page)
    } finally {
      await deletePost(request, diaryPath(date))
    }
    expect(state.pageErrors).toEqual([])
    expect(state.consoleErrors).toEqual([])
  })
})

test.describe('Chinese Calendar accessibility labels', () => {
  test.use({ locale: 'zh-CN' })

  test('exposes meaningful Chinese names for Calendar controls', async ({ page, request }) => {
    const date = localCivilDate()
    const state = await captureDiagnostics(page)
    try {
      await seedDiary(request, date, `# D6.6 Chinese ${RUN_ID}\n`)
      await openDiaryHome(page)
      const calendar = page.getByTestId('diary-calendar')
      await expect(calendar).toHaveAttribute('data-locale', 'zh-CN')
      await expect(calendar).toHaveAccessibleName('日记日历')
      await expect(page.locator('[data-diary-calendar-nav="previous"]')).toHaveAccessibleName('上个月')
      await expect(page.locator('[data-diary-calendar-nav="next"]')).toHaveAccessibleName('下个月')
      await expect(calendarDay(calendar, date)).toHaveAccessibleName(/有日记/)

      await activateDiaryDate(page, date)
      await assertNativeRead(page, date)
    } finally {
      await deletePost(request, diaryPath(date))
    }
    expect(state.pageErrors).toEqual([])
    expect(state.consoleErrors).toEqual([])
  })
})
