import {
  assertSupportedLedgerCurrency,
  normalizeLedgerCurrencyCode,
} from '../../shared/ledgerCurrency.js'
import type {
  LedgerAccountCreateRequest,
  LedgerAccountBalanceTrendRange,
  LedgerAccountIcon,
  LedgerAccountIconConfig,
  LedgerAccountNature,
  LedgerAccountType,
  LedgerCategoryCreateRequest,
  LedgerCategoryKind,
  LedgerExpenseCreateRequest,
  LedgerIncomeCreateRequest,
  LedgerAdjustmentCreateRequest,
  LedgerAdjustmentEndpointRequest,
  LedgerSettingsCreateRequest,
  LedgerTransactionCreateRequest,
  LedgerTransactionCursor,
  LedgerTransactionFilterType,
  LedgerTransactionQuery,
  LedgerTransactionType,
  LedgerTransferFeeMode,
  LedgerTransferKind,
  LedgerTransferCreateRequest,
} from '../../shared/ledgerProtocol.js'
import {
  assertOpeningDate,
  assertIanaTimeZoneId,
  assertUtcMilliseconds,
  parseLedgerLocalDate,
} from './time.js'
import { LedgerError, ledgerValidationError } from './errors.js'

export const LEDGER_NAME_MAX_LENGTH = 120
export const LEDGER_PAYEE_MAX_LENGTH = 200
export const LEDGER_LOCATION_MAX_LENGTH = 200
export const LEDGER_NOTE_MAX_LENGTH = 2_000
export const LEDGER_IDEMPOTENCY_KEY_MAX_LENGTH = 200
export const LEDGER_LIST_LIMIT_DEFAULT = 50
export const LEDGER_LIST_LIMIT_MAX = 200
export const LEDGER_TREND_MONTHS_DEFAULT = 6

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw ledgerValidationError('request body must be a JSON object')
  }
  return value as UnknownRecord
}

function hasOwn(record: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function assertExactKeys(
  record: UnknownRecord,
  allowed: readonly string[],
  required: readonly string[],
): void {
  const allowedSet = new Set(allowed)
  const unknownKeys = Object.keys(record).filter((key) => !allowedSet.has(key)).sort()
  const missingKeys = required.filter((key) => !hasOwn(record, key))
  if (unknownKeys.length || missingKeys.length) {
    throw ledgerValidationError('request contains unknown or missing fields', {
      ...(unknownKeys.length ? { unknownKeys: unknownKeys.join(',') } : {}),
      ...(missingKeys.length ? { missingKeys: missingKeys.join(',') } : {}),
    })
  }
}

function requireString(record: UnknownRecord, key: string): string {
  const value = record[key]
  if (typeof value !== 'string') {
    throw ledgerValidationError(`${key} must be a string`, { field: key })
  }
  return value
}

function requireNonEmptyId(record: UnknownRecord, key: string): string {
  const value = requireString(record, key)
  if (!value || value.trim().length === 0) {
    throw ledgerValidationError(`${key} must be non-empty`, { field: key })
  }
  return value
}

function optionalString(record: UnknownRecord, key: string, defaultValue: string): string {
  if (!hasOwn(record, key)) return defaultValue
  return requireString(record, key)
}

function validateLength(value: string, key: string, min: number, max: number): string {
  if (value.length < min || value.length > max) {
    throw ledgerValidationError(`${key} must be ${min}–${max} UTF-16 code units`, {
      field: key,
      min,
      max,
    })
  }
  return value
}

function parseName(record: UnknownRecord, key = 'name'): string {
  const trimmed = requireString(record, key).trim()
  return validateLength(trimmed, key, 1, LEDGER_NAME_MAX_LENGTH)
}

function parseNote(record: UnknownRecord): string {
  return validateLength(
    optionalString(record, 'note', ''),
    'note',
    0,
    LEDGER_NOTE_MAX_LENGTH,
  )
}

function parseCardNumber(record: UnknownRecord): string {
  return validateLength(optionalString(record, 'cardNumber', ''), 'cardNumber', 0, 64)
}

function parsePayee(record: UnknownRecord): string {
  return validateLength(
    optionalString(record, 'payee', ''),
    'payee',
    0,
    LEDGER_PAYEE_MAX_LENGTH,
  )
}

function parseLocation(record: UnknownRecord): string {
  return validateLength(optionalString(record, 'location', ''), 'location', 0, LEDGER_LOCATION_MAX_LENGTH)
}

function parseSafeInteger(record: UnknownRecord, key: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw ledgerValidationError(`${key} must be a safe integer`, { field: key })
  }
  return value
}

