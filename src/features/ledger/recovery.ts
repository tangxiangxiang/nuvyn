import type {
  LedgerAccountCreateRequest,
  LedgerCategoryCreateRequest,
  LedgerSettingsCreateRequest,
  LedgerTransactionCreateRequest,
} from '../../../shared/ledgerProtocol'
import { NUVYN_BROWSER_STORAGE_KEYS } from '../../technicalNamespace'

export const LEDGER_PENDING_CREATE_STORAGE_KEY = NUVYN_BROWSER_STORAGE_KEYS.ledgerPendingCreate
export const LEDGER_RECOVERY_SCHEMA_VERSION = 1 as const

export type LedgerCreateOperation = 'settings' | 'account' | 'category' | 'transaction'
export type LedgerCreatePayload =
  | LedgerSettingsCreateRequest
  | LedgerAccountCreateRequest
  | LedgerCategoryCreateRequest
  | LedgerTransactionCreateRequest

export interface LedgerPendingCreateIntent {
  readonly version: typeof LEDGER_RECOVERY_SCHEMA_VERSION
  readonly operation: LedgerCreateOperation
  readonly operationScope: string
  readonly idempotencyKey: string
  readonly canonicalPayload: LedgerCreatePayload
  readonly createdAt: number
  /** A non-secret owner hint prevents replay into a different owner session. */
  readonly ownerIdentity: string | null
}

export type LedgerPendingCreateReadResult =
  | { readonly status: 'none' }
  | { readonly status: 'valid'; readonly intent: LedgerPendingCreateIntent }
  | { readonly status: 'invalid'; readonly reason: string }
  | { readonly status: 'unavailable'; readonly reason: string }

export type LedgerRecoveryWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function storage(): StorageLike | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isOperation(value: unknown): value is LedgerCreateOperation {
  return value === 'settings' || value === 'account' || value === 'category' || value === 'transaction'
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function safeDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function safeLedgerIcon(value: unknown): boolean {
  return typeof value === 'string'
    && (['wallet', 'credit_card', 'cash', 'building_bank', 'briefcase'].includes(value)
      || /^custom_[a-z0-9_]+$/.test(value))
}

function isSafeSettingsPayload(value: unknown): value is LedgerSettingsCreateRequest {
  return isRecord(value)
    && hasExactKeys(value, ['baseCurrency', 'timezone'])
    && nonEmptyString(value.baseCurrency)
    && nonEmptyString(value.timezone)
}

function isSafeAccountPayload(value: unknown): value is LedgerAccountCreateRequest {
  return isRecord(value)
    && hasExactKeys(value, [
      'name', 'type', 'nature', 'openingBalanceMinor', 'openingDate', 'currency', 'note',
      ...(Object.prototype.hasOwnProperty.call(value, 'icon') ? ['icon'] : []),
      ...(Object.prototype.hasOwnProperty.call(value, 'cardNumber') ? ['cardNumber'] : []),
    ])
    && nonEmptyString(value.name)
    && (value.type === 'cash'
      || value.type === 'bank'
      || value.type === 'wallet'
      || value.type === 'credit_card'
      || value.type === 'loan'
      || value.type === 'other')
    && (value.nature === 'asset' || value.nature === 'liability')
    && safeInteger(value.openingBalanceMinor)
    && safeDate(value.openingDate)
    && nonEmptyString(value.currency)
    && typeof value.note === 'string'
    && (value.icon === undefined || safeLedgerIcon(value.icon))
    && (value.cardNumber === undefined || typeof value.cardNumber === 'string')
}

function isSafeCategoryPayload(value: unknown): value is LedgerCategoryCreateRequest {
  return isRecord(value)
    && (hasExactKeys(value, ['kind', 'name']) || hasExactKeys(value, ['kind', 'name', 'icon']))
    && (value.kind === 'income' || value.kind === 'expense')
    && nonEmptyString(value.name)
    && (value.icon === undefined || safeLedgerIcon(value.icon))
}

function isSafeTransactionPayload(value: unknown): value is LedgerTransactionCreateRequest {
  if (!isRecord(value) || !safeInteger(value.amountMinor) || value.amountMinor <= 0
    || !safeInteger(value.occurredAt) || typeof value.note !== 'string') {
    return false
  }

  if (value.type === 'income' || value.type === 'expense') {
    return (hasExactKeys(value, ['type', 'amountMinor', 'accountId', 'categoryId', 'occurredAt', 'location', 'payee', 'note'])
      || hasExactKeys(value, ['type', 'amountMinor', 'accountId', 'categoryId', 'occurredAt', 'payee', 'note']))
      && nonEmptyString(value.accountId)
      && nonEmptyString(value.categoryId)
      && (value.location === undefined || typeof value.location === 'string')
      && typeof value.payee === 'string'
      && typeof value.note === 'string'
  }

  if (value.type === 'transfer') {
    const allowedKeys = new Set([
      'type', 'transferKind', 'amountMinor', 'feeMinor', 'feeMode',
      'fromAccountId', 'toAccountId', 'occurredAt', 'location', 'payee', 'note',
    ])
    const requiredKeys = ['type', 'amountMinor', 'fromAccountId', 'toAccountId', 'occurredAt', 'note']
    return requiredKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
      && Object.keys(value).every((key) => allowedKeys.has(key))
      && nonEmptyString(value.fromAccountId)
      && nonEmptyString(value.toAccountId)
      && value.fromAccountId !== value.toAccountId
      && (value.transferKind === undefined || value.transferKind === 'general' || value.transferKind === 'repayment' || value.transferKind === 'withdrawal')
      && (value.feeMinor === undefined || safeInteger(value.feeMinor) && value.feeMinor >= 0)
      && (value.feeMode === undefined || value.feeMode === 'extra' || value.feeMode === 'deducted')
      && (value.location === undefined || typeof value.location === 'string')
      && (value.payee === undefined || typeof value.payee === 'string')
      && typeof value.note === 'string'
  }

  return false
}

function isSafePayload(
  operation: LedgerCreateOperation,
  value: unknown,
): value is LedgerCreatePayload {
  switch (operation) {
    case 'settings': return isSafeSettingsPayload(value)
    case 'account': return isSafeAccountPayload(value)
    case 'category': return isSafeCategoryPayload(value)
    case 'transaction': return isSafeTransactionPayload(value)
  }
}

export function isLedgerPendingCreateIntent(value: unknown): value is LedgerPendingCreateIntent {
  if (!isRecord(value)) return false
  return value.version === LEDGER_RECOVERY_SCHEMA_VERSION
    && isOperation(value.operation)
    && value.operationScope === ledgerOperationScope(value.operation)
    && typeof value.idempotencyKey === 'string'
    && value.idempotencyKey.length > 0
    && isSafePayload(value.operation, value.canonicalPayload)
    && typeof value.createdAt === 'number'
    && Number.isSafeInteger(value.createdAt)
    && (value.ownerIdentity === null || typeof value.ownerIdentity === 'string')
}

export function readLedgerPendingCreate(): LedgerPendingCreateReadResult {
  const store = storage()
  if (!store) return { status: 'unavailable', reason: 'sessionStorage is unavailable.' }
  let raw: string | null
  try {
    raw = store.getItem(LEDGER_PENDING_CREATE_STORAGE_KEY)
  } catch {
    return { status: 'unavailable', reason: 'sessionStorage cannot be read.' }
  }
  if (raw === null) return { status: 'none' }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isLedgerPendingCreateIntent(parsed)) {
      return { status: 'invalid', reason: 'The pending Ledger create record failed validation.' }
    }
    return { status: 'valid', intent: parsed }
  } catch {
    return { status: 'invalid', reason: 'The pending Ledger create record is not valid JSON.' }
  }
}

