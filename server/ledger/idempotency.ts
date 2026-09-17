import { createHash } from 'node:crypto'
import type { Database as DatabaseT } from 'better-sqlite3'
import type {
  LedgerAccountCreateRequest,
  LedgerAccountDto,
  LedgerAdjustmentEndpointRequest,
  LedgerAdjustmentAppliedDto,
  LedgerAdjustmentNoOpDto,
  LedgerCategoryCreateRequest,
  LedgerCategoryDto,
  LedgerSettingsCreateRequest,
  LedgerSettingsDto,
  LedgerTransactionCreateRequest,
  LedgerTransactionDto,
} from '../../shared/ledgerProtocol.js'
import { LedgerError, ledgerValidationError } from './errors.js'
import {
  type LedgerIdempotencyRecord,
  type LedgerRepository,
} from './repository.js'
import { runLedgerWrite } from './writeTransaction.js'

/** Canonical, already-parsed request DTOs accepted by Ledger create mutations. */
export type LedgerCanonicalMutation =
  | LedgerSettingsCreateRequest
  | LedgerAccountCreateRequest
  | LedgerCategoryCreateRequest
  | LedgerTransactionCreateRequest
  | LedgerAdjustmentEndpointRequest

export type LedgerJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly LedgerJsonValue[]
  | { readonly [key: string]: LedgerJsonValue }

export type LedgerCommittedReplayResponseBody =
  | LedgerSettingsDto
  | LedgerAccountDto
  | LedgerCategoryDto
  | LedgerTransactionDto
  | LedgerAdjustmentAppliedDto

export type LedgerNoOpReplayResponseBody = LedgerAdjustmentNoOpDto

export type LedgerReplayResponseBody =
  | LedgerCommittedReplayResponseBody
  | LedgerNoOpReplayResponseBody

export const LEDGER_IDEMPOTENCY_OPERATION_SCOPES = {
  settings: 'POST:/api/ledger/settings',
  accounts: 'POST:/api/ledger/accounts',
  categories: 'POST:/api/ledger/categories',
  transactions: 'POST:/api/ledger/transactions',
} as const

export function ledgerAccountAdjustmentOperationScope(accountId: string): string {
  return `POST:/api/ledger/accounts/${accountId}/adjust`
}

function serializationError(message: string): never {
  throw new TypeError(`Ledger JSON serialization rejected the value: ${message}`)
}

function assertDataProperty(value: object, key: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor === undefined || !('value' in descriptor)) {
    serializationError('accessor properties are not supported')
  }
}

function assertPlainObject(value: object): void {
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    serializationError('only plain objects are supported')
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    serializationError('symbol properties are not supported')
  }
}

function serializeLedgerJsonValue(value: unknown, activeObjects: Set<object>): string {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'string': {
      const encoded = JSON.stringify(value)
      if (encoded === undefined) serializationError('string could not be encoded')
      return encoded
    }
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number': {
      if (!Number.isFinite(value)) serializationError('numbers must be finite')
      const encoded = JSON.stringify(value)
      if (encoded === undefined) serializationError('number could not be encoded')
      return encoded
    }
    case 'undefined':
      return serializationError('undefined is not supported')
    case 'bigint':
      return serializationError('bigint is not supported')
    case 'function':
      return serializationError('functions are not supported')
    case 'symbol':
      return serializationError('symbols are not supported')
    case 'object':
      break
    default:
      return serializationError('unsupported value type')
  }

  const objectValue = value as object
  if (activeObjects.has(objectValue)) serializationError('cyclic objects are not supported')
  activeObjects.add(objectValue)

  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        serializationError('only ordinary arrays are supported')
      }
      if (Object.getOwnPropertySymbols(value).length > 0) {
        serializationError('symbol properties are not supported')
      }
      const ownNames = Object.getOwnPropertyNames(value)
      const keys = Object.keys(value)
      if (ownNames.length !== keys.length + 1 || !ownNames.includes('length')) {
        serializationError('arrays may not have extra properties')
      }
      if (keys.length !== value.length) serializationError('sparse arrays are not supported')

      for (let index = 0; index < value.length; index += 1) {
        const key = String(index)
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          serializationError('sparse arrays are not supported')
        }
        assertDataProperty(value, key)
      }

      const serializedItems: string[] = []
      for (let index = 0; index < value.length; index += 1) {
        serializedItems.push(serializeLedgerJsonValue(value[index], activeObjects))
      }
      return `[${serializedItems.join(',')}]`
    }

    assertPlainObject(objectValue)
    const ownNames = Object.getOwnPropertyNames(objectValue)
    const keys = Object.keys(objectValue)
    if (ownNames.length !== keys.length) {
      serializationError('non-enumerable properties are not supported')
    }

    return `{${keys.sort().map((key) => {
      assertDataProperty(objectValue, key)
      const encodedKey = JSON.stringify(key)
      if (encodedKey === undefined) serializationError('object key could not be encoded')
      return `${encodedKey}:${serializeLedgerJsonValue((objectValue as Record<string, unknown>)[key], activeObjects)}`
    }).join(',')}}`
  } finally {
    activeObjects.delete(objectValue)
  }
}

