/**
 * Server-owned Ledger domain objects.
 *
 * SQLite rows are intentionally treated as untrusted persistence input. They
 * use snake_case nullable discriminator columns; this module is the boundary
 * that turns them into the non-nullable discriminated domain union consumed by
 * later Ledger layers.
 */

import {
  isSupportedLedgerCurrency,
  normalizeLedgerCurrencyCode,
} from '../../shared/ledgerCurrency.js'
import { normalizeLedgerCategoryName } from '../../shared/ledgerNormalization.js'
import type {
  LedgerAccountNature,
  LedgerAccountIcon,
  LedgerAccountIconConfig,
  LedgerAccountType,
  LedgerCategoryKind,
  LedgerTransferFeeMode,
  LedgerTransferKind,
} from '../../shared/ledgerProtocol.js'
import { LEDGER_BUILTIN_ACCOUNT_ICON_NAMES, LEDGER_DEFAULT_ACCOUNT_ICONS, type LedgerCategorySystemKey } from '../../shared/ledgerProtocol.js'
import {
  assertPositiveMinor,
  assertSafeMinor,
  checkedSubMinor,
} from './money.js'
import {
  assertOpeningDate,
  assertUtcMilliseconds,
  isIanaTimeZoneId,
} from './time.js'
import { ledgerValidationError } from './errors.js'
import {
  LEDGER_ACCOUNT_NATURES,
  LEDGER_ACCOUNT_TYPES,
  LEDGER_CATEGORY_KINDS,
  LEDGER_TRANSACTION_TYPES,
  LEDGER_TRANSFER_KINDS,
} from './validation.js'

type UnknownRow = Record<string, unknown>

/** The untrusted snake_case shape returned by a Ledger SELECT. */
export interface LedgerSettingsRow {
  readonly singleton_id?: unknown
  readonly base_currency?: unknown
  readonly timezone?: unknown
  readonly has_created_account?: unknown
  readonly version?: unknown
  readonly created_at?: unknown
  readonly updated_at?: unknown
  readonly account_icon_default?: unknown
  readonly account_icon_available_json?: unknown
  readonly account_icon_archived_json?: unknown
  readonly account_icon_custom_json?: unknown
  readonly account_icon_names_json?: unknown
  readonly [column: string]: unknown
}

/** The untrusted snake_case shape returned by a Ledger SELECT. */
export interface LedgerAccountRow {
  readonly id?: unknown
  readonly name?: unknown
  readonly type?: unknown
  readonly nature?: unknown
  readonly opening_balance_minor?: unknown
  readonly opening_date?: unknown
  readonly currency?: unknown
  readonly note?: unknown
  readonly archived_at?: unknown
  readonly version?: unknown
  readonly created_at?: unknown
  readonly updated_at?: unknown
  readonly [column: string]: unknown
}

/** The untrusted snake_case shape returned by a Ledger SELECT. */
export interface LedgerCategoryRow {
  readonly id?: unknown
  readonly kind?: unknown
  readonly name?: unknown
  readonly normalized_name?: unknown
  readonly system_key?: unknown
  readonly icon?: unknown
  readonly is_default?: unknown
  readonly sort_order?: unknown
  readonly archived_at?: unknown
  readonly version?: unknown
  readonly created_at?: unknown
  readonly updated_at?: unknown
  readonly [column: string]: unknown
}

/** The untrusted snake_case shape returned by a Ledger SELECT. */
export interface LedgerTransactionRow {
  readonly id?: unknown
  readonly type?: unknown
  readonly transfer_kind?: unknown
  readonly group_id?: unknown
  readonly transfer_fee_mode?: unknown
  readonly amount_minor?: unknown
  readonly account_id?: unknown
  readonly from_account_id?: unknown
  readonly to_account_id?: unknown
  readonly category_id?: unknown
  readonly occurred_at?: unknown
  readonly location?: unknown
  readonly payee?: unknown
  readonly note?: unknown
  readonly adjustment_calculated_balance_minor?: unknown
  readonly adjustment_target_balance_minor?: unknown
  readonly deleted_at?: unknown
  readonly version?: unknown
  readonly created_at?: unknown
  readonly updated_at?: unknown
  readonly [column: string]: unknown
}

export interface LedgerSettings {
  readonly baseCurrency: string
  readonly timezone: string
  readonly hasCreatedAccount: boolean
  readonly version: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly accountIcons: LedgerAccountIconConfig
}

