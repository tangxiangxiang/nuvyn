<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  darkTheme,
  dateEnUS,
  dateZhCN,
  enUS,
  NConfigProvider,
  NDialogProvider,
  NMessageProvider,
  NNotificationProvider,
  zhCN,
} from 'naive-ui'
import ConfirmHost from '../../../components/ConfirmHost.vue'
import PromptHost from '../../../components/PromptHost.vue'
import ToastHost from '../../../components/ToastHost.vue'
import { useConfirm, type CancellableConfirm } from '../../../composables/useConfirm'
import { useI18n } from '../../../composables/useI18n'
import { usePrompt } from '../../../composables/usePrompt'
import { useTheme } from '../../../composables/useTheme'
import { useToast } from '../../../composables/useToast'
import { createNuvynNaiveThemeOverrides } from '../../naiveTheme'

const { theme, set: setTheme } = useTheme()
const { locale, setLocale } = useI18n()
const toast = useToast()
const { confirmCancellable } = useConfirm()
const { prompt } = usePrompt()

const naiveTheme = computed(() => theme.value === 'dark' ? darkTheme : null)
const naiveLocale = computed(() => locale.value === 'zh' ? zhCN : enUS)
const naiveDateLocale = computed(() => locale.value === 'zh' ? dateZhCN : dateEnUS)
const themeOverrides = computed(() => createNuvynNaiveThemeOverrides(theme.value))

const mode = ref<'normal' | 'vault' | 'ledger'>('normal')
const toastResult = ref('')
const confirmResult = ref('')
const promptResult = ref('')
let toastId: number | null = null
let pendingConfirm: CancellableConfirm | null = null

function openToast(): void {
  toastId = toast.success('Toast feedback', 0)
  toastResult.value = 'visible'
}

function dismissToast(): void {
  if (toastId !== null) toast.dismiss(toastId)
  toastId = null
  toastResult.value = 'dismissed'
}

function openConfirm(): void {
  const pending = confirmCancellable('Delete this test item?', 'This test-only action is destructive.', {
    destructive: true,
  })
  pendingConfirm = pending
  void pending.promise.then((value) => {
    if (pendingConfirm === pending) pendingConfirm = null
    confirmResult.value = value ? 'confirmed' : 'cancelled'
  })
}

function cancelConfirm(): void {
  pendingConfirm?.cancel()
}

function openPrompt(): void {
  void prompt({
    title: 'Rename test item',
    placeholder: 'name',
    initial: 'draft name',
    actionLabel: 'Transform',
    actionTitle: 'Transform name',
    transform: async (value) => value.toUpperCase(),
  }).then((value) => {
    promptResult.value = value ?? 'cancelled'
  })
}

function chooseMode(next: typeof mode.value): void {
  mode.value = next
}

watch(mode, (next, previous) => {
  if (previous) document.body.classList.remove(`${previous}-mode`)
  if (next !== 'normal') document.body.classList.add(`${next}-mode`)
})

onBeforeUnmount(() => {
  document.body.classList.remove('vault-mode', 'ledger-mode')
})

setTheme('light')
setLocale('zh')
</script>

<template>
  <NConfigProvider
    :theme="naiveTheme"
    :theme-overrides="themeOverrides"
    :locale="naiveLocale"
    :date-locale="naiveDateLocale"
    :preflight-style-disabled="true"
  >
    <NDialogProvider>
      <NMessageProvider>
        <NNotificationProvider>
          <main :data-mode="mode" data-testid="feedback-overlay-harness">
            <button type="button" data-testid="open-toast" @click="openToast">Open toast</button>
            <button type="button" data-testid="dismiss-toast" @click="dismissToast">Dismiss toast</button>
            <button type="button" data-testid="open-confirm" @click="openConfirm">Open confirm</button>
            <button type="button" data-testid="cancel-confirm" @click="cancelConfirm">Cancel confirm externally</button>
            <button type="button" data-testid="open-prompt" @click="openPrompt">Open prompt</button>
            <button type="button" data-testid="theme-light" @click="setTheme('light')">Light</button>
            <button type="button" data-testid="theme-dark" @click="setTheme('dark')">Dark</button>
            <button type="button" data-testid="locale-zh" @click="setLocale('zh')">中文</button>
            <button type="button" data-testid="locale-en" @click="setLocale('en')">English</button>
            <button type="button" data-testid="mode-normal" @click="chooseMode('normal')">Normal</button>
            <button type="button" data-testid="mode-vault" @click="chooseMode('vault')">Vault</button>
            <button type="button" data-testid="mode-ledger" @click="chooseMode('ledger')">Ledger</button>
            <output data-testid="theme-value">{{ theme }}</output>
            <output data-testid="locale-value">{{ locale }}</output>
            <output data-testid="mode-value">{{ mode }}</output>
            <output data-testid="toast-result">{{ toastResult }}</output>
            <output data-testid="confirm-result">{{ confirmResult }}</output>
            <output data-testid="prompt-result">{{ promptResult }}</output>
          </main>
          <ToastHost />
          <ConfirmHost />
          <PromptHost />
        </NNotificationProvider>
      </NMessageProvider>
    </NDialogProvider>
  </NConfigProvider>
</template>
