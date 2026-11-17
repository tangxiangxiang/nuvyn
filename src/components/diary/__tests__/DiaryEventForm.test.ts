// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref, type Ref } from 'vue'
import { lunarToSolar, nextLunarOccurrence, type ChineseEventDateRule } from '../../../../shared/lunarCalendar'
import { parseEvent, type EventFields } from '../../../../shared/diaryLife'
import { useConfirm } from '../../../composables/useConfirm'
import DiaryEventForm from '../DiaryEventForm.vue'

const gregorianEvent: EventFields = {
  title: '大学毕业',
  description: '和家人一起庆祝',
  emoji: '🎯',
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
}

function birthdayEvent(overrides: Partial<EventFields> = {}): EventFields {
  const rule: ChineseEventDateRule = {
    calendar: 'chinese',
    lunarMonth: 10,
    lunarDay: 7,
    isLeapMonth: false,
    leapMonthPolicy: 'regular-month',
    shortMonthPolicy: 'last-day',
  }
  const startDate = lunarToSolar({ year: 1951, month: rule.lunarMonth, day: rule.lunarDay, isLeapMonth: false })
  if (!startDate) throw new Error('Fixture birthday date must be valid')
  return {
    ...gregorianEvent,
    title: '爷爷',
    emoji: '🎂',
    type: 'birthday',
    startDate,
    endDate: startDate,
    dateRule: rule,
    recurrence: 'yearly',
    showCountdown: true,
    birthday: { birthLunarYear: 1951 },
    ...overrides,
  }
}

function mountEventForm(
  initialFields: EventFields = gregorianEvent,
  today = '2026-11-16',
  isEditing = false,
) {
  const fields: Ref<EventFields> = ref(structuredClone(initialFields))
  const Host = defineComponent({
    setup() {
      return () => h(DiaryEventForm, {
        modelValue: fields.value,
        today,
        isEditing,
        'onUpdate:modelValue': (next: EventFields) => { fields.value = next },
      })
    },
  })
  const wrapper = mount(Host)
  return { wrapper, fields }
}

async function answerPendingConfirm(answer: boolean) {
  await vi.waitFor(() => expect(useConfirm().queue.value.length).toBeGreaterThan(0))
  const request = useConfirm().queue.value.at(-1)!
  useConfirm().answer(request.id, answer)
  await flushPromises()
  await nextTick()
  return request
}

function visibleControls(wrapper: VueWrapper, selector: string) {
  return wrapper.findAll(selector).filter(({ element }) => {
    const advanced = element.closest('details')
    return !advanced || advanced.open
  })
}

