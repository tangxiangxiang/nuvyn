import { test, expect } from './fixtures/auth'
import { unlockDiary } from './helpers/diary-life'

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
      const input = page.getByRole('textbox', { name: '记录', exact: true })
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
      await page.getByRole('button', { name: '保存', exact: true }).click()
      await expect(input).toBeHidden()
      if (viewport.width <= 768) await cell.tap()
      else await cell.click()
      await expect(input).toHaveValue(`日记录 ${viewport.width}`)
      await page.getByRole('button', { name: '取消', exact: true }).click()
      await expect(cell.locator('img')).toHaveCount(1)
      const monthBefore = await calendar.locator('.n-calendar-header').innerText()
      await page.getByRole('button', { name: '切换到人生事件' }).click()
      await expect(cell).toHaveAttribute('aria-pressed', 'true')
      await expect(cell.locator('img')).toHaveCount(0)
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
      await cell.click()
      await expect(page.getByRole('button', { name: `人生事件 ${viewport.width}`, exact: true })).toBeVisible()
      await page.reload()
      await unlockDiary(page)
      await expect(page.getByRole('button', { name: '切换到情绪日记' })).toBeVisible()
      await expect(cell.locator('img')).toHaveAttribute('src', /event-goal/)
      await page.screenshot({ path: testInfo.outputPath('diary-calendar.png') })
      expect(await page.locator('.monaco-editor').count()).toBe(0)
      if (viewport.width === 1280) {
        await page.getByRole('region', { name: '倒数日' }).getByRole('button', { name: /人生事件 1280/ }).click()
        await expect(page.getByRole('textbox', { name: '事件标题' })).toHaveValue('人生事件 1280')
        await page.getByRole('button', { name: '删除', exact: true }).click()
        await page.getByRole('dialog', { name: '删除这条记录？' }).getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
        await expect(cell.locator('img')).toHaveCount(0)
      }
    })
  })
}
