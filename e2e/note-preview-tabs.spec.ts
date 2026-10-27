import { randomUUID } from 'node:crypto'
import type { Page, APIRequestContext } from '@playwright/test'
import { expect, test } from './fixtures/auth'
import { createDoc, gotoVaultReady } from './helpers/edit-program'

const tab = (page: Page, path: string) => page.locator(`[data-tab-id="${path}"]`)
const noteTabs = (page: Page) => page.locator('.tabs [data-tab-mode]')
const host = (page: Page) => page.locator('.monaco-host')

async function row(page: Page, path: string) {
  if (await page.locator('.vault.note-tablet-mode').count()
    && await page.getByTestId('left-panel-toggle').getAttribute('aria-pressed') !== 'true') {
    await page.getByTestId('left-panel-toggle').tap()
  }
  const folder = page.locator('[data-tree-key="folder:inbox"]')
  if (!(await page.locator(`[data-tree-key="file:${path}"]`).isVisible())) await folder.locator(':scope > .row-line').click()
  return page.locator(`[data-tree-key="file:${path}"] > .row-line`)
}

async function fixture(request: APIRequestContext) {
  const id = randomUUID().slice(0, 8)
  const paths = Object.fromEntries(['a', 'b', 'c', 'd'].map((name) => [name, `inbox/preview-${name}-${id}`])) as Record<'a' | 'b' | 'c' | 'd', string>
  const bodies = {
    a: `# Alpha\n\n[[${paths.b}#preview-section|Wiki target]]\n\n[Relative target](./preview-b-${id}.md#preview-section)`,
    b: `# Beta\n\n${'Paragraph\n\n'.repeat(25)}## Preview section\n\nTARGET CONTENT`,
    c: '# Gamma\n\nOriginal C', d: '# Delta\n\nOriginal D',
  }
  for (const name of ['a', 'b', 'c', 'd'] as const) await createDoc(request, paths[name], bodies[name], [])
  return { paths, bodies, async cleanup() { for (const path of Object.values(paths)) await request.delete(`/api/posts/${path}`) } }
}

async function append(page: Page, text: string) {
  await host(page).evaluate((el) => {
    const editor = (el as any).__vueParentComponent.setupState.editor
    const model = editor.getModel()
    const lineNumber = model.getLineCount()
    editor.setPosition({ lineNumber, column: model.getLineMaxColumn(lineNumber) })
    editor.focus()
  })
  await page.keyboard.insertText(text)
}

test('single-click previews, real double-click pinning, first-edit pinning and URL refresh preserve work', async ({ page, request }) => {
  const f = await fixture(request)
  const { a, b, c, d } = f.paths
  try {
    await gotoVaultReady(page)
    await (await row(page, a)).click()
    await expect(tab(page, a)).toHaveAttribute('data-tab-mode', 'preview')
    await expect(tab(page, a).locator('.tab-title')).toHaveCSS('font-style', 'italic')
    await (await row(page, b)).click()
    await expect(tab(page, b)).toHaveAttribute('data-tab-mode', 'preview')
    await expect(tab(page, a)).toHaveCount(0)
    await expect(noteTabs(page)).toHaveCount(1)
    await (await row(page, b)).dblclick()
    await expect(tab(page, b)).toHaveAttribute('data-tab-mode', 'pinned')
    await (await row(page, c)).click()
    await expect(tab(page, c)).toHaveAttribute('data-tab-mode', 'preview')
    await expect(host(page)).toBeVisible()
    await host(page).evaluate((el) => {
      const editor = (el as any).__vueParentComponent.setupState.editor
      Object.assign(window, { __previewEditor: editor, __previewModel: editor.getModel() })
    })
    await append(page, '\nEdited C')
    await expect(tab(page, c)).toHaveAttribute('data-tab-mode', 'pinned')
    expect(await host(page).evaluate((el) => {
      const editor = (el as any).__vueParentComponent.setupState.editor
      return editor === (window as any).__previewEditor && editor.getModel() === (window as any).__previewModel
    })).toBe(true)
    await host(page).evaluate((el) => (el as any).__vueParentComponent.setupState.editor.trigger('preview-test', 'undo', null))
    await expect(tab(page, c)).toHaveAttribute('data-tab-mode', 'pinned')
    await host(page).evaluate((el) => (el as any).__vueParentComponent.setupState.editor.trigger('preview-test', 'redo', null))
    await (await row(page, d)).click()
    await expect(tab(page, d)).toHaveAttribute('data-tab-mode', 'preview')
    await expect(noteTabs(page)).toHaveCount(3)
    await expect(tab(page, c)).toHaveAttribute('data-save-status', 'saved')
    expect((await (await request.get(`/api/posts/${c}`)).json()).raw).toBe(f.bodies.c + '\nEdited C')
    const persisted = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((key) => key.startsWith('nuvyn:tabs:v1:'))!
      return JSON.parse(localStorage.getItem(key)!)
    })
    expect(persisted.paths).toEqual([b, c])
    expect(persisted.active).toBeNull()
    await expect(page).toHaveURL(new RegExp(`/vault/${d}$`))
    await page.reload()
    await expect(tab(page, d)).toHaveAttribute('data-tab-mode', 'pinned')
    await expect(tab(page, b)).toHaveAttribute('data-tab-mode', 'pinned')
    await expect(tab(page, c)).toHaveAttribute('data-tab-mode', 'pinned')
    await expect(noteTabs(page)).toHaveCount(3)
  } finally { await f.cleanup() }
})

