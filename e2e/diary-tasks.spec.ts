import { test, expect } from './fixtures/auth'
import { chooseDiaryAction, unlockDiary } from './helpers/diary-life'

const fixtureYear = 1900 + Math.floor(Math.random() * 100)
let testYear = fixtureYear

test.beforeEach(async ({ page }, testInfo) => {
  testYear = fixtureYear + testInfo.repeatEachIndex * (testInfo.project.retries + 1) + testInfo.retry
  await page.clock.install({ time: new Date(testYear, 10, 16, 12) })
})

test('creates a dated task, completes it, restores it, and moves it to a new calendar date', async ({ page }) => {
  await page.goto('/diary')
  await unlockDiary(page)
  await page.getByTestId('diary-view-toggle').click()

  const date = `${testYear}-11-16`
  const nextDate = `${testYear}-11-19`
  const cell = page.locator(`.diary-life-calendar [data-date="${date}"]`)
  await expect(cell).toBeVisible()
  await cell.click()
  await chooseDiaryAction(page, page.getByRole('button', { name: '更多当天事件操作' }), '新增待办')

  const title = `Phase 3 day task ${Math.random().toString(36).slice(2, 9)}`
  const editor = page.locator('.diary-task-edit-dialog')
  await expect(editor).toBeVisible()
  const titleInput = page.getByRole('textbox', { name: '待办名称' })
  await expect(titleInput).toBeFocused()
  await titleInput.fill(title)
  await page.getByLabel('截止日期').fill(date)
  await page.getByRole('button', { name: '保存', exact: true }).click()

  const complete = page.getByRole('checkbox', { name: `完成待办：${title}`, exact: true })
  await expect(complete).toBeVisible()
  const marker = cell.locator('.life-task-marker')
  await expect(marker).toBeVisible()
  await expect(marker).toHaveAttribute('src', '/emoji/alarm-clock-animated.png')
  await expect(marker).toHaveJSProperty('naturalWidth', 256)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(marker).toHaveAttribute('src', '/emoji/alarm-clock.svg')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await expect(marker).toHaveAttribute('src', '/emoji/alarm-clock-animated.png')

  const secondTitle = `${title} second`
  await chooseDiaryAction(page, page.getByRole('button', { name: '更多当天事件操作' }), '新增待办')
  await page.getByRole('textbox', { name: '待办名称' }).fill(secondTitle)
  await page.getByLabel('截止日期').fill(date)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: `完成待办：${secondTitle}` })).toBeVisible()
  await expect(marker).toHaveCount(1)

  const originalViewport = page.viewportSize()
  for (const width of [320, 390, 430, 768, 1280]) {
    await page.setViewportSize({ width, height: originalViewport?.height ?? 900 })
    const bounds = await marker.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.width).toBeGreaterThan(0)
    expect(bounds!.width).toBeLessThanOrEqual(21)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  if (originalViewport) await page.setViewportSize(originalViewport)

  await page.getByRole('button', { name: `编辑待办：${secondTitle}`, exact: true }).click()
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await page.getByRole('dialog', { name: '删除这条待办？' }).getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
  await expect(marker).toHaveCount(1)

  await complete.click()
  await expect(page.locator('.diary-task-row.is-completed')).toContainText(title)
  await expect(marker).toHaveCount(0)

  await page.getByRole('checkbox', { name: `恢复待办：${title}`, exact: true }).click()
  await expect(page.getByRole('checkbox', { name: `完成待办：${title}`, exact: true })).toBeVisible()
  await expect(marker).toBeVisible()

  await page.getByRole('button', { name: `编辑待办：${title}`, exact: true }).click()
  await page.getByRole('textbox', { name: '待办名称' }).fill(`${title} 草稿`)
  await page.route('**/api/diary/life/tasks/*', route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 409, json: { code: 'diary-conflict' } })
    : route.continue())
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('当前草稿已保留')
  await expect(page.getByRole('textbox', { name: '待办名称' })).toHaveValue(`${title} 草稿`)
  await page.getByRole('button', { name: '重新加载' }).click()
  await expect(page.getByRole('textbox', { name: '待办名称' })).toHaveValue(title)
  await page.unroute('**/api/diary/life/tasks/*')
  await page.getByRole('button', { name: '取消', exact: true }).click()

  for (const viewport of [
    { width: 320, height: 720 },
    { width: 390, height: 844 },
    { width: 430, height: 900 },
    { width: 768, height: 1024 },
    { width: 1280, height: 900 },
  ]) {
    await page.setViewportSize(viewport)
    await page.getByRole('button', { name: `编辑待办：${title}`, exact: true }).click()
    const form = page.locator('.diary-task-edit-dialog')
    const bounds = await form.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await expect(form).toBeHidden()
  }

  await page.getByRole('button', { name: `编辑待办：${title}`, exact: true }).click()
  await expect(editor).toBeVisible()
  await page.getByLabel('截止日期').fill(nextDate)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: `完成待办：${title}`, exact: true })).toHaveCount(0)
  const nextCell = page.locator(`.diary-life-calendar [data-date="${nextDate}"]`)
  await expect(nextCell.locator('.life-task-marker')).toBeVisible()
  await page.getByRole('button', { name: '关闭当天事件' }).click()
  await nextCell.click()
  await expect(nextCell.locator('.life-task-marker')).toHaveAttribute('src', '/emoji/stopwatch.svg')
  await page.getByRole('button', { name: `编辑待办：${title}`, exact: true }).click()
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await page.getByRole('dialog', { name: '删除这条待办？' }).getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
  await expect(nextCell.locator('.life-task-marker')).toHaveCount(0)
})

