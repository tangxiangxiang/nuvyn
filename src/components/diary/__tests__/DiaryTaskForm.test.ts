// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { NDatePicker, NInput, NSelect, NTimePicker } from 'naive-ui'
import DiaryTaskForm from '../DiaryTaskForm.vue'
import type { DiaryEvent } from '../../../../shared/diaryLife'
import type { TaskEditorFields } from '../../../../shared/diaryTasks'

function getControl(wrapper: ReturnType<typeof mount>, component: typeof NDatePicker | typeof NSelect | typeof NTimePicker, label: string) {
  return wrapper.findAllComponents(component).find(control => control.attributes('aria-label') === label)!
}

function getProp(control: ReturnType<typeof getControl>, name: string) {
  return (control.props() as Record<string, unknown>)[name]
}

describe('DiaryTaskForm', () => {
  it('marks the task title and recurring end date as required', () => {
    const initial: TaskEditorFields = {
      title: '', description: '', startDate: null, startTime: null, dueDate: null, dueTime: null,
      recurrence: { frequency: 'daily', startDate: '2026-11-16', untilDate: null }, eventId: null,
    }
    const wrapper = mount(DiaryTaskForm, { props: { modelValue: initial, today: '2026-11-16' } })

    expect(wrapper.find('.diary-task-form-title').text()).toContain('待办名称*')
    expect(wrapper.findAll('.diary-task-required')).toHaveLength(2)
    expect(wrapper.findComponent(NInput).props('inputProps')).toMatchObject({
      'aria-label': '待办名称',
      required: true,
    })
    wrapper.unmount()
  })

  it('uses Naive pickers and clears a time without clearing its date', async () => {
    const initial: TaskEditorFields = {
      title: '预约体检', description: '', startDate: '2026-11-18', startTime: '09:30',
      dueDate: '2026-11-20', dueTime: '10:30', recurrence: null, eventId: null,
    }
    const wrapper = mount(DiaryTaskForm, { props: { modelValue: initial, today: '2026-11-16' } })
    const startDate = getControl(wrapper, NDatePicker, '开始日期')
    const startTime = getControl(wrapper, NTimePicker, '开始时间')

    expect(getProp(startDate, 'valueFormat')).toBe('yyyy-MM-dd')
    expect(getProp(startDate, 'formattedValue')).toBe('2026-11-18')
    expect(getProp(startTime, 'valueFormat')).toBe('HH:mm')
    expect(getProp(startTime, 'formattedValue')).toBe('09:30')
    expect(startTime.props('clearable')).toBe(true)

    await startDate.vm.$emit('update:formatted-value', '2026-11-19', 0)
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({ startDate: '2026-11-19' })
    await startTime.vm.$emit('update:formatted-value', null, null)
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({ startDate: '2026-11-18', startTime: null })
    await getControl(wrapper, NTimePicker, '截止时间').vm.$emit('update:formatted-value', null, null)
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({ dueDate: '2026-11-20', dueTime: null })
    wrapper.unmount()
  })

  it('clears the due date and due time using the native date picker action', async () => {
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

    const dueDate = getControl(wrapper, NDatePicker, '截止日期')
    expect(dueDate.props('clearable')).toBe(true)
    await dueDate.vm.$emit('update:formatted-value', null, null)
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({
      dueDate: null,
      dueTime: null,
    })
    wrapper.unmount()
  })

  it('clears optional start dates with their time while keeping start and due pairs independent', async () => {
    const initial: TaskEditorFields = {
      title: '准备发布', description: '', startDate: null, startTime: null,
      dueDate: '2026-11-21', dueTime: '12:00', recurrence: null, eventId: null,
    }
    const wrapper = mount(DiaryTaskForm, { props: { modelValue: initial, today: '2026-11-16' } })

    await getControl(wrapper, NDatePicker, '开始日期').vm.$emit('update:formatted-value', '2026-11-19')
    const startDateDraft = wrapper.emitted('update:modelValue')?.at(-1)?.[0] as TaskEditorFields
    expect(startDateDraft).toMatchObject({ startDate: '2026-11-19', startTime: null, dueDate: '2026-11-21', dueTime: '12:00' })
    const startDatePicker = getControl(wrapper, NDatePicker, '开始日期')
    expect(startDatePicker.props('clearable')).toBe(true)
    await wrapper.setProps({ modelValue: { ...startDateDraft, startTime: '09:00' } })
    await startDatePicker.vm.$emit('update:formatted-value', null, null)
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({
      startDate: null, startTime: null, dueDate: '2026-11-21', dueTime: '12:00',
    })
    expect(wrapper.find('button.diary-task-clear-date').exists()).toBe(false)
    wrapper.unmount()
  })

  it('selects a concrete occurrence for yearly Events and prefers the task due date when it matches', async () => {
    const event: DiaryEvent = {
      id: 'a2a41f64-17ae-4b68-9c98-bb45fc4ad8c7',
      title: '相识纪念日', description: '', emoji: '🎉', type: 'anniversary',
      startDate: '2020-11-15', endDate: '2020-11-15', startTime: null, endTime: null,
      allDay: true, dateRule: { calendar: 'gregory' }, recurrence: 'yearly',
      showCountdown: false, isPrimary: false, version: 1, createdAt: 1, updatedAt: 1,
    }
    const initial: TaskEditorFields = {
      title: '准备礼物', description: '', startDate: null, startTime: null,
      dueDate: '2026-11-15', dueTime: null, recurrence: null, eventId: null, eventOccurrenceDate: null,
    }
    const wrapper = mount(DiaryTaskForm, {
      props: {
        modelValue: initial,
        today: '2026-11-18',
        eventOptions: [{ value: event.id, label: '相识纪念日 · 每年', event }],
      },
    })

    const selector = getControl(wrapper, NSelect, '关联日程')
    await selector.vm.$emit('update:value', event.id)
    const selectedDraft = wrapper.emitted('update:modelValue')?.at(-1)?.[0] as TaskEditorFields
    expect(selectedDraft).toMatchObject({ eventId: event.id, eventOccurrenceDate: '2026-11-15', dueDate: '2026-11-15' })
    await wrapper.setProps({ modelValue: selectedDraft })

    const occurrencePicker = getControl(wrapper, NDatePicker, '关联日程发生日期')
    expect(getProp(occurrencePicker, 'formattedValue')).toBe('2026-11-15')
    const isDateDisabled = getProp(occurrencePicker, 'isDateDisabled') as (timestamp: number) => boolean
    expect(isDateDisabled(new Date(2026, 10, 15).getTime())).toBe(false)
    expect(isDateDisabled(new Date(2026, 10, 16).getTime())).toBe(true)

    await occurrencePicker.vm.$emit('update:formatted-value', '2027-11-15')
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({
      eventId: event.id, eventOccurrenceDate: '2027-11-15', dueDate: '2026-11-15',
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

    await getControl(wrapper, NSelect, '重复规则').vm.$emit('update:value', 'weekly')
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

    await getControl(wrapper, NSelect, '重复规则').vm.$emit('update:value', 'daily')
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
    await getControl(wrapper, NSelect, '重复规则').vm.$emit('update:value', 'daily')
    const recurringDraft = wrapper.emitted('update:modelValue')?.at(-1)?.[0] as TaskEditorFields
    expect(recurringDraft).toMatchObject({ recurrence: { frequency: 'daily', startDate: '2026-11-16' } })
    await wrapper.setProps({ modelValue: recurringDraft })
    await getControl(wrapper, NDatePicker, '开始日期').vm.$emit('update:formatted-value', '2026-11-18')
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({
      recurrence: { startDate: '2026-11-18' },
    })
    wrapper.unmount()
  })

  it('keeps an existing recurring start date required and locked', async () => {
    const initial: TaskEditorFields = {
      title: '每周整理笔记', description: '', startDate: null, startTime: null, dueDate: '2026-11-16', dueTime: null,
      recurrence: { frequency: 'daily', startDate: '2026-11-16', untilDate: null }, eventId: null,
    }
    const wrapper = mount(DiaryTaskForm, {
      props: { modelValue: initial, today: '2026-11-16', lockRecurrenceStart: true },
    })

    expect(getControl(wrapper, NDatePicker, '开始日期').props('disabled')).toBe(true)
    expect(getControl(wrapper, NDatePicker, '开始日期').props('clearable')).not.toBe(true)
    expect(wrapper.find('button.diary-task-clear-date').exists()).toBe(false)
    expect(getProp(getControl(wrapper, NSelect, '重复规则'), 'options')).not.toContainEqual(expect.objectContaining({ value: '' }))
    await getControl(wrapper, NSelect, '重复规则').vm.$emit('update:value', 'weekly')
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

  it('shows the schedule selector by default and loads options when opened', async () => {
    const initial: TaskEditorFields = {
      title: '准备证件', description: '', startDate: null, startTime: null, dueDate: '2026-11-20', dueTime: null, recurrence: null, eventId: null,
    }
    const wrapper = mount(DiaryTaskForm, { props: { modelValue: initial, today: '2026-11-16' } })
    const selector = getControl(wrapper, NSelect, '关联日程')

    expect(wrapper.find('.diary-task-event-select').exists()).toBe(true)
    expect(selector.props('placeholder')).toBe('不关联日程')
    expect(selector.props('bordered')).toBe(true)
    expect(selector.props('clearable')).toBe(true)
    await selector.vm.$emit('update:show', true)
    expect(wrapper.emitted('event-picker-open')).toHaveLength(1)
    wrapper.unmount()
  })
})
