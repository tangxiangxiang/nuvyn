import type {
  LedgerAccountDto,
  LedgerAdjustmentTransactionDto,
  LedgerExpenseTransactionDto,
  LedgerIncomeTransactionDto,
  LedgerTransactionDto,
  LedgerTransferTransactionDto,
} from './ledgerProtocol.js'

export type LedgerAnalysisAccountDto = Pick<LedgerAccountDto,
  | 'id' | 'name' | 'nature' | 'type'
  | 'openingBalanceMinor' | 'openingDate' | 'currentBalanceMinor'
  | 'currency' | 'currencyExponent' | 'note' | 'archivedAt'
>

type LedgerAnalysisExpenseDto = Omit<LedgerExpenseTransactionDto, 'amountMinor'> & {
  /** Signed in the analysis export so repayment rebates net against interest without appearing as income. */
  readonly amountMinor: number
}

export type LedgerAnalysisTransactionDto = (
  | LedgerIncomeTransactionDto
  | LedgerAnalysisExpenseDto
  | Omit<LedgerTransferTransactionDto, 'bundle'>
  | LedgerAdjustmentTransactionDto
) & {
  readonly categoryName?: string | null
  readonly accountName?: string | null
  readonly fromAccountName?: string | null
  readonly toAccountName?: string | null
}

export interface LedgerAnalysisExportDto {
  readonly version: 1
  readonly exportedAt: string
  readonly currency: string
  readonly timezone: string
  readonly accounts: readonly LedgerAnalysisAccountDto[]
  readonly transactions: readonly LedgerAnalysisTransactionDto[]
}

export function toLedgerAnalysisTransaction(
  transaction: LedgerTransactionDto,
  accountNames: ReadonlyMap<string, string>,
  categoryNames: ReadonlyMap<string, string>,
): LedgerAnalysisTransactionDto {
  if (transaction.type === 'transfer') {
    // Export each accounting row, not the list's calculated bundle total.
    const { bundle: _bundle, ...principal } = transaction
    return {
      ...principal,
      fromAccountName: accountNames.get(transaction.fromAccountId) ?? null,
      toAccountName: accountNames.get(transaction.toAccountId) ?? null,
    }
  }
  if (transaction.type === 'income' && transaction.groupId !== undefined) {
    // The stored income row restores the source account balance. Export it
    // as a signed expense adjustment so reports show net interest, not
    // artificial income, while preserving the same account movement.
    return {
      ...transaction,
      type: 'expense',
      amountMinor: -transaction.amountMinor,
      accountName: accountNames.get(transaction.accountId) ?? null,
      categoryName: categoryNames.get(transaction.categoryId) ?? null,
    }
  }
  return {
    ...transaction,
    accountName: accountNames.get(transaction.accountId) ?? null,
    ...(transaction.type === 'income' || transaction.type === 'expense'
      ? { categoryName: categoryNames.get(transaction.categoryId) ?? null }
      : {}),
  }
}
