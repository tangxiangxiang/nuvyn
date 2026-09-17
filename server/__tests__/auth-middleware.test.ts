import { afterEach, describe, expect, it } from 'vitest'
import app from '../index.js'
import { SESSION_LAST_SEEN_UPDATE_INTERVAL_MS, SESSION_LIFETIME_MS } from '../auth/config.js'
import { createSession, revokeSession } from '../auth/session.js'
import { getVaultId } from '../vaultIdentity.js'
import {
  authenticatedRequest,
  closeAuthTestContext,
  createAuthenticatedTestContext,
} from './helpers/auth.js'

let sentinelExecuted = false
app.get('/api/__auth_boundary_test_sentinel', (c) => {
  sentinelExecuted = true
  return c.json({ ok: true })
})

describe('Phase 5 central authentication boundary', () => {
  afterEach(() => {
    // Each test owns its context and closes it in the test body. This hook is
    // intentionally empty: it documents that no global test bypass exists.
  })

  it('keeps only the exact health/auth allowlist public', async () => {
    const context = createAuthenticatedTestContext()
    try {
      const health = await app.fetch(new Request('http://localhost/api/health'))
      expect(health.status).toBe(200)
      expect(await health.json()).toEqual({ ok: true })

      const status = await app.fetch(new Request('http://localhost/api/auth/status'))
      expect(status.status).toBe(200)

      const unknownAuth = await app.fetch(new Request('http://localhost/api/auth/future'))
      expect(unknownAuth.status).toBe(401)
      expect(await unknownAuth.json()).toEqual({
        error: 'Authentication required.',
        code: 'auth-session-required',
      })

      const methodMismatch = await app.fetch(new Request('http://localhost/api/auth/status', { method: 'POST' }))
      expect(methodMismatch.status).toBe(401)
      const loginGet = await app.fetch(new Request('http://localhost/api/auth/login'))
      expect(loginGet.status).toBe(401)
    } finally {
      closeAuthTestContext(context)
    }
  })

  it('fails closed before handlers and protects the stable vault identity', async () => {
    const context = createAuthenticatedTestContext()
    try {
      const anonymous = await app.fetch(new Request('http://localhost/api/tree'))
      expect(anonymous.status).toBe(401)
      expect(anonymous.headers.get('cache-control')).toBe('no-store')

      for (const path of [
        '/api/files/state',
        '/api/posts',
        '/api/folders',
        '/api/recover',
        '/api/metadata/migration',
        '/api/links/index',
        '/api/ai/sessions',
        '/api/history/status',
        '/api/future-example',
      ]) {
        const response = await app.fetch(new Request(`http://localhost${path}`))
        expect(response.status, path).toBe(401)
        expect(await response.json(), path).toEqual({
          error: 'Authentication required.',
          code: 'auth-session-required',
        })
      }

      const identity = await app.fetch(authenticatedRequest(context, '/api/vault/identity'))
      expect(identity.status).toBe(200)
      expect(identity.headers.get('cache-control')).toBe('no-store')
      expect(await identity.json()).toEqual({ vaultId: getVaultId() })

      const tree = await app.fetch(authenticatedRequest(context, '/api/tree'))
      expect(tree.status).toBe(200)
      expect(tree.headers.get('cache-control')).toBe('no-store')

      const unknown = await app.fetch(authenticatedRequest(context, '/api/future-example'))
      expect(unknown.status).toBe(404)
      expect(unknown.headers.get('cache-control')).toBe('no-store')
    } finally {
      closeAuthTestContext(context)
    }
  })

  it('stops anonymous requests before a protected handler and lets valid sessions reach it', async () => {
    const context = createAuthenticatedTestContext()
    try {
      sentinelExecuted = false
      const anonymous = await app.fetch(new Request('http://localhost/api/__auth_boundary_test_sentinel'))
      expect(anonymous.status).toBe(401)
      expect(sentinelExecuted).toBe(false)

      const authenticated = await app.fetch(authenticatedRequest(
        context,
        '/api/__auth_boundary_test_sentinel',
      ))
      expect(authenticated.status).toBe(200)
      expect(sentinelExecuted).toBe(true)
    } finally {
      closeAuthTestContext(context)
    }
  })

  it('applies the existing CSRF/content policy to protected mutations', async () => {
    const context = createAuthenticatedTestContext()
    try {
      const wrongOrigin = await app.fetch(authenticatedRequest(context, '/api/posts', {
        method: 'POST',
        origin: 'http://evil.example',
        body: { path: 'blocked', title: 'Blocked' },
      }))
      expect(wrongOrigin.status).toBe(403)
      expect(await wrongOrigin.json()).toMatchObject({ code: 'csrf-origin-mismatch' })
      expect(wrongOrigin.headers.get('cache-control')).toBe('no-store')

      const crossSite = await app.fetch(new Request('http://localhost/api/posts', {
        method: 'POST',
        headers: {
          Cookie: context.cookie,
          Origin: context.runtime.config.publicOrigin,
          'Sec-Fetch-Site': 'cross-site',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ path: 'blocked', title: 'Blocked' }),
      }))
      expect(crossSite.status).toBe(403)
      expect(await crossSite.json()).toMatchObject({ code: 'csrf-cross-site' })
      expect(crossSite.headers.get('cache-control')).toBe('no-store')

      const missingContentType = await app.fetch(new Request('http://localhost/api/posts', {
        method: 'POST',
        headers: {
          Cookie: context.cookie,
          'Content-Length': String(Buffer.byteLength(JSON.stringify({ path: 'blocked', title: 'Blocked' }))),
        },
        body: JSON.stringify({ path: 'blocked', title: 'Blocked' }),
      }))
      expect(missingContentType.status).toBe(415)
      expect(await missingContentType.json()).toMatchObject({ code: 'invalid-content-type' })
      expect(missingContentType.headers.get('cache-control')).toBe('no-store')

      const validOrigin = await app.fetch(authenticatedRequest(context, '/api/posts', {
        method: 'POST',
        origin: context.runtime.config.publicOrigin,
        body: {},
        contentType: 'application/json; charset=utf-8',
      }))
      expect(validOrigin.status).not.toBe(403)
      expect(validOrigin.headers.get('cache-control')).toBe('no-store')

      const emptyStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close()
        },
      })
      const bodylessDelete = await app.fetch(new Request('http://localhost/api/posts/does-not-exist', {
        method: 'DELETE',
        headers: { Cookie: context.cookie },
        body: emptyStream,
        duplex: 'half',
      }))
      expect(bodylessDelete.status).not.toBe(415)
      expect(bodylessDelete.headers.get('cache-control')).toBe('no-store')

      const explicitZeroLengthDelete = await app.fetch(new Request('http://localhost/api/posts/does-not-exist', {
        method: 'DELETE',
        headers: {
          Cookie: context.cookie,
          'Content-Length': '0',
        },
      }))
      expect(explicitZeroLengthDelete.status).not.toBe(415)

      const positiveLengthWithoutType = await app.fetch(new Request('http://localhost/api/posts/does-not-exist', {
        method: 'DELETE',
        headers: {
          Cookie: context.cookie,
          'Content-Length': '1',
        },
      }))
      expect(positiveLengthWithoutType.status).toBe(415)
      expect(await positiveLengthWithoutType.json()).toMatchObject({ code: 'invalid-content-type' })

      const transferEncodedWithoutType = await app.fetch(new Request('http://localhost/api/posts/does-not-exist', {
        method: 'DELETE',
        headers: {
          Cookie: context.cookie,
          'Transfer-Encoding': 'chunked',
        },
      }))
      expect(transferEncodedWithoutType.status).toBe(415)
      expect(await transferEncodedWithoutType.json()).toMatchObject({ code: 'invalid-content-type' })

      const jsonPost = await app.fetch(new Request('http://localhost/api/posts', {
        method: 'POST',
        headers: {
          Cookie: context.cookie,
          'Content-Length': '2',
          'Content-Type': 'application/json',
        },
        body: '{}',
      }))
      expect(jsonPost.status).not.toBe(415)

      const jsonPatch = await app.fetch(new Request('http://localhost/api/posts/does-not-exist', {
        method: 'PATCH',
        headers: {
          Cookie: context.cookie,
          'Content-Length': '2',
          'Content-Type': 'application/json',
        },
        body: '{}',
      }))
      expect(jsonPatch.status).not.toBe(415)
    } finally {
      closeAuthTestContext(context)
    }
  })

  it('normalizes missing, unknown, revoked, expired, and disabled sessions to one 401 contract', async () => {
    const now = 1_700_000_000_000
    const context = createAuthenticatedTestContext({ now: () => now })
    const path = 'http://localhost/api/tree'
    const requestWithToken = (token: string) => new Request(path, {
      headers: { Cookie: `${context.runtime.config.cookie.name}=${token}` },
    })
    const expectRequired = async (request: Request) => {
      const response = await app.fetch(request)
      expect(response.status).toBe(401)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toEqual({
        error: 'Authentication required.',
        code: 'auth-session-required',
      })
    }

    try {
      expect((await app.fetch(requestWithToken(context.rawToken))).status).toBe(200)
      await expectRequired(new Request(path))
      await expectRequired(requestWithToken('not-a-real-session-token'))

      expect(revokeSession(context.db, context.rawToken, now)).toBe(true)
      await expectRequired(requestWithToken(context.rawToken))

      const expired = createSession(context.db, context.userId, {
        now: now - SESSION_LIFETIME_MS - 1,
      })
      await expectRequired(requestWithToken(expired.rawToken))

      const disabled = createSession(context.db, context.userId, { now })
      context.db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(context.userId)
      await expectRequired(requestWithToken(disabled.rawToken))
    } finally {
      closeAuthTestContext(context)
    }
  })

  it('touches last_seen_at only after the coarse interval and never slides expiry', async () => {
    const initialNow = 1_700_000_000_000
    let now = initialNow
    const context = createAuthenticatedTestContext({ now: () => now })
    try {
      const before = context.db.prepare(
        'SELECT last_seen_at, expires_at FROM auth_sessions WHERE id = ?',
      ).get(context.session.id) as { last_seen_at: number; expires_at: number }

      now = initialNow + SESSION_LAST_SEEN_UPDATE_INTERVAL_MS - 1
      expect((await app.fetch(authenticatedRequest(context, '/api/tree'))).status).toBe(200)
      const withinInterval = context.db.prepare(
        'SELECT last_seen_at, expires_at FROM auth_sessions WHERE id = ?',
      ).get(context.session.id) as { last_seen_at: number; expires_at: number }
      expect(withinInterval).toEqual(before)

      now = initialNow + SESSION_LAST_SEEN_UPDATE_INTERVAL_MS
      expect((await app.fetch(authenticatedRequest(context, '/api/tree'))).status).toBe(200)
      const touched = context.db.prepare(
        'SELECT last_seen_at, expires_at FROM auth_sessions WHERE id = ?',
      ).get(context.session.id) as { last_seen_at: number; expires_at: number }
      expect(touched.last_seen_at).toBe(now)
      expect(touched.expires_at).toBe(before.expires_at)

      now += SESSION_LAST_SEEN_UPDATE_INTERVAL_MS - 1
      expect((await app.fetch(authenticatedRequest(context, '/api/tree'))).status).toBe(200)
      const secondWithinInterval = context.db.prepare(
        'SELECT last_seen_at, expires_at FROM auth_sessions WHERE id = ?',
      ).get(context.session.id) as { last_seen_at: number; expires_at: number }
      expect(secondWithinInterval).toEqual(touched)
    } finally {
      closeAuthTestContext(context)
    }
  })

  it('does not enter the protected handler when a due last_seen update fails', async () => {
    const initialNow = 1_700_000_000_000
    let now = initialNow
    const context = createAuthenticatedTestContext({ now: () => now })
    try {
      now += SESSION_LAST_SEEN_UPDATE_INTERVAL_MS
      context.db.pragma('query_only = ON')
      const response = await app.fetch(authenticatedRequest(context, '/api/tree'))
      expect(response.status).toBe(503)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toEqual({
        error: 'Authentication is temporarily unavailable.',
        code: 'auth-unavailable',
      })
    } finally {
      closeAuthTestContext(context)
    }
  })

  it('prunes expired rows opportunistically with a process-local maintenance interval', async () => {
    const initialNow = 1_700_000_000_000
    let now = initialNow
    const context = createAuthenticatedTestContext({ now: () => now })
    try {
      const firstExpired = createSession(context.db, context.userId, {
        now: initialNow - SESSION_LIFETIME_MS - 1,
      })
      expect((await app.fetch(authenticatedRequest(context, '/api/tree'))).status).toBe(200)
      await Promise.resolve()
      expect(context.db.prepare('SELECT 1 FROM auth_sessions WHERE id = ?').get(firstExpired.session.id)).toBeUndefined()

      const secondExpired = createSession(context.db, context.userId, {
        now: initialNow - SESSION_LIFETIME_MS - 2,
      })
      // The same maintenance timestamp suppresses another DELETE attempt.
      expect((await app.fetch(authenticatedRequest(context, '/api/tree'))).status).toBe(200)
      await Promise.resolve()
      expect(context.db.prepare('SELECT 1 FROM auth_sessions WHERE id = ?').get(secondExpired.session.id)).toEqual({ 1: 1 })

      now += context.runtime.service.sessionPruneIntervalMs
      expect((await app.fetch(authenticatedRequest(context, '/api/tree'))).status).toBe(200)
      await Promise.resolve()
      expect(context.db.prepare('SELECT 1 FROM auth_sessions WHERE id = ?').get(secondExpired.session.id)).toBeUndefined()
      expect((await app.fetch(authenticatedRequest(context, '/api/tree'))).status).toBe(200)
    } finally {
      closeAuthTestContext(context)
    }
  })

  it('fails closed with a safe auth-unavailable response when session storage is unavailable', async () => {
    const context = createAuthenticatedTestContext()
    try {
      context.db.close()
      const response = await app.fetch(authenticatedRequest(context, '/api/tree'))
      expect(response.status).toBe(503)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toEqual({
        error: 'Authentication is temporarily unavailable.',
        code: 'auth-unavailable',
      })
    } finally {
      closeAuthTestContext(context)
    }
  })
})
