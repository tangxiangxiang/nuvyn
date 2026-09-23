<script setup lang="ts">
import { NButton, NIcon } from 'naive-ui'
import type { Message } from '../../lib/ai-api'
import { Link, ListCheck, Search, Stars } from '@vicons/tabler'
import AiToolCallCard from './AiToolCallCard.vue'
import AiMarkdown from './AiMarkdown.vue'
import { useI18n } from '../../composables/useI18n'

const props = defineProps<{
  messages: Message[]
  currentPath: string | null
  quickPrompts: Array<{ label: string; text: string }>
}>()

const emit = defineEmits<{
  prompt: [text: string]
}>()
const { t } = useI18n()
</script>

<template>
  <div
    class="ai-messages"
    :class="{ 'is-empty': props.messages.length === 0, 'has-messages': props.messages.length > 0 }"
    role="log"
    aria-live="polite"
  >
    <div v-if="props.messages.length === 0" class="ai-empty-chat">
      <div class="ai-suggestion-heading">{{ t('ai.suggestions') }}</div>
      <div class="ai-quick-prompts" :aria-label="t('ai.quick_prompts')">
        <NButton
          v-for="(prompt, index) in props.quickPrompts"
          :key="prompt.label"
          attr-type="button"
          :bordered="false"
          class="ai-quick-prompt"
          @click="emit('prompt', prompt.text)"
        >
          <NIcon class="ai-quick-icon" aria-hidden="true">
            <Stars v-if="index === 0" />
            <Link v-else-if="index === 1 && props.currentPath" />
            <Search v-else-if="index === 1" />
            <ListCheck v-else />
          </NIcon>
          <span>{{ prompt.label }}</span>
        </NButton>
      </div>

      <div class="ai-empty-hint">
        {{ t(props.currentPath ? 'ai.empty_hint_note' : 'ai.empty_hint_vault') }}
      </div>
    </div>

    <div
      v-for="message in props.messages"
      v-else
      :key="message.id || `${message.sessionId}-${message.createdAt}`"
      class="ai-message"
      :class="[message.role, { 'ai-streaming': message.id === 0 }]"
    >
      <div
        v-if="message.role === 'assistant'"
        class="ai-avatar"
        aria-hidden="true"
      ><NIcon aria-hidden="true"><Stars /></NIcon></div>
      <div class="ai-bubble">
        <AiMarkdown
          v-if="message.role === 'assistant' && message.content && message.id !== 0"
          :content="message.content"
        />
        <div v-else-if="message.content" class="ai-text" :class="{ 'ai-streaming-text': message.role === 'assistant' && message.id === 0 }">
          {{ message.content }}
        </div>
        <span
          v-else-if="message.role === 'assistant' && message.id === 0"
          class="ai-typing"
          role="status"
          :aria-label="t('ai.generating')"
        ><span /><span /><span /></span>
        <AiToolCallCard
          v-for="call in message.blocks?.toolCalls ?? []"
          :key="call.id"
          :call="call"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.ai-text {
  white-space: pre-wrap;
  word-break: break-word;
}

/* Typing indicator — three small dots that pulse in sequence. Shown
   when an assistant message exists (id === 0 sentinel for the in-flight
   placeholder) but has no content yet, so the user gets immediate
   feedback after pressing send instead of staring at an empty bubble. */
.ai-typing {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 14px;
  padding: 0 2px;
}
.ai-typing > span {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--vs-text-2, var(--text-muted)) 70%, transparent);
  animation: ai-typing-bounce 1.2s infinite ease-in-out;
}
.ai-typing > span:nth-child(2) { animation-delay: 0.15s; }
.ai-typing > span:nth-child(3) { animation-delay: 0.3s; }
@keyframes ai-typing-bounce {
  0%, 60%, 100% {
    transform: translateY(0);
    opacity: 0.4;
  }
  30% {
    transform: translateY(-3px);
    opacity: 1;
  }
}
.ai-empty-chat {
  display: flex;
  flex-direction: column;
  align-self: stretch;
  width: 100%;
  gap: 0;
  padding: 0 0 10px;
  color: var(--vs-text-2);
}
.ai-suggestion-heading {
  margin-top: 6px;
  color: var(--vs-text-3);
  font-size: 0.7rem;
  font-weight: 600;
  line-height: 1.3;
}
.ai-quick-prompts {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  min-width: 0;
  gap: 1px;
  margin-top: 5px;
}
.ai-quick-prompt {
  display: flex;
  justify-content: flex-start;
  width: 100%;
  min-width: 0;
  height: 28px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--vs-text-2);
  font: inherit;
  font-size: 0.78rem;
  line-height: 1.2;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.ai-quick-prompt:hover {
  color: var(--vs-text-1);
  background: color-mix(in srgb, var(--vs-hover-bg) 72%, transparent);
}
.ai-quick-prompt :deep(.n-button__content) {
  justify-content: flex-start;
  gap: 8px;
  width: 100%;
}
.ai-quick-icon {
  flex: 0 0 auto;
  color: var(--vs-text-3);
}
.ai-quick-icon :deep(svg) { width: 14px; height: 14px; display: block; }
.ai-empty-hint {
  margin-top: 9px;
  padding-left: 6px;
  color: var(--vs-text-3);
  font-size: 0.72rem;
  line-height: 1.4;
}
</style>
