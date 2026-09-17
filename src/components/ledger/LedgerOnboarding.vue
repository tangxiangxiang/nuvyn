<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NStep, NSteps } from 'naive-ui'
import LedgerFirstAccountForm from './LedgerFirstAccountForm.vue'
import LedgerInitializationForm from './LedgerInitializationForm.vue'
import LedgerPendingCreateRecovery from './LedgerPendingCreateRecovery.vue'
import { ledgerErrorMessage } from '../../features/ledger/ledgerErrors'
import { useLedgerStore } from '../../features/ledger/ledgerStore'

const props = defineProps<{ initialStep: 'settings' | 'account' }>()
const store = useLedgerStore()
const step = ref(props.initialStep)
const recoveryError = ref('')
const currentStep = computed(() => step.value === 'settings' ? 1 : 2)

watch(() => props.initialStep, (next) => { step.value = next })

const pendingOnboardingIntent = computed(() => {
  const pending = store.pendingCreate.value
  return store.mutationState.value === 'UNCERTAIN'
    && pending && (pending.operation === 'settings' || pending.operation === 'account') ? pending : null
})
const recoveryBusy = computed(() => store.mutationState.value === 'SUBMITTING')

function showSettings(): void {
  if (store.settings.value?.hasCreatedAccount) return
  recoveryError.value = ''
  step.value = 'settings'
}

function settingsSaved(): void {
  recoveryError.value = ''
  step.value = 'account'
}

async function retryRecovery(): Promise<void> {
  recoveryError.value = ''
  try {
    await store.retryPendingCreate()
    if (store.pendingCreate.value === null && store.settings.value && !store.settings.value.hasCreatedAccount) {
      step.value = 'account'
    }
  } catch (error) {
    recoveryError.value = ledgerErrorMessage(error, '上一次操作仍未确认，请稍后再试。')
  }
}
</script>

<template>
  <section
    class="ledger-onboarding"
    data-testid="ledger-onboarding"
    aria-labelledby="ledger-onboarding-title"
  >
    <div class="ledger-onboarding-heading">
      <div>
        <p class="ledger-eyebrow">Ledger 首次使用</p>
        <h1 id="ledger-onboarding-title">把 Ledger 设置成你的账本</h1>
      </div>
    </div>

    <NSteps
      class="ledger-onboarding-steps"
      :current="currentStep"
      size="small"
      aria-label="Ledger 设置步骤"
    >
      <NStep title="基础设置" />
      <NStep title="添加账户" />
    </NSteps>

    <div class="ledger-onboarding-stage">
      <LedgerPendingCreateRecovery
        v-if="pendingOnboardingIntent"
        :intent="pendingOnboardingIntent"
        :busy="recoveryBusy"
        :error="recoveryError"
        @retry="retryRecovery"
      />
      <LedgerInitializationForm v-else-if="step === 'settings'" @saved="settingsSaved" />
      <LedgerFirstAccountForm v-else @edit-settings="showSettings" />
    </div>
  </section>
</template>

<style scoped>
.ledger-onboarding { --ledger-content-width: 620px; display: grid; align-content: center; justify-items: center; gap: 24px; width: min(100%, 980px); min-height: calc(100vh - 52px); margin: 0 auto; padding: 46px 28px 64px; box-sizing: border-box; }
.ledger-onboarding-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 28px; width: min(100%, var(--ledger-content-width)); text-align: left; }
.ledger-eyebrow { margin: 0 0 6px; color: var(--accent); font-size: .75rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
.ledger-onboarding-heading h1 { margin: 0; color: var(--text-h); font-size: clamp(1.7rem, 3vw, 2.2rem); line-height: 1.2; }
.ledger-onboarding-steps { width: min(100%, var(--ledger-content-width)); margin: -8px 0 0; }
.ledger-onboarding-stage { display: flex; align-items: flex-start; width: min(100%, var(--ledger-content-width)); height: 666px; }
.ledger-onboarding-stage :deep(.ledger-onboarding-card) { width: 100%; }
@media (max-width: 680px) {
  .ledger-onboarding { padding: 30px 16px 48px; }
  .ledger-onboarding-heading { align-items: flex-start; flex-direction: column; gap: 16px; }
}
@media (max-width: 620px) {
  .ledger-onboarding-stage { height: auto; }
}
</style>
