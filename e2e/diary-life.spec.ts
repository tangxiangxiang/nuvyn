import type { Locator, Page } from '@playwright/test'
import { test, expect } from './fixtures/auth'
import { chooseDiaryAction, chooseDiaryDayAction, openEmptyDiaryDay, saveDiaryDay, unlockDiary } from './helpers/diary-life'

const scrollTestImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==', 'base64')
const diaryLifeFixtureBaseYear = 1000 + Math.floor(Math.random() * 700)

function diaryLifeFixtureYear(testInfo: { repeatEachIndex: number; retry: number; project: { retries: number } }) {
  return diaryLifeFixtureBaseYear + testInfo.repeatEachIndex * (testInfo.project.retries + 1) + testInfo.retry
}

test.beforeEach(async ({ page }, testInfo) => {
  // The specs share a server database. Use a run-specific historical year so
  // a new run avoids stale fixtures, with disjoint years for retries/repeats.
  await page.clock.setFixedTime(new Date(diaryLifeFixtureYear(testInfo), 0, 10, 12))
})

function dateNumberOffset(cell: Locator) {
  return cell.locator('.life-date-number').evaluate(number => {
    const date = number.closest('.life-date')!.getBoundingClientRect()
    const text = number.getBoundingClientRect()
    return { x: text.x - date.x, y: text.y - date.y }
  })
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
      await openEmptyDiaryDay(page, cell, async () => {
        await cell.focus()
        await cell.press('Enter')
      })
      await expect(cell).toHaveAttribute('aria-pressed', 'true')
      await chooseDiaryDayAction(page, '添加一条', viewport.width <= 768)
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
      await page.getByRole('button', { name: '切换到人生事件' }).click()
      await expect(cell).toHaveAttribute('aria-pressed', 'false')
      await expect(cell.locator('img')).toHaveCount(0)
      expect(await dateNumberOffset(cell)).toEqual(numberBefore)
      expect(await calendar.locator('.n-calendar-header').innerText()).toBe(monthBefore)
      await cell.click()
      await expect(cell).toHaveAttribute('aria-pressed', 'true')
      await page.getByRole('button', { name: '新增事件', exact: true }).click()
      const eventTitle = `人生事件 ${viewport.width} (${testInfo.repeatEachIndex + 1})`
      await page.getByRole('textbox', { name: '事件标题', exact: true }).fill(eventTitle)
      if (viewport.width === 1280) {
        await page.getByRole('checkbox', { name: '每年重复' }).click()
        await page.getByRole('checkbox', { name: '显示倒数日' }).click()
      }
      await page.getByRole('button', { name: '保存', exact: true }).click()
      const eventDetail = page.getByTestId('diary-event-detail')
      await expect(eventDetail).toBeVisible()
      await expect(page.getByRole('textbox', { name: '事件标题', exact: true })).toBeHidden()
      const eventModal = page.locator('.diary-life-dialog')
      const eventModalBounds = await eventModal.boundingBox()
      expect(eventModalBounds).not.toBeNull()
      expect(eventModalBounds!.x).toBeGreaterThanOrEqual(0)
      expect(eventModalBounds!.x + eventModalBounds!.width).toBeLessThanOrEqual(viewport.width + 1)
      expect(eventModalBounds!.y + eventModalBounds!.height).toBeLessThanOrEqual(viewport.height + 1)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.getByRole('button', { name: '关闭事件详情' }).click()
      await expect(page.getByRole('button', { name: eventTitle, exact: true })).toBeVisible()
      await page.getByRole('button', { name: '关闭当天事件' }).click()
      await page.getByTestId('diary-event-list-toggle').click()
      const eventList = page.locator('.diary-event-list-dialog')
      await expect(eventList).toBeVisible()
      const listedEvent = eventList.getByRole('button').filter({ hasText: eventTitle })
      await expect(listedEvent).toBeVisible()
      await listedEvent.click()
      await expect(eventDetail).toBeVisible()
      await expect(page.getByRole('textbox', { name: '事件标题', exact: true })).toBeHidden()
      await page.getByRole('button', { name: '编辑', exact: true }).click()
      const eventTitleInput = page.getByRole('textbox', { name: '事件标题', exact: true })
      await expect(eventTitleInput).toHaveValue(eventTitle)
      await eventTitleInput.fill(`${eventTitle} 草稿`)
      await page.getByRole('button', { name: '取消', exact: true }).click()
      const eventDiscard = page.getByRole('dialog', { name: '放弃未保存的修改？' })
      await eventDiscard.getByRole('button', { name: /^(Cancel|取消)$/ }).click()
      await expect(eventTitleInput).toHaveValue(`${eventTitle} 草稿`)
      await page.getByRole('button', { name: '取消', exact: true }).click()
      await page.getByRole('dialog', { name: '放弃未保存的修改？' }).getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
      await expect(page.locator('.diary-event-modal-title')).toContainText(eventTitle)
      await page.getByRole('button', { name: '编辑', exact: true }).click()
      const updatedEventTitle = `${eventTitle} 更新`
      await eventTitleInput.fill(updatedEventTitle)
      await page.getByRole('button', { name: '保存', exact: true }).click()
      await expect(eventDetail).toBeVisible()
      await expect(eventTitleInput).toBeHidden()
      await expect(page.locator('.diary-event-modal-title')).toContainText(updatedEventTitle)
      await page.getByRole('button', { name: '关闭事件详情' }).click()
      await expect(eventList.getByRole('button').filter({ hasText: updatedEventTitle })).toBeVisible()
      await page.getByRole('button', { name: '关闭事件列表' }).click()
      await expect(cell).toHaveAttribute('aria-pressed', 'false')
      await cell.click()
      await expect(page.getByRole('button', { name: updatedEventTitle, exact: true })).toBeVisible()
      await page.getByRole('button', { name: updatedEventTitle, exact: true }).click()
      await expect(eventDetail).toBeVisible()
      await page.getByRole('button', { name: '关闭事件详情' }).click()
      await expect(page.getByRole('button', { name: updatedEventTitle, exact: true })).toBeVisible()
      await page.getByRole('button', { name: '关闭当天事件' }).click()
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
        await countdowns.getByRole('button').filter({ hasText: updatedEventTitle }).click()
        await expect(eventDetail).toBeVisible()
        await expect(page.getByRole('textbox', { name: '事件标题' })).toBeHidden()

        await page.getByRole('button', { name: '编辑', exact: true }).click()
        const lockedDraft = page.getByRole('textbox', { name: '事件标题', exact: true })
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
        await page.getByRole('button', { name: '保存', exact: true }).click()
        await expect(eventDetail).toHaveCount(0)
        const unlockButton = page.getByRole('button', { name: '解锁日记', exact: true })
        await expect(unlockButton).toBeVisible()
        await expect(lockedDraft).toHaveCount(0)
        await unlockButton.click()
        await unlockDiary(page)
        await expect(countdowns).toBeVisible()
        await countdowns.getByRole('button').filter({ hasText: updatedEventTitle }).click()
        await expect(eventDetail).toBeVisible()
        await expect(page.locator('.diary-event-modal-title')).toContainText(updatedEventTitle)
        await expect(page.locator('.diary-event-modal-title')).not.toContainText('锁定前草稿')

        await page.getByRole('button', { name: '更多事件操作' }).click()
        await page.getByRole('menuitem', { name: '删除事件' }).click()
        await page.getByRole('dialog', { name: '删除这条事件？' }).getByRole('button', { name: /^(Confirm|确认|确定)$/ }).click()
        await expect(cell.locator('img')).toHaveCount(0)
      }
    })
  })
}

