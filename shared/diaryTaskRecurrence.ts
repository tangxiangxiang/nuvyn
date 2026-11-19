import { Temporal } from '@js-temporal/polyfill'
import { civilDate } from './diaryLife.js'

export type TaskRecurrenceFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly'

export interface TaskRecurrenceRule {
  frequency: TaskRecurrenceFrequency
  /** The original anchor date. Monthly and yearly rules always derive from it. */
  startDate: string
  untilDate: string | null
}

const FREQUENCIES = new Set<TaskRecurrenceFrequency>(['daily', 'weekly', 'monthly', 'yearly'])

export function parseTaskRecurrenceRule(value: unknown): TaskRecurrenceRule | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const rule = value as Record<string, unknown>
  if (typeof rule.frequency !== 'string' || !FREQUENCIES.has(rule.frequency as TaskRecurrenceFrequency)
    || !civilDate(rule.startDate)
    || !(rule.untilDate === null || (civilDate(rule.untilDate) && rule.untilDate >= rule.startDate))) return null
  return {
    frequency: rule.frequency as TaskRecurrenceFrequency,
    startDate: rule.startDate,
    untilDate: rule.untilDate as string | null,
  }
}

/** Whether a Gregorian civil date is an occurrence of a bounded recurrence rule. */
export function taskRecurrenceOccursOn(rule: TaskRecurrenceRule, date: string, effectiveFrom = rule.startDate): boolean {
  if (!civilDate(date) || !civilDate(effectiveFrom) || date < rule.startDate || date < effectiveFrom
    || (rule.untilDate !== null && date > rule.untilDate)) return false

  const target = Temporal.PlainDate.from(date)
  const anchor = Temporal.PlainDate.from(rule.startDate)
  switch (rule.frequency) {
    case 'daily':
      return true
    case 'weekly':
      return target.since(anchor, { largestUnit: 'days' }).days % 7 === 0
    case 'monthly': {
      const targetMonth = target.with({ day: 1 })
      const anchorMonth = anchor.with({ day: 1 })
      const monthDistance = targetMonth.since(anchorMonth, { largestUnit: 'months' }).months
      const anchorDay = Math.min(anchor.day, target.daysInMonth)
      return monthDistance >= 0 && target.day === anchorDay
    }
    case 'yearly':
      return target.month === anchor.month && target.day === Math.min(anchor.day, target.daysInMonth)
  }
}

/** Enumerates only a finite date range. Callers must keep ranges bounded. */
export function taskRecurrenceDates(
  rule: TaskRecurrenceRule,
  start: string,
  end: string,
  effectiveFrom = rule.startDate,
  maxDays = 366,
): string[] {
  if (!civilDate(start) || !civilDate(end) || end < start || !Number.isInteger(maxDays) || maxDays < 1) return []
  const first = start > effectiveFrom ? start : effectiveFrom
  const last = rule.untilDate && rule.untilDate < end ? rule.untilDate : end
  if (last < first) return []
  const distance = Temporal.PlainDate.from(last).since(Temporal.PlainDate.from(first), { largestUnit: 'days' }).days
  if (distance >= maxDays) throw new RangeError('Diary task recurrence range exceeds the supported window')

  const dates: string[] = []
  const lastDate = Temporal.PlainDate.from(last)
  let date = Temporal.PlainDate.from(first)
  while (Temporal.PlainDate.compare(date, lastDate) <= 0) {
    const civil = date.toString()
    if (taskRecurrenceOccursOn(rule, civil, effectiveFrom)) dates.push(civil)
    if (Temporal.PlainDate.compare(date, lastDate) === 0) break
    date = date.add({ days: 1 })
  }
  return dates
}

const SEARCH_WINDOW_DAYS = 3660

function shiftedDate(date: string, days: number): string {
  try {
    return Temporal.PlainDate.from(date).add({ days }).toString()
  } catch {
    return days < 0 ? '0001-01-01' : '9999-12-31'
  }
}

/**
 * Picks one useful occurrence for a series-level search result. It prefers
 * the nearest non-skipped occurrence from today, and only searches backward
 * when the series has ended. The bounded window is longer than the maximum
 * gap between supported yearly occurrences.
 */
export function taskSearchOccurrenceDate(
  rule: TaskRecurrenceRule,
  effectiveFrom: string,
  today: string,
  skippedDates: ReadonlySet<string> | ((date: string) => boolean) = new Set(),
): string | null {
  if (!civilDate(effectiveFrom) || !civilDate(today)) return null
  const isSkipped = typeof skippedDates === 'function' ? skippedDates : (date: string) => skippedDates.has(date)
  const futureStart = [rule.startDate, effectiveFrom, today].sort().at(-1)!
  const futureEnd = [rule.untilDate ?? '9999-12-31', shiftedDate(futureStart, SEARCH_WINDOW_DAYS)].sort()[0]!
  if (futureEnd >= futureStart) {
    const futureDates = taskRecurrenceDates(rule, futureStart, futureEnd, effectiveFrom, SEARCH_WINDOW_DAYS + 1)
    const target = futureDates.find(date => !isSkipped(date))
    if (target) return target
  }

  if (rule.untilDate === null || rule.untilDate > today) return null
  const pastEnd = rule.untilDate
  const pastStart = [rule.startDate, effectiveFrom, shiftedDate(pastEnd, -SEARCH_WINDOW_DAYS)].sort().at(-1)!
  if (pastEnd < pastStart) return null
  const pastDates = taskRecurrenceDates(rule, pastStart, pastEnd, effectiveFrom, SEARCH_WINDOW_DAYS + 1)
  return [...pastDates].reverse().find(date => !isSkipped(date)) ?? null
}
