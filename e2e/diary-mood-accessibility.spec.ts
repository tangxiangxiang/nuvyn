import { expect, test, type APIRequestContext, type Page } from './fixtures/diary'
import { CALENDAR_TEST_DATE, CALENDAR_TEST_TIME_ZONE, calendarDay, calendarMoodButton } from './helpers/calendar-clock'

const TEST_TIME_ZONE = CALENDAR_TEST_TIME_ZONE
const RUN_ID = String(Date.now())

test.use({
  timezoneId: TEST_TIME_ZONE,
  trace: 'off',
  screenshot: 'only-on-failure',
})

function localCivilDate(): string {
  return CALENDAR_TEST_DATE
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

async function seedExistingDiary(request: APIRequestContext, date: string, mood = 'happy'): Promise<void> {
  const path = diaryPath(date)
  await deleteDiaryDate(request, date)
  const created = await request.post('/api/diary/dates', {
    data: { date, timeZone: TEST_TIME_ZONE },
  })
  expect(created.status(), await created.text()).toBe(201)

  const initialResponse = await request.get(`/api/posts/${path}`)
  expect(initialResponse.status(), await initialResponse.text()).toBe(200)
  const initial = await initialResponse.json() as { raw: string }
  const saved = await request.put(`/api/posts/${path}`, {
    data: {
      raw: `# D7.5 accessibility ${RUN_ID}\n\nKeyboard and locale evidence.\n`,
      baseRaw: initial.raw,
    },
  })
  expect(saved.status(), await saved.text()).toBe(200)

  const detailResponse = await request.get(`/api/posts/${path}`)
  expect(detailResponse.status(), await detailResponse.text()).toBe(200)
  const detail = await detailResponse.json() as { metadata: { updatedAt: number } }
  const moodResponse = await request.patch(`/api/metadata/documents/${path}`, {
    data: { mood, expectedUpdatedAt: detail.metadata.updatedAt },
  })
  expect(moodResponse.status(), await moodResponse.text()).toBe(200)
}

async function findUnusedPastDate(request: APIRequestContext): Promise<string> {
  let candidate = previousCivilDate(localCivilDate())
  for (let attempt = 0; attempt < 45; attempt += 1) {
    const response = await request.get(`/api/posts/${diaryPath(candidate)}`)
    if (response.status() === 404) return candidate
    expect(response.status(), await response.text()).toBe(200)
    candidate = previousCivilDate(candidate)
  }
  throw new Error('unable to find an unused past Diary date')
}

async function selectScope(page: Page, scope: 'note' | 'diary'): Promise<void> {
  const chip = page.locator('.scope-chip').filter({ hasText: scope })
  if (await chip.getAttribute('aria-pressed') !== 'true') await chip.click()
}

async function openDiaryHome(page: Page): Promise<void> {
  await page.goto('/vault')
  await expect(page.locator('.file-tree')).toBeVisible()
  await selectScope(page, 'diary')
  await expect(page.getByTestId('diary-calendar-surface')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('diary-calendar')).toBeVisible()
}

async function moveCalendarToMonth(page: Page, date: string): Promise<void> {
  const calendar = page.getByTestId('diary-calendar')
  const targetMonth = date.slice(0, 7)
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const currentMonth = await calendar.getAttribute('data-month')
    if (currentMonth === targetMonth) return
    if (!currentMonth) throw new Error('Calendar did not expose its current month')
    await page.getByTestId(currentMonth < targetMonth ? 'diary-calendar-next' : 'diary-calendar-previous').click()
  }
  throw new Error(`Calendar did not reach ${targetMonth}`)
}

function captureDiagnostics(page: Page): { pageErrors: string[]; consoleErrors: string[] } {
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  return { pageErrors, consoleErrors }
}

function startMoodPatchCounter(page: Page): () => number {
  let count = 0
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (request.method() === 'PATCH' && url.pathname.startsWith('/api/metadata/documents/diary/')) count += 1
  })
  return () => count
}

