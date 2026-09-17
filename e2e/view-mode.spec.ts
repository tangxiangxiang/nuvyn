import { expect, test } from './fixtures/auth'

/* Control is accepted by both the vault handler and Monaco in Chromium on
   every CI host, avoiding a Node-host/browser-platform mismatch. */
const primaryModifier = 'Control'
const TEST_DOC_PATH = 'inbox/e2e-shortcut-test'

async function openShortcutDocument(page: import('@playwright/test').Page) {
  const testRow = page.locator('.tree-row').filter({ hasText: 'Shortcut Test' }).first()
  if (!await testRow.isVisible()) {
    const inbox = page.locator('.tree-row.folder').filter({ hasText: 'inbox' }).first()
    await inbox.locator('.chevron').click()
  }
  await testRow.click()
}

async function focusMonacoInput(page: import('@playwright/test').Page) {
  const editor = page.locator('.monaco-editor')
  await editor.waitFor({ state: 'visible', timeout: 10_000 })
  // Use Monaco's pointer surface so its controller, cursor, and EditContext
  // all acquire focus together; directly focusing an ARIA mirror textbox does
  // not activate Monaco's keybinding service.
  await editor.locator('.view-lines').click({ position: { x: 40, y: 12 } })
  await expect(editor).toHaveClass(/focused/)
}

test.describe('View mode toggle', () => {
  test.beforeEach(async ({ page }) => {
    // Ensure a known document exists so Monaco-focus tests don't
    // silently skip when the vault is empty (e.g. in CI). 409
    // Conflict (already exists) is a safe no-op.
    await page.request.post('/api/posts', {
      data: { path: TEST_DOC_PATH, title: 'Shortcut Test' },
    }).catch(() => {})
    await page.goto('/vault')
  })

  test('hides the view toggle on Vault Home until a document is opened', async ({ page }) => {
    await expect(page.locator('[data-testid="view-toggle"]')).toHaveCount(0)
  })

  test('hides the file-tree horizontal scrollbar without disabling scrolling', async ({ page }) => {
    const tree = page.locator('.tree')
    await expect(tree).toBeVisible()
    const metrics = await tree.evaluate((element) => ({
      overflowX: getComputedStyle(element).overflowX,
      scrollbarHeight: getComputedStyle(element, '::-webkit-scrollbar').height,
    }))
    expect(metrics.overflowX).toBe('auto')
    expect(metrics.scrollbarHeight).toBe('0px')
  })

  test('keeps expanded subtrees out of scroll ownership', async ({ page }) => {
    const inbox = page.locator('.tree-row.folder[data-tree-path="inbox"]')
    if (await inbox.getAttribute('aria-expanded') !== 'true') {
      await inbox.locator('.chevron').click()
    }

    const subtree = inbox.locator(':scope > .tree-children')
    await expect(subtree).toBeVisible()
    const overflow = await subtree.evaluate((element) => ({
      x: getComputedStyle(element).overflowX,
      y: getComputedStyle(element).overflowY,
    }))
    expect(overflow).toEqual({ x: 'visible', y: 'visible' })
  })

  test('toggles the left side panel from the top-right NavBar', async ({ page }) => {
    const toggle = page.getByTestId('left-panel-toggle')
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.file-tree')).toBeVisible()

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await expect(toggle).toHaveAttribute('aria-label', 'Open left panel')
    await expect(page.locator('.activity-bar')).toHaveCount(0)
    await expect(page.locator('.file-tree')).toHaveCount(0)

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.activity-bar')).toBeVisible()
    await expect(page.locator('.file-tree')).toBeVisible()
  })

  test('app opens in edit mode by default', async ({ page }) => {
    await openShortcutDocument(page)
    await expect(page.locator('[data-testid="view-toggle"]')).toHaveAttribute('aria-label', 'Switch to read')
  })

  test('clicking the NavBar toggle button switches to read mode', async ({ page }) => {
    await openShortcutDocument(page)
    await page.locator('[data-testid="view-toggle"]').click()
    await expect(page.locator('[data-testid="view-toggle"]')).toHaveAttribute('aria-label', 'Switch to edit')
    await expect(page.getByTestId('reading-export-pdf')).toHaveCount(0)
    await expect(
      page.locator('.reading-pane').getByRole('button', { name: /Export PDF|Download PDF|导出 PDF/ }),
    ).toHaveCount(0)
  })

  test('clicking again returns to edit mode', async ({ page }) => {
    await openShortcutDocument(page)
    const btn = page.locator('[data-testid="view-toggle"]')
    await btn.click()
    await btn.click()
    await expect(btn).toHaveAttribute('aria-label', 'Switch to read')
  })

  test('Cmd/Ctrl+E toggles edit↔read from the vault', async ({ page }) => {
    await openShortcutDocument(page)
    const toggle = page.getByTestId('view-toggle')
    await expect(toggle).toHaveAttribute('aria-label', 'Switch to read')
    // Focus the vault container so that @keydown fires on it
    await page.locator('.vault').focus()
    await page.keyboard.press(`${primaryModifier}+e`)
    await expect(toggle).toHaveAttribute('aria-label', 'Switch to edit')
    await page.keyboard.press(`${primaryModifier}+e`)
    await expect(toggle).toHaveAttribute('aria-label', 'Switch to read')
  })

  test('Cmd/Ctrl+E toggles mode while Monaco editor has focus', async ({ page }) => {
    const toggle = page.getByTestId('view-toggle')

    // Open the known test document so Monaco is mounted
    await openShortcutDocument(page)

    // Wait for the async Monaco component to load
    await focusMonacoInput(page)

    // Toggle to read mode from inside Monaco
    await page.keyboard.press(`${primaryModifier}+e`)
    await expect(toggle).toHaveAttribute('aria-label', 'Switch to edit')

    // Verify Monaco's Find Widget did NOT open
    await expect(
      page.locator('.monaco-editor .find-widget.visible'),
    ).toHaveCount(0)

    // Toggle back to edit mode — the vault container was focused
    // after the switch (see VaultView focus watcher), so this
    // second Cmd/Ctrl+E lands on .vault's @keydown handler.
    await page.keyboard.press(`${primaryModifier}+e`)
    await expect(toggle).toHaveAttribute('aria-label', 'Switch to read')
  })

  test('Cmd/Ctrl+F still opens Find Widget normally', async ({ page }) => {
    // Open the known test document so Monaco is mounted
    await openShortcutDocument(page)

    await focusMonacoInput(page)

    await page.keyboard.press(`${primaryModifier}+f`)
    await expect(
      page.locator('.monaco-editor .find-widget.visible'),
    ).toHaveCount(1)
  })

  test('viewMode persists across a hard refresh', async ({ page }) => {
    await openShortcutDocument(page)
    const btn = page.locator('[data-testid="view-toggle"]')
    await btn.click()
    await expect(btn).toHaveAttribute('aria-label', 'Switch to edit')
    await page.reload()
    await expect(btn).toHaveAttribute('aria-label', 'Switch to edit')
  })
})
