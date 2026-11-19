// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { DiaryTaskListItem } from '../../../../shared/diaryTasks'
import DiaryTaskRows from '../DiaryTaskRows.vue'

type OneOffTask = Extract<DiaryTaskListItem, { kind?: 'one-off' }>
const now = new Date(2026, 10, 18, 12).getTime()

function makeTask(overrides: Partial<OneOffTask> = {}): OneOffTask {
  return {
    id: 'task-1',
    title: 'OEE报表开发',
    description: '',
    startDate: null,
    startTime: null,
    dueDate: '2026-11-18',
    dueTime: null,
    completedAt: null,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('DiaryTaskRows', () => {
  it('places the task detail beside the title in a cloud card', () => {
    const task = makeTask({ dueTime: '12:00' })
    const wrapper = mount(DiaryTaskRows, { props: { items: [task], today: '2026-11-18', now, showDueDate: false } })

    expect(wrapper.get('.diary-task-row').classes()).toContain('diary-cloud-card')
    expect(wrapper.get('.diary-task-edit').element.children[0]?.className).toBe('diary-task-copy')
    expect(wrapper.get('.diary-task-detail').text()).toBe('截止 12:00')
    expect(wrapper.get('.diary-task-edit').element.children[1]?.className).toBe('diary-task-trailing')
    expect(wrapper.get('.diary-task-trailing').find('.diary-task-detail').exists()).toBe(true)
    wrapper.unmount()
  })

  it('does not render a placeholder when a task has no time detail', () => {
    const wrapper = mount(DiaryTaskRows, { props: { items: [makeTask()], today: '2026-11-18', now, showDueDate: false } })

    expect(wrapper.find('.diary-task-detail').exists()).toBe(false)
    expect(wrapper.get('.diary-task-title').text()).toBe('OEE报表开发')
    wrapper.unmount()
  })

  it('shows completed status instead of the deadline and restores the deadline when reopened', async () => {
    const completed = makeTask({ dueTime: '12:00', completedAt: new Date(2026, 10, 18, 12).getTime() })
    const wrapper = mount(DiaryTaskRows, { props: { items: [completed], today: '2026-11-18', now, showDueDate: false } })

    expect(wrapper.get('.diary-task-row').classes()).toContain('is-completed')
    expect(wrapper.get('.diary-task-detail').text()).toBe('已完成')
    expect(wrapper.get('.diary-task-edit').attributes('aria-label')).toBe(`编辑待办：${completed.title}`)

    await wrapper.get('.diary-task-toggle').trigger('click')
    expect(wrapper.emitted('toggle')?.[0]?.[0]).toEqual(completed)
    await wrapper.setProps({ items: [{ ...completed, completedAt: null }] })
    expect(wrapper.get('.diary-task-detail').text()).toBe('截止 12:00')
    wrapper.unmount()
  })

  it('shows deadline Alarm Clock only in reminder lists for open urgent tasks', () => {
    const urgent = makeTask({ dueDate: '2026-11-18' })
    const future = makeTask({ id: 'future', dueDate: '2026-11-21' })
    const overdue = makeTask({ id: 'overdue', dueDate: '2026-11-17' })
    const completed = makeTask({ id: 'completed', dueDate: '2026-11-18', completedAt: 1 })
    const wrapper = mount(DiaryTaskRows, {
      props: { items: [urgent, future, overdue, completed], today: '2026-11-18', now, showDeadlineReminder: true },
    })

    const rows = wrapper.findAll('.diary-task-row')
    expect(rows[0]!.find('.diary-task-deadline-reminder').attributes('src')).toBe('/emoji/alarm-clock-animated.png')
    expect(rows[1]!.find('.diary-task-deadline-reminder').exists()).toBe(false)
    expect(rows[2]!.find('.diary-task-deadline-reminder').attributes('src')).toBe('/emoji/alarm-clock.svg')
    expect(rows[3]!.find('.diary-task-deadline-reminder').exists()).toBe(false)
    expect(rows[3]!.find('.diary-task-detail').text()).toBe('已完成')
    wrapper.unmount()
  })

  it('labels a task completed after its deadline as overdue completion', () => {
    const completed = makeTask({ dueDate: '2026-11-18', dueTime: '12:00', completedAt: new Date(2026, 10, 18, 13, 26).getTime() })
    const wrapper = mount(DiaryTaskRows, { props: { items: [completed], today: '2026-11-18', now, showDueDate: false } })

    expect(wrapper.get('.diary-task-detail').text()).toBe('逾期完成')
    wrapper.unmount()
  })

  it('updates overdue status and warning styling when the current time changes', async () => {
    const task = makeTask({ dueTime: '02:00' })
    const wrapper = mount(DiaryTaskRows, {
      props: { items: [task], today: '2026-11-18', now: new Date(2026, 10, 18, 1, 59).getTime(), showDueDate: false },
    })

    expect(wrapper.get('.diary-task-detail').text()).toBe('截止 02:00')
    expect(wrapper.get('.diary-task-row').classes()).not.toContain('is-overdue')

    await wrapper.setProps({ now: new Date(2026, 10, 18, 2, 8).getTime() })
    expect(wrapper.get('.diary-task-detail').text()).toBe('已逾期8分钟')
    expect(wrapper.get('.diary-task-row').classes()).toContain('is-overdue')

    await wrapper.setProps({ now: new Date(2026, 10, 18, 10, 26).getTime() })
    expect(wrapper.get('.diary-task-detail').text()).toBe('已逾期8小时26分')
  })

  it('keeps task completion and title editing on separate controls', async () => {
    const task = makeTask()
    const wrapper = mount(DiaryTaskRows, { props: { items: [task], today: '2026-11-18', now } })

    await wrapper.get('.diary-task-toggle').trigger('click')
    expect(wrapper.emitted('toggle')?.[0]?.[0]).toEqual(task)
    expect(wrapper.emitted('edit')).toBeUndefined()

    await wrapper.get('.diary-task-edit').trigger('click')
    expect(wrapper.emitted('edit')?.[0]?.[0]).toEqual(task)
    wrapper.unmount()
  })

  it('shows skipped status without labeling the task overdue', () => {
    const task = {
      kind: 'recurring' as const,
      id: 'series:2026-11-14',
      seriesId: 'series',
      occurrenceDate: '2026-11-14',
      effectiveFrom: '2026-11-14',
      recurrence: { frequency: 'daily' as const, startDate: '2026-11-14', untilDate: null },
      seriesVersion: 1,
      occurrenceVersion: 1,
      title: '跳过的待办',
      description: '',
      dueDate: '2026-11-14',
      dueTime: null,
      completedAt: null,
      skipped: true,
      version: 1,
      createdAt: 1,
      updatedAt: 1,
    }
    const wrapper = mount(DiaryTaskRows, { props: { items: [task], today: '2026-11-18', now } })

    expect(wrapper.get('.diary-task-row').classes()).toContain('is-skipped')
    expect(wrapper.get('.diary-task-row').classes()).toContain('diary-cloud-card')
    expect(wrapper.text()).toContain('本次已跳过')
    expect(wrapper.text()).not.toContain('已完成')
    expect(wrapper.text()).not.toContain('已逾期')
    wrapper.unmount()
  })

  it('retains repeat and completed presentation in embedded rows without nested cards', () => {
    const task: DiaryTaskListItem = {
      kind: 'recurring',
      id: 'series:2026-11-14',
      seriesId: 'series',
      occurrenceDate: '2026-11-14',
      effectiveFrom: '2026-11-14',
      recurrence: { frequency: 'daily' as const, startDate: '2026-11-14', untilDate: null },
      seriesVersion: 1,
      occurrenceVersion: 1,
      title: 'OEE报表开发',
      description: '',
      dueDate: '2026-11-18',
      dueTime: null,
      completedAt: 100,
      skipped: false,
      version: 1,
      createdAt: 1,
      updatedAt: 1,
    }
    const wrapper = mount(DiaryTaskRows, { props: { items: [task], today: '2026-11-18', now, editable: false, variant: 'plain' } })

    expect(wrapper.get('.diary-task-rows').classes()).toContain('diary-task-rows--plain')
    expect(wrapper.get('.diary-task-row').classes()).toContain('is-completed')
    expect(wrapper.find('.diary-cloud-card').exists()).toBe(false)
    expect(wrapper.get('.diary-task-repeat').text()).toBe('↻')
    expect(wrapper.get('.diary-task-title').element.closest('.diary-task-edit')?.tagName).toBe('DIV')
    wrapper.unmount()
  })
})
