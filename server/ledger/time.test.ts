import { describe, expect, it } from 'vitest'
import { LedgerError } from './errors.js'
import {
  IANA_TIME_ZONE_ID_RE,
  LEDGER_FUTURE_SKEW_MS,
  assertIanaTimeZoneId,
  assertOpeningDate,
  assertUtcMilliseconds,
  calendarDayPointsForInstant,
  calendarMonthRanges,
  calendarMonthRangesForLocalDate,
  ledgerLocalDateForInstant,
  localDateRange,
  monthRange,
  openingBoundaryMs,
  parseLedgerLocalDate,
  periodRange,
  periodRangesForLocalDate,
  periodRangesForInstant,
  todayRange,
  validateOccurredAt,
  weekRange,
  yearRange,
} from './time.js'

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

describe('Ledger named timezone and UTC primitives', () => {
  it('accepts valid single-component and slash-separated IANA names', () => {
    for (const timezone of ['UTC', 'CET', 'PST8PDT', 'Asia/Shanghai', 'America/Los_Angeles']) {
      expect(IANA_TIME_ZONE_ID_RE.test(timezone)).toBe(true)
      expect(assertIanaTimeZoneId(timezone)).toBe(timezone)
    }
  })

  it('rejects offsets, datetime expressions, whitespace, and unknown names', () => {
    for (const timezone of [
      '+08:00',
      '-05',
      '-05:00',
      '2026-09-03T00:00+08:00',
      '2026-09-03T00:00+08:00[Asia/Shanghai]',
      'Definitely/Not_A_Zone',
      ' Asia/Shanghai',
      'Asia/Shanghai ',
    ]) {
      expect(() => assertIanaTimeZoneId(timezone)).toThrow(LedgerError)
    }
  })

  it('validates strict Gregorian opening dates and UTC milliseconds', () => {
    expect(assertOpeningDate('2026-02-28')).toBe('2026-02-28')
    expect(() => assertOpeningDate('2026-02-30')).toThrow()
    expect(() => assertOpeningDate('2026-13-01')).toThrow()
    expect(() => assertOpeningDate('2026-1-01')).toThrow()
    expect(assertUtcMilliseconds(0)).toBe(0)
    expect(assertUtcMilliseconds(-1)).toBe(-1)
    expect(() => assertUtcMilliseconds(1.5)).toThrow()
    expect(() => assertUtcMilliseconds(Number.MAX_SAFE_INTEGER)).toThrow()
  })

  it('validates generic Ledger local dates without changing opening-date errors', () => {
    expect(parseLedgerLocalDate('2026-08-20', 'anchorDate')).toBe('2026-08-20')
    expect(parseLedgerLocalDate('2024-02-29', 'anchorDate')).toBe('2024-02-29')
    for (const value of ['2026-8-20', '2026-02-30', '2026-99-99', 'abc']) {
      expect(() => parseLedgerLocalDate(value, 'anchorDate')).toThrow(LedgerError)
    }
    expect(() => assertOpeningDate('2026-02-30')).toThrow(LedgerError)
  })

  it('resolves the same instant to the Ledger-local date in the configured timezone', () => {
    const instant = Date.parse('2026-09-05T16:30:00.000Z')
    expect(ledgerLocalDateForInstant(instant, 'Asia/Shanghai')).toBe('2026-09-06')
    expect(ledgerLocalDateForInstant(instant, 'America/Los_Angeles')).toBe('2026-09-05')
  })
})