export interface LedgerAccount {
  readonly id: string
  readonly name: string
  readonly type: LedgerAccountType
  readonly nature: LedgerAccountNature
  readonly icon?: LedgerAccountIcon
  readonly openingBalanceMinor: number
  readonly openingDate: string
  readonly currency: string
  readonly note: string
  readonly cardNumber?: string
  readonly archivedAt: number | null
  readonly version: number
  readonly createdAt: number
  readonly updatedAt: number
}

export interface LedgerCategory {
  readonly id: string
  readonly kind: LedgerCategoryKind
  readonly name: string
  readonly normalizedName: string
  readonly systemKey?: LedgerCategorySystemKey
  /** Built-in categories cannot be renamed, archived, or deleted. */
  readonly isDefault?: boolean
  readonly icon?: LedgerAccountIcon
  readonly sortOrder?: number
  readonly archivedAt: number | null
  readonly version: number
  readonly createdAt: number
  readonly updatedAt: number
}

export interface LedgerTransactionBase {
  readonly id: string
  readonly groupId?: string
  readonly amountMinor: number
  readonly occurredAt: number
  readonly location?: string
  readonly note: string
  readonly deletedAt: number | null
  readonly version: number
  readonly createdAt: number
  readonly updatedAt: number
}

export interface IncomeTransaction extends LedgerTransactionBase {
  readonly type: 'income'
  readonly accountId: string
  readonly categoryId: string
  readonly payee: string
}

export interface ExpenseTransaction extends LedgerTransactionBase {
  readonly type: 'expense'
  readonly accountId: string
  readonly categoryId: string
  readonly payee: string
}

export interface TransferTransaction extends LedgerTransactionBase {
  readonly type: 'transfer'
  readonly transferKind: LedgerTransferKind
  readonly feeMode?: LedgerTransferFeeMode
  readonly fromAccountId: string
  readonly toAccountId: string
  readonly payee: string
}

export interface AdjustmentTransaction extends LedgerTransactionBase {
  readonly type: 'adjustment'
  readonly accountId: string
  readonly adjustmentCalculatedBalanceMinor: number
  readonly adjustmentTargetBalanceMinor: number
}

export type LedgerTransaction =
  | IncomeTransaction
  | ExpenseTransaction
  | TransferTransaction
  | AdjustmentTransaction

/** The one reusable Account type/nature pairing authority. */
const ACCOUNT_NATURES_BY_TYPE: Readonly<Record<LedgerAccountType, readonly LedgerAccountNature[]>> = {
  cash: ['asset'],
  bank: ['asset'],
  wallet: ['asset'],
  credit_card: ['liability'],
  loan: ['liability'],
  other: ['asset', 'liability'],
}

export function isLedgerAccountTypeNature(type: unknown, nature: unknown): boolean {
  if (typeof type !== 'string' || typeof nature !== 'string') return false
  if (!Object.prototype.hasOwnProperty.call(ACCOUNT_NATURES_BY_TYPE, type)) return false
  const allowedNatures = ACCOUNT_NATURES_BY_TYPE[type as LedgerAccountType]
  return allowedNatures.includes(nature as LedgerAccountNature)
}

export function assertLedgerAccountTypeNature(
  type: LedgerAccountType,
  nature: LedgerAccountNature,
): void {
  if (!isLedgerAccountTypeNature(type, nature)) {
    throw ledgerValidationError('Account type and nature are not a valid Ledger pairing', {
      field: 'nature',
    })
  }
}

function invalidRow(entity: string, field: string, reason: string): never {
  throw ledgerValidationError(`invalid persisted Ledger ${entity} row`, {
    entity,
    field,
    reason,
  })
}

function asRow(value: unknown, entity: string): UnknownRow {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalidRow(entity, 'row', 'row must be an object')
  }
  return value as UnknownRow
}

function hasOwn(row: UnknownRow, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(row, field)
}

function valueAt(row: UnknownRow, entity: string, field: string): unknown {
  if (!hasOwn(row, field)) return invalidRow(entity, field, 'column is missing')
  return row[field]
}

function requiredString(row: UnknownRow, entity: string, field: string): string {
  const value = valueAt(row, entity, field)
  if (typeof value !== 'string') return invalidRow(entity, field, 'column must be a string')
  return value
}

