<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NDatePicker, NIcon, NInput, NPopover, type InputInst } from 'naive-ui'
import { Calendar } from '@vicons/tabler'

const props = withDefaults(defineProps<{
  modelValue: string
  label: string
  testId?: string
  disabled?: boolean
}>(), {
  testId: undefined,
  disabled: false,
})

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const input = ref<InputInst | null>(null)
const show = ref(false)
const inputValue = ref(props.modelValue.replace('T', ' '))

type LocalDateTimeParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

function parseLocalDateTime(value: string): LocalDateTimeParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!match) return null
  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  }
  if (parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31 || parts.hour > 23 || parts.minute > 59) return null
  return parts
}

function browserTimestamp(value: string): number | null {
  const parts = parseLocalDateTime(value)
  if (!parts) return null
  const candidate = new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
  if (candidate.getFullYear() !== parts.year || candidate.getMonth() !== parts.month - 1 || candidate.getDate() !== parts.day) return null
  // A browser timezone may normalize a Ledger wall-clock value across a DST
  // gap. The raw value remains in the trigger; this timestamp only supplies
  // a stable calendar position to Naive's panel.
  return candidate.getTime()
}

function isValidCalendarDate(parts: LocalDateTimeParts): boolean {
  const candidate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day))
  return candidate.getUTCFullYear() === parts.year
    && candidate.getUTCMonth() === parts.month - 1
    && candidate.getUTCDate() === parts.day
}

function localDateTimeFromBrowserTimestamp(timestamp: number): string {
  const value = new Date(timestamp)
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`
}

const pickerValue = computed(() => browserTimestamp(props.modelValue))

watch(() => props.modelValue, (value) => {
  inputValue.value = value.replace('T', ' ')
})

function openPicker(): void {
  if (!props.disabled) show.value = true
}

function handleTriggerKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  openPicker()
}

function updateInputValue(value: string): void {
  inputValue.value = value
  const canonical = value.replace(' ', 'T')
  const parts = parseLocalDateTime(canonical)
  if (parts && isValidCalendarDate(parts)) emit('update:modelValue', canonical)
}

function restoreInputValue(): void {
  const canonical = inputValue.value.replace(' ', 'T')
  const parts = parseLocalDateTime(canonical)
  if (!parts || !isValidCalendarDate(parts)) inputValue.value = props.modelValue.replace('T', ' ')
}

function updateValue(value: string | null, timestamp: number | null): void {
  let nextValue = value ?? ''
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
    nextValue = localDateTimeFromBrowserTimestamp(timestamp)
  }
  inputValue.value = nextValue.replace('T', ' ')
  emit('update:modelValue', nextValue)
  show.value = false
}

defineExpose({
  focus: () => input.value?.focus(),
  focusTime: () => input.value?.focus(),
  blur: () => input.value?.blur(),
})
</script>

<template>
  <NPopover v-model:show="show" trigger="manual" placement="bottom-start" :show-arrow="false">
    <template #trigger>
      <NInput
        ref="input"
        class="ledger-date-time-picker"
        :data-testid="props.testId"
        :value="inputValue"
        placeholder="请选择日期时间"
        :disabled="props.disabled"
        :aria-label="props.label"
        aria-haspopup="dialog"
        @click="openPicker"
        @keydown="handleTriggerKeydown"
        @blur="restoreInputValue"
        @update:value="updateInputValue"
      >
        <template #suffix><NIcon :size="16" aria-hidden="true"><Calendar /></NIcon></template>
      </NInput>
    </template>
    <NDatePicker
      panel
      type="datetime"
      format="yyyy-MM-dd HH:mm"
      value-format="yyyy-MM-dd'T'HH:mm"
      :value="pickerValue"
      :clearable="false"
      :disabled="props.disabled"
      :aria-label="props.label"
      @update:formatted-value="updateValue"
    />
  </NPopover>
</template>

<style>
.v-binder-follower-container:has(.n-date-panel) {
  z-index: 10000 !important;
}
</style>
