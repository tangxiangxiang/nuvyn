<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, onUpdated, ref } from 'vue'
import { NButton, NCalendar } from 'naive-ui'
import type { DiaryMoodId } from '../../../shared/diaryMood'
import { useI18n } from '../../composables/useI18n'
import { useTheme } from '../../composables/useTheme'
import { useDiaryMoodIconPreferences } from '../../composables/diary/useDiaryMoodIconPreferences'
import type { DiaryDate } from '../../../shared/diaryProtocol'
import DiaryMoodPicker from './DiaryMoodPicker.vue'
import {
  diaryCalendarMonthFromFields,
  diaryCalendarMonthFromLocalDate,
  diaryDateFromCalendarFields,
  diaryDateFromNaiveCalendarValue,
  localCivilToday,
  naiveCalendarValueForDiaryDate,
  naiveCalendarValueForMonth,
  normalizeDiaryDays,
  type DiaryCalendarDay,
  type DiaryCalendarMonth,
} from './diaryCalendarAdapter'

type NaiveCalendarDay = {
  year: number
  month: number
  date: number
}

const props = withDefaults(defineProps<{
  days: readonly DiaryCalendarDay[]
  loading?: boolean
  error?: string | null
  initialMonth?: DiaryCalendarMonth
  moodBusy?: boolean
}>(), {
  loading: false,
  error: null,
  moodBusy: false,
})

const emit = defineEmits<{
  'date-selected': [date: DiaryDate]
  'month-change': [month: DiaryCalendarMonth]
  'mood-change': [date: DiaryDate, mood: DiaryMoodId | null]
}>()

const lastMonthKey = ref<string | null>(null)
const currentMonth = ref<DiaryCalendarMonth | null>(null)
const calendarKey = ref(0)
const selectedCalendarValue = ref<number | null>(null)
const calendarRoot = ref<HTMLElement | null>(null)
const moodPickerOpen = ref(false)
const activeMoodDate = ref<DiaryDate | null>(null)
const activeMoodTrigger = ref<HTMLButtonElement | null>(null)
const moodPickerRef = ref<InstanceType<typeof DiaryMoodPicker> | null>(null)
const moodPickerStyle = ref<Record<string, string>>({ top: '12px', left: '12px' })
let moodPickerPositionFrame: number | null = null
const { locale, t } = useI18n()
const { theme } = useTheme()
const moodPreferences = useDiaryMoodIconPreferences()

const calendarLocale = computed(() => (locale.value === 'zh' ? 'zh-CN' : 'en-US'))
const isDark = computed(() => theme.value === 'dark')
const normalizedDays = computed(() => normalizeDiaryDays(props.days))
const daysByDate = computed(() => new Map(
  normalizedDays.value.map((day) => [day.date, day] as const),
))
const activeMoodDay = computed(() => (
  activeMoodDate.value ? daysByDate.value.get(activeMoodDate.value) ?? null : null
))
const activeMood = computed<string | null>(() => activeMoodDay.value?.mood ?? null)
const initialMonth = computed(() => (
  diaryCalendarMonthFromFields(props.initialMonth) ?? diaryCalendarMonthFromLocalDate()
))
const calendarDefaultValue = computed(() => (
  naiveCalendarValueForMonth(currentMonth.value ?? initialMonth.value) ?? Date.now()
))
// The 2.45.3 declaration exposes `value` as an optional number, while the
// component also treats an explicit runtime null as "nothing selected".
// Keep that null at runtime so a Mood-first click cannot become selected.
const calendarValue = computed<number | undefined>(() => (
  selectedCalendarValue.value as number | undefined
))
const todayDate = computed(() => localCivilToday())
const weekdayLabels = computed(() => {
  // Naive UI's en-US locale starts on Sunday and its zh-CN locale starts on
  // Monday in 2.45.3. Keep this row aligned with the provider's date locale.
  const firstDay = locale.value === 'zh' ? 1 : 0
  const formatter = new Intl.DateTimeFormat(calendarLocale.value, { weekday: 'short' })
  return Array.from({ length: 7 }, (_, index) => (
    formatter.format(new Date(2024, 0, 7 + ((firstDay + index) % 7), 12))
  ))
})

