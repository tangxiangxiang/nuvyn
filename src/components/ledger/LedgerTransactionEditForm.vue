<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NForm, type SelectGroupOption, type SelectOption } from 'naive-ui'
import type {
  LedgerTransactionDto,
  LedgerTransferFeeMode,
  LedgerTransferKind,
} from '../../../shared/ledgerProtocol'
import { ledgerErrorMessage } from '../../features/ledger/ledgerErrors'
import { ledgerDecimalFromMinor, parseLedgerMoney } from '../../features/ledger/money'
import { useLedgerStore } from '../../features/ledger/ledgerStore'
import { instantFromLocalDateTime, localDateTimeInputFromInstant } from '../../features/ledger/time'
import LedgerTransactionFormFields from './LedgerTransactionFormFields.vue'
import { ledgerAccountSelectOptions, renderLedgerAccountLabel, renderLedgerCategoryLabel } from './ledgerSelectRenderers'

const props = withDefaults(defineProps<{
  transaction: LedgerTransactionDto
  cancelable?: boolean
  groupTransactions?: readonly LedgerTransactionDto[]
}>(), { cancelable: true })

const emit = defineEmits<{
  saved: [transaction: LedgerTransactionDto]
  cancel: []
  dirty: [value: boolean]
}>()
const store = useLedgerStore()

const amount = ref('')
const accountId = ref('')
const categoryId = ref('')
const fromAccountId = ref('')
const toAccountId = ref('')
const transferKind = ref<LedgerTransferKind>('general')
const transferFeeAmount = ref('')
const transferFeeMode = ref<LedgerTransferFeeMode | null>('deducted')
const occurredAt = ref('')
const location = ref('')
const payee = ref('')
const note = ref('')
const error = ref('')
const saving = ref(false)
type FormSnapshot = {
  amount: string
  accountId: string
  categoryId: string
  fromAccountId: string
  toAccountId: string
  transferKind: LedgerTransferKind
  transferFeeAmount: string
  transferFeeMode: LedgerTransferFeeMode | null
  occurredAt: string
  location: string
  payee: string
  note: string
}
const initialSnapshot = ref<FormSnapshot | null>(null)

const transaction = computed(() => props.transaction)
const groupedExpense = computed(() => {
  const expense = props.groupTransactions?.find((item) => item.type === 'expense' && item.deletedAt === null)
  return expense?.type === 'expense' ? expense : null
})
const formType = computed<'income' | 'expense' | 'transfer'>(() => transaction.value.type === 'adjustment' ? 'expense' : transaction.value.type)
const associatedAccounts = computed(() => {
  const value = transaction.value
  if (value.type === 'income' || value.type === 'expense' || value.type === 'adjustment') {
    return store.accounts.value.filter((account) => account.id === value.accountId)
  }
  return store.accounts.value.filter((account) => account.id === value.fromAccountId || account.id === value.toAccountId)
})
const hasArchivedAccount = computed(() => associatedAccounts.value.some((account) => account.archivedAt !== null))
const financialFieldsEditable = computed(() => transaction.value.type !== 'adjustment' && !hasArchivedAccount.value && transaction.value.deletedAt === null)
const categories = computed(() => {
  const value = transaction.value
  if (value.type !== 'income' && value.type !== 'expense') return []
  const currentId = value.categoryId
  const current = store.categories.value.find((category) => category.id === currentId)
  const active = store.activeCategories.value.filter((category) => category.kind === value.type)
  if (current && !active.some((category) => category.id === current.id)) return [current, ...active]
  return active
})
const accountOptions = computed<SelectGroupOption[]>(() => ledgerAccountSelectOptions(store.activeAccounts.value))
const transferFromAccountOptions = computed<SelectGroupOption[]>(() => accountOptionsForTransferSide('from'))
const transferToAccountOptions = computed<SelectGroupOption[]>(() => accountOptionsForTransferSide('to'))
const categoryOptions = computed<SelectOption[]>(() => categories.value.map((category) => ({
  value: category.id,
  label: `${category.name}${category.archivedAt !== null ? '（已归档）' : ''}`,
})))
function accountOptionsForTransferSide(side: 'from' | 'to'): SelectGroupOption[] {
  const allowedNatures = transferKind.value === 'general'
    ? undefined
    : side === 'from'
      ? ['asset'] as const
      : transferKind.value === 'repayment'
        ? ['liability'] as const
        : ['asset'] as const
  return ledgerAccountSelectOptions(store.activeAccounts.value, {
    showBalance: false,
    allowedNatures,
  })
}

function renderAccountLabel(option: SelectOption | SelectGroupOption) {
  return renderLedgerAccountLabel(option, store.activeAccounts.value)
}

