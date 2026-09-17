<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { NAlert, NButton, NCard, NIcon, NModal, NStatistic } from 'naive-ui'
import { X } from '@vicons/tabler'
import type { LedgerTransactionDto } from '../../../shared/ledgerProtocol'
import { useConfirm } from '../../composables/useConfirm'
import { useToast } from '../../composables/useToast'
import { ledgerErrorMessage } from '../../features/ledger/ledgerErrors'
import { formatLedgerMoney } from '../../features/ledger/money'
import { formatLedgerDateTime } from '../../features/ledger/time'
import { useLedgerStore } from '../../features/ledger/ledgerStore'
import LedgerTransactionEditForm from './LedgerTransactionEditForm.vue'

const props = defineProps<{
  open: boolean
  transaction: LedgerTransactionDto | null
}>()
const emit = defineEmits<{
  close: []
  updated: [transaction: LedgerTransactionDto]
  deleted: [transaction: LedgerTransactionDto]
}>()

const store = useLedgerStore()
const toast = useToast()
const { confirm } = useConfirm()
const detailFocusTarget = ref<HTMLElement | null>(null)
const currentTransaction = ref<LedgerTransactionDto | null>(null)
const groupTransactions = ref<readonly LedgerTransactionDto[]>([])
let groupRequestSerial = 0
const editing = ref(false)
const editDirty = ref(false)
const actionError = ref('')
const restoringId = ref<string | null>(null)

const transaction = computed(() => currentTransaction.value ?? props.transaction)
const associatedAccounts = computed(() => {
  const value = transaction.value
  if (!value) return []
  const ids = value.type === 'transfer'
    ? [value.fromAccountId, value.toAccountId]
    : [value.accountId]
  return store.accounts.value.filter((account) => ids.includes(account.id))
})
const archivedAccounts = computed(() => associatedAccounts.value.filter((account) => account.archivedAt !== null))
const ordinaryTransaction = computed(() => transaction.value !== null && transaction.value.type !== 'adjustment')
const deleted = computed(() => transaction.value?.deletedAt !== null)
const groupedCompanion = computed(() => transaction.value?.type === 'expense' && transaction.value.groupId !== undefined)
const canEdit = computed(() => ordinaryTransaction.value && !deleted.value && !groupedCompanion.value)
const groupedExpense = computed(() => groupTransactions.value.find((item) => item.type === 'expense') ?? null)
const groupedTotalMinor = computed(() => {
  const value = transaction.value
  if (!value || value.type !== 'transfer' || !groupedExpense.value) return null
  return value.amountMinor + groupedExpense.value.amountMinor
})
const canDelete = computed(() => canEdit.value && archivedAccounts.value.length === 0)

function accountName(id: string): string {
  return store.accounts.value.find((account) => account.id === id)?.name ?? '未知账户'
}

function categoryName(id: string): string {
  return store.categories.value.find((category) => category.id === id)?.name ?? '未知分类'
}

function typeLabel(value: LedgerTransactionDto): string {
  if (value.type === 'income') return '收入'
  if (value.type === 'expense') return '支出'
  if (value.type === 'transfer') return value.transferKind === 'repayment' ? '还款' : value.transferKind === 'withdrawal' ? '提现' : '转账'
  return '余额调整'
}

function amountLabel(value: LedgerTransactionDto): string {
  const currency = store.settings.value?.baseCurrency ?? 'CNY'
  if (value.type === 'income') return `+${formatLedgerMoney(value.amountMinor, currency)}`
  if (value.type === 'expense') return `-${formatLedgerMoney(value.amountMinor, currency)}`
  if (value.type === 'transfer') {
    return formatLedgerMoney(groupedTotalMinor.value ?? value.amountMinor, currency)
  }
  return formatLedgerMoney(value.amountMinor, currency)
}