function assertEmptyPayee(payee: string, entity: string): void {
  if (payee !== '') invalidRow(entity, 'payee', 'payee must be empty for this transaction type')
}

function requiredId(row: UnknownRow, entity: string, field: string): string {
  const value = requiredString(row, entity, field)
  if (value.length === 0) return invalidRow(entity, field, 'identifier must be non-empty')
  return value
}

function nullableId(row: UnknownRow, entity: string, field: string): string | null {
  const value = valueAt(row, entity, field)
  if (value === null) return null
  if (typeof value !== 'string' || value.length === 0) {
    return invalidRow(entity, field, 'column must be null or a non-empty identifier')
  }
  return value
}

function requiredNullableId(
  value: string | null,
  entity: string,
  field: string,
): string {
  if (value === null) return invalidRow(entity, field, 'required identifier is null')
  return value
}

function safeInteger(row: UnknownRow, entity: string, field: string): number {
  const value = valueAt(row, entity, field)
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return invalidRow(entity, field, 'column must be a safe integer')
  }
  return value
}

function positiveVersion(row: UnknownRow, entity: string, field: string): number {
  const value = safeInteger(row, entity, field)
  if (value < 1) return invalidRow(entity, field, 'version must be positive')
  return value
}

function utcMilliseconds(row: UnknownRow, entity: string, field: string): number {
  const value = safeInteger(row, entity, field)
  try {
    return assertUtcMilliseconds(value, field)
  } catch {
    return invalidRow(entity, field, 'column is outside the supported UTC millisecond range')
  }
}

function nullableUtcMilliseconds(row: UnknownRow, entity: string, field: string): number | null {
  const value = valueAt(row, entity, field)
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return invalidRow(entity, field, 'column must be null or a safe integer UTC timestamp')
  }
  try {
    return assertUtcMilliseconds(value, field)
  } catch {
    return invalidRow(entity, field, 'column is outside the supported UTC millisecond range')
  }
}

function safeMinor(row: UnknownRow, entity: string, field: string): number {
  const value = valueAt(row, entity, field)
  assertSafeMinor(value, field)
  return value
}

function nullableSafeMinor(row: UnknownRow, entity: string, field: string): number | null {
  const value = valueAt(row, entity, field)
  if (value === null) return null
  assertSafeMinor(value, field)
  return value
}

function enumValue<T extends string>(
  row: UnknownRow,
  entity: string,
  field: string,
  allowed: readonly T[],
): T {
  const value = valueAt(row, entity, field)
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    return invalidRow(entity, field, 'unsupported discriminator value')
  }
  return value as T
}

function nullableEnumValue<T extends string>(
  row: UnknownRow,
  entity: string,
  field: string,
  allowed: readonly T[],
): T | null {
  const value = valueAt(row, entity, field)
  if (value === null) return null
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    return invalidRow(entity, field, 'unsupported discriminator value')
  }
  return value as T
}

function persistedCurrency(row: UnknownRow, entity: string, field: string): string {
  const value = requiredString(row, entity, field)
  let normalized: string
  try {
    normalized = normalizeLedgerCurrencyCode(value)
  } catch {
    return invalidRow(entity, field, 'currency is not a canonical ISO 4217 code')
  }
  if (normalized !== value || !isSupportedLedgerCurrency(value)) {
    return invalidRow(entity, field, 'currency is not supported by the Ledger metadata')
  }
  return value
}

function persistedTimezone(row: UnknownRow, entity: string, field: string): string {
  const value = requiredString(row, entity, field)
  if (!isIanaTimeZoneId(value)) {
    return invalidRow(entity, field, 'timezone is not a named IANA timezone identifier')
  }
  return value
}

function persistedOpeningDate(row: UnknownRow, entity: string, field: string): string {
  const value = requiredString(row, entity, field)
  try {
    return assertOpeningDate(value)
  } catch {
    return invalidRow(entity, field, 'openingDate is not a valid Gregorian date')
  }
}

function persistedName(row: UnknownRow, entity: string, field: string): string {
  const value = requiredString(row, entity, field)
  if (value.trim().length === 0) return invalidRow(entity, field, 'name must be non-empty')
  return value
}

