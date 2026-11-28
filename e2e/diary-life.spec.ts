import type { Locator, Page } from '@playwright/test'
import { test, expect } from './fixtures/auth'
import { chooseDiaryAction, chooseDiaryDayAction, diaryEventDateInput, fillDiaryEventDate, diaryMonthLabel, openEmptyDiaryDay, saveDiaryDay, selectNaiveOption, unlockDiary } from './helpers/diary-life'
import { lunarToSolar } from '../shared/lunarCalendar'

const scrollTestImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==', 'base64')
const diaryLifeFixtureBaseYear = 1000 + Math.floor(Math.random() * 700)

function diaryLifeFixtureYear(testInfo: { repeatEachIndex: number; retry: number; project: { retries: number } }) {
  return diaryLifeFixtureBaseYear + testInfo.repeatEachIndex * (testInfo.project.retries + 1) + testInfo.retry
}

test.beforeEach(async ({ page }, testInfo) => {
  // Keep the browser's wall clock advancing. Vue uses Date.now() to decide
  // whether a bubbling event predates a listener; a frozen timestamp can make
  // the calendar's child click handlers discard real clicks.
  const time = testInfo.title === 'lunar Events preserve their rule across countdowns, editing and calendar dates'
    || testInfo.title === 'creates lunar and Gregorian birthdays without guessing the birth year'
    || testInfo.title === 'keeps a single-date milestone on its edited date without annual repetition'
    || testInfo.title === 'Diary selected day Event distance stays on one line across viewport widths'
    || testInfo.title === 'clears the date highlight on Escape after opening with a pointer'
    ? new Date('2026-11-16T12:00:00+08:00')
    : testInfo.title === 'closes the Diary reading dialog without selecting another date'
      ? new Date(diaryLifeFixtureYear(testInfo), 0, 20, 12)
      : testInfo.title === 'uses the server day boundary and enables editing after midnight without reopening'
      ? new Date(diaryLifeFixtureYear(testInfo), 0, 29, 12)
      : new Date(diaryLifeFixtureYear(testInfo), 0, 10, 12)
  await page.clock.install({ time })
})

function dateNumberOffset(cell: Locator) {
  return cell.locator('.life-date-number').evaluate(number => {
    const date = number.closest('.life-date')!.getBoundingClientRect()
    const text = number.getBoundingClientRect()
    return { x: text.x - date.x, y: text.y - date.y }
  })
}

async function tapCalendarDateUnderBackdrop(page: Page) {
  const point = await page.evaluate(() => {
    const card = document.querySelector<HTMLElement>('.diary-life-dialog')
    if (!card) return null
    const cardBounds = card.getBoundingClientRect()
    for (const button of document.querySelectorAll<HTMLElement>('.diary-life-calendar .life-date-action[aria-pressed="false"]')) {
      const cell = button.closest<HTMLElement>('.life-date')
      if (!cell) continue
      const bounds = cell.getBoundingClientRect()
      const x = bounds.left + bounds.width / 2
      const y = bounds.top + bounds.height / 2
      const hit = document.elementFromPoint(x, y)
      const outsideCard = !hit?.closest('.diary-life-dialog')
      const ownedByModal = Boolean(hit?.closest('.n-modal-container'))
      if (y < cardBounds.top && x >= 0 && x < innerWidth && y >= 0 && y < innerHeight && outsideCard && ownedByModal) {
        return { date: cell.dataset.date, x, y }
      }
    }
    return null
  })
  expect(point, 'a visible calendar date should be covered by the modal backdrop').not.toBeNull()
  await page.touchscreen.tap(point!.x, point!.y)
  return page.locator(`.diary-life-calendar .life-date[data-date="${point!.date}"] .life-date-action`)
}

async function expectDiaryContentUnclipped(scroller: Locator, content: Locator) {
  await expect(content).toBeInViewport({ ratio: 0.99 })
  await expect.poll(async () => {
    const [body, target] = await Promise.all([scroller.boundingBox(), content.boundingBox()])
    if (!body || !target) return false
    return target.y >= body.y - 1 && target.y + target.height <= body.y + body.height + 1
      && target.x >= body.x - 1 && target.x + target.width <= body.x + body.width + 1
  }).toBe(true)
}

async function expectDiaryTextareaAutoSized(textarea: Locator, expectedValue?: string) {
  await expect.poll(() => textarea.evaluate(node => node.scrollHeight - node.clientHeight)).toBeLessThanOrEqual(1)
  await expect.poll(() => textarea.evaluate(node => (
    Math.abs(parseFloat(node.style.height) - node.scrollHeight)
  ))).toBeLessThanOrEqual(1)
  if (expectedValue !== undefined) await expect(textarea).toHaveValue(expectedValue)
}

async function expectDiaryScrollbarsHidden(dialog: Locator, scroller: Locator) {
  await expect(scroller).toHaveCSS('scrollbar-width', 'none')
  expect(await scroller.evaluate(node => getComputedStyle(node, '::-webkit-scrollbar').display)).toBe('none')
  const rail = dialog.locator('.n-card__content-scrollbar > .n-scrollbar-rail--vertical')
  await expect(rail).toHaveCSS('display', 'none')
  await expect(rail.locator('.n-scrollbar-rail__scrollbar')).toBeHidden()
}

async function readStableHoverColors(button: Locator) {
  return button.evaluate(element => new Promise<string[]>((resolve) => {
    let previous = ''
    let stableFrames = 0
    const sample = () => {
      const style = getComputedStyle(element)
      const values = [style.color, style.backgroundColor, style.borderColor]
      const current = JSON.stringify(values)
      stableFrames = current === previous ? stableFrames + 1 : 0
      previous = current
      if (stableFrames >= 2) resolve(values)
      else requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  }))
}

async function expectDiaryGlassModal(page: Page, dialog: Locator) {
  await expect(dialog).toHaveCSS('backdrop-filter', /blur\(18px\)/)
  const modalContainer = page.locator('.n-modal-container').filter({ has: dialog })
  await expect(modalContainer.locator(':scope > .n-modal-mask')).toHaveCSS('backdrop-filter', /blur\(8px\)/)
}

async function expectDiaryCanScrollToEnd(page: Page, dialog: Locator, lastEntry: Locator, lastImage: Locator, touch: boolean) {
  const scroller = dialog.locator('.n-card__content-scrollbar > .n-scrollbar-container')
  await expect(scroller).toHaveCSS('overflow-y', /^(auto|scroll)$/)
  await expect.poll(() => scroller.evaluate(node => node.scrollHeight - node.clientHeight)).toBeGreaterThan(0)
  await expect(dialog).toBeInViewport({ ratio: 0.99 })
  expect(await scroller.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

  await scroller.evaluate(node => { node.scrollTop = 0 })
  await expect(lastEntry).not.toBeInViewport()
  await expect(lastImage).not.toBeInViewport()
  const horizontalLayout = () => lastImage.evaluate(node => {
    const { left, width } = node.getBoundingClientRect()
    return { left, width }
  })
  const beforeScroll = await horizontalLayout()
  await expectDiaryScrollbarsHidden(dialog, scroller)
  if (touch) {
    const bounds = await scroller.boundingBox()
    if (!bounds) throw new Error('Diary scroll container has no bounds')
    const touchPoint = { x: bounds.x + 8, y: bounds.y + bounds.height * 0.72 }
    const hit = await page.evaluate(({ x, y }) => {
      const container = document.querySelector('.diary-day-dialog-card .n-card__content-scrollbar > .n-scrollbar-container')
      const target = document.elementFromPoint(x, y)
      return {
        insideScroller: Boolean(container && target && container.contains(target)),
        overflowY: container ? getComputedStyle(container).overflowY : '',
        touchAction: container ? getComputedStyle(container).touchAction : '',
      }
    }, touchPoint)
    expect(hit.insideScroller).toBe(true)
    expect(hit.overflowY).toMatch(/^(auto|scroll)$/)
    expect(hit.touchAction).not.toBe('none')
    const browser = await page.context().newCDPSession(page)
    try {
      const points = [0, 1, 2, 3, 4, 5].map(step => ({
        x: touchPoint.x,
        y: touchPoint.y - step * Math.min(24, bounds.height / 16),
        id: 1,
      }))
      await browser.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [points[0]] })
      for (const point of points.slice(1)) {
        await browser.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point] })
      }
      await browser.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBeGreaterThan(0)
    } finally {
      await browser.detach()
    }
    await scroller.evaluate(node => { node.scrollTop = node.scrollHeight })
  } else {
    await scroller.hover()
    await page.mouse.wheel(0, await scroller.evaluate(node => node.scrollHeight))
  }
  await expect.poll(() => scroller.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop))
    .toBeLessThanOrEqual(1)
  await expectDiaryContentUnclipped(scroller, lastEntry)
  await expectDiaryContentUnclipped(scroller, lastImage)
  expect(await horizontalLayout()).toEqual(beforeScroll)
  await expectDiaryScrollbarsHidden(dialog, scroller)
}

for (const width of [390, 430]) {
  test.describe(`Diary mobile backdrop at ${width}px`, () => {
    test.use({ isMobile: true, hasTouch: true, viewport: { width, height: 844 } })

    test('closes the day events dialog without opening the date under the same touch', async ({ page }) => {
      await page.goto('/diary')
      await unlockDiary(page)
      await page.getByRole('button', { name: '事件视图' }).tap()

      const selectedDate = page.locator('.diary-life-calendar .life-date[data-date$="-01-10"]')
      await expect(selectedDate).toBeVisible()
      await selectedDate.tap()
      const dialog = page.locator('.diary-life-dialog')
      await expect(dialog).toBeVisible()
      await dialog.locator('.n-card-header').tap()
      await expect(dialog).toBeVisible()

      const backgroundDate = await tapCalendarDateUnderBackdrop(page)
      await expect(dialog).toHaveCount(0)
      await expect(backgroundDate).toHaveAttribute('aria-pressed', 'false')
      await expect(page.locator('.diary-life-dialog')).toHaveCount(0)

      for (let iteration = 0; iteration < 3; iteration += 1) {
        await selectedDate.tap()
        await expect(dialog).toBeVisible()
        await dialog.getByRole('button', { name: '关闭当天事件' }).tap()
        await expect(dialog).toHaveCount(0)
      }
    })

    test('closes the Diary reading dialog without selecting another date', async ({ page }) => {
      await page.goto('/diary')
      await unlockDiary(page)

      const day = width === 390 ? '12' : '13'
      const cell = page.locator(`.diary-life-calendar .life-date[data-date$="-01-${day}"]`)
      await openEmptyDiaryDay(page, cell, () => cell.click())
      await page.getByRole('textbox', { name: '第 1 条日记', exact: true }).fill(`触摸遮罩日记 ${width}`)
      await saveDiaryDay(page)
      await page.getByRole('button', { name: '关闭日记' }).tap()
      await expect(page.getByTestId('diary-day-dialog')).toHaveCount(0)

      await cell.click()
      const dialog = page.getByTestId('diary-day-dialog')
      await expect(dialog).toBeVisible()
      await dialog.locator('.diary-day-heading').tap()
      await expect(dialog).toBeVisible()
      const backgroundDate = await tapCalendarDateUnderBackdrop(page)
      await expect(dialog).toHaveCount(0)
      await expect(backgroundDate).toHaveAttribute('aria-pressed', 'false')
      await expect(page.getByTestId('diary-day-dialog')).toHaveCount(0)
    })

    test('keeps a dirty Event draft when backdrop close is cancelled', async ({ page }) => {
      await page.goto('/diary')
      await unlockDiary(page)
      await page.getByRole('button', { name: '事件视图' }).tap()

      const selectedDate = page.locator('.diary-life-calendar .life-date[data-date$="-01-10"]')
      await selectedDate.tap()
      await page.getByTestId('diary-add-event').tap()
      const title = page.getByRole('textbox', { name: '事件名称', exact: true })
      await title.fill(`保留草稿 ${width}`)
      await page.touchscreen.tap(width / 2, 8)

      const confirmation = page.getByRole('dialog', { name: '放弃未保存的修改？' })
      await expect(confirmation).toBeVisible()
      await confirmation.getByRole('button', { name: /^(Cancel|取消)$/ }).tap()
      await expect(title).toHaveValue(`保留草稿 ${width}`)
      await expect(page.locator('.diary-life-dialog')).toBeVisible()
    })

    test('keeps a dirty Todo draft when backdrop close is cancelled', async ({ page }) => {
      await page.goto('/diary')
      await unlockDiary(page)
      await page.getByRole('button', { name: '待办视图' }).tap()

      const selectedDate = page.locator('.diary-life-calendar .life-date[data-date$="-01-10"]')
      await selectedDate.tap()
      await page.getByTestId('diary-add-task').tap()
      const title = page.getByRole('textbox', { name: '待办名称', exact: true })
      await title.fill(`保留待办草稿 ${width}`)
      await page.touchscreen.tap(width / 2, 8)

      const confirmation = page.getByRole('dialog', { name: '放弃未保存的修改？' })
      await expect(confirmation).toBeVisible()
      await confirmation.getByRole('button', { name: /^(Cancel|取消)$/ }).tap()
      await expect(title).toHaveValue(`保留待办草稿 ${width}`)
      await expect(page.locator('.diary-task-edit-dialog')).toBeVisible()
    })
  })
}

