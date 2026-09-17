// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { isValidLedgerRouteDate, parseLedgerRouteDate } from '../periodNavigation'

describe('Ledger route local-date boundary', () => {
  it('accepts strict calendar dates and rejects malformed or impossible dates', () => {
    expect(parseLedgerRouteDate('2026-08-20')).toBe('2026-08-20')
    expect(parseLedgerRouteDate('2024-02-29')).toBe('2024-02-29')
    for (const value of ['2026-8-20', '2025-02-29', '2026-02-30', '2026-99-99', 'abc', undefined, ['2026-08-20']]) {
      expect(parseLedgerRouteDate(value)).toBeNull()
      expect(isValidLedgerRouteDate(value)).toBe(false)
    }
  })
})
