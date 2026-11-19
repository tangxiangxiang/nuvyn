<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { NCheckbox, NDatePicker, NInput, NPopover, NSelect, NTimePicker } from 'naive-ui'
import { lunarDayLabel, lunarMonthLabel, lunarToSolar, nextLunarOccurrence, solarToLunar, type ChineseEventDateRule, type EventDateRule } from '../../../shared/lunarCalendar'
import { birthdayAgeAt, birthdayPersonName, civilDate, displayEventTitle, nextOccurrence, type EventFields } from '../../../shared/diaryLife'
import { useConfirm } from '../../composables/useConfirm'
import { EVENT_EMOJI, eventEmojiSource } from '../../features/diary/eventEmoji'

const value = defineModel<EventFields>({ required: true })
const props = defineProps<{ today: string; isEditing?: boolean }>()
const { confirmCancellable } = useConfirm()
let cancelTypeSwitch: (() => void) | undefined
onBeforeUnmount(() => {
  cancelTypeSwitch?.()
  cancelTypeSwitch = undefined
})
const calendarError = ref('')
const emojiPickerOpen = ref(false)
const typeSwitchPending = ref(false)
const dateRule = computed<EventDateRule>(() => value.value.dateRule ?? { calendar: 'gregory' })
const chineseRule = computed(() => dateRule.value.calendar === 'chinese' ? dateRule.value : null)
const isBirthday = computed(() => value.value.type === 'birthday')
const isAnniversary = computed(() => value.value.type === 'anniversary')
const isMilestone = computed(() => value.value.type === 'milestone')
const isSchedule = computed(() => value.value.type === 'schedule')
const birthdayLunarMonthSelection = ref<string | null>(isBirthday.value && chineseRule.value
  ? `${chineseRule.value.isLeapMonth ? 'leap' : 'regular'}:${chineseRule.value.lunarMonth}`
  : null)
const birthdayLunarDaySelection = ref<number | null>(isBirthday.value && chineseRule.value ? chineseRule.value.lunarDay : null)
const selectedBirthdayLunarMonth = computed(() => {
  const match = /^(regular|leap):(\d{1,2})$/.exec(birthdayLunarMonthSelection.value ?? '')
  return match ? { lunarMonth: Number(match[2]), isLeapMonth: match[1] === 'leap' } : null
})
const titleInput = computed({
  get: () => isBirthday.value ? birthdayPersonName(value.value.title) : value.value.title,
  set: (title: string) => { value.value.title = title },
})
const canUseLunar = computed(() => value.value.recurrence === 'yearly' && value.value.allDay
  && value.value.startTime === null && value.value.endTime === null
  && value.value.startDate === value.value.endDate && solarToLunar(value.value.startDate) !== null)
const birthdayLunarDraft = ref<{
  dateRule: ChineseEventDateRule
  birthday?: { birthLunarYear: number }
  startDate: string
  lunarMonthSelection: string | null
  lunarDaySelection: number | null
} | null>(null)
const canSwitchBirthdayToLunar = computed(() => dateRule.value.calendar === 'gregory'
  && (Boolean(value.value.startDate && solarToLunar(value.value.startDate)) || (!value.value.startDate && birthdayLunarDraft.value !== null)))
const birthdayDateIsValid = computed(() => {
  if (!isBirthday.value) return true
  if (chineseRule.value) {
    if (birthdayLunarMonthSelection.value === null || birthdayLunarDaySelection.value === null) return false
    const birthLunarYear = value.value.birthday && 'birthLunarYear' in value.value.birthday
      ? value.value.birthday.birthLunarYear
      : null
    if (!Number.isInteger(birthLunarYear) || birthLunarYear! < 1901 || birthLunarYear! > 2100) return false
    const birthDate = lunarToSolar({
      year: birthLunarYear!, month: chineseRule.value.lunarMonth, day: chineseRule.value.lunarDay,
      isLeapMonth: chineseRule.value.isLeapMonth,
    })
    return Boolean(birthDate && birthDate === value.value.startDate && birthDate === value.value.endDate)
  }
  const birthGregorianYear = value.value.birthday && 'birthGregorianYear' in value.value.birthday
    ? value.value.birthday.birthGregorianYear
    : null
  return Number.isInteger(birthGregorianYear) && civilDate(value.value.startDate)
    && value.value.startDate === value.value.endDate
    && Number(value.value.startDate.slice(0, 4)) === birthGregorianYear
})
const hasExtendedDateFields = computed(() => value.value.endDate !== value.value.startDate
  || !value.value.allDay || value.value.startTime !== null || value.value.endTime !== null)
