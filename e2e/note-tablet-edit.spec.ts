import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures/auth'
import { createDoc } from './helpers/edit-program'

test.use({ hasTouch: true })
const host = (page: Page) => page.locator('.monaco-host')
const imageButton = (page: Page) => page.getByTestId('tablet-insert-image')

async function edit(page: Page, document: string) {
  await page.goto(`/vault/${document}`)
  const toggle = page.getByTestId('view-toggle')
  await expect(toggle).toBeVisible()
  if (/edit|编辑/i.test(await toggle.getAttribute('aria-label') ?? '')) await toggle.tap()
  await expect(host(page)).toBeVisible()
}

async function sameModel(page: Page) {
  expect(await host(page).evaluate((el) => {
    const editor = (el as any).__vueParentComponent.setupState.editor
    return editor === (window as any).__tabletEditor && editor.getModel() === (window as any).__tabletModel
  })).toBe(true)
}

async function openTreeDocument(page: Page, document: string) {
  const toggle = page.getByTestId('left-panel-toggle')
  if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.tap()
  const row = page.locator(`[data-tree-key="file:${document}"] > .row-line`)
  if (!await row.isVisible()) await page.locator('[data-tree-key="folder:inbox"] > .row-line').tap()
  await row.tap()
  await expect(page).toHaveURL(new RegExp(`/vault/${document}$`))
  await expect(host(page)).toBeVisible()
}

for (const [width, height] of [[601, 900], [768, 1024], [820, 1180], [1024, 768], [1180, 820], [1200, 900], [390, 844]]) {
  test(`touch editing capability is isolated at ${width}x${height}`, async ({ page, request }) => {
    await page.setViewportSize({ width: width!, height: height! })
    const document = `inbox/tablet-edit-${randomUUID()}`
    await createDoc(request, document, '# Tablet edit\n\n中英文 writing', [])
    try {
      await page.goto(`/vault/${document}`)
      const tablet = width! > 600 && width! < 1200
      if (!tablet) {
        await expect(page.locator('.vault')).not.toHaveClass(/note-tablet-mode/)
        await expect(imageButton(page)).toHaveCount(0)
        return
      }
      await edit(page, document)
      await expect(imageButton(page)).toBeVisible()
      await expect(page.locator('.editor-tabs-shell')).toHaveCount(0)
      const box = await imageButton(page).boundingBox()
      expect(box!.height).toBeGreaterThanOrEqual(40)
      await page.locator('.monaco-editor .view-lines').tap({ position: { x: 80, y: 12 } })
      await page.keyboard.insertText('触摸输入 ')
      await expect.poll(async () => (await (await request.get(`/api/posts/${document}`)).json()).raw).toContain('触摸输入')
      await page.getByTestId('left-panel-toggle').tap()
      const documents = page.getByTestId('open-workspace-documents')
      await documents.locator('.open-workspace-documents-toggle').tap()
      await expect(documents.locator(`[data-workspace-document-id="${document}"]`)).toHaveAttribute('data-tab-mode', 'pinned')
      await page.getByTestId('left-panel-toggle').tap()
      await page.getByTestId('view-toggle').tap()
      await expect(imageButton(page)).toHaveCount(0)
      await expect(page.locator('.reading-pane')).toContainText('触摸输入')
      await page.getByTestId('view-toggle').tap()
      expect(await host(page).evaluate((el) => (el as any).__vueParentComponent.setupState.editor.hasTextFocus())).toBe(false)
    } finally { await request.delete(`/api/posts/${document}`) }
  })
}

