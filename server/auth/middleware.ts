import { getCookie } from 'hono/cookie'
import type { MiddlewareHandler } from 'hono'
import { checkCsrfHeaders, checkJsonContentType, isUnsafeMethod } from './csrf.js'
import { getAuthRuntime } from './runtime.js'
import { selectSessionToken } from './session.js'

const PUBLIC_ENDPOINTS = new Set([
  'GET /api/health',
  'GET /api/auth/status',
  'POST /api/auth/setup',
  'POST /api/auth/login',
  'POST /api/auth/logout',
])

function jsonError(c: any, status: number, error: string, code: string): Response {
  c.header('Cache-Control', 'no-store')
  return c.json({ error, code }, status)
}

function isPublicEndpoint(method: string, path: string): boolean {
  return PUBLIC_ENDPOINTS.has(`${method.toUpperCase()} ${path}`)
}

function requestHasBody(request: Request): boolean {
  // HTTP/1.1 requests without Content-Length can still carry a body when
  // transfer-encoding is present. A non-null Fetch Request.body alone is not
  // reliable under Node/Hono adapters: bodyless DELETE requests may still be
  // represented by an empty stream.
  const contentLength = request.headers.get('content-length')
  if (contentLength !== null) {
    const length = Number(contentLength)
    if (Number.isFinite(length)) return length > 0
  }
  return request.headers.has('transfer-encoding')
}

function requiresJsonBody(method: string, path: string): boolean {
  // Asset uploads are the one authenticated mutation that intentionally
  // carries a binary body. Keep the exception exact; every other body-bearing
  // mutation remains subject to the existing JSON content-type boundary.
  return !(method === 'PUT' && /^\/api\/assets\/[^/]+$/.test(path))
}

/**
 * The single application authentication boundary. It intentionally owns no
 * domain behavior: route handlers remain responsible for their existing
 * validation and persistence semantics.
 */
export const authBoundary: MiddlewareHandler = async (c, next) => {
  const method = c.req.method.toUpperCase()
  if (isPublicEndpoint(method, c.req.path)) return next()

  // Set the protected response cache policy before the handler runs. Hono
  // merges context headers into handler responses, including errors.
  c.header('Cache-Control', 'no-store')

  const runtime = getAuthRuntime()
  if (!runtime) {
    return jsonError(c, 503, 'Authentication is temporarily unavailable.', 'auth-unavailable')
  }

  let status: ReturnType<NonNullable<ReturnType<typeof getAuthRuntime>>['service']['status']>
  let sessionToken: ReturnType<typeof selectSessionToken>
  try {
    sessionToken = selectSessionToken(getCookie(c), runtime.config)
    status = runtime.service.status(sessionToken)
  } catch {
    return jsonError(c, 503, 'Authentication is temporarily unavailable.', 'auth-unavailable')
  }
  if (!status.authenticated || !status.user) {
    // A revoked/expired/disabled session can still have a process-local
    // Diary capability until the next explicit lock. Remove that capability
    // as soon as the auth boundary observes the invalid session so a later
    // request cannot retain an otherwise stale DEK in server memory.
    const invalidSessionId = status.session?.session?.id
    if (invalidSessionId !== undefined) {
      await runtime.diaryAccess.invalidateAuthSession(invalidSessionId)
    }
    return jsonError(c, 401, 'Authentication required.', 'auth-session-required')
  }

  // Reuse the lookup result already produced by status(); maintenance must
  // never perform a second raw-token lookup. A valid status without its
  // session record is an internal consistency failure, not an invitation to
  // continue into the protected handler.
  if (!status.session || status.session.status !== 'valid' || !status.session.session) {
    return jsonError(c, 503, 'Authentication is temporarily unavailable.', 'auth-unavailable')
  }
  try {
    runtime.service.maintainAuthenticatedSession(status.session.session)
  } catch {
    return jsonError(c, 503, 'Authentication is temporarily unavailable.', 'auth-unavailable')
  }

  // Keep the context deliberately safe and minimal. Existing handlers do
  // not depend on it yet; it is the owner-identity seam for capability
  // binding. The session token itself never enters route context.
  c.set('authUser', { id: status.user.id, username: status.user.username })
  c.set('authSessionId', status.session.session.id)

  if (isUnsafeMethod(method)) {
    const csrf = checkCsrfHeaders(c.req.raw.headers, method, runtime.config)
    if (!csrf.ok) return jsonError(c, 403, csrf.message, csrf.code)

    // A body-bearing mutation must be JSON. Wire-level framing headers are
    // inspected without consuming the stream, so streaming handlers remain
    // intact.
    if (requestHasBody(c.req.raw) && requiresJsonBody(method, c.req.path)) {
      const content = checkJsonContentType(c.req.raw.headers)
      if (!content.ok) return jsonError(c, 415, content.message, content.code)
    }
  }

  return next()
}

export { PUBLIC_ENDPOINTS, isPublicEndpoint, requiresJsonBody }