test.describe('Diary desktop modal dismissal', () => {
  test.use({ isMobile: false, hasTouch: false, viewport: { width: 1280, height: 800 } })

  test('keeps backdrop click and Escape dismissal working', async ({ page }) => {
    await page.goto('/diary')
    await unlockDiary(page)
    await page.getByRole('button', { name: '事件视图' }).click()

    const cell = page.locator('.diary-life-calendar .life-date[data-date$="-01-10"]')
    await cell.click()
    const dialog = page.locator('.diary-life-dialog')
    await expect(dialog).toBeVisible()
    await page.mouse.click(4, 4)
    await expect(dialog).toHaveCount(0)

    await cell.click()
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })
})

for (const viewport of [{ width: 390, height: 844 }, { width: 430, height: 900 }, { width: 768, height: 1024 }, { width: 1280, height: 800 }]) {
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
      const dayOfMonth = viewport.width === 390 ? 15 : viewport.width === 430 ? 30 : viewport.width === 768 ? 16 : 17
      const cell = calendar.locator(`[data-date$="-01-${dayOfMonth}"]`)
      const dateAction = cell.locator('.life-date-action')
      await openEmptyDiaryDay(page, cell, async () => {
        await dateAction.focus()
        await dateAction.press('Enter')
      })
      await expect(dateAction).toHaveAttribute('aria-pressed', 'true')
      await chooseDiaryDayAction(page, '添加一条', viewport.width <= 768)
      const input = page.getByRole('textbox', { name: '第 1 条日记', exact: true })
      await expect(input).toBeVisible()
      const editorBoundsBefore = await input.boundingBox()
      await page.getByRole('button', { name: '选择心情' }).click()
      const floatingMoodPicker = page.getByTestId('diary-mood-picker')
      await expect(floatingMoodPicker).toBeVisible()
      // The picker is a floating popover, never part of the Diary content flow.
      await expect(page.getByTestId('diary-day-content').getByTestId('diary-mood-picker')).toHaveCount(0)
      const editorBoundsDuring = await input.boundingBox()
      expect(editorBoundsBefore).not.toBeNull()
      expect(editorBoundsDuring).not.toBeNull()
      expect(Math.abs(editorBoundsDuring!.y - editorBoundsBefore!.y)).toBeLessThan(1)
      const pickerBounds = await floatingMoodPicker.boundingBox()
      expect(pickerBounds).not.toBeNull()
      expect(pickerBounds!.x).toBeGreaterThanOrEqual(0)
      expect(pickerBounds!.x + pickerBounds!.width).toBeLessThanOrEqual(viewport.width + 1)
      await floatingMoodPicker.locator('button[data-mood-id]').first().click()
      await expect(floatingMoodPicker).toBeHidden()
      await input.fill(`日记录 ${viewport.width}`)
      if (viewport.width === 1280) {
        await page.getByRole('button', { name: '取消', exact: true }).click()
        const confirmation = page.getByRole('dialog', { name: '放弃未保存的修改？' })
        const confirmationContainer = page.locator('.n-modal-container').filter({ has: confirmation })
        await expect(confirmationContainer.locator(':scope > .n-modal-mask')).toHaveCSS('backdrop-filter', 'none')
        await confirmation.getByRole('button', { name: /^(Cancel|取消)$/ }).click()
        await expect(input).toHaveValue(`日记录 ${viewport.width}`)

        const dayUrl = '**/api/diary/life/days/*'
        await page.route(dayUrl, route => route.request().method() === 'PUT'
          ? route.fulfill({ status: 503, json: { error: 'save unavailable' } })
          : route.continue())
        await saveDiaryDay(page)
        await expect(page.getByTestId('diary-day-dialog').getByRole('alert')).toHaveText('操作失败，请重试。')
        await expect(input).toHaveValue(`日记录 ${viewport.width}`)
        await page.unroute(dayUrl)
      }
      await saveDiaryDay(page)
      await expect(page.getByText('日记已保存', { exact: true })).toBeVisible()
      await expect(page.getByTestId('diary-edit-entry')).toBeVisible()
      await expect(page.getByTestId('diary-bullet-reader')).toContainText(`日记录 ${viewport.width}`)
      await expect(page.getByTestId('diary-save-entry')).toHaveCount(0)
      await expect(page.getByTestId('diary-day-actions-menu')).toHaveCount(0)
      const initialTheme = await page.locator('html').getAttribute('data-theme')
      await page.screenshot({ path: testInfo.outputPath(`diary-day-read-${viewport.width}-${initialTheme ?? 'default'}.png`) })
      await page.getByRole('button', { name: '关闭日记' }).click()
      if (viewport.width <= 768) await cell.tap()
      else await cell.click()
      await expect(page.getByTestId('diary-edit-entry')).toBeVisible()
      await expect(page.getByTestId('diary-bullet-reader')).toContainText(`日记录 ${viewport.width}`)
      const dialog = page.getByTestId('diary-day-dialog')
      await expectDiaryGlassModal(page, dialog)
      const heading = dialog.locator('.diary-day-heading')
      const mood = heading.getByTestId('diary-day-mood')
      await expect(mood).toBeVisible()
      const { gap, centerOffset } = await mood.evaluate(element => {
        const date = element.previousElementSibling!.getBoundingClientRect()
        const emoji = element.getBoundingClientRect()
        return { gap: emoji.left - date.right, centerOffset: emoji.top + emoji.height / 2 - date.top - date.height / 2 }
      })
      expect(gap).toBeGreaterThan(0)
      expect(Math.abs(centerOffset)).toBeLessThan(1)
      await expect(dialog.getByTestId('diary-day-content').getByTestId('diary-day-mood')).toHaveCount(0)
      const edit = dialog.getByRole('button', { name: '编辑日记' })
      await expect(edit.locator('svg')).toHaveCount(1)
      const close = dialog.getByRole('button', { name: '关闭日记' })
      if (viewport.width === 1280) {
        await page.mouse.move(0, 0)
        await expect(edit).toHaveCSS('opacity', '0')
        await dialog.getByTestId('diary-day-content').hover()
        await expect(edit).toHaveCSS('opacity', '0')
        await edit.hover()
        await expect(edit).toHaveCSS('opacity', '1')
        const closeBounds = await close.boundingBox()
        await close.hover()
        await expect(edit).toHaveCSS('opacity', '0')
        expect(await close.boundingBox()).toEqual(closeBounds)
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await expect(edit).toHaveCSS('transition-duration', '0s')
        await close.focus()
        await page.keyboard.press('Shift+Tab')
        await expect(edit).toBeFocused()
        await expect(edit).toHaveCSS('opacity', '1')
        await page.keyboard.press('Enter')
      } else {
        await expect(edit).toHaveCSS('opacity', '1')
        await edit.tap()
      }
      const reopenedInput = page.getByRole('textbox', { name: '第 1 条日记', exact: true })
      await expect(reopenedInput).toHaveValue(`日记录 ${viewport.width}`)
      await expect(dialog.locator('.diary-bullet-number')).toHaveText('01')
      await expect(heading.getByRole('button', { name: '选择心情' }).locator('img')).toHaveCSS('width', '24px')
      const textAlignment = await dialog.evaluate(element => {
        const content = element.querySelector('[data-testid="diary-day-content"]')!
        const textarea = content.querySelector('textarea')!
        return textarea.getBoundingClientRect().left - content.getBoundingClientRect().left
      })
      expect(textAlignment).toBeCloseTo(30, 0)
      const cancelEdit = dialog.getByRole('button', { name: '取消', exact: true })
      await expect(cancelEdit).toHaveCSS('opacity', '1')
      await expect(cancelEdit.locator('svg')).toHaveCount(1)
      await expect(dialog).toHaveCSS('width', viewport.width <= 600 ? `${viewport.width}px` : '640px')
      await page.screenshot({ path: testInfo.outputPath(`diary-day-edit-${viewport.width}.png`) })
      await page.getByTestId('diary-cancel-edit').click()
      await expect(reopenedInput).toBeHidden()
      await expect(dialog.locator('.diary-bullet-number')).toHaveCount(0)
      await page.getByRole('button', { name: '关闭日记' }).click()
      await expect(cell.locator('img')).toHaveCount(1)
      const numberBefore = await dateNumberOffset(cell)
      const monthBefore = await calendar.locator('.n-calendar-header').innerText()
      await page.getByRole('button', { name: '事件视图' }).click()
      await expect(dateAction).toHaveAttribute('aria-pressed', 'false')
      await expect(cell.locator('img')).toHaveCount(0)
      expect(await dateNumberOffset(cell)).toEqual(numberBefore)
      expect(await calendar.locator('.n-calendar-header').innerText()).toBe(monthBefore)
      await cell.click()
      await expect(dateAction).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByTestId('diary-add-event')).toBeVisible()
      await expect(page.getByTestId('diary-add-task')).toHaveCount(0)
      const dayEventsDialog = page.locator('.diary-life-dialog')
      await expect(dayEventsDialog.locator('.diary-day-status')).toHaveCount(0)
      await expect(dayEventsDialog.locator('.day-events')).toHaveCount(1)
      await expect(dayEventsDialog.locator('.day-tasks')).toHaveCount(0)
      await expect(dayEventsDialog.locator('.day-list-section-header')).toHaveCount(0)
      await expect(dayEventsDialog.locator('.day-list-content--empty')).toHaveCount(1)
      if (viewport.width === 1280) {
        await expect(dayEventsDialog.getByTestId('diary-add-event')).toHaveCSS('opacity', '0')
        await dayEventsDialog.locator('.diary-event-header-actions').hover()
        await expect(dayEventsDialog.getByTestId('diary-add-event')).toHaveCSS('opacity', '1')
      } else {
        await expect(dayEventsDialog.getByTestId('diary-add-event')).toHaveCSS('opacity', '0.68')
      }
      await expectDiaryGlassModal(page, dayEventsDialog)
      await expect(page.getByRole('button', { name: '更多当天事件操作' })).toHaveCount(0)
      await expect(page.locator('.diary-event-create')).toHaveCount(0)
      await page.getByTestId('diary-add-event').click()
      const eventEditDialog = page.locator('.diary-life-dialog')
      await expectDiaryGlassModal(page, eventEditDialog)
      await expect(eventEditDialog.locator('.n-card__footer')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      const eventTitle = `人生事件 ${viewport.width} (${testInfo.repeatEachIndex + 1})`
      // This scenario covers the single-date milestone calendar marker.
      await page.getByTestId('event-type-milestone').click()
      const eventDate = await cell.getAttribute('data-date')
      expect(eventDate).not.toBeNull()
      await page.getByRole('textbox', { name: '事件名称', exact: true }).fill(eventTitle)
      if (viewport.width === 1280) {
        await page.locator('.event-advanced summary').click()
        await page.getByRole('checkbox', { name: '显示倒数日' }).click()
      }
      await page.getByRole('button', { name: '保存', exact: true }).click()
      const eventModal = page.locator('.diary-life-dialog')
      await expect(eventModal).toBeVisible()
      await expect(eventModal.locator('.day-tasks')).toHaveCount(0)
      await expect(eventModal.locator('.day-list-section-header')).toHaveCount(0)
      await expect(eventModal.locator('.day-events .diary-event-row')).toHaveCount(1)
      await expect(eventModal.locator('.day-list-content--empty')).toHaveCount(0)
      const eventTitleInput = page.getByRole('textbox', { name: '事件名称', exact: true })
      await expect(eventTitleInput).toHaveCount(0)
      const eventModalBounds = await eventModal.boundingBox()
      expect(eventModalBounds).not.toBeNull()
      expect(eventModalBounds!.x).toBeGreaterThanOrEqual(0)
      expect(eventModalBounds!.x + eventModalBounds!.width).toBeLessThanOrEqual(viewport.width + 1)
      expect(eventModalBounds!.y + eventModalBounds!.height).toBeLessThanOrEqual(viewport.height + 1)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      const dayEvent = page.getByRole('button', { name: eventTitle, exact: true })
      await dayEvent.click()
      await expect(eventTitleInput).toHaveValue(eventTitle)
      await eventTitleInput.fill(`${eventTitle} 草稿`)
      await page.getByRole('button', { name: '取消', exact: true }).click()
      const eventDiscard = page.getByRole('dialog', { name: '放弃未保存的修改？' })
      await eventDiscard.getByRole('button', { name: /^(Cancel|取消)$/ }).click()
      await expect(eventTitleInput).toHaveValue(`${eventTitle} 草稿`)
      await page.getByRole('button', { name: '取消', exact: true }).click()
      await page.getByRole('dialog', { name: '放弃未保存的修改？' }).getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
      await expect(eventTitleInput).toHaveCount(0)
      await dayEvent.click()
      const updatedEventTitle = `${eventTitle} 更新`
      await eventTitleInput.fill(updatedEventTitle)
      await page.getByRole('button', { name: '保存', exact: true }).click()
      await expect(eventTitleInput).toHaveCount(0)
      await expect(page.getByRole('button', { name: updatedEventTitle, exact: true })).toBeVisible()
      await page.getByRole('button', { name: '关闭当天事件' }).click()
      await page.reload()
      await unlockDiary(page)
      await expect(page.getByRole('button', { name: '日记视图' })).toBeVisible()
      await expect(page.getByTestId('diary-event-list-toggle')).toHaveCount(0)
      await expect(cell.locator('img')).toHaveAttribute('src', /event-graduation/)
      await page.screenshot({ path: testInfo.outputPath('diary-calendar.png') })
      expect(await page.locator('.monaco-editor').count()).toBe(0)
      if (viewport.width === 1280) {
        const countdowns = page.locator('.countdowns')
        await expect(countdowns).toHaveCount(0)
        const calendarHeight = (await calendar.boundingBox())!.height
        await page.getByTestId('diary-view-mode-diary').click()
        await expect(countdowns).toHaveCount(0)
        expect((await calendar.boundingBox())!.height).toBe(calendarHeight)
        await page.getByTestId('diary-view-mode-events').click()
        await expect(countdowns).toHaveCount(0)
        const occurrence = calendar.locator(`[data-date="${eventDate}"] .life-date-action`)
        await occurrence.click()
        const eventOnDate = page.getByRole('button', { name: updatedEventTitle, exact: true })
        await expect(eventOnDate).toBeVisible()
        await eventOnDate.click()
        await expect(occurrence).toHaveAttribute('aria-pressed', 'true')
        const lockedDraft = page.getByRole('textbox', { name: '事件名称', exact: true })
        await expect(lockedDraft).toHaveValue(updatedEventTitle)
        await lockedDraft.fill(`${updatedEventTitle} 锁定前草稿`)
        const lockStatus = await page.evaluate(async () => {
          const response = await fetch('/api/diary/access/lock', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          return response.status
        })
        expect(lockStatus).toBe(200)
        // Locking the server session is observed by the page on its next
        // protected request, which clears the private event editor.
        await page.getByRole('button', { name: '保存', exact: true }).click()
        await expect(page.getByRole('button', { name: '解锁日程', exact: true })).toBeVisible()
        const unlockButton = page.getByRole('button', { name: '解锁日程', exact: true })
        await expect(lockedDraft).toHaveCount(0)
        await unlockButton.click()
        await unlockDiary(page)
        await expect(countdowns).toHaveCount(0)
        await expect(lockedDraft).toHaveCount(0)
        await occurrence.click()
        const lockedEvent = page.getByRole('button', { name: updatedEventTitle, exact: true })
        await expect(lockedEvent).toBeVisible()
        await lockedEvent.click()
        await expect(occurrence).toHaveAttribute('aria-pressed', 'true')
        await expect(page.getByRole('textbox', { name: '事件名称', exact: true })).toHaveValue(updatedEventTitle)
        await page.getByRole('button', { name: '删除事件', exact: true }).click()
        await page.getByRole('dialog', { name: '删除这条事件？' }).getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
        await expect(occurrence.locator('.life-marker')).toHaveCount(0)
      }
    })
  })
}

