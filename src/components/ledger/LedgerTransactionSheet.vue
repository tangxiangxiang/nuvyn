<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import {
  NButton,
  NCard,
  NForm,
  NIcon,
  NModal,
  NTab,
  NTabs,
  type SelectGroupOption,
  type SelectOption,
} from 'naive-ui'
import { X } from '@vicons/tabler'
import type {
  LedgerCategoryDto,
  LedgerTransferFeeMode,
  LedgerTransferKind,
  LedgerTransactionDto,
} from '../../../shared/ledgerProtocol'
import { useConfirm } from '../../composables/useConfirm'
import { useToast } from '../../composables/useToast'
import { ledgerErrorMessage } from '../../features/ledger/ledgerErrors'
import { currencyExponentFor, parseLedgerMoney } from '../../features/ledger/money'
import { useLedgerStore } from '../../features/ledger/ledgerStore'
import { instantFromLocalDateTime, localDateTimeInputFromInstant } from '../../features/ledger/time'
import LedgerPendingCreateRecovery from './LedgerPendingCreateRecovery.vue'
import LedgerTransactionFormFields from './LedgerTransactionFormFields.vue'
import { ledgerAccountSelectOptions, renderLedgerAccountLabel, renderLedgerCategoryLabel } from './ledgerSelectRenderers'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; saved: [transaction: LedgerTransactionDto] }>()

const store = useLedgerStore()
const toast = useToast()
const { confirm } = useConfirm()
const transactionFields = ref<{ focusAmount: () => void } | null>(null)

type EntryType = 'expense' | 'income' | 'transfer'
const entryTypeOptions: ReadonlyArray<readonly [EntryType, string]> = [
  ['expense', '支出'],
  ['income', '收入'],
  ['transfer', '转账'],
]
const type = ref<EntryType>('expense')
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
const formError = ref('')
const saving = ref(false)
const submitted = ref(false)
const dirty = ref(false)
const closeRequestPending = ref(false)
const closing = ref(false)
let resetting = false

const settings = computed(() => store.settings.value)
const activeAccounts = computed(() => store.activeAccounts.value)
const activeCategories = computed(() => store.activeCategories.value)
const applicableCategories = computed(() => activeCategories.value.filter((category) => category.kind === type.value))
const accountOptions = computed(() => ledgerAccountSelectOptions(activeAccounts.value))
const transferFromAccountOptions = computed(() => ledgerAccountSelectOptions(activeAccounts.value, {
  showBalance: false,
  allowedNatures: transferKind.value === 'general' ? undefined : ['asset'],
}))
const transferToAccountOptions = computed(() => ledgerAccountSelectOptions(activeAccounts.value, {
  showBalance: false,
  allowedNatures: transferKind.value === 'repayment' ? ['liability'] : transferKind.value === 'withdrawal' ? ['asset'] : undefined,
}))
const categoryOptions = computed<SelectOption[]>(() => applicableCategories.value.map((category) => ({
  value: category.id,
  label: categoryLabel(category),
  categoryIcon: category.icon,
})))
const pendingTransaction = computed(() => {
  const pending = store.pendingCreate.value
  return store.mutationState.value === 'UNCERTAIN' && pending?.operation === 'transaction' ? pending : null
})
const recoveryBusy = computed(() => store.mutationState.value === 'SUBMITTING')
const canSubmit = computed(() => activeAccounts.value.length > 0 && !saving.value)
const formTitle = computed(() => type.value === 'expense' ? '记一笔支出' : type.value === 'income' ? '记一笔收入' : '记一笔转账')

function renderAccountLabel(option: SelectOption | SelectGroupOption) {
  return renderLedgerAccountLabel(option, activeAccounts.value)
}

function renderCategoryLabel(option: SelectOption) {
  return renderLedgerCategoryLabel(option, activeCategories.value)
}

function defaultOccurredAt(): string {
  return settings.value?.timezone
    ? localDateTimeInputFromInstant(Date.now(), settings.value.timezone)
    : ''
}

function resetForm(): void {
  resetting = true
  closing.value = false
  type.value = 'expense'
  amount.value = ''
  accountId.value = activeAccounts.value.length === 1 ? activeAccounts.value[0]!.id : ''
  categoryId.value = ''
  fromAccountId.value = ''
  toAccountId.value = ''
  transferKind.value = 'general'
  transferFeeAmount.value = ''
  transferFeeMode.value = null
  occurredAt.value = defaultOccurredAt()
  location.value = ''
  payee.value = ''
  note.value = ''
  formError.value = ''
  submitted.value = false
  dirty.value = false
  void nextTick(() => {
    resetting = false
    dirty.value = false
  })
}

