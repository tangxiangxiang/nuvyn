import { expect, type APIRequestContext, type Page } from '@playwright/test'
import type { BoardMetadata, BoardSceneRecord } from '../../shared/boardProtocol'

export interface BoardAggregate {
  metadata: BoardMetadata
  sceneRecord: BoardSceneRecord
}

export interface BoardCheckpointSnapshot {
  boardId: string
  sceneVersion: number
  baseRevision: number
  localRevision: number
}

export const BOARD_RECOVERY_DATABASE_NAME = 'nuvyn-board-recovery'

export function uniqueBoardTitle(label: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return `B9 E2E ${label} ${suffix}`
}

export async function getBoard(request: APIRequestContext, boardId: string): Promise<BoardAggregate> {
  const response = await request.get(`/api/board/${encodeURIComponent(boardId)}`)
  if (response.status() !== 200) {
    throw new Error(`GET Board ${boardId} returned ${response.status()}: ${await response.text()}`)
  }
  return await response.json() as BoardAggregate
}

export async function listBoards(request: APIRequestContext): Promise<BoardMetadata[]> {
  const response = await request.get('/api/board')
  if (response.status() !== 200) {
    throw new Error(`GET Board list returned ${response.status()}: ${await response.text()}`)
  }
  return await response.json() as BoardMetadata[]
}

export async function deleteBoardIfExists(request: APIRequestContext, boardId: string): Promise<void> {
  const response = await request.delete(`/api/board/${encodeURIComponent(boardId)}`)
  if (response.status() !== 204 && response.status() !== 404) {
    throw new Error(`DELETE Board ${boardId} returned ${response.status()}: ${await response.text()}`)
  }
}

export async function waitForServerRevision(
  request: APIRequestContext,
  boardId: string,
  minimumRevision: number,
  timeout = 15_000,
): Promise<BoardAggregate> {
  let latest: BoardAggregate | null = null
  await expect.poll(async () => {
    latest = await getBoard(request, boardId)
    return latest.sceneRecord.revision
  }, { timeout }).toBeGreaterThanOrEqual(minimumRevision)
  return latest ?? await getBoard(request, boardId)
}

export async function waitForThumbnail(
  request: APIRequestContext,
  boardId: string,
  timeout = 12_000,
): Promise<BoardAggregate> {
  let latest: BoardAggregate | null = null
  await expect.poll(async () => {
    latest = await getBoard(request, boardId)
    return latest.metadata.thumbnailAssetId
  }, { timeout }).toBeTruthy()
  return latest ?? await getBoard(request, boardId)
}

export async function readCheckpoint(page: Page, boardId: string): Promise<BoardCheckpointSnapshot | null> {
  return await page.evaluate(async ({ databaseName, boardId: id }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(databaseName)
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error ?? new Error('IndexedDB open failed'))
      open.onblocked = () => reject(new Error('IndexedDB open blocked'))
    })
    try {
      return await new Promise<BoardCheckpointSnapshot | null>((resolve, reject) => {
        let value: BoardCheckpointSnapshot | null = null
        let settled = false
        const transaction = database.transaction('checkpoints', 'readonly')
        const request = transaction.objectStore('checkpoints').get(id)
        request.onsuccess = () => { value = (request.result ?? null) as BoardCheckpointSnapshot | null }
        request.onerror = () => {
          if (!settled) {
            settled = true
            reject(request.error ?? new Error('Checkpoint read failed'))
          }
        }
        transaction.oncomplete = () => {
          if (!settled) {
            settled = true
            resolve(value)
          }
        }
        transaction.onerror = () => {
          if (!settled) {
            settled = true
            reject(transaction.error ?? new Error('Checkpoint transaction failed'))
          }
        }
        transaction.onabort = () => {
          if (!settled) {
            settled = true
            reject(transaction.error ?? new Error('Checkpoint transaction aborted'))
          }
        }
      })
    } finally {
      database.close()
    }
  }, { databaseName: BOARD_RECOVERY_DATABASE_NAME, boardId })
}

