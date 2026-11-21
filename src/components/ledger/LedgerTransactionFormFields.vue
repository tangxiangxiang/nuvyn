<script setup lang="ts">
import { computed, nextTick, ref, watch, type VNodeChild } from 'vue'
import { NButton, NFormItem, NInput, NPopover, NRadioButton, NRadioGroup, type InputInst, type SelectGroupOption, type SelectOption } from 'naive-ui'
import type { LedgerTransferFeeMode, LedgerTransferKind } from '../../../shared/ledgerProtocol'
import { evaluateLedgerAmountExpression, formatLedgerMoney, parseLedgerMoney } from '../../features/ledger/money'
import LedgerDateTimePicker from './LedgerDateTimePicker.vue'
import LedgerTransactionSelect from './LedgerTransactionSelect.vue'

type TransactionFormType = 'income' | 'expense' | 'transfer'
type OptionRenderer = (option: SelectOption | SelectGroupOption, selected?: boolean) => VNodeChild

const props = withDefaults(defineProps<{
  mode: 'create' | 'edit'
  type: TransactionFormType
  currency: string
  saving: boolean
  financialFieldsEditable?: boolean
  accountOptions: Array<SelectOption | SelectGroupOption>
  transferAccountOptions?: Array<SelectOption | SelectGroupOption>
  transferFromAccountOptions?: Array<SelectOption | SelectGroupOption>
  transferToAccountOptions?: Array<SelectOption | SelectGroupOption>
  categoryOptions: Array<SelectOption | SelectGroupOption>
  renderAccountLabel?: OptionRenderer
  renderCategoryLabel?: OptionRenderer
  allowAmountInput?: (value: string) => boolean
  readonlyAmount?: string
  readonlyOccurredAt?: string
  showPayee?: boolean
}>(), {
  financialFieldsEditable: true,
  transferAccountOptions: () => [],
  transferFromAccountOptions: undefined,
  transferToAccountOptions: undefined,
  readonlyAmount: '—',
  readonlyOccurredAt: '—',
  showPayee: true,
})

const amount = defineModel<string>('amount', { required: true })
const accountId = defineModel<string>('accountId', { required: true })
const categoryId = defineModel<string>('categoryId', { required: true })
const fromAccountId = defineModel<string>('fromAccountId', { required: true })
const toAccountId = defineModel<string>('toAccountId', { required: true })
const transferKind = defineModel<LedgerTransferKind>('transferKind', { default: 'general' })
const transferFeeAmount = defineModel<string>('transferFeeAmount', { default: '' })
const transferFeeMode = defineModel<LedgerTransferFeeMode | null>('transferFeeMode', { default: 'deducted' })
const occurredAt = defineModel<string>('occurredAt', { required: true })
const location = defineModel<string>('location', { required: true })
const payee = defineModel<string>('payee', { required: true })
const note = defineModel<string>('note', { required: true })

const amountInput = ref<InputInst | null>(null)
const amountContainer = ref<HTMLElement | null>(null)
const amountElement = ref<HTMLInputElement | null>(null)
const amountFocused = ref(false)
const amountExpressionToolsOpened = ref(false)
const feeModePopoverOpen = ref(false)
const idPrefix = props.mode === 'create' ? 'ledger-transaction' : 'ledger-edit-transaction'

const amountExpressionResult = computed(() => evaluateLedgerAmountExpression(amount.value, props.currency))
const amountExpressionPreview = computed(() => {
  if (!/[+-]/.test(amount.value) || amountExpressionResult.value.status !== 'complete') return null
  return formatLedgerMoney(amountExpressionResult.value.amountMinor, props.currency)
})
const canAppendAmountOperator = computed(() => amountExpressionResult.value.status === 'complete' && Boolean(amount.value.trim()))

