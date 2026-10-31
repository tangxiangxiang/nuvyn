import { describe, expect, it } from 'vitest'
import {
  LOCAL_SESSION_COOKIE_NAME,
  SECURE_SESSION_COOKIE_NAME,
  activeSessionCookieName,
  loadAuthConfig,
  parsePublicOrigin,
} from '../auth/config'

describe('authentication public-origin configuration', () => {
  it('selects the secure __Host cookie profile for HTTPS origins', () => {
    const config = parsePublicOrigin('https://example.com')
    expect(config.publicOrigin).toBe('https://example.com')
    expect(config.allowedOrigins).toEqual(['https://example.com'])
    expect(config.cookie).toEqual({
      name: SECURE_SESSION_COOKIE_NAME,
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
    })
    expect(activeSessionCookieName(config)).toBe(SECURE_SESSION_COOKIE_NAME)
  })

  it('accepts HTTPS ports without changing the secure profile', () => {
    expect(parsePublicOrigin('https://example.com:8443').cookie.name).toBe(SECURE_SESSION_COOKIE_NAME)
  })

  it.each([
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://[::1]:3000',
  ])('selects the local cookie profile for loopback HTTP: %s', (origin) => {
    const config = parsePublicOrigin(origin)
    expect(config.cookie.name).toBe(LOCAL_SESSION_COOKIE_NAME)
    expect(config.cookie.secure).toBe(false)
    expect(activeSessionCookieName(config)).toBe(LOCAL_SESSION_COOKIE_NAME)
  })

  it.each([
    'http://192.168.1.10:3000',
    'http://example.com',
    'ftp://example.com',
    'not-a-url',
    'https://user:password@example.com',
    'https://example.com/app',
    'https://example.com?query=1',
    'https://example.com#fragment',
  ])('rejects unsafe or malformed public origin: %s', (origin) => {
    expect(() => parsePublicOrigin(origin)).toThrow()
  })

  it('accepts multiple HTTPS origins while preserving the first as canonical', () => {
    const config = parsePublicOrigin(' https://nuvyn.example.com , https://backup.example.com:8443 ')
    expect(config.publicOrigin).toBe('https://nuvyn.example.com')
    expect(config.allowedOrigins).toEqual([
      'https://nuvyn.example.com',
      'https://backup.example.com:8443',
    ])
    expect(config.cookie.name).toBe(SECURE_SESSION_COOKIE_NAME)
    expect(loadAuthConfig({ NUVYN_PUBLIC_ORIGIN: 'https://a.example,https://b.example' }).allowedOrigins)
      .toEqual(['https://a.example', 'https://b.example'])
  })

  it.each([
    'https://a.example,',
    ',https://a.example',
    'https://a.example,,https://b.example',
    'https://a.example,https://a.example/',
    'https://a.example,https://*.example',
    'https://a.example,http://localhost:3000',
    'http://localhost:3000,https://a.example',
    'https://a.example,https://b.example/path',
    Array.from({ length: 9 }, (_, i) => `https://site${i}.example`).join(','),
  ])('rejects invalid multi-origin configuration: %s', (value) => {
    expect(() => parsePublicOrigin(value)).toThrow()
  })

  it('does not consult listener or forwarded-header values', () => {
    const config = loadAuthConfig({
      NUVYN_PUBLIC_ORIGIN: 'http://127.0.0.1:3000',
      HOST: '0.0.0.0',
      Host: 'http://example.com',
      X_FORWARDED_PROTO: 'https',
      X_FORWARDED_HOST: 'example.com',
    })
    expect(config.publicOrigin).toBe('http://127.0.0.1:3000')
    expect(config.cookie.name).toBe(LOCAL_SESSION_COOKIE_NAME)
  })

  it('loads the canonical Nuvyn origin and startup flag', () => {
    const config = loadAuthConfig({
      NUVYN_PUBLIC_ORIGIN: 'https://nuvyn.example.com',
      NUVYN_AUTH_REVOKE_SESSIONS_ON_START: '1',
    })
    expect(config.publicOrigin).toBe('https://nuvyn.example.com')
    expect(config.revokeSessionsOnStart).toBe(true)
  })

  it('parses the session revocation startup flag without mutating the environment', () => {
    const env = {
      NUVYN_PUBLIC_ORIGIN: 'https://example.com',
      NUVYN_AUTH_REVOKE_SESSIONS_ON_START: '1',
    }
    const config = loadAuthConfig(env)
    expect(config.revokeSessionsOnStart).toBe(true)
    expect(env.NUVYN_AUTH_REVOKE_SESSIONS_ON_START).toBe('1')
  })
})
