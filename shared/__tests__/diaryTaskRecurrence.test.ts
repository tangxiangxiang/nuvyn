import { describe, expect, it } from 'vitest'
import { parseTaskRecurrenceRule, taskRecurrenceDates, taskRecurrenceOccursOn } from '../diaryTaskRecurrence'

describe('Diary task recurrence', () => {
  it('validates bounded Gregorian recurrence rules', () => {
    expect(parseTaskRecurrenceRule({ frequency: 'daily', startDate: '2026-01-01', untilDate: null }))
      .toEqual({ frequency: 'daily', startDate: '2026-01-01', untilDate: null })
    expect(parseTaskRecurrenceRule({ frequency: 'weekdays', startDate: '2026-01-01', untilDate: null })).toBeNull()
    expect(parseTaskRecurrenceRule({ frequency: 'daily', startDate: '2026-02-29', untilDate: null })).toBeNull()
    expect(parseTaskRecurrenceRule({ frequency: 'daily', startDate: '2026-01-02', untilDate: '2026-01-01' })).toBeNull()
  })

  it('supports daily and weekly natural-date cadence', () => {
    const daily = { frequency: 'daily' as const, startDate: '2026-11-18', untilDate: '2026-11-20' }
    expect(taskRecurrenceDates(daily, '2026-11-17', '2026-11-22')).toEqual([
      '2026-11-18', '2026-11-19', '2026-11-20',
    ])

    const weekly = { frequency: 'weekly' as const, startDate: '2026-11-18', untilDate: null }
    expect(taskRecurrenceDates(weekly, '2026-11-01', '2026-12-10')).toEqual([
      '2026-11-18', '2026-11-25', '2026-12-02', '2026-12-09',
    ])
  })

  it('keeps monthly dates anchored to the original day at month end', () => {
    const monthly = { frequency: 'monthly' as const, startDate: '2026-01-31', untilDate: null }
    expect(taskRecurrenceDates(monthly, '2026-01-01', '2026-05-01')).toEqual([
      '2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30',
    ])
    expect(taskRecurrenceOccursOn(monthly, '2026-03-28')).toBe(false)
  })

  it('uses February 28 for a February 29 yearly anchor in non-leap years', () => {
    const yearly = { frequency: 'yearly' as const, startDate: '2024-02-29', untilDate: null }
    expect(taskRecurrenceDates(yearly, '2024-01-01', '2028-03-01', yearly.startDate, 2000)).toEqual([
      '2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29',
    ])
  })

  it('honors effective-from and inclusive until dates without unbounded expansion', () => {
    const rule = { frequency: 'daily' as const, startDate: '2026-01-01', untilDate: '2026-01-03' }
    expect(taskRecurrenceDates(rule, '2026-01-01', '2026-01-05', '2026-01-02')).toEqual(['2026-01-02', '2026-01-03'])
    expect(() => taskRecurrenceDates({ ...rule, untilDate: null }, '2026-01-01', '2027-01-02', rule.startDate, 366)).toThrow(RangeError)
    expect(taskRecurrenceOccursOn({ ...rule, untilDate: '9999-12-31' }, '9999-12-31')).toBe(true)
  })
})
