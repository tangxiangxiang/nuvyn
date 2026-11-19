import { describe, expect, it } from 'vitest'
import { taskCompletionInfo, taskOverdueLabel } from '../taskCompletion'

describe('taskCompletionInfo', () => {
  it('distinguishes an on-time completion from a completion after the due time', () => {
    const completedAt = new Date(2026, 10, 15, 3, 26).getTime()

    expect(taskCompletionInfo({ completedAt, dueDate: '2026-11-15', dueTime: '03:26' })).toMatchObject({
      completedAtLabel: '2026-11-15 03:26',
      overdueLabel: null,
      statusLabel: '已完成',
    })
    expect(taskCompletionInfo({ completedAt, dueDate: '2026-11-15', dueTime: '02:00' })).toMatchObject({
      completedAtLabel: '2026-11-15 03:26',
      overdueLabel: '逾期 1小时26分',
      statusLabel: '逾期完成',
    })
  })

  it('uses the end of a date-only deadline and preserves each recurring instance timestamp', () => {
    const beforeMidnight = new Date(2026, 10, 15, 23, 59).getTime()
    const afterMidnight = new Date(2026, 10, 16, 1, 0).getTime()

    expect(taskCompletionInfo({ completedAt: beforeMidnight, dueDate: '2026-11-15', dueTime: null })?.statusLabel).toBe('已完成')
    expect(taskCompletionInfo({ completedAt: afterMidnight, dueDate: '2026-11-15', dueTime: null })).toMatchObject({
      overdueLabel: '逾期 1小时',
      statusLabel: '逾期完成',
    })
    expect(taskCompletionInfo({ completedAt: new Date(2026, 10, 16).getTime(), dueDate: '2026-11-15', dueTime: null })).toMatchObject({
      overdueLabel: '逾期不足1分',
      statusLabel: '逾期完成',
    })
  })

  it('does not classify missing or invalid deadlines as overdue', () => {
    const completedAt = new Date(2026, 10, 15, 3, 26).getTime()

    expect(taskCompletionInfo({ completedAt, dueDate: null, dueTime: null })?.statusLabel).toBe('已完成')
    expect(taskCompletionInfo({ completedAt, dueDate: '2026-02-30', dueTime: '02:00' })?.overdueLabel).toBeNull()
    expect(taskCompletionInfo({ completedAt: null, dueDate: '2026-11-15', dueTime: '02:00' })).toBeNull()
  })
})

describe('taskOverdueLabel', () => {
  it('shows the elapsed time for an overdue timed task', () => {
    const task = { completedAt: null, dueDate: '2026-11-18', dueTime: '02:00' }

    expect(taskOverdueLabel(task, new Date(2026, 10, 18, 1, 59).getTime())).toBeNull()
    expect(taskOverdueLabel(task, new Date(2026, 10, 18, 2, 8).getTime())).toBe('已逾期8分钟')
    expect(taskOverdueLabel(task, new Date(2026, 10, 18, 10, 26).getTime())).toBe('已逾期8小时26分')
    expect(taskOverdueLabel(task, new Date(2026, 10, 22, 2).getTime())).toBe('已逾期4天')
  })

  it('treats a date-only deadline as valid through the due date and counts natural days after it', () => {
    const task = { completedAt: null, dueDate: '2026-11-15', dueTime: null }

    expect(taskOverdueLabel(task, new Date(2026, 10, 15, 23, 59).getTime())).toBeNull()
    expect(taskOverdueLabel(task, new Date(2026, 10, 16).getTime())).toBe('已逾期1天')
    expect(taskOverdueLabel(task, new Date(2026, 10, 19, 10).getTime())).toBe('已逾期4天')
  })

  it('does not show a live overdue label for completed, skipped, or undated tasks', () => {
    const task = { completedAt: null, dueDate: '2026-11-15', dueTime: null }
    const now = new Date(2026, 10, 19).getTime()

    expect(taskOverdueLabel({ ...task, completedAt: now }, now)).toBeNull()
    expect(taskOverdueLabel({ ...task, skipped: true }, now)).toBeNull()
    expect(taskOverdueLabel({ ...task, dueDate: null }, now)).toBeNull()
  })
})