const dateRangeError = computed(() => value.value.endDate < value.value.startDate ? '结束日期不能早于开始日期。' : '')
const startTimeError = computed(() => {
  if (!isSchedule.value || value.value.allDay) return ''
  if (value.value.startTime === null && value.value.endTime !== null) return '请先设置开始时间。'
  if (value.value.startTime === null && !props.isEditing) return '非全天日程请填写开始时间。'
  return ''
})
const endTimeError = computed(() => {
  if (!isSchedule.value || value.value.allDay) return ''
  if (value.value.startDate === value.value.endDate && value.value.startTime && value.value.endTime
    && value.value.endTime <= value.value.startTime) return '同一天的结束时间必须晚于开始时间。'
  return ''
})
const lunarMonthOptions = Array.from({ length: 12 }, (_, index) => ({ value: index + 1, label: lunarMonthLabel(index + 1) }))
const lunarDayOptions = Array.from({ length: 30 }, (_, index) => ({ value: index + 1, label: lunarDayLabel(index + 1) }))
const birthdayLunarMonthOptions = computed(() => {
  const selectedDay = birthdayLunarDaySelection.value ?? 1
  const year = value.value.birthday && 'birthLunarYear' in value.value.birthday
    ? value.value.birthday.birthLunarYear
    : null
  const options = lunarMonthOptions.map(option => ({
    value: `regular:${option.value}`,
    label: option.label,
    disabled: !isValidBirthdayDate(selectedDay, false, option.value),
  }))
  if (Number.isInteger(year) && year! >= 1901 && year! <= 2100) {
    const leapMonth = Array.from({ length: 12 }, (_, index) => index + 1)
      .find(month => lunarToSolar({ year: year!, month, day: 1, isLeapMonth: true }) !== null)
    if (leapMonth) {
      options.splice(leapMonth, 0, {
        value: `leap:${leapMonth}`,
        label: `闰${lunarMonthLabel(leapMonth)}`,
        disabled: !isValidBirthdayDate(selectedDay, true, leapMonth),
      })
    }
  }
  if (chineseRule.value?.isLeapMonth
    && !options.some(option => option.value === `leap:${chineseRule.value?.lunarMonth}`)) {
    options.push({
      value: `leap:${chineseRule.value.lunarMonth}`,
      label: `闰${lunarMonthLabel(chineseRule.value.lunarMonth)}`,
      disabled: true,
    })
  }
  return options
})
const birthdayLunarDayOptions = computed(() => {
  const month = selectedBirthdayLunarMonth.value
  return lunarDayOptions.map(option => ({
    ...option,
    disabled: month ? !isValidBirthdayDate(option.value, month.isLeapMonth, month.lunarMonth) : false,
  }))
})
const lunarMonthTypeOptions = computed(() => [
  { value: 'regular', label: `普通${lunarMonthLabel(chineseRule.value?.lunarMonth ?? 1)}` },
  { value: 'leap', label: `闰${lunarMonthLabel(chineseRule.value?.lunarMonth ?? 1)}` },
])
const leapMonthPolicyOptions = computed(() => [
  { value: 'regular-month', label: `按普通${lunarMonthLabel(chineseRule.value?.lunarMonth ?? 1)}` },
  { value: 'leap-only', label: '跳过该年，只在闰月出现' },
])
const shortMonthPolicyOptions = [
  { value: 'last-day', label: '按当月最后一天' },
  { value: 'skip', label: '跳过该年' },
]
const scheduleStartTimestamp = computed(() => {
  const [year, month, day] = value.value.startDate.split('-').map(Number)
  return new Date(year!, month! - 1, day!).getTime()
})
const isBeforeScheduleStart = (timestamp: number) => timestamp < scheduleStartTimestamp.value
const eventTypes: Array<{ value: EventFields['type']; label: string; icon: string; defaultEmoji: string }> = [
  { value: 'birthday', label: '生日', icon: 'birthday', defaultEmoji: '🎂' },
  { value: 'anniversary', label: '纪念日', icon: 'ring', defaultEmoji: '💍' },
  { value: 'milestone', label: '人生时刻', icon: 'graduation', defaultEmoji: '🎯' },
  { value: 'schedule', label: '重要日程', icon: 'work', defaultEmoji: '💼' },
]
const lunarPreviewDate = computed(() => {
  if (!chineseRule.value) return null
  const fromDate = props.today > value.value.startDate ? props.today : value.value.startDate
  return nextLunarOccurrence(chineseRule.value, fromDate)
})
const birthdayPreview = computed(() => {
  if (!isBirthday.value || !birthdayDateIsValid.value) return null
  const date = nextOccurrence(value.value, props.today)
  const age = date ? birthdayAgeAt(value.value, date) : null
  return date && age !== null ? { date, title: displayEventTitle(value.value, date) } : null
})
const title = computed(() => isBirthday.value ? '生日' : isAnniversary.value ? '纪念日' : isMilestone.value ? '人生时刻' : '重要日程')
const gregorianDateLabel = computed(() => isBirthday.value ? '出生日期' : isAnniversary.value ? '纪念日期' : isMilestone.value ? '发生日期' : '日期')
const emojiSource = computed(() => eventEmojiSource(value.value.emoji))

defineExpose({
  validate: () => validateForm(),
})

function validateForm(): boolean {
  if (isBirthday.value && !birthdayDateIsValid.value && !calendarError.value) {
    calendarError.value = chineseRule.value ? '请填写有效的农历出生日期。' : '请选择有效的公历出生日期。'
  }
  return !calendarError.value && !dateRangeError.value && !startTimeError.value && !endTimeError.value
    && birthdayDateIsValid.value
}

function defaultLunarRule(lunarDate: NonNullable<ReturnType<typeof solarToLunar>>): ChineseEventDateRule {
  return {
    calendar: 'chinese',
    lunarMonth: lunarDate.month,
    lunarDay: lunarDate.day,
    isLeapMonth: lunarDate.isLeapMonth,
    leapMonthPolicy: 'regular-month',
    shortMonthPolicy: 'last-day',
  }
}

function formatGregorianDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  return year + '年' + month + '月' + day + '日'
}

function updateStartDate(date: string | null) {
  const nextDate = date ?? ''
  const wasSingleDay = value.value.startDate === value.value.endDate
  value.value.startDate = nextDate
  if (nextDate && (wasSingleDay || value.value.endDate < nextDate)) value.value.endDate = nextDate
}

function updateEndDate(date: string | null) {
  value.value.endDate = date ?? ''
}

function updateLunarMonth(month: string | number | null) {
  if (month !== null) updateChineseRule({ lunarMonth: Number(month) })
}

