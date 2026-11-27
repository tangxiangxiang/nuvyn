import { test, expect } from './fixtures/auth'
import { unlockDiary } from './helpers/diary-life'

test('keeps the calendar grid continuous across views, themes, and viewport sizes', async ({ page }, testInfo) => {
  test.setTimeout(60_000)
  await page.clock.install({ time: new Date(2026, 10, 16, 12) })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'language', { configurable: true, value: 'zh-CN' })
  })
  await page.route('**/api/diary/life/**', async route => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname
    if (request.method() === 'GET' && pathname === '/api/diary/life/events') {
      await route.fulfill({ json: { items: [{
        id: 'calendar-grid-birthday', title: '生日', description: '', emoji: '🎂', type: 'birthday',
        startDate: '2026-11-15', endDate: '2026-11-15', startTime: null, endTime: null,
        allDay: true, recurrence: 'none', showCountdown: false, isPrimary: false,
        version: 1, createdAt: 1, updatedAt: 1,
      }], next: null } })
    } else if (request.method() === 'GET' && pathname === '/api/diary/life/task-occurrences') {
      await route.fulfill({ json: { items: [], nextCursor: null } })
    } else await route.continue()
  })
  await page.goto('/diary')
  await unlockDiary(page)

  const calendar = page.locator('.diary-life-calendar')
  const monthLabel = calendar.locator('.life-month-label')

  const inspectGrid = () => calendar.evaluate(root => {
    const grid = root.querySelector<HTMLElement>('.n-calendar-dates')!
    const cells = [...grid.querySelectorAll<HTMLElement>('.n-calendar-cell')]
    const gridBounds = grid.getBoundingClientRect()
    const weekdayLabels = [...root.querySelectorAll<HTMLElement>('.life-weekdays span')]
      .map(label => {
        const { x, y, width, height } = label.getBoundingClientRect()
        return { x, y, width, height }
      })
    const cellBounds = cells.map(cell => {
      const { x, y, width, height } = cell.getBoundingClientRect()
      return { x, y, width, height }
    })
    const borders = cells.map(cell => {
      const style = getComputedStyle(cell, '::before')
      return {
        position: getComputedStyle(cell).position,
        topWidth: style.borderTopWidth,
        topStyle: style.borderTopStyle,
        rightWidth: style.borderRightWidth,
        rightStyle: style.borderRightStyle,
        bottomWidth: style.borderBottomWidth,
        bottomStyle: style.borderBottomStyle,
        leftWidth: style.borderLeftWidth,
        leftStyle: style.borderLeftStyle,
        color: style.borderRightColor,
        topLeftRadius: style.borderTopLeftRadius,
        topRightRadius: style.borderTopRightRadius,
        bottomLeftRadius: style.borderBottomLeftRadius,
        bottomRightRadius: style.borderBottomRightRadius,
      }
    })
    const todayBadge = root.querySelector<HTMLElement>('.life-date.today .life-date-badge')
    const todayCell = todayBadge?.closest<HTMLElement>('.n-calendar-cell')
    const todayCellBounds = todayCell?.getBoundingClientRect()
    const todayCellStyle = todayCell ? getComputedStyle(todayCell) : null
    const content = root.querySelector<HTMLElement>('.life-date-content')
    const contentStyle = content ? getComputedStyle(content) : null
    const dateCells = cells.map(cell => {
      const button = cell.querySelector<HTMLElement>('.life-date')
      const lunar = button?.querySelector<HTMLElement>('.life-date-lunar')
      const gregorian = button?.querySelector<HTMLElement>('.life-date-badge')
      const number = button?.querySelector<HTMLElement>('.life-date-number')
      const markerSlot = button?.querySelector<HTMLElement>('.life-marker-slot')
      const marker = button?.querySelector<HTMLElement>('.life-event-marker, .life-task-marker')
      const cellRect = cell.getBoundingClientRect()
      const lunarRect = lunar?.getBoundingClientRect()
      const gregorianRect = gregorian?.getBoundingClientRect()
      const numberRect = number?.getBoundingClientRect()
      const markerSlotRect = markerSlot?.getBoundingClientRect()
      const markerRect = marker?.getBoundingClientRect()
      return button && lunar && gregorian && number && markerSlot && lunarRect && gregorianRect && numberRect && markerSlotRect ? {
        date: button.dataset.date ?? '',
        lunarText: lunar.textContent?.trim() ?? '',
        gregorianText: number.textContent?.trim() ?? '',
        cell: { x: cellRect.x, y: cellRect.y, width: cellRect.width, height: cellRect.height },
        lunar: { x: lunarRect.x, y: lunarRect.y, right: lunarRect.right, width: lunarRect.width },
        gregorian: { x: gregorianRect.x, y: gregorianRect.y, width: gregorianRect.width, right: gregorianRect.right },
        number: { x: numberRect.x, y: numberRect.y, width: numberRect.width, height: numberRect.height },
        markerSlot: { x: markerSlotRect.x, y: markerSlotRect.y, width: markerSlotRect.width, height: markerSlotRect.height },
        marker: markerRect ? { x: markerRect.x, y: markerRect.y, width: markerRect.width, height: markerRect.height, bottom: markerRect.bottom } : null,
      } : null
    })

    return {
      grid: { width: gridBounds.width, height: gridBounds.height },
      cells: cellBounds,
      borders,
      weekdayLabels,
      weekdayGap: gridBounds.y - Math.max(...weekdayLabels.map(label => label.y + label.height)),
      content: contentStyle ? {
        display: contentStyle.display,
        paddingTop: contentStyle.paddingTop,
        paddingRight: contentStyle.paddingRight,
        paddingBottom: contentStyle.paddingBottom,
        paddingLeft: contentStyle.paddingLeft,
      } : null,
      dateCells,
      today: todayCellBounds && todayCellStyle ? {
        width: todayCellBounds.width,
        height: todayCellBounds.height,
        background: todayCellStyle.backgroundColor,
      } : null,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
    }
  })

  const assertGrid = (metrics: Awaited<ReturnType<typeof inspectGrid>>) => {
    const { cells, borders } = metrics
    expect(cells.length).toBeGreaterThanOrEqual(28)
    expect(cells.length).toBeLessThanOrEqual(42)
    expect(cells.length % 7).toBe(0)
    expect(metrics.horizontalOverflow).toBe(false)
    expect(borders).toHaveLength(cells.length)
    expect(metrics.dateCells).toHaveLength(cells.length)
    expect(metrics.weekdayGap).toBeGreaterThanOrEqual(10)
    expect(metrics.weekdayGap).toBeLessThanOrEqual(14)
    expect(metrics.weekdayLabels).toHaveLength(7)
    expect(metrics.content).toMatchObject({ display: 'grid', paddingTop: '8px', paddingBottom: '8px' })

    const first = cells[0]!
    for (const [index, label] of metrics.weekdayLabels.entries()) {
      expect(Math.abs(label.x + label.width / 2 - (first.x + (index + 0.5) * first.width))).toBeLessThan(0.75)
    }
    for (const [index, cell] of cells.entries()) {
      const row = Math.floor(index / 7)
      const column = index % 7
      expect(Math.abs(cell.x - (first.x + column * first.width))).toBeLessThan(0.75)
      expect(Math.abs(cell.y - (first.y + row * first.height))).toBeLessThan(0.75)
      expect(Math.abs(cell.width - first.width)).toBeLessThan(0.1)
      expect(Math.abs(cell.height - first.height)).toBeLessThan(0.1)

      const border = borders[index]!
      expect(border.position).toBe('relative')
      expect(border.rightWidth).toBe('1px')
      expect(border.rightStyle).toBe('solid')
      expect(border.bottomWidth).toBe('1px')
      expect(border.bottomStyle).toBe('solid')
      expect(border.color).not.toBe('rgba(0, 0, 0, 0)')
      expect(border.topWidth).toBe(index < 7 ? '1px' : '0px')
      expect(border.topStyle).toBe(index < 7 ? 'solid' : 'none')
      expect(border.leftWidth).toBe(index % 7 === 0 ? '1px' : '0px')
      expect(border.leftStyle).toBe(index % 7 === 0 ? 'solid' : 'none')
      expect(border.topLeftRadius).toBe(index === 0 ? '12px' : '0px')
      expect(border.topRightRadius).toBe(index === 6 ? '12px' : '0px')
      expect(border.bottomLeftRadius).toBe(index === cells.length - 7 ? '12px' : '0px')
      expect(border.bottomRightRadius).toBe(index === cells.length - 1 ? '12px' : '0px')

      const day = metrics.dateCells[index]!
      expect(day).not.toBeNull()
      expect(day!.lunarText.length).toBeGreaterThan(0)
      expect(day!.gregorianText).toBe(String(Number(day!.date.slice(-2))))
      expect(day!.lunar.x).toBeGreaterThanOrEqual(day!.cell.x)
      expect(day!.lunar.right).toBeLessThanOrEqual(day!.gregorian.x)
      expect(Math.abs(day!.gregorian.right - (day!.cell.x + day!.cell.width - Number.parseFloat(metrics.content!.paddingRight)))).toBeLessThan(0.75)
      expect(day!.number.y).toBeLessThan(day!.cell.y + day!.cell.height / 2)
      expect(Math.abs(day!.markerSlot.x + day!.markerSlot.width / 2 - (day!.cell.x + day!.cell.width / 2))).toBeLessThan(0.75)
      if (day!.marker) {
        expect(day!.marker.bottom).toBeLessThanOrEqual(day!.cell.y + day!.cell.height - 8)
        expect(Math.abs(day!.marker.x + day!.marker.width / 2 - (day!.cell.x + day!.cell.width / 2))).toBeLessThan(0.75)
      }
    }

    if (metrics.today) {
      expect(metrics.today.width).toBeCloseTo(first.width, 2)
      expect(metrics.today.height).toBeCloseTo(first.height, 2)
      expect(metrics.today.background).not.toBe('rgba(0, 0, 0, 0)')
    }
  }

  const originalTheme = await page.locator('html').getAttribute('data-theme')
  const setTheme = async (theme: 'light' | 'dark') => {
    if (await page.locator('html').getAttribute('data-theme') !== theme) {
      await page.locator('.theme-toggle').click()
    }
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  }

  await page.getByTestId('diary-view-mode-diary').click()
  await expect(page.getByTestId('diary-view-mode-diary')).toHaveAttribute('aria-pressed', 'true')
  await setTheme('light')
  const lunarDateCell = calendar.locator('.life-date[data-date="2026-11-16"]')
  const lunarTrigger = lunarDateCell.locator('.life-date-lunar')
  const lunarPopover = page.locator('#diary-lunar-calendar-popover')
  await expect(lunarPopover).toHaveCount(0)
  await calendar.locator('.life-date[data-date="2026-11-17"]').hover()
  await expect(lunarPopover).toHaveCount(0)
  await lunarTrigger.hover()
  await page.clock.runFor(350)
  await expect(lunarPopover).toHaveCount(0)
  await expect(lunarTrigger).toHaveCSS('cursor', 'pointer')
  await lunarTrigger.click()
  await expect(lunarPopover).toBeVisible()
  await expect(lunarTrigger).toHaveAttribute('aria-expanded', 'true')
  await expect(lunarTrigger).toHaveAttribute('aria-controls', 'diary-lunar-calendar-popover')
  await expect(page.getByRole('button', { name: '关闭日记' })).toHaveCount(0)
  expect(await lunarPopover.evaluate(element => getComputedStyle(element.parentElement!).backgroundColor))
    .toBe('rgb(249, 250, 251)')
  expect(await lunarPopover.evaluate(element => getComputedStyle(element.closest('.n-popover')!).boxShadow))
    .toBe('none')
  await expect(lunarPopover.locator('.lunar-calendar-popover-ganzhi')).toHaveText('丙午年 己亥月 甲午日')
  await expect(lunarPopover.locator('.lunar-calendar-popover-date')).toHaveText('农历 十月初八日')
  await expect(lunarPopover.locator('.lunar-calendar-time-item')).toHaveCount(12)
  expect(await lunarPopover.locator('.lunar-calendar-time-grid').evaluate(element => {
    const style = getComputedStyle(element)
    return {
      columns: style.gridTemplateColumns.trim().split(/\s+/).length,
      rows: style.gridTemplateRows.trim().split(/\s+/).length,
    }
  })).toEqual({ columns: 3, rows: 4 })
  await expect(lunarPopover.locator('[data-time-pillar="zi"] .lunar-calendar-time-ganzhi')).toHaveText('甲子')
  await expect(lunarPopover.locator('[data-time-pillar="zi"] .lunar-calendar-time-range')).toHaveText('23:00–01:00')
  await expect(lunarPopover.locator('.is-current-time')).toHaveCount(1)
  await expect(lunarPopover.locator('.is-current-time')).toHaveAttribute('data-time-pillar', 'wu')
  await expect(lunarPopover.locator('img, svg')).toHaveCount(0)
  await expect(lunarPopover).not.toContainText(/生肖|马|🐎/)
  expect(await lunarPopover.evaluate(element => element.closest('.n-popover')!.getBoundingClientRect().width)).toBe(340)

  for (const width of [320, 390, 430, 768, 1280]) {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 900 })
    await expect(lunarPopover).toBeVisible()
    const bounds = await lunarPopover.evaluate(element => {
      const rect = element.closest('.n-popover')!.getBoundingClientRect()
      return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width }
    })
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.y).toBeGreaterThanOrEqual(0)
    expect(bounds.right).toBeLessThanOrEqual(width)
    expect(bounds.bottom).toBeLessThanOrEqual(width < 600 ? 844 : 900)
    if ([390, 768, 1280].includes(width)) {
      await testInfo.attach(`lunar-calendar-popover-${width}.png`, {
        body: await page.screenshot(),
        contentType: 'image/png',
      })
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 })

  await lunarTrigger.click()
  await expect(lunarPopover).toHaveCount(0)

  await lunarTrigger.focus()
  await page.keyboard.press('Enter')
  await expect(lunarPopover).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(lunarPopover).toHaveCount(0)
  await expect(lunarTrigger).toBeFocused()
  await page.keyboard.press('Space')
  await expect(lunarPopover).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(lunarPopover).toHaveCount(0)

  await lunarTrigger.click()
  const nextLunarTrigger = calendar.locator('.life-date[data-date="2026-11-17"] .life-date-lunar')
  await nextLunarTrigger.click()
  await expect(lunarPopover).toBeVisible()
  await expect(lunarPopover.locator('.lunar-calendar-popover-ganzhi')).toContainText('乙未日')
  await expect(lunarPopover.locator('.is-current-time')).toHaveCount(0)
  await page.getByTestId('diary-view-mode-events').evaluate(button => (button as HTMLButtonElement).click())
  await expect(page.getByTestId('diary-view-mode-events')).toHaveAttribute('aria-pressed', 'true')
  await expect(lunarPopover).toHaveCount(0)
  await page.getByTestId('diary-view-mode-diary').click()

  await lunarTrigger.click()
  await expect(lunarPopover).toBeVisible()
  const monthBeforePopoverDismissal = await monthLabel.getAttribute('data-month')
  await calendar.locator('.n-calendar-header__extra .n-button:last-child').evaluate(button => (button as HTMLButtonElement).click())
  await expect(monthLabel).not.toHaveAttribute('data-month', monthBeforePopoverDismissal ?? '')
  await expect(lunarPopover).toHaveCount(0)
  await calendar.locator('.n-calendar-header__extra .n-button:first-child').evaluate(button => (button as HTMLButtonElement).click())
  await setTheme('dark')
  await lunarTrigger.click()
  await expect(lunarPopover).toBeVisible()
  expect(await lunarPopover.evaluate(element => getComputedStyle(element.parentElement!).backgroundColor))
    .toBe('rgb(37, 37, 38)')
  await calendar.locator('.life-date[data-date="2026-11-17"] .life-date-action').click()
  await expect(lunarPopover).toHaveCount(0)
  await expect(page.getByRole('button', { name: '关闭日记' })).toBeVisible()
  await page.getByRole('button', { name: '关闭日记' }).click()
  await setTheme('light')

  expect((await inspectGrid()).today).not.toBeNull()
  await page.getByTestId('diary-view-mode-events').click()
  const birthdayMarker = calendar.locator('.life-date[data-date="2026-11-15"] .life-event-marker')
  await expect(birthdayMarker).toBeVisible()
  await page.setViewportSize({ width: 1280, height: 900 })
  const initialMetrics = await inspectGrid()
  assertGrid(initialMetrics)
  const birthdayLayout = initialMetrics.dateCells.find(day => day?.date === '2026-11-15')!
  const todayLayout = initialMetrics.dateCells.find(day => day?.date === '2026-11-16')!
  expect(birthdayLayout.marker).not.toBeNull()
  expect(Math.abs(
    (birthdayLayout.number.y - birthdayLayout.cell.y) - (todayLayout.number.y - todayLayout.cell.y),
  )).toBeLessThan(0.75)
  const hoverDate = calendar.locator('.life-date[data-date="2026-11-17"]')
  const beforeHover = await hoverDate.locator('.life-date-badge').evaluate(element => {
    const highlight = getComputedStyle(element, '::before')
    const gridLine = getComputedStyle(element.closest('.n-calendar-cell')!, '::before')
    return { background: highlight.backgroundColor, border: gridLine.borderRightColor }
  })
  await hoverDate.hover()
  const afterHover = await hoverDate.locator('.life-date-badge').evaluate(element => {
    const highlight = getComputedStyle(element, '::before')
    const gridLine = getComputedStyle(element.closest('.n-calendar-cell')!, '::before')
    return { background: highlight.backgroundColor, border: gridLine.borderRightColor }
  })
  expect(afterHover.background).not.toBe(beforeHover.background)
  expect(afterHover.border).toBe(beforeHover.border)
  await page.getByTestId('diary-view-mode-diary').click()
  await calendar.locator('.life-date.today').click()
  await expect(page.getByRole('button', { name: '关闭日记' })).toBeVisible()
  expect(await calendar.locator('.life-date.today').evaluate(button => getComputedStyle(button.closest('.n-calendar-cell')!).backgroundColor))
    .not.toBe('rgba(0, 0, 0, 0)')
  await page.getByRole('button', { name: '关闭日记' }).click()

  const rowCounts = new Set<number>()
  for (let index = 0; index < 12; index += 1) {
    const monthBefore = await monthLabel.getAttribute('data-month')
    await calendar.locator('.n-calendar-header__extra .n-button:last-child').click()
    await expect(monthLabel).not.toHaveAttribute('data-month', monthBefore ?? '')
    const metrics = await inspectGrid()
    assertGrid(metrics)
    rowCounts.add(metrics.cells.length / 7)
  }
  expect(rowCounts.size).toBeGreaterThanOrEqual(2)

  const geometryByWidth = new Map<number, number[]>()
  const themeColors = new Map<'light' | 'dark', string>()
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(theme)
    for (const width of [320, 390, 430, 768, 1280]) {
      await page.setViewportSize({ width, height: width < 600 ? 844 : 900 })
      for (const view of ['diary', 'events', 'tasks'] as const) {
        const modeButton = page.getByTestId(`diary-view-mode-${view}`)
        await modeButton.click()
        await expect(modeButton).toHaveAttribute('aria-pressed', 'true')

        const metrics = await inspectGrid()
        assertGrid(metrics)
        expect(metrics.grid.height).toBe(width <= 600 ? 408 : 480)
        const geometry = [metrics.grid.width, metrics.grid.height, metrics.cells.length,
          metrics.cells[0]!.x, metrics.cells[0]!.y, metrics.cells[0]!.width, metrics.cells[0]!.height]
          .map(value => Math.round(value * 100) / 100)
        const baseline = geometryByWidth.get(width)
        if (baseline) expect(geometry).toEqual(baseline)
        else geometryByWidth.set(width, geometry)

        themeColors.set(theme, metrics.borders[0]!.color)
      }
    }
  }
  expect(themeColors.get('light')).not.toBe(themeColors.get('dark'))

  await setTheme(originalTheme === 'dark' ? 'dark' : 'light')
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.getByTestId('diary-view-mode-diary').click()
  const monthBefore = await monthLabel.getAttribute('data-month')
  await calendar.locator('.n-calendar-header__extra .n-button:last-child').click()
  await expect(monthLabel).not.toHaveAttribute('data-month', monthBefore ?? '')
  assertGrid(await inspectGrid())
})