function readTransactionBase(row: UnknownRow): LedgerTransactionBase & { readonly payee: string } {
  const entity = 'transaction'
  const groupId = hasOwn(row, 'group_id')
    ? nullableId(row, entity, 'group_id')
    : null
  return {
    id: requiredId(row, entity, 'id'),
    ...(groupId === null ? {} : { groupId }),
    amountMinor: safeMinor(row, entity, 'amount_minor'),
    occurredAt: utcMilliseconds(row, entity, 'occurred_at'),
    location: row.location === undefined ? '' : requiredString(row, entity, 'location'),
    payee: requiredString(row, entity, 'payee'),
    note: requiredString(row, entity, 'note'),
    deletedAt: nullableUtcMilliseconds(row, entity, 'deleted_at'),
    version: positiveVersion(row, entity, 'version'),
    createdAt: utcMilliseconds(row, entity, 'created_at'),
    updatedAt: utcMilliseconds(row, entity, 'updated_at'),
  }
}

export function ledgerSettingsFromRow(row: unknown): LedgerSettings {
  const record = asRow(row, 'settings')
  const singletonId = safeInteger(record, 'settings', 'singleton_id')
  if (singletonId !== 1) invalidRow('settings', 'singleton_id', 'singleton_id must be 1')

  const marker = safeInteger(record, 'settings', 'has_created_account')
  if (marker !== 0 && marker !== 1) {
    invalidRow('settings', 'has_created_account', 'freeze marker must be 0 or 1')
  }

  const jsonArray = (value: unknown, fallback: string[]): string[] => {
    if (typeof value !== 'string') return fallback
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : fallback
    } catch { return fallback }
  }
  const jsonRecord = (value: unknown): Record<string, string> => {
    if (typeof value !== 'string') return {}
    try {
      const parsed = JSON.parse(value)
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        && Object.values(parsed).every((item) => typeof item === 'string') ? parsed as Record<string, string> : {}
    } catch { return {} }
  }
  const storedAvailableIcons = jsonArray(record.account_icon_available_json, []) as LedgerAccountIcon[]
  const storedArchivedIcons = jsonArray(record.account_icon_archived_json, []) as LedgerAccountIcon[]
  const storedIconNames = jsonRecord(record.account_icon_names_json)
  const storedNames = new Set(Object.values(storedIconNames))
  const missingDefaults = LEDGER_DEFAULT_ACCOUNT_ICONS.filter((icon) => {
    const builtinName = LEDGER_BUILTIN_ACCOUNT_ICON_NAMES[icon]
    return !builtinName || !storedNames.has(builtinName)
  })
  const availableIcons = [...new Set([...missingDefaults, ...storedAvailableIcons])]
  const accountIcons: LedgerAccountIconConfig = {
    defaultIcon: (typeof record.account_icon_default === 'string' ? record.account_icon_default : 'wallet') as LedgerAccountIcon,
    availableIcons,
    archivedIcons: storedArchivedIcons.filter((icon) => !availableIcons.includes(icon)),
    customIcons: jsonRecord(record.account_icon_custom_json),
    customIconNames: { ...LEDGER_BUILTIN_ACCOUNT_ICON_NAMES, ...storedIconNames },
  }
  return {
    baseCurrency: persistedCurrency(record, 'settings', 'base_currency'),
    timezone: persistedTimezone(record, 'settings', 'timezone'),
    hasCreatedAccount: marker === 1,
    version: positiveVersion(record, 'settings', 'version'),
    createdAt: utcMilliseconds(record, 'settings', 'created_at'),
    updatedAt: utcMilliseconds(record, 'settings', 'updated_at'),
    accountIcons,
  }
}

export function ledgerAccountFromRow(row: unknown): LedgerAccount {
  const record = asRow(row, 'account')
  const type = enumValue(record, 'account', 'type', LEDGER_ACCOUNT_TYPES)
  const nature = enumValue(record, 'account', 'nature', LEDGER_ACCOUNT_NATURES)
  if (!isLedgerAccountTypeNature(type, nature)) {
    invalidRow('account', 'nature', 'type and nature are not a valid Ledger pairing')
  }

  return {
    id: requiredId(record, 'account', 'id'),
    name: persistedName(record, 'account', 'name'),
    type,
    nature,
    ...(record.icon && record.icon !== 'wallet' ? { icon: record.icon as LedgerAccountIcon } : {}),
    openingBalanceMinor: safeMinor(record, 'account', 'opening_balance_minor'),
    openingDate: persistedOpeningDate(record, 'account', 'opening_date'),
    currency: persistedCurrency(record, 'account', 'currency'),
    note: requiredString(record, 'account', 'note'),
    ...(hasOwn(record, 'card_number') && typeof record.card_number === 'string' && record.card_number
      ? { cardNumber: record.card_number }
      : {}),
    archivedAt: nullableUtcMilliseconds(record, 'account', 'archived_at'),
    version: positiveVersion(record, 'account', 'version'),
    createdAt: utcMilliseconds(record, 'account', 'created_at'),
    updatedAt: utcMilliseconds(record, 'account', 'updated_at'),
  }
}

