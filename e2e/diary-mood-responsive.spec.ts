import { expect, test, type APIRequestContext, type Page } from './fixtures/diary'
import { clearDraftDatabase, gotoVaultReady } from './helpers/edit-program'
import {
  CALENDAR_TEST_DATE,
  CALENDAR_TEST_TIME_ZONE,
  calendarDay,
  calendarMoodButton,
} from './helpers/calendar-clock'

const TEST_TIME_ZONE = CALENDAR_TEST_TIME_ZONE
const RUN_ID = String(Date.now())

test.use({
  timezoneId: TEST_TIME_ZONE,
  trace: 'off',
  screenshot: 'only-on-failure',
})

type Viewport = {
  name: string
  width: number
  height: number
}

const D75_VIEWPORTS: readonly Viewport[] = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 375, height: 812 },
  { name: 'mobile-wide', width: 390, height: 844 },
  { name: 'narrow-mobile', width: 320, height: 700 },
]

const CANONICAL_MOOD_IDS = [
  'kiss', 'sad', 'surprised-big', 'surprised-small',
  'watching', 'like', 'laughing', 'disappointed',
  'afraid', 'shy', 'happy', 'smiling',
  'amazed', 'angry', 'flirty', 'speechless',
  'dizzy', 'indignant', 'frowning', 'mysterious',
  'laughing-tears', 'playful', 'unwell', 'devilish',
] as const

function localCivilDate(): string {
  return CALENDAR_TEST_DATE
}

function diaryPath(date: string): string {
  return `diary/${date}`
}

async function deletePost(request: APIRequestContext, path: string): Promise<void> {
  const response = await request.delete(`/api/posts/${path}`)
  expect(path.startsWith('diary/') ? [200, 404, 422] : [200, 404]).toContain(response.status())
}

async function seedDiary(request: APIRequestContext, date: string): Promise<void> {
  const path = diaryPath(date)
  await deletePost(request, path)
  const created = await request.post('/api/diary/dates', {
    data: { date, timeZone: TEST_TIME_ZONE },
  })
  expect(created.status(), await created.text()).toBe(201)

  const initialResponse = await request.get(`/api/posts/${path}`)
  expect(initialResponse.status(), await initialResponse.text()).toBe(200)
  const initial = await initialResponse.json() as { raw: string }
  const saved = await request.put(`/api/posts/${path}`, {
    data: {
      raw: `# D7.5 responsive ${RUN_ID}\n\nViewport matrix evidence.\n`,
      baseRaw: initial.raw,
    },
  })
  expect(saved.status(), await saved.text()).toBe(200)

  const detailResponse = await request.get(`/api/posts/${path}`)
  expect(detailResponse.status(), await detailResponse.text()).toBe(200)
  const detail = await detailResponse.json() as { metadata: { updatedAt: number } }
  const mood = await request.patch(`/api/metadata/documents/${path}`, {
    data: { mood: 'happy', expectedUpdatedAt: detail.metadata.updatedAt },
  })
  expect(mood.status(), await mood.text()).toBe(200)
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

async function moveCalendarToMonth(page: Page, date: string): Promise<void> {
  const targetMonth = date.slice(0, 7)
  const calendar = page.getByTestId('diary-calendar')
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

async function pageOverflowMetrics(page: Page): Promise<{
  viewportWidth: number
  htmlClientWidth: number
  htmlScrollWidth: number
  bodyClientWidth: number
  bodyScrollWidth: number
}> {
  return page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    htmlClientWidth: document.documentElement.clientWidth,
    htmlScrollWidth: document.documentElement.scrollWidth,
    bodyClientWidth: document.body.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }))
}

async function assertNoPageHorizontalOverflow(page: Page, label: string): Promise<void> {
  const metrics = await pageOverflowMetrics(page)
  expect(metrics.htmlScrollWidth, `${label} html horizontal overflow`).toBeLessThanOrEqual(metrics.viewportWidth + 1)
  expect(metrics.bodyScrollWidth, `${label} body horizontal overflow`).toBeLessThanOrEqual(metrics.viewportWidth + 1)
  expect(metrics.htmlScrollWidth, `${label} html client/scroll mismatch`).toBeLessThanOrEqual(metrics.htmlClientWidth + 1)
  expect(metrics.bodyScrollWidth, `${label} body client/scroll mismatch`).toBeLessThanOrEqual(metrics.bodyClientWidth + 1)
}

type Box = {
  left: number
  right: number
  top: number
  bottom: number
  width: number
  height: number
}

