<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NIcon, NInput, NSelect, type SelectOption } from 'naive-ui'
import { AlertTriangle } from '@vicons/tabler'
import { useI18n } from '../../composables/useI18n'
import type {
  AiCredentialStatus,
  AiConnectionState,
  AiConnectionTestResult,
  AiKeyErrorCode,
  AiProvider,
  AiSettings,
} from '../../lib/ai-api'

const props = defineProps<{
  settings: AiSettings | null
  apiKey: string
  baseURL: string
  model: string
  loading: boolean
  saving: boolean
  connectionState: AiConnectionState
  connectionResult: AiConnectionTestResult | null
  connectionError: string
  recoveryCode?: AiKeyErrorCode
  credentialStatus?: AiCredentialStatus | null
}>()

const emit = defineEmits<{
  'update:apiKey': [value: string]
  'update:baseURL': [value: string]
  'update:model': [value: string]
  save: []
  'clear-key': []
  'forget-credential': [provider: AiProvider]
  'switch-provider': [provider: AiProvider]
  'test-connection': []
}>()

const { t } = useI18n()
const providerOptions: SelectOption[] = [
  { label: 'Anthropic', value: 'anthropic' },
  { label: 'OpenAI', value: 'openai' },
]

/* Per-provider placeholder defaults. The active provider's saved
   value wins when present (rendered in the parent as maskedKey /
   baseURL / model); these only fill in for an unconfigured provider. */
const activeProvider = computed<AiProvider>(() =>
  props.settings?.provider ?? props.credentialStatus?.provider ?? 'anthropic',
)
const MODEL_PLACEHOLDER = computed(() =>
  activeProvider.value === 'openai' ? 'gpt-4o' : 'claude-sonnet-4-6',
)
const API_KEY_PLACEHOLDER = computed(() =>
  activeProvider.value === 'openai' ? 'sk-...' : 'sk-ant-...',
)
const hasSavedKey = computed(() => Boolean(
  props.settings?.configured
  && props.settings.maskedKey
  && !props.apiKey.trim(),
))
const recoveryProviders = computed<AiProvider[]>(() => {
  if (props.credentialStatus) {
    return (['anthropic', 'openai'] as AiProvider[])
      .filter((provider) => props.credentialStatus?.providers[provider].stored)
  }
  return [props.settings?.provider ?? 'anthropic']
})

function onInput(field: 'apiKey' | 'baseURL' | 'model', value: string) {
  if (field === 'apiKey') emit('update:apiKey', value)
  else if (field === 'baseURL') emit('update:baseURL', value)
  else emit('update:model', value)
}

function onProviderChange(value: string | number | null) {
  if (value === 'anthropic' || value === 'openai') {
    emit('switch-provider', value)
  }
}
</script>

