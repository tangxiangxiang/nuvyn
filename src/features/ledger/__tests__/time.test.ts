// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  formatLedgerDateTime,
  formatLedgerPeriodLabel,
  formatLedgerPeriodPickerLabel,
  formatLedgerTransactionDateTime,
  instantFromLedgerDate,
  instantFromLocalDateTime,
  localDateTimeInputFromInstant,
  openingDateInputFromInstant,
} from '../time'
import { parseLedgerRouteDate } from '../periodNavigation'

describe('Ledger timezone presentation boundary', () => {
  it('round-trips a Ledger-local datetime through a UTC instant', () => {
    const instant = instantFromLocalDateTime('2026-08-20T09:30', 'Asia/Shanghai')
    expect(localDateTimeInputFromInstant(instant, 'Asia/Shanghai')).toBe('2026-08-20T09:30')
    expect(localDateTimeInputFromInstant(instant, 'UTC')).toBe('2026-08-20T01:30')
  })

  it('formats using the explicit Ledger timezone rather than the browser default', () => {
    const instant = instantFromLocalDateTime('2026-08-20T00:30', 'Asia/Shanghai')
    expect(formatLedgerDateTime(instant, 'Asia/Shanghai')).toContain('2026')
  })

  it('formats transaction timestamps with zero-padded numeric date and time', () => {
    const instant = instantFromLocalDateTime('2026-09-13T00:11', 'Asia/Shanghai')
    expect(formatLedgerTransactionDateTime(instant, 'Asia/Shanghai')).toBe('2026/09/13 00:11')
  })

  it('formats today at calendar-date granularity', () => {
    const startAt = instantFromLocalDateTime('2026-09-05T00:00', 'Asia/Shanghai')
    const endAt = instantFromLocalDateTime('2026-09-06T00:00', 'Asia/Shanghai')

    expect(formatLedgerPeriodLabel('today', startAt, endAt, 'Asia/Shanghai')).toBe('2026年9月5日')
    expect(formatLedgerPeriodLabel('today', startAt, endAt, 'Asia/Shanghai')).not.toMatch(/00:00|23:59/)
  })

  it('formats week, month, and year at their period granularity', () => {
    const shanghaiMidnight = (date: string) => instantFromLocalDateTime(`${date}T00:00`, 'Asia/Shanghai')

    expect(formatLedgerPeriodLabel('week', shanghaiMidnight('2026-08-31'), shanghaiMidnight('2026-09-07'), 'Asia/Shanghai'))
      .toBe('2026年8月31日 – 9月6日')
    expect(formatLedgerPeriodLabel('week', shanghaiMidnight('2026-12-28'), shanghaiMidnight('2027-01-04'), 'Asia/Shanghai'))
      .toBe('2026年12月28日 – 2027年1月3日')
    expect(formatLedgerPeriodLabel('month', shanghaiMidnight('2026-09-01'), shanghaiMidnight('2026-10-01'), 'Asia/Shanghai'))
      .toBe('2026年9月')
    expect(formatLedgerPeriodLabel('year', shanghaiMidnight('2026-01-01'), shanghaiMidnight('2027-01-01'), 'Asia/Shanghai'))
      .toBe('2026年')
  })

  it('matches the Naive UI picker text for each period type', () => {
    expect(formatLedgerPeriodPickerLabel('today', '2026-09-08')).toBe('2026-09-08')
    expect(formatLedgerPeriodPickerLabel('week', '2026-09-08')).toBe('2026-37周')
    expect(formatLedgerPeriodPickerLabel('month', '2026-09-08')).toBe('2026-09')
    expect(formatLedgerPeriodPickerLabel('year', '2026-09-08')).toBe('2026')
    expect(formatLedgerPeriodPickerLabel('week', '2027-01-01')).toBe('2026-53周')
  })

  it('uses the Ledger timezone when determining the displayed calendar date', () => {
    const instant = Date.UTC(2026, 8, 4, 16, 30)

    expect(formatLedgerPeriodLabel('today', instant, instant + 86_400_000, 'Asia/Shanghai')).toBe('2026年9月5日')
    expect(formatLedgerPeriodLabel('today', instant, instant + 86_400_000, 'America/Los_Angeles')).toBe('2026年9月4日')
  })

  it('keeps canonical date-only values stable for representative calendar dates', () => {
    for (const date of ['2026-01-01', '2026-02-28', '2026-12-31']) {
      expect(parseLedgerRouteDate(date)).toBe(date)
      const start = instantFromLedgerDate(date, 'Asia/Shanghai', 'start')
      expect(openingDateInputFromInstant(start, 'Asia/Shanghai')).toBe(date)
    }

    expect(parseLedgerRouteDate('')).toBeNull()
  })

  it('uses Ledger-zone boundaries for date-only filters rather than browser-zone boundaries', () => {
    const expected: Record<string, readonly [number, number]> = {
      UTC: [1767225600000, 1767312000000],
      'Asia/Shanghai': [1767196800000, 1767283200000],
      'America/New_York': [1767243600000, 1767330000000],
    }

    for (const [timezone, [start, end]] of Object.entries(expected)) {
      expect(instantFromLedgerDate('2026-01-01', timezone, 'start')).toBe(start)
      expect(instantFromLedgerDate('2026-01-01', timezone, 'end')).toBe(end)
    }
  })

  it('retains Temporal disambiguation for nonexistent and ambiguous Ledger wall-clock times', () => {
    expect(instantFromLocalDateTime('2026-03-08T02:30', 'America/New_York')).toBe(1772955000000)
    expect(instantFromLocalDateTime('2026-11-01T01:30', 'America/New_York')).toBe(1793511000000)

    expect(localDateTimeInputFromInstant(1772955000000, 'America/New_York')).toBe('2026-03-08T03:30')
    expect(localDateTimeInputFromInstant(1793511000000, 'America/New_York')).toBe('2026-11-01T01:30')
  })
})
