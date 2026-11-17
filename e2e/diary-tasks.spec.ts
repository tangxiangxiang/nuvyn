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
  const nextDate = `${testYear}-11-17`
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

  const complete = page.getByRole('checkbox', { name: `完成待办：${title}` })
  await expect(complete).toBeVisible()
  await expect(cell.locator('.life-task-marker')).toBeVisible()
  await complete.click()
  await expect(page.locator('.diary-task-row.is-completed')).toContainText(title)
  await expect(cell.locator('.life-task-marker')).toHaveCount(0)

  await page.getByRole('checkbox', { name: `恢复待办：${title}` }).click()
  await expect(page.getByRole('checkbox', { name: `完成待办：${title}` })).toBeVisible()
  await expect(cell.locator('.life-task-marker')).toBeVisible()

  await page.getByRole('button', { name: `编辑待办：${title}` }).click()
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
    await page.getByRole('button', { name: `编辑待办：${title}` }).click()
    const form = page.locator('.diary-task-edit-dialog')
    const bounds = await form.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await expect(form).toBeHidden()
  }

  await page.getByRole('button', { name: `编辑待办：${title}` }).click()
  await expect(editor).toBeVisible()
  await page.getByLabel('截止日期').fill(nextDate)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: `完成待办：${title}` })).toHaveCount(0)
  const nextCell = page.locator(`.diary-life-calendar [data-date="${nextDate}"]`)
  await expect(nextCell.locator('.life-task-marker')).toBeVisible()
  await page.getByRole('button', { name: '关闭当天事件' }).click()
  await nextCell.click()
  await page.getByRole('button', { name: `编辑待办：${title}` }).click()
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await page.getByRole('dialog', { name: '删除这条待办？' }).getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
  await expect(nextCell.locator('.life-task-marker')).toHaveCount(0)
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
    if (request.method() === 'GET' && url.pathname === '/api/diary/life/tasks') {
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
    if (request.method() === 'GET' && url.pathname === '/api/diary/life/tasks') {
      taskRequests += 1
      await route.fulfill({ json: {
        items: [{ id: taskId, title: 'Events 失败时仍可勾选', description: '', dueDate: date, dueTime: null, completedAt, version: taskVersion, createdAt: 1, updatedAt: taskVersion }],
        nextCursor: null,
      } })
      return
    }
    if (request.method() === 'POST' && url.pathname === `/api/diary/life/tasks/${taskId}/complete`) {
      completedAt = Date.now()
      taskVersion += 1
      await route.fulfill({ json: { task: { id: taskId, title: 'Events 失败时仍可勾选', description: '', dueDate: date, dueTime: null, completedAt, version: taskVersion, createdAt: 1, updatedAt: taskVersion } } })
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
    if (request.method() === 'GET' && url.pathname === '/api/diary/life/tasks') {
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
    if (request.method() === 'GET' && url.pathname === '/api/diary/life/tasks') {
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
