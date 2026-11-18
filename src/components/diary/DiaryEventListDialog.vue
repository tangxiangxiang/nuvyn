<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NEmpty, NSpin } from 'naive-ui'
import { dayDistance, displayEventTitle, nextOccurrence, type DiaryEvent } from '../../../shared/diaryLife'
import type { DiaryTaskListItem, DiaryTaskListStatus } from '../../../shared/diaryTasks'
import { formatLunarRule } from '../../../shared/lunarCalendar'
import { eventEmojiSource } from '../../features/diary/eventEmoji'
import { shouldShowEventDeadlineReminder } from '../../features/diary/deadlineVisualState'
import { alarmClockAsset } from '../../features/diary/deadlineReminderAssets'
import { usePrefersReducedMotion } from '../../composables/usePrefersReducedMotion'
import DiaryTaskRows from './DiaryTaskRows.vue'
import './diaryCloudCard.css'

const props = withDefaults(defineProps<{
  items: DiaryEvent[]
  tasks?: DiaryTaskListItem[]
  taskStatus?: DiaryTaskListStatus
  busyTaskIds?: Set<string>
  today: string
  loading?: boolean
  loadingMore?: boolean
  hasMore?: boolean
  error?: string
  taskLoading?: boolean
  taskLoadingMore?: boolean
  taskHasMore?: boolean
  taskError?: string
}>(), {
  tasks: () => [],
  taskStatus: 'open',
  busyTaskIds: () => new Set<string>(),
  loading: false,
  loadingMore: false,
  hasMore: false,
  error: '',
  taskLoading: false,
  taskLoadingMore: false,
  taskHasMore: false,
  taskError: '',
})

const emit = defineEmits<{
  retry: []
  'load-more': []
  select: [event: DiaryEvent, scrollTop: number, keyboardActivated: boolean]
  'toggle-task': [task: DiaryTaskListItem]
  'edit-task': [task: DiaryTaskListItem, scrollTop: number, keyboardActivated: boolean]
  'load-more-tasks': []
  'retry-tasks': []
  'toggle-task-status': []
}>()

const scroller = ref<HTMLElement | null>(null)
const prefersReducedMotion = usePrefersReducedMotion()
const taskLabel = computed(() => props.taskStatus === 'open' ? '待办事项' : '已完成')
const isCompletelyEmpty = computed(() => !props.loading && !props.error && !props.taskLoading && !props.taskError
  && props.items.length === 0 && props.tasks.length === 0)

defineExpose({
  getScrollTop() {
    return scroller.value?.scrollTop ?? 0
  },
  restoreScroll(scrollTop: number) {
    if (scroller.value) scroller.value.scrollTop = scrollTop
  },
  focusEvent(eventId: string) {
    const eventButton = [...(scroller.value?.querySelectorAll<HTMLButtonElement>('[data-event-id]') ?? [])]
      .find(button => button.dataset.eventId === eventId)
    eventButton?.focus({ preventScroll: true })
    return Boolean(eventButton)
  },
  focusTask(taskId: string) {
    const taskButton = [...(scroller.value?.querySelectorAll<HTMLButtonElement>('[data-task-id]') ?? [])]
      .find(button => button.dataset.taskId === taskId)
    taskButton?.focus({ preventScroll: true })
    return Boolean(taskButton)
  },
})

const typeLabels: Record<DiaryEvent['type'], string> = {
  milestone: '人生时刻',
  anniversary: '纪念日',
  birthday: '生日',
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
  if (event.dateRule?.calendar === 'chinese') return formatLunarRule(event.dateRule)
  if (event.recurrence === 'yearly') return formatDate(event)
  return `${formatDate(event)} · ${typeLabels[event.type]}`
}

const occurrenceDates = computed(() => new Map(props.items.map(event => [event.id, nextOccurrence(event, props.today)])))
function eventTitle(event: DiaryEvent): string {
  return displayEventTitle(event, occurrenceDates.value.get(event.id))
}

const countdowns = computed(() => new Map(props.items.map(event => {
  if (!event.showCountdown) return [event.id, null]
  const date = occurrenceDates.value.get(event.id)
  return [event.id, date ? dayDistance(props.today, date) : null]
})))

function editTask(task: DiaryTaskListItem, keyboardActivated: boolean) {
  emit('edit-task', task, scroller.value?.scrollTop ?? 0, keyboardActivated)
}
</script>

