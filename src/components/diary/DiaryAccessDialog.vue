<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NInput, type InputInst } from 'naive-ui'
import { useFocusTrap } from '../../composables/useFocusTrap'
import { useI18n } from '../../composables/useI18n'

const props = defineProps<{
  open: boolean
  mode: 'setup' | 'unlock'
  busy?: boolean
  error?: string
}>()

const emit = defineEmits<{
  submit: [payload: { password: string; confirmPassword: string }]
  cancel: []
}>()

const { t } = useI18n()
const trap = useFocusTrap()
const modalRef = ref<HTMLElement | null>(null)
const passwordRef = ref<InputInst | null>(null)
const password = ref('')
const confirmPassword = ref('')

function clearFields(): void {
  password.value = ''
  confirmPassword.value = ''
}

function close(): void {
  if (props.busy) return
  clearFields()
  emit('cancel')
}

function submit(): void {
  if (props.busy || !password.value) return
  emit('submit', { password: password.value, confirmPassword: confirmPassword.value })
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
  } else if (event.key === 'Tab') {
    trap.onTab(() => modalRef.value, event)
  }
}

watch(() => props.open, async (open) => {
  if (open) {
    trap.activate()
    await nextTick()
    passwordRef.value?.focus()
  } else {
    clearFields()
    void trap.deactivate()
  }
}, { immediate: true })

onBeforeUnmount(() => { void trap.deactivate() })

onMounted(() => {
  if (props.open) void nextTick(() => passwordRef.value?.focus())
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="diary-access-backdrop"
      role="presentation"
      @click.self="close"
      @keydown="onKeydown"
    >
      <form
        ref="modalRef"
        class="diary-access-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="diary-access-title"
        :aria-busy="busy || undefined"
        @submit.prevent="submit"
      >
        <h2 id="diary-access-title">{{ t(mode === 'setup' ? 'diary_access.setup_title' : 'diary_access.unlock_title') }}</h2>
        <p class="diary-access-description">{{ t(mode === 'setup' ? 'diary_access.setup_description' : 'diary_access.unlock_description') }}</p>
        <label for="diary-access-password">{{ t('diary_access.password') }}</label>
        <NInput
          ref="passwordRef"
          v-model:value="password"
          type="password"
          size="medium"
          :minlength="12"
          :maxlength="256"
          class="diary-access-control"
          :input-props="{
            id: 'diary-access-password',
            autocomplete: 'new-password',
            minlength: 12,
            maxlength: 256,
            required: true,
          }"
          :disabled="busy"
        />
        <template v-if="mode === 'setup'">
          <label for="diary-access-confirm">{{ t('diary_access.confirm_password') }}</label>
          <NInput
            v-model:value="confirmPassword"
            type="password"
            size="medium"
            :minlength="12"
            :maxlength="256"
            class="diary-access-control"
            :input-props="{
              id: 'diary-access-confirm',
              autocomplete: 'new-password',
              minlength: 12,
              maxlength: 256,
              required: true,
            }"
            :disabled="busy"
          />
        </template>
        <p v-if="error" class="diary-access-error" role="alert">{{ error }}</p>
        <div class="diary-access-actions">
          <NButton
            attr-type="button"
            size="medium"
            class="btn"
            :bordered="false"
            data-testid="diary-access-cancel"
            :disabled="busy"
            @click="close"
          >{{ t('common.cancel') }}</NButton>
          <NButton
            attr-type="submit"
            type="primary"
            size="medium"
            class="btn btn-primary"
            :bordered="false"
            :disabled="busy || !password"
          >
            {{ busy ? t('diary_access.working') : t(mode === 'setup' ? 'diary_access.setup' : 'diary_access.unlock') }}
          </NButton>
        </div>
      </form>
    </div>
  </Teleport>
</template>

<style scoped>
.diary-access-backdrop { position: fixed; inset: 0; z-index: 9400; display: grid; place-items: center; padding: 20px; background: rgb(0 0 0 / 0.42); }
.diary-access-dialog { box-sizing: border-box; width: min(420px, 100%); display: grid; gap: 10px; padding: 24px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); box-shadow: 0 16px 48px rgb(0 0 0 / 0.28); }
.diary-access-dialog h2 { margin: 0; color: var(--text-h); font-size: 1.15rem; }
.diary-access-description { margin: 0 0 4px; color: var(--text-muted); font-size: 0.9rem; }
.diary-access-control { width: 100%; }
.diary-access-control :deep(.n-input) { width: 100%; min-height: 40px; border-color: var(--border); border-radius: 5px; background: var(--bg-soft); }
.diary-access-control :deep(.n-input__input-el) { color: var(--text-h); }
.diary-access-error { margin: 2px 0 0; color: #b91c1c; }
.diary-access-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
@media (max-width: 600px) { .diary-access-backdrop { align-items: end; padding: 0; } .diary-access-dialog { width: 100%; border-radius: 8px 8px 0 0; } }
</style>
