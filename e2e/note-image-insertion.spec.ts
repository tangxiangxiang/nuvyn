import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { deflateSync } from 'node:zlib'
import path from 'node:path'
import { expect, test } from './fixtures/auth'
import { createDoc, gotoVaultReady, openDoc } from './helpers/edit-program'

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii')
  const content = Buffer.concat([typeBytes, data])
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  content.copy(chunk, 4)
  chunk.writeUInt32BE(crc32(content), 8 + data.length)
  return chunk
}

const header = Buffer.alloc(13)
header.writeUInt32BE(1, 0)
header.writeUInt32BE(1, 4)
header[8] = 8
header[9] = 6
const PNG = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  pngChunk('IHDR', header),
  pngChunk('IDAT', deflateSync(Buffer.from([0, 255, 255, 255, 255]))),
  pngChunk('IEND', Buffer.alloc(0)),
])
const PNG_BASE64 = PNG.toString('base64')

async function dispatchImageDrop(page: import('@playwright/test').Page, name: string): Promise<void> {
  const editor = page.locator('.editor-pane .monaco-editor').first()
  const bounds = await editor.boundingBox()
  expect(bounds).not.toBeNull()
  await editor.evaluate((element, input) => {
    const bytes = Uint8Array.from(atob(input.base64), (character) => character.charCodeAt(0))
    const file = new File([bytes], input.name, { type: 'image/png' })
    const data = new DataTransfer()
    data.items.add(file)
    element.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      clientX: input.x,
      clientY: input.y,
      dataTransfer: data,
    }))
  }, { name, base64: PNG_BASE64, x: bounds!.x + 90, y: bounds!.y + 18 })
}

async function dispatchNativeEditContextImagePaste(
  page: import('@playwright/test').Page,
  name = '',
): Promise<{ defaultPrevented: boolean; types: string[]; targetClass: string }> {
  return page.locator('.editor-pane .monaco-editor').first().evaluate((editor, input) => {
    const bytes = Uint8Array.from(atob(input.base64), (character) => character.charCodeAt(0))
    const file = new File([bytes], input.name, { type: 'image/png' })
    const clipboard = new DataTransfer()
    clipboard.items.add(file)

    let target = editor.querySelector<HTMLElement>('.native-edit-context')
    if (!target) {
      target = document.createElement('div')
      target.className = 'native-edit-context'
      target.tabIndex = 0
      editor.querySelector('.overflow-guard')?.append(target)
    }
    if (!target) throw new Error('Monaco input target was not available')
    target.focus()

    const paste = new Event('paste', { bubbles: true, cancelable: true, composed: true })
    Object.defineProperty(paste, 'clipboardData', { value: clipboard })
    target.dispatchEvent(paste)
    return {
      defaultPrevented: paste.defaultPrevented,
      types: Array.from(clipboard.types),
      targetClass: target.className,
    }
  }, { base64: PNG_BASE64, name })
}

async function waitForSavedRaw(
  request: import('@playwright/test').APIRequestContext,
  notePath: string,
  text: string,
): Promise<string> {
  let raw = ''
  await expect.poll(async () => {
    const response = await request.get(`/api/posts/${notePath}`)
    raw = (await response.json() as { raw: string }).raw
    return raw.includes(text)
  }, { timeout: 10_000 }).toBe(true)
  return raw
}

function imagePathFromMarkdown(raw: string): string {
  const match = raw.match(/@\/(attachments\/images\/[0-9a-f-]{36}\.(?:png|jpe?g|gif|webp|avif))/iu)
  if (!match?.[1]) throw new Error('Saved Note did not contain a generated image reference')
  return match[1]
}

