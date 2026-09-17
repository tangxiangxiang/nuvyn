import type { BoardMetadata } from '../../../shared/boardProtocol'
import type { SearchProvider, SearchResult, SearchResultSection } from '../../lib/searchResults'
import { boardMetadataSource, type BoardMetadataSource } from './boardMetadataSource'

export interface BoardSearchPayload {
  boardId: string
}

function boardResult(board: BoardMetadata): SearchResult<BoardSearchPayload> {
  return {
    id: `board:${board.id}`,
    type: 'board',
    title: board.title,
    subtitle: 'Board',
    score: 0,
    payload: { boardId: board.id },
  }
}

export function createBoardSearchProvider(source: BoardMetadataSource = boardMetadataSource): SearchProvider {
  return async (query) => {
    await source.ensureLoaded()
    const normalizedQuery = query.trim().toLocaleLowerCase()
    const results = source.getSnapshot()
      .filter((board) => board.title.toLocaleLowerCase().includes(normalizedQuery))
      .map(boardResult)
    const section: SearchResultSection = { id: 'boards', label: 'Boards', results }
    return section
  }
}
