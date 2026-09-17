import { describe, expect, it, vi } from 'vitest'
import type { BoardMetadata } from '../../../../shared/boardProtocol'
import { createBoardMetadataSource } from '../metadataSource'

function board(id: string, title: string, updatedAt: number, lastOpenedAt: number | null = null): BoardMetadata {
  return { id, title, thumbnailAssetId: null, folderId: null, createdAt: updatedAt - 10, updatedAt, lastOpenedAt }
}

describe('Board metadata source', () => {
  it('deduplicates the initial load and keeps newest boards first', async () => {
    const fetchBoards = vi.fn(async () => [
      board('older', 'Older', 10),
      board('newer', 'Newer', 20),
    ])
    const source = createBoardMetadataSource(fetchBoards)

    await Promise.all([source.ensureLoaded(), source.ensureLoaded()])

    expect(fetchBoards).toHaveBeenCalledOnce()
    expect(source.getSnapshot().map((item) => item.id)).toEqual(['newer', 'older'])
  })

  it('updates one shared snapshot for mutations and refreshes from the server', async () => {
    const fetchBoards = vi.fn()
      .mockResolvedValueOnce([board('a', 'A', 10)])
      .mockResolvedValueOnce([board('b', 'B', 30)])
    const source = createBoardMetadataSource(fetchBoards)

    await source.ensureLoaded()
    source.upsert(board('a', 'Renamed', 40))
    source.remove('missing')
    expect(source.getSnapshot()[0]).toMatchObject({ id: 'a', title: 'Renamed' })

    await source.refresh()
    expect(source.getSnapshot()).toEqual([board('b', 'B', 30)])
    expect(fetchBoards).toHaveBeenCalledTimes(2)
  })

  it('does not let an invalidated request repopulate the next session', async () => {
    let resolveFirst!: (boards: readonly BoardMetadata[]) => void
    let resolveSecond!: (boards: readonly BoardMetadata[]) => void
    const fetchBoards = vi.fn()
      .mockImplementationOnce(() => new Promise<readonly BoardMetadata[]>((resolve) => { resolveFirst = resolve }))
      .mockImplementationOnce(() => new Promise<readonly BoardMetadata[]>((resolve) => { resolveSecond = resolve }))
    const source = createBoardMetadataSource(fetchBoards)

    const firstLoad = source.ensureLoaded()
    source.invalidate()
    const secondLoad = source.ensureLoaded()
    resolveSecond([board('current', 'Current', 20)])
    await secondLoad
    resolveFirst([board('stale', 'Stale', 10)])
    await firstLoad

    expect(fetchBoards).toHaveBeenCalledTimes(2)
    expect(source.getSnapshot()).toEqual([board('current', 'Current', 20)])
  })

  it('reloads after an invalidation so search and Gallery can reconcile', async () => {
    const fetchBoards = vi.fn()
      .mockResolvedValueOnce([board('old', 'Old', 10)])
      .mockResolvedValueOnce([board('current', 'Current', 20)])
    const source = createBoardMetadataSource(fetchBoards)

    await source.ensureLoaded()
    source.invalidate()
    await source.ensureLoaded()

    expect(fetchBoards).toHaveBeenCalledTimes(2)
    expect(source.getSnapshot()).toEqual([board('current', 'Current', 20)])
  })

  it('sorts recent metadata by last opened time with an updated-time fallback', async () => {
    const source = createBoardMetadataSource(vi.fn(async () => [
      board('edited', 'Edited', 100, 10),
      board('opened', 'Opened', 20, 90),
      board('legacy', 'Legacy', 80),
    ]))

    await source.ensureLoaded()

    expect(source.getSnapshot().map((item) => item.id)).toEqual(['opened', 'legacy', 'edited'])
  })
})
