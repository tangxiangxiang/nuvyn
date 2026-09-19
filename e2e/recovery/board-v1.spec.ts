import { expect, test } from '../fixtures/auth'
import {
  attachBrowserDiagnostics,
  clearBoardRecovery,
  createBoardThroughUi,
  deleteBoardIfExists,
  drawRectangle,
  getBoard,
  listPendingAssetIds,
  openEditorMenuItem,
  readCheckpoint,
  waitForBoardSaved,
  waitForEditorReady,
  waitForLocalRevision,
  waitForServerRevision,
} from '../helpers/board'

test.setTimeout(60_000)

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