/** Serialize JSON-safe Ledger data with recursively sorted object keys. */
export function stableSerializeLedgerJson(value: unknown): string {
  return serializeLedgerJsonValue(value, new Set<object>())
}

const LEDGER_SETTINGS_REPLAY_KEYS = [
  'baseCurrency',
  'currencyExponent',
  'timezone',
  'hasCreatedAccount',
  'version',
  'createdAt',
  'updatedAt',
  'accountIcons',
] as const

const LEDGER_ACCOUNT_REPLAY_KEYS = [
  'id',
  'name',
  'type',
  'nature',
  'openingBalanceMinor',
  'openingDate',
  'currency',
  'currencyExponent',
  'note',
  'archivedAt',
  'version',
  'createdAt',
  'updatedAt',
  'currentBalanceMinor',
] as const

const LEDGER_CATEGORY_REPLAY_KEYS = [
  'id',
  'kind',
  'name',
  'normalizedName',
  'archivedAt',
  'version',
  'createdAt',
  'updatedAt',
] as const

const LEDGER_TRANSACTION_BASE_REPLAY_KEYS = [
  'id',
  'groupId',
  'type',
  'amountMinor',
  'occurredAt',
  'location',
  'note',
  'deletedAt',
  'version',
  'createdAt',
  'updatedAt',
] as const

const LEDGER_INCOME_REPLAY_KEYS = [
  ...LEDGER_TRANSACTION_BASE_REPLAY_KEYS,
  'accountId',
  'categoryId',
  'payee',
] as const

const LEDGER_EXPENSE_REPLAY_KEYS = [
  ...LEDGER_TRANSACTION_BASE_REPLAY_KEYS,
  'accountId',
  'categoryId',
  'payee',
] as const

const LEDGER_TRANSFER_REPLAY_KEYS = [
  ...LEDGER_TRANSACTION_BASE_REPLAY_KEYS,
  'transferKind',
  'feeMode',
  'fromAccountId',
  'toAccountId',
  'payee',
] as const

const LEDGER_ADJUSTMENT_REPLAY_KEYS = [
  ...LEDGER_TRANSACTION_BASE_REPLAY_KEYS,
  'accountId',
  'adjustmentCalculatedBalanceMinor',
  'adjustmentTargetBalanceMinor',
] as const

function transactionReplayKeys(
  object: Record<string, unknown>,
  keys: readonly string[],
): readonly string[] {
  return keys.filter((key) => {
    if (key === 'location' || key === 'groupId' || key === 'feeMode') {
      return Object.prototype.hasOwnProperty.call(object, key)
    }
    return true
  })
}

const LEDGER_ADJUSTMENT_MUTATION_REPLAY_KEYS = [
  'adjustment',
  'account',
  'noOp',
] as const

type ReplayObject = Record<string, unknown>

function replayResponseError(message: string): never {
  throw new TypeError(`Ledger replay response rejected: ${message}`)
}

