// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { NDatePicker, NInput, NSelect, NTimePicker } from 'naive-ui'
import DiaryTaskForm from '../DiaryTaskForm.vue'
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
      recurrence: { frequency: 'daily', startDate: '2026-11-16', untilDate: null },
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
      dueDate: '2026-11-20', dueTime: '10:30', recurrence: null,
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
    }
    const wrapper = mount(DiaryTaskForm, { props: { modelValue: initial, today: '2026-11-16' } })

    const dueDate = getControl(wrapper, NDatePicker, '截止日期')
    expect(dueDate.props('clearable')).toBe(true)
    await dueDate.vm.$emit('update:formatted-value', null, null)
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({
      dueDate: null,
      dueTime: null,
    })
    await wrapper.setProps({ modelValue: { ...initial, dueDate: null, dueTime: null } })
    expect(wrapper.findAll('.diary-task-form-time-heading').find(heading => heading.text().includes('截止日期'))?.text()).toContain('截止日期*')
    expect(wrapper.get('[role="alert"]').text()).toBe('请选择截止日期。')
    wrapper.unmount()
  })

  it('clears optional start dates with their time while keeping start and due pairs independent', async () => {
    const initial: TaskEditorFields = {
      title: '准备发布', description: '', startDate: null, startTime: null,
      dueDate: '2026-11-21', dueTime: '12:00', recurrence: null,
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

  it('shows a concise error for invalid same-day start and due times', () => {
    const initial: TaskEditorFields = {
      title: '准备发布', description: '', startDate: '2026-11-19', startTime: '15:00',
      dueDate: '2026-11-19', dueTime: '12:00', recurrence: null,
    }
    const wrapper = mount(DiaryTaskForm, { props: { modelValue: initial, today: '2026-11-16' } })

    expect(wrapper.get('[role="alert"]').text()).toBe('同一天的开始时间不能晚于截止时间。')
    wrapper.unmount()
  })

  it('starts a recurrence on the selected due date', async () => {
    const initial: TaskEditorFields = {
      title: '每周整理笔记',
      description: '',
      startDate: null,
      startTime: null,
      dueDate: '2026-11-18',
      dueTime: null,
      recurrence: null,
    }
    const wrapper = mount(DiaryTaskForm, { props: { modelValue: initial, today: '2026-11-16' } })

    await getControl(wrapper, NSelect, '重复规则').vm.$emit('update:value', 'weekly')
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({
      dueDate: '2026-11-18',
      recurrence: { frequency: 'weekly', startDate: '2026-11-18', untilDate: null },
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
      title: '每周整理笔记', description: '', startDate: null, startTime: null, dueDate: null, dueTime: null, recurrence: null,
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
      recurrence: { frequency: 'daily', startDate: '2026-11-16', untilDate: null },
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
      title: '预约体检', description: '', startDate: null, startTime: null, dueDate: null, dueTime: null, recurrence: null,
    }
    const wrapper = mount(DiaryTaskForm, { props: { modelValue: initial, today: '2026-11-16', allowRecurrence: false } })
    expect(wrapper.find('[aria-label="重复规则"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('shows a completed task status in one read-only row above the remarks', async () => {
    const initial: TaskEditorFields = {
      title: '性能稼动率接口开发', description: '备注内容', startDate: null, startTime: null,
      dueDate: '2026-11-15', dueTime: '02:00', recurrence: null,
    }
    const statusTask = {
      completedAt: new Date(2026, 10, 15, 3, 26).getTime(),
      dueDate: initial.dueDate,
      dueTime: initial.dueTime,
    }
    const wrapper = mount(DiaryTaskForm, { props: { modelValue: initial, today: '2026-11-16', statusTask, now: new Date(2026, 10, 19).getTime() } })

    const statusField = wrapper.get('.diary-task-form-completion')
    const statusBox = wrapper.get('[data-testid="diary-task-completion"]')
    expect(statusField.text()).toContain('完成状态')
    expect(statusBox.get('.diary-task-form-completion-left').text()).toBe('2026-11-15 03:26')
    expect(statusBox.get('.diary-task-form-completion-right').text()).toBe('逾期1小时26分')
    expect(statusBox.findAll('.diary-task-form-completion-box')).toHaveLength(0)
    expect(statusBox.findAll('.diary-task-form-completion-left, .diary-task-form-completion-right')).toHaveLength(2)
    expect(statusBox.get('.diary-task-form-completion-right').classes()).toContain('is-overdue')
    expect(wrapper.find('[aria-label="完成时间"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="diary-task-completion"] input').exists()).toBe(false)
    expect(statusBox.attributes('tabindex')).toBeUndefined()
    expect(statusField.element.compareDocumentPosition(wrapper.get('.diary-task-form-description').element)
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    await wrapper.setProps({ modelValue: { ...initial, dueDate: '2026-11-25', dueTime: '02:00' } })
    expect(statusBox.get('.diary-task-form-completion-left').text()).toBe('2026-11-15 03:26')
    expect(statusBox.get('.diary-task-form-completion-right').text()).toBe('逾期1小时26分')
    wrapper.unmount()
  })

  it('shows persisted overdue state, updates it with the shared clock, and hides it after a saved deadline change', async () => {
    const initial: TaskEditorFields = {
      title: '未完成待办', description: '', startDate: null, startTime: null,
      dueDate: '2026-11-15', dueTime: '02:00', recurrence: null,
    }
    const statusTask = { completedAt: null, dueDate: '2026-11-15', dueTime: '02:00' }
    const wrapper = mount(DiaryTaskForm, {
      props: { modelValue: initial, today: '2026-11-16', statusTask, now: new Date(2026, 10, 15, 1, 59).getTime() },
    })

    expect(wrapper.find('[data-testid="diary-task-completion"]').exists()).toBe(false)
    await wrapper.setProps({ now: new Date(2026, 10, 15, 10, 26).getTime() })
    const statusRow = wrapper.get('[data-testid="diary-task-completion"]')
    expect(statusRow.get('.diary-task-form-completion-left').text()).toBe('尚未完成')
    expect(statusRow.get('.diary-task-form-completion-right').text()).toBe('已逾期8小时26分')
    expect(statusRow.get('.diary-task-form-completion-right').classes()).toContain('is-overdue')

    await wrapper.setProps({ modelValue: { ...initial, dueDate: '2026-11-25' } })
    expect(statusRow.get('.diary-task-form-completion-left').text()).toBe('尚未完成')
    expect(statusRow.get('.diary-task-form-completion-right').text()).toBe('已逾期8小时26分')
    await wrapper.setProps({ statusTask: { ...statusTask, dueDate: '2026-11-25' } })
    expect(wrapper.find('[data-testid="diary-task-completion"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('uses the recurring occurrence status and suppresses skipped instances', async () => {
    const initial: TaskEditorFields = {
      title: '每周整理', description: '', startDate: null, startTime: null,
      dueDate: '2026-11-17', dueTime: null,
      recurrence: { frequency: 'weekly', startDate: '2026-11-10', untilDate: '2026-12-31' },
    }
    const occurrence = { completedAt: null, dueDate: '2026-11-17', dueTime: null }
    const wrapper = mount(DiaryTaskForm, {
      props: { modelValue: initial, today: '2026-11-19', statusTask: occurrence, now: new Date(2026, 10, 19, 8).getTime() },
    })

    expect(wrapper.get('[data-testid="diary-task-completion"] .diary-task-form-completion-left').text()).toBe('尚未完成')
    expect(wrapper.get('[data-testid="diary-task-completion"] .diary-task-form-completion-right').text()).toBe('已逾期2天')
    await wrapper.setProps({ statusTask: { ...occurrence, skipped: true } })
    expect(wrapper.find('[data-testid="diary-task-completion"]').exists()).toBe(false)
    await wrapper.setProps({ statusTask: { ...occurrence, completedAt: new Date(2026, 10, 17, 23, 59).getTime() } })
    expect(wrapper.get('[data-testid="diary-task-completion"] .diary-task-form-completion-left').text()).toBe('2026-11-17 23:59')
    expect(wrapper.get('[data-testid="diary-task-completion"] .diary-task-form-completion-right').text()).toBe('按时完成')
    wrapper.unmount()
  })

  it('shows the exact saved completion time for an on-time task and hides it after restoration', async () => {
    const initial: TaskEditorFields = {
      title: '按时完成', description: '', startDate: null, startTime: null,
      dueDate: '2026-12-31', dueTime: '23:30', recurrence: null,
    }
    const statusTask = {
      completedAt: new Date(2026, 11, 31, 23, 30).getTime(),
      dueDate: '2026-12-31',
      dueTime: '23:30',
    }
    const wrapper = mount(DiaryTaskForm, { props: { modelValue: initial, today: '2026-12-31', statusTask } })

    expect(wrapper.get('[data-testid="diary-task-completion"] .diary-task-form-completion-left').text()).toBe('2026-12-31 23:30')
    expect(wrapper.get('[data-testid="diary-task-completion"] .diary-task-form-completion-right').text()).toBe('按时完成')
    expect(wrapper.get('[data-testid="diary-task-completion"] .diary-task-form-completion-right').classes()).not.toContain('is-overdue')
    await wrapper.setProps({ statusTask: { ...statusTask, completedAt: null } })
    expect(wrapper.find('[data-testid="diary-task-completion"]').exists()).toBe(false)
    wrapper.unmount()
  })

})