export function writeLedgerPendingCreate(intent: LedgerPendingCreateIntent): LedgerRecoveryWriteResult {
  const store = storage()
  if (!store) return { ok: false, reason: '当前标签页无法使用 sessionStorage。' }
  const serialized = JSON.stringify(intent)
  try {
    store.setItem(LEDGER_PENDING_CREATE_STORAGE_KEY, serialized)
    if (store.getItem(LEDGER_PENDING_CREATE_STORAGE_KEY) !== serialized) {
      return { ok: false, reason: 'sessionStorage 没有可靠保存记账恢复状态。' }
    }
    return { ok: true }
  } catch {
    return { ok: false, reason: '当前标签页无法保存 sessionStorage 恢复状态。' }
  }
}

export function clearLedgerPendingCreate(): void {
  const store = storage()
  if (!store) return
  try { store.removeItem(LEDGER_PENDING_CREATE_STORAGE_KEY) } catch { /* ignore */ }
}

export function ledgerOperationScope(operation: LedgerCreateOperation): string {
  switch (operation) {
    case 'settings': return 'POST:/api/ledger/settings'
    case 'account': return 'POST:/api/ledger/accounts'
    case 'category': return 'POST:/api/ledger/categories'
    case 'transaction': return 'POST:/api/ledger/transactions'
  }
}

export function createLedgerPendingIntent(
  operation: LedgerCreateOperation,
  canonicalPayload: LedgerCreatePayload,
  idempotencyKey: string,
  ownerIdentity: string | null,
  createdAt = Date.now(),
): LedgerPendingCreateIntent {
  return {
    version: LEDGER_RECOVERY_SCHEMA_VERSION,
    operation,
    operationScope: ledgerOperationScope(operation),
    idempotencyKey,
    canonicalPayload,
    createdAt,
    ownerIdentity,
  }
}
