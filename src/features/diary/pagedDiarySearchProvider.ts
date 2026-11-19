import type { SearchProvider, SearchResult, SearchResultSection } from '../../lib/searchResults'

export interface DiarySearchProviderPage<T> { items: T[]; nextCursor: string | null }
export type DiarySearchPageRequest<T> = (query: string, cursor: string | null, signal: AbortSignal) => Promise<DiarySearchProviderPage<T>>
export type DiarySearchResultMapper<T> = (item: T, query: string) => SearchResult

/** Keeps each encrypted Diary provider's cursor, cancellation, and private result lifetime local. */
export function createPagedDiarySearchProvider<T>(
  id: string,
  label: string,
  requestPage: DiarySearchPageRequest<T>,
  mapItem: DiarySearchResultMapper<T>,
): SearchProvider {
  let activeQuery = ''
  let nextCursor: string | null = null
  let controller: AbortController | null = null
  let generation = 0

  const provider: SearchProvider = async rawQuery => {
    const query = rawQuery.trim()
    controller?.abort()
    controller = null
    generation += 1
    activeQuery = query
    nextCursor = null
    if (!query) return { id, label, results: [], showLabel: true }
    const requestController = new AbortController()
    controller = requestController
    const requestGeneration = generation
    try {
      const page = await requestPage(query, null, requestController.signal)
      if (requestController.signal.aborted || requestGeneration !== generation) return { id, label, results: [], showLabel: true }
      nextCursor = page.nextCursor
      return { id, label, results: page.items.map(item => mapItem(item, query)), showLabel: true, hasMore: nextCursor !== null }
    } catch {
      if (requestController.signal.aborted || requestGeneration !== generation) return { id, label, results: [], showLabel: true }
      nextCursor = null
      return { id, label, results: [], error: true, showLabel: true }
    } finally {
      if (controller === requestController) controller = null
    }
  }

  provider.loadMore = async rawQuery => {
    const query = rawQuery.trim()
    const cursor = nextCursor
    if (!query || query !== activeQuery || !cursor) return null
    controller?.abort()
    const requestController = new AbortController()
    controller = requestController
    const requestGeneration = generation
    try {
      const page = await requestPage(query, cursor, requestController.signal)
      if (requestController.signal.aborted || requestGeneration !== generation || query !== activeQuery) return null
      nextCursor = page.nextCursor
      return {
        id,
        label,
        results: page.items.map(item => mapItem(item, query)),
        showLabel: true,
        hasMore: nextCursor !== null,
      } satisfies SearchResultSection
    } catch {
      if (requestController.signal.aborted || requestGeneration !== generation) return null
      return { id, label, results: [], error: true, showLabel: true }
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