const hasPositiveTransferFee = computed(() => {
  if (props.type !== 'transfer' || transferKind.value !== 'withdrawal' || !transferFeeAmount.value.trim()) return false
  try {
    return parseLedgerMoney(transferFeeAmount.value, props.currency) > 0
  } catch {
    return false
  }
})
const transferFeeModeLabel = computed(() => transferFeeMode.value === 'deducted'
  ? '从提现金额中扣除'
  : transferFeeMode.value === 'extra'
    ? '额外扣除'
    : '扣费方式')
const withdrawalReceivedAmount = computed(() => {
  if (props.type !== 'transfer' || transferKind.value !== 'withdrawal') return null
  try {
    const amountResult = evaluateLedgerAmountExpression(amount.value, props.currency)
    if (amountResult.status !== 'complete') return null
    const amountMinor = amountResult.amountMinor
    const feeMinor = transferFeeAmount.value.trim()
      ? parseLedgerMoney(transferFeeAmount.value, props.currency)
      : 0
    if (amountMinor < 0 || feeMinor < 0 || (feeMinor > 0 && !transferFeeMode.value)) return null
    const receivedMinor = transferFeeMode.value === 'deducted'
      ? amountMinor - feeMinor
      : amountMinor
    return receivedMinor >= 0 ? formatLedgerMoney(receivedMinor, props.currency) : null
  } catch {
    return null
  }
})
const repaymentTotalAmount = computed(() => {
  if (props.type !== 'transfer' || transferKind.value !== 'repayment') return null
  try {
    const amountResult = evaluateLedgerAmountExpression(amount.value, props.currency)
    if (amountResult.status !== 'complete') return null
    const amountMinor = amountResult.amountMinor
    const feeMinor = transferFeeAmount.value.trim()
      ? parseLedgerMoney(transferFeeAmount.value, props.currency)
      : 0
    const totalMinor = amountMinor + feeMinor
    if (amountMinor <= 0 || !Number.isSafeInteger(totalMinor) || totalMinor <= 0) return null
    return formatLedgerMoney(totalMinor, props.currency)
  } catch {
    return null
  }
})

watch(hasPositiveTransferFee, (visible) => {
  if (!visible) feeModePopoverOpen.value = false
})

function selectTransferFeeMode(value: LedgerTransferFeeMode): void {
  transferFeeMode.value = value
  feeModePopoverOpen.value = false
}

function allowTransferFeeInput(value: string): boolean {
  const allowAmountInput = props.allowAmountInput
  if (!allowAmountInput) return true
  if (props.type === 'transfer' && transferKind.value === 'repayment' && value.startsWith('-')) {
    return allowAmountInput(value.slice(1))
  }
  return allowAmountInput(value)
}

function allowAmountExpressionInput(value: string): boolean {
  return evaluateLedgerAmountExpression(value, props.currency).status !== 'invalid'
}

function normalizeAmountExpression(): void {
  if (!/[+-]/.test(amount.value)) return
  const result = evaluateLedgerAmountExpression(amount.value, props.currency)
  if (result.status === 'complete' && result.amountMinor > 0) amount.value = result.normalized
}

function onAmountKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || !/[+-]/.test(amount.value)) return
  // Enter commits an expression rather than submitting the surrounding form.
  event.preventDefault()
  normalizeAmountExpression()
}

function onAmountFocus(event: FocusEvent): void {
  amountFocused.value = true
  amountExpressionToolsOpened.value = true
  if (event.target instanceof HTMLInputElement) amountElement.value = event.target
}

function onAmountFocusOut(): void {
  queueMicrotask(() => {
    if (amountContainer.value?.contains(document.activeElement)) return
    amountFocused.value = false
    normalizeAmountExpression()
  })
}

function insertAmountOperator(operator: '+' | '-'): void {
  const input = amountElement.value
  const currentValue = amount.value
  if (!input || !currentValue.trim()) return
  const start = input.selectionStart ?? currentValue.length
  const end = input.selectionEnd ?? start
  const nextValue = `${currentValue.slice(0, start)}${operator}${currentValue.slice(end)}`
  if (!allowAmountExpressionInput(nextValue)) return
  amount.value = nextValue
  amountFocused.value = true
  void nextTick(() => {
    input.focus()
    const caret = start + 1
    input.setSelectionRange(caret, caret)
  })
}

