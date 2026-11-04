<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { NButton, NInput, NModal } from 'naive-ui'
import { getSpeechPronunciations, saveSpeechPronunciations, type SpeechPronunciationEntry } from '../../lib/ai-api'
import { validateSpeechPronunciations, SPEECH_PRONUNCIATION_LIMITS } from '../../../shared/speechPronunciations'
import { useI18n } from '../../composables/useI18n'
import { useToast } from '../../composables/useToast'

const props = defineProps<{ initialText?: string }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const toast = useToast()
const entries = ref<SpeechPronunciationEntry[]>([])
const loading = ref(true)
const busy = ref(false)
const failed = ref(false)
const invalid = ref(false)
const editing = ref<string | null>(null)
const text = ref(props.initialText ?? '')
const pinyin = ref('')
const controller = new AbortController()
onBeforeUnmount(() => controller.abort())

async function load() {
  loading.value = true
  failed.value = false
  try {
    const result = await getSpeechPronunciations(controller.signal)
    if (controller.signal.aborted) return
    entries.value = result
    const existing = result.find((entry) => entry.text === props.initialText)
    if (existing) edit(existing)
  } catch { if (!controller.signal.aborted) failed.value = true }
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
function save() {
  const entry = { id: editing.value ?? crypto.randomUUID(), text: text.value.trim(), pinyin: pinyin.value }
  void persist([...entries.value.filter((item) => item.id !== editing.value), entry])
}
</script>

<template>
  <NModal :show="true" preset="card" :z-index="10020" :title="t('speech.dictionary')" :style="{ width: 'min(620px, calc(100vw - 32px))' }"
    :mask-closable="!busy" :closable="!busy" :close-on-esc="!busy" :aria-label="t('speech.dictionary')"
    @update:show="(show: boolean) => { if (!show && !busy) emit('close') }">
    <div data-testid="speech-pronunciations">
      <p>{{ t('speech.dictionary_hint') }}</p>
      <p v-if="failed" role="alert">{{ t('speech.dictionary_error') }} <NButton size="small" @click="load">{{ t('speech.dictionary_retry') }}</NButton></p>
      <p v-else>{{ entries.length }} / {{ SPEECH_PRONUNCIATION_LIMITS.entries }}</p>
      <div v-if="!loading && !failed" class="speech-pronunciation-list">
        <div v-for="entry in entries" :key="entry.id" class="speech-pronunciation-row">
          <span>{{ entry.text }} · {{ entry.pinyin }}</span>
          <NButton size="small" :disabled="busy" @click="edit(entry)">{{ t('speech.dictionary_edit') }}</NButton>
          <NButton size="small" :disabled="busy" @click="persist(entries.filter((item) => item.id !== entry.id))">{{ t('speech.dictionary_delete') }}</NButton>
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