function renderCategoryLabel(option: SelectOption) {
  return renderLedgerCategoryLabel(option, categories.value)
}

function associatedAccountIds(): string[] {
  const value = transaction.value
  if (value.type === 'transfer') return [value.fromAccountId, value.toAccountId]
  return [value.accountId]
}

async function refreshAssociatedAccounts(): Promise<void> {
  await Promise.all([...new Set(associatedAccountIds())].map((id) => store.getAccount(id)))
}

function reset(): void {
  const value = transaction.value
  const fee = value.type === 'transfer' ? groupedExpense.value : null
  const requestedAmountMinor = value.type === 'transfer'
    && value.transferKind === 'withdrawal'
    && value.feeMode === 'deducted'
    && fee
    ? value.amountMinor + fee.amountMinor
    : value.type === 'adjustment' ? null : value.amountMinor
  amount.value = requestedAmountMinor === null
    ? ''
    : ledgerDecimalFromMinor(requestedAmountMinor, store.settings.value?.baseCurrency ?? 'CNY')
  occurredAt.value = store.settings.value?.timezone
    ? localDateTimeInputFromInstant(value.occurredAt, store.settings.value.timezone)
    : ''
  location.value = value.location ?? ''
  payee.value = value.type === 'income' || value.type === 'expense' ? value.payee : ''
  note.value = value.note
  accountId.value = value.type === 'income' || value.type === 'expense' ? value.accountId : ''
  categoryId.value = value.type === 'income' || value.type === 'expense' ? value.categoryId : ''
  fromAccountId.value = value.type === 'transfer' ? value.fromAccountId : ''
  toAccountId.value = value.type === 'transfer' ? value.toAccountId : ''
  transferKind.value = value.type === 'transfer' ? value.transferKind : 'general'
  transferFeeAmount.value = fee
    ? ledgerDecimalFromMinor(fee.amountMinor, store.settings.value?.baseCurrency ?? 'CNY')
    : ''
  transferFeeMode.value = value.type === 'transfer'
    ? value.feeMode ?? (value.transferKind === 'withdrawal' ? (fee ? 'extra' : 'deducted') : null)
    : null
  error.value = ''
  initialSnapshot.value = snapshot()
}

watch(() => props.transaction, reset, { immediate: true })
watch(() => props.groupTransactions, reset)
watch([amount, accountId, categoryId, fromAccountId, toAccountId, transferKind, transferFeeAmount, transferFeeMode, occurredAt, location, payee, note], () => {
  if (!initialSnapshot.value) return
  emit('dirty', JSON.stringify(snapshot()) !== JSON.stringify(initialSnapshot.value))
})

watch(transferKind, () => {
  if (transaction.value.type !== 'transfer') return
  if (transferKind.value === 'general') {
    transferFeeAmount.value = ''
    transferFeeMode.value = null
  } else if (transferKind.value === 'repayment') {
    transferFeeMode.value = null
  } else if (transferKind.value === 'withdrawal') {
    transferFeeMode.value = 'deducted'
  }
  const from = store.activeAccounts.value.find((account) => account.id === fromAccountId.value)
  const to = store.activeAccounts.value.find((account) => account.id === toAccountId.value)
  if (transferKind.value !== 'general' && from?.nature !== 'asset') fromAccountId.value = ''
  if (transferKind.value === 'repayment' && to?.nature !== 'liability') toAccountId.value = ''
  if (transferKind.value === 'withdrawal' && to?.nature !== 'asset') toAccountId.value = ''
})

function snapshot(): FormSnapshot {
  return {
    amount: amount.value,
    accountId: accountId.value,
    categoryId: categoryId.value,
    fromAccountId: fromAccountId.value,
    toAccountId: toAccountId.value,
    transferKind: transferKind.value,
    transferFeeAmount: transferFeeAmount.value,
    transferFeeMode: transferFeeMode.value,
    occurredAt: occurredAt.value,
    location: location.value,
    payee: payee.value,
    note: note.value,
  }
}

