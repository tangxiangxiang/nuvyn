import { test, expect } from './fixtures/auth'
import { unlockDiary } from './helpers/diary-life'

const currentDate = '2024-01-08'
const longDate = '2025-08-12'
const currentEntryId = '11111111-1111-4111-8111-111111111111'
const longEntryIds = Array.from({ length: 80 }, (_, index) => `22222222-2222-4222-8222-${String(index + 1).padStart(12, '0')}`)
const longEntries = Array.from({ length: 80 }, (_, index) => index === 74
  ? 'Entry 75 contains diary search needle and should be revealed.'
  : `Entry ${index + 1} keeps a memory.`)

async function seedDiary(page: import('@playwright/test').Page, date: string, entries: string[], entryIds: string[]) {
  await page.evaluate(async ({ date, entries, entryIds }) => {
    const moduleUrl = new URL('/src/lib/diary-life-api.ts', location.href).href
    const api = await import(moduleUrl)
    await api.diaryLifeApi.saveDay(date, { moodId: null, entries, entryIds }, 0)
  }, { date, entries, entryIds })
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
  await page.clock.setFixedTime(new Date('2024-01-10T12:00:00'))
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
  await expect(page.locator('.life-month')).toHaveText('2024-01')
  await page.getByRole('button', { name: '关闭日记' }).click()

  for (const width of [768, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 })
    const dialog = await searchFor(page, 'search needle', longDate)
    await expect(page.locator('.life-month')).toHaveText('2025-08')
    await expect(page.locator(`.diary-life-calendar [data-date="${longDate}"]`)).toHaveAttribute('aria-pressed', 'true')
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
  await page.clock.setFixedTime(new Date('2024-01-10T12:00:00'))
  await page.goto('/diary')
  await unlockDiary(page)
  const lockTestDate = '2024-01-09'
  await seedDiary(page, lockTestDate, ['Private lock search phrase'], ['66666666-6666-4666-8666-666666666666'])
  await page.locator('.nav-search').click()
  const input = page.locator('.palette-input input')
  await input.fill('Private lock search phrase')
  await expect(page.getByRole('option')).toContainText('Private lock search phrase')
  await page.keyboard.press('Escape')
  await expect(page.locator('.palette')).toHaveCount(0)

  await page.getByTestId('account-button').click()
  await page.getByTestId('account-lock-diary').click()
  await expect(page.getByRole('button', { name: '解锁日记', exact: true })).toBeVisible()

  let privateSearchRequests = 0
  await page.route('**/api/diary/life/search', route => {
    privateSearchRequests += 1
    return route.continue()
  })
  await page.locator('.nav-search').click()
  await page.locator('.palette-input input').fill('Private lock search phrase')
  await expect(page.getByRole('status')).toContainText(/No matching results|没有匹配结果/)
  expect(privateSearchRequests).toBe(0)
  await expect(page.locator('.palette')).not.toContainText('Private lock search phrase')
})

test('Diary search preserves an unsaved draft when navigation is cancelled', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2024-01-10T12:00:00'))
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/diary')
  await unlockDiary(page)

  const sourceDate = '2024-01-06'
  const modifiedDate = '2023-12-20'
  const sourceId = '33333333-3333-4333-8333-333333333333'
  const modifiedId = '44444444-4444-4444-8444-444444444444'
  await seedDiary(page, sourceDate, ['Original saved entry'], [sourceId])
  await seedDiary(page, modifiedDate, ['Original search target phrase'], [modifiedId])

  await page.locator(`.diary-life-calendar [data-date="${sourceDate}"]`).click()
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
  await expect(page.locator(`.diary-life-calendar [data-date="${sourceDate}"]`)).toHaveAttribute('aria-pressed', 'true')
  expect(targetReads).toBe(0)
})

test('Diary search opens the latest saved version after a result is updated', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2024-01-10T12:00:00'))
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/diary')
  await unlockDiary(page)

  const modifiedDate = '2023-11-20'
  const modifiedId = '77777777-7777-4777-8777-777777777777'
  await seedDiary(page, modifiedDate, ['Original search target phrase'], [modifiedId])
  const result = await findSearchResult(page, 'Original search target phrase', modifiedDate)
  await page.evaluate(async ({ date, entryId }) => {
    const api = await import(new URL('/src/lib/diary-life-api.ts', location.href).href)
    await api.diaryLifeApi.saveDay(date, { moodId: null, entries: ['Latest saved version'], entryIds: [entryId] }, 1)
  }, { date: modifiedDate, entryId: modifiedId })
  await result.click()
  const modifiedDialog = page.getByTestId('diary-day-dialog')
  await expect(modifiedDialog).toBeVisible()
  await expect(modifiedDialog).toContainText('Latest saved version')
  await expect(modifiedDialog.getByTestId('diary-bullet-editor')).toHaveCount(0)
})

test('Diary search does not open an empty editor when a result is deleted', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2024-01-10T12:00:00'))
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/diary')
  await unlockDiary(page)

  const deletedDate = '2022-07-06'
  const deletedId = '88888888-8888-4888-8888-888888888888'
  await seedDiary(page, deletedDate, ['Deleted search target phrase'], [deletedId])
  const result = await findSearchResult(page, 'Deleted search target phrase', deletedDate)
  await page.evaluate(async ({ date }) => {
    const api = await import(new URL('/src/lib/diary-life-api.ts', location.href).href)
    await api.diaryLifeApi.deleteDay(date, 1)
  }, { date: deletedDate })
  await result.click()
  await expect(page.getByText('这条日记已不存在。', { exact: true })).toBeVisible()
  await expect(page.getByTestId('diary-day-dialog')).toHaveCount(0)
  await expect(page.getByTestId('diary-bullet-editor')).toHaveCount(0)
})