function diaryDateForCalendarDay(day: NaiveCalendarDay): DiaryDate | null {
  return diaryDateFromCalendarFields(day)
}

function diaryDayForCalendarDay(day: NaiveCalendarDay): DiaryCalendarDay | null {
  const date = diaryDateForCalendarDay(day)
  return date ? daysByDate.value.get(date) ?? null : null
}

function moodDefinitionForDay(day: NaiveCalendarDay) {
  const mood = diaryDayForCalendarDay(day)?.mood
  return moodPreferences.presentationFor(mood, locale.value)
}

function hasUnknownMoodForDay(day: NaiveCalendarDay): boolean {
  const mood = diaryDayForCalendarDay(day)?.mood
  return typeof mood === 'string' && !moodPreferences.isAvailable(mood)
}

function moodLabelForDay(day: NaiveCalendarDay): string {
  const mood = diaryDayForCalendarDay(day)?.mood
  const presentation = moodPreferences.presentationFor(mood, locale.value)
  if (presentation) return presentation.label
  return typeof mood === 'string' ? t('mood.unknown') : t('mood.not_set')
}

function moodButtonLabel(day: NaiveCalendarDay): string {
  const date = diaryDateForCalendarDay(day) ?? t('diary.calendar.day')
  return t('diary.calendar.mood_action', {
    date,
    mood: moodLabelForDay(day),
  })
}

function isValidMetadataVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function moodButtonDisabled(day: NaiveCalendarDay): boolean {
  if (props.loading || props.moodBusy) return true
  const data = diaryDayForCalendarDay(day)
  // Existing files without a CAS version are not safe to mutate from the
  // Calendar. Missing today/past dates enter through the date button's
  // Mood-first flow and obtain fresh CAS only after canonical creation.
  return Boolean(data?.hasDiary && !isValidMetadataVersion(data.metadataUpdatedAt))
}

function isTodayForDay(day: NaiveCalendarDay): boolean {
  const date = diaryDateForCalendarDay(day)
  return date !== null && date === todayDate.value
}

function isSelectedForDay(day: NaiveCalendarDay): boolean {
  const date = diaryDateForCalendarDay(day)
  return date !== null
    && selectedCalendarValue.value !== null
    && diaryDateFromNaiveCalendarValue(selectedCalendarValue.value) === date
}

function pickerElement(): HTMLElement | null {
  const element = moodPickerRef.value?.$el
  return element instanceof HTMLElement ? element : null
}

function updateMoodPickerPosition(): void {
  if (!moodPickerOpen.value) return
  const trigger = activeMoodTrigger.value
  const picker = pickerElement()
  if (!trigger || !picker) return

  const triggerRect = trigger.getBoundingClientRect()
  const pickerRect = picker.getBoundingClientRect()
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight
  const inset = 12
  const gap = 8
  const pickerWidth = pickerRect.width || picker.offsetWidth
  const pickerHeight = pickerRect.height || picker.offsetHeight
  const maxLeft = Math.max(inset, viewportWidth - pickerWidth - inset)
  const maxTop = Math.max(inset, viewportHeight - pickerHeight - inset)
  const calendarHeaderClearance = Math.min(64, maxTop)
  const belowTop = triggerRect.bottom + gap
  const aboveTop = triggerRect.top - pickerHeight - gap
  const canPlaceBelow = belowTop <= maxTop
  const canPlaceAbove = aboveTop >= calendarHeaderClearance
  let left = Math.min(Math.max(triggerRect.right - pickerWidth, inset), maxLeft)
  let top: number

  if (canPlaceBelow) {
    top = belowTop
  } else if (canPlaceAbove) {
    top = aboveTop
  } else {
    // Short viewports may not have enough vertical room above or below a
    // day cell. Prefer a side placement so the picker does not cover the
    // month title/navigation controls that remain valid outside targets.
    const rightLeft = triggerRect.right + gap
    const leftLeft = triggerRect.left - pickerWidth - gap
    left = rightLeft + pickerWidth <= viewportWidth - inset
      ? rightLeft
      : leftLeft >= inset
        ? leftLeft
        : left
    top = Math.min(
      Math.max(triggerRect.top + (triggerRect.height - pickerHeight) / 2, calendarHeaderClearance),
      maxTop,
    )
  }

  moodPickerStyle.value = {
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
  }
}