watch(() => props.open, async (open) => {
  if (open) {
    resetForm()
    // NModal owns trapping and restoration. The shared field component
    // supplies the sheet's initial amount focus after its content is mounted.
    await nextTick()
    transactionFields.value?.focusAmount()
  }
})

watch([amount, accountId, categoryId, fromAccountId, toAccountId, transferKind, transferFeeAmount, transferFeeMode, occurredAt, location, payee, note, type], () => {
  if (props.open && !resetting) dirty.value = true
})

watch(type, (nextType, previousType) => {
  if (resetting || nextType === previousType) return
  // Only the common draft survives a semantic type switch. Account and
  // category identities must never be guessed across different transaction
  // meanings.
  accountId.value = ''
  categoryId.value = ''
  payee.value = ''
  fromAccountId.value = ''
  toAccountId.value = ''
  transferKind.value = 'general'
  transferFeeAmount.value = ''
  transferFeeMode.value = null
  if (nextType !== 'transfer' && activeAccounts.value.length === 1) {
    accountId.value = activeAccounts.value[0]!.id
  }
})

watch(transferKind, () => {
  if (resetting || type.value !== 'transfer') return
  const from = activeAccounts.value.find((account) => account.id === fromAccountId.value)
  const to = activeAccounts.value.find((account) => account.id === toAccountId.value)
  if (transferKind.value !== 'general' && from?.nature !== 'asset') fromAccountId.value = ''
  if (transferKind.value === 'repayment' && to?.nature !== 'liability') toAccountId.value = ''
  if (transferKind.value === 'withdrawal' && to?.nature !== 'asset') toAccountId.value = ''
  if (transferKind.value === 'general') {
    transferFeeAmount.value = ''
    transferFeeMode.value = null
  } else {
    transferFeeMode.value = transferKind.value === 'withdrawal' ? 'deducted' : null
  }
})

watch(activeAccounts, (accounts) => {
  if (type.value !== 'transfer') {
    if (accountId.value && !accounts.some((account) => account.id === accountId.value)) accountId.value = ''
    if (!accountId.value && accounts.length === 1) accountId.value = accounts[0]!.id
    return
  }
  if (fromAccountId.value && !accounts.some((account) => account.id === fromAccountId.value)) fromAccountId.value = ''
  if (toAccountId.value && !accounts.some((account) => account.id === toAccountId.value)) toAccountId.value = ''
})

function onTypeTabKeydown(event: KeyboardEvent, selectedType: EntryType): void {
  const current = event.currentTarget as HTMLElement | null
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    type.value = selectedType
    return
  }
  if (!current || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const currentIndex = entryTypeOptions.findIndex(([value]) => value === selectedType)
  const nextIndex = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? entryTypeOptions.length - 1
      : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + entryTypeOptions.length) % entryTypeOptions.length
  const nextType = entryTypeOptions[nextIndex]![0]
  type.value = nextType
  void nextTick(() => {
    current.closest('[role="tablist"]')?.querySelector<HTMLElement>(`[data-ledger-tab="${nextType}"]`)?.focus()
  })
}

async function requestClose(): Promise<void> {
  if (saving.value || closeRequestPending.value) return
  closeRequestPending.value = true
  try {
    if (dirty.value) {
      const leave = await confirm('放弃这笔尚未保存的记录？', '已填写的内容将不会保存。')
      if (!leave) return
    }
    dirty.value = false
    closing.value = true
    emit('close')
  } finally {
    closeRequestPending.value = false
  }
}

function handleVisibilityChange(value: boolean): void {
  if (!value && props.open) void requestClose()
}

function focusInitialInput(): void {
  void nextTick(() => transactionFields.value?.focusAmount())
}

function categoryLabel(category: LedgerCategoryDto): string {
  return category.name
}

function allowAmountInput(value: string): boolean {
  const currency = settings.value?.baseCurrency
  if (!currency || value === '') return true
  const exponent = currencyExponentFor(currency)
  const pattern = exponent === 0
    ? /^\d*$/
    : new RegExp(`^\\d*(?:\\.\\d{0,${exponent}})?$`)
  if (!pattern.test(value)) return false
  if (value === '.' || value.endsWith('.')) return true
  try {
    parseLedgerMoney(value, currency)
    return true
  } catch {
    return false
  }
}

