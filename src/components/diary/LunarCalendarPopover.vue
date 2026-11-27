<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, type CSSProperties } from 'vue'
import { NPopover } from 'naive-ui'
import { lunarDayLabel, lunarMonthLabel, solarToLunarTimePillars, type LunarCalendarDetails } from '../../../shared/lunarCalendar'
import { localToday } from '../../../shared/diaryLife'

const props = defineProps<{
  show: boolean
  date: string
  details: LunarCalendarDetails | null
  today: string
  x: number
  y: number
}>()

const currentTimestamp = ref(Date.now())
const currentToday = ref(props.today)
const viewportWidth = ref(typeof window === 'undefined' ? 364 : window.innerWidth)
const popoverMaxWidth = computed(() => Math.max(0, Math.min(340, viewportWidth.value - 24)))
const popoverSizeStyle = computed<CSSProperties>(() => ({ maxWidth: `${popoverMaxWidth.value}px` }))
const timePillars = computed(() => props.show ? solarToLunarTimePillars(props.date) : null)
const currentPillarKey = computed(() => {
  if (!props.show || props.date !== currentToday.value) return null
  const hour = new Date(currentTimestamp.value).getHours()
  const pillarIndex = Math.ceil(hour / 2) % 12
  return timePillars.value?.[pillarIndex]?.key ?? null
})
const lunarDateLabel = computed(() => {
  const details = props.details
  if (!details) return ''
  const month = `${details.isLeapMonth ? '闰' : ''}${lunarMonthLabel(details.month)}`
  return `农历 ${month}${lunarDayLabel(details.day)}日`
})

const popoverContentStyle: CSSProperties = {
  minWidth: '0',
  padding: '16px',
  boxSizing: 'border-box',
  overflow: 'hidden',
  border: '1px solid color-mix(in srgb, var(--nuvyn-border) 58%, transparent)',
  borderRadius: '12px',
  backgroundColor: 'var(--nuvyn-surface-1)',
  color: 'var(--text)',
  boxShadow: 'none',
}
const popoverThemeOverrides = { boxShadow: 'none' }

let boundaryTimer: ReturnType<typeof setTimeout> | null = null
const TIME_BOUNDARY_HOURS = [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 24]

function clearBoundaryTimer() {
  if (boundaryTimer) clearTimeout(boundaryTimer)
  boundaryTimer = null
}

function updateCurrentTimeAndSchedule() {
  clearBoundaryTimer()
  if (!props.show) return

  const now = new Date()
  currentTimestamp.value = now.getTime()
  currentToday.value = localToday()

  const nextBoundary = TIME_BOUNDARY_HOURS
    .map(hour => hour === 24
      ? new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
      : new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour))
    .find(boundary => boundary.getTime() > now.getTime())
  const delay = Math.max(1, (nextBoundary?.getTime() ?? now.getTime() + 60_000) - now.getTime())
  boundaryTimer = setTimeout(updateCurrentTimeAndSchedule, delay)
}

function updateViewportWidth() {
  viewportWidth.value = window.innerWidth
}

watch(() => props.show, show => {
  if (show) {
    updateViewportWidth()
    window.addEventListener('resize', updateViewportWidth)
  } else {
    window.removeEventListener('resize', updateViewportWidth)
  }
}, { immediate: true })

watch(() => [props.show, props.date] as const, ([show]) => {
  clearBoundaryTimer()
  if (show) updateCurrentTimeAndSchedule()
}, { immediate: true })

watch(() => props.today, today => {
  currentToday.value = today
})

onBeforeUnmount(() => {
  clearBoundaryTimer()
  window.removeEventListener('resize', updateViewportWidth)
})
</script>

<template>
  <NPopover
    :show="show"
    trigger="manual"
    placement="top"
    :x="x"
    :y="y"
    :width="340"
    :style="popoverSizeStyle"
    :flip="true"
    :show-arrow="false"
    :animated="false"
    :raw="true"
    :theme-overrides="popoverThemeOverrides"
    :content-style="popoverContentStyle"
  >
    <section
      v-if="details && timePillars"
      id="diary-lunar-calendar-popover"
      class="lunar-calendar-popover-content"
      role="dialog"
      aria-label="农历日期详情"
    >
      <header class="lunar-calendar-popover-header">
        <p class="lunar-calendar-popover-ganzhi">
          {{ details.yearGanZhi }}年 {{ details.monthGanZhi }}月 {{ details.dayGanZhi }}日
        </p>
        <p class="lunar-calendar-popover-date">{{ lunarDateLabel }}</p>
      </header>

      <div class="lunar-calendar-popover-divider" aria-hidden="true" />

      <div class="lunar-calendar-time-grid" aria-label="十二时辰">
        <div
          v-for="pillar in timePillars"
          :key="pillar.key"
          class="lunar-calendar-time-item"
          :class="{ 'is-current-time': currentPillarKey === pillar.key }"
          :data-time-pillar="pillar.key"
        >
          <span class="lunar-calendar-time-ganzhi">{{ pillar.ganZhi }}</span>
          <span class="lunar-calendar-time-range">{{ pillar.range }}</span>
        </div>
      </div>
    </section>
  </NPopover>
</template>

<style scoped>
.lunar-calendar-popover-content {
  display: grid;
  min-width: 0;
  color: var(--text);
}

.lunar-calendar-popover-header {
  display: grid;
  justify-items: center;
  gap: 4px;
  min-width: 0;
}

.lunar-calendar-popover-header p {
  margin: 0;
  white-space: nowrap;
}

.lunar-calendar-popover-ganzhi {
  color: var(--text);
  font-size: 13px;
  font-weight: 400;
  line-height: 18px;
}

.lunar-calendar-popover-date {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 400;
  line-height: 16px;
}

.lunar-calendar-popover-divider {
  margin: 12px 0;
  border-top: 1px solid color-mix(in srgb, var(--nuvyn-border) 55%, transparent);
}

.lunar-calendar-time-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  grid-template-rows: repeat(4, minmax(40px, auto));
  gap: 10px 4px;
  min-width: 0;
}

.lunar-calendar-time-item {
  display: grid;
  min-width: 0;
  min-height: 40px;
  align-content: center;
  justify-items: center;
  gap: 3px;
  border-radius: 8px;
  text-align: center;
}

.lunar-calendar-time-ganzhi {
  color: var(--text);
  font-size: 16px;
  font-weight: 400;
  line-height: 20px;
  white-space: nowrap;
}

.lunar-calendar-time-range {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 400;
  line-height: 15px;
  white-space: nowrap;
}

.lunar-calendar-time-item.is-current-time {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}

@media (max-width: 360px) {
  .lunar-calendar-time-grid {
    column-gap: 0;
  }

  .lunar-calendar-time-range {
    font-size: 10px;
  }
}
</style>