async function loadGroup(value: LedgerTransactionDto | null): Promise<void> {
  const serial = ++groupRequestSerial
  groupTransactions.value = []
  if (!value?.groupId) return
  try {
    const group = await store.getTransactionGroup(value.groupId)
    if (serial === groupRequestSerial) groupTransactions.value = group
  } catch {
    // The primary transaction remains fully usable if the optional companion
    // read fails; the next open will retry it.
  }
}

watch(() => props.transaction, (value) => {
  currentTransaction.value = value
  editing.value = false
  editDirty.value = false
  actionError.value = ''
  void loadGroup(value)
}, { immediate: true })

watch(() => props.open, async (open) => {
  if (open) {
    editing.value = false
    editDirty.value = false
    actionError.value = ''
    await loadGroup(transaction.value)
    await nextTick()
    detailFocusTarget.value?.focus()
  }
})

function focusInitialDetail(): void {
  void nextTick(() => detailFocusTarget.value?.focus())
}

async function confirmDiscardEdit(): Promise<boolean> {
  if (!editing.value || !editDirty.value) return true
  return confirm('放弃这笔尚未保存的修改？', '已填写的内容将不会保存。')
}

async function requestClose(): Promise<void> {
  if (restoringId.value) return
  if (!await confirmDiscardEdit()) return
  emit('close')
}

async function requestEditCancel(): Promise<void> {
  if (!await confirmDiscardEdit()) return
  editDirty.value = false
  editing.value = false
}

function handleVisibilityChange(value: boolean): void {
  if (!value && props.open) void requestClose()
}

async function restoreAccount(id: string): Promise<void> {
  const current = transaction.value
  const account = store.accounts.value.find((item) => item.id === id)
  if (!current || !account || restoringId.value) return
  restoringId.value = id
  actionError.value = ''
  try {
    await store.restoreAccount(id, account.version)
    const refreshed = groupedCompanion.value
      ? current
      : await store.getTransaction(current.id)
    currentTransaction.value = refreshed
    emit('updated', refreshed)
    toast.success('账户已恢复，交易信息已刷新')
  } catch (cause) {
    actionError.value = ledgerErrorMessage(cause, '账户没有恢复，请刷新后重试。')
  } finally {
    restoringId.value = null
  }
}

async function onSaved(updated: LedgerTransactionDto): Promise<void> {
  currentTransaction.value = updated
  editing.value = false
  editDirty.value = false
  emit('updated', updated)
  await loadGroup(updated)
  toast.success('交易已更新')
}

async function remove(): Promise<void> {
  const current = transaction.value
  if (!current || !canDelete.value || restoringId.value) return
  const confirmed = await confirm('删除这笔交易？', '删除记录会影响账户余额和相关汇总；本次操作不会提供恢复入口。', {
    destructive: true,
    confirmLabel: '删除记录',
  })
  if (!confirmed) return
  actionError.value = ''
  try {
    const deletedTransaction = await store.deleteTransaction(current.id, current.version)
    toast.success('交易已删除')
    emit('deleted', deletedTransaction)
    await requestClose()
  } catch (cause) {
    actionError.value = ledgerErrorMessage(cause, '交易没有删除，请刷新后重试。')
  }
}
</script>

