import { test, expect } from './fixtures/auth'
import { chooseDiaryAction, clearDiaryTaskDate, diaryEventDateInput, diaryMonthLabel, diaryTaskDateInput, diaryTaskTimeInput, fillDiaryEventDate, fillDiaryTaskDate, fillDiaryTaskTime, selectNaiveOption, unlockDiary } from './helpers/diary-life'

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
  await page.getByTestId('diary-add-task').click()

  const title = `Phase 3 day task ${Math.random().toString(36).slice(2, 9)}`
  const editor = page.locator('.diary-task-edit-dialog')
  await expect(editor).toBeVisible()
  const titleInput = page.getByRole('textbox', { name: '待办名称' })
  await expect(titleInput).toBeFocused()
  await expect(editor.locator('.diary-task-form-title')).toContainText('待办名称*')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(editor.getByRole('alert')).toContainText('请输入待办名称')
  await titleInput.fill(title)
  await clearDiaryTaskDate(page, '截止日期')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(editor.locator('.diary-event-form-error')).toContainText('请选择截止日期。')
  await expect(titleInput).toHaveValue(title)
  await expect(editor).toBeVisible()
  await fillDiaryTaskDate(page, '截止日期', date)
  await fillDiaryTaskTime(page, '截止时间', '12:05')
  await page.getByRole('button', { name: '保存', exact: true }).click()

  const taskRow = page.locator('.diary-task-row').filter({ has: page.locator('.diary-task-title', { hasText: title }) })
  await expect(taskRow.locator('.diary-task-detail')).toHaveText('截止 12:05')
  await page.clock.fastForward(6 * 60_000)
  await expect(taskRow.locator('.diary-task-detail')).toHaveText('已逾期1分钟')
  await expect(taskRow).toHaveClass(/is-overdue/)

  await page.getByRole('button', { name: `编辑待办：${title}`, exact: true }).click()
  const savedStatus = editor.locator('[data-testid="diary-task-completion"]')
  const expectedOverdue = '已逾期1分钟'
  await expect(savedStatus.locator('.diary-task-form-completion-left')).toHaveText('尚未完成')
  await expect(savedStatus.locator('.diary-task-form-completion-right')).toHaveText(expectedOverdue)
  await fillDiaryTaskDate(page, '截止日期', nextDate)
  await expect(savedStatus.locator('.diary-task-form-completion-right')).toHaveText(expectedOverdue)
  await fillDiaryTaskDate(page, '截止日期', date)
  await page.getByRole('button', { name: '取消', exact: true }).click()

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
  await page.getByTestId('diary-add-task').click()
  await page.getByRole('textbox', { name: '待办名称' }).fill(secondTitle)
  await fillDiaryTaskDate(page, '截止日期', date)
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
  await clearDiaryTaskDate(page, '截止日期')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(editor.locator('.diary-event-form-error')).toContainText('请选择截止日期。')
  await expect(page.getByRole('textbox', { name: '待办名称' })).toHaveValue(secondTitle)
  await fillDiaryTaskDate(page, '截止日期', date)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(editor).toBeHidden()

  await page.getByRole('button', { name: `编辑待办：${secondTitle}`, exact: true }).click()
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await page.getByRole('dialog', { name: '删除这条待办？' }).getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
  await expect(marker).toHaveCount(1)

  const completionResponsePromise = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/complete'))
  await complete.click()
  const completedTask = (await (await completionResponsePromise).json()).task as { completedAt: number }
  const completedRow = page.locator('.diary-task-row.is-completed').filter({ has: page.locator('.diary-task-title', { hasText: title }) })
  await expect(completedRow).toContainText(title)
  await expect(completedRow.locator('.diary-task-title')).toHaveCSS('text-decoration-line', 'line-through')
  await expect(completedRow.locator('.diary-task-detail')).toHaveText('逾期完成')
  await expect(completedRow.locator('.diary-task-detail')).not.toContainText('截止')
  await expect(marker).toHaveAttribute('src', '/emoji/party-popper.svg')
  await expect(marker).toHaveAttribute('data-todo-day-state', 'completed-late')
  await expect(marker).toHaveClass(/life-task-marker--completed-late/)

  await page.getByRole('button', { name: `编辑待办：${title}`, exact: true }).click()
  const completionDetails = editor.locator('[data-testid="diary-task-completion"]')
  await expect(completionDetails).toBeVisible()
  const completedAtLabel = await page.evaluate(timestamp => {
    const date = new Date(timestamp)
    const pad = (value: number) => value.toString().padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }, completedTask.completedAt)
  await expect(completionDetails).toContainText(completedAtLabel)
  await expect(completionDetails).toContainText('逾期')
  await page.getByRole('button', { name: '取消', exact: true }).click()

  await page.getByRole('checkbox', { name: `恢复待办：${title}`, exact: true }).click()
  await expect(page.getByRole('checkbox', { name: `完成待办：${title}`, exact: true })).toBeVisible()
  await expect(page.locator('.diary-task-row').filter({ has: page.locator('.diary-task-title', { hasText: title }) }).locator('.diary-task-detail')).toHaveText('已逾期1分钟')
  await expect(marker).toHaveAttribute('src', '/emoji/alarm-clock-animated.png')

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
    const completionStatus = form.locator('[data-testid="diary-task-completion"]')
    await expect(completionStatus).toBeVisible()
    await expect(completionStatus.locator('.diary-task-form-completion-box')).toHaveCount(2)
    const statusFits = await completionStatus.evaluate(element => element.scrollWidth <= element.clientWidth)
    expect(statusFits).toBe(true)
    const boxesFit = await completionStatus.locator('.diary-task-form-completion-box').evaluateAll(elements =>
      elements.every(element => element.scrollWidth <= element.clientWidth),
    )
    expect(boxesFit).toBe(true)
    if (viewport.width === 1280) {
      const [statusHeights, inputHeight] = await Promise.all([
        completionStatus.locator('.diary-task-form-completion-box').evaluateAll(elements =>
          elements.map(element => element.getBoundingClientRect().height),
        ),
        form.locator('.diary-task-form-title .n-input').evaluate(element => element.getBoundingClientRect().height),
      ])
      for (const height of statusHeights) expect(Math.abs(height - inputHeight)).toBeLessThanOrEqual(1)
      const root = page.locator('html')
      const originalTheme = await root.getAttribute('data-theme')
      const leftStatusBox = completionStatus.locator('.diary-task-form-completion-left')
      const beforeTheme = await leftStatusBox.evaluate(element => {
        const style = getComputedStyle(element)
        return { background: style.backgroundColor, border: style.borderColor }
      })
      const alternateTheme = originalTheme === 'dark' ? 'light' : 'dark'
      await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), alternateTheme)
      await expect(root).toHaveAttribute('data-theme', alternateTheme)
      const afterTheme = await leftStatusBox.evaluate(element => {
        const style = getComputedStyle(element)
        return { background: style.backgroundColor, border: style.borderColor }
      })
      expect(afterTheme.background).not.toBe(beforeTheme.background)
      expect(afterTheme.border).not.toBe(beforeTheme.border)
      await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), originalTheme!)
      await expect(root).toHaveAttribute('data-theme', originalTheme!)
    }
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await expect(form).toBeHidden()
  }

  await page.getByRole('button', { name: `编辑待办：${title}`, exact: true }).click()
  await expect(editor).toBeVisible()
  await fillDiaryTaskDate(page, '截止日期', nextDate)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: `完成待办：${title}`, exact: true })).toHaveCount(0)
  const nextCell = page.locator(`.diary-life-calendar [data-date="${nextDate}"]`)
  await expect(nextCell.locator('.life-task-marker')).toBeVisible()
  await page.getByRole('button', { name: '关闭当天事件' }).click()
  await nextCell.click()
  await expect(nextCell.locator('.life-task-marker')).toHaveAttribute('src', '/emoji/stopwatch.svg')
  await page.getByRole('button', { name: `编辑待办：${title}`, exact: true }).click()
  await expect(page.locator('.diary-task-edit-dialog [data-testid="diary-task-completion"]')).toHaveCount(0)
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await page.getByRole('dialog', { name: '删除这条待办？' }).getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
  await expect(nextCell.locator('.life-task-marker')).toHaveCount(0)
})

