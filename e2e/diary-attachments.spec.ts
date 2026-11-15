import type { Page } from '@playwright/test'
import { test, expect } from './fixtures/auth'
import { chooseDiaryAction, chooseDiaryDayAction, openEmptyDiaryDay, saveDiaryDay, unlockDiary } from './helpers/diary-life'

test.beforeEach(async ({ page }, testInfo) => {
  // Keep attachment fixtures separate from the Diary life spec, including repeats.
  await page.clock.setFixedTime(new Date(2024 + testInfo.repeatEachIndex, 2, 10, 12))
})

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==', 'base64')
const attachmentMenu = (page: Page, name: string) => page.getByRole('button', { name: `${name} 的操作`, exact: true })
const entryMenu = (page: Page, index: number) => page.getByRole('button', { name: `第 ${index} 条日记的操作`, exact: true })

async function addEntryImages(page: Page, index: number, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  const chooser = page.waitForEvent('filechooser')
  await chooseDiaryAction(page, entryMenu(page, index), '添加图片')
  await (await chooser).setFiles(files)
}

async function chooseAttachments(page: Page, touch = false) {
  const chooser = page.waitForEvent('filechooser')
  await chooseDiaryDayAction(page, '添加附件', touch)
  return chooser
}

const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\nstartxref\n9\n%%EOF\n')

test('Diary attachments upload privately, remain linked to the day, preview, and remove', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined }))
  await page.goto('/diary')
  await unlockDiary(page)

  const cell = page.locator('.diary-life-calendar [data-date$="-03-27"]')
  await Promise.all([
    page.waitForResponse(response => response.url().includes('/api/diary/attachments/sessions/') && response.url().endsWith('/heartbeat') && response.status() === 204),
    openEmptyDiaryDay(page, cell),
  ])
  await expect(page.getByTestId('diary-add-attachment')).toHaveCount(0)
  await (await chooseAttachments(page)).setFiles([
    { name: 'private-memory.png', mimeType: 'image/png', buffer: png },
    { name: 'private-memory.pdf', mimeType: 'application/pdf', buffer: pdf },
  ])
  await expect(page.getByTestId('diary-add-attachment')).toHaveCount(0)

  const attachments = page.getByTestId('diary-attachments')
  await expect(attachments.getByRole('button', { name: '预览 private-memory.png' })).toBeVisible()
  await expect(attachments.getByText('private-memory.png')).toHaveCount(0)
  await expect(attachments.getByText('private-memory.pdf')).toBeVisible()
  await expect(attachments.getByText('待保存')).toHaveCount(1)
  await expect(attachments.getByRole('img', { name: 'private-memory.png' })).toHaveAttribute('src', /^blob:/)
  const protectedImageRead = page.waitForResponse(response => response.url().includes(`/api/diary/attachments/`) && response.url().endsWith('/content') && response.status() === 200)
  await saveDiaryDay(page)
  await protectedImageRead
  await expect(page.getByTestId('diary-edit-entry')).toBeVisible()
  await expect(attachments.getByRole('button', { name: '预览 private-memory.png' })).toBeVisible()
  const imageCard = attachments.locator('.diary-attachment-item').nth(0)
  const pdfCard = attachments.locator('.diary-attachment-item').nth(1)
  await expect(imageCard.locator('.diary-attachment-meta')).toHaveCount(0)
  await expect(pdfCard.locator('.diary-attachment-name')).toHaveText('private-memory.pdf')
  await expect(pdfCard.locator('small')).toHaveCount(0)
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
  await expect(page.getByTestId('diary-attachments').getByRole('button', { name: '预览 private-memory.png' })).toBeVisible()
  await expect(page.getByTestId('diary-attachments').getByText('private-memory.pdf')).toBeVisible()
  await page.getByTestId('diary-edit-entry').click()
  await page.getByRole('button', { name: '预览 private-memory.png' }).hover()
  await chooseDiaryAction(page, attachmentMenu(page, 'private-memory.png'), '移除图片')
  await page.getByTestId('diary-cancel-edit').click()
  const discardConfirm = page.getByRole('dialog', { name: '放弃未保存的修改？' })
  await expect(discardConfirm).toBeVisible()
  await discardConfirm.getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
  await expect(page.getByTestId('diary-attachments').getByRole('button', { name: '预览 private-memory.png' })).toBeVisible()
  await expect(page.getByTestId('diary-attachments').getByText('private-memory.pdf')).toBeVisible()

  await page.getByTestId('diary-edit-entry').click()
  await page.getByRole('button', { name: '预览 private-memory.png' }).hover()
  await chooseDiaryAction(page, attachmentMenu(page, 'private-memory.png'), '移除图片')
  await page.getByRole('button', { name: '下载 private-memory.pdf' }).hover()
  await chooseDiaryAction(page, attachmentMenu(page, 'private-memory.pdf'), '移除附件')
  await saveDiaryDay(page)
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

  const cell = page.locator('.diary-life-calendar [data-date$="-03-28"]')
  await openEmptyDiaryDay(page, cell)
  await (await chooseAttachments(page)).setFiles({
    name: 'discarded.png',
    mimeType: 'image/png',
    buffer: png,
  })
  const attachments = page.getByTestId('diary-attachments')
  await expect(attachments.getByRole('button', { name: '预览 discarded.png' })).toBeVisible()
  await page.getByTestId('diary-cancel-edit').click()
  const confirm = page.getByRole('dialog', { name: '放弃未保存的修改？' })
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
  await expect(page.getByTestId('diary-day-dialog')).toHaveCount(0)

  await cell.click()
  await expect(page.getByTestId('diary-attachments').getByRole('button', { name: '预览 discarded.png' })).toHaveCount(0)
  await expect(cell.locator('.life-entry-marker')).toHaveCount(0)
})