defineExpose({
  focusAmount: () => amountInput.value?.focus(),
})
</script>

<template>
  <div class="ledger-transaction-form-fields" :data-mode="mode">
    <template v-if="financialFieldsEditable">
      <div :class="type === 'transfer' && transferKind !== 'general' ? 'ledger-transfer-amount-grid' : undefined">
        <NFormItem
          class="ledger-form-field ledger-amount-field"
          :show-feedback="false"
          required
        >
          <template #label>
            <div class="ledger-amount-label-row">
              <span>{{ type === 'transfer' && transferKind === 'repayment' ? '还款本金' : type === 'transfer' && transferKind === 'withdrawal' ? '提现金额' : '金额' }}</span>
              <span v-if="repaymentTotalAmount" class="ledger-received-amount">实际扣款 {{ repaymentTotalAmount }}</span>
              <span v-if="withdrawalReceivedAmount" class="ledger-received-amount">实际到账 {{ withdrawalReceivedAmount }}</span>
            </div>
          </template>
          <div ref="amountContainer" class="ledger-money-field-control" @focusin="onAmountFocus" @focusout="onAmountFocusOut">
            <div class="ledger-money-input">
              <span>{{ currency }}</span>
              <NInput
                ref="amountInput"
                v-model:value="amount"
                class="ledger-money-control"
                type="text"
                size="small"
                :allow-input="allowAmountExpressionInput"
                :bordered="false"
                :input-props="{ id: `${idPrefix}-amount`, name: 'amount', inputmode: 'decimal', autocomplete: 'off', required: true }"
                placeholder="0.00"
                :disabled="saving"
                @keydown="onAmountKeydown"
              />
            </div>
            <div v-if="amountExpressionPreview || amountExpressionToolsOpened" class="ledger-amount-expression-row">
              <span v-if="amountExpressionPreview" class="ledger-amount-expression-preview" data-testid="ledger-amount-expression-preview" aria-live="polite">
                计算结果：{{ amountExpressionPreview }}
              </span>
              <div v-if="amountFocused && amount.trim()" class="ledger-amount-expression-operators" aria-label="金额计算操作">
                <button type="button" aria-label="加法" :disabled="saving || !canAppendAmountOperator" @pointerdown.prevent @click="insertAmountOperator('+')">+</button>
                <button type="button" aria-label="减法" :disabled="saving || !canAppendAmountOperator" @pointerdown.prevent @click="insertAmountOperator('-')">−</button>
              </div>
            </div>
          </div>
        </NFormItem>

        <NFormItem v-if="type === 'transfer' && transferKind !== 'general'" class="ledger-form-field" :show-feedback="false">
          <template #label>
            <div class="ledger-fee-label-row">
              <span>{{ transferKind === 'repayment' ? '利息 / 优惠（可选）' : '手续费（可选）' }}</span>
              <NPopover
                v-if="hasPositiveTransferFee"
                v-model:show="feeModePopoverOpen"
                trigger="click"
                placement="bottom-end"
                :width="180"
                :content-style="{ padding: '4px' }"
                :show-arrow="false"
              >
                <template #trigger>
                  <NButton
                    class="ledger-fee-mode-trigger"
                    text
                    size="tiny"
                    :disabled="saving"
                    :aria-label="transferFeeMode ? `修改手续费方式：${transferFeeModeLabel}` : '选择手续费方式'"
                  >
                    {{ transferFeeModeLabel }}
                  </NButton>
                </template>
                <div class="ledger-fee-mode-options" role="radiogroup" aria-label="手续费方式">
                  <button
                    type="button"
                    role="radio"
                    :aria-checked="transferFeeMode === 'deducted'"
                    @click="selectTransferFeeMode('deducted')"
                  >
                    从提现金额中扣除
                  </button>
                  <button
                    type="button"
                    role="radio"
                    :aria-checked="transferFeeMode === 'extra'"
                    @click="selectTransferFeeMode('extra')"
                  >
                    额外扣除
                  </button>
                </div>
              </NPopover>
            </div>
          </template>
          <div class="ledger-money-input">
            <span>{{ currency }}</span>
            <NInput
              v-model:value="transferFeeAmount"
              class="ledger-money-control"
              type="text"
              size="small"
              :allow-input="allowTransferFeeInput"
              :bordered="false"
              :input-props="{ id: `${idPrefix}-fee-amount`, name: 'feeAmount', inputmode: transferKind === 'repayment' ? 'text' : 'decimal', autocomplete: 'off' }"
              placeholder="0.00"
              :disabled="saving"
            />
          </div>
        </NFormItem>
      </div>

      <div v-if="type !== 'transfer'" class="ledger-form-grid">
        <NFormItem class="ledger-form-field" label="账户" :show-feedback="false" required>
          <LedgerTransactionSelect
            v-model="accountId"
            label="账户"
            :id="`${idPrefix}-account`"
            name="accountId"
            required
            :options="accountOptions"
            :render-label="renderAccountLabel"
            placeholder="请选择账户"
            :disabled="saving"
          />
        </NFormItem>

        <NFormItem class="ledger-form-field" label="分类" :show-feedback="false" required>
          <LedgerTransactionSelect
            v-model="categoryId"
            label="分类"
            :id="`${idPrefix}-category`"
            name="categoryId"
            required
            option-layout="grid"
            :options="categoryOptions"
            :render-label="renderCategoryLabel"
            :placeholder="categoryOptions.length ? '请选择分类' : '暂无可用分类'"
            :disabled="saving"
          />
        </NFormItem>
      </div>

      <div v-else class="ledger-form-grid">
        <NFormItem class="ledger-form-field ledger-transfer-kind-field" label="转账类型" :show-feedback="false">
          <NRadioGroup v-model:value="transferKind" class="ledger-transfer-kinds" size="small" :disabled="saving" aria-label="转账类型">
            <NRadioButton value="general">普通转账</NRadioButton>
            <NRadioButton value="repayment">还款</NRadioButton>
            <NRadioButton value="withdrawal">提现</NRadioButton>
          </NRadioGroup>
        </NFormItem>
        <NFormItem class="ledger-form-field" label="转出账户" :show-feedback="false" required>
          <LedgerTransactionSelect
            v-model="fromAccountId"
            label="转出账户"
            :id="`${idPrefix}-from-account`"
            name="fromAccountId"
            required
            :options="transferFromAccountOptions ?? transferAccountOptions"
            :render-label="renderAccountLabel"
            placeholder="请选择转出账户"
            :disabled="saving"
          />
        </NFormItem>
        <NFormItem class="ledger-form-field" label="转入账户" :show-feedback="false" required>
          <LedgerTransactionSelect
            v-model="toAccountId"
            label="转入账户"
            :id="`${idPrefix}-to-account`"
            name="toAccountId"
            required
            :options="transferToAccountOptions ?? transferAccountOptions"
            :render-label="renderAccountLabel"
            placeholder="请选择转入账户"
            :disabled="saving"
          />
        </NFormItem>
      </div>

      <div class="ledger-form-grid">
        <NFormItem class="ledger-form-field" label="发生时间" :show-feedback="false" required>
          <LedgerDateTimePicker
            v-model="occurredAt"
            label="发生时间"
            :test-id="`${idPrefix}-occurred-at`"
            :disabled="saving"
          />
        </NFormItem>
        <NFormItem class="ledger-form-field" label="交易地点（可选）" :show-feedback="false">
          <NInput
            v-model:value="location"
            class="ledger-form-control"
            type="text"
            size="medium"
            maxlength="200"
            :input-props="{ id: `${idPrefix}-location`, name: 'location', autocomplete: 'off' }"
            :disabled="saving"
          />
        </NFormItem>
      </div>
    </template>

    <template v-else>
      <div class="ledger-readonly-fields" aria-label="交易财务字段只读">
        <span>金额：{{ readonlyAmount }}</span>
        <span>发生时间：{{ readonlyOccurredAt }}</span>
      </div>
      <NFormItem class="ledger-form-field" label="交易地点（可选）" :show-feedback="false">
        <NInput v-model:value="location" class="ledger-form-control" type="text" size="medium" maxlength="200" :disabled="saving" />
      </NFormItem>
    </template>

    <NFormItem v-if="showPayee" class="ledger-form-field" label="交易对象（可选）" :show-feedback="false">
      <NInput
        v-model:value="payee"
        class="ledger-form-control"
        type="text"
        size="medium"
        :input-props="{ id: `${idPrefix}-payee`, name: 'payee', autocomplete: 'off' }"
        :disabled="saving"
      />
    </NFormItem>

    <NFormItem class="ledger-form-field" label="备注（可选）" :show-feedback="false">
      <NInput
        v-model:value="note"
        class="ledger-form-control"
        type="textarea"
        size="medium"
        :input-props="{ id: `${idPrefix}-note`, name: 'note', rows: 3 }"
        :disabled="saving"
      />
    </NFormItem>
  </div>
