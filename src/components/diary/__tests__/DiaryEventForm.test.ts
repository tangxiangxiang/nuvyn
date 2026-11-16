// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, reactive } from 'vue'
import DiaryEventForm from '../DiaryEventForm.vue'
import type { EventFields } from '../../../../shared/diaryLife'

const event: EventFields = {
  title: '生日聚餐',
  description: '和家人一起吃饭',
  emoji: '🎂',
  type: 'anniversary',
  startDate: '2026-06-19',
  endDate: '2026-06-19',
  startTime: '18:30',
  endTime: '20:00',
  allDay: true,
  recurrence: 'none',
  showCountdown: true,
  isPrimary: false,
}

function mountEventForm(initialFields: EventFields = event, today = '2026-11-16') {
  const fields = reactive({ ...initialFields })
  const Host = defineComponent({
    setup() {
      return () => h(DiaryEventForm, {
        modelValue: fields,
        today,
        'onUpdate:modelValue': (value: EventFields) => Object.assign(fields, value),
      })
    },
  })
  const wrapper = mount(Host)
  return { wrapper, fields }
}

describe('DiaryEventForm', () => {
  it('groups existing event fields into the three compact sections', () => {
    const { wrapper } = mountEventForm()

    expect(wrapper.findAll('h2').map(heading => heading.text())).toEqual(['基础信息', '重复与展示', '其他'])
    expect(wrapper.get('[aria-label="事件标题"]').element).toBeTruthy()
    expect(wrapper.get('[aria-label="事件描述"]').element).toBeTruthy()
    expect(wrapper.findAll('input[type="date"]')).toHaveLength(2)
    expect(wrapper.findAll('input[type="time"]')).toHaveLength(0)
    expect(wrapper.text()).toContain('每年重复')
    expect(wrapper.text()).toContain('显示倒数日')
    expect(wrapper.text()).toContain('优先显示此事件')
    wrapper.unmount()
  })

  it('reveals existing time values when an all-day event is changed to timed', async () => {
    const { wrapper, fields } = mountEventForm()
    await wrapper.findAll('.n-checkbox')[0]!.trigger('click')
    expect(fields.allDay).toBe(false)
    await nextTick()
    expect(wrapper.findAll('input[type="time"]')).toHaveLength(2)
    expect((wrapper.find('input[aria-label="开始时间"]').element as HTMLInputElement).value).toBe('18:30')
    expect((wrapper.find('input[aria-label="结束时间"]').element as HTMLInputElement).value).toBe('20:00')

    await wrapper.findAll('.n-checkbox')[1]!.trigger('click')
    expect(fields.recurrence).toBe('yearly')
    await nextTick()
    wrapper.unmount()
  })

  it('converts a supported annual Gregorian date to a lunar rule and back without changing other fields', async () => {
    const { wrapper, fields } = mountEventForm({
      ...event,
      startDate: '2026-07-03',
      endDate: '2026-07-03',
      recurrence: 'yearly',
    })
    await wrapper.get('.event-date-calendar-toggle button[aria-pressed="false"]:not(:disabled)').trigger('click')
    await nextTick()

    expect(fields.dateRule).toEqual({
      calendar: 'chinese',
      lunarMonth: 5,
      lunarDay: 19,
      isLeapMonth: false,
      leapMonthPolicy: 'regular-month',
      shortMonthPolicy: 'last-day',
    })
    expect(fields.startDate).toBe('2026-07-03')
    expect(wrapper.text()).toContain('下一次：2027年6月23日（公历）')

    await wrapper.get('select[aria-label="农历日期"]').setValue('20')
    expect(fields.dateRule).toMatchObject({ calendar: 'chinese', lunarDay: 20 })
    await wrapper.get('.event-date-calendar-toggle button[aria-pressed="false"]').trigger('click')
    await nextTick()
    expect(fields.dateRule).toEqual({ calendar: 'gregory' })
    expect(fields.startDate).toBe('2026-07-04')
    expect(fields.endDate).toBe('2026-07-04')
    expect(fields.title).toBe(event.title)
    expect(fields.description).toBe(event.description)
    expect(fields.showCountdown).toBe(event.showCountdown)
    wrapper.unmount()
  })

  it('keeps lunar selection unavailable for event combinations the recurrence engine does not support', () => {
    const { wrapper } = mountEventForm()
    expect(wrapper.get('.event-date-calendar-toggle button[aria-pressed="false"]:disabled').text()).toBe('农历')
    expect(wrapper.text()).toContain('农历重复仅支持全天、单日且每年重复的事件。')
    wrapper.unmount()
  })
})