function replayDataObject(value: unknown, label: string): ReplayObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return replayResponseError(`${label} must be a plain object`)
  }

  const objectValue = value as object
  const prototype = Object.getPrototypeOf(objectValue)
  if (prototype !== Object.prototype && prototype !== null) {
    return replayResponseError(`${label} must be a plain object`)
  }
  if (Object.getOwnPropertySymbols(objectValue).length > 0) {
    return replayResponseError(`${label} must not contain symbol properties`)
  }

  const ownNames = Object.getOwnPropertyNames(objectValue)
  const enumerableNames = Object.keys(objectValue)
  if (ownNames.length !== enumerableNames.length) {
    return replayResponseError(`${label} must contain only enumerable properties`)
  }
  for (const key of ownNames) {
    const descriptor = Object.getOwnPropertyDescriptor(objectValue, key)
    if (descriptor === undefined || !('value' in descriptor)) {
      return replayResponseError(`${label}.${key} must be a data property`)
    }
  }

  return value as ReplayObject
}

function replayExactObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): ReplayObject {
  const object = replayDataObject(value, label)
  const actualKeys = Object.keys(object)
  if (
    actualKeys.length !== expectedKeys.length
    || expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(object, key))
  ) {
    return replayResponseError(`${label} has an invalid field set`)
  }
  return object
}

function assertReplayString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string') return replayResponseError(`${field} must be a string`)
}

function assertReplayBoolean(value: unknown, field: string): asserts value is boolean {
  if (typeof value !== 'boolean') return replayResponseError(`${field} must be a boolean`)
}

function assertReplaySafeInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return replayResponseError(`${field} must be a safe integer`)
  }
}

function assertReplayPositiveSafeInteger(value: unknown, field: string): asserts value is number {
  assertReplaySafeInteger(value, field)
  if (value <= 0) return replayResponseError(`${field} must be positive`)
}

function assertReplayNullableSafeInteger(value: unknown, field: string): void {
  if (value !== null) assertReplaySafeInteger(value, field)
}

function assertReplayEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): asserts value is T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    return replayResponseError(`${field} has an invalid value`)
  }
}

function assertLedgerSettingsReplayBody(value: unknown): asserts value is LedgerSettingsDto {
  const object = replayExactObject(
    value,
    Object.prototype.hasOwnProperty.call(value, 'accountIcons')
      ? LEDGER_SETTINGS_REPLAY_KEYS
      : LEDGER_SETTINGS_REPLAY_KEYS.filter((key) => key !== 'accountIcons'),
    'settings response',
  )
  assertReplayString(object.baseCurrency, 'settings response.baseCurrency')
  assertReplaySafeInteger(object.currencyExponent, 'settings response.currencyExponent')
  assertReplayString(object.timezone, 'settings response.timezone')
  assertReplayBoolean(object.hasCreatedAccount, 'settings response.hasCreatedAccount')
  assertReplayPositiveSafeInteger(object.version, 'settings response.version')
  assertReplaySafeInteger(object.createdAt, 'settings response.createdAt')
  assertReplaySafeInteger(object.updatedAt, 'settings response.updatedAt')
  const accountIcons = object.accountIcons
  if (accountIcons === undefined) return
  if (accountIcons === null || typeof accountIcons !== 'object' || Array.isArray(accountIcons)) return replayResponseError('settings response.accountIcons must be an object')
  const config = accountIcons as Record<string, unknown>
  if (typeof config.defaultIcon !== 'string' || !Array.isArray(config.availableIcons)
    || config.customIcons === null || typeof config.customIcons !== 'object'
    || config.customIconNames === null || typeof config.customIconNames !== 'object') {
    return replayResponseError('settings response.accountIcons has an invalid shape')
  }
}

