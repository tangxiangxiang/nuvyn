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
