import { randomUUID } from 'node:crypto'
import { expect, test } from './fixtures/auth'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

test('Note image trash preserves authenticated Markdown reads, preview, refresh and restore on desktop and mobile', async ({ page, request }) => {
  const notePath = `inbox/attachment-trash-${randomUUID()}`
  const note = await request.post('/api/posts', { data: { path: notePath, title: 'Trash regression' } })
  expect(note.status()).toBe(201)
  let recycledId: string | null = null
  try {
    const uploaded = await request.post('/api/note/images', {
      headers: { Origin: 'http://127.0.0.1:4174' }, multipart: { image: { name: 'trash.png', mimeType: 'image/png', buffer: PNG } },
    })
    expect(uploaded.status(), await uploaded.text()).toBe(201)
    const image = await uploaded.json() as { path: string }
    await request.post('/api/attachments/refresh')
    await page.goto(`/vault/${notePath}`)
    await expect(page.locator('.editor-pane .monaco-editor').first()).toBeVisible()
    async function openManager() {
      await page.locator('[data-testid="account-button"]').click()
      await page.locator('[data-testid="account-settings"]').click()
      await page.locator('.settings-modal').getByRole('button', { name: /存储与附件|Storage & attachments/ }).click()
    }
    await openManager()
    const settings = page.locator('.settings-modal')
    await settings.locator('.attachment-toolbar input').fill(image.path)
    await expect(settings.locator('.attachment-resource-row')).toHaveCount(1)
    await settings.locator('.attachment-resource-row').click()
    const preflightResponse = page.waitForResponse((response) => response.url().endsWith('/api/attachments/cleanup-preview') && response.request().method() === 'POST')
    await settings.getByRole('button', { name: /检查引用风险|Check reference risks/ }).click()
    const eligibility = await (await preflightResponse).json()
    expect(eligibility.quarantineAllowed, JSON.stringify(eligibility)).toBe(true)
    const recycle = settings.getByRole('button', { name: /移入回收站|Move to trash/ })
    await expect(recycle).toBeEnabled()
    await recycle.click()
    const confirmation = page.locator('.n-dialog[role="dialog"]')
    await expect(confirmation).toContainText(/不会立即释放 NAS|does not immediately free NAS/)
    await confirmation.getByRole('button', { name: /移入回收站|Move to trash/ }).click()
    await expect(settings.locator('.attachment-resource-row')).toHaveCount(0)
    const trashResponse = await request.get('/api/attachments/trash')
    const trash = await trashResponse.json() as { items: Array<{ id: string; path: string; state: string }> }
    recycledId = trash.items.find((item) => item.path === image.path)!.id
    expect(trash.items.find((item) => item.id === recycledId)?.state).toBe('trashed')
    const historical = await request.get(`/api/markdown-resources?kind=image&path=${image.path}`)
    expect(historical.status()).toBe(200)
    expect(await historical.body()).toEqual(PNG)

    // A later Note may refer to the original path even while the image is in trash.
    const original = await (await request.get(`/api/posts/${notePath}`)).json() as { raw: string }
    const saved = await request.put(`/api/posts/${notePath}`, { data: { baseRaw: original.raw, raw: `${original.raw}\n\n![Historical image](@/${image.path})` } })
    expect(saved.ok()).toBe(true)
    await page.reload()
    await expect(page.locator('.editor-pane .monaco-editor').first()).toBeVisible()
    await openManager()
    await settings.getByRole('button', { name: /^(回收站|Trash)$/ }).click()
    await settings.locator('.attachment-trash input').fill(image.path)
    await expect(settings.locator('.trash-list button')).toHaveCount(1)
    await settings.locator('.trash-list button').click()
    await expect(settings.locator('.trash-detail .attachment-image-preview img')).toBeVisible()
    for (const width of [1440, 768, 375]) {
      await page.setViewportSize({ width, height: 900 })
      const overflow = await settings.locator('.settings-detail').evaluate((element) => element.scrollWidth - element.clientWidth)
      expect(overflow).toBeLessThanOrEqual(1)
    }
    const restoreButton = settings.locator('.trash-detail').getByRole('button', { name: /^(恢复|Restore)$/ })
    await expect(restoreButton).toBeEnabled()
    await restoreButton.click()
    await expect(settings.locator('.trash-list button')).toHaveCount(0)
    recycledId = null
    const restored = await request.get(`/api/markdown-resources?kind=image&path=${image.path}`)
    expect(await restored.body()).toEqual(PNG)
    await settings.getByRole('button', { name: /^(活动附件|Active attachments)$/ }).click()
    await settings.locator('.attachment-toolbar input').fill(image.path)
    await expect(settings.locator('.attachment-resource-row')).toHaveCount(1)
    await settings.getByRole('button', { name: /关闭|Close/ }).click()
    await expect(settings).toHaveCount(0)
    await page.getByRole('banner').getByRole('button', { name: /^(Switch to read|切换到阅读模式)$/ }).click()
    await expect(page.locator('.reading-pane img[alt="Historical image"]')).toBeVisible()
  } finally {
    if (recycledId) await request.post('/api/attachments/trash/restore', { data: { id: recycledId } }).catch(() => {})
    await request.delete(`/api/posts/${notePath}`).catch(() => {})
  }
})
