// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import DiaryTaskForm from '../DiaryTaskForm.vue'
import type { TaskEditorFields } from '../../../../shared/diaryTasks'

describe('DiaryTaskForm', () => {
  it('clears the due time together with a cleared due date', async () => {
    const initial: TaskEditorFields = {
      title: '预约体检',
      description: '',
      startDate: null,
      startTime: null,
      dueDate: '2026-11-18',
      dueTime: '09:30',
      recurrence: null,
      eventId: null,
    }
    const wrapper = mount(DiaryTaskForm, { props: { modelValue: initial, today: '2026-11-16' } })

    await wrapper.get('button.diary-task-clear-date').trigger('click')
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({
      dueDate: null,
      dueTime: null,
    })
    wrapper.unmount()
  })

  it('keeps optional start and due date-time pairs independent and clears matching times', async () => {
    const initial: TaskEditorFields = {
      title: '准备发布', description: '', startDate: null, startTime: null,
      dueDate: '2026-11-21', dueTime: '12:00', recurrence: null, eventId: null,
    }
    const wrapper = mount(DiaryTaskForm, { props: { modelValue: initial, today: '2026-11-16' } })

    await wrapper.get('input[aria-label="开始日期"]').setValue('2026-11-19')
    const startDateDraft = wrapper.emitted('update:modelValue')?.at(-1)?.[0] as TaskEditorFields
    expect(startDateDraft).toMatchObject({ startDate: '2026-11-19', startTime: null, dueDate: '2026-11-21', dueTime: '12:00' })
    await wrapper.setProps({ modelValue: { ...startDateDraft, startTime: '09:00' } })
    const clearStartButton = wrapper.findAll('button.diary-task-clear-date').find(button => button.text() === '清除开始时间')!
    await clearStartButton.trigger('click')
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({
      startDate: null, startTime: null, dueDate: '2026-11-21', dueTime: '12:00',
    })
    wrapper.unmount()
  })

  it('shows a concise error for invalid same-day start and due times', () => {
    const initial: TaskEditorFields = {
      title: '准备发布', description: '', startDate: '2026-11-19', startTime: '15:00',
      dueDate: '2026-11-19', dueTime: '12:00', recurrence: null, eventId: null,
    }
    const wrapper = mount(DiaryTaskForm, { props: { modelValue: initial, today: '2026-11-16' } })

    expect(wrapper.get('[role="alert"]').text()).toBe('同一天的开始时间不能晚于截止时间。')
    wrapper.unmount()
  })

  it('starts a recurrence on the selected due date and removes an Event link', async () => {
    const initial: TaskEditorFields = {
      title: '每周整理笔记',
      description: '',
      startDate: null,
      startTime: null,
      dueDate: '2026-11-18',
      dueTime: null,
      recurrence: null,
      eventId: 'a2a41f64-17ae-4b68-9c98-bb45fc4ad8c7',
    }
    const wrapper = mount(DiaryTaskForm, { props: { modelValue: initial, today: '2026-11-16' } })

    await wrapper.get('select[aria-label="重复规则"]').setValue('weekly')
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({
      dueDate: '2026-11-18',
      recurrence: { frequency: 'weekly', startDate: '2026-11-18', untilDate: null },
      eventId: null,
    })
    wrapper.unmount()
  })

  it('prefers an explicitly selected start date when switching to a recurrence', async () => {
    const initial: TaskEditorFields = {
      title: '从开始日重复',
      description: '',
      startDate: '2026-11-18',
      startTime: '09:00',
      dueDate: '2026-11-16',
      dueTime: null,
      recurrence: null,
      eventId: null,
    }
    const wrapper = mount(DiaryTaskForm, { props: { modelValue: initial, today: '2026-11-16' } })

    await wrapper.get('select[aria-label="重复规则"]').setValue('daily')
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({
      startDate: '2026-11-18',
      startTime: '09:00',
      dueDate: '2026-11-18',
      recurrence: { frequency: 'daily', startDate: '2026-11-18', untilDate: null },
    })
    wrapper.unmount()
  })

  it('allows a new recurring task start date to be selected', async () => {
    const initial: TaskEditorFields = {
      title: '每周整理笔记', description: '', startDate: null, startTime: null, dueDate: null, dueTime: null, recurrence: null, eventId: null,
    }
    const wrapper = mount(DiaryTaskForm, { props: { modelValue: initial, today: '2026-11-16' } })
    await wrapper.get('select[aria-label="重复规则"]').setValue('daily')
    const recurringDraft = wrapper.emitted('update:modelValue')?.at(-1)?.[0] as TaskEditorFields
    expect(recurringDraft).toMatchObject({ recurrence: { frequency: 'daily', startDate: '2026-11-16' } })
    await wrapper.setProps({ modelValue: recurringDraft })
    await wrapper.get('input[aria-label="开始日期"]').setValue('2026-11-18')
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({
      recurrence: { startDate: '2026-11-18' },
    })
    wrapper.unmount()
  })

  it('keeps an existing recurring start date locked and hides its clear action', async () => {
    const initial: TaskEditorFields = {
      title: '每周整理笔记', description: '', startDate: null, startTime: null, dueDate: '2026-11-16', dueTime: null,
      recurrence: { frequency: 'daily', startDate: '2026-11-16', untilDate: null }, eventId: null,
    }
    const wrapper = mount(DiaryTaskForm, {
      props: { modelValue: initial, today: '2026-11-16', lockRecurrenceStart: true },
    })

    expect(wrapper.get('input[aria-label="开始日期"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('button.diary-task-clear-date').exists()).toBe(false)
    expect(wrapper.get('select[aria-label="重复规则"]').find('option[value=""]').exists()).toBe(false)
    await wrapper.get('select[aria-label="重复规则"]').setValue('weekly')
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({
      recurrence: { frequency: 'weekly', startDate: '2026-11-16' },
    })
    wrapper.unmount()
  })

  it('can hide recurrence for an existing one-off task', () => {
    const initial: TaskEditorFields = {
      title: '预约体检', description: '', startDate: null, startTime: null, dueDate: null, dueTime: null, recurrence: null, eventId: null,
    }
    const wrapper = mount(DiaryTaskForm, { props: { modelValue: initial, today: '2026-11-16', allowRecurrence: false } })
    expect(wrapper.find('[aria-label="重复规则"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('opens the schedule selector only after the user chooses to link a task', async () => {
    const initial: TaskEditorFields = {
      title: '准备证件', description: '', startDate: null, startTime: null, dueDate: '2026-11-20', dueTime: null, recurrence: null, eventId: null,
    }
    const wrapper = mount(DiaryTaskForm, { props: { modelValue: initial, today: '2026-11-16' } })
    expect(wrapper.find('.n-select').exists()).toBe(false)
    await wrapper.get('button.diary-task-link-trigger').trigger('click')
    expect(wrapper.find('.n-select').exists()).toBe(true)
    expect(wrapper.emitted('event-picker-open')).toHaveLength(1)
    wrapper.unmount()
  })
})