function assertLedgerAccountReplayBody(value: unknown): asserts value is LedgerAccountDto {
  const object = replayExactObject(
    value,
    Object.prototype.hasOwnProperty.call(value, 'icon')
      ? [...LEDGER_ACCOUNT_REPLAY_KEYS, 'icon', ...(Object.prototype.hasOwnProperty.call(value, 'cardNumber') ? ['cardNumber'] : [])]
      : Object.prototype.hasOwnProperty.call(value, 'cardNumber')
        ? [...LEDGER_ACCOUNT_REPLAY_KEYS, 'cardNumber']
        : LEDGER_ACCOUNT_REPLAY_KEYS,
    'account response',
  )
  assertReplayString(object.id, 'account response.id')
  assertReplayString(object.name, 'account response.name')
  assertReplayEnum(object.type, ['cash', 'bank', 'wallet', 'credit_card', 'loan', 'other'], 'account response.type')
  assertReplayEnum(object.nature, ['asset', 'liability'], 'account response.nature')
  if (Object.prototype.hasOwnProperty.call(object, 'icon')) {
    if (!(['wallet', 'credit_card', 'cash', 'building_bank', 'briefcase'].includes(object.icon as string)
      || /^custom_[a-z0-9_]+$/.test(object.icon as string))) {
      throw new TypeError('Ledger replay response rejected: account response.icon has an unsupported value')
    }
  }
  assertReplaySafeInteger(object.openingBalanceMinor, 'account response.openingBalanceMinor')
  assertReplayString(object.openingDate, 'account response.openingDate')
  assertReplayString(object.currency, 'account response.currency')
  assertReplaySafeInteger(object.currencyExponent, 'account response.currencyExponent')
  assertReplayString(object.note, 'account response.note')
  if (Object.prototype.hasOwnProperty.call(object, 'cardNumber')) {
    assertReplayString(object.cardNumber, 'account response.cardNumber')
  }
  assertReplayNullableSafeInteger(object.archivedAt, 'account response.archivedAt')
  assertReplayPositiveSafeInteger(object.version, 'account response.version')
  assertReplaySafeInteger(object.createdAt, 'account response.createdAt')
  assertReplaySafeInteger(object.updatedAt, 'account response.updatedAt')
  assertReplaySafeInteger(object.currentBalanceMinor, 'account response.currentBalanceMinor')
}

function assertLedgerCategoryReplayBody(value: unknown): asserts value is LedgerCategoryDto {
  const optionalKeys = [
    ...(Object.prototype.hasOwnProperty.call(value, 'icon') ? ['icon'] : []),
    ...(Object.prototype.hasOwnProperty.call(value, 'systemKey') ? ['systemKey'] : []),
    ...(Object.prototype.hasOwnProperty.call(value, 'protected') ? ['protected'] : []),
  ]
  const object = replayExactObject(
    value,
    [...LEDGER_CATEGORY_REPLAY_KEYS, ...optionalKeys],
    'category response',
  )
  assertReplayString(object.id, 'category response.id')
  assertReplayEnum(object.kind, ['income', 'expense'], 'category response.kind')
  assertReplayString(object.name, 'category response.name')
  assertReplayString(object.normalizedName, 'category response.normalizedName')
  if (Object.prototype.hasOwnProperty.call(object, 'systemKey')) {
    assertReplayEnum(object.systemKey, ['interest', 'fee'], 'category response.systemKey')
  }
  if (Object.prototype.hasOwnProperty.call(object, 'protected') && typeof object.protected !== 'boolean') {
    throw new TypeError('Ledger replay response rejected: category response.protected must be boolean')
  }
  if (Object.prototype.hasOwnProperty.call(object, 'icon')) {
    if (!(['wallet', 'credit_card', 'cash', 'building_bank', 'briefcase'].includes(object.icon as string)
      || /^custom_[a-z0-9_]+$/.test(object.icon as string))) {
      throw new TypeError('Ledger replay response rejected: category response.icon has an unsupported value')
    }
  }
  assertReplayNullableSafeInteger(object.archivedAt, 'category response.archivedAt')
  assertReplayPositiveSafeInteger(object.version, 'category response.version')
  assertReplaySafeInteger(object.createdAt, 'category response.createdAt')
  assertReplaySafeInteger(object.updatedAt, 'category response.updatedAt')
}

