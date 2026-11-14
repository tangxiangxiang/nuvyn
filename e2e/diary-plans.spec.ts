import { expect, goBackFromDiaryDocument, test } from './fixtures/diary'
import { CALENDAR_TEST_TIME_ZONE, calendarDay, calendarMoodButton } from './helpers/calendar-clock'

test.use({ timezoneId: CALENDAR_TEST_TIME_ZONE, locale: 'en-US' })

const tomorrow = '2026-08-16'
const post = `/api/posts/diary/${tomorrow}`

test('legacy migration checks status on reload and writes only after backup confirmation', async ({ page }) => {
  let submissions = 0
  let completed = false
  await page.route('**/api/diary/plans/migration-status', route => route.fulfill({ json: {
    hasLegacyPlans: true,
    pending: completed ? 0 : 1,
    completed: completed ? 1 : 0,
    failures: submissions === 1 ? [{ date: tomorrow, code: 'diary-plan-migration-conflict' }] : [],
    hasConflicts: submissions === 1,
  } }))
  await page.route('**/api/diary/plans/migrate?*', async route => {
    expect(route.request().postDataJSON()).toEqual({ backupConfirmed: true })
    submissions++
    completed = submissions === 2
    await route.fulfill({ json: { next: null } })
  })
  await page.goto('/vault')
  const scope = page.locator('.scope-chip').filter({ hasText: /diary/i })
  if (await scope.getAttribute('aria-pressed') !== 'true') await scope.click()
  const entry = page.getByTestId('diary-plan-migration-open')
  await expect(entry).toBeVisible()
  await page.reload()
  await expect(entry).toBeVisible()
  expect(submissions).toBe(0)

  await entry.click()
  const dialog = page.getByRole('dialog', { name: 'Migrate legacy plans' })
  const confirm = dialog.getByRole('checkbox', { name: 'I have completed the backup' })
  const start = dialog.getByRole('button', { name: 'Start migration' })
  await expect(start).toBeDisabled()
  await confirm.check()
  await start.click()
  await expect(dialog.getByText(`${tomorrow} · File generation, document identity, or legacy plan version conflict`)).toBeVisible()
  const retry = dialog.getByRole('button', { name: 'Retry' })
  await expect(retry).toBeDisabled()
  await confirm.check()
  await retry.click()
  await expect(entry).toBeHidden()
  expect(submissions).toBe(2)
})

for (const viewport of [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
]) {
  test.describe(`Diary planning at ${viewport.width}×${viewport.height}`, () => {
    test.use({ hasTouch: viewport.width === 390 })

    test('unified Diary planning and Mood interaction', async ({ page, request }) => {
      await page.setViewportSize(viewport)
      await page.goto('/vault')
      const scope = page.locator('.scope-chip').filter({ hasText: /diary/i })
      if (await scope.getAttribute('aria-pressed') !== 'true') await scope.click()
      const calendar = page.getByTestId('diary-calendar')
      await expect(calendar).toBeVisible()
      const entry = page.locator('.nav-actions').getByRole('button', { name: 'Open plans', exact: true })
      await expect(entry).toHaveText('')
      await expect(entry.locator('svg')).toBeVisible()
      if (viewport.width === 1280) {
        const root = page.locator('html')
        if (await root.getAttribute('data-theme') !== 'dark') await page.locator('.theme-toggle').click()
        await expect(root).toHaveAttribute('data-theme', 'dark')
        await entry.hover()
        await expect(page.getByTestId('diary-calendar-plan-tooltip')).toBeVisible()
        await page.mouse.move(0, 0)
      }
      await entry.focus()
      await page.keyboard.press('Enter')
      const picker = page.getByLabel('Choose a plan date', { exact: true }).filter({ visible: true })
      await expect(picker).toBeVisible()
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width)
      await page.keyboard.press('Escape')
      await expect(entry).toBeFocused()
      await entry.click()
      await picker.fill(tomorrow)
      await page.getByRole('button', { name: 'Open Diary', exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`/vault/diary/${tomorrow}(?:[?#]|$)`))
      await expect(page.getByTestId('diary-day-plan-sheet')).toHaveCount(0)
      const editor = page.getByRole('textbox', { name: 'Editor content' })
      await expect(editor).toBeVisible()
      const before = await (await request.get(post)).json()
      expect(before.metadata.mood).toBeNull()
      const tasks = '\n\n- [ ] Bring materials\n- [x] Send email\n'
      const lines = page.locator('.editor-pane .monaco-editor .view-line')
      await lines.filter({ hasText: tomorrow }).first().click()
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End')
      await page.keyboard.insertText(tasks)
      await expect.poll(async () => (await (await request.get(post)).json()).raw).toContain(tasks.trim())
      await page.getByTestId('view-toggle').click()
      const checkboxes = page.locator('.reading-pane .task-list-item-checkbox')
      await expect(checkboxes).toHaveCount(2)
      await expect(checkboxes.first()).not.toBeChecked()
      await expect(checkboxes.last()).toBeChecked()
      await expect(checkboxes.last()).toBeDisabled()
      await goBackFromDiaryDocument(page)
      await expect(calendar).toBeVisible()
      const moodButton = calendarMoodButton(calendar, tomorrow)
      const marker = moodButton.getByTestId('diary-calendar-plan')
      await expect(marker).toHaveAttribute('src', '/emoji/plan-clipboard.svg')
      const day = calendarDay(calendar, tomorrow)
      await expect(day).toHaveAccessibleName(/1 of 2 plan items completed/)

      const saved = await (await request.get(post)).json()
      const dayHeight = (await day.boundingBox())!.height
      if (viewport.width === 390) await moodButton.tap()
      else {
        await moodButton.focus()
        await page.keyboard.press('Enter')
      }
      const moodPicker = page.getByTestId('diary-mood-picker')
      await expect(moodPicker).toBeVisible()
      await moodPicker.locator('[data-mood-id="happy"]').click()
      await expect(marker).toHaveCount(0)
      await expect(moodButton.locator('img')).toBeVisible()
      await expect(day).toHaveAccessibleName(/1 of 2 plan items completed/)
      expect((await day.boundingBox())!.height).toBe(dayHeight)
      await moodButton.click()
      await moodPicker.getByTestId('diary-mood-clear').click()
      await expect(marker).toBeVisible()
      expect((await (await request.get(post)).json()).raw).toBe(saved.raw)
      expect((await day.boundingBox())!.height).toBe(dayHeight)
      await day.click()
      await expect(checkboxes).toHaveCount(2)
      await page.reload()
      await expect(checkboxes).toHaveCount(2)
    })
  })
}
