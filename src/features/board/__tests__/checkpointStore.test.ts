import { describe, expect, it } from 'vitest'
import { createMemoryBoardCheckpointStore } from '../checkpointStore'
import type { BoardCheckpoint, PendingBoardAsset } from '../recoveryTypes'

function checkpoint(boardId: string, localRevision = 3): BoardCheckpoint {
  return {
    boardId,
    sceneVersion: 1,
    baseRevision: 2,
    localRevision,
    scene: { engineData: { elements: [{ id: localRevision }], fileMap: {} }, persistentAppState: {}, assetRefs: [] },
    savedAt: 10,
  }
}

describe('Board checkpoint store', () => {
  it('keeps one checkpoint per board and isolates boards', async () => {
    const store = createMemoryBoardCheckpointStore()
    await store.put(checkpoint('a', 1))
    await store.put(checkpoint('a', 2))
    await store.put(checkpoint('b', 1))

    expect(await store.get('a')).toEqual(checkpoint('a', 2))
    expect(await store.get('b')).toEqual(checkpoint('b', 1))
  })

  it('clears only the target board checkpoint and pending asset foundation rows', async () => {
    const store = createMemoryBoardCheckpointStore()
    await store.put(checkpoint('a'))
    await store.put(checkpoint('b'))
    store.seedPendingAsset({ assetId: 'asset-a', boardId: 'a' })
    store.seedPendingAsset({ assetId: 'asset-b', boardId: 'b' })

    await store.clearBoardRecovery('a')

    expect(await store.get('a')).toBeNull()
    expect(await store.get('b')).toEqual(checkpoint('b'))
    expect(store.getPendingAssetIds('a')).toEqual([])
    expect(store.getPendingAssetIds('b')).toEqual(['asset-b'])
  })

  it('persists the complete PendingBoardAsset Blob contract', async () => {
    const store = createMemoryBoardCheckpointStore()
    const pending: PendingBoardAsset = {
      assetId: '11111111-1111-4111-8111-111111111111',
      boardId: 'board-a',
      engineFileId: 'engine-file-a',
      mimeType: 'image/png',
      blob: new Blob(['png'], { type: 'image/png' }),
      createdAt: 42,
    }

    await store.putPendingAsset(pending)

    await expect(store.getPendingAsset(pending.assetId)).resolves.toEqual(pending)
    await expect(store.listPendingAssets(pending.boardId)).resolves.toEqual([pending])
    await store.deletePendingAsset(pending.assetId)
    await expect(store.getPendingAsset(pending.assetId)).resolves.toBeNull()
  })
})