test('Diary NavBar icon controls share the standard size across viewport widths', async ({ page }) => {
  await page.goto('/diary')
  await unlockDiary(page)

  const viewportWidths = [390, 430, 768, 1024, 1280, 1440]
  const selectors = [
    '.diary-view-toggle',
    '.diary-event-list-toggle',
    '.nav-search',
    '.theme-toggle',
    '[data-testid="account-button"]',
  ]

  for (const width of viewportWidths) {
    await page.setViewportSize({ width, height: 900 })
    const controls = selectors.map(selector => page.locator(`.navbar .nav-actions ${selector}`))
    for (const control of controls) await expect(control).toBeVisible()

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
      .toEqual(Array.from({ length: controls.length }, () => [28, 28]))
    expect(metrics.map(({ iconWidth, iconHeight, svgWidth, svgHeight }) => [iconWidth, iconHeight, svgWidth, svgHeight]))
      .toEqual(Array.from({ length: controls.length }, () => [18, 18, 18, 18]))
    expect(Math.max(...metrics.map(metric => metric.y)) - Math.min(...metrics.map(metric => metric.y)))
      .toBeLessThan(1)
    expect(metrics.slice(1).map((metric, index) => metric.x - metrics[index].x - metrics[index].width))
      .toEqual(Array.from({ length: controls.length - 1 }, () => width <= 600 ? 2 : 6))
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }

  const diaryToggles = [
    page.locator('.navbar .nav-actions .diary-view-toggle'),
    page.locator('.navbar .nav-actions .diary-event-list-toggle'),
  ]
  const search = page.locator('.navbar .nav-actions .nav-search')
  for (const diaryToggle of diaryToggles) {
    await diaryToggle.hover()
    const diaryHover = await readStableHoverColors(diaryToggle)
    await search.hover()
    expect(await readStableHoverColors(search)).toEqual(diaryHover)
  }
})

