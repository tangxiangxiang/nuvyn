<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NEmpty, NSpin } from 'naive-ui'
import { dayDistance, displayEventTitle, nextOccurrence, type DiaryEvent } from '../../../shared/diaryLife'
import type { DiaryTaskListItem, DiaryTaskListStatus } from '../../../shared/diaryTasks'
import { shouldShowEventDeadlineReminder } from '../../features/diary/deadlineVisualState'
import { alarmClockAsset } from '../../features/diary/deadlineReminderAssets'
import { usePrefersReducedMotion } from '../../composables/usePrefersReducedMotion'
import DiaryAlarmClockIcon from './DiaryAlarmClockIcon.vue'
import DiaryEventRow from './DiaryEventRow.vue'
import DiaryTaskRows from './DiaryTaskRows.vue'
import './diaryDayList.css'

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

const occurrenceDates = computed(() => new Map(props.items.map(event => [event.id, nextOccurrence(event, props.today)])))
function eventTitle(event: DiaryEvent): string {
  return displayEventTitle(event, occurrenceDates.value.get(event.id))
}

const countdowns = computed(() => new Map(props.items.map(event => {
  if (!event.showCountdown) return [event.id, null]
  const date = occurrenceDates.value.get(event.id)
  return [event.id, date ? dayDistance(props.today, date) : null]
})))

function eventPrimaryInfo(event: DiaryEvent): string {
  const countdown = countdowns.value.get(event.id)
  if (countdown !== null && countdown !== undefined) {
    if (countdown === 0) return '今天'
    if (countdown === 1) return '明天'
    if (countdown === 2) return '后天'
    return `${countdown}天后`
  }

  const date = occurrenceDates.value.get(event.id) ?? event.startDate
  const [year, month, day] = date.split('-').map(Number)
  return year === Number(props.today.slice(0, 4))
    ? `${month}月${day}日`
    : `${year}年${month}月${day}日`
}

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
    <div v-else ref="scroller" class="day-list-content diary-event-list-scroll">
      <section v-if="tasks.length || taskLoading || taskError" class="day-tasks">
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

      <section v-if="items.length || loading || error" class="day-events">
        <h3 v-if="tasks.length" class="diary-list-section-title">重要日程</h3>
        <div v-if="loading && !items.length" class="diary-event-list-status" role="status"><NSpin size="small" /><span>正在加载事件…</span></div>
        <div v-else-if="error" class="diary-event-list-status" role="alert">
          <span>{{ error }}</span>
          <NButton text type="primary" @click="emit('retry')">重试</NButton>
        </div>
        <DiaryEventRow
          v-for="event in items"
          :key="event.id"
          class="diary-event-list-item"
          :title="eventTitle(event)"
          :emoji="event.emoji"
          single-line
          :data-event-id="event.id"
          :aria-label="eventTitle(event)"
          @click="emit('select', event, scroller?.scrollTop ?? 0, $event.detail === 0)"
        >
          <span class="diary-task-trailing">
            <small class="diary-task-detail diary-event-list-primary-info" :class="{ 'diary-event-list-countdown': countdowns.get(event.id) !== null && countdowns.get(event.id) !== undefined }">{{ eventPrimaryInfo(event) }}</small>
            <DiaryAlarmClockIcon v-if="shouldShowEventDeadlineReminder(event, today)" class="diary-task-deadline-reminder" :src="alarmClockAsset(prefersReducedMotion)" alt="" aria-hidden="true" data-testid="event-deadline-reminder" />
          </span>
        </DiaryEventRow>
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
  overflow: auto;
  scrollbar-width: none;
}
.diary-event-list-scroll::-webkit-scrollbar { display: none; }
.diary-task-list-toggle { display: flex; justify-content: flex-end; min-height: 32px; }
.diary-event-list-status { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 120px; color: var(--text-muted, #6b7280); }
.diary-event-list-more { display: flex; justify-content: center; padding: 14px 0 4px; }
</style>