function assertLedgerTransactionBaseReplayBody(object: ReplayObject, label: string): void {
  assertReplayString(object.id, `${label}.id`)
  if (Object.prototype.hasOwnProperty.call(object, 'groupId')) {
    assertReplayString(object.groupId, `${label}.groupId`)
  }
  assertReplaySafeInteger(object.amountMinor, `${label}.amountMinor`)
  assertReplaySafeInteger(object.occurredAt, `${label}.occurredAt`)
  if (Object.prototype.hasOwnProperty.call(object, 'location')) {
    assertReplayString(object.location, `${label}.location`)
  }
  assertReplayString(object.note, `${label}.note`)
  assertReplayNullableSafeInteger(object.deletedAt, `${label}.deletedAt`)
  assertReplayPositiveSafeInteger(object.version, `${label}.version`)
  assertReplaySafeInteger(object.createdAt, `${label}.createdAt`)
  assertReplaySafeInteger(object.updatedAt, `${label}.updatedAt`)
}

function assertLedgerTransactionReplayBody(value: unknown): asserts value is LedgerTransactionDto {
  const object = replayDataObject(value, 'transaction response')
  switch (object.type) {
    case 'income':
      replayExactObject(object, transactionReplayKeys(object, LEDGER_INCOME_REPLAY_KEYS), 'income response')
      assertReplayEnum(object.type, ['income'], 'income response.type')
      assertLedgerTransactionBaseReplayBody(object, 'income response')
      assertReplayString(object.accountId, 'income response.accountId')
      assertReplayString(object.categoryId, 'income response.categoryId')
      assertReplayString(object.payee, 'income response.payee')
      return
    case 'expense':
      replayExactObject(object, transactionReplayKeys(object, LEDGER_EXPENSE_REPLAY_KEYS), 'expense response')
      assertReplayEnum(object.type, ['expense'], 'expense response.type')
      assertLedgerTransactionBaseReplayBody(object, 'expense response')
      assertReplayString(object.accountId, 'expense response.accountId')
      assertReplayString(object.categoryId, 'expense response.categoryId')
      assertReplayString(object.payee, 'expense response.payee')
      return
    case 'transfer':
      if (!Object.prototype.hasOwnProperty.call(object, 'transferKind')) {
        object.transferKind = 'general'
      }
      replayExactObject(
        object,
        transactionReplayKeys(object, Object.prototype.hasOwnProperty.call(object, 'payee')
          ? LEDGER_TRANSFER_REPLAY_KEYS
          : LEDGER_TRANSFER_REPLAY_KEYS.filter((key) => key !== 'payee')),
        'transfer response',
      )
      assertReplayEnum(object.type, ['transfer'], 'transfer response.type')
      assertReplayEnum(object.transferKind, ['general', 'repayment', 'withdrawal'], 'transfer response.transferKind')
      if (Object.prototype.hasOwnProperty.call(object, 'feeMode')) {
        assertReplayEnum(object.feeMode, ['extra', 'deducted'], 'transfer response.feeMode')
      }
      assertLedgerTransactionBaseReplayBody(object, 'transfer response')
      assertReplayString(object.fromAccountId, 'transfer response.fromAccountId')
      assertReplayString(object.toAccountId, 'transfer response.toAccountId')
      if (Object.prototype.hasOwnProperty.call(object, 'payee')) {
        assertReplayString(object.payee, 'transfer response.payee')
      }
      return
    case 'adjustment':
      replayExactObject(object, transactionReplayKeys(object, LEDGER_ADJUSTMENT_REPLAY_KEYS), 'adjustment response')
      assertReplayEnum(object.type, ['adjustment'], 'adjustment response.type')
      assertLedgerTransactionBaseReplayBody(object, 'adjustment response')
      assertReplayString(object.accountId, 'adjustment response.accountId')
      assertReplaySafeInteger(
        object.adjustmentCalculatedBalanceMinor,
        'adjustment response.adjustmentCalculatedBalanceMinor',
      )
      assertReplaySafeInteger(
        object.adjustmentTargetBalanceMinor,
        'adjustment response.adjustmentTargetBalanceMinor',
      )
      return
    default:
      return replayResponseError('transaction response.type has an invalid value')
  }
}