function updateLunarDay(day: string | number | null) {
  if (day !== null) updateChineseRule({ lunarDay: Number(day) })
}

function updateLunarMonthType(type: string | number | null) {
  if (type === 'regular' || type === 'leap') updateChineseRule({ isLeapMonth: type === 'leap' })
}

function updateLeapMonthPolicy(policy: string | number | null) {
  if (policy === 'regular-month' || policy === 'leap-only') {
    updateChineseRule({ leapMonthPolicy: policy as ChineseEventDateRule['leapMonthPolicy'] })
  }
}

function updateShortMonthPolicy(policy: string | number | null) {
  if (policy === 'last-day' || policy === 'skip') {
    updateChineseRule({ shortMonthPolicy: policy as ChineseEventDateRule['shortMonthPolicy'] })
  }
}

function typeSwitchLosses(target: EventFields['type']): string[] {
  const losses: string[] = []
  if (value.value.type === 'birthday' && target !== 'birthday' && value.value.birthday) {
    losses.push('出生年份和生日年龄信息')
  }
  const collapsesToSingleDay = target === 'birthday' || target === 'anniversary'
  if (collapsesToSingleDay && value.value.endDate !== value.value.startDate) losses.push('结束日期和持续天数')
  if (collapsesToSingleDay && (!value.value.allDay || value.value.startTime !== null || value.value.endTime !== null)) {
    losses.push('全天设置和开始、结束时间')
  }
  return losses
}

async function setEventType(rawType: string) {
  if (typeSwitchPending.value || !eventTypes.some(option => option.value === rawType)) return
  const targetType = rawType as EventFields['type']
  const previous = value.value
  if (targetType === previous.type) return

  calendarError.value = ''
  birthdayLunarDraft.value = null
  const losses = typeSwitchLosses(targetType)
  const changes: string[] = []
  const previousType = eventTypes.find(option => option.value === previous.type)!
  const target = eventTypes.find(option => option.value === targetType)!
  const next: EventFields = { ...previous, type: targetType }
  const previousRule = previous.dateRule?.calendar === 'chinese' ? previous.dateRule : null
  // The stored date is the lower bound for lunar recurrence, not necessarily an occurrence.
  const lunarBaseDate = previousRule && targetType !== 'anniversary' ? nextLunarOccurrence(previousRule, previous.startDate) : null

  if (targetType === 'birthday') {
    const birthdayDate = lunarBaseDate ?? previous.startDate
    const birth = solarToLunar(birthdayDate)
    const rule = previousRule ?? (birth ? defaultLunarRule(birth) : {
      calendar: 'chinese' as const,
      lunarMonth: 1,
      lunarDay: 1,
      isLeapMonth: false,
      leapMonthPolicy: 'regular-month' as const,
      shortMonthPolicy: 'last-day' as const,
    })
    next.title = birthdayPersonName(previous.title)
    delete next.birthday
    next.dateRule = rule
    next.startDate = birth ? birthdayDate : ''
    next.endDate = next.startDate
    next.startTime = null
    next.endTime = null
    next.allDay = true
    next.recurrence = 'yearly'
  } else {
    delete next.birthday
    if (previous.type === 'birthday') next.title = birthdayPersonName(previous.title)
    if (targetType === 'anniversary') {
      next.endDate = next.startDate
      next.startTime = null
      next.endTime = null
      next.allDay = true
      if (previousRule || !props.isEditing) next.recurrence = 'yearly'
    } else if (previousRule) {
      const baseDate = lunarBaseDate ?? previous.startDate
      next.dateRule = { calendar: 'gregory' }
      next.startDate = baseDate
      next.endDate = baseDate
      if (previous.type === 'birthday') {
        losses.push('生日对应的农历年度规则')
        next.recurrence = 'none'
      }
      changes.push(lunarBaseDate
        ? `公历基准日期为 ${baseDate}`
        : `农历规则在支持范围内无发生日期，将使用原公历基准日期 ${baseDate}`)
      if (previous.type !== 'birthday') losses.push('农历重复规则')
      changes.push(next.recurrence === 'yearly' ? '按公历每年重复' : '不再每年重复')
    }
  }

  if (losses.length || changes.length) {
    typeSwitchPending.value = true
    const detail = [
      ...(losses.length ? ['继续后将清除：' + losses.join('、')] : []),
      ...changes,
      '取消会保留当前表单内容',
    ].join('。') + '。'
    const pending = confirmCancellable('切换事件类型？', detail)
    cancelTypeSwitch = pending.cancel
    try {
      if (!await pending.promise || cancelTypeSwitch !== pending.cancel || value.value !== previous) return
    } finally {
      typeSwitchPending.value = false
      cancelTypeSwitch = undefined
    }
  }

  if (!props.isEditing && previous.emoji === previousType.defaultEmoji) next.emoji = target.defaultEmoji
  if (!props.isEditing) next.showCountdown = targetType === 'birthday' || targetType === 'anniversary'
  if (targetType === 'birthday' && next.dateRule?.calendar === 'chinese') {
    if (props.isEditing || previousRule) {
      birthdayLunarMonthSelection.value = `${next.dateRule.isLeapMonth ? 'leap' : 'regular'}:${next.dateRule.lunarMonth}`
      birthdayLunarDaySelection.value = next.dateRule.lunarDay
    } else {
      birthdayLunarMonthSelection.value = null
      birthdayLunarDaySelection.value = null
    }
  } else if (previous.type === 'birthday') {
    birthdayLunarMonthSelection.value = null
    birthdayLunarDaySelection.value = null
  }
  value.value = next
}

