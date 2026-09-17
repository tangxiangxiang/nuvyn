<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
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

const username = ref('')
const password = ref('')
const error = ref('')
const errorCode = ref<string | undefined>()
const usernameInput = ref<InputInst | null>(null)

const credentialError = computed(() => errorCode.value === 'invalid-credentials')

function errorText(value: unknown): string {
  errorCode.value = value instanceof AuthApiError ? value.code : undefined
  if (!(value instanceof AuthApiError)) return t('auth.unavailable')
  if (value.code === 'invalid-credentials') return t('auth.invalid_credentials')
  if (value.code === 'auth-rate-limited') {
    return value.retryAfterSeconds
      ? t('auth.rate_limited', { seconds: value.retryAfterSeconds })
      : t('auth.rate_limited_generic')
  }
  if (value.code === 'validation-error') return t('auth.validation_error')
  return t('auth.unavailable')
}

function redirectTarget(): string {
  return safeInternalRedirect(route.query.redirect, '/vault')
}

async function submit(): Promise<void> {
  if (auth.submitting.value) return
  error.value = ''
  errorCode.value = undefined
  try {
    await auth.login({ username: username.value, password: password.value })
    password.value = ''
    await router.replace(router.resolve(redirectTarget()))
  } catch (cause) {
    error.value = errorText(cause)
    await nextTick()
    usernameInput.value?.focus()
  }
}

onMounted(() => usernameInput.value?.focus())
</script>

<template>
  <section class="auth-page" aria-labelledby="login-title">
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
      <h1 id="login-title">{{ t('auth.welcome_back') }}</h1>
      <p class="auth-subtitle">{{ t('auth.sign_in_description') }}</p>

      <p v-if="route.query.reason === 'expired'" class="auth-notice" role="status">
        {{ t('auth.session_expired') }}
      </p>
      <form class="auth-form" autocomplete="off" :aria-busy="auth.submitting.value" @submit.prevent="submit">
        <div class="auth-field">
          <label for="login-username">{{ t('auth.username') }}</label>
          <NInput
            ref="usernameInput"
            v-model:value="username"
            class="auth-control"
            type="text"
            size="medium"
            :input-props="{
              id: 'login-username',
              name: 'username',
              autocomplete: 'off',
              required: true,
              'aria-invalid': credentialError ? 'true' : undefined,
              'aria-describedby': credentialError ? 'login-error' : undefined,
            }"
            :disabled="auth.submitting.value"
            :status="credentialError ? 'error' : undefined"
          />
        </div>
        <div class="auth-field">
          <label for="login-password">{{ t('auth.password') }}</label>
          <NInput
            v-model:value="password"
            class="auth-control"
            type="password"
            size="medium"
            :input-props="{
              id: 'login-password',
              name: 'password',
              autocomplete: 'new-password',
              required: true,
              'aria-invalid': credentialError ? 'true' : undefined,
              'aria-describedby': credentialError ? 'login-error' : undefined,
            }"
            :disabled="auth.submitting.value"
            :status="credentialError ? 'error' : undefined"
          />
        </div>
        <p v-if="error" id="login-error" class="auth-error" role="alert">{{ error }}</p>
        <NButton class="auth-submit" attr-type="submit" type="primary" :disabled="auth.submitting.value">
          {{ auth.submitting.value ? t('auth.signing_in') : t('auth.sign_in') }}
        </NButton>
      </form>
    </div>
  </section>
</template>
