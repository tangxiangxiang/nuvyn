import { test, expect } from './fixtures/auth'
import type { Page, TestInfo } from '@playwright/test'
import type { EventFields } from '../shared/diaryLife'
import { diaryEventDateInput, diaryMonthLabel, fillDiaryEventDate, unlockDiary } from './helpers/diary-life'

function dateAfter(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const value = new Date(year!, month! - 1, day!, 12)
  value.setDate(value.getDate() + days)
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
}

function monthDistance(from: string, to: string): number {
  return (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12
    + Number(to.slice(5, 7)) - Number(from.slice(5, 7))
}

async function verifyPeriodFormSpacing(page: Page, testInfo: TestInfo, state: 'create' | 'edit') {
  const form = page.getByTestId('diary-event-form')
  await expect(form.locator('.event-date-heading')).toHaveCount(0)
  for (const { width, height, gap, sideBySide } of [
    { width: 1280, height: 900, gap: 20, sideBySide: true },
    { width: 390, height: 844, gap: 17, sideBySide: false },
  ]) {
    await page.setViewportSize({ width, height })
    await expect.poll(() => form.evaluate(element => {
      const title = element.querySelector('.event-title-field')!.getBoundingClientRect()
      const dates = element.querySelector('.event-date-section .event-dates')!
      const dateBox = dates.getBoundingClientRect()
      const note = element.querySelector('textarea')!.closest('label')!.getBoundingClientRect()
      const [start, end] = Array.from(dates.children, field => field.getBoundingClientRect())
      return {
        titleToDates: dateBox.top - title.bottom,
        datesToNote: note.top - dateBox.bottom,
        sideBySide: start!.top === end!.top && start!.right < end!.left,
      }
    })).toEqual({ titleToDates: gap, datesToNote: gap, sideBySide })
    await page.screenshot({ path: testInfo.outputPath(`diary-life-period-${state}-${width}.png`), animations: 'disabled' })
  }
  await page.setViewportSize({ width: 1280, height: 900 })
}

test('Life Period supports endpoint markers, search, and direct editing without an attachment section', async ({ page }, testInfo) => {
  testInfo.setTimeout(90_000)
  await page.clock.install({ time: new Date('2026-11-28T12:00:00') })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/diary')
  await unlockDiary(page)
  await page.getByTestId('diary-view-mode-events').click()

  const startDate = '2026-11-30'
  const endDate = dateAfter(startDate, 400)
  const interiorDate = dateAfter(startDate, 30)
  const title = `人生阶段 ${crypto.randomUUID().slice(0, 8)}`
  const description = `阶段搜索词 ${crypto.randomUUID()}`
  const calendar = page.locator('.diary-life-calendar')

  await calendar.locator(`[data-date="${startDate}"] .life-date-action`).click()
  await page.getByTestId('diary-add-event').click()
  const editor = page.locator('.diary-event-edit-dialog')
  await expect(editor).toBeVisible()
  await page.getByTestId('event-type-period').click()
  await expect(page.getByTestId('event-type-period')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('textbox', { name: '结束日期' })).toHaveValue('')
  await page.getByRole('textbox', { name: '事件名称' }).fill(title)
  await page.getByLabel('事件备注').fill(description)
  await expect(editor.locator('input[type="file"]')).toHaveCount(0)
  await expect(editor.getByText('附件', { exact: true })).toHaveCount(0)
  await verifyPeriodFormSpacing(page, testInfo, 'create')

  const saveResponse = page.waitForResponse(response => response.request().method() === 'PUT'
    && new URL(response.url()).pathname.startsWith('/api/diary/life/events/'))
  await page.getByRole('button', { name: '保存', exact: true }).click()
  const response = await saveResponse
  expect(response.ok()).toBe(true)
  const result = await response.json() as { event: { id: string; endDate: string | null } }
  expect(result.event.endDate).toBeNull()

  const row = page.locator(`.day-events [data-event-id="${result.event.id}"]`)
  await expect(row).toBeVisible()
  await expect(row.locator('.diary-event-distance')).toHaveText('还剩 2 天')
  await row.press('Enter')
  await expect(editor.getByText('编辑事件', { exact: true })).toBeVisible()
  const titleInput = editor.getByRole('textbox', { name: '事件名称' })
  await expect(titleInput).toBeFocused()
  await expect(titleInput).toHaveValue(title)
  await expect(editor.getByLabel('事件备注')).toHaveValue(description)
  await expect(editor.getByRole('textbox', { name: '结束日期' })).toHaveValue('')
  await expect(editor.locator('input[type="file"]')).toHaveCount(0)
  await expect(editor).not.toContainText('还剩 2 天')
  await verifyPeriodFormSpacing(page, testInfo, 'edit')

  await titleInput.fill('未保存的人生阶段名称')
  const cancel = editor.getByRole('button', { name: '取消', exact: true })
  await cancel.press('Enter')
  const discard = page.getByRole('dialog', { name: '放弃未保存的修改？' })
  await expect(discard).toBeVisible()
  await discard.getByRole('button', { name: /^(Cancel|取消)$/ }).click()
  await expect(discard).toBeHidden()
  await expect(titleInput).toHaveValue('未保存的人生阶段名称')
  await cancel.press('Enter')
  await expect(discard).toBeVisible()
  await discard.getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
  await expect(editor).toHaveCount(0)
  await expect(row).toBeFocused()
  await expect(row).toHaveAccessibleName(title)
  await row.click()
  await expect(titleInput).toHaveValue(title)
  await fillDiaryEventDate(page, '结束日期', endDate)
  await expect(page.getByRole('textbox', { name: '结束日期' })).toHaveValue(endDate)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(editor).toHaveCount(0)

  const startCell = calendar.locator(`[data-date="${startDate}"]`)
  await expect(startCell.locator('.life-marker')).toHaveCount(1)
  await page.getByRole('button', { name: '关闭当天事件' }).click()

  const arrows = calendar.locator('.n-calendar-header').getByRole('button')
  const startMonth = `${startDate.slice(0, 7)}-01`
  const interiorMonth = `${interiorDate.slice(0, 7)}-01`
  for (let index = 0; index < monthDistance(startMonth, interiorMonth); index += 1) await arrows.last().click()
  await expect(calendar.locator('.life-month-label')).toHaveText(diaryMonthLabel(interiorDate.slice(0, 7)))
  await expect(calendar.locator(`[data-date="${interiorDate}"] .life-marker`)).toHaveCount(0)

  const endMonth = `${endDate.slice(0, 7)}-01`
  for (let index = 0; index < monthDistance(interiorMonth, endMonth); index += 1) await arrows.last().click()
  await expect(calendar.locator('.life-month-label')).toHaveText(diaryMonthLabel(endDate.slice(0, 7)))
  const endCell = calendar.locator(`[data-date="${endDate}"]`)
  await expect(endCell.locator('.life-marker')).toHaveCount(1)
  await endCell.locator('.life-date-action').click()
  await expect(row).toBeVisible()
  await row.click()
  await expect(titleInput).toHaveValue(title)
  await expect(diaryEventDateInput(page, '开始日期')).toHaveValue(startDate)
  await expect(diaryEventDateInput(page, '结束日期')).toHaveValue(endDate)
  await cancel.click()
  await expect(row).toBeVisible()
  await expect(endCell.locator('.life-date-action')).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: '关闭当天事件' }).click()

  await page.locator('.nav-search').click()
  const search = page.locator('.palette-input input')
  await search.fill(description)
  const searchResult = page.getByRole('option').filter({ hasText: title })
  await expect(searchResult).toBeVisible()
  await searchResult.click()
  await expect(calendar.locator('.life-month-label')).toHaveText(diaryMonthLabel(startDate.slice(0, 7)))
  await expect(row).toHaveAttribute('data-search-highlight', 'event')
  await expect(startCell.locator('.life-date-action')).toHaveAttribute('aria-pressed', 'true')
  await expect(editor).toHaveCount(0)

  await row.click()
  await editor.getByRole('button', { name: '删除事件', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: '删除这条事件？' })
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
  await expect(editor).toHaveCount(0)
  await expect(row).toHaveCount(0)
  await expect(calendar.locator(`[data-date="${startDate}"] .life-marker`)).toHaveCount(0)
})

