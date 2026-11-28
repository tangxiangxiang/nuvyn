import { Temporal } from '@js-temporal/polyfill'
import { isMoodId, isDiaryCustomMoodId } from './diaryMood.js'
import { MAX_DIARY_DAY_ATTACHMENTS, MAX_DIARY_EVENT_ATTACHMENTS } from './diaryAttachments.js'
import { lunarOccurrenceInYear, lunarToSolar, MAX_LUNAR_SOLAR_DATE, MIN_LUNAR_SOLAR_DATE, nextLunarOccurrence, solarToLunar, type EventDateRule } from './lunarCalendar.js'

export interface DiaryImageGroup { entryId: string | null; attachmentIds: string[] }
export interface DayFields {
  moodId: string | null
  entries: string[]
  /** Older days may omit stable entry identities; editing assigns them. */
  entryIds?: string[]
  /** Older or ungrouped images are rendered at the end of the day. */
  imageGroups?: DiaryImageGroup[]
}
export interface DiaryDaySummary { date: string; moodId: string | null; hasEntries: boolean; hasAttachments: boolean; version: number }
export interface DiarySearchItem {
  date: string
  entryId?: string
  entryIndex?: number
  snippet: string
  match: 'entry' | 'date'
}
export interface DiarySearchPage { items: DiarySearchItem[]; nextCursor: string | null }
export interface DiaryEventSearchItem {
  id: string
  title: string
  emoji: string
  type: EventFields['type']
  targetDate: string | null
  subtitle: string
  snippet: string
  match: 'title' | 'description'
}
export interface DiaryEventSearchPage { items: DiaryEventSearchItem[]; nextCursor: string | null }
export interface EventFields {
  title: string
  description: string
  emoji: string
  type: 'milestone' | 'anniversary' | 'schedule' | 'birthday' | 'period'
  /** The source calendar and year used for age-aware annual birthday events. */
  birthday?: { birthLunarYear: number } | { birthGregorianYear: number }
  startDate: string
  endDate: string | null
  startTime: string | null
  endTime: string | null
  allDay: boolean
  /** Missing on historical encrypted records means the original Gregorian calendar. */
  dateRule?: EventDateRule
  recurrence: 'none' | 'yearly'
  attachmentIds?: string[]
  showCountdown: boolean
  isPrimary: boolean
}
export interface DiaryDay extends DayFields { date: string; version: number; createdAt: number; updatedAt: number }
export interface DiaryEvent extends EventFields {
  id: string
  version: number
  createdAt: number
  updatedAt: number
  attachments?: import('./diaryAttachments.js').DiaryAttachment[]
}
export function civilDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '0001-01-01') return false
  try { return Temporal.PlainDate.from(value, { overflow: 'reject' }).toString() === value } catch { return false }
}
export function localToday(): string { return Temporal.Now.plainDateISO().toString() }
export function dayDistance(from: string, to: string): number {
  return Temporal.PlainDate.from(from).until(Temporal.PlainDate.from(to)).days
}
export function addDays(date: string, days: number): string { return Temporal.PlainDate.from(date).add({ days }).toString() }
export type LifePeriodSummary = {
  status: 'upcoming' | 'active' | 'ended'
  duration: string
}
function formatPeriodDuration(from: string, to: string): string {
  const difference = Temporal.PlainDate.from(from).until(Temporal.PlainDate.from(to), { largestUnit: 'year' })
  const units = [
    difference.years ? `${difference.years} 年` : '',
    difference.months ? `${difference.months} 个月` : '',
    difference.days ? `${difference.days} 天` : '',
  ].filter(Boolean)
  return units.join(' ') || '0 天'
}
export function lifePeriodSummary(event: Pick<EventFields, 'type' | 'startDate' | 'endDate'>, today: string): LifePeriodSummary | null {
  if (event.type !== 'period') return null
  if (today < event.startDate) return { status: 'upcoming', duration: formatPeriodDuration(today, event.startDate) }
  if (event.endDate !== null && today >= event.endDate) return { status: 'ended', duration: formatPeriodDuration(event.startDate, event.endDate) }
  return { status: 'active', duration: formatPeriodDuration(event.startDate, today) }
}
export const MAX_DAY_ENTRIES = 100
export const MAX_DAY_ENTRY_CHARACTERS = 4000
export const MAX_DAY_TOTAL_CHARACTERS = 4000
export const MAX_DIARY_IMAGE_GROUP_SIZE = 9
const DIARY_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
export function parseDay(value: unknown): DayFields | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (v.moodId !== null && !isMoodId(v.moodId) && !isDiaryCustomMoodId(v.moodId)) return null
  let entries: unknown[]
  if (Array.isArray(v.entries)) {
    entries = v.entries
  } else if (typeof v.description === 'string' && v.description.length <= MAX_DAY_TOTAL_CHARACTERS) {
    // Existing encrypted records used one description string. Preserve it as
    // one entry (including its original spacing and line breaks) on read.
    entries = v.description.length > 0 ? [v.description] : []
  } else {
    return null
  }
  if (entries.length > MAX_DAY_ENTRIES || entries.some(entry => typeof entry !== 'string' || entry.length > MAX_DAY_ENTRY_CHARACTERS)) return null
  const textEntries = entries as string[]
  if (textEntries.reduce((total, entry) => total + entry.length, 0) > MAX_DAY_TOTAL_CHARACTERS) return null

  let suppliedEntryIds: string[] | undefined
  if (v.entryIds !== undefined) {
    if (!Array.isArray(v.entryIds) || v.entryIds.length !== textEntries.length
      || v.entryIds.some(id => typeof id !== 'string' || !DIARY_UUID.test(id))
      || new Set(v.entryIds).size !== v.entryIds.length) return null
    suppliedEntryIds = v.entryIds as string[]
  }

  let imageGroups: DiaryImageGroup[] | undefined
  if (v.imageGroups !== undefined) {
    if (!Array.isArray(v.imageGroups) || v.imageGroups.length > 20) return null
    const knownEntries = new Set(suppliedEntryIds ?? [])
    const usedAttachments = new Set<string>()
    const groups: DiaryImageGroup[] = []
    for (const rawGroup of v.imageGroups) {
      if (!rawGroup || typeof rawGroup !== 'object' || Array.isArray(rawGroup)) return null
      const group = rawGroup as Record<string, unknown>
      if (group.entryId !== null && (!suppliedEntryIds || typeof group.entryId !== 'string' || !knownEntries.has(group.entryId))) return null
      if (!Array.isArray(group.attachmentIds) || group.attachmentIds.length < 1
        || group.attachmentIds.length > MAX_DIARY_IMAGE_GROUP_SIZE
        || group.attachmentIds.some(id => typeof id !== 'string' || !DIARY_UUID.test(id))
        || new Set(group.attachmentIds).size !== group.attachmentIds.length) return null
      const attachmentIds = group.attachmentIds as string[]
      if (attachmentIds.some(id => usedAttachments.has(id))) return null
      attachmentIds.forEach(id => usedAttachments.add(id))
      if (usedAttachments.size > MAX_DIARY_DAY_ATTACHMENTS) return null
      groups.push({ entryId: group.entryId as string | null, attachmentIds: [...attachmentIds] })
    }
    imageGroups = groups
  }

  const retainedIndexes = textEntries.flatMap((entry, index) => entry.trim().length > 0 ? [index] : [])
  const retainedEntries = retainedIndexes.map(index => textEntries[index]!)
  const retainedEntryIds = suppliedEntryIds?.filter((_, index) => retainedIndexes.includes(index))
  const retainedIdSet = new Set(retainedEntryIds ?? [])
  const normalizedGroups = imageGroups?.map(group => ({
    ...group,
    // If a text row is cleared, keep its photos and move them to the end.
    entryId: group.entryId !== null && !retainedIdSet.has(group.entryId) ? null : group.entryId,
  }))
  return {
    moodId: v.moodId as string | null,
    entries: retainedEntries,
    ...(retainedEntryIds ? { entryIds: retainedEntryIds } : {}),
    ...(normalizedGroups ? { imageGroups: normalizedGroups } : {}),
  }
}
export function parseEvent(value: unknown): EventFields | null {
  if (!value || typeof value !== 'object') return null
  const v = value as EventFields & { dateRule?: unknown; birthday?: unknown }
  let dateRule = parseEventDateRule(v.dateRule)
  // Older encrypted birthday records may not contain dateRule. Their birthLunarYear
  // is the authoritative signal that these dates were lunar, so preserve that meaning.
  if (v.type === 'birthday' && v.dateRule === undefined && v.birthday && typeof v.birthday === 'object'
    && !Array.isArray(v.birthday) && Number.isInteger((v.birthday as Record<string, unknown>).birthLunarYear)) {
    const lunarBirthDate = solarToLunar(v.startDate)
    if (lunarBirthDate && lunarBirthDate.year === (v.birthday as Record<string, unknown>).birthLunarYear) {
      dateRule = {
        calendar: 'chinese',
        lunarMonth: lunarBirthDate.month,
        lunarDay: lunarBirthDate.day,
        isLeapMonth: lunarBirthDate.isLeapMonth,
        leapMonthPolicy: 'regular-month',
        shortMonthPolicy: 'last-day',
      }
    }
  }
  if (!dateRule) return null
  if (typeof v.title !== 'string' || !v.title.trim() || v.title.length > 160
    || typeof v.description !== 'string' || v.description.length > 4000
    || typeof v.emoji !== 'string' || !v.emoji || v.emoji.length > 100
    || !/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(v.emoji)
    || [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(v.emoji)].length !== 1
    || !['milestone', 'anniversary', 'schedule', 'birthday', 'period'].includes(v.type)
    || !civilDate(v.startDate)
    || typeof v.allDay !== 'boolean' || typeof v.showCountdown !== 'boolean' || typeof v.isPrimary !== 'boolean'
    || !['none', 'yearly'].includes(v.recurrence)) return null
  const time = (t: unknown) => t === null || (typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t))
  if (!time(v.startTime) || !time(v.endTime)) return null
  if (v.type === 'period') {
    if (!(v.endDate === null || (civilDate(v.endDate) && v.endDate >= v.startDate))
      || v.recurrence !== 'none' || dateRule.calendar !== 'gregory' || !v.allDay
      || v.startTime !== null || v.endTime !== null || v.showCountdown) return null
  } else if (!civilDate(v.endDate) || v.endDate < v.startDate || dayDistance(v.startDate, v.endDate) > 366) {
    return null
  }
  const attachmentIds = (v as EventFields & { attachmentIds?: unknown }).attachmentIds
  if (attachmentIds !== undefined && (!Array.isArray(attachmentIds) || attachmentIds.length > MAX_DIARY_EVENT_ATTACHMENTS
    || attachmentIds.some(id => typeof id !== 'string' || !DIARY_UUID.test(id))
    || new Set(attachmentIds).size !== attachmentIds.length)) return null
  if (!v.allDay && v.endTime !== null && v.startTime === null) return null
  if (!v.allDay && v.startDate === v.endDate && v.startTime && v.endTime && v.endTime <= v.startTime) return null
  if (dateRule.calendar === 'chinese' && (v.recurrence !== 'yearly' || !v.allDay
    || v.startDate !== v.endDate || v.startTime !== null || v.endTime !== null
    || v.startDate < MIN_LUNAR_SOLAR_DATE || v.startDate > MAX_LUNAR_SOLAR_DATE || !solarToLunar(v.startDate))) return null
  let birthday: EventFields['birthday']
  if (v.type === 'birthday') {
    if (!v.birthday || typeof v.birthday !== 'object' || Array.isArray(v.birthday)
      || v.recurrence !== 'yearly' || !v.allDay
      || v.startDate !== v.endDate || v.startTime !== null || v.endTime !== null) return null
    const birthdayFields = v.birthday as Record<string, unknown>
    if (dateRule.calendar === 'chinese') {
      const birthLunarYear = birthdayFields.birthLunarYear
      if (Object.keys(birthdayFields).length !== 1 || !Number.isInteger(birthLunarYear)
        || (birthLunarYear as number) < 1901 || (birthLunarYear as number) > 2100) return null
      const birthDate = lunarToSolar({
        year: birthLunarYear as number,
        month: dateRule.lunarMonth,
        day: dateRule.lunarDay,
        isLeapMonth: dateRule.isLeapMonth,
      })
      if (!birthDate || birthDate !== v.startDate) return null
      birthday = { birthLunarYear: birthLunarYear as number }
    } else {
      const birthGregorianYear = birthdayFields.birthGregorianYear
      if (Object.keys(birthdayFields).length !== 1 || !Number.isInteger(birthGregorianYear)
        || (birthGregorianYear as number) < 1 || (birthGregorianYear as number) > 9999
        || Number(v.startDate.slice(0, 4)) !== birthGregorianYear) return null
      birthday = { birthGregorianYear: birthGregorianYear as number }
    }
    if (!birthdayPersonName(v.title)) return null
  } else if (v.birthday !== undefined) {
    return null
  }
  const title = v.type === 'birthday' ? birthdayPersonName(v.title) : v.title.trim()
  return { title, description: v.description.trim(), emoji: v.emoji, type: v.type,
    startDate: v.startDate, endDate: v.endDate, startTime: v.allDay ? null : v.startTime,
    endTime: v.allDay ? null : v.endTime, allDay: v.allDay, dateRule, recurrence: v.recurrence,
    ...(birthday ? { birthday } : {}),
    ...(attachmentIds ? { attachmentIds: [...attachmentIds] as string[] } : {}),
    showCountdown: v.showCountdown, isPrimary: v.isPrimary }
}

