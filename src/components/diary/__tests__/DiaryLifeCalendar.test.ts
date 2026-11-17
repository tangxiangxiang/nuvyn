// @vitest-environment jsdom
import { mount, enableAutoUnmount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DiaryLifeCalendar from '../DiaryLifeCalendar.vue'

enableAutoUnmount(afterEach)
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function mountCalendar(markers: Record<string, { source?: string; emoji?: string; count?: number; hasTasks?: boolean }> = {}) {
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

  it('keeps the event emoji and the unfinished task dot as separate calendar markers', () => {
    const { wrapper } = mountCalendar({
      '2026-11-18': { emoji: '🎂', count: 1, hasTasks: true },
      '2026-11-19': { hasTasks: true },
    })

    const eventAndTask = wrapper.get('.life-date[data-date="2026-11-18"] .life-marker')
    expect(eventAndTask.text()).toContain('🎂')
    expect(eventAndTask.find('.life-task-marker').exists()).toBe(true)
    const taskOnly = wrapper.get('.life-date[data-date="2026-11-19"] .life-marker')
    expect(taskOnly.find('.life-task-marker').exists()).toBe(true)
    expect(taskOnly.find('.life-entry-marker').exists()).toBe(false)
    wrapper.unmount()
  })
})
