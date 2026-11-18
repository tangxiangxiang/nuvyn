<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { NCalendar, NDatePicker } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { diaryCalendarMonthFromFields, diaryDateFromCalendarFields, naiveCalendarValueForMonth } from './diaryCalendarAdapter'
import { shouldAnimateTodoDayMarker, todoDayMarkerAssets, type TodoDayMarkerAssets } from '../../features/diary/deadlineReminderAssets'
import type { TodoDayVisualState } from '../../features/diary/deadlineVisualState'
import DiaryAnimatedEmoji from './DiaryAnimatedEmoji.vue'

const PIXEL_WHEEL_MONTH_THRESHOLD = 220
const LINE_WHEEL_MONTH_THRESHOLD = 6
const WHEEL_GESTURE_GAP_MS = 120
const WHEEL_TAIL_MAX_DELTA = 24
const WHEEL_RESTART_MIN_INCREASE = 12
const props = defineProps<{ today: string; selectedDate: string | null; month: string; revision: number; markers: Record<string, { source?: string; emoji?: string; count?: number; hasEntries?: boolean; hasAttachments?: boolean; hasTasks?: boolean; todoDayState?: TodoDayVisualState }> }>()
const emit = defineEmits<{ select: [date: string]; month: [date: string] }>()
const { locale } = useI18n()
interface TodoMarkerPresentation extends TodoDayMarkerAssets {
  state: TodoDayVisualState
  animate: boolean
}

const todoMarkers = computed<Record<string, TodoMarkerPresentation>>(() => {
  const result: Record<string, TodoMarkerPresentation> = {}
  for (const [date, marker] of Object.entries(props.markers)) {
    const state = marker.todoDayState
    if (!state || state === 'none') continue
    const assets = todoDayMarkerAssets(state)
    if (!assets) continue
    result[date] = {
      ...assets,
      state,
      animate: shouldAnimateTodoDayMarker(date, props.month, props.today),
    }
  }
  return result
})

function todoMarkerAlt(state: TodoDayVisualState): string {
  if (state === 'due-soon') return '即将截止待办'
  if (state === 'overdue') return '逾期待办'
  if (state === 'completed') return '当天待办已全部完成'
  if (state === 'completed-late') return '当天待办已全部完成（含逾期完成）'
  return state === 'pending' ? '有未完成待办' : ''
}

// Match the firstDayOfWeek of the zhCN and enUS locales in NuvynUiRoot.
const weekdays = computed(() => locale.value === 'zh'
  ? ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
  : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])
const dateFor = (year: number, month: number, date: number) => diaryDateFromCalendarFields({ year, month, date }) ?? ''
const calendarRef = ref<InstanceType<typeof NCalendar> | null>(null)
const calendarPickerRevision = ref(0)
const calendarKey = computed(() => `${props.revision}-${calendarPickerRevision.value}`)
const initialMonthTimestamp = computed(() => {
  const [year, month] = props.month.split('-').map(Number)
  return naiveCalendarValueForMonth({ year: year!, month: month! }) ?? Date.now()
})
let touchStart: { x: number; y: number } | null = null
let suppressCalendarClick = false
let suppressCalendarClickTimer: ReturnType<typeof setTimeout> | null = null
let wheelDistance = 0
let wheelPeak = 0
let wheelDirection = 0
let wheelMode = -1
let lastWheelAt = -Infinity
let wheelTail: { peak: number; low: number } | null = null

onBeforeUnmount(() => {
  if (suppressCalendarClickTimer) clearTimeout(suppressCalendarClickTimer)
})

function navigateMonthByGesture(offset: number) {
  if (offset > 0) calendarRef.value?.handleNextClick()
  else calendarRef.value?.handlePrevClick()
}

function onTouchStart(event: TouchEvent) {
  if (suppressCalendarClick) {
    suppressCalendarClick = false
    if (suppressCalendarClickTimer) clearTimeout(suppressCalendarClickTimer)
    suppressCalendarClickTimer = null
  }
  if (event.touches.length !== 1) {
    touchStart = null
    return
  }
  const touch = event.touches[0]!
  touchStart = { x: touch.clientX, y: touch.clientY }
}