test('long editor preserves its model, selection, undo and save state through viewport and drawer changes', async ({ page, request }) => {
  await page.setViewportSize({ width: 768, height: 1024 })
  const document = `inbox/tablet-long-${randomUUID()}`
  const raw = Array.from({ length: 150 }, (_, i) => `Line ${i + 1} 中文 prose`).join('\n')
  await createDoc(request, document, raw, [])
  let saves = 0
  page.on('request', (r) => { if (r.method() === 'PUT' && new URL(r.url()).pathname === `/api/posts/${document}`) saves++ })
  try {
    await edit(page, document)
    await host(page).evaluate((el) => {
      const editor = (el as any).__vueParentComponent.setupState.editor
      Object.assign(window, { __tabletEditor: editor, __tabletModel: editor.getModel() })
      editor.setPosition({ lineNumber: 150, column: 1 })
      editor.revealLine(150)
    })
    await expect.poll(() => host(page).evaluate((el) => {
      const editor = (el as any).__vueParentComponent.setupState.editor
      return editor.getVisibleRanges().at(-1).endLineNumber
    })).toBe(150)
    for (const viewport of [{ width: 768, height: 600 }, { width: 1024, height: 768 }, { width: 768, height: 1024 }]) {
      await page.setViewportSize(viewport)
      await expect.poll(() => host(page).evaluate((el) => Math.abs(el.clientHeight - el.querySelector('.monaco-editor')!.clientHeight))).toBeLessThanOrEqual(1)
      await sameModel(page)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
    for (const selector of ['[data-testid="left-panel-toggle"]', '.right-rail-toggle']) {
      await page.locator(selector).tap()
      await page.locator(selector).tap()
      await sameModel(page)
      expect(await host(page).evaluate((el) => (el as any).__vueParentComponent.setupState.editor.hasTextFocus())).toBe(false)
    }
    expect(saves).toBe(0)
    await host(page).evaluate((el) => {
      const editor = (el as any).__vueParentComponent.setupState.editor
      editor.setPosition({ lineNumber: 150, column: 1 })
      editor.focus()
      editor.pushUndoStop()
    })
    await page.keyboard.type('TabletEnd')
    await host(page).evaluate((el) => (el as any).__vueParentComponent.setupState.editor.pushUndoStop())
    await expect.poll(async () => (await (await request.get(`/api/posts/${document}`)).json()).raw).toContain('TabletEnd')
    await host(page).evaluate((el) => (el as any).__vueParentComponent.setupState.editor.trigger('tablet-test', 'undo', null))
    await expect.poll(async () => (await (await request.get(`/api/posts/${document}`)).json()).raw).toBe(raw)
    await host(page).evaluate((el) => (el as any).__vueParentComponent.setupState.editor.trigger('tablet-test', 'redo', null))
    await expect.poll(async () => (await (await request.get(`/api/posts/${document}`)).json()).raw).toContain('TabletEnd')
    await page.setViewportSize({ width: 1200, height: 900 })
    await expect(page.locator('.editor-tabs-shell')).toBeVisible()
    await sameModel(page)
  } finally { await request.delete(`/api/posts/${document}`) }
})

test('touch image entry retains line 20 and cancellation leaves the document unchanged', async ({ page, request }) => {
  await page.setViewportSize({ width: 768, height: 1024 })
  const document = `inbox/tablet-image-${randomUUID()}`
  const raw = Array.from({ length: 30 }, (_, i) => `Line ${i + 1}`).join('\n')
  await createDoc(request, document, raw, [])
  let imagePath: string | undefined
  try {
    await edit(page, document)
    await host(page).evaluate((el) => (el as any).__vueParentComponent.setupState.editor.setPosition({ lineNumber: 20, column: 1 }))
    await imageButton(page).tap()
    const picker = page.locator('.attachment-picker-modal')
    await expect(picker).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(picker).toHaveCount(0)
    expect(await host(page).evaluate((el) => (el as any).__vueParentComponent.setupState.editor.getValue())).toBe(raw)
    await imageButton(page).tap()
    const chooser = page.waitForEvent('filechooser')
    await picker.getByRole('button', { name: /上传新图片|Upload (?:a )?new image/ }).tap()
    await (await chooser).setFiles({ name: 'tablet.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') })
    await expect.poll(async () => (await (await request.get(`/api/posts/${document}`)).json()).raw).toContain('![tablet]')
    const saved = (await (await request.get(`/api/posts/${document}`)).json()).raw as string
    expect(saved.split('\n')[19]).toMatch(/^!\[tablet\].*Line 20$/)
    imagePath = /@\/(attachments\/images\/[^)]+)/.exec(saved)?.[1]
  } finally {
    await request.delete(`/api/posts/${document}`)
    if (imagePath && process.env.NUVYN_DRAFT_E2E_VAULT) await fs.rm(path.join(process.env.NUVYN_DRAFT_E2E_VAULT, imagePath), { force: true })
    await request.post('/api/attachments/refresh')
  }
})

