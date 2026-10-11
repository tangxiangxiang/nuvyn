import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCanonicalEmptyBoardScene } from '../../../../shared/boardProtocol'
import { getBoardPreview, type BoardAggregate } from '../api'
import { fetchAssetBlob } from '../assetClient'
import { excalidrawAdapter } from '../engine/excalidrawAdapter'
import { loadBoardPreview } from '../preview'

vi.mock('../api', () => ({ getBoardPreview: vi.fn() }))
vi.mock('../assetClient', () => ({ fetchAssetBlob: vi.fn() }))

function board(): BoardAggregate {
  return {
    metadata: { id: 'board', title: 'Diagram', folderId: null, thumbnailAssetId: null, createdAt: 1, updatedAt: 2, lastOpenedAt: null },
    sceneRecord: { boardId: 'board', engine: 'excalidraw', sceneVersion: 1, revision: 3, scene: createCanonicalEmptyBoardScene() },
  }
}

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { vi.restoreAllMocks() })

describe('saved Board previews', () => {
  it('starts independent asset downloads together and exports once after they all finish', async () => {
    const saved = board()
    const ids = Array.from({ length: 12 }, (_, index) => `asset-${index}`)
    saved.sceneRecord.scene = {
      engineData: {
        elements: ids.map(id => ({ type: 'image', fileId: id })),
        fileMap: Object.fromEntries(ids.map(id => [id, id])),
      },
      persistentAppState: {}, assetRefs: ids,
    }
    vi.mocked(getBoardPreview).mockResolvedValueOnce(saved)
    const resolvers: Array<(blob: Blob) => void> = []
    vi.mocked(fetchAssetBlob).mockImplementation(() => new Promise(resolve => { resolvers.push(resolve) }))
    const exportSvg = vi.spyOn(excalidrawAdapter, 'exportSvg').mockResolvedValue(new Blob(['<svg/>']))
    const task = loadBoardPreview('board')
    await vi.waitFor(() => expect(resolvers).toHaveLength(12))
    expect(exportSvg).not.toHaveBeenCalled()
    for (const resolve of resolvers) resolve(new Blob(['image'], { type: 'image/png' }))
    await task
    expect(fetchAssetBlob).toHaveBeenCalledTimes(12)
    expect(exportSvg).toHaveBeenCalledOnce()
  })

  it('stops before exporting if cancellation arrives during hydration', async () => {
    const saved = board()
    saved.sceneRecord.scene.engineData = { elements: [{ type: 'rectangle' }], fileMap: {} }
    vi.mocked(getBoardPreview).mockResolvedValueOnce(saved)
    const controller = new AbortController()
    vi.spyOn(excalidrawAdapter, 'hydrate').mockImplementationOnce(async () => {
      controller.abort()
      return { elements: [], appState: {}, files: {} }
    })
    const exportSvg = vi.spyOn(excalidrawAdapter, 'exportSvg')
    await expect(loadBoardPreview('board', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(exportSvg).not.toHaveBeenCalled()
  })

  it('discards an exported blob if cancellation arrives during SVG export', async () => {
    const saved = board()
    saved.sceneRecord.scene.engineData = { elements: [{ type: 'rectangle' }], fileMap: {} }
    vi.mocked(getBoardPreview).mockResolvedValueOnce(saved)
    const controller = new AbortController()
    vi.spyOn(excalidrawAdapter, 'exportSvg').mockImplementationOnce(async () => {
      controller.abort()
      return new Blob(['<svg/>'])
    })
    await expect(loadBoardPreview('board', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('returns an empty state without loading the export engine', async () => {
    vi.mocked(getBoardPreview).mockResolvedValueOnce(board())
    const exportSvg = vi.spyOn(excalidrawAdapter, 'exportSvg')
    expect(await loadBoardPreview('board')).toMatchObject({ image: null, revision: 3 })
    expect(exportSvg).not.toHaveBeenCalled()
  })

  it('hydrates all image assets and exports a crisp SVG, deduplicating shared assets', async () => {
    const saved = board()
    saved.sceneRecord.scene = {
      engineData: {
        elements: [{ type: 'image', fileId: 'first' }, { type: 'image', fileId: 'second' }],
        fileMap: { first: 'asset', second: 'asset' },
      },
      persistentAppState: {},
      assetRefs: ['asset'],
    }
    vi.mocked(getBoardPreview).mockResolvedValueOnce(saved)
    vi.mocked(fetchAssetBlob).mockResolvedValueOnce(new Blob(['image'], { type: 'image/png' }))
    const svg = new Blob(['<svg />'], { type: 'image/svg+xml' })
    const exportSvg = vi.spyOn(excalidrawAdapter, 'exportSvg').mockResolvedValueOnce(svg)
    const signal = new AbortController().signal
    expect(await loadBoardPreview('board', signal)).toMatchObject({ metadata: saved.metadata, image: svg, revision: 3 })
    expect(fetchAssetBlob).toHaveBeenCalledExactlyOnceWith('asset', signal)
    expect(exportSvg).toHaveBeenCalledWith(expect.objectContaining({ files: { first: expect.any(Object), second: expect.any(Object) } }))
  })

  it('does not silently render a preview missing an image asset', async () => {
    const saved = board()
    saved.sceneRecord.scene = {
      engineData: { elements: [{ type: 'image', fileId: 'file' }], fileMap: { file: 'asset' } },
      persistentAppState: {}, assetRefs: ['asset'],
    }
    vi.mocked(getBoardPreview).mockResolvedValueOnce(saved)
    vi.mocked(fetchAssetBlob).mockRejectedValueOnce(new Error('Missing image'))
    const exportSvg = vi.spyOn(excalidrawAdapter, 'exportSvg')
    await expect(loadBoardPreview('board')).rejects.toThrow('Missing image')
    expect(exportSvg).not.toHaveBeenCalled()
  })

  it('rejects incompatible scenes and cancels superseded loads before exporting', async () => {
    const saved = board()
    saved.sceneRecord.sceneVersion = 99
    vi.mocked(getBoardPreview).mockResolvedValueOnce(saved)
    await expect(loadBoardPreview('board')).rejects.toMatchObject({ code: 'BOARD_SCENE_VERSION_UNSUPPORTED' })
    const controller = new AbortController()
    controller.abort()
    vi.mocked(getBoardPreview).mockResolvedValueOnce(board())
    await expect(loadBoardPreview('board', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
