import { readFile } from 'node:fs/promises'
import { expect, test } from './fixtures/auth'
import {
  attachBrowserDiagnostics,
  boardCard,
  clearBoardRecovery,
  createBoardThroughUi,
  deleteBoardIfExists,
  drawRectangle,
  getBoard,
  goBackToBoardHome,
  insertImageThroughBrowserDrop,
  listPendingAssetIds,
  openEditorMenuItem,
  openGlobalSearchAndBoard,
  readCheckpoint,
  renameBoardThroughUi,
  uniqueBoardTitle,
  waitForBoardSaved,
  waitForEditorReady,
  waitForLocalRevision,
  waitForServerRevision,
  waitForThumbnail,
} from './helpers/board'

const SMALL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)
const SMALL_SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#6c63ff" /></svg>')

test.setTimeout(60_000)

test('Board V1 exposes the native Excalidraw preference controls', async ({ page, request }) => {
  let boardId = ''
  try {
    await page.goto('/board')
    boardId = await createBoardThroughUi(page)

    await page.getByTestId('main-menu-trigger').click()
    const preferences = page.getByText(/^(偏好设置|Preferences)$/, { exact: true }).last()
    await expect(preferences).toBeVisible()
    await preferences.click()

    const submenu = page.locator('.excalidraw-main-menu-preferences-submenu')
    await expect(submenu).toBeVisible()
    for (const label of [
      /Select on|选择时/, /Wrap|包含/, /Overlap|重叠/, /Tool lock|工具锁/, /Snap to objects|吸附至对象/,
      /Toggle grid|切换网格显示/, /Zen mode|禅模式/, /View mode|查看模式/, /Shape properties|画布与形状属性/,
      /Arrow binding|箭头绑定/, /Snap to midpoints|吸附到中点/,
    ]) {
      await expect(submenu).toContainText(label)
    }
  } finally {
    if (boardId) {
      await clearBoardRecovery(page, boardId).catch(() => {})
      await deleteBoardIfExists(request, boardId).catch(() => {})
    }
  }
})

test('Board V1 persists a drawn scene across reload and exposes it in Gallery/Search', async ({ page, request }) => {
  const diagnostics = attachBrowserDiagnostics(page)
  let boardId = ''
  try {
    await page.goto('/board')
    await expect(page.getByTestId('board-home')).toBeVisible()
    await expect(page.locator('text=FileTree')).toHaveCount(0)

    boardId = await createBoardThroughUi(page)
    const initial = await getBoard(request, boardId)
    expect(initial.sceneRecord).toMatchObject({
      boardId,
      engine: 'excalidraw',
      sceneVersion: 1,
      revision: 0,
      scene: {
        engineData: { elements: [], fileMap: {} },
        persistentAppState: {},
        assetRefs: [],
      },
    })

    await drawRectangle(page)
    const localRevision = await waitForLocalRevision(page, 1)
    expect(localRevision).toBeGreaterThan(0)
    await waitForBoardSaved(page)
    const saved = await waitForServerRevision(request, boardId, initial.sceneRecord.revision + 1)
    const savedElements = (saved.sceneRecord.scene.engineData as { elements: Array<Record<string, unknown>> }).elements
    expect(savedElements.length).toBeGreaterThan(0)
    expect(savedElements).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'rectangle', isDeleted: false }),
    ]))
    const sceneUpdatedAt = saved.metadata.updatedAt

    const thumbnailed = await waitForThumbnail(request, boardId)
    const thumbnailAssetId = thumbnailed.metadata.thumbnailAssetId
    expect(thumbnailAssetId).toEqual(expect.any(String))
    const thumbnailResponse = await request.get(`/api/assets/${thumbnailAssetId}`)
    expect(thumbnailResponse.status()).toBe(200)
    expect(thumbnailResponse.headers()['content-type']).toContain('image/png')
    expect((await thumbnailResponse.body()).byteLength).toBeGreaterThan(0)
    const afterThumbnail = await getBoard(request, boardId)
    expect(afterThumbnail.metadata.updatedAt).toBe(sceneUpdatedAt)

    await page.reload()
    await waitForEditorReady(page)
    await expect(page.getByTestId('board-editor-recovery')).toHaveCount(0)
    await expect(page.getByTestId('board-editor-error')).toHaveCount(0)
    const restored = await getBoard(request, boardId)
    expect(restored.sceneRecord.scene.engineData.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'rectangle', isDeleted: false }),
    ]))

    await goBackToBoardHome(page)
    const galleryCard = boardCard(page, boardId)
    const thumbnail = galleryCard.locator('img')
    await expect(thumbnail).toHaveCount(1)
    await expect.poll(async () => await thumbnail.evaluate((image) => image.complete && image.naturalWidth > 0))
      .toBe(true)

    const renamedTitle = uniqueBoardTitle('Lifecycle')
    await renameBoardThroughUi(page, boardId, renamedTitle)
    expect((await getBoard(request, boardId)).metadata.title).toBe(renamedTitle)

    let boardListRequests = 0
    const onBoardListRequest = (requestEvent: import('@playwright/test').Request) => {
      if (requestEvent.method() === 'GET' && new URL(requestEvent.url()).pathname === '/api/board') boardListRequests += 1
    }
    page.on('request', onBoardListRequest)
    await openGlobalSearchAndBoard(page, renamedTitle, boardId)
    page.off('request', onBoardListRequest)
    expect(boardListRequests).toBeLessThanOrEqual(1)
    await expect(page.getByTestId('board-editor-status')).toHaveAttribute('data-status', 'ready')
    expect(diagnostics.pageErrors).toEqual([])
    expect(diagnostics.serverErrors).toEqual([])
  } finally {
    if (boardId) {
      await clearBoardRecovery(page, boardId).catch(() => {})
      await deleteBoardIfExists(request, boardId).catch(() => {})
    }
  }
})