describe('DiaryEventForm', () => {
  it('shows only the essential single date fields for a milestone', () => {
    const { wrapper } = mountEventForm()

    expect(wrapper.findAll('[data-testid^="event-type-"]')).toHaveLength(4)
    expect(wrapper.get('[aria-label="事件名称"]').element).toBeTruthy()
    expect(wrapper.get('[aria-label="事件备注"]').element).toBeTruthy()
    expect(visibleControls(wrapper, 'input[type="date"]')).toHaveLength(1)
    expect(wrapper.get('input[type="date"]').attributes('aria-label')).toBe('发生日期')
    expect(visibleControls(wrapper, 'input[type="time"]')).toHaveLength(0)
    expect(wrapper.find('.event-advanced').attributes('open')).toBeUndefined()
    expect(wrapper.get('.event-advanced summary').text()).toContain('更多选项')
    wrapper.unmount()
  })

  it('shows schedule ranges and reveals time fields only when the event is not all-day', async () => {
    const { wrapper, fields } = mountEventForm({
      ...gregorianEvent,
      type: 'schedule',
      title: '家庭旅行',
      endDate: '2026-07-05',
    })

    expect(visibleControls(wrapper, 'input[type="date"]')).toHaveLength(2)
    expect(visibleControls(wrapper, 'input[type="time"]')).toHaveLength(0)
    await wrapper.get('.event-date-section .n-checkbox').trigger('click')
    expect(fields.value.allDay).toBe(false)
    await nextTick()
    expect(visibleControls(wrapper, 'input[type="time"]')).toHaveLength(2)
    expect((wrapper.get('input[aria-label="开始时间"]').element as HTMLInputElement).value).toBe('')
    wrapper.unmount()
  })

  it('shows anniversary calendar and yearly repeat controls without birthday fields', () => {
    const { wrapper } = mountEventForm({
      ...gregorianEvent,
      type: 'anniversary',
      title: '结婚纪念日',
      recurrence: 'yearly',
    })

    expect(wrapper.get('[aria-label="纪念日期"]').element).toBeTruthy()
    expect(wrapper.get('[aria-label="日期类型"]').text()).toContain('公历')
    expect(wrapper.get('[aria-label="日期类型"]').text()).toContain('农历')
    expect(visibleControls(wrapper, 'input[type="date"]')).toHaveLength(1)
    expect(wrapper.text()).toContain('每年重复')
    expect(wrapper.find('[aria-label="出生农历年"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('renders lunar birthday fields and computes its next age-aware occurrence', () => {
    const { wrapper, fields } = mountEventForm(birthdayEvent())

    expect(wrapper.get('[aria-label="生日称呼"]').element).toBeTruthy()
    expect(wrapper.get('[aria-label="出生农历年"]').element).toBeTruthy()
    expect(wrapper.get('[aria-label="农历月份"]').element).toBeTruthy()
    expect(wrapper.get('[aria-label="农历日期"]').element).toBeTruthy()
    expect(wrapper.get('[aria-label="出生月份类型"]').element).toBeTruthy()
    expect(visibleControls(wrapper, 'input[type="date"]')).toHaveLength(0)
    expect(visibleControls(wrapper, 'input[type="time"]')).toHaveLength(0)
    expect(wrapper.text()).not.toContain('每年重复')
    expect(wrapper.text()).toContain('下一次：')
    expect(wrapper.text()).toContain('岁生日')
    expect(parseEvent(fields.value)).not.toBeNull()
    wrapper.unmount()
  })

  it('validates birthday years and keeps the generated occurrence valid', async () => {
    const { wrapper, fields } = mountEventForm(birthdayEvent())
    const birthYear = wrapper.get('[aria-label="出生农历年"]')

    await birthYear.setValue('1800')
    expect(wrapper.get('[role="alert"]').text()).toContain('1901—2100')
    expect(parseEvent(fields.value)).toBeNull()

    await birthYear.setValue('1952')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(fields.value.birthday?.birthLunarYear).toBe(1952)
    expect(fields.value.startDate).toBe(lunarToSolar({ year: 1952, month: 10, day: 7, isLeapMonth: false }))
    expect(fields.value.recurrence).toBe('yearly')
    expect(fields.value.allDay).toBe(true)
    expect(parseEvent(fields.value)).not.toBeNull()
    wrapper.unmount()
  })

  it('exposes the existing lunar leap-month and short-month policies only in advanced options', async () => {
    let leapBirth: { year: number; month: number; day: number } | undefined
    let dayThirtyBirth: { year: number; month: number } | undefined
    for (let year = 1901; year <= 2100 && (!leapBirth || !dayThirtyBirth); year++) {
      for (let month = 1; month <= 12; month++) {
        if (!leapBirth && lunarToSolar({ year, month, day: 1, isLeapMonth: true })) {
          leapBirth = { year, month, day: 1 }
        }
        if (!dayThirtyBirth && lunarToSolar({ year, month, day: 30, isLeapMonth: false })) {
          dayThirtyBirth = { year, month }
        }
      }
    }
    expect(leapBirth).toBeDefined()
    expect(dayThirtyBirth).toBeDefined()

    const leapRule: ChineseEventDateRule = {
      calendar: 'chinese',
      lunarMonth: leapBirth!.month,
      lunarDay: leapBirth!.day,
      isLeapMonth: true,
      leapMonthPolicy: 'regular-month',
      shortMonthPolicy: 'last-day',
    }
    const leapDate = lunarToSolar({ year: leapBirth!.year, month: leapRule.lunarMonth, day: leapRule.lunarDay, isLeapMonth: true })!
    const leapForm = mountEventForm(birthdayEvent({
      startDate: leapDate,
      endDate: leapDate,
      dateRule: leapRule,
      birthday: { birthLunarYear: leapBirth!.year },
    }))
    expect(leapForm.wrapper.find('.event-advanced').attributes('open')).toBeUndefined()
    await leapForm.wrapper.get('.event-advanced summary').trigger('click')
    expect(leapForm.wrapper.get('[aria-label="缺少闰月时"]').element).toBeTruthy()
    leapForm.wrapper.unmount()

    const shortRule: ChineseEventDateRule = {
      calendar: 'chinese',
      lunarMonth: dayThirtyBirth!.month,
      lunarDay: 30,
      isLeapMonth: false,
      leapMonthPolicy: 'regular-month',
      shortMonthPolicy: 'last-day',
    }
    const shortDate = lunarToSolar({ year: dayThirtyBirth!.year, month: shortRule.lunarMonth, day: 30, isLeapMonth: false })!
    const shortForm = mountEventForm(birthdayEvent({
      startDate: shortDate,
      endDate: shortDate,
      dateRule: shortRule,
      birthday: { birthLunarYear: dayThirtyBirth!.year },
    }))
    await shortForm.wrapper.get('.event-advanced summary').trigger('click')
    expect(shortForm.wrapper.get('[aria-label="小月处理方式"]').element).toBeTruthy()
    shortForm.wrapper.unmount()
  })

  it('disables birthday lunar dates that are invalid for the entered birth year and month', () => {
    let shortBirth: { year: number; month: number } | undefined
    let leapBirth: { year: number; month: number } | undefined
    for (let year = 1901; year <= 2100 && (!shortBirth || !leapBirth); year++) {
      for (let month = 1; month <= 12; month++) {
        if (!shortBirth && lunarToSolar({ year, month, day: 29, isLeapMonth: false })
          && !lunarToSolar({ year, month, day: 30, isLeapMonth: false })
          && !lunarToSolar({ year, month, day: 29, isLeapMonth: true })) {
          shortBirth = { year, month }
        }
        if (!leapBirth && lunarToSolar({ year, month, day: 1, isLeapMonth: true })) {
          leapBirth = { year, month }
        }
      }
    }
    expect(shortBirth).toBeDefined()
    expect(leapBirth).toBeDefined()

    const shortRule: ChineseEventDateRule = {
      calendar: 'chinese',
      lunarMonth: shortBirth!.month,
      lunarDay: 29,
      isLeapMonth: false,
      leapMonthPolicy: 'regular-month',
      shortMonthPolicy: 'last-day',
    }
    const shortDate = lunarToSolar({ year: shortBirth!.year, month: shortRule.lunarMonth, day: 29, isLeapMonth: false })!
    const shortForm = mountEventForm(birthdayEvent({
      startDate: shortDate,
      endDate: shortDate,
      dateRule: shortRule,
      birthday: { birthLunarYear: shortBirth!.year },
    }))
    expect((shortForm.wrapper.get('select[aria-label="农历日期"] option[value="30"]').element as HTMLOptionElement).disabled).toBe(true)
    expect((shortForm.wrapper.get('select[aria-label="出生月份类型"] option[value="leap"]').element as HTMLOptionElement).disabled).toBe(true)
    expect(parseEvent(shortForm.fields.value)).not.toBeNull()
    shortForm.wrapper.unmount()

    const leapRule: ChineseEventDateRule = {
      calendar: 'chinese',
      lunarMonth: leapBirth!.month,
      lunarDay: 1,
      isLeapMonth: true,
      leapMonthPolicy: 'regular-month',
      shortMonthPolicy: 'last-day',
    }
    const leapDate = lunarToSolar({ year: leapBirth!.year, month: leapRule.lunarMonth, day: 1, isLeapMonth: true })!
    const leapForm = mountEventForm(birthdayEvent({
      startDate: leapDate,
      endDate: leapDate,
      dateRule: leapRule,
      birthday: { birthLunarYear: leapBirth!.year },
    }))
    expect(leapForm.wrapper.findAll('select[aria-label="农历月份"] option[disabled]').length).toBeGreaterThan(0)
    expect(parseEvent(leapForm.fields.value)).not.toBeNull()
    leapForm.wrapper.unmount()
  })

  it('converts an eligible annual anniversary between Gregorian and lunar dates while preserving shared fields', async () => {
    const initial: EventFields = {
      ...gregorianEvent,
      type: 'anniversary',
      title: '结婚纪念日',
      startDate: '2026-07-03',
      endDate: '2026-07-03',
      recurrence: 'yearly',
      showCountdown: true,
    }
    const { wrapper, fields } = mountEventForm(initial)
    await wrapper.get('.event-date-calendar-toggle button[aria-pressed="false"]:not(:disabled)').trigger('click')

    expect(fields.value.dateRule).toEqual({
      calendar: 'chinese',
      lunarMonth: 5,
      lunarDay: 19,
      isLeapMonth: false,
      leapMonthPolicy: 'regular-month',
      shortMonthPolicy: 'last-day',
    })
    expect(fields.value.startDate).toBe(initial.startDate)
    expect(wrapper.text()).toContain('下一次：')

    await wrapper.get('select[aria-label="农历日期"]').setValue('20')
    const convertedDate = fields.value.dateRule?.calendar === 'chinese'
      ? nextLunarOccurrence(fields.value.dateRule, initial.startDate)
      : null
    await wrapper.get('.event-date-calendar-toggle button[aria-pressed="false"]').trigger('click')
    expect(fields.value.dateRule).toEqual({ calendar: 'gregory' })
    expect(fields.value.startDate).toBe(convertedDate)
    expect(fields.value.endDate).toBe(convertedDate)
    expect(fields.value.title).toBe(initial.title)
    expect(fields.value.description).toBe(initial.description)
    expect(fields.value.showCountdown).toBe(initial.showCountdown)
    expect(parseEvent(fields.value)).not.toBeNull()
    wrapper.unmount()
  })

  it('keeps legacy duration and time values accessible without losing them when advanced options are collapsed', async () => {
    const initial: EventFields = {
      ...gregorianEvent,
      type: 'milestone',
      startDate: '2026-07-03',
      endDate: '2026-07-05',
      startTime: '18:30',
      endTime: '20:00',
      allDay: false,
      recurrence: 'yearly',
      showCountdown: true,
      isPrimary: true,
    }
    const { wrapper, fields } = mountEventForm(initial, '2026-01-01', true)
    const advanced = wrapper.get('.event-advanced')
    expect(advanced.attributes('open')).toBeUndefined()
    expect(visibleControls(wrapper, 'input[type="date"]')).toHaveLength(1)
    expect(visibleControls(wrapper, 'input[type="time"]')).toHaveLength(0)

    await advanced.get('summary').trigger('click')
    expect(advanced.attributes('open')).toBeDefined()
    expect(visibleControls(wrapper, 'input[type="date"]')).toHaveLength(2)
    expect((wrapper.get('input[aria-label="结束日期"]').element as HTMLInputElement).value).toBe('2026-07-05')
    expect((wrapper.get('input[aria-label="开始时间"]').element as HTMLInputElement).value).toBe('18:30')
    expect((wrapper.get('input[aria-label="结束时间"]').element as HTMLInputElement).value).toBe('20:00')
    expect(wrapper.get('.event-advanced').text()).toContain('每年重复')

    await advanced.get('summary').trigger('click')
    expect(advanced.attributes('open')).toBeUndefined()
    expect(fields.value).toEqual(initial)
    wrapper.unmount()
  })

  it('leaves a schedule unchanged when canceling a type switch that would discard its range and times', async () => {
    const initial: EventFields = {
      ...gregorianEvent,
      title: '家庭旅行',
      type: 'schedule',
      startDate: '1951-11-04',
      endDate: '1951-11-05',
      startTime: '09:00',
      endTime: '20:00',
      allDay: false,
    }
    const { wrapper, fields } = mountEventForm(initial, '2026-11-16', true)

    await wrapper.get('[data-testid="event-type-birthday"]').trigger('click')
    const request = await answerPendingConfirm(false)
    expect(request.message).toBe('切换事件类型？')
    expect(request.detail).toContain('结束日期和持续天数')
    expect(request.detail).toContain('开始、结束时间')
    expect(fields.value).toEqual(initial)
    wrapper.unmount()
  })

  it('normalizes a confirmed switch to birthday and preserves an existing event emoji and display settings', async () => {
    const initial: EventFields = {
      ...gregorianEvent,
      title: '爷爷生日',
      emoji: '💼',
      type: 'schedule',
      startDate: '1951-11-04',
      endDate: '1951-11-05',
      startTime: '09:00',
      endTime: '20:00',
      allDay: false,
      recurrence: 'none',
      showCountdown: false,
    }
    const { wrapper, fields } = mountEventForm(initial, '2026-11-16', true)

    await wrapper.get('[data-testid="event-type-birthday"]').trigger('click')
    await answerPendingConfirm(true)

    expect(fields.value.type).toBe('birthday')
    expect(fields.value.birthday?.birthLunarYear).toBe(1951)
    expect(fields.value.startDate).toBe('1951-11-04')
    expect(fields.value.endDate).toBe(fields.value.startDate)
    expect(fields.value.startTime).toBeNull()
    expect(fields.value.endTime).toBeNull()
    expect(fields.value.allDay).toBe(true)
    expect(fields.value.recurrence).toBe('yearly')
    expect(fields.value.emoji).toBe('💼')
    expect(fields.value.showCountdown).toBe(false)
    expect(parseEvent(fields.value)).not.toBeNull()
    wrapper.unmount()
  })

  it('requires confirmation before removing a birthday rule, and preserves all fields on cancel', async () => {
    const initial = birthdayEvent()
    const { wrapper, fields } = mountEventForm(initial, '2026-11-16', true)

    await wrapper.get('[data-testid="event-type-milestone"]').trigger('click')
    const request = await answerPendingConfirm(false)
    expect(request.detail).toContain('出生农历年和生日年龄信息')
    expect(request.detail).toContain('生日对应的农历年度规则')
    expect(fields.value).toEqual(initial)

    await wrapper.get('[data-testid="event-type-milestone"]').trigger('click')
    await answerPendingConfirm(true)
    expect(fields.value.type).toBe('milestone')
    expect(fields.value.birthday).toBeUndefined()
    expect(fields.value.dateRule).toEqual({ calendar: 'gregory' })
    expect(fields.value.recurrence).toBe('none')
    expect(parseEvent(fields.value)).not.toBeNull()
    wrapper.unmount()
  })
})
