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
const SVG = Buffer.from('<?xml version="1.0" standalone="no"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60" width="120" height="60"><defs><mask id="crop" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse"><rect x="0" y="0" width="120" height="60" fill="#fff"/></mask><symbol id="vector"><rect width="120" height="60" fill="#6270ac"/><text x="8" y="36" fill="#fff">Vector works</text></symbol></defs><g mask="url(#crop)"><use href="#vector" width="120" height="60"/></g></svg>')
const SVG_BASE64 = SVG.toString('base64')

async function dispatchImageDrop(
  page: import('@playwright/test').Page,
  name: string,
  options: { bytes?: string; mimeType?: string } = {},
): Promise<void> {
  const editor = page.locator('.editor-pane .monaco-editor').first()
  const bounds = await editor.boundingBox()
  expect(bounds).not.toBeNull()
  await editor.evaluate((element, input) => {
    const bytes = Uint8Array.from(atob(input.base64), (character) => character.charCodeAt(0))
    const file = new File([bytes], input.name, { type: input.mimeType })
    const data = new DataTransfer()
    data.items.add(file)
    element.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      clientX: input.x,
      clientY: input.y,
      dataTransfer: data,
    }))
  }, {
    name,
    base64: options.bytes ?? PNG_BASE64,
    mimeType: options.mimeType ?? 'image/png',
    x: bounds!.x + 90,
    y: bounds!.y + 18,
  })
}

async function openNoteImagePickerFromContextMenu(page: import('@playwright/test').Page): Promise<void> {
  const editor = page.locator('.editor-pane .monaco-editor').first()
  // Monaco updates the cursor DOM on an animation frame. A right-click at
  // its old rectangle can move the caret back into the document title.
  await expect.poll(() => page.locator('.monaco-host').evaluate((element) => {
    const instance = (element as any).__vueParentComponent.setupState.editor
    const position = instance.getPosition()
    const expected = instance.getScrolledVisiblePosition(position)
    const cursor = element.querySelector('.cursors-layer .cursor')?.getBoundingClientRect()
    if (!expected || !cursor) return false
    const bounds = instance.getDomNode().getBoundingClientRect()
    return Math.abs(cursor.left - bounds.left - expected.left) <= 1
      && Math.abs(cursor.top - bounds.top - expected.top) <= 1
  })).toBe(true)
  const cursor = editor.locator('.cursors-layer .cursor').first()
  const cursorBounds = await cursor.boundingBox()
  expect(cursorBounds).not.toBeNull()
  await page.mouse.click(
    cursorBounds!.x,
    cursorBounds!.y + cursorBounds!.height / 2,
    { button: 'right' },
  )
  const insertImage = page.getByRole('menuitem', { name: /插入图片|Insert image/i })
  await expect(insertImage).toBeVisible()
  // Monaco attaches its menu mouse-up handler 100ms after rendering so the
  // right-click that opened the menu cannot accidentally activate an item.
  await page.waitForTimeout(120)
  await insertImage.click()
  await expect(page.locator('.attachment-picker-modal')).toBeVisible()
}

async function dispatchNativeEditContextImagePaste(
  page: import('@playwright/test').Page,
  name = '',
  options: { bytes?: string; mimeType?: string } = {},
): Promise<{ defaultPrevented: boolean; types: string[]; targetClass: string }> {
  return page.locator('.editor-pane .monaco-editor').first().evaluate((editor, input) => {
    const bytes = Uint8Array.from(atob(input.base64), (character) => character.charCodeAt(0))
    const file = new File([bytes], input.name, { type: input.mimeType })
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
  }, { base64: options.bytes ?? PNG_BASE64, mimeType: options.mimeType ?? 'image/png', name })
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
  const match = raw.match(/@\/(attachments\/images\/[0-9a-f-]{36}\.(?:png|jpe?g|gif|webp|avif|svg))/iu)
  if (!match?.[1]) throw new Error('Saved Note did not contain a generated image reference')
  return match[1]
}

