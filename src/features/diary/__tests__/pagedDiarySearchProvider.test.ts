import { describe, expect, it, vi } from 'vitest'
import type { SearchResult } from '../../../lib/searchResults'
import { createPagedDiarySearchProvider } from '../pagedDiarySearchProvider'

type Item = { id: string; title: string; match: 'title' | 'description' }

function mapper(item: Item, query: string): SearchResult {
  return { id: item.id, type: 'diary-event', title: item.title, score: item.match === 'title' ? 2 : 1, payload: { query, match: item.match } }
}

describe('paged private Diary search providers', () => {
  it('returns one bounded page at a time and preserves title-first cursor order', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ items: [{ id: 'title-hit', title: 'title hit', match: 'title' }], nextCursor: 'title-page' })
      .mockResolvedValueOnce({
        items: Array.from({ length: 19 }, (_, index) => ({ id: `description-${index}`, title: 'description hit', match: 'description' as const })),
        nextCursor: 'description-page',
      })
    const provider = createPagedDiarySearchProvider<Item>('events', '事件', request, mapper)

    const section = await provider('  phrase  ')
    expect(section.results).toHaveLength(1)
    expect(section.results[0]?.id).toBe('title-hit')
    expect(section.hasMore).toBe(true)
    expect(request).toHaveBeenCalledTimes(1)

    const secondPage = await provider.loadMore!('phrase')
    expect(secondPage?.results).toHaveLength(19)
    expect(secondPage?.results[0]?.id).toBe('description-0')
    expect(secondPage?.hasMore).toBe(true)

    request.mockResolvedValueOnce({ items: [{ id: 'description-20', title: 'another description hit', match: 'description' }], nextCursor: null })
    const more = await provider.loadMore!('phrase')
    expect(more?.results.map(result => result.id)).toEqual(['description-20'])
    expect(more?.hasMore).toBe(false)
    expect(request.mock.calls.map(call => call.slice(0, 2))).toEqual([
      ['phrase', null],
      ['phrase', 'title-page'],
      ['phrase', 'description-page'],
    ])
  })

  it('clears private cursor state and aborts the active request', async () => {
    let resolve!: (value: { items: Item[]; nextCursor: string | null }) => void
    const request = vi.fn((_query: string, _cursor: string | null, signal: AbortSignal) => new Promise<{ items: Item[]; nextCursor: string | null }>(done => {
      resolve = done
      signal.addEventListener('abort', () => done({ items: [], nextCursor: null }), { once: true })
    }))
    const provider = createPagedDiarySearchProvider<Item>('events', '事件', request, mapper)
    const pending = provider('private phrase')
    provider.clear?.()

    expect(request.mock.calls[0]?.[2].aborted).toBe(true)
    expect((await pending).results).toEqual([])
    expect(await provider.loadMore!('private phrase')).toBeNull()
    resolve?.({ items: [], nextCursor: null })
  })
})
