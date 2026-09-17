import { describe, expect, it } from 'vitest'
import { isSafeInternalRedirect, safeInternalRedirect } from '../auth-redirect'

describe('safe internal auth redirects', () => {
  it.each([
    '/',
    '/vault',
    '/vault/a/b',
    '/vault/a?view=read#section',
    '/ledger',
    '/ledger/transactions?period=month#recent',
    '/board',
    '/board/atlas',
    '/bills',
    '/bills/transactions?period=month',
  ])('accepts %s', (value) => {
    expect(safeInternalRedirect(value)).toBe(value)
    expect(isSafeInternalRedirect(value)).toBe(true)
  })

  it.each([
    'https://evil.example',
    'http://evil.example',
    '//evil.example',
    '\\\\evil.example',
    '/\\evil',
    '/%5C%5Cevil',
    'javascript:alert(1)',
    'data:text/html,evil',
    '%68%74%74%70%3A%2F%2Fevil.example',
    'https%253A%252F%252Fevil.example',
    '/vault/%E0%A4%A',
    '/vault/\u0000bad',
  ])('rejects %s', (value) => {
    expect(safeInternalRedirect(value)).toBe('/vault')
    expect(isSafeInternalRedirect(value)).toBe(false)
  })
})
