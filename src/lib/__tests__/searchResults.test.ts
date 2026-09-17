import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDocumentSearchProvider, createLatestSearchRunner, invalidateDocumentSearchState, searchEverywhere, type SearchProvider, type SearchResultSection } from '../searchResults'
import { dispose } from '../search'
import type { PostSummary } from '../api'
import { createDocumentSearchSource } from '../documentSearchSource'

const makePost = (path: string, title: string, summary = ''): PostSummary => ({ path, title, created: '', updated: '', tags: [], summary, size: 0, mtime: 1 })

describe('Search Everywhere document provider', () => {
  beforeEach(() => dispose())
  afterEach(() => { vi.unstubAllGlobals(); dispose() })

  it('finds title, path, summary, and body-only matches with snippets', async () => {
    const posts = [makePost('inbox/redis-notes', 'Redis Notes', 'cache reference')]
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ content: 'distributed transaction isolation guarantees' }) })))
    const provider = createDocumentSearchProvider(() => posts)

    expect((await provider('Redis')).results[0].payload).toMatchObject({ match: 'title' })
    expect((await provider('redis-notes')).results[0].payload).toMatchObject({ match: 'path' })
    expect((await provider('cache reference')).results[0].payload).toMatchObject({ match: 'summary' })
    const body = (await provider('transaction isolation')).results[0]
    expect(body.title).toBe('Redis Notes')
    expect(body.payload).toMatchObject({ match: 'body' })
    expect((body.payload as { snippet?: string }).snippet).toContain('transaction isolation')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('rebuilds metadata when posts change', async () => {
    let posts = [makePost('inbox/old', 'Old')]
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ content: '' }) })))
    const provider = createDocumentSearchProvider(() => posts)
    expect((await provider('Old')).results).toHaveLength(1)
    posts = [makePost('inbox/new', 'New')]
    expect((await provider('New')).results[0].title).toBe('New')
    expect((await provider('Old')).results).toHaveLength(0)
  })

  it('loads document metadata without a VaultView consumer', async () => {
    const source = createDocumentSearchSource(async () => [makePost('inbox/atlas', 'Project Atlas')])
    const provider = createDocumentSearchProvider(source)

    const result = await provider('atlas')

    expect(result.results[0]).toMatchObject({ title: 'Project Atlas', payload: { path: 'inbox/atlas' } })
  })

  it('refetches and replaces cached body content when mtime changes', async () => {
    let posts = [makePost('inbox/redis', 'Redis')]
    const bodies = ['old unique phrase', 'new unique phrase']
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ content: bodies.shift() ?? '' }) }))
    vi.stubGlobal('fetch', fetchMock)
    const provider = createDocumentSearchProvider(() => posts)

    expect((await provider('old unique phrase')).results).toHaveLength(1)
    posts = [{ ...posts[0], mtime: 2 }]
    expect((await provider('new unique phrase')).results).toHaveLength(1)
    expect((await provider('old unique phrase')).results).toHaveLength(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('composes future providers as independent sections', async () => {
    const posts = [makePost('inbox/redis', 'Redis')]
    const future: SearchProvider = () => ({ id: 'commands', label: 'Commands', results: [{ id: 'command:open', type: 'command', title: 'Open', score: 1, payload: {} }] })
    const sections = await searchEverywhere('', [createDocumentSearchProvider(() => posts), future])
    expect(sections.map((section) => section.id)).toEqual(['files', 'commands'])
  })

  it('keeps document results when an optional provider fails', async () => {
    const posts = [makePost('inbox/redis', 'Redis')]
    const failing: SearchProvider = async () => { throw new Error('board unavailable') }

    const sections = await searchEverywhere('', [createDocumentSearchProvider(() => posts), failing])

    expect(sections.map((section) => section.id)).toEqual(['files'])
  })

  it('prevents an older async query from replacing newer results', async () => {
    let resolveOld!: (section: SearchResultSection) => void
    const oldResult = new Promise<SearchResultSection>((resolve) => { resolveOld = resolve })
    const provider: SearchProvider = (query) => query === 'old'
      ? oldResult
      : { id: 'files', label: 'Files', results: [{ id: 'file:new', type: 'file', title: 'New', score: 1, payload: { path: 'new' } }] }
    let applied: SearchResultSection[] = []
    const run = createLatestSearchRunner(() => [provider], (sections) => { applied = sections })
    const old = run('old')
    await run('new')
    resolveOld({ id: 'files', label: 'Files', results: [{ id: 'file:old', type: 'file', title: 'Old', score: 1, payload: { path: 'old' } }] })
    await old
    expect(applied[0].results[0].title).toBe('New')
  })

  it('drops a result that resolves after the Diary search epoch advances', async () => {
    let resolveSearch!: (section: SearchResultSection) => void
    const delayed = new Promise<SearchResultSection>((resolve) => { resolveSearch = resolve })
    const provider: SearchProvider = () => delayed
    let applied: SearchResultSection[] = []
    const run = createLatestSearchRunner(() => [provider], (sections) => { applied = sections })
    const request = run('D8_3_BODY_SECRET')
    invalidateDocumentSearchState()
    resolveSearch({
      id: 'files',
      label: 'Files',
      results: [{
        id: 'file:diary/2026-08-31',
        type: 'file',
        title: '2026-08-31',
        score: 1,
        payload: { path: 'diary/2026-08-31', match: 'path' },
      }],
    })
    await request
    expect(applied).toEqual([])
  })
})
