<script setup lang="ts">
import { computed, ref } from 'vue'
import { useToast } from '../../composables/useToast'
import { ledgerErrorMessage } from '../../features/ledger/ledgerErrors'
import { useLedgerStore } from '../../features/ledger/ledgerStore'
import LedgerPendingCreateRecovery from './LedgerPendingCreateRecovery.vue'

const store = useLedgerStore()
const toast = useToast()
const emit = defineEmits<{ resolved: [operation: 'settings' | 'account' | 'category' | 'transaction'] }>()
const retryError = ref('')
const busy = computed(() => store.mutationState.value === 'SUBMITTING')
const pending = computed(() => store.pendingCreate.value)
const blocked = computed(() => store.recoveryState.value === 'BLOCKED')

async function retry(): Promise<void> {
  if (!pending.value || busy.value) return
  const operation = pending.value.operation
  retryError.value = ''
  try {
    await store.retryPendingCreate()
    toast.success(operation === 'account'
      ? '账户已确认保存'
      : operation === 'category'
        ? '分类已确认保存'
        : operation === 'settings'
          ? 'Ledger 设置已确认保存'
          : '交易已确认保存')
    emit('resolved', operation)
    store.dismissRecoveryGate()
  } catch (cause) {
    retryError.value = ledgerErrorMessage(cause, '上一次操作仍未确认，请稍后再试。')
  }
}
</script>

<template>
  <section class="ledger-recovery-gate" data-testid="ledger-recovery-gate">
    <LedgerPendingCreateRecovery
      v-if="pending"
      :intent="pending"
      :busy="busy"
      :error="retryError"
      @retry="retry"
    />
    <section v-else-if="blocked" class="ledger-recovery-blocked" data-testid="ledger-recovery-blocked" role="alert" aria-labelledby="ledger-recovery-blocked-title">
      <p class="ledger-eyebrow">需要处理</p>
      <h1 id="ledger-recovery-blocked-title">无法验证未完成的 Ledger 操作</h1>
      <p>为避免重复记账，Ledger 已暂停新的提交。当前恢复记录无法安全验证；请保留此标签页并联系管理员处理。</p>
      <p v-if="store.recoveryBlockedReason.value" class="ledger-recovery-reason">{{ store.recoveryBlockedReason.value }}</p>
    </section>
  </section>
</template>

<style scoped>
.ledger-recovery-gate { display: grid; min-height: 520px; place-items: center; align-content: center; padding: 42px 24px 64px; box-sizing: border-box; }
.ledger-recovery-blocked { display: grid; gap: 12px; width: min(100%, 620px); padding: 28px; box-sizing: border-box; border: 1px solid color-mix(in srgb, #b42318 35%, var(--border)); border-radius: 14px; background: color-mix(in srgb, #b42318 6%, var(--bg)); }
.ledger-recovery-blocked h1,
.ledger-recovery-blocked p { margin: 0; }
.ledger-recovery-blocked h1 { color: var(--text-h); font-size: 1.35rem; line-height: 1.3; }
.ledger-recovery-blocked p:not(.ledger-eyebrow):not(.ledger-recovery-reason) { color: var(--text); line-height: 1.55; }
.ledger-eyebrow { color: #b42318; font-size: .75rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
.ledger-recovery-reason { color: var(--text-muted); font-size: .78rem; }
@media (max-width: 560px) {
  .ledger-recovery-gate { padding: 30px 16px 48px; }
  .ledger-recovery-blocked { padding: 22px 18px; }
}
</style>
