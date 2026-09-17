import { expect, test } from './fixtures/auth'
import { uniqueBoardTitle } from './helpers/board'

test.setTimeout(60_000)

type BoardResponse = {
  metadata: {
    id: string
  }
}

test('Board folders create a scoped home, move canvases, and preserve them on delete', async ({ page, request }) => {
  const folderName = uniqueBoardTitle('Folder')
  const folderBoardTitle = uniqueBoardTitle('Folder canvas')
  const rootBoardTitle = uniqueBoardTitle('Root canvas')
  let folderId = ''
  let folderBoardId = ''
  let rootBoardId = ''

  try {
    await page.goto('/board')
    await expect(page.getByTestId('board-home')).toBeVisible()

    await page.getByRole('button', { name: /新建文件夹|New folder/ }).click()
    const folderDialog = page.getByRole('dialog').last()
    await folderDialog.getByRole('textbox', { name: /文件夹名称|Folder name/ }).fill(folderName)
    await folderDialog.getByRole('button', { name: /创建|Create/ }).click()

    const folderCard = page.locator('.board-folder-card').filter({ hasText: folderName })
    await expect(folderCard).toBeVisible()
    folderId = await folderCard.getAttribute('data-folder-id') ?? ''
    expect(folderId).not.toBe('')

    const folderBoardResponse = await request.post('/api/board', {
      data: { title: folderBoardTitle, folderId },
    })
    expect(folderBoardResponse.status()).toBe(201)
    folderBoardId = (await folderBoardResponse.json() as BoardResponse).metadata.id

    const rootBoardResponse = await request.post('/api/board', {
      data: { title: rootBoardTitle, folderId: null },
    })
    expect(rootBoardResponse.status()).toBe(201)
    rootBoardId = (await rootBoardResponse.json() as BoardResponse).metadata.id

    await page.reload()
    await expect(page.locator(`[data-folder-id="${folderId}"]`)).toBeVisible()
    await page.locator(`[data-folder-id="${folderId}"]`).click()
    await expect(page).toHaveURL(new RegExp(`/board/folder/${folderId}$`))
    await expect(page.getByTestId('board-card-title')).toHaveText(folderBoardTitle)
    await expect(page.getByTestId('board-card-title')).not.toHaveText(rootBoardTitle)

    await page.goto('/board')
    await expect(page.locator(`[data-board-id="${folderBoardId}"]`)).toHaveCount(0)
    const rootCard = page.locator(`[data-board-id="${rootBoardId}"]`)
    await expect(rootCard).toBeVisible()
    await rootCard.getByRole('button', { name: /Board 操作|Board actions/ }).click()
    await page.getByText(/^移动到文件夹$|^Move to folder$/, { exact: true }).last().click()

    const moveDialog = page.getByRole('dialog').last()
    await moveDialog.getByTestId('board-move-select').click()
    await page.locator('.n-base-select-option').filter({ hasText: folderName }).last().click()
    await moveDialog.getByRole('button', { name: /^移动$|^Move$/ }).click()
    await expect(page.locator(`[data-board-id="${rootBoardId}"]`)).toHaveCount(0)

    await page.goto(`/board/folder/${folderId}`)
    await expect(page.getByTestId('board-card-title')).toHaveCount(2)

    await page.goto('/board')
    await page.locator(`[data-folder-id="${folderId}"] .board-folder-menu`).click()
    await page.getByText(/^删除$|^Delete$/, { exact: true }).last().click()
    const confirmation = page.getByRole('dialog').last()
    await expect(confirmation).toBeVisible()
    await confirmation.getByRole('button', { name: /确定|Confirm/ }).click()

    await expect(page.locator(`[data-folder-id="${folderId}"]`)).toHaveCount(0)
    await expect(page.locator(`[data-board-id="${folderBoardId}"]`)).toBeVisible()
    await expect(page.locator(`[data-board-id="${rootBoardId}"]`)).toBeVisible()
  } finally {
    if (folderBoardId) await request.delete(`/api/board/${folderBoardId}`).catch(() => {})
    if (rootBoardId) await request.delete(`/api/board/${rootBoardId}`).catch(() => {})
    if (folderId) await request.delete(`/api/board-folders/${folderId}`).catch(() => {})
  }
})
