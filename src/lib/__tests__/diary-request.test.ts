import { afterEach, describe, expect, it, vi } from 'vitest'
import { authFetchForPath } from '../diary-request'
import { resetDiaryCapabilityForTesting, setDiaryCapability } from '../diary-capability'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetDiaryCapabilityForTesting()
})

describe('path-scoped Diary request seam', () => {
  it('keeps generic shared post requests ordinary for Notes and explicit for managed Diary', async () => {
    const capability = 'a'.repeat(43)
    const headers: Array<string | null> = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      headers.push(new Headers(init?.headers).get('X-Nuvyn-Diary-Capability'))
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    setDiaryCapability(capability)

    await authFetchForPath('inbox/ordinary-note', '/api/posts/inbox/ordinary-note')
    await authFetchForPath('diary/2026-08-27', '/api/posts/diary/2026-08-27')
    await authFetchForPath('diary/2026-08-27.md', '/api/history/file?path=diary%2F2026-08-27.md')

    expect(headers).toEqual([null, capability, capability])
  })
})
