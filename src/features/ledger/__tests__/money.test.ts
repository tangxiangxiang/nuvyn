// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { evaluateLedgerAmountExpression, formatLedgerCompactMoney, formatLedgerMoney, formatLedgerWholeMoney, parseLedgerMoney } from '../money'

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

describe('Ledger amount expressions', () => {
  it.each([
    ['20-5.28', 'CNY', 1472, '14.72'],
    ['12.5+3.2', 'CNY', 1570, '15.70'],
    ['100-20-5', 'CNY', 7500, '75.00'],
    ['10+5-2.5', 'CNY', 1250, '12.50'],
    ['1.005+0.001', 'KWD', 1006, '1.006'],
    ['100-20', 'JPY', 80, '80'],
    ['.5+1.', 'CNY', 150, '1.50'],
  ])('evaluates %s exactly in %s minor units', (expression, currency, amountMinor, normalized) => {
    expect(evaluateLedgerAmountExpression(expression, currency)).toEqual({
      status: 'complete',
      amountMinor,
      normalized,
    })
  })

  it.each(['', '20-', '20+.', '20-.'])('keeps incomplete input editable: %s', (expression) => {
    expect(evaluateLedgerAmountExpression(expression, 'CNY')).toEqual({ status: 'incomplete' })
  })

  it.each(['1.234', '1++2', '1--2', '1+-2', '2*3', '3/2', '(1+2)', '1  +2'])('rejects unsupported or malformed input: %s', (expression) => {
    expect(evaluateLedgerAmountExpression(expression, 'CNY')).toEqual({ status: 'invalid' })
  })

  it('returns complete negative and zero results for the form to reject as transaction amounts', () => {
    expect(evaluateLedgerAmountExpression('5-20', 'CNY')).toMatchObject({ status: 'complete', amountMinor: -1500 })
    expect(evaluateLedgerAmountExpression('20-20', 'CNY')).toMatchObject({ status: 'complete', amountMinor: 0 })
  })

  it('rejects results that exceed the safe minor-unit range', () => {
    expect(evaluateLedgerAmountExpression('90071992547409.91+0.01', 'CNY')).toEqual({ status: 'invalid' })
  })
})
