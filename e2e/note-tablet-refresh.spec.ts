import { randomUUID } from 'node:crypto'
import { expect, test } from './fixtures/auth'
import { createDoc } from './helpers/edit-program'

test.use({ hasTouch: true, viewport: { width: 768, height: 1024 } })

for (const mode of ['edit', 'read']) {
  test(`tablet ${mode} content follows a pull and returns without reloading the document`, async ({ page, request, context }) => {
    const path = `inbox/tablet-refresh-${randomUUID()}`
    const raw = '# Refresh\n\nKeep this content.'
    await createDoc(request, path, raw, [])
    let release = () => {}
    try {
      await page.goto(`/vault/${path}`)
      const toggle = page.getByTestId('view-toggle')
      await expect(toggle).toBeVisible()
      const label = await toggle.getAttribute('aria-label') ?? ''
      if ((mode === 'edit' && /edit|编辑/i.test(label)) || (mode === 'read' && /read|阅读/i.test(label))) await toggle.tap()
      const surface = page.locator(mode === 'edit' ? '.monaco-host' : '.reading-pane')
      await expect(surface).toBeVisible()
      if (mode === 'edit') {
        await expect(surface.locator('.view-lines')).toBeVisible()
        await surface.evaluate((element) => {
          const editor = (element as any).__vueParentComponent.setupState.editor
          ;(window as any).__pullEditor = editor
          ;(window as any).__pullModel = editor.getModel()
        })
      }
      const area = page.locator('.editor-area')
      const before = (await area.boundingBox())!
      const navbarBefore = (await page.locator('.navbar').boundingBox())!
      const box = (await surface.boundingBox())!
      const session = await context.newCDPSession(page)
      async function pull(distance: number) {
        const x = box.x + box.width / 2
        const y = box.y + 100
        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
        for (let step = 1; step <= 10; step++) await session.send('Input.dispatchTouchEvent', {
          type: 'touchMove', touchPoints: [{ x, y: y + distance * step / 10 }],
        })
      }
      // A short pull moves the content but cancels without refreshing.
      let reads = 0
      const gate = new Promise<void>((resolve) => { release = resolve })
      await page.route('**/api/tree', async (route) => { reads++; await gate; await route.continue() })
      await pull(40)
      await expect.poll(async () => (await area.boundingBox())!.y).toBeGreaterThan(before.y + 10)
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await expect.poll(async () => Math.abs((await area.boundingBox())!.y - before.y)).toBeLessThan(1)
      expect(reads).toBe(0)

      await pull(140)
      const pulled = (await area.boundingBox())!
      expect(pulled.y - before.y).toBeGreaterThan(30)
      expect(pulled.y - before.y).toBeLessThanOrEqual(54)
      expect((await page.locator('.navbar').boundingBox())!.y).toBe(navbarBefore.y)
      await expect(page.locator('.vault-tablet-refresh-indicator.is-armed')).toBeVisible()
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await expect(page.locator('.vault-tablet-refresh-indicator.is-refreshing')).toBeVisible()
      await expect.poll(() => reads).toBe(1)
      release()
      await expect(page.locator('.vault-tablet-refresh-indicator')).toHaveCount(0)
      await expect.poll(async () => Math.abs((await area.boundingBox())!.y - before.y)).toBeLessThan(1)
      await expect(page).toHaveURL(new RegExp(`/vault/${path}$`))
      if (mode === 'edit') expect(await surface.evaluate((element) => {
        const editor = (element as any).__vueParentComponent.setupState.editor
        return editor === (window as any).__pullEditor && editor.getModel() === (window as any).__pullModel
      })).toBe(true)
      expect((await (await request.get(`/api/posts/${path}`)).json()).raw).toBe(raw)
      await session.detach()
    } finally {
      release()
      await request.delete(`/api/posts/${path}`)
    }
  })
}

for (const viewport of [
  { label: 'phone', width: 390, height: 844 },
  { label: 'portrait Pad', width: 768, height: 1024 },
  { label: 'landscape Pad', width: 1024, height: 768 },
]) {
  test(`${viewport.label} Note status bar follows the document sheet during pull-to-refresh`, async ({ page, request, context }) => {
  const path = `inbox/note-refresh-footer-${viewport.width}-${randomUUID()}`
  await createDoc(request, path, '# Phone refresh\n\nContent remains readable.', [])
  try {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.goto(`/vault/${path}`)
    const toggle = page.getByTestId('view-toggle')
    await expect(toggle).toBeVisible()
    const label = await toggle.getAttribute('aria-label') ?? ''
    if (/read|阅读/i.test(label)) await toggle.tap()
    const surface = page.locator('.reading-pane')
    const area = page.locator('.editor-area')
    const footer = page.locator('.status-bar-row')
    const focusControl = footer.locator('.sb-focus-width')
    await expect(surface).toBeVisible()
    await expect(focusControl).toBeVisible()
    await expect(page.locator('.vault')).toHaveClass(/note-tablet-mode/)

    const areaBefore = (await area.boundingBox())!
    const footerBefore = (await footer.boundingBox())!
    const surfaceBox = (await surface.boundingBox())!
    const x = surfaceBox.x + surfaceBox.width / 2
    const y = surfaceBox.y + 90
    const session = await context.newCDPSession(page)
    try {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchStart', touchPoints: [{ x, y }],
      })
      // Below the threshold: test the visual pull without a network refresh.
      for (let step = 1; step <= 7; step++) {
        await session.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x, y: y + step * 10 }],
        })
      }
      await expect(page.locator('.vault.is-pulling-refresh')).toBeVisible()
      await expect.poll(async () => (await area.boundingBox())!.y - areaBefore.y).toBeGreaterThan(20)
      const areaOffset = (await area.boundingBox())!.y - areaBefore.y
      const footerOffset = (await footer.boundingBox())!.y - footerBefore.y
      expect(Math.abs(footerOffset - areaOffset)).toBeLessThanOrEqual(2)

      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await expect.poll(async () => Math.abs((await area.boundingBox())!.y - areaBefore.y)).toBeLessThan(1)
      await expect.poll(async () => Math.abs((await footer.boundingBox())!.y - footerBefore.y)).toBeLessThan(1)
      await expect(focusControl).toBeVisible()
      await expect(page).toHaveURL(new RegExp(`/vault/${path}$`))
    } finally {
      await session.detach()
    }
  } finally {
    await request.delete(`/api/posts/${path}`)
  }
  })
}
