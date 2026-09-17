// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { instantFromLocalDateTime, localDateTimeInputFromInstant } from '../time'
import {
  calendarDateFromNaivePickerTimestamp,
  composeLedgerLocalDateTime,
  splitLedgerLocalDateTime,
} from '../naiveTemporal'

describe('Ledger Naive temporal adapter', () => {
  it('splits and composes the canonical Ledger wall-clock model without Date', () => {
    const value = '2026-01-01T00:30'

    expect(splitLedgerLocalDateTime(value)).toEqual({ date: '2026-01-01', time: '00:30' })
    expect(composeLedgerLocalDateTime('2026-01-01', '00:30')).toBe(value)
    expect(composeLedgerLocalDateTime('2026-01-01', '')).toBe('')
    expect(splitLedgerLocalDateTime('2026-01-01T00:30:00')).toEqual({ date: '', time: '' })
  })

  it('round-trips a date/time picker value through the Ledger timezone authority', () => {
    const value = '2026-01-01T00:30'
    const instant = instantFromLocalDateTime(value, 'Asia/Shanghai')

    // The adapter preserves the wall-clock value. Only the existing Ledger
    // time authority turns it into an instant and back again.
    expect(composeLedgerLocalDateTime(...Object.values(splitLedgerLocalDateTime(value)) as [string, string])).toBe(value)
    expect(localDateTimeInputFromInstant(instant, 'Asia/Shanghai')).toBe(value)
  })

  it('formats picker disable timestamps in the picker browser calendar only', () => {
    const localCalendarCoordinate = new Date(2026, 8, 5, 12, 30).getTime()
    expect(calendarDateFromNaivePickerTimestamp(localCalendarCoordinate)).toBe('2026-09-05')
  })
})