test('lunar Events preserve their rule across details, countdowns, editing and calendar dates', async ({ page }, testInfo) => {
  await page.clock.setFixedTime(new Date('2026-11-16T12:00:00+08:00'))
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/diary')
  await unlockDiary(page)
  if (await page.locator('html').getAttribute('data-theme') !== 'light') {
    await page.locator('.theme-toggle').click()
  }
  await page.getByRole('button', { name: '切换到人生事件' }).click()
  const calendar = page.locator('.diary-life-calendar')
  const startCell = calendar.locator('[data-date="2026-11-16"]')
  await startCell.click()
  await page.getByRole('button', { name: '新增事件', exact: true }).click()

  const title = `农历生日 ${testInfo.repeatEachIndex + 1}`
  await page.getByRole('textbox', { name: '事件标题', exact: true }).fill(title)
  await page.getByRole('checkbox', { name: '每年重复' }).click()
  await page.getByRole('button', { name: '农历', exact: true }).click()
  await page.getByLabel('农历月份').selectOption('5')
  await page.getByLabel('农历日期').selectOption('19')
  await page.getByRole('checkbox', { name: '显示倒数日' }).click()

  for (const width of [390, 430, 768, 1280]) {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 900 })
    await expect(page.getByLabel('农历月份')).toBeVisible()
    const modal = page.locator('.diary-life-dialog')
    const bounds = await modal.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  const lunarMonth = page.getByLabel('农历月份')
  await expect(lunarMonth).toHaveCSS('color-scheme', 'light')
  const createResponsePromise = page.waitForResponse(response => response.request().method() === 'PUT'
    && new URL(response.url()).pathname.startsWith('/api/diary/life/events/'))
  await page.getByRole('button', { name: '保存', exact: true }).click()
  const createdEvent = await (await createResponsePromise).json() as { event: { dateRule?: { calendar: string; lunarMonth: number; lunarDay: number } } }
  expect(createdEvent.event.dateRule).toMatchObject({ calendar: 'chinese', lunarMonth: 5, lunarDay: 19 })

  const detail = page.getByTestId('diary-event-detail')
  await expect(detail).toBeVisible()
  await expect(detail.getByText('农历五月十九', { exact: true })).toBeVisible()
  await expect(detail.getByText('2027年6月23日（公历）', { exact: false })).toBeVisible()
  const detailCountdown = await detail.locator('.diary-event-detail-countdown strong').innerText()
  expect(detailCountdown).toMatch(/^\d+$/)

  await page.getByRole('button', { name: '关闭事件详情' }).click()
  await page.getByRole('button', { name: '关闭当天事件' }).click()
  await page.getByTestId('diary-event-list-toggle').click()
  const eventList = page.locator('.diary-event-list-dialog')
  const listedEvent = eventList.getByRole('button').filter({ hasText: title })
  await expect(listedEvent.locator('.diary-event-list-meta')).toHaveText('农历五月十九 · 每年')
  await expect(listedEvent.locator('.diary-event-list-countdown strong')).toHaveText(detailCountdown)
  await listedEvent.click()
  await expect(detail.getByText('农历五月十九', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: '编辑', exact: true }).click()
  await page.getByLabel('农历日期').selectOption('20')
  await page.getByRole('button', { name: '取消', exact: true }).click()
  const discard = page.getByRole('dialog', { name: '放弃未保存的修改？' })
  await discard.getByRole('button', { name: /^(OK|Confirm|确认|确定)$/ }).click()
  await expect(detail.getByText('农历五月十九', { exact: true })).toBeVisible()
  await expect(detail.getByText('2027年6月23日（公历）', { exact: false })).toBeVisible()

  await page.getByRole('button', { name: '编辑', exact: true }).click()
  await page.getByLabel('农历日期').selectOption('20')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(detail.getByText('农历五月二十', { exact: true })).toBeVisible()
  await expect(detail.getByText('2027年6月24日（公历）', { exact: false })).toBeVisible()

  await page.getByRole('button', { name: '关闭事件详情' }).click()
  await expect(eventList).toBeVisible()
  await page.getByRole('button', { name: '关闭事件列表' }).click()
  await page.locator('.theme-toggle').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  const nextMonth = calendar.locator('.n-calendar-header').getByRole('button').last()
  for (let month = 0; month < 7; month++) await nextMonth.click()
  await expect(calendar.locator('.life-month')).toHaveText('2027-06')
  await expect(calendar.locator('[data-date="2027-06-23"] .life-marker')).toHaveCount(0)
  const occurrenceCell = calendar.locator('[data-date="2027-06-24"]')
  await expect(occurrenceCell.locator('.life-marker')).toBeVisible()
  await occurrenceCell.click()
  await page.getByRole('button', { name: title, exact: true }).click()
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  await expect(page.getByLabel('农历月份')).toHaveCSS('color-scheme', 'dark')
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await page.getByRole('button', { name: '更多事件操作' }).click()
  await page.getByRole('menuitem', { name: '删除事件' }).click()
  await page.getByRole('dialog', { name: '删除这条事件？' }).getByRole('button', { name: /^(OK|Confirm|确认|确定)$/ }).click()
  await expect(occurrenceCell.locator('.life-marker')).toHaveCount(0)
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
  await expect(cell).toHaveAttribute('aria-pressed', 'false')
  await expect(cell).not.toHaveClass(/\bselected\b/)
  await expect(cell.locator('.life-entry-marker')).toBeVisible()
})

