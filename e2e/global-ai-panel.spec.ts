import { expect, test } from './fixtures/auth'
import {
  cleanupCreatedPaths,
  createDoc,
  gotoVaultReady,
  interceptAiChatGated,
  sse,
  sendAi,
} from './helpers/edit-program'
import type { AnyRecord } from './helpers/edit-program'
import { ensureVaultLeftDrawerOpen, selectWorkspace } from './helpers/workspace-navigation'

test('global AI drag position persists, stays in view, and resets on title double-click', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await gotoVaultReady(page)
  const trigger = page.getByTestId('global-ai-trigger')
  await trigger.click()
  const panel = page.getByTestId('global-ai-panel')
  await expect(panel).toBeVisible()
  await expect(panel).toHaveCSS('transform', 'none')

  const initial = await panel.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { left: rect.left, top: rect.top }
  })
  const dragRegion = panel.locator('.ai-floating-drag-region')
  const box = await dragRegion.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await page.mouse.down()
  await page.mouse.move(box!.x + box!.width / 2 - 110, box!.y + box!.height / 2 + 42, { steps: 5 })
  await page.mouse.up()

  const moved = await panel.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { left: rect.left, top: rect.top }
  })
  expect(moved.left).toBeLessThan(initial.left)
  expect(moved.top).toBeGreaterThan(initial.top)
  expect(moved.left).toBeGreaterThanOrEqual(8)
  expect(moved.top).toBeGreaterThanOrEqual(await page.locator('.navbar').evaluate((element) => element.getBoundingClientRect().bottom + 8))

  await panel.getByTestId('global-ai-close').click()
  await expect(panel).toBeHidden()
  await trigger.click()
  await expect(panel).toBeVisible()
  await expect(panel).toHaveCSS('transform', 'none')
  await expect.poll(() => panel.evaluate((element) => element.getBoundingClientRect().left)).toBeCloseTo(moved.left, 0)

  await page.reload()
  await gotoVaultReady(page)
  await page.getByTestId('global-ai-trigger').click()
  await expect(panel).toHaveCSS('transform', 'none')
  const restored = await panel.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { left: rect.left, top: rect.top }
  })
  expect(restored.left).toBeCloseTo(moved.left, 0)
  expect(restored.top).toBeCloseTo(moved.top, 0)

  await panel.locator('.ai-floating-drag-region').dblclick()
  const reset = await panel.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { left: rect.left, top: rect.top }
  })
  expect(reset.left).toBeGreaterThan(moved.left)
  expect(reset.top).toBeLessThan(moved.top)
})

test('an in-flight Note response survives a workspace switch and later requests get no Ledger context', async ({ page, request }) => {
  await page.setViewportSize({ width: 1024, height: 768 })
  const slug = `inbox/e2e-global-ai-${Date.now()}`
  const created: string[] = []
  const chatBodies: AnyRecord[] = []
  let releaseStream!: () => void
  const streamGate = new Promise<void>((resolve) => { releaseStream = resolve })
  try {
    await createDoc(request, slug, '# Global AI context test\n\nA Note snapshot.', created)
    await interceptAiChatGated(page, chatBodies, streamGate, () => [
      sse('user', { id: 1 }),
      sse('token', { text: 'stream finished after switching workspaces' }),
      sse('done', { userId: 1, assistantId: 2 }),
    ].join(''))
    await gotoVaultReady(page)
    await ensureVaultLeftDrawerOpen(page)
    const row = page.locator(`[data-tree-key="file:${slug}"]`)
    if (!(await row.isVisible().catch(() => false))) {
      await page.locator(`[data-tree-key="folder:${slug.split('/')[0]}"]`).click()
    }
    await expect(row).toBeVisible()
    await row.locator(':scope > .row-line').dblclick()
    await expect(page.locator('.editor-pane .monaco-editor .view-lines').first()).toBeVisible()
    await page.getByTestId('global-ai-trigger').click()
    const panel = page.getByTestId('global-ai-panel')
    await expect(panel).toBeVisible()

    await sendAi(page, 'capture the current Note')
    await expect.poll(() => chatBodies.length).toBe(1)
    expect(chatBodies[0]?.liveContext?.identity?.path).toBe(slug)

    const historyButton = panel.getByTestId('global-ai-history')
    await historyButton.click()
    const historyDialog = page.locator('.ai-sp-dialog')
    await expect(historyDialog).toBeFocused()
    await expect(historyDialog.locator('.ai-sp-new')).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(historyDialog).toBeHidden()
    await expect(historyButton).toBeFocused()

    await selectWorkspace(page, 'ledger')
    await expect(page).toHaveURL(/\/ledger(?:\/|$)/)
    await expect(panel).toBeVisible()
    releaseStream()
    await expect(panel.getByText('stream finished after switching workspaces')).toBeVisible()

    await sendAi(page, 'ordinary Ledger workspace question')
    await expect.poll(() => chatBodies.length).toBe(2)
    expect(chatBodies[1]).not.toHaveProperty('liveContext')
    expect(JSON.stringify(chatBodies[1])).not.toContain(slug)

    await selectWorkspace(page, 'board')
    await expect(page).toHaveURL(/\/board(?:\/|$)/)
    await expect.poll(async () => (
      await page.getByTestId('global-ai-trigger').count()
      + await page.getByTestId('immersive-global-ai-trigger').count()
    )).toBeGreaterThan(0)
    await expect(panel).toBeVisible()
  } finally {
    releaseStream()
    await cleanupCreatedPaths(request, created)
  }
})

