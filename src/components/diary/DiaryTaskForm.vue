<script setup lang="ts">
import { computed, ref } from 'vue'
import { NDatePicker, NInput, NSelect, NTimePicker, type InputInst } from 'naive-ui'
import { MAX_DIARY_TASK_DESCRIPTION_LENGTH, MAX_DIARY_TASK_TITLE_LENGTH, taskTimeFieldsError, type TaskEditorFields } from '../../../shared/diaryTasks'
import type { TaskRecurrenceFrequency } from '../../../shared/diaryTaskRecurrence'
import { taskCompletionInfo, taskOverdueLabel, type TaskCompletionRecord } from '../../features/diary/taskCompletion'

type TaskEditorStatus = TaskCompletionRecord & { skipped?: boolean }

const props = withDefaults(defineProps<{
  modelValue: TaskEditorFields
  statusTask?: TaskEditorStatus | null
  now?: number
  inert?: boolean
  today: string
  allowRecurrence?: boolean
  lockRecurrenceStart?: boolean
}>(), {
  allowRecurrence: true,
  lockRecurrenceStart: false,
})
const emit = defineEmits<{
  'update:modelValue': [value: TaskEditorFields]
}>()
const titleInput = ref<InputInst | null>(null)
const recurrenceStartLocked = computed(() => props.modelValue.recurrence !== null && props.lockRecurrenceStart)
const completionInfo = computed(() => {
  const task = props.statusTask
  return task && task.completedAt !== null ? taskCompletionInfo(task) : null
})
const completionDisplay = computed(() => {
  const task = props.statusTask
  if (!task || task.skipped) return null

  if (task.completedAt !== null) {
    const info = completionInfo.value
    if (!info) return null
    return {
      left: info.completedAtLabel,
      right: info.overdueLabel?.replace(/^逾期\s*/, '逾期') ?? '按时完成',
      overdue: Boolean(info.overdueLabel),
    }
  }

  const overdueLabel = taskOverdueLabel(task, props.now ?? Date.now())
  return overdueLabel
    ? { left: '尚未完成', right: overdueLabel, overdue: true }
    : null
})
const title = computed({
  get: () => props.modelValue.title,
  set: (title: string) => emit('update:modelValue', { ...props.modelValue, title }),
})
const date = computed<string | null>({
  get: () => props.modelValue.recurrence?.startDate ?? props.modelValue.dueDate,
  set: value => {
    const dateValue = value ?? ''
    if (recurrenceStartLocked.value) return
    if (props.modelValue.recurrence) {
      emit('update:modelValue', { ...props.modelValue, recurrence: { ...props.modelValue.recurrence, startDate: dateValue } })
    } else {
      emit('update:modelValue', { ...props.modelValue, dueDate: dateValue || null, dueTime: dateValue ? props.modelValue.dueTime : null })
    }
  },
})
const startDate = computed<string | null>({
  get: () => props.modelValue.startDate,
  set: value => emit('update:modelValue', {
    ...props.modelValue,
    startDate: value || null,
    startTime: value ? props.modelValue.startTime : null,
  }),
})
const startTime = computed<string | null>({
  get: () => props.modelValue.startTime,
  set: value => emit('update:modelValue', { ...props.modelValue, startTime: value || null }),
})
const time = computed<string | null>({
  get: () => props.modelValue.dueTime,
  set: dueTime => emit('update:modelValue', { ...props.modelValue, dueTime: dueTime || null }),
})
const timeError = computed(() => {
  const error = taskTimeFieldsError(props.modelValue, props.modelValue.recurrence === null)
  switch (error) {
    case 'invalid-start-date': return '开始日期无效。'
    case 'invalid-start-time': return '开始时间无效。'
    case 'start-time-without-date': return '请先设置开始日期。'
    case 'missing-due-date': return '请选择截止日期。'
    case 'invalid-due-date': return '截止日期无效。'
    case 'invalid-due-time': return '截止时间无效。'
    case 'due-time-without-date': return '请先设置截止日期。'
    case 'start-after-due-date': return '开始日期不能晚于截止日期。'
    case 'start-time-after-due-time': return '同一天的开始时间不能晚于截止时间。'
    default: return ''
  }
})
const description = computed({
  get: () => props.modelValue.description,
  set: (description: string) => emit('update:modelValue', { ...props.modelValue, description }),
})
const frequencyOptions = computed(() => [
  ...(recurrenceStartLocked.value ? [] : [{ value: '' as const, label: '不重复' }]),
  { value: 'daily' as const, label: '每天' },
  { value: 'weekly' as const, label: '每周' },
  { value: 'monthly' as const, label: '每月' },
  { value: 'yearly' as const, label: '每年' },
])
const frequency = computed<TaskRecurrenceFrequency | ''>({
  get: () => props.modelValue.recurrence?.frequency ?? '',
  set: (value: TaskRecurrenceFrequency | '') => {
    if (recurrenceStartLocked.value && value === '') return
    const previousDate = props.modelValue.recurrence?.startDate ?? props.modelValue.startDate ?? props.modelValue.dueDate
    const recurrence = value ? {
      frequency: value,
      startDate: previousDate ?? props.today,
      untilDate: props.modelValue.recurrence?.untilDate ?? null,
    } : null
    emit('update:modelValue', {
      ...props.modelValue,
      recurrence,
      dueDate: recurrence ? recurrence.startDate : previousDate,
    })
  },
})
const untilDate = computed<string | null>({
  get: () => props.modelValue.recurrence?.untilDate ?? null,
  set: untilDate => {
    if (props.modelValue.recurrence) emit('update:modelValue', {
      ...props.modelValue,
      recurrence: { ...props.modelValue.recurrence, untilDate: untilDate || null },
    })
  },
})
const recurrenceStartTimestamp = computed(() => {
  const recurrenceStartDate = props.modelValue.recurrence?.startDate
  if (!recurrenceStartDate) return null
  const [year, month, day] = recurrenceStartDate.split('-').map(Number)
  return new Date(year!, month! - 1, day!).getTime()
})
const isBeforeRecurrenceStart = (timestamp: number) => recurrenceStartTimestamp.value !== null
  && timestamp < recurrenceStartTimestamp.value