<template>
  <div class="diary-event-list-content">
    <div v-if="loading && !items.length && !tasks.length && !taskError" class="diary-event-list-status" role="status">
      <NSpin size="small" />
      <span>正在加载…</span>
    </div>
    <div v-else-if="error && !items.length && !tasks.length && !taskError" class="diary-event-list-status" role="alert">
      <span>{{ error }}</span>
      <NButton text type="primary" @click="emit('retry')">重试</NButton>
    </div>
    <div v-else ref="scroller" class="diary-event-list-scroll">
      <section v-if="tasks.length || taskLoading || taskError" class="diary-task-list-section">
        <header v-if="tasks.length" class="diary-list-section-header">
          <h3>{{ taskLabel }}</h3>
          <NButton text type="primary" :disabled="taskLoading || taskLoadingMore" @click="emit('toggle-task-status')">
            {{ taskStatus === 'open' ? '查看已完成' : '返回待办' }}
          </NButton>
        </header>
        <div v-if="taskLoading && !tasks.length" class="diary-event-list-status" role="status"><NSpin size="small" /><span>正在加载待办…</span></div>
        <div v-else-if="taskError" class="diary-event-list-status" role="alert">
          <span>{{ taskError }}</span>
          <NButton text type="primary" @click="emit('retry-tasks')">重试</NButton>
        </div>
        <DiaryTaskRows v-else :items="tasks" :today="today" :busy-ids="busyTaskIds" show-deadline-reminder @toggle="emit('toggle-task', $event)" @edit="editTask" />
        <div v-if="taskHasMore" class="diary-event-list-more">
          <NButton secondary :loading="taskLoadingMore" @click="emit('load-more-tasks')">加载更多待办</NButton>
        </div>
      </section>

      <div v-if="tasks.length === 0 && !taskLoading && !taskError && taskStatus === 'open'" class="diary-task-list-toggle">
        <NButton text type="primary" @click="emit('toggle-task-status')">查看已完成</NButton>
      </div>
      <div v-if="tasks.length === 0 && !taskLoading && !taskError && taskStatus === 'completed'" class="diary-task-list-toggle">
        <NButton text type="primary" @click="emit('toggle-task-status')">返回待办</NButton>
      </div>

      <NEmpty v-if="isCompletelyEmpty" description="还没有近期事项" />

      <section v-if="items.length || loading || error" class="diary-event-list-section">
        <h3 v-if="tasks.length" class="diary-list-section-title">事件</h3>
        <div v-if="loading && !items.length" class="diary-event-list-status" role="status"><NSpin size="small" /><span>正在加载事件…</span></div>
        <div v-else-if="error" class="diary-event-list-status" role="alert">
          <span>{{ error }}</span>
          <NButton text type="primary" @click="emit('retry')">重试</NButton>
        </div>
        <button
          v-for="event in items"
          :key="event.id"
          type="button"
          class="diary-event-list-item diary-cloud-card"
          :data-event-id="event.id"
          :aria-label="eventTitle(event)"
          @click="emit('select', event, scroller?.scrollTop ?? 0, $event.detail === 0)"
        >
          <span class="diary-event-list-emoji" aria-hidden="true">
            <img v-if="eventEmojiSource(event.emoji)" :src="eventEmojiSource(event.emoji)" alt="">
            <span v-else>{{ event.emoji }}</span>
          </span>
          <span class="diary-event-list-copy">
            <strong>{{ eventTitle(event) }}</strong>
            <span class="diary-event-list-meta">{{ secondaryLabel(event) }}</span>
          </span>
          <span v-if="countdowns.get(event.id) !== null && countdowns.get(event.id) !== undefined || shouldShowEventDeadlineReminder(event, today)" class="diary-event-list-trailing">
            <img v-if="shouldShowEventDeadlineReminder(event, today)" class="diary-event-deadline-reminder" :src="alarmClockAsset(prefersReducedMotion)" alt="" aria-hidden="true" data-testid="event-deadline-reminder">
            <span v-if="countdowns.get(event.id) !== null && countdowns.get(event.id) !== undefined" class="diary-event-list-countdown">
              <strong>{{ countdowns.get(event.id) === 0 ? '今天' : countdowns.get(event.id) }}</strong>
              <small>{{ countdowns.get(event.id) === 0 ? '就是今天' : '天后' }}</small>
            </span>
          </span>
        </button>
        <div v-if="hasMore" class="diary-event-list-more">
          <NButton secondary :loading="loadingMore" @click="emit('load-more')">加载更多事件</NButton>
        </div>
      </section>

      <div v-if="!tasks.length && !taskLoading && !taskError && taskHasMore" class="diary-event-list-more">
        <NButton secondary :loading="taskLoadingMore" @click="emit('load-more-tasks')">加载更多待办</NButton>
      </div>
      <div v-if="!items.length && !loading && !error && hasMore" class="diary-event-list-more">
        <NButton secondary :loading="loadingMore" @click="emit('load-more')">加载更多事件</NButton>
      </div>
    </div>
  </div>
</template>

<style>
.diary-event-list-content { min-height: 0; }
.diary-event-list-scroll {
  max-height: min(60dvh, 560px);
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow: auto;
  scrollbar-width: none;
}
.diary-event-list-scroll::-webkit-scrollbar { display: none; }
.diary-list-section-header { display: flex; min-height: 36px; align-items: center; justify-content: space-between; gap: 8px; }
.diary-list-section-header h3,
.diary-list-section-title { margin: 0; font-size: 14px; font-weight: 600; }
.diary-event-list-section { display: flex; flex-direction: column; gap: 10px; }
.diary-list-section-title { padding-top: 4px; }
.diary-task-list-section { display: flex; flex-direction: column; gap: 4px; }
.diary-task-list-toggle { display: flex; justify-content: flex-end; min-height: 32px; }
.diary-event-list-item {
  width: 100%;
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  padding: 13px 12px;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.diary-event-list-item:focus-visible { outline: none; }
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
.diary-event-list-trailing { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.diary-event-deadline-reminder { width: 20px; height: 20px; flex: none; object-fit: contain; }
.diary-event-list-countdown { display: flex; min-width: 62px; flex-direction: column; align-items: flex-end; white-space: nowrap; }
.diary-event-list-countdown strong { font-size: 16px; font-variant-numeric: tabular-nums; }
.diary-event-list-countdown small { color: var(--text-muted, #6b7280); font-size: 12px; }
.diary-event-list-status { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 120px; color: var(--text-muted, #6b7280); }
.diary-event-list-more { display: flex; justify-content: center; padding: 14px 0 4px; }
@media (max-width: 420px) {
  .diary-event-list-item { grid-template-columns: 28px minmax(0, 1fr) auto; gap: 8px; padding-inline: 8px; }
  .diary-event-list-countdown { min-width: 52px; }
}
</style>
