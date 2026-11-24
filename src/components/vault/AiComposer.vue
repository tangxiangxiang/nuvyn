<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import { NButton, NIcon, NInput, type InputInst } from 'naive-ui'
import { ArrowUp, PlayerStop, Send } from '@vicons/tabler'
import type { LedgerAiCommand } from '../../lib/ai-api'
import { useI18n } from '../../composables/useI18n'

const props = withDefaults(defineProps<{
  modelValue: string
  busy: boolean
  configured: boolean
  canSend?: boolean
  modelName?: string
  prompts?: Array<{ label: string; text: string }>
  commands?: Array<{ label: string; command: LedgerAiCommand; description?: string }>
  placeholder?: string
}>(), {
  canSend: true,
  modelName: '',
  prompts: () => [],
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  send: []
  stop: []
  command: [command: LedgerAiCommand]
}>()
const { t } = useI18n()

const inputPlaceholder = computed(() => props.placeholder ?? t('ai.input_placeholder'))
const inputEl = ref<InputInst | null>(null)
const menuId = useId()
const focused = ref(false)
const dismissed = ref(false)
const selectedPrompt = ref(0)
const composing = ref(false)
const slashText = computed(() => props.commands ? props.modelValue.trim() : props.modelValue)
const slashQuery = computed(() => /^\/([^\s/]*)$/.exec(slashText.value)?.[1] ?? null)
const matchingOptions = computed<Array<{ label: string; text: string; command?: LedgerAiCommand; description?: string }>>(() => {
  const query = (slashQuery.value ?? '').toLocaleLowerCase()
  const commands = (props.commands ?? []).filter(({ command }) => command.startsWith(query))
    .map(({ label, command, description }) => ({ label: `/${command} · ${label}`, text: `/${command}`, command, description }))
  const prompts = props.commands ? [] : props.prompts.filter(prompt => prompt.label.toLocaleLowerCase().includes(query))
  return [...commands, ...prompts]
})
const showPrompts = computed(() => focused.value && !composing.value && !dismissed.value && slashQuery.value !== null
  && (props.prompts.length > 0 || !!props.commands?.length))
const commandInput = computed(() => !!props.commands && slashText.value.startsWith('/'))
watch(() => props.modelValue, () => {
  selectedPrompt.value = 0
  dismissed.value = false
})
watch(() => props.prompts, () => { selectedPrompt.value = 0 })
const sendEnabled = computed(() => !props.busy && !composing.value
  && !!props.modelValue.trim() && (props.configured || commandInput.value) && props.canSend)

function chooseOption(index: number, executeCommand = false) {
  const option = matchingOptions.value[index]
  if (!option || composing.value) return
  if (option.command && executeCommand) {
    if (!props.busy && props.canSend) emit('command', option.command)
  } else {
    emit('update:modelValue', option.text)
  }
  dismissed.value = true
  if (!option.command || !executeCommand) void focus()
}

function send() {
  if (sendEnabled.value) emit('send')
}

function onInput(value: string) {
  emit('update:modelValue', value)
}

function onKeydown(event: KeyboardEvent) {
  if (composing.value || event.isComposing || event.keyCode === 229) return
  if (showPrompts.value) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      dismissed.value = true
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const count = matchingOptions.value.length
      if (count) selectedPrompt.value = (selectedPrompt.value + (event.key === 'ArrowDown' ? 1 : count - 1)) % count
      return
    }
    if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
      if (event.key === 'Enter' || matchingOptions.value.length) event.preventDefault()
      const option = matchingOptions.value[selectedPrompt.value]
      if (event.key === 'Enter' && commandInput.value && (!option || option.command)) {
        if (option?.command && slashText.value !== option.text) chooseOption(selectedPrompt.value, true)
        else send()
      } else {
        chooseOption(selectedPrompt.value)
      }
      return
    }
  }
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  send()
}

function onPrimaryAction() {
  if (props.busy) emit('stop')
  else send()
}

async function focus() {
  await nextTick()
  inputEl.value?.focus()
}

defineExpose({ focus })
</script>

<template>
  <form class="ai-composer" @submit.prevent="send">
    <div v-if="showPrompts" :id="menuId" class="ai-prompt-menu" role="listbox" :aria-label="t(commands ? 'ai.finance_commands' : 'ai.prompt_templates')">
      <div v-if="!commands" class="ai-prompt-menu-heading">{{ t('ai.prompt_templates') }}</div>
      <button
        v-for="(prompt, index) in matchingOptions"
        :id="`${menuId}-${index}`"
        :key="prompt.label"
        type="button"
        role="option"
        :aria-selected="selectedPrompt === index"
        :class="{ 'is-selected': selectedPrompt === index }"
        :title="prompt.text"
        :aria-label="prompt.label"
        tabindex="-1"
        :disabled="prompt.command && (busy || !canSend)"
        @pointerdown.prevent
        @click="chooseOption(index, true)"
      >
        <template v-if="prompt.command">
          <span class="ai-command-name">{{ prompt.text }}</span>
          <small class="ai-command-description">{{ prompt.description ?? prompt.label }}</small>
        </template>
        <template v-else>{{ prompt.label }}</template>
      </button>
      <div v-if="!matchingOptions.length" class="ai-prompt-menu-heading">{{ t('ai.no_matching_prompts') }}</div>
    </div>
    <div class="ai-composer-card">
      <NInput
        ref="inputEl"
        class="ai-input-control"
        type="textarea"
        :autosize="{ minRows: commands ? 1 : 2, maxRows: 5 }"
        :value="modelValue"
        :placeholder="inputPlaceholder"
        :bordered="false"
        :theme-overrides="{ color: 'transparent', colorFocus: 'transparent', borderRadius: '0', boxShadowFocus: 'none' }"
        :input-props="{
          class: 'ai-input',
          'aria-label': inputPlaceholder,
          'aria-controls': showPrompts ? menuId : undefined,
          'aria-activedescendant': showPrompts && matchingOptions.length ? `${menuId}-${selectedPrompt}` : undefined,
        }"
        @focus="focused = true"
        @pointerdown="dismissed = false"
        @blur="focused = false"
        @keydown="onKeydown"
        @compositionstart="composing = true"
        @compositionend="composing = false"
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
            :disabled="!busy && !sendEnabled"
            @click="onPrimaryAction"
          >
            <NIcon class="ai-send-icon" aria-hidden="true">
              <PlayerStop v-if="busy" />
              <ArrowUp v-else-if="commands" />
              <Send v-else />
            </NIcon>
          </NButton>
        </div>
      </div>
    </div>
  </form>
</template>