<template>
  <section class="settings-section" aria-labelledby="settings-ai-title">
    <header class="settings-section-header">
      <div>
        <h3 id="settings-ai-title">{{ t('settings.ai') }}</h3>
        <p>{{ t('settings.ai_subtitle') }}</p>
      </div>
      <div class="settings-section-actions">
        <NButton
          v-if="settings || recoveryCode === 'master-key-required'"
          attr-type="button"
          size="medium"
          type="error"
          ghost
          :bordered="false"
          class="btn settings-clear-key-btn"
          :disabled="saving"
          @click="emit('clear-key')"
        >{{ t('settings.clear_key') }}</NButton>
        <NButton
          attr-type="button"
          size="medium"
          type="primary"
          :bordered="false"
          class="btn btn-primary"
          :disabled="loading || saving"
          @click="emit('save')"
        >{{ t(saving ? 'settings.saving' : 'settings.save') }}</NButton>
      </div>
    </header>
    <div class="settings-section-body">
      <div v-if="recoveryCode === 'master-key-required'" class="settings-ai-recovery settings-warning-card" role="alert">
        <div class="settings-warning-heading">
          <NIcon class="settings-warning-icon" aria-hidden="true"><AlertTriangle /></NIcon>
          <strong>{{ t('settings.master_key_missing') }}</strong>
        </div>
        <div class="settings-warning-content">
          <p>{{ t('settings.master_key_missing_detail') }}</p>
          <p>{{ t('settings.master_key_forget_warning') }}</p>
        </div>
        <div class="settings-warning-actions">
          <NButton
            v-for="provider in recoveryProviders"
            :key="provider"
            attr-type="button"
            size="medium"
            type="error"
            ghost
            :bordered="false"
            class="btn settings-danger-secondary"
            :disabled="saving"
            @click="emit('forget-credential', provider)"
          >{{ t('settings.forget_provider_key', { provider }) }}</NButton>
        </div>
      </div>
      <div class="settings-card" aria-labelledby="settings-ai-configuration-title">
        <h4 id="settings-ai-configuration-title" class="settings-card-title">
          {{ t('settings.configuration') }}
        </h4>
        <div class="settings-field-grid">
          <!-- Provider remains a real server-backed switch. The response
               refreshes the other fields with that provider's saved view. -->
          <label class="settings-field">
            <span class="settings-field-label">{{ t('settings.provider') }}</span>
            <NSelect
              data-testid="settings-provider"
              :aria-label="t('settings.provider')"
              :value="activeProvider"
              :options="providerOptions"
              size="medium"
              :disabled="loading || saving"
              @update:value="onProviderChange"
            />
          </label>
          <label class="settings-field">
            <span class="settings-field-label">{{ t('settings.api_key') }}</span>
            <span class="settings-input-wrap" :class="{ 'is-saved': hasSavedKey }">
              <NInput
                :value="apiKey"
                type="password"
                size="medium"
                :input-props="{
                  autocomplete: 'off',
                  style: hasSavedKey ? { paddingRight: '94px' } : undefined,
                }"
                :placeholder="settings?.maskedKey || API_KEY_PLACEHOLDER"
                :disabled="loading || saving"
                @update:value="onInput('apiKey', $event)"
              />
              <span v-if="hasSavedKey" class="settings-key-status" role="status">
                <span class="settings-key-status-icon" aria-hidden="true">✓</span>
                {{ t('settings.key_saved') }}
              </span>
            </span>
          </label>
          <label class="settings-field">
            <span class="settings-field-label">{{ t('settings.base_url') }}</span>
            <NInput
              :value="baseURL"
              type="text"
              size="medium"
              :input-props="{ type: 'url' }"
              :placeholder="activeProvider === 'openai' ? 'https://api.openai.com/v1' : t('settings.optional')"
              :disabled="loading || saving"
              @update:value="onInput('baseURL', $event)"
            />
          </label>
          <label class="settings-field">
            <span class="settings-field-label">{{ t('settings.model') }}</span>
            <NInput
              :value="model"
              type="text"
              size="medium"
              :placeholder="MODEL_PLACEHOLDER"
              :disabled="loading || saving"
              @update:value="onInput('model', $event)"
            />
          </label>
        </div>
      </div>
      <div class="settings-card settings-connection-card" aria-labelledby="settings-ai-connection-title">
        <div class="settings-connection-header">
          <h4 id="settings-ai-connection-title" class="settings-card-title">
            {{ t('settings.connection_status') }}
          </h4>
          <NButton
            attr-type="button"
            size="medium"
            :bordered="false"
            class="btn settings-connection-btn"
            :disabled="loading || saving || connectionState === 'checking'"
            @click="emit('test-connection')"
          >{{ t(connectionState === 'checking' ? 'settings.connection_checking' : connectionState === 'failed' ? 'settings.retest_connection' : 'settings.test_connection') }}</NButton>
        </div>
        <div
          class="settings-connection-status"
          :class="`is-${connectionState}`"
          role="status"
          aria-live="polite"
        >
          <span class="settings-connection-dot" aria-hidden="true" />
          <div class="settings-connection-copy">
            <strong>
              {{ t(
                connectionState === 'connected'
                  ? 'settings.connection_connected'
                  : connectionState === 'checking'
                    ? 'settings.connection_checking'
                    : connectionState === 'failed'
                      ? 'settings.connection_failed'
                      : 'settings.connection_untested',
              ) }}
            </strong>
            <p v-if="connectionState === 'connected' && connectionResult">
              {{ connectionResult.provider === 'openai' ? 'OpenAI' : 'Anthropic' }} · {{ connectionResult.model }} · {{ connectionResult.latencyMs }} ms
            </p>
            <p v-else-if="connectionState === 'checking'">
              {{ activeProvider === 'openai' ? 'OpenAI' : 'Anthropic' }} · {{ model }}
            </p>
            <p v-else-if="connectionState === 'failed'">{{ connectionError }}</p>
            <p v-else>{{ t('settings.connection_untested_detail') }}</p>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