function updateFrequency(value: string | number | null) {
  if (typeof value === 'string') frequency.value = value as TaskRecurrenceFrequency | ''
}

defineExpose({ focusTitle: () => titleInput.value?.focus() })
</script>

<template>
  <div class="diary-task-form">
    <label class="diary-task-form-field diary-task-form-title">
      <span>待办名称<span class="diary-task-required" aria-hidden="true">*</span></span>
      <NInput
        ref="titleInput"
        v-model:value="title"
        :disabled="inert"
        :maxlength="MAX_DIARY_TASK_TITLE_LENGTH"
        placeholder="要完成的事情"
        :input-props="{ 'aria-label': '待办名称', required: true }"
      />
    </label>
    <div v-if="modelValue.recurrence" class="diary-task-form-due">
      <label class="diary-task-form-field">
        <span>开始日期</span>
        <NDatePicker
          v-model:formatted-value="date"
          class="diary-task-date-picker"
          type="date"
          format="yyyy-MM-dd"
          value-format="yyyy-MM-dd"
          :aria-label="modelValue.recurrence ? '开始日期' : '截止日期'"
          :disabled="inert || recurrenceStartLocked"
        />
      </label>
      <label class="diary-task-form-field">
        <span>截止时间</span>
        <NTimePicker
          v-model:formatted-value="time"
          class="diary-task-time-picker"
          format="HH:mm"
          value-format="HH:mm"
          aria-label="截止时间"
          clearable
          :disabled="inert || !date"
        />
      </label>
    </div>
    <div v-else class="diary-task-form-time-groups">
      <div class="diary-task-form-time-group">
        <div class="diary-task-form-time-heading">开始时间</div>
        <div class="diary-task-form-time-inputs">
          <NDatePicker
            v-model:formatted-value="startDate"
            class="diary-task-date-picker"
            type="date"
            format="yyyy-MM-dd"
            value-format="yyyy-MM-dd"
            aria-label="开始日期"
            clearable
            :status="timeError ? 'error' : undefined"
            :disabled="inert"
          />
          <NTimePicker
            v-model:formatted-value="startTime"
            class="diary-task-time-picker"
            format="HH:mm"
            value-format="HH:mm"
            aria-label="开始时间"
            clearable
            :status="timeError ? 'error' : undefined"
            :disabled="inert || !startDate"
          />
        </div>
      </div>
      <div class="diary-task-form-time-group">
        <div class="diary-task-form-time-heading">截止日期<span class="diary-task-required" aria-hidden="true">*</span></div>
        <div class="diary-task-form-time-inputs">
          <NDatePicker
            v-model:formatted-value="date"
            class="diary-task-date-picker"
            type="date"
            format="yyyy-MM-dd"
            value-format="yyyy-MM-dd"
            aria-label="截止日期"
            aria-required="true"
            clearable
            :status="timeError ? 'error' : undefined"
            :disabled="inert"
          />
          <NTimePicker
            v-model:formatted-value="time"
            class="diary-task-time-picker"
            format="HH:mm"
            value-format="HH:mm"
            aria-label="截止时间"
            clearable
            :status="timeError ? 'error' : undefined"
            :disabled="inert || !date"
          />
        </div>
      </div>
    </div>
    <p v-if="timeError" class="diary-task-form-time-error" role="alert">{{ timeError }}</p>
    <label v-if="allowRecurrence" class="diary-task-form-field">
      <span>重复</span>
      <NSelect :value="frequency" :options="frequencyOptions" aria-label="重复规则" :disabled="inert" @update:value="updateFrequency" />
    </label>
    <label v-if="modelValue.recurrence" class="diary-task-form-field">
      <span>结束日期<span class="diary-task-required" aria-hidden="true">*</span></span>
      <NDatePicker
        v-model:formatted-value="untilDate"
        class="diary-task-date-picker"
        type="date"
        format="yyyy-MM-dd"
        value-format="yyyy-MM-dd"
        aria-label="重复结束日期"
        clearable
        :is-date-disabled="isBeforeRecurrenceStart"
        :disabled="inert"
      />
    </label>
    <div v-if="completionDisplay" class="diary-task-form-field diary-task-form-completion">
      <span class="diary-task-form-completion-label">完成状态</span>
      <div class="diary-task-form-completion-value" data-testid="diary-task-completion">
        <span class="diary-task-form-completion-left">{{ completionDisplay.left }}</span>
        <span class="diary-task-form-completion-right" :class="{ 'is-overdue': completionDisplay.overdue }">{{ completionDisplay.right }}</span>
      </div>
    </div>
    <label class="diary-task-form-field diary-task-form-description">
      <span>备注</span>
      <NInput
        v-model:value="description"
        type="textarea"
        :disabled="inert"
        :maxlength="MAX_DIARY_TASK_DESCRIPTION_LENGTH"
        :autosize="{ minRows: 2, maxRows: 5 }"
        placeholder=""
        :input-props="{ 'aria-label': '待办备注' }"
      />
    </label>
  </div>
