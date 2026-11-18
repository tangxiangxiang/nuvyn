// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { lunarToSolar, type ChineseEventDateRule } from '../../../../shared/lunarCalendar'
import type { DiaryEvent } from '../../../../shared/diaryLife'
import type { DiaryTaskListItem } from '../../../../shared/diaryTasks'
import DiaryEventReader from '../DiaryEventReader.vue'

function makeEvent(overrides: Partial<DiaryEvent> = {}): DiaryEvent {
  return {
    id: 'event-1',
    title: '大学毕业',
    description: '和家人一起庆祝\n留下美好回忆',
    emoji: '🎓',
    type: 'milestone',
    startDate: '2026-07-03',
    endDate: '2026-07-03',
    startTime: null,
    endTime: null,
    allDay: true,
    dateRule: { calendar: 'gregory' },
    recurrence: 'none',
    showCountdown: false,
    isPrimary: false,
    version: 3,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

const naiveStubs = {
  NButton: { template: '<button :aria-label="$attrs[\'aria-label\']" @click="$emit(\'click\')"><slot /></button>' },
  NIcon: { template: '<span aria-hidden="true"><slot /></span>' },
}

function mountReader(event: DiaryEvent, occurrenceDate = event.startDate, focusTarget?: 'container' | 'edit' | null) {
  return mount(DiaryEventReader, {
    props: { event, occurrenceDate, focusTarget },
    attachTo: document.body,
    global: { stubs: naiveStubs },
  })
}

describe('DiaryEventReader', () => {
  it('shows milestone title and multiline description without editor-only labels', () => {
    const wrapper = mountReader(makeEvent())

    expect(wrapper.get('h1').text()).toBe('大学毕业')
    expect(wrapper.get('.diary-event-reader-description').text()).toBe('和家人一起庆祝\n留下美好回忆')
    expect(wrapper.text()).not.toContain('人生时刻')
    expect(wrapper.text()).not.toContain('重复')
    expect(wrapper.findAll('[aria-label="编辑事件"]')).toHaveLength(1)
    expect(wrapper.findAll('[aria-label="关闭事件"]')).toHaveLength(1)
    expect(wrapper.find('.diary-event-reader-tasks').exists()).toBe(false)
    wrapper.unmount()
  })

  it('shows related tasks only when present and emits direct completion actions', async () => {
    const event = makeEvent({ type: 'schedule', title: '周六体检', startDate: '2026-11-21', endDate: '2026-11-21' })
    const task: DiaryTaskListItem = {
      kind: 'one-off',
      id: 'task-1',
      title: '准备身份证',
      description: '',
      dueDate: '2026-11-20',
      dueTime: null,
      completedAt: null,
      eventId: event.id,
      version: 1,
      createdAt: 1,
      updatedAt: 1,
    }
    const wrapper = mount(DiaryEventReader, {
      props: { event, occurrenceDate: event.startDate, today: '2026-11-18', relatedTasks: [task] },
      attachTo: document.body,
      global: { stubs: naiveStubs },
    })

    expect(wrapper.get('.diary-event-reader-tasks h2').text()).toBe('相关待办')
    expect(wrapper.get('.diary-task-title').text()).toBe('准备身份证')
    expect(wrapper.get('.diary-task-rows').classes()).toContain('diary-task-rows--plain')
    expect(wrapper.get('.diary-task-row').classes()).not.toContain('diary-cloud-card')
    await wrapper.get('.diary-task-toggle').trigger('click')
    expect(wrapper.emitted('toggle-task')?.[0]?.[0]).toMatchObject({ id: task.id })
    wrapper.unmount()
  })

  it('uses the lunar occurrence date to show a birthday age without a generated title', () => {
    const dateRule: ChineseEventDateRule = {
      calendar: 'chinese',
      lunarMonth: 10,
      lunarDay: 7,
      isLeapMonth: false,
      leapMonthPolicy: 'regular-month',
      shortMonthPolicy: 'last-day',
    }
    const occurrenceDate = lunarToSolar({ year: 2026, month: 10, day: 7, isLeapMonth: false })!
    const birthDate = lunarToSolar({ year: 1951, month: 10, day: 7, isLeapMonth: false })!
    const wrapper = mountReader(makeEvent({
      title: '爷爷',
      emoji: '🎂',
      type: 'birthday',
      startDate: birthDate,
      endDate: birthDate,
      recurrence: 'yearly',
      dateRule,
      birthday: { birthLunarYear: 1951 },
    }), occurrenceDate)

    expect(wrapper.get('h1').text()).toBe('爷爷75岁生日')
    expect(wrapper.get('.diary-event-reader-date').text()).toContain('农历十月初七')
    expect(wrapper.get('.diary-event-reader-date').text()).toContain('2026年')
    wrapper.unmount()
  })

  it('keeps anniversary wording concise and hides an empty description', () => {
    const wrapper = mountReader(makeEvent({
      title: '相识纪念日',
      description: '  ',
      type: 'anniversary',
      startDate: '2020-06-19',
      endDate: '2020-06-19',
      recurrence: 'yearly',
    }), '2026-06-19')

    expect(wrapper.get('h1').text()).toBe('相识纪念日')
    expect(wrapper.get('.diary-event-reader-date').text()).toBe('6月19日')
    expect(wrapper.findAll('.diary-event-reader-description')).toHaveLength(0)
    expect(wrapper.text()).not.toContain('每年重复')
    expect(wrapper.text()).not.toContain('周年')
    wrapper.unmount()
  })

  it('shows schedule date ranges, all-day status, and non-all-day times', () => {
    const allDay = mountReader(makeEvent({
      title: '家庭旅行',
      type: 'schedule',
      startDate: '2026-12-02',
      endDate: '2026-12-03',
    }))
    expect(allDay.get('.diary-event-reader-date').text()).toBe('2026年12月2日 – 2026年12月3日 · 全天')
    allDay.unmount()

    const timed = mountReader(makeEvent({
      title: '夜间列车',
      type: 'schedule',
      startDate: '2026-12-02',
      endDate: '2026-12-03',
      startTime: '22:30',
      endTime: '01:00',
      allDay: false,
    }))
    expect(timed.get('.diary-event-reader-date').text()).toContain('22:30–01:00')
    expect(timed.text()).not.toContain('重要日程')
    timed.unmount()
  })

  it('emits reader actions without changing the event', async () => {
    const event = makeEvent()
    const wrapper = mountReader(event)
    await wrapper.get('[data-testid="diary-event-reader-edit"]').trigger('click')
    await wrapper.get('[aria-label="关闭事件"]').trigger('click')

    expect(wrapper.emitted('edit')).toHaveLength(1)
    expect(wrapper.emitted('close')).toHaveLength(1)
    expect(wrapper.props('event')).toEqual(event)
    wrapper.unmount()
  })

  it('places keyboard focus on the reader or its edit action when requested', () => {
    const container = mountReader(makeEvent(), undefined, 'container')
    expect(document.activeElement).toBe(container.get('[data-testid="diary-event-reader"]').element)
    container.unmount()

    const edit = mountReader(makeEvent(), undefined, 'edit')
    expect(document.activeElement).toBe(edit.get('[data-testid="diary-event-reader-edit"]').element)
    edit.unmount()
  })
})
