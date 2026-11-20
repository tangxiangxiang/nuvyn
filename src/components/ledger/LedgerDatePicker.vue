<script setup lang="ts">
import { ref } from 'vue'
import { NDatePicker, NIcon, type DatePickerInst, type DatePickerProps } from 'naive-ui'
import { Calendar, X } from '@vicons/tabler'

type LedgerIsDateDisabled = NonNullable<DatePickerProps['isDateDisabled']>
type LedgerDatePickerType = 'date' | 'week' | 'month' | 'year'

const props = withDefaults(defineProps<{
  modelValue: string
  label: string
  type?: LedgerDatePickerType
  format?: string
  size?: DatePickerProps['size']
  testId?: string
  disabled?: boolean
  clearable?: boolean
  placeholder?: string
  isDateDisabled?: LedgerIsDateDisabled
}>(), {
  type: 'date',
  format: 'yyyy-MM-dd',
  size: 'medium',
  testId: undefined,
  disabled: false,
  clearable: false,
  placeholder: undefined,
  isDateDisabled: undefined,
})

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const picker = ref<DatePickerInst | null>(null)
const show = ref(false)

function updateValue(value: string | null): void {
  emit('update:modelValue', value ?? '')
}

function openPicker(): void {
  if (!props.disabled) show.value = true
}

function updatePickerShow(value: boolean): void {
  // NDatePicker requests opening when its input is focused or clicked. Keep
  // that field editable, but let only the explicit calendar button open it.
  if (!value) show.value = false
}

function clearValue(): void {
  emit('update:modelValue', '')
}

defineExpose({
  focus: () => picker.value?.focus(),
  blur: () => picker.value?.blur(),
})
</script>

<template>
  <div class="ledger-date-picker-control" :class="{ 'ledger-date-picker-control--clearable': props.clearable && props.modelValue }">
    <NDatePicker
      ref="picker"
      class="ledger-date-picker"
      :size="props.size"
      :type="props.type"
      :format="props.format"
      value-format="yyyy-MM-dd"
      :formatted-value="props.modelValue || null"
      :clearable="false"
      :disabled="props.disabled"
      :placeholder="props.placeholder"
      :is-date-disabled="props.isDateDisabled"
      :aria-label="props.label"
      :data-testid="props.testId"
      :show="show"
      @update:formatted-value="updateValue"
      @update:show="updatePickerShow"
    />
    <div class="ledger-date-picker-actions">
      <button
        v-if="props.clearable && props.modelValue"
        type="button"
        class="ledger-date-picker-action"
        :aria-label="`清除${props.label}`"
        :disabled="props.disabled"
        @click.stop="clearValue"
      >
        <NIcon :size="15" aria-hidden="true"><X /></NIcon>
      </button>
      <button
        type="button"
        class="ledger-date-picker-action"
        :aria-label="`选择${props.label}`"
        :disabled="props.disabled"
        aria-haspopup="dialog"
        @click.stop="openPicker"
      >
        <NIcon :size="16" aria-hidden="true"><Calendar /></NIcon>
      </button>
    </div>
  </div>
</template>

<style scoped>
.ledger-date-picker-control { position: relative; width: 100%; min-width: 0; }
.ledger-date-picker { width: 100%; }
.ledger-date-picker :deep(.n-date-picker-icon) { display: none; }
.ledger-date-picker :deep(.n-input__input-el) { padding-right: 38px; }
.ledger-date-picker-control--clearable .ledger-date-picker :deep(.n-input__input-el) { padding-right: 68px; }
.ledger-date-picker-actions {
  position: absolute;
  z-index: 1;
  top: 50%;
  right: 7px;
  display: flex;
  align-items: center;
  gap: 3px;
  transform: translateY(-50%);
}
.ledger-date-picker-action {
  display: inline-grid;
  width: 28px;
  height: 28px;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted, #6b7280);
  cursor: pointer;
}
.ledger-date-picker-action:hover:not(:disabled) { background: color-mix(in srgb, var(--text) 7%, transparent); }
.ledger-date-picker-action:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.ledger-date-picker-action:disabled { cursor: not-allowed; opacity: .5; }
</style>