test('starts a new recurring task on its explicit start date and ignores hidden one-off time validation', async ({ page }) => {
  await page.goto('/diary')
  await unlockDiary(page)
  await page.getByTestId('diary-view-toggle').click()

  const selectedDate = `${testYear}-11-16`
  const startDate = `${testYear}-11-18`
  const title = `Start date recurrence ${Math.random().toString(36).slice(2, 8)}`
  const calendar = page.locator('.diary-life-calendar')
  const selectedCell = calendar.locator(`[data-date="${selectedDate}"]`)
  const startCell = calendar.locator(`[data-date="${startDate}"]`)
  await selectedCell.click()
  await chooseDiaryAction(page, page.getByRole('button', { name: '更多当天事件操作' }), '新增待办')

  const editor = page.locator('.diary-task-edit-dialog')
  await page.getByRole('textbox', { name: '待办名称' }).fill(title)
  await page.getByLabel('开始日期').fill(startDate)
  await page.getByLabel('开始时间').fill('09:00')
  await expect(editor.getByRole('alert')).toContainText('开始日期不能晚于截止日期')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(editor.locator('.diary-event-form-error')).toContainText('请检查开始和截止时间设置')
  await page.getByLabel('重复规则').selectOption('daily')
  await expect(page.getByLabel('开始日期')).toHaveValue(startDate)
  await page.getByRole('button', { name: '保存', exact: true }).click()

  await expect(editor).toBeHidden()
  await expect(selectedCell.locator('.life-task-marker')).toHaveCount(0)
  await expect(startCell.locator('.life-task-marker')).toBeVisible()
  await page.getByRole('button', { name: '关闭当天事件' }).click()
  await startCell.click()
  await expect(page.getByRole('checkbox', { name: `完成待办：${title}` })).toBeVisible()
  await expect(page.locator('.diary-task-title').filter({ hasText: title })).toContainText('↻')
  await page.getByRole('button', { name: `编辑待办：${title}` }).click()
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await page.getByRole('dialog', { name: '删除整个重复任务及已记录的完成、跳过状态？' })
    .getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
  await expect(startCell.locator('.life-task-marker')).toHaveCount(0)
})