async function focusByKeyboard(page: Page, selector: string): Promise<void> {
  await page.evaluate(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
  })
  const target = page.locator(selector)
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return
    await page.keyboard.press('Tab')
  }
  throw new Error(`keyboard traversal did not reach ${selector}`)
}

async function focusIndicator(locator: ReturnType<Page['locator']>): Promise<{
  outlineStyle: string
  outlineWidth: string
  outlineColor: string
  boxShadow: string
}> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineColor: style.outlineColor,
      boxShadow: style.boxShadow,
    }
  })
}

function assertVisibleFocusIndicator(style: Awaited<ReturnType<typeof focusIndicator>>): void {
  const outlineVisible = style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0
  const shadowVisible = style.boxShadow !== 'none' && !style.boxShadow.includes('rgba(0, 0, 0, 0)')
  expect(outlineVisible || shadowVisible).toBe(true)
  if (outlineVisible) expect(style.outlineColor).not.toMatch(/transparent|rgba\([^)]*,\s*0\)$/i)
}

test('keyboard grid keeps 4×6 geometry and arrows do not mutate Mood', async ({ page, request }) => {
  const date = localCivilDate()
  const diagnostics = captureDiagnostics(page)
  const moodPatchCount = startMoodPatchCounter(page)

  try {
    await seedExistingDiary(request, date, 'happy')
    await openDiaryHome(page)
    const surface = page.getByTestId('diary-calendar-surface')
    const moodButton = surface.locator(`[data-testid="diary-calendar-mood"][data-date="${date}"]`)
    await moodButton.click()

    const picker = page.getByTestId('diary-mood-picker')
    const radios = picker.getByRole('radio')
    await expect(picker).toBeVisible()
    await expect(radios).toHaveCount(24)
    await expect(picker.getByRole('radiogroup')).toHaveCount(1)
    await expect(picker.getByRole('radio', { name: '开心 / Happy' })).toBeFocused()
    await expect(picker.locator('[aria-checked="true"]')).toHaveCount(1)

    const roving = await radios.evaluateAll((elements) => elements.map((element) => ({
      id: element.getAttribute('data-mood-id'),
      tabIndex: element.getAttribute('tabindex'),
      row: element.getAttribute('data-row'),
      column: element.getAttribute('data-column'),
      checked: element.getAttribute('aria-checked'),
    })))
    expect(roving.filter((radio) => radio.tabIndex === '0')).toHaveLength(1)
    expect(roving.filter((radio) => radio.tabIndex === '-1')).toHaveLength(23)
    expect(roving.map((radio) => [radio.row, radio.column])).toEqual([
      ['1', '1'], ['1', '2'], ['1', '3'], ['1', '4'],
      ['2', '1'], ['2', '2'], ['2', '3'], ['2', '4'],
      ['3', '1'], ['3', '2'], ['3', '3'], ['3', '4'],
      ['4', '1'], ['4', '2'], ['4', '3'], ['4', '4'],
      ['5', '1'], ['5', '2'], ['5', '3'], ['5', '4'],
      ['6', '1'], ['6', '2'], ['6', '3'], ['6', '4'],
    ])

    async function expectArrow(fromId: string, key: string, toId: string): Promise<void> {
      const source = picker.locator(`[data-mood-id="${fromId}"]`)
      await source.focus()
      await page.keyboard.press(key)
      await expect(picker.locator(`[data-mood-id="${toId}"]`)).toBeFocused()
      await expect(picker.locator('[data-mood-id="happy"]')).toHaveAttribute('aria-checked', 'true')
      await expect(picker.locator('[data-mood-id="sad"]')).toHaveAttribute('aria-checked', 'false')
    }

    await expectArrow('kiss', 'ArrowLeft', 'kiss')
    await expectArrow('kiss', 'ArrowUp', 'kiss')
    await expectArrow('surprised-small', 'ArrowRight', 'surprised-small')
    await expectArrow('surprised-small', 'ArrowUp', 'surprised-small')
    await expectArrow('laughing-tears', 'ArrowLeft', 'laughing-tears')
    await expectArrow('laughing-tears', 'ArrowDown', 'laughing-tears')
    await expectArrow('devilish', 'ArrowRight', 'devilish')
    await expectArrow('devilish', 'ArrowDown', 'devilish')
    await expectArrow('shy', 'ArrowRight', 'happy')
    await expectArrow('shy', 'ArrowLeft', 'afraid')
    await expectArrow('shy', 'ArrowDown', 'angry')
    await expectArrow('shy', 'ArrowUp', 'like')
    expect(moodPatchCount()).toBe(0)
    expect(new URL(page.url()).pathname).toBe('/vault')
    await expect(page.locator(`[role="tab"][data-tab-id="${diaryPath(date)}"]`)).toHaveCount(0)
  } finally {
    await deleteDiaryDate(request, date)
  }

  expect(diagnostics.pageErrors).toEqual([])
  expect(diagnostics.consoleErrors).toEqual([])
})