function validateFinancialFields(): {
  amountMinor: number
  occurredAtMs: number
  feeMinor: number
  feeMode?: LedgerTransferFeeMode
} | null {
  const settings = store.settings.value
  if (!settings) {
    error.value = 'Ledger 设置尚未加载完成。'
    return null
  }
  let amountMinor: number
  try {
    amountMinor = parseLedgerMoney(amount.value, settings.baseCurrency)
  } catch {
    error.value = `请输入有效的${settings.baseCurrency}金额。`
    return null
  }
  if (amountMinor <= 0) {
    error.value = '金额必须大于 0。'
    return null
  }
  if (!occurredAt.value) {
    error.value = '请选择发生时间。'
    return null
  }
  let occurredAtMs: number
  try {
    occurredAtMs = instantFromLocalDateTime(occurredAt.value, settings.timezone)
  } catch {
    error.value = '请选择有效的发生时间。'
    return null
  }
  let feeMinor = 0
  if (transaction.value.type === 'transfer') {
    if (!fromAccountId.value || !toAccountId.value) {
      error.value = '请选择转出账户和转入账户。'
      return null
    }
    if (fromAccountId.value === toAccountId.value) {
      error.value = '转出账户和转入账户必须不同。'
      return null
    }
    const from = store.accounts.value.find((account) => account.id === fromAccountId.value)
    const to = store.accounts.value.find((account) => account.id === toAccountId.value)
    if (transferKind.value === 'repayment' && (from?.nature !== 'asset' || to?.nature !== 'liability')) {
      error.value = '还款必须从资产账户转入负债账户。'
      return null
    }
    if (transferKind.value === 'withdrawal' && (from?.nature !== 'asset' || to?.nature !== 'asset')) {
      error.value = '提现必须在两个资产账户之间进行。'
      return null
    }
    if (transferKind.value !== 'general') {
      try {
        feeMinor = transferFeeAmount.value.trim()
          ? parseLedgerMoney(transferFeeAmount.value, settings.baseCurrency)
          : 0
      } catch {
        error.value = `请输入有效的${settings.baseCurrency}利息或手续费。`
        return null
      }
      if (feeMinor < 0) {
        error.value = '利息或手续费不能为负数。'
        return null
      }
      if (feeMinor > 0 && transferKind.value === 'withdrawal') {
        if (!transferFeeMode.value) {
          error.value = '请选择手续费方式。'
          return null
        }
        if (transferFeeMode.value === 'deducted' && feeMinor >= amountMinor) {
          error.value = '从提现金额中扣除时，手续费必须小于提现金额。'
          return null
        }
      }
    }
  } else if (!accountId.value || !categoryId.value) {
    error.value = '请选择账户和分类。'
    return null
  }
  return {
    amountMinor,
    occurredAtMs,
    feeMinor,
    ...(transaction.value.type === 'transfer'
      && transferKind.value === 'withdrawal'
      && feeMinor > 0
      && transferFeeMode.value
      ? { feeMode: transferFeeMode.value }
      : {}),
  }
}

function categoryPatchField(): { categoryId?: string } {
  const value = transaction.value
  if (value.type !== 'income' && value.type !== 'expense') return {}
  const current = store.categories.value.find((category) => category.id === value.categoryId)
  // The server permits an existing archived Category to remain attached to a
  // historical transaction, but rejects it as a new candidate. Omit the
  // unchanged archived identity from a partial edit; selecting an active
  // replacement still sends the new categoryId.
  if (current && current.archivedAt !== null && categoryId.value === current.id) return {}
  return { categoryId: categoryId.value }
}