function assertLedgerAdjustmentReplayBody(
  value: unknown,
): asserts value is Extract<LedgerTransactionDto, { type: 'adjustment' }> {
  assertLedgerTransactionReplayBody(value)
  if (value.type !== 'adjustment') {
    return replayResponseError('adjustment response must have type adjustment')
  }
}

function assertLedgerAdjustmentMutationReplayBody(
  value: unknown,
): asserts value is LedgerAdjustmentAppliedDto | LedgerAdjustmentNoOpDto {
  const object = replayExactObject(
    value,
    LEDGER_ADJUSTMENT_MUTATION_REPLAY_KEYS,
    'adjustment mutation response',
  )
  assertReplayBoolean(object.noOp, 'adjustment mutation response.noOp')
  assertLedgerAccountReplayBody(object.account)

  if (object.noOp === true) {
    if (object.adjustment !== null) {
      return replayResponseError('no-op adjustment response must contain null adjustment')
    }
    return
  }

  assertLedgerAdjustmentReplayBody(object.adjustment)
}

function assertLedgerReplayResponseBody(value: unknown): asserts value is LedgerReplayResponseBody {
  const object = replayDataObject(value, 'replay response')
  if (Object.prototype.hasOwnProperty.call(object, 'noOp')
    || Object.prototype.hasOwnProperty.call(object, 'adjustment')) {
    return assertLedgerAdjustmentMutationReplayBody(object)
  }
  if (Object.prototype.hasOwnProperty.call(object, 'currentBalanceMinor')) {
    return assertLedgerAccountReplayBody(object)
  }
  if (Object.prototype.hasOwnProperty.call(object, 'type')) {
    return assertLedgerTransactionReplayBody(object)
  }
  if (Object.prototype.hasOwnProperty.call(object, 'normalizedName')) {
    return assertLedgerCategoryReplayBody(object)
  }
  if (Object.prototype.hasOwnProperty.call(object, 'baseCurrency')) {
    return assertLedgerSettingsReplayBody(object)
  }
  return replayResponseError('response body is not a supported Ledger DTO')
}

function isLedgerAdjustmentNoOpReplayBody(
  value: LedgerReplayResponseBody,
): value is LedgerNoOpReplayResponseBody {
  return 'noOp' in value && value.noOp === true
}

function assertLedgerCommittedReplayResponseBody(
  value: unknown,
): asserts value is LedgerCommittedReplayResponseBody {
  assertLedgerReplayResponseBody(value)
  if (isLedgerAdjustmentNoOpReplayBody(value)) {
    return replayResponseError('committed response must not be an Adjustment no-op')
  }
}

function assertLedgerNoOpReplayResponseBody(
  value: unknown,
): asserts value is LedgerNoOpReplayResponseBody {
  assertLedgerReplayResponseBody(value)
  if (!isLedgerAdjustmentNoOpReplayBody(value)) {
    return replayResponseError('no-op response must be an Adjustment no-op')
  }
}

/** Serialize a closed Ledger success/no-op body for durable replay. */
export function serializeLedgerReplayResponse(responseBody: LedgerReplayResponseBody): string {
  assertLedgerReplayResponseBody(responseBody)
  return stableSerializeLedgerJson(responseBody)
}

/** Fingerprint an already parsed and normalized Ledger create request. */
export function fingerprintLedgerMutation(request: LedgerCanonicalMutation): string {
  return createHash('sha256')
    .update(stableSerializeLedgerJson(request), 'utf8')
    .digest('hex')
}

export type LedgerIdempotentResult =
  | {
      readonly resultStatus: 'committed'
      readonly responseStatus: 201
      readonly responseBody: LedgerCommittedReplayResponseBody
      readonly resultType?: string | null
      readonly resultId?: string | null
    }
  | {
      readonly resultStatus: 'no-op'
      readonly responseStatus: 200
      readonly responseBody: LedgerNoOpReplayResponseBody
      readonly resultType?: string | null
      readonly resultId?: string | null
    }

export interface LedgerReplayResult {
  readonly responseStatus: 200 | 201
  readonly responseBodyJson: string
  readonly replayed: boolean
}

