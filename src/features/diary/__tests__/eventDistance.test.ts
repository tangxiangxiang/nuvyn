import { describe, expect, it } from 'vitest'
import { lunarToSolar, type ChineseEventDateRule } from '../../../../shared/lunarCalendar'
import { displayEventTitle, type DiaryEvent } from '../../../../shared/diaryLife'
import { eventDistanceLabel } from '../eventDistance'

function makeEvent(overrides: Partial<DiaryEvent> = {}): DiaryEvent {
  return {
    id: 'event-1',
    title: '人生时刻',
    description: '',
    emoji: '🎯',
    type: 'milestone',
    startDate: '2026-11-19',
    endDate: '2026-11-19',
    startTime: null,
    endTime: null,
    allDay: true,
    recurrence: 'none',
    showCountdown: false,
    isPrimary: false,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('eventDistanceLabel', () => {
  it('labels upcoming, active and ended life periods on their endpoint rows', () => {
    const period = makeEvent({ type: 'period', startDate: '2023-07-01', endDate: '2027-07-01' })
    expect(eventDistanceLabel(period, period.startDate, '2023-06-16')).toBe('还剩 15 天')
    expect(eventDistanceLabel({ ...period, endDate: null }, period.startDate, '2026-11-28')).toBe('已持续 3 年 4 个月 27 天')
    expect(eventDistanceLabel(period, period.endDate!, '2027-07-01')).toBe('持续 4 年')
    expect(eventDistanceLabel(period, '2027-06-30', '2027-07-02')).toBe('')
  })

  it('labels yesterday, today, tomorrow, month and year boundaries', () => {
    expect(eventDistanceLabel(makeEvent({ startDate: '2026-11-18', endDate: '2026-11-18' }), '2026-11-18', '2026-11-19')).toBe('已过去1天')
    expect(eventDistanceLabel(makeEvent(), '2026-11-19', '2026-11-19')).toBe('今天')
    expect(eventDistanceLabel(makeEvent({ startDate: '2026-11-20', endDate: '2026-11-20' }), '2026-11-20', '2026-11-19')).toBe('还剩1天')
    expect(eventDistanceLabel(makeEvent({ startDate: '2027-11-04', endDate: '2027-11-04' }), '2027-11-04', '2026-11-19')).toBe('还剩350天')
  })

  it('uses Temporal day distances across leap days', () => {
    expect(eventDistanceLabel(makeEvent({ startDate: '2024-03-01', endDate: '2024-03-01' }), '2024-03-01', '2024-02-29')).toBe('还剩1天')
    expect(eventDistanceLabel(makeEvent({ startDate: '2024-02-29', endDate: '2024-02-29' }), '2024-02-29', '2024-03-01')).toBe('已过去1天')
  })

  it('uses the selected annual occurrence even when showCountdown is false', () => {
    const event = makeEvent({
      title: '爷爷',
      emoji: '🎂',
      type: 'birthday',
      startDate: '1951-11-15',
      endDate: '1951-11-15',
      recurrence: 'yearly',
      dateRule: { calendar: 'gregory' },
      birthday: { birthGregorianYear: 1951 },
      showCountdown: false,
    })

    expect(eventDistanceLabel(event, '2026-11-15', '2026-11-19')).toBe('已过去4天')
    expect(eventDistanceLabel(event, '2027-11-15', '2026-11-19')).toBe('还剩361天')
  })

  it('uses the displayed lunar birthday occurrence and its year', () => {
    const dateRule: ChineseEventDateRule = {
      calendar: 'chinese',
      lunarMonth: 10,
      lunarDay: 7,
      isLeapMonth: false,
      leapMonthPolicy: 'regular-month',
      shortMonthPolicy: 'last-day',
    }
    const startDate = lunarToSolar({ year: 1951, month: 10, day: 7, isLeapMonth: false })!
    const event = makeEvent({
      title: '爷爷',
      emoji: '🎂',
      type: 'birthday',
      startDate,
      endDate: startDate,
      recurrence: 'yearly',
      dateRule,
      birthday: { birthLunarYear: 1951 },
      showCountdown: false,
    })
    const occurrence2026 = lunarToSolar({ year: 2026, month: 10, day: 7, isLeapMonth: false })!
    const occurrence2027 = lunarToSolar({ year: 2027, month: 10, day: 7, isLeapMonth: false })!

    expect(occurrence2026).toBe('2026-11-15')
    expect(occurrence2027).toBe('2027-11-04')
    expect(displayEventTitle(event, occurrence2026)).toBe('爷爷75岁生日')
    expect(displayEventTitle(event, occurrence2027)).toBe('爷爷76岁生日')
    expect(eventDistanceLabel(event, occurrence2026, '2026-11-19')).toBe('已过去4天')
    expect(eventDistanceLabel(event, occurrence2027, '2026-11-19')).toBe('还剩350天')
  })

  it('retains progress labels for a readable legacy schedule range', () => {
    const event = makeEvent({
      type: 'milestone', legacySchedule: true,
      startDate: '2026-11-17', endDate: '2026-11-21',
    })

    expect(eventDistanceLabel(event, '2026-11-19', '2026-11-16')).toBe('还剩1天')
    expect(eventDistanceLabel(event, '2026-11-19', '2026-11-19')).toBe('进行中')
    expect(eventDistanceLabel(event, '2026-11-19', '2026-11-24')).toBe('已过去3天')
  })

  it('updates with today and returns no label for a date outside the Event occurrence', () => {
    const event = makeEvent({ startDate: '2026-11-20', endDate: '2026-11-20' })

    expect(eventDistanceLabel(event, '2026-11-20', '2026-11-19')).toBe('还剩1天')
    expect(eventDistanceLabel(event, '2026-11-20', '2026-11-20')).toBe('今天')
    expect(eventDistanceLabel(event, '2026-11-19', '2026-11-19')).toBe('')
  })
})
