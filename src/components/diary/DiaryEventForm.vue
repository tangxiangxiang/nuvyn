<script setup lang="ts">
import { computed, ref } from 'vue'
import { NInput, NSelect, NCheckbox } from 'naive-ui'
import { lunarDayLabel, lunarMonthLabel, lunarToSolar, nextLunarOccurrence, solarToLunar, type ChineseEventDateRule, type EventDateRule } from '../../../shared/lunarCalendar'
import { birthdayPersonName, type EventFields } from '../../../shared/diaryLife'
import { EVENT_EMOJI } from '../../features/diary/eventEmoji'

const value = defineModel<EventFields>({ required: true })
const props = defineProps<{ today: string }>()
const calendarError = ref('')
const dateRule = computed<EventDateRule>(() => value.value.dateRule ?? { calendar: 'gregory' })
const chineseRule = computed(() => dateRule.value.calendar === 'chinese' ? dateRule.value : null)
const isBirthday = computed(() => value.value.type === 'birthday')
const titleInput = computed({
  get: () => isBirthday.value ? birthdayPersonName(value.value.title) : value.value.title,
  set: (title: string) => { value.value.title = title },
})
const canUseLunar = computed(() => value.value.recurrence === 'yearly' && value.value.allDay
  && value.value.startDate === value.value.endDate && solarToLunar(value.value.startDate) !== null)
const lunarMonthOptions = Array.from({ length: 12 }, (_, index) => ({ value: index + 1, label: lunarMonthLabel(index + 1) }))
const lunarDayOptions = Array.from({ length: 30 }, (_, index) => ({ value: index + 1, label: lunarDayLabel(index + 1) }))
const lunarPreviewDate = computed(() => {
  if (!chineseRule.value) return null
  const fromDate = props.today > value.value.startDate ? props.today : value.value.startDate
  return nextLunarOccurrence(chineseRule.value, fromDate)
})
const birthdayPreview = computed(() => {
  const rule = chineseRule.value
  const birthLunarYear = value.value.birthday?.birthLunarYear
  if (!isBirthday.value || !rule || !Number.isInteger(birthLunarYear)
    || birthLunarYear! < 1901 || birthLunarYear! > 2100) return null
  const birthDate = lunarToSolar({
    year: birthLunarYear!,
    month: rule.lunarMonth,
    day: rule.lunarDay,
    isLeapMonth: rule.isLeapMonth,
  })
  if (!birthDate || birthDate !== value.value.startDate) return null
  const fromDate = props.today > value.value.startDate ? props.today : value.value.startDate
  const date = nextLunarOccurrence(rule, fromDate)
  const occurrence = date ? solarToLunar(date) : null
  return date && occurrence ? { date, age: occurrence.year - birthLunarYear! } : null
})
const types = [
  { label: '人生时刻', value: 'milestone' },
  { label: '纪念日', value: 'anniversary' },
  { label: '生日', value: 'birthday' },
  { label: '重要日程', value: 'schedule' },
]

function setEventType(type: string | number | null) {
  if (typeof type !== 'string' || !types.some(option => option.value === type)) return
  const eventType = type as EventFields['type']
  calendarError.value = ''
  if (eventType !== 'birthday') {
    value.value.type = eventType
    delete value.value.birthday
    return
  }
  const lunarDate = solarToLunar(value.value.startDate)
  if (!lunarDate) {
    calendarError.value = '生日日期仅支持 1901—2100 年的公历日期。'
    return
  }
  const rule: ChineseEventDateRule = {
    calendar: 'chinese',
    lunarMonth: lunarDate.month,
    lunarDay: lunarDate.day,
    isLeapMonth: lunarDate.isLeapMonth,
    leapMonthPolicy: 'regular-month',
    shortMonthPolicy: 'last-day',
  }
  const birthDate = lunarToSolar({
    year: lunarDate.year,
    month: lunarDate.month,
    day: lunarDate.day,
    isLeapMonth: lunarDate.isLeapMonth,
  })
  if (!birthDate) {
    calendarError.value = '无法识别这一天的农历生日，请更换日期后重试。'
    return
  }
  value.value.type = eventType
  value.value.title = birthdayPersonName(value.value.title)
  value.value.birthday = { birthLunarYear: 0 }
  value.value.dateRule = rule
  value.value.startDate = birthDate
  value.value.endDate = birthDate
  value.value.recurrence = 'yearly'
  value.value.allDay = true
  value.value.startTime = null
  value.value.endTime = null
  value.value.emoji = '🎂'
  value.value.showCountdown = true
}

