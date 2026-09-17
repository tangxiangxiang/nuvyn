import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  advanceAuthSessionGeneration,
  authFetch,
  captureAuthSessionGeneration,
  diaryAuthFetch,
  observeAuthSessionResponse,
  resetAuthSessionForTesting,
  subscribeDiaryAccessLocked,
  subscribeAuthSessionRequired,
} from '../auth-session'
import {
  getDiaryCapability,
  resetDiaryCapabilityForTesting,
  setDiaryCapability,
} from '../diary-capability'

afterEach(() => {
  resetAuthSessionForTesting()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetDiaryCapabilityForTesting()
})

describe('auth-session response observer', () => {
  it.each([
    [401, { code: 'auth-session-required' }, true],
    [401, { code: 'ai-authentication-failed' }, false],
    [401, { code: 'openai-tools-unsupported' }, false],
    [401, {}, false],
    [401, null, false],
    [403, { code: 'auth-session-required' }, false],
    [500, { code: 'auth-session-required' }, false],
  ])('classifies status=%s body=%o as %s', async (status, body, expected) => {
    const response = new Response(body === null ? 'not json' : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
    await expect(observeAuthSessionResponse(response)).resolves.toBe(expected)
  })

  it('uses a clone and leaves the original response readable', async () => {
    const response = new Response(JSON.stringify({ error: 'Authentication required.', code: 'auth-session-required' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
    await expect(observeAuthSessionResponse(response)).resolves.toBe(true)
    await expect(response.json()).resolves.toEqual({
      error: 'Authentication required.',
      code: 'auth-session-required',
    })
  })

  it('emits one event with the request generation', async () => {
    const listener = vi.fn()
    const stop = subscribeAuthSessionRequired(listener)
    const requestGeneration = captureAuthSessionGeneration()
    const response = new Response(JSON.stringify({ code: 'auth-session-required' }), { status: 401 })
    await observeAuthSessionResponse(response, requestGeneration)
    expect(listener).toHaveBeenCalledWith({ generation: requestGeneration })
    stop()
    advanceAuthSessionGeneration()
  })
})

describe('explicit Diary request session boundary', () => {
  it('does not send an in-memory capability on an ordinary authenticated request', async () => {
    const capability = 'a'.repeat(43)
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('X-Nuvyn-Diary-Capability')).toBeNull()
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    setDiaryCapability(capability)

    await expect(authFetch('/api/posts/inbox/ordinary-note')).resolves.toMatchObject({ status: 200 })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('allows an explicit Diary operation to use a generic Vault endpoint', async () => {
    const capability = 'a'.repeat(43)
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('X-Nuvyn-Diary-Capability')).toBe(capability)
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    setDiaryCapability(capability)

    await expect(diaryAuthFetch('/api/files/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })).resolves.toMatchObject({ status: 200 })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('sends the opaque capability only through the explicit Diary seam', async () => {
    const capability = 'a'.repeat(43)
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('X-Nuvyn-Diary-Capability')).toBe(capability)
      return new Response(JSON.stringify({ error: 'Diary access is locked.', code: 'diary-locked' }), {
        status: 423,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    setDiaryCapability(capability)
    const locked = vi.fn()
    const unsubscribe = subscribeDiaryAccessLocked(locked)

    const response = await diaryAuthFetch('/api/posts/diary/2026-08-27')

    expect(response.status).toBe(423)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(locked).toHaveBeenCalledOnce()
    // The observer only signals the session owner. The capability is cleared
    // by useDiaryAccessSession, so this low-level test keeps that ownership
    // distinction explicit.
    expect(getDiaryCapability()).toBe(capability)
    unsubscribe()
  })
})
