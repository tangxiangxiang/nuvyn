import { describe, expect, it } from 'vitest'
import { civilDate, dayDistance, eventOccurrenceStart, nextOccurrence, occurrenceInYear, occursOn, parseDay, parseEvent, type EventFields } from '../diaryLife'

const event: EventFields = { title: '生日', description: '', emoji: '🎂', type: 'anniversary', startDate: '2024-02-29', endDate: '2024-02-29', startTime: null, endTime: null, allDay: true, recurrence: 'yearly', showCountdown: true, isPrimary: false }
describe('Diary natural days', () => {
  it('normalizes legacy descriptions without losing their original text', () => {
    for (const value of ['2025-02-29', '2026-04-31', '2026-1-01', '0000-01-01', '2026-11-15T00:00:00Z']) expect(civilDate(value)).toBe(false)
    expect(civilDate('2024-02-29')).toBe(true)
    expect(parseDay({ moodId: null, description: '  第一行  \n第二行\n' })).toEqual({ moodId: null, entries: ['  第一行  \n第二行\n'] })
    expect(parseDay({ moodId: null, description: '' })).toEqual({ moodId: null, entries: [] })
    expect(parseDay({ moodId: 'not-a-mood', entries: [] })).toBeNull()
  })
  it('validates Bullet Entries limits without truncating existing 4000-character records', () => {
    const legacy = '日'.repeat(4000)
    expect(parseDay({ moodId: 'happy', description: legacy })).toEqual({ moodId: 'happy', entries: [legacy] })
    expect(parseDay({ moodId: null, description: `${legacy}x` })).toBeNull()
    expect(parseDay({ moodId: null, entries: ['一', '  ', '二\n行'] })).toEqual({ moodId: null, entries: ['一', '二\n行'] })
    expect(parseDay({ moodId: null, entries: Array.from({ length: 101 }, () => 'a') })).toBeNull()
    expect(parseDay({ moodId: null, entries: ['a'.repeat(4001)] })).toBeNull()
    expect(parseDay({ moodId: null, entries: ['a'.repeat(2500), 'b'.repeat(1501)] })).toBeNull()
  })
  it('keeps legacy days positionless and validates stable entry-to-image groups', () => {
    const entryIds = [
      '08a5c822-0d61-4e6c-a62c-1931a4da0771',
      '08a5c822-0d61-4e6c-a62c-1931a4da0772',
    ]
    const ids = Array.from({ length: 10 }, (_, index) => `18a5c822-0d61-4e6c-a62c-1931a4da0${String(index).padStart(3, '0')}`)
    expect(parseDay({ moodId: null, entries: ['旧日记'] })).toEqual({ moodId: null, entries: ['旧日记'] })
    expect(parseDay({ moodId: null, entries: [], imageGroups: [{ entryId: null, attachmentIds: [ids[0]] }] })?.imageGroups)
      .toEqual([{ entryId: null, attachmentIds: [ids[0]] }])
    expect(parseDay({ moodId: null, entries: ['旧日记'], imageGroups: [{ entryId: '08a5c822-0d61-4e6c-a62c-1931a4da0771', attachmentIds: [ids[0]] }] })).toBeNull()
    expect(parseDay({ moodId: null, entries: ['早餐'], entryIds: [entryIds[0]], imageGroups: [{ entryId: entryIds[0], attachmentIds: [ids[0]] }] }))
      .toEqual({ moodId: null, entries: ['早餐'], entryIds: [entryIds[0]], imageGroups: [{ entryId: entryIds[0], attachmentIds: [ids[0]] }] })
    expect(parseDay({ moodId: null, entries: ['早餐'], entryIds: [entryIds[0]], imageGroups: [{ entryId: entryIds[0], attachmentIds: ids.slice(0, 9) }] })?.imageGroups?.[0]?.attachmentIds).toHaveLength(9)
    expect(parseDay({ moodId: null, entries: ['早餐', '学习'], entryIds, imageGroups: [
      { entryId: entryIds[0], attachmentIds: [ids[0]] },
      { entryId: entryIds[1], attachmentIds: [ids[1]] },
    ] })?.imageGroups).toHaveLength(2)
    expect(parseDay({ moodId: null, entries: ['早餐'], entryIds: [entryIds[0]], imageGroups: [{ entryId: entryIds[0], attachmentIds: [ids[0], ids[0]] }] })).toBeNull()
    expect(parseDay({ moodId: null, entries: ['早餐'], entryIds: [entryIds[0]], imageGroups: [{ entryId: entryIds[1], attachmentIds: [ids[0]] }] })).toBeNull()
    expect(parseDay({ moodId: null, entries: ['早餐', ''], entryIds, imageGroups: [{ entryId: entryIds[1], attachmentIds: [ids[0]] }] })?.imageGroups?.[0]?.entryId).toBeNull()
  })
  it('constrains Feb 29 to Feb 28 and finds the next year after occurrence', () => {
    expect(nextOccurrence(event, '2025-02-01')).toBe('2025-02-28')
    expect(nextOccurrence(event, '2025-03-01')).toBe('2026-02-28')
    expect(nextOccurrence(event, '2028-01-01')).toBe('2028-02-29')
    expect(occursOn(event, '2025-02-28')).toBe(true)
    expect(occursOn(event, '2023-02-28')).toBe(false)
  })
  it('uses civil days across DST and year boundaries', () => {
    expect(dayDistance('2026-03-07', '2026-03-09')).toBe(2)
    expect(dayDistance('2026-10-31', '2026-11-02')).toBe(2)
    expect(dayDistance('2026-12-31', '2027-01-01')).toBe(1)
    const trip = { ...event, startDate: '2024-12-30', endDate: '2025-01-02' }
    expect(occursOn(trip, '2027-01-01')).toBe(true)
    expect(occursOn(trip, '2027-01-03')).toBe(false)
    expect(eventOccurrenceStart(trip, '2027-01-01')).toBe('2026-12-30')
    const oneTimeTrip = { ...trip, recurrence: 'none' as const }
    expect(eventOccurrenceStart(oneTimeTrip, '2024-12-31')).toBe('2024-12-30')
  })
  it('prefers an exact annual occurrence start when long event ranges overlap', () => {
    const longAnnualEvent = {
      ...event,
      startDate: '2020-06-01',
      endDate: '2021-06-02',
    }
    expect(eventOccurrenceStart(longAnnualEvent, '2021-06-01')).toBe('2021-06-01')
    expect(eventOccurrenceStart(longAnnualEvent, '2021-06-02')).toBe('2021-06-01')
  })
  it('does not count expired one-time events', () => {
    expect(nextOccurrence({ ...event, recurrence: 'none' }, '2025-01-01')).toBeNull()
  })
  it('validates times, ranges, and required title', () => {
    expect(parseEvent({ ...event, title: ' ' })).toBeNull()
    expect(parseEvent({ ...event, endDate: '2024-02-28' })).toBeNull()
    expect(parseEvent({ ...event, allDay: false, startTime: '25:00' })).toBeNull()
    expect(parseEvent({ ...event, allDay: false, startTime: '13:00', endTime: '12:00' })).toBeNull()
    expect(parseEvent({ ...event, allDay: false, endDate: '2024-03-01', startTime: '13:00', endTime: '12:00' })).not.toBeNull()
  })
  it('defaults legacy events to Gregorian and calculates validated lunar yearly occurrences', () => {
    expect(parseEvent(event)?.dateRule).toEqual({ calendar: 'gregory' })
    const lunarRule = {
      calendar: 'chinese' as const,
      lunarMonth: 5,
      lunarDay: 19,
      isLeapMonth: false,
      leapMonthPolicy: 'regular-month' as const,
      shortMonthPolicy: 'last-day' as const,
    }
    const lunarEvent: EventFields = {
      ...event,
      startDate: '2026-11-16',
      endDate: '2026-11-16',
      dateRule: lunarRule,
    }
    expect(parseEvent(lunarEvent)).toMatchObject({ dateRule: lunarRule })
    expect(occurrenceInYear(lunarEvent, 2027)).toBe('2027-06-23')
    expect(nextOccurrence(lunarEvent, '2026-11-16')).toBe('2027-06-23')
    expect(occursOn(lunarEvent, '2027-06-23')).toBe(true)
    expect(occursOn(lunarEvent, '2027-06-22')).toBe(false)
    expect(eventOccurrenceStart(lunarEvent, '2027-06-23')).toBe('2027-06-23')
    expect(parseEvent({ ...lunarEvent, recurrence: 'none' })).toBeNull()
    expect(parseEvent({ ...lunarEvent, allDay: false })).toBeNull()
    expect(parseEvent({ ...lunarEvent, endDate: '2026-11-17' })).toBeNull()
    expect(parseEvent({ ...lunarEvent, dateRule: { ...lunarRule, lunarDay: 31 } })).toBeNull()
    expect(parseEvent({ ...lunarEvent, startDate: '2101-01-01', endDate: '2101-01-01' })).toBeNull()
  })
})
