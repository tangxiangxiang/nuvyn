import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDocumentSearchProvider, createLatestSearchRunner, invalidateDocumentSearchState, searchEverywhere, type SearchProvider, type SearchResultSection } from '../searchResults'
import { dispose } from '../search'
import type { PostSummary } from '../api'
import { createDocumentSearchSource } from '../documentSearchSource'

const makePost = (path: string, title: string, summary = ''): PostSummary => ({ path, title, created: '', updated: '', tags: [], summary, size: 0, mtime: 1 })

function nextProviderUpdate(provider: SearchProvider): Promise<void> {
  return new Promise((resolve) => {
    let unsubscribe = () => {}
    unsubscribe = provider.subscribe?.(() => {
      unsubscribe()
      resolve()
    }) ?? (() => {})
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('Search Everywhere document provider', () => {
  beforeEach(() => dispose())
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); dispose() })

  it('finds title, path, summary, and body-only matches with snippets', async () => {
    const posts = [makePost('inbox/redis-notes', 'Redis Notes', 'cache reference')]
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ content: 'distributed transaction isolation guarantees' }) })))
    const provider = createDocumentSearchProvider(() => posts)
    const bodyReady = nextProviderUpdate(provider)

    const title = (await provider('Redis')).results[0].payload as Record<string, unknown>
    expect(title).toMatchObject({ match: 'title' })
    expect(title).not.toHaveProperty('bodyQuery')
    expect((await provider('inbox')).results[0].payload).toMatchObject({ match: 'path' })
    expect((await provider('cache reference')).results[0].payload).toMatchObject({ match: 'summary' })
    await bodyReady
    const body = (await provider('transaction isolation')).results[0]
    expect(body.title).toBe('Redis Notes')
    expect(body.payload).toMatchObject({ match: 'body', bodyQuery: 'transaction isolation' })
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
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })))
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
    const oldBodyReady = nextProviderUpdate(provider)

    expect((await provider('old unique phrase')).results).toHaveLength(0)
    await oldBodyReady
    expect((await provider('old unique phrase')).results).toHaveLength(1)
    posts = [{ ...posts[0], mtime: 2 }]
    const newBodyReady = nextProviderUpdate(provider)
    expect((await provider('new unique phrase')).results).toHaveLength(0)
    await newBodyReady
    expect((await provider('new unique phrase')).results).toHaveLength(1)
    expect((await provider('old unique phrase')).results).toHaveLength(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns metadata hits while the body fetch is still pending', async () => {
    const posts = [makePost('inbox/redis', 'Redis')]
    const response = deferred<unknown>()
    const fetchMock = vi.fn(() => response.promise)
    vi.stubGlobal('fetch', fetchMock)
    const provider = createDocumentSearchProvider(() => posts)
    const update = nextProviderUpdate(provider)

    const section = await provider('Redis')

    expect(section.results).toHaveLength(1)
    expect(section.results[0].payload).toMatchObject({ path: 'inbox/redis', match: 'title' })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    response.resolve({ ok: true, status: 200, json: async () => ({ content: 'Redis body' }) })
    await update
  })

  it('notifies subscribers after body priming so the same query returns body-only hits', async () => {
    const posts = [makePost('inbox/guide', 'Engineering guide')]
    const response = deferred<unknown>()
    vi.stubGlobal('fetch', vi.fn(() => response.promise))
    const provider = createDocumentSearchProvider(() => posts)
    const update = nextProviderUpdate(provider)
    const query = 'bodyonlymarker'

    expect((await provider(query)).results).toHaveLength(0)
    response.resolve({ ok: true, status: 200, json: async () => ({ content: `Contains ${query} in the note body` }) })
    await update

    expect((await provider(query)).results[0].payload).toMatchObject({
      path: posts[0].path,
      match: 'body',
      bodyQuery: query,
    })
  })

  it('retries failed body fetches after the backoff expires', async () => {
    const posts = [makePost('inbox/retry-guide', 'Retry guide')]
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ content: 'retrybodymarker' }) })
    vi.stubGlobal('fetch', fetchMock)
    const provider = createDocumentSearchProvider(() => posts)
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000)
    const firstUpdate = nextProviderUpdate(provider)

    expect((await provider('retrybodymarker')).results).toHaveLength(0)
    await firstUpdate
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await provider('retrybodymarker')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    now.mockReturnValue(101_501)
    const retryUpdate = nextProviderUpdate(provider)
    await provider('retrybodymarker')
    await retryUpdate
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect((await provider('retrybodymarker')).results[0].payload).toMatchObject({ path: posts[0].path, match: 'body' })
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