function parsePositiveInteger(record: UnknownRecord, key: string): number {
  const value = parseSafeInteger(record, key)
  if (value <= 0) {
    throw ledgerValidationError(`${key} must be greater than zero`, { field: key })
  }
  return value
}

function parseEnum<T extends string>(
  record: UnknownRecord,
  key: string,
  allowed: readonly T[],
): T {
  const value = requireString(record, key)
  if (!allowed.includes(value as T)) {
    throw ledgerValidationError(`${key} has an unsupported value`, { field: key })
  }
  return value as T
}

export const LEDGER_ACCOUNT_TYPES: readonly LedgerAccountType[] = [
  'cash', 'bank', 'wallet', 'credit_card', 'loan', 'other',
]
export const LEDGER_ACCOUNT_NATURES: readonly LedgerAccountNature[] = ['asset', 'liability']
export const LEDGER_ACCOUNT_ICONS: readonly LedgerAccountIcon[] = ['wallet', 'credit_card', 'cash', 'building_bank', 'briefcase']
export const LEDGER_CATEGORY_KINDS: readonly LedgerCategoryKind[] = ['income', 'expense']
export const LEDGER_TRANSACTION_TYPES: readonly LedgerTransactionType[] = [
  'income', 'expense', 'transfer', 'adjustment',
]
export const LEDGER_TRANSFER_KINDS: readonly LedgerTransferKind[] = [
  'general', 'repayment', 'withdrawal',
]
export const LEDGER_TRANSFER_FEE_MODES: readonly LedgerTransferFeeMode[] = ['extra', 'deducted']
export const LEDGER_ACCOUNT_BALANCE_TREND_RANGES: readonly LedgerAccountBalanceTrendRange[] = [7, 30, 90, 365]

export function parseAccountType(record: UnknownRecord, key = 'type'): LedgerAccountType {
  return parseEnum(record, key, LEDGER_ACCOUNT_TYPES)
}

export function parseAccountNature(record: UnknownRecord, key = 'nature'): LedgerAccountNature {
  return parseEnum(record, key, LEDGER_ACCOUNT_NATURES)
}

export function parseAccountIcon(record: UnknownRecord, key = 'icon'): LedgerAccountIcon {
  const value = requireString(record, key)
  if (LEDGER_ACCOUNT_ICONS.includes(value as LedgerAccountIcon) || /^custom_[a-z0-9_]+$/.test(value)) return value as LedgerAccountIcon
  throw ledgerValidationError(`${key} has an unsupported value`, { field: key })
}

export function parseCategoryKind(record: UnknownRecord, key = 'kind'): LedgerCategoryKind {
  return parseEnum(record, key, LEDGER_CATEGORY_KINDS)
}

export function parseTransactionType(record: UnknownRecord, key = 'type'): LedgerTransactionType {
  return parseEnum(record, key, LEDGER_TRANSACTION_TYPES)
}

export function parseTransferKind(record: UnknownRecord, key = 'transferKind'): LedgerTransferKind {
  return parseEnum(record, key, LEDGER_TRANSFER_KINDS)
}

export function parseTransferFeeMode(record: UnknownRecord, key = 'feeMode'): LedgerTransferFeeMode {
  return parseEnum(record, key, LEDGER_TRANSFER_FEE_MODES)
}

