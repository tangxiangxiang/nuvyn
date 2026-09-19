import type {
  LedgerCashflowSummary,
  LedgerTransactionDto,
} from '../../../shared/ledgerProtocol'

export type LedgerTransactionPresentationKind =
  | 'income'
  | 'expense'
  | 'repayment'
  | 'transfer'
  | 'adjustment'

export function ledgerTransactionPresentationKind(
  transaction: LedgerTransactionDto,
): LedgerTransactionPresentationKind {
  if (transaction.type === 'transfer' && transaction.transferKind === 'repayment') return 'repayment'
  return transaction.type
}

function assertSafeMinor(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} must be a safe integer`)
}

function checkedAddMinor(left: number, right: number): number {
  assertSafeMinor(left, 'leftMinor')
  assertSafeMinor(right, 'rightMinor')
  const result = left + right
  assertSafeMinor(result, 'minor amount sum')
  return result
}

function checkedSubMinor(left: number, right: number): number {
  assertSafeMinor(left, 'leftMinor')
  assertSafeMinor(right, 'rightMinor')
  const result = left - right
  assertSafeMinor(result, 'minor amount difference')
  return result
}

export function ledgerPresentationOutflowMinor(
  summary: Pick<LedgerCashflowSummary, 'expenseMinor' | 'repaymentMinor'>,
): number {
  return checkedAddMinor(summary.expenseMinor, summary.repaymentMinor)
}

export function ledgerPresentationBalanceMinor(
  summary: Pick<LedgerCashflowSummary, 'incomeMinor' | 'expenseMinor' | 'repaymentMinor'>,
): number {
  return checkedSubMinor(summary.incomeMinor, ledgerPresentationOutflowMinor(summary))
}
