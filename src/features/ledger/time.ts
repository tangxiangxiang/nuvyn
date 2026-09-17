import { Temporal } from '@js-temporal/polyfill'
import type { LedgerPeriodName } from '../../../shared/ledgerProtocol'

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** Convert a UTC instant into the Ledger timezone for datetime-local input. */
export function localDateTimeInputFromInstant(instantMs: number, timezone: string): string {
  const local = Temporal.Instant.fromEpochMilliseconds(instantMs).toZonedDateTimeISO(timezone)
  return `${String(local.year).padStart(4, '0')}-${pad(local.month)}-${pad(local.day)}T${pad(local.hour)}:${pad(local.minute)}`
}

/** Convert a Ledger-local datetime-local value to the authoritative UTC instant. */
export function instantFromLocalDateTime(value: string, timezone: string): number {
  const plain = Temporal.PlainDateTime.from(value)
  return plain.toZonedDateTime(timezone).toInstant().epochMilliseconds
}

export function openingDateInputFromInstant(instantMs: number, timezone: string): string {
  const local = Temporal.Instant.fromEpochMilliseconds(instantMs).toZonedDateTimeISO(timezone)
  return `${String(local.year).padStart(4, '0')}-${pad(local.month)}-${pad(local.day)}`
}

/** Convert a Ledger-local calendar date into an exclusive/inclusive query boundary. */
export function instantFromLedgerDate(
  value: string,
  timezone: string,
  boundary: 'start' | 'end' = 'start',
): number {
  const date = Temporal.PlainDate.from(value)
  const boundaryDate = boundary === 'end' ? date.add({ days: 1 }) : date
  return boundaryDate.toZonedDateTime({
    timeZone: timezone,
    plainTime: Temporal.PlainTime.from('00:00'),
  }).toInstant().epochMilliseconds
}

export function formatLedgerDateTime(
  instantMs: number,
  timezone: string,
  locale = 'zh-CN',
): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(instantMs))
}

/** Format a transaction timestamp for compact Ledger tables. */
export function formatLedgerTransactionDateTime(instantMs: number, timezone: string): string {
  const local = Temporal.Instant.fromEpochMilliseconds(instantMs).toZonedDateTimeISO(timezone)
  const date = `${String(local.year).padStart(4, '0')}/${pad(local.month)}/${pad(local.day)}`
  const time = `${pad(local.hour)}:${pad(local.minute)}`
  return `${date} ${time}`
}

function formatLedgerCalendarDate(
  instantMs: number,
  timezone: string,
  locale: string,
  includeYear: boolean,
): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    ...(includeYear ? { year: 'numeric' as const } : {}),
    month: 'long',
    day: 'numeric',
  }).format(new Date(instantMs))
}

function formatLedgerCalendarMonth(instantMs: number, timezone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    year: 'numeric',
    month: 'long',
  }).format(new Date(instantMs))
}

function formatLedgerCalendarYear(instantMs: number, timezone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    year: 'numeric',
  }).format(new Date(instantMs))
}

/**
 * Format a server-owned exclusive period boundary at the period's calendar
 * granularity. The end of a date range is converted to its final inclusive
 * millisecond before its calendar date is displayed.
 */
export function formatLedgerPeriodLabel(
  period: LedgerPeriodName,
  startAt: number,
  endAt: number,
  timezone: string,
  locale = 'zh-CN',
): string {
  if (period === 'month') return formatLedgerCalendarMonth(startAt, timezone, locale)
  if (period === 'year') return formatLedgerCalendarYear(startAt, timezone, locale)

  const start = Temporal.Instant.fromEpochMilliseconds(startAt).toZonedDateTimeISO(timezone)
  const endInclusiveAt = endAt - 1
  const end = Temporal.Instant.fromEpochMilliseconds(endInclusiveAt).toZonedDateTimeISO(timezone)
  const startLabel = formatLedgerCalendarDate(startAt, timezone, locale, true)

  if (period === 'today') return startLabel

  const endLabel = formatLedgerCalendarDate(endInclusiveAt, timezone, locale, start.year !== end.year)
  return `${startLabel} – ${endLabel}`
}

/** Format a period anchor exactly as the matching Naive UI picker displays it. */
export function formatLedgerPeriodPickerLabel(period: LedgerPeriodName, date: string): string {
  const plainDate = Temporal.PlainDate.from(date)
  if (period === 'today') return date
  if (period === 'month') return date.slice(0, 7)
  if (period === 'year') return date.slice(0, 4)

  // Naive UI's zh-CN date locale uses ISO week numbering: Monday starts the
  // week and the week containing January 4 is week one.
  const weekYearDate = plainDate.add({ days: 4 - plainDate.dayOfWeek })
  const januaryFourth = Temporal.PlainDate.from({ year: weekYearDate.year, month: 1, day: 4 })
  const firstWeekStart = januaryFourth.subtract({ days: januaryFourth.dayOfWeek - 1 })
  const daysFromFirstWeek = firstWeekStart.until(plainDate, { largestUnit: 'days' }).days
  const weekNumber = Math.floor(daysFromFirstWeek / 7) + 1
  return `${weekYearDate.year}-${weekNumber}周`
}

export function formatLedgerDate(
  date: string,
  timezone: string,
  locale = 'zh-CN',
): string {
  const plain = Temporal.PlainDate.from(date)
  const instant = plain.toZonedDateTime({ timeZone: timezone, plainTime: Temporal.PlainTime.from('00:00') })
    .toInstant().epochMilliseconds
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    dateStyle: 'medium',
  }).format(new Date(instant))
}

export function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}
