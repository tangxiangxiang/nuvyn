<script setup lang="ts">
import { computed, ref } from 'vue'
import { NIcon, NPopover } from 'naive-ui'
import { X } from '@vicons/tabler'
import type { LedgerAccountIcon as AccountIcon } from '../../../shared/ledgerProtocol'
import { useLedgerAccountIconPreferences } from '../../composables/useLedgerAccountIconPreferences'
import LedgerAccountIcon from './LedgerAccountIcon.vue'

const props = defineProps<{ modelValue: AccountIcon; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [icon: AccountIcon] }>()
const preferences = useLedgerAccountIconPreferences()
const show = ref(false)
const builtinLabels: Readonly<Record<string, string>> = {
  wallet: '钱包',
  credit_card: '信用卡',
  cash: '现金',
  building_bank: '银行',
  briefcase: '其他',
}
const options = computed(() => preferences.availableIcons.value.map((value) => ({
  value,
  label: preferences.customIconNames.value[value] || builtinLabels[value] || '自定义图标',
})))

function select(icon: AccountIcon): void {
  emit('update:modelValue', icon)
  show.value = false
}
</script>

<template>
  <NPopover v-model:show="show" trigger="manual" placement="bottom-end" :show-arrow="false" raw>
    <template #trigger>
      <span class="ledger-icon-picker-trigger" :class="{ 'is-disabled': disabled }" role="button" :tabindex="disabled ? -1 : 0" :aria-disabled="disabled ? 'true' : undefined" aria-label="选择账户图标" @click.stop="!disabled && (show = true)" @keydown.enter.prevent="!disabled && (show = true)" @keydown.space.prevent="!disabled && (show = true)">
        <LedgerAccountIcon :icon="modelValue" :size="20" />
      </span>
    </template>
    <section class="ledger-icon-picker" role="group" aria-label="选择账户图标">
      <header class="ledger-icon-picker-header">
        <strong>选择账户图标</strong>
        <button class="ledger-icon-picker-close" type="button" aria-label="关闭" title="关闭" @click="show = false">
          <NIcon :size="18" aria-hidden="true"><X /></NIcon>
        </button>
      </header>
      <div class="ledger-icon-picker-grid" role="radiogroup" aria-label="账户图标">
        <button v-for="option in options" :key="option.value" type="button" class="ledger-icon-picker-option" :class="{ 'is-selected': modelValue === option.value }" role="radio" :aria-checked="modelValue === option.value" @click="select(option.value)">
          <LedgerAccountIcon :icon="option.value" :size="27" />
          <span>{{ option.label }}</span>
        </button>
      </div>
    </section>
  </NPopover>
</template>

<style scoped>
.ledger-icon-picker-trigger { display: inline-grid; width: 30px; height: 30px; place-items: center; border-radius: 6px; color: var(--text-muted); cursor: pointer; }
.ledger-icon-picker-trigger:hover { background: var(--bg-soft); color: var(--text-h); }
.ledger-icon-picker-trigger:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.ledger-icon-picker-trigger.is-disabled { cursor: not-allowed; opacity: .5; }
.ledger-icon-picker { width: min(320px, calc(100vw - 24px)); box-sizing: border-box; padding: 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface, var(--bg)); color: var(--text-h); box-shadow: 0 8px 28px rgb(24 34 56 / 14%); }
.ledger-icon-picker-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
.ledger-icon-picker-header strong { font-size: .85rem; font-weight: 650; }
.ledger-icon-picker-close { display: inline-flex; width: 28px; height: 28px; align-items: center; justify-content: center; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--text-muted); cursor: pointer; }
.ledger-icon-picker-close:hover { background: var(--bg-soft); color: var(--text-h); }
.ledger-icon-picker-close:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.ledger-icon-picker-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; max-height: 330px; overflow-y: auto; }
.ledger-icon-picker-option { display: flex; min-width: 0; min-height: 62px; flex-direction: column; align-items: center; justify-content: center; gap: 5px; padding: 6px 3px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--text-muted); cursor: pointer; font: inherit; text-align: center; }
.ledger-icon-picker-option:hover { background: var(--bg-soft); color: var(--text-h); }
.ledger-icon-picker-option.is-selected { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); color: var(--accent); }
.ledger-icon-picker-option span { max-width: 100%; overflow: hidden; font-size: .68rem; line-height: 1.1; text-overflow: ellipsis; white-space: nowrap; }
.ledger-icon-picker-option:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