test('attachment tiles stay within the Diary sheet on desktop, tablet and narrow mobile widths', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/diary')
  await unlockDiary(page)

  const cell = page.locator('.diary-life-calendar [data-date$="-03-29"]')
  await openEmptyDiaryDay(page, cell)
  const name = `${'long-private-memory-'.repeat(4)}.png`
  await (await chooseAttachments(page)).setFiles({
    name,
    mimeType: 'image/png',
    buffer: png,
  })
  await expect(page.getByTestId('diary-attachments').getByRole('button', { name: `预览 ${name}` })).toBeVisible()
  await saveDiaryDay(page)

  const attachmentCard = page.getByTestId('diary-attachments').locator('.diary-attachment-item')
  const dialog = page.getByTestId('diary-day-dialog')
  await expect(attachmentCard.locator('.diary-attachment-actions')).toHaveCount(0)
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 601, height: 800 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(viewport)
    const phone = viewport.width <= 600
    const expectedWidth = phone ? viewport.width : Math.min(640, viewport.width - 32)
    await expect(dialog).toHaveCSS('width', `${expectedWidth}px`)
    const bounds = (await dialog.boundingBox())!
    expect(bounds.x).toBeCloseTo((viewport.width - expectedWidth) / 2, 0)
    if (phone) expect(bounds.y + bounds.height).toBeCloseTo(viewport.height, 0)
    const layout = await page.getByTestId('diary-attachments').evaluate(element => {
      const grid = element.querySelector('.diary-attachment-grid')
      return {
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
        rootScrollWidth: document.documentElement.scrollWidth,
        columns: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0,
        firstCardWidth: grid?.querySelector('.diary-attachment-item')?.getBoundingClientRect().width ?? 0,
      }
    })
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width)
    expect(layout.rootScrollWidth).toBeLessThanOrEqual(viewport.width)
    expect(layout.columns).toBe(1)
    expect(layout.firstCardWidth).toBe(phone ? 144 : 176)
  }

  await page.getByTestId('diary-edit-entry').click()
  const menuTrigger = attachmentMenu(page, name)
  const remove = attachmentCard.locator('.diary-attachment-actions')
  const cardBounds = await attachmentCard.boundingBox()
  const removeBounds = await remove.boundingBox()
  expect(cardBounds).not.toBeNull()
  expect(removeBounds).not.toBeNull()
  expect(removeBounds!.x).toBeGreaterThanOrEqual(cardBounds!.x)
  expect(removeBounds!.y).toBeGreaterThanOrEqual(cardBounds!.y)
  expect(removeBounds!.x + removeBounds!.width).toBeLessThanOrEqual(cardBounds!.x + cardBounds!.width)
  expect(removeBounds!.y + removeBounds!.height).toBeLessThanOrEqual(cardBounds!.y + cardBounds!.height)

  await page.mouse.move(0, 0)
  await expect(remove).toHaveCSS('opacity', '0')
  await attachmentCard.hover()
  await expect(remove).toHaveCSS('opacity', '1')
  await menuTrigger.focus()
  await expect(remove).toHaveCSS('opacity', '1')
  await chooseDiaryAction(page, menuTrigger, '移除图片')
  await saveDiaryDay(page)
  const confirm = page.getByRole('dialog', { name: '删除当天记录？' })
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
  await expect(page.getByTestId('diary-day-dialog')).toHaveCount(0)
})