test('Life Period rows show all duration states without wrapping at narrow widths', async ({ page }, testInfo) => {
  await page.clock.install({ time: new Date('2026-11-28T12:00:00') })
  await page.goto('/diary')
  await unlockDiary(page)

  const longTitle = '人生阶段：一段需要完整记录的长期学习、跨城市生活与工作经历'.repeat(3)
  const periods = [
    { title: longTitle, startDate: '2023-07-01', endDate: '2026-12-13', date: '2026-12-13', label: '已持续 3 年 4 个月 27 天' },
    { title: '未来的人生阶段', startDate: '2026-12-13', endDate: null, date: '2026-12-13', label: '还剩 15 天' },
    { title: '已结束的人生阶段', startDate: '2022-11-27', endDate: '2026-11-27', date: '2026-11-27', label: '持续 4 年' },
  ].map(period => ({ ...period, id: crypto.randomUUID() }))
  await page.evaluate(async periods => {
    const { diaryLifeApi } = await import(new URL('/src/lib/diary-life-api.ts', location.href).href)
    for (const { id, title, startDate, endDate } of periods) {
      const fields: EventFields = {
        type: 'period', title, startDate, endDate, description: '', emoji: '💼',
        startTime: null, endTime: null, allDay: true, recurrence: 'none',
        showCountdown: false, isPrimary: false,
      }
      await diaryLifeApi.saveEvent(id, fields, 0)
    }
  }, periods)
  await page.getByTestId('diary-view-mode-events').click()
  const calendar = page.locator('.diary-life-calendar')
  const cell = (date: string) => calendar.locator(`[data-date="${date}"]`)
  const row = (id: string) => page.locator(`.day-events [data-event-id="${id}"]`)
  const [active, upcoming, ended] = periods

  await expect(cell(ended!.date).locator('.life-marker')).toBeVisible()
  await cell(ended!.date).locator('.life-date-action').click()
  await expect(row(ended!.id).locator('.diary-event-distance')).toHaveText(ended!.label)
  await page.getByRole('button', { name: '关闭当天事件' }).click()
  await calendar.locator('.n-calendar-header').getByRole('button').last().click()
  await expect(cell(upcoming!.date).locator('.life-marker')).toBeVisible()
  await cell(upcoming!.date).locator('.life-date-action').click()
  const activeRow = row(active!.id)
  const title = activeRow.locator('.diary-event-row-title')
  const duration = activeRow.locator('.diary-event-distance')
  await expect(activeRow).toHaveAccessibleName(longTitle)
  await expect(activeRow).toHaveAccessibleDescription(active!.label)
  await expect(duration).toHaveText(active!.label)
  await expect(row(upcoming!.id).locator('.diary-event-distance')).toHaveText(upcoming!.label)

  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 768, height: 1024 },
    { width: 430, height: 900 },
    { width: 390, height: 844 },
    { width: 320, height: 640 },
  ]) {
    await page.setViewportSize(viewport)
    await expect.poll(() => activeRow.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const [rowBox, titleBox, durationBox, upcomingBox] = await Promise.all([
      activeRow.boundingBox(), title.boundingBox(), duration.boundingBox(), row(upcoming!.id).boundingBox(),
    ])
    expect(rowBox!.height).toBe(upcomingBox!.height)
    expect(titleBox!.x + titleBox!.width).toBeLessThan(durationBox!.x)
    expect(durationBox!.x + durationBox!.width).toBeLessThan(rowBox!.x + rowBox!.width)
    expect(await duration.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    if (viewport.width <= 430) {
      expect(await title.evaluate(element => element.scrollWidth > element.clientWidth && getComputedStyle(element).textOverflow === 'ellipsis')).toBe(true)
    }
    if ([1280, 768, 320].includes(viewport.width)) {
      await page.screenshot({ path: testInfo.outputPath(`diary-life-period-list-${viewport.width}.png`), animations: 'disabled' })
    }
  }
})
