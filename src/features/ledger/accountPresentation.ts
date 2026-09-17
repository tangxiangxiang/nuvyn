import type { LedgerAccountNature, LedgerAccountType } from '../../../shared/ledgerProtocol'

/**
 * These labels are presentation metadata only. The server remains the
 * authority for whether a type/nature pair is legal.
 */
export const LEDGER_ACCOUNT_TYPE_OPTIONS: ReadonlyArray<{
  readonly value: LedgerAccountType
  readonly label: string
  readonly natures: readonly LedgerAccountNature[]
}> = [
  { value: 'cash', label: '现金', natures: ['asset'] },
  { value: 'bank', label: '银行账户', natures: ['asset'] },
  { value: 'wallet', label: '电子钱包', natures: ['asset'] },
  { value: 'credit_card', label: '信用卡', natures: ['liability'] },
  { value: 'loan', label: '贷款', natures: ['liability'] },
  { value: 'other', label: '其他', natures: ['asset', 'liability'] },
]

export function ledgerAccountTypeOptionsForNature(
  nature: LedgerAccountNature,
): ReadonlyArray<{ readonly value: LedgerAccountType; readonly label: string }> {
  return LEDGER_ACCOUNT_TYPE_OPTIONS
    .filter((option) => option.natures.includes(nature))
    .map(({ value, label }) => ({ value, label }))
}

