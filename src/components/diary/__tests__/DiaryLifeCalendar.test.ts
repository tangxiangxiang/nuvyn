// @vitest-environment jsdom
import { mount, enableAutoUnmount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DiaryLifeCalendar from '../DiaryLifeCalendar.vue'
import LunarCalendarModal from '../LunarCalendarModal.vue'
import { alarmClockAsset, BOMB_ANIMATED_ASSET, BOMB_STATIC_ASSET, PARTY_POPPER_ASSET } from '../../../features/diary/deadlineReminderAssets'
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

type CalendarMarker = { source?: string; emoji?: string; count?: number; hasTasks?: boolean; todoDayState?: 'none' | 'pending' | 'due-soon' | 'overdue' | 'completed' | 'completed-late' }

function mountCalendar(markers: Record<string, CalendarMarker> = {}, options: { today?: string; month?: string } = {}) {
  const wrapper = mount(DiaryLifeCalendar, {
    props: { today: options.today ?? '2026-11-16', selectedDate: null, month: options.month ?? '2026-11-01', revision: 0, viewMode: 'diary', markers },
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
  it('shows lunar month names on day one and lunar day labels across leap months and year rollover', () => {
    const yearBoundary = mountCalendar({}, { month: '2027-02-01', today: '2027-02-06' })
    expect(yearBoundary.wrapper.get('.life-date[data-date="2027-02-05"] .life-date-lunar').text()).toBe('廿九')
    expect(yearBoundary.wrapper.get('.life-date[data-date="2027-02-06"] .life-date-lunar').text()).toBe('正月')
    yearBoundary.wrapper.unmount()

    const leapMonth = mountCalendar({}, { month: '2023-03-01', today: '2023-03-22' })
    expect(leapMonth.wrapper.get('.life-date[data-date="2023-03-22"] .life-date-lunar').text()).toBe('闰二月')
    expect(leapMonth.wrapper.get('.life-date[data-date="2023-03-23"] .life-date-lunar').text()).toBe('初二')
    leapMonth.wrapper.unmount()
  })

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
      '2026-11-18': { source: '/emoji/event-birthday.svg', emoji: '🎂', count: 1, hasTasks: true, todoDayState: 'pending' },
      '2026-11-19': { hasTasks: true, todoDayState: 'pending' },
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
      '2026-11-18': { source: '/emoji/event-birthday.svg', emoji: '🎂', count: 3, hasTasks: true, todoDayState: 'due-soon' },
    })
    const marker = wrapper.get('.life-date[data-date="2026-11-18"] .life-marker')

    expect(marker.classes()).toContain('life-marker--with-task')
    expect(marker.find('.life-event-marker').attributes('src')).toBe('/emoji/event-birthday.svg')
    expect(marker.find('.life-task-marker').attributes('src')).toBe(alarmClockAsset(false))
    expect(marker.find('small').text()).toBe('+2')
    wrapper.unmount()
  })

  it('keeps Event Emoji and shows exactly one Todo outcome marker', () => {
    const { wrapper } = mountCalendar({
      '2026-11-18': { source: '/emoji/event-birthday.svg', emoji: '🎂', count: 1, hasTasks: true, todoDayState: 'completed' },
      '2026-11-17': { hasTasks: true, todoDayState: 'overdue' },
      '2026-11-19': { hasTasks: true, todoDayState: 'due-soon' },
    })

    const completed = wrapper.get('.life-date[data-date="2026-11-18"] .life-task-marker')
    expect(completed.attributes('src')).toBe(PARTY_POPPER_ASSET)
    expect(completed.attributes('alt')).toBe('当天待办已全部完成')
    expect(wrapper.get('.life-date[data-date="2026-11-18"] .life-marker img:not(.life-task-marker)').attributes('src')).toBe('/emoji/event-birthday.svg')
    const overdue = wrapper.get('.life-date[data-date="2026-11-17"] .life-task-marker')
    expect(overdue.attributes('src')).toBe(BOMB_ANIMATED_ASSET)
    expect(overdue.attributes('data-todo-day-state')).toBe('overdue')
    expect(wrapper.get('.life-date[data-date="2026-11-19"] .life-task-marker').attributes('src')).toBe(alarmClockAsset(false))
    expect(wrapper.findAll('.life-task-marker')).toHaveLength(3)
    wrapper.unmount()
  })

  it('grays only the completed-late Todo Party Popper and keeps it static', () => {
    const { wrapper } = mountCalendar({
      '2026-10-18': { source: '/emoji/event-birthday.svg', emoji: '🎂', count: 1, hasTasks: true, todoDayState: 'completed-late' },
    }, { month: '2026-10-01', today: '2026-11-18' })
    const marker = wrapper.get('.life-date[data-date="2026-10-18"] .life-task-marker')
    const eventEmoji = wrapper.get('.life-date[data-date="2026-10-18"] .life-marker img:not(.life-task-marker)')

    expect(marker.attributes('src')).toBe(PARTY_POPPER_ASSET)
    expect(marker.attributes('alt')).toBe('当天待办已全部完成（含逾期完成）')
    expect(marker.classes()).toContain('life-task-marker--completed-late')
    expect(marker.attributes('data-todo-day-state')).toBe('completed-late')
    expect(eventEmoji.classes()).not.toContain('life-task-marker--completed-late')
    expect(eventEmoji.attributes('src')).toBe('/emoji/event-birthday.svg')
    wrapper.unmount()
  })

  it('uses static Todo Emoji in history, future, and adjacent-month cells', () => {
    const historical = mountCalendar({
      '2026-10-17': { hasTasks: true, todoDayState: 'overdue' },
    }, { month: '2026-10-01', today: '2026-11-18' })
    expect(historical.wrapper.get('.life-date[data-date="2026-10-17"] .life-task-marker').attributes('src')).toBe(BOMB_STATIC_ASSET)
    historical.wrapper.unmount()

    const future = mountCalendar({
      '2026-12-19': { hasTasks: true, todoDayState: 'due-soon' },
    }, { month: '2026-12-01', today: '2026-11-18' })
    expect(future.wrapper.get('.life-date[data-date="2026-12-19"] .life-task-marker').attributes('src')).toBe('/emoji/alarm-clock.svg')
    future.wrapper.unmount()

    const adjacent = mountCalendar({
      '2026-12-01': { hasTasks: true, todoDayState: 'overdue' },
      '2026-11-17': { hasTasks: true, todoDayState: 'overdue' },
    }, { month: '2026-11-01', today: '2026-11-18' })
    expect(adjacent.wrapper.get('.life-date[data-date="2026-12-01"] .life-task-marker').attributes('src')).toBe(BOMB_STATIC_ASSET)
    expect(adjacent.wrapper.get('.life-date[data-date="2026-11-17"] .life-task-marker').attributes('src')).toBe(BOMB_ANIMATED_ASSET)
    adjacent.wrapper.unmount()
  })

  it('selects a static Alarm Clock asset when reduced motion is enabled', () => {
    expect(alarmClockAsset(true)).toBe('/emoji/alarm-clock.svg')
    expect(alarmClockAsset(false)).toBe('/emoji/alarm-clock-animated.png')
  })

  it('opens one centered lunar calendar modal without selecting a calendar day', async () => {
    const { wrapper } = mountCalendar({}, { month: '2026-11-01', today: '2026-11-16' })
    const lunarTrigger = wrapper.get('.life-date[data-date="2026-11-16"] .life-date-lunar')

    await lunarTrigger.trigger('click')
    await wrapper.vm.$nextTick()
    const modal = document.querySelector('#diary-lunar-calendar-modal')
    expect(modal).not.toBeNull()
    const dialog = modal?.closest('.lunar-calendar-modal.n-card')
    expect(dialog?.getAttribute('role')).toBe('dialog')
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
    expect(dialog?.getAttribute('aria-label')).toBe('农历日期详情')
    expect(modal?.querySelector('.lunar-calendar-modal-ganzhi')?.textContent?.trim()).toBe('丙午年 己亥月 甲午日')
    expect(modal?.querySelector('.lunar-calendar-modal-date')?.textContent?.trim()).toBe('农历 十月初八日')
    expect(modal?.querySelectorAll('.lunar-calendar-time-item')).toHaveLength(12)
    expect(Array.from(modal?.querySelectorAll('.lunar-calendar-time-ganzhi') ?? []).map(element => element.textContent)).toEqual([
      '甲子时', '乙丑时', '丙寅时', '丁卯时', '戊辰时', '己巳时',
      '庚午时', '辛未时', '壬申时', '癸酉时', '甲戌时', '乙亥时',
    ])
    expect(modal?.querySelector('[data-time-pillar="zi"] .lunar-calendar-time-range')?.textContent).toBe('23:00–01:00')
    expect(modal?.querySelector('img, svg')).toBeNull()
    expect(lunarTrigger.attributes('aria-expanded')).toBe('true')
    expect(lunarTrigger.attributes('aria-controls')).toBe('diary-lunar-calendar-modal')
    expect(wrapper.emitted('select')).toBeUndefined()

    wrapper.findComponent(LunarCalendarModal).vm.$emit('close')
    await wrapper.vm.$nextTick()
    expect(document.querySelector('#diary-lunar-calendar-modal')).toBeNull()

    const nextDateTrigger = wrapper.get('.life-date[data-date="2026-11-17"] .life-date-lunar')
    await nextDateTrigger.trigger('click')
    await wrapper.vm.$nextTick()
    expect(document.querySelectorAll('#diary-lunar-calendar-modal')).toHaveLength(1)
    expect(document.querySelector('.lunar-calendar-modal-ganzhi')?.textContent?.trim()).toContain('乙未日')
    expect(document.querySelector('.lunar-calendar-modal-date')?.textContent?.trim()).toBe('农历 十月初九日')

    wrapper.findComponent(LunarCalendarModal).vm.$emit('close')
    await wrapper.vm.$nextTick()
    expect(document.querySelector('#diary-lunar-calendar-modal')).toBeNull()
    await wrapper.get('.life-date[data-date="2026-11-16"] .life-date-action').trigger('click')
    expect(wrapper.emitted('select')?.[0]).toEqual(['2026-11-16'])
    wrapper.unmount()
  })

  it('restores focus when the modal closes and clears it on view/month changes', async () => {
    const { wrapper } = mountCalendar({}, { month: '2026-11-01', today: '2026-11-16' })
    document.body.append(wrapper.element as unknown as Node)
    const trigger = wrapper.get('.life-date[data-date="2026-11-16"] .life-date-lunar')

    const triggerElement = trigger.element as HTMLButtonElement
    triggerElement.focus()
    expect(document.activeElement).toBe(triggerElement)
    await trigger.trigger('click')
    await wrapper.vm.$nextTick()
    expect(document.querySelector('#diary-lunar-calendar-modal')).not.toBeNull()
    wrapper.findComponent(LunarCalendarModal).vm.$emit('close')
    await wrapper.vm.$nextTick()
    expect(document.querySelector('#diary-lunar-calendar-modal')).toBeNull()
    expect(document.activeElement).toBe(wrapper.get('.life-date[data-date="2026-11-16"] .life-date-lunar').element)

    await trigger.trigger('click')
    await wrapper.vm.$nextTick()
    wrapper.findComponent(LunarCalendarModal).vm.$emit('close')
    await wrapper.vm.$nextTick()
    expect(document.querySelector('#diary-lunar-calendar-modal')).toBeNull()

    await trigger.trigger('click')
    await wrapper.setProps({ viewMode: 'events' })
    await wrapper.vm.$nextTick()
    expect(document.querySelector('#diary-lunar-calendar-modal')).toBeNull()

    await wrapper.setProps({ viewMode: 'diary' })
    const eventTrigger = wrapper.get('.life-date[data-date="2026-11-16"] .life-date-lunar')
    await eventTrigger.trigger('click')
    await wrapper.setProps({ month: '2026-12-01' })
    await wrapper.vm.$nextTick()
    expect(document.querySelector('#diary-lunar-calendar-modal')).toBeNull()
    wrapper.unmount()
  })

  it('updates the current time highlight at a time boundary and at midnight', async () => {
    vi.setSystemTime(new Date(2026, 10, 16, 0, 59, 30))
    const midnightZiCalendar = mountCalendar({}, { month: '2026-11-01', today: '2026-11-16' })
    await midnightZiCalendar.wrapper.get('.life-date[data-date="2026-11-16"] .life-date-lunar').trigger('click')
    await midnightZiCalendar.wrapper.vm.$nextTick()
    expect(document.querySelector('.lunar-calendar-time-item.is-current-time')?.getAttribute('data-time-pillar')).toBe('zi')
    vi.advanceTimersByTime(30_001)
    await midnightZiCalendar.wrapper.vm.$nextTick()
    expect(document.querySelector('.lunar-calendar-time-item.is-current-time')?.getAttribute('data-time-pillar')).toBe('chou')
    midnightZiCalendar.wrapper.unmount()

    vi.setSystemTime(new Date(2026, 10, 16, 10, 59, 30))
    const todayCalendar = mountCalendar({}, { month: '2026-11-01', today: '2026-11-16' })
    await todayCalendar.wrapper.get('.life-date[data-date="2026-11-16"] .life-date-lunar').trigger('click')
    await todayCalendar.wrapper.vm.$nextTick()
    expect(document.querySelector('.lunar-calendar-time-item.is-current-time')?.getAttribute('data-time-pillar')).toBe('si')
    vi.advanceTimersByTime(30_001)
    await todayCalendar.wrapper.vm.$nextTick()
    expect(document.querySelector('.lunar-calendar-time-item.is-current-time')?.getAttribute('data-time-pillar')).toBe('wu')
    todayCalendar.wrapper.unmount()

    vi.setSystemTime(new Date(2026, 10, 16, 22, 59, 30))
    const lastMinuteCalendar = mountCalendar({}, { month: '2026-11-01', today: '2026-11-16' })
    await lastMinuteCalendar.wrapper.get('.life-date[data-date="2026-11-16"] .life-date-lunar').trigger('click')
    await lastMinuteCalendar.wrapper.vm.$nextTick()
    expect(document.querySelector('.lunar-calendar-time-item.is-current-time')?.getAttribute('data-time-pillar')).toBe('hai')
    vi.advanceTimersByTime(30_001)
    await lastMinuteCalendar.wrapper.vm.$nextTick()
    expect(document.querySelector('.lunar-calendar-time-item.is-current-time')?.getAttribute('data-time-pillar')).toBe('zi')
    vi.advanceTimersByTime(60 * 60_000)
    await lastMinuteCalendar.wrapper.vm.$nextTick()
    expect(document.querySelector('.is-current-time')).toBeNull()
    lastMinuteCalendar.wrapper.unmount()

    vi.setSystemTime(new Date(2026, 10, 16, 23, 59, 30))
    const tomorrowCalendar = mountCalendar({}, { month: '2026-11-01', today: '2026-11-16' })
    await tomorrowCalendar.wrapper.get('.life-date[data-date="2026-11-17"] .life-date-lunar').trigger('click')
    await tomorrowCalendar.wrapper.vm.$nextTick()
    expect(document.querySelector('.lunar-calendar-time-item.is-current-time')).toBeNull()
    vi.advanceTimersByTime(30_001)
    await tomorrowCalendar.wrapper.vm.$nextTick()
    expect(document.querySelector('.lunar-calendar-time-item.is-current-time')?.getAttribute('data-time-pillar')).toBe('zi')
    tomorrowCalendar.wrapper.unmount()

  })
})
