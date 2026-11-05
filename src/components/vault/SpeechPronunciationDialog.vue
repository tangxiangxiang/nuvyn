<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { NButton, NInput, NModal } from 'naive-ui'
import { getSpeechPronunciations, saveSpeechPronunciations, resetSpeechPronunciations, type SpeechPronunciationEntry } from '../../lib/ai-api'
import { validateSpeechPronunciations, SPEECH_PRONUNCIATION_LIMITS } from '../../../shared/speechPronunciations'
import { useI18n } from '../../composables/useI18n'
import { useConfirm } from '../../composables/useConfirm'
import { useToast } from '../../composables/useToast'

const props = defineProps<{ initialText?: string }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const toast = useToast()
const { confirmCancellable } = useConfirm()
let pendingConfirmation: ReturnType<typeof confirmCancellable> | null = null
const corrupt = ref(false)
const confirming = ref(false)
const entries = ref<SpeechPronunciationEntry[]>([])
const loading = ref(true)
const busy = ref(false)
const failed = ref(false)
const invalid = ref(false)
const editing = ref<string | null>(null)
const text = ref(props.initialText ?? '')
const pinyin = ref('')
const controller = new AbortController()
onBeforeUnmount(() => {
  controller.abort()
  pendingConfirmation?.cancel()
})

async function load() {
  if (busy.value || confirming.value || controller.signal.aborted) return
  loading.value = true
  failed.value = false
  corrupt.value = false
  try {
    const result = await getSpeechPronunciations(controller.signal)
    if (controller.signal.aborted) return
    entries.value = result
    const existing = result.find((entry) => entry.text === props.initialText)
    if (existing) edit(existing)
  } catch (error) {
    if (!controller.signal.aborted) {
      failed.value = true
      corrupt.value = (error as { code?: string }).code === 'tts-pronunciations-corrupt'
    }
  }
  finally { loading.value = false }
}
onMounted(load)

function edit(entry: SpeechPronunciationEntry) {
  editing.value = entry.id
  text.value = entry.text
  pinyin.value = entry.pinyin
  invalid.value = false
}
function reset() {
  editing.value = null
  text.value = ''
  pinyin.value = ''
  invalid.value = false
}
async function persist(next: SpeechPronunciationEntry[]) {
  if (loading.value || busy.value || failed.value) return
  invalid.value = false
  let validated: SpeechPronunciationEntry[]
  try { validated = validateSpeechPronunciations(next) }
  catch { invalid.value = true; return }
  busy.value = true
  try {
    const result = await saveSpeechPronunciations(validated, controller.signal)
    if (controller.signal.aborted) return
    entries.value = result
    reset()
    toast.success(t('speech.dictionary_saved'))
    if (props.initialText !== undefined) emit('close')
  } catch { if (!controller.signal.aborted) toast.error(t('speech.dictionary_error')) }
  finally { busy.value = false }
}
async function confirmAction(message: string): Promise<boolean> {
  if (busy.value || pendingConfirmation || controller.signal.aborted) return false
  const pending = confirmCancellable(message, undefined, { destructive: true })
  confirming.value = true
  pendingConfirmation = pending
  try { return await pending.promise && !controller.signal.aborted }
  finally {
    if (pendingConfirmation === pending) pendingConfirmation = null
    confirming.value = false
  }
}
async function remove(entry: SpeechPronunciationEntry) {
  if (await confirmAction(t('speech.dictionary_delete_confirm', { word: entry.text }))) {
    await persist(entries.value.filter((item) => item.id !== entry.id))
  }
}
async function recover() {
  if (!corrupt.value || loading.value || !await confirmAction(t('speech.dictionary_recover_confirm'))) return
  busy.value = true
  try {
    const result = await resetSpeechPronunciations(controller.signal)
    if (controller.signal.aborted) return
    entries.value = result
    failed.value = false
    corrupt.value = false
    reset()
    toast.success(t('speech.dictionary_saved'))
  } catch { if (!controller.signal.aborted) toast.error(t('speech.dictionary_error')) }
  finally { busy.value = false }
}
function save() {
  const entry = { id: editing.value ?? crypto.randomUUID(), text: text.value.trim(), pinyin: pinyin.value }
  void persist([...entries.value.filter((item) => item.id !== editing.value), entry])
}
</script>

<template>
  <NModal :show="true" preset="card" :z-index="10000" :title="t('speech.dictionary')" :style="{ width: 'min(620px, calc(100vw - 32px))' }"
    :mask-closable="!busy && !confirming" :closable="!busy && !confirming" :close-on-esc="!busy && !confirming" :aria-label="t('speech.dictionary')"
    @update:show="(show: boolean) => { if (!show && !busy && !confirming) emit('close') }">
    <div data-testid="speech-pronunciations">
      <p>{{ t('speech.dictionary_hint') }}</p>
      <p>{{ t('speech.dictionary_match_hint') }}</p>
      <p v-if="[...text.trim()].length === 1" role="status">{{ t('speech.dictionary_single_warning') }}</p>
      <p v-if="failed" role="alert">{{ t(corrupt ? 'speech.dictionary_corrupt' : 'speech.dictionary_error') }} <NButton size="small" :disabled="loading || busy || confirming" @click="load">{{ t('speech.dictionary_retry') }}</NButton></p>
      <NButton v-if="corrupt" :disabled="loading || busy" @click="recover">{{ t('speech.dictionary_recover') }}</NButton>
      <p v-if="!failed">{{ entries.length }} / {{ SPEECH_PRONUNCIATION_LIMITS.entries }}</p>
      <div v-if="!loading && !failed" class="speech-pronunciation-list">
        <div v-for="entry in entries" :key="entry.id" class="speech-pronunciation-row">
          <span>{{ entry.text }} · {{ entry.pinyin }}</span>
          <NButton size="small" :disabled="busy" @click="edit(entry)">{{ t('speech.dictionary_edit') }}</NButton>
          <NButton size="small" :disabled="busy" @click="remove(entry)">{{ t('speech.dictionary_delete') }}</NButton>
        </div>
      </div>
      <label class="settings-field"><span>{{ t('speech.dictionary_word') }}</span>
        <NInput v-model:value="text" :disabled="loading || busy || failed" :input-props="{ 'aria-label': t('speech.dictionary_word') }" :maxlength="64" />
      </label>
      <label class="settings-field"><span>{{ t('speech.dictionary_pinyin') }}</span>
        <NInput v-model:value="pinyin" :disabled="loading || busy || failed" :input-props="{ 'aria-label': t('speech.dictionary_pinyin') }" placeholder="tian1 mu3" :maxlength="128" />
      </label>
      <p v-if="invalid" role="alert">{{ t('speech.dictionary_invalid') }}</p>
      <div class="settings-section-actions">
        <NButton :disabled="busy" @click="reset">{{ t('speech.dictionary_reset') }}</NButton>
        <NButton type="primary" :loading="busy" :disabled="loading || busy || failed" @click="save">{{ t('settings.save') }}</NButton>
      </div>
    </div>
  </NModal>
</template>

<style scoped>
.speech-pronunciation-list { max-height: 36vh; overflow-y: auto; margin-bottom: 16px; }
.speech-pronunciation-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; }
.speech-pronunciation-row > span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
</style>