function syncBirthdayDate() {
  if (!isBirthday.value || !chineseRule.value) return
  if (birthdayLunarMonthSelection.value === null || birthdayLunarDaySelection.value === null) {
    calendarError.value = ''
    return
  }
  const birthLunarYear = value.value.birthday && 'birthLunarYear' in value.value.birthday
    ? value.value.birthday.birthLunarYear
    : null
  if (birthLunarYear === null) {
    calendarError.value = ''
    return
  }
  if (!Number.isInteger(birthLunarYear) || birthLunarYear! < 1901 || birthLunarYear! > 2100) {
    calendarError.value = '出生农历年需在 1901—2100 年之间。'
    return
  }
  const rule = chineseRule.value
  const birthDate = lunarToSolar({
    year: birthLunarYear!,
    month: rule.lunarMonth,
    day: rule.lunarDay,
    isLeapMonth: rule.isLeapMonth,
  })
  if (!birthDate) {
    calendarError.value = '该年份没有对应的农历生日，请检查出生年份、月份或日期。'
    return
  }
  calendarError.value = ''
  value.value.startDate = birthDate
  value.value.endDate = birthDate
  value.value.recurrence = 'yearly'
  value.value.allDay = true
  value.value.startTime = null
  value.value.endTime = null
}

function updateBirthLunarYear(raw: string) {
  calendarError.value = ''
  if (raw === '') delete value.value.birthday
  else value.value.birthday = { birthLunarYear: Number(raw) }
  syncBirthdayDate()
}

function updateBirthdayLunarMonth(value: string | number | null) {
  if (value === null) {
    birthdayLunarMonthSelection.value = null
    calendarError.value = ''
    return
  }
  const match = /^(regular|leap):(\d{1,2})$/.exec(String(value))
  if (!match) return
  birthdayLunarMonthSelection.value = `${match[1]}:${Number(match[2])}`
  updateChineseRule({ lunarMonth: Number(match[2]), isLeapMonth: match[1] === 'leap' })
}

function updateBirthdayLunarDay(value: string | number | null) {
  if (value === null) {
    birthdayLunarDaySelection.value = null
    calendarError.value = ''
    return
  }
  birthdayLunarDaySelection.value = Number(value)
  updateChineseRule({ lunarDay: Number(value) })
}

function updateGregorianBirthdayDate(date: string | null) {
  calendarError.value = ''
  const nextDate = date ?? ''
  value.value.startDate = nextDate
  value.value.endDate = nextDate
  if (civilDate(nextDate)) value.value.birthday = { birthGregorianYear: Number(nextDate.slice(0, 4)) }
  else delete value.value.birthday
  value.value.recurrence = 'yearly'
  value.value.allDay = true
  value.value.startTime = null
  value.value.endTime = null
}

function isValidBirthdayDate(
  day: number,
  isLeapMonth = chineseRule.value?.isLeapMonth ?? false,
  lunarMonth = chineseRule.value?.lunarMonth ?? 0,
): boolean {
  const rule = chineseRule.value
  const birthLunarYear = value.value.birthday && 'birthLunarYear' in value.value.birthday
    ? value.value.birthday.birthLunarYear
    : null
  if (!rule || lunarMonth < 1) return false
  if (!Number.isInteger(birthLunarYear) || birthLunarYear! < 1901 || birthLunarYear! > 2100) return true
  return lunarToSolar({ year: birthLunarYear!, month: lunarMonth, day, isLeapMonth }) !== null
}