function validationFailure(message: string): null {
  formError.value = ''
  toast.error(message)
  return null
}

function validate(): { amountMinor: number; occurredAtMs: number; feeMinor: number } | null {
  submitted.value = true
  formError.value = ''
  if (!settings.value) {
    return validationFailure('Ledger 设置尚未加载完成。')
  }
  if (!amount.value.trim()) {
    return validationFailure('请输入金额。')
  }
  let amountMinor: number
  try {
    amountMinor = parseLedgerMoney(amount.value, settings.value.baseCurrency)
  } catch {
    return validationFailure(`请输入有效的${settings.value.baseCurrency}金额。`)
  }
  if (amountMinor <= 0) {
    return validationFailure('金额必须大于 0。')
  }
  if (!occurredAt.value) {
    return validationFailure('请选择发生时间。')
  }
  let occurredAtMs: number
  try {
    occurredAtMs = instantFromLocalDateTime(occurredAt.value, settings.value.timezone)
  } catch {
    return validationFailure('请选择有效的发生时间。')
  }
  let feeMinor = 0
  if (type.value === 'transfer') {
    if (!fromAccountId.value || !toAccountId.value) {
      return validationFailure('请选择转出账户和转入账户。')
    }
    if (fromAccountId.value === toAccountId.value) {
      return validationFailure('转出账户和转入账户必须不同。')
    }
    const from = activeAccounts.value.find((account) => account.id === fromAccountId.value)
    const to = activeAccounts.value.find((account) => account.id === toAccountId.value)
    if (transferKind.value === 'repayment' && (from?.nature !== 'asset' || to?.nature !== 'liability')) {
      return validationFailure('还款必须从资产账户转入负债账户。')
    }
    if (transferKind.value === 'withdrawal' && (from?.nature !== 'asset' || to?.nature !== 'asset')) {
      return validationFailure('提现必须在两个资产账户之间进行。')
    }
    if (transferKind.value !== 'general') {
      if (transferFeeAmount.value.trim()) {
        try {
          feeMinor = parseLedgerMoney(transferFeeAmount.value, settings.value.baseCurrency)
        } catch {
          return validationFailure(`请输入有效的${settings.value.baseCurrency}费用金额。`)
        }
        if (feeMinor < 0) return validationFailure('利息或手续费不能为负数。')
      }
      if (transferKind.value === 'withdrawal' && feeMinor > 0) {
        if (!transferFeeMode.value) return validationFailure('请选择手续费方式。')
        if (transferFeeMode.value === 'deducted' && feeMinor >= amountMinor) {
          return validationFailure('从提现金额中扣除时，手续费必须小于提现金额。')
        }
      }
    }
  } else {
    if (!accountId.value) {
      return validationFailure('请选择账户。')
    }
    if (!categoryId.value) {
      return validationFailure('请选择分类，或先新建一个分类。')
    }
  }
  return { amountMinor, occurredAtMs, feeMinor }
}

async function submit(): Promise<void> {
  if (!canSubmit.value) return
  const parsed = validate()
  if (!parsed) return
  saving.value = true
  try {
    const payload = type.value === 'expense'
      ? {
          type: 'expense' as const,
          amountMinor: parsed.amountMinor,
          accountId: accountId.value,
          categoryId: categoryId.value,
          occurredAt: parsed.occurredAtMs,
          location: location.value.trim(),
          payee: payee.value.trim(),
          note: note.value.trim(),
        }
      : type.value === 'income'
        ? {
            type: 'income' as const,
            amountMinor: parsed.amountMinor,
            accountId: accountId.value,
            categoryId: categoryId.value,
            occurredAt: parsed.occurredAtMs,
            location: location.value.trim(),
            payee: payee.value.trim(),
            note: note.value.trim(),
          }
        : {
            type: 'transfer' as const,
            transferKind: transferKind.value,
            amountMinor: parsed.amountMinor,
            ...(parsed.feeMinor > 0 ? {
              feeMinor: parsed.feeMinor,
              ...(transferKind.value === 'withdrawal' && transferFeeMode.value ? { feeMode: transferFeeMode.value } : {}),
            } : {}),
            fromAccountId: fromAccountId.value,
            toAccountId: toAccountId.value,
            occurredAt: parsed.occurredAtMs,
            location: location.value.trim(),
            payee: payee.value.trim(),
            note: note.value.trim(),
          }
    const saved = await store.createTransaction(payload)
    toast.success('已保存这笔交易')
    emit('saved', saved)
    emit('close')
  } catch (cause) {
    formError.value = ledgerErrorMessage(cause, '交易没有保存，请检查后重试。')
  } finally {
    saving.value = false
  }
}