<template>
  <NModal
    v-if="props.open && transaction"
    :show="props.open && Boolean(transaction)"
    :mask-closable="false"
    :close-on-esc="false"
    :auto-focus="false"
    :trap-focus="true"
    :on-esc="requestClose"
    :on-mask-click="requestClose"
    :on-update-show="handleVisibilityChange"
    :on-after-enter="focusInitialDetail"
  >
    <NCard
      class="ledger-detail-sheet-card ledger-detail-sheet"
      data-testid="ledger-transaction-detail-sheet"
      :bordered="false"
      size="small"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ledger-transaction-detail-title"
    >
      <template #header>
          <div>
            <p class="ledger-eyebrow">交易详情</p>
            <h2 id="ledger-transaction-detail-title">{{ typeLabel(transaction) }}</h2>
          </div>
      </template>
      <template #header-extra>
          <NButton class="ledger-close-button" attr-type="button" size="small" :bordered="false" aria-label="关闭交易详情" @click="requestClose"><NIcon aria-hidden="true" :size="18"><X /></NIcon></NButton>
      </template>

      <div ref="detailFocusTarget" class="ledger-detail-content" tabindex="-1">
        <LedgerTransactionEditForm v-if="editing && canEdit" :transaction="transaction" :group-transactions="groupTransactions" @saved="onSaved" @dirty="editDirty = $event" @cancel="requestEditCancel" />
        <template v-else>
          <NCard class="ledger-transaction-hero" :bordered="false" size="small">
            <NStatistic label="金额" :value="amountLabel(transaction)" :class="`is-${transaction.type}`" />
            <small>{{ formatLedgerDateTime(transaction.occurredAt, store.settings.value?.timezone ?? 'UTC') }}</small>
          </NCard>

          <div class="ledger-detail-list">
            <div class="ledger-detail-row"><span>交易地点</span><strong>{{ transaction.location || '未填写' }}</strong></div>
            <template v-if="transaction.type === 'income' || transaction.type === 'expense'">
              <div class="ledger-detail-row"><span>账户</span><strong>{{ accountName(transaction.accountId) }}<em v-if="associatedAccounts.some((account) => account.archivedAt !== null)">（已归档）</em></strong></div>
              <div class="ledger-detail-row"><span>分类</span><strong>{{ categoryName(transaction.categoryId) }}</strong></div>
              <div class="ledger-detail-row"><span>交易对象</span><strong>{{ transaction.payee || '未填写' }}</strong></div>
            </template>
            <template v-else-if="transaction.type === 'transfer'">
              <div class="ledger-detail-row"><span>转账类型</span><strong>{{ typeLabel(transaction) }}</strong></div>
              <div v-if="groupedExpense" class="ledger-detail-row"><span>{{ transaction.transferKind === 'repayment' ? '还款本金' : '到账金额' }}</span><strong>{{ formatLedgerMoney(transaction.amountMinor, store.settings.value?.baseCurrency ?? 'CNY') }}</strong></div>
              <div v-if="groupedExpense" class="ledger-detail-row"><span>{{ transaction.transferKind === 'repayment' ? '利息' : '手续费' }}</span><strong>{{ formatLedgerMoney(groupedExpense.amountMinor, store.settings.value?.baseCurrency ?? 'CNY') }}<em> · {{ categoryName(groupedExpense.categoryId) }}</em></strong></div>
              <div v-if="groupedExpense" class="ledger-detail-row"><span>{{ transaction.transferKind === 'repayment' ? '总扣款' : '实际扣款' }}</span><strong>{{ formatLedgerMoney(groupedTotalMinor ?? transaction.amountMinor, store.settings.value?.baseCurrency ?? 'CNY') }}</strong></div>
              <div class="ledger-detail-row"><span>转出账户</span><strong>{{ accountName(transaction.fromAccountId) }}</strong></div>
              <div class="ledger-detail-row"><span>转入账户</span><strong>{{ accountName(transaction.toAccountId) }}</strong></div>
            </template>
            <template v-else>
              <div class="ledger-detail-row"><span>账户</span><strong>{{ accountName(transaction.accountId) }}</strong></div>
              <div class="ledger-detail-row"><span>状态</span><strong>余额调整由账户调整流程维护</strong></div>
            </template>
            <div class="ledger-detail-row"><span>备注</span><strong>{{ transaction.note || '未填写' }}</strong></div>
          </div>

          <NAlert v-if="archivedAccounts.length" class="ledger-archived-warning" type="warning" :show-icon="false" role="alert">
            <template #header>关联账户已归档</template>
            <p>历史记录仍可查看。恢复账户后，才能修改交易的财务字段或删除这笔记录。</p>
            <div v-for="account in archivedAccounts" :key="account.id" class="ledger-restore-row">
              <span>{{ account.name }}（已归档）</span>
              <NButton class="ledger-secondary-button" attr-type="button" size="small" :bordered="false" :disabled="Boolean(restoringId)" @click="restoreAccount(account.id)">{{ restoringId === account.id ? '正在恢复…' : '恢复账户' }}</NButton>
            </div>
          </NAlert>

          <NAlert v-if="transaction.type === 'adjustment'" class="ledger-form-info" type="info" :show-icon="false">余额调整为只读记录，不能通过普通交易编辑或删除。</NAlert>
          <NAlert v-if="actionError" class="ledger-form-error" type="error" :show-icon="false" role="alert">{{ actionError }}</NAlert>
          <div class="ledger-form-actions">
            <NButton v-if="canEdit || groupedCompanion" class="ledger-secondary-button" attr-type="button" size="small" :bordered="false" :disabled="Boolean(restoringId) || groupedCompanion" :title="groupedCompanion ? '请从关联的还款记录中统一操作' : undefined" @click="editDirty = false; editing = true">编辑交易</NButton>
            <NButton v-if="canDelete" class="ledger-danger-button" attr-type="button" size="small" :bordered="false" :disabled="Boolean(restoringId)" @click="remove">删除记录</NButton>
            <NButton v-else-if="canEdit && archivedAccounts.length" class="ledger-secondary-button ledger-wide-action" attr-type="button" size="small" :bordered="false" disabled>恢复账户后可删除</NButton>
            <NButton v-else-if="groupedCompanion" class="ledger-danger-button" attr-type="button" size="small" :bordered="false" disabled title="请从关联的还款记录中统一操作">删除记录</NButton>
          </div>
        </template>
      </div>
    </NCard>
  </NModal>