test('repairs a legacy undated task from the conditional notice without inferring a due date', async ({ page }) => {
  const taskId = '11111111-1111-4111-8111-111111111111'
  const dueDate = `${testYear}-11-21`
  const legacyTask = {
    id: taskId,
    title: '历史无日期待办',
    description: '保留原备注',
    startDate: `${testYear}-11-19`,
    startTime: '09:00',
    dueDate: null,
    dueTime: null,
    completedAt: null,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  }
  let savedTask: typeof legacyTask | null = null
  let savedBody: Record<string, unknown> | null = null
  await page.route('**/api/diary/life/**', async route => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname
    if (request.method() === 'GET' && pathname === '/api/diary/life/tasks/undated') {
      await route.fulfill({ json: savedTask ? { task: null, count: 0 } : { task: legacyTask, count: 1 } })
      return
    }
    if (request.method() === 'GET' && pathname === `/api/diary/life/tasks/${taskId}`) {
      await route.fulfill({ json: { task: savedTask ?? legacyTask } })
      return
    }
    if (request.method() === 'PUT' && pathname === `/api/diary/life/tasks/${taskId}`) {
      savedBody = request.postDataJSON() as Record<string, unknown>
      savedTask = { ...legacyTask, ...savedBody, dueDate: savedBody.dueDate as string, version: 2 } as typeof legacyTask
      await route.fulfill({ json: { task: savedTask } })
      return
    }
    if (request.method() === 'GET' && pathname === '/api/diary/life/task-occurrences') {
      await route.fulfill({ json: {
        items: savedTask?.dueDate ? [{ ...savedTask, kind: 'one-off' }] : [],
        nextCursor: null,
      } })
      return
    }
    if (request.method() === 'GET' && pathname === '/api/diary/life/events') {
      await route.fulfill({ json: { items: [], next: null } })
      return
    }
    await route.continue()
  })

  await page.goto('/diary')
  await unlockDiary(page)
  const notice = page.getByTestId('diary-undated-task-notice')
  await expect(notice).toContainText('1 条历史待办缺少截止日期')
  await notice.getByRole('button', { name: '补充截止日期' }).click()

  const editor = page.locator('.diary-task-edit-dialog')
  await expect(editor).toBeVisible()
  await expect(page.getByRole('textbox', { name: '待办名称' })).toHaveValue('历史无日期待办')
  await expect(diaryTaskDateInput(page, '截止日期')).toHaveValue('')
  await expect(diaryTaskDateInput(page, '开始日期')).toHaveValue(`${testYear}-11-19`)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(editor.locator('.diary-event-form-error')).toContainText('请选择截止日期。')
  expect(savedBody).toBeNull()

  await fillDiaryTaskDate(page, '截止日期', dueDate)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(editor).toBeHidden()
  expect(savedBody).toMatchObject({ dueDate, dueTime: null, startDate: `${testYear}-11-19`, startTime: '09:00' })
  await expect(notice).toHaveCount(0)
  await expect(page.getByRole('checkbox', { name: '完成待办：历史无日期待办', exact: true })).toBeVisible()
})

