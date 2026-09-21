// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { formatLedgerCompactMoney, formatLedgerMoney, formatLedgerWholeMoney, parseLedgerMoney } from '../money'

describe('Ledger money presentation boundary', () => {
  it.each([
    ['CNY', '38', 3800],
    ['JPY', '38', 38],
    ['KWD', '38', 38000],
  ])('parses %s using shared currency exponent metadata', (currency, input, expected) => {
    expect(parseLedgerMoney(input, currency)).toBe(expected)
  })

  it('rejects invalid and over-precise input without floating point rounding', () => {
    expect(() => parseLedgerMoney('', 'CNY')).toThrow()
    expect(() => parseLedgerMoney('38.001', 'CNY')).toThrow()
    expect(() => parseLedgerMoney('38.0001', 'KWD')).toThrow()
    expect(() => parseLedgerMoney('1.1', 'JPY')).toThrow()
  })

  it('formats normal currency amounts with the correct exponent', () => {
    expect(formatLedgerMoney(3800, 'CNY')).toContain('38.00')
    expect(formatLedgerMoney(38, 'JPY')).not.toContain('.00')
    expect(formatLedgerMoney(38000, 'KWD')).toContain('38.000')
  })

  it('rounds compact money values to whole major units', () => {
    expect(formatLedgerWholeMoney(12_649, 'CNY')).toBe('¥126')
    expect(formatLedgerWholeMoney(12_650, 'CNY')).toBe('¥127')
    expect(formatLedgerWholeMoney(-1, 'CNY')).toBe('-¥0')
  })

  it('uses short units when a rounded amount would be wide', () => {
    expect(formatLedgerCompactMoney(12_650, 'CNY')).toBe('¥127')
    expect(formatLedgerCompactMoney(126_500, 'CNY')).toBe('¥1.3k')
    expect(formatLedgerCompactMoney(28_426_688, 'CNY')).toBe('¥284.3k')
  })

  it.each([
    ['CNY', 1, '¥0.01'],
    ['CNY', -1, '-¥0.01'],
    ['CNY', 49, '¥0.49'],
    ['CNY', -49, '-¥0.49'],
    ['USD', 1, 'US$0.01'],
    ['KWD', -49, '-KWD 0.049'],
  ])('keeps non-zero sub-unit amounts exact for %s', (currency, minor, expected) => {
    expect(formatLedgerCompactMoney(minor, currency)).toBe(expected)
  })

  it('keeps zero-decimal currencies free of invented fractions', () => {
    expect(formatLedgerCompactMoney(1, 'JPY')).toBe('¥1')
  })

  it('preserves every digit for large safe minor amounts without decimal Number conversion', () => {
    const maxSafeMinor = Number.MAX_SAFE_INTEGER
    const digitsOnly = (value: string): string => value.replace(/[^\d.]/g, '')

    expect(digitsOnly(formatLedgerMoney(maxSafeMinor, 'CNY', 'en-US'))).toBe('90071992547409.91')
    expect(digitsOnly(formatLedgerMoney(maxSafeMinor, 'JPY', 'en-US'))).toBe('9007199254740991')
    expect(digitsOnly(formatLedgerMoney(maxSafeMinor, 'KWD', 'en-US'))).toBe('9007199254740.991')
  })
})
