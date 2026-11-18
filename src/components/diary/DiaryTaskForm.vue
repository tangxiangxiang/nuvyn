<script setup lang="ts">
import { computed, ref } from 'vue'
import { NInput, NSelect, type InputInst } from 'naive-ui'
import { MAX_DIARY_TASK_DESCRIPTION_LENGTH, MAX_DIARY_TASK_TITLE_LENGTH, taskTimeFieldsError, type TaskEditorFields } from '../../../shared/diaryTasks'
import type { TaskRecurrenceFrequency } from '../../../shared/diaryTaskRecurrence'

const props = withDefaults(defineProps<{
  modelValue: TaskEditorFields
  inert?: boolean
  today: string
  allowRecurrence?: boolean
  allowEventLink?: boolean
  lockRecurrenceStart?: boolean
  eventOptions?: Array<{ label: string; value: string }>
  eventOptionsLoading?: boolean
}>(), {
  allowRecurrence: true,
  allowEventLink: true,
  lockRecurrenceStart: false,
  eventOptions: () => [],
  eventOptionsLoading: false,
})
const emit = defineEmits<{
  'update:modelValue': [value: TaskEditorFields]
  'event-picker-open': []
}>()
const titleInput = ref<InputInst | null>(null)
const eventPickerExpanded = ref(Boolean(props.modelValue.eventId))
const eventSelectShown = ref(false)
const recurrenceStartLocked = computed(() => props.modelValue.recurrence !== null && props.lockRecurrenceStart)
const title = computed({
  get: () => props.modelValue.title,
  set: (title: string) => emit('update:modelValue', { ...props.modelValue, title }),
})
const date = computed({
  get: () => props.modelValue.recurrence?.startDate ?? props.modelValue.dueDate ?? '',
  set: (value: string) => {
    if (recurrenceStartLocked.value) return
    if (props.modelValue.recurrence) {
      emit('update:modelValue', { ...props.modelValue, recurrence: { ...props.modelValue.recurrence, startDate: value } })
    } else {
      emit('update:modelValue', { ...props.modelValue, dueDate: value || null, dueTime: value ? props.modelValue.dueTime : null })
    }
  },
})
const startDate = computed({
  get: () => props.modelValue.startDate ?? '',
  set: (value: string) => emit('update:modelValue', {
    ...props.modelValue,
    startDate: value || null,
    startTime: value ? props.modelValue.startTime : null,
  }),
})
const startTime = computed({
  get: () => props.modelValue.startTime ?? '',
  set: (value: string) => emit('update:modelValue', { ...props.modelValue, startTime: value || null }),
})
const time = computed({
  get: () => props.modelValue.dueTime ?? '',
  set: (dueTime: string) => emit('update:modelValue', { ...props.modelValue, dueTime: dueTime || null }),
})
const timeError = computed(() => {
  const error = taskTimeFieldsError(props.modelValue)
  switch (error) {
    case 'invalid-start-date': return '开始日期无效。'
    case 'invalid-start-time': return '开始时间无效。'
    case 'start-time-without-date': return '请先设置开始日期。'
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
const frequency = computed({
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
      eventId: recurrence ? null : props.modelValue.eventId,
    })
  },
})
const untilDate = computed({
  get: () => props.modelValue.recurrence?.untilDate ?? '',
  set: (untilDate: string) => {
    if (props.modelValue.recurrence) emit('update:modelValue', {
      ...props.modelValue,
      recurrence: { ...props.modelValue.recurrence, untilDate: untilDate || null },
    })
  },
})
const eventId = computed({
  get: () => props.modelValue.recurrence ? null : props.modelValue.eventId ?? null,
  set: (value: string | null) => {
    if (!props.modelValue.recurrence) emit('update:modelValue', { ...props.modelValue, eventId: value })
  },
})

function onEventPickerVisibility(visible: boolean) {
  if (visible) emit('event-picker-open')
}

function openEventPicker() {
  eventPickerExpanded.value = true
  eventSelectShown.value = true
  emit('event-picker-open')
}

defineExpose({ focusTitle: () => titleInput.value?.focus() })
</script>