test('overdue Todos use Bomb and return to Party when completed late', async ({ page }) => {
  await page.goto('/diary')
  await unlockDiary(page)
  await page.getByTestId('diary-view-toggle').click()

  const dueDate = `${testYear}-11-15`
  const cell = page.locator(`.diary-life-calendar [data-date="${dueDate}"]`)
  await cell.click()
  await page.getByTestId('diary-add-task').click()
  const title = `Overdue task ${Math.random().toString(36).slice(2, 8)}`
  await page.getByRole('textbox', { name: '待办名称' }).fill(title)
  await fillDiaryTaskDate(page, '截止日期', dueDate)
  await page.getByRole('button', { name: '保存', exact: true }).click()

  const marker = cell.locator('.life-task-marker')
  await expect(marker).toHaveAttribute('src', '/emoji/bomb-animated.png')
  await expect(marker).toHaveAttribute('data-todo-day-state', 'overdue')
  await expect(marker).toHaveJSProperty('naturalWidth', 256)
  await page.getByRole('checkbox', { name: `完成待办：${title}`, exact: true }).click()
  await expect(marker).toHaveAttribute('src', '/emoji/party-popper.svg')
  await expect(marker).toHaveAttribute('data-todo-day-state', 'completed-late')
  await expect(marker).toHaveClass(/life-task-marker--completed-late/)
  await expect(marker).toHaveAttribute('alt', '当天待办已全部完成（含逾期完成）')
  expect(await marker.evaluate(image => getComputedStyle(image).filter)).toBe('grayscale(1)')
  await page.getByRole('checkbox', { name: `恢复待办：${title}`, exact: true }).click()
  await expect(marker).toHaveAttribute('src', '/emoji/bomb-animated.png')

  await page.getByRole('button', { name: `编辑待办：${title}`, exact: true }).click()
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await page.getByRole('dialog', { name: '删除这条待办？' }).getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
  await expect(marker).toHaveCount(0)
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
  await page.getByTestId('diary-add-task').click()

  const editor = page.locator('.diary-task-edit-dialog')
  await page.getByRole('textbox', { name: '待办名称' }).fill(title)
  await fillDiaryTaskDate(page, '开始日期', startDate)
  await fillDiaryTaskTime(page, '开始时间', '09:00')
  await expect(editor.getByRole('alert')).toContainText('开始日期不能晚于截止日期')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(editor.locator('.diary-event-form-error')).toContainText('请检查开始和截止时间设置')
  await selectNaiveOption(page, '重复规则', '每天')
  await expect(diaryTaskDateInput(page, '开始日期')).toHaveValue(startDate)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(editor.getByRole('alert')).toContainText('请选择结束日期')
  await fillDiaryTaskDate(page, '重复结束日期', `${testYear}-11-25`)
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
    expect(eventBounds!.width).toBe(width <= 420 ? 18 : 21)
    expect(eventBounds!.height).toBe(width <= 420 ? 18 : 21)
    expect(taskBounds!.width).toBe(width <= 420 ? 18 : 21)
    expect(taskBounds!.height).toBe(width <= 420 ? 18 : 21)
    expect(eventBounds!.x).toBeGreaterThanOrEqual(cellBounds!.x)
    expect(taskBounds!.x + taskBounds!.width).toBeLessThanOrEqual(cellBounds!.x + cellBounds!.width)
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
  await page.getByTestId('diary-add-task').click()
  const title = `Reduced motion ${Math.random().toString(36).slice(2, 8)}`
  await page.getByRole('textbox', { name: '待办名称' }).fill(title)
  await fillDiaryTaskDate(page, '截止日期', date)
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
  await page.getByTestId('diary-add-task').click()

  const title = `周末需要完成的综合项目${Math.random().toString(36).slice(2, 8)}`.repeat(8)
  await page.getByRole('textbox', { name: '待办名称' }).fill(title)
  await fillDiaryTaskDate(page, '截止日期', date)
  await fillDiaryTaskTime(page, '截止时间', '12:30')
  await page.getByRole('button', { name: '保存', exact: true }).click()

  const row = page.locator('.diary-life-dialog .diary-task-row').filter({ has: page.locator('.diary-task-title', { hasText: title }) })
  await expect(row).toBeVisible()
  await expect(row).toHaveClass(/diary-cloud-card/)
  await expect(row.locator('.diary-task-detail')).toHaveText('截止 12:30')
  await expect(row.locator('.diary-task-detail')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  expect(await row.evaluate(element => getComputedStyle(element).backgroundImage)).toBe('none')

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
        titleIsEllipsized: getComputedStyle(titleElement).textOverflow === 'ellipsis' && getComputedStyle(titleElement).whiteSpace === 'nowrap',
        titleEndsBeforeDetail: titleBounds.right <= detailBounds.left + 1,
        detailFitsInRow: detailBounds.right <= element.getBoundingClientRect().right + 1,
      }
    })
    expect(layout.titleIsEllipsized).toBe(true)
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

