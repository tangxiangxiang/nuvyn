import { describe, expect, it, vi } from 'vitest'
import { BoardAssetError, type AssetUploadResult } from '../assetClient'
import { createBoardAssetSession } from '../assetSession'
import { createMemoryBoardCheckpointStore, type MemoryBoardCheckpointStore } from '../checkpointStore'
import type { BoardRuntimeAsset } from '../engine/types'
import type { BoardScene } from '../../../../shared/boardProtocol'
import type { PendingBoardAsset } from '../recoveryTypes'

const ASSET_A = '11111111-1111-4111-8111-111111111111'
const ASSET_B = '22222222-2222-4222-8222-222222222222'

function imageScene(fileMap: Record<string, string>): BoardScene {
  const elements = Object.keys(fileMap).map((fileId, index) => ({
    id: `image-${index}`,
    type: 'image',
    fileId,
    isDeleted: false,
    version: 1,
  }))
  return {
    engineData: { elements, fileMap },
    persistentAppState: {},
    assetRefs: [...new Set(Object.values(fileMap))],
  }
}

function runtimeImage(fileId: string, bytes = 'image'): { scene: BoardRuntimeAsset; runtime: { elements: unknown[]; appState: Record<string, unknown>; files: Record<string, unknown> } } {
  const blob = new Blob([bytes], { type: 'image/png' })
  return {
    scene: { engineFileId: fileId, mimeType: 'image/png', blob },
    runtime: {
      elements: [{ id: `image-${fileId}`, type: 'image', fileId, isDeleted: false, version: 1 }],
      appState: {},
      files: { [fileId]: { id: fileId, dataURL: 'data:image/png;base64,aW1hZ2U=', mimeType: 'image/png' } },
    },
  }
}

function uploadResult(assetId: string, blob: Blob): AssetUploadResult {
  return { id: assetId, mimeType: 'image/png', byteSize: blob.size, sha256: 'hash' }
}

function pendingAsset(overrides: Partial<PendingBoardAsset> = {}): PendingBoardAsset {
  return {
    assetId: ASSET_A,
    boardId: 'board-1',
    engineFileId: 'file-a',
    mimeType: 'image/png',
    blob: new Blob(['pending'], { type: 'image/png' }),
    createdAt: 10,
    ...overrides,
  }
}

function wrappedStore(base: MemoryBoardCheckpointStore, putPendingAsset: MemoryBoardCheckpointStore['putPendingAsset']): MemoryBoardCheckpointStore {
  return { ...base, putPendingAsset }
}

