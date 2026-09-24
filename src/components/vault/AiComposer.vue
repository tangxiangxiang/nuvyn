<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { NButton, NIcon, NInput, type InputInst } from 'naive-ui'
import { PlayerStop, Send } from '@vicons/tabler'
import { useI18n } from '../../composables/useI18n'

const props = withDefaults(defineProps<{
  modelValue: string
  busy: boolean
  configured: boolean
  canSend?: boolean
  modelName?: string
}>(), {
  canSend: true,
  modelName: '',
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  send: []
  stop: []
}>()
const { t } = useI18n()

const inputPlaceholder = computed(() => t('ai.input_placeholder'))
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
          <span class="ai-mode-badge" :title="modelName">
            <span class="ai-model-name">{{ modelName || '…' }}</span>
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
            :disabled="!busy && (!modelValue.trim() || !configured || !canSend)"
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