test('lays out an Event, event count and deadline icon within one calendar date on all viewport sizes', async ({ page }) => {
  await page.goto('/diary')
  await unlockDiary(page)
  const date = `${testYear}-11-16`
  const event = (id: string, title: string, type: 'birthday' | 'schedule', isPrimary = false) => ({
    id,
    title,
    description: '',
    emoji: type === 'birthday' ? '🎂' : '💼',
    type,
    startDate: date,
    endDate: date,
    startTime: null,
    endTime: null,
    allDay: true,
    recurrence: 'none',
    showCountdown: false,
    isPrimary,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  })
  await page.route('**/api/diary/life/**', async route => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname
    if (request.method() === 'GET' && pathname === '/api/diary/life/events') {
      await route.fulfill({ json: { items: [
        event('birthday', '生日', 'birthday', true),
        event('schedule-1', '日程一', 'schedule'),
        event('schedule-2', '日程二', 'schedule'),
      ], next: null } })
      return
    }
    if (request.method() === 'GET' && pathname === '/api/diary/life/task-occurrences') {
      await route.fulfill({ json: { items: [{
        id: 'deadline-task',
        title: '临期待办',
        description: '',
        startDate: null,
        startTime: null,
        dueDate: date,
        dueTime: null,
        completedAt: null,
        version: 1,
        createdAt: 1,
        updatedAt: 1,
      }], nextCursor: null } })
      return
    }
    await route.continue()
  })

  await page.getByTestId('diary-view-toggle').click()
  const calendar = page.locator('.diary-life-calendar')
  const cell = calendar.locator(`[data-date="${date}"]`)
  const marker = cell.locator('.life-marker')
  await expect(marker.locator('.life-event-marker')).toHaveAttribute('src', '/emoji/event-birthday.svg')
  await expect(marker.locator('.life-task-marker')).toHaveAttribute('src', '/emoji/alarm-clock-animated.png')
  await expect(marker.locator('small')).toHaveText('+2')

  const originalViewport = page.viewportSize()
  for (const width of [320, 390, 430, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    const cellBounds = await cell.boundingBox()
    const eventBounds = await marker.locator('.life-event-marker').boundingBox()
    const taskBounds = await marker.locator('.life-task-marker').boundingBox()
    expect(cellBounds).not.toBeNull()
    expect(eventBounds).not.toBeNull()
    expect(taskBounds).not.toBeNull()
    expect(eventBounds!.width).toBe(width <= 420 ? 16 : 19)
    expect(eventBounds!.height).toBe(width <= 420 ? 16 : 19)
    expect(taskBounds!.width).toBe(width <= 420 ? 18 : 21)
    expect(taskBounds!.height).toBe(width <= 420 ? 18 : 21)
    expect(eventBounds!.x).toBeGreaterThanOrEqual(cellBounds!.x)
    expect(taskBounds!.x + taskBounds!.width).toBeLessThanOrEqual(cellBounds!.x + cellBounds!.width + 1)
    expect(eventBounds!.x + eventBounds!.width).toBeLessThanOrEqual(taskBounds!.x)
    expect(Math.abs((eventBounds!.y + eventBounds!.height / 2) - (taskBounds!.y + taskBounds!.height / 2))).toBeLessThanOrEqual(1)
    if (width <= 420) await expect(marker.locator('small')).toBeHidden()
    else await expect(marker.locator('small')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  if (originalViewport) await page.setViewportSize(originalViewport)
})

test('uses the static Alarm Clock when reduced motion is enabled', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/diary')
  await unlockDiary(page)
  await page.getByTestId('diary-view-toggle').click()

  const date = `${testYear}-11-16`
  const cell = page.locator(`.diary-life-calendar [data-date="${date}"]`)
  await cell.click()
  await chooseDiaryAction(page, page.getByRole('button', { name: '更多当天事件操作' }), '新增待办')
  const title = `Reduced motion ${Math.random().toString(36).slice(2, 8)}`
  await page.getByRole('textbox', { name: '待办名称' }).fill(title)
  await page.getByLabel('截止日期').fill(date)
  await page.getByRole('button', { name: '保存', exact: true }).click()

  const marker = cell.locator('.life-task-marker')
  await expect(marker).toBeVisible()
  await expect(marker).toHaveAttribute('src', '/emoji/alarm-clock.svg')
  await expect(marker).toHaveJSProperty('naturalWidth', 32)

  await page.getByRole('button', { name: `编辑待办：${title}` }).click()
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await page.getByRole('dialog', { name: '删除这条待办？' }).getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
  await expect(marker).toHaveCount(0)
})

test('keeps long task titles and due times aligned without horizontal overflow', async ({ page }) => {
  await page.goto('/diary')
  await unlockDiary(page)
  await page.getByTestId('diary-view-toggle').click()

  const date = `${testYear}-11-16`
  const cell = page.locator(`.diary-life-calendar [data-date="${date}"]`)
  await expect(cell).toBeVisible()
  await cell.click()
  await chooseDiaryAction(page, page.getByRole('button', { name: '更多当天事件操作' }), '新增待办')

  const title = `周末需要完成的综合项目${Math.random().toString(36).slice(2, 8)}`.repeat(8)
  await page.getByRole('textbox', { name: '待办名称' }).fill(title)
  await page.getByLabel('截止日期').fill(date)
  await page.getByLabel('截止时间').fill('12:00')
  await page.getByRole('button', { name: '保存', exact: true }).click()

  const row = page.locator('.diary-life-dialog .diary-task-row').filter({ has: page.locator('.diary-task-title', { hasText: title }) })
  await expect(row).toBeVisible()
  await expect(row).toHaveClass(/diary-cloud-card/)
  await expect(row.locator('.diary-task-detail')).toHaveText('截止 12:00')
  expect(await row.evaluate(element => getComputedStyle(element).backgroundImage)).toContain('/diary-events-cloud-pattern.png')

  for (const viewport of [
    { width: 320, height: 720 },
    { width: 390, height: 844 },
    { width: 430, height: 900 },
    { width: 768, height: 1024 },
    { width: 1280, height: 900 },
  ]) {
    await page.setViewportSize(viewport)
    const layout = await row.evaluate(element => {
      const titleElement = element.querySelector<HTMLElement>('.diary-task-title')!
      const detailElement = element.querySelector<HTMLElement>('.diary-task-detail')!
      const titleBounds = titleElement.getBoundingClientRect()
      const detailBounds = detailElement.getBoundingClientRect()
      return {
        titleFits: titleElement.scrollWidth <= titleElement.clientWidth + 1,
        titleEndsBeforeDetail: titleBounds.right <= detailBounds.left + 1,
        detailFitsInRow: detailBounds.right <= element.getBoundingClientRect().right + 1,
      }
    })
    expect(layout.titleFits).toBe(true)
    expect(layout.titleEndsBeforeDetail).toBe(true)
    expect(layout.detailFitsInRow).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }

  await page.getByRole('button', { name: `编辑待办：${title}` }).click()
  await page.getByRole('button', { name: '删除', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: '删除这条待办？' })
  await confirmation.getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
  await expect(row).toHaveCount(0)
})

test('shows a cross-day Todo only on its due date and keeps its start plan in Recent Items', async ({ page }) => {
  await page.goto('/diary')
  await unlockDiary(page)
  await page.getByTestId('diary-view-toggle').click()

  const startDate = `${testYear}-11-19`
  const middleDate = `${testYear}-11-20`
  const dueDate = `${testYear}-11-21`
  const title = `Cross-day task ${Math.random().toString(36).slice(2, 9)}`
  const startCell = page.locator(`.diary-life-calendar [data-date="${startDate}"]`)
  const middleCell = page.locator(`.diary-life-calendar [data-date="${middleDate}"]`)
  const dueCell = page.locator(`.diary-life-calendar [data-date="${dueDate}"]`)
  await startCell.click()
  await chooseDiaryAction(page, page.getByRole('button', { name: '更多当天事件操作' }), '新增待办')

  await page.getByRole('textbox', { name: '待办名称' }).fill(title)
  await expect(page.getByLabel('开始日期')).toHaveValue('')
  await expect(page.getByLabel('截止日期')).toHaveValue(startDate)
  await page.getByLabel('开始日期').fill(startDate)
  await page.getByLabel('开始时间').fill('09:00')
  await page.getByLabel('截止日期').fill(dueDate)
  await page.getByLabel('截止时间').fill('12:00')

  for (const viewport of [
    { width: 320, height: 720 },
    { width: 390, height: 844 },
    { width: 430, height: 900 },
    { width: 768, height: 1024 },
    { width: 1280, height: 900 },
  ]) {
    await page.setViewportSize(viewport)
    const inputBounds = await page.locator('.diary-task-form-time-groups').evaluate(container => {
      const selectors = [
        '.diary-task-form-time-group:nth-child(1) input[aria-label="开始日期"]',
        '.diary-task-form-time-group:nth-child(1) input[aria-label="开始时间"]',
        '.diary-task-form-time-group:nth-child(2) input[aria-label="截止日期"]',
        '.diary-task-form-time-group:nth-child(2) input[aria-label="截止时间"]',
      ]
      return selectors.map(selector => {
        const input = container.querySelector<HTMLElement>(selector)!
        const bounds = input.getBoundingClientRect()
        return { left: bounds.left, right: bounds.right }
      })
    })
    expect(inputBounds[0]!.right).toBeLessThanOrEqual(inputBounds[1]!.left + 1)
    expect(inputBounds[2]!.right).toBeLessThanOrEqual(inputBounds[3]!.left + 1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.getByRole('button', { name: '保存', exact: true }).click()

  await expect(startCell.locator('.life-task-marker')).toHaveCount(0)
  await page.getByRole('button', { name: '关闭当天事件' }).click()
  await middleCell.click()
  await expect(middleCell.locator('.life-task-marker')).toHaveCount(0)
  await page.getByRole('button', { name: '关闭当天事件' }).click()
  await dueCell.click()
  const checkbox = page.getByRole('checkbox', { name: `完成待办：${title}` })
  await expect(checkbox).toBeVisible()
  await expect(dueCell.locator('.life-task-marker')).toBeVisible()
  await checkbox.click()
  await expect(dueCell.locator('.life-task-marker')).toHaveCount(0)

  await page.getByRole('button', { name: '关闭当天事件' }).click()
  await page.getByTestId('diary-event-list-toggle').click()
  await page.getByRole('button', { name: '查看已完成' }).click()
  const completedRow = page.getByRole('button', { name: `编辑待办：${title}` })
  await expect(completedRow).toContainText('11月21日')
  await completedRow.click()
  await expect(page.getByLabel('开始日期')).toHaveValue(startDate)
  await expect(page.getByLabel('开始时间')).toHaveValue('09:00')
  await expect(page.getByLabel('截止日期')).toHaveValue(dueDate)
  await expect(page.getByLabel('截止时间')).toHaveValue('12:00')
  await page.getByRole('button', { name: '删除', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: '删除这条待办？' })
  await confirmation.getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()

  const startOnlyTitle = `Start-only task ${Math.random().toString(36).slice(2, 9)}`
  await page.getByRole('button', { name: '新增待办' }).click()
  await page.getByRole('textbox', { name: '待办名称' }).fill(startOnlyTitle)
  await page.getByLabel('开始日期').fill(startDate)
  await page.getByLabel('开始时间').fill('09:00')
  await expect(page.getByLabel('截止日期')).toHaveValue('')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  const startOnlyRow = page.getByRole('button', { name: `编辑待办：${startOnlyTitle}` })
  await expect(startOnlyRow).toBeVisible()
  await expect(startOnlyRow).toContainText('11月19日开始 09:00')
  await startOnlyRow.click()
  await expect(page.getByLabel('开始日期')).toHaveValue(startDate)
  await expect(page.getByLabel('截止日期')).toHaveValue('')
  await page.getByRole('button', { name: '删除', exact: true }).click()
  const startOnlyConfirmation = page.getByRole('dialog', { name: '删除这条待办？' })
  await startOnlyConfirmation.getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
})

test('creates an undated task from Recent Items and separates completed tasks', async ({ page }) => {
  await page.goto('/diary')
  await unlockDiary(page)
  await page.getByTestId('diary-event-list-toggle').click()
  const list = page.locator('.diary-event-list-dialog')
  await expect(list).toBeVisible()
  await page.getByRole('button', { name: '新增待办' }).click()

  const title = `Phase 3 undated task ${Math.random().toString(36).slice(2, 9)}`
  const editor = page.locator('.diary-task-edit-dialog')
  await expect(editor).toBeVisible()
  await page.getByRole('textbox', { name: '待办名称' }).fill(title)
  await expect(page.getByLabel('截止日期')).toHaveValue('')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  const complete = page.getByRole('checkbox', { name: `完成待办：${title}` })
  await expect(complete).toBeVisible()
  await expect(page.getByRole('button', { name: `编辑待办：${title}` })).toContainText('无日期')

  await complete.click()
  await expect(page.getByRole('checkbox', { name: `完成待办：${title}` })).toHaveCount(0)
  await page.getByRole('button', { name: '查看已完成' }).click()
  await expect(page.getByRole('checkbox', { name: `恢复待办：${title}` })).toBeVisible()
  await page.getByRole('checkbox', { name: `恢复待办：${title}` }).click()
  await expect(page.getByRole('checkbox', { name: `完成待办：${title}` })).toBeVisible()
  await expect(list.locator('.diary-list-section-header h3')).toHaveText('待办事项')

  await page.getByRole('button', { name: `编辑待办：${title}` }).click()
  await expect(editor).toBeVisible()
  await page.getByRole('button', { name: '删除', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: '删除这条待办？' })
  await confirmation.getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
  await expect(page.getByRole('checkbox', { name: `完成待办：${title}` })).toHaveCount(0)
})

test('a failed calendar Todo request preserves birthday Events and retries only Todos', async ({ page }) => {
  await page.goto('/diary')
  await unlockDiary(page)
  const date = `${testYear}-11-16`
  const event = {
    id: 'e3000000-0000-4000-8000-000000000001',
    title: '独立加载的生日事件',
    description: '',
    emoji: '🎂',
    type: 'birthday',
    startDate: date,
    endDate: date,
    startTime: null,
    endTime: null,
    allDay: true,
    dateRule: { calendar: 'gregory' },
    recurrence: 'none',
    showCountdown: false,
    isPrimary: false,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  }
  let eventRequests = 0
  let taskRequests = 0
  let releaseTaskFailure!: () => void
  const taskFailureGate = new Promise<void>(resolve => { releaseTaskFailure = resolve })
  await page.route('**/api/diary/life/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'GET' && url.pathname === '/api/diary/life/events') {
      eventRequests += 1
      await route.fulfill({ json: { items: [event], next: null } })
      return
    }
    if (request.method() === 'GET' && url.pathname === '/api/diary/life/task-occurrences') {
      taskRequests += 1
      if (taskRequests === 1) {
        await taskFailureGate
        await route.fulfill({ status: 503, json: { code: 'diary-unavailable' } })
      }
      else await route.fulfill({ json: { items: [], nextCursor: null } })
      return
    }
    await route.continue()
  })

  try {
    await page.getByTestId('diary-view-toggle').click()
    const cell = page.locator(`.diary-life-calendar [data-date="${date}"]`)
    await expect.poll(() => taskRequests).toBe(1)
    await expect(cell.locator('.life-marker img')).toHaveAttribute('src', '/emoji/event-birthday.svg')
    await cell.click()
    const dayDialog = page.locator('.diary-life-dialog')
    await expect(dayDialog.locator(`[data-event-id="${event.id}"]`)).toBeVisible()
    await expect(dayDialog.locator('.day-tasks [role="status"]')).toBeVisible()

    releaseTaskFailure()
    const taskError = dayDialog.locator('.day-tasks [role="alert"]')
    await expect(taskError).toContainText('待办加载失败')
    await taskError.getByRole('button', { name: '重试' }).click()
    await expect(taskError).toHaveCount(0)
    await expect(dayDialog.locator(`[data-event-id="${event.id}"]`)).toBeVisible()
    expect(eventRequests).toBe(1)
    expect(taskRequests).toBe(2)
  } finally {
    releaseTaskFailure()
  }
})

test('a failed calendar Event request preserves interactive Todos and retries only Events', async ({ page }) => {
  await page.goto('/diary')
  await unlockDiary(page)
  const date = `${testYear}-11-16`
  const taskId = 'e3000000-0000-4000-8000-000000000002'
  let completedAt: number | null = null
  let taskVersion = 1
  let eventRequests = 0
  let taskRequests = 0
  let releaseEventFailure!: () => void
  const eventFailureGate = new Promise<void>(resolve => { releaseEventFailure = resolve })
  await page.route('**/api/diary/life/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'GET' && url.pathname === '/api/diary/life/events') {
      eventRequests += 1
      if (eventRequests === 1) {
        await eventFailureGate
        await route.fulfill({ status: 503, json: { code: 'diary-unavailable' } })
      }
      else await route.fulfill({ json: { items: [], next: null } })
      return
    }
    if (request.method() === 'GET' && url.pathname === '/api/diary/life/task-occurrences') {
      taskRequests += 1
      await route.fulfill({ json: {
        items: [{ id: taskId, title: 'Events 失败时仍可勾选', description: '', startDate: null, startTime: null, dueDate: date, dueTime: null, completedAt, version: taskVersion, createdAt: 1, updatedAt: taskVersion }],
        nextCursor: null,
      } })
      return
    }
    if (request.method() === 'POST' && url.pathname === `/api/diary/life/tasks/${taskId}/complete`) {
      completedAt = Date.now()
      taskVersion += 1
      await route.fulfill({ json: { task: { id: taskId, title: 'Events 失败时仍可勾选', description: '', startDate: null, startTime: null, dueDate: date, dueTime: null, completedAt, version: taskVersion, createdAt: 1, updatedAt: taskVersion } } })
      return
    }
    await route.continue()
  })

  try {
    await page.getByTestId('diary-view-toggle').click()
    const cell = page.locator(`.diary-life-calendar [data-date="${date}"]`)
    await expect(cell.locator('.life-task-marker')).toBeVisible()
    await cell.click()
    const dayDialog = page.locator('.diary-life-dialog')
    const taskCheckbox = dayDialog.getByRole('checkbox', { name: '完成待办：Events 失败时仍可勾选' })
    await expect(taskCheckbox).toBeVisible()
    await expect(dayDialog.locator('.day-events [role="status"]')).toBeVisible()

    releaseEventFailure()
    const eventError = dayDialog.locator('.day-events [role="alert"]')
    await expect(eventError).toContainText('加载事件失败')
    await eventError.getByRole('button', { name: '重试' }).click()
    await expect(eventError).toHaveCount(0)
    await expect(taskCheckbox).toBeVisible()
    expect(eventRequests).toBe(2)
    expect(taskRequests).toBe(1)

    await taskCheckbox.click()
    await expect(dayDialog.locator('.diary-task-row.is-completed')).toContainText('Events 失败时仍可勾选')
    await expect(cell.locator('.life-task-marker')).toHaveCount(0)
    expect(eventRequests).toBe(2)
    expect(taskRequests).toBe(2)
  } finally {
    releaseEventFailure()
  }
})

