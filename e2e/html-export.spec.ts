import { randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from './fixtures/auth'
import { createDoc, gotoVaultReady, openDoc } from './helpers/edit-program'
import { chooseDocumentExport } from './helpers/document-export'
import type { Page } from '@playwright/test'

async function openMenu(page: Page, path: string) {
  const row = page.locator(`[data-tree-key="file:${path}"]`)
  if (!await row.isVisible()) await page.locator('[data-tree-key="folder:inbox"] > .row-line .chevron').click()
  await expect(row).toBeVisible()
  await row.locator(':scope > .row-line').click({ button: 'right' })
}

test('downloads self-contained HTML and reads the actual file offline at desktop, tablet and phone widths', async ({ page, request, browser, browserName }, info) => {
  const generationNetwork: string[] = []
  const imageReads: string[] = []
  page.on('request', (req) => { if (/^https?:/u.test(req.url()) && !req.url().startsWith(process.env.NUVYN_PUBLIC_ORIGIN! + '/')) generationNetwork.push(req.url()) })
  page.on('request', (req) => { const url = new URL(req.url()); if (url.pathname === '/api/markdown-resources' && url.searchParams.get('kind') === 'image') imageReads.push(url.searchParams.get('path') ?? '') })
  const path = `inbox/html-export-${randomUUID().slice(0,8)}`
  const includePath = `${path}-included`
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='
  const pngUpload = await request.post('/api/note/images', { headers: { Origin: process.env.NUVYN_PUBLIC_ORIGIN! }, multipart: { image: { name: 'original.png', mimeType: 'image/png', buffer: Buffer.from(png.split(',')[1], 'base64') } } })
  expect(pngUpload.status()).toBe(201)
  const pngResource = await pngUpload.json()
  const svgUpload = await request.post('/api/note/images', { headers: { Origin: process.env.NUVYN_PUBLIC_ORIGIN! }, multipart: { image: { name: 'original.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" rx="12" fill="#6270AC"/><text x="20" y="70" fill="white" font-size="24">Original SVG</text></svg>') } } })
  expect(svgUpload.status()).toBe(201)
  const svgResource = await svgUpload.json()
  const boardResponse = await request.post('/api/board', { data: { title: 'Offline Board' } })
  expect(boardResponse.status()).toBe(201)
  const boardId = (await boardResponse.json()).metadata.id
  const sceneSave = await request.put(`/api/board/${boardId}/scene`, { data: {
    engine: 'excalidraw', sceneVersion: 1, expectedRevision: 0,
    scene: { engineData: { elements: [{ id: 'offline-box', type: 'rectangle', x: 0, y: 0, width: 200, height: 100, angle: 0, strokeColor: '#1e1e1e', backgroundColor: '#a5d8ff', fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false }], fileMap: {} }, persistentAppState: {}, assetRefs: [] },
  } })
  expect(sceneSave.status()).toBe(200)
  await createDoc(request, includePath, `Included text\n\n![Included PNG](${pngResource.markdownUrl})`, [])
  const snippetName = `${path.split('/').pop()}-snippet.ts`
  const snippet = join(process.env.NUVYN_DRAFT_E2E_VAULT!, 'inbox', snippetName)
  await mkdir(join(process.env.NUVYN_DRAFT_E2E_VAULT!, 'inbox'), { recursive: true })
  await writeFile(snippet, 'const offlineSnippet = 123\n')
  const raw = [
    '---', 'title: Offline 中文', '---', '',
    '## Local target', '', '[Jump](#local-target)', '', '[[Other Note]]', '',
    ':::: flex direction=row wrap=nowrap', '', `![A](${svgResource.markdownUrl})`, '', '::: flex direction=column grow=1 basis=50%', '', 'Text beside image', '', ':::', '', '::::', '',
    '::: flex direction=row mobile=preserve', '', 'Preserved left', '', 'Preserved right', '', ':::', '',
    '> [!NOTE]', '> Offline callout', '',
    '::: details All code', 'Complete details', ':::', '',
    '```ts :line-numbers', 'const answer = 42', '```', '', '$E=mc^2$', '',
    '::: code-group', '```ts [first.ts]', 'const firstPanel = 1', '```', '```js [second.js]', 'const secondPanel = 2', '```', ':::', '',
    `<!--@include: ./${includePath.split('/').pop()}.md-->`, '', `<<< ./${snippetName}`, '', `![Offline Board](board:${boardId})`, '',
    `![Repeated PNG](${pngResource.markdownUrl})`, '',
    '```mermaid', 'flowchart LR', '  A[Start] --> B[Finish]', '```', '',
    '```markmap', '# Map root', '## Child A $a^2$', '## Child B', '```', '',
    '| Left | Right |', '| --- | --- |', '| Table | Content |', '',
    'Footnote[^one]', '', '[^one]: Offline footnote', '',
  ].join('\n')
  await createDoc(request, path, raw, [])
  try {
    await gotoVaultReady(page)
    await page.evaluate(async () => { (await import('/src/composables/useTheme.ts')).useTheme().set('dark') })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await openMenu(page, path)
    const pending = page.waitForEvent('download')
    await chooseDocumentExport(page, 'html')
    const download = await Promise.race([
      pending,
      page.getByText(/Document export failed|文档导出失败/u).waitFor().then(() => { throw new Error('HTML export failed before download') }),
    ])
    expect(download.suggestedFilename()).toBe(path.split('/').pop() + '.html')
    const file = info.outputPath('offline.html')
    await download.saveAs(file)
    expect(generationNetwork).toEqual([])
    expect(imageReads.filter((resource) => resource === pngResource.path)).toHaveLength(1)
    const html = await readFile(file, 'utf8')
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).not.toContain('/api/')
    expect(html).not.toContain('<script')
    expect(html).toContain('data:font/woff2;base64,')
    // WebKit's transport-level offline emulation rejects even file:// with
    // an internal navigation error (independently reproduced). Block every
    // HTTP(S) request there; Chromium additionally uses the offline flag.
    const offline = await browser.newContext({ offline: browserName !== 'webkit' })
    const errors: string[] = []
    const requests: string[] = []
    await offline.route(/^https?:\/\//u, (route) => { requests.push(route.request().url()); return route.abort() })
    const reader = await offline.newPage()
    reader.on('pageerror', (error) => errors.push(error.message))
    for (const width of [1440,768,375]) {
      await reader.setViewportSize({ width, height: 900 })
      await reader.goto(pathToFileURL(file).href)
      await expect(reader.locator('html')).toHaveAttribute('data-theme', 'light')
      expect(await reader.locator('body').evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgb(255, 255, 255)')
      await expect(reader.locator('h1')).toHaveText('Offline 中文')
      await expect(reader.locator('img')).toHaveCount(4)
      expect(await reader.locator('img[alt="Included PNG"]').getAttribute('src')).toBe(png)
      expect(await reader.locator('img').evaluateAll((images: HTMLImageElement[]) => images.every((image) => image.complete && image.naturalWidth > 0))).toBe(true)
      await expect(reader.locator('.board-embed img')).toBeVisible()
      await expect(reader.locator('article')).toContainText('Included text')
      await expect(reader.locator('article')).toContainText('offlineSnippet')
      await expect(reader.locator('article')).toContainText('firstPanel')
      await expect(reader.locator('article')).toContainText('secondPanel')
      await expect(reader.locator('.nuvyn-code-group [role="tabpanel"]')).toHaveCount(2)
      for (const panel of await reader.locator('.nuvyn-code-group [role="tabpanel"]').all()) await expect(panel).toBeVisible()
      await expect(reader.locator('.html-diagram svg')).toHaveCount(2)
      for (const svg of await reader.locator('.html-diagram svg').all()) {
        const box = await svg.boundingBox()
        expect(box!.width).toBeGreaterThan(100)
        expect(box!.height).toBeGreaterThan(30)
      }
      await expect(reader.locator('.katex')).toHaveCount(1)
      await expect(reader.locator('.html-diagram foreignObject math')).toHaveCount(1)
      await expect(reader.locator('.html-diagram .katex-html')).toHaveCount(0)
      expect(await reader.evaluate(async () => { await document.fonts.ready; return document.fonts.check('16px KaTeX_Main') })).toBe(true)
      const flex = reader.locator('.nuvyn-flex').first()
      expect(await flex.evaluate((element) => getComputedStyle(element).flexDirection)).toBe(width === 375 ? 'column' : 'row')
      expect(await reader.locator('.nuvyn-flex-mobile-preserve').evaluate((element) => getComputedStyle(element).flexDirection)).toBe('row')
      expect(await reader.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await expect(reader.locator('.footnotes')).toContainText('Offline footnote')
      await reader.screenshot({ path: info.outputPath(`offline-${width}.png`), fullPage: true })
    }
    expect(requests).toEqual([])
    expect(errors).toEqual([])
    await offline.close()
    await expect(page.locator('.html-export-surface')).toHaveCount(0)
  } finally {
    await request.delete(`/api/posts/${path}`)
    await request.delete(`/api/posts/${includePath}`)
    await request.delete(`/api/board/${boardId}`)
    await unlink(snippet)
  }
})

test('remote images fail without downloading or fetching and the chooser can retry', async ({ page, request }) => {
  const path = `inbox/html-failure-${randomUUID().slice(0,8)}`
  await createDoc(request, path, '# Fail\n\n![Remote](https://invalid.example/no.png)', [])
  const remote: string[] = []
  await page.route('https://invalid.example/**', (route) => { remote.push(route.request().url()); return route.abort() })
  const downloads: string[] = []
  page.on('download', (download) => downloads.push(download.suggestedFilename()))
  try {
    await gotoVaultReady(page)
    await openMenu(page, path)
    await chooseDocumentExport(page, 'html')
    await expect(page.getByText(/Document export failed|文档导出失败/u)).toBeVisible()
    expect(downloads).toEqual([])
    expect(remote).toEqual([])
    await expect(page.locator('.html-export-surface')).toHaveCount(0)
    await expect(page.getByRole('dialog').getByRole('button', { name: /^(Export|导出)$/u })).toBeEnabled()
  } finally { await request.delete(`/api/posts/${path}`) }
})

test('HTML captures the real unsaved Monaco model without saving, switching tabs or rebuilding the model', async ({ page, request }) => {
  const path = `inbox/html-unsaved-${randomUUID().slice(0,8)}`
  const initial = await createDoc(request, path, '# Saved\n\nServer body', [])
  try {
    await page.route(`**/api/posts/${path}`, (route) => route.request().method() === 'PUT' ? route.abort() : route.continue())
    await gotoVaultReady(page)
    await openDoc(page, path)
    await page.locator('.editor-pane .monaco-editor .view-lines').click({ position: { x: 40, y: 12 } })
    await page.keyboard.press('Enter')
    await page.keyboard.insertText('HTML_UNSAVED_SENTINEL')
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('HTML_UNSAVED_SENTINEL')
    const version = await page.evaluate(async (target) => {
      const { getMarkdownModel } = await import('/src/components/vault/monacoModelRegistry.ts')
      return (getMarkdownModel(target) as { getVersionId(): number }).getVersionId()
    }, path)
    const url = page.url()
    await openMenu(page, path)
    const pending = page.waitForEvent('download')
    await chooseDocumentExport(page, 'html')
    expect(await readFile((await (await pending).path())!, 'utf8')).toContain('HTML_UNSAVED_SENTINEL')
    expect((await (await request.get(`/api/posts/${path}`)).json()).raw).toBe(initial.raw)
    expect(page.url()).toBe(url)
    await expect(page.locator(`[data-tab-id="${path}"] .tab-dirty-indicator`)).toBeVisible()
    expect(await page.evaluate(async (target) => {
      const { getMarkdownModel } = await import('/src/components/vault/monacoModelRegistry.ts')
      return (getMarkdownModel(target) as { getVersionId(): number }).getVersionId()
    }, path)).toBe(version)
  } finally { await request.delete(`/api/posts/${path}`) }
})

for (const failure of ['403', '404', '500', 'unsafe-svg', 'timeout', 'unmount', 'auth'] as const) {
  test(`HTML blocks incomplete output and cleans its surface: ${failure}`, async ({ page, request }) => {
    const path = `inbox/html-resource-${randomUUID().slice(0,8)}`
    await createDoc(request, path, '# Failure\n\n![Missing](@/attachments/images/offline-e2e.svg)', [])
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const requests: string[] = []
    const downloads: string[] = []
    page.on('download', (download) => downloads.push(download.suggestedFilename()))
    await page.route('**/api/markdown-resources?*', async (route) => {
      if (!route.request().url().includes('offline-e2e.svg')) { await route.continue(); return }
      requests.push(route.request().url())
      if (failure === 'timeout' || failure === 'unmount' || failure === 'auth') await gate
      await route.fulfill({ status: /^\d/u.test(failure) ? Number(failure) : 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10"/></svg>' }).catch(() => {})
    })
    try {
      await gotoVaultReady(page)
      if (failure === 'timeout') await page.clock.install()
      await openMenu(page, path)
      await chooseDocumentExport(page, 'html')
      await expect.poll(() => requests.length).toBe(1)
      if (failure === 'timeout') await page.clock.fastForward(15_001)
      if (failure === 'unmount') await page.goto('/ledger')
      if (failure === 'auth') {
        await page.evaluate(async () => {
          const { observeAuthSessionResponse } = await import('/src/lib/auth-session.ts')
          await observeAuthSessionResponse(new Response(JSON.stringify({ code: 'auth-session-required' }), { status: 401, headers: { 'content-type': 'application/json' } }))
        })
        await expect(page).toHaveURL(/\/login/u)
      }
      if (failure !== 'unmount' && failure !== 'auth') {
        await expect(page.getByText(/Document export failed|文档导出失败/u)).toBeVisible()
        await expect(page.getByRole('dialog').getByRole('button', { name: /^(Export|导出)$/u })).toBeEnabled()
      }
      await expect(page.locator('.html-export-surface')).toHaveCount(0)
      expect(downloads).toEqual([])
    } finally { release(); await request.delete(`/api/posts/${path}`) }
  })
}

test('a missing Board fails HTML export rather than silently dropping the preview', async ({ page, request }) => {
  const path = `inbox/html-board-missing-${randomUUID().slice(0,8)}`
  await createDoc(request, path, `# Missing Board\n\n![Missing](board:${randomUUID()})`, [])
  const downloads: string[] = []
  page.on('download', (download) => downloads.push(download.suggestedFilename()))
  try {
    await gotoVaultReady(page)
    await openMenu(page, path)
    await chooseDocumentExport(page, 'html')
    await expect(page.getByText(/Document export failed|文档导出失败/u)).toBeVisible()
    await expect(page.locator('.html-export-surface')).toHaveCount(0)
    expect(downloads).toEqual([])
  } finally { await request.delete(`/api/posts/${path}`) }
})
