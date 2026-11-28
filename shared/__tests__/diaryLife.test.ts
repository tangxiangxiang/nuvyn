import { describe, expect, it } from 'vitest'
import { lunarToSolar } from '../lunarCalendar'
import { birthdayAgeAt, civilDate, dayDistance, displayEventTitle, eventOccurrenceStart, lifePeriodSummary, nextOccurrence, occurrenceInYear, occursOn, parseDay, parseEvent, type EventFields } from '../diaryLife'

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
  it('validates open-ended life periods without relaxing other Event ranges', () => {
    const period: EventFields = {
      ...event,
      title: '第一份工作',
      emoji: '💼',
      type: 'period',
      startDate: '2010-01-31',
      endDate: null,
      recurrence: 'none',
      showCountdown: false,
    }
    expect(parseEvent(period)).toMatchObject({ type: 'period', endDate: null, startDate: '2010-01-31' })
    expect(parseEvent({ ...period, endDate: '2025-01-31' })).not.toBeNull()
    expect(parseEvent({ ...period, endDate: '2009-12-31' })).toBeNull()
    expect(parseEvent({ ...period, recurrence: 'yearly' })).toBeNull()
    expect(parseEvent({ ...period, showCountdown: true })).toBeNull()
    expect(parseEvent({ ...period, allDay: false })).toBeNull()
    expect(parseEvent({ ...period, endTime: '09:00' })).toBeNull()
    expect(parseEvent({ ...period, dateRule: {
      calendar: 'chinese', lunarMonth: 1, lunarDay: 1, isLeapMonth: false,
      leapMonthPolicy: 'regular-month', shortMonthPolicy: 'last-day',
    } })).toBeNull()
    expect(parseEvent({ ...period, attachmentIds: ['08a5c822-0d61-4e6c-a62c-1931a4da0771'] })?.attachmentIds)
      .toEqual(['08a5c822-0d61-4e6c-a62c-1931a4da0771'])
    expect(parseEvent({ ...event, type: 'schedule', startDate: '2020-01-01', endDate: '2021-01-02' })).toBeNull()
  })
  it('marks only life-period endpoints and calculates natural-date status and duration', () => {
    const period: EventFields = {
      ...event,
      title: '居住经历',
      type: 'period',
      startDate: '2023-07-01',
      endDate: '2027-07-01',
      recurrence: 'none',
      showCountdown: false,
    }
    expect(occursOn(period, '2023-07-01')).toBe(true)
    expect(occursOn(period, '2025-01-01')).toBe(false)
    expect(occursOn(period, '2027-07-01')).toBe(true)
    expect(occursOn({ ...period, endDate: null }, '2027-07-01')).toBe(false)
    expect(eventOccurrenceStart(period, '2027-07-01')).toBe('2023-07-01')
    expect(eventOccurrenceStart(period, '2025-01-01')).toBeNull()
    expect(nextOccurrence(period, '2024-01-01')).toBeNull()

    expect(lifePeriodSummary({ ...period, endDate: null }, '2023-07-01'))
      .toEqual({ status: 'active', duration: '0 天' })
    expect(lifePeriodSummary({ ...period, endDate: null }, '2026-11-27'))
      .toEqual({ status: 'active', duration: '3 年 4 个月 26 天' })
    expect(lifePeriodSummary(period, '2027-06-30'))
      .toEqual({ status: 'active', duration: '3 年 11 个月 29 天' })
    expect(lifePeriodSummary(period, '2027-07-01'))
      .toEqual({ status: 'ended', duration: '4 年' })
    expect(lifePeriodSummary(period, '2028-01-01'))
      .toEqual({ status: 'ended', duration: '4 年' })
    expect(lifePeriodSummary({ ...period, startDate: '2027-04-03', endDate: null }, '2027-03-01'))
      .toEqual({ status: 'upcoming', duration: '1 个月 2 天' })
    expect(lifePeriodSummary({ ...period, startDate: '2024-01-31', endDate: '2024-02-28' }, '2024-02-28'))
      .toEqual({ status: 'ended', duration: '28 天' })
    expect(lifePeriodSummary({ ...period, startDate: '2024-02-29', endDate: '2025-02-28' }, '2025-02-28'))
      .toEqual({ status: 'ended', duration: '11 个月 30 天' })
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

  it('keeps legacy lunar birthdays lunar when the encrypted record omitted dateRule', () => {
    const lunarBirthday: EventFields = {
      title: '爷爷', description: '', emoji: '🎂', type: 'birthday',
      startDate: lunarToSolar({ year: 1951, month: 10, day: 7, isLeapMonth: false })!,
      endDate: lunarToSolar({ year: 1951, month: 10, day: 7, isLeapMonth: false })!, startTime: null, endTime: null,
      allDay: true, dateRule: {
        calendar: 'chinese', lunarMonth: 10, lunarDay: 7, isLeapMonth: false,
        leapMonthPolicy: 'regular-month', shortMonthPolicy: 'last-day',
      }, recurrence: 'yearly', birthday: { birthLunarYear: 1951 }, showCountdown: true, isPrimary: false,
    }
    const parsed = parseEvent({ ...lunarBirthday, dateRule: undefined })
    expect(parsed?.dateRule).toMatchObject({ calendar: 'chinese', lunarMonth: 10, lunarDay: 7 })
    expect(parsed?.birthday).toEqual({ birthLunarYear: 1951 })
  })

  it('validates Gregorian birthdays and uses the Gregorian anniversary year for age', () => {
    const gregorianBirthday: EventFields = {
      title: '小明生日', description: '', emoji: '🎂', type: 'birthday',
      startDate: '2000-02-29', endDate: '2000-02-29', startTime: null, endTime: null,
      allDay: true, dateRule: { calendar: 'gregory' }, recurrence: 'yearly',
      birthday: { birthGregorianYear: 2000 }, showCountdown: true, isPrimary: false,
    }
    const parsed = parseEvent(gregorianBirthday)
    expect(parsed?.birthday).toEqual({ birthGregorianYear: 2000 })
    expect(occurrenceInYear(gregorianBirthday, 2025)).toBe('2025-02-28')
    expect(nextOccurrence(gregorianBirthday, '2026-01-01')).toBe('2026-02-28')
    expect(birthdayAgeAt(gregorianBirthday, '2026-02-28')).toBe(26)
    expect(displayEventTitle(gregorianBirthday, '2026-02-28')).toBe('小明26岁生日')
    expect(occursOn(gregorianBirthday, '2026-02-28')).toBe(true)
    expect(occursOn(gregorianBirthday, '2026-03-01')).toBe(false)
    expect(parseEvent({ ...gregorianBirthday, birthday: { birthGregorianYear: 2001 } })).toBeNull()
  })
})