test('a delayed Todo page from the previous month cannot replace current calendar markers', async ({ page }) => {
  await page.goto('/diary')
  await unlockDiary(page)
  const previousMonthTask = {
    id: 'e3000000-0000-4000-8000-000000000003',
    title: '旧月份待办',
    description: '',
    dueDate: `${testYear}-11-30`,
    dueTime: null,
    completedAt: null,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  }
  const currentMonthTask = {
    ...previousMonthTask,
    id: 'e3000000-0000-4000-8000-000000000004',
    title: '当前月份待办',
    dueDate: `${testYear}-12-05`,
  }
  let releasePreviousMonth!: () => void
  let finishPreviousMonth!: () => void
  const previousMonthGate = new Promise<void>(resolve => { releasePreviousMonth = resolve })
  const previousMonthFinished = new Promise<void>(resolve => { finishPreviousMonth = resolve })
  let taskRequests = 0
  await page.route('**/api/diary/life/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'GET' && url.pathname === '/api/diary/life/task-occurrences') {
      taskRequests += 1
      if (taskRequests === 1) {
        await previousMonthGate
        try { await route.fulfill({ json: { items: [previousMonthTask], nextCursor: null } }) } catch { /* The prior month request may already have been aborted. */ }
        finishPreviousMonth()
      } else {
        await route.fulfill({ json: { items: [currentMonthTask], nextCursor: null } })
      }
      return
    }
    await route.continue()
  })

  try {
    await page.getByTestId('diary-view-toggle').click()
    await expect.poll(() => taskRequests).toBe(1)
    const calendar = page.locator('.diary-life-calendar')
    const arrows = calendar.locator('.n-calendar-header').getByRole('button')
    await arrows.last().click()
    await expect(calendar.locator('.life-month-label')).toHaveText(`${testYear}-12`)
    const currentCell = calendar.locator(`[data-date="${currentMonthTask.dueDate}"]`)
    await expect(currentCell.locator('.life-task-marker')).toBeVisible()

    releasePreviousMonth()
    await previousMonthFinished
    await expect(calendar.locator(`[data-date="${previousMonthTask.dueDate}"] .life-task-marker`)).toHaveCount(0)
    await expect(currentCell.locator('.life-task-marker')).toBeVisible()
    expect(taskRequests).toBe(2)
  } finally {
    releasePreviousMonth()
  }
})

