<script setup lang="ts">
import { computed, ref, watch, type VNodeChild } from 'vue'
import { NButton, NFormItem, NInput, NPopover, NRadioButton, NRadioGroup, NSelect, type InputInst, type SelectGroupOption, type SelectOption } from 'naive-ui'
import type { LedgerTransferFeeMode, LedgerTransferKind } from '../../../shared/ledgerProtocol'
import { formatLedgerMoney, parseLedgerMoney } from '../../features/ledger/money'
import { ledgerSelectNodeProps } from '../../features/ledger/naiveControls'
import LedgerDateTimePicker from './LedgerDateTimePicker.vue'

type TransactionFormType = 'income' | 'expense' | 'transfer'
type AccountOptionRenderer = (option: SelectOption | SelectGroupOption, selected?: boolean) => VNodeChild
type CategoryOptionRenderer = (option: SelectOption) => VNodeChild

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
  categoryOptions: SelectOption[]
  renderAccountLabel?: AccountOptionRenderer
  renderCategoryLabel?: CategoryOptionRenderer
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
const feeModePopoverOpen = ref(false)
const idPrefix = props.mode === 'create' ? 'ledger-transaction' : 'ledger-edit-transaction'

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
    const amountMinor = parseLedgerMoney(amount.value, props.currency)
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
    const amountMinor = parseLedgerMoney(amount.value, props.currency)
    const feeMinor = transferFeeAmount.value.trim()
      ? parseLedgerMoney(transferFeeAmount.value, props.currency)
      : 0
    if (amountMinor < 0 || feeMinor < 0) return null
    return formatLedgerMoney(amountMinor + feeMinor, props.currency)
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
              <span v-if="repaymentTotalAmount" class="ledger-received-amount">总扣款 {{ repaymentTotalAmount }}</span>
              <span v-if="withdrawalReceivedAmount" class="ledger-received-amount">实际到账 {{ withdrawalReceivedAmount }}</span>
            </div>
          </template>
          <div class="ledger-money-input">
            <span>{{ currency }}</span>
            <NInput
              ref="amountInput"
              v-model:value="amount"
              class="ledger-money-control"
              type="text"
              size="small"
              :allow-input="allowAmountInput"
              :bordered="false"
              :input-props="{ id: `${idPrefix}-amount`, name: 'amount', inputmode: 'decimal', autocomplete: 'off', required: true }"
              placeholder="0.00"
              :disabled="saving"
            />
          </div>
        </NFormItem>

        <NFormItem v-if="type === 'transfer' && transferKind !== 'general'" class="ledger-form-field" :show-feedback="false">
          <template #label>
            <div class="ledger-fee-label-row">
              <span>{{ transferKind === 'repayment' ? '利息（可选）' : '手续费（可选）' }}</span>
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
              :allow-input="allowAmountInput"
              :bordered="false"
              :input-props="{ id: `${idPrefix}-fee-amount`, name: 'feeAmount', inputmode: 'decimal', autocomplete: 'off' }"
              placeholder="0.00"
              :disabled="saving"
            />
          </div>
        </NFormItem>
      </div>

      <div v-if="type !== 'transfer'" class="ledger-form-grid">
        <NFormItem class="ledger-form-field" label="账户" :show-feedback="false" required>
          <NSelect
            v-model:value="accountId"
            class="ledger-form-control"
            size="medium"
            :options="accountOptions"
            :render-label="renderAccountLabel"
            :node-props="ledgerSelectNodeProps"
            :input-props="{ id: `${idPrefix}-account`, name: 'accountId', required: true }"
            aria-label="账户"
            aria-haspopup="listbox"
            role="combobox"
            placeholder="请选择账户"
            :disabled="saving"
          />
        </NFormItem>

        <NFormItem class="ledger-form-field" label="分类" :show-feedback="false" required>
          <NSelect
            v-model:value="categoryId"
            class="ledger-form-control"
            size="medium"
            :options="categoryOptions"
            :render-label="renderCategoryLabel"
            :node-props="ledgerSelectNodeProps"
            :input-props="{ id: `${idPrefix}-category`, name: 'categoryId', required: true }"
            aria-label="分类"
            aria-haspopup="listbox"
            role="combobox"
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
          <NSelect
            v-model:value="fromAccountId"
            class="ledger-form-control"
            size="medium"
            :options="transferFromAccountOptions ?? transferAccountOptions"
            :render-label="renderAccountLabel"
            :node-props="ledgerSelectNodeProps"
            :input-props="{ id: `${idPrefix}-from-account`, name: 'fromAccountId', required: true }"
            aria-label="转出账户"
            aria-haspopup="listbox"
            role="combobox"
            placeholder="请选择转出账户"
            :disabled="saving"
          />
        </NFormItem>
        <NFormItem class="ledger-form-field" label="转入账户" :show-feedback="false" required>
          <NSelect
            v-model:value="toAccountId"
            class="ledger-form-control"
            size="medium"
            :options="transferToAccountOptions ?? transferAccountOptions"
            :render-label="renderAccountLabel"
            :node-props="ledgerSelectNodeProps"
            :input-props="{ id: `${idPrefix}-to-account`, name: 'toAccountId', required: true }"
            aria-label="转入账户"
            aria-haspopup="listbox"
            role="combobox"
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
.ledger-transfer-kinds { display: flex; width: 100%; }
.ledger-transfer-kinds :deep(.n-radio-button) { display: flex; min-width: 0; flex: 1 1 0; justify-content: center; }
.ledger-transfer-kinds :deep(.n-radio-button__label) { width: 100%; text-align: center; }
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