test.describe('Diary attachment touch controls', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })

  test('keeps the remove action visible and tappable without hover', async ({ page }) => {
    await page.goto('/diary')
    await unlockDiary(page)
    const cell = page.locator('.diary-life-calendar [data-date$="-03-30"]')
    await openEmptyDiaryDay(page, cell)
    await (await chooseAttachments(page, true)).setFiles({
      name: 'touch-remove.png',
      mimeType: 'image/png',
      buffer: png,
    })

    const card = page.getByTestId('diary-attachments').locator('.diary-attachment-item')
    const remove = card.locator('.diary-attachment-actions')
    await expect(card).toBeVisible()
    await expect(remove).toHaveCSS('opacity', '1')
    expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true)
    await chooseDiaryAction(page, attachmentMenu(page, 'touch-remove.png'), '移除图片', true)
    await expect(card).toHaveCount(0)
  })
})

test('Diary entries keep photo groups attached through movement, refresh, cancellation and entry deletion', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/diary')
  await unlockDiary(page)

  const cell = page.locator('.diary-life-calendar [data-date$="-03-21"]')
  await openEmptyDiaryDay(page, cell)
  await chooseDiaryDayAction(page, '添加一条')
  const first = page.getByRole('textbox', { name: '第 1 条日记', exact: true })
  await first.fill('早餐\n今天早上吃了南瓜饼，记录食物的味道和当时的感受。')
  await chooseDiaryDayAction(page, '添加一条')
  const second = page.getByRole('textbox', { name: '第 2 条日记', exact: true })
  await second.fill('学习')

  const firstRow = page.locator('.diary-bullet-editor li').nth(0)
  const secondRow = page.locator('.diary-bullet-editor li').nth(1)
  await expect(page.getByTestId('diary-entry-image-input')).toHaveCount(1)
  await expect(page.getByTestId('diary-add-entry-image')).toHaveCount(0)
  await expect(page.getByTestId('diary-add-attachment')).toHaveCount(0)
  const firstEntryId = await firstRow.getAttribute('data-entry-id')
  const secondEntryId = await secondRow.getAttribute('data-entry-id')
  expect(firstEntryId).toBeTruthy()
  expect(secondEntryId).toBeTruthy()
  const breakfastImages = Array.from({ length: 10 }, (_, index) => ({
    name: `breakfast-${index + 1}.png`, mimeType: 'image/png', buffer: png,
  }))
  await page.setViewportSize({ width: 1440, height: 900 })
  for (const count of [3, 6, 9]) {
    await addEntryImages(page, 1, breakfastImages.slice(count - 3, count))
    const tiles = firstRow.locator('.diary-attachment-item')
    await expect(tiles).toHaveCount(count)
    const rows = await tiles.evaluateAll(items => {
      const rowWidths = new Map<number, number>()
      for (const tile of items) {
        const { top } = tile.getBoundingClientRect()
        rowWidths.set(top, (rowWidths.get(top) ?? 0) + 1)
      }
      return [...rowWidths.values()]
    })
    expect(rows).toEqual(Array(count / 3).fill(3))
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(firstRow.locator('.diary-attachment-grid')).toHaveCount(1)
  await addEntryImages(page, 1, breakfastImages.slice(9))
  await expect(firstRow.locator('.diary-attachment-grid')).toHaveCount(2)
  await expect(firstRow.locator('.diary-attachment-grid').nth(0).locator('.diary-attachment-item')).toHaveCount(9)
  await expect(firstRow.locator('.diary-attachment-grid').nth(1).locator('.diary-attachment-item')).toHaveCount(1)

  await addEntryImages(page, 2, [{ name: 'study.png', mimeType: 'image/png', buffer: png }])
  await expect(secondRow.locator('.diary-attachment-item')).toHaveCount(1)
  await page.setViewportSize({ width: 320, height: 568 })
  const studyMenu = attachmentMenu(page, 'study.png')
  await studyMenu.click()
  const popup = page.getByRole('menu', { name: 'study.png 的操作' })
  const moveToBreakfast = popup.getByRole('menuitem', { name: '移动到第 1 行后', exact: true })
  await expect(moveToBreakfast).toBeVisible()
  const popupBounds = (await popup.boundingBox())!
  expect(popupBounds.x).toBeGreaterThanOrEqual(0)
  expect(popupBounds.x + popupBounds.width).toBeLessThanOrEqual(320)
  await expect.poll(() => moveToBreakfast.evaluate(option => {
    const { left, top, height } = option.getBoundingClientRect()
    return option.contains(document.elementFromPoint(left + 4, top + height / 2))
  })).toBe(true)
  await page.keyboard.press('Escape')
  await expect(popup).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await chooseDiaryAction(page, attachmentMenu(page, 'breakfast-1.png'), '移动到第 2 行后')
  await expect(firstRow.locator('.diary-attachment-item')).toHaveCount(9)
  await expect(secondRow.locator('.diary-attachment-item')).toHaveCount(2)
  const lastTile = secondRow.getByRole('button', { name: '预览 breakfast-1.png' })
  await lastTile.scrollIntoViewIfNeeded()
  const lastTileBounds = (await lastTile.boundingBox())!
  const scroller = page.locator('.diary-day-dialog-card .n-card__content-scrollbar .n-scrollbar-container')
  const scrollBounds = (await scroller.boundingBox())!
  expect(lastTileBounds.y).toBeGreaterThanOrEqual(0)
  expect(lastTileBounds.y + lastTileBounds.height).toBeLessThanOrEqual(scrollBounds.y + scrollBounds.height)
  await saveDiaryDay(page)

  let reader = page.getByTestId('diary-bullet-reader')
  let firstReadRow = reader.locator('li').nth(0)
  let secondReadRow = reader.locator('li').nth(1)
  await expect(reader).toHaveCSS('list-style-type', 'none')
  await expect(reader).toHaveCSS('padding-inline-start', '0px')
  await expect(firstReadRow.locator('.diary-attachment-item')).toHaveCount(9)
  await expect(secondReadRow.locator('.diary-attachment-item')).toHaveCount(2)
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 430, height: 844 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(viewport)
    const gallery = firstReadRow.locator('.diary-attachment-grid').first()
    const layout = await gallery.evaluate(node => ({
      width: node.clientWidth,
      scrollWidth: node.scrollWidth,
      columns: getComputedStyle(node).gridTemplateColumns.split(' ').length,
      cardWidths: Array.from(node.querySelectorAll('.diary-attachment-item'), item => item.getBoundingClientRect().width),
      rootScrollWidth: document.documentElement.scrollWidth,
    }))
    expect(layout.columns).toBe(3)
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width)
    expect(layout.rootScrollWidth).toBeLessThanOrEqual(viewport.width)
    expect(layout.cardWidths).toHaveLength(8)
    expect(layout.cardWidths.every(width => width > 0 && width < layout.width)).toBe(true)

    const bulletLayout = await reader.evaluate(node => {
      const firstItem = node.querySelector('li')!
      const text = firstItem.querySelector<HTMLElement>('.diary-bullet-reader-text')!
      const gallery = firstItem.querySelector<HTMLElement>('.diary-attachment-section')!
      const listStyle = getComputedStyle(node)
      const listBounds = node.getBoundingClientRect()
      const textBounds = text.getBoundingClientRect()
      const galleryBounds = gallery.getBoundingClientRect()
      return {
        scrollWidth: node.scrollWidth,
        width: node.clientWidth,
        textOffset: textBounds.left - listBounds.left,
        expectedTextOffset: Number.parseFloat(listStyle.paddingInlineStart),
        textHeight: textBounds.height,
        galleryOffset: galleryBounds.left - textBounds.left,
        galleryTop: galleryBounds.top,
        textBottom: textBounds.bottom,
      }
    })
    expect(bulletLayout.scrollWidth).toBeLessThanOrEqual(bulletLayout.width)
    expect(bulletLayout.textOffset).toBeGreaterThanOrEqual(bulletLayout.expectedTextOffset - 1)
    expect(bulletLayout.textHeight).toBeGreaterThan(16)
    expect(Math.abs(bulletLayout.galleryOffset)).toBeLessThanOrEqual(1)
    expect(bulletLayout.galleryTop).toBeGreaterThanOrEqual(bulletLayout.textBottom)
  }
  await page.getByRole('button', { name: '关闭日记' }).click()
  await page.reload()
  await unlockDiary(page)
  await cell.click()
  reader = page.getByTestId('diary-bullet-reader')
  firstReadRow = reader.locator('li').nth(0)
  secondReadRow = reader.locator('li').nth(1)
  await expect(firstReadRow.locator('.diary-attachment-item')).toHaveCount(9)
  await expect(secondReadRow.locator('.diary-attachment-item')).toHaveCount(2)

  await page.getByTestId('diary-edit-entry').click()
  await chooseDiaryAction(page, attachmentMenu(page, 'breakfast-2.png'), '移动到日记末尾')
  await page.getByTestId('diary-cancel-edit').click()
  const discard = page.getByRole('dialog', { name: '放弃未保存的修改？' })
  await expect(discard).toBeVisible()
  await discard.getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
  await expect(page.getByTestId('diary-bullet-reader').locator('li').nth(0).locator('.diary-attachment-item')).toHaveCount(9)
  await expect(page.getByTestId('diary-bullet-reader').locator('li').nth(1).locator('.diary-attachment-item')).toHaveCount(2)

  await page.getByTestId('diary-edit-entry').click()
  await chooseDiaryAction(page, entryMenu(page, 1), '删除此条')
  await saveDiaryDay(page)
  reader = page.getByTestId('diary-bullet-reader')
  await expect(reader.locator('li')).toHaveCount(1)
  await expect(reader.locator('li').nth(0).locator('.diary-attachment-item')).toHaveCount(2)
  await expect(page.getByTestId('diary-attachments').locator('.diary-attachment-item')).toHaveCount(11)
  await page.getByRole('button', { name: '关闭日记' }).click()
  await page.reload()
  await unlockDiary(page)
  await cell.click()
  reader = page.getByTestId('diary-bullet-reader')
  await expect(reader.locator('li')).toHaveCount(1)
  await expect(reader.locator('li').nth(0).locator('.diary-attachment-item')).toHaveCount(2)
  await expect(page.getByTestId('diary-attachments').locator('.diary-attachment-item')).toHaveCount(11)
})
