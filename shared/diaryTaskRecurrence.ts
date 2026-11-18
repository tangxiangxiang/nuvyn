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
  for (let date = Temporal.PlainDate.from(first); Temporal.PlainDate.compare(date, Temporal.PlainDate.from(last)) <= 0; date = date.add({ days: 1 })) {
    const civil = date.toString()
    if (taskRecurrenceOccursOn(rule, civil, effectiveFrom)) dates.push(civil)
  }
  return dates
}
