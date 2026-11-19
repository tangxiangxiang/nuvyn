import { civilDate, dayDistance } from '../../../shared/diaryLife'

export interface TaskCompletionRecord {
  completedAt: number | null
  dueDate: string | null
  dueTime: string | null
}

export interface TaskCompletionInfo {
  completedAt: number
  completedAtLabel: string
  overdueLabel: string | null
  statusLabel: '已完成' | '逾期完成'
}

function formatLocalDateTime(timestamp: number): string | null {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return null

  const year = date.getFullYear().toString().padStart(4, '0')
  const month = (date.getMonth() + 1).toString().padStart(2, '0')
  const day = date.getDate().toString().padStart(2, '0')
  const hours = date.getHours().toString().padStart(2, '0')
  const minutes = date.getMinutes().toString().padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}`
}

function deadlineTimestamp(dueDate: string | null, dueTime: string | null): number | null {
  if (!dueDate || !civilDate(dueDate)) return null
  if (dueTime !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(dueTime)) return null

  const [year, month, day] = dueDate.split('-').map(Number)
  const deadline = new Date(0)
  deadline.setHours(0, 0, 0, 0)
  deadline.setFullYear(year!, month! - 1, day!)

  if (dueTime) {
    const [hours, minutes] = dueTime.split(':').map(Number)
    deadline.setHours(hours!, minutes!, 0, 0)
  } else {
    deadline.setDate(deadline.getDate() + 1)
  }

  return deadline.getTime()
}

function formatOverdueDuration(milliseconds: number): string {
  const totalMinutes = Math.floor(milliseconds / 60_000)
  if (totalMinutes < 1) return '逾期不足1分'
  const days = Math.floor(totalMinutes / 1_440)
  const hours = Math.floor((totalMinutes % 1_440) / 60)
  const minutes = totalMinutes % 60
  const duration = [
    days ? `${days}天` : '',
    hours ? `${hours}小时` : '',
    minutes ? `${minutes}分` : '',
  ].join('')
  return `逾期 ${duration || '1分'}`
}

/** Formats a live overdue label for one unfinished task or recurring occurrence. */
export function taskOverdueLabel(
  task: TaskCompletionRecord & { skipped?: boolean },
  now: number,
): string | null {
  if (task.completedAt !== null || task.skipped || !task.dueDate) return null
  const deadline = deadlineTimestamp(task.dueDate, task.dueTime)
  if (deadline === null) return null

  if (task.dueTime === null) {
    const today = formatLocalDateTime(now)?.slice(0, 10)
    if (!today || today <= task.dueDate) return null
    return `已逾期${dayDistance(task.dueDate, today)}天`
  }

  const overdueMilliseconds = now - deadline
  if (overdueMilliseconds <= 0) return null

  const totalMinutes = Math.floor(overdueMilliseconds / 60_000)
  if (totalMinutes < 1) return '已逾期不足1分钟'
  if (totalMinutes < 60) return `已逾期${totalMinutes}分钟`

  const hours = Math.floor(totalMinutes / 60)
  if (hours < 24) {
    const minutes = totalMinutes % 60
    return `已逾期${hours}小时${minutes ? `${minutes}分` : ''}`
  }

  return `已逾期${Math.floor(totalMinutes / 1_440)}天`
}

/** Formats one task instance's completion timestamp and compares it to its deadline. */
export function taskCompletionInfo(task: TaskCompletionRecord): TaskCompletionInfo | null {
  if (task.completedAt === null) return null
  const completedAtLabel = formatLocalDateTime(task.completedAt)
  if (!completedAtLabel) return null

  const deadline = deadlineTimestamp(task.dueDate, task.dueTime)
  const overdueDuration = deadline !== null && (task.dueTime === null ? task.completedAt >= deadline : task.completedAt > deadline)
    ? task.completedAt - deadline
    : null

  return {
    completedAt: task.completedAt,
    completedAtLabel,
    overdueLabel: overdueDuration === null ? null : formatOverdueDuration(overdueDuration),
    statusLabel: overdueDuration === null ? '已完成' : '逾期完成',
  }
}

/** Shares the exact deadline comparison used by the task editor and calendar. */
export function isTaskCompletedLate(task: TaskCompletionRecord & { skipped?: boolean }): boolean {
  if (task.skipped || task.completedAt === null) return false
  const completion = taskCompletionInfo(task)
  return completion !== null && completion.overdueLabel !== null
}
