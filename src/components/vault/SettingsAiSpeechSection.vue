<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { NButton, NCheckbox, NSelect } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { useConfirm } from '../../composables/useConfirm'
import { useToast } from '../../composables/useToast'
import * as api from '../../lib/ai-api'
import type { AiProfile, AiSpeechSettings } from '../../lib/ai-api'
import { DEFAULT_SPEECH_VOICE, SPEECH_VOICE_IDS, type SpeechVoiceId } from '../../../shared/aiProfiles'
import SpeechPronunciationDialog from './SpeechPronunciationDialog.vue'

const { t } = useI18n()
const { confirmCancellable } = useConfirm()
let pendingConfirmation: ReturnType<typeof confirmCancellable> | null = null
async function confirm(...args: Parameters<typeof confirmCancellable>): Promise<boolean> {
  const pending = confirmCancellable(...args)
  pendingConfirmation = pending
  try { return await pending.promise } finally {
    if (pendingConfirmation === pending) pendingConfirmation = null
  }
}
const toast = useToast()
const profiles = ref<AiProfile[]>([])
const controller = new AbortController()
let disposed = false
const loading = ref(true)
const loadError = ref(false)
const confirming = ref(false)
const speechMenuOpen = ref(false)
const voiceMenuOpen = ref(false)
const pronunciationDialogOpen = ref(false)
const dictionaryButton = ref<InstanceType<typeof NButton> | null>(null)
const speechSettings = ref<AiSpeechSettings>({ profileId: null, privacyConsent: false, voiceId: DEFAULT_SPEECH_VOICE })
const speechProfileId = ref<string | null>(null)
const speechPrivacyConsent = ref(false)
const speechVoiceId = ref<SpeechVoiceId>(DEFAULT_SPEECH_VOICE)
const speechVoiceOptions = computed(() => SPEECH_VOICE_IDS.map((value) => ({ value, label: t(`speech.voice_${value}`) })))
const speechSaving = ref(false)
const speechError = ref('')
const speechCache = ref<api.NoteSpeechCacheUsage | null>(null)
const cacheBusy = ref(false)
const cacheError = ref(false)
async function loadSpeechCache() {
  try {
    const usage = await api.getNoteSpeechCacheUsage(controller.signal)
    if (!disposed) speechCache.value = usage
  } catch { if (!disposed) cacheError.value = true }
}
async function clearSpeechCache() {
  if (blocked.value) return
  cacheBusy.value = true
  try {
    confirming.value = true
    let accepted = false
    try { accepted = await confirm(t('settings.speech_cache_clear'), t('settings.speech_cache_confirm'), { destructive: true }) }
    finally { confirming.value = false }
    if (!accepted || disposed) return
    cacheError.value = false
    const usage = await api.clearNoteSpeechCache(controller.signal)
    if (!disposed) { speechCache.value = usage; toast.success(t('settings.speech_cache_cleared')) }
  } catch { if (!disposed) cacheError.value = true }
  finally { cacheBusy.value = false }
}
const speechProfileOptions = computed(() => {
  const options = profiles.value.map((profile) => ({
    label: `${profile.name} · ${profile.provider === 'openai' ? 'OpenAI' : 'Anthropic'}`,
    value: profile.id,
    disabled: !profile.configured || Boolean(profile.credentialError),
  }))
  if (speechProfileId.value && !profiles.value.some((profile) => profile.id === speechProfileId.value)) {
    options.unshift({ label: t('settings.speech_profile_missing'), value: speechProfileId.value, disabled: true })
  }
  return options
})

const blocked = computed(() => loading.value || loadError.value || speechSaving.value || cacheBusy.value || confirming.value)
const snapshot = () => JSON.stringify({
  profileId: speechProfileId.value,
  privacyConsent: speechPrivacyConsent.value,
  voiceId: speechVoiceId.value,
})
const initial = ref('')
const dirty = computed(() => initial.value !== '' && snapshot() !== initial.value)

async function load() {
  loading.value = true
  loadError.value = false
  try {
    const [data, speech] = await Promise.all([
      api.getAiProfiles(controller.signal),
      api.getAiSpeechSettings(controller.signal),
    ])
    if (disposed) return
    profiles.value = data.profiles
    speechSettings.value = speech
    speechProfileId.value = speech.profileId
    speechPrivacyConsent.value = speech.privacyConsent
    speechVoiceId.value = speech.voiceId ?? DEFAULT_SPEECH_VOICE
    initial.value = snapshot()
  } catch {
    if (!disposed) loadError.value = true
  } finally {
    if (!disposed) loading.value = false
  }
}
async function canLeave(): Promise<boolean> {
  if (speechSaving.value || cacheBusy.value || confirming.value || pronunciationDialogOpen.value) return false
  if (!dirty.value) return true
  confirming.value = true
  try {
    return await confirm(t('settings.speech_discard'), t('settings.speech_discard_detail'), { destructive: true }) && !disposed
  } finally {
    confirming.value = false
  }
}
async function closeDictionary() {
  pronunciationDialogOpen.value = false
  await nextTick()
  if (!disposed) dictionaryButton.value?.$el.focus()
}
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && (speechMenuOpen.value || voiceMenuOpen.value)) {
    event.preventDefault()
    event.stopPropagation()
    speechMenuOpen.value = false
    voiceMenuOpen.value = false
  }
}
async function saveSpeechSettings() {
  if (blocked.value || speechSaving.value) return
  speechSaving.value = true
  speechError.value = ''
  try {
    const saved = await api.saveAiSpeechSettings({
      profileId: speechProfileId.value,
      privacyConsent: speechPrivacyConsent.value,
      voiceId: speechVoiceId.value,
    }, controller.signal)
    if (disposed) return
    speechSettings.value = saved
    speechProfileId.value = saved.profileId
    speechPrivacyConsent.value = saved.privacyConsent
    speechVoiceId.value = saved.voiceId
    initial.value = snapshot()
    toast.success(t('settings.speech_saved'))
  } catch (error) {
    if (disposed) return
    const code = (error as { code?: string })?.code
    speechError.value = t(code === 'ai-speech-key-type-invalid'
      ? 'settings.speech_key_type_invalid'
      : code === 'ai-speech-profile-unconfigured'
        ? 'settings.speech_profile_unconfigured'
        : code === 'ai-profile-not-found'
          ? 'settings.speech_profile_missing'
          : 'settings.speech_save_failed')
  } finally {
    speechSaving.value = false
  }
}