type PickerMetrics = {
  picker: Box
  options: Array<{
    id: string
    row: number
    column: number
    visible: boolean
    box: Box
  }>
  clear: { visible: boolean; box: Box }
  rowTops: number[]
  columnLefts: number[]
  rowCounts: number[]
  columnCounts: number[]
  optionWithinPicker: boolean
  clearWithinPicker: boolean
  optionOverlaps: Array<[string, string]>
  clearOverlaps: string[]
  pickerScrollWidth: number
  pickerClientWidth: number
}

async function readPickerMetrics(page: Page): Promise<PickerMetrics> {
  const metrics = await page.evaluate(() => {
    const toBox = (element: Element | null): Box => {
      const rect = element?.getBoundingClientRect()
      return rect
        ? {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
          }
        : { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }
    }
    const picker = document.querySelector<HTMLElement>('[data-testid="diary-mood-picker"]')
    if (!picker) throw new Error('Mood Picker is not mounted')

    const pickerBox = toBox(picker)
    const optionElements = [...picker.querySelectorAll<HTMLElement>('[role="radio"]')]
    const options = optionElements.map((element) => {
      const style = getComputedStyle(element)
      const box = toBox(element)
      return {
        id: element.dataset.moodId ?? '',
        row: Number(element.dataset.row ?? '-1'),
        column: Number(element.dataset.column ?? '-1'),
        visible: style.display !== 'none'
          && style.visibility !== 'hidden'
          && box.width > 0
          && box.height > 0,
        box,
      }
    })
    const cluster = (values: number[]): number[] => {
      const sorted = [...values].sort((left, right) => left - right)
      const clusters: number[] = []
      for (const value of sorted) {
        const previous = clusters[clusters.length - 1]
        if (previous === undefined || Math.abs(value - previous) > 2) clusters.push(value)
      }
      return clusters
    }
    const rowTops = cluster(options.map((option) => option.box.top))
    const columnLefts = cluster(options.map((option) => option.box.left))
    const rowCounts = rowTops.map((top) => options.filter((option) => Math.abs(option.box.top - top) <= 2).length)
    const columnCounts = columnLefts.map((left) => options.filter((option) => Math.abs(option.box.left - left) <= 2).length)
    const overlaps = (left: Box, right: Box): boolean => (
      left.left < right.right - 0.5
      && left.right > right.left + 0.5
      && left.top < right.bottom - 0.5
      && left.bottom > right.top + 0.5
    )
    const optionOverlaps: Array<[string, string]> = []
    for (let index = 0; index < options.length; index += 1) {
      for (let other = index + 1; other < options.length; other += 1) {
        if (overlaps(options[index]!.box, options[other]!.box)) {
          optionOverlaps.push([options[index]!.id, options[other]!.id])
        }
      }
    }
    const clearElement = picker.querySelector<HTMLElement>('[data-testid="diary-mood-clear"]')
    const clearBox = toBox(clearElement)
    return {
      picker: pickerBox,
      options,
      clear: {
        visible: Boolean(clearElement)
          && getComputedStyle(clearElement).display !== 'none'
          && getComputedStyle(clearElement).visibility !== 'hidden'
          && clearBox.width > 0
          && clearBox.height > 0,
        box: clearBox,
      },
      rowTops,
      columnLefts,
      rowCounts,
      columnCounts,
      optionWithinPicker: options.every((option) => (
        option.box.left >= pickerBox.left - 1
        && option.box.right <= pickerBox.right + 1
        && option.box.top >= pickerBox.top - 1
        && option.box.bottom <= pickerBox.bottom + 1
      )),
      clearWithinPicker: clearBox.left >= pickerBox.left - 1
        && clearBox.right <= pickerBox.right + 1
        && clearBox.top >= pickerBox.top - 1
        && clearBox.bottom <= pickerBox.bottom + 1,
      optionOverlaps,
      clearOverlaps: options.filter((option) => overlaps(option.box, clearBox)).map((option) => option.id),
      pickerScrollWidth: picker.scrollWidth,
      pickerClientWidth: picker.clientWidth,
    }
  })
  return metrics
}