function onTouchMove(event: TouchEvent) {
  if (!touchStart || event.touches.length !== 1) return
  const touch = event.touches[0]!
  const deltaX = touch.clientX - touchStart.x
  const deltaY = touch.clientY - touchStart.y
  if (Math.abs(deltaY) > 10 && Math.abs(deltaY) > Math.abs(deltaX)) event.preventDefault()
}

function onTouchEnd(event: TouchEvent) {
  const start = touchStart
  touchStart = null
  const touch = event.changedTouches[0]
  if (!start || !touch) return
  const deltaX = touch.clientX - start.x
  const deltaY = touch.clientY - start.y
  if (Math.abs(deltaY) < 80 || Math.abs(deltaY) < Math.abs(deltaX) * 1.25) return
  suppressCalendarClick = true
  suppressCalendarClickTimer = setTimeout(() => {
    suppressCalendarClick = false
    suppressCalendarClickTimer = null
  }, 500)
  navigateMonthByGesture(deltaY < 0 ? 1 : -1)
}

function onCalendarClickCapture(event: MouseEvent) {
  if (!suppressCalendarClick || event.detail === 0) return
  suppressCalendarClick = false
  if (suppressCalendarClickTimer) clearTimeout(suppressCalendarClickTimer)
  suppressCalendarClickTimer = null
  event.preventDefault()
  event.stopPropagation()
}

function onWheel(event: WheelEvent) {
  const mode = event.deltaMode
  const distance = Math.abs(event.deltaY)
  if (event.ctrlKey || distance <= Math.abs(event.deltaX)) return
  event.preventDefault()

  const direction = Math.sign(event.deltaY)
  const idle = event.timeStamp - lastWheelAt >= WHEEL_GESTURE_GAP_MS
  lastWheelAt = event.timeStamp
  if (idle || mode !== wheelMode) {
    wheelDistance = 0
    wheelPeak = 0
    wheelTail = null
    wheelDirection = direction
    wheelMode = mode
  } else if (direction !== wheelDirection) {
    if (wheelTail && distance < WHEEL_RESTART_MIN_INCREASE) return
    wheelDistance = 0
    wheelPeak = 0
    wheelTail = null
    wheelDirection = direction
  }

  if (wheelTail) {
    // A fresh push can start before the previous gesture's momentum has stopped.
    wheelTail.low = Math.min(wheelTail.low, distance)
    const hasDecayed = wheelTail.low <= Math.min(WHEEL_TAIL_MAX_DELTA, wheelTail.peak / 2)
    const accelerates = distance >= Math.max(wheelTail.low * 2, wheelTail.low + WHEEL_RESTART_MIN_INCREASE)
    if (!hasDecayed || !accelerates) {
      if (distance > wheelTail.peak) wheelTail = { peak: distance, low: distance }
      return
    }
    wheelTail = null
  }

  const pixelMode = mode === WheelEvent.DOM_DELTA_PIXEL
  const threshold = pixelMode ? PIXEL_WHEEL_MONTH_THRESHOLD
    : mode === WheelEvent.DOM_DELTA_LINE ? LINE_WHEEL_MONTH_THRESHOLD : 1
  wheelDistance += distance
  wheelPeak = Math.max(wheelPeak, distance)
  if (wheelDistance < threshold) return

  if (pixelMode) wheelTail = { peak: wheelPeak, low: distance }
  wheelDistance = 0
  wheelPeak = 0
  navigateMonthByGesture(direction)
}

function onPanelChange(value: { year: number; month: number }) {
  const month = diaryCalendarMonthFromFields(value)
  if (!month) return
  const firstDay = dateFor(month.year, month.month, 1)
  if (firstDay) emit('month', firstDay)
}

