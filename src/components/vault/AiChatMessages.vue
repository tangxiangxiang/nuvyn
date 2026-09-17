<script setup lang="ts">
import { NButton, NIcon } from 'naive-ui'
import type { Message } from '../../lib/ai-api'
import { Stars } from '@vicons/tabler'
import AiToolCallCard from './AiToolCallCard.vue'
import AiMarkdown from './AiMarkdown.vue'
import { useI18n } from '../../composables/useI18n'

defineProps<{
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
  <div class="ai-messages" role="log" aria-live="polite">
    <div v-if="messages.length === 0" class="ai-empty-chat">
      <div class="ai-empty-head">
        <NIcon class="ai-empty-icon" aria-hidden="true"><Stars /></NIcon>
        <div>
          <div class="ai-empty-title">
            {{ t(currentPath ? 'ai.ask_note' : 'ai.ask_vault') }}
          </div>
          <div class="ai-empty-subtitle">
            {{ currentPath || t('ai.no_document') }}
          </div>
        </div>
      </div>
      <div class="ai-quick-prompts" :aria-label="t('ai.quick_prompts')">
        <NButton
          v-for="prompt in quickPrompts"
          :key="prompt.label"
          attr-type="button"
          :bordered="false"
          class="ai-quick-prompt"
          @click="emit('prompt', prompt.text)"
        >{{ prompt.label }}</NButton>
      </div>
    </div>

    <div
      v-for="message in messages"
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
  gap: 12px;
  padding: 4px 0;
  color: var(--vs-text-2, #858585);
}
.ai-empty-head {
  display: flex;
  align-items: center;
  gap: 9px;
}
.ai-empty-icon {
  display: inline-flex;
  width: 26px;
  height: 26px;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  color: color-mix(in srgb, var(--vs-accent, #007acc) 82%, var(--vs-text-1, #d4d4d4));
  background: color-mix(in srgb, var(--vs-accent, #007acc) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--vs-accent, #007acc) 22%, transparent);
  border-radius: 7px;
}
.ai-empty-icon :deep(svg) { width: 15px; height: 15px; display: block; }
.ai-empty-title { color: var(--vs-text-1, #d4d4d4); font-size: 0.86rem; font-weight: 600; line-height: 1.25; }
.ai-empty-subtitle {
  margin-top: 2px;
  max-width: 230px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--vs-text-3, #6a6a6a);
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 0.72rem;
}
.ai-quick-prompts { display: flex; flex-wrap: wrap; gap: 6px; }
.ai-quick-prompt {
  padding: 4px 7px;
  border: 1px solid color-mix(in srgb, var(--vs-border, #3c3c3c) 22%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--vs-bg-2, #252526) 72%, transparent);
  color: var(--vs-text-2, #858585);
  font: inherit;
  font-size: 0.75rem;
  line-height: 1.2;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
}
.ai-quick-prompt:hover {
  color: var(--vs-text-1, #d4d4d4);
  background: color-mix(in srgb, var(--vs-accent, #007acc) 10%, var(--vs-bg-2, #252526));
  border-color: color-mix(in srgb, var(--vs-accent, #007acc) 36%, var(--vs-border, #3c3c3c));
}
</style>