test('tab double-click and keyboard context menu pin without reload or save', async ({ page, request }) => {
  const f = await fixture(request)
  try {
    await gotoVaultReady(page)
    await (await row(page, f.paths.a)).click()
    await expect(host(page)).toBeVisible()
    const requests: string[] = []
    page.on('request', (event) => {
      if (new URL(event.url()).pathname === `/api/posts/${f.paths.a}`) requests.push(event.method())
    })
    await tab(page, f.paths.a).dblclick()
    await expect(tab(page, f.paths.a)).toHaveAttribute('data-tab-mode', 'pinned')
    expect(requests).toEqual([])
    await (await row(page, f.paths.b)).click()
    await expect(tab(page, f.paths.b)).toHaveAttribute('data-tab-mode', 'preview')
    await tab(page, f.paths.b).focus()
    await page.keyboard.press('Shift+F10')
    await page.getByRole('menuitem', { name: /固定标签|Pin Tab/ }).click()
    await expect(tab(page, f.paths.b)).toHaveAttribute('data-tab-mode', 'pinned')
    await (await row(page, f.paths.c)).click()
    await expect(noteTabs(page)).toHaveCount(3)
  } finally { await f.cleanup() }
})

test('global search previews documents and refresh retains the route document', async ({ page, request }) => {
  const f = await fixture(request)
  try {
    await gotoVaultReady(page)
    await (await row(page, f.paths.a)).click()
    await page.keyboard.press('Control+p')
    await page.locator('.palette-input input').fill(f.paths.b.split('/').at(-1)!)
    await page.getByRole('option').filter({ hasText: f.paths.b }).click()
    await expect(tab(page, f.paths.b)).toHaveAttribute('data-tab-mode', 'preview')
    await expect(tab(page, f.paths.a)).toHaveCount(0)
    await page.reload()
    await expect(tab(page, f.paths.b)).toHaveAttribute('data-tab-mode', 'pinned')
  } finally { await f.cleanup() }
})

test.describe('touch preview operations', () => {
  test.use({ viewport: { width: 768, height: 1024 }, hasTouch: true })

  test('tap previews and the existing context menu provides explicit pinning', async ({ page, request }) => {
    const f = await fixture(request)
    try {
      await gotoVaultReady(page)
      await (await row(page, f.paths.a)).tap()
      await expect(tab(page, f.paths.a)).toHaveAttribute('data-tab-mode', 'preview')
      await expect(host(page)).toBeVisible()
      // Exercise the menu's touch activation, not a synthetic double tap.
      // Native OS long-press delivery of contextmenu remains a device check.
      await tab(page, f.paths.a).evaluate((el) => {
        const rect = el.getBoundingClientRect()
        el.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, clientX: rect.left + 10, clientY: rect.bottom,
        }))
      })
      await expect(page.getByRole('menu')).toBeInViewport()
      await page.getByRole('menuitem', { name: /固定标签|Pin Tab/ }).tap()
      await expect(tab(page, f.paths.a)).toHaveAttribute('data-tab-mode', 'pinned')
      await (await row(page, f.paths.b)).tap()
      await expect(tab(page, f.paths.b)).toHaveAttribute('data-tab-mode', 'preview')
      await expect(noteTabs(page)).toHaveCount(2)
    } finally { await f.cleanup() }
  })
})

