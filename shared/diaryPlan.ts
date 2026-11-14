import type { DiaryDate } from './diaryProtocol.js'

export interface DiaryPlanFields {
  title: string
  plannedTime: string | null
}

export interface DiaryPlanItem extends DiaryPlanFields {
  id: string
  date: DiaryDate
  completedAt: number | null
  createdAt: number
  updatedAt: number
  version: number
}

export interface DiaryPlanDaySummary {
  date: DiaryDate
  total: number
  completed: number
}

export function parseDiaryPlanFields(input: unknown): DiaryPlanFields | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const value = input as Record<string, unknown>
  const title = typeof value.title === 'string' ? value.title.trim() : ''
  if (!title || [...title].length > 200 || /[\uD800-\uDFFF]/u.test(title)) return null
  const plannedTime = value.plannedTime === undefined ? null : value.plannedTime
  if (plannedTime !== null && (typeof plannedTime !== 'string'
    || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(plannedTime) || plannedTime.length !== 5)) return null
  return { title, plannedTime }
}

export function compareDiaryPlanItems(a: DiaryPlanItem, b: DiaryPlanItem): number {
  return Number(a.completedAt !== null) - Number(b.completedAt !== null)
    || (a.plannedTime ?? '24:00').localeCompare(b.plannedTime ?? '24:00')
    || a.createdAt - b.createdAt || a.id.localeCompare(b.id)
}
