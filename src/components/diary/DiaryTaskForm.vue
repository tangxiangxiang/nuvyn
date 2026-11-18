<script setup lang="ts">
import { computed, ref } from 'vue'
import { NDatePicker, NInput, NSelect, NTimePicker, type InputInst, type SelectOption } from 'naive-ui'
import { MAX_DIARY_TASK_DESCRIPTION_LENGTH, MAX_DIARY_TASK_TITLE_LENGTH, taskTimeFieldsError, type TaskEditorFields } from '../../../shared/diaryTasks'
import { dayDistance, type DiaryEvent } from '../../../shared/diaryLife'
import type { TaskRecurrenceFrequency } from '../../../shared/diaryTaskRecurrence'
import { buildTaskEventOccurrenceOptions, recommendedTaskEventOccurrence } from '../../features/diary/taskEventOccurrences'

const props = withDefaults(defineProps<{
  modelValue: TaskEditorFields
  inert?: boolean
  today: string
  allowRecurrence?: boolean
  allowEventLink?: boolean
  lockRecurrenceStart?: boolean
  eventOptions?: DiaryEvent[]
  eventOptionsLoading?: boolean
  eventOptionsError?: string
  preferredOccurrenceDate?: string | null
}>(), {
  allowRecurrence: true,
  allowEventLink: true,
  lockRecurrenceStart: false,
  eventOptions: () => [],
  eventOptionsLoading: false,
  eventOptionsError: '',
  preferredOccurrenceDate: null,
})
const emit = defineEmits<{
  'update:modelValue': [value: TaskEditorFields]
  'event-picker-open': []
}>()
const titleInput = ref<InputInst | null>(null)
const eventSelectShown = ref(false)
const eventSearch = ref('')
const recurrenceStartLocked = computed(() => props.modelValue.recurrence !== null && props.lockRecurrenceStart)
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
      eventId: recurrence ? null : props.modelValue.eventId,
      eventOccurrenceDate: recurrence ? null : props.modelValue.eventOccurrenceDate,
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
const eventOccurrenceOptions = computed(() => {
  const options = buildTaskEventOccurrenceOptions(props.eventOptions, {
    today: props.today,
    dueDate: props.modelValue.dueDate,
    preferredOccurrenceDate: props.preferredOccurrenceDate,
    selectedOccurrenceDate: props.modelValue.eventOccurrenceDate,
    search: eventSearch.value,
  })
  const targetDate = props.modelValue.dueDate ?? props.preferredOccurrenceDate ?? props.today
  const recommended = new Map(props.eventOptions.map(event => [
    event.id,
    recommendedTaskEventOccurrence(event, options, targetDate)?.value,
  ]))
  const events = new Map(props.eventOptions.map(event => [event.id, event]))
  return options.sort((left, right) => {
    const leftEvent = events.get(left.eventId)
    const rightEvent = events.get(right.eventId)
    const titleOrder = (leftEvent?.title ?? '').localeCompare(rightEvent?.title ?? '')
    if (titleOrder !== 0) return titleOrder
    const eventOrder = left.eventId.localeCompare(right.eventId)
    if (eventOrder !== 0) return eventOrder
    const leftRecommended = recommended.get(left.eventId) === left.value
    const rightRecommended = recommended.get(right.eventId) === right.value
    if (leftRecommended !== rightRecommended) return leftRecommended ? -1 : 1
    return Math.abs(dayDistance(targetDate, left.occurrenceDate)) - Math.abs(dayDistance(targetDate, right.occurrenceDate))
      || left.occurrenceDate.localeCompare(right.occurrenceDate)
  })
})
const selectedEventOccurrence = computed(() => eventOccurrenceOptions.value.find(option =>
  option.eventId === props.modelValue.eventId && option.occurrenceDate === props.modelValue.eventOccurrenceDate,
) ?? null)
const eventPickerValue = computed({
  get: () => props.modelValue.recurrence ? null : selectedEventOccurrence.value?.value ?? null,
  set: (value: string | null) => {
    if (props.modelValue.recurrence) return
    if (!value) {
      emit('update:modelValue', { ...props.modelValue, eventId: null, eventOccurrenceDate: null })
      return
    }
    const option = eventOccurrenceOptions.value.find(candidate => candidate.value === value)
    if (!option) return
    emit('update:modelValue', { ...props.modelValue, eventId: option.eventId, eventOccurrenceDate: option.occurrenceDate })
    eventSearch.value = ''
  },
})
const eventSelectOptions = computed<SelectOption[]>(() => eventOccurrenceOptions.value.map(option => ({ ...option })))
const eventSelectPlaceholder = computed(() => props.eventOptionsError
  ? '日程加载失败，打开选择框重试'
  : props.eventOptionsLoading && !selectedEventOccurrence.value
    ? '正在加载关联日程…'
    : '不关联日程')

function onEventPickerVisibility(visible: boolean) {
  if (visible) emit('event-picker-open')
}

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
        <div class="diary-task-form-time-heading">截止时间</div>
        <div class="diary-task-form-time-inputs">
          <NDatePicker
            v-model:formatted-value="date"
            class="diary-task-date-picker"
            type="date"
            format="yyyy-MM-dd"
            value-format="yyyy-MM-dd"
            aria-label="截止日期"
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
    <div v-if="allowEventLink && !modelValue.recurrence" class="diary-task-form-field">
      <span>关联日程</span>
      <NSelect
        class="diary-task-event-select"
        v-model:value="eventPickerValue"
        v-model:show="eventSelectShown"
        :options="eventSelectOptions"
        :loading="eventOptionsLoading"
        :placeholder="eventSelectPlaceholder"
        :disabled="inert"
        bordered
        clearable
        filterable
        aria-label="关联日程"
        @search="eventSearch = $event"
        @update:show="onEventPickerVisibility"
      />
      <span v-if="eventOptionsError" class="diary-task-form-error" role="status">{{ eventOptionsError }} 打开选择框可重试。</span>
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
.diary-task-form-description textarea { resize: vertical; }
</style>
