// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import DiaryEventListDialog from '../DiaryEventListDialog.vue'
import type { DiaryEvent } from '../../../../shared/diaryLife'

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
  it('shows concise event details, countdowns, and keeps API order', () => {
    const first = makeEvent({ id: 'first', title: '较早显示', isPrimary: false })
    const second = makeEvent({ id: 'second', title: '优先事件', isPrimary: true, startDate: '2026-11-18', endDate: '2026-11-18', recurrence: 'none', type: 'milestone' })
    const wrapper = mount(DiaryEventListDialog, {
      props: { items: [first, second], today: '2026-11-15' },
      global: { stubs: naiveStubs },
    })

    const rows = wrapper.findAll('.diary-event-list-item')
    expect(rows.map(row => row.attributes('aria-label'))).toEqual(['较早显示', '优先事件'])
    expect(rows[0]!.text()).toContain('每年重复')
    expect(rows[0]!.text()).toContain('6 月 19 日')
    expect(rows[0]!.text()).toContain('较早显示')
    expect(rows[0]!.text()).not.toContain('周年')
    expect(rows[1]!.text()).toContain('3')
    expect(rows[1]!.text()).toContain('天后')
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
})
