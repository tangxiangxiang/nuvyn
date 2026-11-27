import { test, expect } from './fixtures/auth'
import { diaryMonthLabel, unlockDiary } from './helpers/diary-life'

const currentDate = '2024-06-08'
const longDate = '2025-06-12'
const currentEntryId = '11111111-1111-4111-8111-111111111111'
const longEntryIds = Array.from({ length: 80 }, (_, index) => `22222222-2222-4222-8222-${String(index + 1).padStart(12, '0')}`)
const longEntries = Array.from({ length: 80 }, (_, index) => index === 74
  ? 'Entry 75 contains diary search needle and should be revealed.'
  : `Entry ${index + 1} keeps a memory.`)

async function seedDiary(page: import('@playwright/test').Page, date: string, entries: string[], entryIds: string[]) {
  await page.evaluate(async ({ date, entries, entryIds }) => {
    const moduleUrl = new URL('/src/lib/diary-life-api.ts', location.href).href
    const api = await import(moduleUrl)
    const current = await api.diaryLifeApi.day(date)
    // These dates are reserved for this spec. A rerun may see its own prior
    // fixture or a tombstone, so seed with the version returned by the Day API.
    await api.diaryLifeApi.saveDay(date, { moodId: null, entries, entryIds }, current.version)
  }, { date, entries, entryIds })
}

async function updateDiary(page: import('@playwright/test').Page, date: string, entries: string[], entryIds: string[]) {
  await page.evaluate(async ({ date, entries, entryIds }) => {
    const api = await import(new URL('/src/lib/diary-life-api.ts', location.href).href)
    const current = await api.diaryLifeApi.day(date)
    if (current.day === null) throw new Error(`Expected seeded Diary date ${date} to exist`)
    await api.diaryLifeApi.saveDay(date, { moodId: null, entries, entryIds }, current.version)
  }, { date, entries, entryIds })
}

async function deleteDiary(page: import('@playwright/test').Page, date: string) {
  await page.evaluate(async date => {
    const api = await import(new URL('/src/lib/diary-life-api.ts', location.href).href)
    const current = await api.diaryLifeApi.day(date)
    if (current.day === null) throw new Error(`Expected seeded Diary date ${date} to exist`)
    await api.diaryLifeApi.deleteDay(date, current.version)
  }, date)
}

async function requestDiaryResult(page: import('@playwright/test').Page, value: { date: string; entryId?: string; entryIndex?: number }) {
  await page.evaluate(async intent => {
    const navigation = await import(new URL('/src/composables/diary/useDiarySearchNavigation.ts', location.href).href)
    navigation.requestDiarySearchOpen(intent)
  }, value)
}

async function findSearchResult(page: import('@playwright/test').Page, query: string, date: string) {
  await page.locator('.nav-search').click()
  await page.locator('.palette-input input').fill(query)
  const result = page.getByRole('option').filter({ hasText: date })
  await expect(result).toBeVisible()
  return result
}