async function retryPending(): Promise<void> {
  try {
    const result = await store.retryPendingCreate()
    toast.success('已确认这笔交易')
    emit('saved', result as LedgerTransactionDto)
    emit('close')
  } catch (cause) {
    formError.value = ledgerErrorMessage(cause, '上一次操作仍未确认，请稍后再试。')
  }
}

</script>

<template>
  <NModal
    v-if="props.open && !closing"
    :show="props.open && !closing"
    :mask-closable="false"
    :close-on-esc="false"
    :auto-focus="false"
    :trap-focus="true"
    :on-esc="requestClose"
    :on-update-show="handleVisibilityChange"
    :on-after-enter="focusInitialInput"
  >
    <NCard
      class="ledger-sheet-card ledger-sheet"
      data-testid="ledger-transaction-sheet"
      :bordered="false"
      size="small"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ledger-sheet-title"
    >
      <template #header>
          <div>
            <h2 id="ledger-sheet-title">{{ formTitle }}</h2>
          </div>
      </template>
      <template #header-extra>
          <NButton class="ledger-close-button" attr-type="button" size="small" :bordered="false" :disabled="saving" aria-label="关闭记账窗口" @click="requestClose"><NIcon aria-hidden="true" :size="18"><X /></NIcon></NButton>
      </template>

        <LedgerPendingCreateRecovery
          v-if="pendingTransaction"
          :intent="pendingTransaction"
          :busy="recoveryBusy"
          :error="formError"
          @retry="retryPending"
        />

        <template v-else>
          <NTabs
            v-model:value="type"
            class="ledger-entry-types"
            type="segment"
            size="small"
            role="tablist"
            aria-label="交易类型"
            :animated="false"
            :tabs-padding="0"
          >
            <NTab
              v-for="option in entryTypeOptions"
              :key="option[0]"
              :name="option[0]"
              :tab="option[1]"
              class="ledger-entry-type"
              :data-ledger-tab="option[0]"
              role="tab"
              :aria-selected="type === option[0] ? 'true' : 'false'"
              :tabindex="type === option[0] ? 0 : -1"
              :disabled="saving"
              @keydown="onTypeTabKeydown($event, option[0])"
            />
          </NTabs>

          <NForm class="ledger-entry-form" :aria-busy="saving ? 'true' : undefined" @submit.prevent="submit">
            <LedgerTransactionFormFields
              ref="transactionFields"
              v-model:amount="amount"
              v-model:account-id="accountId"
              v-model:category-id="categoryId"
              v-model:from-account-id="fromAccountId"
              v-model:to-account-id="toAccountId"
              v-model:transfer-kind="transferKind"
              v-model:transfer-fee-amount="transferFeeAmount"
              v-model:transfer-fee-mode="transferFeeMode"
              v-model:occurred-at="occurredAt"
              v-model:location="location"
              v-model:payee="payee"
              v-model:note="note"
              mode="create"
              :type="type"
              :currency="settings?.baseCurrency ?? 'CNY'"
              :saving="saving"
              :account-options="accountOptions"
              :transfer-from-account-options="transferFromAccountOptions"
              :transfer-to-account-options="transferToAccountOptions"
              :category-options="categoryOptions"
              :render-account-label="renderAccountLabel"
              :render-category-label="renderCategoryLabel"
              :allow-amount-input="allowAmountInput"
              :show-payee="type !== 'transfer'"
            />

            <p v-if="!activeAccounts.length" class="ledger-form-error" role="alert">请先创建一个可用账户，再记账。</p>
            <p v-if="formError" class="ledger-form-error" role="alert">{{ formError }}</p>
            <div class="ledger-form-actions">
              <NButton class="ledger-secondary-button" attr-type="button" size="small" :bordered="false" :disabled="saving" @click="requestClose">取消</NButton>
              <NButton class="ledger-primary-button" attr-type="submit" type="primary" size="small" :bordered="false" :disabled="!canSubmit">{{ saving ? '正在保存…' : '保存' }}</NButton>
            </div>
          </NForm>
        </template>
    </NCard>
  </NModal>
</template>

