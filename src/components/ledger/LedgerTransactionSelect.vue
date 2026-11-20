<script setup lang="ts">
import { computed, defineComponent, ref, watch, type PropType, type VNodeChild } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { NIcon, NModal, NSelect, type SelectGroupOption, type SelectOption } from 'naive-ui'
import { Check, X } from '@vicons/tabler'

type OptionRenderer = (option: SelectOption | SelectGroupOption, selected?: boolean) => VNodeChild
type OptionGroup = { key: string; label: string; options: SelectOption[] }

const props = withDefaults(defineProps<{
  label: string
  id: string
  name: string
  placeholder: string
  options: Array<SelectOption | SelectGroupOption>
  renderLabel?: OptionRenderer
  required?: boolean
  disabled?: boolean
}>(), {
  renderLabel: undefined,
  required: false,
  disabled: false,
})

const selectedValue = defineModel<string>({ required: true })
const phoneLayout = useMediaQuery('(max-width: 600px)')
const selectionDialogOpen = ref(false)

const OptionLabel = defineComponent({
  props: {
    option: { type: Object as PropType<SelectOption>, required: true },
    renderLabel: { type: Function as PropType<OptionRenderer>, default: undefined },
    selected: Boolean,
  },
  setup(optionProps) {
    return () => {
      if (optionProps.renderLabel) return optionProps.renderLabel(optionProps.option, optionProps.selected)
      if (typeof optionProps.option.label === 'function') return optionProps.option.label(optionProps.option, optionProps.selected)
      return String(optionProps.option.label ?? '')
    }
  },
})

const optionGroups = computed<OptionGroup[]>(() => {
  const groups: OptionGroup[] = []
  const ungrouped: SelectOption[] = []
  props.options.forEach((option, index) => {
    if (option.type === 'group') {
      const options = (option.children ?? []).filter((child): child is SelectOption => child.value !== undefined)
      if (!options.length) return
      const label = typeof option.label === 'string' ? option.label : ''
      groups.push({ key: String(option.key ?? `group-${index}`), label, options })
      return
    }
    if (option.value !== undefined) ungrouped.push(option)
  })
  if (ungrouped.length) groups.push({ key: 'ungrouped-options', label: '', options: ungrouped })
  return groups
})

watch(() => props.disabled, (disabled) => {
  if (disabled) selectionDialogOpen.value = false
})

function handleDropdownVisibility(show: boolean): void {
  if (show && !props.disabled) selectionDialogOpen.value = true
}

function selectOption(option: SelectOption): void {
  if (option.disabled || props.disabled || option.value === undefined) return
  selectedValue.value = String(option.value)
  selectionDialogOpen.value = false
}
</script>

<template>
  <NSelect
    v-model:value="selectedValue"
    class="ledger-form-control"
    size="medium"
    :options="props.options"
    :render-label="props.renderLabel"
    :node-props="ledgerSelectNodeProps"
    :input-props="{ id: props.id, name: props.name, required: props.required }"
    :aria-label="props.label"
    aria-haspopup="dialog"
    role="combobox"
    :show-arrow="false"
    :placeholder="props.placeholder"
    :disabled="props.disabled"
    :show="false"
    @update:show="handleDropdownVisibility"
  />

  <NModal v-model:show="selectionDialogOpen">
    <section
      class="ledger-option-picker-dialog"
      role="dialog"
      aria-modal="true"
      :aria-label="`选择${props.label}`"
    >
      <header class="ledger-option-picker-header">
        <h2>{{ props.label }}</h2>
        <button type="button" :aria-label="`关闭${props.label}选择`" @click="selectionDialogOpen = false">
          <NIcon :size="18" aria-hidden="true"><X /></NIcon>
        </button>
      </header>
      <div class="ledger-option-picker-list" role="listbox" :aria-label="props.label">
        <section v-for="group in optionGroups" :key="group.key" class="ledger-option-picker-group" role="group" :aria-label="group.label || undefined">
          <h3 v-if="group.label" class="ledger-select-group-label">{{ group.label }}</h3>
          <button
            v-for="option in group.options"
            :key="String(option.value)"
            type="button"
            class="ledger-option-picker-option"
            :class="{ 'ledger-option-picker-option--selected': String(option.value) === selectedValue }"
            :data-ledger-option="String(option.value)"
            role="option"
            :aria-selected="String(option.value) === selectedValue"
            :disabled="Boolean(option.disabled) || props.disabled"
            @click="selectOption(option)"
          >
            <span class="ledger-option-picker-option-label">
              <OptionLabel :option="option" :render-label="props.renderLabel" :selected="String(option.value) === selectedValue" />
            </span>
            <NIcon v-if="String(option.value) === selectedValue" class="ledger-option-picker-check" :size="18" aria-hidden="true"><Check /></NIcon>
          </button>
        </section>
        <p v-if="!optionGroups.length" class="ledger-option-picker-empty">暂无可选项</p>
      </div>
    </section>
  </NModal>
</template>

<style scoped>
.ledger-option-picker-dialog {
  display: flex;
  width: min(560px, calc(100vw - 48px));
  max-height: min(70dvh, 620px);
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border, #8884);
  border-radius: 18px;
  background: var(--bg, #fff);
  box-shadow: 0 18px 48px rgb(24 31 52 / 18%);
}

.ledger-option-picker-header {
  display: flex;
  min-height: 64px;
  box-sizing: border-box;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 16px 8px 20px;
  border-bottom: 1px solid color-mix(in srgb, var(--border, #8884) 70%, transparent);
}

.ledger-option-picker-header h2 { margin: 0; color: var(--text-h); font-size: 1.08rem; font-weight: 700; }
.ledger-option-picker-header button {
  display: inline-grid;
  width: 36px;
  height: 36px;
  flex: 0 0 36px;
  place-items: center;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--text-muted, #6b7280);
  cursor: pointer;
}
.ledger-option-picker-header button:hover { background: color-mix(in srgb, var(--text) 7%, transparent); }
.ledger-option-picker-header button:focus-visible,
.ledger-option-picker-option:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

.ledger-option-picker-list {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 10px 12px max(14px, env(safe-area-inset-bottom));
}

.ledger-option-picker-group + .ledger-option-picker-group { margin-top: 10px; }
.ledger-option-picker-group > .ledger-select-group-label { margin: 0 8px 4px; }
.ledger-option-picker-option {
  display: flex;
  width: 100%;
  min-height: 48px;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  font: inherit;
  text-align: left;
}
.ledger-option-picker-option:hover:not(:disabled) { background: color-mix(in srgb, var(--text) 5%, transparent); }
.ledger-option-picker-option--selected { border-color: color-mix(in srgb, var(--accent) 22%, transparent); background: color-mix(in srgb, var(--accent) 9%, transparent); }
.ledger-option-picker-option:disabled { cursor: not-allowed; opacity: .5; }
.ledger-option-picker-option-label { display: flex; min-width: 0; flex: 1 1 auto; align-items: center; }
.ledger-option-picker-check { flex: 0 0 auto; color: var(--accent); }
.ledger-option-picker-empty { margin: 0; padding: 24px 12px; color: var(--text-muted); text-align: center; }

@media (max-width: 600px) {
  .ledger-option-picker-dialog {
    align-self: flex-end;
    width: 100%;
    max-height: min(76dvh, 720px);
    margin: auto 0 0;
    border-radius: 18px 18px 0 0;
  }
  .ledger-option-picker-list { padding-bottom: max(18px, env(safe-area-inset-bottom)); }
}
</style>
