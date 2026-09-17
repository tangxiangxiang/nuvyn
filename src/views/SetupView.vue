<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { NButton, NInput, type InputInst } from 'naive-ui'
import { useRoute, useRouter } from 'vue-router'
import { AuthApiError } from '../lib/auth-api'
import { safeInternalRedirect } from '../lib/auth-redirect'
import { useAuth } from '../composables/useAuth'
import { useI18n } from '../composables/useI18n'

const route = useRoute()
const router = useRouter()
const auth = useAuth()
const { t } = useI18n()

const bootstrapToken = ref('')
const username = ref('')
const password = ref('')
const confirmPassword = ref('')
const error = ref('')
const errorCode = ref<string | undefined>()
const confirmError = ref('')
const tokenInput = ref<InputInst | null>(null)
const confirmInput = ref<InputInst | null>(null)

function errorText(value: unknown): string {
  errorCode.value = value instanceof AuthApiError ? value.code : undefined
  if (!(value instanceof AuthApiError)) return t('auth.unavailable')
  if (value.code === 'bootstrap-invalid') return t('auth.bootstrap_invalid')
  if (value.code === 'already-initialized') return t('auth.already_initialized')
  if (value.code === 'auth-rate-limited') {
    return value.retryAfterSeconds
      ? t('auth.rate_limited', { seconds: value.retryAfterSeconds })
      : t('auth.rate_limited_generic')
  }
  if (value.code === 'validation-error') return t('auth.validation_error')
  return t('auth.unavailable')
}

async function submit(): Promise<void> {
  if (auth.submitting.value) return
  error.value = ''
  errorCode.value = undefined
  confirmError.value = ''
  if (password.value !== confirmPassword.value) {
    confirmError.value = t('auth.password_mismatch')
    await nextTick()
    confirmInput.value?.focus()
    return
  }
  try {
    await auth.setup({
      bootstrapToken: bootstrapToken.value,
      username: username.value,
      password: password.value,
    })
    bootstrapToken.value = ''
    password.value = ''
    confirmPassword.value = ''
    await router.replace(router.resolve(safeInternalRedirect(route.query.redirect, '/vault')))
  } catch (cause) {
    if (cause instanceof AuthApiError && cause.code === 'already-initialized') {
      const refreshedState = await auth.refreshStatus()
      if (refreshedState === 'authenticated') {
        await router.replace(router.resolve(safeInternalRedirect(route.query.redirect, '/vault')))
        return
      }
      if (refreshedState === 'unauthenticated') {
        await router.replace({ name: 'login', query: route.query.redirect ? { redirect: safeInternalRedirect(route.query.redirect) } : undefined })
        return
      }
    }
    error.value = errorText(cause)
    await nextTick()
    tokenInput.value?.focus()
  }
}

onMounted(() => tokenInput.value?.focus())
</script>

<template>
  <section class="auth-page" aria-labelledby="setup-title">
    <div class="auth-page-brand" aria-label="Nuvyn">
      <img
        class="auth-page-brand-logo"
        :src="'/logo-48.png'"
        alt=""
        aria-hidden="true"
        data-testid="auth-logo"
      />
      <span class="auth-page-brand-wordmark">Nuvyn</span>
    </div>
    <div class="auth-card">
      <h1 id="setup-title">{{ t('auth.setup_title') }}</h1>
      <p class="auth-subtitle">{{ t('auth.setup_description') }}</p>

      <form class="auth-form" :aria-busy="auth.submitting.value" @submit.prevent="submit">
        <div class="auth-field">
          <label for="setup-token">{{ t('auth.bootstrap_token') }}</label>
          <NInput
            ref="tokenInput"
            v-model:value="bootstrapToken"
            class="auth-control"
            type="password"
            size="medium"
            :input-props="{
              id: 'setup-token',
              name: 'bootstrapToken',
              autocomplete: 'off',
              required: true,
              'aria-invalid': errorCode === 'bootstrap-invalid' ? 'true' : undefined,
              'aria-describedby': errorCode === 'bootstrap-invalid' ? 'setup-token-help setup-error' : 'setup-token-help',
            }"
            :disabled="auth.submitting.value"
            :status="errorCode === 'bootstrap-invalid' ? 'error' : undefined"
          />
          <p id="setup-token-help" class="auth-help">{{ t('auth.bootstrap_token_help') }}</p>
        </div>
        <div class="auth-field">
          <label for="setup-username">{{ t('auth.username') }}</label>
          <NInput
            v-model:value="username"
            class="auth-control"
            type="text"
            size="medium"
            :input-props="{ id: 'setup-username', name: 'username', autocomplete: 'username', required: true }"
            :disabled="auth.submitting.value"
          />
        </div>
        <div class="auth-field">
          <label for="setup-password">{{ t('auth.password') }}</label>
          <NInput
            v-model:value="password"
            class="auth-control"
            type="password"
            size="medium"
            :input-props="{ id: 'setup-password', name: 'password', autocomplete: 'new-password', required: true }"
            :disabled="auth.submitting.value"
          />
        </div>
        <div class="auth-field">
          <label for="setup-confirm-password">{{ t('auth.confirm_password') }}</label>
          <NInput
            ref="confirmInput"
            v-model:value="confirmPassword"
            class="auth-control"
            type="password"
            size="medium"
            :input-props="{
              id: 'setup-confirm-password',
              name: 'confirmPassword',
              autocomplete: 'new-password',
              required: true,
              'aria-invalid': confirmError ? 'true' : undefined,
              'aria-describedby': confirmError ? 'setup-confirm-error' : undefined,
            }"
            :disabled="auth.submitting.value"
            :status="confirmError ? 'error' : undefined"
          />
        </div>
        <p v-if="confirmError" id="setup-confirm-error" class="auth-error" role="alert">{{ confirmError }}</p>
        <p v-if="error" id="setup-error" class="auth-error" role="alert">{{ error }}</p>
        <NButton class="auth-submit" attr-type="submit" type="primary" :disabled="auth.submitting.value">
          {{ auth.submitting.value ? t('auth.creating_owner') : t('auth.create_owner') }}
        </NButton>
      </form>
    </div>
  </section>
</template>
