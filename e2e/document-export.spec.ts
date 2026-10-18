import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures/auth'
import { createDoc, gotoVaultReady, openDoc } from './helpers/edit-program'
import { chooseDocumentExport } from './helpers/document-export'

async function openMenu(page: Page, path: string): Promise<void> {
  const row = page.locator(`[data-tree-key="file:${path}"]`)
  if (!await row.isVisible()) {
    await page.locator(`[data-tree-key="folder:${path.split('/')[0]}"] > .row-line .chevron`).click()
  }
  await expect(row).toBeVisible()
  await row.locator(':scope > .row-line').click({ button: 'right' })
}

test('Markdown downloads the unsaved Monaco buffer without saving or changing the active document', async ({ page, request }) => {
  const path = `inbox/export-unsaved-${randomUUID().slice(0, 8)}`
  const created: string[] = []
  const initial = await createDoc(request, path, '# Saved title\n\nSaved body', created)
  try {
    await page.route(`**/api/posts/${path}`, (route) => route.request().method() === 'PUT' ? route.abort() : route.continue())
    await gotoVaultReady(page)
    await openDoc(page, path)
    await page.locator('.editor-pane .monaco-editor .view-lines').click({ position: { x: 40, y: 12 } })
    await page.keyboard.press('Enter')
    await page.keyboard.insertText('UNSAVED_EXPORT_中文_🚀')
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('UNSAVED_EXPORT_中文_🚀')
    // Read the real model after real keyboard input, independent of platform
    // cursor shortcuts. Export must match every byte of this live buffer.
    const liveRaw = await page.evaluate(async (target) => {
      const { getMarkdownModel } = await import('/src/components/vault/monacoModelRegistry.ts')
      const model = getMarkdownModel(target) as { getValue(): string } | undefined
      if (!model) throw new Error('Expected mounted Monaco model')
      return model.getValue()
    }, path)
    expect(liveRaw).toContain('UNSAVED_EXPORT_中文_🚀')
    expect(liveRaw).not.toBe(initial.raw)
    const url = page.url()
    const dirty = page.locator(`[data-tab-id="${path}"] .tab-dirty-indicator`)
    await expect(dirty).toBeVisible()
    await openMenu(page, path)
    const pending = page.waitForEvent('download')
    await chooseDocumentExport(page, 'markdown')
    const download = await pending
    expect(download.suggestedFilename()).toBe(`${path.split('/').pop()}.md`)
    expect(await readFile((await download.path())!, 'utf8')).toBe(liveRaw)
    expect((await (await request.get(`/api/posts/${path}`)).json()).raw).toBe(initial.raw)
    await expect(dirty).toBeVisible()
    expect(page.url()).toBe(url)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator(`[data-tree-key="file:${path}"]`)).toBeFocused()
  } finally {
    await request.delete(`/api/posts/${path}`)
  }
})

test('unopened Markdown preserves all source syntax, CRLF and the exact target instead of the active tab', async ({ page, request }) => {
  const id = randomUUID().slice(0, 8)
  const path = `inbox/export-original-${id}`
  const active = `inbox/export-active-${id}`
  const created: string[] = []
  const raw = [
    '---', 'title: Different display title', 'custom: "中文 🚀"', '---',
    ':::: flex direction=row', '![image](@/attachments/images/existing.svg)', '::::',
    '> [!NOTE]', '> Keep the marker', '```mermaid', 'A-->B', '```',
    '```markmap', '# Original map', '```', '$E=mc^2$', '[[Other Note]]',
    '<!--@include: ./not-bundled.md-->', '<<< ./snippet.ts',
    '![Board](board:8a1c2544-dad0-4f20-a593-7bbc59882921)', '',
  ].join('\r\n')
  const original = await createDoc(request, path, raw, created)
  await createDoc(request, active, '# Active\n\nWRONG_ACTIVE_SOURCE', created)
  try {
    await gotoVaultReady(page)
    await openDoc(page, active)
    const url = page.url()
    await openMenu(page, path)
    const pending = page.waitForEvent('download')
    await chooseDocumentExport(page, 'markdown')
    const download = await pending
    const bytes = await readFile((await download.path())!)
    expect(bytes.equals(Buffer.from(original.raw, 'utf8'))).toBe(true)
    expect(bytes.toString('utf8')).toContain('\r\n')
    expect(download.suggestedFilename()).toBe(`export-original-${id}.md`)
    expect(page.url()).toBe(url)
    await expect(page.locator(`[data-tab-id="${path}"]`)).toHaveCount(0)
    await expect(page.locator('.pdf-export-surface')).toHaveCount(0)
  } finally {
    for (const item of created) await request.delete(`/api/posts/${item}`)
  }
})

test('export retries a source failure, rejects duplicate clicks and uses one delayed snapshot', async ({ page, request }) => {
  const path = `inbox/export-retry-${randomUUID().slice(0, 8)}`
  await createDoc(request, path, '# Retry\n\nTARGET_SOURCE', [])
  try {
    await gotoVaultReady(page)
    let attempts = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    await page.route(`**/api/posts/${path}`, async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      attempts += 1
      if (attempts === 1) return route.fulfill({ status: 500, json: { error: 'Source unavailable' } })
      await gate
      return route.continue()
    })
    await openMenu(page, path)
    await chooseDocumentExport(page, 'markdown')
    const dialog = page.getByRole('dialog')
    const submit = dialog.getByRole('button', { name: /^(Export|导出)$/u })
    await expect(page.getByText(/Document export failed|文档导出失败/u)).toBeVisible()
    await expect(submit).toBeEnabled()
    const pending = page.waitForEvent('download')
    await submit.evaluate((button: HTMLButtonElement) => { button.click(); button.click() })
    await expect.poll(() => attempts).toBe(2)
    await expect(dialog.getByRole('button').last()).toBeDisabled()
    release()
    const download = await pending
    expect(await readFile((await download.path())!, 'utf8')).toContain('TARGET_SOURCE')
    expect(attempts).toBe(2)
    await expect(dialog).toHaveCount(0)
  } finally {
    await request.delete(`/api/posts/${path}`)
  }
})

test('export dialog supports Escape, restores tree focus and fits a mobile viewport', async ({ page, request }, testInfo) => {
  const path = `inbox/export-cancel-${randomUUID().slice(0, 8)}`
  await createDoc(request, path, '', [])
  try {
    await page.setViewportSize({ width: 375, height: 812 })
    await gotoVaultReady(page)
    // Open the existing mobile Files drawer; do not change its layout policy.
    const row = page.locator(`[data-tree-key="file:${path}"]`)
    const files = page.getByRole('button', { name: /Files|文件/u, exact: true })
    if (!await page.locator('.file-tree').isVisible() && await files.count()) await files.first().click()
    await openMenu(page, path)
    await page.locator('.tree-context-menu').getByRole('button', { name: /^(Export…|导出…)$/u }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('radio')).toHaveCount(2)
    const bounds = await dialog.boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375)
    await dialog.screenshot({ path: testInfo.outputPath('export-dialog-mobile.png') })
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(row).toBeFocused()
  } finally {
    await request.delete(`/api/posts/${path}`)
  }
})