function assertPickerGeometry(metrics: PickerMetrics, viewport: Viewport): void {
  expect(metrics.options, `${viewport.name} picker option count`).toHaveLength(24)
  expect(metrics.options.map((option) => option.id), `${viewport.name} canonical row-major order`)
    .toEqual(CANONICAL_MOOD_IDS)
  expect(metrics.options.every((option) => option.visible), `${viewport.name} option visibility`).toBe(true)
  expect(metrics.rowTops, `${viewport.name} real browser row count`).toHaveLength(6)
  expect(metrics.columnLefts, `${viewport.name} real browser column count`).toHaveLength(4)
  expect(metrics.rowCounts, `${viewport.name} four options per row`).toEqual([4, 4, 4, 4, 4, 4])
  expect(metrics.columnCounts, `${viewport.name} six options per column`).toEqual([6, 6, 6, 6])
  expect(metrics.picker.left, `${viewport.name} picker left containment`).toBeGreaterThanOrEqual(-1)
  expect(metrics.picker.right, `${viewport.name} picker right containment`).toBeLessThanOrEqual(viewport.width + 1)
  expect(metrics.picker.width, `${viewport.name} picker width`).toBeGreaterThan(0)
  expect(metrics.picker.height, `${viewport.name} picker height`).toBeGreaterThan(0)
  expect(metrics.optionWithinPicker, `${viewport.name} options clipped by picker`).toBe(true)
  expect(metrics.clear.visible, `${viewport.name} Clear visibility`).toBe(true)
  expect(metrics.clearWithinPicker, `${viewport.name} Clear containment`).toBe(true)
  expect(metrics.optionOverlaps, `${viewport.name} Mood option overlap`).toEqual([])
  expect(metrics.clearOverlaps, `${viewport.name} Clear/option overlap`).toEqual([])
  expect(metrics.pickerScrollWidth, `${viewport.name} picker internal horizontal overflow`)
    .toBeLessThanOrEqual(metrics.pickerClientWidth + 1)
}

type CalendarMetrics = {
  surface: Box
  day: Box
  mood: Box
  previous: Box
  next: Box
  title: Box
  dateMoodSeparated: boolean
  moodOverlapsNeighbor: boolean
  dateBackground: string
  dateBorderWidth: string
  dateBoxShadow: string
}

async function readCalendarMetrics(page: Page, date: string): Promise<CalendarMetrics> {
  return page.evaluate((targetDate) => {
    const toBox = (element: Element | null): Box => {
      const rect = element?.getBoundingClientRect()
      return rect
        ? {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
          }
        : { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }
    }
    const overlaps = (left: Box, right: Box): boolean => (
      left.left < right.right - 0.5
      && left.right > right.left + 0.5
      && left.top < right.bottom - 0.5
      && left.bottom > right.top + 0.5
    )
    const root = document.querySelector<HTMLElement>('[data-testid="diary-calendar"]')
    const activeLayout = root?.querySelector<HTMLElement>('.n-calendar-dates') ?? null
    const dateButton = activeLayout?.querySelector<HTMLElement>(`[data-diary-day-content][data-date="${targetDate}"]`) ?? null
    const moodButton = activeLayout?.querySelector<HTMLElement>(`[data-testid="diary-calendar-mood"][data-date="${targetDate}"]`) ?? null
    const dateBox = toBox(dateButton)
    const moodBox = toBox(moodButton)
    const moodCell = moodButton?.closest('.n-calendar-cell')
    const neighborDateButtons = [...(activeLayout?.querySelectorAll<HTMLElement>('[data-diary-day-content]') ?? [])]
      .filter((button) => button !== dateButton && button.closest('.n-calendar-cell') !== moodCell)
      .map((button) => toBox(button))
    return {
      surface: toBox(document.querySelector('[data-testid="diary-calendar-surface"]')),
      day: dateBox,
      mood: moodBox,
      previous: toBox(root?.querySelector('[data-diary-calendar-nav="previous"]') ?? null),
      next: toBox(root?.querySelector('[data-diary-calendar-nav="next"]') ?? null),
      title: toBox(root?.querySelector('[data-testid="diary-calendar-month"]') ?? null),
      dateMoodSeparated: dateButton !== null && moodButton !== null && dateBox.bottom <= moodBox.top + 1,
      moodOverlapsNeighbor: neighborDateButtons.some((button) => overlaps(moodBox, button)),
      dateBackground: dateButton ? getComputedStyle(dateButton).backgroundColor : '',
      dateBorderWidth: dateButton ? getComputedStyle(dateButton).borderWidth : '',
      dateBoxShadow: dateButton ? getComputedStyle(dateButton).boxShadow : '',
    }
  }, date)
}

