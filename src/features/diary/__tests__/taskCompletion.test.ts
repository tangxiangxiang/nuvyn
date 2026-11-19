import { describe, expect, it } from 'vitest'
import { taskCompletionInfo } from '../taskCompletion'

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
