import { expect, test } from './fixtures/auth'
import { createDoc, gotoVaultReady, openDoc, setEditorContent } from './helpers/edit-program'

const RUN_ID = String(Date.now())

test('Zen Mode preserves Vault layout and the mounted editor across edit and read surfaces', async ({ page, request }) => {
  const path = `inbox/zen-mode-${RUN_ID}`
  const createdPaths: string[] = []

  try {
    await createDoc(request, path, '# Zen Mode\n\nOriginal body.\n', createdPaths)
    await gotoVaultReady(page)
    await openDoc(page, path)

    const layouts = [
      { activePanel: 'files', leftSidebarCollapsed: false, sidePanelWidth: 301, rightRailTab: 'ai', rightRailWidth: 412, rightRailCollapsed: false },
      { activePanel: 'files', leftSidebarCollapsed: false, sidePanelWidth: 317, rightRailTab: 'toc', rightRailWidth: 426, rightRailCollapsed: true },
      { activePanel: 'tags', leftSidebarCollapsed: true, sidePanelWidth: 329, rightRailTab: 'properties', rightRailWidth: 438, rightRailCollapsed: false },
      { activePanel: 'history', leftSidebarCollapsed: true, sidePanelWidth: 343, rightRailTab: 'history', rightRailWidth: 450, rightRailCollapsed: true },
    ]

    for (const layout of layouts) {
      await page.evaluate((value) => {
        localStorage.setItem('nuvyn.vault.layout', JSON.stringify(value))
      }, layout)
      await page.reload()
      await expect(page.locator('.editor-pane .monaco-editor')).toBeVisible()
      await expect(page.locator('.navbar')).toBeVisible()

      const persistedLayout = await page.evaluate(() => localStorage.getItem('nuvyn.vault.layout'))
      const editor = page.locator('.editor-pane .monaco-editor').first()
      await editor.evaluate((element) => {
        Object.defineProperty(window, '__zenModeEditorNode', { value: element, configurable: true })
      })
      await editor.locator('.view-lines').click()
      await page.keyboard.press('ControlOrMeta+K')
      await page.keyboard.press('z')

      const vault = page.locator('.vault')
      await expect(vault).toHaveAttribute('data-zen-mode', 'true')
      await expect(page.locator('.editor-pane .monaco-editor')).toBeVisible()
      await expect(page.locator('.navbar')).toHaveCount(0)
      await expect(page.locator('.activity-bar')).toHaveCount(0)
      await expect(page.locator('.file-tree, .tag-panel, .history-panel')).toHaveCount(0)
      await expect(page.locator('.right-rail-slot')).toHaveCount(0)
      await expect(page.locator('.editor-tabs-shell')).toBeHidden()
      await expect(page.locator('.status-bar-row')).toHaveCount(0)
      await expect(page.locator('.splitter')).toHaveCount(0)

      const zenLayout = await vault.evaluate((element) => {
        const style = getComputedStyle(element)
        const main = document.querySelector('main.container')
        return {
          gridColumns: style.gridTemplateColumns,
          navbarHeight: main ? getComputedStyle(main).getPropertyValue('--navbar-h').trim() : null,
          scrollWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          layout: localStorage.getItem('nuvyn.vault.layout'),
          focusWidth: localStorage.getItem('nuvyn.editor.focus-width'),
        }
      })
      expect(zenLayout.gridColumns.trim().split(/\s+/)).toHaveLength(1)
      expect(zenLayout.navbarHeight).toBe('0px')
      expect(zenLayout.scrollWidth).toBeLessThanOrEqual(zenLayout.viewportWidth)
      expect(zenLayout.layout).toBe(persistedLayout)

      const editorBounds = await editor.boundingBox()
      const vaultBounds = await vault.boundingBox()
      expect(editorBounds).not.toBeNull()
      expect(vaultBounds).not.toBeNull()
      expect(Math.abs(
        editorBounds!.x + editorBounds!.width / 2 - vaultBounds!.x - vaultBounds!.width / 2,
      )).toBeLessThan(3)

      // Exercise repeatable entry/exit in all four user layout combinations.
      await page.keyboard.press('ControlOrMeta+K')
      await page.keyboard.press('z')
      await expect(vault).toHaveAttribute('data-zen-mode', 'false')
      expect(await page.evaluate(() => (
        (window as Window & { __zenModeEditorNode?: Element }).__zenModeEditorNode
        === document.querySelector('.editor-pane .monaco-editor')
      ))).toBe(true)
      expect(await page.evaluate(() => localStorage.getItem('nuvyn.vault.layout'))).toBe(persistedLayout)
    }

    const editor = page.locator('.editor-pane .monaco-editor').first()
    await setEditorContent(page, 'ZENMODE_UNSAVED_MARKER')
    await editor.locator('.view-lines').click()
    await page.keyboard.press('ControlOrMeta+K')
    await page.keyboard.press('z')
    await expect(page.locator('.vault')).toHaveAttribute('data-zen-mode', 'true')
    await expect(page.locator('.editor-pane .monaco-editor .view-lines')).toContainText('ZENMODE_UNSAVED_MARKER')

    // Escape exits while keeping the same editor, selection model, and dirty text alive.
    await page.keyboard.press('Escape')
    await expect(page.locator('.vault')).toHaveAttribute('data-zen-mode', 'false')
    await expect(page.locator('.editor-pane .monaco-editor .view-lines')).toContainText('ZENMODE_UNSAVED_MARKER')

    // Reading mode remains intact when Zen Mode is entered and exited.
    await page.getByTestId('view-toggle').click()
    await expect(page.locator('.reading-pane')).toBeVisible()
    await page.setViewportSize({ width: 375, height: 800 })
    await page.locator('.reading-pane').click()
    await page.keyboard.press('ControlOrMeta+K')
    await page.keyboard.press('z')
    await expect(page.locator('.reading-pane')).toBeVisible()
    await expect(page.locator('.vault')).toHaveAttribute('data-zen-mode', 'true')
    await expect(page.locator('.navbar')).toHaveCount(0)
    await expect(page.locator('.activity-bar, .file-tree, .right-rail-slot, .status-bar-row')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    await page.keyboard.press('ControlOrMeta+K')
    await page.keyboard.press('z')
    await expect(page.locator('.vault')).toHaveAttribute('data-zen-mode', 'false')
    await expect(page.locator('.reading-pane')).toBeVisible()
    await page.setViewportSize({ width: 1280, height: 900 })

    await page.getByTestId('view-toggle').click()
    await expect(page.locator('.editor-pane .monaco-editor')).toBeVisible()
    await page.locator('.editor-pane .monaco-editor .view-lines').click()
    await page.keyboard.press('ControlOrMeta+K')
    await page.keyboard.press('z')
    await expect(page.locator('.vault')).toHaveAttribute('data-zen-mode', 'true')
    await page.keyboard.press('Escape')
    await expect(page.locator('.vault')).toHaveAttribute('data-zen-mode', 'false')

    // Zen state is never persisted, even when a browser reload interrupts it.
    await page.locator('.editor-pane .monaco-editor .view-lines').click()
    await page.keyboard.press('ControlOrMeta+K')
    await page.keyboard.press('z')
    await expect(page.locator('.vault')).toHaveAttribute('data-zen-mode', 'true')
    await page.reload()
    await expect(page.locator('.vault')).toHaveAttribute('data-zen-mode', 'false')
    await expect(page.locator('.navbar')).toBeVisible()

    for (const width of [375, 768, 1024]) {
      await page.setViewportSize({ width, height: 800 })
      await page.locator('.editor-pane .monaco-editor .view-lines').click()
      await page.keyboard.press('ControlOrMeta+K')
      await page.keyboard.press('z')
      const vault = page.locator('.vault')
      await expect(vault).toHaveAttribute('data-zen-mode', 'true')
      await expect(page.locator('.editor-pane .monaco-editor')).toBeVisible()
      await expect(page.locator('.navbar, .activity-bar, .file-tree, .right-rail-slot, .status-bar-row')).toHaveCount(0)
      const viewportLayout = await page.evaluate(() => {
        const main = document.querySelector('main.container')
        return {
          width: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          height: document.documentElement.scrollHeight,
          clientHeight: document.documentElement.clientHeight,
          shellHeight: main?.getBoundingClientRect().height ?? 0,
          viewportHeight: window.innerHeight,
        }
      })
      expect(viewportLayout.width).toBeLessThanOrEqual(viewportLayout.clientWidth)
      expect(viewportLayout.height).toBeLessThanOrEqual(viewportLayout.clientHeight)
      expect(Math.abs(viewportLayout.shellHeight - viewportLayout.viewportHeight)).toBeLessThan(2)

      // A viewport resize does not end the temporary Zen state.
      if (width === 1024) {
        await page.setViewportSize({ width: 375, height: 800 })
        await expect(vault).toHaveAttribute('data-zen-mode', 'true')
      }
      await page.keyboard.press('Escape')
      await expect(vault).toHaveAttribute('data-zen-mode', 'false')
    }

    await page.setViewportSize({ width: 1280, height: 900 })

    // The tab is clean before close; the empty Vault home does not enter Zen Mode.
    await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveAttribute('aria-label', /Saved/)
    await page.locator(`[role="tab"][data-tab-id="${path}"] .tab-close`).click()
    await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveCount(0)
    await page.goto('/vault')
    await page.locator('.vault').focus()
    await page.keyboard.press('ControlOrMeta+K')
    await page.keyboard.press('z')
    await expect(page.locator('.vault')).toHaveAttribute('data-zen-mode', 'false')
  } finally {
    for (const createdPath of createdPaths) {
      const deleted = await request.delete(`/api/posts/${createdPath}`)
      expect([200, 404]).toContain(deleted.status())
    }
  }
})

test('touch long press on the brand enters Zen Mode after the constellation finishes', async ({ page, request }) => {
  const path = `inbox/zen-brand-touch-${RUN_ID}`
  const createdPaths: string[] = []

  try {
    await createDoc(request, path, '# Touch Zen Mode\n\nThe document remains mounted.\n', createdPaths)
    await gotoVaultReady(page)
    await openDoc(page, path)
    const currentViewportWidth = page.viewportSize()?.width ?? 375
    const touchViewportWidth = currentViewportWidth > 600 ? 768 : 375
    await page.setViewportSize({ width: touchViewportWidth, height: 812 })

    const brand = page.locator('.navbar .brand')
    const editor = page.locator('.editor-pane .monaco-editor').first()
    await editor.evaluate((element) => {
      Object.defineProperty(window, '__zenModeEditorNode', { value: element, configurable: true })
    })
    const originalUrl = page.url()
    await brand.evaluate((element) => {
      element.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        pointerId: 42,
        pointerType: 'touch',
        clientX: 24,
        clientY: 18,
      }))
    })
    await expect(page.locator('.brand-constellation')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('.brand-network-virtue')).toHaveText(/Courage|勇气/, { timeout: 1000 })

    // Releasing after recognition does not stop the animation. The click
    // synthesized by mobile browsers is consumed rather than routed home.
    await brand.evaluate((element) => {
      element.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true,
        pointerId: 42,
        pointerType: 'touch',
        clientX: 24,
        clientY: 18,
      }))
      element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await expect(page.locator('.vault')).toHaveAttribute('data-zen-mode', 'true', { timeout: 8500 })
    await expect(page.locator('.navbar')).toHaveCount(0)
    expect(page.url()).toBe(originalUrl)
    expect(await page.evaluate(() => (
      (window as Window & { __zenModeEditorNode?: Element }).__zenModeEditorNode
      === document.querySelector('.editor-pane .monaco-editor')
    ))).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)

    // Reload is the mobile-safe reset path: Zen Mode is intentionally not
    // persisted and phones/tablets do not gain a dedicated exit control.
    await page.reload()
    await expect(page.locator('.vault')).toHaveAttribute('data-zen-mode', 'false')
    await expect(page.locator('.navbar .brand')).toBeVisible()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await brand.evaluate((element) => {
      element.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        pointerId: 43,
        pointerType: 'touch',
        clientX: 24,
        clientY: 18,
      }))
    })
    await expect(page.locator('.vault')).toHaveAttribute('data-zen-mode', 'true', { timeout: 5000 })
  } finally {
    for (const createdPath of createdPaths) {
      const deleted = await request.delete(`/api/posts/${createdPath}`)
      expect([200, 404]).toContain(deleted.status())
    }
  }
})
