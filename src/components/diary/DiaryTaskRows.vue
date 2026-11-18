<script setup lang="ts">
import type { DiaryTaskListItem } from '../../../shared/diaryTasks'
import { taskDueDateLabel } from '../../features/diary/diaryTaskCalendar'
import { taskDeadlineVisualState } from '../../features/diary/deadlineVisualState'
import { taskDeadlineReminderAsset } from '../../features/diary/deadlineReminderAssets'
import { usePrefersReducedMotion } from '../../composables/usePrefersReducedMotion'
import DiaryAlarmClockIcon from './DiaryAlarmClockIcon.vue'
import './diaryCloudCard.css'

const props = withDefaults(defineProps<{
  items: DiaryTaskListItem[]
  today: string
  busyIds?: Set<string>
  showDueDate?: boolean
  editable?: boolean
  variant?: 'card' | 'plain'
  showDeadlineReminder?: boolean
}>(), {
  busyIds: () => new Set<string>(),
  showDueDate: true,
  editable: true,
  variant: 'card',
  showDeadlineReminder: false,
})
const prefersReducedMotion = usePrefersReducedMotion()

const emit = defineEmits<{
  toggle: [task: DiaryTaskListItem]
  edit: [task: DiaryTaskListItem, keyboardActivated: boolean]
}>()

function detail(task: DiaryTaskListItem): string {
  if (props.showDueDate) return taskDueDateLabel(task, props.today)
  if (!task.dueTime) return ''
  return task.kind === 'recurring' ? task.dueTime : `截止 ${task.dueTime}`
}

function hasDeadlineReminder(task: DiaryTaskListItem): boolean {
  if (!props.showDeadlineReminder) return false
  const state = taskDeadlineVisualState(task, props.today)
  return state === 'due-soon' || state === 'overdue'
}

function deadlineReminderSource(task: DiaryTaskListItem): string {
  return taskDeadlineReminderAsset(taskDeadlineVisualState(task, props.today), prefersReducedMotion.value) ?? ''
}
</script>

<template>
  <div class="diary-task-rows" :class="{ 'diary-task-rows--plain': variant === 'plain' }">
    <div v-for="task in items" :key="task.id" class="diary-task-row" :class="{ 'diary-cloud-card': variant === 'card', 'is-completed': task.completedAt !== null, 'is-skipped': task.kind === 'recurring' && task.skipped }">
      <button
        type="button"
        class="diary-task-toggle"
        role="checkbox"
        :aria-checked="task.completedAt !== null"
        :aria-label="`${task.completedAt === null ? '完成' : '恢复'}待办：${task.title}`"
        :data-task-toggle="task.id"
        :disabled="busyIds.has(task.id)"
        @click.stop="emit('toggle', task)"
      >
        <span aria-hidden="true">✓</span>
      </button>
      <button
        v-if="editable"
        type="button"
        class="diary-task-edit"
        :data-task-id="task.id"
        :aria-label="`编辑待办：${task.title}`"
        :disabled="busyIds.has(task.id)"
        @click="emit('edit', task, $event.detail === 0)"
      >
        <span class="diary-task-copy">
          <span class="diary-task-title">{{ task.title }}<span v-if="task.kind === 'recurring'" class="diary-task-repeat" aria-label="重复待办"> ↻</span></span>
          <small v-if="task.kind === 'recurring' && task.skipped" class="diary-task-status">本次已跳过</small>
        </span>
        <span v-if="detail(task) || hasDeadlineReminder(task)" class="diary-task-trailing">
          <small v-if="detail(task)" class="diary-task-detail">{{ detail(task) }}</small>
          <DiaryAlarmClockIcon v-if="hasDeadlineReminder(task)" class="diary-task-deadline-reminder" :src="deadlineReminderSource(task)" alt="" aria-hidden="true" />
        </span>
      </button>
      <div v-else class="diary-task-edit">
        <span class="diary-task-copy">
          <span class="diary-task-title">{{ task.title }}<span v-if="task.kind === 'recurring'" class="diary-task-repeat" aria-label="重复待办"> ↻</span></span>
          <small v-if="task.kind === 'recurring' && task.skipped" class="diary-task-status">本次已跳过</small>
        </span>
        <span v-if="detail(task) || hasDeadlineReminder(task)" class="diary-task-trailing">
          <small v-if="detail(task)" class="diary-task-detail">{{ detail(task) }}</small>
          <DiaryAlarmClockIcon v-if="hasDeadlineReminder(task)" class="diary-task-deadline-reminder" :src="deadlineReminderSource(task)" alt="" aria-hidden="true" />
        </span>
      </div>
    </div>
  </div>
</template>

<style>
.diary-task-rows { display: flex; min-width: 0; flex-direction: column; gap: 8px; }
.diary-task-row {
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr);
  gap: 4px;
  align-items: center;
  min-width: 0;
  box-sizing: border-box;
  padding: 4px 8px;
}
.day-tasks .diary-task-row { min-height: 48px; padding-top: 0; padding-bottom: 0; }
.day-tasks .diary-task-edit { min-height: 46px; padding-top: 0; padding-bottom: 0; }
.diary-task-rows--plain { gap: 0; }
.diary-task-rows--plain .diary-task-row {
  border: 0;
  border-bottom: 1px solid color-mix(in srgb, var(--border, #d9dce5) 55%, transparent);
  border-radius: 0;
  padding: 0;
}
.diary-task-toggle {
  position: relative;
  display: grid;
  width: 40px;
  height: 44px;
  place-items: center;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-muted, #6b7280);
  cursor: pointer;
}
.diary-task-toggle::before {
  position: absolute;
  width: 18px;
  height: 18px;
  box-sizing: border-box;
  border: 1.5px solid currentColor;
  border-radius: 50%;
  content: '';
}
.diary-task-toggle > span { position: relative; z-index: 1; font-size: 11px; opacity: 0; }
.diary-task-toggle[aria-checked='true'] { color: var(--primary, #6366f1); }
.diary-task-toggle[aria-checked='true']::before { border-color: currentColor; background: currentColor; }
.diary-task-toggle[aria-checked='true'] > span { color: var(--bg, #fff); opacity: 1; }
.diary-task-toggle:focus-visible,
.diary-task-edit:focus-visible { outline: 2px solid var(--primary, #6366f1); outline-offset: -2px; border-radius: 6px; }
.diary-task-toggle:disabled { opacity: .55; cursor: wait; }
.diary-task-edit {
  display: grid;
  width: 100%;
  box-sizing: border-box;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 44px;
  padding: 6px 4px 6px 2px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.diary-task-copy { display: flex; min-width: 0; flex-direction: column; justify-content: center; gap: 3px; }
.diary-task-title { display: block; max-width: 100%; overflow-wrap: anywhere; line-height: 1.4; }
.diary-task-repeat { white-space: nowrap; }
.diary-task-detail,
.diary-task-status { color: var(--text-muted, #6b7280); font-size: 12px; }
.diary-task-trailing { display: flex; align-items: center; justify-self: end; gap: 5px; min-width: 0; }
.diary-task-deadline-reminder { width: 18px; height: 18px; flex: none; object-fit: contain; }
.diary-task-detail {
  padding: 3px 6px;
  border-radius: 6px;
  background-color: color-mix(in srgb, var(--text) 4%, transparent);
  font-variant-numeric: tabular-nums;
  line-height: 1.4;
  white-space: nowrap;
}
.diary-task-row.is-completed .diary-task-title { color: var(--text-muted, #6b7280); text-decoration: line-through; }
.diary-task-row.is-completed .diary-task-edit small { opacity: .72; }
</style>
