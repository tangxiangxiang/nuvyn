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
    await page.locator('.reading-pane').click()
    await page.keyboard.press('ControlOrMeta+K')
    await page.keyboard.press('z')
    await expect(page.locator('.reading-pane')).toBeVisible()
    await expect(page.locator('.vault')).toHaveAttribute('data-zen-mode', 'true')
    await page.keyboard.press('ControlOrMeta+K')
    await page.keyboard.press('z')
    await expect(page.locator('.vault')).toHaveAttribute('data-zen-mode', 'false')
    await expect(page.locator('.reading-pane')).toBeVisible()

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

    await page.setViewportSize({ width: 600, height: 800 })
    await page.locator('.editor-pane .monaco-editor .view-lines').click()
    await page.keyboard.press('ControlOrMeta+K')
    await page.keyboard.press('z')
    await expect(page.locator('.vault')).toHaveAttribute('data-zen-mode', 'false')
    await page.setViewportSize({ width: 1280, height: 900 })

    await page.locator('.editor-pane .monaco-editor .view-lines').click()
    await page.keyboard.press('ControlOrMeta+K')
    await page.keyboard.press('z')
    await expect(page.locator('.vault')).toHaveAttribute('data-zen-mode', 'true')
    await page.setViewportSize({ width: 600, height: 800 })
    await expect(page.locator('.vault')).toHaveAttribute('data-zen-mode', 'false')
    await page.setViewportSize({ width: 1280, height: 900 })

    // The empty Vault home does not enter Zen Mode.
    await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveAttribute('data-save-status', 'saved')
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
