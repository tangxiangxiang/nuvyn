<script setup lang="ts">
import { computed, ref } from 'vue'
import { NCalendar } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'

defineProps<{ today: string; markers: Record<string, { source?: string; emoji?: string; count?: number }> }>()
const emit = defineEmits<{ select: [date: string]; month: [date: string] }>()
const selected = ref<number>()
const { locale } = useI18n()
const weekdays = computed(() => locale.value === 'zh'
  ? ['一', '二', '三', '四', '五', '六', '日']
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
    <template #header="{ year, month }"><strong>{{ year }}-{{ String(month).padStart(2, '0') }}</strong><div class="life-weekdays" aria-hidden="true"><span v-for="label in weekdays" :key="label">{{ label }}</span></div></template>
    <template #default="{ year, month, date }">
      <button type="button" class="life-date" :class="{ today: dateFor(year, month, date) === today, selected: selectedDate === dateFor(year, month, date) }"
        :data-date="dateFor(year, month, date)" :aria-label="dateFor(year, month, date)" :aria-pressed="selectedDate === dateFor(year, month, date)"
        @click.stop="choose(year, month, date)">
        <span>{{ date }}</span>
        <span class="life-marker">
          <img v-if="markers[dateFor(year, month, date)]?.source" :src="markers[dateFor(year, month, date)]?.source" alt="">
          <span v-else>{{ markers[dateFor(year, month, date)]?.emoji }}</span>
          <small v-if="(markers[dateFor(year, month, date)]?.count ?? 0) > 1">+{{ markers[dateFor(year, month, date)]!.count! - 1 }}</small>
        </span>
      </button>
    </template>
  </NCalendar>
</template>

<style scoped>
.diary-life-calendar { min-width: 0; height: max(460px, calc(100dvh - 150px)); }
.diary-life-calendar :deep(.n-calendar-date) { display: none; }
.diary-life-calendar :deep(.n-calendar-cell) { padding: 0; border-color: transparent; }
.diary-life-calendar :deep(.n-calendar-header) { position: relative; padding: 12px 8px 40px; }
.life-weekdays { position: absolute; left: 0; right: 0; bottom: 6px; display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); text-align: center; opacity: .6; font-size: 12px; }
.life-date { width: 100%; height: 100%; min-height: 58px; padding: 6px 2px; border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; }
.life-date:focus-visible { outline: 2px solid var(--accent, #6366f1); outline-offset: -2px; border-radius: 6px; }
.life-date.selected > span:first-child { border-radius: 50%; background: var(--n-date-color-current); color: var(--n-date-text-color-current); min-width: 26px; padding: 2px; }
.life-date.today:not(.selected) > span:first-child { color: var(--accent, #6366f1); font-weight: 700; text-decoration: underline; text-underline-offset: 5px; }
.life-marker { height: 30px; display: flex; align-items: center; justify-content: center; gap: 2px; font-size: 26px; }
.life-marker img { width: 28px; height: 28px; }
.life-marker small { font-size: 10px; opacity: .65; }
@media (max-width: 600px) { .diary-life-calendar { height: max(440px, calc(100dvh - 150px)); } .life-marker img { width: 24px; height: 24px; } }
</style>
