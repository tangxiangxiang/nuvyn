import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, test } from './fixtures/auth'
import { createDoc, gotoVaultReady, openDoc } from './helpers/edit-program'
import { chooseDocumentExport } from './helpers/document-export'

const source = [
  '# Tasks', '', '## Work', '', '[Before tasks](#work)', '',
  '- [ ] Pending', '- [x] Lowercase done', '- [X] Uppercase done', '  - [ ] Nested task',
  '- Ordinary list item', '', '[After tasks](#work)',
].join('\n')
const initialStates = [false, true, true, false]

test.describe('Reader touch input', () => {
  test.use({ hasTouch: true })
  test('Reader task states resist mouse, touch and keyboard without saving; Monaco edits still save', async ({ page, request, browserName }, info) => {
    const path = `inbox/tasks-readonly-${randomUUID().slice(0, 8)}`
    const saved = await createDoc(request, path, source, [])
    try {
      await gotoVaultReady(page)
      await openDoc(page, path)
      const tab = page.locator(`[data-tab-id="${path}"]`)
      await expect(tab).toHaveAttribute('data-save-status', 'idle')
      await page.getByTestId('view-toggle').click()
      const article = page.locator('.reading-pane .article')
      const checkboxes = article.getByRole('checkbox')
      await expect(checkboxes).toHaveCount(4)
      const writes: string[] = []
      page.on('request', (event) => {
        if (event.method() === 'PUT' && new URL(event.url()).pathname === `/api/posts/${path}`) writes.push(event.url())
      })
      const states = () => checkboxes.evaluateAll((nodes) => nodes.map((node) => (node as HTMLInputElement).checked))
      const layout = () => article.locator('ul').first().evaluate((element) => {
        const box = element.getBoundingClientRect()
        return { width: box.width, height: box.height }
      })
      const beforeLayout = await layout()
      for (const checkbox of await checkboxes.all()) {
        await expect(checkbox).toBeDisabled()
        expect(await checkbox.evaluate((node) => getComputedStyle(node).cursor)).not.toBe('pointer')
        await checkbox.scrollIntoViewIfNeeded()
        const box = (await checkbox.boundingBox())!
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
        expect(await states()).toEqual(initialStates)
        await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
        expect(await states()).toEqual(initialStates)
        // Playwright refuses locator.click on a label for a disabled input.
        // Real pointer input verifies the browser's native disabled behavior.
        const label = (await checkbox.locator('..').boundingBox())!
        await page.mouse.click(label.x + label.width / 2, label.y + label.height / 2)
        expect(await states()).toEqual(initialStates)
        expect(await checkbox.locator('..').evaluate((node) => getComputedStyle(node).cursor)).not.toBe('pointer')
        await article.getByRole('link', { name: 'Before tasks', exact: true }).focus()
        await checkbox.evaluate((node) => (node as HTMLElement).focus())
        await expect(checkbox).not.toBeFocused()
        await page.keyboard.press('Space')
        expect(await states()).toEqual(initialStates)
      }
      await article.getByRole('link', { name: 'Before tasks', exact: true }).focus()
      // Safari's default Tab navigation skips links; Option+Tab includes them.
      await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab')
      await expect(article.getByRole('link', { name: 'After tasks', exact: true })).toBeFocused()
      await page.keyboard.press('Space')
      expect(await states()).toEqual(initialStates)
      expect(await layout()).toEqual(beforeLayout)
      await expect(article.locator('ul ul .task-list-item-checkbox')).toHaveCount(1)
      await expect(tab.locator('.tab-dirty-indicator')).toHaveCount(0)
      expect(writes).toEqual([])
      expect((await (await request.get(`/api/posts/${path}`)).json()).raw).toBe(saved.raw)
      await article.locator('ul').first().screenshot({ path: info.outputPath('readonly-tasks.png') })

      await page.getByTestId('view-toggle').click()
      await page.locator('.monaco-host').evaluate((host) => {
        const editor = (host as any).__vueParentComponent.setupState.editor
        const line = editor.getModel().getLinesContent().findIndex((text: string) => text === '- [ ] Pending') + 1
        if (!line) throw new Error('Task source line not found')
        editor.setSelection({ startLineNumber: line, startColumn: 4, endLineNumber: line, endColumn: 5 })
        editor.focus()
      })
      const saving = page.waitForResponse((response) => response.request().method() === 'PUT' && new URL(response.url()).pathname === `/api/posts/${path}`)
      await page.keyboard.insertText('x')
      expect((await saving).ok()).toBe(true)
      await expect(tab).toHaveAttribute('data-save-status', 'saved')
      await page.getByTestId('view-toggle').click()
      await expect(checkboxes.first()).toBeChecked()
      await expect(checkboxes.first()).toBeDisabled()
      expect((await (await request.get(`/api/posts/${path}`)).json()).raw).toBe(saved.raw.replace('- [ ] Pending', '- [x] Pending'))
    } finally { await request.delete(`/api/posts/${path}`) }
  })
})

for (const format of ['html', 'pdf'] as const) {
  test(`${format.toUpperCase()} export preserves all readonly task states and nesting`, async ({ page, request }) => {
    const path = `inbox/tasks-${format}-${randomUUID().slice(0, 8)}`
    await createDoc(request, path, source, [])
    try {
      await gotoVaultReady(page)
      await openDoc(page, path)
      await page.getByTestId('view-toggle').click()
      const row = page.locator(`[data-tree-key="file:${path}"] > .row-line`)
      if (format === 'html') {
        await row.click({ button: 'right' })
        const htmlDownload = page.waitForEvent('download')
        await chooseDocumentExport(page, 'html')
        const html = await readFile((await (await htmlDownload).path())!, 'utf8')
        const offline = await page.context().newPage()
        await offline.setContent(html)
        const checkboxes = offline.getByRole('checkbox')
        await expect(checkboxes).toHaveCount(4)
        expect(await checkboxes.evaluateAll((nodes) => nodes.map((node) => (node as HTMLInputElement).checked))).toEqual(initialStates)
        for (const checkbox of await checkboxes.all()) await expect(checkbox).toBeDisabled()
        const label = (await offline.locator('label').first().boundingBox())!
        await offline.mouse.click(label.x + label.width / 2, label.y + label.height / 2)
        await expect(checkboxes.first()).not.toBeChecked()
        await expect(offline.locator('ul ul .task-list-item-checkbox')).toHaveCount(1)
        await offline.close()
        return
      }

      await page.evaluate(() => {
        (window as any).__taskPdfSnapshot = null
        const observer = new MutationObserver(() => {
          const article = document.querySelector('.pdf-export-surface article')
          const inputs = article?.querySelectorAll<HTMLInputElement>('.task-list-item-checkbox')
          if (!article || inputs?.length !== 4) return
          const snapshot = {
            states: Array.from(inputs, (input) => ({ checked: input.checked, disabled: input.disabled })),
            nested: article.querySelectorAll('ul ul .task-list-item-checkbox').length,
          }
          Object.assign(window, { __taskPdfSnapshot: snapshot })
          observer.disconnect()
        })
        observer.observe(document.body, { childList: true, subtree: true })
      })
      await row.click({ button: 'right' })
      const pdfDownload = page.waitForEvent('download')
      await chooseDocumentExport(page, 'pdf')
      const bytes = await readFile((await (await pdfDownload).path())!)
      expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
      expect(await page.evaluate(() => (window as any).__taskPdfSnapshot)).toEqual({
        states: initialStates.map((checked) => ({ checked, disabled: true })), nested: 1,
      })
    } finally { await request.delete(`/api/posts/${path}`) }
  })
}