onMounted(() => { void load(); void loadSpeechCache() })
onBeforeUnmount(() => { disposed = true; pendingConfirmation?.cancel(); controller.abort() })
defineExpose({ canLeave })
</script>

<template>
  <section class="settings-section" aria-labelledby="settings-speech-page-title" @keydown.capture="onKeydown">
    <header class="settings-section-header">
      <div><h3 id="settings-speech-page-title">{{ t('settings.ai_speech') }}</h3></div>
    </header>
    <div class="settings-section-body">
      <div v-if="loadError" class="settings-warning-card" role="alert">
        {{ t('settings.profile_load_error') }}
        <NButton @click="load">{{ t('settings.profile_retry') }}</NButton>
      </div>
      <div class="settings-card settings-speech-card" aria-labelledby="settings-speech-title">
        <h4 id="settings-speech-title" class="settings-card-title">{{ t('settings.speech_title') }}</h4>
        <p class="settings-speech-description">{{ t('settings.speech_detail') }}</p>
        <label class="settings-field">
          <span class="settings-field-label">{{ t('settings.speech_profile') }}</span>
          <NSelect data-testid="settings-speech-profile" :aria-label="t('settings.speech_profile')"
            v-model:value="speechProfileId" v-model:show="speechMenuOpen" to=".settings-backdrop" clearable :options="speechProfileOptions"
            :disabled="blocked || speechSaving" :placeholder="t('settings.speech_profile_placeholder')" />
        </label>
        <p v-if="!loading && speechProfileId && !profiles.some(profile => profile.id === speechProfileId && profile.configured && !profile.credentialError)"
          role="alert" class="settings-warning-card">{{ t(profiles.some(profile => profile.id === speechProfileId) ? 'settings.speech_profile_unconfigured' : 'settings.speech_profile_missing') }}</p>
        <label class="settings-field">
          <span class="settings-field-label">{{ t('speech.voice') }}</span>
          <NSelect data-testid="settings-speech-voice" :aria-label="t('speech.voice')" v-model:value="speechVoiceId" v-model:show="voiceMenuOpen" to=".settings-backdrop" :options="speechVoiceOptions" :disabled="blocked || speechSaving" />
        </label>
        <NCheckbox v-model:checked="speechPrivacyConsent" :disabled="blocked || speechSaving">
          {{ t('settings.speech_privacy_consent') }}
        </NCheckbox>
        <p v-if="speechError" class="settings-warning-card" role="alert">{{ speechError }}</p>
        <div class="settings-section-actions">
          <NButton type="primary" :loading="speechSaving" :disabled="blocked || speechSaving"
            @click="saveSpeechSettings">{{ t('settings.save') }}</NButton>
          <span v-if="speechSettings.privacyConsent && !speechPrivacyConsent" class="settings-speech-revoke-hint">
            {{ t('settings.speech_consent_will_revoke') }}
          </span>
        </div>
      </div>
      <div class="settings-card settings-speech-dictionary">
        <h4 class="settings-card-title">{{ t('speech.dictionary') }}</h4>
        <p class="settings-speech-description">{{ t('settings.speech_dictionary_detail') }}</p>
        <NButton ref="dictionaryButton" :disabled="blocked" @click="pronunciationDialogOpen = true">{{ t('speech.dictionary') }}</NButton>
        <SpeechPronunciationDialog v-if="pronunciationDialogOpen" @close="closeDictionary" />
      </div>
      <div class="settings-card settings-speech-cache">
        <h4 class="settings-card-title">{{ t('settings.speech_cache_title') }}</h4>
        <p class="settings-speech-description">{{ t('settings.speech_cache_detail') }}</p>
        <div class="settings-section-actions settings-ai-profile-actions">
          <span v-if="speechCache">{{ t('settings.speech_cache_usage', { used: (speechCache.bytes / 1048576).toFixed(1), limit: (speechCache.limitBytes / 1048576).toFixed(0) }) }}</span>
          <NButton size="small" :loading="cacheBusy" :disabled="blocked || cacheBusy" @click="clearSpeechCache">{{ t('settings.speech_cache_clear') }}</NButton>
        </div>
        <p v-if="cacheError" class="settings-warning-card" role="alert">{{ t('settings.speech_cache_error') }}</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.settings-speech-card,
.settings-speech-dictionary,
.settings-speech-cache {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.settings-card-title,
.settings-speech-description {
  margin: 0;
}
.settings-speech-description {
  color: var(--settings-muted);
  font-size: 0.9rem;
  line-height: 1.5;
}
.settings-section-actions {
  flex-wrap: wrap;
}
</style>
