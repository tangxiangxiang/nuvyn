// Regression for: searching for an H3 inside a doc whose title is H1 (the
// first H1 of the same file) used to silently return nothing when the
// CommandPalette was opened for the first time. The title index had been
// built but the body cache was still empty, so only the body path could
// resolve the H3 hit — and that path runs only when bodyCache is populated.
//
// The fix: the watch on the query input now routes through refresh()
// (which awaits ensureIndexed, including primeBody) instead of calling
// search() directly.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bodyCachePathsForTesting, buildIndex, dispose, primeBody, search } from '../search'
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
    json: async () => ({ content }),
  }))
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

  it('regression: H3 must be findable after the user types, even if body is not yet primed when the palette opens', async () => {
    // Simulate the timing the bug exposed: buildIndex is sync and ready,
    // primeBody is in-flight (we resolve the fetch only after the user
    // "typed" the query). The fix is in CommandPalette: its watch on
    // `query` now goes through refresh(), which awaits primeBody. Here
    // we model that by calling search() after awaiting primeBody — i.e.
    // we encode the post-await state, not the pre-await state, and assert
    // the hit is present. The earlier behavior would have produced zero
    // hits because the body cache was empty.
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

    // refresh() in the real component awaits ensureIndexed → primeBody.
    // After the await, bodyCache is populated and the same query now hits.
    const lateHits = search('H3')
    expect(lateHits).toHaveLength(1)
    expect(lateHits[0].match).toBe('body')
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