function syncBirthdayDate() {
  if (!isBirthday.value || !chineseRule.value) return
  const birthLunarYear = value.value.birthday?.birthLunarYear
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
  value.value.birthday = { birthLunarYear: raw === '' ? 0 : Number(raw) }
  syncBirthdayDate()
}

function isValidBirthdayDate(
  day: number,
  isLeapMonth = chineseRule.value?.isLeapMonth ?? false,
  lunarMonth = chineseRule.value?.lunarMonth ?? 0,
): boolean {
  const rule = chineseRule.value
  const birthLunarYear = value.value.birthday?.birthLunarYear
  if (!rule || lunarMonth < 1) return false
  if (!Number.isInteger(birthLunarYear) || birthLunarYear! < 1901 || birthLunarYear! > 2100) return true
  return lunarToSolar({ year: birthLunarYear!, month: lunarMonth, day, isLeapMonth }) !== null
}

function setCalendar(calendar: 'gregory' | 'chinese') {
  calendarError.value = ''
  if (calendar === dateRule.value.calendar) return
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
    value.value.dateRule = {
      calendar: 'chinese',
      lunarMonth: lunarDate.month,
      lunarDay: lunarDate.day,
      isLeapMonth: lunarDate.isLeapMonth,
      leapMonthPolicy: 'regular-month',
      shortMonthPolicy: 'last-day',
    }
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
  value.value.dateRule = { ...chineseRule.value, ...updates }
  if (isBirthday.value) syncBirthdayDate()
}

function formatGregorianDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  return `${year}年${month}月${day}日`
}
</script>

