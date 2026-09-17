<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NForm, NFormItem, NInput, NSelect, type SelectOption } from 'naive-ui'
import type { LedgerAccountDto, LedgerAccountIcon as AccountIcon, LedgerAccountNature, LedgerAccountType } from '../../../shared/ledgerProtocol'
import { ledgerAccountTypeOptionsForNature } from '../../features/ledger/accountPresentation'
import { ledgerErrorMessage } from '../../features/ledger/ledgerErrors'
import { useLedgerStore } from '../../features/ledger/ledgerStore'
import { ledgerDecimalFromMinor, parseLedgerMoney } from '../../features/ledger/money'
import { ledgerSelectNodeProps } from '../../features/ledger/naiveControls'
import LedgerDatePicker from './LedgerDatePicker.vue'
import LedgerAccountIconPicker from './LedgerAccountIconPicker.vue'

const props = withDefaults(defineProps<{
  account: LedgerAccountDto
  hasHistory: boolean
  cancelable?: boolean
}>(), { cancelable: true })

const emit = defineEmits<{ saved: [account: LedgerAccountDto]; cancel: [] }>()
const store = useLedgerStore()

const name = ref('')
const note = ref('')
const cardNumber = ref('')
const icon = ref<AccountIcon>('wallet')
const nature = ref<LedgerAccountNature>('asset')
const type = ref<LedgerAccountType>('bank')
const openingBalance = ref('0')
const openingDate = ref('')
const error = ref('')
const submitted = ref(false)
const saving = ref(false)

const maskedCardNumber = computed(() => {
  const value = cardNumber.value.trim()
  if (value.length <= 8) return value
  return `${value.slice(0, 4)}${'*'.repeat(value.length - 8)}${value.slice(-4)}`
})

const financialFieldsEditable = computed(() => !props.hasHistory && props.account.archivedAt === null)
const natureOptions: SelectOption[] = [
  { value: 'asset', label: '资产（我拥有的）' },
  { value: 'liability', label: '负债（我需要偿还的）' },
]
const typeOptions = computed<SelectOption[]>(() => ledgerAccountTypeOptionsForNature(nature.value).map((option) => ({
  value: option.value,
  label: option.label,
})))

function reset(): void {
  name.value = props.account.name
  note.value = props.account.note
  cardNumber.value = props.account.cardNumber ?? ''
  icon.value = props.account.icon ?? 'wallet'
  nature.value = props.account.nature
  type.value = props.account.type
  openingBalance.value = ledgerDecimalFromMinor(props.account.openingBalanceMinor, props.account.currency)
  openingDate.value = props.account.openingDate
  error.value = ''
  submitted.value = false
}

watch(() => props.account, reset, { immediate: true })
watch(nature, (nextNature) => {
  if (!typeOptions.value.some((option) => option.value === type.value)) {
    type.value = (typeOptions.value[0]?.value as LedgerAccountType | undefined)
      ?? (nextNature === 'asset' ? 'bank' : 'credit_card')
  }
})

function validate(): number | null {
  submitted.value = true
  error.value = ''
  if (!name.value.trim()) {
    error.value = '请给账户起一个容易识别的名称。'
    return null
  }
  if (!financialFieldsEditable.value) return 0
  if (!/^\d{4}-\d{2}-\d{2}$/.test(openingDate.value)) {
    error.value = '请选择有效的期初日期。'
    return null
  }
  try {
    return parseLedgerMoney(openingBalance.value.trim() || '0', props.account.currency)
  } catch {
    error.value = `请输入有效的${props.account.currency}金额。`
    return null
  }
}