export function parseAccountBalanceTrendRange(value: unknown): LedgerAccountBalanceTrendRange {
  if (value === undefined) return 30
  const numeric = typeof value === 'string' && /^[1-9]\d*$/.test(value)
    ? Number(value)
    : NaN
  if (!LEDGER_ACCOUNT_BALANCE_TREND_RANGES.includes(numeric as LedgerAccountBalanceTrendRange)) {
    throw ledgerValidationError('range must be one of 7, 30, 90, or 365 days', { field: 'range' })
  }
  return numeric as LedgerAccountBalanceTrendRange
}

function parseCurrency(record: UnknownRecord, key = 'currency'): string {
  const value = requireString(record, key)
  try {
    return assertSupportedLedgerCurrency(value)
  } catch {
    throw new LedgerError('ledger-invalid-currency', 400, `${key} is not a supported ISO 4217 currency`, { field: key })
  }
}

export function parseBaseCurrency(record: UnknownRecord, key = 'baseCurrency'): string {
  const value = requireString(record, key)
  try {
    return assertSupportedLedgerCurrency(value)
  } catch {
    throw new LedgerError('ledger-invalid-currency', 400, `${key} is not a supported ISO 4217 currency`, { field: key })
  }
}

export function parseTimezone(record: UnknownRecord, key = 'timezone'): string {
  return assertIanaTimeZoneId(requireString(record, key))
}

export function parseExpectedVersion(record: UnknownRecord, key = 'expectedVersion'): number {
  const value = parseSafeInteger(record, key)
  if (value < 1) {
    throw ledgerValidationError(`${key} must be a positive safe integer`, { field: key })
  }
  return value
}

export function parseIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > LEDGER_IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw ledgerValidationError('Idempotency-Key must be a non-empty opaque value of at most 200 UTF-16 code units', {
      field: 'Idempotency-Key',
    })
  }
  return value
}

export function parseSettingsCreateRequest(value: unknown): LedgerSettingsCreateRequest {
  const record = asRecord(value)
  assertExactKeys(record, ['baseCurrency', 'timezone'], ['baseCurrency', 'timezone'])
  return {
    baseCurrency: parseBaseCurrency(record),
    timezone: parseTimezone(record),
  }
}

export function parseAccountCreateRequest(value: unknown): LedgerAccountCreateRequest {
  const record = asRecord(value)
  assertExactKeys(record, [
    'name', 'type', 'nature', 'icon', 'openingBalanceMinor', 'openingDate', 'currency', 'note', 'cardNumber',
  ], ['name', 'type', 'nature', 'openingBalanceMinor', 'openingDate', 'currency'])
  return {
    name: parseName(record),
    type: parseAccountType(record),
    nature: parseAccountNature(record),
    ...(hasOwn(record, 'icon') ? { icon: parseAccountIcon(record) } : {}),
    openingBalanceMinor: parseSafeInteger(record, 'openingBalanceMinor'),
    openingDate: assertOpeningDate(requireString(record, 'openingDate')),
    currency: parseCurrency(record),
    note: parseNote(record),
    cardNumber: parseCardNumber(record),
  }
}

export function parseCategoryCreateRequest(value: unknown): LedgerCategoryCreateRequest {
  const record = asRecord(value)
  assertExactKeys(record, ['kind', 'name', 'icon'], ['kind', 'name'])
  return {
    kind: parseCategoryKind(record),
    name: parseName(record),
    ...(hasOwn(record, 'icon') ? { icon: parseAccountIcon(record) } : {}),
  }
}

function parseOccurredAt(record: UnknownRecord): number {
  return assertUtcMilliseconds(parseSafeInteger(record, 'occurredAt'), 'occurredAt')
}

function parseAmountMinor(record: UnknownRecord): number {
  return parsePositiveInteger(record, 'amountMinor')
}

function parseOptionalFeeMinor(record: UnknownRecord): number | undefined {
  if (!hasOwn(record, 'feeMinor')) return undefined
  const feeMinor = parseSafeInteger(record, 'feeMinor')
  if (feeMinor < 0) {
    throw ledgerValidationError('feeMinor must not be negative', { field: 'feeMinor' })
  }
  return feeMinor
}

function parseAdjustmentBalance(record: UnknownRecord, key: string): number {
  return parseSafeInteger(record, key)
}