test('a Todo response from a locked Diary session cannot enter the next unlocked session', async ({ page }) => {
  await page.goto('/diary')
  await unlockDiary(page)
  const staleTask = {
    id: 'e3000000-0000-4000-8000-000000000005',
    title: '不应恢复的旧会话待办',
    description: '',
    dueDate: `${testYear}-11-28`,
    dueTime: null,
    completedAt: null,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  }
  const currentTask = {
    ...staleTask,
    id: 'e3000000-0000-4000-8000-000000000006',
    title: '当前会话待办',
    dueDate: `${testYear}-11-29`,
  }
  let releaseStale!: () => void
  let finishStale!: () => void
  let staleRequestStarted!: () => void
  const staleGate = new Promise<void>(resolve => { releaseStale = resolve })
  const staleFinished = new Promise<void>(resolve => { finishStale = resolve })
  const staleStarted = new Promise<void>(resolve => { staleRequestStarted = resolve })
  let taskRequests = 0
  await page.route('**/api/diary/life/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'GET' && url.pathname === '/api/diary/life/task-occurrences') {
      taskRequests += 1
      if (taskRequests === 1) {
        staleRequestStarted()
        await staleGate
        try { await route.fulfill({ json: { items: [staleTask], nextCursor: null } }) } catch { /* Locking aborts the old session request. */ }
        finishStale()
      } else {
        await route.fulfill({ json: { items: [currentTask], nextCursor: null } })
      }
      return
    }
    await route.continue()
  })

  try {
    await page.getByTestId('diary-view-toggle').click()
    await staleStarted
    await page.getByTestId('account-button').click()
    await page.getByTestId('account-lock-diary').click()
    const unlockButton = page.getByRole('button', { name: '解锁日记' })
    await expect(unlockButton).toBeVisible()
    await unlockButton.click()
    await unlockDiary(page)
    const calendar = page.locator('.diary-life-calendar')
    const currentCell = calendar.locator(`[data-date="${currentTask.dueDate}"]`)
    await expect(currentCell.locator('.life-task-marker')).toBeVisible()
    releaseStale()
    await staleFinished
    await expect(calendar.locator(`[data-date="${staleTask.dueDate}"] .life-task-marker`)).toHaveCount(0)
    await expect(currentCell.locator('.life-task-marker')).toBeVisible()
    expect(taskRequests).toBe(2)
    await expect(page.getByTestId('diary-task-edit-dialog')).toHaveCount(0)
  } finally {
    releaseStale()
  }
})