function scheduleMoodPickerPosition(): void {
  if (!moodPickerOpen.value) return
  void nextTick(() => {
    if (!moodPickerOpen.value) return
    if (moodPickerPositionFrame !== null) window.cancelAnimationFrame(moodPickerPositionFrame)
    if (typeof window.requestAnimationFrame === 'function') {
      moodPickerPositionFrame = window.requestAnimationFrame(() => {
        moodPickerPositionFrame = null
        updateMoodPickerPosition()
      })
    } else {
      updateMoodPickerPosition()
    }
  })
}

function closeMoodPicker(restoreFocus = true): void {
  if (!moodPickerOpen.value) return
  const trigger = activeMoodTrigger.value
  moodPickerOpen.value = false
  activeMoodDate.value = null
  activeMoodTrigger.value = null
  moodPickerStyle.value = { top: '12px', left: '12px' }
  if (restoreFocus) void nextTick(() => trigger?.focus())
}

function openMoodPickerForDate(date: DiaryDate, trigger: HTMLButtonElement): void {
  activeMoodDate.value = date
  activeMoodTrigger.value = trigger
  moodPickerStyle.value = { top: '12px', left: '12px' }
  moodPickerOpen.value = true
  void nextTick(() => {
    moodPickerRef.value?.focusInitial()
    scheduleMoodPickerPosition()
  })
}

function openMoodPicker(day: NaiveCalendarDay, event: MouseEvent): void {
  if (moodButtonDisabled(day)) return
  const date = diaryDateForCalendarDay(day)
  const trigger = event.currentTarget
  if (!date || !(trigger instanceof HTMLButtonElement)) return

  openMoodPickerForDate(date, trigger)
}

function emitMoodChange(mood: DiaryMoodId | null): void {
  if (activeMoodDate.value) emit('mood-change', activeMoodDate.value, mood)
}

function isCalendarContextTarget(target: EventTarget | null): boolean {
  return target instanceof Element
    && Boolean(calendarRoot.value?.contains(target))
}

function onDocumentPointerDown(event: PointerEvent): void {
  const target = event.target
  const picker = pickerElement()
  if (!moodPickerOpen.value || !(target instanceof Node) || picker?.contains(target)) return

  // A date/header navigation target is a new Calendar context even though it
  // lives inside the keep-mounted Calendar root. Close at pointerdown so the
  // picker cannot retain its old date while the subsequent click navigates.
  if (isCalendarContextTarget(target)) {
    closeMoodPicker(false)
    return
  }

  if (!calendarRoot.value?.contains(target)) closeMoodPicker(false)
}

function monthKey(month: DiaryCalendarMonth): string {
  return `${month.year}-${String(month.month).padStart(2, '0')}`
}

function announceMonth(month: DiaryCalendarMonth): void {
  const key = monthKey(month)
  if (lastMonthKey.value === key) return

  // A panel change is a new Calendar context. Do not let a body-teleported
  // picker continue editing the date from the previous month.
  closeMoodPicker(false)
  currentMonth.value = month
  lastMonthKey.value = key
  emit('month-change', month)
}

function onCalendarPanelChange(value: unknown): void {
  const month = diaryCalendarMonthFromFields(value)
  if (!month) return

  announceMonth(month)
}

function selectDate(date: DiaryDate): void {
  // Date navigation leaves the current Mood picker context. The parent may
  // keep Calendar mounted while the native document surface takes over, so
  // close without restoring focus to the soon-to-be-hidden trigger.
  selectedCalendarValue.value = naiveCalendarValueForDiaryDate(date)
  closeMoodPicker(false)
  emit('date-selected', date)
}

function calendarMonthForDay(day: NaiveCalendarDay): DiaryCalendarMonth | null {
  return diaryCalendarMonthFromFields(day)
}

function isCurrentCalendarMonth(month: DiaryCalendarMonth): boolean {
  return currentMonth.value !== null && monthKey(currentMonth.value) === monthKey(month)
}

function dateButtonForDate(date: DiaryDate): HTMLButtonElement | null {
  return calendarRoot.value?.querySelector<HTMLButtonElement>(
    `[data-diary-day-content][data-date="${date}"]`,
  ) ?? null
}

