import { expect, test } from './fixtures/auth'
import {
  createBoardThroughUi,
  deleteBoardIfExists,
  getBoard,
  goBackToBoardHome,
  waitForBoardSaved,
  waitForEditorReady,
} from './helpers/board'

function savedTextScene(text: string, elementId: string) {
  return {
    engineData: {
      elements: [{
        id: elementId,
        type: 'text',
        text,
        originalText: text,
        isDeleted: false,
      }],
      fileMap: {},
    },
    persistentAppState: {},
    assetRefs: [],
  }
}

async function searchFor(page: import('@playwright/test').Page, query: string) {
  await page.keyboard.press('Control+p')
  const dialog = page.getByRole('dialog', { name: /全局搜索|Global search/ })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('textbox', { name: /搜索全部内容|Search all content/ }).fill(query)
  return { dialog, results: page.getByRole('option') }
}

test('Board global search finds saved text, opens the canvas, and tracks saved revisions', async ({ page, request }) => {
  const title = `B9 E2E body search ${Date.now()}`
  let boardId = ''

  try {
    await page.goto('/board')
    boardId = await createBoardThroughUi(page)
    const renamed = await request.patch(`/api/board/${encodeURIComponent(boardId)}`, { data: { title } })
    expect(renamed.status()).toBe(200)

    const root = page.locator('[data-board-excalidraw-root]')
    await root.getByTestId('toolbar-text').click()
    const canvas = root.locator('canvas.excalidraw__canvas.interactive')
    await canvas.click({ position: { x: 360, y: 220 } })
    const textEditor = root.locator('textarea[data-type="wysiwyg"]')
    await expect(textEditor).toBeVisible()
    await textEditor.fill('死锁的四个必要条件')
    await textEditor.evaluate((element) => (element as HTMLTextAreaElement).blur())
    await waitForBoardSaved(page)
    const savedBoard = await getBoard(request, boardId)
    expect(JSON.stringify(savedBoard.sceneRecord.scene.engineData)).toContain('死锁的四个必要条件')

    await page.goto('/board')

    const firstSearch = await searchFor(page, '死锁')
    const bodyResult = firstSearch.results.filter({ hasText: title })
    await expect(bodyResult).toHaveCount(1)
    await expect(bodyResult).toContainText(/正文|Content/)
    await expect(bodyResult).toContainText('死锁的四个必要条件')
    await expect(bodyResult.locator('.palette-note-highlight')).toHaveText('死锁')
    await expect(bodyResult.locator('.palette-path')).toHaveCount(0)
    await bodyResult.click()
    await expect(page).toHaveURL(new RegExp(`/board/${boardId}$`))
    await waitForEditorReady(page)

    await page.reload()
    await waitForEditorReady(page)
    await goBackToBoardHome(page)
    const repeatSearch = await searchFor(page, '死锁')
    await expect(repeatSearch.results.filter({ hasText: title })).toHaveCount(1)
    await repeatSearch.dialog.getByRole('textbox', { name: /搜索全部内容|Search all content/ }).fill('线程同步')
    await expect(repeatSearch.results).toHaveCount(0)
    await expect(repeatSearch.dialog.locator('.palette-empty')).toContainText(/没有找到相关内容|No matching results/)

    const changed = await request.put(`/api/board/${encodeURIComponent(boardId)}/scene`, {
      data: {
        engine: 'excalidraw',
        sceneVersion: 1,
        expectedRevision: (await getBoard(request, boardId)).sceneRecord.revision,
        scene: savedTextScene('Java 线程同步实践', 'body-search-text-updated'),
      },
    })
    expect(changed.status()).toBe(200)
    await repeatSearch.dialog.getByRole('textbox', { name: /搜索全部内容|Search all content/ }).fill('死锁')
    await expect(repeatSearch.dialog.locator('.palette-empty')).toContainText(/没有找到相关内容|No matching results/)
    await repeatSearch.dialog.getByRole('textbox', { name: /搜索全部内容|Search all content/ }).fill('线程同步')
    await expect(repeatSearch.results.filter({ hasText: title })).toContainText('Java 线程同步实践')

    const removed = await request.delete(`/api/board/${encodeURIComponent(boardId)}`)
    expect(removed.status()).toBe(204)
    await repeatSearch.dialog.getByRole('textbox', { name: /搜索全部内容|Search all content/ }).fill(title)
    await expect(repeatSearch.dialog.locator('.palette-empty')).toContainText(/没有找到相关内容|No matching results/)
  } finally {
    if (boardId) await deleteBoardIfExists(request, boardId)
  }
})
