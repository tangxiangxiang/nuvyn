/**
 * Pure Diary date/path contract.
 *
 * DiaryDate is a local civil calendar date, not a timestamp. Callers should
 * obtain it through parseDiaryDate() or a validated equivalent before using
 * it as an identity. Logical paths are expected to have already gone through
 * the shared path normalizer, so this module deliberately does not accept a
 * trailing `.md` as a second spelling of a Diary identity.
 */

export const DIARY_ROOT = 'diary' as const

declare const diaryDateBrand: unique symbol

/** A strictly validated YYYY-MM-DD local calendar date. */
export type DiaryDate = string & { readonly [diaryDateBrand]: 'DiaryDate' }

export type DiaryPathKind = 'root' | 'managed' | 'unmanaged' | 'outside'

const DIARY_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

/** Parse a strict, real Gregorian calendar date without timezone conversion. */
export function parseDiaryDate(value: unknown): DiaryDate | null {
  if (typeof value !== 'string') return null
  const match = DIARY_DATE_RE.exec(value)
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12) return null
  if (day < 1 || day > daysInMonth(year, month)) return null

  return value as DiaryDate
}

/** Type guard for a value that has passed strict Diary date validation. */
export function isValidDiaryDate(value: unknown): value is DiaryDate {
  return parseDiaryDate(value) !== null
}

/** Convert a validated date identity to its extensionless logical path. */
export function diaryLogicalPathForDate(date: DiaryDate): string {
  if (!isValidDiaryDate(date)) throw new Error(`invalid DiaryDate: ${String(date)}`)
  return `${DIARY_ROOT}/${date}`
}

/** Parse a normalized extensionless logical path back to its Diary date. */
export function diaryDateFromPath(path: unknown): DiaryDate | null {
  if (typeof path !== 'string' || !path.startsWith(`${DIARY_ROOT}/`)) return null
  const dateText = path.slice(DIARY_ROOT.length + 1)
  if (dateText.includes('/')) return null
  return parseDiaryDate(dateText)
}

/** True only for the fixed Diary system root itself. */
export function isDiaryRoot(path: unknown): boolean {
  return path === DIARY_ROOT
}

/** True only for the canonical, strictly valid managed Diary document path. */
export function isManagedDiaryPath(path: unknown): boolean {
  return diaryDateFromPath(path) !== null
}

/** Classify Diary root, managed content, invalid/unmanaged content, or outside paths. */
export function classifyDiaryPath(path: unknown): DiaryPathKind {
  if (isDiaryRoot(path)) return 'root'
  if (typeof path !== 'string' || !path.startsWith(`${DIARY_ROOT}/`)) return 'outside'
  return isManagedDiaryPath(path) ? 'managed' : 'unmanaged'
}