function needsMoodFirst(date: DiaryDate): boolean {
  return daysByDate.value.get(date)?.hasDiary !== true
    && Boolean(todayDate.value && date <= todayDate.value)
}

function onDayClick(day: NaiveCalendarDay, event: MouseEvent): void {
  const date = diaryDateForCalendarDay(day)
  if (!date) return

  // A missing today/past Diary requires a Mood choice before the existing
  // date command may create it. Opening and dismissing this picker is purely
  // presentational and therefore cannot create a document. Missing future
  // dates continue through the existing command so its guard remains the
  // single authority for the browser-visible no-op.
  if (needsMoodFirst(date)) {
    const trigger = event.currentTarget
    if (trigger instanceof HTMLButtonElement) openMoodPickerForDate(date, trigger)
    return
  }

  // The custom day button is the stable interaction owner. Recreate the
  // small Naive Calendar instance when a direct click targets an adjacent
  // month, because Naive's own cell click is intentionally stopped below.
  const month = calendarMonthForDay(day)
  if (month && !isCurrentCalendarMonth(month)) {
    announceMonth(month)
    calendarKey.value += 1
  }
  selectDate(date)
}

function onCalendarValueUpdate(value: number, time: NaiveCalendarDay): void {
  const date = diaryDateFromNaiveCalendarValue(value) ?? diaryDateForCalendarDay(time)
  if (!date) return

  // A click on the outer Naive cell (for example, on its padding) does not
  // pass through the custom button. Apply the same Mood-first rule there.
  if (needsMoodFirst(date)) {
    const trigger = dateButtonForDate(date)
    if (trigger) openMoodPickerForDate(date, trigger)
    return
  }

  selectDate(date)
}

function dayAriaLabel(day: NaiveCalendarDay): string {
  const base = diaryDateForCalendarDay(day) || t('diary.calendar.day')
  const data = diaryDayForCalendarDay(day)
  const labels: string[] = []
  if (data?.hasDiary) labels.push(t('diary.calendar.has_diary'))
  if (data?.hasDiary) labels.push(`${t('mood.label')}: ${moodLabelForDay(day)}`)
  return labels.length ? `${base}, ${labels.join(', ')}` : base
}

/**
 * Naive UI owns the header buttons, while their accessible copy belongs to
 * Diary. Mark the two icon buttons through their rendered SVG shape once, so
 * event logic can use our data attributes instead of Naive's internal class
 * names.
 */
