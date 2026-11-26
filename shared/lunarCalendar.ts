import { Lunar, LunarMonth, LunarYear, Solar } from 'lunar-typescript'
import { Temporal } from '@js-temporal/polyfill'

/** Hong Kong Observatory's published Gregorian/Lunar correspondence table. */
export const MIN_LUNAR_SOLAR_DATE = '1901-01-01'
export const MAX_LUNAR_SOLAR_DATE = '2100-12-31'
const MIN_LUNAR_YEAR = 1900
const MAX_LUNAR_YEAR = 2100

export interface LunarDate {
  year: number
  month: number
  day: number
  isLeapMonth: boolean
}

export interface LunarCalendarDetails extends LunarDate {
  yearGanZhi: string
  zodiac: string
  monthGanZhi: string
  dayGanZhi: string
}

export interface ChineseEventDateRule {
  calendar: 'chinese'
  lunarMonth: number
  lunarDay: number
  isLeapMonth: boolean
  leapMonthPolicy: 'regular-month' | 'leap-only'
  shortMonthPolicy: 'last-day' | 'skip'
}

export type EventDateRule = { calendar: 'gregory' } | ChineseEventDateRule

function isSupportedSolarDate(date: string): boolean {
  if (date < MIN_LUNAR_SOLAR_DATE || date > MAX_LUNAR_SOLAR_DATE) return false
  try {
    return Temporal.PlainDate.from(date, { overflow: 'reject' }).toString() === date
  } catch {
    return false
  }
}

function convertSolarDate(date: string): { lunar: Lunar; lunarDate: LunarDate } | null {
  if (!isSupportedSolarDate(date)) return null
  const [year, month, day] = date.split('-').map(Number)
  try {
    const lunar = Solar.fromYmd(year!, month!, day!).getLunar()
    const lunarMonth = lunar.getMonth()
    const result = {
      year: lunar.getYear(),
      month: Math.abs(lunarMonth),
      day: lunar.getDay(),
      isLeapMonth: lunarMonth < 0,
    }
    if (result.year < MIN_LUNAR_YEAR || result.year > MAX_LUNAR_YEAR || result.month < 1 || result.month > 12
      || result.day < 1 || result.day > 30) return null
    return { lunar, lunarDate: result }
  } catch {
    return null
  }
}

export function solarToLunar(date: string): LunarDate | null {
  return convertSolarDate(date)?.lunarDate ?? null
}

export function solarToLunarDetails(date: string): LunarCalendarDetails | null {
  const converted = convertSolarDate(date)
  if (!converted) return null
  const { lunar, lunarDate } = converted
  try {
    return {
      ...lunarDate,
      yearGanZhi: lunar.getYearInGanZhi(),
      zodiac: lunar.getYearShengXiao(),
      monthGanZhi: lunar.getMonthInGanZhi(),
      dayGanZhi: lunar.getDayInGanZhi(),
    }
  } catch {
    return null
  }
}

/** Converts only valid lunar dates; it never lets the library constrain invalid input. */
export function lunarToSolar(date: LunarDate): string | null {
  if (!Number.isInteger(date.year) || date.year < MIN_LUNAR_YEAR || date.year > MAX_LUNAR_YEAR
    || !Number.isInteger(date.month) || date.month < 1 || date.month > 12
    || !Number.isInteger(date.day) || date.day < 1 || date.day > 30
    || typeof date.isLeapMonth !== 'boolean') return null
  try {
    const year = LunarYear.fromYear(date.year)
    const leapMonth = year.getLeapMonth()
    if (date.isLeapMonth && leapMonth !== date.month) return null
    const monthNumber = date.isLeapMonth ? -date.month : date.month
    const month = LunarMonth.fromYm(date.year, monthNumber)
    if (!month || date.day > month.getDayCount()) return null
    const solar = Lunar.fromYmd(date.year, monthNumber, date.day).getSolar().toYmd()
    const roundTrip = solarToLunar(solar)
    if (!roundTrip || roundTrip.year !== date.year || roundTrip.month !== date.month
      || roundTrip.day !== date.day || roundTrip.isLeapMonth !== date.isLeapMonth) return null
    return solar
  } catch {
    return null
  }
}

export function lunarOccurrenceInYear(rule: ChineseEventDateRule, year: number): string | null {
  if (!Number.isInteger(year) || year < MIN_LUNAR_YEAR || year > MAX_LUNAR_YEAR) return null
  const yearInfo = LunarYear.fromYear(year)
  let monthNumber = rule.lunarMonth

  if (rule.isLeapMonth) {
    if (yearInfo.getLeapMonth() === rule.lunarMonth) {
      monthNumber = -rule.lunarMonth
    } else if (rule.leapMonthPolicy === 'leap-only') {
      return null
    }
  }

  const month = LunarMonth.fromYm(year, monthNumber)
  if (!month) return null
  let day = rule.lunarDay
  if (day > month.getDayCount()) {
    if (rule.shortMonthPolicy === 'skip') return null
    day = month.getDayCount()
  }
  return lunarToSolar({ year, month: Math.abs(monthNumber), day, isLeapMonth: monthNumber < 0 })
}

export function nextLunarOccurrence(rule: ChineseEventDateRule, fromDate: string): string | null {
  const lunarStart = solarToLunar(fromDate)
  if (!lunarStart) return null
  for (let year = lunarStart.year; year <= MAX_LUNAR_YEAR; year++) {
    const occurrence = lunarOccurrenceInYear(rule, year)
    if (occurrence && occurrence >= fromDate) return occurrence
  }
  return null
}

const LUNAR_MONTH_NAMES = ['正月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '冬月', '腊月']
const LUNAR_DAY_NAMES = [
  '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十',
]

export function lunarMonthLabel(month: number): string {
  return LUNAR_MONTH_NAMES[month - 1] ?? `${month}月`
}

export function lunarDayLabel(day: number): string {
  return LUNAR_DAY_NAMES[day - 1] ?? `${day}日`
}

export function formatLunarRule(rule: ChineseEventDateRule, prefix = true): string {
  const month = `${rule.isLeapMonth ? '闰' : ''}${lunarMonthLabel(rule.lunarMonth)}`
  return `${prefix ? '农历' : ''}${month}${lunarDayLabel(rule.lunarDay)}`
}
