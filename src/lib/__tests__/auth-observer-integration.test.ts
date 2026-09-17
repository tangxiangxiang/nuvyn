import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAiSettings } from '../ai-api'
import { SavePostConflictError, savePost } from '../api'
import { getStatus, HistoryApiError } from '../history-api'
import { resetAuthSessionForTesting, subscribeAuthSessionRequired } from '../auth-session'

afterEach(() => {
  resetAuthSessionForTesting()
  vi.restoreAllMocks()
})

describe('application fetch wrappers and auth-session observer', () => {
  it('does not turn an AI provider 401 into Nuvyn session expiry', async () => {
    const expired = vi.fn()
    const stop = subscribeAuthSessionRequired(expired)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ error: 'provider rejected credentials', code: 'ai-authentication-failed' }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    ))

    await expect(getAiSettings()).rejects.toMatchObject({ status: 401, code: 'ai-authentication-failed' })
    expect(expired).not.toHaveBeenCalled()
    stop()
  })

  it('keeps SavePost conflict parsing intact', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({
        error: 'document changed on disk',
        code: 'EDIT_CONFLICT',
        current: { raw: '# disk', mtime: 2, size: 6 },
      }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    ))
    await expect(savePost('inbox/note', '# local', '# base')).rejects.toBeInstanceOf(SavePostConflictError)
  })

  it('keeps History Git-unavailable semantics intact', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ dirty: [], available: false }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    ))
    await expect(getStatus()).resolves.toEqual({ dirty: [], available: false })

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response(
      JSON.stringify({ error: 'history failed', code: 'HISTORY_FAILED' }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    ))
    await expect(getStatus()).rejects.toBeInstanceOf(HistoryApiError)
  })
})