function annotateCalendarNavigation(): void {
  const buttons = [...(calendarRoot.value?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    .filter((button) => button.querySelector('svg')
      && !button.matches('[data-diary-day-content], [data-testid="diary-calendar-mood"]'))
  const previous = buttons[0]
  const next = buttons.at(-1)
  if (!previous || !next || previous === next) return

  previous.dataset.diaryCalendarNav = 'previous'
  previous.dataset.testid = 'diary-calendar-previous'
  previous.setAttribute('aria-label', t('diary.calendar.previous_month'))
  next.dataset.diaryCalendarNav = 'next'
  next.dataset.testid = 'diary-calendar-next'
  next.setAttribute('aria-label', t('diary.calendar.next_month'))
}

function focusDate(date: DiaryDate): boolean {
  const target = calendarRoot.value?.querySelector<HTMLElement>(
    `[data-diary-day-content][data-date="${date}"]`,
  )
  if (!target) return false
  target.focus()
  return document.activeElement === target
}

function clearSelection(): void {
  selectedCalendarValue.value = null
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  window.addEventListener('resize', scheduleMoodPickerPosition)
  window.addEventListener('scroll', scheduleMoodPickerPosition, true)
  announceMonth(initialMonth.value)
  annotateCalendarNavigation()
  void nextTick(annotateCalendarNavigation)
})

onUpdated(() => {
  annotateCalendarNavigation()
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
  window.removeEventListener('resize', scheduleMoodPickerPosition)
  window.removeEventListener('scroll', scheduleMoodPickerPosition, true)
  if (moodPickerPositionFrame !== null) window.cancelAnimationFrame(moodPickerPositionFrame)
})

defineExpose({ focusDate, closeMoodPicker, clearSelection })

</script>

<template>
  <section
    ref="calendarRoot"
    class="diary-calendar"
    data-testid="diary-calendar"
    :data-locale="calendarLocale"
    :data-theme="isDark ? 'dark' : 'light'"
    :data-month="currentMonth ? `${currentMonth.year}-${String(currentMonth.month).padStart(2, '0')}` : undefined"
    role="region"
    :aria-label="t('diary.calendar.label')"
    :aria-busy="props.loading || undefined"
  >
    <div class="diary-calendar-host">
      <NCalendar
        :key="calendarKey"
        :default-value="calendarDefaultValue"
        :value="calendarValue"
        @panel-change="onCalendarPanelChange"
        @update:value="onCalendarValueUpdate"
      >
        <template #header="{ year, month }">
          <div class="diary-calendar-header-content">
            <span
              class="diary-calendar-month"
              data-testid="diary-calendar-month"
              :data-month="`${year}-${String(month).padStart(2, '0')}`"
            >
              {{ `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}` }}
            </span>
            <div class="diary-calendar-weekdays" role="row" :aria-label="t('diary.calendar.navigation')">
              <span v-for="weekday in weekdayLabels" :key="weekday" role="columnheader">{{ weekday }}</span>
            </div>
          </div>
        </template>
        <template #default="{ year, month, date }">
          <template v-if="diaryDateFromCalendarFields({ year, month, date })">
            <div class="diary-calendar-day-content">
              <button
                type="button"
                role="button"
                data-diary-day-content
                :class="{
                  'has-mood': moodDefinitionForDay({ year, month, date }) || hasUnknownMoodForDay({ year, month, date }),
                  'is-selected': isSelectedForDay({ year, month, date }),
                  'is-today': isTodayForDay({ year, month, date }),
                }"
                :data-date="diaryDateFromCalendarFields({ year, month, date }) ?? undefined"
                :aria-label="dayAriaLabel({ year, month, date })"
                :aria-current="isTodayForDay({ year, month, date }) ? 'date' : undefined"
                :aria-pressed="isSelectedForDay({ year, month, date }) ? 'true' : 'false'"
                aria-disabled="false"
                @click.stop="onDayClick({ year, month, date }, $event)"
              >
                <span class="diary-calendar-day-number">{{ date }}</span>
                <span v-if="diaryDayForCalendarDay({ year, month, date })?.hasDiary" class="diary-calendar-visually-hidden">
                  {{ t('diary.calendar.has_diary') }}
                </span>
                <span v-if="diaryDayForCalendarDay({ year, month, date })?.hasDiary" class="diary-calendar-visually-hidden">
                  {{ t('mood.label') }}: {{ moodLabelForDay({ year, month, date }) }}
                </span>
              </button>
              <NButton
                v-if="diaryDayForCalendarDay({ year, month, date })?.hasDiary || moodDefinitionForDay({ year, month, date }) || hasUnknownMoodForDay({ year, month, date })"
                attr-type="button"
                size="small"
                quaternary
                :bordered="false"
                class="diary-calendar-mood"
                :class="{
                  'diary-calendar-mood-unknown': hasUnknownMoodForDay({ year, month, date }),
                  'diary-calendar-mood-empty': !moodDefinitionForDay({ year, month, date }) && !hasUnknownMoodForDay({ year, month, date }),
                }"
                data-testid="diary-calendar-mood"
                :data-date="diaryDateFromCalendarFields({ year, month, date }) ?? undefined"
                :aria-label="moodButtonLabel({ year, month, date })"
                :aria-expanded="moodPickerOpen && activeMoodDate === diaryDateFromCalendarFields({ year, month, date }) ? 'true' : 'false'"
                :aria-controls="moodPickerOpen && activeMoodDate === diaryDateFromCalendarFields({ year, month, date }) ? 'diary-mood-picker' : undefined"
                :disabled="moodButtonDisabled({ year, month, date })"
                @click.stop="openMoodPicker({ year, month, date }, $event)"
                @keydown.stop
              >
                <img
                  v-if="moodDefinitionForDay({ year, month, date })"
                  :src="moodDefinitionForDay({ year, month, date })!.source"
                  alt=""
                  aria-hidden="true"
                >
                <span v-else-if="hasUnknownMoodForDay({ year, month, date })" aria-hidden="true">?</span>
                <span v-else class="diary-calendar-mood-empty-mark" aria-hidden="true">?</span>
              </NButton>
            </div>
          </template>
        </template>
      </NCalendar>

      <div v-if="props.loading" class="diary-calendar-status" data-testid="diary-calendar-loading" role="status" aria-live="polite">
        {{ t('diary.calendar.loading') }}
      </div>
      <div v-if="props.error" class="diary-calendar-status diary-calendar-error" data-testid="diary-calendar-error" role="alert">
        {{ props.error }}
      </div>
    </div>

    <Teleport to="body">
      <DiaryMoodPicker
        v-if="moodPickerOpen"
        ref="moodPickerRef"
        :style="moodPickerStyle"
        :current-mood="activeMood"
        :busy="props.moodBusy"
        @select="emitMoodChange"
        @clear="emitMoodChange(null)"
        @close="closeMoodPicker"
      />
    </Teleport>
  </section>