export function ledgerCategoryFromRow(row: unknown): LedgerCategory {
  const record = asRow(row, 'category')
  const name = persistedName(record, 'category', 'name')
  const normalizedName = requiredString(record, 'category', 'normalized_name')
  const systemKey = hasOwn(record, 'system_key')
    ? nullableEnumValue(record, 'category', 'system_key', ['interest', 'fee'] as const)
    : null
  const isDefault = hasOwn(record, 'is_default')
    ? safeInteger(record, 'category', 'is_default')
    : 0
  if (isDefault !== 0 && isDefault !== 1) invalidRow('category', 'is_default', 'must be 0 or 1')
  const sortOrder = hasOwn(record, 'sort_order')
    ? safeInteger(record, 'category', 'sort_order')
    : undefined
  if (sortOrder !== undefined && sortOrder < 0) invalidRow('category', 'sort_order', 'must be non-negative')
  if (
    normalizedName.length === 0
    || normalizedName !== normalizeLedgerCategoryName(name)
  ) {
    invalidRow('category', 'normalized_name', 'normalized name does not match the display name')
  }
  const kind = enumValue(record, 'category', 'kind', LEDGER_CATEGORY_KINDS)
  if (systemKey !== null && kind !== 'expense') invalidRow('category', 'system_key', 'must be null for income')

  return {
    id: requiredId(record, 'category', 'id'),
    kind,
    name,
    normalizedName,
    ...(systemKey === null ? {} : { systemKey }),
    ...(isDefault === 1 ? { isDefault: true } : {}),
    ...(record.icon && record.icon !== 'wallet' ? { icon: record.icon as LedgerAccountIcon } : {}),
    ...(sortOrder === undefined ? {} : { sortOrder }),
    archivedAt: nullableUtcMilliseconds(record, 'category', 'archived_at'),
    version: positiveVersion(record, 'category', 'version'),
    createdAt: utcMilliseconds(record, 'category', 'created_at'),
    updatedAt: utcMilliseconds(record, 'category', 'updated_at'),
  }
}