test('recurring Todo completion and skipping are scoped to one date', async ({ page }) => {
  await page.goto('/diary')
  await unlockDiary(page)
  await page.getByTestId('diary-view-toggle').click()

  const startDate = `${testYear}-11-16`
  const skippedDate = `${testYear}-11-17`
  const followingDate = `${testYear}-11-18`
  const stoppedAfterDate = `${testYear}-11-19`
  const title = `Daily task ${Math.random().toString(36).slice(2, 8)}`
  const calendar = page.locator('.diary-life-calendar')
  const startCell = calendar.locator(`[data-date="${startDate}"]`)
  await startCell.click()
  await chooseDiaryAction(page, page.getByRole('button', { name: '更多当天事件操作' }), '新增待办')

  const editor = page.locator('.diary-task-edit-dialog')
  await page.getByRole('textbox', { name: '待办名称' }).fill(title)
  await page.getByLabel('重复规则').selectOption('daily')
  await page.getByLabel('开始日期').fill(startDate)
  await page.getByRole('button', { name: '保存', exact: true }).click()

  await expect(page.getByRole('checkbox', { name: `完成待办：${title}` })).toBeVisible()
  await expect(page.locator('.diary-task-title').filter({ hasText: title })).toContainText('↻')
  await page.getByRole('checkbox', { name: `完成待办：${title}` }).click()
  await expect(page.locator('.diary-task-row.is-completed')).toContainText(title)
  await expect(startCell.locator('.life-task-marker')).toHaveCount(0)

  await page.getByRole('button', { name: '关闭当天事件' }).click()
  const skippedCell = calendar.locator(`[data-date="${skippedDate}"]`)
  await skippedCell.click()
  await expect(page.getByRole('checkbox', { name: `完成待办：${title}` })).toBeVisible()
  await page.getByRole('button', { name: `编辑待办：${title}` }).click()
  await expect(editor).toBeVisible()
  await expect(page.getByLabel('开始日期')).toBeDisabled()
  await expect(editor.getByRole('button', { name: '清除日期' })).toHaveCount(0)

  for (const viewport of [
    { width: 320, height: 720 },
    { width: 390, height: 844 },
    { width: 430, height: 900 },
    { width: 768, height: 1024 },
    { width: 1280, height: 900 },
  ]) {
    await page.setViewportSize(viewport)
    const bounds = await editor.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }

  await page.getByRole('button', { name: '跳过本次' }).click()
  await expect(page.locator('.diary-task-row.is-skipped')).toContainText('本次已跳过')
  await expect(page.locator('.diary-task-row.is-skipped')).not.toContainText('已逾期')
  await expect(skippedCell.locator('.life-task-marker')).toHaveCount(0)
  await page.getByRole('button', { name: '关闭当天事件' }).click()
  const followingCell = calendar.locator(`[data-date="${followingDate}"]`)
  await followingCell.click()
  await expect(page.getByRole('checkbox', { name: `完成待办：${title}` })).toBeVisible()
  await page.getByRole('button', { name: `编辑待办：${title}` }).click()
  await page.getByRole('button', { name: '结束重复' }).click()
  const stopConfirmation = page.getByRole('dialog', { name: '结束后续重复安排？当前这次和之前的记录会保留。' })
  await stopConfirmation.getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()

  await page.getByRole('button', { name: '关闭当天事件' }).click()
  const stoppedCell = calendar.locator(`[data-date="${stoppedAfterDate}"]`)
  await stoppedCell.click()
  await expect(page.getByRole('checkbox', { name: `完成待办：${title}` })).toHaveCount(0)

  await page.getByRole('button', { name: '关闭当天事件' }).click()
  await followingCell.click()
  await page.getByRole('button', { name: `编辑待办：${title}` }).click()
  await page.getByRole('button', { name: '删除', exact: true }).click()
  const deleteConfirmation = page.getByRole('dialog', { name: '删除整个重复任务及已记录的完成、跳过状态？' })
  await deleteConfirmation.getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
  await expect(followingCell.locator('.life-task-marker')).toHaveCount(0)
})