test('shows a cross-day Todo only on its due date and preserves its start plan', async ({ page }) => {
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
  await page.getByTestId('diary-add-task').click()

  await page.getByRole('textbox', { name: '待办名称' }).fill(title)
  await expect(diaryTaskDateInput(page, '开始日期')).toHaveValue('')
  await expect(diaryTaskDateInput(page, '截止日期')).toHaveValue(startDate)
  await fillDiaryTaskDate(page, '开始日期', startDate)
  await fillDiaryTaskTime(page, '开始时间', '09:00')
  await fillDiaryTaskDate(page, '截止日期', dueDate)
  await fillDiaryTaskTime(page, '截止时间', '12:00')

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
        '.diary-task-form-time-group:nth-child(1) .diary-task-date-picker input',
        '.diary-task-form-time-group:nth-child(1) .diary-task-time-picker input',
        '.diary-task-form-time-group:nth-child(2) .diary-task-date-picker input',
        '.diary-task-form-time-group:nth-child(2) .diary-task-time-picker input',
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
  await expect(dueCell.locator('.life-task-marker')).toHaveAttribute('src', '/emoji/party-popper.svg')
  await expect(dueCell.locator('.life-task-marker')).toHaveAttribute('data-todo-day-state', 'completed-late')
  await expect(dueCell.locator('.life-task-marker')).toHaveClass(/life-task-marker--completed-late/)

  await page.getByRole('button', { name: '关闭当天事件' }).click()
  await dueCell.click()
  const completedRow = page.getByRole('button', { name: `编辑待办：${title}` })
  await expect(completedRow).toBeVisible()
  await completedRow.click()
  await expect(diaryTaskDateInput(page, '截止日期')).toHaveValue(dueDate)
  await expect(diaryTaskDateInput(page, '开始日期')).toHaveValue(startDate)
  await expect(diaryTaskTimeInput(page, '开始时间')).toHaveValue('09:00')
  await expect(diaryTaskDateInput(page, '截止日期')).toHaveValue(dueDate)
  await expect(diaryTaskTimeInput(page, '截止时间')).toHaveValue('12:00')
  await page.getByRole('button', { name: '删除', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: '删除这条待办？' })
  await confirmation.getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()

})

