import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { expect, test } from './fixtures/auth'

test('Attachment Manager lists real sources, filters, refreshes, and preserves the open editor', async ({ page, request }) => {
  const runId = randomUUID()
  const notePath = `inbox/attachment-manager-note-${runId}`
  const assetId = randomUUID()
  const materialName = `Attachment Manager Material ${runId.slice(0, 8)}`
  const initialFileName = `attachment-manager-initial-${runId.slice(0, 8)}.txt`
  const refreshedFileName = `attachment-manager-refreshed-${runId.slice(0, 8)}.txt`
  const vaultRoot = process.env.NUVYN_DRAFT_E2E_VAULT
  if (!vaultRoot) throw new Error('NUVYN_DRAFT_E2E_VAULT is required for Attachment Manager E2E')
  const initialFilePath = path.join(vaultRoot, 'inbox', initialFileName)
  const refreshedFilePath = path.join(vaultRoot, 'inbox', refreshedFileName)
  let materialId: string | null = null
  let noteCreated = false
  let assetCreated = false

  try {
    const note = await request.post('/api/posts', { data: { path: notePath, title: 'Attachment manager editor state' } })
    expect(note.status(), await note.text()).toBe(201)
    noteCreated = true
    await fs.writeFile(initialFilePath, 'catalog fixture')

    const asset = await request.put(`/api/assets/${assetId}`, {
      headers: { 'Content-Type': 'image/png' },
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
    })
    expect(asset.status(), await asset.text()).toBe(200)
    assetCreated = true

    const material = await request.post('/api/board-materials', {
      data: {
        name: materialName,
        svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="2" /></svg>',
      },
    })
    expect(material.status(), await material.text()).toBe(201)
    materialId = (await material.json() as { id: string }).id

    await page.goto(`/vault/${notePath}`)
    const editor = page.locator('.editor-pane .monaco-editor').first()
    await expect(editor).toBeVisible()
    await expect(page.locator('.editor-pane .monaco-editor .view-lines')).toContainText('Attachment manager editor state')
    await page.evaluate(() => {
      ;(window as typeof window & { __attachmentManagerEditor?: Element | null }).__attachmentManagerEditor = document.querySelector('.editor-pane .monaco-editor')
    })
    const initialUrl = page.url()

    await page.locator('[data-testid="account-button"]').click()
    await page.locator('[data-testid="account-settings"]').click()
    const settings = page.locator('.settings-modal')
    await settings.getByRole('button', { name: /存储与附件|Storage & attachments/ }).click()
    await expect(settings.locator('#attachment-manager-title')).toBeVisible()
    await expect(settings.locator('.attachment-resource-row').filter({ hasText: initialFileName })).toBeVisible()
    await expect(settings.locator('.attachment-resource-row').filter({ hasText: materialName })).toBeVisible()
    await expect(settings.getByText(new RegExp(`(?:未命名图片|Unnamed image) · ${assetId.slice(0, 8)}`), { exact: true })).toBeVisible()
    await expect(settings.getByRole('button', { name: /删除|上传/ })).toHaveCount(0)

    await settings.locator('.attachment-resource-row').filter({ hasText: initialFileName }).click()
    await expect(settings.locator('.attachment-detail-panel')).toContainText(`inbox/${initialFileName}`)
    await expect(settings.locator('.attachment-detail-panel')).toContainText(/待确认|Unknown/)
    await expect(settings.getByRole('button', { name: /复制 ID \/ 路径|Copy ID \/ path/ })).toBeVisible()

    // The catalog is a snapshot: a subsequent on-disk file appears after the
    // explicit refresh, not during ordinary pagination/search.
    await fs.writeFile(refreshedFilePath, 'new file after initial snapshot')
    await settings.getByRole('button', { name: /刷新目录|Refresh catalog/ }).click()
    await expect(settings.locator('.attachment-resource-row').filter({ hasText: refreshedFileName })).toBeVisible()

    await settings.locator('.attachment-toolbar input').fill(assetId.slice(0, 12))
    await expect(settings.locator('.attachment-resource-row')).toHaveCount(1)
    await settings.locator('.attachment-resource-row').click()
    await expect(settings.locator('.attachment-detail-panel')).toContainText(assetId)

    await settings.getByRole('button', { name: /返回设置|Back to settings/ }).click()
    await expect(settings.locator('.settings-nav')).toBeVisible()
    await settings.getByRole('button', { name: /关闭|Close/ }).click()
    await expect(settings).toHaveCount(0)
    await expect(editor).toBeVisible()
    expect(await page.evaluate(() => (
      (window as typeof window & { __attachmentManagerEditor?: Element | null }).__attachmentManagerEditor
        === document.querySelector('.editor-pane .monaco-editor')
    ))).toBe(true)
    expect(page.url()).toBe(initialUrl)
  } finally {
    if (materialId) {
      await request.post(`/api/board-materials/${materialId}/archive`).catch(() => {})
      await request.delete(`/api/board-materials/${materialId}`).catch(() => {})
    }
    if (assetCreated) await request.delete(`/api/assets/${assetId}/unreferenced`).catch(() => {})
    if (noteCreated) await request.delete(`/api/posts/${notePath}`).catch(() => {})
    await fs.rm(initialFilePath, { force: true })
    await fs.rm(refreshedFilePath, { force: true })
    await request.post('/api/attachments/refresh').catch(() => {})
  }
})