test('Wiki and relative Markdown links reuse the preview slot and preserve anchor navigation', async ({ page, request }) => {
  const f = await fixture(request)
  try {
    await gotoVaultReady(page)
    await (await row(page, f.paths.a)).click()
    await expect(host(page)).toBeVisible()
    await page.getByTestId('view-toggle').click()
    for (const name of ['Wiki target', 'Relative target']) {
      await page.locator('.reading-pane').getByRole('link', { name, exact: true }).click()
      await expect(tab(page, f.paths.b)).toHaveAttribute('data-tab-mode', 'preview')
      await expect(noteTabs(page)).toHaveCount(1)
      await expect(page.locator('.reading-pane #preview-section')).toBeInViewport()
      await expect(page).toHaveURL(new RegExp(`/vault/${f.paths.b}$`))
      await (await row(page, f.paths.a)).click()
      await expect(page.locator('.reading-pane').getByRole('link', { name: 'Wiki target', exact: true })).toBeVisible()
    }
  } finally { await f.cleanup() }
})

test('delayed replaced and closed preview requests cannot resurrect tabs; pinning while loading is retained', async ({ page, request }) => {
  const f = await fixture(request)
  let releaseA!: () => void
  let releaseD!: () => void
  const aGate = new Promise<void>((resolve) => { releaseA = resolve })
  const dGate = new Promise<void>((resolve) => { releaseD = resolve })
  await page.route(`**/api/posts/${f.paths.a}`, async (route) => { await aGate; await route.continue() })
  await page.route(`**/api/posts/${f.paths.d}`, async (route) => { await dGate; await route.continue() })
  try {
    await gotoVaultReady(page)
    await (await row(page, f.paths.a)).click()
    await expect(tab(page, f.paths.a)).toHaveAttribute('data-tab-mode', 'preview')
    await (await row(page, f.paths.b)).click()
    await (await row(page, f.paths.c)).click()
    await expect(tab(page, f.paths.c)).toHaveAttribute('aria-selected', 'true')
    const aResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/posts/${f.paths.a}`)
    releaseA()
    await aResponse
    await expect(host(page)).toBeVisible()
    await expect(noteTabs(page)).toHaveCount(1)
    await expect(tab(page, f.paths.a)).toHaveCount(0)
    await (await row(page, f.paths.d)).dblclick()
    await expect(tab(page, f.paths.d)).toHaveAttribute('data-tab-mode', 'pinned')
    await (await row(page, f.paths.b)).click()
    await expect(tab(page, f.paths.d)).toBeVisible()
    const dResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/posts/${f.paths.d}`)
    await tab(page, f.paths.d).locator('.tab-close').click()
    releaseD()
    await dResponse
    await expect(tab(page, f.paths.d)).toHaveCount(0)
    await expect(tab(page, f.paths.b)).toHaveAttribute('aria-selected', 'true')
  } finally {
    releaseA(); releaseD()
    await page.unrouteAll({ behavior: 'wait' })
    await f.cleanup()
  }
})

test('save failure keeps edited preview pinned and preserves its body while browsing another Note', async ({ page, request }) => {
  const f = await fixture(request)
  await page.route(`**/api/posts/${f.paths.a}`, async (route) => {
    if (route.request().method() === 'PUT') await route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"Injected save failure"}' })
    else await route.continue()
  })
  try {
    await gotoVaultReady(page)
    await (await row(page, f.paths.a)).click()
    await expect(host(page)).toBeVisible()
    await append(page, '\nUNSAVED LOCAL BODY')
    await expect(tab(page, f.paths.a)).toHaveAttribute('data-tab-mode', 'pinned')
    await expect(tab(page, f.paths.a)).toHaveAttribute('data-save-status', 'error')
    await (await row(page, f.paths.b)).click()
    await expect(tab(page, f.paths.a)).toBeVisible()
    await expect(tab(page, f.paths.b)).toHaveAttribute('data-tab-mode', 'preview')
    await tab(page, f.paths.a).click()
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('UNSAVED LOCAL BODY')
    expect((await (await request.get(`/api/posts/${f.paths.a}`)).json()).raw).toBe(f.bodies.a)
  } finally {
    await page.unrouteAll({ behavior: 'wait' })
    await f.cleanup()
  }
})
