<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NEmpty, NModal, NSpin } from 'naive-ui'
import { dayDistance, localToday, nextOccurrence, type DiaryEvent } from '../../../shared/diaryLife'
import { eventEmojiSource } from '../../features/diary/eventEmoji'

const props = withDefaults(defineProps<{
  show: boolean
  items: DiaryEvent[]
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
  'update:show': [value: boolean]
  retry: []
  'load-more': []
  select: [event: DiaryEvent]
}>()

const today = localToday()
const typeLabels: Record<DiaryEvent['type'], string> = {
  milestone: '人生时刻',
  anniversary: '纪念日',
  schedule: '重要日程',
}

function formatDate(event: DiaryEvent): string {
  return event.startDate === event.endDate
    ? event.startDate
    : `${event.startDate} – ${event.endDate}`
}

function countdownLabel(event: DiaryEvent): string | null {
  if (!event.showCountdown) return null
  const date = nextOccurrence(event, today)
  if (!date) return null
  const days = dayDistance(today, date)
  return days === 0 ? '就是今天' : `还有 ${days} 天`
}

const isEmpty = computed(() => !props.loading && !props.error && props.items.length === 0)
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    class="diary-event-list-dialog"
    :mask-closable="!loadingMore"
    :close-on-esc="!loadingMore"
    title="人生事件"
    @update:show="emit('update:show', $event)"
  >
    <div class="diary-event-list-heading">值得记住的每一个时刻</div>
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
        class="diary-event-list-card"
        @click="emit('select', event)"
      >
        <span class="diary-event-list-emoji" aria-hidden="true">
          <img v-if="eventEmojiSource(event.emoji)" :src="eventEmojiSource(event.emoji)" alt="">
          <span v-else>{{ event.emoji }}</span>
        </span>
        <span class="diary-event-list-content">
          <strong>{{ event.title }}</strong>
          <span class="diary-event-list-meta">
            <span>{{ formatDate(event) }}</span>
            <span>· {{ typeLabels[event.type] }}</span>
            <span v-if="event.recurrence === 'yearly'">· 每年重复</span>
          </span>
          <span v-if="event.description" class="diary-event-list-description">{{ event.description }}</span>
          <span v-if="countdownLabel(event)" class="diary-event-list-countdown">{{ countdownLabel(event) }}</span>
        </span>
      </button>
      <div v-if="hasMore" class="diary-event-list-more">
        <NButton secondary :loading="loadingMore" @click="emit('load-more')">加载更多</NButton>
      </div>
    </div>
  </NModal>
</template>

<style>
.diary-event-list-dialog.n-card {
  width: min(620px, calc(100vw - 32px));
  max-height: 80dvh;
}
.diary-event-list-dialog .n-card__content {
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.diary-event-list-heading {
  color: var(--text-muted, #6b7280);
  font-size: 14px;
}
.diary-event-list-scroll {
  min-height: 0;
  max-height: 60dvh;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-inline: 2px;
}
.diary-event-list-card {
  width: 100%;
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr);
  gap: 12px;
  align-items: start;
  padding: 12px;
  border: 1px solid var(--border, #d9dce5);
  border-radius: 12px;
  background: var(--surface, transparent);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.diary-event-list-card:hover,
.diary-event-list-card:focus-visible {
  border-color: var(--accent, #6366f1);
  outline: none;
}
.diary-event-list-emoji {
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  background: color-mix(in srgb, var(--accent, #6366f1) 12%, transparent);
  font-size: 24px;
}
.diary-event-list-emoji img { width: 28px; height: 28px; }
.diary-event-list-content { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.diary-event-list-content strong { font-size: 16px; }
.diary-event-list-meta { color: var(--text-muted, #6b7280); font-size: 13px; }
.diary-event-list-description {
  color: var(--text-muted, #6b7280);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  white-space: pre-wrap;
}
.diary-event-list-countdown { color: var(--accent, #6366f1); font-size: 13px; }
.diary-event-list-status { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 120px; color: var(--text-muted, #6b7280); }
.diary-event-list-more { display: flex; justify-content: center; padding-top: 4px; }
@media (max-width: 600px) {
  .diary-event-list-dialog.n-card {
    position: fixed;
    bottom: 0;
    left: 0;
    width: 100%;
    max-height: 90dvh;
    margin: 0;
    border-radius: 18px 18px 0 0;
    padding-bottom: env(safe-area-inset-bottom);
  }
  .diary-event-list-scroll { max-height: 68dvh; }
}
</style>