describe('Ledger DST-safe local calendar periods', () => {
  it('builds account trend points from Ledger-local dates across DST', () => {
    const points = calendarDayPointsForInstant(
      3,
      3,
      Date.parse('2024-03-11T12:00:00.000Z'),
      'America/Los_Angeles',
    )
    expect(points.map((point) => point.date)).toEqual(['2024-03-09', '2024-03-10', '2024-03-11'])
    expect(iso(points[0]!.startMs)).toBe('2024-03-09T08:00:00.000Z')
    expect(iso(points[1]!.startMs)).toBe('2024-03-10T08:00:00.000Z')
    expect(iso(points[2]!.startMs)).toBe('2024-03-11T07:00:00.000Z')
  })

  it('uses Monday as the week boundary and half-open ranges', () => {
    const instant = Date.parse('2026-09-02T04:00:00.000Z')
    const today = todayRange(instant, 'Asia/Shanghai')
    const week = weekRange(instant, 'Asia/Shanghai')
    const month = monthRange(instant, 'Asia/Shanghai')
    const year = yearRange(instant, 'Asia/Shanghai')

    expect(iso(today.startMs)).toBe('2026-09-01T16:00:00.000Z')
    expect(iso(today.endMs)).toBe('2026-09-02T16:00:00.000Z')
    expect(iso(week.startMs)).toBe('2026-08-30T16:00:00.000Z')
    expect(iso(week.endMs)).toBe('2026-09-06T16:00:00.000Z')
    expect(iso(month.startMs)).toBe('2026-08-31T16:00:00.000Z')
    expect(iso(month.endMs)).toBe('2026-09-30T16:00:00.000Z')
    expect(iso(year.startMs)).toBe('2025-12-31T16:00:00.000Z')
    expect(iso(year.endMs)).toBe('2026-12-31T16:00:00.000Z')
    expect(today.startMs < instant).toBe(true)
    expect(today.endMs > instant).toBe(true)
    expect(today.endMs - today.startMs).toBe(86_400_000)
    expect(week.startMs < week.endMs).toBe(true)
  })

  it('returns all fixed periods from one Ledger instant', () => {
    const periods = periodRangesForInstant(Date.parse('2026-09-02T04:00:00.000Z'), 'Asia/Shanghai')
    expect(Object.keys(periods)).toEqual(['today', 'week', 'month', 'year'])
    expect(iso(periods.today.startMs)).toBe('2026-09-01T16:00:00.000Z')
    expect(iso(periods.week.startMs)).toBe('2026-08-30T16:00:00.000Z')
    expect(iso(periods.month.startMs)).toBe('2026-08-31T16:00:00.000Z')
    expect(iso(periods.year.startMs)).toBe('2025-12-31T16:00:00.000Z')
  })

  it('converts opening dates and local days without assuming a 24-hour day', () => {
    expect(iso(openingBoundaryMs('2024-03-10', 'America/Los_Angeles'))).toBe('2024-03-10T08:00:00.000Z')
    const spring = localDateRange('2024-03-10', 'America/Los_Angeles')
    const fall = localDateRange('2024-11-03', 'America/Los_Angeles')
    const Shanghai = localDateRange('2024-03-10', 'Asia/Shanghai')
    expect(iso(spring.startMs)).toBe('2024-03-10T08:00:00.000Z')
    expect(iso(spring.endMs)).toBe('2024-03-11T07:00:00.000Z')
    expect(spring.endMs - spring.startMs).toBe(23 * 60 * 60 * 1_000)
    expect(iso(fall.startMs)).toBe('2024-11-03T07:00:00.000Z')
    expect(iso(fall.endMs)).toBe('2024-11-04T08:00:00.000Z')
    expect(fall.endMs - fall.startMs).toBe(25 * 60 * 60 * 1_000)
    expect(Shanghai.endMs - Shanghai.startMs).toBe(24 * 60 * 60 * 1_000)
  })

  it('allows exactly the configured future skew and rejects beyond it', () => {
    const now = 1_700_000_000_000
    expect(validateOccurredAt(now + LEDGER_FUTURE_SKEW_MS, now)).toBe(now + LEDGER_FUTURE_SKEW_MS)
    expect(() => validateOccurredAt(now + LEDGER_FUTURE_SKEW_MS + 1, now)).toThrow()
    expect(validateOccurredAt(now - 1, now)).toBe(now - 1)
  })

  it('uses [start,end) boundary semantics for a period', () => {
    const range = periodRange('month', Date.parse('2026-09-02T04:00:00.000Z'), 'Asia/Shanghai')
    const nextRange = periodRange('month', range.endMs, 'Asia/Shanghai')
    const includes = (instant: number, candidate: { startMs: number; endMs: number }) => (
      instant >= candidate.startMs && instant < candidate.endMs
    )

    expect(includes(range.startMs, range)).toBe(true)
    expect(includes(range.endMs, range)).toBe(false)
    expect(includes(range.endMs, nextRange)).toBe(true)
    expect(nextRange.startMs).toBe(range.endMs)
  })

  it('builds DST-safe consecutive calendar-month ranges', () => {
    const spring = calendarMonthRanges(
      2,
      Date.parse('2024-03-10T12:00:00.000Z'),
      'America/Los_Angeles',
    )
    expect(spring.map((range) => range.month)).toEqual(['2024-02', '2024-03'])
    expect(iso(spring[0].startMs)).toBe('2024-02-01T08:00:00.000Z')
    expect(iso(spring[0].endMs)).toBe('2024-03-01T08:00:00.000Z')
    expect(iso(spring[1].endMs)).toBe('2024-04-01T07:00:00.000Z')

    const fall = calendarMonthRanges(
      2,
      Date.parse('2024-11-04T12:00:00.000Z'),
      'America/Los_Angeles',
    )
    expect(fall.map((range) => range.month)).toEqual(['2024-10', '2024-11'])
    expect(iso(fall[1].startMs)).toBe('2024-11-01T07:00:00.000Z')
    expect(iso(fall[1].endMs)).toBe('2024-12-01T08:00:00.000Z')
  })

  it('builds anchored full periods and six complete months from a local date', () => {
    const periods = periodRangesForLocalDate('2026-08-20', 'Asia/Shanghai')
    expect(iso(periods.today.startMs)).toBe('2026-08-19T16:00:00.000Z')
    expect(iso(periods.today.endMs)).toBe('2026-08-20T16:00:00.000Z')
    expect(iso(periods.week.startMs)).toBe('2026-08-16T16:00:00.000Z')
    expect(iso(periods.week.endMs)).toBe('2026-08-23T16:00:00.000Z')
    expect(iso(periods.month.startMs)).toBe('2026-07-31T16:00:00.000Z')
    expect(iso(periods.month.endMs)).toBe('2026-08-31T16:00:00.000Z')
    expect(iso(periods.year.startMs)).toBe('2025-12-31T16:00:00.000Z')
    expect(iso(periods.year.endMs)).toBe('2026-12-31T16:00:00.000Z')

    const crossYear = periodRangesForLocalDate('2027-01-01', 'Asia/Shanghai')
    expect(iso(crossYear.week.startMs)).toBe('2026-12-27T16:00:00.000Z')
    expect(iso(crossYear.week.endMs)).toBe('2027-01-03T16:00:00.000Z')

    expect(calendarMonthRangesForLocalDate(6, '2025-06-15', 'Asia/Shanghai').map((range) => range.month))
      .toEqual(['2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06'])
  })
})
