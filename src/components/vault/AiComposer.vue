<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { NButton, NIcon, NInput, type InputInst } from 'naive-ui'
import { PlayerStop, Send } from '@vicons/tabler'
import { useI18n } from '../../composables/useI18n'

const props = withDefaults(defineProps<{
  modelValue: string
  busy: boolean
  configured: boolean
  contextPaths: string[]
  canAddContext: boolean
  contextPickerOpen: boolean
}>(), {
  contextPaths: () => [],
  canAddContext: true,
  contextPickerOpen: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  send: []
  stop: []
  'remove-context': [path: string]
  'toggle-context-picker': []
}>()
const { t } = useI18n()

const inputPlaceholder = computed(
  () => `${t('ai.input_placeholder')} · ${t('ai.keyboard_hint')}`,
)
const inputEl = ref<InputInst | null>(null)

function onInput(value: string) {
  emit('update:modelValue', value)
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey) return
  event.preventDefault()
  emit('send')
}

function onPrimaryAction() {
  if (props.busy) emit('stop')
  else emit('send')
}

async function focus() {
  await nextTick()
  inputEl.value?.focus()
}

defineExpose({ focus })
</script>

<template>
  <form class="ai-composer" @submit.prevent="emit('send')">
    <div class="ai-composer-card">
      <div v-if="contextPaths.length" class="ai-context-paths" :aria-label="t('ai.attached_context')">
        <span v-for="path in contextPaths" :key="path" class="ai-context-chip" :title="path">
          <span class="ai-context-chip-path">{{ path }}</span>
          <NButton
            class="ai-context-chip-remove"
            attr-type="button"
            text
            :bordered="false"
            :aria-label="t('ai.remove_context')"
            @click="emit('remove-context', path)"
          >×</NButton>
        </span>
      </div>
      <NInput
        ref="inputEl"
        class="ai-input-control"
        type="textarea"
        :autosize="{ minRows: 1, maxRows: 8 }"
        :value="modelValue"
        :placeholder="inputPlaceholder"
        :bordered="false"
        :input-props="{ class: 'ai-input', 'aria-label': t('ai.input_placeholder') }"
        @keydown="onKeydown"
        @update:value="onInput"
      />
      <div class="ai-toolbar">
        <div class="ai-toolbar-left">
          <NButton
            class="ai-tool-button"
            attr-type="button"
            text
            :bordered="false"
            :title="t('ai.add_context')"
            :aria-label="t('ai.add_context')"
            :disabled="!canAddContext"
            :aria-expanded="contextPickerOpen"
            aria-haspopup="listbox"
            @click="emit('toggle-context-picker')"
          >
            <span class="ai-tool-plus">+</span>
          </NButton>
          <!-- Reserved for a future AI mode selector; currently display-only. -->
          <span class="ai-mode-badge" aria-hidden="true">
            <span class="ai-mode-dot" />
            Auto
          </span>
        </div>
        <div class="ai-toolbar-right">
          <NButton
            class="ai-send"
            :class="{ 'ai-send-busy': busy }"
            attr-type="button"
            text
            :bordered="false"
            :title="t(busy ? 'ai.stop' : 'ai.send_hint')"
            :aria-label="t(busy ? 'ai.stop' : 'ai.send')"
            :disabled="!busy && (!modelValue.trim() || !configured)"
            @click="onPrimaryAction"
          >
            <NIcon class="ai-send-icon" aria-hidden="true">
              <PlayerStop v-if="busy" />
              <Send v-else />
            </NIcon>
          </NButton>
        </div>
      </div>
    </div>
  </form>
</template>
