import { describe, expect, it } from 'vitest'
import { lunarOccurrenceInYear, lunarToSolar, nextLunarOccurrence, solarToLunar, solarToLunarDetails, type ChineseEventDateRule } from '../lunarCalendar'

const mayNineteenth: ChineseEventDateRule = {
  calendar: 'chinese',
  lunarMonth: 5,
  lunarDay: 19,
  isLeapMonth: false,
  leapMonthPolicy: 'regular-month',
  shortMonthPolicy: 'last-day',
}

describe('shared Chinese lunar calendar conversion', () => {
  it('matches Hong Kong Observatory 2026 and 2027 correspondence-table dates', () => {
    expect(solarToLunar('2026-07-03')).toEqual({ year: 2026, month: 5, day: 19, isLeapMonth: false })
    expect(lunarToSolar({ year: 2026, month: 5, day: 19, isLeapMonth: false })).toBe('2026-07-03')
    expect(solarToLunar('2027-02-05')).toEqual({ year: 2026, month: 12, day: 29, isLeapMonth: false })
    expect(solarToLunar('2027-02-06')).toEqual({ year: 2027, month: 1, day: 1, isLeapMonth: false })
    expect(lunarToSolar({ year: 2026, month: 12, day: 10, isLeapMonth: false })).toBe('2027-01-17')
  })

  it('computes calendar GanZhi with lunar-year and solar-term boundaries', () => {
    expect(solarToLunarDetails('2026-02-16')).toMatchObject({
      year: 2025,
      month: 12,
      day: 29,
      isLeapMonth: false,
      yearGanZhi: '乙巳',
      zodiac: '蛇',
      monthGanZhi: '庚寅',
      dayGanZhi: '辛酉',
    })
    expect(solarToLunarDetails('2026-02-17')).toMatchObject({
      year: 2026,
      month: 1,
      day: 1,
      isLeapMonth: false,
      yearGanZhi: '丙午',
      zodiac: '马',
      monthGanZhi: '庚寅',
      dayGanZhi: '壬戌',
    })
    expect(solarToLunarDetails('2026-02-03')?.monthGanZhi).toBe('己丑')
    expect(solarToLunarDetails('2026-02-04')?.monthGanZhi).toBe('庚寅')
  })

  it('preserves leap-month fields alongside GanZhi details', () => {
    expect(solarToLunarDetails('2023-03-22')).toMatchObject({
      year: 2023,
      month: 2,
      day: 1,
      isLeapMonth: true,
      yearGanZhi: '癸卯',
      zodiac: '兔',
      monthGanZhi: '乙卯',
      dayGanZhi: '己卯',
    })
    expect(solarToLunarDetails('2026-02-30')).toBeNull()
  })

  it('distinguishes regular and leap months and skips multiple absent leap years', () => {
    expect(solarToLunar('2023-03-22')).toEqual({ year: 2023, month: 2, day: 1, isLeapMonth: true })
    expect(lunarToSolar({ year: 2023, month: 2, day: 1, isLeapMonth: true })).toBe('2023-03-22')
    expect(lunarToSolar({ year: 2023, month: 2, day: 1, isLeapMonth: false })).toBe('2023-02-20')

    const leapMay = { ...mayNineteenth, isLeapMonth: true }
    expect(lunarOccurrenceInYear(leapMay, 2026)).toBe('2026-07-03')
    expect(lunarOccurrenceInYear({ ...leapMay, leapMonthPolicy: 'leap-only' }, 2026)).toBeNull()
    expect(nextLunarOccurrence({ ...leapMay, leapMonthPolicy: 'leap-only' }, '2026-07-12')).toBe('2028-07-11')
    expect(lunarOccurrenceInYear(leapMay, 2028)).toBe('2028-07-11')
  })

  it('applies the small-month policy without rolling into the next month', () => {
    const leapSecondMonth = { ...mayNineteenth, lunarMonth: 2, lunarDay: 30, isLeapMonth: true }
    expect(lunarOccurrenceInYear(leapSecondMonth, 2023)).toBe('2023-04-19')
    expect(lunarOccurrenceInYear({ ...leapSecondMonth, shortMonthPolicy: 'skip' }, 2023)).toBeNull()
    expect(lunarToSolar({ year: 2023, month: 2, day: 30, isLeapMonth: true })).toBeNull()
  })

  it('finds today, the next lunar year, and dates that cross the Gregorian year boundary', () => {
    expect(nextLunarOccurrence(mayNineteenth, '2026-07-03')).toBe('2026-07-03')
    expect(nextLunarOccurrence(mayNineteenth, '2026-07-04')).toBe('2027-06-23')
    expect(nextLunarOccurrence({ ...mayNineteenth, lunarMonth: 12, lunarDay: 10 }, '2026-12-01')).toBe('2027-01-17')
  })

  it('rejects invalid dates and dates outside the authoritative support range', () => {
    expect(solarToLunar('2026-02-30')).toBeNull()
    expect(solarToLunar('1900-12-31')).toBeNull()
    expect(solarToLunar('2101-01-01')).toBeNull()
    expect(lunarToSolar({ year: 2026, month: 13, day: 1, isLeapMonth: false })).toBeNull()
    expect(lunarToSolar({ year: 2026, month: 5, day: 31, isLeapMonth: false })).toBeNull()
    expect(lunarToSolar({ year: 2026, month: 5, day: 1, isLeapMonth: true })).toBeNull()
    expect(nextLunarOccurrence(mayNineteenth, '2101-01-01')).toBeNull()
  })
})
