import { addDays, nextOccurrence, occursOn, type DiaryEvent } from '../../../shared/diaryLife'
import { isTaskOverdue, type DiaryTask } from '../../../shared/diaryTasks'
import { isTaskCompletedLate } from './taskCompletion'

export type DeadlineVisualState = 'normal' | 'due-soon' | 'overdue' | 'inactive'
export type TodoDayVisualState = 'none' | 'pending' | 'due-soon' | 'overdue' | 'completed' | 'completed-late'
export type DeadlineTask = Pick<DiaryTask, 'completedAt' | 'dueDate' | 'dueTime'> & { skipped?: boolean }

/** Classifies a single task or recurring occurrence by civil date, never dueTime. */
export function taskDeadlineVisualState(task: DeadlineTask, today: string): DeadlineVisualState {
  if (task.completedAt !== null || task.skipped === true || task.dueDate === null) return 'inactive'
  if (isTaskOverdue(task, today)) return 'overdue'
  return task.dueDate <= addDays(today, 1) ? 'due-soon' : 'normal'
}

/** Selects the strongest visual reminder for a date without duplicating tasks. */
export function mostUrgentTaskDeadlineState(tasks: DeadlineTask[], today: string): DeadlineVisualState {
  const states = tasks.map(task => taskDeadlineVisualState(task, today))
  if (states.includes('overdue')) return 'overdue'
  if (states.includes('due-soon')) return 'due-soon'
  if (states.includes('normal')) return 'normal'
  return 'inactive'
}

/** Derives one calendar marker from the persisted states for a single due date. */
export function todoDayVisualState(tasks: readonly DeadlineTask[], today: string): TodoDayVisualState {
  if (!tasks.length) return 'none'

  const pending = tasks.filter(task => task.skipped !== true && task.completedAt === null)
  if (pending.length) {
    const urgentState = mostUrgentTaskDeadlineState(pending, today)
    if (urgentState === 'overdue') return 'overdue'
    if (urgentState === 'due-soon') return 'due-soon'
    return 'pending'
  }

  if (tasks.every(task => task.skipped !== true && task.completedAt !== null)) {
    return tasks.some(isTaskCompletedLate) ? 'completed-late' : 'completed'
  }
  return 'none'
}

/** Uses Diary's existing recurrence and cross-day occurrence rules. */
export function shouldShowEventDeadlineReminder(event: DiaryEvent, today: string): boolean {
  if (occursOn(event, today)) return true
  const upcoming = nextOccurrence(event, today)
  return upcoming === today || upcoming === addDays(today, 1)
}
