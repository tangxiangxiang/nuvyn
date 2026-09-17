import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthApiError, getAuthStatus, login, setupOwner } from '../auth-api'

afterEach(() => vi.restoreAllMocks())

describe('auth API wire contracts', () => {
  it('sends only setup fields and uses same-origin credentials', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ authenticated: true, user: { id: 1, username: 'owner' } }), { status: 201 }),
    )
    await setupOwner({ bootstrapToken: 'token', username: 'owner', password: 'password' })
    const [, init] = fetchMock.mock.calls[0]!
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin' })
    expect(JSON.parse(String(init?.body))).toEqual({
      bootstrapToken: 'token',
      username: 'owner',
      password: 'password',
    })
    expect(JSON.stringify(init?.body)).not.toContain('confirmPassword')
  })

  it('preserves safe error code and bounded Retry-After', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Invalid username or password.', code: 'invalid-credentials' }), {
        status: 401,
        headers: { 'content-type': 'application/json', 'Retry-After': '12' },
      }),
    )
    await expect(login({ username: 'owner', password: 'wrong' })).rejects.toMatchObject({
      name: 'AuthApiError',
      status: 401,
      code: 'invalid-credentials',
      retryAfterSeconds: 12,
    })
  })

  it('fails closed for malformed status responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ authenticated: true }), { status: 200 }))
    await expect(getAuthStatus()).rejects.toBeInstanceOf(AuthApiError)
  })
})