test('selects, drops, and pastes SVG into Note Markdown, then renders it after reload', async ({ page, request }) => {
  const runId = randomUUID()
  const notePath = `inbox/svg-reference-${runId}`
  const createdPaths: string[] = []
  const uploadedPaths: string[] = []
  const vaultRoot = process.env.NUVYN_DRAFT_E2E_VAULT
  if (!vaultRoot) throw new Error('NUVYN_DRAFT_E2E_VAULT is required for Note image E2E')

  try {
    await createDoc(request, notePath, 'Keep this paragraph intact.\n', createdPaths)
    await gotoVaultReady(page)
    await openDoc(page, notePath)
    const editor = page.locator('.editor-pane .monaco-editor').first()
    await editor.locator('.view-lines').click({ position: { x: 35, y: 12 } })
    await page.keyboard.press('Control+End')

    const pickerResponsePromise = page.waitForResponse((response) => (
      new URL(response.url()).pathname === '/api/note/images' && response.request().method() === 'POST'
    ))
    const chooserPromise = page.waitForEvent('filechooser')
    await openNoteImagePickerFromContextMenu(page)
    const picker = page.locator('.attachment-picker-modal')
    await expect(picker).toBeVisible()
    await picker.getByRole('button', { name: /上传新图片|Upload (?:a )?new image/ }).click()
    const chooser = await chooserPromise
    await chooser.setFiles({ name: 'Architecture.svg', mimeType: 'image/svg+xml', buffer: SVG })
    const pickerResponse = await pickerResponsePromise
    expect(pickerResponse.status(), await pickerResponse.text()).toBe(201)
    await expect(editor.locator('.view-lines')).toContainText('![Architecture](@/attachments/images/')

    await editor.locator('.view-lines').click({ position: { x: 35, y: 12 } })
    await page.keyboard.press('Control+End')
    const dropResponsePromise = page.waitForResponse((response) => (
      new URL(response.url()).pathname === '/api/note/images' && response.request().method() === 'POST'
    ))
    // Some operating systems expose locally dragged SVG files with a generic
    // XML MIME type; the server still validates the actual SVG bytes.
    await dispatchImageDrop(page, 'Dropped Diagram.svg', { bytes: SVG_BASE64, mimeType: 'application/xml' })
    const dropResponse = await dropResponsePromise
    expect(dropResponse.status(), await dropResponse.text()).toBe(201)

    await page.keyboard.press('Control+End')
    const pasteResponsePromise = page.waitForResponse((response) => (
      new URL(response.url()).pathname === '/api/note/images' && response.request().method() === 'POST'
    ))
    const clipboardEvent = await dispatchNativeEditContextImagePaste(page, 'Clipboard Map.svg', {
      bytes: SVG_BASE64,
      mimeType: 'image/svg+xml',
    })
    expect(clipboardEvent.types).toEqual(['Files'])
    expect(clipboardEvent.defaultPrevented).toBe(true)
    const pasteResponse = await pasteResponsePromise
    expect(pasteResponse.status(), await pasteResponse.text()).toBe(201)

    const saved = await waitForSavedRaw(request, notePath, 'Clipboard Map')
    expect(saved).toContain('![Architecture](@/attachments/images/')
    expect(saved).toContain('![Dropped Diagram](@/attachments/images/')
    expect(saved).toContain('![Clipboard Map](@/attachments/images/')
    expect(saved.replace(/!\[[^\]]*\]\(@\/attachments\/images\/[0-9a-f-]{36}\.svg\)/gu, ''))
      .toContain('Keep this paragraph intact.')
    uploadedPaths.push(...[...saved.matchAll(/@\/(attachments\/images\/[0-9a-f-]{36}\.svg)/gu)].map((match) => match[1]!))
    expect(new Set(uploadedPaths).size).toBe(3)

    await page.getByTestId('view-toggle').click()
    const images = page.locator('.reading-pane img')
    await expect(images).toHaveCount(3)
    for (const image of await images.all()) {
      await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(120)
      const dimensions = await image.evaluate((element) => ({
        width: (element as HTMLImageElement).naturalWidth,
        height: (element as HTMLImageElement).naturalHeight,
      }))
      expect(dimensions.width / dimensions.height).toBe(2)
    }

    await page.reload()
    const reloadedImage = page.locator('.reading-pane img').first()
    await expect(reloadedImage).toBeVisible()
    await expect.poll(() => reloadedImage.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(120)

  } finally {
    for (const createdPath of createdPaths) await request.delete(`/api/posts/${createdPath}`).catch(() => {})
    for (const relativePath of new Set(uploadedPaths)) {
      if (!relativePath.startsWith('attachments/images/')) continue
      await fs.rm(path.join(vaultRoot, ...relativePath.split('/')), { force: true })
    }
    await request.post('/api/attachments/refresh').catch(() => {})
    await request.post('/api/attachments/references/refresh').catch(() => {})
  }
})