test('Diary event picker keeps four equal types across phone, tablet, and desktop', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await page.goto('/diary')
  await unlockDiary(page)
  await page.getByTestId('diary-view-mode-events').click()

  const futureDate = await page.evaluate(() => {
    const now = new Date()
    now.setDate(now.getDate() + 1)
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  })
  await page.locator(`.diary-life-calendar [data-date="${futureDate}"]`).click()
  await page.getByTestId('diary-add-event').click()

  const editor = page.locator('.diary-event-edit-dialog')
  const picker = editor.locator('.event-type-picker')
  await expect(editor).toBeVisible()
  await expect(page.getByTestId('event-type-milestone')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('event-type-birthday')).toBeVisible()
  await expect(page.getByTestId('event-type-anniversary')).toBeVisible()
  await expect(page.getByTestId('event-type-period')).toBeVisible()
  await expect(page.getByTestId('event-type-schedule')).toHaveCount(0)
  await expect(editor).not.toContainText('重要日程')
  await expect(page.getByTestId('diary-day-dialog')).toHaveCount(0)
  await expect(editor.getByRole('checkbox', { name: '全天' })).toHaveCount(0)

  for (const viewport of [
    { width: 320, height: 640 },
    { width: 390, height: 844 },
    { width: 430, height: 900 },
    { width: 768, height: 1024 },
    { width: 1280, height: 900 },
  ]) {
    await page.setViewportSize(viewport)
    const bounds = await editor.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1)
    expect(bounds!.y).toBeGreaterThanOrEqual(0)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height + 1)
    expect(await picker.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    expect(await picker.evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length)).toBe(4)
    await expect(editor.locator('.n-card-content')).toHaveCSS('overflow-y', 'auto')
    await expect(editor.getByRole('button', { name: '保存', exact: true })).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }

  await page.setViewportSize({ width: 1280, height: 900 })
  await fillDiaryEventDate(page, '发生日期', '2026-11-30')
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
  await page.screenshot({ path: testInfo.outputPath('diary-event-form-milestone-1280.png'), animations: 'disabled' })
  await page.getByTestId('event-type-anniversary').click()
  await expect(page.getByTestId('event-type-anniversary')).toHaveAttribute('aria-pressed', 'true')
  await fillDiaryEventDate(page, '纪念日期', '2026-11-30')
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
  await page.screenshot({ path: testInfo.outputPath('diary-event-form-anniversary-1280.png'), animations: 'disabled' })
  await page.getByTestId('event-type-birthday').click()
  await expect(page.getByTestId('event-type-birthday')).toHaveAttribute('aria-pressed', 'true')
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
  await page.screenshot({ path: testInfo.outputPath('diary-event-form-birthday-1280.png'), animations: 'disabled' })
  await page.getByTestId('event-type-period').click()
  const typeChange = page.getByRole('dialog', { name: '切换事件类型？' })
  await expect(typeChange).toBeVisible()
  await typeChange.getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
  await expect(typeChange).toBeHidden()
  await expect(page.getByTestId('event-type-period')).toHaveAttribute('aria-pressed', 'true')
  await fillDiaryEventDate(page, '开始日期', '2020-05-20')
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
  await page.screenshot({ path: testInfo.outputPath('diary-event-form-period-1280.png'), animations: 'disabled' })
})