test('an image upload cannot insert into a different tablet Note after navigation', async ({ page, request }) => {
  await page.setViewportSize({ width: 1024, height: 768 })
  const a = `inbox/tablet-upload-a-${randomUUID()}`
  const b = `inbox/tablet-upload-b-${randomUUID()}`
  await createDoc(request, a, '# Upload source', [])
  await createDoc(request, b, '# Untouched destination', [])
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const pending = new Promise<void>((resolve) => { started = resolve })
  let uploadedPath: string | undefined
  await page.route('**/api/note/images', async (route) => {
    started()
    await gate
    await route.continue()
  })
  try {
    await edit(page, a)
    await imageButton(page).tap()
    const uploadedResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/note/images' && response.request().method() === 'POST')
    const chooser = page.waitForEvent('filechooser')
    await page.locator('.attachment-picker-modal').getByRole('button', { name: /上传新图片|Upload (?:a )?new image/ }).tap()
    await (await chooser).setFiles({ name: 'late.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') })
    await pending
    await openTreeDocument(page, b)
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('Untouched destination')
    release()
    const response = await uploadedResponse
    expect(response.status()).toBe(201)
    uploadedPath = (await response.json()).path
    await expect(page.getByText(/图片已保存，但插入位置已失效|image was saved, but its insertion point/i)).toBeVisible()
    expect((await (await request.get(`/api/posts/${b}`)).json()).raw).toBe('# Untouched destination')
    expect(await host(page).evaluate((el) => (el as any).__vueParentComponent.setupState.editor.getValue())).toBe('# Untouched destination')
  } finally {
    release()
    await page.unrouteAll({ behavior: 'wait' })
    await request.delete(`/api/posts/${a}`)
    await request.delete(`/api/posts/${b}`)
    if (uploadedPath?.startsWith('attachments/images/') && process.env.NUVYN_DRAFT_E2E_VAULT) await fs.rm(path.join(process.env.NUVYN_DRAFT_E2E_VAULT, uploadedPath), { force: true })
    await request.post('/api/attachments/refresh')
  }
})

test('save failure keeps the edited tablet Preview pinned and recoverable while another Note opens', async ({ page, request }) => {
  await page.setViewportSize({ width: 768, height: 1024 })
  const a = `inbox/tablet-error-a-${randomUUID()}`
  const b = `inbox/tablet-error-b-${randomUUID()}`
  await createDoc(request, a, '# Save source', [])
  await createDoc(request, b, '# Other document', [])
  await page.route(`**/api/posts/${a}`, async (route) => {
    if (route.request().method() === 'PUT') await route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"Injected save failure"}' })
    else await route.continue()
  })
  try {
    await edit(page, a)
    await page.locator('.monaco-editor .view-lines').tap({ position: { x: 80, y: 12 } })
    await page.keyboard.insertText('LOCAL')
    await openTreeDocument(page, b)
    await page.getByTestId('left-panel-toggle').tap()
    const documents = page.getByTestId('open-workspace-documents')
    await documents.locator('.open-workspace-documents-toggle').tap()
    const source = documents.locator(`[data-workspace-document-id="${a}"]`)
    await expect(source).toHaveAttribute('data-tab-mode', 'pinned')
    await expect(source).toHaveAttribute('data-save-status', 'error')
    await source.locator('.open-workspace-document-select').tap()
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('LOCAL')
    expect((await (await request.get(`/api/posts/${a}`)).json()).raw).toBe('# Save source')
  } finally {
    await page.unrouteAll({ behavior: 'wait' })
    await request.delete(`/api/posts/${a}`)
    await request.delete(`/api/posts/${b}`)
  }
})

test('controlled composition protects a Preview before programmatic document navigation', async ({ page, request }) => {
  await page.setViewportSize({ width: 768, height: 1024 })
  const a = `inbox/tablet-ime-a-${randomUUID()}`
  const b = `inbox/tablet-ime-b-${randomUUID()}`
  await createDoc(request, a, '# Composition source', [])
  await createDoc(request, b, '# Destination', [])
  const writes: string[] = []
  page.on('request', (r) => { if (r.method() === 'PUT' && new URL(r.url()).pathname === `/api/posts/${a}`) writes.push(r.postData() ?? '') })
  try {
    await edit(page, a)
    // Controlled input lifecycle on real Monaco, not a system IME emulator.
    await host(page).evaluate((el) => {
      const editor = (el as any).__vueParentComponent.setupState.editor
      const input = el.querySelector<HTMLElement>('.native-edit-context, textarea.inputarea')!
      const target: EventTarget = (input as any).editContext ?? input
      target.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      editor.setPosition({ lineNumber: 1, column: 1 })
      editor.trigger('tablet-composition-test', 'type', { text: '合成中文' })
    })
    expect(writes).toEqual([])
    await page.locator('.vault').evaluate((el, destination) => (el as any).__vueParentComponent.setupState.router.push(`/vault/${destination}`), b)
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('Destination')
    await expect.poll(async () => (await (await request.get(`/api/posts/${a}`)).json()).raw).toBe('合成中文# Composition source')
    expect((await (await request.get(`/api/posts/${b}`)).json()).raw).toBe('# Destination')
    await page.getByTestId('left-panel-toggle').tap()
    const documents = page.getByTestId('open-workspace-documents')
    await documents.locator('.open-workspace-documents-toggle').tap()
    await expect(documents.locator(`[data-workspace-document-id="${a}"]`)).toHaveAttribute('data-tab-mode', 'pinned')
  } finally {
    await request.delete(`/api/posts/${a}`)
    await request.delete(`/api/posts/${b}`)
  }
})
