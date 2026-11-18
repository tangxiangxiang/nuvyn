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

  it('starts a recurrence on the selected due date and removes an Event link', async () => {
    const initial: TaskEditorFields = {
      title: '每周整理笔记',
      description: '',
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

  it('allows a new recurring task start date to be selected', async () => {
    const initial: TaskEditorFields = {
      title: '每周整理笔记', description: '', dueDate: null, dueTime: null, recurrence: null, eventId: null,
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
      title: '每周整理笔记', description: '', dueDate: '2026-11-16', dueTime: null,
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
      title: '预约体检', description: '', dueDate: null, dueTime: null, recurrence: null, eventId: null,
    }
    const wrapper = mount(DiaryTaskForm, { props: { modelValue: initial, today: '2026-11-16', allowRecurrence: false } })
    expect(wrapper.find('[aria-label="重复规则"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('opens the schedule selector only after the user chooses to link a task', async () => {
    const initial: TaskEditorFields = {
      title: '准备证件', description: '', dueDate: '2026-11-20', dueTime: null, recurrence: null, eventId: null,
    }
    const wrapper = mount(DiaryTaskForm, { props: { modelValue: initial, today: '2026-11-16' } })
    expect(wrapper.find('.n-select').exists()).toBe(false)
    await wrapper.get('button.diary-task-link-trigger').trigger('click')
    expect(wrapper.find('.n-select').exists()).toBe(true)
    expect(wrapper.emitted('event-picker-open')).toHaveLength(1)
    wrapper.unmount()
  })
})
