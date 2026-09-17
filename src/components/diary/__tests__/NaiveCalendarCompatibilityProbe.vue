<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  darkTheme,
  dateEnUS,
  dateZhCN,
  enUS,
  NCalendar,
  NConfigProvider,
  zhCN,
} from 'naive-ui'
import { diaryDateFromCalendarFields, diaryDateFromNaiveCalendarValue, naiveCalendarValueForMonth } from '../diaryCalendarAdapter'
import { parseDiaryDate, type DiaryDate } from '../../../../shared/diaryProtocol'

const calendarValue = ref<number | null>(null)
const showCalendar = ref(true)
const hasDiary = ref(true)
const isDark = ref(false)
const locale = ref<'en' | 'zh'>('en')
const currentPage = ref('2026-08')
const selectedDate = ref<DiaryDate | null>(null)
const clickedDate = ref<DiaryDate | null>(null)

const calendarLocale = computed(() => locale.value === 'zh' ? zhCN : enUS)
const calendarDateLocale = computed(() => locale.value === 'zh' ? dateZhCN : dateEnUS)
const value = computed<number | undefined>(() => calendarValue.value as number | undefined)
const defaultValue = naiveCalendarValueForMonth({ year: 2026, month: 8 })!

function dateFromSlot(year: number, month: number, date: number): DiaryDate | null {
  return diaryDateFromCalendarFields({ year, month, date })
}

function onPanelChange(info: { year: number; month: number }): void {
  currentPage.value = `${String(info.year).padStart(4, '0')}-${String(info.month).padStart(2, '0')}`
}

function onUpdateValue(nextValue: number, time: { year: number; month: number; date: number }): void {
  calendarValue.value = nextValue
  selectedDate.value = diaryDateFromNaiveCalendarValue(nextValue) ?? dateFromSlot(time.year, time.month, time.date)
}

function onSlotClick(year: number, month: number, date: number): void {
  clickedDate.value = dateFromSlot(year, month, date)
}

function toggleIndicator(): void {
  hasDiary.value = !hasDiary.value
}

function toggleLocale(): void {
  locale.value = locale.value === 'en' ? 'zh' : 'en'
}

function toggleTheme(): void {
  isDark.value = !isDark.value
}

function toggleCalendar(): void {
  showCalendar.value = !showCalendar.value
}

function clickNavigation(direction: 'previous' | 'next'): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>('.n-calendar-header__extra button')
  const target = direction === 'previous' ? buttons[0] : buttons[buttons.length - 1]
  target?.click()
}
</script>

<template>
  <NConfigProvider
    :theme="isDark ? darkTheme : null"
    :locale="calendarLocale"
    :date-locale="calendarDateLocale"
  >
    <main
      data-testid="naive-calendar-probe"
      :data-page="currentPage"
      :data-locale="locale"
      :data-theme="isDark ? 'dark' : 'light'"
    >
      <div class="probe-controls">
        <button data-testid="prev-page" type="button" @click="clickNavigation('previous')">Previous</button>
        <button data-testid="next-page" type="button" @click="clickNavigation('next')">Next</button>
        <button data-testid="toggle-indicator" type="button" @click="toggleIndicator">Toggle indicator</button>
        <button data-testid="toggle-locale" type="button" @click="toggleLocale">Toggle locale</button>
        <button data-testid="toggle-theme" type="button" @click="toggleTheme">Toggle theme</button>
        <button data-testid="toggle-calendar" type="button" @click="toggleCalendar">Toggle calendar</button>
      </div>

      <output data-testid="selected-date">{{ selectedDate ?? '' }}</output>
      <output data-testid="clicked-date">{{ clickedDate ?? '' }}</output>

      <NCalendar
        v-if="showCalendar"
        :default-value="defaultValue"
        :value="value"
        @panel-change="onPanelChange"
        @update:value="onUpdateValue"
      >
        <template #default="{ year, month, date }">
          <button
            type="button"
            :data-date="dateFromSlot(year, month, date) ?? ''"
            @click="onSlotClick(year, month, date)"
          >
            {{ date }}
            <span v-if="hasDiary && dateFromSlot(year, month, date) === parseDiaryDate('2026-08-24')" data-testid="custom-marker">mood-probe</span>
          </button>
        </template>
      </NCalendar>
    </main>
  </NConfigProvider>
</template>
