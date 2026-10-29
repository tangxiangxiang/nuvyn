<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { NButton, NInput, NSelect } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { useConfirm } from '../../composables/useConfirm'
import { useToast } from '../../composables/useToast'
import { useAiHistory } from '../../composables/vault/useAiHistory'
import * as api from '../../lib/ai-api'
import type { AiProfile, AiProfileInput, AiProvider, AiConnectionState, AiConnectionTestResult } from '../../lib/ai-api'

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
const history = useAiHistory()
const profiles = ref<AiProfile[]>([])
const activeId = ref<string | null>(null)
const selectedId = ref<string | null>(null)
const loading = ref(true)
const saving = ref(false)
const confirming = ref(false)
const loadError = ref(false)
const migrationError = ref<string | undefined>()
const form = reactive({ name: '', provider: 'anthropic' as AiProvider, apiKey: '', baseURL: '', model: '' })
const initial = ref(JSON.stringify(form))
const sectionEl = ref<HTMLElement | null>(null)
const dirty = computed(() => JSON.stringify(form) !== initial.value)
const selected = computed(() => profiles.value.find((p) => p.id === selectedId.value))
const blocked = computed(() => loading.value || saving.value || confirming.value)
const menuOpen = ref(false)
const connectionState = ref<AiConnectionState>('untested')
const connectionResult = ref<AiConnectionTestResult | null>(null)
const connectionError = ref('')
const controller = new AbortController()
let testController: AbortController | null = null
let testRun = 0
let disposed = false
const providerOptions = [{ label: 'Anthropic', value: 'anthropic' }, { label: 'OpenAI', value: 'openai' }]

