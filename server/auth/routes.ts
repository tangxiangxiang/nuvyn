import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { bodyLimit } from 'hono/body-limit'
import { Hono } from 'hono'
import {
  LOCAL_SESSION_COOKIE_NAME,
  SECURE_SESSION_COOKIE_NAME,
  SESSION_LIFETIME_MS,
} from './config.js'
import { checkCsrfHeaders, checkJsonContentType } from './csrf.js'
import { AuthServiceError } from './service.js'
import { getAuthRuntime } from './runtime.js'
import { findSessionByRawToken, selectSessionToken } from './session.js'

const authRoutes = new Hono()

function noStore(c: { header: (name: string, value: string) => void }): void {
  c.header('Cache-Control', 'no-store')
}

// Keep the cache policy true even for malformed/unknown auth paths that Hono
// resolves to a framework-generated 404 rather than one of the handlers below.
authRoutes.use('*', async (c, next) => {
  noStore(c)
  await next()
})

function jsonError(
  c: any,
  status: number,
  error: string,
  code: string,
  retryAfterMs?: number,
): Response {
  noStore(c)
  if (retryAfterMs !== undefined) {
    c.header('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))))
  }
  return c.json({ error, code }, status)
}

// Authentication payloads contain only short credentials. Keep this limit
// local to setup/login so document mutation routes can continue to accept
// larger Markdown bodies.
export const AUTH_REQUEST_BODY_MAX_BYTES = 16 * 1024

const authRequestBodyLimit = bodyLimit({
  maxSize: AUTH_REQUEST_BODY_MAX_BYTES,
  onError: (c) => jsonError(
    c,
    413,
    'Authentication request is too large.',
    'auth-request-too-large',
  ),
})

function runtimeOrError(c: any) {
  const runtime = getAuthRuntime()
  if (!runtime) {
    return { runtime: null, response: jsonError(c, 503, 'Authentication is temporarily unavailable.', 'auth-unavailable') }
  }
  return { runtime, response: null }
}

function parseObject(body: unknown): Record<string, unknown> | null {
  return body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null
}

function parseCookies(c: any): Record<string, string | undefined> {
  return getCookie(c)
}

function setSessionCookie(c: any, runtime: NonNullable<ReturnType<typeof getAuthRuntime>>, rawToken: string, expiresAt: number): void {
  const { name, ...cookieOptions } = runtime.config.cookie
  setCookie(c, name, rawToken, {
    ...cookieOptions,
    maxAge: Math.floor(SESSION_LIFETIME_MS / 1000),
    expires: new Date(expiresAt),
  })
}

function clearSessionCookies(c: any): void {
  deleteCookie(c, SECURE_SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: true,
    path: '/',
    expires: new Date(0),
  })
  deleteCookie(c, LOCAL_SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: false,
    path: '/',
    expires: new Date(0),
  })
}

function selectRequestCookie(c: any, runtime: NonNullable<ReturnType<typeof getAuthRuntime>>) {
  return selectSessionToken(parseCookies(c), runtime.config)
}

function csrfError(c: any, runtime: NonNullable<ReturnType<typeof getAuthRuntime>>, requireJson: boolean): Response | null {
  const csrf = checkCsrfHeaders(c.req.raw.headers, c.req.method, runtime.config)
  if (!csrf.ok) return jsonError(c, 403, csrf.message, csrf.code)
  if (requireJson) {
    const content = checkJsonContentType(c.req.raw.headers)
    if (!content.ok) return jsonError(c, 415, content.message, content.code)
  }
  return null
}

authRoutes.get('/status', (c) => {
  const resolved = runtimeOrError(c)
  if (!resolved.runtime) return resolved.response!
  const runtime = resolved.runtime
  try {
    const sessionToken = selectRequestCookie(c, runtime)
    const status = runtime.service.status(sessionToken)
    noStore(c)
    if (!status.authenticated || !status.user) {
      return c.json({ authenticated: false, setupRequired: status.setupRequired })
    }
    return c.json({
      authenticated: true,
      setupRequired: false,
      user: status.user,
    })
  } catch {
    return jsonError(c, 503, 'Authentication is temporarily unavailable.', 'auth-unavailable')
  }
})