test('reuses Vault images directly in Note and imports Board Assets as validated copies', async ({ page, request }) => {
  const runId = randomUUID()
  const notePath = `inbox/attachment-picker-${runId}`
  const createdPaths: string[] = []
  const createdVaultImages: string[] = []
  const boardAssetId = randomUUID()
  const vaultRoot = process.env.NUVYN_DRAFT_E2E_VAULT
  if (!vaultRoot) throw new Error('NUVYN_DRAFT_E2E_VAULT is required for Note image E2E')

  try {
    const sourceUpload = await request.post('/api/note/images', {
      headers: { Origin: process.env.NUVYN_PUBLIC_ORIGIN },
      multipart: { image: { name: 'direct-reference.png', mimeType: 'image/png', buffer: PNG } },
    })
    expect(sourceUpload.status(), await sourceUpload.text()).toBe(201)
    const sourcePath = (await sourceUpload.json() as { path: string }).path
    createdVaultImages.push(sourcePath)

    const boardAssetUpload = await request.put(`/api/assets/${boardAssetId}`, {
      headers: { Origin: process.env.NUVYN_PUBLIC_ORIGIN, 'Content-Type': 'image/png' },
      data: PNG,
    })
    expect(boardAssetUpload.status(), await boardAssetUpload.text()).toBe(200)

    await createDoc(request, notePath, '# Attachment picker\n', createdPaths)
    await request.post('/api/attachments/refresh')
    await gotoVaultReady(page)
    await openDoc(page, notePath)
    const editor = page.locator('.editor-pane .monaco-editor').first()
    await editor.locator('.view-lines').click({ position: { x: 35, y: 12 } })
    await page.keyboard.press('Control+End')

    let noteImageUploads = 0
    const countNoteImageUploads = (requestEvent: import('@playwright/test').Request) => {
      if (requestEvent.method() === 'POST' && new URL(requestEvent.url()).pathname === '/api/note/images') {
        noteImageUploads += 1
      }
    }
    page.on('request', countNoteImageUploads)

    await openNoteImagePickerFromContextMenu(page)
    const picker = page.locator('.attachment-picker-modal')
    await expect(picker).toBeVisible()
    await picker.getByPlaceholder(/搜索名称、路径或 ID|Search names, paths, or IDs/).fill(sourcePath.split('/').at(-1)!)
    const vaultOption = picker.getByRole('option').filter({ hasText: sourcePath.split('/').at(-1)! })
    await expect(vaultOption).toHaveCount(1)
    await expect(vaultOption).toContainText(/直接引用|Direct reference/)
    await vaultOption.click()
    await picker.getByRole('button', { name: /插入图片|Insert image/ }).click()
    await expect(editor.locator('.view-lines')).toContainText(`@/${sourcePath}`)
    const directRaw = await waitForSavedRaw(request, notePath, `@/${sourcePath}`)
    expect(directRaw).toContain(`![${sourcePath.split('/').at(-1)?.replace(/\.[^.]+$/u, '')}](@/${sourcePath})`)
    expect(noteImageUploads).toBe(0)

    await editor.locator('.view-lines').click({ position: { x: 35, y: 12 } })
    await page.keyboard.press('Control+End')
    await openNoteImagePickerFromContextMenu(page)
    await expect(picker).toBeVisible()
    await picker.getByPlaceholder(/搜索名称、路径或 ID|Search names, paths, or IDs/).fill(boardAssetId)
    const boardOption = picker.getByRole('option').filter({ hasText: boardAssetId.slice(0, 8) })
    await expect(boardOption).toHaveCount(1)
    await expect(boardOption).toContainText(/导入副本|Import a copy/)
    await boardOption.click()
    const importResponsePromise = page.waitForResponse((response) => (
      new URL(response.url()).pathname === '/api/note/images' && response.request().method() === 'POST'
    ))
    await picker.getByRole('button', { name: /插入图片|Insert image/ }).click()
    const importResponse = await importResponsePromise
    expect(importResponse.status(), await importResponse.text()).toBe(201)
    const imported = await importResponse.json() as { id: string; path: string }
    createdVaultImages.push(imported.path)
    expect(imported.path).toMatch(/^attachments\/images\/[0-9a-f-]{36}\.png$/iu)
    expect(imported.id).not.toBe(boardAssetId)
    expect(await waitForSavedRaw(request, notePath, `@/${imported.path}`)).toContain(`@/${imported.path}`)
    expect(noteImageUploads).toBe(1)

    const originalAsset = await request.get(`/api/assets/${boardAssetId}`)
    expect(originalAsset.status()).toBe(200)
    expect(await originalAsset.body()).toEqual(PNG)
    const audit = await request.get('/api/attachments/audit?limit=100')
    expect(audit.status()).toBe(200)
    expect((await audit.json() as { entries: Array<{ operation: string; sourceResourceId: string | null }> }).entries)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ operation: 'note-import-from-board-asset', sourceResourceId: boardAssetId }),
      ]))
    page.off('request', countNoteImageUploads)

    await page.reload()
    await expect(page.locator('.editor-pane .monaco-editor').first()).toBeVisible()
    const restoredRaw = await (await request.get(`/api/posts/${notePath}`)).json() as { raw: string }
    expect(restoredRaw.raw).toContain(`@/${sourcePath}`)
    expect(restoredRaw.raw).toContain(`@/${imported.path}`)
  } finally {
    for (const createdPath of createdPaths) await request.delete(`/api/posts/${createdPath}`).catch(() => {})
    for (const relativePath of new Set(createdVaultImages)) {
      if (!relativePath.startsWith('attachments/images/')) continue
      await fs.rm(path.join(vaultRoot, ...relativePath.split('/')), { force: true })
    }
    await request.delete(`/api/assets/${boardAssetId}/unreferenced`).catch(() => {})
    await request.post('/api/attachments/refresh').catch(() => {})
    await request.post('/api/attachments/references/refresh').catch(() => {})
  }
})