function parseIncomeOrExpenseCreate(
  value: unknown,
  type: 'income' | 'expense',
): LedgerIncomeCreateRequest | LedgerExpenseCreateRequest {
  const record = asRecord(value)
  assertExactKeys(record, [
    'type', 'amountMinor', 'accountId', 'categoryId', 'occurredAt', 'location', 'payee', 'note',
  ], ['type', 'amountMinor', 'accountId', 'categoryId', 'occurredAt'])
  if (parseTransactionType(record) !== type) {
    throw ledgerValidationError('transaction type discriminator does not match the parser', { field: 'type' })
  }
  const result = {
    type,
    amountMinor: parseAmountMinor(record),
    accountId: requireNonEmptyId(record, 'accountId'),
    categoryId: requireNonEmptyId(record, 'categoryId'),
    occurredAt: parseOccurredAt(record),
    location: parseLocation(record),
    payee: parsePayee(record),
    note: parseNote(record),
  }
  return result
}

function parseTransferCreate(value: unknown): LedgerTransferCreateRequest {
  const record = asRecord(value)
  assertExactKeys(record, [
    'type', 'transferKind', 'amountMinor', 'feeMinor', 'feeMode',
    'fromAccountId', 'toAccountId', 'occurredAt', 'location', 'payee', 'note',
  ], ['type', 'amountMinor', 'fromAccountId', 'toAccountId', 'occurredAt'])
  if (parseTransactionType(record) !== 'transfer') {
    throw ledgerValidationError('transaction type discriminator does not match the parser', { field: 'type' })
  }
  return {
    type: 'transfer',
    ...(hasOwn(record, 'transferKind') ? { transferKind: parseTransferKind(record) } : {}),
    amountMinor: parseAmountMinor(record),
    ...(hasOwn(record, 'feeMinor') ? { feeMinor: parseOptionalFeeMinor(record) } : {}),
    ...(hasOwn(record, 'feeMode') ? { feeMode: parseTransferFeeMode(record) } : {}),
    fromAccountId: requireNonEmptyId(record, 'fromAccountId'),
    toAccountId: requireNonEmptyId(record, 'toAccountId'),
    occurredAt: parseOccurredAt(record),
    location: parseLocation(record),
    payee: parsePayee(record),
    note: parseNote(record),
  }
}

function parseAdjustmentCreate(value: unknown): LedgerAdjustmentCreateRequest {
  const record = asRecord(value)
  assertExactKeys(record, [
    'type', 'accountId', 'targetBalanceMinor', 'expectedCalculatedBalanceMinor', 'occurredAt', 'note',
  ], ['type', 'accountId', 'targetBalanceMinor', 'expectedCalculatedBalanceMinor', 'occurredAt'])
  if (parseTransactionType(record) !== 'adjustment') {
    throw ledgerValidationError('transaction type discriminator does not match the parser', { field: 'type' })
  }
  return {
    type: 'adjustment',
    accountId: requireNonEmptyId(record, 'accountId'),
    targetBalanceMinor: parseAdjustmentBalance(record, 'targetBalanceMinor'),
    expectedCalculatedBalanceMinor: parseAdjustmentBalance(record, 'expectedCalculatedBalanceMinor'),
    occurredAt: parseOccurredAt(record),
    note: parseNote(record),
  }
}

/** Parse the complete discriminated transaction create union without DB access. */
export function parseTransactionCreateRequest(value: unknown): LedgerTransactionCreateRequest {
  const record = asRecord(value)
  const type = parseTransactionType(record)
  switch (type) {
    case 'income':
      return parseIncomeOrExpenseCreate(record, 'income')
    case 'expense':
      return parseIncomeOrExpenseCreate(record, 'expense')
    case 'transfer':
      return parseTransferCreate(record)
    case 'adjustment':
      return parseAdjustmentCreate(record)
  }
}