</template>

<style scoped>
.diary-calendar {
  flex: 1 1 auto;
  width: 100%;
  height: 100%;
  max-width: none;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  background: transparent;
  color: var(--text);
}

.diary-calendar-host {
  position: relative;
  flex: 1 1 auto;
  width: 100%;
  height: 100%;
  /* Keep the toolbar/weekday rhythm intact while reserving a small,
     viewport-relative breathing room below the final week. The calendar
     rows themselves still consume the remaining height. */
  padding: 8px 0 clamp(16px, 3vh, 32px);
  box-sizing: border-box;
  min-width: 0;
  min-height: 0;
}

.diary-calendar-status {
  position: absolute;
  top: 84px;
  left: 16px;
  z-index: 2;
  color: var(--text-muted);
  font-size: 0.875rem;
  pointer-events: none;
}

.diary-calendar-error {
  color: var(--vs-danger, #d73a49);
}

/* Naive UI owns the calendar structure; these overrides keep the Diary
   surface airy and translucent instead of restoring the default grid card. */
.diary-calendar-host :deep(.n-calendar) {
  display: flex;
  flex: 1 1 auto;
  width: 100%;
  height: 100% !important;
  min-width: 0;
  min-height: 0;
  background: transparent;
  color: inherit;
}

.diary-calendar-host :deep(.n-calendar-header) {
  position: relative;
  flex: 0 0 76px;
  height: 76px;
  box-sizing: border-box;
  justify-content: center;
  padding: 0 16px 8px;
}

.diary-calendar-host :deep(.n-calendar-header__title) {
  position: absolute;
  top: 0;
  left: 0;
  display: block;
  height: 76px;
  width: 100%;
  min-width: 0;
  max-width: none;
  color: var(--vs-text-1, var(--text-h));
  font-size: 0.95rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  overflow: visible;
}

.diary-calendar-month {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 44px;
  box-sizing: border-box;
  width: max-content;
  max-width: 100%;
  margin: 0 auto;
  padding: 2px 4px;
  border-radius: 6px;
  background: transparent;
  appearance: none;
  color: var(--vs-text-1, var(--text-h));
  text-align: center;
}

.diary-calendar[data-theme='dark'] .diary-calendar-month {
  color: #f1f5f9;
}

.diary-calendar-header-content {
  position: relative;
  display: block;
  width: 100%;
  height: 100%;
}

.diary-calendar-weekdays {
  position: absolute;
  top: 48px;
  right: 4px;
  left: 4px;
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  align-items: center;
  color: var(--vs-text-3, var(--text-muted));
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  line-height: 1;
  text-align: center;
}

.diary-calendar-host :deep(.n-calendar-header__extra) {
  position: absolute;
  inset: 0;
  display: block;
  pointer-events: none;
}

.diary-calendar-host :deep(.n-calendar-header__extra .n-button-group) {
  display: block;
  width: 100%;
  height: 100%;
}

.diary-calendar-host :deep(.n-calendar-header__extra .n-button) {
  position: absolute;
  top: 0;
  width: 44px;
  min-width: 44px;
  height: 44px;
  min-height: 44px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--vs-text-2, var(--text-muted));
  pointer-events: auto;
}