function assertCalendarGeometry(metrics: CalendarMetrics, viewport: Viewport): void {
  expect(metrics.surface.width, `${viewport.name} Calendar surface width`).toBeGreaterThan(0)
  expect(metrics.surface.right, `${viewport.name} Calendar surface containment`).toBeLessThanOrEqual(viewport.width + 1)
  expect(metrics.day.width, `${viewport.name} date target width`).toBeGreaterThan(0)
  expect(metrics.day.height, `${viewport.name} date target height`).toBeGreaterThan(0)
  expect(metrics.mood.width, `${viewport.name} Mood target width`).toBeGreaterThan(0)
  expect(metrics.mood.height, `${viewport.name} Mood target height`).toBeGreaterThan(0)
  expect(metrics.dateMoodSeparated, `${viewport.name} date/Mood vertical separation`).toBe(true)
  expect(
    metrics.moodOverlapsNeighbor,
    `${viewport.name} Mood crosses a neighboring date cell: ${JSON.stringify({ day: metrics.day, mood: metrics.mood })}`,
  ).toBe(false)
  expect(metrics.previous.width, `${viewport.name} previous target width`).toBeGreaterThanOrEqual(40)
  expect(metrics.previous.height, `${viewport.name} previous target height`).toBeGreaterThanOrEqual(40)
  expect(metrics.next.width, `${viewport.name} next target width`).toBeGreaterThanOrEqual(40)
  expect(metrics.next.height, `${viewport.name} next target height`).toBeGreaterThanOrEqual(40)
  expect(metrics.previous.right, `${viewport.name} previous control viewport containment`).toBeLessThanOrEqual(viewport.width + 1)
  expect(metrics.next.right, `${viewport.name} next control viewport containment`).toBeLessThanOrEqual(viewport.width + 1)
  expect(metrics.dateBackground, `${viewport.name} selected date background regression`).toMatch(/transparent|rgba\(0, 0, 0, 0\)/i)
  expect(metrics.dateBorderWidth, `${viewport.name} selected date border regression`).toBe('0px')
  expect(metrics.dateBoxShadow, `${viewport.name} selected date shadow regression`).toBe('none')
}

async function closePicker(page: Page): Promise<void> {
  const picker = page.getByTestId('diary-mood-picker')
  if (await picker.count()) {
    await picker.getByTestId('diary-mood-picker-close').click()
    await expect(picker).toHaveCount(0)
  }
}

async function assertNativeDiaryNoOverflow(page: Page, date: string, viewport: Viewport): Promise<void> {
  const path = diaryPath(date)
  await expect(page).toHaveURL(new RegExp(`/vault/${path.replace('/', '\\/')}(?:[?#]|$)`), { timeout: 15_000 })
  await expect(page.getByTestId('diary-calendar')).toBeHidden()
  await expect(page.locator('.reading-pane')).toBeVisible()
  await expect(page.getByTestId('diary-mood-picker')).toHaveCount(0)
  await assertNoPageHorizontalOverflow(page, `${viewport.name} Native Diary`)
}

async function runResponsiveMatrix(page: Page, date: string): Promise<void> {
  const calendar = page.getByTestId('diary-calendar')
  const surface = page.getByTestId('diary-calendar-surface')
  const dateButton = () => calendarDay(surface, date)
  const moodButton = () => calendarMoodButton(surface, date)

  for (const viewport of D75_VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await expect(calendar).toBeVisible()
    await expect(dateButton()).toBeVisible()
    await expect(moodButton()).toBeVisible()
    await assertNoPageHorizontalOverflow(page, `${viewport.name} Calendar Home`)
    assertCalendarGeometry(await readCalendarMetrics(page, date), viewport)

    const monthBefore = await calendar.getAttribute('data-month')
    await page.getByTestId('diary-calendar-next').click()
    await expect(calendar).not.toHaveAttribute('data-month', monthBefore ?? '')
    await page.getByTestId('diary-calendar-previous').click()
    await expect(calendar).toHaveAttribute('data-month', monthBefore ?? '')
    await expect(moodButton()).toHaveCount(1)

    await moodButton().click()
    const picker = page.getByTestId('diary-mood-picker')
    await expect(picker).toBeVisible()
    expect(await page.locator('[data-testid="diary-mood-picker"]').count()).toBe(1)
    assertPickerGeometry(await readPickerMetrics(page), viewport)
    await assertNoPageHorizontalOverflow(page, `${viewport.name} Calendar with Picker`)
    await closePicker(page)

    await dateButton().click()
    await assertNativeDiaryNoOverflow(page, date, viewport)
    await page.locator(`[role="tab"][data-tab-id="${diaryPath(date)}"] .tab-close`).click()
    await expect(page.locator(`[role="tab"][data-tab-id="${diaryPath(date)}"]`)).toHaveCount(0)
    await expect(calendar).toBeVisible()
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/__markdown-test?mode=reading')
  await page.evaluate(() => {
    localStorage.clear()
    localStorage.setItem('nuvyn.theme', 'light')
  })
  await clearDraftDatabase(page)
  await gotoVaultReady(page)
})