/** Parse the dedicated Account Adjustment endpoint payload. */
export function parseAdjustmentEndpointRequest(value: unknown): LedgerAdjustmentEndpointRequest {
  const record = asRecord(value)
  assertExactKeys(record, [
    'targetBalanceMinor', 'expectedCalculatedBalanceMinor', 'occurredAt', 'note',
  ], ['targetBalanceMinor', 'expectedCalculatedBalanceMinor', 'occurredAt'])
  return {
    targetBalanceMinor: parseAdjustmentBalance(record, 'targetBalanceMinor'),
    expectedCalculatedBalanceMinor: parseAdjustmentBalance(record, 'expectedCalculatedBalanceMinor'),
    occurredAt: parseOccurredAt(record),
    note: parseNote(record),
  }
}

export interface LedgerSettingsPatchRequest {
  readonly expectedVersion: number
  readonly baseCurrency?: string
  readonly timezone?: string
  readonly accountIcons?: LedgerAccountIconConfig
}

export function parseSettingsPatchRequest(value: unknown): LedgerSettingsPatchRequest {
  const record = asRecord(value)
  assertExactKeys(record, ['expectedVersion', 'baseCurrency', 'timezone', 'accountIcons'], ['expectedVersion'])
  if (!hasOwn(record, 'baseCurrency') && !hasOwn(record, 'timezone') && !hasOwn(record, 'accountIcons')) {
    throw ledgerValidationError('settings PATCH must contain at least one mutable field')
  }
  return {
    expectedVersion: parseExpectedVersion(record),
    ...(hasOwn(record, 'baseCurrency') ? { baseCurrency: parseBaseCurrency(record) } : {}),
    ...(hasOwn(record, 'timezone') ? { timezone: parseTimezone(record) } : {}),
    ...(hasOwn(record, 'accountIcons') ? { accountIcons: parseAccountIconConfig(record.accountIcons) } : {}),
  }
}

function parseAccountIconConfig(value: unknown): LedgerAccountIconConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw ledgerValidationError('accountIcons must be an object')
  const config = value as Record<string, unknown>
  if (!Array.isArray(config.availableIcons) || typeof config.defaultIcon !== 'string'
    || config.customIcons === null || typeof config.customIcons !== 'object'
    || config.customIconNames === null || typeof config.customIconNames !== 'object') {
    throw ledgerValidationError('accountIcons has an invalid shape')
  }
  const availableIcons = config.availableIcons.filter((icon): icon is string => typeof icon === 'string')
  const archivedIcons = Array.isArray(config.archivedIcons)
    ? config.archivedIcons.filter((icon): icon is string => typeof icon === 'string')
    : []
  if (!availableIcons.length || !availableIcons.includes(config.defaultIcon)) throw ledgerValidationError('accountIcons must contain a valid default icon')
  const customIcons = Object.fromEntries(Object.entries(config.customIcons).filter(([, svg]) => typeof svg === 'string'))
  const customIconNames = Object.fromEntries(Object.entries(config.customIconNames).filter(([, name]) => typeof name === 'string'))
  return { defaultIcon: config.defaultIcon as LedgerAccountIcon, availableIcons: availableIcons as LedgerAccountIcon[], archivedIcons: archivedIcons as LedgerAccountIcon[], customIcons, customIconNames }
}

export interface LedgerAccountPatchRequest {
  readonly expectedVersion: number
  readonly name?: string
  readonly note?: string
  readonly cardNumber?: string
  readonly icon?: LedgerAccountIcon
  readonly type?: LedgerAccountType
  readonly nature?: LedgerAccountNature
  readonly openingBalanceMinor?: number
  readonly openingDate?: string
}