.diary-calendar-host :deep(.n-calendar-header__extra .n-button__border),
.diary-calendar-host :deep(.n-calendar-header__extra .n-button__state-border) {
  display: none;
}

.diary-calendar-host :deep(.n-calendar-header__extra .n-button:first-child) {
  right: calc(50% + 48px);
}

.diary-calendar-host :deep(.n-calendar-header__extra .n-button:nth-child(2)) {
  display: none;
}

.diary-calendar-host :deep(.n-calendar-header__extra .n-button:last-child) {
  left: calc(50% + 48px);
}

.diary-calendar-host :deep(.n-calendar-header__extra .n-button:hover),
.diary-calendar-host :deep(.n-calendar-header__extra .n-button:active) {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  color: var(--vs-text-1, var(--text-h));
}

.diary-calendar-host :deep(.n-calendar-header__extra .n-button:focus) {
  border: 0;
  outline: none;
  box-shadow: none;
}

.diary-calendar-host :deep(.n-calendar-header__extra .n-button:focus-visible) {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.diary-calendar-host :deep(.n-calendar-dates) {
  flex: 1 1 auto;
  min-height: 0;
  border: 0;
  border-radius: 0;
  gap: 1px;
  background: transparent;
}

.diary-calendar-host :deep(.n-calendar-cell) {
  min-width: 0;
  min-height: 44px;
  padding: 4px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  overflow: visible;
}

.diary-calendar-host :deep(.n-calendar-cell:hover),
.diary-calendar-host :deep(.n-calendar-cell--selected) {
  background: transparent;
}

.diary-calendar-host :deep(.n-calendar-cell__bar) {
  display: none;
}

.diary-calendar-host :deep(.n-calendar-date) {
  height: 0;
  padding: 0;
  visibility: hidden;
}

.diary-calendar-host :deep(.n-calendar-date__day) {
  display: none;
}

.diary-calendar-day-content {
  position: absolute;
  inset: 0;
  z-index: 1;
  min-height: 44px;
  --diary-calendar-date-top: max(0px, calc(50% - 36px));
  pointer-events: none;
}

.diary-calendar-day-content > [data-diary-day-content] {
  position: absolute;
  top: var(--diary-calendar-date-top);
  left: 50%;
  display: flex;
  width: 44px;
  height: 44px;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  padding: 0;
  transform: translateX(-50%);
  border: 0;
  border-radius: 8px;
  background: transparent;
  box-shadow: none;
  color: var(--vs-text-1, var(--text));
  cursor: pointer;
  font: inherit;
  line-height: 1;
  pointer-events: auto;
  transition: color 160ms ease-out;
}

.diary-calendar-day-content > [data-diary-day-content]::before {
  position: absolute;
  inset: 0;
  z-index: 0;
  box-sizing: border-box;
  border: 1px solid transparent;
  border-radius: inherit;
  background: transparent;
  box-shadow: none;
  content: '';
  pointer-events: none;
  transition:
    background 160ms ease-out,
    border-color 160ms ease-out,
    box-shadow 160ms ease-out;
}

.diary-calendar-day-content > [data-diary-day-content]:hover::before {
  background: color-mix(in srgb, var(--accent) 7%, transparent);
}

.diary-calendar-day-content > [data-diary-day-content]:focus {
  outline: none;
}

.diary-calendar-host :deep(.n-calendar-cell--other-month) [data-diary-day-content] {
  color: var(--vs-text-3, var(--text-muted));
  opacity: 0.7;
}

.diary-calendar-day-content > [data-diary-day-content].is-selected {
  background: transparent;
  box-shadow: none;
  color: var(--accent);
  font-weight: 650;
}

.diary-calendar-day-content > [data-diary-day-content].is-selected::before {
  border-color: color-mix(in srgb, var(--accent) 26%, transparent);
  background: color-mix(in srgb, var(--accent) 11%, transparent);
  box-shadow: 0 4px 14px color-mix(in srgb, var(--accent) 7%, transparent);
}

.diary-calendar-day-content > [data-diary-day-content].is-selected:hover::before {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}

.diary-calendar-day-content > [data-diary-day-content].is-today .diary-calendar-day-number {
  color: var(--accent);
  font-weight: 650;
}

.diary-calendar-day-content > [data-diary-day-content].is-today .diary-calendar-day-number::after {
  position: absolute;
  top: calc(100% + 5px);
  left: 50%;
  width: 14px;
  height: 2px;
  transform: translateX(-50%);
  border-radius: 999px;
  background: var(--accent);
  content: '';
}

.diary-calendar-day-content > [data-diary-day-content].is-selected.is-today .diary-calendar-day-number::after {
  opacity: 0.55;
}

.diary-calendar[data-theme='dark'] .diary-calendar-day-content > [data-diary-day-content]:hover::before {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}

.diary-calendar[data-theme='dark'] .diary-calendar-day-content > [data-diary-day-content].is-selected::before {
  border-color: color-mix(in srgb, var(--accent) 34%, transparent);
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  box-shadow: 0 4px 14px color-mix(in srgb, var(--accent) 8%, transparent);
}

.diary-calendar[data-theme='dark'] .diary-calendar-day-content > [data-diary-day-content].is-selected:hover::before {
  background: color-mix(in srgb, var(--accent) 18%, transparent);
}

.diary-calendar-host :deep(.n-calendar-cell--other-month) [data-diary-day-content].is-selected::before {
  border-color: color-mix(in srgb, var(--accent) 20%, transparent);
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  box-shadow: 0 4px 14px color-mix(in srgb, var(--accent) 4%, transparent);
}

.diary-calendar[data-theme='dark'] .diary-calendar-host :deep(.n-calendar-cell--other-month) [data-diary-day-content].is-selected::before {
  border-color: color-mix(in srgb, var(--accent) 26%, transparent);
  background: color-mix(in srgb, var(--accent) 11%, transparent);
  box-shadow: 0 4px 14px color-mix(in srgb, var(--accent) 5%, transparent);
}

.diary-calendar-host :deep([data-diary-day-content]:focus-visible) {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.diary-calendar-day-number {
  position: relative;
  z-index: 1;
  display: inline-block;
}

.diary-calendar-mood {
  position: absolute;
  top: calc(var(--diary-calendar-date-top) + 65px);
  left: 50%;
  z-index: 2;
  display: inline-flex;
  width: 28px;
  height: 28px;
  align-items: center;
  justify-content: center;
  transform: translate(-50%, -50%);
  padding: 0;
  border: 0;
  background: transparent;
  box-shadow: none;
  color: var(--vs-text-2, var(--text-muted));
  cursor: pointer;
  font: inherit;
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1;
  pointer-events: auto;
}

.diary-calendar-mood img {
  width: 21px;
  height: 21px;
  object-fit: contain;
}

.diary-calendar-mood-empty-mark {
  font-size: 1rem;
  font-weight: 500;
}

.diary-calendar-mood:hover:not(:disabled),
.diary-calendar-mood:focus,
.diary-calendar-mood:active {
  border: 0;
  background: transparent;
  outline: none;
  box-shadow: none;
}

.diary-calendar-mood:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.diary-calendar-mood:disabled {
  cursor: not-allowed;
  opacity: 0.38;
}

.diary-calendar-mood:disabled:focus-visible {
  outline: none;
}

.diary-calendar-visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (max-width: 420px) {
  .diary-calendar-host {
    padding: 8px 0 clamp(12px, 3vh, 24px);
  }

  .diary-calendar-host :deep(.n-calendar-header) {
    flex-basis: 76px;
    height: 76px;
    padding-left: 4px;
    padding-right: 4px;
  }

  .diary-calendar-host :deep(.n-calendar-header__extra .n-button:first-child) {
    right: calc(50% + 44px);
  }

  .diary-calendar-host :deep(.n-calendar-header__extra .n-button:last-child) {
    left: calc(50% + 44px);
  }

  .diary-calendar-host :deep(.n-calendar-cell) {
    min-height: 72px;
    padding: 2px;
  }

  .diary-calendar-day-content {
    min-height: 72px;
  }

  .diary-calendar-mood {
    top: calc(var(--diary-calendar-date-top) + 61px);
    width: 24px;
    height: 24px;
  }

  .diary-calendar-mood img {
    width: 18px;
    height: 18px;
  }

  .diary-calendar-status {
    left: 8px;
  }
}
</style>
