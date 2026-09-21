import {
  currencyExponentFor,
  formatMinorToDecimal,
  parseDecimalToMinor,
} from '../../../shared/ledgerCurrency'

export { currencyExponentFor }

/** Parse the decimal string users understand at the UI boundary. */
export function parseLedgerMoney(value: string, currency: string): number {
  return parseDecimalToMinor(value.trim(), currency)
}

export function ledgerDecimalFromMinor(value: number, currency: string): string {
  return formatMinorToDecimal(value, currency)
}

/**
 * Formatting is presentation only. Financial calculations remain integer
 * minor-unit values from the server. Intl receives the exact integer portion
 * as a BigInt so a large safe minor amount never makes a lossy Number round
 * trip before it reaches the screen.
 */
export function formatLedgerMoney(
  minor: number,
  currency: string,
  locale = 'zh-CN',
): string {
  const exponent = currencyExponentFor(currency)
  if (!Number.isSafeInteger(minor)) {
    throw new RangeError('minor amount must be a safe integer')
  }

  const negative = minor < 0
  const magnitude = BigInt(negative ? -minor : minor)
  const digits = magnitude.toString()
  const padded = exponent === 0 ? digits : digits.padStart(exponent + 1, '0')
  const integerDigits = exponent === 0 ? padded : padded.slice(0, -exponent)
  const fractionDigits = exponent === 0 ? '' : padded.slice(-exponent)
  const decimal = negative
    ? `-${exponent === 0 ? integerDigits : `${integerDigits}.${fractionDigits}`}`
    : exponent === 0 ? integerDigits : `${integerDigits}.${fractionDigits}`

  try {
    const formatter = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      currencyDisplay: 'symbol',
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    })
    const integerMagnitude = BigInt(integerDigits)
    // BigInt has no negative zero. Use -1n only to obtain the locale's
    // negative-sign/currency pattern for values such as -0.01, then replace
    // its integer token with the localized zero token.
    const patternValue = negative
      ? integerMagnitude === 0n ? -1n : -integerMagnitude
      : integerMagnitude
    const parts = formatter.formatToParts(patternValue)
    const localizedZero = integerMagnitude === 0n
      ? formatter.formatToParts(0n).find((part) => part.type === 'integer')?.value
      : undefined
    return parts.map((part) => {
      if (part.type === 'fraction') return fractionDigits
      if (part.type === 'integer' && localizedZero !== undefined) return localizedZero
      return part.value
    }).join('')
  } catch {
    return `${currency} ${decimal}`
  }
}

/** Format a money value rounded to whole major currency units for compact UI. */
export function formatLedgerWholeMoney(
  minor: number,
  currency: string,
  locale = 'zh-CN',
): string {
  const exponent = currencyExponentFor(currency)
  if (!Number.isSafeInteger(minor)) {
    throw new RangeError('minor amount must be a safe integer')
  }
  if (exponent === 0) return formatLedgerMoney(minor, currency, locale)

  const negative = minor < 0
  const magnitude = BigInt(negative ? -minor : minor)
  const unit = 10n ** BigInt(exponent)
  const integerMagnitude = magnitude / unit
  const roundedMagnitude = magnitude % unit * 2n >= unit
    ? integerMagnitude + 1n
    : integerMagnitude

  try {
    const formatter = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      currencyDisplay: 'symbol',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    })
    // Preserve a negative sign when a small negative amount rounds to zero.
    const patternValue = negative
      ? roundedMagnitude === 0n ? -1n : -roundedMagnitude
      : roundedMagnitude
    const parts = formatter.formatToParts(patternValue)
    const localizedZero = roundedMagnitude === 0n
      ? formatter.formatToParts(0n).find((part) => part.type === 'integer')?.value
      : undefined
    return parts.map((part) => (
      part.type === 'integer' && localizedZero !== undefined ? localizedZero : part.value
    )).join('')
  } catch {
    return `${currency} ${negative ? '-' : ''}${roundedMagnitude.toString()}`
  }
}

/** Format a rounded money value with a short unit for space-constrained UI. */
export function formatLedgerCompactMoney(
  minor: number,
  currency: string,
): string {
  const exponent = currencyExponentFor(currency)
  if (!Number.isSafeInteger(minor)) {
    throw new RangeError('minor amount must be a safe integer')
  }

  const negative = minor < 0
  const magnitude = BigInt(negative ? -minor : minor)
  const unit = 10n ** BigInt(exponent)
  // Never turn a real sub-unit movement into a misleading zero. The compact
  // formatter may round whole major units, but values such as -¥0.01 remain
  // exact and retain the currency exponent.
  if (magnitude > 0n && magnitude < unit) return formatLedgerMoney(minor, currency)
  const integerMagnitude = magnitude / unit
  const roundedMagnitude = magnitude % unit * 2n >= unit
    ? integerMagnitude + 1n
    : integerMagnitude

  try {
    // en-US makes the compact threshold useful for narrow screens (1k rather
    // than waiting until 10,000 for zh-CN's first compact unit). The currency
    // still uses its narrow symbol, so CNY remains ¥1k and USD remains $1k.
    const formatter = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      notation: 'compact',
      compactDisplay: 'short',
      minimumFractionDigits: 0,
      maximumFractionDigits: 1,
    })
    // Preserve a negative sign when a small negative amount rounds to zero.
    const patternValue = negative
      ? roundedMagnitude === 0n ? -1n : -roundedMagnitude
      : roundedMagnitude
    const parts = formatter.formatToParts(patternValue)
    const localizedZero = roundedMagnitude === 0n
      ? formatter.formatToParts(0n).find((part) => part.type === 'integer')?.value
      : undefined
    return parts.map((part) => {
      if (part.type === 'integer' && localizedZero !== undefined) return localizedZero
      if (part.type === 'compact' && part.value === 'K') return 'k'
      return part.value
    }).join('')
  } catch {
    return formatLedgerWholeMoney(minor, currency)
  }
}

export function formatLedgerSignedMoney(
  minor: number,
  currency: string,
  locale = 'zh-CN',
): string {
  if (minor === 0) return formatLedgerMoney(0, currency, locale)
  return `${minor > 0 ? '+' : '-'}${formatLedgerMoney(Math.abs(minor), currency, locale)}`
}