function setCalendar(calendar: 'gregory' | 'chinese') {
  calendarError.value = ''
  if (calendar === dateRule.value.calendar) return
  if (isBirthday.value) {
    if (calendar === 'gregory') {
      const lunarBirthYear = value.value.birthday && 'birthLunarYear' in value.value.birthday
        ? value.value.birthday.birthLunarYear
        : null
      const birthDate = chineseRule.value && birthdayLunarMonthSelection.value !== null
        && birthdayLunarDaySelection.value !== null && Number.isInteger(lunarBirthYear)
        ? lunarToSolar({ year: lunarBirthYear!, month: chineseRule.value.lunarMonth, day: chineseRule.value.lunarDay, isLeapMonth: chineseRule.value.isLeapMonth })
        : null
      birthdayLunarDraft.value = {
        dateRule: chineseRule.value ? { ...chineseRule.value } : {
          calendar: 'chinese', lunarMonth: 1, lunarDay: 1, isLeapMonth: false,
          leapMonthPolicy: 'regular-month', shortMonthPolicy: 'last-day',
        },
        ...(Number.isInteger(lunarBirthYear) ? { birthday: { birthLunarYear: lunarBirthYear! } } : {}),
        startDate: birthDate ?? '',
        lunarMonthSelection: birthdayLunarMonthSelection.value,
        lunarDaySelection: birthdayLunarDaySelection.value,
      }
      value.value.dateRule = { calendar: 'gregory' }
      value.value.startDate = birthDate ?? ''
      value.value.endDate = value.value.startDate
      if (birthDate) value.value.birthday = { birthGregorianYear: Number(birthDate.slice(0, 4)) }
      else delete value.value.birthday
      return
    }

    if (!value.value.startDate) {
      const previous = birthdayLunarDraft.value
      if (previous) {
        value.value.dateRule = { ...previous.dateRule }
        value.value.startDate = previous.startDate
        value.value.endDate = previous.startDate
        birthdayLunarMonthSelection.value = previous.lunarMonthSelection
        birthdayLunarDaySelection.value = previous.lunarDaySelection
        if (previous.birthday) value.value.birthday = { ...previous.birthday }
        else delete value.value.birthday
        return
      }
      calendarError.value = '请选择公历出生日期后再切换为农历。'
      return
    }
    const lunarDate = solarToLunar(value.value.startDate)
    if (!lunarDate) {
      calendarError.value = '农历生日仅支持 1901—2100 年范围内的有效公历日期。'
      return
    }
    const prior = birthdayLunarDraft.value
    const priorDate = prior ? lunarToSolar({
      year: lunarDate.year, month: prior.dateRule.lunarMonth, day: prior.dateRule.lunarDay,
      isLeapMonth: prior.dateRule.isLeapMonth,
    }) : null
    const restorePriorSelections = Boolean(prior && priorDate === value.value.startDate
      && (prior.startDate !== '' || prior.lunarMonthSelection !== null || prior.lunarDaySelection !== null))
    const rule = restorePriorSelections
      ? { ...prior!.dateRule }
      : defaultLunarRule(lunarDate)
    value.value.dateRule = rule
    value.value.endDate = value.value.startDate
    value.value.birthday = { birthLunarYear: lunarDate.year }
    birthdayLunarMonthSelection.value = restorePriorSelections
      ? prior!.lunarMonthSelection
      : `${rule.isLeapMonth ? 'leap' : 'regular'}:${rule.lunarMonth}`
    birthdayLunarDaySelection.value = restorePriorSelections ? prior!.lunarDaySelection : rule.lunarDay
    birthdayLunarDraft.value = null
    return
  }
  if (calendar === 'chinese') {
    if (!canUseLunar.value) {
      calendarError.value = '农历重复仅支持全天、单日且每年重复的事件。'
      return
    }
    const lunarDate = solarToLunar(value.value.startDate)
    if (!lunarDate) {
      calendarError.value = '农历日期仅支持 1901—2100 年的公历日期。'
      return
    }
    value.value.dateRule = defaultLunarRule(lunarDate)
    return
  }

  const rule = chineseRule.value
  if (!rule) return
  const convertedDate = nextLunarOccurrence(rule, value.value.startDate)
  if (!convertedDate) {
    calendarError.value = '当前农历规则在支持范围内没有可转换的公历日期。'
    return
  }
  value.value.startDate = convertedDate
  value.value.endDate = convertedDate
  value.value.dateRule = { calendar: 'gregory' }
}

function updateChineseRule(updates: Partial<ChineseEventDateRule>) {
  if (!chineseRule.value) return
  calendarError.value = ''
  const updatedRule = { ...chineseRule.value, ...updates }
  value.value.dateRule = updatedRule
  if (isBirthday.value) {
    syncBirthdayDate()
  }
}
</script>

