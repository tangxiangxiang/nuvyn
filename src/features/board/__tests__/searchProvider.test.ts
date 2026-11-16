import { describe, expect, it, vi } from 'vitest'
import { createLatestSearchRunner } from '../../../lib/searchResults'
import { createBoardSearchProvider } from '../searchProvider'

describe('Board search provider', () => {
  it('maps title and saved-body matches to the existing Board result type', async () => {
    const search = vi.fn(async () => ({
      items: [
        { boardId: 'exact', title: '死锁', match: 'title' as const, revision: 3, updatedAt: 10 },
        {
          boardId: 'body', title: 'Java 并发', match: 'body' as const, revision: 4, updatedAt: 20,
          snippet: '死锁的四个必要条件', elementId: 'text-4',
        },
      ],
    }))
    const provider = createBoardSearchProvider(search)

    const section = await provider(' 死锁 ')

    expect(search).toHaveBeenCalledWith('死锁')
    expect(section).toMatchObject({ id: 'boards', label: '白板' })
    expect(section.results).toEqual([
      {
        id: 'board:exact', type: 'board', title: '死锁', score: 0,
        payload: { boardId: 'exact', match: 'title', revision: 3 },
      },
      {
        id: 'board:body', type: 'board', title: 'Java 并发', score: 0,
        payload: {
          boardId: 'body', match: 'body', revision: 4,
          snippet: '死锁的四个必要条件', elementId: 'text-4',
        },
      },
    ])
    expect(section.results[1]?.subtitle).toBeUndefined()
  })

  it('does not request recommendations for an empty query', async () => {
    const search = vi.fn(async () => ({ items: [] }))
    const provider = createBoardSearchProvider(search)

    await expect(provider(' \n ')).resolves.toMatchObject({ id: 'boards', label: '白板', results: [] })
    expect(search).not.toHaveBeenCalled()
  })

  it('prevents an older slow query from replacing the latest result section', async () => {
    const pending = new Map<string, (value: { items: Array<{
      boardId: string
      title: string
      match: 'title'
      revision: number
      updatedAt: number
    }> }) => void>()
    const provider = createBoardSearchProvider((query) => new Promise((resolve) => {
      pending.set(query, resolve)
    }))
    const applied: string[][] = []
    const run = createLatestSearchRunner(() => [provider], (sections) => {
      applied.push(sections.flatMap((section) => section.results.map((result) => result.title)))
    })

    const oldRequest = run('old')
    const newRequest = run('new')
    pending.get('new')?.({ items: [{ boardId: 'new', title: 'Newest', match: 'title', revision: 1, updatedAt: 2 }] })
    await newRequest
    pending.get('old')?.({ items: [{ boardId: 'old', title: 'Stale', match: 'title', revision: 1, updatedAt: 1 }] })
    await oldRequest

    expect(applied).toEqual([['Newest']])
  })
})