export function parseAccountPatchRequest(value: unknown): LedgerAccountPatchRequest {
  const record = asRecord(value)
  const mutableKeys = [
    'name', 'note', 'cardNumber', 'type', 'nature', 'openingBalanceMinor', 'openingDate',
    'icon',
  ] as const
  assertExactKeys(record, ['expectedVersion', ...mutableKeys], ['expectedVersion'])
  if (!mutableKeys.some((key) => hasOwn(record, key))) {
    throw ledgerValidationError('account PATCH must contain at least one mutable field')
  }
  return {
    expectedVersion: parseExpectedVersion(record),
    ...(hasOwn(record, 'name') ? { name: parseName(record) } : {}),
    ...(hasOwn(record, 'note') ? { note: parseNote(record) } : {}),
    ...(hasOwn(record, 'cardNumber') ? { cardNumber: parseCardNumber(record) } : {}),
    ...(hasOwn(record, 'type') ? { type: parseAccountType(record) } : {}),
    ...(hasOwn(record, 'nature') ? { nature: parseAccountNature(record) } : {}),
    ...(hasOwn(record, 'icon') ? { icon: parseAccountIcon(record) } : {}),
    ...(hasOwn(record, 'openingBalanceMinor')
      ? { openingBalanceMinor: parseSafeInteger(record, 'openingBalanceMinor') }
      : {}),
    ...(hasOwn(record, 'openingDate')
      ? { openingDate: assertOpeningDate(requireString(record, 'openingDate')) }
      : {}),
  }
}

export interface LedgerCategoryPatchRequest {
  readonly expectedVersion: number
  readonly kind?: LedgerCategoryKind
  readonly name?: string
  readonly icon?: LedgerAccountIcon
}

export function parseCategoryPatchRequest(value: unknown): LedgerCategoryPatchRequest {
  const record = asRecord(value)
  assertExactKeys(record, ['expectedVersion', 'kind', 'name', 'icon'], ['expectedVersion'])
  if (!hasOwn(record, 'kind') && !hasOwn(record, 'name') && !hasOwn(record, 'icon')) {
    throw ledgerValidationError('category PATCH must contain at least one mutable field')
  }
  return {
    expectedVersion: parseExpectedVersion(record),
    ...(hasOwn(record, 'kind') ? { kind: parseCategoryKind(record) } : {}),
    ...(hasOwn(record, 'name') ? { name: parseName(record) } : {}),
    ...(hasOwn(record, 'icon') ? { icon: parseAccountIcon(record) } : {}),
  }
}

export interface LedgerTransactionPatchRequest {
  readonly expectedVersion: number
  readonly type?: LedgerTransactionType
  readonly transferKind?: LedgerTransferKind
  readonly amountMinor?: number
  readonly feeMinor?: number
  readonly feeMode?: LedgerTransferFeeMode
  readonly accountId?: string
  readonly fromAccountId?: string
  readonly toAccountId?: string
  readonly categoryId?: string
  readonly occurredAt?: number
  readonly location?: string
  readonly payee?: string
  readonly note?: string
  readonly adjustmentCalculatedBalanceMinor?: number
  readonly adjustmentTargetBalanceMinor?: number
}

export function parseTransactionPatchRequest(value: unknown): LedgerTransactionPatchRequest {
  const record = asRecord(value)
  const mutableKeys = [
    'type', 'transferKind', 'amountMinor', 'feeMinor', 'feeMode', 'accountId', 'fromAccountId', 'toAccountId', 'categoryId',
    'occurredAt', 'location', 'payee', 'note', 'adjustmentCalculatedBalanceMinor',
    'adjustmentTargetBalanceMinor',
  ] as const
  assertExactKeys(record, ['expectedVersion', ...mutableKeys], ['expectedVersion'])
  if (!mutableKeys.some((key) => hasOwn(record, key))) {
    throw ledgerValidationError('transaction PATCH must contain at least one mutable field')
  }
  return {
    expectedVersion: parseExpectedVersion(record),
    ...(hasOwn(record, 'type') ? { type: parseTransactionType(record) } : {}),
    ...(hasOwn(record, 'transferKind') ? { transferKind: parseTransferKind(record) } : {}),
    ...(hasOwn(record, 'amountMinor') ? { amountMinor: parseAmountMinor(record) } : {}),
    ...(hasOwn(record, 'feeMinor') ? { feeMinor: parseOptionalFeeMinor(record) } : {}),
    ...(hasOwn(record, 'feeMode') ? { feeMode: parseTransferFeeMode(record) } : {}),
    ...(hasOwn(record, 'accountId') ? { accountId: requireNonEmptyId(record, 'accountId') } : {}),
    ...(hasOwn(record, 'fromAccountId') ? { fromAccountId: requireNonEmptyId(record, 'fromAccountId') } : {}),
    ...(hasOwn(record, 'toAccountId') ? { toAccountId: requireNonEmptyId(record, 'toAccountId') } : {}),
    ...(hasOwn(record, 'categoryId') ? { categoryId: requireNonEmptyId(record, 'categoryId') } : {}),
    ...(hasOwn(record, 'occurredAt') ? { occurredAt: parseOccurredAt(record) } : {}),
    ...(hasOwn(record, 'location') ? { location: parseLocation(record) } : {}),
    ...(hasOwn(record, 'payee') ? { payee: parsePayee(record) } : {}),
    ...(hasOwn(record, 'note') ? { note: parseNote(record) } : {}),
    ...(hasOwn(record, 'adjustmentCalculatedBalanceMinor')
      ? { adjustmentCalculatedBalanceMinor: parseAdjustmentBalance(record, 'adjustmentCalculatedBalanceMinor') }
      : {}),
    ...(hasOwn(record, 'adjustmentTargetBalanceMinor')
      ? { adjustmentTargetBalanceMinor: parseAdjustmentBalance(record, 'adjustmentTargetBalanceMinor') }
      : {}),
  }
}

