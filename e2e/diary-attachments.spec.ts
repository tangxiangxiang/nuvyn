import { test, expect } from './fixtures/auth'
import { unlockDiary } from './helpers/diary-life'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==', 'base64')
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\nstartxref\n9\n%%EOF\n')

test('Diary attachments upload privately, remain linked to the day, preview, and remove', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/diary')
  await unlockDiary(page)

  const cell = page.locator('.diary-life-calendar [data-date$="-27"]')
  await cell.click()
  await page.getByTestId('diary-add-attachment').click()
  await page.getByTestId('diary-attachment-input').setInputFiles([
    { name: 'private-memory.png', mimeType: 'image/png', buffer: png },
    { name: 'private-memory.pdf', mimeType: 'application/pdf', buffer: pdf },
  ])

  const attachments = page.getByTestId('diary-attachments')
  await expect(attachments.getByText('private-memory.png')).toBeVisible()
  await expect(attachments.getByText('private-memory.pdf')).toBeVisible()
  await expect(attachments.getByText('待保存')).toHaveCount(2)
  await page.getByTestId('diary-save-entry').click()
  await expect(page.getByTestId('diary-edit-entry')).toBeVisible()
  await expect(attachments.getByText('private-memory.png')).toBeVisible()
  await expect(cell.locator('.life-entry-marker')).toBeVisible()

  await attachments.getByRole('button', { name: '预览 private-memory.png' }).click()
  await expect(page.getByRole('dialog', { name: 'private-memory.png' })).toBeVisible()
  await page.getByRole('button', { name: '关闭图片预览' }).click()
  const download = page.waitForEvent('download')
  await attachments.getByRole('button', { name: '下载 private-memory.pdf' }).click()
  expect((await download).suggestedFilename()).toBe('private-memory.pdf')
  await page.getByRole('button', { name: '关闭日记' }).click()

  await page.reload()
  await unlockDiary(page)
  await expect(cell.locator('.life-entry-marker')).toBeVisible()
  await cell.click()
  await expect(page.getByTestId('diary-attachments').getByText('private-memory.png')).toBeVisible()
  await expect(page.getByTestId('diary-attachments').getByText('private-memory.pdf')).toBeVisible()
  await page.getByTestId('diary-edit-entry').click()
  await page.getByRole('button', { name: '移除 private-memory.png' }).click()
  await page.getByTestId('diary-cancel-edit').click()
  const discardConfirm = page.getByRole('dialog', { name: '放弃未保存的修改？' })
  await expect(discardConfirm).toBeVisible()
  await discardConfirm.getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
  await expect(page.getByTestId('diary-attachments').getByText('private-memory.png')).toBeVisible()
  await expect(page.getByTestId('diary-attachments').getByText('private-memory.pdf')).toBeVisible()

  await page.getByTestId('diary-edit-entry').click()
  await page.getByRole('button', { name: '移除 private-memory.png' }).click()
  await page.getByRole('button', { name: '移除 private-memory.pdf' }).click()
  await page.getByTestId('diary-save-entry').click()
  const confirm = page.getByRole('dialog', { name: '删除当天记录？' })
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
  await expect(page.getByTestId('diary-day-dialog')).toHaveCount(0)
  await expect(cell.locator('.life-entry-marker')).toHaveCount(0)
})

test('cancelling a Diary edit discards staged attachments and preserves a clean day', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/diary')
  await unlockDiary(page)

  const cell = page.locator('.diary-life-calendar [data-date$="-28"]')
  await cell.click()
  await page.getByTestId('diary-add-attachment').click()
  await page.getByTestId('diary-attachment-input').setInputFiles({
    name: 'discarded.png',
    mimeType: 'image/png',
    buffer: png,
  })
  const attachments = page.getByTestId('diary-attachments')
  await expect(attachments.getByText('discarded.png')).toBeVisible()
  await page.getByTestId('diary-cancel-edit').click()
  const confirm = page.getByRole('dialog', { name: '放弃未保存的修改？' })
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
  await expect(page.getByTestId('diary-day-dialog')).toHaveCount(0)

  await cell.click()
  await expect(page.getByTestId('diary-attachments').getByText('discarded.png')).toHaveCount(0)
  await expect(cell.locator('.life-entry-marker')).toHaveCount(0)
})

test('attachment tiles stay within the Diary sheet on desktop, tablet and narrow mobile widths', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/diary')
  await unlockDiary(page)

  const cell = page.locator('.diary-life-calendar [data-date$="-29"]')
  await cell.click()
  await page.getByTestId('diary-add-attachment').click()
  const name = `${'long-private-memory-'.repeat(4)}.png`
  await page.getByTestId('diary-attachment-input').setInputFiles({
    name,
    mimeType: 'image/png',
    buffer: png,
  })
  await expect(page.getByTestId('diary-attachments').getByText(name)).toBeVisible()
  await page.getByTestId('diary-save-entry').click()

  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(viewport)
    const layout = await page.getByTestId('diary-attachments').evaluate(element => {
      const grid = element.querySelector('.diary-attachment-grid')
      return {
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
        rootScrollWidth: document.documentElement.scrollWidth,
        columns: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0,
      }
    })
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width)
    expect(layout.rootScrollWidth).toBeLessThanOrEqual(viewport.width)
    expect(layout.columns).toBe(viewport.width <= 600 ? 2 : 3)
  }

  await page.getByTestId('diary-edit-entry').click()
  await page.getByRole('button', { name: `移除 ${name}` }).click()
  await page.getByTestId('diary-save-entry').click()
  const confirm = page.getByRole('dialog', { name: '删除当天记录？' })
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
  await expect(page.getByTestId('diary-day-dialog')).toHaveCount(0)
})