async function searchFor(page: import('@playwright/test').Page, query: string, date: string) {
  const result = await findSearchResult(page, query, date)
  await result.click()
  const dialog = page.getByTestId('diary-day-dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

test('Diary private search opens current and cross-year hits in reading mode and reveals the matching entry', async ({ page }) => {
  await page.clock.install({ time: new Date('2024-06-10T12:00:00') })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/diary')
  await unlockDiary(page)
  await expect(page.locator('.diary-life-calendar')).toBeVisible()
  await seedDiary(page, currentDate, ['Current month memory: blue teacup'], [currentEntryId])
  await seedDiary(page, longDate, longEntries, longEntryIds)

  const currentDialog = await searchFor(page, 'blue teacup', currentDate)
  await expect(currentDialog).toContainText('Current month memory: blue teacup')
  await expect(currentDialog.getByTestId('diary-bullet-reader')).toBeVisible()
  await expect(currentDialog.getByTestId('diary-bullet-editor')).toHaveCount(0)
  await expect(page.locator('.life-month-label')).toHaveText(diaryMonthLabel(currentDate.slice(0, 7)))
  await page.getByRole('button', { name: '关闭日记' }).click()

  for (const width of [768, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 })
    const dialog = await searchFor(page, 'search needle', longDate)
    await expect(page.locator('.life-month-label')).toHaveText(diaryMonthLabel(longDate.slice(0, 7)))
    const selectedCell = page.locator(`.diary-life-calendar [data-date="${longDate}"]`)
    await expect(selectedCell).toHaveClass(/\bselected\b/)
    await expect(selectedCell.locator('.life-date-action')).toHaveAttribute('aria-pressed', 'true')
    await expect(dialog.getByTestId('diary-bullet-editor')).toHaveCount(0)
    const matchingEntry = dialog.locator(`[data-entry-id="${longEntryIds[74]}"]`)
    await expect(matchingEntry).toBeVisible()
    await expect(matchingEntry).toContainText('search needle')
    await expect.poll(() => matchingEntry.evaluate(node => node.getBoundingClientRect().top)).toBeGreaterThanOrEqual(
      await dialog.locator('.n-card__content-scrollbar > .n-scrollbar-container').evaluate(node => node.getBoundingClientRect().top) - 1,
    )
    const scrollTop = await dialog.locator('.n-card__content-scrollbar > .n-scrollbar-container').evaluate(node => node.scrollTop)
    expect(scrollTop).toBeGreaterThan(0)
    await page.getByRole('button', { name: '关闭日记' }).click()
  }
})

test('Diary lock clears search results and locked search does not query private text', async ({ page }) => {
  await page.clock.install({ time: new Date('2024-06-10T12:00:00') })
  await page.goto('/diary')
  await unlockDiary(page)
  const lockTestDate = '2024-06-09'
  await seedDiary(page, lockTestDate, ['Private lock search phrase'], ['66666666-6666-4666-8666-666666666666'])
  await page.locator('.nav-search').click()
  const input = page.locator('.palette-input input')
  await input.fill('Private lock search phrase')
  await expect(page.getByRole('option')).toContainText('Private lock search phrase')
  await page.keyboard.press('Escape')
  await expect(page.locator('.palette')).toHaveCount(0)

  await page.getByTestId('account-button').click()
  await page.getByTestId('account-lock-diary').click()
  await expect(page.getByRole('button', { name: '解锁日程', exact: true })).toBeVisible()

  let privateSearchRequests = 0
  let privateEventSearchRequests = 0
  let privateTaskSearchRequests = 0
  await page.route('**/api/diary/life/search', route => {
    privateSearchRequests += 1
    return route.continue()
  })
  await page.route('**/api/diary/life/events/search', route => {
    privateEventSearchRequests += 1
    return route.continue()
  })
  await page.route('**/api/diary/life/tasks/search', route => {
    privateTaskSearchRequests += 1
    return route.continue()
  })
  await page.locator('.nav-search').click()
  await page.locator('.palette-input input').fill('Private lock search phrase')
  await expect(page.getByRole('status')).toContainText(/No matching results|没有匹配结果/)
  expect(privateSearchRequests).toBe(0)
  expect(privateEventSearchRequests).toBe(0)
  expect(privateTaskSearchRequests).toBe(0)
  await expect(page.locator('.palette')).not.toContainText('Private lock search phrase')
})

test('Diary search preserves an unsaved draft when navigation is cancelled', async ({ page }) => {
  await page.clock.install({ time: new Date('2024-06-10T12:00:00') })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/diary')
  await unlockDiary(page)

  const sourceDate = '2024-06-06'
  const modifiedDate = '2023-06-20'
  const sourceId = '33333333-3333-4333-8333-333333333333'
  const modifiedId = '44444444-4444-4444-8444-444444444444'
  await seedDiary(page, sourceDate, ['Original saved entry'], [sourceId])
  await seedDiary(page, modifiedDate, ['Original search target phrase'], [modifiedId])

  await page.locator(`.diary-life-calendar [data-date="${sourceDate}"] .life-date-action`).click()
  const sourceDialog = page.getByTestId('diary-day-dialog')
  await expect(sourceDialog.getByTestId('diary-bullet-reader')).toBeVisible()
  await sourceDialog.getByTestId('diary-edit-entry').click()
  const draft = sourceDialog.getByRole('textbox', { name: '第 1 条日记', exact: true })
  await draft.fill('Unsaved local draft')

  let targetReads = 0
  await page.route(`**/api/diary/life/days/${modifiedDate}`, route => {
    if (route.request().method() === 'GET') targetReads += 1
    return route.continue()
  })
  await requestDiaryResult(page, { date: modifiedDate, entryId: modifiedId })
  const discard = page.getByRole('dialog', { name: '放弃未保存的修改？' })
  await expect(discard).toBeVisible()
  await discard.getByRole('button', { name: /^(Cancel|取消)$/ }).click()
  await expect(sourceDialog.getByTestId('diary-bullet-editor')).toBeVisible()
  await expect(draft).toHaveValue('Unsaved local draft')
  const sourceCell = page.locator(`.diary-life-calendar [data-date="${sourceDate}"]`)
  await expect(sourceCell).toHaveClass(/\bselected\b/)
  await expect(sourceCell.locator('.life-date-action')).toHaveAttribute('aria-pressed', 'true')
  expect(targetReads).toBe(0)
})

test('Diary search opens the latest saved version after a result is updated', async ({ page }) => {
  await page.clock.install({ time: new Date('2024-06-10T12:00:00') })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/diary')
  await unlockDiary(page)

  const modifiedDate = '2023-06-21'
  const modifiedId = '77777777-7777-4777-8777-777777777777'
  await seedDiary(page, modifiedDate, ['Original search target phrase'], [modifiedId])
  const result = await findSearchResult(page, 'Original search target phrase', modifiedDate)
  await updateDiary(page, modifiedDate, ['Latest saved version'], [modifiedId])
  await result.click()
  const modifiedDialog = page.getByTestId('diary-day-dialog')
  await expect(modifiedDialog).toBeVisible()
  await expect(modifiedDialog).toContainText('Latest saved version')
  await expect(modifiedDialog.getByTestId('diary-bullet-editor')).toHaveCount(0)
})

test('Diary search does not open an empty editor when a result is deleted', async ({ page }) => {
  await page.clock.install({ time: new Date('2024-06-10T12:00:00') })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/diary')
  await unlockDiary(page)

  const deletedDate = '2022-06-22'
  const deletedId = '88888888-8888-4888-8888-888888888888'
  await seedDiary(page, deletedDate, ['Deleted search target phrase'], [deletedId])
  const result = await findSearchResult(page, 'Deleted search target phrase', deletedDate)
  await deleteDiary(page, deletedDate)
  await result.click()
  await expect(page.getByText('这条日记已不存在。', { exact: true })).toBeVisible()
  await expect(page.getByTestId('diary-day-dialog')).toHaveCount(0)
  await expect(page.getByTestId('diary-bullet-editor')).toHaveCount(0)
})

test('Event and Todo search navigate across years to the exact calendar rows', async ({ page }) => {
  await page.clock.install({ time: new Date('2024-06-10T12:00:00') })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/diary')
  await unlockDiary(page)

  const seeded = await page.evaluate(async () => {
    const life = await import(new URL('/src/lib/diary-life-api.ts', location.href).href)
    const tasks = await import(new URL('/src/lib/diary-tasks-api.ts', location.href).href)
    const eventId = '99999999-9999-4999-8999-999999999901'
    await life.diaryLifeApi.saveEvent(eventId, {
      title: '买下山景公寓', description: '', emoji: '🏠', type: 'milestone',
      startDate: '2023-10-12', endDate: '2023-10-12', startTime: null, endTime: null,
      allDay: true, dateRule: { calendar: 'gregory' }, recurrence: 'none', showCountdown: false, isPrimary: false,
    }, 0)
    const task = await tasks.diaryTasksApi.createTask({
      title: '联系装修师傅', description: '确认厨房报价', startDate: null, startTime: null,
      dueDate: '2023-10-13', dueTime: null,
    })
    return { eventId, taskId: task.task.id }
  })

  await page.locator('.nav-search').click()
  const search = page.locator('.palette-input input')
  await search.fill('山景公寓')
  const eventResult = page.getByRole('option').filter({ hasText: '买下山景公寓' })
  await expect(eventResult).toBeVisible()
  await expect(eventResult.locator('mark')).toContainText('山景公寓')
  await expect(page.locator('.palette-section-label')).toHaveText('事件')
  await eventResult.click()

  const eventDialog = page.locator('.diary-life-dialog')
  await expect(eventDialog).toBeVisible()
  await expect(page.locator('.life-month-label')).toHaveText(diaryMonthLabel('2023-10'))
  const eventRow = eventDialog.locator(`[data-event-id="${seeded.eventId}"]`)
  await expect(eventRow).toBeVisible()
  await expect(eventRow).toHaveAttribute('data-search-highlight', 'event')
  await expect(eventDialog.locator('.diary-event-form-content')).toHaveCount(0)
  await page.getByRole('button', { name: '关闭当天事件' }).click()

  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.nav-search').click()
  await search.fill('联系装修师傅')
  const taskResult = page.getByRole('option').filter({ hasText: '联系装修师傅' })
  await expect(taskResult).toBeVisible()
  await expect(taskResult).toContainText('截止 2023-10-13 · 未完成')
  await expect(page.locator('.palette-section-label')).toHaveText('待办')
  await taskResult.click()

  const taskDialog = page.locator('.diary-life-dialog')
  await expect(taskDialog).toBeVisible()
  await expect(page.locator('.life-month-label')).toHaveText(diaryMonthLabel('2023-10'))
  const taskRow = taskDialog.locator(`[data-task-id="${seeded.taskId}"]`).locator('xpath=..')
  await expect(taskRow).toBeVisible()
  await expect(taskRow).toHaveAttribute('data-search-highlight', 'task')
  await expect(taskDialog.locator('.diary-task-edit-dialog')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('deleted Event and Todo search results fail safely without opening a dialog', async ({ page }) => {
  await page.clock.install({ time: new Date('2024-06-10T12:00:00') })
  await page.goto('/diary')
  await unlockDiary(page)

  const seeded = await page.evaluate(async () => {
    const life = await import(new URL('/src/lib/diary-life-api.ts', location.href).href)
    const tasks = await import(new URL('/src/lib/diary-tasks-api.ts', location.href).href)
    const eventId = '99999999-9999-4999-8999-999999999902'
    const event = await life.diaryLifeApi.saveEvent(eventId, {
      title: '删除保护事件标记', description: '', emoji: '🎯', type: 'milestone',
      startDate: '2023-11-12', endDate: '2023-11-12', startTime: null, endTime: null,
      allDay: true, dateRule: { calendar: 'gregory' }, recurrence: 'none', showCountdown: false, isPrimary: false,
    }, 0)
    const task = await tasks.diaryTasksApi.createTask({
      title: '删除保护待办标记', description: '', startDate: null, startTime: null,
      dueDate: '2023-11-13', dueTime: null,
    })
    return { eventId, eventVersion: event.event.version, taskId: task.task.id, taskVersion: task.task.version }
  })

  await page.locator('.nav-search').click()
  const search = page.locator('.palette-input input')
  await search.fill('删除保护事件标记')
  const eventResult = page.getByRole('option').filter({ hasText: '删除保护事件标记' })
  await expect(eventResult).toBeVisible()
  await page.evaluate(async ({ id, version }) => {
    const life = await import(new URL('/src/lib/diary-life-api.ts', location.href).href)
    await life.diaryLifeApi.deleteEvent(id, version)
  }, { id: seeded.eventId, version: seeded.eventVersion })
  await eventResult.click()
  await expect(page.getByText('这条事件已不存在。', { exact: true })).toBeVisible()
  await expect(page.locator('.diary-life-dialog')).toHaveCount(0)

  await page.locator('.nav-search').click()
  await search.fill('删除保护待办标记')
  const taskResult = page.getByRole('option').filter({ hasText: '删除保护待办标记' })
  await expect(taskResult).toBeVisible()
  await page.evaluate(async ({ id, version }) => {
    const tasks = await import(new URL('/src/lib/diary-tasks-api.ts', location.href).href)
    await tasks.diaryTasksApi.deleteTask(id, version)
  }, { id: seeded.taskId, version: seeded.taskVersion })
  await taskResult.click()
  await expect(page.getByText('这条待办已不存在或没有有效实例。', { exact: true })).toBeVisible()
  await expect(page.locator('.diary-life-dialog')).toHaveCount(0)
})
