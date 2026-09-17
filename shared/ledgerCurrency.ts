/**
 * Ledger currency metadata snapshot.
 *
 * Source: SIX, ISO 4217 Maintenance Agency, List One (Current Currency &
 * Funds), published 2026-01-01, retrieved 2026-09-03. The snapshot is
 * checked in deliberately: runtime and tests never fetch currency metadata.
 * Entries whose official Minor Unit is N.A. are omitted because they cannot
 * satisfy Ledger's integer minor-unit contract.
 *
 * A future snapshot may add codes, but must not silently remove a code already
 * used by a Ledger or change its exponent. Use
 * checkLedgerCurrencyMetadataCompatibility() before such an update.
 */

export const LEDGER_CURRENCY_METADATA_SOURCE =
  'SIX ISO 4217 Maintenance Agency List One (Current Currency & Funds)' as const
export const LEDGER_CURRENCY_METADATA_REVISION = '2026-01-01' as const
export const LEDGER_CURRENCY_METADATA_RETRIEVED_AT = '2026-09-03' as const
export const LEDGER_CURRENCY_METADATA_VERSION =
  `six-list-one-${LEDGER_CURRENCY_METADATA_REVISION}` as const

export type LedgerCurrencyExponentMap = Readonly<Record<string, number>>

const CURRENCY_EXPONENTS: LedgerCurrencyExponentMap = Object.freeze({
  AED: 2,
  AFN: 2,
  ALL: 2,
  AMD: 2,
  AOA: 2,
  ARS: 2,
  AUD: 2,
  AWG: 2,
  AZN: 2,
  BAM: 2,
  BBD: 2,
  BDT: 2,
  BHD: 3,
  BIF: 0,
  BMD: 2,
  BND: 2,
  BOB: 2,
  BOV: 2,
  BRL: 2,
  BSD: 2,
  BTN: 2,
  BWP: 2,
  BYN: 2,
  BZD: 2,
  CAD: 2,
  CDF: 2,
  CHE: 2,
  CHF: 2,
  CHW: 2,
  CLF: 4,
  CLP: 0,
  CNY: 2,
  COP: 2,
  COU: 2,
  CRC: 2,
  CUP: 2,
  CVE: 2,
  CZK: 2,
  DJF: 0,
  DKK: 2,
  DOP: 2,
  DZD: 2,
  EGP: 2,
  ERN: 2,
  ETB: 2,
  EUR: 2,
  FJD: 2,
  FKP: 2,
  GBP: 2,
  GEL: 2,
  GHS: 2,
  GIP: 2,
  GMD: 2,
  GNF: 0,
  GTQ: 2,
  GYD: 2,
  HKD: 2,
  HNL: 2,
  HTG: 2,
  HUF: 2,
  IDR: 2,
  ILS: 2,
  INR: 2,
  IQD: 3,
  IRR: 2,
  ISK: 0,
  JMD: 2,
  JOD: 3,
  JPY: 0,
  KES: 2,
  KGS: 2,
  KHR: 2,
  KMF: 0,
  KPW: 2,
  KRW: 0,
  KWD: 3,
  KYD: 2,
  KZT: 2,
  LAK: 2,
  LBP: 2,
  LKR: 2,
  LRD: 2,
  LSL: 2,
  LYD: 3,
  MAD: 2,
  MDL: 2,
  MGA: 2,
  MKD: 2,
  MMK: 2,
  MNT: 2,
  MOP: 2,
  MRU: 2,
  MUR: 2,
  MVR: 2,
  MWK: 2,
  MXN: 2,
  MXV: 2,
  MYR: 2,
  MZN: 2,
  NAD: 2,
  NGN: 2,
  NIO: 2,
  NOK: 2,
  NPR: 2,
  NZD: 2,
  OMR: 3,
  PAB: 2,
  PEN: 2,
  PGK: 2,
  PHP: 2,
  PKR: 2,
  PLN: 2,
  PYG: 0,
  QAR: 2,
  RON: 2,
  RSD: 2,
  RUB: 2,
  RWF: 0,
  SAR: 2,
  SBD: 2,
  SCR: 2,
  SDG: 2,
  SEK: 2,
  SGD: 2,
  SHP: 2,
  SLE: 2,
  SOS: 2,
  SRD: 2,
  SSP: 2,
  STN: 2,
  SVC: 2,
  SYP: 2,
  SZL: 2,
  THB: 2,
  TJS: 2,
  TMT: 2,
  TND: 3,
  TOP: 2,
  TRY: 2,
  TTD: 2,
  TWD: 2,
  TZS: 2,
  UAH: 2,
  UGX: 0,
  USD: 2,
  USN: 2,
  UYI: 0,
  UYU: 2,
  UYW: 4,
  UZS: 2,
  VED: 2,
  VES: 2,
  VND: 0,
  VUV: 0,
  WST: 2,
  XAD: 2,
  XAF: 0,
  XCD: 2,
  XCG: 2,
  XOF: 0,
  XPF: 0,
  YER: 2,
  ZAR: 2,
  ZMW: 2,
  ZWG: 2,
})

