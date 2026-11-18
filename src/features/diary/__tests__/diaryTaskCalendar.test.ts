import { describe, expect, it, vi } from 'vitest'
import type { DiaryTask, DiaryTaskListItem, DiaryTaskItemPage } from '../../../../shared/diaryTasks'
import { DiaryTaskListChangedError } from '../../../lib/diary-tasks-api'
import { groupTasksByDueDate, listDiaryTasksInRange, taskDueDateLabel } from '../diaryTaskCalendar'

function makeTask(overrides: Partial<DiaryTask> = {}): DiaryTaskListItem {
  return {
    kind: 'one-off',
    id: '00000000-0000-4000-8000-000000000001',
    title: 'Task',
    description: '',
    dueDate: '2026-11-17',
    dueTime: null,
    completedAt: null,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('Diary task calendar helpers', () => {
  it('loads every range page and restarts from page one after a revision conflict', async () => {
    const first = makeTask({ id: 'first' })
    const second = makeTask({ id: 'second', dueDate: '2026-11-18' })
    let changedOnce = false
    const cursors: Array<string | undefined> = []
    const readPage = vi.fn(async (_start: string, _end: string, cursor?: string): Promise<DiaryTaskItemPage> => {
      cursors.push(cursor)
      if (cursor === 'stale' && !changedOnce) {
        changedOnce = true
        throw new DiaryTaskListChangedError()
      }
      if (!cursor) return { items: [first], nextCursor: 'stale' }
      return { items: [second], nextCursor: null }
    })

    await expect(listDiaryTasksInRange('2026-11-01', '2026-11-30', undefined, readPage))
      .resolves.toEqual([first, second])
    expect(cursors).toEqual([undefined, 'stale', undefined, 'stale'])
  })

  it('groups only dated tasks and labels overdue, completed, and undated tasks', () => {
    const overdue = makeTask({ dueDate: '2026-11-14' })
    const completed = makeTask({ id: 'completed', dueDate: '2026-11-14', completedAt: 10 })
    const undated = makeTask({ id: 'undated', dueDate: null })
    const grouped = groupTasksByDueDate([overdue, completed, undated])

    expect([...grouped.keys()]).toEqual(['2026-11-14'])
    expect(grouped.get('2026-11-14')).toEqual([overdue, completed])
    expect(taskDueDateLabel(overdue, '2026-11-16')).toBe('已逾期 2 天')
    expect(taskDueDateLabel(completed, '2026-11-16')).toBe('11月14日')
    expect(taskDueDateLabel(undated, '2026-11-16')).toBe('无日期')
    expect(taskDueDateLabel(makeTask({ dueDate: '2026-11-17', dueTime: '09:30' }), '2026-11-16'))
      .toBe('明天 09:30')
    expect(taskDueDateLabel({ ...overdue, skipped: true }, '2026-11-16')).toBe('11月14日')
  })

  it('stops pagination after the request is aborted', async () => {
    const controller = new AbortController()
    const readPage = vi.fn(async (_start: string, _end: string, _cursor?: string, signal?: AbortSignal): Promise<DiaryTaskItemPage> => {
      expect(signal).toBe(controller.signal)
      controller.abort()
      return { items: [makeTask()], nextCursor: 'next' }
    })

    await expect(listDiaryTasksInRange('2026-11-01', '2026-11-30', controller.signal, readPage)).resolves.toEqual([])
    expect(readPage).toHaveBeenCalledTimes(1)
  })
})
