import { describe, expect, it } from 'vitest'
import { isTaskOverdue, MAX_DIARY_TASK_DESCRIPTION_LENGTH, MAX_DIARY_TASK_TITLE_LENGTH, parseTaskFields, parseWritableTaskFields, taskTimeFieldsError } from '../diaryTasks.js'

describe('Diary task fields', () => {
  it('normalizes the title and supplies optional defaults while preserving description line breaks', () => {
    expect(parseTaskFields({ title: '  Call grandpa  ', description: 'first line\nsecond line' })).toEqual({
      title: 'Call grandpa',
      description: 'first line\nsecond line',
      startDate: null,
      startTime: null,
      dueDate: null,
      dueTime: null,
    })
  })

  it('validates title and description limits', () => {
    expect(parseTaskFields({ title: ' \n ' })).toBeNull()
    expect(parseTaskFields({ title: ` ${'x'.repeat(MAX_DIARY_TASK_TITLE_LENGTH)} ` })).toMatchObject({ title: 'x'.repeat(MAX_DIARY_TASK_TITLE_LENGTH) })
    expect(parseTaskFields({ title: 'x'.repeat(MAX_DIARY_TASK_TITLE_LENGTH + 1) })).toBeNull()
    expect(parseTaskFields({ title: 'valid', description: 'd'.repeat(MAX_DIARY_TASK_DESCRIPTION_LENGTH) })).not.toBeNull()
    expect(parseTaskFields({ title: 'valid', description: 'd'.repeat(MAX_DIARY_TASK_DESCRIPTION_LENGTH + 1) })).toBeNull()
  })

  it('accepts nullable and valid due dates and times, and rejects invalid combinations', () => {
    expect(parseTaskFields({ title: 'Undated', dueDate: null, dueTime: null })).not.toBeNull()
    expect(parseTaskFields({ title: 'Date only', dueDate: '2024-02-29', dueTime: null })).not.toBeNull()
    expect(parseTaskFields({ title: 'Timed', dueDate: '2026-11-17', dueTime: '09:05' })).not.toBeNull()
    expect(parseTaskFields({ title: 'Bad date', dueDate: '2026-02-29' })).toBeNull()
    expect(parseTaskFields({ title: 'Bad start date', startDate: '2026-02-29' })).toBeNull()
    expect(parseTaskFields({ title: 'Bad time', dueDate: '2026-11-17', dueTime: '24:00' })).toBeNull()
    expect(parseTaskFields({ title: 'Bad start time', startDate: '2026-11-17', startTime: '9:30' })).toBeNull()
    expect(parseTaskFields({ title: 'Time without date', dueTime: '09:05' })).toBeNull()
  })

  it('normalizes legacy tasks and accepts independent start and due dates', () => {
    expect(parseTaskFields({ title: 'Legacy task', dueDate: null, dueTime: null })).toMatchObject({
      startDate: null,
      startTime: null,
      dueDate: null,
      dueTime: null,
    })
    expect(parseTaskFields({ title: 'Start only', startDate: '2026-11-19' })).toMatchObject({
      startDate: '2026-11-19', startTime: null, dueDate: null, dueTime: null,
    })
    expect(parseTaskFields({ title: 'Due only', dueDate: '2026-11-21', dueTime: '12:00' })).toMatchObject({
      startDate: null, startTime: null, dueDate: '2026-11-21', dueTime: '12:00',
    })
    expect(parseTaskFields({ title: 'Same day', startDate: '2026-11-19', startTime: '09:00', dueDate: '2026-11-19', dueTime: '12:00' })).not.toBeNull()
    expect(parseTaskFields({ title: 'Across days', startDate: '2026-11-19', startTime: '09:00', dueDate: '2026-11-21', dueTime: '12:00' })).not.toBeNull()
    expect(parseTaskFields({ title: 'Start after due', startDate: '2026-11-21', dueDate: '2026-11-19' })).toBeNull()
    expect(parseTaskFields({ title: 'Time order', startDate: '2026-11-19', startTime: '15:00', dueDate: '2026-11-19', dueTime: '12:00' })).toBeNull()
    expect(parseTaskFields({ title: 'Start time without date', startTime: '09:00' })).toBeNull()
    expect(parseTaskFields({ title: 'Due time without date', dueTime: '12:00' })).toBeNull()
  })

  it('keeps legacy reads nullable but requires a valid due date for one-off writes', () => {
    expect(parseTaskFields({ title: 'Legacy task', dueDate: null })).toMatchObject({ dueDate: null })
    expect(parseWritableTaskFields({ title: 'Legacy task', dueDate: null })).toBeNull()
    expect(parseWritableTaskFields({ title: 'Missing task date' })).toBeNull()
    expect(taskTimeFieldsError({ title: 'Missing task date', dueDate: null }, true)).toBe('missing-due-date')
    expect(parseWritableTaskFields({ title: 'Dated task', dueDate: '2026-11-20' })).toMatchObject({ dueDate: '2026-11-20' })
    expect(parseWritableTaskFields({ title: 'Start after due', startDate: '2026-11-21', dueDate: '2026-11-20' })).toBeNull()
  })
})

describe('Diary task overdue calculation', () => {
  const task = { id: 'task', title: 'Task', description: '', dueTime: null, version: 1, createdAt: 1, updatedAt: 1, completedAt: null }

  it('uses the due date and completion timestamp only', () => {
    expect(isTaskOverdue({ ...task, dueDate: '2026-11-15' }, '2026-11-16')).toBe(true)
    expect(isTaskOverdue({ ...task, dueDate: '2026-11-16' }, '2026-11-16')).toBe(false)
    const timedTask = { ...task, dueDate: '2026-11-17', dueTime: '00:01' }
    expect(isTaskOverdue(timedTask, '2026-11-17')).toBe(false)
    expect(isTaskOverdue({ ...task, dueDate: '2026-11-15', completedAt: 1 }, '2026-11-16')).toBe(false)
    expect(isTaskOverdue({ ...task, dueDate: null }, '2026-11-16')).toBe(false)
  })

  it('does not mark skipped occurrences overdue and recalculates after reopening', () => {
    const yesterday = { ...task, dueDate: '2026-11-15' }
    expect(isTaskOverdue(yesterday, '2026-11-16')).toBe(true)
    expect(isTaskOverdue({ ...yesterday, skipped: true }, '2026-11-16')).toBe(false)
    expect(isTaskOverdue({ ...yesterday, skipped: false }, '2026-11-16')).toBe(true)
    expect(isTaskOverdue({ ...task, dueDate: '2026-11-16' }, '2026-11-16')).toBe(false)
    expect(isTaskOverdue({ ...task, dueDate: '2026-11-17' }, '2026-11-16')).toBe(false)
    expect(isTaskOverdue({ ...task, dueDate: null }, '2026-11-16')).toBe(false)
  })
})
