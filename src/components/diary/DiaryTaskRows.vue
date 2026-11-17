<script setup lang="ts">
import type { DiaryTask } from '../../../shared/diaryTasks'
import { taskDueDateLabel } from '../../features/diary/diaryTaskCalendar'

const props = withDefaults(defineProps<{
  items: DiaryTask[]
  today: string
  busyIds?: Set<string>
  showDueDate?: boolean
}>(), {
  busyIds: () => new Set<string>(),
  showDueDate: true,
})

const emit = defineEmits<{
  toggle: [task: DiaryTask]
  edit: [task: DiaryTask, keyboardActivated: boolean]
}>()

function detail(task: DiaryTask): string {
  if (props.showDueDate) return taskDueDateLabel(task, props.today)
  return task.dueTime ?? ''
}
</script>

<template>
  <div class="diary-task-rows">
    <div v-for="task in items" :key="task.id" class="diary-task-row" :class="{ 'is-completed': task.completedAt !== null }">
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
        type="button"
        class="diary-task-edit"
        :data-task-id="task.id"
        :aria-label="`编辑待办：${task.title}`"
        :disabled="busyIds.has(task.id)"
        @click="emit('edit', task, $event.detail === 0)"
      >
        <span class="diary-task-title">{{ task.title }}</span>
        <small v-if="detail(task)">{{ detail(task) }}</small>
      </button>
    </div>
  </div>
</template>

<style>
.diary-task-rows { display: flex; flex-direction: column; }
.diary-task-row {
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr);
  gap: 4px;
  align-items: center;
  min-width: 0;
  border-bottom: 1px solid color-mix(in srgb, var(--border, #d9dce5) 55%, transparent);
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
  display: flex;
  min-width: 0;
  min-height: 44px;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 3px;
  padding: 5px 8px 5px 2px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.diary-task-title { max-width: 100%; overflow-wrap: anywhere; line-height: 1.4; }
.diary-task-edit small { color: var(--text-muted, #6b7280); font-size: 12px; }
.diary-task-row.is-completed .diary-task-title { color: var(--text-muted, #6b7280); text-decoration: line-through; }
.diary-task-row.is-completed .diary-task-edit small { opacity: .72; }
</style>
