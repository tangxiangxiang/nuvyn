// Search index regressions. Body-only hits appear in search() after
// primeBody finishes; the provider's metadata-first refresh contract is
// covered in searchResults.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bodyCachePathsForTesting, buildIndex, dispose, primeBody, rebuildIndex, search } from '../search'
import type { PostSummary } from '../api'

const post: PostSummary = {
  path: 'inbox/markdown-syntax',
  title: 'H1',                    // title comes from the first H1 of the body
  created: '',
  updated: '',
  tags: ['markdown', 'reference'],
  summary: 'Headings, lists, code, links — the essentials.',
  size: 0,
  mtime: 0,
}

const body = `---
title: Markdown syntax quick reference
---

# H1
## H2
### H3

- bullet
- list
`

function fakeFetchOk(content: string) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ content }),
  }))
}

function makePost(path: string, title: string, mtime = 1): PostSummary {
  return { ...post, path, title, mtime }
}

describe('search', () => {
  beforeEach(() => {
    dispose()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    dispose()
  })

  it('finds H1 in the title index without needing body', () => {
    buildIndex([post])
    const hits = search('H1')
    expect(hits).toHaveLength(1)
    expect(hits[0].match).toBe('title')
  })

  it('finds H3 via the body fallback when only the body matches', async () => {
    // Pretend the body endpoint is ready before the user starts typing.
    vi.stubGlobal('fetch', fakeFetchOk(body))
    const { primeBody } = await import('../search')
    buildIndex([post])
    await primeBody([post])

    const hits = search('H3')
    expect(hits).toHaveLength(1)
    expect(hits[0].path).toBe(post.path)
    expect(hits[0].match).toBe('body')
  })

  it('finds a body-only H3 after background priming completes', async () => {
    let resolveFetch!: (v: unknown) => void
    const fetchPromise = new Promise((res) => { resolveFetch = res })
    vi.stubGlobal('fetch', vi.fn(() => fetchPromise))

    buildIndex([post])
    const { primeBody } = await import('../search')
    const priming = primeBody([post])

    // Simulate the user typing "H3" before the fetch returned.
    const earlyHits = search('H3')
    expect(earlyHits).toHaveLength(0)         // body still empty

    // Now the fetch completes (server returned the body).
    resolveFetch({
      ok: true,
      json: async () => ({ content: body }),
    })
    await priming

    // Once priming completes, the same query can find the body-only match.
    const lateHits = search('H3')
    expect(lateHits).toHaveLength(1)
    expect(lateHits[0].match).toBe('body')
  })

  it('limits concurrent body priming requests to six', async () => {
    const posts = Array.from({ length: 8 }, (_, index) => makePost(`inbox/concurrency-${index}`, `Note ${index}`, index + 1))
    const pending: Array<(response: unknown) => void> = []
    let active = 0
    let maxActive = 0
    const fetchMock = vi.fn(() => new Promise<unknown>((resolve) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      pending.push((response) => {
        active -= 1
        resolve(response)
      })
    }))
    vi.stubGlobal('fetch', fetchMock)
    buildIndex(posts)

    const priming = primeBody(posts)

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6))
    expect(active).toBe(6)
    expect(maxActive).toBeLessThanOrEqual(6)

    for (let completed = 0; completed < posts.length; completed += 1) {
      const release = pending.shift()
      expect(release).toBeDefined()
      release?.({ ok: true, status: 200, json: async () => ({ content: '' }) })
      const expectedStarted = Math.min(6 + completed + 1, posts.length)
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(expectedStarted))
    }

    await expect(priming).resolves.toBe(true)
    expect(maxActive).toBeLessThanOrEqual(6)
    expect(active).toBe(0)
  })

  it('does not cache or return an old path when a body request resolves after index rebuild', async () => {
    const oldPost = makePost('inbox/old-note', 'Old note')
    const newPost = makePost('archive/renamed-note', 'Renamed note')
    let resolveFetch!: (response: unknown) => void
    const fetchMock = vi.fn(() => new Promise<unknown>((resolve) => { resolveFetch = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    buildIndex([oldPost])

    const priming = primeBody([oldPost])
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    rebuildIndex([newPost])
    resolveFetch({ ok: true, status: 200, json: async () => ({ content: 'legacysecretphrase' }) })

    await expect(priming).resolves.toBe(false)
    expect(bodyCachePathsForTesting()).not.toContain(oldPost.path)
    expect(search('legacysecretphrase').some((hit) => hit.path === oldPost.path)).toBe(false)
  })

  it('classifies fuzzy title hits using MiniSearch matched fields', () => {
    const redis = makePost('inbox/redis-reference', 'Redis')
    buildIndex([redis])

    expect(search('Rdis')[0]).toMatchObject({ path: redis.path, match: 'title' })
  })

  it('regression: primeBody must use encodeURI on the path, not encodeURIComponent', async () => {
    // The splat route /api/posts/* expects raw `/` between segments, not
    // %2F. encodeURIComponent turns `inbox/markdown-syntax` into
    // `inbox%2Fmarkdown-syntax` and the server rejects it with 400 (its
    // path regex would never see a `/` in a segment, so a %2F path
    // matches no segment pattern and is treated as an invalid path
    // string). The fix: primeBody uses encodeURI, which leaves the
    // reserved `/` alone. This test pins the URL shape by asserting
    // the path the fetch sees contains raw `/` separators.
    const seenUrls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      seenUrls.push(url)
      return { ok: true, json: async () => ({ content: body }) }
    }))

    const { primeBody } = await import('../search')
    await primeBody([post])

    expect(seenUrls).toHaveLength(1)
    expect(seenUrls[0]).toBe('/api/posts/inbox/markdown-syntax')
    expect(seenUrls[0]).not.toContain('%2F')
  })

  it('keeps managed Diary body/title metadata out of search and bodyCache', async () => {
    const diary: PostSummary = {
      ...post,
      path: 'diary/2026-08-31',
      title: 'Private Diary title',
      tags: ['private-tag'],
      summary: 'D8_3_BODY_SECRET_summary',
      mtime: 1,
    }
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ content: 'D8_3_BODY_SECRET_content' }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    buildIndex([diary])

    await primeBody([diary])

    expect(fetchMock).not.toHaveBeenCalled()
    expect(bodyCachePathsForTesting()).not.toContain(diary.path)
    expect(search('Private Diary title')).toEqual([])
    expect(search('D8_3_BODY_SECRET_summary')).toEqual([])
    expect(search('D8_3_BODY_SECRET_content')).toEqual([])
    expect(search('2026-08-31')[0]?.path).toBe(diary.path)
  })
})
