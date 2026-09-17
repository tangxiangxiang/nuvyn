// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { LibraryItems } from '@excalidraw/excalidraw/types'
import {
  BOARD_LIBRARY_DATABASE_NAME,
  BOARD_LIBRARY_DATABASE_VERSION,
  BOARD_LIBRARY_RECORD_KEY,
  BOARD_LIBRARY_STORE_NAME,
  createMemoryBoardLibraryStore,
} from '../libraryStore'
import {
  boardLibraryPersistenceAdapter,
  createBoardLibraryInstallHashGuard,
  createBoardLibraryPersistenceAdapter,
  currentBoardLibraryReturnUrl,
  persistBoardLibraryItems,
} from '../libraryIntegration'

const libraryItems: LibraryItems = [{
  id: 'library-item-1',
  status: 'published',
  elements: [],
  created: 1,
  name: 'Test library item',
}]

describe('Board Library store', () => {
  it('keeps the official LibraryItems shape across the adapter boundary', async () => {
    const firstStore = createMemoryBoardLibraryStore()
    await firstStore.save(libraryItems)

    // The memory implementation mirrors the IndexedDB adapter contract in
    // unit tests without involving Board Scene state.
    const adapter = createBoardLibraryPersistenceAdapter(firstStore)
    await adapter.save({ libraryItems })
    expect(await adapter.load({ source: 'load' })).toEqual({ libraryItems })
  })

  it('clears the user-level library without a Board ID', async () => {
    const store = createMemoryBoardLibraryStore()
    await store.save(libraryItems)
    await store.clear()
    await expect(store.load()).resolves.toEqual([])
  })

  it('uses a dedicated user-level IndexedDB record contract', () => {
    expect(BOARD_LIBRARY_DATABASE_NAME).toBe('nuvyn-board-library')
    expect(BOARD_LIBRARY_DATABASE_VERSION).toBe(1)
    expect(BOARD_LIBRARY_STORE_NAME).toBe('library')
    expect(BOARD_LIBRARY_RECORD_KEY).toBe('user')
  })

  it('serializes and de-duplicates full LibraryItems snapshots', async () => {
    const store = createMemoryBoardLibraryStore()
    const save = vi.spyOn(store, 'save')
    const adapter = createBoardLibraryPersistenceAdapter(store)

    await Promise.all([
      adapter.save({ libraryItems }),
      adapter.save({ libraryItems }),
    ])

    expect(save).toHaveBeenCalledOnce()
    expect(await store.load()).toEqual(libraryItems)
  })

  it('reports a library save failure without changing the rejected promise', async () => {
    const error = new Error('IndexedDB unavailable')
    const onError = vi.fn()
    const save = vi.spyOn(boardLibraryPersistenceAdapter, 'save').mockRejectedValueOnce(error)

    await expect(persistBoardLibraryItems(libraryItems, onError)).rejects.toBe(error)
    expect(onError).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith(error)
    save.mockRestore()
  })

  it('builds an absolute Board return URL without the install hash', () => {
    const originalUrl = window.location.href
    window.history.replaceState({}, '', '/board/board-1#addLibrary=https%3A%2F%2Flibraries.excalidraw.com%2Ftest')

    expect(currentBoardLibraryReturnUrl()).toBe(`${window.location.origin}/board/board-1`)

    window.history.replaceState({}, '', originalUrl)
  })

  it('blocks a duplicate install hash without blocking the first callback', () => {
    const originalUrl = window.location.href
    const installHash = 'addLibrary=https%3A%2F%2Flibraries.excalidraw.com%2Ftest'
    window.history.replaceState({}, '', '/board/board-1')
    const guard = createBoardLibraryInstallHashGuard()

    window.history.replaceState({}, '', `/board/board-1#${installHash}`)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    expect(window.location.hash).toBe(`#${installHash}`)

    window.dispatchEvent(new HashChangeEvent('hashchange'))
    expect(window.location.hash).toBe('')
    guard.dispose()
    window.history.replaceState({}, '', originalUrl)
  })
})
