import { describe, expect, it, vi } from 'vitest'
import type { BoardMetadata } from '../../../../shared/boardProtocol'
import { createBoardSearchProvider } from '../searchProvider'
import { createBoardMetadataSource } from '../metadataSource'

function board(id: string, title: string): BoardMetadata {
  return { id, title, thumbnailAssetId: null, folderId: null, createdAt: 1, updatedAt: 1, lastOpenedAt: null }
}

describe('Board search provider', () => {
  it('searches Board titles locally after one metadata load', async () => {
    const fetchBoards = vi.fn(async () => [
      board('one', 'Project Atlas'),
      board('two', 'Reading List'),
    ])
    const provider = createBoardSearchProvider(createBoardMetadataSource(fetchBoards))

    const result = await provider('ATLAS')

    expect(result).toMatchObject({ id: 'boards', label: 'Boards' })
    expect(result.results).toHaveLength(1)
    expect(result.results[0]).toMatchObject({
      id: 'board:one',
      type: 'board',
      title: 'Project Atlas',
      payload: { boardId: 'one' },
    })

    await provider('')
    expect(fetchBoards).toHaveBeenCalledOnce()
  })
})