test('calendar Todo actions remain available without the Recent Items list', async ({ page }) => {
  await page.goto('/diary')
  await unlockDiary(page)
  await expect(page.getByTestId('diary-event-list-toggle')).toHaveCount(0)
  await page.getByTestId('diary-view-toggle').click()

  const date = `${testYear}-11-19`
  const cell = page.locator(`.diary-life-calendar [data-date="${date}"]`)
  await cell.click()
  const closeButton = page.getByRole('button', { name: '关闭当天事件' })
  const addTaskButton = page.getByTestId('diary-add-task')
  await expect(closeButton).toHaveCSS('width', '32px')
  await expect(closeButton).toHaveCSS('border-radius', '50%')
  await expect(addTaskButton).toHaveCSS('width', '32px')
  await expect(addTaskButton).toHaveCSS('border-radius', '50%')
  await expect(addTaskButton).toBeVisible()
  await expect(page.getByTestId('diary-add-event')).toBeVisible()
  await expect(page.getByRole('button', { name: '更多当天事件操作' })).toHaveCount(0)
  await page.getByTestId('diary-add-task').click()

  const title = `Calendar task ${Math.random().toString(36).slice(2, 9)}`
  const editor = page.locator('.diary-task-edit-dialog')
  await expect(editor).toBeVisible()
  await page.getByRole('textbox', { name: '待办名称' }).fill(title)
  await expect(diaryTaskDateInput(page, '截止日期')).toHaveValue(date)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  const complete = page.getByRole('checkbox', { name: `完成待办：${title}` })
  await expect(complete).toBeVisible()
  await complete.click()
  const restore = page.getByRole('checkbox', { name: `恢复待办：${title}` })
  await expect(restore).toBeVisible()
  await restore.click()
  await expect(page.getByRole('checkbox', { name: `完成待办：${title}` })).toBeVisible()

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
    await expect(cell.locator('.life-task-marker')).toHaveAttribute('src', '/emoji/party-popper.svg')
    await expect(cell.locator('.life-task-marker')).toHaveAttribute('data-todo-day-state', 'completed-late')
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
    await expect(calendar.locator('.life-month-label')).toHaveText(diaryMonthLabel(`${testYear}-12`))
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
    const unlockButton = page.getByRole('button', { name: '解锁日程' })
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
  await page.getByTestId('diary-add-task').click()

  const editor = page.locator('.diary-task-edit-dialog')
  await page.getByRole('textbox', { name: '待办名称' }).fill(title)
  await selectNaiveOption(page, '重复规则', '每天')
  await fillDiaryTaskDate(page, '开始日期', startDate)
  await fillDiaryTaskTime(page, '截止时间', '23:59')
  await fillDiaryTaskDate(page, '重复结束日期', `${testYear}-11-30`)
  await page.getByRole('button', { name: '保存', exact: true }).click()

  await expect(page.getByRole('checkbox', { name: `完成待办：${title}` })).toBeVisible()
  await expect(page.locator('.diary-task-title').filter({ hasText: title })).toContainText('↻')
  await expect(page.locator('.diary-task-row').filter({ has: page.locator('.diary-task-title', { hasText: title }) }).locator('.diary-task-detail')).toHaveText('23:59')
  await page.getByRole('checkbox', { name: `完成待办：${title}` }).click()
  await expect(page.locator('.diary-task-row.is-completed')).toContainText(title)
  await expect(page.locator('.diary-task-row.is-completed').locator('.diary-task-detail')).toHaveText('逾期完成')
  await expect(startCell.locator('.life-task-marker')).toHaveAttribute('src', '/emoji/party-popper.svg')
  await expect(startCell.locator('.life-task-marker')).toHaveAttribute('data-todo-day-state', 'completed-late')

  await page.getByRole('button', { name: `编辑待办：${title}` }).click()
  const completedOccurrence = editor.locator('[data-testid="diary-task-completion"]')
  await expect(completedOccurrence).toBeVisible()
  await expect(completedOccurrence).toContainText(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
  await expect(completedOccurrence).toContainText('逾期')
  await page.getByRole('button', { name: '取消', exact: true }).click()

  await page.getByRole('button', { name: '关闭当天事件' }).click()
  const skippedCell = calendar.locator(`[data-date="${skippedDate}"]`)
  await skippedCell.click()
  await expect(page.getByRole('checkbox', { name: `完成待办：${title}` })).toBeVisible()
  await page.getByRole('button', { name: `编辑待办：${title}` }).click()
  await expect(editor).toBeVisible()
  await expect(diaryTaskDateInput(page, '开始日期')).toBeDisabled()
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
  await expect(page.locator('.diary-task-row.is-skipped').locator('.diary-task-detail')).toHaveText('23:59')
  await expect(page.locator('.diary-task-row.is-skipped')).not.toContainText('已完成')
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

  const firstDate = `${testYear}-11-20`
  const effectiveDate = `${testYear}-11-21`
  const followingDate = `${testYear}-11-28`
  const title = `Series split ${Math.random().toString(36).slice(2, 9)}`
  const calendar = page.locator('.diary-life-calendar')
  const firstCell = calendar.locator(`[data-date="${firstDate}"]`)
  const effectiveCell = calendar.locator(`[data-date="${effectiveDate}"]`)
  const followingCell = calendar.locator(`[data-date="${followingDate}"]`)

  await firstCell.click()
  await page.getByTestId('diary-add-task').click()
  await page.getByRole('textbox', { name: '待办名称' }).fill(title)
  await selectNaiveOption(page, '重复规则', '每天')
  await fillDiaryTaskDate(page, '开始日期', firstDate)
  await fillDiaryTaskDate(page, '重复结束日期', `${testYear}-11-30`)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByRole('checkbox', { name: `完成待办：${title}` }).click()
  await expect(page.locator('.diary-task-row.is-completed')).toContainText(title)

  await page.getByRole('button', { name: '关闭当天事件' }).click()
  await effectiveCell.click()
  await page.getByRole('button', { name: `编辑待办：${title}` }).click()
  await selectNaiveOption(page, '重复规则', '每周')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: `完成待办：${title}` })).toBeVisible()

  await page.getByRole('button', { name: '关闭当天事件' }).click()
  await firstCell.click()
  await expect(page.locator('.diary-task-row.is-completed')).toContainText(title)
  await page.getByRole('button', { name: `编辑待办：${title}` }).click()
  const oldSeriesEditor = page.locator('.diary-task-edit-dialog')
  await expect(diaryTaskDateInput(page, '开始日期')).toBeDisabled()
  await expect(oldSeriesEditor.getByRole('button', { name: '清除日期' })).toHaveCount(0)
  await fillDiaryTaskDate(page, '重复结束日期', '')
  await oldSeriesEditor.getByRole('button', { name: '保存', exact: true }).click()
  await expect(oldSeriesEditor.getByRole('alert')).toContainText('请选择结束日期')
  await fillDiaryTaskDate(page, '重复结束日期', followingDate)
  await oldSeriesEditor.getByRole('button', { name: '保存', exact: true }).click()
  await expect(oldSeriesEditor.getByRole('alert')).toContainText('历史边界')
  await oldSeriesEditor.getByRole('button', { name: '取消' }).click()
  const discardTaskChanges = page.getByRole('dialog', { name: '放弃未保存的修改？' })
  await discardTaskChanges.getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
  await expect(oldSeriesEditor).toBeHidden()
  await page.getByRole('button', { name: '关闭当天事件' }).click()
  await expect(firstCell.locator('.life-task-marker')).toHaveAttribute('src', '/emoji/party-popper.svg')
  await expect(firstCell.locator('.life-task-marker')).toHaveAttribute('data-todo-day-state', 'completed-late')

  await followingCell.click()
  await expect(page.getByRole('checkbox', { name: `完成待办：${title}` })).toBeVisible()
})