<style scoped>
.ledger-sheet-card { align-self: center; width: min(100%, 620px); max-height: min(92vh, 820px); margin: auto; overflow: auto; box-sizing: border-box; border: 1px solid color-mix(in srgb, var(--border) 68%, transparent); border-radius: 18px 18px 12px 12px; background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 5%, transparent), transparent 48%), color-mix(in srgb, var(--bg-soft) 68%, transparent); box-shadow: 0 24px 70px color-mix(in srgb, #0f172a 30%, transparent), inset 0 1px 0 color-mix(in srgb, #fff 32%, transparent); -webkit-backdrop-filter: saturate(145%) blur(22px); backdrop-filter: saturate(145%) blur(22px); color: var(--text); }
.ledger-sheet-card :deep(.n-card__content) { display: grid; gap: 14px; }
.ledger-sheet-card :deep(.n-card__header) { align-items: flex-start; gap: 16px; padding-bottom: 2px; }
.ledger-sheet-card h2 { margin: 0; color: var(--text-h); font-size: 1.35rem; line-height: 1.25; }
.ledger-close-button { width: 36px; height: 36px; padding: 0; border: 1px solid color-mix(in srgb, var(--border) 86%, transparent); border-radius: 9px; background: color-mix(in srgb, var(--bg) 58%, transparent); color: var(--text-muted); font-size: 1.3rem; line-height: 1; cursor: pointer; transition: border-color .18s ease, background-color .18s ease, color .18s ease; }
.ledger-close-button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.ledger-close-button:disabled { cursor: wait; opacity: .6; }
.ledger-entry-types { width: 100%; }
.ledger-entry-types :deep(.n-tabs-rail) { padding: 3px; border: 1px solid color-mix(in srgb, var(--border) 82%, transparent); border-radius: 9px; background: color-mix(in srgb, var(--bg) 54%, transparent); }
.ledger-entry-types :deep(.n-tabs-tab) { min-height: 30px; padding: 0 12px; border-radius: 7px; color: var(--text-muted); font: inherit; font-size: .78rem; transition: background-color .18s ease, color .18s ease; }
.ledger-entry-types :deep(.n-tabs-tab--active) { background: color-mix(in srgb, var(--accent) 11%, transparent); color: var(--accent); font-weight: 700; }
.ledger-entry-types :deep(.n-tabs-tab:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
.ledger-entry-types :deep(.n-tabs-tab--disabled) { cursor: wait; opacity: .6; }
.ledger-entry-form { display: grid; gap: 6px; }
.ledger-field-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.ledger-link-button { padding: 0; border: 0; background: transparent; color: var(--accent); font: inherit; font-size: .76rem; cursor: pointer; }
.ledger-link-button:hover:not(:disabled) { text-decoration: underline; }
.ledger-link-button:disabled { cursor: wait; opacity: .6; }
.ledger-quick-create { display: grid; gap: 6px; margin-top: 3px; padding: 10px; border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--border)); border-radius: 8px; background: color-mix(in srgb, var(--accent) 6%, transparent); }
.ledger-quick-create label { font-size: .78rem; }
.ledger-quick-create-row { display: flex; gap: 7px; }
.ledger-quick-create-row :deep(.ledger-form-control) { flex: 1; min-width: 0; }
.ledger-form-actions { display: flex; justify-content: flex-end; gap: 9px; margin: 2px -4px -4px; padding: 4px 4px 0; border-top: 1px solid color-mix(in srgb, var(--border) 72%, transparent); }
.ledger-primary-button,
.ledger-secondary-button { min-height: 32px; padding: 6px 12px; border-radius: 7px; font: inherit; font-size: .78rem; font-weight: 650; cursor: pointer; }
.ledger-primary-button { border: 1px solid var(--accent); background: var(--accent); color: #fff; }
.ledger-primary-button:hover:not(:disabled) { background: var(--accent-hover); }
.ledger-secondary-button { border: 1px solid var(--border); background: var(--bg); color: var(--text-h); }
.ledger-secondary-button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.ledger-primary-button:disabled,
.ledger-secondary-button:disabled { cursor: wait; opacity: .65; }
.ledger-form-error { margin: 0; color: #b42318; font-size: .81rem; line-height: 1.45; }
@media (max-width: 600px) {
  .ledger-sheet-card { align-self: flex-end; width: 100%; max-height: 100%; margin: auto 0 0; border-radius: 16px 16px 0 0; }
  .ledger-form-actions > * { flex: 1 1 140px; }
}
</style>