<template>
  <div class="event-fields">
    <section class="event-form-section" aria-labelledby="event-basic-heading">
      <h2 id="event-basic-heading">基础信息</h2>
      <div class="event-emojis" role="group" aria-label="选择事件 Emoji">
        <button
          v-for="icon in EVENT_EMOJI"
          :key="icon.asset"
          type="button"
          :aria-label="icon.name"
          :aria-pressed="value.emoji === icon.glyph"
          @click="value.emoji = icon.glyph"
        ><img :src="`/emoji/event-${icon.asset}.svg`" alt=""></button>
      </div>
      <label class="event-field">
        <span>{{ isBirthday ? '称呼' : '事件标题' }}</span>
        <NInput v-model:value="titleInput" :input-props="{ 'aria-label': isBirthday ? '生日称呼' : '事件标题' }" :placeholder="isBirthday ? '例如：爷爷' : '值得记住的事'" :maxlength="160" />
      </label>
      <NSelect :value="value.type" :options="types" aria-label="事件类型" @update:value="setEventType" />
      <template v-if="isBirthday && chineseRule">
        <div class="event-dates">
          <label class="event-field">
            <span>出生农历年</span>
            <input :value="value.birthday?.birthLunarYear ? value.birthday.birthLunarYear : ''" type="number" min="1901" max="2100" step="1" required aria-label="出生农历年" @input="updateBirthLunarYear(($event.target as HTMLInputElement).value)">
          </label>
          <label class="event-field">
            <span>农历月份</span>
            <select aria-label="农历月份" :value="chineseRule.lunarMonth" @change="updateChineseRule({ lunarMonth: Number(($event.target as HTMLSelectElement).value) })">
              <option v-for="option in lunarMonthOptions" :key="option.value" :value="option.value" :disabled="!isValidBirthdayDate(chineseRule.lunarDay, chineseRule.isLeapMonth, option.value)">{{ option.label }}</option>
            </select>
          </label>
        </div>
        <div class="event-dates">
          <label class="event-field">
            <span>农历日期</span>
            <select aria-label="农历日期" :value="chineseRule.lunarDay" @change="updateChineseRule({ lunarDay: Number(($event.target as HTMLSelectElement).value) })">
              <option v-for="option in lunarDayOptions" :key="option.value" :value="option.value" :disabled="!isValidBirthdayDate(option.value)">{{ option.label }}</option>
            </select>
          </label>
          <label class="event-field">
            <span>出生月份</span>
            <select aria-label="出生月份类型" :value="chineseRule.isLeapMonth ? 'leap' : 'regular'" @change="updateChineseRule({ isLeapMonth: ($event.target as HTMLSelectElement).value === 'leap' })">
              <option value="regular">普通{{ lunarMonthLabel(chineseRule.lunarMonth) }}</option>
              <option value="leap" :disabled="!isValidBirthdayDate(chineseRule.lunarDay, true)">闰{{ lunarMonthLabel(chineseRule.lunarMonth) }}</option>
            </select>
          </label>
        </div>
        <p v-if="birthdayPreview" class="event-date-preview" aria-live="polite">
          自动标题：{{ birthdayPersonName(value.title) }}{{ birthdayPreview.age }}岁生日 · {{ formatGregorianDate(birthdayPreview.date) }}
        </p>
        <p v-else class="event-date-preview" aria-live="polite">填写有效的出生农历年和生日日期</p>
        <p v-if="calendarError" class="event-date-error" role="alert">{{ calendarError }}</p>
        <p class="event-date-help">保存一次即可；每年自动换算日期，并生成“称呼 + 年龄 + 生日”标题。</p>
      </template>
      <template v-else>
      <div class="event-date-calendar-toggle" role="group" aria-label="日期类型">
        <button type="button" :aria-pressed="dateRule.calendar === 'gregory'" @click="setCalendar('gregory')">公历</button>
        <button type="button" :aria-pressed="dateRule.calendar === 'chinese'" :disabled="dateRule.calendar !== 'chinese' && !canUseLunar" @click="setCalendar('chinese')">农历</button>
      </div>
      <p v-if="dateRule.calendar === 'gregory' && !canUseLunar" class="event-date-help">农历重复仅支持全天、单日且每年重复的事件。</p>
      <p v-if="calendarError" class="event-date-error" role="alert">{{ calendarError }}</p>

      <template v-if="dateRule.calendar === 'gregory'">
        <div class="event-dates">
          <label class="event-field"><span>开始日期</span><input v-model="value.startDate" type="date" required aria-label="开始日期"></label>
          <label class="event-field"><span>结束日期</span><input v-model="value.endDate" type="date" required aria-label="结束日期"></label>
        </div>
      </template>
      <template v-else-if="chineseRule">
        <div class="event-dates">
          <label class="event-field">
            <span>农历月份</span>
            <select aria-label="农历月份" :value="chineseRule.lunarMonth" @change="updateChineseRule({ lunarMonth: Number(($event.target as HTMLSelectElement).value) })">
              <option v-for="option in lunarMonthOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
          </label>
          <label class="event-field">
            <span>农历日期</span>
            <select aria-label="农历日期" :value="chineseRule.lunarDay" @change="updateChineseRule({ lunarDay: Number(($event.target as HTMLSelectElement).value) })">
              <option v-for="option in lunarDayOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
          </label>
        </div>
        <label class="event-field">
          <span>月份类型</span>
          <select aria-label="月份类型" :value="chineseRule.isLeapMonth ? 'leap' : 'regular'" @change="updateChineseRule({ isLeapMonth: ($event.target as HTMLSelectElement).value === 'leap' })">
            <option value="regular">普通{{ lunarMonthLabel(chineseRule.lunarMonth) }}</option>
            <option value="leap">闰{{ lunarMonthLabel(chineseRule.lunarMonth) }}</option>
          </select>
        </label>
        <label v-if="chineseRule.isLeapMonth" class="event-field">
          <span>目标年份没有闰月时</span>
          <select aria-label="缺少闰月时" :value="chineseRule.leapMonthPolicy" @change="updateChineseRule({ leapMonthPolicy: ($event.target as HTMLSelectElement).value as ChineseEventDateRule['leapMonthPolicy'] })">
            <option value="regular-month">按普通{{ lunarMonthLabel(chineseRule.lunarMonth) }}</option>
            <option value="leap-only">跳过该年，只在闰月出现</option>
          </select>
        </label>
        <label v-if="chineseRule.lunarDay === 30" class="event-field">
          <span>目标月份只有二十九天时</span>
          <select aria-label="小月处理方式" :value="chineseRule.shortMonthPolicy" @change="updateChineseRule({ shortMonthPolicy: ($event.target as HTMLSelectElement).value as ChineseEventDateRule['shortMonthPolicy'] })">
            <option value="last-day">按当月最后一天</option>
            <option value="skip">跳过该年</option>
          </select>
        </label>
        <p class="event-date-preview" aria-live="polite">
          <template v-if="lunarPreviewDate">下一次：{{ formatGregorianDate(lunarPreviewDate) }}（公历）</template>
          <template v-else>支持范围内暂无下一次日期</template>
        </p>
        <p class="event-date-help">农历日期支持 1901—2100 年；此规则仅用于全天、单日、每年重复事件。</p>
      </template>

      <NCheckbox v-model:checked="value.allDay" :disabled="dateRule.calendar === 'chinese'">全天</NCheckbox>
      <div v-if="!value.allDay" class="event-dates">
        <label class="event-field"><span>开始时间</span><input :value="value.startTime ?? ''" type="time" aria-label="开始时间" @input="value.startTime = ($event.target as HTMLInputElement).value || null"></label>
        <label class="event-field"><span>结束时间</span><input :value="value.endTime ?? ''" type="time" aria-label="结束时间" @input="value.endTime = ($event.target as HTMLInputElement).value || null"></label>
      </div>
      </template>
    </section>

    <section class="event-form-section" aria-labelledby="event-display-heading">
      <h2 id="event-display-heading">重复与展示</h2>
      <div class="event-checkboxes">
        <NCheckbox v-if="!isBirthday" :checked="value.recurrence === 'yearly'" :disabled="dateRule.calendar === 'chinese'" @update:checked="value.recurrence = $event ? 'yearly' : 'none'">每年重复</NCheckbox>
        <NCheckbox v-else :checked="true" disabled>按农历每年重复</NCheckbox>
        <NCheckbox v-model:checked="value.showCountdown">显示倒数日</NCheckbox>
        <NCheckbox v-model:checked="value.isPrimary">优先显示此事件</NCheckbox>
      </div>
    </section>

    <section class="event-form-section" aria-labelledby="event-other-heading">
      <h2 id="event-other-heading">其他</h2>
      <label class="event-field">
        <span>说明 <small>可选</small></span>
        <NInput v-model:value="value.description" type="textarea" :input-props="{ 'aria-label': '事件描述' }" placeholder="记下这一刻" :maxlength="4000" :rows="3" />
      </label>
    </section>
  </div>