function resetTest() {
  ++testRun
  testController?.abort()
  testController = null
  connectionState.value = 'untested'
  connectionResult.value = null
  connectionError.value = ''
}
watch(form, resetTest, { flush: 'sync' })
function select(profile?: AiProfile) {
  resetTest()
  selectedId.value = profile?.id ?? null
  Object.assign(form, { name: profile?.name ?? '', provider: profile?.provider ?? 'anthropic', apiKey: '', baseURL: profile?.baseURL ?? '', model: profile?.model ?? '' })
  initial.value = JSON.stringify(form)
}
async function canLeave(): Promise<boolean> {
  if (saving.value || confirming.value) return false
  if (!dirty.value) { resetTest(); return true }
  confirming.value = true
  try {
    return await confirm(t('settings.profile_discard'), t('settings.profile_discard_detail'), { destructive: true }) && !disposed
  } finally { confirming.value = false }
}
async function choose(profile?: AiProfile) {
  if (blocked.value || profile?.id === selectedId.value && profile) return
  if (await canLeave() && !disposed) select(profile)
}
async function reload(preferredId: string | null = selectedId.value) {
  const data = await api.getAiProfiles(controller.signal)
  if (disposed) return
  profiles.value = data.profiles
  activeId.value = data.activeProfileId
  migrationError.value = data.migrationError
  select(data.profiles.find((p) => p.id === preferredId) ?? data.profiles.find((p) => p.id === data.activeProfileId) ?? data.profiles[0])
}
async function load() {
  loading.value = true
  loadError.value = false
  try { await reload() } catch (error) {
    if (!disposed) { loadError.value = true; showError(error) }
  } finally { loading.value = false }
}
function showError(error: unknown) {
  const code = (error as { code?: string })?.code
  if (code && ['master-key-required', 'master-key-invalid', 'master-key-file-unreadable', 'stored-key-invalid'].includes(code) && selectedId.value) {
    profiles.value = profiles.value.map((p) => p.id === selectedId.value ? { ...p, credentialError: code } : p)
  }
  const message = error instanceof Error ? error.message : t('common.unknown_error')
  toast.error(t('settings.save_failed', { error: message }))
}
async function retryMigration() {
  if (blocked.value || !await canLeave()) return
  loading.value = true
  try {
    await api.retryAiProfileMigration(controller.signal)
    await reload()
  } catch (error) { if (!disposed) showError(error) } finally { loading.value = false }
}
async function protocolConsent(): Promise<boolean> {
  if (!selected.value?.configured || selected.value.provider === form.provider || form.apiKey.trim()) return true
  return await confirm(t('settings.profile_protocol_confirm'), t('settings.profile_protocol_detail')) && !disposed
}
function input(): AiProfileInput {
  return { name: form.name, provider: form.provider, baseURL: form.baseURL, model: form.model,
    ...(form.apiKey.trim() ? { apiKey: form.apiKey } : {}),
    ...(selected.value && selected.value.provider !== form.provider ? { confirmProviderChange: true } : {}) }
}
async function save() {
  if (blocked.value || !form.name.trim()) return
  confirming.value = true
  let consent: boolean
  try { consent = await protocolConsent() } finally { confirming.value = false }
  if (!consent || disposed) return
  saving.value = true
  resetTest()
  try {
    const result = selectedId.value
      ? await api.updateAiProfile(selectedId.value, input(), controller.signal)
      : await api.createAiProfile(input(), controller.signal)
    if (disposed) return
    // Apply the successful response immediately, even if a later refresh fails.
    profiles.value = [...profiles.value.filter((p) => p.id !== result.id), result]
    select(result)
    await history.loadSettings()
    if (!disposed) toast.success(t('settings.saved'))
  } catch (error) { if (!disposed) showError(error) } finally { saving.value = false }
}
async function activate() {
  if (blocked.value || !selectedId.value || dirty.value) return
  saving.value = true
  try {
    const result = await api.activateAiProfile(selectedId.value, controller.signal)
    if (disposed) return
    activeId.value = result.activeProfileId
    await history.loadSettings()
  } catch (error) { if (!disposed) showError(error) } finally { saving.value = false }
}
async function remove() {
  const profile = selected.value
  if (blocked.value || !profile || !await canLeave()) return
  confirming.value = true
  let ok: boolean
  try {
    ok = await confirm(t('settings.profile_delete_confirm', { name: profile.name, provider: profile.provider }),
      t(activeId.value === profile.id ? 'settings.profile_delete_default_detail' : 'settings.profile_delete_detail'), { destructive: true })
  } finally { confirming.value = false }
  if (!ok || disposed) return
  saving.value = true
  resetTest()
  try {
    await api.deleteAiProfile(profile.id, activeId.value === profile.id, controller.signal)
    if (disposed) return
    profiles.value = profiles.value.filter((p) => p.id !== profile.id)
    if (activeId.value === profile.id) activeId.value = null
    select(profiles.value[0])
    await history.loadSettings()
  } catch (error) { if (!disposed) showError(error) } finally { saving.value = false }
}
async function clearKey() {
  const profile = selected.value
  if (blocked.value || !profile) return
  confirming.value = true
  let ok: boolean
  try {
    ok = await confirm(t('settings.profile_clear_confirm', { name: profile.name, provider: profile.provider }), t('settings.forget_key_detail'), { destructive: true })
  } finally { confirming.value = false }
  if (!ok || disposed) return
  saving.value = true
  resetTest()
  try {
    const next = await api.updateAiProfile(profile.id, { clearKey: true }, controller.signal)
    if (disposed) return
    profiles.value = profiles.value.map((p) => p.id === next.id ? next : p)
    // Clearing a key does not discard unsaved name/model edits.
    form.apiKey = ''
    await history.loadSettings().catch(() => {})
    toast.success(t('settings.key_cleared'))
  } catch (error) { if (!disposed) showError(error) } finally { saving.value = false }
}
async function testConnection() {
  if (blocked.value || connectionState.value === 'checking') return
  confirming.value = true
  let consent: boolean
  try { consent = await protocolConsent() } finally { confirming.value = false }
  if (!consent || disposed) return
  resetTest()
  const run = ++testRun
  const abort = new AbortController()
  testController = abort
  connectionState.value = 'checking'
  try {
    const result = await api.testAiProfileConnection(selectedId.value, input(), abort.signal)
    if (disposed || run !== testRun) return
    connectionResult.value = result
    connectionState.value = 'connected'
  } catch (error: any) {
    if (disposed || run !== testRun) return
    connectionState.value = 'failed'
    const keys: Record<string, string> = { 'ai-connection-timeout': 'settings.connection_timeout', 'ai-authentication-failed': 'settings.connection_auth_failed', 'ai-model-unavailable': 'settings.connection_model_unavailable' }
    connectionError.value = keys[error.code] ? t(keys[error.code]!) : error.message || t('settings.connection_failed')
  } finally { if (run === testRun) testController = null }
}
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && menuOpen.value) {
    event.preventDefault()
    event.stopPropagation()
    menuOpen.value = false
  }
}
onMounted(async () => {
  await load()
  await nextTick()
  if (!disposed) sectionEl.value?.querySelector<HTMLInputElement>('input:not([disabled])')?.focus()
})
onBeforeUnmount(() => { disposed = true; pendingConfirmation?.cancel(); controller.abort(); resetTest(); form.apiKey = '' })
defineExpose({ canLeave })
</script>

