import { describe, expect, it, vi } from 'vitest'

const authFetch = vi.hoisted(() => vi.fn())
vi.mock('../../../lib/auth-session', () => ({ authFetch }))

import {
  createBoard,
  createBoardFolder,
  deleteBoard,
  deleteBoardFolder,
  listBoardFolders,
  moveBoard,
  renameBoard,
  renameBoardFolder,
  saveBoardScene,
  setBoardThumbnail,
} from '../api'

describe('Board API mutation uncertainty', () => {
  it('marks transport failures as uncertain', async () => {
    authFetch.mockRejectedValueOnce(new TypeError('network failed'))

    await expect(createBoard()).rejects.toMatchObject({
      uncertain: true,
      status: 500,
    })
  })

  it('marks a parseable HTTP error as definite', async () => {
    authFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid title', code: 'BOARD_VALIDATION_ERROR' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }))

    await expect(createBoard()).rejects.toMatchObject({
      uncertain: false,
      status: 400,
      code: 'BOARD_VALIDATION_ERROR',
    })
  })

  it('marks an unreadable response as uncertain', async () => {
    authFetch.mockResolvedValueOnce(new Response('not json', { status: 500 }))

    await expect(createBoard()).rejects.toMatchObject({
      uncertain: true,
      status: 500,
    })
  })

  it.each([
    ['rename', () => renameBoard('board-1', 'Renamed')],
    ['delete', () => deleteBoard('board-1')],
  ])('marks %s transport failures as uncertain', async (_operation, mutation) => {
    authFetch.mockRejectedValueOnce(new TypeError('network failed'))

    await expect(mutation()).rejects.toMatchObject({ uncertain: true })
  })

  it('saves only the server scene contract with the expected revision', async () => {
    authFetch.mockResolvedValueOnce(new Response(JSON.stringify({ revision: 4, updatedAt: 123 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))

    const scene = { engineData: { elements: [], fileMap: {} }, persistentAppState: {}, assetRefs: [] }
    await expect(saveBoardScene('board/1', {
      expectedRevision: 3,
      engine: 'excalidraw',
      sceneVersion: 1,
      scene,
    })).resolves.toEqual({ revision: 4, updatedAt: 123 })

    expect(authFetch).toHaveBeenCalledWith('/api/board/board%2F1/scene', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 3, engine: 'excalidraw', sceneVersion: 1, scene }),
    })
  })

  it('updates only the thumbnail Asset reference', async () => {
    authFetch.mockResolvedValueOnce(new Response(JSON.stringify({ thumbnailAssetId: 'asset-2' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))

    await expect(setBoardThumbnail('board/1', 'asset-2')).resolves.toEqual({ thumbnailAssetId: 'asset-2' })
    expect(authFetch).toHaveBeenCalledWith('/api/board/board%2F1/thumbnail', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assetId: 'asset-2' }),
    })
  })

  it('supports clearing a thumbnail with a null Asset ID', async () => {
    authFetch.mockResolvedValueOnce(new Response(JSON.stringify({ thumbnailAssetId: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))

    await expect(setBoardThumbnail('board-1', null)).resolves.toEqual({ thumbnailAssetId: null })
    expect(authFetch).toHaveBeenCalledWith('/api/board/board-1/thumbnail', expect.objectContaining({
      body: JSON.stringify({ assetId: null }),
    }))
  })

  it('uses the Folder and Board move endpoints without scene payloads', async () => {
    authFetch
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 'folder-1', name: 'Work', parentId: null, boardCount: 2 }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'folder-1', name: 'Work', parentId: null, boardCount: 2 }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'folder-1', name: 'Projects', parentId: null, boardCount: 2 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'board-1', folderId: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))

    await expect(listBoardFolders()).resolves.toHaveLength(1)
    await expect(createBoardFolder('Work')).resolves.toMatchObject({ name: 'Work' })
    await expect(renameBoardFolder('folder/1', 'Projects')).resolves.toMatchObject({ name: 'Projects' })
    await expect(deleteBoardFolder('folder/1')).resolves.toBeUndefined()
    await expect(moveBoard('board/1', null)).resolves.toMatchObject({ folderId: null })

    expect(authFetch).toHaveBeenCalledWith('/api/board/board%2F1/folder', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderId: null }),
    })
  })
})