async function submit(): Promise<void> {
  if (saving.value) return
  const parsedOpeningBalance = validate()
  if (parsedOpeningBalance === null) return
  saving.value = true
  error.value = ''
  try {
    const body = financialFieldsEditable.value
      ? {
          expectedVersion: props.account.version,
          name: name.value.trim(),
          note: note.value.trim(),
          ...(cardNumber.value.trim() ? { cardNumber: cardNumber.value.trim() } : {}),
          ...(icon.value !== 'wallet' ? { icon: icon.value } : {}),
          type: type.value,
          nature: nature.value,
          openingBalanceMinor: parsedOpeningBalance,
          openingDate: openingDate.value,
        }
      : {
          expectedVersion: props.account.version,
          name: name.value.trim(),
          note: note.value.trim(),
          ...(cardNumber.value.trim() ? { cardNumber: cardNumber.value.trim() } : {}),
          ...(icon.value !== 'wallet' ? { icon: icon.value } : {}),
        }
    const updated = await store.patchAccount(props.account.id, body)
    emit('saved', updated)
  } catch (cause) {
    error.value = ledgerErrorMessage(cause, '账户没有保存，请刷新后重试。')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <NForm class="ledger-account-edit-form" data-testid="ledger-account-edit-form" :aria-busy="saving ? 'true' : undefined" @submit.prevent="submit">
    <div>
      <h2 id="ledger-account-edit-title">编辑账户</h2>
      <p class="ledger-form-info">{{ props.account.currency }} · {{ store.settings.value?.timezone ?? 'UTC' }}</p>
    </div>

    <NFormItem class="ledger-form-field" label="卡号（可选）" :show-feedback="false">
      <NInput
        :value="maskedCardNumber"
        class="ledger-form-control"
        type="text"
        size="medium"
        disabled
        :input-props="{ id: 'ledger-edit-account-card-number', name: 'cardNumber', inputmode: 'numeric', autocomplete: 'off', disabled: true }"
        placeholder="请输入卡号"
      />
    </NFormItem>

    <NFormItem class="ledger-form-field" label="账户名称" :show-feedback="false" required>
      <NInput
        v-model:value="name"
        class="ledger-form-control"
        type="text"
        size="medium"
        :input-props="{ id: 'ledger-edit-account-name', name: 'name', required: true }"
        :disabled="saving"
      >
        <template #suffix>
          <LedgerAccountIconPicker v-model="icon" :disabled="saving" />
        </template>
      </NInput>
    </NFormItem>

    <div class="ledger-form-grid">
      <NFormItem class="ledger-form-field" label="账户性质" :show-feedback="false" required>
        <NSelect
          v-model:value="nature"
          class="ledger-form-control"
          size="medium"
          :options="natureOptions"
          :node-props="ledgerSelectNodeProps"
          :input-props="{ id: 'ledger-edit-account-nature', name: 'nature' }"
          aria-label="账户性质"
          aria-haspopup="listbox"
          role="combobox"
          :disabled="saving || !financialFieldsEditable"
        />
      </NFormItem>
      <NFormItem class="ledger-form-field" label="账户类型" :show-feedback="false" required>
        <NSelect
          v-model:value="type"
          class="ledger-form-control"
          size="medium"
          :options="typeOptions"
          :node-props="ledgerSelectNodeProps"
          :input-props="{ id: 'ledger-edit-account-type', name: 'type' }"
          aria-label="账户类型"
          aria-haspopup="listbox"
          role="combobox"
          :disabled="saving || !financialFieldsEditable"
        />
      </NFormItem>
      <NFormItem class="ledger-form-field" label="期初余额" :show-feedback="false">
        <NInput
          v-model:value="openingBalance"
          class="ledger-form-control"
          type="text"
          size="medium"
          :input-props="{ id: 'ledger-edit-account-opening-balance', name: 'openingBalance', inputmode: 'decimal' }"
          :disabled="saving || !financialFieldsEditable"
        />
      </NFormItem>
      <NFormItem class="ledger-form-field" label="期初日期" :show-feedback="false" required>
        <LedgerDatePicker
          v-model="openingDate"
          label="期初日期"
          test-id="ledger-edit-account-opening-date"
          :disabled="saving || !financialFieldsEditable"
        />
      </NFormItem>
    </div>

    <NFormItem class="ledger-form-field" label="备注（可选）" :show-feedback="false">
      <NInput
        v-model:value="note"
        class="ledger-form-control"
        type="textarea"
        size="medium"
        :input-props="{ id: 'ledger-edit-account-note', name: 'note', rows: 3 }"
        :disabled="saving"
      />
    </NFormItem>

    <p v-if="error" class="ledger-form-error" role="alert">{{ error }}</p>
    <div class="ledger-form-actions">
      <NButton v-if="props.cancelable" class="ledger-secondary-button" attr-type="button" size="small" :bordered="false" :disabled="saving" @click="emit('cancel')">取消</NButton>
      <NButton class="ledger-primary-button" attr-type="submit" type="primary" size="small" :bordered="false" :disabled="saving">{{ saving ? '保存中…' : '保存' }}</NButton>
    </div>
  </NForm>
</template>

<style scoped>
.ledger-account-edit-form { display: grid; gap: 18px; width: min(100%, 620px); box-sizing: border-box; padding: 28px; border: 1px solid var(--border); border-radius: 14px; background: var(--bg-soft); }
.ledger-eyebrow { margin: 0 0 6px; color: var(--accent); font-size: .75rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
.ledger-account-edit-form h2 { margin: 0; color: var(--text-h); font-size: 1.35rem; }
.ledger-form-info { margin: 9px 0 0; color: var(--text-muted); font-size: .81rem; line-height: 1.5; }
.ledger-form-history { margin: 8px 0 0; color: var(--text-muted); font-size: .78rem; line-height: 1.5; }
.ledger-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.ledger-form-field { display: grid; gap: 6px; }
.ledger-form-field :deep(.n-form-item-label) { color: var(--text-h); font-size: .83rem; font-weight: 650; }
.ledger-form-control { width: 100%; }
.ledger-account-name-icon { color: var(--text-muted); opacity: .82; }
.ledger-form-field :deep(.ledger-form-control .n-input),
.ledger-form-field :deep(.ledger-form-control .n-base-selection),
.ledger-form-field :deep(.ledger-date-picker) { width: 100%; }
.ledger-form-field :deep(.ledger-date-picker .n-input) { width: 100%; }
.ledger-form-error { margin: 0; color: #b42318; font-size: .82rem; }
.ledger-form-actions { display: flex; justify-content: flex-end; gap: 9px; }
.ledger-primary-button,
.ledger-secondary-button { min-height: 32px; padding: 6px 12px; border-radius: 7px; font: inherit; font-size: .78rem; font-weight: 650; cursor: pointer; }
.ledger-primary-button { border: 1px solid var(--accent); background: var(--accent); color: #fff; }
.ledger-primary-button:hover:not(:disabled) { background: var(--accent-hover); }
.ledger-secondary-button { border: 1px solid var(--border); background: var(--bg); color: var(--text-h); }
.ledger-secondary-button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.ledger-primary-button:disabled,
.ledger-secondary-button:disabled { cursor: wait; opacity: .65; }
@media (max-width: 620px) {
  .ledger-account-edit-form { padding: 23px 18px; }
  .ledger-form-grid { grid-template-columns: 1fr; }
  .ledger-form-actions > * { flex: 1 1 150px; }
}
</style>