test.describe('Chinese light responsive matrix', () => {
  test.use({ locale: 'zh-CN' })

  test('keeps Calendar and the single Mood Picker usable across all D7.5 viewports', async ({ page, request }) => {
    test.setTimeout(120_000)
    const date = localCivilDate()
    try {
      await seedDiary(request, date)
      await openDiaryHome(page)
      await expect(page.getByTestId('diary-calendar')).toHaveAttribute('data-theme', 'light')
      await expect(page.getByTestId('diary-calendar')).toHaveAttribute('data-locale', 'zh-CN')
      await runResponsiveMatrix(page, date)
    } finally {
      await deletePost(request, diaryPath(date))
    }
  })
})

test.describe('English dark and ordinary Vault responsive smoke', () => {
  test.use({ locale: 'en-US' })

  test('keeps Picker geometry stable in dark theme and keeps ordinary Vault outside Mood policy', async ({ page, request }) => {
    test.setTimeout(120_000)
    const date = localCivilDate()
    const note = `inbox/d75-ordinary-${RUN_ID}`
    try {
      await seedDiary(request, date)
      await seedNote(request, note)
      await openDiaryHome(page)
      const themeToggle = page.locator('.theme-toggle')
      await expect(themeToggle).toBeVisible()
      await themeToggle.click()
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
      await expect(page.getByTestId('diary-calendar')).toHaveAttribute('data-theme', 'dark')
      await expect(page.getByTestId('diary-calendar')).toHaveAttribute('data-locale', 'en-US')
      await expect(page.getByTestId('diary-calendar-mood', { exact: true })).toHaveCount(1)

      for (const viewport of [D75_VIEWPORTS[0]!, D75_VIEWPORTS[3]!]) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height })
        await expect(page.getByTestId('diary-calendar')).toBeVisible()
        await expect(calendarMoodButton(page.getByTestId('diary-calendar'), date)).toBeVisible()
        await assertNoPageHorizontalOverflow(page, `${viewport.name} dark Calendar Home`)
        assertCalendarGeometry(await readCalendarMetrics(page, date), viewport)
        await calendarMoodButton(page.getByTestId('diary-calendar'), date).click()
        await expect(page.getByTestId('diary-mood-picker')).toBeVisible()
        const metrics = await readPickerMetrics(page)
        assertPickerGeometry(metrics, viewport)
        await expect(page.getByTestId('diary-mood-clear')).toHaveText('Clear mood')
        await assertNoPageHorizontalOverflow(page, `${viewport.name} dark Calendar with Picker`)
        await closePicker(page)
      }

      // Ordinary Vault is a boundary smoke, not a second responsive redesign
      // target. Use the wide native layout here; the mobile native workspace
      // is already covered by the existing D6.6 responsive suite.
      await page.setViewportSize({ width: 1280, height: 800 })
      await selectScope(page, 'note')
      await expect(page.getByTestId('diary-calendar')).toHaveCount(0)
      await expect(page.locator('.file-tree')).toBeVisible()
      const ordinaryRow = page.locator(`[data-tree-key="file:${note}"]`)
      if (!(await ordinaryRow.isVisible())) {
        const ordinaryFolder = page.locator('[data-tree-key="folder:inbox"]')
        await expect(ordinaryFolder).toBeVisible()
        await ordinaryFolder.locator('.row-line').click()
      }
      await expect(ordinaryRow).toBeVisible()
      await ordinaryRow.locator('.row-line').click()
      await expect(page).toHaveURL(new RegExp(`/vault/${note.replace('/', '\\/')}(?:[?#]|$)`))
      await expect(page.getByTestId('diary-mood-picker')).toHaveCount(0)
      // The mobile document contract already proves the native workspace
      // without the optional FileTree side panel. Keep this smoke focused on
      // the ordinary Vault boundary rather than reopening generic Vault
      // layout work in D7.5 Round 1.
      const explorer = page.getByRole('button', { name: /Explorer|文件浏览器|文件资源管理器/i })
      await expect(explorer).toHaveAttribute('aria-pressed', 'true')
      await explorer.click()
      await expect(page.locator('.file-tree')).toBeHidden()
      await assertNoPageHorizontalOverflow(page, '1280px ordinary Vault without FileTree')
    } finally {
      await deletePost(request, diaryPath(date))
      await deletePost(request, note)
    }
  })
})
