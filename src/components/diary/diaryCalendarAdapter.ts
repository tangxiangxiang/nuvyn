import { parseDiaryDate, type DiaryDate } from '../../../shared/diaryProtocol'

/** A visible month, kept separate from the DiaryDate domain identity. */
export interface DiaryCalendarMonth {
  year: number
  month: number
}

/** Date fields exposed by Naive UI's Calendar default slot. */
export interface CalendarDateFields {
  year: number
  month: number
  date: number
}

/** Month fields emitted by Naive UI's Calendar panel-change callback. */
export interface CalendarMonthFields {
  year: number
  month: number
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** Convert local calendar fields to a validated date without timezone conversion. */
export function diaryDateFromCalendarFields(
  value: Pick<CalendarDateFields, 'year' | 'month' | 'date'> | null | undefined,
): DiaryDate | null {
  if (!value || !isInteger(value.year) || !isInteger(value.month) || !isInteger(value.date)) {
    return null
  }

  return parseDiaryDate(`${String(value.year).padStart(4, '0')}-${pad(value.month)}-${pad(value.date)}`)
}

/** Validate a library-independent month payload. */
export function diaryCalendarMonthFromFields(value: unknown): DiaryCalendarMonth | null {
  if (!value || typeof value !== 'object') return null
  const fields = value as { year?: unknown; month?: unknown }
  if (!isInteger(fields.year) || !isInteger(fields.month)) return null
  if (fields.year < 0 || fields.year > 9999 || fields.month < 1 || fields.month > 12) return null

  return { year: fields.year, month: fields.month }
}

/** Convert a validated date to a local Date used only by the Calendar widget. */
export function localCalendarDateForDiaryDate(date: DiaryDate): Date {
  const [year, month, day] = date.split('-').map(Number)
  const value = new Date(0)

  // Date(year, ...) applies the 1900 offset to years 0 through 99. setFullYear
  // preserves the four-digit year. Noon remains intentional for DST safety.
  value.setFullYear(year, month - 1, day)
  value.setHours(12, 0, 0, 0)

  return value
}

/** Convert a DiaryDate to Naive UI Calendar's numeric local value. */
export function naiveCalendarValueForDiaryDate(date: DiaryDate): number {
  return localCalendarDateForDiaryDate(date).getTime()
}

/** Convert a Diary month to Naive UI Calendar's numeric local value. */
export function naiveCalendarValueForMonth(month: DiaryCalendarMonth): number | null {
  const date = parseDiaryDate(
    `${String(month.year).padStart(4, '0')}-${pad(month.month)}-01`,
  )
  return date ? naiveCalendarValueForDiaryDate(date) : null
}

/** Convert Naive UI Calendar's numeric local value to a DiaryDate. */
export function diaryDateFromNaiveCalendarValue(value: unknown): DiaryDate | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return diaryDateFromCalendarFields({
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    date: date.getDate(),
  })
}
