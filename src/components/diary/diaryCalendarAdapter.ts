import { parseDiaryDate, type DiaryDate } from '../../../shared/diaryProtocol'

/**
 * The smallest Diary projection the presentation adapter needs for MVP.
 * This type intentionally has no Calendar-library fields.
 */
export interface DiaryCalendarDay {
  date: DiaryDate
  hasDiary: boolean
  /** Current SQLite mood value; unknown strings remain opaque for display. */
  mood?: string | null
  /** Current SQLite CAS version for a managed Diary metadata mutation. */
  metadataUpdatedAt?: number
  /** Stable SQLite document identity, when supplied by the bulk summary. */
  documentId?: string
}

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

/**
 * Convert local civil fields to the validated DiaryDate identity.
 * No Date object or UTC serialization is involved in this conversion.
 */
export function diaryDateFromCalendarFields(
  value: Pick<CalendarDateFields, 'year' | 'month' | 'date'> | null | undefined,
): DiaryDate | null {
  if (!value || !isInteger(value.year) || !isInteger(value.month) || !isInteger(value.date)) {
    return null
  }

  return parseDiaryDate(`${String(value.year).padStart(4, '0')}-${pad(value.month)}-${pad(value.date)}`)
}

/** Convert a browser-local Date to a date-only DiaryDate without UTC slicing. */
export function diaryDateFromLocalDate(value: Date): DiaryDate | null {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null

  return parseDiaryDate(
    `${String(value.getFullYear()).padStart(4, '0')}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`,
  )
}

/** Return the browser-local civil date for Today presentation. */
export function localCivilToday(): DiaryDate | null {
  return diaryDateFromLocalDate(new Date())
}

/** Return the browser-local month used when no initial month is supplied. */
export function diaryCalendarMonthFromLocalDate(value = new Date()): DiaryCalendarMonth {
  return {
    year: value.getFullYear(),
    month: value.getMonth() + 1,
  }
}

/** Validate a library-independent month payload. */
export function diaryCalendarMonthFromFields(value: unknown): DiaryCalendarMonth | null {
  if (!value || typeof value !== 'object') return null
  const fields = value as { year?: unknown; month?: unknown }
  if (!isInteger(fields.year) || !isInteger(fields.month)) return null
  if (fields.year < 0 || fields.year > 9999 || fields.month < 1 || fields.month > 12) return null

  return { year: fields.year, month: fields.month }
}

/** Convert a validated DiaryDate into a local Date only for Calendar navigation. */
export function localCalendarDateForDiaryDate(date: DiaryDate): Date {
  const [year, month, day] = date.split('-').map(Number)
  const value = new Date(0)

  // Date(year, ...) applies the legacy 1900 offset to years 0 through 99.
  // setFullYear() does not, so the complete four-digit Diary year survives
  // the local navigation bridge. Noon remains intentional for DST safety.
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
  return diaryDateFromLocalDate(new Date(value))
}

/** Convert Naive UI Calendar's numeric local value to its visible month. */
export function diaryCalendarMonthFromNaiveCalendarValue(value: unknown): DiaryCalendarMonth | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return diaryCalendarMonthFromLocalDate(date)
}

/**
 * Normalize a projection defensively for presentation. Invalid entries are
 * ignored, and duplicate dates collapse to one record with an OR'd marker.
 * This protects the UI from duplicate marker artifacts without repairing
 * domain data.
 */
export function normalizeDiaryDays(
  days: readonly DiaryCalendarDay[] | null | undefined,
): DiaryCalendarDay[] {
  const byDate = new Map<string, DiaryCalendarDay>()

  for (const input of days ?? []) {
    if (!input || typeof input !== 'object') continue
    const candidate = input as Partial<DiaryCalendarDay>
    const date = parseDiaryDate(candidate.date)
    if (!date) continue

    const existing = byDate.get(date)
    if (existing) {
      existing.hasDiary = existing.hasDiary || candidate.hasDiary === true
      if (existing.mood === undefined && Object.prototype.hasOwnProperty.call(candidate, 'mood')) {
        existing.mood = typeof candidate.mood === 'string' || candidate.mood === null
          ? candidate.mood
          : undefined
      }
      if (existing.metadataUpdatedAt === undefined && Number.isSafeInteger(candidate.metadataUpdatedAt)) {
        existing.metadataUpdatedAt = candidate.metadataUpdatedAt
      }
      if (existing.documentId === undefined && typeof candidate.documentId === 'string') {
        existing.documentId = candidate.documentId
      }
      continue
    }

    const normalized: DiaryCalendarDay = {
      date,
      hasDiary: candidate.hasDiary === true,
    }
    if (typeof candidate.mood === 'string' || candidate.mood === null) normalized.mood = candidate.mood
    if (Number.isSafeInteger(candidate.metadataUpdatedAt)) normalized.metadataUpdatedAt = candidate.metadataUpdatedAt
    if (typeof candidate.documentId === 'string') normalized.documentId = candidate.documentId
    byDate.set(date, normalized)
  }

  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date))
}