authRoutes.post('/setup', authRequestBodyLimit, async (c) => {
  const resolved = runtimeOrError(c)
  if (!resolved.runtime) return resolved.response!
  const runtime = resolved.runtime
  const csrf = csrfError(c, runtime, true)
  if (csrf) return csrf
  // Closed setup has precedence over token/body details, including a wrong
  // bootstrap token, so it cannot become a takeover oracle.
  try {
    if (runtime.service.ownerExists()) {
      return jsonError(c, 409, 'Nuvyn is already initialized.', 'already-initialized')
    }
  } catch {
    return jsonError(c, 503, 'Authentication is temporarily unavailable.', 'auth-unavailable')
  }
  let body: Record<string, unknown> | null
  try {
    body = parseObject(await c.req.json())
  } catch {
    body = null
  }
  if (!body) return jsonError(c, 400, 'Bootstrap token, username, and password are required.', 'validation-error')
  try {
    const result = await runtime.service.setup({
      bootstrapToken: body.bootstrapToken,
      username: body.username,
      password: body.password,
      signal: c.req.raw.signal,
    })
    setSessionCookie(c, runtime, result.session.rawToken, result.session.session.expiresAt)
    noStore(c)
    return c.json({ authenticated: true, user: result.user }, 201)
  } catch (error) {
    if (error instanceof AuthServiceError) {
      return jsonError(c, error.status, error.message, error.code, error.retryAfterMs)
    }
    return jsonError(c, 500, 'Authentication is temporarily unavailable.', 'auth-unavailable')
  }
})

authRoutes.post('/login', authRequestBodyLimit, async (c) => {
  const resolved = runtimeOrError(c)
  if (!resolved.runtime) return resolved.response!
  const runtime = resolved.runtime
  const csrf = csrfError(c, runtime, true)
  if (csrf) return csrf
  let body: Record<string, unknown> | null
  try {
    body = parseObject(await c.req.json())
  } catch {
    body = null
  }
  if (!body) return jsonError(c, 400, 'Username and password are required.', 'validation-error')
  try {
    const result = await runtime.service.login({
      username: body.username,
      password: body.password,
      signal: c.req.raw.signal,
    })
    setSessionCookie(c, runtime, result.session.rawToken, result.session.session.expiresAt)
    noStore(c)
    return c.json({ authenticated: true, user: result.user })
  } catch (error) {
    if (error instanceof AuthServiceError) {
      return jsonError(c, error.status, error.message, error.code, error.retryAfterMs)
    }
    return jsonError(c, 500, 'Authentication is temporarily unavailable.', 'auth-unavailable')
  }
})

authRoutes.post('/logout', async (c) => {
  const resolved = runtimeOrError(c)
  if (!resolved.runtime) return resolved.response!
  const runtime = resolved.runtime
  const csrf = csrfError(c, runtime, false)
  if (csrf) return csrf
  const rawToken = selectRequestCookie(c, runtime)
  let sessionId: number | null = null
  try {
    const lookup = rawToken ? findSessionByRawToken(runtime.db, rawToken) : null
    sessionId = lookup?.session?.id ?? null
  } catch {
    // The existing logout error path below remains authoritative; no
    // capability cleanup is attempted without a proven session identity.
  }
  // Invalidate the in-memory Diary capability before revoking the auth
  // session. Even if the persistent logout write fails, a capability from
  // the session being logged out must not remain usable in this process.
  if (sessionId !== null) await runtime.diaryAccess.invalidateAuthSession(sessionId)
  let logoutError: unknown = null
  try {
    runtime.service.logout(rawToken)
  } catch (error) {
    // Missing, expired, revoked, and invalid sessions are handled as normal
    // no-ops by the service. An actual storage failure must remain visible to
    // the client rather than being reported as a successful server revoke.
    logoutError = error
  }
  try {
    clearSessionCookies(c)
  } catch {
    // Cookie cleanup is best effort even when the underlying revoke failed.
  }
  if (logoutError !== null) {
    return jsonError(c, 503, 'Authentication is temporarily unavailable.', 'auth-unavailable')
  }
  noStore(c)
  return c.body(null, 204)
})

export { authRoutes }
export default authRoutes