test('editing a recurring Todo changes future occurrences and preserves completed history', async ({ page }) => {
  await page.goto('/diary')
  await unlockDiary(page)
  await page.getByTestId('diary-view-toggle').click()

  const firstDate = `${testYear}-11-16`
  const effectiveDate = `${testYear}-11-17`
  const followingDate = `${testYear}-11-24`
  const title = `Series split ${Math.random().toString(36).slice(2, 9)}`
  const calendar = page.locator('.diary-life-calendar')
  const firstCell = calendar.locator(`[data-date="${firstDate}"]`)
  const effectiveCell = calendar.locator(`[data-date="${effectiveDate}"]`)
  const followingCell = calendar.locator(`[data-date="${followingDate}"]`)

  await firstCell.click()
  await chooseDiaryAction(page, page.getByRole('button', { name: '更多当天事件操作' }), '新增待办')
  await page.getByRole('textbox', { name: '待办名称' }).fill(title)
  await page.getByLabel('重复规则').selectOption('daily')
  await page.getByLabel('开始日期').fill(firstDate)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByRole('checkbox', { name: `完成待办：${title}` }).click()
  await expect(page.locator('.diary-task-row.is-completed')).toContainText(title)

  await page.getByRole('button', { name: '关闭当天事件' }).click()
  await effectiveCell.click()
  await page.getByRole('button', { name: `编辑待办：${title}` }).click()
  await page.getByLabel('重复规则').selectOption('weekly')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: `完成待办：${title}` })).toBeVisible()

  await page.getByRole('button', { name: '关闭当天事件' }).click()
  await firstCell.click()
  await expect(page.locator('.diary-task-row.is-completed')).toContainText(title)
  await page.getByRole('button', { name: `编辑待办：${title}` }).click()
  const oldSeriesEditor = page.locator('.diary-task-edit-dialog')
  await expect(page.getByLabel('开始日期')).toBeDisabled()
  await expect(oldSeriesEditor.getByRole('button', { name: '清除日期' })).toHaveCount(0)
  await page.getByLabel('重复结束日期').fill('')
  await oldSeriesEditor.getByRole('button', { name: '保存', exact: true }).click()
  await expect(oldSeriesEditor.getByRole('alert')).toContainText('历史边界')
  await page.getByLabel('重复结束日期').fill(firstDate)
  await oldSeriesEditor.getByRole('button', { name: '取消' }).click()
  await page.getByRole('button', { name: '关闭当天事件' }).click()
  await expect(firstCell.locator('.life-task-marker')).toHaveCount(0)

  await followingCell.click()
  await expect(page.getByRole('checkbox', { name: `完成待办：${title}` })).toBeVisible()
})

