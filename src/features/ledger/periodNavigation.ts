import { Temporal } from '@js-temporal/polyfill'

const LEDGER_LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Parse a browser route/date-input value as a strict Gregorian local date.
 * This helper deliberately does not compare the value with today: the Server
 * remains the authority for future-date validation.
 */
export function parseLedgerRouteDate(value: unknown): string | null {
  if (typeof value !== 'string' || !LEDGER_LOCAL_DATE_RE.test(value)) return null
  try {
    Temporal.PlainDate.from(value, { overflow: 'reject' })
    return value
  } catch {
    return null
  }
}

export const parseLedgerLocalDate = parseLedgerRouteDate

export function isValidLedgerRouteDate(value: unknown): value is string {
  return parseLedgerRouteDate(value) !== null
}
