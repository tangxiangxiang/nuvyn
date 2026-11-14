<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { NButton, NDatePicker, NIcon, NInput, NModal, type InputInst } from 'naive-ui'
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
const draftValue = ref('')
const touchScreen = useMediaQuery('(pointer: coarse)')

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

const pickerValue = computed(() => browserTimestamp(draftValue.value))

watch(() => props.modelValue, (value) => {
  inputValue.value = value.replace('T', ' ')
})

function openPicker(): void {
  if (props.disabled || show.value) return
  draftValue.value = props.modelValue
  show.value = true
}

function handleTriggerKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' && !(touchScreen.value && event.key === ' ')) return
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
  draftValue.value = typeof timestamp === 'number' && Number.isFinite(timestamp)
    ? localDateTimeFromBrowserTimestamp(timestamp)
    : value ?? ''
}

function confirmValue(): void {
  if (!draftValue.value || props.disabled) return
  inputValue.value = draftValue.value.replace('T', ' ')
  emit('update:modelValue', draftValue.value)
  show.value = false
}

defineExpose({
  focus: () => input.value?.focus(),
  focusTime: () => input.value?.focus(),
  blur: () => input.value?.blur(),
})
</script>

<template>
  <NInput
    ref="input"
    class="ledger-date-time-picker"
    :data-testid="props.testId"
    :value="inputValue"
    placeholder="请选择日期时间"
    :disabled="props.disabled"
    :readonly="touchScreen"
    :aria-label="props.label"
    aria-haspopup="dialog"
    @click="openPicker"
    @keydown="handleTriggerKeydown"
    @blur="restoreInputValue"
    @update:value="updateInputValue"
  >
    <template #suffix><NIcon :size="16" aria-hidden="true"><Calendar /></NIcon></template>
  </NInput>
  <NModal v-model:show="show">
    <section
      class="ledger-date-time-dialog"
      role="dialog"
      aria-modal="true"
      :aria-label="props.label"
    >
      <NDatePicker
        panel
        type="datetime"
        format="yyyy-MM-dd HH:mm"
        value-format="yyyy-MM-dd'T'HH:mm"
        :time-picker-props="{ format: 'HH:mm' }"
        :actions="[]"
        :value="pickerValue"
        :clearable="false"
        :disabled="props.disabled"
        @update:formatted-value="updateValue"
      />
      <div class="ledger-date-time-actions">
        <NButton attr-type="button" @click="show = false">取消</NButton>
        <NButton attr-type="button" type="primary" :disabled="!draftValue || props.disabled" @click="confirmValue">确认</NButton>
      </div>
    </section>
  </NModal>
</template>

<style scoped>
.ledger-date-time-dialog {
  width: min(400px, calc(100% - 24px));
  max-height: calc(100dvh - 24px);
  overflow: auto;
  border-radius: 16px;
  background: var(--bg);
}

.ledger-date-time-dialog :deep(.n-date-panel) {
  width: 100%;
  box-sizing: border-box;
  /* The panel defaults to an intrinsic 0fr track even at full width. */
  grid-template-columns: minmax(0, 1fr);
}

.ledger-date-time-dialog :deep(.n-date-panel-weekdays),
.ledger-date-time-dialog :deep(.n-date-panel-dates) {
  grid-template-columns: repeat(7, minmax(0, 1fr));
  margin-inline: 0;
}

.ledger-date-time-dialog :deep(.n-date-panel-month__text) {
  white-space: nowrap;
}

.ledger-date-time-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  padding: 10px 14px 14px;
}

@media (max-width: 600px) {
  .ledger-date-time-dialog {
    align-self: flex-end;
    width: 100%;
    margin: auto 0 0;
    border-radius: 16px 16px 0 0;
  }

  .ledger-date-time-actions {
    padding-bottom: max(14px, env(safe-area-inset-bottom));
  }

  .ledger-date-time-actions :deep(.n-button) {
    min-height: 44px;
  }
}
</style>