test('renders and decodes an SVG exported by the pinned Excalidraw package', async ({ page, request }) => {
  const runId = randomUUID()
  const notePath = `inbox/excalidraw-svg-${runId}`
  const createdPaths: string[] = []
  const uploadedPaths: string[] = []
  const vaultRoot = process.env.NUVYN_DRAFT_E2E_VAULT
  if (!vaultRoot) throw new Error('NUVYN_DRAFT_E2E_VAULT is required for Note image E2E')

  try {
    const fixture = await fs.readFile(path.resolve('e2e/fixtures/excalidraw-note-image.svg'))
    const upload = await request.post('/api/note/images', {
      headers: { Origin: process.env.NUVYN_PUBLIC_ORIGIN },
      multipart: { image: { name: 'excalidraw-export.svg', mimeType: 'image/svg+xml', buffer: fixture } },
    })
    expect(upload.status(), await upload.text()).toBe(201)
    const imagePath = (await upload.json() as { path: string }).path
    uploadedPaths.push(imagePath)

    await createDoc(request, notePath, `# Excalidraw export\n\n![Excalidraw scene](@/${imagePath})\n`, createdPaths)
    await gotoVaultReady(page)
    await openDoc(page, notePath)
    await page.getByTestId('view-toggle').click()

    const image = page.locator('.reading-pane img[alt="Excalidraw scene"]')
    await expect(image).toBeVisible()
    const decoded = await image.evaluate(async (element) => {
      const img = element as HTMLImageElement
      await img.decode()
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Canvas 2D context is unavailable')
      context.drawImage(img, 0, 0)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      let nonWhitePixels = 0
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index + 3]! > 0 && (pixels[index]! < 245 || pixels[index + 1]! < 245 || pixels[index + 2]! < 245)) {
          nonWhitePixels += 1
        }
      }
      return { width: img.naturalWidth, height: img.naturalHeight, nonWhitePixels }
    })
    expect(decoded.width).toBeGreaterThan(300)
    expect(decoded.height).toBeGreaterThan(200)
    expect(decoded.nonWhitePixels).toBeGreaterThan(3_000)
    const initialBounds = await image.boundingBox()
    expect(initialBounds).not.toBeNull()
    await image.evaluate((element) => {
      const img = element as HTMLImageElement
      img.style.width = `${img.naturalWidth * 1.5}px`
    })
    const scaledBounds = await image.boundingBox()
    expect(scaledBounds!.width).toBeGreaterThan(initialBounds!.width)

    const safeResponse = await request.get(`/api/markdown-resources?kind=image&path=${encodeURIComponent(imagePath)}`)
    expect(safeResponse.status()).toBe(200)
    const safeSvg = await safeResponse.text()
    expect(safeSvg).toContain('中文 / English')
    expect(safeSvg).toContain('<clipPath')
    expect(safeSvg).toContain('<use href="#image-fixture-png"')
    expect(safeSvg).toContain('@font-face{font-family:Virgil;src:url(data:font/woff2;base64,')
    const embeddedFontSource = safeSvg.match(/@font-face\{font-family:Virgil;src:url\((data:font\/woff2;base64,[^)]+)\)\}/u)?.[1]
    expect(embeddedFontSource).toBeTruthy()
    const fontLoaded = await page.evaluate(async (source) => {
      const font = new FontFace('NuvynExcalidrawFixture', `url("${source}")`)
      await font.load()
      document.fonts.add(font)
      return document.fonts.check('16px NuvynExcalidrawFixture')
    }, embeddedFontSource!)
    expect(fontLoaded).toBe(true)
  } finally {
    for (const createdPath of createdPaths) await request.delete(`/api/posts/${createdPath}`).catch(() => {})
    for (const relativePath of new Set(uploadedPaths)) {
      if (!relativePath.startsWith('attachments/images/')) continue
      await fs.rm(path.join(vaultRoot, ...relativePath.split('/')), { force: true })
    }
    await request.post('/api/attachments/refresh').catch(() => {})
    await request.post('/api/attachments/references/refresh').catch(() => {})
  }
})

