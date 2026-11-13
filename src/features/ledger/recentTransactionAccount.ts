import type { LedgerTransactionDto } from '../../../shared/ledgerProtocol'

const storageKey = 'nuvyn.ledger.recent-transaction-account'

export function readRecentTransactionAccount(): string {
  try {
    return localStorage.getItem(storageKey) ?? ''
  } catch {
    return ''
  }
}

export function rememberTransactionAccount(transaction: LedgerTransactionDto): void {
  if (transaction.type !== 'income' && transaction.type !== 'expense') return
  if (typeof transaction.accountId !== 'string' || !transaction.accountId) return
  try {
    localStorage.setItem(storageKey, transaction.accountId)
  } catch {
    // The preference is optional when browser storage is unavailable.
  }
}
