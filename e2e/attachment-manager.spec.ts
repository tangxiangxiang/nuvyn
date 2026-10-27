import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { expect, test } from './fixtures/auth'

const PREVIEW_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

test('Attachment Manager lists real sources, filters, refreshes, and preserves the open editor', async ({ page, request }) => {
  const runId = randomUUID()
  const notePath = `inbox/attachment-manager-note-${runId}`
  const assetId = randomUUID()
  const boardTitle = `Attachment reference board ${runId.slice(0, 8)}`
  const consumerNotePath = `inbox/attachment-reference-consumer-${runId}`
  const sourceNotePath = `inbox/attachment-reference-source-${runId}`
  const materialName = `Attachment Manager Material ${runId.slice(0, 8)}`
  const initialFileName = `attachment-manager-initial-${runId.slice(0, 8)}.txt`
  const refreshedFileName = `attachment-manager-refreshed-${runId.slice(0, 8)}.txt`
  const diagramFileName = `attachment-manager-diagram-${runId.slice(0, 8)}.png`
  const vaultRoot = process.env.NUVYN_DRAFT_E2E_VAULT
  if (!vaultRoot) throw new Error('NUVYN_DRAFT_E2E_VAULT is required for Attachment Manager E2E')
  const initialFilePath = path.join(vaultRoot, 'inbox', initialFileName)
  const refreshedFilePath = path.join(vaultRoot, 'inbox', refreshedFileName)
  const diagramFilePath = path.join(vaultRoot, 'inbox', diagramFileName)
  let materialId: string | null = null
  let boardId: string | null = null
  let boardCreated = false
  let noteCreated = false
  let consumerNoteCreated = false
  let sourceNoteCreated = false
  let assetCreated = false
  let assetPreviewRequests = 0
  const countAssetPreviewRequests = (requestEvent: import('@playwright/test').Request) => {
    if (new URL(requestEvent.url()).pathname === `/api/assets/${assetId}/preview`) assetPreviewRequests += 1
  }

  try {
    page.on('request', countAssetPreviewRequests)
    const note = await request.post('/api/posts', { data: { path: notePath, title: 'Attachment manager editor state' } })
    expect(note.status(), await note.text()).toBe(201)
    noteCreated = true
    await fs.writeFile(initialFilePath, 'catalog fixture')
    await fs.writeFile(diagramFilePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))

    const consumer = await request.post('/api/posts', { data: { path: consumerNotePath, title: 'Attachment reference consumer' } })
    expect(consumer.status(), await consumer.text()).toBe(201)
    consumerNoteCreated = true
    const source = await request.post('/api/posts', { data: { path: sourceNotePath, title: 'Attachment reference source' } })
    expect(source.status(), await source.text()).toBe(201)
    sourceNoteCreated = true
    const sourceInitial = await (await request.get(`/api/posts/${sourceNotePath}`)).json() as { raw: string }
    const sourceSave = await request.put(`/api/posts/${sourceNotePath}`, {
      data: {
        baseRaw: sourceInitial.raw,
        raw: `${sourceInitial.raw}\n\n![Diagram](./${diagramFileName})`,
      },
    })
    expect(sourceSave.ok(), await sourceSave.text()).toBe(true)
    const consumerInitial = await (await request.get(`/api/posts/${consumerNotePath}`)).json() as { raw: string }
    const consumerSave = await request.put(`/api/posts/${consumerNotePath}`, {
      data: {
        baseRaw: consumerInitial.raw,
        raw: `${consumerInitial.raw}\n\n<!--@include: ./attachment-reference-source-${runId}.md-->`,
      },
    })
    expect(consumerSave.ok(), await consumerSave.text()).toBe(true)

    const asset = await request.put(`/api/assets/${assetId}`, {
      headers: { 'Content-Type': 'image/png' },
      data: PREVIEW_PNG,
    })
    expect(asset.status(), await asset.text()).toBe(200)
    assetCreated = true

    const boardResponse = await request.post('/api/board', { data: { title: boardTitle } })
    expect(boardResponse.status(), await boardResponse.text()).toBe(201)
    boardId = (await boardResponse.json() as { metadata: { id: string } }).metadata.id
    boardCreated = true
    const scene = await request.put(`/api/board/${boardId}/scene`, {
      data: {
        engine: 'excalidraw',
        sceneVersion: 1,
        expectedRevision: 0,
        scene: {
          engineData: {
            elements: [{ id: 'attachment-manager-image', type: 'image', fileId: 'attachment-manager-image-file', isDeleted: false }],
            fileMap: { 'attachment-manager-image-file': assetId },
          },
          persistentAppState: {},
          assetRefs: [assetId],
        },
      },
    })
    expect(scene.status(), await scene.text()).toBe(200)
    const thumbnail = await request.put(`/api/board/${boardId}/thumbnail`, { data: { assetId } })
    expect(thumbnail.status(), await thumbnail.text()).toBe(200)
    const consumerAfterImage = await (await request.get(`/api/posts/${consumerNotePath}`)).json() as { raw: string }
    const consumerBoardSave = await request.put(`/api/posts/${consumerNotePath}`, {
      data: {
        baseRaw: consumerAfterImage.raw,
        raw: `${consumerAfterImage.raw}\n![Board](board:${boardId})`,
      },
    })
    expect(consumerBoardSave.ok(), await consumerBoardSave.text()).toBe(true)

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
    expect(assetPreviewRequests).toBe(0)
    await expect(settings.getByRole('button', { name: /删除|Delete/ })).toHaveCount(0)
    await expect(settings.getByRole('button', { name: /上传图片到 Note 附件库|Upload image to Note library/ })).toBeVisible()

    await settings.locator('.attachment-resource-row').filter({ hasText: initialFileName }).click()
    await expect(settings.locator('.attachment-detail-panel')).toContainText(`inbox/${initialFileName}`)
    await expect(settings.locator('.attachment-detail-panel')).toContainText(/未发现引用|No references found/)
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
    await expect(settings.locator('.attachment-detail-panel img')).toBeVisible()
    await expect.poll(() => settings.locator('.attachment-detail-panel img').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await expect.poll(() => assetPreviewRequests).toBe(1)
    await expect(settings.locator('.attachment-reference-row')).toHaveCount(3)
    const boardSceneReference = settings.locator('.attachment-reference-row').filter({ hasText: /画布资源|canvas asset/ })
    const boardThumbnailReference = settings.locator('.attachment-reference-row').filter({ hasText: /缩略图|thumbnail/ })
    await expect(boardSceneReference).toHaveCount(1)
    await expect(boardSceneReference).toContainText(boardTitle)
    await expect(boardThumbnailReference).toHaveCount(1)
    await expect(boardThumbnailReference).toContainText(boardTitle)
    const embeddedNote = settings.locator('.attachment-reference-row').filter({ hasText: 'Attachment reference consumer' })
    await expect(embeddedNote).toContainText(/Board 嵌入|Board embed/)
    await expect(embeddedNote).toContainText(/间接使用|indirect/)

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

    // Reopen the manager and verify the real Note → local image relationship,
    // its read-only risk report, and navigation through the existing SPA route.
    await page.locator('[data-testid="account-button"]').click()
    await page.locator('[data-testid="account-settings"]').click()
    await page.locator('.settings-modal').getByRole('button', { name: /存储与附件|Storage & attachments/ }).click()
    await expect(settings.locator('#attachment-manager-title')).toBeVisible()
    await settings.locator('.attachment-toolbar input').fill(diagramFileName)
    await expect(settings.locator('.attachment-resource-row')).toHaveCount(1)
    await settings.locator('.attachment-resource-row').click()
    const referenceRow = settings.locator('.attachment-reference-row').filter({ hasText: 'Attachment reference consumer' })
    await expect(referenceRow).toBeVisible()
    await expect(referenceRow).toContainText(/间接|indirect/)
    const sourceLink = settings.locator('.attachment-reference-source').filter({ hasText: 'Attachment reference source' })
    await expect(sourceLink).toBeVisible()
    await settings.getByRole('button', { name: /检查引用风险|Check reference risk/ }).click()
    const riskReport = settings.locator('.attachment-risk-result')
    await expect(riskReport).toContainText(/引用|use/i)
    await expect(riskReport).toContainText(/历史版本未检查|Git history was not checked/)
    await sourceLink.click()
    await expect(settings).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(`/vault/${sourceNotePath}$`))
    await expect(page.locator('.editor-pane .monaco-editor').first()).toBeVisible()

    await page.locator('[data-testid="account-button"]').click()
    await page.locator('[data-testid="account-settings"]').click()
    await page.locator('.settings-modal').getByRole('button', { name: /存储与附件|Storage & attachments/ }).click()
    await expect(settings.locator('#attachment-manager-title')).toBeVisible()
    await settings.locator('.attachment-toolbar input').fill(diagramFileName)
    await expect(settings.locator('.attachment-resource-row')).toHaveCount(1)
    await settings.locator('.attachment-resource-row').click()
    const ownerReference = settings.locator('.attachment-reference-row').filter({ hasText: 'Attachment reference consumer' })
    await ownerReference.click()
    await expect(settings).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(`/vault/${consumerNotePath}$`))
    await expect(page.locator('.editor-pane .monaco-editor').first()).toBeVisible()
  } finally {
    page.off('request', countAssetPreviewRequests)
    if (boardCreated && boardId) await request.delete(`/api/board/${boardId}`).catch(() => {})
    if (materialId) {
      await request.post(`/api/board-materials/${materialId}/archive`).catch(() => {})
      await request.delete(`/api/board-materials/${materialId}`).catch(() => {})
    }
    if (assetCreated) await request.delete(`/api/assets/${assetId}/unreferenced`).catch(() => {})
    if (consumerNoteCreated) await request.delete(`/api/posts/${consumerNotePath}`).catch(() => {})
    if (sourceNoteCreated) await request.delete(`/api/posts/${sourceNotePath}`).catch(() => {})
    if (noteCreated) await request.delete(`/api/posts/${notePath}`).catch(() => {})
    await fs.rm(initialFilePath, { force: true })
    await fs.rm(refreshedFilePath, { force: true })
    await fs.rm(diagramFilePath, { force: true })
    await request.post('/api/attachments/refresh').catch(() => {})
  }
})