test('keeps a single-date milestone on its edited date without annual repetition', async ({ page }) => {
  await page.goto('/diary')
  await unlockDiary(page)
  await page.getByTestId('diary-view-mode-events').click()

  const calendar = page.locator('.diary-life-calendar')
  const originalDate = '2026-11-20'
  const movedDate = '2026-12-05'
  const originalCell = calendar.locator(`[data-date="${originalDate}"]`)
  await originalCell.click()
  await page.getByTestId('diary-add-event').click()
  await page.getByRole('textbox', { name: '事件名称', exact: true }).fill('日期调整时刻')
  await page.getByRole('button', { name: '保存', exact: true }).click()

  const dayEvent = page.getByRole('button', { name: '日期调整时刻', exact: true })
  await expect(dayEvent).toHaveClass(/diary-cloud-card/)
  expect(await dayEvent.evaluate(element => getComputedStyle(element).backgroundImage)).toBe('none')
  await dayEvent.click()
  await fillDiaryEventDate(page, '发生日期', movedDate)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(calendar.locator('.life-month-label')).toHaveText(diaryMonthLabel('2026-12'))
  await expect(calendar.locator(`[data-date="${movedDate}"] .life-date-action`)).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: '日期调整时刻', exact: true })).toBeVisible()

  await page.getByRole('button', { name: '关闭当天事件' }).click()
  const arrows = calendar.locator('.n-calendar-header').getByRole('button')
  await arrows.first().click()
  await expect(calendar.locator('.life-month-label')).toHaveText(diaryMonthLabel('2026-11'))
  await expect(originalCell.locator('.life-marker')).toHaveCount(0)

  const milestoneDate = '2026-11-21'
  await calendar.locator(`[data-date="${milestoneDate}"]`).click()
  await page.getByTestId('diary-add-event').click()
  await page.getByRole('textbox', { name: '事件名称', exact: true }).fill('单次时刻')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.diary-event-edit-dialog')).toHaveCount(0)
  await page.getByRole('button', { name: '关闭当天事件' }).click()

  for (let index = 0; index < 12; index++) await arrows.last().click()
  await expect(calendar.locator('.life-month-label')).toHaveText(diaryMonthLabel('2027-11'))
  const nextYearCell = calendar.locator('[data-date="2027-11-21"]')
  await nextYearCell.click()
  const milestoneRow = page.getByRole('button', { name: '单次时刻', exact: true })
  await expect(milestoneRow).toHaveCount(0)
  await expect(nextYearCell.locator('.life-marker')).toHaveCount(0)
  await page.getByRole('button', { name: '关闭当天事件' }).click()

  for (let index = 0; index < 12; index++) await arrows.first().click()
  await expect(calendar.locator('.life-month-label')).toHaveText(diaryMonthLabel('2026-11'))
  const milestoneCell = calendar.locator('[data-date="2026-11-21"]')
  await milestoneCell.click()
  await expect(milestoneRow).toBeVisible()

  await milestoneRow.focus()
  await page.keyboard.press('Enter')
  const titleInput = page.getByRole('textbox', { name: '事件名称', exact: true })
  await expect(titleInput).toBeFocused()
  await page.getByRole('button', { name: '取消', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(calendar.locator('.life-month-label')).toHaveText(diaryMonthLabel('2026-11'))
  await expect(milestoneCell.locator('.life-date-action')).toHaveAttribute('aria-pressed', 'true')
  await expect(milestoneRow).toBeFocused()

  await milestoneRow.focus()
  await page.keyboard.press('Enter')
  await titleInput.fill('年度时刻已更新')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(titleInput).toHaveCount(0)
  await expect(calendar.locator('.life-month-label')).toHaveText(diaryMonthLabel('2026-11'))
  await expect(calendar.locator('[data-date="2026-11-21"] .life-date-action')).toHaveAttribute('aria-pressed', 'true')

  await expect(milestoneRow).toHaveCount(0)
  const updatedMilestoneRow = page.getByRole('button', { name: '年度时刻已更新', exact: true })
  await expect(updatedMilestoneRow).toBeVisible()
  await page.getByRole('button', { name: '关闭当天事件' }).click()
  for (let index = 0; index < 12; index++) await arrows.last().click()
  await expect(calendar.locator('.life-month-label')).toHaveText(diaryMonthLabel('2027-11'))
  await nextYearCell.click()
  await expect(updatedMilestoneRow).toHaveCount(0)
  await page.getByRole('button', { name: '关闭当天事件' }).click()
  for (let index = 0; index < 12; index++) await arrows.first().click()
  await expect(calendar.locator('.life-month-label')).toHaveText(diaryMonthLabel('2026-11'))
  await milestoneCell.click()
  await expect(updatedMilestoneRow).toBeVisible()

  await updatedMilestoneRow.focus()
  await page.keyboard.press('Enter')
  await expect(titleInput).toBeFocused()
  await page.getByRole('button', { name: '关闭事件编辑' }).focus()
  await page.keyboard.press('Enter')
  await expect(updatedMilestoneRow).toBeFocused()

  await page.keyboard.press('Enter')
  await expect(titleInput).toBeFocused()
  await page.getByRole('button', { name: '删除事件', exact: true }).focus()
  await page.keyboard.press('Enter')
  const deleteDialog = page.getByRole('dialog', { name: '删除这条事件？' })
  await deleteDialog.getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
  await expect(updatedMilestoneRow).toHaveCount(0)
  await expect(page.getByRole('button', { name: '关闭当天事件' })).toBeFocused()
})