test('selects an image, supports undo/redo, renders after reload, and tracks its Note reference', async ({ page, request }) => {
  const runId = randomUUID()
  const notePath = `inbox/note-image-picker-${runId}`
  const createdPaths: string[] = []
  const uploadedPaths: string[] = []
  const vaultRoot = process.env.NUVYN_DRAFT_E2E_VAULT
  if (!vaultRoot) throw new Error('NUVYN_DRAFT_E2E_VAULT is required for Note image E2E')

  try {
    await createDoc(request, notePath, '# Image insertion\n\nKeep this paragraph intact.\n', createdPaths)
    await gotoVaultReady(page)
    await openDoc(page, notePath)

    const editor = page.locator('.editor-pane .monaco-editor').first()
    await editor.locator('.view-lines').click({ position: { x: 35, y: 12 } })
    await page.keyboard.press('Control+End')
    const uploadResponsePromise = page.waitForResponse((response) => (
      new URL(response.url()).pathname === '/api/note/images' && response.request().method() === 'POST'
    ), { timeout: 5_000 })
    const fileChooserPromise = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: /插入图片|Insert image/ }).click()
    const fileChooser = await fileChooserPromise
    await fileChooser.setFiles({ name: 'Architecture Screenshot.png', mimeType: 'image/png', buffer: PNG })
    const uploadResponse = await uploadResponsePromise
    expect(uploadResponse.status(), await uploadResponse.text()).toBe(201)

    const markdown = /!\[Architecture\s+Screenshot\]\(@\/attachments\/images\/[0-9a-f-]{36}\.png\)/iu
    await expect(editor.locator('.view-lines')).toContainText(markdown)
    const insertedRaw = await waitForSavedRaw(request, notePath, 'Architecture Screenshot')
    const uploadedPath = imagePathFromMarkdown(insertedRaw)
    uploadedPaths.push(uploadedPath)
    expect(insertedRaw).toContain('Keep this paragraph intact.')

    await editor.locator('.view-lines').click({ position: { x: 30, y: 12 } })
    await page.keyboard.press('Control+z')
    await expect(editor.locator('.view-lines')).not.toContainText('Architecture Screenshot')
    await page.keyboard.press('Control+Shift+z')
    await expect(editor.locator('.view-lines')).toContainText('Architecture Screenshot')

    await page.getByTestId('view-toggle').click()
    const renderedImage = page.locator('.reading-pane img').first()
    await expect(renderedImage).toBeVisible()
    await expect.poll(() => renderedImage.evaluate((element) => (
      (element as HTMLImageElement).naturalWidth
    ))).toBe(1)
    await page.reload()
    await expect(page.locator('.reading-pane img').first()).toBeVisible()
    await expect.poll(() => page.locator('.reading-pane img').first().evaluate((element) => (
      (element as HTMLImageElement).naturalWidth
    ))).toBe(1)

    await page.locator('[data-testid="account-button"]').click()
    await page.locator('[data-testid="account-settings"]').click()
    const settings = page.locator('.settings-modal')
    await settings.getByRole('button', { name: /存储与附件|Storage & attachments/ }).click()
    await expect(settings.locator('#attachment-manager-title')).toBeVisible()
    await settings.locator('.attachment-toolbar input').fill(path.posix.basename(uploadedPath))
    const resource = settings.locator('.attachment-resource-row').filter({ hasText: uploadedPath })
    await expect(resource).toBeVisible()
    await resource.click()
    await expect(settings.locator('.attachment-detail-panel')).toContainText(uploadedPath)
    await expect(settings.locator('.attachment-reference-row').filter({ hasText: 'Image insertion' })).toBeVisible()
  } finally {
    for (const createdPath of createdPaths) await request.delete(`/api/posts/${createdPath}`).catch(() => {})
    for (const relativePath of uploadedPaths) {
      if (!relativePath.startsWith('attachments/images/')) continue
      await fs.rm(path.join(vaultRoot, ...relativePath.split('/')), { force: true })
    }
    await request.post('/api/attachments/refresh').catch(() => {})
    await request.post('/api/attachments/references/refresh').catch(() => {})
  }
})

test('drops local image files without replacing Note text', async ({ page, request }) => {
  const runId = randomUUID()
  const notePath = `inbox/note-image-inputs-${runId}`
  const createdPaths: string[] = []
  const uploadedPaths: string[] = []
  const vaultRoot = process.env.NUVYN_DRAFT_E2E_VAULT
  if (!vaultRoot) throw new Error('NUVYN_DRAFT_E2E_VAULT is required for Note image E2E')

  try {
    await createDoc(request, notePath, '# Keep this heading\n\nKeep this body unchanged.\n', createdPaths)
    await gotoVaultReady(page)
    await openDoc(page, notePath)
    const editor = page.locator('.editor-pane .monaco-editor').first()
    await editor.locator('.view-lines').click({ position: { x: 35, y: 12 } })
    await page.keyboard.press('Control+End')
    await dispatchImageDrop(page, 'Dropped Diagram.png')
    await expect(editor.locator('.view-lines')).toContainText('![Dropped Diagram](@/attachments/images/')
    const droppedRaw = await waitForSavedRaw(request, notePath, 'Dropped Diagram')
    const insertedImage = droppedRaw.match(/!\[Dropped Diagram\]\(@\/(attachments\/images\/[0-9a-f-]{36}\.png)\)/u)
    expect(insertedImage).not.toBeNull()
    uploadedPaths.push(insertedImage![1]!)
    const originalText = droppedRaw.replace(insertedImage![0], '')
    expect(originalText).toContain('Keep this heading')
    expect(originalText).toContain('Keep this body unchanged.')
  } finally {
    for (const createdPath of createdPaths) await request.delete(`/api/posts/${createdPath}`).catch(() => {})
    for (const relativePath of new Set(uploadedPaths)) {
      if (!relativePath.startsWith('attachments/images/')) continue
      await fs.rm(path.join(vaultRoot, ...relativePath.split('/')), { force: true })
    }
    await request.post('/api/attachments/refresh').catch(() => {})
  }
})

