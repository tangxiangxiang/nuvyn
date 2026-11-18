import { dayDistance, displayEventTitle, eventOccurrenceStart, occurrenceInYear, type DiaryEvent } from '../../../shared/diaryLife'

export interface TaskEventOccurrenceOption {
  label: string
  value: string
  eventId: string
  occurrenceDate: string
}

const OPTION_SEPARATOR = '::'

export function taskEventOccurrenceValue(eventId: string, occurrenceDate: string): string {
  return `${eventId}${OPTION_SEPARATOR}${occurrenceDate}`
}

function eventOccurrenceInCalendarYear(event: DiaryEvent, calendarYear: number): string[] {
  const sourceYears = event.dateRule?.calendar === 'chinese'
    ? [calendarYear - 1, calendarYear, calendarYear + 1]
    : [calendarYear]
  return [...new Set(sourceYears
    .map(year => occurrenceInYear(event, year))
    .filter((date): date is string => Boolean(date && date.startsWith(`${calendarYear}-`) && date >= event.startDate)))].sort()
}

function searchYear(search: string): number | null {
  const match = search.match(/(?:^|\D)(\d{4})(?:\D|$)/)
  if (!match) return null
  const year = Number(match[1])
  return year >= 1 && year <= 9999 ? year : null
}

export function buildTaskEventOccurrenceOptions(
  events: DiaryEvent[],
  options: {
    today: string
    dueDate?: string | null
    preferredOccurrenceDate?: string | null
    selectedOccurrenceDate?: string | null
    search?: string
  },
): TaskEventOccurrenceOption[] {
  const anchorDates = [options.dueDate, options.preferredOccurrenceDate, options.selectedOccurrenceDate, options.today]
    .filter((date): date is string => Boolean(date))
  const years = new Set<number>()
  for (const anchor of anchorDates) {
    const year = Number(anchor.slice(0, 4))
    if (!Number.isInteger(year) || year < 1 || year > 9999) continue
    for (const delta of [-1, 0, 1]) {
      if (year + delta >= 1 && year + delta <= 9999) years.add(year + delta)
    }
  }
  const requestedYear = searchYear(options.search ?? '')
  if (requestedYear !== null) years.add(requestedYear)

  const occurrences: TaskEventOccurrenceOption[] = []
  for (const event of events) {
    const dates = event.recurrence === 'none'
      ? [event.startDate]
      : [...new Set([...years].flatMap(year => eventOccurrenceInCalendarYear(event, year)))].sort()
    for (const occurrenceDate of dates) {
      const title = displayEventTitle(event, occurrenceDate)
      occurrences.push({
        label: `${title} · ${occurrenceDate}`,
        value: taskEventOccurrenceValue(event.id, occurrenceDate),
        eventId: event.id,
        occurrenceDate,
      })
    }
  }
  return occurrences.sort((left, right) => left.label.localeCompare(right.label))
}

export function recommendedTaskEventOccurrence(
  event: DiaryEvent,
  options: TaskEventOccurrenceOption[],
  targetDate: string,
): TaskEventOccurrenceOption | null {
  if (event.recurrence === 'none') {
    return options.find(option => option.eventId === event.id && option.occurrenceDate === event.startDate) ?? null
  }
  const matchingOccurrence = eventOccurrenceStart(event, targetDate)
  if (matchingOccurrence) {
    const exact = options.find(option => option.eventId === event.id && option.occurrenceDate === matchingOccurrence)
    if (exact) return exact
  }
  return options
    .filter(option => option.eventId === event.id)
    .sort((left, right) => Math.abs(dayDistance(targetDate, left.occurrenceDate)) - Math.abs(dayDistance(targetDate, right.occurrenceDate))
      || left.occurrenceDate.localeCompare(right.occurrenceDate))[0] ?? null
}
