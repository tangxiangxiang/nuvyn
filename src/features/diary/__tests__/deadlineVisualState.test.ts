import { describe, expect, it } from 'vitest'
import type { DiaryEvent } from '../../../../shared/diaryLife'
import type { DiaryTaskListItem } from '../../../../shared/diaryTasks'
import { mostUrgentTaskDeadlineState, shouldShowEventDeadlineReminder, taskDeadlineVisualState, todoDayVisualState } from '../deadlineVisualState'

type OneOffTask = Extract<DiaryTaskListItem, { kind?: 'one-off' }>

function makeTask(overrides: Partial<OneOffTask> = {}): OneOffTask {
  return {
    id: 'task-1',
    title: '任务',
    description: '',
    startDate: null,
    startTime: null,
    dueDate: '2026-11-21',
    dueTime: null,
    completedAt: null,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function makeEvent(overrides: Partial<DiaryEvent> = {}): DiaryEvent {
  return {
    id: 'event-1',
    title: '事项',
    description: '',
    emoji: '🎂',
    type: 'birthday',
    startDate: '2026-11-20',
    endDate: '2026-11-20',
    startTime: null,
    endTime: null,
    allDay: true,
    recurrence: 'none',
    showCountdown: true,
    isPrimary: false,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('Diary deadline visual state', () => {
  const today = '2026-11-18'

  it('classifies dates without considering start date, start time, or due time', () => {
    expect(taskDeadlineVisualState(makeTask({ dueDate: '2026-11-18', dueTime: '00:01' }), today)).toBe('due-soon')
    expect(taskDeadlineVisualState(makeTask({ dueDate: '2026-11-19' }), today)).toBe('due-soon')
    expect(taskDeadlineVisualState(makeTask({ dueDate: '2026-11-20', startDate: '2026-11-18', startTime: '09:00' }), today)).toBe('normal')
    expect(taskDeadlineVisualState(makeTask({ dueDate: '2026-11-17' }), today)).toBe('overdue')
  })

  it('marks completed, skipped and undated occurrences inactive', () => {
    expect(taskDeadlineVisualState(makeTask({ completedAt: 10 }), today)).toBe('inactive')
    const recurring = { ...makeTask({ dueDate: '2026-11-17' }), kind: 'recurring' as const, skipped: true }
    expect(taskDeadlineVisualState(recurring, today)).toBe('inactive')
    expect(taskDeadlineVisualState(makeTask({ dueDate: null }), today)).toBe('inactive')
  })

  it('prioritizes overdue, then due soon, then normal and ignores inactive tasks', () => {
    expect(mostUrgentTaskDeadlineState([
      makeTask({ dueDate: '2026-11-19' }),
      makeTask({ id: 'past', dueDate: '2026-11-17' }),
      makeTask({ id: 'done', dueDate: '2026-11-18', completedAt: 1 }),
    ], today)).toBe('overdue')
    expect(mostUrgentTaskDeadlineState([makeTask({ dueDate: '2026-11-19' }), makeTask({ dueDate: '2026-11-21' })], today)).toBe('due-soon')
    expect(mostUrgentTaskDeadlineState([makeTask({ dueDate: '2026-11-21' })], today)).toBe('normal')
    expect(mostUrgentTaskDeadlineState([makeTask({ completedAt: 1 })], today)).toBe('inactive')
  })

  it('derives a completed marker only when every occurrence is completed', () => {
    expect(todoDayVisualState([], today)).toBe('none')
    expect(todoDayVisualState([makeTask({ completedAt: 10 })], today)).toBe('completed')
    expect(todoDayVisualState([
      makeTask({ completedAt: 10 }),
      makeTask({ id: 'task-2', completedAt: 11 }),
    ], today)).toBe('completed')
    expect(todoDayVisualState([
      makeTask({ completedAt: 10 }),
      makeTask({ id: 'task-2', dueDate: '2026-11-21' }),
    ], today)).toBe('pending')
    expect(todoDayVisualState([
      makeTask({ completedAt: 10 }),
      { ...makeTask({ id: 'series:2026-11-17', dueDate: '2026-11-17' }), skipped: true },
    ], today)).toBe('none')
    expect(todoDayVisualState([
      { ...makeTask({ id: 'series:2026-11-17', dueDate: '2026-11-17' }), skipped: true },
    ], today)).toBe('none')
  })

  it('uses the precise due time and date-only end of day for completion markers', () => {
    const dueDate = '2026-11-17'
    const exactDueTime = new Date(2026, 10, 17, 2, 0).getTime()
    const lateSameDay = new Date(2026, 10, 17, 3, 26).getTime()
    const beforeDateDeadline = new Date(2026, 10, 17, 23, 59).getTime()
    const lateAt = new Date(2026, 10, 18, 0, 0).getTime()
    expect(todoDayVisualState([makeTask({ dueDate, dueTime: '02:00', completedAt: exactDueTime })], today)).toBe('completed')
    expect(todoDayVisualState([makeTask({ dueDate, dueTime: '02:00', completedAt: lateSameDay })], today)).toBe('completed-late')
    expect(todoDayVisualState([makeTask({ dueDate, dueTime: '03:26', completedAt: lateSameDay })], today)).toBe('completed')
    expect(todoDayVisualState([makeTask({ dueDate, completedAt: beforeDateDeadline })], today)).toBe('completed')
    expect(todoDayVisualState([makeTask({ dueDate, completedAt: lateAt })], today)).toBe('completed-late')
    expect(todoDayVisualState([makeTask({ dueDate: '2026-11-18', completedAt: lateAt })], today)).toBe('completed')
    expect(todoDayVisualState([
      makeTask({ dueDate, dueTime: '02:00', completedAt: exactDueTime }),
      makeTask({ id: 'late', dueDate, completedAt: lateAt }),
    ], today)).toBe('completed-late')
    const lateOccurrence = { ...makeTask({ id: 'series:2026-11-17', dueDate, completedAt: lateAt }), kind: 'recurring' as const }
    const onTimeOccurrence = { ...makeTask({ id: 'series:2026-11-18', dueDate: '2026-11-18', completedAt: lateAt }), kind: 'recurring' as const }
    expect(todoDayVisualState([lateOccurrence], today)).toBe('completed-late')
    expect(todoDayVisualState([onTimeOccurrence], today)).toBe('completed')
    expect(todoDayVisualState([
      makeTask({ dueDate, completedAt: lateAt }),
      makeTask({ id: 'pending', dueDate, completedAt: null }),
    ], today)).toBe('overdue')
  })

  it('prioritizes overdue and due-soon pending tasks over completion', () => {
    expect(todoDayVisualState([
      makeTask({ completedAt: 10 }),
      makeTask({ id: 'overdue', dueDate: '2026-11-17' }),
      makeTask({ id: 'soon', dueDate: '2026-11-19' }),
    ], today)).toBe('overdue')
    expect(todoDayVisualState([
      makeTask({ completedAt: 10 }),
      makeTask({ id: 'soon', dueDate: '2026-11-19' }),
      makeTask({ id: 'ordinary', dueDate: '2026-11-21' }),
    ], today)).toBe('due-soon')
    expect(todoDayVisualState([
      makeTask({ id: 'reopened', completedAt: null, dueDate: '2026-11-21' }),
    ], today)).toBe('pending')
    expect(todoDayVisualState([
      makeTask({ id: 'late-complete', completedAt: 10, dueDate: '2026-11-17' }),
    ], today)).toBe('completed')
  })

  it('reminds for events today, tomorrow, active multi-day events and lunar birthdays', () => {
    expect(shouldShowEventDeadlineReminder(makeEvent(), today)).toBe(false)
    expect(shouldShowEventDeadlineReminder(makeEvent({ startDate: today, endDate: today }), today)).toBe(true)
    expect(shouldShowEventDeadlineReminder(makeEvent({ startDate: '2026-11-19', endDate: '2026-11-19' }), today)).toBe(true)
    expect(shouldShowEventDeadlineReminder(makeEvent({ startDate: '2026-11-16', endDate: '2026-11-20' }), today)).toBe(true)
    const lunarBirthday = makeEvent({
      startDate: '2026-07-03',
      endDate: '2026-07-03',
      recurrence: 'yearly',
      dateRule: { calendar: 'chinese', lunarMonth: 5, lunarDay: 19, isLeapMonth: false, leapMonthPolicy: 'regular-month', shortMonthPolicy: 'last-day' },
    })
    expect(shouldShowEventDeadlineReminder(lunarBirthday, '2027-06-22')).toBe(true)
  })
})
