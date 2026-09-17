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

  it('requires JSON only for JSON-body endpoints and accepts charset parameters', () => {
    expect(checkJsonContentType(new Headers({ 'Content-Type': 'application/json' }))).toEqual({ ok: true })
    expect(checkJsonContentType(new Headers({ 'Content-Type': 'application/json; charset=utf-8' }))).toEqual({ ok: true })
    expect(checkJsonContentType(new Headers({ 'Content-Type': 'text/plain' }))).toMatchObject({
      ok: false,
      code: 'invalid-content-type',
    })
  })
})
