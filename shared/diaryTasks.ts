import { civilDate } from './diaryLife.js'

export interface TaskFields {
  title: string
  description: string
  dueDate: string | null
  dueTime: string | null
}

export interface DiaryTask extends TaskFields {
  id: string
  completedAt: number | null
  version: number
  createdAt: number
  updatedAt: number
}

export const MAX_DIARY_TASK_TITLE_LENGTH = 160
export const MAX_DIARY_TASK_DESCRIPTION_LENGTH = 4000

/** Parse and normalize the client-editable fields of a one-off Diary task. */
export function parseTaskFields(value: unknown): TaskFields | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const fields = value as Record<string, unknown>
  if (typeof fields.title !== 'string') return null
  const title = fields.title.trim()
  if (!title || title.length > MAX_DIARY_TASK_TITLE_LENGTH) return null

  const description = fields.description === undefined ? '' : fields.description
  if (typeof description !== 'string' || description.length > MAX_DIARY_TASK_DESCRIPTION_LENGTH) return null

  const dueDate = fields.dueDate === undefined ? null : fields.dueDate
  const dueTime = fields.dueTime === undefined ? null : fields.dueTime
  if (dueDate !== null && !civilDate(dueDate)) return null
  if (dueTime !== null && (typeof dueTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(dueTime))) return null
  if (dueDate === null && dueTime !== null) return null

  return { title, description, dueDate, dueTime } as TaskFields
}

/** Overdue is a date-derived view of an unfinished task, never stored state. */
export function isTaskOverdue(task: Pick<DiaryTask, 'completedAt' | 'dueDate'>, today: string): boolean {
  return task.completedAt === null && task.dueDate !== null && task.dueDate < today
}