test('a workspace modal takes priority over the floating AI panel and consumes the first Escape', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 })
  await gotoVaultReady(page)
  const trigger = page.getByTestId('global-ai-trigger')
  await trigger.click()
  const panel = page.getByTestId('global-ai-panel')
  await expect(panel).toBeVisible()

  await page.locator('.mobile-workspace-selector').click()
  const workspaceDialog = page.locator('#workspace-switcher-dialog')
  await expect(workspaceDialog).toBeVisible()
  await expect(panel).toBeHidden()
  await page.keyboard.press('Escape')
  await expect(workspaceDialog).toBeHidden()
  await expect(panel).toBeVisible()
  await expect(trigger).toHaveAttribute('aria-pressed', 'true')

  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  await expect(trigger).toBeFocused()
})

test.describe('tablet global AI panel', () => {
  test.use({ hasTouch: true, isMobile: false, viewport: { width: 1024, height: 768 } })

  test('keeps a floating layout and supports touch dragging within the viewport', async ({ page }) => {
    await gotoVaultReady(page)
    await page.getByTestId('global-ai-trigger').tap()
    const panel = page.getByTestId('global-ai-panel')
    await expect(panel).toBeVisible()

    const before = await panel.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return { left: rect.left, top: rect.top }
    })
    const box = await panel.locator('.ai-floating-drag-region').boundingBox()
    expect(box).not.toBeNull()
    const client = await page.context().newCDPSession(page)
    const x = box!.x + box!.width / 2
    const y = box!.y + box!.height / 2
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ id: 1, x, y, radiusX: 2, radiusY: 2, force: 1 }],
    })
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ id: 1, x: x - 72, y: y + 36, radiusX: 2, radiusY: 2, force: 1 }],
    })
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await client.detach()

    const after = await panel.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return { left: rect.left, top: rect.top }
    })
    expect(after.left).toBeLessThan(before.left)
    expect(after.top).toBeGreaterThan(before.top)
    expect(after.left).toBeGreaterThanOrEqual(8)
    expect(after.top).toBeGreaterThanOrEqual(await page.locator('.navbar').evaluate((element) => element.getBoundingClientRect().bottom + 8))
  })
})

test.describe('mobile global AI panel', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })

  test('opens as a full-screen touch panel and closes without a backdrop', async ({ page }) => {
    await gotoVaultReady(page)
    await page.getByTestId('global-ai-trigger').tap()
    const panel = page.getByTestId('global-ai-panel')
    await expect(panel).toBeVisible()
    await expect(panel).toHaveCSS('position', 'fixed')
    await expect(panel.locator('.ai-floating-drag-region')).toHaveCSS('cursor', 'default')
    await panel.getByTestId('global-ai-close').tap()
    await expect(panel).toBeHidden()
    await expect(page.locator('.ai-floating-backdrop')).toHaveCount(0)
  })
})
