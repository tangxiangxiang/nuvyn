export type LedgerLocalDateTimeParts = {
  date: string
  time: string
}

/**
 * Split the canonical Ledger wall-clock value without constructing a Date.
 * The browser timezone must never participate in this conversion.
 */
export function splitLedgerLocalDateTime(value: string): LedgerLocalDateTimeParts {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(value)
  return match ? { date: match[1]!, time: match[2]! } : { date: '', time: '' }
}

/** Compose the existing Ledger wall-clock model from Naive date/time fields. */
export function composeLedgerLocalDateTime(date: string, time: string): string {
  return date && time ? `${date}T${time}` : ''
}

/**
 * NDatePicker gives isDateDisabled a timestamp representing the picker's
 * browser calendar coordinate. Formatting it in that same local coordinate
 * recovers the displayed calendar date; it is not a Ledger instant.
 */
export function calendarDateFromNaivePickerTimestamp(timestamp: number): string {
  const date = new Date(timestamp)
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
