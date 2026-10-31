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
  readonly allowedOrigins: readonly string[]
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
const MAX_PUBLIC_ORIGINS = 8

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
 * Parse one or more explicit browser-facing origins (comma-separated).
 * The first is the canonical origin for legacy consumers; each is equally
 * authorized for same-origin browser mutations. No CORS is enabled.
 */
export function parsePublicOrigin(value: string): AuthConfig {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AuthConfigError('NUVYN_PUBLIC_ORIGIN is required')
  }

  const entries = value.split(',').map((entry) => entry.trim())
  if (entries.some((entry) => !entry) || entries.length > MAX_PUBLIC_ORIGINS) {
    throw new AuthConfigError('NUVYN_PUBLIC_ORIGIN must contain 1–8 non-empty origins')
  }

  const urls = entries.map((raw) => {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      throw new AuthConfigError('NUVYN_PUBLIC_ORIGIN must contain absolute http(s) origins')
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new AuthConfigError('NUVYN_PUBLIC_ORIGIN must use http or https')
    }
    if (url.username || url.password || url.hostname.includes('*')) {
      throw new AuthConfigError('NUVYN_PUBLIC_ORIGIN must not contain credentials or wildcard hosts')
    }
    if (url.pathname !== '/' || url.search || url.hash) {
      throw new AuthConfigError('NUVYN_PUBLIC_ORIGIN must not contain a path, query, or fragment')
    }
    if (url.protocol === 'http:' && !LOOPBACK_HTTP_HOSTS.has(url.hostname)) {
      throw new AuthConfigError('plaintext HTTP is allowed only for loopback origins')
    }
    return url
  })

  // A single HTTP loopback origin remains valid for development. Mixing
  // secure and insecure origins would yield one incompatible cookie profile.
  if (urls.length > 1 && urls.some((url) => url.protocol !== 'https:')) {
    throw new AuthConfigError('multiple NUVYN_PUBLIC_ORIGIN entries must all use HTTPS')
  }

  const allowedOrigins = urls.map((url) => url.origin)
  if (new Set(allowedOrigins).size !== allowedOrigins.length) {
    throw new AuthConfigError('NUVYN_PUBLIC_ORIGIN must not contain duplicate origins')
  }

  return {
    publicOrigin: allowedOrigins[0]!,
    allowedOrigins,
    cookie: cookieProfile(urls[0]!.protocol === 'https:'),
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
