// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref, type Ref } from 'vue'
import { NInput, NSelect, NTimePicker } from 'naive-ui'
import { lunarToSolar, nextLunarOccurrence, solarToLunar, type ChineseEventDateRule } from '../../../../shared/lunarCalendar'
import { nextOccurrence, parseEvent, type EventFields } from '../../../../shared/diaryLife'
import { useConfirm } from '../../../composables/useConfirm'
import DiaryDatePicker from '../DiaryDatePicker.vue'
import DiaryEventForm from '../DiaryEventForm.vue'

const gregorianEvent: EventFields = {
  title: '大学毕业',
  description: '和家人一起庆祝',
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
  legacySchedule = false,
) {
  const fields: Ref<EventFields> = ref(structuredClone(initialFields))
  const Host = defineComponent({
    setup() {
      return () => h(DiaryEventForm, {
        modelValue: fields.value,
        today,
        isEditing,
        legacySchedule,
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

function visibleControls(wrapper: VueWrapper, component: typeof DiaryDatePicker | typeof NTimePicker) {
  return wrapper.findAllComponents(component).filter(({ element }) => {
    const advanced = element.closest('details')
    return !advanced || advanced.open
  })
}

function getControl(wrapper: VueWrapper, component: typeof DiaryDatePicker | typeof NInput | typeof NSelect | typeof NTimePicker, label: string) {
  return wrapper.findAllComponents(component).find(control => {
    if (component === DiaryDatePicker) return (control.props() as Record<string, unknown>).label === label
    if (component === NInput) return ((control.props() as Record<string, unknown>).inputProps as Record<string, unknown> | undefined)?.['aria-label'] === label
    return control.attributes('aria-label') === label
  })!
}

function getProp(control: ReturnType<typeof getControl>, name: string) {
  return (control.props() as Record<string, unknown>)[name]
}

describe('DiaryEventForm', () => {
  it('shows only the essential single date fields for a milestone', () => {
    const { wrapper } = mountEventForm()

    expect(wrapper.findAll('[data-testid^="event-type-"]')).toHaveLength(4)
    expect(wrapper.text()).not.toContain('重要日程')
    expect(wrapper.get('[aria-label="事件名称"]').element).toBeTruthy()
    expect(getProp(getControl(wrapper, NInput, '事件名称'), 'placeholder')).toBe('例如：买下第一套房')
    expect(wrapper.get('[aria-label="事件备注"]').element).toBeTruthy()
    expect(visibleControls(wrapper, DiaryDatePicker)).toHaveLength(1)
    expect(getProp(getControl(wrapper, DiaryDatePicker, '发生日期'), 'modelValue')).toBe('2026-07-03')
    expect(visibleControls(wrapper, NTimePicker)).toHaveLength(0)
    expect(wrapper.find('.event-advanced').attributes('open')).toBeUndefined()
    expect(wrapper.get('.event-advanced summary').text()).toContain('更多选项')
    wrapper.unmount()
  })

  it('creates an open-ended life period without recurrence, time, or countdown controls', async () => {
    const { wrapper, fields } = mountEventForm()
    await wrapper.get('[data-testid="event-type-period"]').trigger('click')

    expect(fields.value).toMatchObject({
      type: 'period', emoji: '💼', startDate: '2026-07-03', endDate: null,
      recurrence: 'none', allDay: true, startTime: null, endTime: null, showCountdown: false,
    })
    expect(getProp(getControl(wrapper, DiaryDatePicker, '结束日期'), 'modelValue')).toBeNull()
    expect(getProp(getControl(wrapper, DiaryDatePicker, '结束日期'), 'placeholder')).toBe('未结束')
    expect(getProp(getControl(wrapper, DiaryDatePicker, '结束日期'), 'clearable')).toBe(true)
    expect(wrapper.find('.event-date-section h2').exists()).toBe(false)
    expect(visibleControls(wrapper, DiaryDatePicker)).toHaveLength(2)
    expect(visibleControls(wrapper, NTimePicker)).toHaveLength(0)
    expect(wrapper.text()).not.toContain('显示倒数日')
    expect(parseEvent(fields.value)).not.toBeNull()

    await getControl(wrapper, DiaryDatePicker, '结束日期').vm.$emit('update:modelValue', '2027-07-03')
    expect(parseEvent(fields.value)?.endDate).toBe('2027-07-03')
    await getControl(wrapper, DiaryDatePicker, '结束日期').vm.$emit('update:modelValue', null)
    expect(fields.value.endDate).toBeNull()
    expect(parseEvent(fields.value)).not.toBeNull()
    wrapper.unmount()
  })

  it('requires confirmation before converting an open or long Life Period to a bounded Event type', async () => {
    const period: EventFields = {
      ...gregorianEvent,
      type: 'period',
      emoji: '💼',
      endDate: null,
      recurrence: 'none',
      showCountdown: false,
    }
    const { wrapper, fields } = mountEventForm(period, '2026-11-16', true)

    await wrapper.get('[data-testid="event-type-milestone"]').trigger('click')
    const openEndedPrompt = await answerPendingConfirm(false)
    expect(openEndedPrompt.detail).toContain('未结束状态')
    expect(fields.value).toMatchObject({ type: 'period', endDate: null })

    await wrapper.get('[data-testid="event-type-milestone"]').trigger('click')
    await answerPendingConfirm(true)
    expect(fields.value).toMatchObject({ type: 'milestone', startDate: '2026-07-03', endDate: '2026-07-03' })
    expect(parseEvent(fields.value)).not.toBeNull()

    wrapper.unmount()

    const longPeriod = { ...period, endDate: '2028-01-01' }
    const longWrapper = mountEventForm(longPeriod, '2026-11-16', true)
    await longWrapper.wrapper.get('[data-testid="event-type-milestone"]').trigger('click')
    const longRangePrompt = await answerPendingConfirm(false)
    expect(longRangePrompt.detail).toContain('超过 366 天')
    expect(longWrapper.fields.value).toMatchObject({ type: 'period', endDate: '2028-01-01' })
    longWrapper.wrapper.unmount()
  })

  it('preserves a meaningful bounded date range when converting an Event to a Life Period', async () => {
    const { wrapper, fields } = mountEventForm({
      ...gregorianEvent,
      type: 'milestone',
      startDate: '2025-01-01',
      endDate: '2025-12-31',
      recurrence: 'yearly',
    }, '2026-11-16', true)

    await wrapper.get('[data-testid="event-type-period"]').trigger('click')
    await answerPendingConfirm(true)
    expect(fields.value).toMatchObject({
      type: 'period', startDate: '2025-01-01', endDate: '2025-12-31',
      recurrence: 'none', allDay: true, startTime: null, endTime: null, showCountdown: false,
    })
    expect(parseEvent(fields.value)).not.toBeNull()
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
    expect(visibleControls(wrapper, DiaryDatePicker)).toHaveLength(1)
    expect(wrapper.text()).toContain('每年重复')
    expect(wrapper.find('[aria-label="出生年份"]').exists()).toBe(false)
    expect(wrapper.find('[aria-label="农历月份类型"]').exists()).toBe(false)
    expect(getProp(getControl(wrapper, NInput, '事件名称'), 'placeholder')).toBe('例如：结婚纪念日')
    wrapper.unmount()
  })

  it('combines regular and leap lunar anniversary months while preserving the recurrence rule', async () => {
    const date = lunarToSolar({ year: 2023, month: 2, day: 1, isLeapMonth: true })!
    const rule: ChineseEventDateRule = {
      calendar: 'chinese', lunarMonth: 2, lunarDay: 1, isLeapMonth: true,
      leapMonthPolicy: 'leap-only', shortMonthPolicy: 'skip',
    }
    const { wrapper, fields } = mountEventForm({
      ...gregorianEvent,
      type: 'anniversary',
      title: '重要纪念日',
      startDate: date,
      endDate: date,
      recurrence: 'yearly',
      dateRule: rule,
    }, '2023-03-01', true)
    const month = getControl(wrapper, NSelect, '农历月份')
    const options = getProp(month, 'options') as Array<{ value: string; label: string; disabled?: boolean }>

    expect(getProp(month, 'value')).toBe('leap:2')
    expect(options).toContainEqual(expect.objectContaining({ value: 'regular:2', label: '二月' }))
    expect(options).toContainEqual(expect.objectContaining({ value: 'leap:2', label: '闰二月' }))
    expect(wrapper.find('[aria-label="农历月份类型"]').exists()).toBe(false)

    await month.vm.$emit('update:value', 'regular:2')
    expect(fields.value.dateRule).toMatchObject({ lunarMonth: 2, isLeapMonth: false, leapMonthPolicy: 'leap-only', shortMonthPolicy: 'skip' })
    await month.vm.$emit('update:value', 'leap:2')
    expect(fields.value.dateRule).toEqual(rule)
    expect(parseEvent(fields.value)).not.toBeNull()
    wrapper.unmount()
  })

  it('uses type-specific event placeholders and aligns milestone default Emoji without overwriting custom Emoji', async () => {
    const defaultEvent: EventFields = { ...gregorianEvent, type: 'milestone', emoji: '🎓' }
    const defaultForm = mountEventForm(defaultEvent)
    expect(defaultForm.wrapper.get('[data-testid="event-type-milestone"]').attributes('aria-pressed')).toBe('true')
    expect(defaultForm.fields.value.emoji).toBe('🎓')
    expect(defaultForm.wrapper.get('[aria-label="选择事件 Emoji"] img').attributes('src')).toBe('/emoji/event-graduation.svg')
    await defaultForm.wrapper.get('[data-testid="event-type-anniversary"]').trigger('click')
    expect(getProp(getControl(defaultForm.wrapper, NInput, '事件名称'), 'placeholder')).toBe('例如：结婚纪念日')
    await defaultForm.wrapper.get('[data-testid="event-type-period"]').trigger('click')
    await answerPendingConfirm(true)
    expect(getProp(getControl(defaultForm.wrapper, NInput, '事件名称'), 'placeholder')).toBe('例如：第一份工作')
    await defaultForm.wrapper.get('[data-testid="event-type-birthday"]').trigger('click')
    await answerPendingConfirm(true)
    expect(getProp(getControl(defaultForm.wrapper, NInput, '生日称呼'), 'placeholder')).toBeUndefined()
    defaultForm.wrapper.unmount()

    const customForm = mountEventForm({ ...defaultEvent, emoji: '🎯' })
    await customForm.wrapper.get('[data-testid="event-type-period"]').trigger('click')
    expect(customForm.fields.value.emoji).toBe('🎯')
    customForm.wrapper.unmount()
  })

  it('renders lunar birthday fields and computes its next age-aware occurrence', () => {
    const { wrapper, fields } = mountEventForm(birthdayEvent())

    expect(wrapper.get('[aria-label="生日称呼"]').element).toBeTruthy()
    expect(wrapper.get('[aria-label="出生年份"]').element).toBeTruthy()
    expect(wrapper.get('[aria-label="农历月份"]').element).toBeTruthy()
    expect(wrapper.get('[aria-label="农历日期"]').element).toBeTruthy()
    expect(wrapper.find('[aria-label="出生月份类型"]').exists()).toBe(false)
    expect(wrapper.get('[aria-label="生日历法"]').text()).toContain('公历')
    expect(visibleControls(wrapper, DiaryDatePicker)).toHaveLength(0)
    expect(visibleControls(wrapper, NTimePicker)).toHaveLength(0)
    expect(wrapper.find('[aria-label="农历月份类型"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('每年重复')
    expect(wrapper.text()).toContain('下一次：')
    expect(wrapper.text()).toContain('岁生日')
    expect(parseEvent(fields.value)).not.toBeNull()
    wrapper.unmount()
  })

  it('validates birthday years and keeps the generated occurrence valid', async () => {
    const { wrapper, fields } = mountEventForm(birthdayEvent())
    const birthYear = wrapper.get('[aria-label="出生年份"]')

    await birthYear.setValue('1800')
    expect(wrapper.get('[role="alert"]').text()).toContain('1901—2100')
    expect(parseEvent(fields.value)).toBeNull()

    await birthYear.setValue('1952')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(fields.value.birthday && 'birthLunarYear' in fields.value.birthday && fields.value.birthday.birthLunarYear).toBe(1952)
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
    const shortLunarDays = getProp(getControl(shortForm.wrapper, NSelect, '农历日期'), 'options') as Array<{ value: number; disabled?: boolean }>
    const birthdayMonths = getProp(getControl(shortForm.wrapper, NSelect, '农历月份'), 'options') as Array<{ value: string; disabled?: boolean }>
    expect(shortLunarDays.find(option => option.value === 30)?.disabled).toBe(true)
    const listedLeapMonths = birthdayMonths.filter(option => option.value.startsWith('leap:'))
    expect(listedLeapMonths.length).toBeLessThanOrEqual(1)
    expect(listedLeapMonths.every(option => {
      const month = Number(option.value.split(':')[1])
      return lunarToSolar({ year: shortBirth!.year, month, day: 1, isLeapMonth: true }) !== null
    })).toBe(true)
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
    const leapMonths = getProp(getControl(leapForm.wrapper, NSelect, '农历月份'), 'options') as Array<{ value: string; label: string; disabled?: boolean }>
    expect(leapMonths.filter(option => option.value.startsWith('leap:'))).toEqual([
      expect.objectContaining({ value: `leap:${leapBirth!.month}`, label: expect.stringContaining('闰') }),
    ])
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
    expect(getProp(getControl(wrapper, NSelect, '农历月份'), 'value')).toBe('regular:5')

    await getControl(wrapper, NSelect, '农历日期').vm.$emit('update:value', 20)
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

  it('switches a birthday between calendars without changing its actual birth date', async () => {
    const initial = birthdayEvent()
    const { wrapper, fields } = mountEventForm(initial)
    const calendar = wrapper.get('[aria-label="生日历法"]')

    await calendar.findAll('button').find(button => button.text() === '公历')!.trigger('click')
    expect(fields.value.dateRule).toEqual({ calendar: 'gregory' })
    expect(fields.value.startDate).toBe(initial.startDate)
    expect(fields.value.birthday).toEqual({ birthGregorianYear: Number(initial.startDate.slice(0, 4)) })
    expect(getProp(getControl(wrapper, DiaryDatePicker, '出生日期'), 'modelValue')).toBe(initial.startDate)
    expect(parseEvent(fields.value)).not.toBeNull()

    await calendar.findAll('button').find(button => button.text() === '农历')!.trigger('click')
    expect(fields.value.startDate).toBe(initial.startDate)
    expect(fields.value.dateRule).toEqual(initial.dateRule)
    expect(fields.value.birthday).toEqual(initial.birthday)
    expect(parseEvent(fields.value)).not.toBeNull()
    wrapper.unmount()
  })

  it('uses the Gregorian date picker for leap-day birthdays and previews the constrained annual date', async () => {
    const { wrapper, fields } = mountEventForm({
      ...gregorianEvent,
      title: '小明',
      type: 'birthday',
      startDate: '2000-02-29',
      endDate: '2000-02-29',
      recurrence: 'yearly',
      dateRule: { calendar: 'gregory' },
      birthday: { birthGregorianYear: 2000 },
    }, '2026-01-01')

    expect(visibleControls(wrapper, DiaryDatePicker)).toHaveLength(1)
    expect(wrapper.text()).toContain('下一次：2026年2月28日 · 小明26岁生日')
    expect(parseEvent(fields.value)).not.toBeNull()
    wrapper.unmount()
  })

  it('leaves a new lunar birthday year, month, and day blank instead of inferring them from the selected calendar date', async () => {
    const { wrapper, fields } = mountEventForm({ ...gregorianEvent, startDate: '2026-11-19', endDate: '2026-11-19' })
    await wrapper.get('[data-testid="event-type-birthday"]').trigger('click')

    expect(wrapper.get('[aria-label="出生年份"]').element).toBeTruthy()
    expect((wrapper.get('[aria-label="出生年份"]').element as HTMLInputElement).value).toBe('')
    expect(getProp(getControl(wrapper, NSelect, '农历月份'), 'value')).toBeNull()
    expect(getProp(getControl(wrapper, NSelect, '农历日期'), 'value')).toBeNull()
    expect(fields.value.birthday).toBeUndefined()
    expect(wrapper.text()).not.toContain('填写出生日期后显示下一次生日')
    expect(fields.value.startDate).not.toBe('')
    expect(parseEvent(fields.value)).toBeNull()
    wrapper.unmount()
  })

  it('keeps milestone editing to one date without schedule-only controls', async () => {
    const { wrapper } = mountEventForm()
    const advanced = wrapper.get('.event-advanced')
    await advanced.get('summary').trigger('click')

    expect(visibleControls(wrapper, DiaryDatePicker)).toHaveLength(1)
    expect(visibleControls(wrapper, NTimePicker)).toHaveLength(0)
    expect(advanced.text()).not.toContain('结束日期')
    expect(advanced.text()).not.toContain('开始时间')
    expect(advanced.text()).not.toContain('结束时间')
    expect(advanced.text()).not.toContain('全天')
    expect(advanced.text()).not.toContain('每年重复')
    wrapper.unmount()
  })

  it('requires explicit conversion before a legacy schedule can be saved', async () => {
    const initial: EventFields = {
      ...gregorianEvent,
      title: '家庭旅行',
      type: 'milestone',
      startDate: '1951-11-04',
      endDate: '1951-11-05',
      startTime: '09:00',
      endTime: '20:00',
      allDay: false,
      recurrence: 'yearly',
    }
    const { wrapper, fields } = mountEventForm(initial, '2026-11-16', true, true)
    const form = wrapper.getComponent(DiaryEventForm)
    const validate = () => (form.vm as unknown as { $: { exposed: { validate: () => boolean } } }).$.exposed.validate()

    expect(wrapper.text()).toContain('这条记录来自旧版重要日程')
    expect(validate()).toBe(false)
    expect(visibleControls(wrapper, DiaryDatePicker)).toHaveLength(1)
    expect(visibleControls(wrapper, NTimePicker)).toHaveLength(0)

    await wrapper.get('[data-testid="event-type-milestone"]').trigger('click')
    const request = await answerPendingConfirm(false)
    expect(request.message).toBe('转换旧日程？')
    expect(request.detail).toContain('名称、开始日期、备注和 Emoji 会保留')
    expect(fields.value).toEqual(initial)
    expect(validate()).toBe(false)

    await wrapper.get('[data-testid="event-type-milestone"]').trigger('click')
    await answerPendingConfirm(true)
    expect(fields.value).toMatchObject({
      type: 'milestone', startDate: '1951-11-04', endDate: '1951-11-04',
      startTime: null, endTime: null, allDay: true, recurrence: 'none',
    })
    expect(validate()).toBe(true)
    expect(parseEvent(fields.value)).not.toBeNull()
    wrapper.unmount()
  })

  it('normalizes a confirmed switch to birthday and preserves an existing event emoji and display settings', async () => {
    const initial: EventFields = {
      ...gregorianEvent,
      title: '爷爷生日',
      emoji: '💼',
      type: 'milestone',
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
    expect(fields.value.birthday).toBeUndefined()
    expect(fields.value.startDate).toBe('1951-11-04')
    expect(fields.value.endDate).toBe(fields.value.startDate)
    expect(fields.value.startTime).toBeNull()
    expect(fields.value.endTime).toBeNull()
    expect(fields.value.allDay).toBe(true)
    expect(fields.value.recurrence).toBe('yearly')
    expect(fields.value.emoji).toBe('💼')
    expect(fields.value.showCountdown).toBe(false)
    expect(parseEvent(fields.value)).toBeNull()
    await wrapper.get('[aria-label="出生年份"]').setValue('1951')
    expect(fields.value.birthday).toEqual({ birthLunarYear: 1951 })
    expect(parseEvent(fields.value)).not.toBeNull()
    wrapper.unmount()
  })

  it('protects a lunar anniversary when switching to a milestone and uses the edited Gregorian date', async () => {
    const target = 'milestone'
    const dateLabel = '发生日期'
    const { birthday: _birth, ...annual } = birthdayEvent()
    const initial: EventFields = {
      ...annual,
      type: 'anniversary',
      title: '结婚纪念日',
      startDate: '2026-01-01',
      endDate: '2026-01-01',
    }
    const { wrapper, fields } = mountEventForm(initial, '2026-11-16', true)
    const baseDate = nextOccurrence(initial, initial.startDate)
    expect(baseDate).toBe('2026-11-15')
    expect(wrapper.findComponent(DiaryDatePicker).exists()).toBe(false)
    const targetButton = wrapper.get(`[data-testid="event-type-${target}"]`)

    await targetButton.trigger('click')
    const request = await answerPendingConfirm(false)
    expect(request.detail).toContain('农历重复规则')
    expect(request.detail).toContain(baseDate)
    expect(fields.value).toEqual(initial)

    await targetButton.trigger('click')
    await answerPendingConfirm(true)
    expect(fields.value).toMatchObject({
      type: target, startDate: baseDate, endDate: baseDate, dateRule: { calendar: 'gregory' }, recurrence: 'none',
    })
    const date = getControl(wrapper, DiaryDatePicker, dateLabel)
    expect(getProp(date, 'modelValue')).toBe(baseDate)
    await date.vm.$emit('update:modelValue', '2026-11-14')
    const saved = parseEvent(fields.value)
    expect(saved).toMatchObject({ dateRule: { calendar: 'gregory' }, startDate: '2026-11-14', endDate: '2026-11-14', recurrence: 'none' })
    expect(saved && nextOccurrence(saved, '2027-01-01')).toBeNull()
    wrapper.unmount()
  })

  it('preserves the lunar rule and annual recurrence when removing birthday age information', async () => {
    const initial = birthdayEvent()
    const { wrapper, fields } = mountEventForm(initial, '2026-11-16', true)
    const button = wrapper.get('[data-testid="event-type-anniversary"]')
    await button.trigger('click')
    const request = await answerPendingConfirm(true)
    expect(request.detail).toContain('出生年份和生日年龄信息')
    expect(request.detail).not.toContain('农历年度规则')
    expect(fields.value.birthday).toBeUndefined()
    expect(fields.value).toMatchObject({
      type: 'anniversary', startDate: initial.startDate, dateRule: initial.dateRule, recurrence: 'yearly',
    })
    expect(parseEvent(fields.value)).not.toBeNull()
    wrapper.unmount()
  })

  it('does not infer the birth year and preserves the selected lunar leap month', async () => {
    const birth = { year: 2023, month: 2, day: 1, isLeapMonth: true }
    const date = lunarToSolar(birth)!
    expect(solarToLunar(date)).toEqual(birth)
    const { wrapper, fields } = mountEventForm({
      ...gregorianEvent, title: '小明', startDate: date, endDate: date,
    }, '2026-01-01', true)
    await wrapper.get('[data-testid="event-type-birthday"]').trigger('click')
    expect(fields.value).toMatchObject({ startDate: date, dateRule: { calendar: 'chinese', lunarMonth: 2, lunarDay: 1, isLeapMonth: true } })
    expect(fields.value.birthday).toBeUndefined()
    await wrapper.get('[aria-label="出生年份"]').setValue('2023')
    expect(fields.value.birthday).toEqual({ birthLunarYear: 2023 })
    expect(wrapper.text()).toContain('小明3岁生日')
    expect(parseEvent(fields.value)).not.toBeNull()
    wrapper.unmount()
  })

  it('cancels an open type confirmation when the editor is torn down', async () => {
    const initial = birthdayEvent()
    const { wrapper, fields } = mountEventForm(initial)
    await wrapper.get('[data-testid="event-type-milestone"]').trigger('click')
    expect(useConfirm().queue.value).toHaveLength(1)
    wrapper.unmount()
    await flushPromises()
    expect(useConfirm().queue.value).toHaveLength(0)
    expect(fields.value).toEqual(initial)
  })

  it('requires confirmation before removing a birthday rule, and preserves all fields on cancel', async () => {
    const initial = birthdayEvent()
    const { wrapper, fields } = mountEventForm(initial, '2026-11-16', true)

    await wrapper.get('[data-testid="event-type-milestone"]').trigger('click')
    const request = await answerPendingConfirm(false)
    expect(request.detail).toContain('出生年份和生日年龄信息')
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