<template>
  <section ref="sectionEl" class="settings-section" aria-labelledby="settings-ai-title" @keydown.capture="onKeydown">
    <header class="settings-section-header">
      <div>
        <h3 id="settings-ai-title">{{ t('settings.ai') }}</h3>
        <p>{{ t('settings.ai_subtitle') }}</p>
      </div>
      <NButton :disabled="blocked" @click="choose()">{{ t('settings.profile_add') }}</NButton>
    </header>
    <div class="settings-section-body">
      <div v-if="loadError" role="alert" class="settings-warning-card">
        {{ t('settings.profile_load_error') }}
        <NButton @click="load">{{ t('settings.profile_retry') }}</NButton>
      </div>
      <div class="settings-card settings-ai-profiles" :aria-label="t('settings.profile_list')">
        <p v-if="!loading && !profiles.length">{{ t('settings.profile_empty') }}</p>
        <NButton v-for="profile in profiles" :key="profile.id" class="settings-ai-profile"
          :class="{ 'is-selected': selectedId === profile.id }" :aria-pressed="selectedId === profile.id"
          :disabled="blocked" @click="choose(profile)">
          <span class="settings-ai-profile-copy">
            <strong>{{ profile.name }}</strong>
            <small>{{ profile.provider === 'openai' ? 'OpenAI' : 'Anthropic' }} · {{ profile.model || '—' }}</small>
          </span>
          <span v-if="activeId === profile.id" class="settings-ai-profile-default">{{ t('settings.profile_default') }}</span>
        </NButton>
      </div>
      <div v-if="selected?.credentialError" role="alert" class="settings-warning-card">
        {{ t('settings.profile_key_error', { code: selected.credentialError }) }}
        <NButton v-if="migrationError" :disabled="blocked" @click="retryMigration">{{ t('settings.profile_retry') }}</NButton>
      </div>
      <div class="settings-card" aria-labelledby="settings-ai-configuration-title">
        <h4 id="settings-ai-configuration-title" class="settings-card-title">{{ t('settings.configuration') }}</h4>
        <div class="settings-field-grid">
          <label class="settings-field">
            <span class="settings-field-label">{{ t('settings.profile_name') }}</span>
            <NInput v-model:value="form.name" :maxlength="100" :disabled="blocked || loadError" />
          </label>
          <label class="settings-field">
            <span class="settings-field-label">{{ t('settings.provider') }}</span>
            <NSelect data-testid="settings-provider" :aria-label="t('settings.provider')" v-model:value="form.provider"
              :options="providerOptions" to=".settings-backdrop" v-model:show="menuOpen" :disabled="blocked || loadError" />
          </label>
          <label class="settings-field">
            <span class="settings-field-label">{{ t('settings.api_key') }}</span>
            <span class="settings-input-wrap" :class="{ 'is-saved': selected?.configured && !form.apiKey }">
              <NInput v-model:value="form.apiKey" type="password" :disabled="blocked || loadError"
                :input-props="{ autocomplete: 'off' }" :placeholder="selected?.maskedKey || (form.provider === 'openai' ? 'sk-...' : 'sk-ant-...')" />
              <span v-if="selected?.configured && !form.apiKey" class="settings-key-status" role="status">✓ {{ t('settings.key_saved') }}</span>
            </span>
          </label>
          <label class="settings-field">
            <span class="settings-field-label">{{ t('settings.base_url') }}</span>
            <NInput v-model:value="form.baseURL" :disabled="blocked || loadError" :input-props="{ type: 'url' }"
              :placeholder="form.provider === 'openai' ? 'https://api.openai.com/v1' : t('settings.optional')" />
          </label>
          <label class="settings-field">
            <span class="settings-field-label">{{ t('settings.model') }}</span>
            <NInput v-model:value="form.model" :disabled="blocked || loadError" :placeholder="form.provider === 'openai' ? 'gpt-4o' : 'claude-sonnet-4-6'" />
          </label>
        </div>
        <div class="settings-section-actions settings-ai-profile-actions">
          <NButton v-if="selected?.configured" :disabled="blocked" @click="clearKey">{{ t('settings.clear_key') }}</NButton>
          <NButton v-if="selected" :disabled="blocked || dirty || !selected.configured || !!selected.credentialError || activeId === selectedId" @click="activate">{{ t('settings.profile_activate') }}</NButton>
          <NButton v-if="selected" type="error" ghost :disabled="blocked" @click="remove">{{ t('settings.profile_delete') }}</NButton>
          <NButton type="primary" :loading="saving" :disabled="blocked || loadError || !form.name.trim()" @click="save">{{ t(saving ? 'settings.saving' : 'settings.save') }}</NButton>
        </div>
      </div>
      <div class="settings-card settings-connection-card">
        <div class="settings-connection-header">
          <h4 class="settings-card-title">{{ t('settings.connection_status') }}</h4>
          <NButton :disabled="blocked || loadError || connectionState === 'checking'" @click="testConnection">{{ t(connectionState === 'checking' ? 'settings.connection_checking' : connectionState === 'failed' ? 'settings.retest_connection' : 'settings.test_connection') }}</NButton>
        </div>
        <div class="settings-connection-status" :class="`is-${connectionState}`" role="status" aria-live="polite">
          <span class="settings-connection-dot" aria-hidden="true" />
          <div class="settings-connection-copy">
            <strong>{{ t(connectionState === 'connected' ? 'settings.connection_connected' : connectionState === 'checking' ? 'settings.connection_checking' : connectionState === 'failed' ? 'settings.connection_failed' : 'settings.connection_untested') }}</strong>
            <p v-if="connectionResult">{{ form.name }} · {{ connectionResult.model }} · {{ connectionResult.latencyMs }} ms</p>
            <p v-else-if="connectionState === 'failed'">{{ connectionError }}</p>
            <p v-else>{{ t('settings.connection_untested_detail') }}</p>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
