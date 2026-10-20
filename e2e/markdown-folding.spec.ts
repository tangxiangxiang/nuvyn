import { readFile } from 'node:fs/promises'
import { expect, test } from './fixtures/auth'
import { createDoc, gotoVaultReady, openDoc } from './helpers/edit-program'
import { chooseDocumentExport } from './helpers/document-export'

const source = [
  '# Folding', '', '[Jump to child](#child)', '',
  '## Parent', '', 'Parent body', '', '### Child', '', 'CHILD_COMPLETE_CONTENT', '',
  '- [x] first', '  - nested one', '  - nested two', '- [ ] second', '',
  '> First paragraph', '>', '> Second paragraph', '',
  '```ts', 'const foldedCode = 42', 'console.log(foldedCode)', '```', '',
  '## Other', '', 'OTHER_COMPLETE_CONTENT', '',
].join('\n')

async function setup(page: import('@playwright/test').Page, request: import('@playwright/test').APIRequestContext, body = source) {
  const path = `inbox/markdown-fold-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  await createDoc(request, path, body, [])
  await gotoVaultReady(page)
  await openDoc(page, path)
  return path
}

test('native Monaco gutter folds nested Markdown without editing and navigation reveals hidden content', async ({ page, request }) => {
  const path = await setup(page, request)
  try {
    const editor = page.locator('.monaco-editor')
    const lines = editor.locator('.view-lines')
    const folds = editor.locator('.margin-view-overlays :is(.codicon-folding-expanded,.codicon-folding-collapsed)')
    await expect(folds.first()).toBeVisible()
    await page.mouse.move(0, 0)
    await expect(folds.first()).toHaveCSS('opacity', '0')
    await folds.first().hover()
    await expect(folds.first()).toHaveCSS('opacity', '1')
    await folds.first().click()
    await expect(lines).not.toContainText('Parent body')
    await expect(lines).toContainText('# Folding')
    await page.mouse.move(0, 0)
    await expect(folds.first()).toHaveCSS('opacity', '0')
    await folds.first().hover()
    await expect(folds.first()).toHaveCSS('opacity', '1')
    await folds.first().click()
    await expect(lines).toContainText('Parent body')
    // Fold Parent, then exercise the same exposed navigation API used by
    // Vault search/anchor handoffs against the real mounted Monaco instance.
    await folds.nth(1).click()
    expect(await page.locator('.monaco-host').evaluate((el) => (el as any).__vueParentComponent.exposed.revealText('CHILD_COMPLETE_CONTENT'))).toBe(true)
    await expect(lines).toContainText('CHILD_COMPLETE_CONTENT')
    await lines.click({ position: { x: 40, y: 12 } })
    // Read Monaco's resolved modifier: emulated Playwright user agents can
    // report MacIntel while Monaco's runtime resolves native Ctrl bindings.
    const nativeModifier = await page.locator('.monaco-host').evaluate((el) => {
      const editor = (el as any).__vueParentComponent.setupState.editor
      return editor._standaloneKeybindingService.lookupKeybinding('editor.foldAll').getChords()[0].metaKey ? 'Meta' : 'Control'
    })
    await page.keyboard.press(`${nativeModifier}+k`)
    await page.keyboard.press(`${nativeModifier}+0`)
    await expect(lines).not.toContainText('Parent body')
    await page.keyboard.press(`${nativeModifier}+k`)
    await page.keyboard.press(`${nativeModifier}+j`)
    await expect(lines).toContainText('Parent body')
    await page.locator('.monaco-host').evaluate(async (el) => {
      const editor = (el as any).__vueParentComponent.setupState.editor
      const line = editor.getModel().getLinesContent().findIndex((text: string) => text === '```ts') + 1
      editor.setPosition({ lineNumber: line, column: 1 })
      await editor.getAction('editor.fold').run()
    })
    await expect(lines).not.toContainText('const foldedCode = 42')
    await page.locator('.monaco-host').evaluate(async (el) => {
      const editor = (el as any).__vueParentComponent.setupState.editor
      await editor.getAction('editor.unfold').run()
    })
    await expect(lines).toContainText('const foldedCode = 42')
    expect((await (await request.get(`/api/posts/${path}`)).json()).raw).toBe(source)
    await expect(page.locator(`[data-tab-id="${path}"]`)).toHaveAttribute('data-save-status', 'idle')
    await page.locator('.monaco-host').evaluate((el) => {
      const editor = (el as any).__vueParentComponent.setupState.editor
      editor.setPosition({ lineNumber: editor.getModel().getLineCount(), column: 1 })
      editor.focus()
    })
    await page.keyboard.insertText('FOLD_UNDO_TEXT')
    await expect(lines).toContainText('FOLD_UNDO_TEXT')
    const undoRedo = (command: 'undo' | 'redo') => page.locator('.monaco-host').evaluate((el, command) => {
      const editor = (el as any).__vueParentComponent.setupState.editor
      editor.trigger('folding-test', command, null)
      return editor.getModel().getValue()
    }, command)
    expect(await undoRedo('undo')).toBe(source)
    expect(await undoRedo('redo')).toContain('FOLD_UNDO_TEXT')
    expect(await undoRedo('undo')).toBe(source)
  } finally { await request.delete(`/api/posts/${path}`) }
})