</template>

<style>
.diary-task-form { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
.diary-task-form-field { display: flex; min-width: 0; flex-direction: column; gap: 7px; color: var(--text); font-size: 14px; }
.diary-task-form-field > span { color: var(--text-muted, #6b7280); }
.diary-task-form-field > span small { font-size: 12px; font-weight: 400; }
.diary-task-required { margin-left: 3px; color: var(--error-color, #d03050); }
.diary-task-form :deep(.diary-task-date-picker),
.diary-task-form :deep(.diary-task-time-picker),
.diary-task-form :deep(.n-select) { width: 100%; min-width: 0; }
.diary-task-form-title input { font-size: 17px; }
.diary-task-form-due { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; align-items: end; min-width: 0; }
.diary-task-form-time-groups { display: flex; min-width: 0; flex-direction: column; gap: 14px; }
.diary-task-form-time-group { display: flex; min-width: 0; flex-direction: column; gap: 7px; }
.diary-task-form-time-heading { color: var(--text-muted, #6b7280); font-size: 14px; }
.diary-task-form-time-heading small { font-size: 12px; font-weight: 400; }
.diary-task-form-time-inputs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; align-items: end; min-width: 0; }
.diary-task-form-time-error { margin: -10px 0 0; color: var(--error-color, #d03050); font-size: 12px; }
.diary-task-form-completion { gap: 7px; }
.diary-task-form-completion-label { color: var(--text-muted, #6b7280); }
.diary-task-form-completion-value { box-sizing: border-box; display: flex; width: 100%; min-width: 0; min-height: 34px; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 12px; padding: 6px 12px; border: 1px solid var(--nuvyn-border, var(--border)); border-radius: var(--nuvyn-radius-md, 8px); background: var(--nuvyn-surface-1, var(--bg-soft)); color: var(--text); font-size: 14px; line-height: 1.5; font-variant-numeric: tabular-nums; user-select: text; }
.diary-task-form-completion-left,
.diary-task-form-completion-right { min-width: 0; white-space: nowrap; }
.diary-task-form-completion-left { flex: 0 0 auto; }
.diary-task-form-completion-right { margin-left: auto; color: var(--text-muted, #6b7280); text-align: right; }
.diary-task-form-completion-right.is-overdue { color: color-mix(in srgb, var(--error-color, #d03050) 70%, var(--text-muted, #6b7280)); }
@media (max-width: 430px) {
  .diary-task-form-completion-value { gap: 4px 8px; padding-inline: 9px; font-size: 13px; }
}
.diary-task-form-description textarea { resize: vertical; }
</style>
