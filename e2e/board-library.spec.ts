import { expect, test } from './fixtures/auth'
import {
  attachBrowserDiagnostics,
  clearBoardRecovery,
  createBoardThroughUi,
  deleteBoardIfExists,
  getBoard,
  goBackToBoardHome,
  waitForEditorReady,
} from './helpers/board'

const BOARD_LIBRARY_DATABASE_NAME = 'nuvyn-board-library'
const BOARD_LIBRARY_STORE_NAME = 'library'
const BOARD_LIBRARY_RECORD_KEY = 'user'

const LIBRARY_FIXTURE_URL_A = 'https://libraries.excalidraw.com/nuvyn-fixture-a.excalidrawlib'
const LIBRARY_FIXTURE_URL_B = 'https://libraries.excalidraw.com/nuvyn-fixture-b.excalidrawlib'

function fixtureLibrary(id: string, name: string, x: number): string {
  return JSON.stringify({
    type: 'excalidrawlib',
    version: 2,
    source: 'Nuvyn E2E fixture',
    libraryItems: [{
      id,
      status: 'published',
      created: 1,
      name,
      elements: [{
        id: `${id}-element`,
        type: 'rectangle',
        x,
        y: 0,
        width: 120,
        height: 80,
        angle: 0,
        strokeColor: '#000000',
        backgroundColor: 'transparent',
        fillStyle: 'solid',
        strokeWidth: 1,
        strokeStyle: 'solid',
        roughness: 1,
        opacity: 100,
        groupIds: [],
        frameId: null,
        roundness: null,
        seed: 1,
        version: 1,
        versionNonce: 1,
        isDeleted: false,
        boundElements: null,
        updated: 1,
        link: null,
        locked: false,
      }],
    }],
  })
}

async function clearBoardLibrary(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(({ databaseName, storeName }) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error(`Could not delete ${storeName}`))
    request.onblocked = () => reject(new Error(`Could not delete ${databaseName}`))
  }), { databaseName: BOARD_LIBRARY_DATABASE_NAME, storeName: BOARD_LIBRARY_STORE_NAME })
}

async function readBoardLibrary(page: import('@playwright/test').Page): Promise<Array<{ id: string }>> {
  return await page.evaluate(({ databaseName, storeName, recordKey }) => new Promise<Array<{ id: string }>>((resolve, reject) => {
    const open = indexedDB.open(databaseName)
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(storeName)) open.result.createObjectStore(storeName, { keyPath: 'key' })
    }
    open.onsuccess = () => {
      const database = open.result
      const transaction = database.transaction(storeName, 'readonly')
      const request = transaction.objectStore(storeName).get(recordKey)
      request.onsuccess = () => {
        const value = request.result as { libraryItems?: Array<{ id: string }> } | undefined
        resolve(value?.libraryItems ?? [])
      }
      request.onerror = () => reject(request.error ?? new Error('Could not read Board Library'))
      transaction.oncomplete = () => database.close()
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not read Board Library'))
    }
    open.onerror = () => reject(open.error ?? new Error('Could not open Board Library'))
  }), {
    databaseName: BOARD_LIBRARY_DATABASE_NAME,
    storeName: BOARD_LIBRARY_STORE_NAME,
    recordKey: BOARD_LIBRARY_RECORD_KEY,
  })
}

