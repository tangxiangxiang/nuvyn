import { afterEach, describe, expect, it, vi } from 'vitest'
import { diaryLifeApi } from '../../../lib/diary-life-api'
import { createDiarySearchProvider } from '../diarySearchProvider'

vi.mock('../../../lib/diary-life-api', () => ({
  diaryLifeApi: { search: vi.fn() },
}))

describe('Diary search provider', () => {
  afterEach(() => vi.resetAllMocks())

  it('does not search empty queries and maps hits to private Diary results', async () => {
    vi.mocked(diaryLifeApi.search).mockResolvedValue({
      items: [{ date: '2026-11-15', entryId: 'entry-id', snippet: '早餐吃了南瓜饼', match: 'entry' }],
      nextCursor: null,
    })
    const provider = createDiarySearchProvider()

    expect((await provider('   ')).results).toEqual([])
    expect(diaryLifeApi.search).not.toHaveBeenCalled()

    const section = await provider(' 南瓜饼 ')
    expect(section).toMatchObject({ id: 'diary', label: '日记' })
    expect(section.results).toEqual([expect.objectContaining({
      id: 'diary:2026-11-15',
      type: 'diary-day',
      title: '2026-11-15',
      payload: { date: '2026-11-15', entryId: 'entry-id', snippet: '早餐吃了南瓜饼', match: 'entry', query: '南瓜饼' },
    })])
    expect(diaryLifeApi.search).toHaveBeenCalledWith('南瓜饼', 20, null, expect.any(AbortSignal))
  })

  it('requests the next cursor page only for the active query', async () => {
    vi.mocked(diaryLifeApi.search)
      .mockResolvedValueOnce({ items: [{ date: '2026-11-15', snippet: 'first match', match: 'entry', entryIndex: 0 }], nextCursor: '2026-11-15' })
      .mockResolvedValueOnce({ items: [{ date: '2026-11-14', snippet: 'second match', match: 'entry', entryIndex: 1 }], nextCursor: null })
    const provider = createDiarySearchProvider()
    await provider('match')

    const page = await provider.loadMore!('match')
    expect(page?.results).toHaveLength(1)
    expect(page?.results[0]?.title).toBe('2026-11-14')
    expect(diaryLifeApi.search).toHaveBeenLastCalledWith('match', 20, '2026-11-15', expect.any(AbortSignal))
    expect(await provider.loadMore!('different')).toBeNull()
  })

  it('clears private state and aborts outstanding requests', async () => {
    vi.mocked(diaryLifeApi.search).mockImplementation((_query, _limit, _cursor, signal) => new Promise((done) => {
      expect(signal?.aborted).toBe(false)
      signal?.addEventListener('abort', () => done({ items: [], nextCursor: null }), { once: true })
    }))
    const provider = createDiarySearchProvider()
    const pending = provider('private phrase')
    provider.clear?.()
    expect((await pending).results).toEqual([])
    expect(await provider.loadMore!('private phrase')).toBeNull()
    expect(vi.mocked(diaryLifeApi.search).mock.calls[0]?.[3]?.aborted).toBe(true)
  })

  it('returns a visible failure state for search API errors', async () => {
    vi.mocked(diaryLifeApi.search).mockRejectedValue(new Error('private server error'))
    const section = await createDiarySearchProvider()('marker')
    expect(section).toMatchObject({ id: 'diary', error: true, results: [] })
    expect(JSON.stringify(section)).not.toContain('private server error')
  })
})