type NonPromiseResult<T> = T extends PromiseLike<unknown> ? never : T

export interface ExecuteIdempotentLedgerCreateInput {
  readonly operationScope: string
  readonly idempotencyKey: string
  readonly request: LedgerCanonicalMutation
  readonly mutation: () => NonPromiseResult<LedgerIdempotentResult>
  /** Test-only failure seam; never supplied by an HTTP/API caller. */
  readonly afterMutationBeforeIdempotencyInsert?: () => void
  readonly createdAt?: number
}

function invalidExecution(message: string): never {
  throw ledgerValidationError(message)
}

function assertMutationResult(value: unknown): asserts value is LedgerIdempotentResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalidExecution('Ledger idempotent mutation must return a result object')
  }

  const result = value as Record<string, unknown>
  if (result.resultStatus !== 'committed' && result.resultStatus !== 'no-op') {
    return invalidExecution('Ledger idempotent mutation returned an invalid result status')
  }
  const expectedResponseStatus = result.resultStatus === 'committed' ? 201 : 200
  if (result.responseStatus !== expectedResponseStatus) {
    return invalidExecution('Ledger idempotent mutation returned an invalid response status')
  }
  if (result.resultStatus === 'committed') {
    assertLedgerCommittedReplayResponseBody(result.responseBody)
  } else {
    assertLedgerNoOpReplayResponseBody(result.responseBody)
  }
  if (result.resultType !== undefined && result.resultType !== null && typeof result.resultType !== 'string') {
    return invalidExecution('Ledger idempotent mutation returned an invalid result type')
  }
  if (result.resultId !== undefined && result.resultId !== null && typeof result.resultId !== 'string') {
    return invalidExecution('Ledger idempotent mutation returned an invalid result id')
  }
}

function assertReplayStatus(status: number): asserts status is 200 | 201 {
  if (status !== 200 && status !== 201) {
    return invalidExecution('Ledger replay record has an unsupported response status')
  }
}

function replayResult(record: LedgerIdempotencyRecord): LedgerReplayResult {
  assertReplayStatus(record.responseStatus)
  return {
    responseStatus: record.responseStatus,
    responseBodyJson: record.responseBodyJson,
    replayed: true,
  }
}

/**
 * Execute a successful Ledger create/no-op and durably snapshot its first
 * response. The mutation and replay row share runLedgerWrite's transaction.
 */
export function executeIdempotentLedgerCreate(
  db: DatabaseT,
  repository: LedgerRepository,
  input: ExecuteIdempotentLedgerCreateInput,
): LedgerReplayResult {
  const requestFingerprint = fingerprintLedgerMutation(input.request)

  return runLedgerWrite(db, () => {
    const existing = repository.getIdempotencyRecord(input.operationScope, input.idempotencyKey)
    if (existing !== null) {
      if (existing.requestFingerprint !== requestFingerprint) {
        throw new LedgerError(
          'ledger-idempotency-conflict',
          409,
          'Idempotency-Key was already used for a different Ledger request',
        )
      }
      return replayResult(existing)
    }

    // Delegate the callback itself to the L0.3 helper so its runtime
    // native-async and thenable guards also cover escaped callers.
    const mutationResult = runLedgerWrite(db, input.mutation)
    assertMutationResult(mutationResult)
    const responseBodyJson = serializeLedgerReplayResponse(mutationResult.responseBody)
    const createdAt = input.createdAt ?? Date.now()
    if (!Number.isSafeInteger(createdAt)) {
      return invalidExecution('Ledger idempotency createdAt must be a safe integer')
    }

    input.afterMutationBeforeIdempotencyInsert?.()

    repository.insertIdempotencyRecord({
      operationScope: input.operationScope,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint,
      responseStatus: mutationResult.responseStatus,
      responseBodyJson,
      resultStatus: mutationResult.resultStatus,
      resultType: mutationResult.resultType ?? null,
      resultId: mutationResult.resultId ?? null,
      createdAt,
    })

    return {
      responseStatus: mutationResult.responseStatus,
      responseBodyJson,
      replayed: false,
    }
  })
}
