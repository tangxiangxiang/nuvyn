import { test, expect } from './fixtures/auth'
import { diaryMonthLabel, fillDiaryEventDate, unlockDiary } from './helpers/diary-life'

const periodAttachment = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\nstartxref\n9\n%%EOF\n')

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

test('Life Period supports endpoint markers, search, event attachments, and responsive details', async ({ page }, testInfo) => {
  testInfo.setTimeout(90_000)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/diary')
  await unlockDiary(page)
  await page.getByTestId('diary-view-mode-events').click()

  const startDate = await page.evaluate(() => {
    const value = new Date()
    value.setDate(value.getDate() + 2)
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
  })
  const endDate = dateAfter(startDate, 400)
  const interiorDate = dateAfter(startDate, 30)
  const title = `人生阶段 ${crypto.randomUUID().slice(0, 8)}`
  const description = `阶段搜索词 ${crypto.randomUUID()}`
  const calendar = page.locator('.diary-life-calendar')

  await calendar.locator(`[data-date="${startDate}"]`).click()
  await page.getByTestId('diary-add-event').click()
  const editor = page.locator('.diary-event-edit-dialog')
  await expect(editor).toBeVisible()
  await page.getByTestId('event-type-period').click()
  await expect(page.getByTestId('event-type-period')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('textbox', { name: '结束日期' })).toHaveValue('')
  await page.getByRole('textbox', { name: '事件名称' }).fill(title)
  await page.getByLabel('事件备注').fill(description)
  const attachmentInput = page.getByTestId('diary-event-attachment-input')
  const attachmentResponsePromise = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname.includes('/api/diary/attachments/events/'))
  await attachmentInput.setInputFiles({
    name: '阶段证明.pdf',
    mimeType: 'application/pdf',
    buffer: periodAttachment,
  })
  const attachmentResponse = await attachmentResponsePromise
  expect(attachmentResponse.ok()).toBe(true)
  await expect(page.getByTestId('diary-attachment-gallery')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('diary-life-period-editor-desktop.png') })

  const saveResponse = page.waitForResponse(response => response.request().method() === 'PUT'
    && new URL(response.url()).pathname.startsWith('/api/diary/life/events/'))
  await page.getByRole('button', { name: '保存', exact: true }).click()
  const response = await saveResponse
  expect(response.ok()).toBe(true)
  const result = await response.json() as { event: { id: string; endDate: string | null; attachments: Array<{ name: string }> } }
  expect(result.event.endDate).toBeNull()
  expect(result.event.attachments.map(attachment => attachment.name)).toEqual(['阶段证明.pdf'])

  const row = page.locator(`.day-events [data-event-id="${result.event.id}"]`)
  await expect(row).toBeVisible()
  await row.click()
  const detail = page.getByTestId('diary-period-detail')
  await expect(detail).toBeVisible()
  await expect(detail.getByRole('heading', { name: title })).toBeVisible()
  await expect(detail.getByRole('button', { name: '下载 阶段证明.pdf' })).toBeVisible()
  await expect(detail.getByTestId('diary-period-duration')).not.toBeEmpty()

  for (const viewport of [
    { width: 320, height: 640 },
    { width: 390, height: 844 },
    { width: 430, height: 900 },
    { width: 768, height: 1024 },
    { width: 1280, height: 900 },
  ]) {
    await page.setViewportSize(viewport)
    const bounds = await page.locator('.diary-period-detail-dialog').boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1)
    expect(bounds!.y).toBeGreaterThanOrEqual(0)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height + 1)
    expect(await detail.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if ([320, 768, 1280].includes(viewport.width)) {
      await page.screenshot({ path: testInfo.outputPath(`diary-life-period-detail-${viewport.width}.png`) })
    }
  }

  await page.getByRole('button', { name: '编辑', exact: true }).click()
  await expect(editor).toBeVisible()
  await expect(page.getByRole('textbox', { name: '结束日期' })).toHaveValue('')
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
  const endpointRow = page.locator(`.day-events [data-event-id="${result.event.id}"]`)
  await expect(endpointRow).toBeVisible()
  await endpointRow.click()
  await expect(detail.getByRole('heading', { name: title })).toBeVisible()
  await page.getByRole('button', { name: '关闭人生阶段详情' }).click()
  await page.getByRole('button', { name: '关闭当天事件' }).click()

  await page.locator('.nav-search').click()
  const search = page.locator('.palette-input input')
  await search.fill(description)
  const searchResult = page.getByRole('option').filter({ hasText: title })
  await expect(searchResult).toBeVisible()
  await searchResult.click()
  await expect(calendar.locator('.life-month-label')).toHaveText(diaryMonthLabel(startDate.slice(0, 7)))
  await expect(detail.getByRole('heading', { name: title })).toBeVisible()
  await expect(detail.locator('[data-testid="diary-attachments"]')).toBeVisible()

  await page.getByRole('button', { name: '删除阶段', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: '删除这条事件？' })
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
  await expect(detail).toHaveCount(0)
  await expect(calendar.locator(`[data-date="${startDate}"] .life-marker`)).toHaveCount(0)
})