</template>

<style scoped>
.ledger-detail-sheet-card {
  align-self: center;
  width: min(100%, 620px);
  max-height: min(92vh, 820px);
  margin: auto;
  overflow: auto;
  box-sizing: border-box;
  border: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
  border-radius: 18px 18px 12px 12px;
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--accent) 7%, transparent), transparent 46%),
    color-mix(in srgb, var(--bg-soft) 78%, transparent);
  box-shadow: 0 24px 70px color-mix(in srgb, #0f172a 30%, transparent), inset 0 1px 0 color-mix(in srgb, #fff 28%, transparent);
  -webkit-backdrop-filter: saturate(150%) blur(24px);
  backdrop-filter: saturate(150%) blur(24px);
  color: var(--text);
}
.ledger-detail-sheet-card :deep(.n-card__content) { display: grid; gap: 16px; }
.ledger-detail-sheet-card :deep(.n-card__header) { align-items: flex-start; gap: 16px; padding-bottom: 2px; }
.ledger-eyebrow { margin: 0 0 5px; color: var(--accent); font-size: .72rem; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }
.ledger-detail-sheet-card h2 { margin: 0; color: var(--text-h); font-size: 1.45rem; letter-spacing: -.02em; line-height: 1.25; }
.ledger-close-button { width: 36px; height: 36px; padding: 0; border: 1px solid color-mix(in srgb, var(--border) 86%, transparent); border-radius: 9px; background: color-mix(in srgb, var(--bg) 42%, transparent); color: var(--text-muted); font-size: 1.3rem; line-height: 1; cursor: pointer; transition: border-color .18s ease, background-color .18s ease, color .18s ease; }
.ledger-close-button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.ledger-close-button:disabled { cursor: wait; opacity: .65; }
.ledger-detail-content { display: grid; gap: 16px; outline: none; }
.ledger-transaction-hero { border: 1px solid color-mix(in srgb, var(--accent) 16%, var(--border)); border-radius: 12px; background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 10%, transparent), transparent 68%), color-mix(in srgb, var(--bg-soft) 58%, transparent); }
.ledger-transaction-hero :deep(.n-card__content) { display: grid; gap: 6px; padding: 18px; }
.ledger-transaction-hero :deep(.n-statistic-label) { color: var(--text-muted); font-size: .76rem; }
.ledger-transaction-hero :deep(.n-statistic-value) { color: var(--text-h); font-size: 1.8rem; font-variant-numeric: tabular-nums; letter-spacing: -.025em; }
.ledger-transaction-hero :deep(.n-statistic.is-income .n-statistic-value) { color: #18794e; }
.ledger-transaction-hero :deep(.n-statistic.is-expense .n-statistic-value) { color: #b42318; }
.ledger-transaction-hero small { color: var(--text-muted); font-size: .75rem; }
.ledger-detail-list { display: grid; margin: 0; padding: 5px 14px; border: 1px solid color-mix(in srgb, var(--border) 48%, transparent); border-radius: 11px; background: color-mix(in srgb, var(--bg) 18%, transparent); }
.ledger-detail-row { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 16px; align-items: baseline; padding: 10px 0; }
.ledger-detail-row:not(:last-child) { border-bottom: 1px solid color-mix(in srgb, var(--border) 34%, transparent); }
.ledger-detail-row > span { color: var(--text-muted); font-size: .76rem; }
.ledger-detail-row > strong { min-width: 0; color: var(--text-h); font-size: .82rem; font-weight: 550; line-height: 1.45; overflow-wrap: anywhere; white-space: pre-wrap; }
.ledger-detail-list em { color: var(--text-muted); font-style: normal; }
.ledger-archived-warning { border: 1px solid color-mix(in srgb, #b7791f 35%, var(--border)); border-radius: 11px; background: color-mix(in srgb, #f6ad55 8%, transparent); }
.ledger-archived-warning :deep(.n-alert-body) { display: grid; gap: 9px; padding: 13px; }
.ledger-archived-warning :deep(.n-alert__title) { color: var(--text-h); font-size: .85rem; }
.ledger-archived-warning p { margin: 0; color: var(--text-muted); font-size: .77rem; line-height: 1.45; }
.ledger-restore-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: var(--text); font-size: .8rem; }
.ledger-form-info { margin: 0; color: var(--text-muted); font-size: .79rem; line-height: 1.45; }
.ledger-form-info :deep(.n-alert-body) { color: var(--text-muted); }
.ledger-form-error { margin: 0; color: #b42318; font-size: .81rem; }
.ledger-form-error :deep(.n-alert-body) { color: #b42318; }
.ledger-form-actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px; padding-top: 2px; }
.ledger-primary-button,
.ledger-secondary-button,
.ledger-danger-button { display: inline-flex; width: 88px; min-width: 88px; height: 32px; min-height: 32px; align-items: center; justify-content: center; padding: 6px 12px; box-sizing: border-box; border-radius: 8px; font: inherit; font-size: .78rem; font-weight: 650; cursor: pointer; }
.ledger-wide-action { width: auto; min-width: 132px; }
.ledger-primary-button { border: 1px solid var(--accent); background: var(--accent); color: #fff; }
.ledger-primary-button:hover { background: var(--accent-hover); }
.ledger-secondary-button { border: 1px solid color-mix(in srgb, var(--border) 86%, transparent); background: color-mix(in srgb, var(--bg) 34%, transparent); color: var(--text-h); }
.ledger-secondary-button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.ledger-danger-button { border: 1px solid color-mix(in srgb, #b42318 55%, var(--border)); background: transparent; color: #b42318; }
.ledger-danger-button:hover:not(:disabled) { background: color-mix(in srgb, #b42318 8%, transparent); }
.ledger-primary-button:disabled,
.ledger-secondary-button:disabled,
.ledger-danger-button:disabled { cursor: wait; opacity: .65; }
@media (max-width: 600px) {
  .ledger-detail-sheet-card { align-self: flex-end; width: 100%; max-height: 100%; margin: auto 0 0; border-radius: 16px 16px 0 0; }
  .ledger-form-actions > * { flex: 1 1 110px; }
}
</style>
