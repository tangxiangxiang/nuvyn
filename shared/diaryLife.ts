import { Temporal } from '@js-temporal/polyfill'
import { isMoodId, isDiaryCustomMoodId } from './diaryMood.js'

export interface DayFields { moodId: string | null; description: string }
export interface EventFields {
  title: string
  description: string
  emoji: string
  type: 'milestone' | 'anniversary' | 'schedule'
  startDate: string
  endDate: string
  startTime: string | null
  endTime: string | null
  allDay: boolean
  recurrence: 'none' | 'yearly'
  showCountdown: boolean
  isPrimary: boolean
}
export interface DiaryDay extends DayFields { date: string; version: number; createdAt: number; updatedAt: number }
export interface DiaryEvent extends EventFields { id: string; version: number; createdAt: number; updatedAt: number }
export function civilDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '0001-01-01') return false
  try { return Temporal.PlainDate.from(value, { overflow: 'reject' }).toString() === value } catch { return false }
}
export function localToday(): string { return Temporal.Now.plainDateISO().toString() }
export function dayDistance(from: string, to: string): number {
  return Temporal.PlainDate.from(from).until(Temporal.PlainDate.from(to)).days
}
export function addDays(date: string, days: number): string { return Temporal.PlainDate.from(date).add({ days }).toString() }
export function parseDay(value: unknown): DayFields | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (v.moodId !== null && !isMoodId(v.moodId) && !isDiaryCustomMoodId(v.moodId)) return null
  if (typeof v.description !== 'string' || v.description.length > 4000) return null
  return { moodId: v.moodId as string | null, description: v.description.trim() }
}
export function parseEvent(value: unknown): EventFields | null {
  if (!value || typeof value !== 'object') return null
  const v = value as EventFields
  if (typeof v.title !== 'string' || !v.title.trim() || v.title.length > 160
    || typeof v.description !== 'string' || v.description.length > 4000
    || typeof v.emoji !== 'string' || !v.emoji || v.emoji.length > 100
    || !/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(v.emoji)
    || [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(v.emoji)].length !== 1
    || !['milestone', 'anniversary', 'schedule'].includes(v.type)
    || !civilDate(v.startDate) || !civilDate(v.endDate) || v.endDate < v.startDate
    || dayDistance(v.startDate, v.endDate) > 366
    || typeof v.allDay !== 'boolean' || typeof v.showCountdown !== 'boolean' || typeof v.isPrimary !== 'boolean'
    || !['none', 'yearly'].includes(v.recurrence)) return null
  const time = (t: unknown) => t === null || (typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t))
  if (!time(v.startTime) || !time(v.endTime)) return null
  if (!v.allDay && v.endTime !== null && v.startTime === null) return null
  if (!v.allDay && v.startDate === v.endDate && v.startTime && v.endTime && v.endTime <= v.startTime) return null
  return { title: v.title.trim(), description: v.description.trim(), emoji: v.emoji, type: v.type,
    startDate: v.startDate, endDate: v.endDate, startTime: v.allDay ? null : v.startTime,
    endTime: v.allDay ? null : v.endTime, allDay: v.allDay, recurrence: v.recurrence,
    showCountdown: v.showCountdown, isPrimary: v.isPrimary }
}
// Annual Feb 29 occurrences fall on Feb 28 in non-leap years. Durations use
// natural days, so DST changes never shorten or lengthen an occurrence.
export function occurrenceInYear(event: EventFields, year: number): string {
  return Temporal.PlainDate.from(event.startDate).with({ year }, { overflow: 'constrain' }).toString()
}
export function occursOn(event: EventFields, date: string): boolean {
  if (date < event.startDate) return false
  if (event.recurrence === 'none') return date <= event.endDate && date >= event.startDate
  const year = Temporal.PlainDate.from(date).year
  const duration = dayDistance(event.startDate, event.endDate)
  return [year - 1, year].some((y) => {
    const start = occurrenceInYear(event, y)
    return start >= event.startDate && start <= date && date <= addDays(start, duration)
  })
}
export function nextOccurrence(event: EventFields, today: string): string | null {
  if (event.recurrence === 'none') return event.startDate >= today ? event.startDate : null
  let year = Math.max(Temporal.PlainDate.from(today).year, Temporal.PlainDate.from(event.startDate).year)
  let next = occurrenceInYear(event, year)
  if (next < today) {
    if (year >= 9999) return null
    next = occurrenceInYear(event, ++year)
  }
  return next
}
export function compareEvents(a: DiaryEvent, b: DiaryEvent): number {
  return Number(b.isPrimary) - Number(a.isPrimary) || (a.startTime ?? '').localeCompare(b.startTime ?? '')
    || a.createdAt - b.createdAt || a.id.localeCompare(b.id)
}