function parseEventDateRule(value: unknown): EventDateRule | null {
  if (value === undefined) return { calendar: 'gregory' }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const rule = value as Record<string, unknown>
  if (rule.calendar === 'gregory') return { calendar: 'gregory' }
  if (rule.calendar !== 'chinese'
    || !Number.isInteger(rule.lunarMonth) || (rule.lunarMonth as number) < 1 || (rule.lunarMonth as number) > 12
    || !Number.isInteger(rule.lunarDay) || (rule.lunarDay as number) < 1 || (rule.lunarDay as number) > 30
    || typeof rule.isLeapMonth !== 'boolean'
    || !['regular-month', 'leap-only'].includes(rule.leapMonthPolicy as string)
    || !['last-day', 'skip'].includes(rule.shortMonthPolicy as string)) return null
  return {
    calendar: 'chinese',
    lunarMonth: rule.lunarMonth as number,
    lunarDay: rule.lunarDay as number,
    isLeapMonth: rule.isLeapMonth,
    leapMonthPolicy: rule.leapMonthPolicy as 'regular-month' | 'leap-only',
    shortMonthPolicy: rule.shortMonthPolicy as 'last-day' | 'skip',
  }
}
// Annual Feb 29 occurrences fall on Feb 28 in non-leap years. Durations use
// natural days, so DST changes never shorten or lengthen an occurrence.
export function occurrenceInYear(event: EventFields, year: number): string | null {
  if (event.dateRule?.calendar === 'chinese') return lunarOccurrenceInYear(event.dateRule, year)
  return Temporal.PlainDate.from(event.startDate).with({ year }, { overflow: 'constrain' }).toString()
}
export function occursOn(event: EventFields, date: string): boolean {
  if (event.type === 'period') return date === event.startDate || (event.endDate !== null && date === event.endDate)
  if (date < event.startDate) return false
  if (event.endDate === null) return false
  if (event.recurrence === 'none') return date <= event.endDate && date >= event.startDate
  if (event.dateRule?.calendar === 'chinese') return nextOccurrence(event, date) === date
  const year = Temporal.PlainDate.from(date).year
  const duration = dayDistance(event.startDate, event.endDate)
  return [year - 1, year].some((y) => {
    const start = occurrenceInYear(event, y)
    if (!start) return false
    return start >= event.startDate && start <= date && date <= addDays(start, duration)
  })
}
/** Returns the start date of the Event occurrence containing a displayed date. */
export function eventOccurrenceStart(event: EventFields, date: string): string | null {
  if (event.type === 'period') return date === event.startDate || (event.endDate !== null && date === event.endDate) ? event.startDate : null
  if (!civilDate(date) || date < event.startDate) return null
  if (event.endDate === null) return null
  if (event.recurrence === 'none') return date <= event.endDate ? event.startDate : null
  const year = Temporal.PlainDate.from(date).year
  const duration = dayDistance(event.startDate, event.endDate)
  const occurrenceYears = [year, year - 1]
  const starts = occurrenceYears.map(occurrenceYear => occurrenceInYear(event, occurrenceYear))
  if (starts.some(start => start === date && start >= event.startDate)) return date
  for (const start of starts) {
    if (start && start >= event.startDate && start <= date && date <= addDays(start, duration)) return start
  }
  return null
}
export function nextOccurrence(event: EventFields, today: string): string | null {
  if (event.type === 'period') return event.startDate >= today ? event.startDate : null
  if (event.recurrence === 'none') return event.startDate >= today ? event.startDate : null
  if (event.endDate === null) return null
  if (event.dateRule?.calendar === 'chinese') {
    return nextLunarOccurrence(event.dateRule, today < event.startDate ? event.startDate : today)
  }
  let year = Math.max(Temporal.PlainDate.from(today).year, Temporal.PlainDate.from(event.startDate).year)
  let next = occurrenceInYear(event, year)!
  if (next < today) {
    if (year >= 9999) return null
    next = occurrenceInYear(event, ++year)!
  }
  return next
}
/** Returns the age reached on this exact birthday occurrence in its source calendar. */
export function birthdayAgeAt(event: EventFields, date: string): number | null {
  if (event.type !== 'birthday' || !event.birthday) return null
  if (event.dateRule?.calendar === 'chinese' && 'birthLunarYear' in event.birthday) {
    const lunarDate = solarToLunar(date)
    if (!lunarDate || lunarDate.year < event.birthday.birthLunarYear
      || lunarOccurrenceInYear(event.dateRule, lunarDate.year) !== date) return null
    return lunarDate.year - event.birthday.birthLunarYear
  }
  if (event.dateRule?.calendar !== 'chinese' && 'birthGregorianYear' in event.birthday) {
    const gregorianYear = Number(date.slice(0, 4))
    if (gregorianYear < event.birthday.birthGregorianYear || occurrenceInYear(event, gregorianYear) !== date) return null
    return gregorianYear - event.birthday.birthGregorianYear
  }
  return null
}
/** Removes generated birthday suffixes from titles saved by older UI versions. */
export function birthdayPersonName(title: string): string {
  return title
    .replace(/\s*[·•,，]\s*\d+\s*岁生日$/u, '')
    .replace(/\s*\d+\s*岁生日$/u, '')
    .replace(/\s*生日$/u, '')
    .trim()
}
/** Birthday event titles are generated for the occurrence being displayed. */
export function displayEventTitle(event: EventFields, date?: string | null): string {
  if (event.type !== 'birthday') return event.title
  const person = birthdayPersonName(event.title)
  const age = date ? birthdayAgeAt(event, date) : null
  return age === null ? `${person || ''}生日` : `${person}${age}岁生日`
}
export function compareEvents(a: DiaryEvent, b: DiaryEvent): number {
  return Number(b.isPrimary) - Number(a.isPrimary) || (a.startTime ?? '').localeCompare(b.startTime ?? '')
    || a.createdAt - b.createdAt || a.id.localeCompare(b.id)
}
