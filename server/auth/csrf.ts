import type { AuthConfig } from './config.js'

export type CsrfFailureCode = 'csrf-origin-mismatch' | 'csrf-cross-site' | 'invalid-content-type'

export type CsrfCheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: CsrfFailureCode; readonly message: string }

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export function isUnsafeMethod(method: string): boolean {
  return UNSAFE_METHODS.has(method.toUpperCase())
}

/** Apply the narrow same-origin mutation policy used by Phase 2 auth routes. */
export function checkCsrfHeaders(
  headers: Headers,
  method: string,
  config: Pick<AuthConfig, 'publicOrigin'>,
): CsrfCheckResult {
  if (!isUnsafeMethod(method)) return { ok: true }
  const origin = headers.get('origin')
  if (origin !== null && origin !== config.publicOrigin) {
    return {
      ok: false,
      code: 'csrf-origin-mismatch',
      message: 'Request origin is not allowed.',
    }
  }
  if (headers.get('sec-fetch-site')?.toLowerCase() === 'cross-site') {
    return {
      ok: false,
      code: 'csrf-cross-site',
      message: 'Cross-site mutation is not allowed.',
    }
  }
  return { ok: true }
}

export function hasJsonContentType(headers: Headers): boolean {
  const contentType = headers.get('content-type')
  return contentType !== null && /^application\/json\s*(?:;|$)/i.test(contentType)
}

export function checkJsonContentType(headers: Headers): CsrfCheckResult {
  if (hasJsonContentType(headers)) return { ok: true }
  return {
    ok: false,
    code: 'invalid-content-type',
    message: 'Content-Type must be application/json.',
  }
}
