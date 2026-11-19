<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { NButton, NDatePicker, NIcon, NInput, NModal, type DatePickerProps } from 'naive-ui'
import { Calendar, X } from '@vicons/tabler'

const props = withDefaults(defineProps<{
  modelValue: string | null
  label: string
  clearable?: boolean
  status?: 'success' | 'error'
  isDateDisabled?: DatePickerProps['isDateDisabled']
}>(), {
  clearable: false,
  status: undefined,
  isDateDisabled: undefined,
})

const emit = defineEmits<{ 'update:modelValue': [value: string | null] }>()
const show = ref(false)
const inputValue = ref(props.modelValue ?? '')
const draftDate = ref('')
const touchScreen = useMediaQuery('(pointer: coarse)')

const pickerValue = computed(() => localTimestamp(draftDate.value))

watch(() => props.modelValue, value => {
  inputValue.value = value ?? ''
})

function localTimestamp(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
  return date.getTime()
}

function localDateFromTimestamp(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function openPicker(): void {
  draftDate.value = props.modelValue ?? ''
  show.value = true
}

function updateInputValue(value: string): void {
  inputValue.value = value
  if (localTimestamp(value) !== null) emit('update:modelValue', value)
}

function restoreInputValue(): void {
  if (localTimestamp(inputValue.value) === null) inputValue.value = props.modelValue ?? ''
}

function updateDraft(value: string | null, timestamp: number | null): void {
  draftDate.value = typeof timestamp === 'number' && Number.isFinite(timestamp)
    ? localDateFromTimestamp(timestamp)
    : value ?? ''
}

function confirmDate(): void {
  if (!draftDate.value) return
  emit('update:modelValue', draftDate.value)
  show.value = false
}

function clearDate(): void {
  emit('update:modelValue', null)
}
</script>

<template>
  <div class="diary-date-picker-control">
    <NInput
      class="diary-date-picker-input"
      :value="inputValue"
      :placeholder="`请选择${props.label}`"
      :status="props.status"
      :readonly="touchScreen"
      aria-haspopup="dialog"
      :aria-label="props.label"
      @click="touchScreen && openPicker()"
      @keydown.enter.prevent="openPicker"
      @blur="restoreInputValue"
      @update:value="updateInputValue"
    >
      <template #suffix>
        <span class="diary-date-picker-suffix">
          <button
            v-if="props.clearable && props.modelValue"
            type="button"
            class="diary-date-picker-clear"
            :aria-label="`清除${props.label}`"
            @click.stop="clearDate"
          >
            <NIcon :size="15" aria-hidden="true"><X /></NIcon>
          </button>
          <button
            type="button"
            class="diary-date-picker-calendar"
            :aria-label="`选择${props.label}`"
            @click.stop="openPicker"
          >
            <NIcon :size="16" aria-hidden="true"><Calendar /></NIcon>
          </button>
        </span>
      </template>
    </NInput>

    <NModal v-model:show="show">
      <section class="diary-date-picker-dialog" role="dialog" aria-modal="true" :aria-label="`选择${props.label}`">
        <NDatePicker
          class="diary-date-picker-panel"
          panel
          type="date"
          format="yyyy-MM-dd"
          value-format="yyyy-MM-dd"
          :actions="[]"
          :value="pickerValue"
          :is-date-disabled="props.isDateDisabled"
          :clearable="false"
          @update:formatted-value="updateDraft"
        />
        <div class="diary-date-picker-actions">
          <NButton attr-type="button" @click="show = false">取消</NButton>
          <NButton attr-type="button" type="primary" :disabled="!draftDate" @click="confirmDate">确认</NButton>
        </div>
      </section>
    </NModal>
  </div>
</template>

<style scoped>
.diary-date-picker-control { width: 100%; min-width: 0; }
.diary-date-picker-suffix { display: inline-flex; align-items: center; gap: 8px; }
.diary-date-picker-clear {
  display: inline-grid;
  width: 24px;
  height: 24px;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted, #6b7280);
  cursor: pointer;
}
.diary-date-picker-clear:hover { background: color-mix(in srgb, var(--text) 7%, transparent); }
.diary-date-picker-calendar {
  display: inline-grid;
  width: 24px;
  height: 24px;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted, #6b7280);
  cursor: pointer;
}
.diary-date-picker-calendar:hover { background: color-mix(in srgb, var(--text) 7%, transparent); }
.diary-date-picker-dialog {
  width: min(400px, calc(100% - 24px));
  max-height: calc(100dvh - 24px);
  overflow: auto;
  border: 1px solid var(--border, #8884);
  border-radius: 16px;
  background: var(--bg, #fff);
  box-shadow: 0 18px 48px rgb(24 31 52 / 18%);
}
.diary-date-picker-dialog :deep(.diary-date-picker-panel) {
  width: 100%;
  box-sizing: border-box;
  grid-template-columns: minmax(0, 1fr);
}
.diary-date-picker-dialog :deep(.n-date-panel--month) {
  position: relative;
  z-index: 2;
  width: max-content;
  max-width: calc(100vw - 32px);
  box-sizing: border-box;
  border: 1px solid var(--nuvyn-border, var(--border, #8884));
  background-color: var(--nuvyn-bg, var(--bg, #fff));
  box-shadow: 0 12px 28px rgb(24 31 52 / 18%);
}
.diary-date-picker-dialog :deep(.n-date-panel-weekdays),
.diary-date-picker-dialog :deep(.n-date-panel-dates) {
  grid-template-columns: repeat(7, minmax(0, 1fr));
  margin-inline: 0;
}
.diary-date-picker-dialog :deep(.n-date-panel-month__text) { white-space: nowrap; }
.diary-date-picker-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  padding: 12px 14px 14px;
  border-top: 1px solid var(--border, #8883);
}
.diary-date-picker-actions :deep(.n-button) { min-width: 0; }
@media (max-width: 600px) {
  .diary-date-picker-dialog {
    align-self: flex-end;
    width: 100%;
    margin: auto 0 0;
    border-radius: 16px 16px 0 0;
  }
  .diary-date-picker-actions { padding-bottom: max(14px, env(safe-area-inset-bottom)); }
  .diary-date-picker-actions :deep(.n-button) { min-height: 44px; }
}
</style>