test('Wiki Anchor navigation unfolds the current document destination without resetting other sections', async ({ page, request }) => {
  const path = `inbox/fold-wiki-${Date.now()}`
  await createDoc(request, path, `# Wiki fold\n\n[[${path}#child|Wiki child]]\n\n## Parent\nbody\n\n### Child\ntarget\n\n## Other\nother body`, [])
  try {
    await gotoVaultReady(page)
    await openDoc(page, path)
    await page.getByTestId('view-toggle').click()
    const article = page.locator('.reading-pane .article')
    await expect(page.locator('.reading-pane')).toHaveCSS('padding-top', '24px')
    await expect(page.locator('.reading-pane')).toHaveCSS('padding-bottom', '80px')
    const parent = article.locator('#parent > .nuvyn-fold-toggle')
    const other = article.locator('#other > .nuvyn-fold-toggle')
    await expect(article.locator('h1 > .nuvyn-fold-toggle')).toHaveCount(0)
    expect(await article.locator('.nuvyn-fold-toggle').evaluateAll((buttons) => buttons.every((button) => /^H[1-6]$/.test(button.parentElement!.tagName)))).toBe(true)
    await page.mouse.move(0, 0)
    await expect(parent).toHaveCSS('opacity', '0')
    // Disclosure controls must not indent text, increase line height or
    // change wrapping, even while hidden. Compare to the unenhanced layout.
    const layout = await article.evaluate((root) => {
      const headings = Array.from(root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6'))
      const measure = () => headings.map((heading) => {
        const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT, {
          acceptNode: (node) => node.textContent?.trim() && !node.parentElement?.closest('.nuvyn-fold-toggle')
            ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
        })
        const text = walker.nextNode()!
        const range = document.createRange()
        range.selectNodeContents(text)
        const rect = range.getBoundingClientRect()
        return { x: rect.x, y: rect.y, height: heading.getBoundingClientRect().height }
      })
      const enhanced = measure()
      const controls = Array.from(root.querySelectorAll<HTMLElement>('.nuvyn-fold-toggle'))
      controls.forEach((control) => { control.style.display = 'none' })
      const original = measure()
      controls.forEach((control) => { control.style.removeProperty('display') })
      return { enhanced, original }
    })
    expect(layout.enhanced).toEqual(layout.original)
    const beforeHover = await article.locator('#parent').boundingBox()
    await article.locator('#parent').hover()
    await expect(parent).toHaveCSS('opacity', '1')
    expect(await article.locator('#parent').boundingBox()).toEqual(beforeHover)
    await page.mouse.move(0, 0)
    await page.keyboard.press('Tab')
    await parent.focus()
    await expect(parent).toHaveCSS('opacity', '1')
    await parent.evaluate((el) => (el as HTMLElement).blur())
    await expect(parent).toHaveCSS('opacity', '0')
    await other.click()
    await parent.click()
    await article.getByRole('link', { name: 'Wiki child', exact: true }).click()
    await expect(article.locator('#child')).toBeVisible()
    await expect(parent).toHaveAttribute('aria-expanded', 'true')
    await expect(other).toHaveAttribute('aria-expanded', 'false')
  } finally { await request.delete(`/api/posts/${path}`) }
})