async function installFixtureFromHash(page: import('@playwright/test').Page, url: string): Promise<void> {
  await page.evaluate((libraryUrl) => {
    window.location.hash = `addLibrary=${encodeURIComponent(libraryUrl)}`
  }, url)
  await expect(page.locator('[data-testid="library"] .library-unit__active')).toHaveCount(1, { timeout: 20_000 })
  await expect(page).toHaveURL(/\/board\/[^/?#]+$/)
}

test.setTimeout(60_000)

test('Board Library imports install hashes and persists across reloads and Boards', async ({ page, request }) => {
  const diagnostics = attachBrowserDiagnostics(page)
  let boardA = ''
  let boardB = ''
  try {
    await page.goto('/board')
    page.on('dialog', async (dialog) => { await dialog.accept() })
    await clearBoardLibrary(page)
    await page.route(LIBRARY_FIXTURE_URL_A, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: fixtureLibrary('fixture-library-a', 'Nuvyn fixture A', 0),
      })
    })
    await page.route(LIBRARY_FIXTURE_URL_B, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: fixtureLibrary('fixture-library-b', 'Nuvyn fixture B', 180),
      })
    })

    boardA = await createBoardThroughUi(page)
    await installFixtureFromHash(page, LIBRARY_FIXTURE_URL_A)
    await installFixtureFromHash(page, LIBRARY_FIXTURE_URL_A)
    await expect.poll(async () => (await readBoardLibrary(page)).map((item) => item.id)).toEqual(['fixture-library-a'])

    await page.reload()
    await waitForEditorReady(page)
    await expect.poll(async () => (await readBoardLibrary(page)).map((item) => item.id)).toEqual(['fixture-library-a'])

    await goBackToBoardHome(page)
    boardB = await createBoardThroughUi(page)
    await expect.poll(async () => (await readBoardLibrary(page)).map((item) => item.id)).toEqual(['fixture-library-a'])

    // This navigation enters the editor with the install hash already present,
    // covering the initial-mount path in addition to the hashchange path above.
    await page.goto(`/board/${encodeURIComponent(boardB)}#addLibrary=${encodeURIComponent(LIBRARY_FIXTURE_URL_B)}`)
    await waitForEditorReady(page)
    await expect(page.locator('[data-testid="library"] .library-unit__active')).toHaveCount(2, { timeout: 20_000 })
    await expect(page).toHaveURL(/\/board\/[^/?#]+$/)
    await expect.poll(async () => (await readBoardLibrary(page)).map((item) => item.id)).toEqual([
      'fixture-library-b',
      'fixture-library-a',
    ])

    const sceneBeforeManualImport = await getBoard(request, boardB)
    const libraryMenuTrigger = page.locator('[data-testid="library"] .library-menu-items-container .dropdown-menu-button').first()
    await expect(libraryMenuTrigger).toBeVisible()
    await libraryMenuTrigger.click()
    await page.evaluate((fileContents) => {
      Object.defineProperty(window, 'showOpenFilePicker', {
        configurable: true,
        value: async () => [{
          getFile: async () => new File([fileContents], 'nuvyn-fixture-c.excalidrawlib', { type: 'application/json' }),
        }],
      })
    }, fixtureLibrary('fixture-library-c', 'Nuvyn fixture C', 360))
    await page.locator('[data-testid="library"] .library-menu [data-testid="lib-dropdown--load"]').click()
    await expect(page.locator('[data-testid="library"] .library-unit__active')).toHaveCount(3, { timeout: 20_000 })
    await expect.poll(async () => (await readBoardLibrary(page)).map((item) => item.id)).toEqual([
      'fixture-library-c',
      'fixture-library-b',
      'fixture-library-a',
    ])
    const sceneAfterManualImport = await getBoard(request, boardB)
    expect(sceneAfterManualImport.sceneRecord.revision).toBe(sceneBeforeManualImport.sceneRecord.revision)
    expect(sceneAfterManualImport.metadata.updatedAt).toBe(sceneBeforeManualImport.metadata.updatedAt)

    await page.reload()
    await waitForEditorReady(page)
    await expect.poll(async () => (await readBoardLibrary(page)).map((item) => item.id)).toEqual([
      'fixture-library-c',
      'fixture-library-b',
      'fixture-library-a',
    ])
    expect(diagnostics.pageErrors).toEqual([])
    expect(diagnostics.serverErrors).toEqual([])
  } finally {
    if (boardA) {
      await clearBoardRecovery(page, boardA).catch(() => {})
      await deleteBoardIfExists(request, boardA).catch(() => {})
    }
    if (boardB) {
      await clearBoardRecovery(page, boardB).catch(() => {})
      await deleteBoardIfExists(request, boardB).catch(() => {})
    }
    await clearBoardLibrary(page).catch(() => {})
  }
})
