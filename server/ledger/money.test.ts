import { describe, expect, it } from 'vitest'
import {
  LEDGER_CURRENCY_METADATA_REVISION,
  LEDGER_CURRENCY_METADATA_SOURCE,
  LEDGER_CURRENCY_METADATA_VERSION,
  LEDGER_CURRENCY_EXPONENTS,
  assertLedgerCurrencyMetadataCompatible,
  checkLedgerCurrencyMetadataCompatibility,
  currencyExponentFor,
  formatMinorToDecimal,
  getLedgerCurrencyExponent,
  isSupportedLedgerCurrency,
  normalizeLedgerCurrencyCode,
  parseDecimalToMinor,
} from '../../shared/ledgerCurrency.js'
import {
  MAX_SAFE_MINOR,
  assertNonNegativeSafeInteger,
  assertPositiveMinor,
  assertSafeMinor,
  checkedAddMinor,
  checkedSubMinor,
  checkedSumMinor,
} from './money.js'

describe('Ledger checked money arithmetic', () => {
  it('accepts signed safe integers and enforces positive/non-negative field rules', () => {
    expect(() => assertSafeMinor(MAX_SAFE_MINOR)).not.toThrow()
    expect(() => assertSafeMinor(-MAX_SAFE_MINOR)).not.toThrow()
    expect(() => assertPositiveMinor(1)).not.toThrow()
    expect(() => assertNonNegativeSafeInteger(0)).not.toThrow()
    expect(() => assertSafeMinor(1.5)).toThrow()
    expect(() => assertSafeMinor(Number.MAX_SAFE_INTEGER + 1)).toThrow()
    expect(() => assertPositiveMinor(0)).toThrow()
    expect(() => assertNonNegativeSafeInteger(-1)).toThrow()
  })

  it('checks every arithmetic result, including aggregate totals', () => {
    expect(checkedAddMinor(100, -40)).toBe(60)
    expect(checkedSubMinor(100, 140)).toBe(-40)
    expect(checkedSumMinor([1, 2, -1])).toBe(2)
    expect(() => checkedAddMinor(MAX_SAFE_MINOR, 1)).toThrow()
    expect(() => checkedSubMinor(-MAX_SAFE_MINOR, 1)).toThrow()
    expect(() => checkedSumMinor([MAX_SAFE_MINOR, 1])).toThrow()
    expect(() => checkedSumMinor([MAX_SAFE_MINOR - 1, 1, 1])).toThrow()
  })
})
describe('Ledger ISO 4217 minor-unit metadata and decimal conversion', () => {
  it('uses a checked-in, versioned SIX snapshot with representative exponents', () => {
    expect(LEDGER_CURRENCY_METADATA_SOURCE).toContain('SIX')
    expect(LEDGER_CURRENCY_METADATA_REVISION).toBe('2026-01-01')
    expect(LEDGER_CURRENCY_METADATA_VERSION).toBe('six-list-one-2026-01-01')
    expect(currencyExponentFor('CNY')).toBe(2)
    expect(currencyExponentFor('USD')).toBe(2)
    expect(currencyExponentFor('JPY')).toBe(0)
    expect(currencyExponentFor('KWD')).toBe(3)
    expect(currencyExponentFor('CLF')).toBe(4)
    expect(getLedgerCurrencyExponent('not-a-currency')).toBeUndefined()
    expect(isSupportedLedgerCurrency('cny')).toBe(true)
    expect(normalizeLedgerCurrencyCode(' usd ')).toBe('USD')
    expect(() => currencyExponentFor('XXX')).toThrow()
  })

  it('parses and formats decimal strings using the currency exponent, never float math', () => {
    expect(parseDecimalToMinor('38.50', 'CNY')).toBe(3850)
    expect(formatMinorToDecimal(3850, 'CNY')).toBe('38.50')
    expect(parseDecimalToMinor('123', 'JPY')).toBe(123)
    expect(formatMinorToDecimal(123, 'JPY')).toBe('123')
    expect(parseDecimalToMinor('1.234', 'KWD')).toBe(1234)
    expect(formatMinorToDecimal(1234, 'KWD')).toBe('1.234')
    expect(parseDecimalToMinor('1.2345', 'CLF')).toBe(12345)
    expect(formatMinorToDecimal(12345, 'CLF')).toBe('1.2345')
    expect(parseDecimalToMinor('-0.01', 'CNY')).toBe(-1)
    expect(formatMinorToDecimal(-1, 'CNY')).toBe('-0.01')
    expect(parseDecimalToMinor('90071992547409.91', 'CNY')).toBe(MAX_SAFE_MINOR)
    expect(formatMinorToDecimal(MAX_SAFE_MINOR, 'CNY')).toBe('90071992547409.91')
  })

  it('rejects excess precision, malformed decimal strings, and unsafe results', () => {
    expect(() => parseDecimalToMinor('1.001', 'CNY')).toThrow()
    expect(() => parseDecimalToMinor('1.0', 'JPY')).toThrow()
    expect(() => parseDecimalToMinor('1e2', 'CNY')).toThrow()
    expect(() => parseDecimalToMinor(' 1.00', 'CNY')).toThrow()
    expect(() => parseDecimalToMinor('90071992547409.92', 'CNY')).toThrow()
    expect(() => formatMinorToDecimal(Number.MAX_SAFE_INTEGER + 1, 'CNY')).toThrow()
  })

  it('enforces the post-release metadata compatibility policy for used currencies', () => {
    const previous = { CNY: 2, JPY: 0 }
    expect(checkLedgerCurrencyMetadataCompatibility(
      previous,
      { CNY: 2, JPY: 0, USD: 2 },
      ['CNY'],
    )).toEqual({ compatible: true })
    expect(checkLedgerCurrencyMetadataCompatibility(
      previous,
      { CNY: 2 },
      ['JPY'],
    )).toMatchObject({ compatible: false, code: 'currency-removed', currency: 'JPY' })
    expect(checkLedgerCurrencyMetadataCompatibility(
      previous,
      { CNY: 3, JPY: 0 },
      ['CNY'],
    )).toMatchObject({
      compatible: false,
      code: 'currency-exponent-changed',
      currency: 'CNY',
      previousExponent: 2,
      nextExponent: 3,
    })
    expect(() => assertLedgerCurrencyMetadataCompatible(
      previous,
      { CNY: 3, JPY: 0 },
      ['CNY'],
    )).toThrow()
    expect(Object.keys(LEDGER_CURRENCY_EXPONENTS).every((code) => /^[A-Z]{3}$/.test(code))).toBe(true)
  })
})