<template>
  <div class="diary-task-form">
    <label class="diary-task-form-field diary-task-form-title">
      <span>待办名称</span>
      <NInput
        ref="titleInput"
        v-model:value="title"
        :disabled="inert"
        :maxlength="MAX_DIARY_TASK_TITLE_LENGTH"
        placeholder="要完成的事情"
        :input-props="{ 'aria-label': '待办名称' }"
      />
    </label>
    <div v-if="modelValue.recurrence" class="diary-task-form-due">
      <label class="diary-task-form-field">
        <span>开始日期</span>
        <input v-model="date" type="date" :aria-label="modelValue.recurrence ? '开始日期' : '截止日期'" :disabled="inert || recurrenceStartLocked">
      </label>
      <label class="diary-task-form-field">
        <span>截止时间</span>
        <input v-model="time" type="time" aria-label="截止时间" :disabled="inert || !date">
      </label>
      <button v-if="date && !recurrenceStartLocked" type="button" class="diary-task-clear-date" :disabled="inert" @click="date = ''">清除日期</button>
    </div>
    <div v-else class="diary-task-form-time-groups">
      <div class="diary-task-form-time-group">
        <div class="diary-task-form-time-heading">开始时间 <small>可选</small></div>
        <div class="diary-task-form-time-inputs">
          <input v-model="startDate" type="date" aria-label="开始日期" :disabled="inert" :aria-invalid="Boolean(timeError)">
          <input v-model="startTime" type="time" aria-label="开始时间" :disabled="inert || !startDate" :aria-invalid="Boolean(timeError)">
          <button v-if="startDate" type="button" class="diary-task-clear-date" :disabled="inert" @click="startDate = ''">清除开始时间</button>
        </div>
      </div>
      <div class="diary-task-form-time-group">
        <div class="diary-task-form-time-heading">截止时间 <small>可选</small></div>
        <div class="diary-task-form-time-inputs">
          <input v-model="date" type="date" aria-label="截止日期" :disabled="inert" :aria-invalid="Boolean(timeError)">
          <input v-model="time" type="time" aria-label="截止时间" :disabled="inert || !date" :aria-invalid="Boolean(timeError)">
          <button v-if="date" type="button" class="diary-task-clear-date" :disabled="inert" @click="date = ''">清除截止时间</button>
        </div>
      </div>
    </div>
    <p v-if="timeError" class="diary-task-form-time-error" role="alert">{{ timeError }}</p>
    <label v-if="allowRecurrence" class="diary-task-form-field">
      <span>重复</span>
      <select v-model="frequency" aria-label="重复规则" :disabled="inert">
        <option v-for="option in frequencyOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
      </select>
    </label>
    <label v-if="modelValue.recurrence" class="diary-task-form-field">
      <span>结束日期 <small>可选</small></span>
      <input v-model="untilDate" type="date" aria-label="重复结束日期" :min="modelValue.recurrence.startDate" :disabled="inert">
    </label>
    <div v-if="allowEventLink && !modelValue.recurrence" class="diary-task-form-field">
      <span>关联日程 <small>可选</small></span>
      <button v-if="!eventPickerExpanded" type="button" class="diary-task-link-trigger" :disabled="inert" @click="openEventPicker">选择日程</button>
      <NSelect
        v-else
        v-model:value="eventId"
        v-model:show="eventSelectShown"
        :options="eventOptions"
        :loading="eventOptionsLoading"
        :disabled="inert"
        clearable
        filterable
        placeholder="不关联日程"
        aria-label="关联日程"
        @update:show="onEventPickerVisibility"
      />
    </div>
    <label class="diary-task-form-field diary-task-form-description">
      <span>备注 <small>可选</small></span>
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
.diary-task-form-field select { width: 100%; min-width: 0; height: 38px; box-sizing: border-box; padding: 0 9px; border: 1px solid var(--border, #d9dce5); border-radius: 7px; background: var(--input-color, var(--bg)); color: inherit; font: inherit; }
.diary-task-link-trigger { align-self: flex-start; min-height: 32px; padding: 2px 0; border: 0; background: transparent; color: var(--accent, #6366f1); font: inherit; font-size: 13px; cursor: pointer; }
.diary-task-link-trigger:disabled { opacity: .55; cursor: default; }
.diary-task-form-title input { font-size: 17px; }
.diary-task-form-due { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; gap: 10px; align-items: end; min-width: 0; }
.diary-task-form-time-groups { display: flex; min-width: 0; flex-direction: column; gap: 14px; }
.diary-task-form-time-group { display: flex; min-width: 0; flex-direction: column; gap: 7px; }
.diary-task-form-time-heading { color: var(--text-muted, #6b7280); font-size: 14px; }
.diary-task-form-time-heading small { font-size: 12px; font-weight: 400; }
.diary-task-form-time-inputs { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; gap: 10px; align-items: end; min-width: 0; }
.diary-task-form-due input {
  width: 100%;
  min-width: 0;
  height: 38px;
  box-sizing: border-box;
  padding: 0 9px;
  border: 1px solid var(--border, #d9dce5);
  border-radius: 7px;
  background: var(--input-color, var(--bg));
  color: inherit;
  font: inherit;
}
.diary-task-form-time-inputs input {
  width: 100%;
  min-width: 0;
  height: 38px;
  box-sizing: border-box;
  padding: 0 9px;
  border: 1px solid var(--border, #d9dce5);
  border-radius: 7px;
  background: var(--input-color, var(--bg));
  color: inherit;
  font: inherit;
}
.diary-task-form-time-inputs input:disabled { opacity: .55; }
.diary-task-form-time-inputs input[aria-invalid="true"] { border-color: var(--error-color, #d03050); }
.diary-task-form-time-error { margin: -10px 0 0; color: var(--error-color, #d03050); font-size: 12px; }
.diary-task-form-due input:disabled { opacity: .55; }
.diary-task-clear-date { height: 38px; padding: 0 4px; border: 0; background: transparent; color: var(--text-muted, #6b7280); font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; }
.diary-task-clear-date:disabled { cursor: default; opacity: .55; }
.diary-task-form-description textarea { resize: vertical; }
@media (max-width: 420px) {
  .diary-task-form-due { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .diary-task-form-time-inputs { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .diary-task-form-time-inputs .diary-task-clear-date { grid-column: 2; justify-self: end; height: 28px; }
  .diary-task-clear-date { grid-column: 2; justify-self: end; height: 28px; }
}
</style>