test('renders a Flex image layout on desktop and stacks it on mobile', async ({ page, request }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  const runId = randomUUID()
  const notePath = `inbox/row-${runId.slice(0, 8)}`
  const createdPaths: string[] = []
  const uploadedPaths: string[] = []
  const vaultRoot = process.env.NUVYN_DRAFT_E2E_VAULT
  if (!vaultRoot) throw new Error('NUVYN_DRAFT_E2E_VAULT is required for Note image E2E')

  try {
    const pngUpload = await request.post('/api/note/images', {
      headers: { Origin: process.env.NUVYN_PUBLIC_ORIGIN },
      multipart: { image: { name: 'row.png', mimeType: 'image/png', buffer: PNG } },
    })
    expect(pngUpload.status(), await pngUpload.text()).toBe(201)
    const pngPath = (await pngUpload.json() as { path: string }).path
    uploadedPaths.push(pngPath)

    const svgUpload = await request.post('/api/note/images', {
      headers: { Origin: process.env.NUVYN_PUBLIC_ORIGIN },
      multipart: { image: { name: 'row.svg', mimeType: 'image/svg+xml', buffer: SVG } },
    })
    expect(svgUpload.status(), await svgUpload.text()).toBe(201)
    const svgPath = (await svgUpload.json() as { path: string }).path
    uploadedPaths.push(svgPath)

    await createDoc(request, notePath, [
      '# Image Flex',
      '',
      `![Standalone](@/${pngPath})`,
      '',
      '::: flex',
      '',
      `![Raster](@/${pngPath})`,
      '',
      `![Vector](@/${svgPath})`,
      '',
      ':::',
    ].join('\n'), createdPaths)
    await gotoVaultReady(page)
    await openDoc(page, notePath)
    await page.getByTestId('view-toggle').click()

    const flex = page.locator('.reading-pane .nuvyn-flex')
    const flexImages = flex.locator('img')
    await expect(flex).toBeVisible()
    await expect(flexImages).toHaveCount(2)
    await expect.poll(() => flexImages.nth(0).evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(1)
    await expect.poll(() => flexImages.nth(1).evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(120)

    const desktopGeometry = await flexImages.evaluateAll((images) => images.map((image) => {
      const bounds = image.getBoundingClientRect()
      return { x: bounds.x, y: bounds.y, right: bounds.right, width: bounds.width }
    }))
    expect(desktopGeometry[0]!.x).not.toBe(desktopGeometry[1]!.x)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

    await page.setViewportSize({ width: 390, height: 844 })
    const leftPanelToggle = page.getByTestId('left-panel-toggle')
    if ((await leftPanelToggle.getAttribute('aria-pressed')) === 'true') await leftPanelToggle.click()
    const rightRailToggle = page.locator('.right-rail-toggle')
    if (await rightRailToggle.count()) {
      if ((await rightRailToggle.getAttribute('aria-pressed')) === 'true') await rightRailToggle.click()
    }
    const mobileGeometry = await flexImages.evaluateAll((images) => images.map((image) => {
      const bounds = image.getBoundingClientRect()
      return { x: bounds.x, y: bounds.y, right: bounds.right, width: bounds.width }
    }))
    expect(mobileGeometry[0]!.y).toBeLessThan(mobileGeometry[1]!.y)
    expect(mobileGeometry.every((bounds) => bounds.right <= 390 && bounds.width >= 0)).toBe(true)
    const mobileOverflow = await page.evaluate(() => ({
      viewport: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      offenders: Array.from(document.body.querySelectorAll('*'))
        .map((element) => ({
          tag: element.tagName,
          className: typeof element.className === 'string' ? element.className : '',
          left: Math.round(element.getBoundingClientRect().left),
          right: Math.round(element.getBoundingClientRect().right),
          width: Math.round(element.getBoundingClientRect().width),
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        }))
        .filter((element) => element.right > window.innerWidth + 1 || element.scrollWidth > element.clientWidth + 1)
        .slice(0, 12),
    }))
    expect(mobileOverflow.documentWidth, JSON.stringify(mobileOverflow)).toBeLessThanOrEqual(mobileOverflow.viewport)

    await page.reload()
    const reloadedFlexImages = page.locator('.reading-pane .nuvyn-flex img')
    await expect(reloadedFlexImages).toHaveCount(2)
    await expect.poll(() => reloadedFlexImages.nth(0).evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(1)
    await expect.poll(() => reloadedFlexImages.nth(1).evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(120)
    await expect(page.locator('.reading-pane img[alt="Standalone"]')).toBeVisible()
  } finally {
    for (const createdPath of createdPaths) await request.delete(`/api/posts/${createdPath}`).catch(() => {})
    for (const relativePath of new Set(uploadedPaths)) {
      if (!relativePath.startsWith('attachments/images/')) continue
      await fs.rm(path.join(vaultRoot, ...relativePath.split('/')), { force: true })
    }
    await request.post('/api/attachments/refresh').catch(() => {})
    await request.post('/api/attachments/references/refresh').catch(() => {})
  }
})

test('Attachment Manager lists referenced SVGs and direct reads reject active content', async ({ page, request }) => {
  const runId = randomUUID()
  const notePath = `inbox/svg-manager-${runId}`
  const safePath = `attachments/images/${runId}.svg`
  const unsafePath = `attachments/images/manual-${runId}.svg`
  const createdPaths: string[] = []
  const vaultRoot = process.env.NUVYN_DRAFT_E2E_VAULT
  if (!vaultRoot) throw new Error('NUVYN_DRAFT_E2E_VAULT is required for Note image E2E')

  try {
    await createDoc(request, notePath, `# SVG Manager Reference\n\n![Vector](@/${safePath})\n`, createdPaths)
    await fs.mkdir(path.dirname(path.join(vaultRoot, safePath)), { recursive: true })
    await fs.writeFile(path.join(vaultRoot, safePath), SVG)
    await fs.writeFile(path.join(vaultRoot, unsafePath), '<svg xmlns="http://www.w3.org/2000/svg"><script>window.__nuvynSvgExecuted=true</script><rect width="10" height="10"/></svg>')
    await request.post('/api/attachments/refresh')
    await request.post('/api/attachments/references/refresh')

    await gotoVaultReady(page)
    await openDoc(page, notePath)
    await page.locator('[data-testid="account-button"]').click()
    await page.locator('[data-testid="account-settings"]').click()
    const settings = page.locator('.settings-modal')
    await settings.getByRole('button', { name: /存储与附件|Storage & attachments/ }).click()
    await expect(settings.locator('#attachment-manager-title')).toBeVisible()
    await settings.locator('.attachment-toolbar input').fill(path.posix.basename(safePath))
    const resource = settings.locator('.attachment-resource-row').filter({ hasText: safePath })
    await expect(resource).toBeVisible()
    await resource.click()
    await expect(settings.locator('.attachment-detail-panel')).toContainText(safePath)
    await expect(settings.locator('.attachment-reference-row').filter({ hasText: 'SVG Manager Reference' })).toBeVisible()

    const directPage = await page.context().newPage()
    await directPage.addInitScript(() => { (window as Window & { __nuvynSvgExecuted?: boolean }).__nuvynSvgExecuted = false })
    const unsafeResponse = await directPage.goto(`/api/markdown-resources?kind=image&path=${encodeURIComponent(unsafePath)}`)
    expect(unsafeResponse?.status()).toBe(415)
    await expect(directPage.locator('body')).toContainText('resource-invalid-svg')
    expect(await directPage.evaluate(() => (window as Window & { __nuvynSvgExecuted?: boolean }).__nuvynSvgExecuted)).toBe(false)
    await directPage.close()
  } finally {
    for (const createdPath of createdPaths) await request.delete(`/api/posts/${createdPath}`).catch(() => {})
    for (const relativePath of [safePath, unsafePath]) {
      await fs.rm(path.join(vaultRoot, ...relativePath.split('/')), { force: true })
    }
    await request.post('/api/attachments/refresh').catch(() => {})
    await request.post('/api/attachments/references/refresh').catch(() => {})
  }
})

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
    await openNoteImagePickerFromContextMenu(page)
    const picker = page.locator('.attachment-picker-modal')
    await expect(picker).toBeVisible()
    await picker.getByRole('button', { name: /上传新图片|Upload (?:a )?new image/ }).click()
    const fileChooser = await fileChooserPromise
    await fileChooser.setFiles({ name: 'Architecture Screenshot.png', mimeType: 'image/png', buffer: PNG })
    const uploadResponse = await uploadResponsePromise
    expect(uploadResponse.status(), await uploadResponse.text()).toBe(201)

    const markdown = /!\[Architecture\s+Screenshot\]\(@\/attachments\/images\/[0-9a-f-]{36}\.png\)/iu
    await expect(editor.locator('.view-lines')).toContainText(markdown)
    const insertedRaw = await waitForSavedRaw(request, notePath, 'Architecture Screenshot')
    expect(insertedRaw).toMatch(/^# Image insertion\n/)
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
