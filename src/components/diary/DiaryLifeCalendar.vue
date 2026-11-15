<script setup lang="ts">
import { computed, ref } from 'vue'
import { NCalendar } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'

defineProps<{ today: string; markers: Record<string, { source?: string; emoji?: string; count?: number; hasEntries?: boolean; hasAttachments?: boolean }> }>()
const emit = defineEmits<{ select: [date: string]; month: [date: string] }>()
const selected = ref<number>()
const { locale } = useI18n()
// Match the firstDayOfWeek of the zhCN and enUS locales in NuvynUiRoot.
const weekdays = computed(() => locale.value === 'zh'
  ? ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
  : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])
const dateFor = (year: number, month: number, date: number) => `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`
const selectedDate = computed(() => selected.value === undefined ? '' : dateFor(new Date(selected.value).getFullYear(), new Date(selected.value).getMonth() + 1, new Date(selected.value).getDate()))
function choose(year: number, month: number, day: number) {
  const d = new Date(0)
  d.setFullYear(year, month - 1, day)
  d.setHours(12, 0, 0, 0)
  selected.value = d.getTime()
  emit('select', dateFor(year, month, day))
}
</script>

<template>
  <NCalendar class="diary-life-calendar" :value="selected" @panel-change="({ year, month }) => emit('month', dateFor(year, month, 1))">
    <template #header="{ year, month }">
      <strong class="life-month">{{ dateFor(year, month, 1).slice(0, 7) }}</strong>
      <div class="life-weekdays">
        <span v-for="label in weekdays" :key="label">{{ label }}</span>
      </div>
    </template>
    <template #default="{ year, month, date }">
      <button type="button" class="life-date" :class="{ today: dateFor(year, month, date) === today, selected: selectedDate === dateFor(year, month, date) }"
        :data-date="dateFor(year, month, date)" :aria-label="dateFor(year, month, date)" :aria-pressed="selectedDate === dateFor(year, month, date)"
        @click.stop="choose(year, month, date)">
        <span class="life-date-badge"><span class="life-date-number">{{ date }}</span></span>
        <span v-if="markers[dateFor(year, month, date)]" class="life-marker">
          <img v-if="markers[dateFor(year, month, date)]?.source" :src="markers[dateFor(year, month, date)]?.source" alt="">
          <span v-else-if="markers[dateFor(year, month, date)]?.emoji">{{ markers[dateFor(year, month, date)]?.emoji }}</span>
          <span v-else-if="markers[dateFor(year, month, date)]?.hasEntries || markers[dateFor(year, month, date)]?.hasAttachments" class="life-entry-marker" aria-label="有日记内容">•</span>
          <small v-if="(markers[dateFor(year, month, date)]?.count ?? 0) > 1">+{{ markers[dateFor(year, month, date)]!.count! - 1 }}</small>
        </span>
      </button>
    </template>
  </NCalendar>
</template>

<style scoped>
.diary-life-calendar {
  flex: 1 0 auto;
  min-width: 0;
  height: auto;
  color: var(--text);
  background: transparent;
}

.diary-life-calendar :deep(.n-calendar-header) {
  position: relative;
  flex: 0 0 76px;
  padding: 0;
}

.diary-life-calendar :deep(.n-calendar-header__title) {
  display: grid;
  grid-template-rows: 44px 20px;
  align-self: stretch;
  width: 100%;
  color: var(--text);
}

.life-month {
  align-self: center;
  justify-self: center;
  font-size: 0.95rem;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.life-weekdays {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  align-items: center;
  color: var(--text-muted);
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-align: center;
}

.diary-life-calendar :deep(.n-calendar-header__extra) {
  position: absolute;
  inset: 0 0 auto;
  justify-content: center;
  pointer-events: none;
}

.diary-life-calendar :deep(.n-calendar-header__extra .n-button-group) {
  display: grid;
  grid-template-columns: 44px 88px 44px;
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
     height and number alignment stay stable between months. */
  grid-template-rows: repeat(6, minmax(72px, 1fr));
  min-height: 432px;
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
  grid-template-rows: max(0px, calc(50% - 36px)) 44px 24px;
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

.life-date:hover .life-date-badge {
  background: color-mix(in srgb, var(--accent) 7%, transparent);
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
  background: color-mix(in srgb, var(--accent) 11%, transparent);
}

.life-date-number {
  position: relative;
}

.life-date.today .life-date-number,
.life-date.selected .life-date-number {
  color: var(--accent);
  font-weight: 650;
}

.life-date.today .life-date-number::after {
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

.life-marker {
  grid-row: 3;
  display: flex;
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
}
</style>
