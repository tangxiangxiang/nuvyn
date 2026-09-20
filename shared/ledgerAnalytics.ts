import type { LedgerTransactionType, LedgerTransferKind } from './ledgerProtocol'

/**
 * Statistics inclusion is an analytics concern, not an accounting concern.
 * Keep this predicate free of browser, server, and persistence dependencies so
 * every read surface agrees on which transaction rows may be excluded.
 */
export function ledgerTransactionContributesToStatistics(transaction: {
  readonly type: LedgerTransactionType
  readonly transferKind?: LedgerTransferKind | null
}): boolean {
  return transaction.type === 'income'
    || transaction.type === 'expense'
    || (transaction.type === 'transfer' && transaction.transferKind === 'repayment')
}