test('Enter, Space, and Clear each perform exactly one Mood mutation', async ({ page, request }) => {
  const date = localCivilDate()
  const path = diaryPath(date)
  const diagnostics = captureDiagnostics(page)
  const moodPatchCount = startMoodPatchCounter(page)

  try {
    await seedExistingDiary(request, date, 'happy')
    await openDiaryHome(page)
    const moodButton = page.locator(`[data-testid="diary-calendar-mood"][data-date="${date}"]`)
    const picker = page.getByTestId('diary-mood-picker')

    await moodButton.click()
    await picker.getByRole('radio', { name: '伤心 / Sad' }).press('Enter')
    await expect.poll(moodPatchCount).toBe(1)
    await expect.poll(async () => {
      const response = await request.get(`/api/posts/${path}`)
      if (response.status() !== 200) return null
      const body = await response.json() as { metadata?: { mood?: string | null } }
      return body.metadata?.mood ?? null
    }).toBe('sad')
    await expect(picker).toHaveCount(0)

    await moodButton.click()
    await picker.getByRole('radio', { name: '开心 / Happy' }).press(' ')
    await expect.poll(moodPatchCount).toBe(2)
    await expect.poll(async () => {
      const response = await request.get(`/api/posts/${path}`)
      if (response.status() !== 200) return null
      const body = await response.json() as { metadata?: { mood?: string | null } }
      return body.metadata?.mood ?? null
    }).toBe('happy')
    await expect(picker).toHaveCount(0)

    await moodButton.click()
    const clear = picker.getByTestId('diary-mood-clear')
    await picker.getByRole('radio', { name: '开心 / Happy' }).press('Tab')
    await expect(clear).toBeFocused()
    await clear.press('Enter')
    await expect.poll(moodPatchCount).toBe(3)
    await expect.poll(async () => {
      const response = await request.get(`/api/posts/${path}`)
      if (response.status() !== 200) return null
      const body = await response.json() as { metadata?: { mood?: string | null } }
      return body.metadata?.mood ?? null
    }).toBeNull()
    await expect(picker).toHaveCount(0)
    await expect(moodButton).toHaveText('?')
    await expect(page).toHaveURL(/\/vault(?:[?#]|$)/)
    await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveCount(0)
    expect(moodPatchCount()).toBe(3)
  } finally {
    await deleteDiaryDate(request, date)
  }

  expect(diagnostics.pageErrors).toEqual([])
  expect(diagnostics.consoleErrors).toEqual([])
})

test('Escape and picker Close restore the same Mood trigger without navigation', async ({ page, request }) => {
  const date = localCivilDate()
  const diagnostics = captureDiagnostics(page)
  const moodPatchCount = startMoodPatchCounter(page)

  try {
    await seedExistingDiary(request, date, 'happy')
    await openDiaryHome(page)
    const surface = page.getByTestId('diary-calendar-surface')
    const moodButton = surface.locator(`[data-testid="diary-calendar-mood"][data-date="${date}"]`)
    await focusByKeyboard(page, `[data-testid="diary-calendar-mood"][data-date="${date}"]`)
    await expect(moodButton).toBeFocused()
    await page.keyboard.press('Enter')

    const picker = page.getByTestId('diary-mood-picker')
    await expect(picker).toBeVisible()
    await expect(picker.getByRole('radio', { name: '开心 / Happy' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(picker).toHaveCount(0)
    await expect(moodButton).toBeFocused()
    expect(moodPatchCount()).toBe(0)
    expect(new URL(page.url()).pathname).toBe('/vault')

    await page.keyboard.press('Enter')
    await expect(picker).toBeVisible()
    await expect(picker.getByRole('radio', { name: '开心 / Happy' })).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    const close = picker.getByTestId('diary-mood-picker-close')
    await expect(close).toBeFocused()
    await close.press('Enter')
    await expect(picker).toHaveCount(0)
    await expect(moodButton).toBeFocused()
    expect(moodPatchCount()).toBe(0)
    expect(new URL(page.url()).pathname).toBe('/vault')
  } finally {
    await deleteDiaryDate(request, date)
  }

  expect(diagnostics.pageErrors).toEqual([])
  expect(diagnostics.consoleErrors).toEqual([])
})

test('missing past date enters Mood-first picker by keyboard and Escape creates nothing', async ({ page, request }) => {
  const date = await findUnusedPastDate(request)
  const path = diaryPath(date)
  const diagnostics = captureDiagnostics(page)
  const createMethods: string[] = []
  const moodPatchRequests: string[] = []
  page.on('request', (requestEvent) => {
    const url = new URL(requestEvent.url())
    if (url.pathname === '/api/diary/dates') createMethods.push(requestEvent.method())
    if (requestEvent.method() === 'PATCH' && url.pathname === `/api/metadata/documents/${path}`) {
      moodPatchRequests.push(requestEvent.method())
    }
  })

  try {
    await deleteDiaryDate(request, date)
    await openDiaryHome(page)
    await moveCalendarToMonth(page, date)
    const dateButton = calendarDay(page.getByTestId('diary-calendar'), date)
    await expect(dateButton).toBeVisible()
    // DiaryCalendar exposes the custom date button as the actual keyboard
    // owner. Focus it explicitly, then use a real keyboard activation to
    // characterize the Mood-first entry path.
    await dateButton.focus()
    await expect(dateButton).toBeFocused()
    await page.keyboard.press('Enter')

    const picker = page.getByTestId('diary-mood-picker')
    await expect(picker).toBeVisible()
    await expect(picker.getByRole('radio').first()).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(picker).toHaveCount(0)
    await expect(dateButton).toBeFocused()
    expect(createMethods).toEqual([])
    expect(moodPatchRequests).toEqual([])
    expect((await request.get(`/api/posts/${path}`)).status()).toBe(404)
    expect(new URL(page.url()).pathname).toBe('/vault')
  } finally {
    await deleteDiaryDate(request, date)
  }

  expect(diagnostics.pageErrors).toEqual([])
  expect(diagnostics.consoleErrors).toEqual([])
})

test('Calendar Mood trigger exposes truthful popup semantics and complete radio ARIA', async ({ page, request }) => {
  const date = localCivilDate()
  const diagnostics = captureDiagnostics(page)

  try {
    await seedExistingDiary(request, date, 'happy')
    await openDiaryHome(page)
    const calendar = page.getByTestId('diary-calendar')
    const dateButton = calendarDay(calendar, date)
    const moodButton = calendarMoodButton(calendar, date)
    await expect(calendar).toHaveAccessibleName(/日记日历|Diary calendar/)
    await expect(dateButton).toHaveAccessibleName(/有日记|Diary exists/)
    await expect(moodButton).toHaveAccessibleName(/心情|mood/i)
    await expect(moodButton).toHaveAttribute('aria-expanded', 'false')

    await moodButton.click()
    const picker = page.getByTestId('diary-mood-picker')
    await expect(moodButton).toHaveAttribute('aria-expanded', 'true')
    const popupRole = await picker.getAttribute('role')
    const hasPopup = await moodButton.getAttribute('aria-haspopup')
    if (hasPopup === 'dialog') expect(popupRole).toBe('dialog')
    else if (hasPopup === 'menu') expect(popupRole).toBe('menu')
    else if (hasPopup === 'listbox') expect(popupRole).toBe('listbox')
    else if (hasPopup === 'tree') expect(popupRole).toBe('tree')
    else if (hasPopup === 'grid') expect(popupRole).toBe('grid')
    else expect(hasPopup).toBeNull()

    const controls = await moodButton.getAttribute('aria-controls')
    expect(controls).toBeTruthy()
    expect(await picker.getAttribute('id')).toBe(controls)
    expect(await page.locator(`#${controls}`).count()).toBe(1)
    await expect(picker).toHaveAccessibleName(/选择心情|Choose a mood/)
    await expect(picker.getByRole('radiogroup')).toHaveAccessibleName(/心情选项|Mood options/)

    const radios = picker.getByRole('radio')
    await expect(radios).toHaveCount(24)
    const radioState = await radios.evaluateAll((elements) => elements.map((element) => ({
      name: element.getAttribute('aria-label') ?? '',
      checked: element.getAttribute('aria-checked'),
      tabIndex: element.getAttribute('tabindex'),
      posInSet: element.getAttribute('aria-posinset'),
      setSize: element.getAttribute('aria-setsize'),
    })))
    expect(radioState.every((radio) => radio.name.length > 0)).toBe(true)
    expect(new Set(radioState.map((radio) => radio.name)).size).toBe(24)
    expect(radioState.every((radio) => radio.checked === 'true' || radio.checked === 'false')).toBe(true)
    expect(radioState.filter((radio) => radio.checked === 'true')).toHaveLength(1)
    expect(radioState.filter((radio) => radio.tabIndex === '0')).toHaveLength(1)
    expect(radioState.map((radio) => radio.posInSet)).toEqual(Array.from({ length: 24 }, (_, index) => String(index + 1)))
    expect(radioState.every((radio) => radio.setSize === '24')).toBe(true)
    await expect(picker.getByTestId('diary-mood-picker-close')).toHaveAccessibleName(/关闭心情选择器|Close mood picker/)
    await expect(picker.getByTestId('diary-mood-clear')).toHaveAccessibleName(/清空心情|Clear mood/)
    expect(await picker.textContent()).not.toContain('✓')
  } finally {
    await deleteDiaryDate(request, date)
  }

  expect(diagnostics.pageErrors).toEqual([])
  expect(diagnostics.consoleErrors).toEqual([])
})

test('selected Mood has a visible non-color cue and keyboard focus rings are visible', async ({ page, request }) => {
  await page.addInitScript(() => localStorage.setItem('nuvyn.theme', 'light'))
  const date = localCivilDate()
  const diagnostics = captureDiagnostics(page)

  try {
    await seedExistingDiary(request, date, 'happy')
    await openDiaryHome(page)
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    const moodButton = page.locator(`[data-testid="diary-calendar-mood"][data-date="${date}"]`)
    await focusByKeyboard(page, `[data-testid="diary-calendar-mood"][data-date="${date}"]`)
    assertVisibleFocusIndicator(await focusIndicator(moodButton))
    await page.keyboard.press('Enter')

    const picker = page.getByTestId('diary-mood-picker')
    const selected = picker.locator('[data-mood-id="happy"]')
    const unselected = picker.locator('[data-mood-id="sad"]')
    await expect(selected).toBeFocused()
    assertVisibleFocusIndicator(await focusIndicator(selected))

    const cueStyles = await page.evaluate(() => {
      const selectedOption = document.querySelector<HTMLElement>('[data-mood-id="happy"]')
      const unselectedOption = document.querySelector<HTMLElement>('[data-mood-id="sad"]')
      const selectedLabel = selectedOption?.querySelector<HTMLElement>('.diary-mood-option-label')
      const unselectedLabel = unselectedOption?.querySelector<HTMLElement>('.diary-mood-option-label')
      if (!selectedOption || !unselectedOption || !selectedLabel || !unselectedLabel) {
        throw new Error('selected and unselected Mood options are required')
      }
      const selectedOptionStyle = getComputedStyle(selectedOption)
      const unselectedOptionStyle = getComputedStyle(unselectedOption)
      const selectedLabelStyle = getComputedStyle(selectedLabel)
      const unselectedLabelStyle = getComputedStyle(unselectedLabel)
      return {
        selectedFontWeight: selectedLabelStyle.fontWeight,
        unselectedFontWeight: unselectedLabelStyle.fontWeight,
        selectedFontStyle: selectedLabelStyle.fontStyle,
        unselectedFontStyle: unselectedLabelStyle.fontStyle,
        selectedTextDecoration: selectedLabelStyle.textDecorationLine,
        unselectedTextDecoration: unselectedLabelStyle.textDecorationLine,
        selectedBorderWidth: selectedOptionStyle.borderWidth,
        unselectedBorderWidth: unselectedOptionStyle.borderWidth,
        selectedBorderStyle: selectedOptionStyle.borderStyle,
        unselectedBorderStyle: unselectedOptionStyle.borderStyle,
      }
    })
    expect(
      cueStyles.selectedFontWeight !== cueStyles.unselectedFontWeight
      || cueStyles.selectedFontStyle !== cueStyles.unselectedFontStyle
      || cueStyles.selectedTextDecoration !== cueStyles.unselectedTextDecoration
      || cueStyles.selectedBorderWidth !== cueStyles.unselectedBorderWidth
      || cueStyles.selectedBorderStyle !== cueStyles.unselectedBorderStyle,
    ).toBe(true)

    await page.keyboard.press('Tab')
    const clear = picker.getByTestId('diary-mood-clear')
    await expect(clear).toBeFocused()
    assertVisibleFocusIndicator(await focusIndicator(clear))
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Shift+Tab')
    const close = picker.getByTestId('diary-mood-picker-close')
    await expect(close).toBeFocused()
    assertVisibleFocusIndicator(await focusIndicator(close))

    await close.press('Escape')
    await expect(picker).toHaveCount(0)
    await page.getByRole('button', { name: /主题：浅色|Theme: Light/ }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.getByTestId('diary-calendar')).toHaveAttribute('data-theme', 'dark')
  } finally {
    await deleteDiaryDate(request, date)
  }

  expect(diagnostics.pageErrors).toEqual([])
  expect(diagnostics.consoleErrors).toEqual([])
})

test.describe('Chinese touch interaction', () => {
  test.use({ locale: 'zh-CN', hasTouch: true, viewport: { width: 375, height: 812 } })

  test('real touch activates Mood without date navigation and Clear remains usable', async ({ page, request }) => {
    const date = localCivilDate()
    const path = diaryPath(date)
    const diagnostics = captureDiagnostics(page)
    const moodPatchCount = startMoodPatchCounter(page)

    try {
      await seedExistingDiary(request, date, 'happy')
      await openDiaryHome(page)
      const moodButton = page.locator(`[data-testid="diary-calendar-mood"][data-date="${date}"]`)
      await expect(moodButton).toBeVisible()
      await moodButton.tap()

      const picker = page.getByTestId('diary-mood-picker')
      await expect(picker).toBeVisible()
      await picker.getByRole('radio', { name: '伤心 / Sad' }).tap()
      await expect.poll(moodPatchCount).toBe(1)
      await expect.poll(async () => {
        const response = await request.get(`/api/posts/${path}`)
        if (response.status() !== 200) return null
        const body = await response.json() as { metadata?: { mood?: string | null } }
        return body.metadata?.mood ?? null
      }).toBe('sad')
      await expect(picker).toHaveCount(0)
      await expect(page).toHaveURL(/\/vault(?:[?#]|$)/)
      await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveCount(0)

      await moodButton.tap()
      await picker.getByTestId('diary-mood-clear').tap()
      await expect.poll(moodPatchCount).toBe(2)
      await expect.poll(async () => {
        const response = await request.get(`/api/posts/${path}`)
        if (response.status() !== 200) return null
        const body = await response.json() as { metadata?: { mood?: string | null } }
        return body.metadata?.mood ?? null
      }).toBeNull()
      await expect(picker).toHaveCount(0)
      await expect(moodButton).toHaveText('?')
      expect(moodPatchCount()).toBe(2)
    } finally {
      await deleteDiaryDate(request, date)
    }

    expect(diagnostics.pageErrors).toEqual([])
    expect(diagnostics.consoleErrors).toEqual([])
  })
})

test.describe('Chinese light keyboard locale', () => {
  test.use({ locale: 'zh-CN' })

  test('keeps Calendar and Mood names available in Chinese', async ({ page, request }) => {
    await page.addInitScript(() => localStorage.setItem('nuvyn.theme', 'light'))
    const date = localCivilDate()
    const diagnostics = captureDiagnostics(page)

    try {
      await seedExistingDiary(request, date, 'happy')
      await openDiaryHome(page)
      await expect(page.getByTestId('diary-calendar')).toHaveAttribute('data-locale', 'zh-CN')
      await expect(page.getByTestId('diary-calendar')).toHaveAccessibleName('日记日历')
      const moodButton = page.locator(`[data-testid="diary-calendar-mood"][data-date="${date}"]`)
      await expect(moodButton).toHaveAccessibleName(/设置 .* 的心情/)
      await moodButton.click()
      const picker = page.getByTestId('diary-mood-picker')
      await expect(picker).toHaveAccessibleName('选择心情')
      await expect(picker.getByRole('radiogroup')).toHaveAccessibleName('心情选项')
      await expect(picker.getByTestId('diary-mood-picker-close')).toHaveAccessibleName('关闭心情选择器')
      await expect(picker.getByTestId('diary-mood-clear')).toHaveAccessibleName('清空心情')
      await expect(picker.getByRole('radio', { name: '开心 / Happy' })).toHaveAttribute('aria-checked', 'true')
    } finally {
      await deleteDiaryDate(request, date)
    }

    expect(diagnostics.pageErrors).toEqual([])
    expect(diagnostics.consoleErrors).toEqual([])
  })
})

test.describe('English dark keyboard locale', () => {
  test.use({ locale: 'en-US' })

  test('keeps Calendar and Mood names available in English and dark theme', async ({ page, request }) => {
    await page.addInitScript(() => localStorage.setItem('nuvyn.theme', 'dark'))
    const date = localCivilDate()
    const diagnostics = captureDiagnostics(page)

    try {
      await seedExistingDiary(request, date, 'happy')
      await openDiaryHome(page)
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
      const calendar = page.getByTestId('diary-calendar')
      await expect(calendar).toHaveAttribute('data-locale', 'en-US')
      await expect(calendar).toHaveAccessibleName('Diary calendar')
      const moodButton = page.locator(`[data-testid="diary-calendar-mood"][data-date="${date}"]`)
      await expect(moodButton).toHaveAccessibleName(/Set mood for/)
      await focusByKeyboard(page, `[data-testid="diary-calendar-mood"][data-date="${date}"]`)
      await expect(moodButton).toBeFocused()
      assertVisibleFocusIndicator(await focusIndicator(moodButton))
      await page.keyboard.press('Enter')
      const picker = page.getByTestId('diary-mood-picker')
      await expect(picker).toHaveAccessibleName('Choose a mood')
      await expect(picker.getByRole('radiogroup')).toHaveAccessibleName('Mood options')
      await expect(picker.getByTestId('diary-mood-picker-close')).toHaveAccessibleName('Close mood picker')
      await expect(picker.getByTestId('diary-mood-clear')).toHaveAccessibleName('Clear mood')
      const selected = picker.getByRole('radio', { name: '开心 / Happy' })
      await expect(selected).toHaveAttribute('aria-checked', 'true')
      await expect(selected).toBeFocused()
      assertVisibleFocusIndicator(await focusIndicator(selected))
      await page.keyboard.press('Tab')
      await expect(picker.getByTestId('diary-mood-clear')).toBeFocused()
      assertVisibleFocusIndicator(await focusIndicator(picker.getByTestId('diary-mood-clear')))
      await page.keyboard.press('Escape')
      await expect(picker).toHaveCount(0)
      await expect(moodButton).toBeFocused()
    } finally {
      await deleteDiaryDate(request, date)
    }

    expect(diagnostics.pageErrors).toEqual([])
    expect(diagnostics.consoleErrors).toEqual([])
  })
})