export async function listPendingAssetIds(page: Page, boardId: string): Promise<string[]> {
  return await page.evaluate(async ({ databaseName, boardId: id }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(databaseName)
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error ?? new Error('IndexedDB open failed'))
      open.onblocked = () => reject(new Error('IndexedDB open blocked'))
    })
    try {
      return await new Promise<string[]>((resolve, reject) => {
        let value: string[] = []
        let settled = false
        const transaction = database.transaction('pending-assets', 'readonly')
        const request = transaction.objectStore('pending-assets').index('boardId').getAll(id)
        request.onsuccess = () => {
          value = (request.result as Array<{ assetId: string }>).map((asset) => asset.assetId)
        }
        request.onerror = () => {
          if (!settled) {
            settled = true
            reject(request.error ?? new Error('Pending asset read failed'))
          }
        }
        transaction.oncomplete = () => {
          if (!settled) {
            settled = true
            resolve(value)
          }
        }
        transaction.onerror = () => {
          if (!settled) {
            settled = true
            reject(transaction.error ?? new Error('Pending asset transaction failed'))
          }
        }
        transaction.onabort = () => {
          if (!settled) {
            settled = true
            reject(transaction.error ?? new Error('Pending asset transaction aborted'))
          }
        }
      })
    } finally {
      database.close()
    }
  }, { databaseName: BOARD_RECOVERY_DATABASE_NAME, boardId })
}

export async function clearBoardRecovery(page: Page, boardId: string): Promise<void> {
  await page.evaluate(async ({ databaseName, boardId: id }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(databaseName)
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error ?? new Error('IndexedDB open failed'))
      open.onblocked = () => reject(new Error('IndexedDB open blocked'))
    })
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const transaction = database.transaction(['checkpoints', 'pending-assets'], 'readwrite')
        transaction.objectStore('checkpoints').delete(id)
        const pendingStore = transaction.objectStore('pending-assets')
        const keysRequest = pendingStore.index('boardId').getAllKeys(id)
        keysRequest.onsuccess = () => {
          for (const key of keysRequest.result) pendingStore.delete(key)
        }
        keysRequest.onerror = () => {
          if (!settled) {
            settled = true
            reject(keysRequest.error ?? new Error('Pending asset cleanup failed'))
          }
        }
        transaction.oncomplete = () => {
          if (!settled) {
            settled = true
            resolve()
          }
        }
        transaction.onerror = () => {
          if (!settled) {
            settled = true
            reject(transaction.error ?? new Error('Recovery cleanup transaction failed'))
          }
        }
        transaction.onabort = () => {
          if (!settled) {
            settled = true
            reject(transaction.error ?? new Error('Recovery cleanup transaction aborted'))
          }
        }
      })
    } finally {
      database.close()
    }
  }, { databaseName: BOARD_RECOVERY_DATABASE_NAME, boardId })
}

export async function waitForEditorReady(page: Page): Promise<void> {
  await expect(page.getByTestId('board-editor')).toBeVisible()
  await expect(page.getByTestId('board-editor-status')).toHaveAttribute('data-status', 'ready', { timeout: 45_000 })
  await expect(page.getByTestId('excalidraw-host')).toBeVisible()
  await expect(page.locator('[data-board-excalidraw-root] .excalidraw')).toBeVisible()
}

export async function waitForBoardSaved(page: Page, timeout = 15_000): Promise<void> {
  await expect(page.getByTestId('board-editor-status')).toHaveAttribute('data-save-status', 'saved', { timeout })
}