export function parseExpectedVersionCommand(value: unknown): number {
  const record = asRecord(value)
  assertExactKeys(record, ['expectedVersion'], ['expectedVersion'])
  return parseExpectedVersion(record)
}

export function parseLimit(value: unknown): number {
  if (value === undefined) return LEDGER_LIST_LIMIT_DEFAULT
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : NaN
  if (!Number.isSafeInteger(numeric) || numeric < 1 || numeric > LEDGER_LIST_LIMIT_MAX) {
    throw ledgerValidationError(`limit must be an integer from 1 to ${LEDGER_LIST_LIMIT_MAX}`, { field: 'limit' })
  }
  return numeric
}

export function parseUtcQueryValue(value: unknown, key: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw ledgerValidationError(`${key} must be an integer UTC millisecond timestamp`, { field: key })
  }
  const numeric = Number(value)
  return assertUtcMilliseconds(numeric, key)
}

export function parseBooleanQuery(value: unknown, key: string, defaultValue = false): boolean {
  if (value === undefined) return defaultValue
  if (value === 'true' || value === true) return true
  if (value === 'false' || value === false) return false
  throw ledgerValidationError(`${key} must be true or false`, { field: key })
}

function invalidCursor(): never {
  throw ledgerValidationError('cursor must be a valid Ledger v1 keyset cursor', { field: 'cursor' })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Decode and validate the opaque v1 transaction cursor payload. */
export function parseLedgerTransactionCursor(value: unknown): LedgerTransactionCursor {
  if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return invalidCursor()
  }

  let payloadText: string
  try {
    const bytes = Buffer.from(value, 'base64url')
    if (bytes.length === 0 || bytes.toString('base64url') !== value) return invalidCursor()
    payloadText = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return invalidCursor()
  }

  let payload: unknown
  try {
    payload = JSON.parse(payloadText)
  } catch {
    return invalidCursor()
  }
  if (!isPlainObject(payload)) return invalidCursor()

  const keys = Object.keys(payload).sort()
  if (keys.length !== 4 || keys.join(',') !== 'createdAt,id,occurredAt,v') return invalidCursor()
  if (payload.v !== 1) return invalidCursor()
  if (
    typeof payload.id !== 'string'
    || payload.id.length === 0
    || typeof payload.occurredAt !== 'number'
    || typeof payload.createdAt !== 'number'
    || !Number.isSafeInteger(payload.occurredAt)
    || !Number.isSafeInteger(payload.createdAt)
  ) {
    return invalidCursor()
  }

  try {
    return {
      occurredAt: assertUtcMilliseconds(payload.occurredAt, 'cursor.occurredAt'),
      createdAt: assertUtcMilliseconds(payload.createdAt, 'cursor.createdAt'),
      id: payload.id,
    }
  } catch {
    return invalidCursor()
  }
}