test('converting a Life Period to an anniversary protects its range until confirmed', async ({ page }) => {
  await page.goto('/diary')
  await unlockDiary(page)
  await page.getByTestId('diary-view-mode-events').click()

  const startDate = await page.evaluate(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  })
  await page.locator(`.diary-life-calendar [data-date="${startDate}"]`).click()
  await page.getByTestId('diary-add-event').click()
  await page.getByTestId('event-type-period').click()

  const nextDate = await page.evaluate(date => {
    const [year, month, day] = date.split('-').map(Number)
    const next = new Date(year, month - 1, day + 1)
    return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`
  }, startDate)
  await fillDiaryEventDate(page, '结束日期', nextDate)

  await page.getByTestId('event-type-anniversary').click()
  let typeChange = page.getByRole('dialog', { name: '切换事件类型？' })
  await expect(typeChange).toBeVisible()
  await expect(typeChange).toContainText('结束日期和持续天数')
  await typeChange.getByRole('button', { name: /^(Cancel|取消)$/ }).click()
  await expect(page.getByTestId('event-type-period')).toHaveAttribute('aria-pressed', 'true')
  await expect(diaryEventDateInput(page, '结束日期')).toHaveValue(nextDate)

  await page.getByTestId('event-type-anniversary').click()
  typeChange = page.getByRole('dialog', { name: '切换事件类型？' })
  await expect(typeChange).toBeVisible()
  await typeChange.getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
  await expect(page.getByTestId('event-type-anniversary')).toHaveAttribute('aria-pressed', 'true')
  await expect(diaryEventDateInput(page, '结束日期')).toHaveCount(0)
  await expect(page.getByRole('checkbox', { name: '每年重复' })).toBeChecked()
})

test('Diary selected day Event distance stays on one line across viewport widths', async ({ page }) => {
  const event = {
    id: 'distance-row-event',
    title: `响应式日程 ${'较长标题'.repeat(10)}`,
    description: '',
    emoji: '🎯',
    type: 'milestone' as const,
    startDate: '2026-11-16',
    endDate: '2026-11-16',
    startTime: null,
    endTime: null,
    allDay: true,
    dateRule: { calendar: 'gregory' as const },
    recurrence: 'none' as const,
    showCountdown: false,
    isPrimary: false,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  }
  const pastEvent = {
    ...event,
    id: 'past-distance-row-event',
    title: '已过去的日程',
    startDate: '2026-11-15',
    endDate: '2026-11-15',
  }
  await page.route('**/api/diary/life/events?*', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { items: [event, pastEvent], next: null } })
    : route.continue())
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/diary')
  await unlockDiary(page)
  await expect(page.getByTestId('diary-event-list-toggle')).toHaveCount(0)
  await page.getByTestId('diary-view-mode-events').click()
  await page.locator('.diary-life-calendar [data-date="2026-11-16"]').click()

  const row = page.getByRole('button', { name: event.title, exact: true })
  const distance = row.locator('.diary-event-distance')
  await expect(distance).toHaveText('今天')
  await expect(distance).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  const expectThemeCardSurface = async () => {
    const colors = await row.evaluate(element => {
      const probe = document.createElement('div')
      probe.style.backgroundColor = 'var(--bg)'
      document.body.append(probe)
      const expected = getComputedStyle(probe).backgroundColor
      probe.remove()
      const style = getComputedStyle(element)
      return { backgroundColor: style.backgroundColor, backgroundImage: style.backgroundImage, expected }
    })
    expect(colors.backgroundColor).toBe(colors.expected)
    expect(colors.backgroundImage).toBe('none')
  }
  await expectThemeCardSurface()
  const title = row.locator('.diary-event-row-title')
  for (const width of [320, 390, 430, 768, 1280]) {
    await page.setViewportSize({ width, height: width <= 430 ? 844 : 900 })
    await expect(row).toBeVisible()
    await expect(title).toHaveCSS('white-space', 'nowrap')
    await expect(title).toHaveCSS('text-overflow', 'ellipsis')
    await expect(distance).toHaveCSS('white-space', 'nowrap')
    const bounds = await row.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.getByRole('button', { name: '关闭当天事件' }).click()
  const originalTheme = await page.locator('html').getAttribute('data-theme')
  await page.locator('.theme-toggle').click()
  await expect.poll(() => page.locator('html').getAttribute('data-theme')).not.toBe(originalTheme)
  await page.locator('.diary-life-calendar [data-date="2026-11-16"]').click()
  await expect(row).toBeVisible()
  await expectThemeCardSurface()
  await page.getByRole('button', { name: '关闭当天事件' }).click()
  await page.locator('.theme-toggle').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', originalTheme ?? '')

  await page.locator('.diary-life-calendar [data-date="2026-11-15"]').click()
  const pastRow = page.getByRole('button', { name: pastEvent.title, exact: true })
  await expect(pastRow.locator('.diary-event-distance')).toHaveText('已过去1天')
  await page.getByRole('button', { name: '关闭当天事件' }).click()
  const eventsView = page.getByTestId('diary-view-mode-events')
  const diaryView = page.getByTestId('diary-view-mode-diary')
  await expect(eventsView).toHaveAttribute('aria-pressed', 'true')
  await diaryView.click()
  await expect(page.locator('.diary-life-calendar [data-date="2026-11-16"]')).toHaveCount(1)
  await expect(diaryView).toHaveAttribute('aria-pressed', 'true')
  await expect(eventsView).toHaveAttribute('aria-pressed', 'false')
})

test('Diary NavBar icon controls share the standard size across viewport widths', async ({ page }) => {
  await page.goto('/diary')
  await unlockDiary(page)

  const viewportWidths = [320, 390, 430, 768, 1024, 1280, 1440]
  const selectors = [
    '[data-testid="diary-view-mode-diary"]',
    '[data-testid="diary-view-mode-events"]',
    '[data-testid="diary-view-mode-tasks"]',
    '.nav-search',
    '[data-testid="global-ai-trigger"]',
    '.theme-toggle',
    '[data-testid="account-button"]',
  ]

  for (const width of viewportWidths) {
    await page.setViewportSize({ width, height: 900 })
    await expect(page.getByTestId('diary-event-list-toggle')).toHaveCount(0)
    const controls = selectors.map(selector => page.locator(`.navbar .nav-actions ${selector}`))
    for (const control of controls) await expect(control).toBeVisible()
    await expect(page.locator('.navbar .nav-actions button:visible')).toHaveCount(controls.length)

    const metrics = await Promise.all(controls.map(control => control.evaluate(button => {
      const bounds = button.getBoundingClientRect()
      const icon = button.querySelector('.n-icon')!.getBoundingClientRect()
      const svg = button.querySelector('.n-icon svg')!.getBoundingClientRect()
      return {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        iconWidth: icon.width,
        iconHeight: icon.height,
        svgWidth: svg.width,
        svgHeight: svg.height,
      }
    })))

    expect(metrics.map(({ width: buttonWidth, height }) => [buttonWidth, height]))
      // The compact toolbar narrows its controls at <=360px, except the account button.
      .toEqual(selectors.map(selector => [width <= 360 && !selector.includes('account-button') ? 26 : 28, 28]))
    expect(metrics.map(({ iconWidth, iconHeight, svgWidth, svgHeight }) => [iconWidth, iconHeight, svgWidth, svgHeight]))
      .toEqual(Array.from({ length: controls.length }, () => [18, 18, 18, 18]))
    expect(Math.max(...metrics.map(metric => metric.y)) - Math.min(...metrics.map(metric => metric.y)))
      .toBeLessThan(1)
    const gaps = metrics.slice(1).map((metric, index) => metric.x - metrics[index].x - metrics[index].width)
    const expectedGap = width <= 360 ? 0 : width <= 600 ? 2 : 6
    // Diary mode buttons and utility buttons must share exactly one spacing rhythm.
    expect(gaps.map(gap => Math.round(gap))).toEqual(Array(controls.length - 1).fill(expectedGap))
    expect(metrics[0]!.x).toBeGreaterThanOrEqual(0)
    expect(metrics.at(-1)!.x + metrics.at(-1)!.width).toBeLessThanOrEqual(width)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }

  const diaryToggles = [page.getByTestId('diary-view-mode-events')]
  const search = page.locator('.navbar .nav-actions .nav-search')
  for (const diaryToggle of diaryToggles) {
    await diaryToggle.hover()
    const diaryHover = await readStableHoverColors(diaryToggle)
    await search.hover()
    expect(await readStableHoverColors(search)).toEqual(diaryHover)
  }
})

test('lunar Events preserve their rule across countdowns, editing and calendar dates', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/diary')
  await unlockDiary(page)
  if (await page.locator('html').getAttribute('data-theme') !== 'light') {
    await page.locator('.theme-toggle').click()
  }
  await page.getByTestId('diary-view-mode-events').click()
  const calendar = page.locator('.diary-life-calendar')
  const startCell = calendar.locator('[data-date="2026-11-16"]')
  await startCell.click()
  await expect(page.getByTestId('diary-add-event')).toBeVisible()
  await page.getByTestId('diary-add-event').click()
  await page.getByTestId('event-type-anniversary').click()

  const title = `农历生日 ${'标题很长'.repeat(10)} ${testInfo.repeatEachIndex + 1}`
  await page.getByRole('textbox', { name: '事件名称', exact: true }).fill(title)
  await page.getByRole('button', { name: '农历', exact: true }).click()
  await selectNaiveOption(page, '农历月份', '五月')
  await selectNaiveOption(page, '农历日期', '十九')

  for (const width of [390, 430, 768, 1280]) {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 900 })
    await expect(page.getByLabel('农历月份', { exact: true })).toBeVisible()
    const modal = page.locator('.diary-life-dialog')
    const bounds = await modal.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  const lunarMonth = page.getByLabel('农历月份', { exact: true })
  expect(await lunarMonth.evaluate(element => getComputedStyle(element).getPropertyValue('--n-color').trim()))
    .toBe(await page.locator('html').evaluate(element => getComputedStyle(element).getPropertyValue('--nuvyn-surface-1').trim()))
  const createResponsePromise = page.waitForResponse(response => response.request().method() === 'PUT'
    && new URL(response.url()).pathname.startsWith('/api/diary/life/events/'))
  await page.getByRole('button', { name: '保存', exact: true }).click()
  const createdEvent = await (await createResponsePromise).json() as {
    event: { startDate: string; dateRule?: { calendar: string; lunarMonth: number; lunarDay: number } }
  }
  expect(createdEvent.event.dateRule).toMatchObject({ calendar: 'chinese', lunarMonth: 5, lunarDay: 19 })

  await expect(page.locator('.diary-event-edit-dialog')).toHaveCount(0)
  await page.getByRole('button', { name: '关闭当天事件' }).click()
  let occurrenceYear = Number(createdEvent.event.startDate.slice(0, 4))
  let occurrenceDate = lunarToSolar({ year: occurrenceYear, month: 5, day: 19, isLeapMonth: false })!
  if (occurrenceDate < createdEvent.event.startDate) {
    occurrenceYear += 1
    occurrenceDate = lunarToSolar({ year: occurrenceYear, month: 5, day: 19, isLeapMonth: false })!
  }
  let visibleMonth = (await calendar.locator('.life-month-label').getAttribute('data-month'))!
  const showMonth = async (date: string) => {
    const targetMonth = date.slice(0, 7)
    const [visibleYear, visibleMonthNumber] = visibleMonth.split('-').map(Number)
    const [targetYear, targetMonthNumber] = targetMonth.split('-').map(Number)
    const monthDelta = (targetYear! - visibleYear!) * 12 + targetMonthNumber! - visibleMonthNumber!
    const buttons = calendar.locator('.n-calendar-header').getByRole('button')
    const button = monthDelta < 0 ? buttons.first() : buttons.last()
    for (let index = 0; index < Math.abs(monthDelta); index++) await button.click()
    visibleMonth = targetMonth
    await expect(calendar.locator('.life-month-label')).toHaveText(diaryMonthLabel(targetMonth))
  }
  await showMonth(occurrenceDate)
  const occurrenceCell = calendar.locator(`[data-date="${occurrenceDate}"]`)
  await occurrenceCell.click()
  const occurrenceEvent = page.getByRole('button', { name: title, exact: true })
  const distance = occurrenceEvent.locator('.diary-event-distance')
  await expect(distance).toHaveText(/^还剩\d+天$/)
  const occurrenceTitle = occurrenceEvent.locator('.diary-event-row-title')
  for (const width of [320, 390, 430, 768, 1280]) {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 900 })
    await expect(occurrenceEvent).toBeVisible()
    await expect(occurrenceTitle).toHaveCSS('white-space', 'nowrap')
    await expect(occurrenceTitle).toHaveCSS('text-overflow', 'ellipsis')
    await expect(distance).toBeVisible()
    const rowBounds = await occurrenceEvent.boundingBox()
    expect(rowBounds).not.toBeNull()
    expect(rowBounds!.x).toBeGreaterThanOrEqual(0)
    expect(rowBounds!.x + rowBounds!.width).toBeLessThanOrEqual(width + 1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  await page.setViewportSize({ width: 1280, height: 900 })
  await occurrenceEvent.click()
  await expect(page.locator('.diary-event-edit-dialog')).toBeVisible()
  await expect(page.getByLabel('农历月份', { exact: true })).toContainText('五月')
  await expect(page.getByLabel('农历日期')).toContainText('十九')

  await selectNaiveOption(page, '农历日期', '二十')
  await page.getByRole('button', { name: '关闭事件编辑' }).click()
  const discard = page.getByRole('dialog', { name: '放弃未保存的修改？' })
  await discard.getByRole('button', { name: /^(Cancel|取消)$/ }).click()
  await expect(page.getByLabel('农历日期')).toContainText('二十')
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await discard.getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
  await expect(page.locator('.diary-event-edit-dialog')).toHaveCount(0)

  await occurrenceEvent.click()
  await expect(page.getByLabel('农历日期')).toContainText('十九')
  await selectNaiveOption(page, '农历日期', '二十')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.diary-event-edit-dialog')).toHaveCount(0)

  await page.getByRole('button', { name: '关闭当天事件' }).click()
  const updatedOccurrence = lunarToSolar({ year: occurrenceYear, month: 5, day: 20, isLeapMonth: false })!
  await showMonth(updatedOccurrence)
  const updatedOccurrenceCell = calendar.locator(`[data-date="${updatedOccurrence}"]`)
  await expect(updatedOccurrenceCell.locator('.life-marker')).toHaveCount(1)
  await updatedOccurrenceCell.click()
  const updatedDayEvent = page.getByRole('button', { name: title, exact: true })
  await updatedDayEvent.click()
  await expect(page.locator('.diary-event-edit-dialog')).toBeVisible()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await page.getByRole('button', { name: '关闭当天事件' }).click()

  await page.locator('.theme-toggle').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await updatedOccurrenceCell.click()
  await updatedDayEvent.click()
  const darkLunarMonth = page.getByLabel('农历月份', { exact: true })
  expect(await darkLunarMonth.evaluate(element => getComputedStyle(element).getPropertyValue('--n-color').trim()))
    .toBe(await page.locator('html').evaluate(element => getComputedStyle(element).getPropertyValue('--nuvyn-surface-1').trim()))

  const milestone = page.getByTestId('event-type-milestone')
  await milestone.click()
  const typeChange = page.getByRole('dialog', { name: '切换事件类型？' })
  await expect(typeChange).toContainText('农历重复规则')
  await typeChange.getByRole('button', { name: /^(Cancel|取消)$/ }).click()
  await expect(page.getByLabel('农历日期')).toContainText('二十')
  await milestone.click()
  await typeChange.getByRole('button', { name: /^(OK|Confirm|确认|确定)$/ }).click()
  const gregorianDate = diaryEventDateInput(page, '发生日期')
  const expectedGregorianDate = lunarToSolar({ year: occurrenceYear, month: 5, day: 20, isLeapMonth: false })!
  await expect(gregorianDate).toHaveValue(expectedGregorianDate)
  const movedGregorianDate = lunarToSolar({ year: occurrenceYear, month: 5, day: 21, isLeapMonth: false })!
  await fillDiaryEventDate(page, '发生日期', movedGregorianDate)

  const saveResponse = page.waitForResponse(response => response.request().method() === 'PUT'
    && new URL(response.url()).pathname.startsWith('/api/diary/life/events/'))
  await page.getByRole('button', { name: '保存', exact: true }).click()
  const response = await saveResponse
  expect(response.ok()).toBe(true)
  expect(await response.json()).toMatchObject({
    event: { type: 'milestone', dateRule: { calendar: 'gregory' }, startDate: movedGregorianDate, endDate: movedGregorianDate, recurrence: 'none' },
  })
  const gregorianOccurrence = calendar.locator(`[data-date="${movedGregorianDate}"] .life-date-action`)
  await expect(gregorianOccurrence).toHaveAttribute('aria-pressed', 'true')
  await expect(updatedOccurrenceCell.locator('.life-marker')).toHaveCount(0)
  await expect(gregorianOccurrence.locator('.life-marker')).toHaveCount(1)
  await page.getByRole('button', { name: '关闭当天事件' }).click()

  await expect(gregorianOccurrence.locator('.life-marker')).toHaveCount(1)
  await gregorianOccurrence.click()
  await updatedDayEvent.click()
  await page.getByRole('button', { name: '删除事件', exact: true }).click()
  await page.getByRole('dialog', { name: '删除这条事件？' }).getByRole('button', { name: /^(OK|Confirm|确认|确定)$/ }).click()
  await expect(gregorianOccurrence.locator('.life-marker')).toHaveCount(0)
})

test('creates lunar and Gregorian birthdays without guessing the birth year', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 900 })
  await page.goto('/diary')
  await unlockDiary(page)
  await page.getByTestId('diary-view-mode-events').click()
  const calendar = page.locator('.diary-life-calendar')
  await calendar.locator('[data-date="2026-11-16"]').click()
  await page.getByTestId('diary-add-event').click()
  await page.getByTestId('event-type-birthday').click()

  await page.getByRole('textbox', { name: '生日称呼', exact: true }).fill('爷爷')
  const birthYear = page.getByLabel('出生年份', { exact: true })
  await expect(birthYear).toHaveValue('')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await birthYear.fill('1951')
  await expect(page.locator('.event-date-preview')).toHaveCount(0)
  await selectNaiveOption(page, '农历月份', '十月')
  await selectNaiveOption(page, '农历日期', '初七')
  await expect(page.locator('.event-date-preview')).toContainText('岁生日')

  const birthdayCalendar = page.getByRole('group', { name: '生日历法' })
  await birthdayCalendar.getByRole('button', { name: '公历' }).click()
  const convertedBirthDate = diaryEventDateInput(page, '出生日期')
  const lunarBirthDate = await convertedBirthDate.inputValue()
  expect(lunarBirthDate).toMatch(/^1951-/)
  await birthdayCalendar.getByRole('button', { name: '农历' }).click()
  await expect(birthYear).toHaveValue('1951')

  const lunarSave = page.waitForResponse(response => response.request().method() === 'PUT'
    && new URL(response.url()).pathname.startsWith('/api/diary/life/events/'))
  await page.getByRole('button', { name: '保存', exact: true }).click()
  const lunarResponse = await lunarSave
  expect(lunarResponse.ok()).toBe(true)
  expect(await lunarResponse.json()).toMatchObject({
    event: { type: 'birthday', startDate: lunarBirthDate, dateRule: { calendar: 'chinese' }, birthday: { birthLunarYear: 1951 } },
  })

  await page.getByTestId('diary-add-event').click()
  await page.getByTestId('event-type-birthday').click()
  await page.getByRole('textbox', { name: '生日称呼', exact: true }).fill('小明')
  const gregorianCalendar = page.getByRole('group', { name: '生日历法' })
  await gregorianCalendar.getByRole('button', { name: '公历' }).click()
  await fillDiaryEventDate(page, '出生日期', '2000-02-29')
  await expect(page.locator('.event-date-preview')).toContainText('27岁生日')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

  const gregorianSave = page.waitForResponse(response => response.request().method() === 'PUT'
    && new URL(response.url()).pathname.startsWith('/api/diary/life/events/'))
  await page.getByRole('button', { name: '保存', exact: true }).click()
  const gregorianResponse = await gregorianSave
  expect(gregorianResponse.ok()).toBe(true)
  expect(await gregorianResponse.json()).toMatchObject({
    event: {
      type: 'birthday', startDate: '2000-02-29', dateRule: { calendar: 'gregory' },
      birthday: { birthGregorianYear: 2000 }, recurrence: 'yearly',
    },
  })
})

test('text-only Diary days have a calendar marker and preserve bullet editing interactions', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/diary')
  await unlockDiary(page)
  const calendar = page.locator('.diary-life-calendar')
  const cell = calendar.locator('[data-date$="-01-19"]')
  await openEmptyDiaryDay(page, cell)
  await chooseDiaryDayAction(page, '添加一条')
  const first = page.getByRole('textbox', { name: '第 1 条日记' })
  await first.fill('第一条记录')
  await first.press('End')
  await first.press('Enter')
  const second = page.getByRole('textbox', { name: '第 2 条日记' })
  await second.fill('第二条记录')
  await second.press('Shift+Enter')
  await second.type('续写')
  await saveDiaryDay(page)
  await expect(page.getByTestId('diary-bullet-reader').locator('li')).toHaveCount(2)
  await expect(page.getByTestId('diary-bullet-reader').locator('li').nth(1)).toContainText('第二条记录\n续写')
  await page.getByRole('button', { name: '关闭日记' }).click()
  await expect(cell.locator('.life-date-action')).toHaveAttribute('aria-pressed', 'false')
  await expect(cell).not.toHaveClass(/\bselected\b/)
  await expect(cell.locator('.life-entry-marker')).toBeVisible()
})

test('clears the date highlight on Escape after opening with a pointer', async ({ page }) => {
  await page.goto('/diary')
  await unlockDiary(page)
  const cell = page.locator('.diary-life-calendar [data-date="2026-11-15"]')
  await openEmptyDiaryDay(page, cell)
  await page.mouse.move(0, 0)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('diary-day-dialog')).toHaveCount(0)
  await expect(cell.locator('.life-date-action')).toHaveAttribute('aria-pressed', 'false')
  const badge = cell.locator('.life-date-badge')
  const focusRing = () => badge.evaluate(element => getComputedStyle(element, '::before').outlineStyle)
  await expect.poll(focusRing).toBe('none')

  const dateAction = cell.locator('.life-date-action')
  const lunarTrigger = cell.locator('.life-date-lunar')
  const lunarModal = page.locator('#diary-lunar-calendar-modal')
  await lunarTrigger.focus()
  await page.keyboard.press('Enter')
  await expect(lunarModal).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(lunarModal).toHaveCount(0)
  await expect(lunarTrigger).toBeFocused()
  await expect(page.getByTestId('diary-day-dialog')).toHaveCount(0)

  await dateAction.focus()
  await expect.poll(focusRing).toBe('solid')
  await dateAction.press('Enter')
  await expect(page.getByTestId('diary-day-dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('diary-day-dialog')).toHaveCount(0)
  await expect(dateAction).toHaveAttribute('aria-pressed', 'false')
  await expect(dateAction).toBeFocused()
  await expect.poll(focusRing).toBe('solid')
})

test.describe('Diary local timezone boundary', () => {
  test.use({ timezoneId: 'Asia/Shanghai' })

  test('uses the server day boundary and enables editing after midnight without reopening', async ({ page }, testInfo) => {
    const year = diaryLifeFixtureYear(testInfo)
    const date = `${year}-01-28`
    await page.goto('/diary')
    await unlockDiary(page)

    let serverToday = `${year}-01-27`
    await page.route(`**/api/diary/life/days/${date}`, async route => {
      const response = await route.fetch()
      await route.fulfill({ response, json: { ...await response.json(), today: serverToday } })
    })
    let policyChecks = 0
    await page.route('**/api/diary/life/day-policy', route => {
      policyChecks++
      return route.fulfill({ json: { today: serverToday } })
    })
    const heartbeats: string[] = []
    const diaryTimeZones: string[] = []
    page.on('request', request => {
      if (request.url().endsWith('/heartbeat')) heartbeats.push(request.url())
      if (request.url().includes('/api/diary/life/day-policy') || request.url().includes(`/api/diary/life/days/${date}`)) {
        diaryTimeZones.push(request.headers()['x-diary-time-zone'] ?? '')
      }
    })
    await page.locator(`.diary-life-calendar [data-date="${date}"]`).click()
    await expect.poll(() => diaryTimeZones.length).toBeGreaterThan(0)
    expect(diaryTimeZones).toContain('Asia/Shanghai')
    const dialog = page.getByTestId('diary-day-dialog')
    await expect(dialog.getByText('未来的日子还没有日记。可以在事件中安排计划。')).toBeVisible()
    await expect(dialog.getByTestId('diary-edit-entry')).toHaveCount(0)
    await expect(dialog.getByTestId('diary-day-actions-menu')).toHaveCount(0)
    await expect(dialog.getByTestId('diary-bullet-editor')).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: '选择心情' })).toHaveCount(0)
    await page.clock.fastForward(30_000)
    await expect.poll(() => policyChecks).toBeGreaterThan(0)
    expect(heartbeats).toHaveLength(0)

    serverToday = date
    await page.clock.fastForward(30_000)
    const edit = dialog.getByTestId('diary-edit-entry')
    await expect(edit).toBeVisible()
    await edit.click()
    const first = dialog.getByRole('textbox', { name: '第 1 条日记', exact: true })
    await first.fill('跨日后的日记')
    await page.clock.fastForward(30_000)
    await expect(first).toHaveValue('跨日后的日记')
  })
})

test('restores focus for entry shortcuts without treating Chinese composition as a shortcut', async ({ page, context }) => {
  await page.goto('/diary')
  await unlockDiary(page)
  await openEmptyDiaryDay(page, page.locator('.diary-life-calendar [data-date$="-01-18"]'))

  const editor = page.getByTestId('diary-bullet-editor')
  const entries = editor.getByRole('textbox')
  const first = entries.nth(0)
  const second = entries.nth(1)
  const third = entries.nth(2)
  await first.pressSequentially('AB')
  await expect(first).toHaveValue('AB')
  await first.press('ArrowLeft')
  await first.press('Enter')
  await expect(first).toHaveValue('A')
  await expect(second).toHaveValue('B')
  await expect(second).toBeFocused()

  await chooseDiaryDayAction(page, '添加一条')
  await expect(third).toBeFocused()
  const cdp = await context.newCDPSession(page)
  try {
    await cdp.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 })
    await expect(third).toHaveValue('中文')
    await third.press('Enter')
    await expect(entries).toHaveCount(3)
    await expect(third).toBeFocused()
    await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
  } finally { await cdp.detach() }
  await third.fill('')
  await third.press('Backspace')
  await expect(entries).toHaveCount(2)
  await expect(second).toBeFocused()

  await chooseDiaryDayAction(page, '添加一条')
  await third.fill('C')
  await chooseDiaryAction(page, editor.getByRole('button', { name: '第 2 条日记的操作', exact: true }), '删除此条')
  await expect(first).toBeFocused()
  await expect(second).toHaveValue('C')
  await chooseDiaryAction(page, editor.getByRole('button', { name: '第 2 条日记的操作', exact: true }), '删除此条')
  await expect(entries).toHaveCount(1)
  await expect(first).toBeFocused()
  await chooseDiaryAction(page, editor.getByRole('button', { name: '第 1 条日记的操作', exact: true }), '删除此条')
  await expect(first).toHaveValue('')
  await expect(first).toBeFocused()
})

test('mood-only Diary day stays compact in read and edit modes across themes', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/diary')
  await unlockDiary(page)
  const cell = page.locator('.diary-life-calendar [data-date$="-01-26"]')
  await openEmptyDiaryDay(page, cell)
  const dialog = page.getByTestId('diary-day-dialog')
  const moodTrigger = page.getByRole('button', { name: '选择心情' })
  const moodPopover = page.getByTestId('diary-mood-picker')
  await moodTrigger.click()
  await expect(moodPopover).toBeVisible()
  // Naive UI's modal focus trap can keep focus on its own controls while the
  // picker is teleported inside the modal. Escape must still close the picker.
  await dialog.getByTestId('diary-cancel-edit').focus()
  await expect(dialog.getByTestId('diary-cancel-edit')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(moodPopover).toBeHidden()
  await expect(dialog).toBeVisible()
  await expect(moodTrigger).toBeFocused()

  await moodTrigger.click()
  await expect(moodPopover).toBeVisible()
  await page.getByTestId('diary-day-dialog').locator('.diary-day-heading > strong').click()
  await expect(moodPopover).toBeHidden()
  await expect(page.getByTestId('diary-day-dialog')).toBeVisible()

  await moodTrigger.click()
  await moodPopover.locator('[data-mood-id="happy"]').click()
  await saveDiaryDay(page)

  await expectDiaryGlassModal(page, dialog)
  await expect(dialog.getByTestId('diary-day-mood')).toBeVisible()
  await expect(dialog.getByTestId('diary-empty-reading')).toBeVisible()
  await expect(dialog.getByTestId('diary-save-entry')).toHaveCount(0)
  const originalTheme = await page.locator('html').getAttribute('data-theme')
  const originalSurfaceColor = await dialog.evaluate(element => getComputedStyle(element).backgroundColor)
  await page.screenshot({ path: testInfo.outputPath(`diary-mood-only-read-${originalTheme ?? 'default'}.png`) })
  await page.getByRole('button', { name: '关闭日记' }).click()

  await page.locator('.theme-toggle').click()
  const alternateTheme = await page.locator('html').getAttribute('data-theme')
  expect(alternateTheme).not.toBe(originalTheme)
  await cell.click()
  await expectDiaryGlassModal(page, dialog)
  const alternateSurfaceColor = await dialog.evaluate(element => getComputedStyle(element).backgroundColor)
  expect(alternateSurfaceColor).not.toBe(originalSurfaceColor)
  await expect(dialog.getByTestId('diary-day-mood')).toBeVisible()
  await expect(dialog.getByTestId('diary-empty-reading')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath(`diary-mood-only-read-${alternateTheme ?? 'default'}.png`) })
  await page.getByTestId('diary-edit-entry').click()
  await expect(page.getByRole('button', { name: '选择心情' })).toBeVisible()
  await expect(page.getByRole('button', { name: '更多日记操作' })).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath(`diary-mood-only-edit-${alternateTheme ?? 'default'}.png`) })
  await page.getByRole('button', { name: '关闭日记' }).click()
  await page.locator('.theme-toggle').click()
})

for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }]) {
  test.describe(`Diary mood picker touch behavior at ${viewport.width}px`, () => {
    test.use({ viewport, hasTouch: true })

    test('Escape closes only the picker, outside touch closes it, and Diary Escape resumes', async ({ page }) => {
      await page.goto('/diary')
      await unlockDiary(page)
      const cell = page.locator('.diary-life-calendar [data-date$="-01-27"]')
      await openEmptyDiaryDay(page, cell, () => cell.tap())

      const dialog = page.getByTestId('diary-day-dialog')
      const moodTrigger = page.getByRole('button', { name: '选择心情' })
      const moodPopover = page.getByTestId('diary-mood-picker')
      const entry = page.getByRole('textbox', { name: '第 1 条日记', exact: true })
      await entry.fill(`保留触屏草稿 ${viewport.width}`)

      await moodTrigger.tap()
      await expect(moodPopover).toBeVisible()
      await dialog.getByTestId('diary-cancel-edit').focus()
      await page.keyboard.press('Escape')
      await expect(moodPopover).toBeHidden()
      await expect(dialog).toBeVisible()
      await expect(entry).toHaveValue(`保留触屏草稿 ${viewport.width}`)
      await expect(moodTrigger).toBeFocused()

      await moodTrigger.tap()
      await expect(moodPopover).toBeVisible()
      await dialog.locator('.diary-day-heading > strong').tap()
      await expect(moodPopover).toBeHidden()
      await expect(dialog).toBeVisible()
      await expect(entry).toHaveValue(`保留触屏草稿 ${viewport.width}`)

      await moodTrigger.tap()
      await expect(moodPopover).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(moodPopover).toBeHidden()
      await expect(moodTrigger).toBeFocused()

      await page.keyboard.press('Escape')
      const confirmation = page.getByRole('dialog', { name: '放弃未保存的修改？' })
      await expect(confirmation).toBeVisible()
      await confirmation.getByRole('button', { name: /^(Cancel|取消)$/ }).tap()
      await expect(dialog).toBeVisible()
      await expect(entry).toHaveValue(`保留触屏草稿 ${viewport.width}`)
    })
  })
}

test('closes the active day dialog when a save discovers the Diary was locked', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/diary')
  await unlockDiary(page)
  await openEmptyDiaryDay(page, page.locator('.diary-life-calendar [data-date$="-01-24"]'))
  const dialog = page.getByTestId('diary-day-dialog')
  await expect(dialog).toBeVisible()
  await page.getByRole('textbox', { name: '第 1 条日记', exact: true }).fill('锁定前的未保存内容')

  const lockStatus = await page.evaluate(async () => {
    const response = await fetch('/api/diary/access/lock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    return response.status
  })
  expect(lockStatus).toBe(200)

  await saveDiaryDay(page)
  await expect(dialog).toHaveCount(0)
  const unlockButton = page.getByRole('button', { name: '解锁日程', exact: true })
  await expect(unlockButton).toBeVisible()
  await unlockButton.click()
  await expect(page.getByRole('dialog', { name: /解锁日程|Unlock Schedule/ })).toBeVisible()
  await expect(unlockButton).toBeHidden()
  await page.getByTestId('diary-access-cancel').click()
  await expect(unlockButton).toBeFocused()
})

for (const [index, viewport] of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 430, height: 844 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
].entries()) {
  test.describe(`Diary bullet editor at ${viewport.width}px`, () => {
    const touch = viewport.width <= 768
    test.use({ hasTouch: touch })

    test('keeps long entries inside the dialog and removes the day from the calendar', async ({ page }, testInfo) => {
      await page.setViewportSize(viewport)
      await page.goto('/diary')
      await unlockDiary(page)
      const calendar = page.locator('.diary-life-calendar')
      const date = `0${4 + index}`
      const cell = calendar.locator(`[data-date$="-01-${date}"]`)
      await openEmptyDiaryDay(page, cell, () => viewport.width <= 768 ? cell.tap() : cell.click())

      const editor = page.getByTestId('diary-bullet-editor')
      await expect(editor).toBeVisible()
      await expect(editor.getByRole('button', { name: '第 1 条日记的操作' })).toBeDisabled()

      const longText = '这是一条很长的日记内容用于验证窄屏自动换行'.repeat(5)
      const first = page.getByRole('textbox', { name: '第 1 条日记', exact: true })
      await first.fill(longText)
      await expectDiaryTextareaAutoSized(first, longText)
      await first.press('End')
      const caretAfterEnd = await first.evaluate(node => (node as HTMLTextAreaElement).selectionStart)
      expect(caretAfterEnd).toBeGreaterThanOrEqual(0)
      expect(caretAfterEnd).toBeLessThanOrEqual(longText.length)
      await first.press('Enter')
      const second = page.getByRole('textbox', { name: '第 2 条日记', exact: true })
      const firstPart = await first.inputValue()
      const secondPart = await second.inputValue()
      expect(firstPart).toBe(longText.slice(0, caretAfterEnd))
      expect(secondPart).toBe(longText.slice(caretAfterEnd))
      expect(firstPart + secondPart).toBe(longText)
      const retainedSecond = `${secondPart}保留这一条`
      await second.fill(retainedSecond)
      await expectDiaryTextareaAutoSized(second, retainedSecond)

      const dialog = page.getByTestId('diary-day-dialog')
      const layout = await dialog.evaluate(node => {
        const editorNode = node.querySelector<HTMLElement>('[data-testid="diary-bullet-editor"]')!
        const row = editorNode.querySelector<HTMLElement>('.diary-bullet-row')!
        const button = row.querySelector<HTMLElement>('.diary-bullet-actions')!
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
          inputLeft: row.querySelector('textarea')!.getBoundingClientRect().left,
          editorLeft: editorNode.getBoundingClientRect().left,
          dialogLeft: dialogBounds.left,
          dialogTop: dialogBounds.top,
          dialogBottom: dialogBounds.bottom,
          documentWidth: document.documentElement.scrollWidth,
        }
      })
      expect(layout.dialogLeft).toBeGreaterThanOrEqual(-1)
      expect(layout.dialogRight).toBeLessThanOrEqual(viewport.width + 1)
      expect(layout.dialogScrollWidth).toBeLessThanOrEqual(layout.dialogWidth + 1)
      expect(layout.rowRight).toBeLessThanOrEqual(layout.editorRight + 1)
      expect(layout.buttonRight).toBeLessThanOrEqual(layout.rowRight + 1)
      expect(layout.inputWidth).toBeGreaterThan(100)
      expect(layout.inputLeft - layout.editorLeft).toBeCloseTo(30, 0)
      expect(layout.documentWidth).toBeLessThanOrEqual(viewport.width)
      expect(layout.dialogTop).toBeGreaterThanOrEqual(-1)
      expect(layout.dialogBottom).toBeLessThanOrEqual(viewport.height + 1)
      const scroller = dialog.locator('.n-card__content-scrollbar .n-scrollbar-container')
      expect(await scroller.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1)
      await expectDiaryScrollbarsHidden(dialog, scroller)
      await expectDiaryTextareaAutoSized(first, firstPart)
      await expectDiaryContentUnclipped(scroller, first)
      await expectDiaryContentUnclipped(scroller, second)
      const lastMenu = editor.getByRole('button', { name: '第 2 条日记的操作', exact: true })
      await expectDiaryContentUnclipped(scroller, lastMenu)
      await expect(lastMenu).toHaveCSS('opacity', '1')
      await lastMenu.press('Enter')
      const lastActions = page.getByRole('menu', { name: '第 2 条日记的操作' })
      await expect(lastActions).toBeInViewport({ ratio: 0.99 })
      await page.keyboard.press('Escape')
      await expect(lastActions).toHaveCount(0)
      if (viewport.width === 390) await page.screenshot({ path: testInfo.outputPath('diary-editor-mobile.png') })

      const firstMenu = page.getByRole('button', { name: '第 1 条日记的操作', exact: true })
      if (viewport.width === 1280) {
        const actions = dialog.locator('.diary-bullet-actions').first()
        await dialog.getByRole('button', { name: '关闭日记' }).focus()
        await page.mouse.move(0, 0)
        await expect(actions).toHaveCSS('opacity', '0')
        await first.hover()
        await expect(actions).toHaveCSS('opacity', '1')
        await first.focus()
        await page.keyboard.press('Tab')
        await expect(firstMenu).toBeFocused()
        await page.keyboard.press('Enter')
        await expect(page.getByRole('menu', { name: '第 1 条日记的操作' })).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(page.getByRole('menu')).toHaveCount(0)
        await expect(firstMenu).toBeFocused()
        await expect(dialog).toBeVisible()
        await page.keyboard.press('Enter')
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('Enter')
        await expect(page.getByRole('menu')).toHaveCount(0)
      } else {
        if (viewport.width <= 768) await expect(dialog.locator('.diary-bullet-actions').first()).toHaveCSS('opacity', '1')
        await chooseDiaryAction(page, firstMenu, '删除此条', viewport.width <= 768)
      }
      const remaining = page.getByRole('textbox', { name: '第 1 条日记', exact: true })
      await expect(remaining).toHaveValue(retainedSecond)
      await expect(remaining).toBeFocused()
      await saveDiaryDay(page, viewport.width <= 768)
      await expect(page.getByTestId('diary-bullet-reader')).toContainText('保留这一条')
      await expectDiaryContentUnclipped(scroller, dialog.getByText(retainedSecond, { exact: true }))
      await expectDiaryScrollbarsHidden(dialog, scroller)
      await page.getByRole('button', { name: '关闭日记' }).click()
      await expect(cell.locator('.life-marker')).toBeVisible()

      if (viewport.width <= 768) await cell.tap()
      else await cell.click()
      await expect(page.getByTestId('diary-day-actions-menu')).toHaveCount(0)
      await page.getByTestId('diary-edit-entry').click()
      await chooseDiaryDayAction(page, '删除日记', viewport.width <= 768)
      const confirmation = page.getByRole('dialog', { name: '删除这条记录？' })
      await confirmation.getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
      await expect(cell.locator('.life-marker')).toHaveCount(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    })

    test('scrolls overflowing Diary content without showing a scrollbar in either mode', async ({ page }) => {
      await page.setViewportSize(viewport)
      await page.goto('/diary')
      await unlockDiary(page)
      const date = [20, 21, 22, 23, 25, 29][index]
      const cell = page.locator(`.diary-life-calendar [data-date$="-01-${date}"]`)
      await openEmptyDiaryDay(page, cell, () => touch ? cell.tap() : cell.click())

      const dialog = page.getByTestId('diary-day-dialog')
      const editor = dialog.getByTestId('diary-bullet-editor')
      const scroller = dialog.locator('.n-card__content-scrollbar .n-scrollbar-container')
      const entryCount = 10
      const sentence = '这是一条很长的日记内容用于验证窄屏自动换行'
      for (let number = 1; number < entryCount; number++) {
        const entry = editor.getByRole('textbox', { name: `第 ${number} 条日记`, exact: true })
        await entry.fill(`${number} ${sentence.repeat(number === 1 ? 32 : 9)}`)
        await expectDiaryTextareaAutoSized(entry, `${number} ${sentence.repeat(number === 1 ? 32 : 9)}`)
        await entry.press('Enter')
      }

      const lastText = '最后一条日记，下面是今天的照片。'
      const last = editor.getByRole('textbox', { name: `第 ${entryCount} 条日记`, exact: true })
      await last.fill(lastText)
      const chooser = page.waitForEvent('filechooser')
      await chooseDiaryDayAction(page, '添加附件', touch)
      const photos = ['scroll-first.png', 'scroll-middle.png', 'scroll-last.png']
      await (await chooser).setFiles(photos.map(name => ({ name, mimeType: 'image/png', buffer: scrollTestImage })))
      const lastImage = dialog.getByRole('button', { name: '预览 scroll-last.png', exact: true })
      await expect(lastImage).toBeVisible()
      await expectDiaryCanScrollToEnd(page, dialog, last, lastImage, touch)
      await expect(last).toHaveValue(lastText)

      const trigger = editor.getByRole('button', { name: `第 ${entryCount} 条日记的操作`, exact: true })
      await expectDiaryContentUnclipped(scroller, trigger)
      if (touch) {
        await trigger.tap()
      } else {
        await last.focus()
        await page.keyboard.press('Tab')
        await expect(trigger).toBeFocused()
        await page.keyboard.press('Enter')
      }
      const menu = page.getByRole('menu', { name: `第 ${entryCount} 条日记的操作` })
      await expect(menu).toBeInViewport({ ratio: 0.99 })
      await expect(menu.getByRole('menuitem', { name: '删除此条' })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(menu).toHaveCount(0)

      await saveDiaryDay(page, touch)
      const lastReadEntry = dialog.getByTestId('diary-bullet-reader').getByText(lastText, { exact: true })
      await expect(lastReadEntry).toBeVisible()
      await expectDiaryCanScrollToEnd(page, dialog, lastReadEntry, lastImage, touch)
      const image = lastImage.getByRole('img', { name: 'scroll-last.png' })
      await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
      if (touch) {
        await lastImage.tap()
      } else {
        await lastImage.focus()
        await page.keyboard.press('Home')
        await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBe(0)
        await page.keyboard.press('End')
        await expectDiaryContentUnclipped(scroller, lastImage)
        await page.keyboard.press('Enter')
      }
      await expect(page.getByRole('dialog', { name: 'scroll-last.png', exact: true })).toBeVisible()
    })
  })
}

for (const viewport of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 430, height: 844 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
]) {
  test(`cancel closes a new Diary date dialog at ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.goto('/diary')
    await unlockDiary(page)
    const calendar = page.locator('.diary-life-calendar')
    const cell = calendar.locator('[data-date$="-01-27"]')
    await openEmptyDiaryDay(page, cell)

    const dialog = page.getByTestId('diary-day-dialog')
    await expect(dialog).toBeVisible()
    const bounds = await dialog.evaluate(node => ({
      left: node.getBoundingClientRect().left,
      right: node.getBoundingClientRect().right,
      width: node.clientWidth,
      scrollWidth: node.scrollWidth,
    }))
    expect(bounds.left).toBeGreaterThanOrEqual(-1)
    expect(bounds.right).toBeLessThanOrEqual(viewport.width + 1)
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.width + 1)

    const input = page.getByRole('textbox', { name: '第 1 条日记', exact: true })
    await input.fill('暂不保存的草稿')
    await page.getByTestId('diary-cancel-edit').click()
    const confirmation = page.getByRole('dialog', { name: '放弃未保存的修改？' })
    await expect(confirmation).toBeVisible()
    await confirmation.getByRole('button', { name: /^(Cancel|取消)$/ }).click()
    await expect(input).toHaveValue('暂不保存的草稿')

    await page.getByTestId('diary-cancel-edit').click()
    const discard = page.getByRole('dialog', { name: '放弃未保存的修改？' })
    await discard.getByRole('button', { name: /^(OK|Confirm|确认|确定)$/ }).click()
    await expect(dialog).toHaveCount(0)
  })
}

