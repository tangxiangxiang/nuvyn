<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import { NButton, NIcon, NInput, type InputInst } from 'naive-ui'
import { PlayerStop, Send } from '@vicons/tabler'
import { useI18n } from '../../composables/useI18n'

const props = withDefaults(defineProps<{
  modelValue: string
  busy: boolean
  configured: boolean
  canSend?: boolean
  modelName?: string
  prompts?: Array<{ label: string; text: string }>
}>(), {
  canSend: true,
  modelName: '',
  prompts: () => [],
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  send: []
  stop: []
}>()
const { t } = useI18n()

const inputPlaceholder = computed(() => t('ai.input_placeholder'))
const inputEl = ref<InputInst | null>(null)
const menuId = useId()
const focused = ref(false)
const dismissed = ref(false)
const selectedPrompt = ref(0)
const slashQuery = computed(() => /^\/([^\s/]*)$/.exec(props.modelValue)?.[1] ?? null)
const matchingPrompts = computed(() => props.prompts.filter(prompt =>
  prompt.label.toLocaleLowerCase().includes((slashQuery.value ?? '').toLocaleLowerCase()),
))
const showPrompts = computed(() => focused.value && !dismissed.value && slashQuery.value !== null && props.prompts.length > 0)
watch(() => props.modelValue, () => {
  selectedPrompt.value = 0
  dismissed.value = false
})
watch(() => props.prompts, () => { selectedPrompt.value = 0 })
const sendEnabled = computed(() => !props.busy && !!props.modelValue.trim() && props.configured && props.canSend)

function choosePrompt(index: number) {
  const prompt = matchingPrompts.value[index]
  if (!prompt) return
  emit('update:modelValue', prompt.text)
  dismissed.value = true
  void focus()
}

function send() {
  if (sendEnabled.value) emit('send')
}

function onInput(value: string) {
  emit('update:modelValue', value)
}

function onKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return
  if (showPrompts.value) {
    if (event.key === 'Escape') {
      event.preventDefault()
      dismissed.value = true
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const count = matchingPrompts.value.length
      if (count) selectedPrompt.value = (selectedPrompt.value + (event.key === 'ArrowDown' ? 1 : count - 1)) % count
      return
    }
    if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
      if (event.key === 'Enter' || matchingPrompts.value.length) event.preventDefault()
      choosePrompt(selectedPrompt.value)
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
    <div v-if="showPrompts" :id="menuId" class="ai-prompt-menu" role="listbox" :aria-label="t('ai.prompt_templates')">
      <div class="ai-prompt-menu-heading">{{ t('ai.prompt_templates') }}</div>
      <button
        v-for="(prompt, index) in matchingPrompts"
        :id="`${menuId}-${index}`"
        :key="prompt.label"
        type="button"
        role="option"
        :aria-selected="selectedPrompt === index"
        :class="{ 'is-selected': selectedPrompt === index }"
        :title="prompt.text"
        @mousedown.prevent
        @click="choosePrompt(index)"
      >{{ prompt.label }}</button>
      <div v-if="!matchingPrompts.length" class="ai-prompt-menu-heading">{{ t('ai.no_matching_prompts') }}</div>
    </div>
    <div class="ai-composer-card">
      <NInput
        ref="inputEl"
        class="ai-input-control"
        type="textarea"
        :autosize="{ minRows: 1, maxRows: 5 }"
        :value="modelValue"
        :placeholder="inputPlaceholder"
        :bordered="false"
        :theme-overrides="{ color: 'transparent', colorFocus: 'transparent', borderRadius: '0', boxShadowFocus: 'none' }"
        :input-props="{
          class: 'ai-input',
          'aria-label': t('ai.input_placeholder'),
          'aria-controls': showPrompts ? menuId : undefined,
          'aria-activedescendant': showPrompts && matchingPrompts.length ? `${menuId}-${selectedPrompt}` : undefined,
        }"
        @focus="focused = true"
        @blur="focused = false"
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
            :disabled="!busy && !sendEnabled"
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
