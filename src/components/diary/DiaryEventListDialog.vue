<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NEmpty, NSpin } from 'naive-ui'
import { dayDistance, nextOccurrence, type DiaryEvent } from '../../../shared/diaryLife'
import { formatLunarRule } from '../../../shared/lunarCalendar'
import { eventEmojiSource } from '../../features/diary/eventEmoji'

const props = withDefaults(defineProps<{
  items: DiaryEvent[]
  today: string
  loading?: boolean
  loadingMore?: boolean
  hasMore?: boolean
  error?: string
}>(), {
  loading: false,
  loadingMore: false,
  hasMore: false,
  error: '',
})

const emit = defineEmits<{
  retry: []
  'load-more': []
  select: [event: DiaryEvent]
}>()

const typeLabels: Record<DiaryEvent['type'], string> = {
  milestone: '人生时刻',
  anniversary: '纪念日',
  schedule: '重要日程',
}

function formatDate(event: DiaryEvent): string {
  if (event.dateRule?.calendar === 'chinese') return formatLunarRule(event.dateRule)
  if (event.recurrence === 'yearly') {
    const [, month, day] = event.startDate.split('-')
    return `${Number(month)} 月 ${Number(day)} 日`
  }
  return event.startDate === event.endDate
    ? event.startDate
    : `${event.startDate} – ${event.endDate}`
}

function secondaryLabel(event: DiaryEvent): string {
  if (event.dateRule?.calendar === 'chinese') return `${formatLunarRule(event.dateRule)} · 每年`
  if (event.recurrence === 'yearly') return `每年重复 · ${formatDate(event)}`
  return `${formatDate(event)} · ${typeLabels[event.type]}`
}

const countdowns = computed(() => new Map(props.items.map(event => {
  if (!event.showCountdown) return [event.id, null]
  const date = nextOccurrence(event, props.today)
  return [event.id, date ? dayDistance(props.today, date) : null]
})))
const isEmpty = computed(() => !props.loading && !props.error && props.items.length === 0)
</script>

<template>
  <div class="diary-event-list-content">
    <div v-if="loading" class="diary-event-list-status" role="status">
      <NSpin size="small" />
      <span>正在加载…</span>
    </div>
    <div v-else-if="error" class="diary-event-list-status" role="alert">
      <span>{{ error }}</span>
      <NButton text type="primary" @click="emit('retry')">重试</NButton>
    </div>
    <NEmpty v-else-if="isEmpty" description="还没有人生事件" />
    <div v-else class="diary-event-list-scroll">
      <button
        v-for="event in items"
        :key="event.id"
        type="button"
        class="diary-event-list-item"
        :aria-label="event.title"
        @click="emit('select', event)"
      >
        <span class="diary-event-list-emoji" aria-hidden="true">
          <img v-if="eventEmojiSource(event.emoji)" :src="eventEmojiSource(event.emoji)" alt="">
          <span v-else>{{ event.emoji }}</span>
        </span>
        <span class="diary-event-list-copy">
          <strong>{{ event.title }}</strong>
          <span class="diary-event-list-meta">{{ secondaryLabel(event) }}</span>
        </span>
        <span v-if="countdowns.get(event.id) !== null && countdowns.get(event.id) !== undefined" class="diary-event-list-countdown">
          <strong>{{ countdowns.get(event.id) === 0 ? '今天' : countdowns.get(event.id) }}</strong>
          <small>{{ countdowns.get(event.id) === 0 ? '就是今天' : '天后' }}</small>
        </span>
      </button>
      <div v-if="hasMore" class="diary-event-list-more">
        <NButton secondary :loading="loadingMore" @click="emit('load-more')">加载更多</NButton>
      </div>
    </div>
  </div>
</template>

<style>
.diary-event-list-content { min-height: 0; }
.diary-event-list-scroll {
  max-height: min(60dvh, 560px);
  overflow: auto;
  scrollbar-width: none;
}
.diary-event-list-scroll::-webkit-scrollbar { display: none; }
.diary-event-list-item {
  width: 100%;
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  padding: 13px 4px;
  border: 0;
  border-bottom: 1px solid var(--border, #d9dce5);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.diary-event-list-item:hover,
.diary-event-list-item:focus-visible { outline: none; background: color-mix(in srgb, var(--text) 4%, transparent); }
.diary-event-list-emoji { width: 32px; height: 32px; display: grid; place-items: center; font-size: 22px; }
.diary-event-list-emoji img { width: 26px; height: 26px; object-fit: contain; }
.diary-event-list-copy { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.diary-event-list-copy strong {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-height: 1.4;
  font-size: 16px;
  font-weight: 600;
}
.diary-event-list-meta { color: var(--text-muted, #6b7280); font-size: 13px; }
.diary-event-list-countdown { display: flex; min-width: 62px; flex-direction: column; align-items: flex-end; white-space: nowrap; }
.diary-event-list-countdown strong { font-size: 16px; font-variant-numeric: tabular-nums; }
.diary-event-list-countdown small { color: var(--text-muted, #6b7280); font-size: 12px; }
.diary-event-list-status { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 120px; color: var(--text-muted, #6b7280); }
.diary-event-list-more { display: flex; justify-content: center; padding: 14px 0 4px; }
@media (max-width: 420px) {
  .diary-event-list-item { grid-template-columns: 28px minmax(0, 1fr) auto; gap: 8px; }
  .diary-event-list-countdown { min-width: 52px; }
}
</style>
