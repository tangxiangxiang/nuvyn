import { describe, expect, it } from 'vitest'
import type { DiaryEvent } from '../../../../shared/diaryLife'
import type { DiaryTaskListItem } from '../../../../shared/diaryTasks'
import { mostUrgentTaskDeadlineState, shouldShowEventDeadlineReminder, taskDeadlineVisualState } from '../deadlineVisualState'

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
