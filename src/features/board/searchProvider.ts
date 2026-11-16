import type { BoardSearchItem, BoardSearchMatch } from '../../../shared/boardSearchProtocol'
import type { SearchProvider, SearchResult, SearchResultSection } from '../../lib/searchResults'
import { searchBoardContent } from './api'

export interface BoardSearchPayload {
  boardId: string
  match: BoardSearchMatch
  revision: number
  snippet?: string
  elementId?: string
}

export type BoardSearchRequest = (query: string) => Promise<{ items: BoardSearchItem[] }>

function boardResult(item: BoardSearchItem): SearchResult<BoardSearchPayload> {
  return {
    id: `board:${item.boardId}`,
    type: 'board',
    title: item.title,
    score: 0,
    payload: {
      boardId: item.boardId,
      match: item.match,
      revision: item.revision,
      ...(item.snippet ? { snippet: item.snippet } : {}),
      ...(item.elementId ? { elementId: item.elementId } : {}),
    },
  }
}

export function createBoardSearchProvider(search: BoardSearchRequest = searchBoardContent): SearchProvider {
  return async (query) => {
    if (!query.trim()) return { id: 'boards', label: 'Boards', results: [] }
    const response = await search(query.trim())
    const results = response.items.map(boardResult)
    const section: SearchResultSection = { id: 'boards', label: 'Boards', results }
    return section
  }
}