async function submit(): Promise<void> {
  if (saving.value) return
  error.value = ''
  if (transaction.value.type === 'adjustment' || transaction.value.deletedAt !== null) {
    error.value = '这笔记录当前不可编辑。'
    return
  }

  saving.value = true
  try {
    if (financialFieldsEditable.value) {
      // An Account can be archived in another session while this form is
      // open. Re-read the server-owned Account state immediately before
      // constructing a financial patch; do not rely on the old snapshot or
      // let an avoidable generic 409 decide the UX.
      await refreshAssociatedAccounts()
      if (!financialFieldsEditable.value) {
        error.value = '关联账户已归档，无法保存财务字段。请先恢复账户；当前只允许修改交易对象和备注。'
        return
      }
    }

    const financial = financialFieldsEditable.value ? validateFinancialFields() : null
    if (financialFieldsEditable.value && !financial) return
    const body = financialFieldsEditable.value && financial
      ? transaction.value.type === 'income'
        ? {
            expectedVersion: transaction.value.version,
            amountMinor: financial.amountMinor,
            accountId: accountId.value,
            ...categoryPatchField(),
            occurredAt: financial.occurredAtMs,
            location: location.value.trim(),
            payee: payee.value.trim(),
            note: note.value.trim(),
          }
        : transaction.value.type === 'expense'
          ? {
              expectedVersion: transaction.value.version,
              amountMinor: financial.amountMinor,
              accountId: accountId.value,
              ...categoryPatchField(),
              occurredAt: financial.occurredAtMs,
              location: location.value.trim(),
              payee: payee.value.trim(),
              note: note.value.trim(),
            }
          : {
              expectedVersion: transaction.value.version,
              transferKind: transferKind.value,
              amountMinor: financial.amountMinor,
              feeMinor: financial.feeMinor,
              ...(financial.feeMinor > 0 && transferKind.value === 'withdrawal'
                ? { feeMode: financial.feeMode }
                : {}),
              fromAccountId: fromAccountId.value,
              toAccountId: toAccountId.value,
              occurredAt: financial.occurredAtMs,
              location: location.value.trim(),
              note: note.value.trim(),
            }
      : transaction.value.type === 'income' || transaction.value.type === 'expense'
        ? { expectedVersion: transaction.value.version, location: location.value.trim(), payee: payee.value.trim(), note: note.value.trim() }
        : { expectedVersion: transaction.value.version, location: location.value.trim(), note: note.value.trim() }
    const updated = await store.patchTransaction(transaction.value.id, body)
    emit('saved', updated)
  } catch (cause) {
    error.value = ledgerErrorMessage(cause, '交易没有保存，请刷新后重试。')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <NForm class="ledger-transaction-edit-form" data-testid="ledger-transaction-edit-form" :aria-busy="saving ? 'true' : undefined" @submit.prevent="submit">
    <p v-if="hasArchivedAccount" class="ledger-form-info">关联账户已归档；当前只能修改{{ transaction.type === 'income' || transaction.type === 'expense' ? '交易对象和备注' : '备注' }}。恢复账户后才能修改财务字段。</p>

    <LedgerTransactionFormFields
      v-model:amount="amount"
      v-model:account-id="accountId"
      v-model:category-id="categoryId"
      v-model:from-account-id="fromAccountId"
      v-model:to-account-id="toAccountId"
      v-model:transfer-kind="transferKind"
      v-model:occurred-at="occurredAt"
      v-model:location="location"
      v-model:payee="payee"
      v-model:note="note"
      mode="edit"
      :type="formType"
      :currency="store.settings.value?.baseCurrency ?? 'CNY'"
      :saving="saving"
      :financial-fields-editable="financialFieldsEditable"
      :account-options="accountOptions"
      :transfer-from-account-options="transferFromAccountOptions"
      :transfer-to-account-options="transferToAccountOptions"
      :render-account-label="renderAccountLabel"
      v-model:transfer-fee-amount="transferFeeAmount"
      v-model:transfer-fee-mode="transferFeeMode"
      :category-options="categoryOptions"
      :render-category-label="renderCategoryLabel"
      :readonly-amount="transaction.type === 'adjustment' ? '由余额调整维护' : ledgerDecimalFromMinor(transaction.amountMinor, store.settings.value?.baseCurrency ?? 'CNY')"
      :readonly-occurred-at="occurredAt || '—'"
      :show-payee="transaction.type === 'income' || transaction.type === 'expense'"
    />

    <p v-if="error" class="ledger-form-error" role="alert">{{ error }}</p>
    <div class="ledger-form-actions">
      <NButton v-if="props.cancelable" class="ledger-secondary-button" attr-type="button" size="small" :bordered="false" :disabled="saving" @click="emit('cancel')">取消</NButton>
      <NButton class="ledger-primary-button" attr-type="submit" type="primary" size="small" :bordered="false" :disabled="saving">{{ saving ? '正在保存…' : '保存' }}</NButton>
    </div>
  </NForm>
</template>

<style scoped>
.ledger-transaction-edit-form { display: grid; gap: 14px; width: 100%; padding: 0 4px 4px; box-sizing: border-box; }
.ledger-form-info { margin: 0; padding: 9px 10px; border: 1px solid color-mix(in srgb, var(--accent) 20%, var(--border)); border-radius: 8px; background: color-mix(in srgb, var(--accent) 6%, transparent); color: var(--text-muted); font-size: .8rem; line-height: 1.5; }
.ledger-form-error { margin: 0; color: #b42318; font-size: .81rem; }
.ledger-form-actions { display: flex; justify-content: flex-end; gap: 9px; margin-top: -8px; padding: 12px 0 0; border-top: 1px solid color-mix(in srgb, var(--border) 42%, transparent); }
.ledger-primary-button,
.ledger-secondary-button { min-height: 32px; padding: 6px 12px; border-radius: 7px; font: inherit; font-size: .78rem; font-weight: 650; cursor: pointer; }
.ledger-primary-button { border: 1px solid var(--accent); background: var(--accent); color: #fff; }
.ledger-primary-button:hover:not(:disabled) { background: var(--accent-hover); }
.ledger-secondary-button { border: 1px solid color-mix(in srgb, var(--border) 86%, transparent); background: color-mix(in srgb, var(--bg) 34%, transparent); color: var(--text-h); }
.ledger-secondary-button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.ledger-primary-button:disabled,
.ledger-secondary-button:disabled { cursor: wait; opacity: .65; }
@media (max-width: 620px) {
  .ledger-transaction-edit-form { padding: 0 2px 4px; }
  .ledger-form-actions > * { flex: 1 1 140px; }
}
</style>
