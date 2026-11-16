import type { DiarySearchItem } from '../../../shared/diaryLife'
import { diaryLifeApi } from '../../lib/diary-life-api'
import type { SearchProvider, SearchResult, SearchResultSection } from '../../lib/searchResults'

export interface DiarySearchPayload extends DiarySearchItem {
  query: string
}

function makeResult(item: DiarySearchItem, query: string): SearchResult<DiarySearchPayload> {
  return {
    id: `diary:${item.date}`,
    type: 'diary-day',
    title: item.date,
    score: 0,
    payload: { ...item, query },
  }
}

export function createDiarySearchProvider(): SearchProvider {
  let activeQuery = ''
  let nextCursor: string | null = null
  let controller: AbortController | null = null
  let generation = 0

  const provider: SearchProvider = async (rawQuery) => {
    const query = rawQuery.trim()
    controller?.abort()
    controller = null
    generation += 1
    activeQuery = query
    nextCursor = null
    if (!query) return { id: 'diary', label: '日记', results: [] }
    const requestController = new AbortController()
    controller = requestController
    const requestGeneration = generation
    try {
      const page = await diaryLifeApi.search(query, 20, null, requestController.signal)
      if (requestController.signal.aborted || requestGeneration !== generation) return { id: 'diary', label: '日记', results: [] }
      nextCursor = page.nextCursor
      return { id: 'diary', label: '日记', results: page.items.map(item => makeResult(item, query)) }
    } catch {
      if (requestController.signal.aborted || requestGeneration !== generation) return { id: 'diary', label: '日记', results: [] }
      nextCursor = null
      return { id: 'diary', label: '日记', results: [], error: true }
    } finally {
      if (controller === requestController) controller = null
    }
  }

  provider.loadMore = async (rawQuery): Promise<SearchResultSection | null> => {
    const query = rawQuery.trim()
    const cursor = nextCursor
    if (!query || query !== activeQuery || !cursor) return null
    controller?.abort()
    const requestController = new AbortController()
    controller = requestController
    const requestGeneration = generation
    try {
      const page = await diaryLifeApi.search(query, 20, cursor, requestController.signal)
      if (requestController.signal.aborted || requestGeneration !== generation || query !== activeQuery) return null
      nextCursor = page.nextCursor
      return { id: 'diary', label: '日记', results: page.items.map(item => makeResult(item, query)) }
    } catch {
      if (requestController.signal.aborted || requestGeneration !== generation) return null
      nextCursor = cursor
      return { id: 'diary', label: '日记', results: [], error: true }
    } finally {
      if (controller === requestController) controller = null
    }
  }

  provider.clear = () => {
    generation += 1
    controller?.abort()
    controller = null
    activeQuery = ''
    nextCursor = null
  }
  return provider
}
