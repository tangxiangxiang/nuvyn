import { describe, expect, it } from 'vitest'
import { checkCsrfHeaders, checkJsonContentType } from '../auth/csrf.js'
import { parsePublicOrigin } from '../auth/config.js'

const config = parsePublicOrigin('https://nuvyn.example.com')

describe('authentication CSRF policy', () => {
  it('allows matching origin and rejects an exact mismatch', () => {
    expect(checkCsrfHeaders(new Headers({ Origin: config.publicOrigin }), 'POST', config)).toEqual({ ok: true })
    expect(checkCsrfHeaders(new Headers({ Origin: 'https://evil.example' }), 'POST', config)).toMatchObject({
      ok: false,
      code: 'csrf-origin-mismatch',
    })
  })

  it('rejects cross-site unsafe mutations but permits missing browser metadata', () => {
    expect(checkCsrfHeaders(new Headers({ 'Sec-Fetch-Site': 'cross-site' }), 'POST', config)).toMatchObject({
      ok: false,
      code: 'csrf-cross-site',
    })
    expect(checkCsrfHeaders(new Headers(), 'POST', config)).toEqual({ ok: true })
    expect(checkCsrfHeaders(new Headers({ Origin: 'https://evil.example' }), 'GET', config)).toEqual({ ok: true })
  })

  it('accepts either configured HTTPS origin without permitting arbitrary cross-site requests', () => {
    const multi = parsePublicOrigin('https://nuvyn.example.com,https://backup.example.com')
    for (const origin of multi.allowedOrigins) {
      expect(checkCsrfHeaders(new Headers({ Origin: origin, 'Sec-Fetch-Site': 'same-origin' }), 'POST', multi))
        .toEqual({ ok: true })
    }
    expect(checkCsrfHeaders(new Headers({ Origin: 'https://backup.example.com.evil.test' }), 'POST', multi))
      .toMatchObject({ ok: false, code: 'csrf-origin-mismatch' })
    expect(checkCsrfHeaders(new Headers({ Origin: 'https://backup.example.com', 'Sec-Fetch-Site': 'cross-site' }), 'POST', multi))
      .toMatchObject({ ok: false, code: 'csrf-cross-site' })
  })

  it('requires JSON only for JSON-body endpoints and accepts charset parameters', () => {
    expect(checkJsonContentType(new Headers({ 'Content-Type': 'application/json' }))).toEqual({ ok: true })
    expect(checkJsonContentType(new Headers({ 'Content-Type': 'application/json; charset=utf-8' }))).toEqual({ ok: true })
    expect(checkJsonContentType(new Headers({ 'Content-Type': 'text/plain' }))).toMatchObject({
      ok: false,
      code: 'invalid-content-type',
    })
  })
})