test('Reader keeps nested states and TOC/anchors reveal only necessary sections', async ({ page, request }) => {
  await page.addInitScript(() => localStorage.setItem('nuvyn.vault.layout', JSON.stringify({ activePanel: 'files', leftSidebarCollapsed: false, sidePanelWidth: 280, rightRailTab: 'toc', rightRailWidth: 300, rightRailCollapsed: false })))
  const path = await setup(page, request)
  try {
    await page.getByTestId('view-toggle').click()
    const article = page.locator('.reading-pane .article')
    const parent = article.locator('#parent > .nuvyn-fold-toggle')
    const child = article.locator('#child > .nuvyn-fold-toggle')
    const other = article.locator('#other > .nuvyn-fold-toggle')
    await child.click()
    await parent.click()
    await parent.click()
    await expect(child).toHaveAttribute('aria-expanded', 'false')
    await expect(article.getByText('CHILD_COMPLETE_CONTENT', { exact: true })).toBeHidden()
    await other.click()
    await parent.click()
    await page.locator('.toc-panel-link').filter({ hasText: 'Child' }).click()
    await expect(parent).toHaveAttribute('aria-expanded', 'true')
    // Navigating to Child reveals its heading, not its intentionally folded body.
    await expect(child).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('.toc-panel-item.active')).toContainText('Child')
    await expect(other).toHaveAttribute('aria-expanded', 'false')
    await parent.click()
    await article.getByRole('link', { name: 'Jump to child' }).click()
    await expect(child).toBeVisible()
    await child.click()
    await expect(article.getByText('CHILD_COMPLETE_CONTENT', { exact: true })).toBeVisible()
    // Browser-native keyboard activation and real hidden content focus behavior.
    await child.focus()
    await page.keyboard.press('Space')
    await expect(child).toHaveAttribute('aria-expanded', 'false')
    await page.keyboard.press('Enter')
    await expect(child).toHaveAttribute('aria-expanded', 'true')
    const quote = article.locator('blockquote')
    await expect(quote.locator('.nuvyn-fold-toggle')).toHaveCount(0)
    await expect(quote.getByText('Second paragraph', { exact: true })).toBeVisible()
    const code = article.locator('pre > code').first()
    await expect(article.locator('pre > .nuvyn-fold-toggle')).toHaveCount(0)
    await expect(code).toBeVisible()
    await expect(article.locator('.nuvyn-code-copy')).toBeVisible()
    await page.getByTestId('view-toggle').click()
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('Parent body')
    await page.getByTestId('view-toggle').click()
    await expect(article.locator('#parent > .nuvyn-fold-toggle')).toHaveCount(1)
    expect((await (await request.get(`/api/posts/${path}`)).json()).raw).toBe(source)
  } finally { await request.delete(`/api/posts/${path}`) }
})