function calendarMonthValue(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`
}

function calendarMonthLabel(year: number, month: number): string {
  return new Intl.DateTimeFormat(locale.value === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, 1)))
}

function onMonthPickerUpdate(value: string | null) {
  const match = /^(\d{4})-(\d{2})$/.exec(value ?? '')
  if (!match) return
  const year = Number(match[1])
  const month = Number(match[2])
  const firstDay = dateFor(year, month, 1)
  if (!firstDay || firstDay.slice(0, 7) === props.month.slice(0, 7)) return
  calendarPickerRevision.value += 1
  emit('month', firstDay)
}

function selectDate(date: string, event: MouseEvent) {
  // Escape can turn focus left by a pointer click into a visible focus ring.
  if (event.detail > 0 && event.currentTarget instanceof HTMLButtonElement) {
    event.currentTarget.blur()
  }
  emit('select', date)
}
</script>

<template>
  <NCalendar
    :key="calendarKey"
    ref="calendarRef"
    class="diary-life-calendar"
    :default-value="initialMonthTimestamp"
    @panel-change="onPanelChange"
    @touchstart.passive="onTouchStart"
    @touchmove="onTouchMove"
    @touchend.passive="onTouchEnd"
    @touchcancel="touchStart = null"
    @click.capture="onCalendarClickCapture"
    @wheel="onWheel"
  >
    <template #header="{ year, month }">
      <div class="life-month-control">
        <strong class="life-month-label" :data-month="calendarMonthValue(year, month)">{{ calendarMonthLabel(year, month) }}</strong>
        <NDatePicker
          class="life-month-picker"
          type="month"
          format="yyyy-MM"
          value-format="yyyy-MM"
          :bordered="false"
          input-readonly
          :formatted-value="calendarMonthValue(year, month)"
          aria-label="选择日历月份"
          data-testid="diary-calendar-month-picker"
          @update:formatted-value="onMonthPickerUpdate"
        />
      </div>
      <div class="life-weekdays">
        <span v-for="label in weekdays" :key="label">{{ label }}</span>
      </div>
    </template>
    <template #default="{ year, month, date }">
      <button type="button" class="life-date" :class="{ today: dateFor(year, month, date) === today, selected: selectedDate === dateFor(year, month, date) }"
        :data-date="dateFor(year, month, date)" :aria-label="dateFor(year, month, date)" :aria-pressed="selectedDate === dateFor(year, month, date)"
        @click.stop="selectDate(dateFor(year, month, date), $event)">
        <span class="life-date-badge"><span class="life-date-number">{{ date }}</span></span>
        <span
          v-if="markers[dateFor(year, month, date)]"
          class="life-marker"
          :class="{
            'life-marker--with-task': Boolean(todoMarkers[dateFor(year, month, date)]),
            'life-marker--with-event-task': Boolean(markers[dateFor(year, month, date)]?.emoji && todoMarkers[dateFor(year, month, date)]),
          }"
        >
          <img v-if="markers[dateFor(year, month, date)]?.source" :class="{ 'life-event-marker': Boolean(markers[dateFor(year, month, date)]?.emoji) }" :src="markers[dateFor(year, month, date)]?.source" alt="">
          <span v-else-if="markers[dateFor(year, month, date)]?.emoji" class="life-event-marker">{{ markers[dateFor(year, month, date)]?.emoji }}</span>
          <span v-else-if="markers[dateFor(year, month, date)]?.hasEntries || markers[dateFor(year, month, date)]?.hasAttachments" class="life-entry-marker" aria-label="有日记内容">•</span>
          <small v-if="(markers[dateFor(year, month, date)]?.count ?? 0) > 1">+{{ markers[dateFor(year, month, date)]!.count! - 1 }}</small>
          <DiaryAnimatedEmoji
            v-if="todoMarkers[dateFor(year, month, date)]"
            class="life-task-marker"
            :class="{ 'life-task-marker--completed-late': todoMarkers[dateFor(year, month, date)]?.state === 'completed-late' }"
            :data-todo-day-state="todoMarkers[dateFor(year, month, date)]?.state"
            :animated-src="todoMarkers[dateFor(year, month, date)]?.animatedSrc ?? null"
            :static-src="todoMarkers[dateFor(year, month, date)]!.staticSrc"
            :animate="todoMarkers[dateFor(year, month, date)]?.animate ?? false"
            :alt="todoMarkerAlt(todoMarkers[dateFor(year, month, date)]!.state)"
          />
        </span>
      </button>
    </template>
  </NCalendar>
</template>

<style scoped>
.diary-life-calendar {
  flex: 0 0 auto;
  align-self: center;
  width: min(100%, 800px);
  max-width: 800px;
  min-width: 0;
  height: auto;
  margin-inline: auto;
  color: var(--text);
  background: transparent;
  touch-action: pan-x;
}

.diary-life-calendar :deep(.n-calendar-header) {
  position: relative;
  flex: 0 0 82px;
  padding: 0;
}

.diary-life-calendar :deep(.n-calendar-header__title) {
  display: grid;
  grid-template-rows: 56px 26px;
  align-self: stretch;
  width: 100%;
  color: var(--text);
}

.life-month-control {
  position: relative;
  z-index: 1;
  display: grid;
  align-self: center;
  justify-self: center;
  place-items: center;
  width: 250px;
  max-width: calc(100% - 88px);
  height: 56px;
  border-radius: 8px;
  transition: background-color .14s ease;
}

.life-month-label {
  align-self: center;
  justify-self: center;
  font-size: 26px;
  font-weight: 600;
  letter-spacing: 0.02em;
  white-space: nowrap;
}

.life-month-picker {
  position: absolute;
  inset: 0;
  width: 100%;
  opacity: 0;
  cursor: pointer;
}

.life-month-picker :deep(.n-input) {
  width: 100%;
  height: 100%;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  box-shadow: none;
  text-align: center;
}

.life-month-picker :deep(.n-input__border),
.life-month-picker :deep(.n-input__state-border),
.life-month-picker :deep(.n-input__suffix) {
  display: none;
}

.life-month-picker :deep(.n-input__input-el) {
  height: 56px;
  padding: 0;
  color: var(--text);
  font: inherit;
  font-size: 26px;
  font-weight: 600;
  line-height: 56px;
  text-align: center;
  cursor: pointer;
}

.life-month-control:hover,
.life-month-control:focus-within {
  background: color-mix(in srgb, var(--accent) 5%, transparent);
}

.life-month-control:focus-within .life-month-label {
  color: var(--accent);
}

.life-weekdays {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  align-items: center;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-align: center;
}

.diary-life-calendar :deep(.n-calendar-header__extra) {
  position: absolute;
  inset: 6px 0 auto;
  justify-content: center;
  pointer-events: none;
}

.diary-life-calendar :deep(.n-calendar-header__extra .n-button-group) {
  display: grid;
  grid-template-columns: 44px 250px 44px;
}

.diary-life-calendar :deep(.n-calendar-header__extra .n-button) {
  width: 44px;
  height: 44px;
  margin: 0;
  padding: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-muted);
  pointer-events: auto;
}

.diary-life-calendar :deep(.n-calendar-header__extra .n-button:nth-child(2)),
.diary-life-calendar :deep(.n-calendar-header__extra .n-button__border),
.diary-life-calendar :deep(.n-calendar-header__extra .n-button__state-border) {
  display: none;
}

.diary-life-calendar :deep(.n-calendar-header__extra .n-button:last-child) {
  grid-column: 3;
}

.diary-life-calendar :deep(.n-calendar-header__extra .n-button:hover) {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  color: var(--text);
}

.diary-life-calendar :deep(.n-calendar-header__extra .n-button:focus-visible) {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.diary-life-calendar :deep(.n-calendar-dates) {
  /* Naive UI renders four to six weeks. Reserve six tracks so the row
     height and number alignment stay stable without stretching to fill the
     viewport. */
  grid-template-rows: repeat(6, 80px);
  height: 480px;
  min-height: 480px;
  border: 0;
  border-radius: 0;
  background: transparent;
}

.diary-life-calendar :deep(.n-calendar-cell),
.diary-life-calendar :deep(.n-calendar-cell:hover),
.diary-life-calendar :deep(.n-calendar-cell--selected) {
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
}

.diary-life-calendar :deep(.n-calendar-date),
.diary-life-calendar :deep(.n-calendar-cell__bar) {
  display: none;
}

.life-date {
  display: grid;
  grid-template-rows: minmax(0, 1fr) 44px 24px;
  justify-items: center;
  width: 100%;
  height: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  line-height: 1;
  cursor: pointer;
}

.diary-life-calendar :deep(.n-calendar-cell--other-month) .life-date {
  color: var(--text-muted);
  opacity: 0.7;
}

.life-date-badge {
  display: grid;
  grid-row: 2;
  place-items: center;
  width: min(44px, 100%);
  height: 44px;
  box-sizing: border-box;
  border: 1px solid transparent;
  border-radius: 8px;
}

.life-date:focus-visible {
  outline: none;
}

.life-date:focus-visible .life-date-badge {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.life-date.selected .life-date-badge {
  border-color: color-mix(in srgb, var(--accent) 26%, transparent);
  background: color-mix(in srgb, var(--accent) 13%, transparent);
}

.life-date.today:not(.selected) .life-date-badge {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}

.life-date.today.selected .life-date-badge {
  border-color: color-mix(in srgb, var(--accent) 32%, transparent);
  background: color-mix(in srgb, var(--accent) 15%, transparent);
}

.life-date-number {
  position: relative;
}

.life-date.today .life-date-number,
.life-date.selected .life-date-number {
  color: var(--accent);
  font-weight: 650;
}

.life-marker {
  grid-row: 3;
  display: flex;
  min-width: 0;
  max-width: 100%;
  align-items: center;
  justify-content: center;
  gap: 2px;
  font-size: 21px;
}

.life-marker img {
  width: 21px;
  height: 21px;
  object-fit: contain;
}

.life-marker .life-event-marker {
  flex: none;
  line-height: 1;
}

.life-marker .life-task-marker {
  width: 21px;
  height: 21px;
  flex: none;
}

.life-marker .life-task-marker--completed-late {
  filter: grayscale(1);
}

.life-marker small {
  font-size: 10px;
  opacity: 0.65;
}

.life-entry-marker {
  color: var(--accent);
  font-size: 22px;
  line-height: 1;
}

@media (max-width: 420px) {
  .life-marker { font-size: 18px; }
  .life-marker img { width: 18px; height: 18px; }
  .life-marker .life-task-marker { width: 18px; height: 18px; }
  .life-marker--with-task small { display: none; }
  /* The two 18px icons already fill the narrow date-cell track. */
  .life-marker--with-event-task { gap: 0; }
}

@media (max-width: 600px) {
  .diary-life-calendar :deep(.n-calendar-header) { flex-basis: 64px; }
  .diary-life-calendar :deep(.n-calendar-header__title) { grid-template-rows: 40px 24px; }
  .life-month-control { width: 200px; height: 40px; }
  .life-month-label { font-size: 22px; }
  .life-month-picker :deep(.n-input),
  .life-month-picker :deep(.n-input__input-el) { height: 40px; }
  .life-month-picker :deep(.n-input__input-el) { font-size: 22px; line-height: 40px; }
  .diary-life-calendar :deep(.n-calendar-header__extra) { inset: 0 0 auto; }
  .diary-life-calendar :deep(.n-calendar-header__extra .n-button-group) {
    grid-template-columns: 40px 200px 40px;
  }
  .diary-life-calendar :deep(.n-calendar-header__extra .n-button) { width: 40px; height: 40px; }
  .diary-life-calendar :deep(.n-calendar-dates) {
    grid-template-rows: repeat(6, 68px);
    height: 408px;
    min-height: 408px;
  }
  .life-date { grid-template-rows: minmax(0, 1fr) 44px 22px; }
}
</style>