/** The immutable code → exponent snapshot used by all Ledger layers. */
export const LEDGER_CURRENCY_EXPONENTS = CURRENCY_EXPONENTS
/** Compatibility alias for callers that use the ISO terminology. */
export const ISO_4217_MINOR_UNIT_EXPONENTS = CURRENCY_EXPONENTS

export interface LedgerCurrencyMetadataEntry {
  readonly code: string
  readonly exponent: number
}

export const LEDGER_CURRENCY_METADATA: readonly LedgerCurrencyMetadataEntry[] =
  Object.freeze(
    Object.entries(CURRENCY_EXPONENTS).map(([code, exponent]) =>
      Object.freeze({ code, exponent })),
  )

export type LedgerCurrencyErrorCode =
  | 'invalid-currency-code'
  | 'unsupported-currency'
  | 'invalid-decimal'
  | 'fractional-precision-exceeded'
  | 'currency-amount-overflow'
  | 'currency-metadata-incompatible'

export class LedgerCurrencyError extends Error {
  readonly code: LedgerCurrencyErrorCode

  constructor(code: LedgerCurrencyErrorCode, message: string) {
    super(message)
    this.name = 'LedgerCurrencyError'
    this.code = code
  }
}

export type LedgerCurrencyMetadataCompatibility =
  | { readonly compatible: true }
  | {
      readonly compatible: false
      readonly code: 'currency-removed' | 'currency-exponent-changed'
      readonly currency: string
      readonly previousExponent?: number
      readonly nextExponent?: number
    }

const CURRENCY_CODE_RE = /^[A-Z]{3}$/
const DECIMAL_RE = /^(-?)(\d+)(?:\.(\d+))?$/
const MAX_SAFE_INTEGER_DIGITS = String(Number.MAX_SAFE_INTEGER)

/** Normalize an ISO alphabetic code without making it a locale-sensitive ID. */
export function normalizeLedgerCurrencyCode(value: unknown): string {
  if (typeof value !== 'string') {
    throw new LedgerCurrencyError('invalid-currency-code', 'currency must be a string')
  }
  const normalized = value.trim().toUpperCase()
  if (!CURRENCY_CODE_RE.test(normalized)) {
    throw new LedgerCurrencyError('invalid-currency-code', 'currency must be a three-letter ISO code')
  }
  return normalized
}

export function isSupportedLedgerCurrency(value: unknown): value is string {
  try {
    const code = normalizeLedgerCurrencyCode(value)
    return Object.prototype.hasOwnProperty.call(CURRENCY_EXPONENTS, code)
  } catch {
    return false
  }
}

export function getLedgerCurrencyExponent(value: unknown): number | undefined {
  let code: string
  try {
    code = normalizeLedgerCurrencyCode(value)
  } catch {
    return undefined
  }
  return CURRENCY_EXPONENTS[code]
}

/** Return a supported code's exponent or a deterministic currency error. */
export function currencyExponentFor(value: unknown): number {
  const code = normalizeLedgerCurrencyCode(value)
  const exponent = CURRENCY_EXPONENTS[code]
  if (exponent === undefined) {
    throw new LedgerCurrencyError('unsupported-currency', 'currency is not supported by the Ledger metadata snapshot')
  }
  return exponent
}

export const getCurrencyExponent = currencyExponentFor