export function ledgerTransactionFromRow(row: unknown): LedgerTransaction {
  const record = asRow(row, 'transaction')
  const type = enumValue(record, 'transaction', 'type', LEDGER_TRANSACTION_TYPES)
  const transferKind = nullableEnumValue(record, 'transaction', 'transfer_kind', LEDGER_TRANSFER_KINDS)
  const feeMode = hasOwn(record, 'transfer_fee_mode')
    ? nullableEnumValue(record, 'transaction', 'transfer_fee_mode', ['extra', 'deducted'] as const)
    : null
  const base = readTransactionBase(record)
  const { payee, ...withoutPayee } = base
  const accountId = nullableId(record, 'transaction', 'account_id')
  const fromAccountId = nullableId(record, 'transaction', 'from_account_id')
  const toAccountId = nullableId(record, 'transaction', 'to_account_id')
  const categoryId = nullableId(record, 'transaction', 'category_id')
  const calculated = nullableSafeMinor(
    record,
    'transaction',
    'adjustment_calculated_balance_minor',
  )
  const target = nullableSafeMinor(
    record,
    'transaction',
    'adjustment_target_balance_minor',
  )

  switch (type) {
    case 'income':
      if (transferKind !== null) invalidRow('transaction', 'transfer_kind', 'must be null for income')
      if (feeMode !== null) invalidRow('transaction', 'transfer_fee_mode', 'must be null for income')
      assertPositiveMinor(base.amountMinor, 'amount_minor')
      if (fromAccountId !== null) invalidRow('transaction', 'from_account_id', 'must be null for income')
      if (toAccountId !== null) invalidRow('transaction', 'to_account_id', 'must be null for income')
      if (calculated !== null) invalidRow('transaction', 'adjustment_calculated_balance_minor', 'must be null for income')
      if (target !== null) invalidRow('transaction', 'adjustment_target_balance_minor', 'must be null for income')
      return {
        ...withoutPayee,
        type: 'income',
        accountId: requiredNullableId(accountId, 'transaction', 'account_id'),
        categoryId: requiredNullableId(categoryId, 'transaction', 'category_id'),
        payee,
      }

    case 'expense':
      if (transferKind !== null) invalidRow('transaction', 'transfer_kind', 'must be null for expense')
      if (feeMode !== null) invalidRow('transaction', 'transfer_fee_mode', 'must be null for expense')
      assertPositiveMinor(base.amountMinor, 'amount_minor')
      if (fromAccountId !== null) invalidRow('transaction', 'from_account_id', 'must be null for expense')
      if (toAccountId !== null) invalidRow('transaction', 'to_account_id', 'must be null for expense')
      if (calculated !== null) invalidRow('transaction', 'adjustment_calculated_balance_minor', 'must be null for expense')
      if (target !== null) invalidRow('transaction', 'adjustment_target_balance_minor', 'must be null for expense')
      return {
        ...withoutPayee,
        type: 'expense',
        accountId: requiredNullableId(accountId, 'transaction', 'account_id'),
        categoryId: requiredNullableId(categoryId, 'transaction', 'category_id'),
        payee,
      }

    case 'transfer':
      if (transferKind === null) invalidRow('transaction', 'transfer_kind', 'is required for transfer')
      if (feeMode !== null && (transferKind !== 'withdrawal' || base.groupId === undefined)) {
        invalidRow('transaction', 'transfer_fee_mode', 'requires a grouped withdrawal transfer')
      }
      assertPositiveMinor(base.amountMinor, 'amount_minor')
      if (accountId !== null) invalidRow('transaction', 'account_id', 'must be null for transfer')
      if (categoryId !== null) invalidRow('transaction', 'category_id', 'must be null for transfer')
      if (calculated !== null) invalidRow('transaction', 'adjustment_calculated_balance_minor', 'must be null for transfer')
      if (target !== null) invalidRow('transaction', 'adjustment_target_balance_minor', 'must be null for transfer')
      const transferFrom = requiredNullableId(fromAccountId, 'transaction', 'from_account_id')
      const transferTo = requiredNullableId(toAccountId, 'transaction', 'to_account_id')
      if (transferFrom === transferTo) {
        invalidRow('transaction', 'to_account_id', 'transfer account pair must be distinct')
      }
      return {
        ...withoutPayee,
        type: 'transfer',
        transferKind,
        ...(feeMode === null ? {} : { feeMode }),
        fromAccountId: transferFrom,
        toAccountId: transferTo,
        payee,
      }

    case 'adjustment':
      if (transferKind !== null) invalidRow('transaction', 'transfer_kind', 'must be null for adjustment')
      if (feeMode !== null) invalidRow('transaction', 'transfer_fee_mode', 'must be null for adjustment')
      if (base.amountMinor === 0) invalidRow('transaction', 'amount_minor', 'adjustment delta must be non-zero')
      if (fromAccountId !== null) invalidRow('transaction', 'from_account_id', 'must be null for adjustment')
      if (toAccountId !== null) invalidRow('transaction', 'to_account_id', 'must be null for adjustment')
      if (categoryId !== null) invalidRow('transaction', 'category_id', 'must be null for adjustment')
      assertEmptyPayee(payee, 'transaction')
      const adjustmentCalculated = calculated
      const adjustmentTarget = target
      if (adjustmentCalculated === null) {
        invalidRow('transaction', 'adjustment_calculated_balance_minor', 'is required for adjustment')
      }
      if (adjustmentTarget === null) {
        invalidRow('transaction', 'adjustment_target_balance_minor', 'is required for adjustment')
      }
      const expectedDelta = checkedSubMinor(adjustmentTarget, adjustmentCalculated)
      if (base.amountMinor !== expectedDelta) {
        invalidRow('transaction', 'amount_minor', 'must equal target minus calculated balance')
      }
      return {
        ...withoutPayee,
        type: 'adjustment',
        accountId: requiredNullableId(accountId, 'transaction', 'account_id'),
        adjustmentCalculatedBalanceMinor: adjustmentCalculated,
        adjustmentTargetBalanceMinor: adjustmentTarget,
      }
  }
}
