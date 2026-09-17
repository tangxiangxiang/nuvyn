import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app, { __setMetadataDbForTesting } from '../index.js'
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../auth/password.js'
import { AUTH_REQUEST_BODY_MAX_BYTES } from '../auth/routes.js'
import { createSession, findSessionByRawToken, revokeSession } from '../auth/session.js'
import {
  closeAuthTestContext,
  cookieFromResponse,
  countRows,
  createAuthTestContext,
  TEST_SETUP_TOKEN,
  jsonRequest,
  type AuthTestContext,
} from './helpers/auth.js'
import { resetAuthRuntimeForTesting } from '../auth/runtime.js'
import type { KdfGuard } from '../auth/kdfGuard.js'

let context: AuthTestContext

beforeEach(() => {
  context = createAuthTestContext()
})

afterEach(() => {
  closeAuthTestContext(context)
})

async function setupOwner(
  token = TEST_SETUP_TOKEN,
  password = 'correct horse battery staple',
): Promise<{ cookie: string; body: any; response: Response }> {
  const response = await app.fetch(jsonRequest('/api/auth/setup', {
    method: 'POST',
    origin: context.runtime.config.publicOrigin,
    body: { bootstrapToken: token, username: 'Admin', password },
  }))
  const body = await response.json()
  return { cookie: cookieFromResponse(response), body, response }
}