test('Attachment Manager remains reachable in desktop, tablet, and short mobile viewports', async ({ page, request }, testInfo) => {
  const geometry: unknown[] = []
  async function recordGeometry(stage: string) {
    const snapshot = await page.evaluate(() => {
      const selectors = ['.vault', '.editor-area', '.monaco-host', '.monaco-editor', '.settings-backdrop', '.settings-modal', '.settings-detail', '.tabs']
      return {
        innerWidth: window.innerWidth, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, scrollX: window.scrollX,
        elements: Object.fromEntries(selectors.map((selector) => {
          const element = document.querySelector<HTMLElement>(selector)
          if (!element) return [selector, null]
          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return [selector, { x: rect.x, y: rect.y, width: rect.width, right: rect.right, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, overflowX: style.overflowX, position: style.position, gridTemplateColumns: style.gridTemplateColumns }]
        })),
      }
    })
    geometry.push({ stage, ...snapshot })
  }
  const runId = randomUUID()
  const notePath = `inbox/attachment-layout-${runId}`
  const filenames = Array.from({ length: 35 }, (_, index) => `attachment-layout-${runId.slice(0, 8)}-${String(index + 1).padStart(2, '0')}.txt`)
  const vaultRoot = process.env.NUVYN_DRAFT_E2E_VAULT
  if (!vaultRoot) throw new Error('NUVYN_DRAFT_E2E_VAULT is required for Attachment Manager E2E')
  const absolutePaths = filenames.map((filename) => path.join(vaultRoot, 'inbox', filename))
  let noteCreated = false

  try {
    const note = await request.post('/api/posts', { data: { path: notePath, title: 'Attachment manager responsive layout' } })
    expect(note.status(), await note.text()).toBe(201)
    noteCreated = true
    await fs.mkdir(path.join(vaultRoot, 'inbox'), { recursive: true })
    await Promise.all(absolutePaths.map((filePath) => fs.writeFile(filePath, 'layout fixture')))
    const refreshed = await request.post('/api/attachments/refresh')
    expect(refreshed.status(), await refreshed.text()).toBe(200)

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/vault/${notePath}`)
    await expect(page.locator('.editor-pane .monaco-editor').first()).toBeVisible()
    await page.locator('[data-testid="account-button"]').click()
    await page.locator('[data-testid="account-settings"]').click()
    const settings = page.locator('.settings-modal')
    await settings.getByRole('button', { name: /存储与附件|Storage & attachments/ }).click()
    await expect(settings.locator('.attachment-resource-row')).toHaveCount(30)

    for (const viewport of [
      { width: 1440, height: 900, label: 'desktop' },
      { width: 768, height: 1024, label: 'tablet' },
      { width: 390, height: 844, label: 'mobile' },
      { width: 375, height: 667, label: 'short mobile' },
      { width: 375, height: 600, label: 'very short mobile' },
    ]) {
      await settings.getByRole('button', { name: /关闭|Close/ }).click()
      await expect(settings).toHaveCount(0)
      await recordGeometry(`${viewport.label}: closed before resize`)
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await recordGeometry(`${viewport.label}: closed after resize`)
      // setViewportSize can resolve before matchMedia's change event updates
      // the Vue layout and Monaco's ResizeObserver. Compare the modal with
      // the settled closed workspace, not the previous tablet presentation.
      if (viewport.width > 600 && viewport.width < 1200) {
        await expect(page.locator('.vault')).toHaveClass(/note-tablet-mode/)
      } else {
        await expect(page.locator('.vault')).not.toHaveClass(/note-tablet-mode/)
      }
      await expect.poll(() => page.locator('.monaco-host').evaluate((host) => {
        const editor = host.querySelector('.monaco-editor')!
        // Monaco's ElementSizeObserver clamps both dimensions to at least 5px.
        return Math.abs(editor.getBoundingClientRect().width - Math.max(5, host.getBoundingClientRect().width))
      })).toBeLessThanOrEqual(1)
      await recordGeometry(`${viewport.label}: closed layout settled`)
      const baselineDocumentOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      await page.locator('[data-testid="account-button"]').click()
      await page.locator('[data-testid="account-settings"]').click()
      await recordGeometry(`${viewport.label}: settings opened`)
      await page.locator('.settings-modal').getByRole('button', { name: /存储与附件|Storage & attachments/ }).click()
      await expect(settings.locator('.attachment-resource-row')).toHaveCount(30)
      await recordGeometry(`${viewport.label}: manager opened`)
      const detailScroller = settings.locator('.settings-detail')
      await detailScroller.evaluate((element) => { element.scrollTop = 0 })

      const topContentLayout = await settings.evaluate((dialog) => {
        const withinViewport = (selector: string) => {
          const element = dialog.querySelector(selector)
          if (!element) return { visible: false, missing: true }
          const rect = element.getBoundingClientRect()
          const bounds = dialog.getBoundingClientRect()
          return {
            visible: rect.top >= Math.max(0, bounds.top)
              && rect.bottom <= Math.min(window.innerHeight, bounds.bottom)
              && rect.left >= Math.max(0, bounds.left)
              && rect.right <= Math.min(window.innerWidth, bounds.right),
            rect: { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left },
            bounds: { top: bounds.top, right: bounds.right, bottom: bounds.bottom, left: bounds.left },
          }
        }
        const selectors = ['#attachment-manager-title', '.attachment-back', '.attachment-refresh', '.attachment-summary', '.attachment-toolbar']
        return Object.fromEntries(selectors.map((selector) => [selector, withinViewport(selector)]))
      })
      expect(Object.values(topContentLayout).every((layout) => layout.visible), `${viewport.label}: title, back, refresh, summary and filters fit in the viewport: ${JSON.stringify(topContentLayout)}`).toBe(true)

      if (viewport.width === 375 && viewport.height === 600) {
        const searchInput = settings.locator('.attachment-toolbar input')
        await searchInput.fill(filenames[0]!)
        await expect(settings.locator('.attachment-resource-row')).toHaveCount(1)
        await searchInput.fill('')
        await expect(settings.locator('.attachment-resource-row')).toHaveCount(30)
        await settings.locator('.attachment-toolbar .n-select').first().click()
        const fileTypeOption = page.getByText(/^(?:文件|File)$/)
        await expect(fileTypeOption).toBeVisible()
        await fileTypeOption.click()
        await expect(settings.locator('.attachment-resource-row')).toHaveCount(30)
      }

      const lastRow = settings.locator('.attachment-resource-row').last()
      await lastRow.scrollIntoViewIfNeeded()
      await expect(lastRow).toBeVisible()
      const lastRowReachable = await lastRow.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return rect.top >= 0 && rect.bottom <= window.innerHeight
      })
      expect(lastRowReachable, `${viewport.label}: last item on the current page can be brought into view`).toBe(true)
      await recordGeometry(`${viewport.label}: list scrolled`)

      const nextPage = settings.getByRole('button', { name: /下一页附件|Next attachment page/ })
      await expect(nextPage).toBeEnabled()
      await nextPage.scrollIntoViewIfNeeded()
      await nextPage.click()
      await expect(settings.locator('.attachment-resource-row')).toHaveCount(5)
      const finalItem = settings.locator('.attachment-resource-row').last()
      await finalItem.scrollIntoViewIfNeeded()
      await finalItem.click()
      const details = settings.locator('.attachment-detail-panel')
      await details.scrollIntoViewIfNeeded()
      await expect(details).toContainText(filenames[34]!)
      await recordGeometry(`${viewport.label}: detail selected`)
      const detailHeading = details.locator('.attachment-detail-heading')
      await detailHeading.scrollIntoViewIfNeeded()
      const detailReachable = await detailHeading.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return rect.top >= 0 && rect.bottom <= window.innerHeight
      })
      expect(detailReachable, `${viewport.label}: selected resource details can be brought into view`).toBe(true)

      const note = settings.locator('.attachment-reference-note')
      await note.scrollIntoViewIfNeeded()
      const noteReachable = await note.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return rect.top >= 0 && rect.bottom <= window.innerHeight
      })
      expect(noteReachable, `${viewport.label}: reference guidance can be brought into view`).toBe(true)

      const layout = await settings.evaluate((dialog) => {
        const detail = dialog.querySelector<HTMLElement>('.settings-detail')!
        const content = dialog.querySelector<HTMLElement>('.attachment-manager-content')!
        const list = dialog.querySelector<HTMLElement>('.attachment-resource-list')!
        return {
          dialogOverflowX: dialog.scrollWidth - dialog.clientWidth,
          detailOverflowX: detail.scrollWidth - detail.clientWidth,
          viewportOverflowX: document.documentElement.scrollWidth - window.innerWidth,
          detailOverflowY: getComputedStyle(detail).overflowY,
          contentOverflowY: getComputedStyle(content).overflowY,
          listOverflowY: getComputedStyle(list).overflowY,
          contentIsInternallyScrollable: content.scrollHeight > content.clientHeight + 1,
          listIsInternallyScrollable: list.scrollHeight > list.clientHeight + 1,
          overflowingElements: Array.from(document.querySelectorAll<HTMLElement>('*'))
            .filter((element) => {
              const rect = element.getBoundingClientRect()
              return rect.width > 0 && (rect.left < -1 || rect.right > window.innerWidth + 1)
            })
            .slice(0, 8)
            .map((element) => ({ tag: element.tagName, id: element.id, className: element.className.toString().slice(0, 80), right: Math.round(element.getBoundingClientRect().right) })),
        }
      })
      expect(layout.dialogOverflowX, `${viewport.label}: no horizontal dialog overflow`).toBeLessThanOrEqual(1)
      expect(layout.detailOverflowX, `${viewport.label}: no horizontal settings content overflow`).toBeLessThanOrEqual(1)
      expect(layout.viewportOverflowX, `${viewport.label}: manager does not add horizontal overflow beyond the closed-workspace baseline (${baselineDocumentOverflow}px); ${JSON.stringify(layout.overflowingElements)}`).toBeLessThanOrEqual(baselineDocumentOverflow + 1)
      if (viewport.width <= 900) {
        expect(layout.detailOverflowY, `${viewport.label}: settings detail owns vertical scrolling`).toBe('auto')
        expect(layout.contentOverflowY, `${viewport.label}: no nested manager scroll region`).toBe('visible')
        expect(layout.listOverflowY, `${viewport.label}: list flows with the page`).toBe('visible')
        expect(layout.contentIsInternallyScrollable, `${viewport.label}: no nested content scroll`).toBe(false)
        expect(layout.listIsInternallyScrollable, `${viewport.label}: no nested list scroll`).toBe(false)
      }

      const previousPage = settings.getByRole('button', { name: /上一页附件|Previous attachment page/ })
      await previousPage.scrollIntoViewIfNeeded()
      await previousPage.click()
      await expect(settings.locator('.attachment-resource-row')).toHaveCount(30)
    }
    await settings.getByRole('button', { name: /关闭|Close/ }).click()
    await expect(settings).toHaveCount(0)
    await recordGeometry('final settings closed')
  } finally {
    await testInfo.attach('attachment-layout-geometry', { body: JSON.stringify(geometry, null, 2), contentType: 'application/json' })
    if (noteCreated) await request.delete(`/api/posts/${notePath}`).catch(() => {})
    await Promise.all(absolutePaths.map((filePath) => fs.rm(filePath, { force: true })))
    await request.post('/api/attachments/refresh').catch(() => {})
  }
})
