<script setup lang="ts">
import { nextTick, onActivated, onBeforeUnmount, onMounted, ref } from 'vue'
import type { FinanceAgentPhase } from '../../../shared/ledgerAiAnalysis'
import { NButton, NIcon } from 'naive-ui'
import type { Message } from '../../lib/ai-api'
import { ArrowDown, Link, ListCheck, Search, Stars, Wallet } from '@vicons/tabler'
import AiToolActivity from './AiToolActivity.vue'
import AiFinanceActivity from './AiFinanceActivity.vue'
import AiMarkdown from './AiMarkdown.vue'
import { useI18n } from '../../composables/useI18n'

const props = defineProps<{
  messages: Message[]
  currentPath: string | null
  noteLinkContext?: { paths: string[]; openLink: (path: string, anchor?: string) => Promise<void> } | null
  quickPrompts: Array<{ label: string; text: string }>
  emptyHint?: string
  finance?: boolean
  showWelcome?: boolean
  promptsDisabled?: boolean
  financePhase?: FinanceAgentPhase | null
}>()

const emit = defineEmits<{
  prompt: [text: string]
}>()
const { t } = useI18n()
const viewport = ref<HTMLElement | null>(null)
const content = ref<HTMLElement | null>(null)
const following = ref(true)
let observer: ResizeObserver | undefined
let lastScrollTop = 0

function onScroll() {
  const el = viewport.value
  if (!el?.clientHeight) return
  lastScrollTop = el.scrollTop
  following.value = el.scrollHeight - el.clientHeight - el.scrollTop < 56
}

function followLatest() {
  const el = viewport.value
  if (!el?.clientHeight) return
  following.value = true
  el.scrollTop = el.scrollHeight
  lastScrollTop = el.scrollTop
}

onMounted(() => {
  if (!props.finance || !viewport.value || !content.value || typeof ResizeObserver === 'undefined') return
  observer = new ResizeObserver(() => {
    if (following.value) followLatest()
  })
  observer.observe(viewport.value)
  observer.observe(content.value)
})
onActivated(async () => {
  if (!props.finance) return
  await nextTick()
  if (following.value) followLatest()
  else if (viewport.value) viewport.value.scrollTop = lastScrollTop
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div class="ai-message-region">
    <div
      ref="viewport"
      class="ai-messages"
      :class="{ 'is-empty': props.messages.length === 0, 'has-messages': props.messages.length > 0 }"
      role="log"
      :tabindex="finance ? 0 : undefined"
      aria-live="polite"
      @scroll.passive="finance && onScroll()"
    >
      <div ref="content" class="ai-message-list">
        <div v-if="props.messages.length === 0">
          <div v-if="!finance || showWelcome" class="ai-empty-chat">
            <template v-if="finance">
              <NIcon class="ai-finance-welcome-icon" aria-hidden="true"><Wallet /></NIcon>
              <h2>{{ t('ai.finance_welcome') }}</h2>
              <p class="ai-empty-hint">{{ emptyHint }}</p>
            </template>
            <div v-else class="ai-suggestion-heading">{{ t('ai.suggestions') }}</div>
            <div class="ai-quick-prompts" :aria-label="t('ai.quick_prompts')">
              <NButton
                v-for="(prompt, index) in props.quickPrompts"
                :key="prompt.label"
                attr-type="button"
                :bordered="false"
                class="ai-quick-prompt"
                :title="prompt.text"
                :disabled="promptsDisabled"
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

            <div v-if="!finance" class="ai-empty-hint">
              {{ props.emptyHint ?? t(props.currentPath ? 'ai.empty_hint_note' : 'ai.empty_hint_vault') }}
            </div>
          </div>
        </div>

        <div
          v-for="message in props.messages"
          v-else
          :key="message.id > 0 ? message.id : `${message.sessionId}-${message.createdAt}-${message.role}`"
          class="ai-message"
          :class="[message.role, { 'ai-streaming': message.id === 0 }]"
        >
          <div
            v-if="!finance && message.role === 'assistant'"
            class="ai-avatar"
            aria-hidden="true"
          ><NIcon aria-hidden="true"><Stars /></NIcon></div>
          <div class="ai-bubble">
            <AiFinanceActivity
              v-if="finance && message.blocks?.financeActivity?.length"
              :activity="message.blocks.financeActivity"
              :streaming="message.id === 0"
            />
            <AiMarkdown
              v-if="message.role === 'assistant' && message.content && (finance || message.id !== 0)"
              :content="message.content"
              :source-path="currentPath"
              :finance="finance"
              :note-link-context="props.noteLinkContext"
            />
            <div v-else-if="message.content" class="ai-text" :class="{ 'ai-streaming-text': message.role === 'assistant' && message.id === 0 }">
              {{ message.content }}
            </div>
            <span
              v-else-if="!finance && message.role === 'assistant' && message.id === 0"
              class="ai-typing"
              role="status"
              :aria-label="t('ai.generating')"
            ><span /><span /><span /></span>
            <span v-if="finance && message.blocks?.cancelled" class="ai-finance-phase" role="status">{{ t('ai.finance_cancelled') }}</span>
            <AiToolActivity v-if="!finance && message.blocks?.toolCalls.length" :calls="message.blocks.toolCalls" />
          </div>
        </div>
        <p v-if="finance && financePhase" class="ai-finance-phase" role="status" data-testid="finance-agent-progress">
          {{ t(`ai.finance_phase_${financePhase}`) }}
        </p>
      </div>
    </div>
    <NButton v-if="finance && !following" class="ai-scroll-latest" size="small" round :aria-label="t('ai.finance_scroll_latest')" @click="followLatest">
      <NIcon aria-hidden="true"><ArrowDown /></NIcon>
    </NButton>
  </div>
</template>

<style scoped>
.ai-message-region {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
}
.ai-message-region > .ai-messages { width: 100%; }
.ai-message-list { display: flex; flex-direction: column; gap: 12px; }
.is-finance .ai-messages:focus-visible { outline: 1px solid var(--vs-accent); outline-offset: -2px; }
.is-finance .ai-message-list { flex: 1 0 auto; gap: 16px; }
.is-finance .is-empty .ai-message-list { justify-content: center; padding-bottom: min(8vh, 52px); box-sizing: border-box; }
.is-finance .ai-empty-chat { align-items: center; text-align: center; padding: 12px 0; }
.ai-finance-welcome-icon { color: var(--vs-accent); font-size: 28px; }
.is-finance .ai-empty-chat h2 { margin: 10px 0 0; color: var(--vs-text-1); font-size: 1.15rem; }
.is-finance .ai-empty-hint { margin: 6px 0 14px; padding: 0; font-size: 0.82rem; }
.is-finance .ai-quick-prompts { align-self: center; }
.is-finance .ai-quick-prompt { min-height: 36px; font-size: 0.85rem; padding-inline: 10px; }
.ai-finance-activity + .ai-markdown { margin-top: 6px; }
.ai-finance-phase { margin: 0; font-size: 0.75rem; color: var(--vs-text-2); }
.ai-scroll-latest { position: absolute; z-index: 1; bottom: 8px; left: 50%; transform: translateX(-50%); }

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