test('a one-off Todo can be linked to a schedule and survives Event deletion', async ({ page }) => {
  await page.goto('/diary')
  await unlockDiary(page)
  await page.getByTestId('diary-view-toggle').click()

  const date = `${testYear}-11-21`
  const eventTitle = `Checkup ${Math.random().toString(36).slice(2, 8)}`
  const taskTitle = `Prepare ID ${Math.random().toString(36).slice(2, 8)}`
  const cell = page.locator(`.diary-life-calendar [data-date="${date}"]`)
  await cell.click()
  await chooseDiaryAction(page, page.getByRole('button', { name: '更多当天事件操作' }), '新增事件')
  await page.getByTestId('event-type-schedule').click()
  await page.getByRole('textbox', { name: '事件名称' }).fill(eventTitle)
  await page.getByLabel('开始日期').fill(date)
  await page.getByLabel('结束日期').fill(date)
  await page.getByRole('button', { name: '保存', exact: true }).click()

  await expect(page.getByRole('heading', { name: eventTitle })).toBeVisible()
  await page.getByRole('button', { name: '关闭事件' }).click()
  await chooseDiaryAction(page, page.getByRole('button', { name: '更多当天事件操作' }), '新增待办')
  await page.getByRole('textbox', { name: '待办名称' }).fill(taskTitle)
  await page.getByLabel('截止日期').fill(date)
  await page.getByRole('button', { name: '选择日程' }).click()
  const eventOption = page.getByText(`${date} · ${eventTitle}`, { exact: true })
  await expect(eventOption).toBeVisible()
  await eventOption.click()
  await page.getByRole('button', { name: '保存', exact: true }).click()

  await page.getByRole('button', { name: eventTitle }).click()
  const relatedTasks = page.locator('.diary-event-reader-tasks')
  await expect(relatedTasks.getByRole('heading', { name: '相关待办' })).toBeVisible()
  await expect(relatedTasks).toContainText(taskTitle)
  await relatedTasks.getByRole('checkbox', { name: `完成待办：${taskTitle}` }).click()
  await expect(relatedTasks.locator('.diary-task-row.is-completed')).toContainText(taskTitle)

  await page.getByRole('button', { name: '编辑事件' }).click()
  await page.getByRole('button', { name: '删除事件', exact: true }).click()
  const eventDeleteConfirmation = page.getByRole('dialog', { name: '删除这条事件？' })
  await eventDeleteConfirmation.getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
  await expect(page.getByRole('checkbox', { name: `恢复待办：${taskTitle}` })).toBeVisible()

  await page.getByRole('button', { name: `编辑待办：${taskTitle}` }).click()
  await page.getByRole('button', { name: '删除', exact: true }).click()
  const taskDeleteConfirmation = page.getByRole('dialog', { name: '删除这条待办？' })
  await taskDeleteConfirmation.getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
})
