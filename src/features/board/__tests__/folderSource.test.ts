import { describe, expect, it, vi } from 'vitest'
import type { BoardFolderSummary } from '../../../../shared/boardProtocol'
import { createBoardFolderSource } from '../folderSource'

function folder(id: string, name: string, boardCount = 0): BoardFolderSummary {
  return { id, name, parentId: null, createdAt: 1, updatedAt: 1, boardCount }
}

describe('Board folder source', () => {
  it('loads folders in stable name order and updates them locally', async () => {
    const fetchFolders = vi.fn(async () => [folder('b', 'Work'), folder('a', 'Learning')])
    const source = createBoardFolderSource(fetchFolders)

    await source.ensureLoaded()
    expect(fetchFolders).toHaveBeenCalledOnce()
    expect(source.getSnapshot().map((item) => item.name)).toEqual(['Learning', 'Work'])

    source.upsert({ ...folder('b', 'Archive'), boardCount: 3 })
    expect(source.getSnapshot().map((item) => item.name)).toEqual(['Archive', 'Learning'])
    source.remove('a')
    expect(source.getSnapshot().map((item) => item.id)).toEqual(['b'])
  })

  it('invalidates stale in-flight data before a later load can repopulate the source', async () => {
    let resolveFirst!: (folders: readonly BoardFolderSummary[]) => void
    const fetchFolders = vi.fn()
      .mockImplementationOnce(() => new Promise<readonly BoardFolderSummary[]>((resolve) => { resolveFirst = resolve }))
      .mockResolvedValueOnce([folder('fresh', 'Fresh')])
    const source = createBoardFolderSource(fetchFolders)

    const first = source.ensureLoaded()
    source.invalidate()
    const second = source.ensureLoaded()
    resolveFirst([folder('stale', 'Stale')])
    await Promise.all([first, second])

    expect(source.getSnapshot().map((item) => item.id)).toEqual(['fresh'])
  })
})