export function parseTransactionTypeFilter(value: unknown): LedgerTransactionFilterType | 'all' {
  if (value === undefined || value === 'all') return 'all'
  if (
    typeof value !== 'string'
    || (value !== 'income' && value !== 'expense' && value !== 'transfer')
  ) {
    throw ledgerValidationError('type has an unsupported transaction filter', { field: 'type' })
  }
  return value
}

function parseQueryId(record: UnknownRecord, key: string): string | undefined {
  if (!hasOwn(record, key)) return undefined
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw ledgerValidationError(`${key} must be a non-empty identifier`, { field: key })
  }
  return value
}

function parseQuerySearch(record: UnknownRecord): string | undefined {
  if (!hasOwn(record, 'search')) return undefined
  const value = record.search
  if (typeof value !== 'string') {
    throw ledgerValidationError('search must be a string', { field: 'search' })
  }
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

function parseQueryCursor(record: UnknownRecord): string | undefined {
  if (!hasOwn(record, 'cursor')) return undefined
  const value = record.cursor
  parseLedgerTransactionCursor(value)
  if (typeof value !== 'string') return invalidCursor()
  return value
}

function parseQueryOffset(record: UnknownRecord): number | undefined {
  if (!hasOwn(record, 'offset')) return undefined
  const value = record.offset
  const numeric = typeof value === 'string' && /^\d+$/.test(value)
    ? Number(value)
    : value
  if (!Number.isSafeInteger(numeric) || Number(numeric) < 0) {
    throw ledgerValidationError('offset must be a non-negative safe integer', { field: 'offset' })
  }
  return Number(numeric)
}

/** Parse the complete, shared transaction-list query contract. */
export function parseTransactionQuery(value: UnknownRecord): LedgerTransactionQuery {
  assertExactKeys(value, [
    'type', 'accountId', 'categoryId', 'from', 'to', 'search',
    'groupId', 'includeDeleted', 'limit', 'cursor', 'offset',
  ], [])

  const from = parseUtcQueryValue(value.from, 'from')
  const to = parseUtcQueryValue(value.to, 'to')
  if (from !== undefined && to !== undefined && from >= to) {
    throw ledgerValidationError('from must be earlier than to', { field: 'from' })
  }

  const cursor = parseQueryCursor(value)
  const offset = parseQueryOffset(value)
  if (cursor !== undefined && offset !== undefined) {
    throw ledgerValidationError('cursor and offset cannot be used together', { field: 'offset' })
  }

  return {
    type: parseTransactionTypeFilter(value.type),
    accountId: parseQueryId(value, 'accountId'),
    categoryId: parseQueryId(value, 'categoryId'),
    groupId: parseQueryId(value, 'groupId'),
    from,
    to,
    search: parseQuerySearch(value),
    includeDeleted: parseBooleanQuery(value.includeDeleted, 'includeDeleted', false),
    limit: parseLimit(value.limit),
    cursor,
    offset,
  }
}

export function parseTrendMonths(value: unknown): number {
  if (value === undefined) return LEDGER_TREND_MONTHS_DEFAULT
  const numeric = typeof value === 'string' && /^[1-9]\d*$/.test(value)
    ? Number(value)
    : NaN
  if (!Number.isSafeInteger(numeric) || numeric < 1) {
    throw ledgerValidationError('months must be a positive safe integer', { field: 'months' })
  }
  return numeric
}

export function parseOverviewScope(value: unknown): 'today' | 'week' | 'month' | 'year' | 'all' {
  if (value === undefined || value === 'all') return 'all'
  if (value === 'today' || value === 'week' || value === 'month' || value === 'year') return value
  throw ledgerValidationError('scope has an unsupported Overview value', { field: 'scope' })
}

export function parseOverviewAnchorDate(value: unknown): string | undefined {
  if (value === undefined) return undefined
  return parseLedgerLocalDate(value, 'anchorDate')
}

/** Validate a client-supplied currency code without exposing metadata details. */
export function isSupportedCurrencyCode(value: unknown): value is string {
  try {
    normalizeLedgerCurrencyCode(value)
    return assertSupportedLedgerCurrency(value).length === 3
  } catch {
    return false
  }
}