test('Board V1 persists image assets and exports the restored runtime', async ({ page, request }) => {
  const diagnostics = attachBrowserDiagnostics(page)
  let boardId = ''
  try {
    await page.goto('/board')
    boardId = await createBoardThroughUi(page)
    await insertImageThroughBrowserDrop(page, SMALL_PNG)

    await waitForLocalRevision(page, 1)
    await page.waitForTimeout(500)
    expect(await page.locator('.n-message').filter({ hasText: /图片无法保存到本地恢复缓存|local recovery cache/ }).count()).toBe(0)
    const saved = await waitForServerRevision(request, boardId, 1)
    await waitForBoardSaved(page)
    const engineData = saved.sceneRecord.scene.engineData as { elements: Array<Record<string, unknown>>; fileMap: Record<string, string> }
    const image = engineData.elements.find((element) => element.type === 'image' && element.isDeleted !== true)
    expect(image).toBeTruthy()
    const assetIds = [...new Set(Object.values(engineData.fileMap))]
    expect(assetIds.length).toBeGreaterThan(0)
    expect(saved.sceneRecord.scene.assetRefs).toEqual(assetIds)
    expect(Object.keys(engineData.fileMap)).toContain(image!.fileId)
    for (const assetId of assetIds) {
      const assetResponse = await request.get(`/api/assets/${assetId}`)
      expect(assetResponse.status()).toBe(200)
      expect(assetResponse.headers()['content-type']).toContain('image/')
      expect((await assetResponse.body()).byteLength).toBeGreaterThan(0)
    }
    await expect.poll(() => listPendingAssetIds(page, boardId), { timeout: 15_000 }).toEqual([])

    const assetId = assetIds[0]
    const assetResponsePromise = page.waitForResponse((response) => (
      new URL(response.url()).pathname === `/api/assets/${assetId}`
      && response.request().method() === 'GET'
      && response.status() === 200
    ))
    await page.reload()
    const restoredAssetResponse = await assetResponsePromise
    expect(restoredAssetResponse.status()).toBe(200)
    await waitForEditorReady(page)
    expect((await getBoard(request, boardId)).sceneRecord.scene.assetRefs).toContain(assetId)
    await expect(page.locator('[data-board-excalidraw-root] .excalidraw')).toBeVisible()

    await goBackToBoardHome(page)
    const theme = page.locator('.theme-toggle')
    if (await page.locator('html').getAttribute('data-theme') !== 'dark') await theme.click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await boardCard(page, boardId).getByRole('button', { name: /打开 Board|Open Board/ }).click()
    await waitForEditorReady(page)
    await expect(page.locator('[data-board-excalidraw-root] .excalidraw.theme--dark')).toBeVisible()

    const beforeExport = await getBoard(request, boardId)
    const localRevisionBeforeExport = await page.getByTestId('board-local-revision').getAttribute('data-local-revision')
    const persistenceRequests: string[] = []
    const onPersistenceRequest = (requestEvent: import('@playwright/test').Request) => {
      const pathname = new URL(requestEvent.url()).pathname
      if (requestEvent.method() === 'PUT' && (pathname.endsWith('/scene') || pathname.endsWith('/thumbnail') || pathname.includes('/api/assets/'))) {
        persistenceRequests.push(`${requestEvent.method()} ${pathname}`)
      }
    }
    page.on('request', onPersistenceRequest)

    const pngDownloadPromise = page.waitForEvent('download')
    await openEditorMenuItem(page, /导出 PNG|Export PNG/)
    const pngDownload = await pngDownloadPromise
    expect(pngDownload.suggestedFilename()).toBe('Untitled Board.png')
    const pngPath = await pngDownload.path()
    expect(pngPath).toBeTruthy()
    expect((await readFile(pngPath!)).byteLength).toBeGreaterThan(0)

    const svgDownloadPromise = page.waitForEvent('download')
    await openEditorMenuItem(page, /导出 SVG|Export SVG/)
    const svgDownload = await svgDownloadPromise
    expect(svgDownload.suggestedFilename()).toBe('Untitled Board.svg')
    const svgPath = await svgDownload.path()
    expect(svgPath).toBeTruthy()
    const svg = (await readFile(svgPath!, 'utf8')).trim()
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('<image')
    page.off('request', onPersistenceRequest)
    expect(persistenceRequests).toEqual([])
    const afterExport = await getBoard(request, boardId)
    expect(afterExport.sceneRecord.revision).toBe(beforeExport.sceneRecord.revision)
    expect(await page.getByTestId('board-local-revision').getAttribute('data-local-revision')).toBe(localRevisionBeforeExport)
    expect(diagnostics.pageErrors).toEqual([])
    expect(diagnostics.serverErrors).toEqual([])
  } finally {
    if (boardId) {
      await clearBoardRecovery(page, boardId).catch(() => {})
      await deleteBoardIfExists(request, boardId).catch(() => {})
    }
  }
})

