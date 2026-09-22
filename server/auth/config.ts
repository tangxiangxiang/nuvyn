/**
 * Authentication configuration primitives.
 *
 * Phase 1 deliberately keeps these values as pure parsing helpers. Startup
 * wiring, environment validation, and cookie serialization belong to later
 * authentication phases; importing this module never reads or mutates the
 * database, timers, or process environment.
 */

import { readCanonicalEnv } from '../env.js'
import {
  NUVYN_LOCAL_SESSION_COOKIE_NAME,
  NUVYN_SECURE_SESSION_COOKIE_NAME,
} from '../technicalNamespace.js'

export const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000
export const SESSION_LAST_SEEN_UPDATE_INTERVAL_MS = 60 * 60 * 1000

export const SECURE_SESSION_COOKIE_NAME = NUVYN_SECURE_SESSION_COOKIE_NAME
export const LOCAL_SESSION_COOKIE_NAME = NUVYN_LOCAL_SESSION_COOKIE_NAME

export type SessionCookieName =
  | typeof SECURE_SESSION_COOKIE_NAME
  | typeof LOCAL_SESSION_COOKIE_NAME

export type AuthCookieProfile = {
  readonly name: SessionCookieName
  readonly secure: boolean
  readonly httpOnly: true
  readonly sameSite: 'Lax'
  readonly path: '/'
}

export type AuthConfig = {
  readonly publicOrigin: string
  readonly cookie: AuthCookieProfile
  readonly sessionLifetimeMs: number
  readonly sessionLastSeenUpdateIntervalMs: number
  readonly revokeSessionsOnStart: boolean
}

export class AuthConfigError extends Error {
  readonly code = 'invalid-auth-config'

  constructor(message: string) {
    super(message)
    this.name = 'AuthConfigError'
  }
}

const LOOPBACK_HTTP_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function cookieProfile(secure: boolean): AuthCookieProfile {
  return secure
    ? {
        name: SECURE_SESSION_COOKIE_NAME,
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
        path: '/',
      }
    : {
        name: LOCAL_SESSION_COOKIE_NAME,
        secure: false,
        httpOnly: true,
        sameSite: 'Lax',
        path: '/',
      }
}

/**
 * Parse the browser-facing origin and derive the only accepted cookie profile.
 * Listener addresses and forwarded request headers are intentionally absent
 * from this API: public origin is the security authority.
 */
export function parsePublicOrigin(value: string): AuthConfig {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AuthConfigError('NUVYN_PUBLIC_ORIGIN is required')
  }

  const raw = value.trim()
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new AuthConfigError('NUVYN_PUBLIC_ORIGIN must be an absolute http(s) origin')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AuthConfigError('NUVYN_PUBLIC_ORIGIN must use http or https')
  }
  if (url.username || url.password) {
    throw new AuthConfigError('NUVYN_PUBLIC_ORIGIN must not contain credentials')
  }
  // URL.origin always implies a root pathname. A non-root pathname is a
  // deployment path, not an origin, and would make same-origin checks unsafe.
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new AuthConfigError('NUVYN_PUBLIC_ORIGIN must not contain a path, query, or fragment')
  }

  const secure = url.protocol === 'https:'
  if (!secure && !LOOPBACK_HTTP_HOSTS.has(url.hostname)) {
    throw new AuthConfigError('plaintext HTTP is allowed only for loopback origins')
  }

  return {
    publicOrigin: url.origin,
    cookie: cookieProfile(secure),
    sessionLifetimeMs: SESSION_LIFETIME_MS,
    sessionLastSeenUpdateIntervalMs: SESSION_LAST_SEEN_UPDATE_INTERVAL_MS,
    revokeSessionsOnStart: false,
  }
}

/** Parse the Phase 1 environment-shaped authentication configuration. */
export function loadAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): AuthConfig {
  const config = parsePublicOrigin(
    readCanonicalEnv(env, 'NUVYN_PUBLIC_ORIGIN') ?? '',
  )
  return {
    ...config,
    revokeSessionsOnStart: readCanonicalEnv(
      env,
      'NUVYN_AUTH_REVOKE_SESSIONS_ON_START',
    ) === '1',
  }
}

/** Alias used by callers that prefer an explicit parser name. */
export const parseAuthConfig = loadAuthConfig

/** Return the one cookie name accepted for the selected origin profile. */
export function activeSessionCookieName(config: Pick<AuthConfig, 'cookie'>): SessionCookieName {
  return config.cookie.name
}
