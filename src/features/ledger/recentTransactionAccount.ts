import type { LedgerTransactionDto } from '../../../shared/ledgerProtocol'
import type { AuthUser } from '../../lib/auth-api'
import { NUVYN_BROWSER_STORAGE_KEYS, ownerScopedStorageKey, readStorageKey, writeStorageKey } from '../../technicalNamespace'

const storageKey = NUVYN_BROWSER_STORAGE_KEYS.ledgerRecentTransactionAccount

export function readRecentTransactionAccount(owner: AuthUser | null): string {
  // The legacy unscoped key has no verifiable owner.
  return owner ? readStorageKey(ownerScopedStorageKey(storageKey, owner)) ?? '' : ''
}

export function rememberTransactionAccount(owner: AuthUser, transaction: LedgerTransactionDto): void {
  if (transaction.type !== 'income' && transaction.type !== 'expense') return
  if (typeof transaction.accountId !== 'string' || !transaction.accountId) return
  writeStorageKey(ownerScopedStorageKey(storageKey, owner), transaction.accountId)
}