<template>
  <div class="event-fields" data-testid="diary-event-form">
    <div class="event-type-picker" role="group" aria-label="事件类型">
      <button
        v-for="option in eventTypes"
        :key="option.value"
        type="button"
        :data-testid="'event-type-' + option.value"
        :aria-pressed="value.type === option.value"
        :disabled="typeSwitchPending"
        @click="setEventType(option.value)"
      >
        <img :src="'/emoji/event-' + option.icon + '.svg'" alt="">
        <span>{{ option.label }}</span>
      </button>
    </div>

    <label class="event-field event-title-field">
      <span>{{ isBirthday ? '称呼' : '事件名称' }}</span>
      <NInput
        v-model:value="titleInput"
        :input-props="{ 'aria-label': isBirthday ? '生日称呼' : '事件名称' }"
        :placeholder="isBirthday ? undefined : '值得记住的事'"
        :maxlength="160"
      />
    </label>

    <p v-if="calendarError" class="event-date-error" role="alert">{{ calendarError }}</p>
    <p v-if="dateRangeError && !isSchedule" class="event-date-error" role="alert">{{ dateRangeError }}</p>

    <section class="event-date-section" :aria-label="title + '日期'">
      <div v-if="(!isSchedule && !isMilestone) || chineseRule" class="event-date-heading">
        <h2 v-if="!isSchedule">{{ isBirthday ? '出生日期' : isAnniversary ? '纪念日期' : '发生日期' }}</h2>
        <div v-if="isBirthday || isAnniversary || chineseRule" class="event-date-calendar-toggle" role="group" :aria-label="isBirthday ? '生日历法' : '日期类型'">
          <template v-if="isBirthday">
            <button type="button" :aria-pressed="dateRule.calendar === 'chinese'" :disabled="dateRule.calendar !== 'chinese' && !canSwitchBirthdayToLunar" @click="setCalendar('chinese')">农历</button>
            <button type="button" :aria-pressed="dateRule.calendar === 'gregory'" @click="setCalendar('gregory')">公历</button>
          </template>
          <template v-else>
            <button type="button" :aria-pressed="dateRule.calendar === 'gregory'" @click="setCalendar('gregory')">公历</button>
            <button type="button" :aria-pressed="dateRule.calendar === 'chinese'" :disabled="dateRule.calendar !== 'chinese' && !canUseLunar" @click="setCalendar('chinese')">农历</button>
          </template>
        </div>
      </div>

      <div v-if="isBirthday && chineseRule" class="event-dates event-birthday-dates">
        <label class="event-field">
          <span>出生年份</span>
          <input
            :value="value.birthday && 'birthLunarYear' in value.birthday ? value.birthday.birthLunarYear : ''"
            type="number"
            min="1901"
            max="2100"
            step="1"
            required
            aria-label="出生年份"
            @input="updateBirthLunarYear(($event.target as HTMLInputElement).value)"
          >
        </label>
        <label class="event-field">
          <span>农历月份</span>
          <NSelect
            :value="birthdayLunarMonthSelection"
            :options="birthdayLunarMonthOptions"
            placeholder="请选择月份"
            clearable
            aria-label="农历月份"
            @update:value="updateBirthdayLunarMonth"
          />
        </label>
        <label class="event-field">
          <span>农历日期</span>
          <NSelect
            :value="birthdayLunarDaySelection"
            :options="birthdayLunarDayOptions"
            placeholder="请选择日期"
            clearable
            aria-label="农历日期"
            @update:value="updateBirthdayLunarDay"
          />
        </label>
      </div>

      <label v-else-if="isBirthday" class="event-field">
        <span>出生日期</span>
        <NDatePicker
          :formatted-value="value.startDate || null"
          class="event-date-picker"
          type="date"
          format="yyyy-MM-dd"
          value-format="yyyy-MM-dd"
          aria-label="出生日期"
          clearable
          @update:formatted-value="updateGregorianBirthdayDate"
        />
      </label>
      <div v-if="!isBirthday && chineseRule" class="event-dates event-lunar-dates">
        <label class="event-field">
          <span>农历月份</span>
          <NSelect :value="chineseRule.lunarMonth" :options="lunarMonthOptions" aria-label="农历月份" @update:value="updateLunarMonth" />
        </label>
        <label class="event-field">
          <span>农历日期</span>
          <NSelect :value="chineseRule.lunarDay" :options="lunarDayOptions" aria-label="农历日期" @update:value="updateLunarDay" />
        </label>
        <label class="event-field event-lunar-month-type">
          <span>月份类型</span>
          <NSelect :value="chineseRule.isLeapMonth ? 'leap' : 'regular'" :options="lunarMonthTypeOptions" aria-label="农历月份类型" @update:value="updateLunarMonthType" />
        </label>
      </div>

      <div v-else-if="isSchedule" class="event-dates">
        <label class="event-field">
          <span>开始日期</span>
          <NDatePicker
            :formatted-value="value.startDate"
            class="event-date-picker"
            type="date"
            format="yyyy-MM-dd"
            value-format="yyyy-MM-dd"
            aria-label="开始日期"
            :status="dateRangeError ? 'error' : undefined"
            @update:formatted-value="updateStartDate"
          />
        </label>
        <label class="event-field">
          <span>结束日期</span>
          <NDatePicker
            :formatted-value="value.endDate"
            class="event-date-picker"
            type="date"
            format="yyyy-MM-dd"
            value-format="yyyy-MM-dd"
            aria-label="结束日期"
            :status="dateRangeError ? 'error' : undefined"
            :is-date-disabled="isBeforeScheduleStart"
            @update:formatted-value="updateEndDate"
          />
          <small v-if="dateRangeError" id="event-end-date-error" class="event-date-error" role="alert">{{ dateRangeError }}</small>
        </label>
      </div>

      <label v-else-if="!isBirthday" class="event-field">
        <span>{{ gregorianDateLabel }}</span>
        <NDatePicker
          :formatted-value="value.startDate"
          class="event-date-picker"
          type="date"
          format="yyyy-MM-dd"
          value-format="yyyy-MM-dd"
          :aria-label="gregorianDateLabel"
          @update:formatted-value="updateStartDate"
        />
      </label>

      <p v-if="isBirthday && dateRule.calendar === 'gregory' && value.startDate && !solarToLunar(value.startDate)" class="event-date-help">此日期仍可作为公历生日保存，超出农历换算范围时不能切换为农历。</p>

      <p v-if="isBirthday && birthdayPreview" class="event-date-preview" aria-live="polite">
        下一次：{{ formatGregorianDate(birthdayPreview.date) }} · {{ birthdayPreview.title }}
      </p>
      <p v-else-if="!isBirthday && chineseRule" class="event-date-preview" aria-live="polite">
        <template v-if="lunarPreviewDate">下一次：{{ formatGregorianDate(lunarPreviewDate) }}（公历）</template>
        <template v-else>支持范围内暂无下一次日期</template>
      </p>

      <NCheckbox v-if="isAnniversary && !chineseRule" :checked="value.recurrence === 'yearly'" @update:checked="value.recurrence = $event ? 'yearly' : 'none'">每年重复</NCheckbox>
      <NCheckbox v-if="isSchedule && !chineseRule" v-model:checked="value.allDay">全天</NCheckbox>
      <p v-if="isSchedule && value.allDay && (value.startTime || value.endTime)" class="event-date-help">保存为全天日程后会清除已有时间。</p>
      <div v-if="isSchedule && !chineseRule && !value.allDay" class="event-dates">
        <label class="event-field">
          <span>开始时间</span>
          <NTimePicker
            :formatted-value="value.startTime"
            class="event-time-picker"
            format="HH:mm"
            value-format="HH:mm"
            aria-label="开始时间"
            clearable
            :required="!isEditing ? true : undefined"
            :status="startTimeError ? 'error' : undefined"
            @update:formatted-value="value.startTime = $event"
          />
          <small v-if="startTimeError" id="event-start-time-error" class="event-date-error" role="alert">{{ startTimeError }}</small>
        </label>
        <label class="event-field">
          <span>结束时间</span>
          <NTimePicker
            :formatted-value="value.endTime"
            class="event-time-picker"
            format="HH:mm"
            value-format="HH:mm"
            aria-label="结束时间"
            clearable
            :status="endTimeError ? 'error' : undefined"
            @update:formatted-value="value.endTime = $event"
          />
          <small v-if="endTimeError" id="event-end-time-error" class="event-date-error" role="alert">{{ endTimeError }}</small>
        </label>
      </div>

      <p v-if="isAnniversary && dateRule.calendar === 'gregory' && !canUseLunar" class="event-date-help">农历纪念日仅支持全天、单日且每年重复的事件。</p>
    </section>

    <label class="event-field event-description-field">
      <span>备注 <small>可选</small></span>
      <NInput
        v-model:value="value.description"
        type="textarea"
        :input-props="{ 'aria-label': '事件备注' }"
        placeholder="记下这一刻"
        :maxlength="4000"
        :autosize="{ minRows: 2, maxRows: 5 }"
      />
    </label>

    <details class="event-advanced">
      <summary>
        <span>更多选项</span>
        <span class="event-advanced-chevron" aria-hidden="true"></span>
      </summary>
      <div class="event-advanced-content">
        <div class="event-emoji-setting">
          <span>自定义 Emoji</span>
          <NPopover v-model:show="emojiPickerOpen" trigger="click" placement="bottom-start" :show-arrow="false" raw>
            <template #trigger>
              <button
                type="button"
                class="event-emoji-trigger"
                aria-label="选择事件 Emoji"
                aria-haspopup="true"
                :aria-expanded="emojiPickerOpen"
              >
                <img v-if="emojiSource" :src="emojiSource" alt="">
                <span v-else aria-hidden="true">{{ value.emoji }}</span>
              </button>
            </template>
            <div class="event-emoji-picker" role="group" aria-label="可选 Emoji">
              <button
                v-for="icon in EVENT_EMOJI"
                :key="icon.asset"
                type="button"
                :aria-label="icon.name"
                :aria-pressed="value.emoji === icon.glyph"
                @click="value.emoji = icon.glyph; emojiPickerOpen = false"
              >
                <img :src="'/emoji/event-' + icon.asset + '.svg'" alt="">
              </button>
            </div>
          </NPopover>
        </div>
        <div v-if="!isBirthday && !isAnniversary && !chineseRule" class="event-date-calendar-toggle" role="group" aria-label="日期类型">
          <button type="button" :aria-pressed="dateRule.calendar === 'gregory'" @click="setCalendar('gregory')">公历</button>
          <button type="button" :aria-pressed="dateRule.calendar === 'chinese'" :disabled="dateRule.calendar !== 'chinese' && !canUseLunar" @click="setCalendar('chinese')">农历</button>
        </div>
        <p v-if="!isBirthday && dateRule.calendar === 'gregory' && !canUseLunar" class="event-date-help">农历重复仅支持全天、单日且每年重复的事件。</p>

        <NCheckbox v-if="isMilestone || isSchedule" :checked="value.recurrence === 'yearly'" :disabled="dateRule.calendar === 'chinese'" @update:checked="value.recurrence = $event ? 'yearly' : 'none'">每年重复</NCheckbox>
        <NCheckbox v-model:checked="value.showCountdown">显示倒数日</NCheckbox>
        <NCheckbox v-model:checked="value.isPrimary">优先显示此事件</NCheckbox>

        <template v-if="!isBirthday && !isSchedule && hasExtendedDateFields">
          <p class="event-date-help">保留此事件已有的持续日期和时间设置，可在这里继续编辑。</p>
          <label v-if="value.endDate !== value.startDate" class="event-field">
            <span>结束日期</span>
            <NDatePicker
              :formatted-value="value.endDate"
              class="event-date-picker"
              type="date"
              format="yyyy-MM-dd"
              value-format="yyyy-MM-dd"
              aria-label="结束日期"
              :is-date-disabled="isBeforeScheduleStart"
              @update:formatted-value="updateEndDate"
            />
          </label>
          <NCheckbox v-if="!isSchedule" v-model:checked="value.allDay">全天</NCheckbox>
          <div v-if="!value.allDay" class="event-dates">
            <label class="event-field">
              <span>开始时间</span>
              <NTimePicker
                :formatted-value="value.startTime"
                class="event-time-picker"
                format="HH:mm"
                value-format="HH:mm"
                aria-label="开始时间"
                clearable
                @update:formatted-value="value.startTime = $event"
              />
            </label>
            <label class="event-field">
              <span>结束时间</span>
              <NTimePicker
                :formatted-value="value.endTime"
                class="event-time-picker"
                format="HH:mm"
                value-format="HH:mm"
                aria-label="结束时间"
                clearable
                @update:formatted-value="value.endTime = $event"
              />
            </label>
          </div>
        </template>

        <template v-if="chineseRule?.isLeapMonth">
          <label class="event-field">
            <span>目标年份没有闰月时</span>
            <NSelect
              :value="chineseRule.leapMonthPolicy"
              :options="leapMonthPolicyOptions"
              aria-label="缺少闰月时"
              @update:value="updateLeapMonthPolicy"
            />
          </label>
        </template>
        <template v-if="chineseRule?.lunarDay === 30">
          <label class="event-field">
            <span>目标月份只有二十九天时</span>
            <NSelect
              :value="chineseRule.shortMonthPolicy"
              :options="shortMonthPolicyOptions"
              aria-label="小月处理方式"
              @update:value="updateShortMonthPolicy"
            />
          </label>
        </template>
      </div>
    </details>
  </div>
