<script setup lang="ts">
import { h, ref, useId, watch } from 'vue'
import { NDropdown, type DropdownOption } from 'naive-ui'
import { Dots } from '@vicons/tabler'

const props = defineProps<{
  label: string
  options: DropdownOption[]
  disabled?: boolean
  contextual?: boolean
}>()
const emit = defineEmits<{ select: [key: string] }>()
const open = ref(false)
const menuId = useId()

watch(() => props.disabled, disabled => {
  if (disabled) open.value = false
})

function select(key: string | number) {
  if (!open.value || props.disabled) return
  open.value = false
  emit('select', String(key))
}

function renderLabel(option: DropdownOption) {
  const label = typeof option.label === 'string' ? option.label : ''
  return h('span', { class: 'diary-action-label', title: label }, label)
}

function onKeydown(event: KeyboardEvent) {
  if (!open.value || event.isComposing) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    open.value = false
  } else if (event.key === 'Tab') {
    open.value = false
  }
}
</script>

<template>
  <span class="diary-action-menu" :class="{ 'is-contextual': contextual, 'is-open': open }">
    <NDropdown
      v-model:show="open"
      :to="true"
      trigger="click"
      placement="bottom-end"
      :options="options"
      :render-label="renderLabel"
      :disabled="disabled"
      :animated="false"
      :z-index="3000"
      scrollable
      :style="{ maxHeight: 'min(260px, 45dvh)', maxWidth: 'calc(100vw - 24px)' }"
      :menu-props="() => ({ id: menuId, role: 'menu', 'aria-label': label })"
      :node-props="option => ({ role: 'menuitem', 'aria-disabled': option.disabled ? 'true' : undefined })"
      @select="select"
    >
      <button
        type="button"
        class="diary-action-trigger"
        :disabled="disabled"
        :aria-label="label"
        aria-haspopup="menu"
        :aria-expanded="open"
        :aria-controls="open ? menuId : undefined"
        @click="($event.currentTarget as HTMLButtonElement).focus({ preventScroll: true })"
        @keydown="onKeydown"
      >
        <Dots aria-hidden="true" />
      </button>
    </NDropdown>
  </span>
</template>

<style scoped>
.diary-action-menu { display: inline-flex; }
.diary-action-trigger {
  display: grid;
  width: 40px;
  height: 40px;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.diary-action-trigger:hover:not(:disabled) { background: color-mix(in srgb, currentColor 8%, transparent); }
.diary-action-trigger:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.diary-action-trigger:disabled { opacity: .45; cursor: not-allowed; }
.diary-action-trigger > svg { width: 16px; height: 16px; }
:global(.diary-action-label) {
  display: block;
  max-width: min(240px, calc(100vw - 64px));
  overflow: hidden;
  text-overflow: ellipsis;
}
@media (hover: hover) and (pointer: fine) and (not (any-pointer: coarse)) {
  .diary-action-menu.is-contextual { opacity: 0; }
  :is(.diary-bullet-entry, .diary-attachment-item):is(:hover, :focus-within) .diary-action-menu.is-contextual,
  .diary-action-menu.is-contextual.is-open { opacity: 1; }
}
@media (prefers-reduced-motion: no-preference) {
  .diary-action-menu { transition: opacity 140ms ease; }
}
</style>
