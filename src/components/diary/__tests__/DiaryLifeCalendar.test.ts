// @vitest-environment jsdom
import { mount, enableAutoUnmount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DiaryLifeCalendar from '../DiaryLifeCalendar.vue'
import { alarmClockAsset } from '../../../features/diary/deadlineReminderAssets'
import { useI18n } from '../../../composables/useI18n'

enableAutoUnmount(afterEach)
beforeEach(() => {
  vi.useFakeTimers()
  useI18n().setLocale('zh')
})
afterEach(() => {
  vi.useRealTimers()
  useI18n().setLocale('zh')
})

function mountCalendar(markers: Record<string, { source?: string; emoji?: string; count?: number; hasTasks?: boolean; taskDeadlineState?: 'normal' | 'due-soon' | 'overdue' | 'inactive' }> = {}) {
  const wrapper = mount(DiaryLifeCalendar, {
    props: { today: '2026-11-16', selectedDate: null, month: '2026-11-01', revision: 0, markers },
  })
  const calendar = wrapper.get('.diary-life-calendar')
  let time = 0

  function wheel(deltas: number[], interval = 16, deltaMode: number = WheelEvent.DOM_DELTA_PIXEL) {
    for (const deltaY of deltas) {
      time += interval
      vi.advanceTimersByTime(interval)
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY, deltaMode })
      Object.defineProperty(event, 'timeStamp', { value: time })
      calendar.element.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
    }
  }

  return { wrapper, wheel, months: () => wrapper.emitted('month')?.flat() ?? [] }
}

describe('Diary calendar wheel navigation', () => {
  it('localizes the month heading while preserving the yyyy-MM picker value', () => {
    const { wrapper } = mountCalendar()
    expect(wrapper.get('.life-month-label').text()).toBe('2026年11月')
    expect(wrapper.get('.life-month-label').attributes('data-month')).toBe('2026-11')
    wrapper.unmount()

    useI18n().setLocale('en')
    const english = mountCalendar()
    expect(english.wrapper.get('.life-month-label').text()).toBe('November 2026')
    expect(english.wrapper.get('.life-month-label').attributes('data-month')).toBe('2026-11')
    english.wrapper.unmount()
  })

  it('ignores light movement and flips only once for a strong flick with a long tail', () => {
    const { wheel, months } = mountCalendar()
    wheel([12, 18, 24, 20])
    expect(months()).toEqual([])

    wheel([500], 140)
    wheel([180, 140, 100, 72, 48, 24, 12, 6, 3], 70)
    vi.advanceTimersByTime(600)
    expect(months()).toEqual(['2026-12-01'])
  })

  it('recognizes a second push in place before the previous tail ends', () => {
    const { wheel, months } = mountCalendar()
    wheel([55, 75, 100, 68, 35, 12, 6])
    expect(months()).toEqual(['2026-12-01'])

    wheel([20, 65, 140])
    expect(months()).toEqual(['2026-12-01', '2027-01-01'])

    wheel([-45, -75, -110])
    expect(months()).toEqual(['2026-12-01', '2027-01-01', '2026-12-01'])
  })

  it('accumulates line based mouse wheel steps separately', () => {
    const { wheel, months } = mountCalendar()
    wheel([3], 16, WheelEvent.DOM_DELTA_LINE)
    expect(months()).toEqual([])
    wheel([3, 3, 3], 16, WheelEvent.DOM_DELTA_LINE)
    expect(months()).toEqual(['2026-12-01', '2027-01-01'])
  })

  it('keeps the event emoji and one Fluent Stopwatch for unfinished tasks as separate markers', () => {
    const { wrapper } = mountCalendar({
      '2026-11-18': { source: '/emoji/event-birthday.svg', emoji: '🎂', count: 1, hasTasks: true },
      '2026-11-19': { hasTasks: true },
    })

    const eventAndTask = wrapper.get('.life-date[data-date="2026-11-18"] .life-marker')
    expect(eventAndTask.find('img:not(.life-task-marker)').attributes('src')).toBe('/emoji/event-birthday.svg')
    expect(eventAndTask.find('img:not(.life-task-marker)').classes()).toContain('life-event-marker')
    expect(eventAndTask.find('.life-task-marker').attributes('src')).toBe('/emoji/stopwatch.svg')
    expect(eventAndTask.find('.life-task-marker').attributes('alt')).toBe('有未完成待办')
    expect(eventAndTask.findAll('img')).toHaveLength(2)
    const taskOnly = wrapper.get('.life-date[data-date="2026-11-19"] .life-marker')
    expect(taskOnly.findAll('.life-task-marker')).toHaveLength(1)
    expect(taskOnly.find('.life-task-marker').attributes('src')).toBe('/emoji/stopwatch.svg')
    expect(taskOnly.find('.life-entry-marker').exists()).toBe(false)
    expect(taskOnly.text()).not.toContain('⏱️')
    expect(taskOnly.text()).not.toContain('⏰')
    wrapper.unmount()
  })

  it('keeps the main Event and Todo markers while exposing a compact multi-event count hook', () => {
    const { wrapper } = mountCalendar({
      '2026-11-18': { source: '/emoji/event-birthday.svg', emoji: '🎂', count: 3, hasTasks: true, taskDeadlineState: 'due-soon' },
    })
    const marker = wrapper.get('.life-date[data-date="2026-11-18"] .life-marker')

    expect(marker.classes()).toContain('life-marker--with-task')
    expect(marker.find('.life-event-marker').attributes('src')).toBe('/emoji/event-birthday.svg')
    expect(marker.find('.life-task-marker').attributes('src')).toBe(alarmClockAsset(false))
    expect(marker.find('small').text()).toBe('+2')
    wrapper.unmount()
  })

  it('uses Alarm Clock for due-soon and overdue tasks while preserving event emoji', () => {
    const { wrapper } = mountCalendar({
      '2026-11-18': { source: '/emoji/event-birthday.svg', emoji: '🎂', count: 1, hasTasks: true, taskDeadlineState: 'due-soon' },
      '2026-11-17': { hasTasks: true, taskDeadlineState: 'overdue' },
    })

    const today = wrapper.get('.life-date[data-date="2026-11-18"] .life-task-marker')
    expect(today.attributes('src')).toBe(alarmClockAsset(false))
    expect(today.attributes('alt')).toBe('即将截止待办')
    expect(wrapper.get('.life-date[data-date="2026-11-18"] .life-marker img:not(.life-task-marker)').attributes('src')).toBe('/emoji/event-birthday.svg')
    expect(wrapper.get('.life-date[data-date="2026-11-17"] .life-task-marker').attributes('src')).toBe('/emoji/alarm-clock.svg')
    expect(wrapper.findAll('.life-task-marker')).toHaveLength(2)
    wrapper.unmount()
  })

  it('selects a static Alarm Clock asset when reduced motion is enabled', () => {
    expect(alarmClockAsset(true)).toBe('/emoji/alarm-clock.svg')
    expect(alarmClockAsset(false)).toBe('/emoji/alarm-clock-animated.png')
  })
})