</template>

<style scoped>
.event-fields { display: flex; min-width: 0; flex-direction: column; gap: 20px; }
.event-type-picker { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.event-type-picker button {
  display: flex;
  min-width: 0;
  min-height: 36px;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 5px 7px;
  border: 1px solid var(--border, #8885);
  border-radius: 10px;
  background: transparent;
  color: var(--text-muted, #6b7280);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.event-type-picker button:hover:not(:disabled) { background: color-mix(in srgb, var(--text) 4%, transparent); }
.event-type-picker button[aria-pressed="true"] {
  border-color: color-mix(in srgb, var(--accent, #6366f1) 55%, var(--border, #8885));
  background: color-mix(in srgb, var(--accent, #6366f1) 6%, transparent);
  color: var(--text);
}
.event-type-picker button:focus-visible,
.event-emoji-trigger:focus-visible,
.event-emoji-picker button:focus-visible {
  outline: 2px solid var(--accent, #6366f1);
  outline-offset: 2px;
}
.event-type-picker button:disabled { opacity: .55; cursor: wait; }
.event-type-picker img { width: 18px; height: 18px; flex: none; object-fit: contain; }
.event-primary-row { display: flex; min-width: 0; align-items: end; }
.event-emoji-trigger {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  padding: 0;
  border: 1px solid var(--border, #8885);
  border-radius: 10px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.event-emoji-trigger:hover { background: color-mix(in srgb, var(--text) 4%, transparent); }
.event-emoji-trigger img { width: 27px; height: 27px; object-fit: contain; }
.event-emoji-trigger > span { font-size: 24px; line-height: 1; }
.event-emoji-picker {
  display: grid;
  grid-template-columns: repeat(3, 42px);
  gap: 5px;
  padding: 8px;
  border: 1px solid var(--border, #8884);
  border-radius: 12px;
  background: var(--bg, #fff);
  box-shadow: 0 12px 28px rgb(24 31 52 / 14%);
}
.event-emoji-picker button {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 9px;
  background: transparent;
  cursor: pointer;
}
.event-emoji-picker button:hover { background: color-mix(in srgb, var(--text) 5%, transparent); }
.event-emoji-picker button[aria-pressed="true"] { border-color: var(--accent, #6366f1); background: color-mix(in srgb, var(--accent, #6366f1) 8%, transparent); }
.event-emoji-picker img { width: 26px; height: 26px; object-fit: contain; }
.event-field { display: flex; min-width: 0; flex-direction: column; gap: 6px; }
.event-field > span { color: var(--text-muted, #6b7280); font-size: 13px; }
.event-field small { margin-inline-start: 4px; font-size: inherit; }
.event-title-field { flex: 1; }
.event-dates { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.event-birthday-dates { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.event-lunar-dates { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.event-date-section { display: flex; min-width: 0; flex-direction: column; gap: 12px; }
.event-date-heading { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 12px; }
.event-date-section h2 { margin: 0; font-size: 14px; font-weight: 650; letter-spacing: .01em; color: var(--text-muted, #6b7280); }
.event-date-calendar-toggle { display: inline-flex; align-self: flex-start; gap: 3px; padding: 3px; border: 1px solid var(--border, #8885); border-radius: 9px; }
.event-date-calendar-toggle button { min-height: 28px; padding: 3px 9px; border: 0; border-radius: 6px; background: transparent; color: var(--text-muted, #6b7280); font: inherit; font-size: 13px; cursor: pointer; }
.event-date-calendar-toggle button[aria-pressed="true"] { background: color-mix(in srgb, var(--accent, #6366f1) 10%, transparent); color: var(--accent, #6366f1); }
.event-date-calendar-toggle button:disabled { opacity: .45; cursor: not-allowed; }
.event-date-calendar-toggle button:focus-visible { outline: 2px solid var(--accent, #6366f1); outline-offset: 1px; }
.event-field input {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  height: 34px;
  min-height: 34px;
  padding: 5px 9px;
  border: 1px solid var(--border, #8885);
  border-radius: 8px;
  background: var(--bg-soft, var(--bg, #fff));
  color: inherit;
  font: inherit;
}
.event-field :deep(.event-date-picker),
.event-field :deep(.event-time-picker),
.event-field :deep(.n-select) { width: 100%; min-width: 0; }
.event-date-preview,
.event-date-help,
.event-date-error { margin: -2px 0 0; font-size: 13px; line-height: 1.5; }
.event-date-preview,
.event-date-help { color: var(--text-muted, #6b7280); }
.event-date-error { color: var(--danger, #dc2626); }
.event-description-field :deep(textarea) { line-height: 1.55; }
.event-emoji-setting { display: flex; min-height: 38px; align-items: center; justify-content: space-between; gap: 12px; color: var(--text-muted, #6b7280); font-size: 13px; }
.event-advanced { border-top: 1px solid var(--border, #8883); padding-top: 14px; }
.event-advanced summary {
  display: flex;
  min-height: 32px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--text);
  font-size: 14px;
  font-weight: 550;
  cursor: pointer;
  list-style: none;
}
.event-advanced summary::-webkit-details-marker { display: none; }
.event-advanced-chevron {
  width: 8px;
  height: 8px;
  flex: none;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: rotate(45deg) translateY(-2px);
  transition: transform 150ms ease;
}
.event-advanced[open] .event-advanced-chevron { transform: rotate(225deg) translateY(-2px); }
.event-advanced-content { display: flex; min-width: 0; flex-direction: column; gap: 13px; padding-top: 14px; }
@media (max-width: 700px) {
  .event-type-picker { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 600px) {
  .event-lunar-dates { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .event-lunar-month-type { grid-column: 1 / -1; }
}
@media (max-width: 480px) {
  .event-fields { gap: 17px; }
  .event-dates { grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .event-lunar-dates { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .event-birthday-dates { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .event-birthday-dates .event-field:first-child { grid-column: 1 / -1; }
  .event-emoji-trigger { width: 38px; height: 38px; }
}
@media (prefers-reduced-motion: reduce) {
  .event-advanced-chevron { transition: none; }
}
</style>
