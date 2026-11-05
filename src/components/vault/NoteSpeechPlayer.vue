<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NIcon, NSelect } from 'naive-ui'
import { PlayerPause, PlayerPlay, PlayerSkipBack, PlayerSkipForward, PlayerStop } from '@vicons/tabler'
import { useI18n } from '../../composables/useI18n'
import type { NoteSpeechRate, NoteSpeechStatus } from '../../composables/vault/useNoteSpeech'

const props = defineProps<{
  status: NoteSpeechStatus
  currentIndex: number
  totalSegments: number
  playbackRate: NoteSpeechRate
  error: string | null
  canGoPrevious: boolean
  canGoNext: boolean
  editing: boolean
}>()

const emit = defineEmits<{
  play: []
  pause: []
  resume: []
  stop: []
  previous: []
  next: []
  retry: []
  rate: [value: number]
}>()

const { t } = useI18n()
const active = computed(() => props.status !== 'idle')
const editorKeyboardOpen = ref(false)
watch([active, () => props.editing], ([active, editing], _, onCleanup) => {
  editorKeyboardOpen.value = false
  const viewport = window.visualViewport
  if (!active || !editing || !viewport) return

  const update = () => {
    editorKeyboardOpen.value = viewport.scale === 1
      && document.documentElement.clientHeight - viewport.height > 100
      && Boolean(document.activeElement?.closest('.monaco-host'))
  }
  viewport.addEventListener('resize', update)
  document.addEventListener('focusin', update)
  update()
  onCleanup(() => {
    viewport.removeEventListener('resize', update)
    document.removeEventListener('focusin', update)
  })
}, { immediate: true })
const rates = [0.75, 1, 1.25, 1.5].map((value) => ({ label: `${value}×`, value }))
const statusLabel = computed(() => {
  if (props.error === 'tts-playback-blocked') return t('note.speech_paused')
  if (props.status === 'playing') return t('note.speech_playing')
  if (props.status === 'paused') return t('note.speech_paused')
  if (props.status === 'buffering') return t('note.speech_buffering')
  if (props.status === 'error') return t('note.speech_error')
  return t('note.speech_preparing')
})
const errorMessage = computed(() => {
  const code = props.error
  if (code === 'tts-playback-blocked') return t('note.speech_playback_blocked')
  if (code === 'tts-too-long' || code === 'tts-text-too-long') return t('note.speech_too_long')
  if (code === 'tts-empty' || code === 'tts-empty-text') return t('note.speech_empty')
  if (code === 'ai-speech-profile-missing' || code === 'ai-profile-not-found') return t('note.speech_profile_missing')
  if (code === 'tts-privacy-consent-required') return t('note.speech_consent_required')
  if (code === 'tts-concurrency-limit' || code === 'tts-rate-limit') return t('note.speech_too_many')
  return code ? t('note.speech_unavailable') : ''
})
</script>

<template>
  <Transition name="note-speech-player">
    <aside v-if="active" class="note-speech-player" :class="{ 'editor-keyboard-open': editorKeyboardOpen }"
      aria-live="polite" data-testid="note-speech-player">
      <div class="note-speech-player-status">
        <strong>{{ statusLabel }}</strong>
        <span v-if="totalSegments > 1">{{ t('note.speech_segment', { current: currentIndex + 1, total: totalSegments }) }}</span>
        <span v-if="errorMessage" class="note-speech-player-error" role="alert">{{ errorMessage }}</span>
      </div>
      <div class="note-speech-player-controls">
        <NButton quaternary size="small" :disabled="!canGoPrevious || status === 'preparing'" :aria-label="t('note.speech_previous')" @click="emit('previous')">
          <NIcon aria-hidden="true"><PlayerSkipBack /></NIcon>
        </NButton>
        <NButton v-if="status === 'playing' || status === 'buffering'" quaternary size="small" :aria-label="t('note.speech_pause')" @click="emit('pause')">
          <NIcon aria-hidden="true"><PlayerPause /></NIcon>
        </NButton>
        <NButton v-else-if="status !== 'error'" quaternary size="small" :disabled="status === 'preparing'"
          :aria-label="t(status === 'paused' ? 'note.speech_resume' : 'note.speech_play')" @click="emit('resume')">
          <NIcon aria-hidden="true"><PlayerPlay /></NIcon>
        </NButton>
        <NButton v-else quaternary size="small" :aria-label="t('note.speech_retry')" @click="emit('retry')">{{ t('note.speech_retry') }}</NButton>
        <NButton v-if="canGoNext" quaternary size="small" :disabled="status === 'preparing'" :aria-label="t('note.speech_next')" @click="emit('next')">
          <NIcon aria-hidden="true"><PlayerSkipForward /></NIcon>
        </NButton>
        <NSelect class="note-speech-rate" size="small" :value="playbackRate" :options="rates" :aria-label="t('note.speech_rate')"
          @update:value="(value: number | null) => value !== null && emit('rate', value)" />
        <NButton quaternary size="small" :aria-label="t('note.speech_stop')" @click="emit('stop')">
          <NIcon aria-hidden="true"><PlayerStop /></NIcon>
        </NButton>
      </div>
    </aside>
  </Transition>
</template>

<style scoped>
.note-speech-player {
  position: fixed;
  z-index: 3000;
  left: 50%;
  bottom: calc(16px + env(safe-area-inset-bottom, 0px));
  display: flex;
  align-items: center;
  gap: 18px;
  max-width: min(720px, calc(100vw - 32px));
  padding: 10px 14px;
  border: 1px solid var(--border-color, #dfe2e8);
  border-radius: 14px;
  transform: translateX(-50%);
  background: var(--surface-color, #fff);
  box-shadow: 0 8px 32px rgb(20 24 40 / 14%);
  color: var(--text-color, #20242e);
}
.note-speech-player-status { display: flex; flex-direction: column; gap: 2px; min-width: 0; font-size: 13px; }
.note-speech-player-status > span { color: var(--text-secondary-color, #737b8c); }
.note-speech-player-status .note-speech-player-error { color: var(--error-color, #c43b4a); }
.note-speech-player-controls { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
.note-speech-rate { width: 76px; }
.note-speech-player-enter-active, .note-speech-player-leave-active { transition: opacity 120ms ease, transform 120ms ease; }
.note-speech-player-enter-from, .note-speech-player-leave-to { opacity: 0; transform: translate(-50%, 8px); }
@media (max-width: 600px), (max-height: 500px) and (pointer: coarse) {
  .note-speech-player {
    left: max(10px, env(safe-area-inset-left, 0px));
    right: max(10px, env(safe-area-inset-right, 0px));
    bottom: calc(10px + env(safe-area-inset-bottom, 0px));
    max-width: none;
    flex-direction: column;
    align-items: stretch;
    gap: 4px;
    padding: 8px;
    transform: none;
  }
  .note-speech-player.editor-keyboard-open { display: none; }
  .note-speech-player-status { font-size: 12px; overflow-wrap: anywhere; }
  .note-speech-player-controls { flex-wrap: wrap; justify-content: space-between; }
  .note-speech-player-controls :deep(.n-button) { min-width: 44px; min-height: 44px; }
  .note-speech-rate :deep(.n-base-selection-label) { min-height: 44px; }
  .note-speech-player-enter-from, .note-speech-player-leave-to { transform: translateY(8px); }
}
</style>