test('Board V1 persists and reloads an SVG asset without rasterizing it', async ({ page, request }) => {
  const diagnostics = attachBrowserDiagnostics(page)
  let boardId = ''
  try {
    await page.goto('/board')
    boardId = await createBoardThroughUi(page)
    await insertImageThroughBrowserDrop(page, SMALL_SVG, 'image/svg+xml', 'board-b9.svg')

    await waitForLocalRevision(page, 1)
    const saved = await waitForServerRevision(request, boardId, 1)
    await waitForBoardSaved(page)
    const engineData = saved.sceneRecord.scene.engineData as { elements: Array<Record<string, unknown>>; fileMap: Record<string, string> }
    const image = engineData.elements.find((element) => element.type === 'image' && element.isDeleted !== true)
    expect(image).toBeTruthy()
    const assetIds = [...new Set(Object.values(engineData.fileMap))]
    expect(assetIds).toHaveLength(1)
    expect(saved.sceneRecord.scene.assetRefs).toEqual(assetIds)

    const assetResponse = await request.get(`/api/assets/${assetIds[0]}`)
    expect(assetResponse.status()).toBe(200)
    expect(assetResponse.headers()['content-type']).toBe('image/svg+xml')
    const storedSvg = (await assetResponse.body()).toString('utf8')
    expect(storedSvg).toContain('<svg')
    expect(storedSvg).toContain('<rect')
    expect(storedSvg).not.toContain('\x89PNG')

    const assetResponsePromise = page.waitForResponse((response) => (
      new URL(response.url()).pathname === `/api/assets/${assetIds[0]}`
      && response.request().method() === 'GET'
      && response.status() === 200
    ))
    await page.reload()
    await assetResponsePromise
    await waitForEditorReady(page)
    await expect(page.locator('[data-board-excalidraw-root] .excalidraw')).toBeVisible()

    const svgDownloadPromise = page.waitForEvent('download')
    await openEditorMenuItem(page, /导出 SVG|Export SVG/)
    const svgDownload = await svgDownloadPromise
    const svgPath = await svgDownload.path()
    expect(svgPath).toBeTruthy()
    const exportedSvg = (await readFile(svgPath!, 'utf8')).trim()
    expect(exportedSvg.startsWith('<svg')).toBe(true)
    expect(exportedSvg).toContain('<image')
    expect(diagnostics.pageErrors).toEqual([])
    expect(diagnostics.serverErrors).toEqual([])
  } finally {
    if (boardId) {
      await clearBoardRecovery(page, boardId).catch(() => {})
      await deleteBoardIfExists(request, boardId).catch(() => {})
    }
  }
})

