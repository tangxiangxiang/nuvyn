<script setup lang="ts">
import { ref } from 'vue'
import { NAlert, NButton, NCard, NEmpty, NList, NListItem } from 'naive-ui'
import type { LedgerAccountDto } from '../../../shared/ledgerProtocol'
import { ledgerErrorMessage } from '../../features/ledger/ledgerErrors'
import { useLedgerStore } from '../../features/ledger/ledgerStore'

const store = useLedgerStore()
const emit = defineEmits<{ create: [] }>()
const restoringId = ref<string | null>(null)
const error = ref('')

async function restore(account: LedgerAccountDto): Promise<void> {
  if (restoringId.value) return
  restoringId.value = account.id
  error.value = ''
  try {
    await store.restoreAccount(account.id, account.version)
  } catch (cause) {
    error.value = ledgerErrorMessage(cause, '账户没有恢复，请刷新后重试。')
  } finally {
    restoringId.value = null
  }
}
</script>

<template>
  <NCard class="ledger-empty-state" data-testid="ledger-no-active-account" :bordered="false" size="small" aria-labelledby="ledger-no-active-account-title">
    <p class="ledger-eyebrow">需要一个可用账户</p>
    <NEmpty :show-icon="false" description="当前没有可用于记账的账户">
      <template #extra>
        <p id="ledger-no-active-account-title">你可以恢复一个已归档账户，或创建一个新账户。账户恢复后，原有历史记录仍会保留。</p>
      </template>
    </NEmpty>
    <NAlert v-if="error" class="ledger-form-error" type="error" :show-icon="false" role="alert">{{ error }}</NAlert>
    <NList v-if="store.archivedAccounts.value.length" class="ledger-archived-list" aria-label="已归档账户" :show-divider="false">
      <NListItem v-for="account in store.archivedAccounts.value" :key="account.id" class="ledger-archived-row">
        <div>
          <strong>{{ account.name }}</strong>
          <span>已归档 · {{ account.currency }}</span>
        </div>
        <template #suffix>
          <NButton class="ledger-secondary-button" attr-type="button" size="small" :bordered="false" :disabled="Boolean(restoringId)" @click="restore(account)">
            {{ restoringId === account.id ? '正在恢复…' : '恢复账户' }}
          </NButton>
        </template>
      </NListItem>
    </NList>
    <NButton class="ledger-primary-button" attr-type="button" type="primary" size="small" :bordered="false" :disabled="Boolean(restoringId)" @click="emit('create')">创建新账户</NButton>
  </NCard>
</template>

<style scoped>
.ledger-empty-state { width: min(100%, 620px); margin: 0 auto; text-align: left; }
.ledger-empty-state :deep(.n-card__content) { display: grid; gap: 14px; padding: 46px 28px; }
.ledger-eyebrow { margin: 0; color: var(--accent); font-size: .75rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
.ledger-empty-state :deep(.n-empty) { padding: 0; align-items: flex-start; }
.ledger-empty-state :deep(.n-empty__description) { color: var(--text-h); font-size: 1.35rem; font-weight: 650; line-height: 1.3; text-align: left; }
.ledger-empty-state :deep(.n-empty__extra) { margin-top: 7px; color: var(--text-muted); font-size: .9rem; line-height: 1.5; text-align: left; }
.ledger-empty-state :deep(.n-empty__extra p) { margin: 0; }
.ledger-form-error { margin: 0; color: #b42318; font-size: .82rem; }
.ledger-form-error :deep(.n-alert-body) { color: #b42318; }
.ledger-archived-list { display: grid; gap: 9px; }
.ledger-archived-list :deep(.n-list-item) { padding: 0; }
.ledger-archived-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg-soft); }
.ledger-archived-row > div { display: grid; gap: 2px; }
.ledger-archived-row strong { color: var(--text-h); font-size: .88rem; }
.ledger-archived-row span { color: var(--text-muted); font-size: .76rem; }
.ledger-primary-button,
.ledger-secondary-button { min-height: 32px; padding: 6px 12px; border-radius: 7px; font: inherit; font-size: .78rem; font-weight: 650; cursor: pointer; }
.ledger-primary-button { border: 1px solid var(--accent); background: var(--accent); color: #fff; }
.ledger-primary-button:hover:not(:disabled) { background: var(--accent-hover); }
.ledger-secondary-button { border: 1px solid var(--border); background: var(--bg); color: var(--text-h); }
.ledger-secondary-button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.ledger-primary-button:disabled,
.ledger-secondary-button:disabled { cursor: wait; opacity: .65; }
@media (max-width: 560px) {
  .ledger-empty-state :deep(.n-card__content) { padding: 32px 16px 48px; }
  .ledger-archived-row { align-items: stretch; flex-direction: column; }
}
</style>
