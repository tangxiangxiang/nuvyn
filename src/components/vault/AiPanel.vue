<script setup lang="ts">
// AI panel — chat UI + session persistence + LLM streaming. The
// close button emits `close` so the parent (VaultView) can decide
// what to do (typically toggleRightRail). The composer sends a user
// message to the active session via useAiHistory.sendAndStream;
// the server streams back tokens that fill the assistant bubble
// in real time.
//
// The `configured` flag (from /api/ai/active) determines whether
// the send button is enabled. When false, a persistent banner
// explains the missing env var.
//
// The send button is a single toggle: when idle, it sends (type=
// submit so Enter still triggers it); when busy, it stops the
// in-flight stream (type=button, distinct color/icon so the
// destructive nature reads visually). See useAiHistory.stop() for
// the AbortController plumbing.
//
// Tool cards: when the assistant message carries tool calls
// (m.blocks?.toolCalls), each call is rendered as a card with the
// tool name, an icon, a status pill (ok / error / pending), and
// the result text. read_file / list_files cards are collapsed by
// default to keep the panel compact; the user can expand them.
//
// Live context (Edit-10.2 capture, Edit-10.3 transport): onSend
// captures the active workspace tab synchronously BEFORE any async
// work, so tab switches, renames or continued typing after the click
// can never splice this turn's identity and content. The route is
// not the AI authority — useAiLiveContext reads the workspace. Every
// ready kind (Document/History/Diff/Recovery) ships the FULL
// send-time snapshot as the request's liveContext field; none /
// unavailable fail closed with no liveContext at all (no route, no
// getPost, no path fallback). The server validates the snapshot
// strictly and uses it for this run's system prompt only.
import { onMounted, ref, computed, nextTick } from 'vue'
import { NButton, NIcon } from 'naive-ui'
import { History, MessagePlus } from '@vicons/tabler'
import { useAiHistory } from '../../composables/vault/useAiHistory'
import { useAiLiveContext } from '../../composables/vault/useAiLiveContext'
import { useI18n } from '../../composables/useI18n'
import { displayPathForCapture } from './aiContextPaths'
import AiSessionPicker from './AiSessionPicker.vue'
import AiChatMessages from './AiChatMessages.vue'
import AiComposer from './AiComposer.vue'
import AiContextPicker from './AiContextPicker.vue'

const props = withDefaults(defineProps<{
  documentPaths?: string[]
}>(), {
  documentPaths: () => [],
})

const draft = ref('')
const contextPaths = ref<string[]>([])
const contextPickerOpen = ref(false)
const pickerOpen = ref(false)
const history = useAiHistory()
const liveContext = useAiLiveContext()
const { t } = useI18n()
const composer = ref<InstanceType<typeof AiComposer> | null>(null)

// The path chip + quick-prompt scope follow the same capture the send
// uses. The computed re-runs capture() on every workspace change —
// there is no cache, and the send path never reads this value.
const displayPath = computed(() => displayPathForCapture(liveContext.capture()))
const availableContextPaths = computed(() => props.documentPaths.filter(
  (path) => path !== displayPath.value && !contextPaths.value.includes(path),
))

onMounted(async () => {
  await history.loadActive()
})

async function onSend() {
  const text = draft.value.trim()
  if (!text) return
  if (history.busy.value) return
  if (!history.configured.value) return

  // Capture BEFORE any await: one immutable send-time snapshot.
  const capture = liveContext.capture()

  draft.value = '' // clear immediately for snappy UX

  // Edit-10.3: ready → the FULL snapshot travels as liveContext;
  // none / unavailable → no liveContext at all (fail closed).
  const snapshot = capture.status === 'ready' ? capture.context : undefined

  await history.sendAndStream(text, {
    liveContext: snapshot,
    ...(contextPaths.value.length ? { contextPaths: [...contextPaths.value] } : {}),
  })
}

function toggleContextPicker() {
  contextPickerOpen.value = !contextPickerOpen.value
}

function addContextPath(path: string) {
  if (contextPaths.value.includes(path)) return
  contextPaths.value = [...contextPaths.value, path]
}

function removeContextPath(path: string) {
  contextPaths.value = contextPaths.value.filter((item) => item !== path)
}

function togglePicker() {
  pickerOpen.value = !pickerOpen.value
}

async function onNewSession() {
  if (history.busy.value) return
  pickerOpen.value = false
  await history.createSession()
}

const quickPrompts = computed(() => {
  const hasNote = displayPath.value !== null
  return hasNote
    ? [
        { label: t('quick_prompts.with_note.summarize.label'), text: t('quick_prompts.with_note.summarize.text') },
        { label: t('quick_prompts.with_note.find_related.label'), text: t('quick_prompts.with_note.find_related.text') },
        { label: t('quick_prompts.with_note.suggest_tidy.label'), text: t('quick_prompts.with_note.suggest_tidy.text') },
      ]
    : [
        { label: t('quick_prompts.no_note.browse.label'), text: t('quick_prompts.no_note.browse.text') },
        { label: t('quick_prompts.no_note.find_unprocessed.label'), text: t('quick_prompts.no_note.find_unprocessed.text') },
        { label: t('quick_prompts.no_note.suggest_tidy.label'), text: t('quick_prompts.no_note.suggest_tidy.text') },
      ]
})

async function useQuickPrompt(text: string) {
  draft.value = text
  await nextTick()
  await composer.value?.focus()
}
</script>

<template>
  <aside class="ai-panel" :aria-label="t('ai.assistant')">
    <header class="ai-header">
      <span
        class="ai-title-session"
        :title="history.activeSession.value?.title || t('ai.new_conversation')"
      >{{ history.activeSession.value?.title || t('ai.new_conversation') }}</span>
      <div class="ai-header-actions">
      <NButton
        class="ai-header-btn"
        attr-type="button"
        text
        :bordered="false"
        :title="t(pickerOpen ? 'ai.close_history' : 'ai.open_history')"
        :aria-label="t(pickerOpen ? 'ai.close_history' : 'ai.open_history')"
        aria-haspopup="dialog"
        :aria-expanded="pickerOpen"
        @click="togglePicker"
      ><NIcon aria-hidden="true"><History /></NIcon></NButton>
      <NButton
        class="ai-header-btn"
        attr-type="button"
        text
        :bordered="false"
        :title="t('ai.new_conversation')"
        :aria-label="t('ai.new_conversation')"
        :disabled="history.busy.value"
        @click="onNewSession"
      ><NIcon aria-hidden="true"><MessagePlus /></NIcon></NButton>
      </div>
    </header>

    <div
      v-if="!history.configured.value"
      class="ai-no-key-banner"
      role="status"
    >{{ t('ai.not_configured') }}</div>

    <AiChatMessages
      :messages="history.messages.value"
      :current-path="displayPath"
      :quick-prompts="quickPrompts"
      @prompt="useQuickPrompt"
    />

    <AiContextPicker
      v-if="contextPickerOpen"
      :paths="availableContextPaths"
      @select="addContextPath"
      @close="contextPickerOpen = false"
    />

    <AiComposer
      ref="composer"
      v-model="draft"
      :busy="history.busy.value"
      :configured="history.configured.value"
      :context-paths="contextPaths"
      :can-add-context="availableContextPaths.length > 0"
      :context-picker-open="contextPickerOpen"
      @send="onSend"
      @stop="history.stop"
      @remove-context="removeContextPath"
      @toggle-context-picker="toggleContextPicker"
    />

    <AiSessionPicker v-if="pickerOpen" @close="pickerOpen = false" />
  </aside>
</template>