</template>

<style scoped>
.event-fields { display: flex; flex-direction: column; gap: 24px; min-width: 0; }
.event-form-section { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.event-form-section h2 { margin: 0; color: var(--text-muted, #6b7280); font-size: 14px; font-weight: 600; }
.event-emojis { display: flex; flex-wrap: wrap; gap: 4px; }
.event-emojis button { border: 1px solid transparent; border-radius: 8px; width: 40px; height: 40px; display: grid; place-items: center; background: transparent; cursor: pointer; }
.event-emojis button:hover { background: color-mix(in srgb, var(--text) 5%, transparent); }
.event-emojis button:focus-visible { outline: 2px solid var(--accent, #6366f1); outline-offset: 1px; }
.event-emojis button[aria-pressed="true"] { border-color: var(--accent, #6366f1); background: color-mix(in srgb, var(--accent, #6366f1) 8%, transparent); }
.event-emojis img { width: 28px; height: 28px; object-fit: contain; }
.event-field { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
.event-field > span { color: var(--text-muted, #6b7280); font-size: 13px; }
.event-field small { margin-inline-start: 4px; font-size: inherit; }
.event-dates { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.event-field input { box-sizing: border-box; width: 100%; min-width: 0; min-height: 36px; padding: 6px 8px; background: transparent; color: inherit; border: 1px solid var(--border, #8886); border-radius: 6px; font: inherit; }
.event-field select { box-sizing: border-box; width: 100%; min-width: 0; min-height: 36px; padding: 6px 8px; background: var(--bg-soft, var(--bg, #fff)); color: inherit; border: 1px solid var(--border, #8886); border-radius: 6px; font: inherit; }
:global(:root[data-theme='dark']) .event-field select { color-scheme: dark; }
:global(:root[data-theme='light']) .event-field select { color-scheme: light; }
.event-date-calendar-toggle { display: inline-flex; align-self: flex-start; padding: 3px; border: 1px solid var(--border, #8886); border-radius: 8px; gap: 3px; }
.event-date-calendar-toggle button { min-height: 34px; padding: 5px 12px; border: 0; border-radius: 6px; background: transparent; color: var(--text-muted, #6b7280); font: inherit; cursor: pointer; }
.event-date-calendar-toggle button[aria-pressed="true"] { background: color-mix(in srgb, var(--accent, #6366f1) 12%, transparent); color: var(--accent, #6366f1); }
.event-date-calendar-toggle button:disabled { opacity: .45; cursor: not-allowed; }
.event-date-calendar-toggle button:focus-visible { outline: 2px solid var(--accent, #6366f1); outline-offset: 1px; }
.event-date-help,.event-date-preview,.event-date-error { margin: -4px 0 0; color: var(--text-muted, #6b7280); font-size: 13px; line-height: 1.5; }
.event-date-error { color: var(--danger, #dc2626); }
.event-checkboxes { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; }
@media (max-width: 390px) { .event-dates { gap: 8px; } }
</style>
