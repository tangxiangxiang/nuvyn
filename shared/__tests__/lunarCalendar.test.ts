import { describe, expect, it } from 'vitest'
import { Temporal } from '@js-temporal/polyfill'
import { lunarOccurrenceInYear, lunarToSolar, nextLunarOccurrence, solarToLunar, solarToLunarDetails, solarToLunarTimePillars, type ChineseEventDateRule } from '../lunarCalendar'

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
    const preSpring = solarToLunarDetails('2026-02-16')
    expect(preSpring).toEqual({
      year: 2025,
      month: 12,
      day: 29,
      isLeapMonth: false,
      yearGanZhi: '乙巳',
      monthGanZhi: '庚寅',
      dayGanZhi: '辛酉',
    })
    expect(preSpring).not.toHaveProperty('zodiac')
    expect(solarToLunarDetails('2026-02-17')).toEqual({
      year: 2026,
      month: 1,
      day: 1,
      isLeapMonth: false,
      yearGanZhi: '丙午',
      monthGanZhi: '庚寅',
      dayGanZhi: '壬戌',
    })
    expect(solarToLunarDetails('2026-02-03')?.monthGanZhi).toBe('己丑')
    expect(solarToLunarDetails('2026-02-04')?.monthGanZhi).toBe('庚寅')
  })

  it('preserves leap-month fields alongside GanZhi details', () => {
    expect(solarToLunarDetails('2023-03-22')).toEqual({
      year: 2023,
      month: 2,
      day: 1,
      isLeapMonth: true,
      yearGanZhi: '癸卯',
      monthGanZhi: '乙卯',
      dayGanZhi: '己卯',
    })
    expect(solarToLunarDetails('2026-02-30')).toBeNull()
  })

  it('calculates twelve time pillars from the selected day stem', () => {
    const pillars = solarToLunarTimePillars('2026-11-16')!
    expect(pillars).toHaveLength(12)
    expect(pillars.map(({ key, ganZhi, range, startHour }) => ({ key, ganZhi, range, startHour }))).toEqual([
      { key: 'zi', ganZhi: '甲子', range: '23:00–01:00', startHour: 23 },
      { key: 'chou', ganZhi: '乙丑', range: '01:00–03:00', startHour: 1 },
      { key: 'yin', ganZhi: '丙寅', range: '03:00–05:00', startHour: 3 },
      { key: 'mao', ganZhi: '丁卯', range: '05:00–07:00', startHour: 5 },
      { key: 'chen', ganZhi: '戊辰', range: '07:00–09:00', startHour: 7 },
      { key: 'si', ganZhi: '己巳', range: '09:00–11:00', startHour: 9 },
      { key: 'wu', ganZhi: '庚午', range: '11:00–13:00', startHour: 11 },
      { key: 'wei', ganZhi: '辛未', range: '13:00–15:00', startHour: 13 },
      { key: 'shen', ganZhi: '壬申', range: '15:00–17:00', startHour: 15 },
      { key: 'you', ganZhi: '癸酉', range: '17:00–19:00', startHour: 17 },
      { key: 'xu', ganZhi: '甲戌', range: '19:00–21:00', startHour: 19 },
      { key: 'hai', ganZhi: '乙亥', range: '21:00–23:00', startHour: 21 },
    ])
    expect(solarToLunarDetails('2026-11-16')?.dayGanZhi).toBe('甲午')
  })

  it('calculates all twelve pillars by Wu Shu Dun for all ten day stems', () => {
    const stems = Array.from('甲乙丙丁戊己庚辛壬癸')
    const branches = Array.from('子丑寅卯辰巳午未申酉戌亥')
    const start = Temporal.PlainDate.from('2026-11-16')
    const observedStems = new Set<string>()

    for (let offset = 0; offset < 10; offset += 1) {
      const date = start.add({ days: offset }).toString()
      const dayStem = solarToLunarDetails(date)!.dayGanZhi[0]!
      const pillars = solarToLunarTimePillars(date)!
      observedStems.add(dayStem)
      expect(pillars).toHaveLength(12)
      const dayStemIndex = stems.indexOf(dayStem)
      const ziStemIndex = (dayStemIndex % 5) * 2
      expect(pillars.map(pillar => pillar.ganZhi)).toEqual(branches.map((branch, index) =>
        `${stems[(ziStemIndex + index) % stems.length]}${branch}`))
    }

    expect(observedStems).toEqual(new Set(stems))
  })

  it('uses each selected day stem across month, year, and leap-month boundaries', () => {
    const stems = Array.from('甲乙丙丁戊己庚辛壬癸')
    for (const date of ['2026-12-31', '2027-01-01', '2027-01-31', '2027-02-01', '2023-03-22', '2023-03-23']) {
      const dayStem = solarToLunarDetails(date)!.dayGanZhi[0]!
      const pillars = solarToLunarTimePillars(date)!
      expect(pillars).toHaveLength(12)
      expect(pillars[0]!.ganZhi).toBe(`${stems[(stems.indexOf(dayStem) % 5) * 2]}子`)
    }
    expect(solarToLunarTimePillars('2026-02-30')).toBeNull()
    expect(solarToLunarTimePillars('1900-12-31')).toBeNull()
    expect(solarToLunarTimePillars('2101-01-01')).toBeNull()
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