test('Board V1 material insertion owns an independent SVG Asset lifecycle', async ({ page, request }) => {
  const diagnostics = attachBrowserDiagnostics(page)
  let boardId = ''
  let materialId = ''
  try {
    await page.goto('/board')
    boardId = await createBoardThroughUi(page)

    await openEditorMenuItem(page, /我的素材|My materials/)
    const panel = page.getByTestId('board-material-panel')
    await expect(panel).toBeVisible()
    await panel.getByRole('button', { name: /添加素材|Add material/ }).click()

    const modal = page.getByRole('dialog', { name: /添加 SVG 素材|Add SVG material/ })
    await expect(modal).toBeVisible()
    await modal.locator('input[type="file"]').setInputFiles({
      name: 'mysql.svg',
      mimeType: 'image/svg+xml',
      buffer: SMALL_SVG,
    })
    const materialName = `MySQL ${Date.now()}`
    await modal.locator('input[type="text"]').fill(materialName)
    await modal.getByRole('button', { name: /上传素材|Upload material/ }).click()
    await expect(modal).toBeHidden()

    const materialCard = panel.locator('.board-material-card').filter({ hasText: materialName })
    await expect(materialCard).toBeVisible()
    await materialCard.locator('.board-material-card-open').click()
    await expect(panel).toBeHidden()

    await waitForLocalRevision(page, 1)
    await waitForBoardSaved(page)
    const saved = await waitForServerRevision(request, boardId, 1)
    const engineData = saved.sceneRecord.scene.engineData as { elements: Array<Record<string, unknown>>; fileMap: Record<string, string> }
    const image = engineData.elements.find((element) => element.type === 'image' && element.isDeleted !== true)
    expect(image).toBeTruthy()
    const assetId = image?.fileId && typeof image.fileId === 'string' ? engineData.fileMap[image.fileId] : undefined
    expect(assetId).toBeTruthy()
    if (!assetId) throw new Error('Material insertion did not persist a Board Asset reference')
    expect(saved.sceneRecord.scene.assetRefs).toContain(assetId)

    const materialsResponse = await request.get('/api/board-materials')
    expect(materialsResponse.status()).toBe(200)
    const materials = await materialsResponse.json() as Array<{ id: string; name: string }>
    materialId = materials.find((material) => material.name === materialName)?.id ?? ''
    expect(materialId).toMatch(/^[0-9a-f-]{36}$/)

    const persistedSceneJson = JSON.stringify(saved.sceneRecord.scene)
    expect(persistedSceneJson).not.toContain(materialId)
    expect(persistedSceneJson).not.toMatch(/materialId|boardMaterialId|sourceMaterialId/)

    const assetResponse = await request.get(`/api/assets/${assetId}`)
    expect(assetResponse.status()).toBe(200)
    expect(assetResponse.headers()['content-type']).toBe('image/svg+xml')
    const storedSvg = (await assetResponse.body()).toString('utf8')
    expect(storedSvg).toContain('<svg')
    expect(storedSvg).toContain('<rect')
    expect(storedSvg).not.toContain('\x89PNG')

    const archive = await request.post(`/api/board-materials/${encodeURIComponent(materialId)}/archive`)
    expect(archive.status()).toBe(200)
    const deleted = await request.delete(`/api/board-materials/${encodeURIComponent(materialId)}`)
    expect(deleted.status()).toBe(204)

    const assetResponsePromise = page.waitForResponse((response) => (
      new URL(response.url()).pathname === `/api/assets/${assetId}`
      && response.request().method() === 'GET'
      && response.status() === 200
    ))
    await page.reload()
    await assetResponsePromise
    await waitForEditorReady(page)
    const restored = await getBoard(request, boardId)
    expect(restored.sceneRecord.scene.engineData.elements)
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image', fileId: image?.fileId })]))
    expect(restored.sceneRecord.scene.assetRefs).toContain(assetId)
    expect((await request.get(`/api/assets/${assetId}`)).headers()['content-type']).toBe('image/svg+xml')
    expect(diagnostics.pageErrors).toEqual([])
    expect(diagnostics.serverErrors).toEqual([])
  } finally {
    if (materialId) {
      await request.post(`/api/board-materials/${encodeURIComponent(materialId)}/archive`).catch(() => {})
      await request.delete(`/api/board-materials/${encodeURIComponent(materialId)}`).catch(() => {})
    }
    if (boardId) {
      await clearBoardRecovery(page, boardId).catch(() => {})
      await deleteBoardIfExists(request, boardId).catch(() => {})
    }
  }
})

