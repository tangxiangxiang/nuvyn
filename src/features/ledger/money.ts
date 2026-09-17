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

export function formatLedgerSignedMoney(
  minor: number,
  currency: string,
  locale = 'zh-CN',
): string {
  if (minor === 0) return formatLedgerMoney(0, currency, locale)
  return `${minor > 0 ? '+' : '-'}${formatLedgerMoney(Math.abs(minor), currency, locale)}`
}