test('clears the date highlight on Escape after opening with a pointer', async ({ page }) => {
  await page.goto('/diary')
  await unlockDiary(page)
  const cell = page.locator('.diary-life-calendar [data-date$="-01-27"]')
  await openEmptyDiaryDay(page, cell)
  await page.mouse.move(0, 0)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('diary-day-dialog')).toHaveCount(0)
  await expect(cell).toHaveAttribute('aria-pressed', 'false')
  await expect(cell.locator('.life-date-badge')).toHaveCSS('outline-style', 'none')

  await openEmptyDiaryDay(page, cell, async () => {
    await cell.focus()
    await cell.press('Enter')
  })
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('diary-day-dialog')).toHaveCount(0)
  await expect(cell).toHaveAttribute('aria-pressed', 'false')
  await expect(cell).toBeFocused()
  await expect(cell.locator('.life-date-badge')).toHaveCSS('outline-style', 'solid')
})

test('uses the server day boundary and enables editing after midnight without reopening', async ({ page }, testInfo) => {
  const year = diaryLifeFixtureYear(testInfo)
  const date = `${year}-01-28`
  await page.clock.install({ time: new Date(year, 0, 29, 12) })
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
  page.on('request', request => {
    if (request.url().endsWith('/heartbeat')) heartbeats.push(request.url())
  })
  await page.locator(`.diary-life-calendar [data-date="${date}"]`).click()
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
  await page.getByRole('button', { name: '选择心情' }).click()
  await page.getByTestId('diary-mood-picker').locator('[data-mood-id="happy"]').click()
  await saveDiaryDay(page)

  const dialog = page.getByTestId('diary-day-dialog')
  await expect(dialog.getByTestId('diary-day-mood')).toBeVisible()
  await expect(dialog.getByTestId('diary-empty-reading')).toBeVisible()
  await expect(dialog.getByTestId('diary-save-entry')).toHaveCount(0)
  const originalTheme = await page.locator('html').getAttribute('data-theme')
  await page.screenshot({ path: testInfo.outputPath(`diary-mood-only-read-${originalTheme ?? 'default'}.png`) })
  await page.getByRole('button', { name: '关闭日记' }).click()

  await page.locator('.theme-toggle').click()
  const alternateTheme = await page.locator('html').getAttribute('data-theme')
  expect(alternateTheme).not.toBe(originalTheme)
  await cell.click()
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
  const unlockButton = page.getByRole('button', { name: '解锁日记', exact: true })
  await expect(unlockButton).toBeVisible()
  await unlockButton.click()
  await expect(page.getByRole('dialog', { name: /解锁日记|Unlock Diary/ })).toBeVisible()
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

    await openEmptyDiaryDay(page, today)
    await expect(today).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('diary-edit-entry')).toHaveCount(0)
    await page.getByTestId('diary-cancel-edit').click()
    await expect(page.getByTestId('diary-day-dialog')).toHaveCount(0)
    await expect(today).toHaveAttribute('aria-pressed', 'false')
    const numberBefore = await dateNumberOffset(today)
    await page.getByRole('button', { name: '切换到人生事件' }).click()
    await expect(today).toHaveAttribute('aria-pressed', 'false')
    await expect(title).toHaveText(monthBefore)
    expect((await calendar.boundingBox())!.height).toBe(calendarBox.height)
    expect(await dateNumberOffset(today)).toEqual(numberBefore)
    await page.screenshot({ path: testInfo.outputPath('calendar-layout.png') })
  })
}
