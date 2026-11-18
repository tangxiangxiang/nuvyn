import { addDays, dayDistance } from '../../../shared/diaryLife'
import { isTaskOverdue, type DiaryTaskListItem, type DiaryTaskItemPage } from '../../../shared/diaryTasks'
import { DiaryTaskListChangedError, diaryTasksApi } from '../../lib/diary-tasks-api'

type RangePageReader = (start: string, end: string, cursor?: string, signal?: AbortSignal) => Promise<DiaryTaskItemPage>

/** Reads every page in a calendar range as one revision-consistent snapshot. */
export async function listDiaryTasksInRange(
  start: string,
  end: string,
  signal?: AbortSignal,
  readPage: RangePageReader = diaryTasksApi.taskItemsInRange,
): Promise<DiaryTaskListItem[]> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const items = new Map<string, DiaryTaskListItem>()
    let cursor: string | undefined
    try {
      do {
        if (signal?.aborted) return []
        const page = await readPage(start, end, cursor, signal)
        if (signal?.aborted) return []
        for (const task of page.items) items.set(task.id, task)
        cursor = page.nextCursor ?? undefined
      } while (cursor !== undefined)
      return [...items.values()]
    } catch (error) {
      if (signal?.aborted) return []
      if (!(error instanceof DiaryTaskListChangedError) || attempt === 1) throw error
    }
  }
  return []
}

export function groupTasksByDueDate(tasks: DiaryTaskListItem[]): Map<string, DiaryTaskListItem[]> {
  const grouped = new Map<string, DiaryTaskListItem[]>()
  for (const task of tasks) {
    if (!task.dueDate) continue
    const items = grouped.get(task.dueDate) ?? []
    items.push(task)
    grouped.set(task.dueDate, items)
  }
  return grouped
}

export function taskDueDateLabel(task: Pick<DiaryTaskListItem, 'dueDate' | 'dueTime' | 'completedAt'>, today: string): string {
  const { dueDate, dueTime } = task
  if (!dueDate) return '无日期'
  const nextDay = addDays(today, 1)
  let label: string
  if (isTaskOverdue(task, today)) {
    label = `已逾期 ${dayDistance(dueDate, today)} 天`
  } else if (dueDate === today) label = '今天'
  else if (dueDate === nextDay) label = '明天'
  else {
    const [year, month, day] = dueDate.split('-').map(Number)
    label = year === Number(today.slice(0, 4)) ? `${month}月${day}日` : `${year}年${month}月${day}日`
  }
  return dueTime ? `${label} ${dueTime}` : label
}