export async function createBoardThroughUi(page: Page): Promise<string> {
  await expect(page.getByTestId('board-home')).toBeVisible()
  const createButton = page.getByRole('button', { name: /新建 Board|New Board|创建第一个 Board|Create your first board/ }).first()
  await expect(createButton).toBeVisible()
  await createButton.click()
  await expect(page).toHaveURL(/\/board\/[^/]+$/)
  const match = page.url().match(/\/board\/([^/?#]+)$/)
  if (!match?.[1]) throw new Error(`Could not extract Board ID from ${page.url()}`)
  await waitForEditorReady(page)
  return decodeURIComponent(match[1])
}

export async function drawRectangle(page: Page): Promise<void> {
  const root = page.locator('[data-board-excalidraw-root]')
  await expect(root.getByTestId('toolbar-rectangle')).toBeVisible()
  // The generic-shape trigger and the rectangle option share a test id in
  // Excalidraw. Use the accessible trigger so the helper remains stable
  // across Excalidraw toolbar markup changes.
  await root.getByRole('button', { name: 'Rectangle', exact: true }).first().click()
  const canvas = root.locator('canvas.excalidraw__canvas.interactive')
  await expect(canvas).toBeVisible()
  const box = await canvas.boundingBox()
  if (!box) throw new Error('Excalidraw interactive canvas has no layout box')
  // Selecting a shape opens Excalidraw's style panel on the left. Keep the
  // gesture outside that panel so the pointer sequence reaches the canvas.
  await page.mouse.move(box.x + 220, box.y + 120)
  await page.mouse.down()
  await page.mouse.move(box.x + 460, box.y + 260, { steps: 5 })
  await page.mouse.up()
}

export async function insertImageThroughBrowserDrop(
  page: Page,
  image: Buffer,
  mimeType = 'image/png',
  fileName = 'board-b9.png',
): Promise<void> {
  const root = page.locator('[data-board-excalidraw-root]')
  const canvas = root.locator('canvas.excalidraw__canvas.interactive')
  await expect(canvas).toBeVisible()
  const box = await canvas.boundingBox()
  if (!box) throw new Error('Excalidraw interactive canvas has no layout box')
  await page.evaluate(({ base64, clientX, clientY, mimeType: fileMimeType, fileName: imageFileName }) => {
    const target = document.querySelector<HTMLElement>('[data-board-excalidraw-root] .excalidraw')
    if (!target) throw new Error('Excalidraw drop target is unavailable')
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    const file = new File([bytes], imageFileName, { type: fileMimeType })
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(file)
    const eventInit: DragEventInit = {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      dataTransfer,
    }
    target.dispatchEvent(new DragEvent('dragenter', eventInit))
    target.dispatchEvent(new DragEvent('dragover', eventInit))
    target.dispatchEvent(new DragEvent('drop', eventInit))
  }, {
    base64: image.toString('base64'),
    clientX: box.x + 300,
    clientY: box.y + 230,
    mimeType,
    fileName,
  })
}

export async function waitForLocalRevision(page: Page, minimumRevision: number, timeout = 10_000): Promise<number> {
  const revision = page.getByTestId('board-local-revision')
  await expect.poll(async () => Number(await revision.getAttribute('data-local-revision')), { timeout })
    .toBeGreaterThanOrEqual(minimumRevision)
  return Number(await revision.getAttribute('data-local-revision'))
}

export function boardCard(page: Page, boardId: string) {
  return page.locator(`[data-board-id="${boardId}"]`).first()
}

export async function goBackToBoardHome(page: Page): Promise<void> {
  await openEditorMenuItem(page, /返回 Board|Back to boards/)
  await expect(page).toHaveURL(/\/board$/)
  await expect(page.getByTestId('board-home')).toBeVisible()
}

export async function renameBoardThroughUi(page: Page, boardId: string, title: string): Promise<void> {
  const card = boardCard(page, boardId)
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: /Board 操作|Board actions/ }).click()
  const renameOption = page.getByText(/^(重命名|Rename)$/, { exact: true }).last()
  await expect(renameOption).toBeVisible()
  await renameOption.click()
  const dialog = page.getByRole('dialog').last()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('textbox', { name: /Board 名称|Board title/ }).fill(title)
  await page.getByTestId('board-rename-submit').click()
  await expect(dialog).toBeHidden()
  await expect(boardCard(page, boardId).getByTestId('board-card-title')).toHaveText(title)
}

export async function openGlobalSearchAndBoard(page: Page, title: string, boardId: string): Promise<void> {
  await page.keyboard.press('Control+p')
  const dialog = page.getByRole('dialog', { name: /全局搜索|Global search/ })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('textbox', { name: /搜索全部内容|Search all content/ }).fill(title)
  const result = page.getByRole('option').filter({ hasText: title }).first()
  await expect(result).toBeVisible()
  await result.click()
  await expect(page).toHaveURL(new RegExp(`/board/${boardId}$`))
  await waitForEditorReady(page)
}

export async function openEditorMenuItem(page: Page, name: RegExp): Promise<void> {
  await page.getByTestId('main-menu-trigger').click()
  const item = page.getByText(name).last()
  await expect(item).toBeVisible()
  await item.click()
}

export function attachBrowserDiagnostics(page: Page): { pageErrors: string[]; serverErrors: string[] } {
  const pageErrors: string[] = []
  const serverErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('response', (response) => {
    const pathname = new URL(response.url()).pathname
    if ((pathname.startsWith('/api/board') || pathname.startsWith('/api/assets')) && response.status() >= 500) {
      serverErrors.push(`${response.status()} ${response.request().method()} ${pathname}`)
    }
  })
  return { pageErrors, serverErrors }
}