test('375px Reader restores Flex, Mermaid, MarkMap and Code Group without replacing widgets', async ({ page, request }, testInfo) => {
  const body = source + [
    '## Widgets', '',
    '::: flex direction=row mobile=preserve', 'Left paragraph', '', 'Right paragraph', ':::', '',
    '```mermaid', 'graph LR', 'A-->B', '```', '',
    '```markmap', '# Root', '## Leaf', '```', '',
    '::: code-group', '```ts [A]', 'const a = 1', '```', '```js [B]', 'const b = 2', '```', ':::', '',
  ].join('\n')
  const path = await setup(page, request, body)
  try {
    await page.getByRole('button', { name: 'Collapse left panel', exact: true }).click()
    await page.getByRole('button', { name: 'Collapse right panel', exact: true }).click()
    await page.setViewportSize({ width: 375, height: 812 })
    await page.getByTestId('view-toggle').click()
    const article = page.locator('.reading-pane .article')
    await article.locator('.mermaid-widget-host').scrollIntoViewIfNeeded()
    await expect(article.locator('.mermaid-svg > svg')).toBeVisible()
    await article.locator('.markmap-widget-host').scrollIntoViewIfNeeded()
    await expect(article.locator('.markmap-svg')).toBeVisible()
    const secondTab = article.locator('.nuvyn-code-group [role="tab"]').nth(1)
    await secondTab.click()
    const widgets = article.locator('#widgets > .nuvyn-fold-toggle')
    await article.locator('.mermaid-widget-host').evaluate((el) => { (window as any).__foldWidget = el })
    await widgets.click()
    await expect(article.locator('.mermaid-widget-host')).toBeHidden()
    await widgets.click()
    await expect(article.locator('.mermaid-svg > svg')).toBeVisible()
    await expect(article.locator('.markmap-svg')).toBeVisible()
    expect(await article.locator('.mermaid-widget-host').evaluate((el) => el === (window as any).__foldWidget)).toBe(true)
    await expect(secondTab).toHaveAttribute('aria-selected', 'true')
    const geometry = await article.locator('.nuvyn-flex').evaluate((el) => {
      const [a, b] = Array.from(el.children).map((child) => child.getBoundingClientRect())
      const pane = el.closest('.reading-pane')!
      return { sameRow: Math.abs(a.top - b.top) < 2, overflow: pane.scrollWidth > pane.clientWidth }
    })
    expect(geometry).toEqual({ sameRow: true, overflow: false })
    await page.screenshot({ path: testInfo.outputPath('folding-mobile.png') })
  } finally { await request.delete(`/api/posts/${path}`) }
})

test('HTML and PDF export use fresh expanded surfaces while Reader content remains folded', async ({ page, request }) => {
  const path = await setup(page, request)
  try {
    await page.getByTestId('view-toggle').click()
    const article = page.locator('.reading-pane .article')
    await article.locator('#parent > .nuvyn-fold-toggle').click()
    await expect(article.getByText('CHILD_COMPLETE_CONTENT', { exact: true })).toBeHidden()
    const row = page.locator(`[data-tree-key="file:${path}"] > .row-line`)
    await row.click({ button: 'right' })
    const htmlDownload = page.waitForEvent('download')
    await chooseDocumentExport(page, 'html')
    const html = await readFile((await (await htmlDownload).path())!, 'utf8')
    expect(html).toContain('CHILD_COMPLETE_CONTENT')
    expect(html).toContain('OTHER_COMPLETE_CONTENT')
    expect(html).not.toContain('nuvyn-fold-toggle')
    expect(html).not.toContain('nuvyn-fold-hidden')
    // Observe the actual independent PDF article before it is captured.
    await page.evaluate(() => {
      (window as any).__foldPdf = null
      const observer = new MutationObserver(() => {
        const surface = document.querySelector('.pdf-export-surface article')
        if (surface?.textContent?.includes('CHILD_COMPLETE_CONTENT')) {
          (window as any).__foldPdf = { controls: surface.querySelectorAll('.nuvyn-fold-toggle').length, hidden: surface.querySelectorAll('[hidden]').length, text: surface.textContent }
          observer.disconnect()
        }
      })
      observer.observe(document.body, { subtree: true, childList: true })
    })
    await row.click({ button: 'right' })
    const pdfDownload = page.waitForEvent('download')
    await chooseDocumentExport(page, 'pdf')
    const bytes = await readFile((await (await pdfDownload).path())!)
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
    expect(await page.evaluate(() => (window as any).__foldPdf)).toEqual({ controls: 0, hidden: 0, text: expect.stringContaining('CHILD_COMPLETE_CONTENT') })
    await expect(article.getByText('CHILD_COMPLETE_CONTENT', { exact: true })).toBeHidden()
  } finally { await request.delete(`/api/posts/${path}`) }
})
