import { addDays, dayDistance, eventOccurrenceStart, occursOn, type DiaryEvent } from '../../../shared/diaryLife'

export function eventDistanceLabel(event: DiaryEvent, occurrenceDate: string, today: string): string {
  if (!occursOn(event, occurrenceDate)) return ''

  const start = eventOccurrenceStart(event, occurrenceDate)
  if (!start) return ''

  const end = addDays(start, dayDistance(event.startDate, event.endDate))
  if (today < start) return `还剩${dayDistance(today, start)}天`
  if (today <= end) return start === end ? '今天' : '进行中'
  return `已过去${dayDistance(end, today)}天`
}
