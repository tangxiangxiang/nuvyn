import { civilDate } from './diaryLife.js'
import { parseTaskRecurrenceRule, type TaskRecurrenceRule } from './diaryTaskRecurrence.js'

export interface TaskFields {
  title: string
  description: string
  dueDate: string | null
  dueTime: string | null
}

export interface OneOffTaskFields extends TaskFields {
  startDate: string | null
  startTime: string | null
}

export interface TaskEventAssociation {
  taskId: string
  eventId: string
  occurrenceDate: string
}

export interface DiaryTask extends OneOffTaskFields {
  id: string
  completedAt: number | null
  version: number
  createdAt: number
  updatedAt: number
  eventId?: string | null
  eventOccurrenceDate?: string | null
}

export interface TaskSeriesFields {
  title: string
  description: string
  dueTime: string | null
  recurrence: TaskRecurrenceRule
}

export interface DiaryTaskSeries extends TaskSeriesFields {
  id: string
  effectiveFrom: string
  version: number
  createdAt: number
  updatedAt: number
}

export interface DiaryRecurringTaskOccurrence extends TaskFields {
  kind: 'recurring'
  /** Stable row identity for this individual calendar occurrence. */
  id: string
  seriesId: string
  occurrenceDate: string
  effectiveFrom: string
  recurrence: TaskRecurrenceRule
  seriesVersion: number
  occurrenceVersion: number
  version: number
  completedAt: number | null
  skipped: boolean
  createdAt: number
  updatedAt: number
}

export type DiaryTaskListItem = (DiaryTask & { kind?: 'one-off'; eventId?: string | null }) | DiaryRecurringTaskOccurrence

export interface TaskOccurrenceState {
  status: 'pending' | 'completed' | 'skipped'
  completedAt: number | null
}

export interface DiaryTaskPage {
  items: DiaryTask[]
  nextCursor: string | null
}

export interface DiaryTaskItemPage {
  items: DiaryTaskListItem[]
  nextCursor: string | null
}

export interface TaskEditorFields extends OneOffTaskFields {
  recurrence: TaskRecurrenceRule | null
  eventId: string | null
  eventOccurrenceDate?: string | null
}

export type DiaryTaskListStatus = 'open' | 'completed'

export const MAX_DIARY_TASK_TITLE_LENGTH = 160
export const MAX_DIARY_TASK_DESCRIPTION_LENGTH = 4000

/** Parse and normalize the client-editable fields of a one-off Diary task. */
export type TaskTimeValidationError =
  | 'invalid-start-date'
  | 'invalid-start-time'
  | 'start-time-without-date'
  | 'invalid-due-date'
  | 'invalid-due-time'
  | 'due-time-without-date'
  | 'start-after-due-date'
  | 'start-time-after-due-time'

/** Validate and normalize the civil start and due fields used by one-off tasks. */
export function taskTimeFieldsError(value: unknown): TaskTimeValidationError | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'invalid-start-date'
  const fields = value as Record<string, unknown>
  const startDate = fields.startDate === undefined ? null : fields.startDate
  const startTime = fields.startTime === undefined ? null : fields.startTime
  const dueDate = fields.dueDate === undefined ? null : fields.dueDate
  const dueTime = fields.dueTime === undefined ? null : fields.dueTime
  const validTime = (time: unknown): time is string => typeof time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(time)

  if (startDate !== null && (typeof startDate !== 'string' || !civilDate(startDate))) return 'invalid-start-date'
  if (startTime !== null && !validTime(startTime)) return 'invalid-start-time'
  if (startDate === null && startTime !== null) return 'start-time-without-date'
  if (dueDate !== null && (typeof dueDate !== 'string' || !civilDate(dueDate))) return 'invalid-due-date'
  if (dueTime !== null && !validTime(dueTime)) return 'invalid-due-time'
  if (dueDate === null && dueTime !== null) return 'due-time-without-date'
  if (startDate !== null && dueDate !== null && startDate > dueDate) return 'start-after-due-date'
  if (startDate !== null && startDate === dueDate && startTime !== null && dueTime !== null && startTime > dueTime) {
    return 'start-time-after-due-time'
  }
  return null
}

/** Parse the client-editable fields of a one-off Diary task. */
export function parseTaskFields(value: unknown): OneOffTaskFields | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const fields = value as Record<string, unknown>
  if (typeof fields.title !== 'string') return null
  const title = fields.title.trim()
  if (!title || title.length > MAX_DIARY_TASK_TITLE_LENGTH) return null

  const description = fields.description === undefined ? '' : fields.description
  if (typeof description !== 'string' || description.length > MAX_DIARY_TASK_DESCRIPTION_LENGTH) return null

  const timeError = taskTimeFieldsError(fields)
  if (timeError) return null
  return {
    title,
    description,
    startDate: (fields.startDate === undefined ? null : fields.startDate) as string | null,
    startTime: (fields.startTime === undefined ? null : fields.startTime) as string | null,
    dueDate: (fields.dueDate === undefined ? null : fields.dueDate) as string | null,
    dueTime: (fields.dueTime === undefined ? null : fields.dueTime) as string | null,
  }
}

export function parseTaskSeriesFields(value: unknown): TaskSeriesFields | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const fields = value as Record<string, unknown>
  if (typeof fields.title !== 'string') return null
  const title = fields.title.trim()
  if (!title || title.length > MAX_DIARY_TASK_TITLE_LENGTH) return null
  const description = fields.description === undefined ? '' : fields.description
  const dueTime = fields.dueTime === undefined ? null : fields.dueTime
  const recurrence = parseTaskRecurrenceRule(fields.recurrence)
  if (typeof description !== 'string' || description.length > MAX_DIARY_TASK_DESCRIPTION_LENGTH
    || !(dueTime === null || (typeof dueTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(dueTime)))
    || !recurrence) return null
  return { title, description, dueTime: dueTime as string | null, recurrence }
}

export function parseTaskOccurrenceState(value: unknown): TaskOccurrenceState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const state = value as Record<string, unknown>
  if (!['pending', 'completed', 'skipped'].includes(state.status as string)
    || !(state.completedAt === null || (Number.isSafeInteger(state.completedAt) && (state.completedAt as number) >= 0))
    || (state.status === 'completed') !== (state.completedAt !== null)) return null
  return { status: state.status as TaskOccurrenceState['status'], completedAt: state.completedAt as number | null }
}

/** Overdue is a date-derived view of an unfinished task, never stored state. */
export function isTaskOverdue(task: Pick<DiaryTask, 'completedAt' | 'dueDate'> & { skipped?: boolean }, today: string): boolean {
  return task.completedAt === null && task.skipped !== true && task.dueDate !== null && task.dueDate < today
}