test('pastes a system-style Files PNG from Monaco native-edit-context into the active Note', async ({ page, request }) => {
  const runId = randomUUID()
  const notePath = `inbox/note-image-paste-${runId}`
  const createdPaths: string[] = []
  let uploadedPath = ''
  const vaultRoot = process.env.NUVYN_DRAFT_E2E_VAULT
  if (!vaultRoot) throw new Error('NUVYN_DRAFT_E2E_VAULT is required for Note image E2E')

  try {
    await createDoc(request, notePath, '# Native paste target\n\nKeep this sentence.\n', createdPaths)
    await gotoVaultReady(page)
    await openDoc(page, notePath)
    const editor = page.locator('.editor-pane .monaco-editor').first()
    await editor.locator('.view-lines').click({ position: { x: 35, y: 12 } })
    await page.keyboard.press('Control+End')

    const responsePromise = page.waitForResponse((response) => (
      new URL(response.url()).pathname === '/api/note/images' && response.request().method() === 'POST'
    ), { timeout: 5_000 })
    const clipboardEvent = await dispatchNativeEditContextImagePaste(page)
    expect(clipboardEvent.types).toEqual(['Files'])
    expect(clipboardEvent.targetClass).toContain('native-edit-context')
    expect(clipboardEvent.defaultPrevented).toBe(true)

    const response = await responsePromise
    expect(response.status(), await response.text()).toBe(201)
    await expect(editor.locator('.view-lines')).toContainText('![Image](@/attachments/images/')
    const insertedRaw = await waitForSavedRaw(request, notePath, '![Image](@/attachments/images/')
    const uploadedImagePath = imagePathFromMarkdown(insertedRaw)
    uploadedPath = uploadedImagePath
    expect(insertedRaw).toContain('Keep this sentence.')
  } finally {
    for (const createdPath of createdPaths) await request.delete(`/api/posts/${createdPath}`).catch(() => {})
    if (uploadedPath.startsWith('attachments/images/')) {
      await fs.rm(path.join(vaultRoot, ...uploadedPath.split('/')), { force: true })
    }
    await request.post('/api/attachments/refresh').catch(() => {})
    await request.post('/api/attachments/references/refresh').catch(() => {})
  }
})

test('does not insert an in-flight upload into a different Note after switching tabs', async ({ page, request }) => {
  const runId = randomUUID()
  const firstPath = `inbox/note-image-switch-a-${runId}`
  const secondPath = `inbox/note-image-switch-b-${runId}`
  const createdPaths: string[] = []
  let uploadedPath = ''
  const vaultRoot = process.env.NUVYN_DRAFT_E2E_VAULT
  if (!vaultRoot) throw new Error('NUVYN_DRAFT_E2E_VAULT is required for Note image E2E')
  let releaseUpload!: () => void
  let uploadRequestSeen = false
  const uploadGate = new Promise<void>((resolve) => { releaseUpload = resolve })

  try {
    await createDoc(request, firstPath, '# Upload source\n\nSource remains unchanged.\n', createdPaths)
    await createDoc(request, secondPath, '# Other Note\n\nSecond Note stays clean.\n', createdPaths)
    await gotoVaultReady(page)
    await openDoc(page, firstPath)
    const firstEditor = page.locator('.editor-pane .monaco-editor').first()
    await firstEditor.locator('.view-lines').click({ position: { x: 35, y: 12 } })
    await page.keyboard.press('Control+End')
    await page.route('**/api/note/images', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      uploadRequestSeen = true
      await uploadGate
      return route.continue()
    })

    const responsePromise = page.waitForResponse((item) => (
      new URL(item.url()).pathname === '/api/note/images' && item.request().method() === 'POST'
    ))
    const clipboardEvent = await dispatchNativeEditContextImagePaste(page, 'Switch Diagram.png')
    expect(clipboardEvent.defaultPrevented).toBe(true)
    await expect.poll(() => uploadRequestSeen).toBe(true)
    await openDoc(page, secondPath)
    releaseUpload()
    const response = await responsePromise
    expect(response.status()).toBe(201)
    const result = await response.json() as { path: string }
    uploadedPath = result.path

    const secondEditor = page.locator('.editor-pane .monaco-editor').first()
    await expect(secondEditor.locator('.view-lines')).toContainText('Second Note stays clean.')
    await expect(secondEditor.locator('.view-lines')).not.toContainText('@/attachments/images/')
    await expect(page.getByText(/图片已保存，但插入位置已失效|image was saved, but its insertion point is no longer available/i)).toBeVisible()
    expect((await (await request.get(`/api/posts/${firstPath}`)).json() as { raw: string }).raw)
      .not.toContain('@/attachments/images/')
  } finally {
    releaseUpload()
    await page.unroute('**/api/note/images').catch(() => {})
    for (const createdPath of createdPaths) await request.delete(`/api/posts/${createdPath}`).catch(() => {})
    if (uploadedPath.startsWith('attachments/images/')) {
      await fs.rm(path.join(vaultRoot, ...uploadedPath.split('/')), { force: true })
    }
    await request.post('/api/attachments/refresh').catch(() => {})
  }
})
