<script setup lang="ts">
import { computed } from 'vue'
import { addDays, dayDistance, nextOccurrence, type DiaryEvent } from '../../../shared/diaryLife'
import { formatLunarRule } from '../../../shared/lunarCalendar'

const props = defineProps<{
  event: DiaryEvent
  today: string
  occurrenceDate: string
  error?: string
}>()

const typeLabels: Record<DiaryEvent['type'], string> = {
  milestone: '人生时刻',
  anniversary: '纪念日',
  schedule: '重要日程',
}

const nextDate = computed(() => nextOccurrence(props.event, props.today))
const countdownDays = computed(() => props.event.showCountdown && nextDate.value ? dayDistance(props.today, nextDate.value) : null)
const displayedStartDate = computed(() => props.event.recurrence === 'yearly' ? props.occurrenceDate : props.event.startDate)
const displayedEndDate = computed(() => {
  if (props.event.recurrence !== 'yearly') return props.event.endDate
  return addDays(displayedStartDate.value, dayDistance(props.event.startDate, props.event.endDate))
})

function formatDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  return `${year}年${month}月${day}日`
}

const lunarRule = computed(() => props.event.dateRule?.calendar === 'chinese' ? props.event.dateRule : null)
const dateLabel = computed(() => lunarRule.value
  ? formatLunarRule(lunarRule.value)
  : displayedStartDate.value === displayedEndDate.value
    ? formatDate(displayedStartDate.value)
    : `${formatDate(displayedStartDate.value)} – ${formatDate(displayedEndDate.value)}`)
const lunarPolicyLabel = computed(() => {
  const rule = lunarRule.value
  if (!rule) return ''
  const details = []
  if (rule.isLeapMonth) details.push(rule.leapMonthPolicy === 'regular-month' ? '无闰月时按普通月' : '仅在闰月年份发生')
  if (rule.lunarDay === 30) details.push(rule.shortMonthPolicy === 'last-day' ? '小月时按最后一天' : '小月时跳过')
  return details.join(' · ')
})
const timeLabel = computed(() => {
  if (props.event.allDay) return '全天'
  if (!props.event.startTime && !props.event.endTime) return ''
  return [props.event.startTime, props.event.endTime].filter(Boolean).join(' – ')
})
</script>

<template>
  <article class="diary-event-detail" data-testid="diary-event-detail">
    <p v-if="error" class="diary-event-detail-error" role="alert">{{ error }}</p>

    <section v-if="nextDate && countdownDays !== null" class="diary-event-detail-countdown" aria-label="距离下一次发生">
      <strong>{{ countdownDays === 0 ? '就是今天' : countdownDays }}</strong>
      <span v-if="countdownDays > 0">天后</span>
      <small>下一次 · {{ formatDate(nextDate) }}<template v-if="lunarRule">（公历）</template></small>
    </section>

    <dl class="diary-event-detail-facts">
      <div>
        <dt>日期</dt>
        <dd>{{ dateLabel }}</dd>
      </div>
      <div v-if="lunarRule && (!event.showCountdown || !nextDate)">
        <dt>下一次</dt>
        <dd>{{ nextDate ? `${formatDate(nextDate)}（公历）` : '支持范围内暂无下一次日期' }}</dd>
      </div>
      <div v-if="lunarPolicyLabel">
        <dt>日期规则</dt>
        <dd>{{ lunarPolicyLabel }}</dd>
      </div>
      <div v-if="timeLabel">
        <dt>时间</dt>
        <dd>{{ timeLabel }}</dd>
      </div>
      <div>
        <dt>重复</dt>
        <dd>{{ event.recurrence === 'yearly' ? '每年' : '不重复' }}</dd>
      </div>
      <div>
        <dt>类型</dt>
        <dd>{{ typeLabels[event.type] }}</dd>
      </div>
    </dl>

    <section v-if="event.description" class="diary-event-detail-description">
      <h2>说明</h2>
      <p>{{ event.description }}</p>
    </section>
  </article>
</template>

<style scoped>
.diary-event-detail { min-width: 0; color: var(--text); }
.diary-event-detail-error { margin: 0 0 16px; color: var(--danger, #dc2626); }
.diary-event-detail-countdown {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 22px 12px 26px;
  text-align: center;
}
.diary-event-detail-countdown strong {
  font-size: clamp(36px, 8vw, 52px);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}
.diary-event-detail-countdown > span { color: var(--text-muted, #6b7280); font-size: 15px; }
.diary-event-detail-countdown small { margin-top: 8px; color: var(--text-muted, #6b7280); font-size: 14px; }
.diary-event-detail-facts { display: flex; flex-direction: column; gap: 15px; margin: 0; }
.diary-event-detail-facts > div { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 12px; }
.diary-event-detail-facts dt { color: var(--text-muted, #6b7280); }
.diary-event-detail-facts dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
.diary-event-detail-description { margin-top: 25px; }
.diary-event-detail-description h2 { margin: 0 0 8px; color: var(--text-muted, #6b7280); font-size: 14px; font-weight: 500; }
.diary-event-detail-description p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.65; }
</style>