</template>

<style scoped>
.ledger-transaction-form-fields { display: grid; gap: 12px; min-width: 0; }
.ledger-form-field { display: grid; gap: 4px; min-width: 0; }
.ledger-amount-field { margin-top: 12px; }
.ledger-form-field :deep(.n-form-item-label) { color: var(--text-h); font-size: .8rem; font-weight: 700; letter-spacing: .01em; }
.ledger-form-field :deep(.n-form-item-blank) { min-width: 0; }
.ledger-form-control { width: 100%; }
.ledger-form-field :deep(.ledger-form-control .n-input),
.ledger-form-field :deep(.ledger-form-control .n-base-selection),
.ledger-form-field :deep(.ledger-date-time-picker),
.ledger-form-field :deep(.ledger-date-time-picker .n-input-group) { width: 100%; }
.ledger-form-field :deep(.ledger-date-time-picker .n-date-picker),
.ledger-form-field :deep(.ledger-date-time-picker .n-time-picker) { min-width: 0; flex: 1 1 0; }
.ledger-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.ledger-transfer-amount-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 12px; }
.ledger-transfer-amount-grid .ledger-amount-field { margin-top: 0; }
.ledger-transfer-kind-field { grid-column: 1 / -1; }
.ledger-transfer-kinds { display: flex; width: 100%; height: 34px; box-sizing: border-box; gap: 2px; padding: 2px; border: 1px solid color-mix(in srgb, var(--border) 82%, transparent); border-radius: 9px; background: color-mix(in srgb, var(--bg) 54%, transparent); line-height: normal; white-space: normal; }
.ledger-transfer-kinds :deep(.n-radio-group__splitor) { display: none; }
.ledger-transfer-kinds :deep(.n-radio-button) { display: flex; height: 28px; min-width: 0; flex: 1 1 0; align-items: center; justify-content: center; box-sizing: border-box; padding: 0 8px; border: 0; border-radius: 7px; background: transparent; color: var(--text-muted); line-height: 28px; transition: background-color .18s ease, color .18s ease; }
.ledger-transfer-kinds :deep(.n-radio-button__state-border) { display: none; }
.ledger-transfer-kinds :deep(.n-radio__label) { width: 100%; text-align: center; }
.ledger-transfer-kinds :deep(.n-radio-button--checked) { background: color-mix(in srgb, var(--accent) 11%, transparent); color: var(--accent); font-weight: 700; }
.ledger-transfer-kinds :deep(.n-radio-button:not(.n-radio-button--checked):not(.n-radio-button--disabled):hover) { background: color-mix(in srgb, var(--accent) 6%, transparent); color: var(--text); }
.ledger-transfer-kinds :deep(.n-radio-button--focus:not(.n-radio-button--disabled)) { outline: none; }
.ledger-transfer-kinds :deep(.n-radio-button:has(.n-radio-input:focus-visible):not(.n-radio-button--disabled)) { outline: 2px solid var(--accent); outline-offset: 2px; z-index: 2; }
.ledger-fee-label-row { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 8px; }
.ledger-amount-label-row { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 8px; }
.ledger-received-amount { color: var(--accent); font-size: .72rem; font-weight: 650; }
.ledger-fee-mode-trigger { color: var(--accent); font-size: .72rem; font-weight: 650; }
.ledger-fee-mode-options { display: grid; gap: 2px; }
.ledger-fee-mode-options button { padding: 5px 7px; border: 0; border-radius: 5px; background: transparent; color: var(--text); cursor: pointer; font: inherit; font-size: .82rem; text-align: left; }
.ledger-fee-mode-options button:hover,
.ledger-fee-mode-options button[aria-checked="true"] { background: color-mix(in srgb, var(--accent) 10%, transparent); color: var(--accent); }
.ledger-money-input { display: flex; align-items: center; width: 100%; min-height: 34px; box-sizing: border-box; gap: 8px; padding: 2px 10px; border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--border)); border-radius: 8px; background: color-mix(in srgb, var(--bg) 78%, transparent); box-shadow: 0 3px 12px color-mix(in srgb, var(--accent) 5%, transparent); }
.ledger-money-input:focus-within { border-color: var(--accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 18%, transparent); }
.ledger-money-input > span { color: var(--accent); font-size: .78rem; font-weight: 750; }
.ledger-money-control { flex: 1; min-width: 0; font-size: .95rem; font-weight: 650; }
.ledger-money-field-control { display: grid; width: 100%; min-width: 0; gap: 4px; }
.ledger-amount-expression-row { display: flex; min-height: 21px; align-items: center; justify-content: space-between; gap: 8px; padding: 0 2px; }
.ledger-amount-expression-preview { min-width: 0; color: var(--text-muted); font-size: .72rem; line-height: 1.35; }
.ledger-amount-expression-operators { display: flex; flex: 0 0 auto; gap: 4px; }
.ledger-amount-expression-operators button { width: 25px; height: 21px; padding: 0; border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--border)); border-radius: 6px; background: color-mix(in srgb, var(--bg) 75%, transparent); color: var(--accent); cursor: pointer; font: inherit; font-size: .82rem; line-height: 1; }
.ledger-amount-expression-operators button:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 10%, var(--bg)); }
.ledger-amount-expression-operators button:disabled { cursor: default; opacity: .45; }
.ledger-readonly-fields { display: flex; flex-wrap: wrap; gap: 8px; color: var(--text-muted); font-size: .78rem; }
.ledger-readonly-fields span { padding: 6px 9px; border: 1px solid color-mix(in srgb, var(--border) 68%, transparent); border-radius: 7px; background: color-mix(in srgb, var(--bg-soft) 60%, transparent); }
.ledger-transaction-form-fields :deep(.n-base-selection-label__render-label),
.ledger-transaction-form-fields :deep(.n-base-selection-input__content),
.ledger-transaction-form-fields :deep(.n-base-selection-overlay__wrapper) { width: 100%; min-width: 0; }
.ledger-transaction-form-fields :deep(.n-base-selection-label__render-label),
.ledger-transaction-form-fields :deep(.n-base-selection-overlay__wrapper),
.ledger-transaction-form-fields :deep(.n-base-selection-input),
.ledger-transaction-form-fields :deep(.n-base-selection-input__content) { display: flex; height: 100%; align-items: center; }
@media (max-width: 600px) {
  .ledger-form-grid,
  .ledger-transfer-amount-grid { grid-template-columns: 1fr; }
}
</style>
