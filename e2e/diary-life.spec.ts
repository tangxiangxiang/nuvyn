import type { Locator } from '@playwright/test'
import { test, expect } from './fixtures/auth'
import { unlockDiary } from './helpers/diary-life'

function dateNumberOffset(cell: Locator) {
  return cell.locator('.life-date-number').evaluate(number => {
    const date = number.closest('.life-date')!.getBoundingClientRect()
    const text = number.getBoundingClientRect()
    return { x: text.x - date.x, y: text.y - date.y }
  })
}

for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1280, height: 800 }]) {
  test.describe(`Diary at ${viewport.width}`, () => {
    test.use({ hasTouch: viewport.width <= 768 })

    test(`Diary life at ${viewport.width}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport)
      if (viewport.width === 390) {
        await page.addInitScript(() => Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined }))
      }
      await page.goto('/diary')
      await unlockDiary(page)
      const calendar = page.locator('.diary-life-calendar')
      await expect(calendar).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      const dayOfMonth = 15 + [390, 768, 1280].indexOf(viewport.width)
      const cell = calendar.locator(`[data-date$="-${dayOfMonth}"]`)
      await cell.focus()
      await cell.press('Enter')
      const addEntry = page.getByTestId('diary-add-entry')
      await expect(addEntry).toBeVisible()
      await addEntry.click()
      const input = page.getByRole('textbox', { name: '第 1 条日记', exact: true })
      await expect(input).toBeVisible()
      await page.getByRole('button', { name: '选择心情' }).click()
      await page.getByTestId('diary-mood-picker').locator('button[data-mood-id]').first().click()
      await input.fill(`日记录 ${viewport.width}`)
      if (viewport.width === 1280) {
        await page.getByRole('button', { name: '取消', exact: true }).click()
        const confirmation = page.getByRole('dialog', { name: '放弃未保存的修改？' })
        await confirmation.getByRole('button', { name: /^(Cancel|取消)$/ }).click()
        await expect(input).toHaveValue(`日记录 ${viewport.width}`)
      }
      await page.getByTestId('diary-save-entry').click()
      await expect(page.getByTestId('diary-edit-entry')).toBeVisible()
      await expect(page.getByTestId('diary-bullet-reader')).toContainText(`日记录 ${viewport.width}`)
      await page.getByRole('button', { name: '关闭日记' }).click()
      if (viewport.width <= 768) await cell.tap()
      else await cell.click()
      await expect(page.getByTestId('diary-edit-entry')).toBeVisible()
      await expect(page.getByTestId('diary-bullet-reader')).toContainText(`日记录 ${viewport.width}`)
      await page.getByTestId('diary-edit-entry').click()
      const reopenedInput = page.getByRole('textbox', { name: '第 1 条日记', exact: true })
      await expect(reopenedInput).toHaveValue(`日记录 ${viewport.width}`)
      await page.getByTestId('diary-cancel-edit').click()
      await expect(reopenedInput).toBeHidden()
      await page.getByRole('button', { name: '关闭日记' }).click()
      await expect(cell.locator('img')).toHaveCount(1)
      const numberBefore = await dateNumberOffset(cell)
      const monthBefore = await calendar.locator('.n-calendar-header').innerText()
      await page.getByRole('button', { name: '切换到人生事件' }).click()
      await expect(cell).toHaveAttribute('aria-pressed', 'true')
      await expect(cell.locator('img')).toHaveCount(0)
      expect(await dateNumberOffset(cell)).toEqual(numberBefore)
      expect(await calendar.locator('.n-calendar-header').innerText()).toBe(monthBefore)
      await cell.click()
      await page.getByRole('button', { name: '新增事件', exact: true }).click()
      await page.getByRole('textbox', { name: '事件标题', exact: true }).fill(`人生事件 ${viewport.width}`)
      if (viewport.width === 1280) {
        await page.getByRole('checkbox', { name: '每年重复' }).click()
        await page.getByRole('checkbox', { name: '显示倒数日' }).click()
      }
      await page.getByRole('button', { name: '保存', exact: true }).click()
      await expect(page.getByRole('textbox', { name: '事件标题', exact: true })).toBeHidden()
      await page.getByTestId('diary-event-list-toggle').click()
      const eventList = page.locator('.diary-event-list-dialog')
      await expect(eventList).toBeVisible()
      await expect(eventList.getByRole('button', { name: new RegExp(`人生事件 ${viewport.width}`) })).toBeVisible()
      await eventList.getByRole('button', { name: new RegExp(`人生事件 ${viewport.width}`) }).click()
      await expect(page.getByRole('textbox', { name: '事件标题', exact: true })).toHaveValue(`人生事件 ${viewport.width}`)
      await page.getByRole('button', { name: '取消', exact: true }).click()
      await cell.click()
      await expect(page.getByRole('button', { name: `人生事件 ${viewport.width}`, exact: true })).toBeVisible()
      await page.reload()
      await unlockDiary(page)
      await expect(page.getByRole('button', { name: '切换到情绪日记' })).toBeVisible()
      await expect(cell.locator('img')).toHaveAttribute('src', /event-goal/)
      await page.screenshot({ path: testInfo.outputPath('diary-calendar.png') })
      expect(await page.locator('.monaco-editor').count()).toBe(0)
      if (viewport.width === 1280) {
        const countdowns = page.getByRole('region', { name: '倒数日' })
        await expect(countdowns).toBeVisible()
        const calendarHeight = (await calendar.boundingBox())!.height
        await page.getByRole('button', { name: '切换到情绪日记' }).click()
        await expect(countdowns).toBeHidden()
        expect((await calendar.boundingBox())!.height).toBe(calendarHeight)
        await page.getByRole('button', { name: '切换到人生事件' }).click()
        await countdowns.getByRole('button', { name: /人生事件 1280/ }).click()
        await expect(page.getByRole('textbox', { name: '事件标题' })).toHaveValue('人生事件 1280')
        await page.getByRole('button', { name: '删除', exact: true }).click()
        await page.getByRole('dialog', { name: '删除这条记录？' }).getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
        await expect(cell.locator('img')).toHaveCount(0)
      }
    })
  })
}

test('text-only Diary days have a calendar marker and preserve bullet editing interactions', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/diary')
  await unlockDiary(page)
  const calendar = page.locator('.diary-life-calendar')
  const cell = calendar.locator('[data-date$="-19"]')
  await cell.click()
  const addEntry = page.getByTestId('diary-add-entry')
  await expect(addEntry).toBeVisible()
  await addEntry.click()
  const first = page.getByRole('textbox', { name: '第 1 条日记' })
  await first.fill('第一条记录')
  await first.press('End')
  await first.press('Enter')
  const second = page.getByRole('textbox', { name: '第 2 条日记' })
  await second.fill('第二条记录')
  await second.press('Shift+Enter')
  await second.type('续写')
  await page.getByTestId('diary-save-entry').click()
  await expect(page.getByTestId('diary-bullet-reader').locator('li')).toHaveCount(2)
  await expect(page.getByTestId('diary-bullet-reader').locator('li').nth(1)).toContainText('第二条记录\n续写')
  await page.getByRole('button', { name: '关闭日记' }).click()
  await expect(cell.locator('.life-entry-marker')).toBeVisible()
})

for (const viewport of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
]) {
  test.describe(`Diary bullet editor at ${viewport.width}px`, () => {
    test.use({ hasTouch: viewport.width <= 768 })

    test('keeps long entries inside the dialog and removes the day from the calendar', async ({ page }) => {
      await page.setViewportSize(viewport)
      await page.goto('/diary')
      await unlockDiary(page)
      const calendar = page.locator('.diary-life-calendar')
      const cell = calendar.locator('[data-date$="-22"]')
      if (viewport.width <= 768) await cell.tap()
      else await cell.click()

      const editButton = page.getByTestId('diary-edit-entry')
      if (await editButton.isVisible()) await editButton.click()

      const editor = page.getByTestId('diary-bullet-editor')
      await expect(editor).toBeVisible()
      const removeButtons = editor.locator('.diary-bullet-remove')
      while (true) {
        const last = removeButtons.last()
        await expect(last).toBeVisible()
        if (await last.isDisabled()) break
        await last.click()
      }

      const longText = '这是一条很长的日记内容用于验证窄屏自动换行'.repeat(24)
      const first = page.getByRole('textbox', { name: '第 1 条日记', exact: true })
      await first.fill(longText)
      await first.press('End')
      await first.press('Enter')
      const second = page.getByRole('textbox', { name: '第 2 条日记', exact: true })
      await second.fill('保留这一条')

      const dialog = page.getByTestId('diary-day-dialog')
      const layout = await dialog.evaluate(node => {
        const editorNode = node.querySelector<HTMLElement>('[data-testid="diary-bullet-editor"]')!
        const row = editorNode.querySelector<HTMLElement>('.diary-bullet-row')!
        const button = row.querySelector<HTMLElement>('.diary-bullet-remove')!
        const dialogBounds = node.getBoundingClientRect()
        const rowBounds = row.getBoundingClientRect()
        const buttonBounds = button.getBoundingClientRect()
        return {
          dialogRight: dialogBounds.right,
          dialogWidth: node.clientWidth,
          dialogScrollWidth: node.scrollWidth,
          editorRight: editorNode.getBoundingClientRect().right,
          rowRight: rowBounds.right,
          buttonRight: buttonBounds.right,
          inputWidth: row.querySelector('textarea')!.getBoundingClientRect().width,
          documentWidth: document.documentElement.scrollWidth,
        }
      })
      expect(layout.dialogRight).toBeLessThanOrEqual(viewport.width + 1)
      expect(layout.dialogScrollWidth).toBeLessThanOrEqual(layout.dialogWidth + 1)
      expect(layout.rowRight).toBeLessThanOrEqual(layout.editorRight + 1)
      expect(layout.buttonRight).toBeLessThanOrEqual(layout.rowRight + 1)
      expect(layout.inputWidth).toBeGreaterThan(100)
      expect(layout.documentWidth).toBeLessThanOrEqual(viewport.width)

      const deleteFirst = page.getByRole('button', { name: '删除第 1 条日记', exact: true })
      if (viewport.width <= 768) await deleteFirst.tap()
      else await deleteFirst.click()
      const remaining = page.getByRole('textbox', { name: '第 1 条日记', exact: true })
      await expect(remaining).toHaveValue('保留这一条')
      await expect(remaining).toBeFocused()
      await page.getByTestId('diary-save-entry').click()
      await expect(page.getByTestId('diary-bullet-reader')).toContainText('保留这一条')
      await page.getByRole('button', { name: '关闭日记' }).click()
      await expect(cell.locator('.life-marker')).toBeVisible()

      if (viewport.width <= 768) await cell.tap()
      else await cell.click()
      await expect(page.getByTestId('diary-delete-entry')).toHaveCount(0)
      await page.getByTestId('diary-edit-entry').click()
      await page.getByTestId('diary-delete-entry').click()
      const confirmation = page.getByRole('dialog', { name: '删除这条记录？' })
      await confirmation.getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
      await expect(cell.locator('.life-marker')).toHaveCount(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    })
  })
}

for (const viewport of [
  { width: 1800, height: 830 },
  { width: 1280, height: 800 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
  { width: 320, height: 568 },
]) {
  test(`calendar layout stays aligned at ${viewport.width}×${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport)
    const english = viewport.width === 1280
    if (!english) await page.addInitScript(() => Object.defineProperty(navigator, 'language', { value: 'zh-CN' }))
    await page.goto('/diary')
    await unlockDiary(page)
    const calendar = page.locator('.diary-life-calendar')
    await expect(calendar).toBeVisible()
    const title = calendar.locator('.life-month')
    const header = calendar.locator('.n-calendar-header')
    const arrows = header.getByRole('button')
    const grid = calendar.locator('.n-calendar-dates')
    const today = calendar.locator('.life-date.today')
    const number = today.locator('.life-date-number')
    const center = (box: { x: number; width: number }) => box.x + box.width / 2
    const calendarBox = (await calendar.boundingBox())!
    const titleBox = (await title.boundingBox())!

    await expect(title).toHaveText(/^\d{4}-\d{2}$/)
    await expect(arrows).toHaveCount(2)
    expect(Math.abs(center(calendarBox) - center(titleBox))).toBeLessThan(1)
    const left = (await arrows.first().boundingBox())!
    const right = (await arrows.last().boundingBox())!
    expect(Math.abs((center(left) + center(right)) / 2 - center(titleBox))).toBeLessThan(1)
    expect([left.width, left.height, right.width, right.height]).toEqual([44, 44, 44, 44])
    await expect(grid).toHaveCSS('border-top-width', '0px')
    await expect(grid.locator('.n-calendar-cell').first()).toHaveCSS('border-bottom-width', '0px')
    expect(await number.evaluate(node => getComputedStyle(node, '::after').width)).toBe('14px')

    const labels = calendar.locator('.life-weekdays span')
    const dates = calendar.locator('.life-date')
    const week = await labels.allTextContents()
    expect(week).toEqual(english
      ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      : ['周一', '周二', '周三', '周四', '周五', '周六', '周日'])
    for (let i = 0; i < 7; i++) {
      const label = (await labels.nth(i).boundingBox())!
      const date = (await dates.nth(i).boundingBox())!
      expect(Math.abs(center(label) - center(date))).toBeLessThan(1)
      const dateKey = await dates.nth(i).getAttribute('data-date')
      expect(new Date(dateKey!).getUTCDay()).toBe((i + (english ? 0 : 1)) % 7)
    }

    const scroll = await page.getByTestId('diary-life').evaluate(node => ({
      horizontal: Math.max(node.scrollWidth - node.clientWidth, document.documentElement.scrollWidth - innerWidth),
      vertical: Math.max(node.scrollHeight - node.clientHeight, document.documentElement.scrollHeight - innerHeight),
    }))
    expect(scroll.horizontal).toBeLessThanOrEqual(0)
    expect(scroll.vertical).toBeLessThanOrEqual(1)
    const monthBefore = await title.innerText()
    const rowHeight = (await dates.first().boundingBox())!.height
    await arrows.last().click()
    await expect(title).not.toHaveText(monthBefore)
    expect((await calendar.boundingBox())!.height).toBe(calendarBox.height)
    expect((await dates.first().boundingBox())!.height).toBeCloseTo(rowHeight, 0)
    await arrows.first().click()
    await expect(title).toHaveText(monthBefore)

    await today.click()
    await page.getByTestId('diary-edit-entry').click()
    await page.getByTestId('diary-cancel-edit').click()
    await expect(page.getByTestId('diary-edit-entry')).toBeVisible()
    await page.getByRole('button', { name: '关闭日记' }).click()
    const numberBefore = await dateNumberOffset(today)
    await page.getByRole('button', { name: '切换到人生事件' }).click()
    await expect(today).toHaveAttribute('aria-pressed', 'true')
    await expect(title).toHaveText(monthBefore)
    expect((await calendar.boundingBox())!.height).toBe(calendarBox.height)
    expect(await dateNumberOffset(today)).toEqual(numberBefore)
    await page.screenshot({ path: testInfo.outputPath('calendar-layout.png') })
  })
}