test('Board V1 recovers a durable local checkpoint after an interrupted save', async ({ page, context, request }) => {
  const diagnostics = attachBrowserDiagnostics(page)
  let boardId = ''
  try {
    await page.goto('/board')
    boardId = await createBoardThroughUi(page)
    const initial = await getBoard(request, boardId)
    await page.route('**/api/board/*/scene', async (route) => {
      if (route.request().method() === 'PUT') {
        await route.abort('failed')
        return
      }
      await route.continue()
    })
    await drawRectangle(page)
    const localRevision = await waitForLocalRevision(page, 1)
    await expect.poll(async () => (await readCheckpoint(page, boardId))?.localRevision ?? 0, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(localRevision)
    const checkpoint = await readCheckpoint(page, boardId)
    expect(checkpoint).toMatchObject({ boardId, baseRevision: initial.sceneRecord.revision, localRevision })
    const serverBeforeCrash = await getBoard(request, boardId)
    expect(serverBeforeCrash.sceneRecord.revision).toBe(initial.sceneRecord.revision)
    expect((serverBeforeCrash.sceneRecord.scene.engineData as { elements: unknown[] }).elements).toHaveLength(0)

    await page.close({ runBeforeUnload: false })
    const reopened = await context.newPage()
    const reopenedDiagnostics = attachBrowserDiagnostics(reopened)
    try {
      await reopened.goto(`/board/${boardId}`)
      await expect(reopened.getByTestId('board-editor-recovery')).toBeVisible({ timeout: 30_000 })
      await expect(reopened.getByTestId('excalidraw-host')).toHaveCount(0)
      await reopened.getByRole('button', { name: /恢复本地修改|Recover local changes/ }).click()
      await waitForEditorReady(reopened)
      await waitForLocalRevision(reopened, localRevision)
      await waitForBoardSaved(reopened)
      const recovered = await waitForServerRevision(request, boardId, initial.sceneRecord.revision + 1)
      expect((recovered.sceneRecord.scene.engineData as { elements: Array<Record<string, unknown>> }).elements)
        .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'rectangle', isDeleted: false })]))
      await expect.poll(() => readCheckpoint(reopened, boardId), { timeout: 15_000 }).toBeNull()
      expect(reopenedDiagnostics.pageErrors).toEqual([])
      expect(reopenedDiagnostics.serverErrors).toEqual([])
    } finally {
      await clearBoardRecovery(reopened, boardId).catch(() => {})
      await reopened.close().catch(() => {})
    }
  } finally {
    if (boardId) {
      await clearBoardRecovery(page, boardId).catch(() => {})
      await deleteBoardIfExists(request, boardId).catch(() => {})
    }
    expect(diagnostics.pageErrors).toEqual([])
    expect(diagnostics.serverErrors).toEqual([])
  }
})

test('Board V1 permanently deletes an editor Board without ghost metadata', async ({ page, request }) => {
  const diagnostics = attachBrowserDiagnostics(page)
  let boardId = ''
  try {
    await page.goto('/board')
    boardId = await createBoardThroughUi(page)
    await drawRectangle(page)
    await waitForLocalRevision(page, 1)
    await waitForServerRevision(request, boardId, 1)
    await waitForBoardSaved(page)

    await openEditorMenuItem(page, /删除 Board|Delete board/)
    const dialog = page.getByRole('dialog', { name: /删除.*Board|Delete.*Board/ }).last()
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: /删除|Delete/ }).click()
    await expect(page).toHaveURL(/\/board$/)
    await expect(page.getByTestId('board-home')).toBeVisible()
    await expect(page.locator(`[data-board-id="${boardId}"]`)).toHaveCount(0)
    await page.evaluate(() => new Promise<void>((resolve) => queueMicrotask(resolve)))
    await expect(page.locator(`[data-board-id="${boardId}"]`)).toHaveCount(0)
    const deleted = await request.get(`/api/board/${boardId}`)
    expect(deleted.status()).toBe(404)
    await expect.poll(() => readCheckpoint(page, boardId), { timeout: 10_000 }).toBeNull()
    await expect.poll(() => listPendingAssetIds(page, boardId), { timeout: 10_000 }).toEqual([])
    expect(diagnostics.pageErrors).toEqual([])
    expect(diagnostics.serverErrors).toEqual([])
  } finally {
    if (boardId) {
      await clearBoardRecovery(page, boardId).catch(() => {})
      await deleteBoardIfExists(request, boardId).catch(() => {})
    }
  }
})