export function assertSupportedLedgerCurrency(value: unknown): string {
  const code = normalizeLedgerCurrencyCode(value)
  currencyExponentFor(code)
  return code
}

function safeIntegerFromDigits(digits: string): number {
  const canonical = digits.replace(/^0+(?=\d)/, '')
  if (
    canonical.length > MAX_SAFE_INTEGER_DIGITS.length
    || (canonical.length === MAX_SAFE_INTEGER_DIGITS.length && canonical > MAX_SAFE_INTEGER_DIGITS)
  ) {
    throw new LedgerCurrencyError('currency-amount-overflow', 'decimal amount exceeds safe minor-unit range')
  }
  const value = Number(canonical)
  if (!Number.isSafeInteger(value)) {
    throw new LedgerCurrencyError('currency-amount-overflow', 'decimal amount exceeds safe minor-unit range')
  }
  return value
}

/** Parse a strict decimal string into signed integer minor units. */
export function parseDecimalToMinor(value: string, currency: string): number {
  const exponent = currencyExponentFor(currency)
  if (typeof value !== 'string') {
    throw new LedgerCurrencyError('invalid-decimal', 'decimal amount must be a string')
  }
  const match = DECIMAL_RE.exec(value)
  if (!match) {
    throw new LedgerCurrencyError('invalid-decimal', 'decimal amount has an invalid format')
  }
  const fraction = match[3] ?? ''
  if (fraction.length > exponent) {
    throw new LedgerCurrencyError(
      'fractional-precision-exceeded',
      'decimal amount has more fractional digits than the currency exponent',
    )
  }
  const minorDigits = `${match[2]}${fraction.padEnd(exponent, '0')}`
  const magnitude = safeIntegerFromDigits(minorDigits)
  return match[1] === '-' && magnitude !== 0 ? -magnitude : magnitude
}

/** Reconstruct a decimal string from signed integer minor units. */
export function formatMinorToDecimal(value: number, currency: string): string {
  const exponent = currencyExponentFor(currency)
  if (!Number.isSafeInteger(value)) {
    throw new LedgerCurrencyError('currency-amount-overflow', 'minor amount must be a safe integer')
  }
  const negative = value < 0
  const magnitude = negative ? -value : value
  const digits = String(magnitude)
  if (exponent === 0) return negative ? `-${digits}` : digits
  const padded = digits.padStart(exponent + 1, '0')
  const splitAt = padded.length - exponent
  const result = `${padded.slice(0, splitAt)}.${padded.slice(splitAt)}`
  return negative ? `-${result}` : result
}

export const decimalToMinor = parseDecimalToMinor
export const minorToDecimal = formatMinorToDecimal

/**
 * Check a proposed metadata refresh against currencies already used by a
 * Ledger. New codes are compatible; a removed or re-exponented used code is
 * not.
 */
export function checkLedgerCurrencyMetadataCompatibility(
  previous: LedgerCurrencyExponentMap,
  next: LedgerCurrencyExponentMap,
  usedCurrencies: Iterable<string>,
): LedgerCurrencyMetadataCompatibility {
  const used = [...new Set([...usedCurrencies].map((value) => value.trim().toUpperCase()))].sort()
  for (const currency of used) {
    const previousExponent = previous[currency]
    const nextExponent = next[currency]
    if (nextExponent === undefined) {
      return {
        compatible: false,
        code: 'currency-removed',
        currency,
        ...(previousExponent === undefined ? {} : { previousExponent }),
      }
    }
    if (previousExponent !== undefined && previousExponent !== nextExponent) {
      return {
        compatible: false,
        code: 'currency-exponent-changed',
        currency,
        previousExponent,
        nextExponent,
      }
    }
  }
  return { compatible: true }
}

export function assertLedgerCurrencyMetadataCompatible(
  previous: LedgerCurrencyExponentMap,
  next: LedgerCurrencyExponentMap,
  usedCurrencies: Iterable<string>,
): void {
  const result = checkLedgerCurrencyMetadataCompatibility(previous, next, usedCurrencies)
  if (!result.compatible) {
    throw new LedgerCurrencyError(
      'currency-metadata-incompatible',
      `currency metadata is incompatible for ${result.currency}`,
    )
  }
}