for (const viewport of [
  { width: 1920, height: 1080 },
  { width: 1800, height: 830 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 601, height: 900 },
  { width: 600, height: 900 },
  { width: 430, height: 844 },
  { width: 390, height: 844 },
  { width: 320, height: 568 },
]) {
  test(`calendar layout stays aligned at ${viewport.width}×${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport)
    const english = viewport.width >= 1200
    if (!english) await page.addInitScript(() => Object.defineProperty(navigator, 'language', { value: 'zh-CN' }))
    await page.goto('/diary')
    await unlockDiary(page)
    const calendar = page.locator('.diary-life-calendar')
    await expect(calendar).toBeVisible()
    const title = calendar.locator('.life-month-label')
    const header = calendar.locator('.n-calendar-header')
    const arrows = header.getByRole('button')
    const grid = calendar.locator('.n-calendar-dates')
    const today = calendar.locator('.life-date.today')
    const number = today.locator('.life-date-number')
    const center = (box: { x: number; width: number }) => box.x + box.width / 2
    const calendarBox = (await calendar.boundingBox())!
    const titleBox = (await title.boundingBox())!
    const initialMonth = `${diaryLifeFixtureYear(testInfo)}-01`
    const todayCellBackground = await today.evaluate(node => getComputedStyle(node.closest('.n-calendar-cell')!).backgroundColor)
    const ordinaryCell = calendar.locator('.n-calendar-cell:not(.n-calendar-cell--other-month) .life-date:not(.today)').first()
    const ordinaryCellBackground = await ordinaryCell.evaluate(node => getComputedStyle(node.closest('.n-calendar-cell')!).backgroundColor)
    const badgeBackground = await today.locator('.life-date-badge').evaluate(node => getComputedStyle(node).backgroundColor)
    const badgeHighlightBackground = await today.locator('.life-date-badge').evaluate(node => getComputedStyle(node, '::before').backgroundColor)
    const todayNumberStyle = await number.evaluate(node => {
      const style = getComputedStyle(node)
      return { color: style.color, fontWeight: style.fontWeight }
    })
    const ordinaryNumberColor = await ordinaryCell.locator('.life-date-number').evaluate(node => getComputedStyle(node).color)

    await expect(title).toHaveAttribute('data-month', initialMonth)
    await expect(title).toHaveText(diaryMonthLabel(initialMonth, english ? 'en' : 'zh'))
    expect(calendarBox.width).toBeLessThanOrEqual(800)
    expect(Math.abs(center(calendarBox) - viewport.width / 2)).toBeLessThan(1)
    expect(todayCellBackground).not.toBe('rgba(0, 0, 0, 0)')
    expect(todayCellBackground).not.toBe(ordinaryCellBackground)
    expect(badgeBackground).toBe('rgba(0, 0, 0, 0)')
    expect(badgeHighlightBackground).toBe('rgba(0, 0, 0, 0)')
    expect(todayNumberStyle).toEqual({ color: ordinaryNumberColor, fontWeight: '400' })
    await expect(arrows).toHaveCount(2)
    expect(Math.abs(center(calendarBox) - center(titleBox))).toBeLessThan(1)
    await calendar.getByTestId('diary-calendar-month-picker').click()
    await expect(page.locator('.n-date-panel').first()).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.n-date-panel')).toHaveCount(0)
    const left = (await arrows.first().boundingBox())!
    const right = (await arrows.last().boundingBox())!
    expect(Math.abs((center(left) + center(right)) / 2 - center(titleBox))).toBeLessThan(1)
    const arrowSize = viewport.width <= 600 ? 40 : 44
    expect([left.width, left.height, right.width, right.height]).toEqual([arrowSize, arrowSize, arrowSize, arrowSize])
    await expect(grid).toHaveCSS('border-top-width', '0px')
    await expect(grid.locator('.n-calendar-cell').first()).toHaveCSS('border-bottom-width', '0px')
    expect(await number.evaluate(node => getComputedStyle(node, '::after').content)).toBe('none')

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
      scrollbarWidth: getComputedStyle(node).scrollbarWidth,
      scrollbarDisplay: getComputedStyle(node, '::-webkit-scrollbar').display,
      scrollbarGutter: getComputedStyle(node).scrollbarGutter,
    }))
    expect(scroll.horizontal).toBeLessThanOrEqual(0)
    expect(scroll.vertical).toBeLessThanOrEqual(1)
    expect(scroll.scrollbarWidth).toBe('none')
    expect(scroll.scrollbarDisplay).toBe('none')
    expect(scroll.scrollbarGutter).toBe('auto')
    const monthBefore = await title.innerText()
    const rowHeight = (await dates.first().boundingBox())!.height
    expect(rowHeight).toBe(viewport.width <= 600 ? 68 : 80)
    await arrows.last().click()
    await expect(title).not.toHaveText(monthBefore)
    expect((await calendar.boundingBox())!.height).toBe(calendarBox.height)
    expect((await dates.first().boundingBox())!.height).toBeCloseTo(rowHeight, 0)
    await arrows.first().click()
    await expect(title).toHaveText(monthBefore)

    await openEmptyDiaryDay(page, today)
    await expect(today.locator('.life-date-action')).toHaveAttribute('aria-pressed', 'true')
    await expect(today).toHaveClass(/\bselected\b/)
    await expect.poll(() => today.evaluate(node => getComputedStyle(node.closest('.n-calendar-cell')!).backgroundColor))
      .toBe(todayCellBackground)
    await expect.poll(() => today.locator('.life-date-badge').evaluate(node => getComputedStyle(node, '::before').backgroundColor))
      .toBe('rgba(0, 0, 0, 0)')
    await expect(page.getByTestId('diary-edit-entry')).toHaveCount(0)
    await page.getByTestId('diary-cancel-edit').click()
    await expect(page.getByTestId('diary-day-dialog')).toHaveCount(0)
    await expect(today.locator('.life-date-action')).toHaveAttribute('aria-pressed', 'false')
    await expect(today).not.toHaveClass(/\bselected\b/)
    await expect.poll(() => today.evaluate(node => getComputedStyle(node.closest('.n-calendar-cell')!).backgroundColor))
      .toBe(todayCellBackground)
    const numberBefore = await dateNumberOffset(today)
    await page.getByTestId('diary-view-mode-events').click()
    await expect(today.locator('.life-date-action')).toHaveAttribute('aria-pressed', 'false')
    await expect(title).toHaveText(monthBefore)
    expect((await calendar.boundingBox())!.height).toBe(calendarBox.height)
    expect(await dateNumberOffset(today)).toEqual(numberBefore)
    await page.screenshot({ path: testInfo.outputPath('calendar-layout.png') })
  })
}
