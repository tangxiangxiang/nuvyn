// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import DiaryEventListDialog from '../DiaryEventListDialog.vue'
import type { DiaryEvent } from '../../../../shared/diaryLife'
import type { DiaryTask } from '../../../../shared/diaryTasks'

function makeTask(overrides: Partial<DiaryTask> = {}): DiaryTask {
  return {
    id: 'task-1',
    title: '给爷爷打电话',
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

function makeEvent(overrides: Partial<DiaryEvent> = {}): DiaryEvent {
  return {
    id: 'event-1',
    title: '爸爸的生日',
    description: '和爸爸一起吃顿饭',
    emoji: '🎂',
    type: 'anniversary',
    startDate: '2024-06-19',
    endDate: '2024-06-19',
    startTime: null,
    endTime: null,
    allDay: true,
    recurrence: 'yearly',
    showCountdown: true,
    isPrimary: false,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

const naiveStubs = {
  NButton: { template: '<button><slot /></button>' },
  NEmpty: { template: '<p><slot /></p>' },
  NSpin: { template: '<span />' },
}

describe('DiaryEventListDialog content', () => {
  it('shows concise event details, countdowns, and keeps API order', async () => {
    const first = makeEvent({ id: 'first', title: '较早显示', isPrimary: false })
    const second = makeEvent({ id: 'second', title: '优先事件', isPrimary: true, startDate: '2026-11-18', endDate: '2026-11-18', recurrence: 'none', type: 'milestone' })
    const wrapper = mount(DiaryEventListDialog, {
      props: { items: [first, second], today: '2026-11-15' },
      global: { stubs: naiveStubs },
    })

    const rows = wrapper.findAll('.diary-event-list-item')
    expect(rows.map(row => row.attributes('aria-label'))).toEqual(['较早显示', '优先事件'])
    expect(rows[0]!.classes()).toContain('diary-cloud-card')
    expect(rows[0]!.text()).toContain('6 月 19 日')
    expect(rows[0]!.text()).toContain('较早显示')
    expect(rows[0]!.text()).not.toContain('周年')
    expect(rows[1]!.text()).toContain('3')
    expect(rows[1]!.text()).toContain('天后')
    const scroller = wrapper.get('.diary-event-list-scroll').element
    scroller.scrollTop = 120
    await rows[0]!.trigger('click')
    expect(wrapper.emitted('select')).toEqual([[first, 120, true]])
    wrapper.vm.restoreScroll(80)
    expect(scroller.scrollTop).toBe(80)
    wrapper.unmount()
  })

  it('does not show a countdown for a past one-time event and reacts when today changes', async () => {
    const past = makeEvent({ id: 'past', title: '已经结束', recurrence: 'none', startDate: '2026-11-10', endDate: '2026-11-10', showCountdown: true })
    const upcoming = makeEvent({ id: 'upcoming', title: '即将发生', recurrence: 'none', startDate: '2026-11-18', endDate: '2026-11-18', type: 'schedule' })
    const wrapper = mount(DiaryEventListDialog, {
      props: { items: [past, upcoming], today: '2026-11-15' },
      global: { stubs: naiveStubs },
    })

    expect(wrapper.findAll('.diary-event-list-countdown')).toHaveLength(1)
    expect(wrapper.find('.diary-event-list-item').text()).toContain('已经结束')
    expect(wrapper.findAll('.diary-event-list-item')[0]!.find('.diary-event-list-countdown').exists()).toBe(false)
    expect(wrapper.findAll('.diary-event-list-item')[1]!.text()).toContain('3')
    await wrapper.setProps({ today: '2026-11-18' })
    expect(wrapper.findAll('.diary-event-list-countdown')[0]!.text()).toContain('就是今天')
    wrapper.unmount()
  })

  it('shows tasks and events together while keeping task completion separate from event selection', async () => {
    const event = makeEvent({ id: 'event-2', title: '爷爷75岁生日' })
    const task = makeTask()
    const wrapper = mount(DiaryEventListDialog, {
      props: { items: [event], tasks: [task], today: '2026-11-16', taskStatus: 'open' },
      global: { stubs: naiveStubs },
    })

    expect(wrapper.find('.diary-list-section-header h3').text()).toBe('待办事项')
    expect(wrapper.find('.diary-event-list-section h3').text()).toBe('事件')
    expect(wrapper.find('.diary-event-list-item').text()).toContain('爷爷75岁生日')
    expect(wrapper.get('[role="checkbox"]').attributes('aria-checked')).toBe('false')
    expect(wrapper.get('.diary-task-row').classes()).toContain('diary-cloud-card')
    expect(wrapper.text()).toContain('11月18日')

    await wrapper.get('[role="checkbox"]').trigger('click')
    expect(wrapper.emitted('toggle-task')).toEqual([[task]])
    expect(wrapper.emitted('edit-task')).toBeUndefined()
    expect(wrapper.emitted('select')).toBeUndefined()

    await wrapper.get('[data-task-id="task-1"]').trigger('click')
    expect(wrapper.emitted('edit-task')?.[0]?.[0]).toEqual(task)
    await wrapper.get('.diary-event-list-item').trigger('click')
    expect(wrapper.emitted('select')?.[0]?.[0]).toEqual(event)
    wrapper.unmount()
  })

  it('offers completed tasks separately and weakens completed task rows', async () => {
    const task = makeTask({ completedAt: 100 })
    const wrapper = mount(DiaryEventListDialog, {
      props: { items: [], tasks: [task], today: '2026-11-16', taskStatus: 'completed' },
      global: { stubs: naiveStubs },
    })

    expect(wrapper.get('.diary-task-row').classes()).toContain('is-completed')
    expect(wrapper.get('.diary-list-section-header h3').text()).toBe('已完成')
    await wrapper.get('.diary-list-section-header button').trigger('click')
    expect(wrapper.emitted('toggle-task-status')).toHaveLength(1)
    wrapper.unmount()
  })

  it('shows only populated sections and a unified empty state', () => {
    const taskOnly = mount(DiaryEventListDialog, {
      props: { items: [], tasks: [makeTask()], today: '2026-11-16' },
      global: { stubs: naiveStubs },
    })
    expect(taskOnly.find('.diary-list-section-title').exists()).toBe(false)
    expect(taskOnly.find('.diary-event-list-section').exists()).toBe(false)
    taskOnly.unmount()

    const empty = mount(DiaryEventListDialog, {
      props: { items: [], tasks: [], today: '2026-11-16' },
      global: { stubs: naiveStubs },
    })
    expect(empty.text()).toContain('还没有近期事项')
    expect(empty.find('.diary-list-section-header').exists()).toBe(false)
    empty.unmount()
  })
})