test('date-coincident Todo and Event remain independent records', async ({ page }) => {
  await page.goto('/diary')
  await unlockDiary(page)
  await page.getByTestId('diary-view-toggle').click()

  const date = `${testYear}-11-21`
  const eventTitle = `Checkup ${Math.random().toString(36).slice(2, 8)}`
  const taskTitle = `Prepare ID ${Math.random().toString(36).slice(2, 8)}`
  const cell = page.locator(`.diary-life-calendar [data-date="${date}"]`)
  await cell.click()
  await expect(page.getByRole('button', { name: '更多当天事件操作' })).toHaveCount(0)
  await page.getByTestId('diary-add-event').click()
  await page.getByTestId('event-type-schedule').click()
  await expect(diaryEventDateInput(page, '开始日期')).toHaveValue(date)
  await expect(diaryEventDateInput(page, '结束日期')).toHaveValue(date)
  await page.getByRole('textbox', { name: '事件名称' }).fill(eventTitle)
  await fillDiaryEventDate(page, '开始日期', date)
  await fillDiaryEventDate(page, '结束日期', date)
  await page.getByRole('button', { name: '保存', exact: true }).click()

  await expect(page.getByRole('button', { name: eventTitle, exact: true })).toBeVisible()
  await page.getByTestId('diary-add-task').click()
  await page.getByRole('textbox', { name: '待办名称' }).fill(taskTitle)
  await expect(diaryTaskDateInput(page, '截止日期')).toHaveValue(date)
  await fillDiaryTaskDate(page, '截止日期', date)
  await page.getByRole('button', { name: '保存', exact: true }).click()

  const eventButton = page.getByRole('button', { name: eventTitle, exact: true })
  await expect(eventButton).toBeVisible()
  await expect(page.getByRole('checkbox', { name: `完成待办：${taskTitle}`, exact: true })).toBeVisible()

  const dayDialog = page.locator('.diary-life-dialog')
  const dayHeadingColor = await dayDialog.getByRole('heading', { name: '待办事项' }).evaluate(heading => getComputedStyle(heading).color)
  await expect(eventButton).toHaveCSS('height', '48px')
  await expect(eventButton.locator('.diary-event-distance')).toHaveText('还剩5天')
  await expect(eventButton.locator('.diary-event-distance')).toHaveCSS('font-size', '12px')
  await expect(eventButton.locator('.diary-event-distance')).toHaveCSS('white-space', 'nowrap')
  await expect(dayDialog.getByRole('heading', { name: '重要日程' })).toHaveCSS('color', dayHeadingColor)
  await page.getByRole('button', { name: '关闭当天事件' }).click()
  await cell.click()

  await page.getByRole('button', { name: `编辑待办：${taskTitle}` }).click()
  await page.getByRole('button', { name: '删除', exact: true }).click()
  const taskDeleteConfirmation = page.getByRole('dialog', { name: '删除这条待办？' })
  await taskDeleteConfirmation.getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
  await expect(eventButton).toBeVisible()

  const remainingTaskTitle = `${taskTitle} independent`
  await page.getByTestId('diary-add-task').click()
  await page.getByRole('textbox', { name: '待办名称' }).fill(remainingTaskTitle)
  await fillDiaryTaskDate(page, '截止日期', date)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: `完成待办：${remainingTaskTitle}`, exact: true })).toBeVisible()

  await eventButton.click()
  await page.getByRole('button', { name: '删除事件', exact: true }).click()
  const eventDeleteConfirmation = page.getByRole('dialog', { name: '删除这条事件？' })
  await eventDeleteConfirmation.getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
  await expect(page.getByRole('checkbox', { name: `完成待办：${remainingTaskTitle}`, exact: true })).toBeVisible()
})