describe('Board asset session', () => {
  it('durably stores a new Pending Blob before starting its upload', async () => {
    const base = createMemoryBoardCheckpointStore()
    let releasePending!: () => void
    const pendingGate = new Promise<void>((resolve) => { releasePending = resolve })
    const events: string[] = []
    const putPendingAsset = vi.fn(async (asset: PendingBoardAsset) => {
      events.push('pending-start')
      await pendingGate
      await base.putPendingAsset(asset)
      events.push('pending-durable')
    })
    const upload = vi.fn(async (assetId: string, _mimeType: string, blob: Blob) => {
      events.push('upload')
      return uploadResult(assetId, blob)
    })
    const store = wrappedStore(base, putPendingAsset)
    const session = createBoardAssetSession({
      boardId: 'board-1',
      store,
      createAssetId: () => ASSET_A,
      upload,
    })
    const runtime = runtimeImage('file-a')

    const intake = session.observeRuntimeAssets([runtime.scene])
    await Promise.resolve()
    expect(upload).not.toHaveBeenCalled()
    releasePending()
    await intake
    await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce())

    expect(events.indexOf('pending-durable')).toBeGreaterThanOrEqual(0)
    expect(events.indexOf('upload')).toBeGreaterThan(events.indexOf('pending-durable'))
    expect(session.getFileMap()).toEqual({ 'file-a': ASSET_A })
  })

  it('allocates one asset ID per engine file and deduplicates uploads', async () => {
    const store = createMemoryBoardCheckpointStore()
    const createAssetId = vi.fn(() => ASSET_A)
    const upload = vi.fn(async (assetId: string, _mimeType: string, blob: Blob) => uploadResult(assetId, blob))
    const session = createBoardAssetSession({ boardId: 'board-1', store, createAssetId, upload })
    const runtime = runtimeImage('file-a')

    await session.observeRuntimeAssets([runtime.scene])
    await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce())
    await session.observeRuntimeAssets([runtime.scene])

    expect(createAssetId).toHaveBeenCalledOnce()
    expect(upload).toHaveBeenCalledOnce()
    expect(await store.getPendingAsset(ASSET_A)).toBeNull()
  })

  it('preserves actionable runtime MIME and size errors for the editor gate', async () => {
    const store = createMemoryBoardCheckpointStore()
    const runtime = runtimeImage('file-a')
    const session = createBoardAssetSession({ boardId: 'board-1', store, maxBytes: 20 })

    await expect(session.observeRuntimeAssets([{
      ...runtime.scene,
      mimeType: 'image/bmp',
    }])).rejects.toMatchObject({
      code: 'UNSUPPORTED_ASSET_MIME',
      status: 415,
      engineFileId: 'file-a',
      mimeType: 'image/bmp',
    })
    const sizeLimitedSession = createBoardAssetSession({ boardId: 'board-1', store, maxBytes: 2 })
    await expect(sizeLimitedSession.observeRuntimeAssets([{
      ...runtime.scene,
      engineFileId: 'file-b',
      blob: new Blob(['large'], { type: 'image/png' }),
    }])).rejects.toMatchObject({
      code: 'ASSET_TOO_LARGE',
      status: 413,
      engineFileId: 'file-b',
    })
  })

  it('keeps Pending Blob after upload failure and retries the same asset ID', async () => {
    const store = createMemoryBoardCheckpointStore()
    const upload = vi.fn()
      .mockRejectedValueOnce(new BoardAssetError('ASSET_UPLOAD_FAILED', 'offline'))
      .mockImplementation(async (assetId: string, _mimeType: string, blob: Blob) => uploadResult(assetId, blob))
    const session = createBoardAssetSession({ boardId: 'board-1', store, createAssetId: () => ASSET_A, upload })
    const runtime = runtimeImage('file-a')
    await session.observeRuntimeAssets([runtime.scene])
    await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce())

    expect(await store.getPendingAsset(ASSET_A)).toBeTruthy()
    await expect(session.ensureSceneAssetsReady(imageScene({ 'file-a': ASSET_A }))).resolves.toBeUndefined()
    expect(upload).toHaveBeenCalledTimes(2)
    expect(upload.mock.calls.map((call) => call[0])).toEqual([ASSET_A, ASSET_A])
    expect(await store.getPendingAsset(ASSET_A)).toBeNull()
  })

  it('keeps background upload failure out of the intake promise until the save gate retries it', async () => {
    const store = createMemoryBoardCheckpointStore()
    const upload = vi.fn()
      .mockRejectedValueOnce(new BoardAssetError('ASSET_UPLOAD_FAILED', 'offline'))
      .mockImplementation(async (assetId: string, _mimeType: string, blob: Blob) => uploadResult(assetId, blob))
    const session = createBoardAssetSession({ boardId: 'board-1', store, createAssetId: () => ASSET_A, upload })
    const runtime = runtimeImage('file-a')

    await expect(session.observeRuntimeAssets([runtime.scene])).resolves.toBeUndefined()
    await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce())
    expect(await store.getPendingAsset(ASSET_A)).toBeTruthy()

    await expect(session.ensureSceneAssetsReady(imageScene({ 'file-a': ASSET_A }))).resolves.toBeUndefined()
    expect(upload).toHaveBeenCalledTimes(2)
    expect(await store.getPendingAsset(ASSET_A)).toBeNull()
  })

  it('allows checkpointing after a durable Pending Blob even when upload fails', async () => {
    const store = createMemoryBoardCheckpointStore()
    const upload = vi.fn().mockRejectedValue(new BoardAssetError('ASSET_UPLOAD_FAILED', 'offline'))
    const session = createBoardAssetSession({ boardId: 'board-1', store, createAssetId: () => ASSET_A, upload })
    const runtime = runtimeImage('file-a')

    await session.observeRuntimeAssets([runtime.scene])
    await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce())
    await Promise.resolve()

    await expect(session.ensureCheckpointAssetsDurable(runtime.runtime)).resolves.toBeUndefined()
    expect(await store.getPendingAsset(ASSET_A)).toMatchObject({
      assetId: ASSET_A,
      boardId: 'board-1',
      engineFileId: 'file-a',
    })
  })

  it('does not wait for a remote upload before checkpointing a durable Pending Blob', async () => {
    const store = createMemoryBoardCheckpointStore()
    const upload = vi.fn(() => new Promise<AssetUploadResult>(() => {}))
    const session = createBoardAssetSession({ boardId: 'board-1', store, createAssetId: () => ASSET_A, upload })
    const runtime = runtimeImage('file-a')

    await session.observeRuntimeAssets([runtime.scene])

    await expect(session.ensureCheckpointAssetsDurable(runtime.runtime)).resolves.toBeUndefined()
    expect(upload).toHaveBeenCalledOnce()
  })

  it('blocks checkpointing when Pending Blob persistence fails', async () => {
    const base = createMemoryBoardCheckpointStore()
    const pendingError = new Error('IndexedDB is unavailable')
    const putPendingAsset = vi.fn().mockRejectedValue(pendingError)
    const store = wrappedStore(base, putPendingAsset)
    const session = createBoardAssetSession({ boardId: 'board-1', store, createAssetId: () => ASSET_A })
    const runtime = runtimeImage('file-a')

    await expect(session.observeRuntimeAssets([runtime.scene])).rejects.toMatchObject({ code: 'ASSET_PENDING_INVALID' })
    await expect(session.ensureCheckpointAssetsDurable(runtime.runtime)).rejects.toMatchObject({
      code: 'ASSET_PENDING_INVALID',
    })
    expect(await store.getPendingAsset(ASSET_A)).toBeNull()
  })

  it('reuploads a local Pending Blob when the Server returns 404', async () => {
    const store = createMemoryBoardCheckpointStore()
    await store.putPendingAsset(pendingAsset())
    const fetch = vi.fn().mockRejectedValue(new BoardAssetError('ASSET_MISSING', 'missing', 404, { uncertain: false }))
    const upload = vi.fn(async (assetId: string, _mimeType: string, blob: Blob) => uploadResult(assetId, blob))
    const session = createBoardAssetSession({ boardId: 'board-1', store, fetch, upload })
    const scene = imageScene({ 'file-a': ASSET_A })

    const resolved = await session.resolveSceneAssets(scene)

    expect(fetch).toHaveBeenCalledWith(ASSET_A)
    expect(upload).toHaveBeenCalledWith(ASSET_A, 'image/png', expect.any(Blob))
    expect(resolved).toMatchObject([{ assetId: ASSET_A, engineFileId: 'file-a', mimeType: 'image/png' }])
    expect(await store.getPendingAsset(ASSET_A)).toBeNull()
  })

  it('does not treat Server errors as missing assets', async () => {
    const store = createMemoryBoardCheckpointStore()
    await store.putPendingAsset(pendingAsset())
    const fetch = vi.fn().mockRejectedValue(new BoardAssetError('ASSET_RESOLVE_FAILED', 'server error', 500))
    const upload = vi.fn()
    const session = createBoardAssetSession({ boardId: 'board-1', store, fetch, upload })

    await expect(session.resolveSceneAssets(imageScene({ 'file-a': ASSET_A }))).rejects.toMatchObject({
      code: 'ASSET_RESOLVE_FAILED',
    })
    expect(upload).not.toHaveBeenCalled()
    expect(await store.getPendingAsset(ASSET_A)).toBeTruthy()
  })

  it('fails closed for a missing or mismatched Pending Blob', async () => {
    const missingStore = createMemoryBoardCheckpointStore()
    const missingSession = createBoardAssetSession({
      boardId: 'board-1',
      store: missingStore,
      fetch: vi.fn().mockRejectedValue(new BoardAssetError('ASSET_MISSING', 'missing', 404, { uncertain: false })),
    })
    await expect(missingSession.resolveSceneAssets(imageScene({ 'file-a': ASSET_A }))).rejects.toMatchObject({ code: 'ASSET_MISSING' })

    const mismatchStore = createMemoryBoardCheckpointStore()
    await mismatchStore.putPendingAsset(pendingAsset({ engineFileId: 'other-file' }))
    const mismatchSession = createBoardAssetSession({
      boardId: 'board-1',
      store: mismatchStore,
      fetch: vi.fn().mockRejectedValue(new BoardAssetError('ASSET_MISSING', 'missing', 404, { uncertain: false })),
    })
    await expect(mismatchSession.resolveSceneAssets(imageScene({ 'file-a': ASSET_A }))).rejects.toMatchObject({ code: 'ASSET_PENDING_INVALID' })
  })

  it('resolves multiple scene assets concurrently and preserves all mappings', async () => {
    const store = createMemoryBoardCheckpointStore()
    const fetch = vi.fn(async (assetId: string) => new Blob([assetId], { type: 'image/png' }))
    const session = createBoardAssetSession({ boardId: 'board-1', store, fetch })
    const scene = imageScene({ 'file-a': ASSET_A, 'file-b': ASSET_B })

    const resolved = await session.resolveSceneAssets(scene)

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(resolved.map((asset) => asset.assetId)).toEqual([ASSET_A, ASSET_B])
    expect(session.getFileMap()).toEqual({ 'file-a': ASSET_A, 'file-b': ASSET_B })
  })

  it('resolves one shared server asset for multiple Excalidraw file IDs', async () => {
    const store = createMemoryBoardCheckpointStore()
    const fetch = vi.fn(async () => new Blob(['shared'], { type: 'image/png' }))
    const session = createBoardAssetSession({ boardId: 'board-1', store, fetch })

    const resolved = await session.resolveSceneAssets(imageScene({ 'file-a': ASSET_A, 'file-b': ASSET_A }))

    expect(fetch).toHaveBeenCalledOnce()
    expect(resolved).toMatchObject([
      { assetId: ASSET_A, engineFileId: 'file-a' },
      { assetId: ASSET_A, engineFileId: 'file-b' },
    ])
    expect([...new Set(imageScene({ 'file-a': ASSET_A, 'file-b': ASSET_A }).assetRefs)]).toEqual([ASSET_A])
  })
})