describe('Phase 2 auth routes', () => {
  it('reports setup state, creates one owner/session, and never returns secrets', async () => {
    const initial = await app.fetch(new Request('http://localhost/api/auth/status'))
    expect(initial.status).toBe(200)
    expect(initial.headers.get('cache-control')).toBe('no-store')
    expect(await initial.json()).toEqual({ authenticated: false, setupRequired: true })

    const created = await setupOwner()
    expect(created.response.status).toBe(201)
    expect(created.body).toEqual({
      authenticated: true,
      user: { id: 1, username: 'admin' },
    })
    expect(JSON.stringify(created.body)).not.toContain(TEST_SETUP_TOKEN)
    expect(created.response.headers.get('set-cookie')).toMatch(/nuvyn_session=/)
    expect(created.response.headers.get('set-cookie')).toMatch(/HttpOnly/)
    expect(created.response.headers.get('set-cookie')).toMatch(/SameSite=Lax/)
    expect(created.response.headers.get('set-cookie')).toMatch(/Path=\//)
    expect(created.response.headers.get('set-cookie')).toMatch(/Max-Age=2592000/)
    expect(countRows(context.db, 'users')).toBe(1)
    expect(countRows(context.db, 'auth_instance')).toBe(1)
    expect(countRows(context.db, 'auth_sessions')).toBe(1)

    const status = await app.fetch(new Request('http://localhost/api/auth/status', {
      headers: { Cookie: created.cookie },
    }))
    expect(status.status).toBe(200)
    expect(await status.json()).toEqual({
      authenticated: true,
      setupRequired: false,
      user: { id: 1, username: 'admin' },
    })

    const second = await app.fetch(jsonRequest('/api/auth/setup', {
      method: 'POST',
      origin: context.runtime.config.publicOrigin,
      body: { bootstrapToken: 'wrong-token', username: 'other', password: 'correct horse battery staple' },
    }))
    expect(second.status).toBe(409)
    expect(await second.json()).toMatchObject({ code: 'already-initialized' })
  })

  it('uses bootstrap-invalid for both missing and incorrect setup tokens', async () => {
    const missing = await app.fetch(jsonRequest('/api/auth/setup', {
      method: 'POST',
      origin: context.runtime.config.publicOrigin,
      body: { username: 'admin', password: 'correct horse battery staple' },
    }))
    const wrong = await app.fetch(jsonRequest('/api/auth/setup', {
      method: 'POST',
      origin: context.runtime.config.publicOrigin,
      body: { bootstrapToken: 'wrong-token', username: 'admin', password: 'correct horse battery staple' },
    }))
    expect(missing.status).toBe(401)
    expect(await missing.json()).toEqual({ error: 'Bootstrap token is invalid.', code: 'bootstrap-invalid' })
    expect(wrong.status).toBe(401)
    expect(await wrong.json()).toEqual({ error: 'Bootstrap token is invalid.', code: 'bootstrap-invalid' })
  })

  it('runs a concurrent setup race with exactly one owner and no orphan user', async () => {
    closeAuthTestContext(context)
    context = createAuthTestContext()
    const requests = [1, 2].map(() => app.fetch(jsonRequest('/api/auth/setup', {
      method: 'POST',
      origin: context.runtime.config.publicOrigin,
      body: { bootstrapToken: TEST_SETUP_TOKEN, username: 'admin', password: 'correct horse battery staple' },
    })))
    const responses = await Promise.all(requests)
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409])
    expect(countRows(context.db, 'users')).toBe(1)
    expect(countRows(context.db, 'auth_instance')).toBe(1)
  })

  it('accepts the one-time generated fallback token without persisting it', async () => {
    closeAuthTestContext(context)
    context = createAuthTestContext({ fallbackBootstrap: true })
    expect(context.logs).toHaveLength(1)
    const token = context.logs[0]!.split(': ').at(-1)!
    const created = await setupOwner(token)
    expect(created.response.status).toBe(201)
    expect(context.logs).toHaveLength(1)
    const tables = context.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as Array<{ name: string }>
    const serialized = JSON.stringify(tables.map(({ name }) => ({
      name,
      rows: context.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all(),
    })))
    expect(serialized).not.toContain(token)
    expect(serialized).not.toContain(created.cookie.slice(created.cookie.indexOf('=') + 1))
    expect(serialized).not.toContain('correct horse battery staple')
    expect(context.logs.join('\n')).not.toContain('correct horse battery staple')
  })

  it('does not log explicit setup, password, session, or cookie secrets', async () => {
    const created = await setupOwner()
    const rawToken = created.cookie.slice(created.cookie.indexOf('=') + 1)
    const tokenHash = findSessionByRawToken(context.db, rawToken).session?.tokenHash
    expect(tokenHash).toBeDefined()
    expect(context.logs).toEqual([])
    expect(context.logs.join('\n')).not.toContain(TEST_SETUP_TOKEN)
    expect(context.logs.join('\n')).not.toContain('correct horse battery staple')
    expect(context.logs.join('\n')).not.toContain(rawToken)
    expect(context.logs.join('\n')).not.toContain(tokenHash!)
    expect(context.logs.join('\n')).not.toContain(created.cookie)
  })

  it('uses identical generic public failures for wrong, unknown, and disabled owners', async () => {
    const created = await setupOwner()
    const request = (username: string, password: string) => app.fetch(jsonRequest('/api/auth/login', {
      method: 'POST',
      origin: context.runtime.config.publicOrigin,
      body: { username, password },
    }))

    const wrong = await request('admin', 'wrong password')
    const unknown = await request('unknown', 'wrong password')
    context.db.prepare('UPDATE users SET disabled = 1 WHERE id = 1').run()
    const disabled = await request('admin', 'correct horse battery staple')
    expect(wrong.status).toBe(401)
    expect(unknown.status).toBe(401)
    expect(disabled.status).toBe(401)
    const wrongBody = await wrong.json()
    expect(await unknown.json()).toEqual(wrongBody)
    expect(await disabled.json()).toEqual(wrongBody)
    expect(wrongBody).toEqual({ error: 'Invalid username or password.', code: 'invalid-credentials' })
    expect(created.cookie).toMatch(/^nuvyn_session=/)
  })

  it('rejects an oversized login body before parsing or authentication work', async () => {
    closeAuthTestContext(context)
    let kdfCalls = 0
    const instrumentedGuard = {
      run: (..._args: unknown[]) => {
        kdfCalls += 1
        return Promise.resolve(Buffer.alloc(32))
      },
    } as unknown as KdfGuard
    context = createAuthTestContext({ kdfGuard: instrumentedGuard })
    await setupOwner()
    kdfCalls = 0

    const login = vi.spyOn(context.runtime.service, 'login')
    try {
      const response = await app.fetch(jsonRequest('/api/auth/login', {
        method: 'POST',
        origin: context.runtime.config.publicOrigin,
        body: {
          username: 'admin',
          password: 'correct horse battery staple',
          padding: 'x'.repeat(AUTH_REQUEST_BODY_MAX_BYTES),
        },
      }))
      expect(response.status).toBe(413)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toEqual({
        error: 'Authentication request is too large.',
        code: 'auth-request-too-large',
      })
      expect(login).not.toHaveBeenCalled()
      expect(kdfCalls).toBe(0)
      expect(countRows(context.db, 'auth_sessions')).toBe(1)
    } finally {
      login.mockRestore()
    }
  })

  it('rejects an oversized setup body before parsing, token verification, or KDF work', async () => {
    closeAuthTestContext(context)
    let kdfCalls = 0
    const instrumentedGuard = {
      run: (..._args: unknown[]) => {
        kdfCalls += 1
        return Promise.resolve(Buffer.alloc(32))
      },
    } as unknown as KdfGuard
    context = createAuthTestContext({ kdfGuard: instrumentedGuard })
    const verify = vi.spyOn(context.runtime.bootstrap, 'verify')
    const setup = vi.spyOn(context.runtime.service, 'setup')
    try {
      const response = await app.fetch(jsonRequest('/api/auth/setup', {
        method: 'POST',
        origin: context.runtime.config.publicOrigin,
        body: {
          bootstrapToken: TEST_SETUP_TOKEN,
          username: 'admin',
          password: 'correct horse battery staple',
          padding: 'x'.repeat(AUTH_REQUEST_BODY_MAX_BYTES),
        },
      }))
      expect(response.status).toBe(413)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toEqual({
        error: 'Authentication request is too large.',
        code: 'auth-request-too-large',
      })
      expect(setup).not.toHaveBeenCalled()
      expect(verify).not.toHaveBeenCalled()
      expect(kdfCalls).toBe(0)
      expect(countRows(context.db, 'users')).toBe(0)
      expect(countRows(context.db, 'auth_sessions')).toBe(0)
    } finally {
      setup.mockRestore()
      verify.mockRestore()
    }
  })

  it('maps an overlong login password to generic credentials without entering the KDF', async () => {
    closeAuthTestContext(context)
    let kdfCalls = 0
    const instrumentedGuard = {
      run: (..._args: unknown[]) => {
        kdfCalls += 1
        return Promise.resolve(Buffer.alloc(32))
      },
    } as unknown as KdfGuard
    context = createAuthTestContext({ kdfGuard: instrumentedGuard })
    await setupOwner()
    kdfCalls = 0
    const beforeSessions = countRows(context.db, 'auth_sessions')

    const response = await app.fetch(jsonRequest('/api/auth/login', {
      method: 'POST',
      origin: context.runtime.config.publicOrigin,
      body: { username: 'admin', password: 'x'.repeat(PASSWORD_MAX_LENGTH + 1) },
    }))
    expect(response.status).toBe(401)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      error: 'Invalid username or password.',
      code: 'invalid-credentials',
    })
    expect(kdfCalls).toBe(0)
    expect(countRows(context.db, 'auth_sessions')).toBe(beforeSessions)
  })

  it('maps an underlong login password to generic credentials without entering the KDF', async () => {
    closeAuthTestContext(context)
    let kdfCalls = 0
    const instrumentedGuard = {
      run: (..._args: unknown[]) => {
        kdfCalls += 1
        return Promise.resolve(Buffer.alloc(32))
      },
    } as unknown as KdfGuard
    context = createAuthTestContext({ kdfGuard: instrumentedGuard })
    await setupOwner()
    kdfCalls = 0
    const beforeSessions = countRows(context.db, 'auth_sessions')

    const response = await app.fetch(jsonRequest('/api/auth/login', {
      method: 'POST',
      origin: context.runtime.config.publicOrigin,
      body: { username: 'admin', password: 'x'.repeat(PASSWORD_MIN_LENGTH - 1) },
    }))
    expect(response.status).toBe(401)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      error: 'Invalid username or password.',
      code: 'invalid-credentials',
    })
    expect(kdfCalls).toBe(0)
    expect(countRows(context.db, 'auth_sessions')).toBe(beforeSessions)
  })

  it('rejects an oversized login Content-Length before authentication work', async () => {
    closeAuthTestContext(context)
    let kdfCalls = 0
    const instrumentedGuard = {
      run: (..._args: unknown[]) => {
        kdfCalls += 1
        return Promise.resolve(Buffer.alloc(32))
      },
    } as unknown as KdfGuard
    context = createAuthTestContext({ kdfGuard: instrumentedGuard })
    await setupOwner()
    kdfCalls = 0
    const beforeSessions = countRows(context.db, 'auth_sessions')
    const login = vi.spyOn(context.runtime.service, 'login')

    try {
      const request = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(AUTH_REQUEST_BODY_MAX_BYTES + 1),
          Origin: context.runtime.config.publicOrigin,
        },
        body: JSON.stringify({ username: 'admin', password: 'correct horse battery staple' }),
      })
      const response = await app.fetch(request)
      expect(response.status).toBe(413)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toEqual({
        error: 'Authentication request is too large.',
        code: 'auth-request-too-large',
      })
      expect(login).not.toHaveBeenCalled()
      expect(kdfCalls).toBe(0)
      expect(countRows(context.db, 'auth_sessions')).toBe(beforeSessions)
    } finally {
      login.mockRestore()
    }
  })

  it('accepts a login password at PASSWORD_MAX_LENGTH', async () => {
    const password = 'x'.repeat(PASSWORD_MAX_LENGTH)
    const created = await setupOwner(TEST_SETUP_TOKEN, password)
    expect(created.response.status).toBe(201)

    const response = await app.fetch(jsonRequest('/api/auth/login', {
      method: 'POST',
      origin: context.runtime.config.publicOrigin,
      body: { username: 'admin', password },
    }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      authenticated: true,
      user: { id: 1, username: 'admin' },
    })
  })

  it('does not pre-lock a hot username bucket before verifying a correct password', async () => {
    closeAuthTestContext(context)
    context = createAuthTestContext({ rateLimiterOptions: { threshold: 2, baseRetryMs: 10, maxDelayMs: 100 } })
    await setupOwner()
    const login = (password: string) => app.fetch(jsonRequest('/api/auth/login', {
      method: 'POST',
      origin: context.runtime.config.publicOrigin,
      body: { username: 'admin', password },
    }))
    expect((await login('wrong password')).status).toBe(401)
    expect((await login('wrong password')).status).toBe(429)
    const correct = await login('correct horse battery staple')
    expect(correct.status).toBe(200)
    expect(context.runtime.loginLimiter.size).toBe(0)
  })

  it('creates a fresh session for every successful login', async () => {
    await setupOwner()
    const login = () => app.fetch(jsonRequest('/api/auth/login', {
      method: 'POST',
      origin: context.runtime.config.publicOrigin,
      body: { username: 'admin', password: 'correct horse battery staple' },
    }))
    const first = await login()
    const second = await login()
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(cookieFromResponse(first)).not.toBe(cookieFromResponse(second))
    expect(countRows(context.db, 'auth_sessions')).toBe(3)
  })

  it('logout is idempotent, reads only the active profile, and clears both cookie names', async () => {
    const created = await setupOwner()
    const logout = await app.fetch(jsonRequest('/api/auth/logout', {
      method: 'POST',
      origin: context.runtime.config.publicOrigin,
      cookie: created.cookie,
    }))
    expect(logout.status).toBe(204)
    const setCookies = (logout.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [logout.headers.get('set-cookie') ?? '']
    expect(setCookies.some((value) => value.startsWith('__Host-nuvyn_session=') || value.startsWith('nuvyn_session='))).toBe(true)
    expect(setCookies.join('\n')).toContain('__Host-nuvyn_session=')
    expect(setCookies.join('\n')).toContain('nuvyn_session=')
    const status = await app.fetch(new Request('http://localhost/api/auth/status', {
      headers: { Cookie: created.cookie },
    }))
    expect(await status.json()).toEqual({ authenticated: false, setupRequired: false })

    const noCookieLogout = await app.fetch(jsonRequest('/api/auth/logout', {
      method: 'POST',
      origin: context.runtime.config.publicOrigin,
    }))
    expect(noCookieLogout.status).toBe(204)
  })

  it('keeps stale and already-revoked sessions idempotent', async () => {
    const created = await setupOwner()
    const rawToken = created.cookie.slice(created.cookie.indexOf('=') + 1)
    expect(revokeSession(context.db, rawToken)).toBe(true)

    const revoked = await app.fetch(jsonRequest('/api/auth/logout', {
      method: 'POST',
      origin: context.runtime.config.publicOrigin,
      cookie: created.cookie,
    }))
    expect(revoked.status).toBe(204)

    context.db.prepare('DELETE FROM auth_sessions').run()
    const stale = await app.fetch(jsonRequest('/api/auth/logout', {
      method: 'POST',
      origin: context.runtime.config.publicOrigin,
      cookie: created.cookie,
    }))
    expect(stale.status).toBe(204)
  })

  it('does not report logout success when server-side revoke fails', async () => {
    const created = await setupOwner()
    context.db.close()

    const failed = await app.fetch(jsonRequest('/api/auth/logout', {
      method: 'POST',
      origin: context.runtime.config.publicOrigin,
      cookie: created.cookie,
    }))
    expect(failed.status).toBe(503)
    expect(await failed.json()).toEqual({
      error: 'Authentication is temporarily unavailable.',
      code: 'auth-unavailable',
    })
    const setCookies = (failed.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.()
      ?? [failed.headers.get('set-cookie') ?? '']
    expect(setCookies.join('\n')).toContain('__Host-nuvyn_session=')
    expect(setCookies.join('\n')).toContain('nuvyn_session=')
  })

  it('never accepts the alternate secure cookie in a local HTTP profile', async () => {
    await setupOwner()
    const created = createSession(context.db, 1, { now: Date.now() })
    const status = await app.fetch(new Request('http://localhost/api/auth/status', {
      headers: { Cookie: `__Host-nuvyn_session=${created.rawToken}` },
    }))
    expect(await status.json()).toEqual({ authenticated: false, setupRequired: false })
    expect(findSessionByRawToken(context.db, created.rawToken).status).toBe('valid')
  })

  it('uses secure __Host cookies for HTTPS origins', async () => {
    closeAuthTestContext(context)
    context = createAuthTestContext({ origin: 'https://nuvyn.example.com' })
    const created = await setupOwner()
    const header = created.response.headers.get('set-cookie')!
    expect(header).toMatch(/^__Host-nuvyn_session=/)
    expect(header).toMatch(/Secure/)
    expect(header).toMatch(/HttpOnly/)
    expect(header).toMatch(/SameSite=Lax/)
    expect(header).toMatch(/Path=\//)
    expect(header).not.toMatch(/Domain=/)
  })

  it('rejects cross-origin/cross-site mutations and non-JSON setup bodies', async () => {
    const mismatch = await app.fetch(jsonRequest('/api/auth/setup', {
      method: 'POST',
      origin: 'https://evil.example',
      body: { bootstrapToken: TEST_SETUP_TOKEN, username: 'admin', password: 'correct horse battery staple' },
    }))
    expect(mismatch.status).toBe(403)
    expect(await mismatch.json()).toMatchObject({ code: 'csrf-origin-mismatch' })

    const crossSite = jsonRequest('/api/auth/setup', {
      method: 'POST',
      origin: context.runtime.config.publicOrigin,
      body: { bootstrapToken: TEST_SETUP_TOKEN, username: 'admin', password: 'correct horse battery staple' },
    })
    crossSite.headers.set('Sec-Fetch-Site', 'cross-site')
    const crossSiteResponse = await app.fetch(crossSite)
    expect(crossSiteResponse.status).toBe(403)
    expect(await crossSiteResponse.json()).toMatchObject({ code: 'csrf-cross-site' })

    const missingType = await app.fetch(jsonRequest('/api/auth/setup', {
      method: 'POST',
      origin: context.runtime.config.publicOrigin,
      contentType: '',
      body: { bootstrapToken: TEST_SETUP_TOKEN, username: 'admin', password: 'correct horse battery staple' },
    }))
    expect(missingType.status).toBe(415)
    expect(await missingType.json()).toMatchObject({ code: 'invalid-content-type' })
  })

  it('gates setup-token verification during an active cooldown', async () => {
    closeAuthTestContext(context)
    let now = 1_700_000_000_000
    context = createAuthTestContext({
      now: () => now,
      rateLimiterOptions: {
        now: () => now,
        threshold: 2,
        baseRetryMs: 100,
        maxDelayMs: 100,
      },
    })
    const invalidRequest = () => app.fetch(jsonRequest('/api/auth/setup', {
      method: 'POST',
      origin: context.runtime.config.publicOrigin,
      body: { bootstrapToken: `${TEST_SETUP_TOKEN}-wrong`, username: 'admin', password: 'correct horse battery staple' },
    }))
    expect((await invalidRequest()).status).toBe(401)
    expect((await invalidRequest()).status).toBe(429)

    const verify = vi.spyOn(context.runtime.bootstrap, 'verify')
    const blocked = await app.fetch(jsonRequest('/api/auth/setup', {
      method: 'POST',
      origin: context.runtime.config.publicOrigin,
      body: { bootstrapToken: TEST_SETUP_TOKEN, username: 'admin', password: 'correct horse battery staple' },
    }))
    expect(blocked.status).toBe(429)
    expect(verify).not.toHaveBeenCalled()
    verify.mockRestore()

    now += 101
    const created = await setupOwner()
    expect(created.response.status).toBe(201)
    expect(context.runtime.setupLimiter.retryAfter('setup')).toBe(0)
    expect(context.runtime.setupLimiter.size).toBe(0)
  })

  it('uses the same injected KDF guard for setup, known login, and dummy login', async () => {
    closeAuthTestContext(context)
    let calls = 0
    const instrumentedGuard = {
      run: (..._args: unknown[]) => {
        calls += 1
        return Promise.resolve(Buffer.alloc(32))
      },
    } as unknown as KdfGuard
    context = createAuthTestContext({ kdfGuard: instrumentedGuard })

    const setup = await setupOwner()
    expect(setup.response.status).toBe(201)
    expect(calls).toBe(1)

    const login = (username: string, password: string) => app.fetch(jsonRequest('/api/auth/login', {
      method: 'POST',
      origin: context.runtime.config.publicOrigin,
      body: { username, password },
    }))
    expect((await login('admin', 'correct horse battery staple')).status).toBe(200)
    expect((await login('unknown', 'wrong password')).status).toBe(401)
    expect(calls).toBe(3)
  })

  it('requires a Nuvyn session for existing application APIs after the cutover', async () => {
    __setMetadataDbForTesting(context.db)
    try {
      const tree = await app.fetch(new Request('http://localhost/api/tree'))
      expect(tree.status).toBe(401)
      expect(await tree.json()).toEqual({ error: 'Authentication required.', code: 'auth-session-required' })
    } finally {
      __setMetadataDbForTesting(null)
    }
  })

  it('keeps the existing anonymous health response and handles an uninitialized auth runtime safely', async () => {
    const health = await app.fetch(new Request('http://localhost/api/health'))
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ ok: true })

    closeAuthTestContext(context)
    const status = await app.fetch(new Request('http://localhost/api/auth/status'))
    expect(status.status).toBe(503)
    expect(status.headers.get('cache-control')).toBe('no-store')
    expect(await status.json()).toEqual({
      error: 'Authentication is temporarily unavailable.',
      code: 'auth-unavailable',
    })
    // Prevent afterEach from attempting to close the same context twice.
    context = createAuthTestContext()
  })
})
