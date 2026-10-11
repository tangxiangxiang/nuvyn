import { expect, goBackFromDiaryDocument, test } from './fixtures/diary'
import { CALENDAR_TEST_DATE, CALENDAR_TEST_TIME_ZONE } from './helpers/calendar-clock'

test.use({ timezoneId: CALENDAR_TEST_TIME_ZONE, trace: 'off', screenshot: 'only-on-failure' })

test('Zen Mode works on an unlocked Diary document and Diary Back still returns to Calendar', async ({ page, request }) => {
  const path = `diary/${CALENDAR_TEST_DATE}`
  const prior = await request.get(`/api/posts/${path}`)
  if (prior.status() !== 404) {
    expect(prior.status(), await prior.text()).toBe(200)
    const deleted = await request.delete(`/api/posts/${path}`)
    expect([200, 404, 422]).toContain(deleted.status())
  }

  const created = await request.post('/api/diary/dates', {
    data: { date: CALENDAR_TEST_DATE, timeZone: CALENDAR_TEST_TIME_ZONE },
  })
  expect(created.status(), await created.text()).toBe(201)
  const initial = await request.get(`/api/posts/${path}`)
  expect(initial.status()).toBe(200)
  const body = await initial.json() as { raw: string }
  const saved = await request.put(`/api/posts/${path}`, {
    data: { raw: '# Zen Diary\n\nPrivate body stays in the native Diary editor.\n', baseRaw: body.raw },
  })
  expect(saved.status(), await saved.text()).toBe(200)

  try {
    await page.goto(`/vault/${path}`)
    await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveAttribute('aria-selected', 'true')
    const viewToggle = page.getByTestId('view-toggle')
    const viewToggleLabel = await viewToggle.getAttribute('aria-label')
    if (/edit|编辑/i.test(viewToggleLabel ?? '')) await viewToggle.click()
    await expect(page.locator('.editor-pane .monaco-editor')).toBeVisible()
    await page.setViewportSize({ width: 375, height: 812 })
    const vault = page.locator('.vault')
    const editor = page.locator('.editor-pane .monaco-editor').first()
    await editor.evaluate((element) => {
      Object.defineProperty(window, '__zenModeDiaryEditorNode', { value: element, configurable: true })
    })

    const brand = page.locator('.navbar .brand')
    const originalUrl = page.url()
    await brand.evaluate((element) => {
      element.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        pointerId: 51,
        pointerType: 'touch',
        clientX: 24,
        clientY: 18,
      }))
    })
    await expect(page.locator('.brand-constellation')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('.brand-network-virtue')).toHaveText(/Courage|勇气/, { timeout: 1000 })
    await brand.evaluate((element) => {
      element.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true,
        pointerId: 51,
        pointerType: 'touch',
        clientX: 24,
        clientY: 18,
      }))
      element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await expect(vault).toHaveAttribute('data-zen-mode', 'true', { timeout: 8500 })
    expect(page.url()).toBe(originalUrl)
    expect(await page.evaluate(() => (
      (window as Window & { __zenModeDiaryEditorNode?: Element }).__zenModeDiaryEditorNode
      === document.querySelector('.editor-pane .monaco-editor')
    ))).toBe(true)
    await expect(page.locator('.navbar')).toHaveCount(0)
    await expect(page.locator('.activity-bar, .file-tree, .right-rail-slot, .status-bar-row')).toHaveCount(0)
    const mobileLayout = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
    }))
    expect(mobileLayout.scrollWidth).toBeLessThanOrEqual(mobileLayout.clientWidth)
    expect(mobileLayout.scrollHeight).toBeLessThanOrEqual(mobileLayout.clientHeight)

    // The existing Diary G → B return remains available from the document surface.
    await vault.focus()
    await page.keyboard.press('g')
    await page.keyboard.press('b')
    await expect(vault).toHaveAttribute('data-zen-mode', 'false')
    await expect(page.getByTestId('diary-calendar-surface')).toBeVisible()
    await expect(page).toHaveURL(/\/vault(?:[?#]|$)/)

    // If opened again, Zen Mode never survives an explicit Diary lock.
    await page.goto(`/vault/${path}`)
    await expect(page.locator('.reading-pane, .editor-pane').first()).toBeVisible()
    await vault.focus()
    await page.keyboard.press('ControlOrMeta+K')
    await page.keyboard.press('z')
    await expect(vault).toHaveAttribute('data-zen-mode', 'true')

    await page.keyboard.press('Escape')
    await expect(vault).toHaveAttribute('data-zen-mode', 'false')
    await page.getByTestId('account-button').click()
    await page.getByTestId('account-lock-diary').click()
    await expect(page.getByTestId('account-menu')).toHaveCount(0)
    await vault.focus()
    await page.keyboard.press('ControlOrMeta+K')
    await page.keyboard.press('z')
    await expect(vault).toHaveAttribute('data-zen-mode', 'false')
  } finally {
    await page.goto('/vault').catch(() => undefined)
    await goBackFromDiaryDocument(page).catch(() => undefined)
    const deleted = await request.delete(`/api/posts/${path}`)
    expect([200, 404, 422]).toContain(deleted.status())
  }
})
