import { randomUUID } from 'node:crypto'
import type { Database as DatabaseT } from 'better-sqlite3'
import {
  currencyExponentFor,
  normalizeLedgerCurrencyCode,
} from '../../shared/ledgerCurrency.js'
import { normalizeLedgerCategoryName } from '../../shared/ledgerNormalization.js'
import type {
  LedgerAccountCreateRequest,
  LedgerAccountDto,
  LedgerAccountNature,
  LedgerAccountType,
  LedgerAdjustmentAppliedDto,
  LedgerAdjustmentEndpointRequest,
  LedgerAdjustmentTransactionDto,
  LedgerCategoryCreateRequest,
  LedgerCategoryDto,
  LedgerCategoryKind,
  LedgerSettingsCreateRequest,
  LedgerSettingsDto,
  LedgerTransactionCreateRequest,
  LedgerTransactionDto,
  LedgerTransferFeeMode,
  LedgerTransferKind,
} from '../../shared/ledgerProtocol.js'
import { LEDGER_BUILTIN_ACCOUNT_ICON_NAMES, LEDGER_DEFAULT_ACCOUNT_ICONS } from '../../shared/ledgerProtocol.js'
import {
  deriveCurrentBalance,
} from './balance.js'
import {
  isLedgerAccountTypeNature,
  type LedgerAccount,
  type LedgerCategory,
  type LedgerSettings,
  type AdjustmentTransaction,
  type ExpenseTransaction,
  type IncomeTransaction,
  type LedgerTransaction,
  type TransferTransaction,
} from './domain.js'
import { LedgerError, ledgerValidationError } from './errors.js'
import {
  executeIdempotentLedgerCreate,
  ledgerAccountAdjustmentOperationScope,
  LEDGER_IDEMPOTENCY_OPERATION_SCOPES,
  type LedgerIdempotentResult,
  type LedgerReplayResult,
} from './idempotency.js'
import {
  assertNonNegativeSafeInteger,
  assertPositiveMinor,
  checkedAddMinor,
  checkedSubMinor,
} from './money.js'
import { createLedgerRepository, type LedgerRepository } from './repository.js'
import {
  parseAccountPatchRequest,
  parseCategoryPatchRequest,
  parseExpectedVersion,
  parseExpectedVersionCommand,
  parseSettingsPatchRequest,
  parseTransactionPatchRequest,
  type LedgerAccountPatchRequest,
  type LedgerCategoryPatchRequest,
  type LedgerSettingsPatchRequest,
  type LedgerTransactionPatchRequest,
} from './validation.js'
import { assertUtcMilliseconds, openingBoundaryMs, validateOccurredAt } from './time.js'
import { runLedgerWrite } from './writeTransaction.js'
import { seedDefaultLedgerCategories } from './defaultCategories.js'

export interface LedgerServiceDependencies {
  readonly now?: () => number
  readonly createId?: () => string
}

export interface LedgerDeletedResponse {
  readonly deleted: true
  readonly id: string
}

export interface LedgerService {
  getSettings(): LedgerSettingsDto
  createSettings(request: LedgerSettingsCreateRequest, idempotencyKey: string): LedgerReplayResult
  patchSettings(value: unknown): LedgerSettingsDto

  listAccounts(includeArchived: boolean): LedgerAccountDto[]
  getAccount(id: string): LedgerAccountDto
  createAccount(request: LedgerAccountCreateRequest, idempotencyKey: string): LedgerReplayResult
  patchAccount(id: string, value: unknown): LedgerAccountDto
  deleteAccount(id: string, value: unknown): LedgerDeletedResponse
  archiveAccount(id: string, value: unknown): LedgerAccountDto
  restoreAccount(id: string, value: unknown): LedgerAccountDto

  listCategories(
    kind: LedgerCategoryKind | undefined,
    includeArchived: boolean,
  ): LedgerCategoryDto[]
  createCategory(request: LedgerCategoryCreateRequest, idempotencyKey: string): LedgerReplayResult
  patchCategory(id: string, value: unknown): LedgerCategoryDto
  deleteCategory(id: string, value: unknown): LedgerDeletedResponse
  archiveCategory(id: string, value: unknown): LedgerCategoryDto
  restoreCategory(id: string, value: unknown): LedgerCategoryDto

  getTransaction(id: string): LedgerTransactionDto
  createTransaction(
    request: LedgerTransactionCreateRequest,
    idempotencyKey: string,
  ): LedgerReplayResult
  patchTransaction(id: string, value: unknown): LedgerTransactionDto
  deleteTransaction(id: string, value: unknown): LedgerTransactionDto
  adjustAccount(
    id: string,
    request: LedgerAdjustmentEndpointRequest,
    idempotencyKey: string,
  ): LedgerReplayResult
}

type MutationRecord = Record<string, unknown>

function asMutationRecord(value: unknown): MutationRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as MutationRecord
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function notFound(entity: string): never {
  throw new LedgerError('ledger-not-found', 404, `${entity} was not found`)
}

function versionConflict(): never {
  throw new LedgerError('ledger-version-conflict', 409, 'Ledger resource version is stale')
}

function assertExpectedVersion(currentVersion: number, expectedVersion: number): void {
  if (currentVersion !== expectedVersion) versionConflict()
}

function nextVersion(currentVersion: number): number {
  if (currentVersion >= Number.MAX_SAFE_INTEGER) {
    throw ledgerValidationError('Ledger resource version cannot be incremented safely', {
      field: 'version',
    })
  }
  return currentVersion + 1
}

function generatedTimestamp(now: () => number): number {
  return assertUtcMilliseconds(now(), 'server timestamp')
}

function generatedId(createId: () => string): string {
  const id = createId()
  if (typeof id !== 'string' || id.length === 0) {
    throw ledgerValidationError('server-generated Ledger ID must be a non-empty string')
  }
  return id
}

function invalidAccountPair(type: LedgerAccountType, nature: LedgerAccountNature): never {
  throw new LedgerError(
    'ledger-invalid-account-pair',
    400,
    `Account type ${type} cannot use nature ${nature}`,
    { field: 'nature' },
  )
}

function assertAccountPair(type: LedgerAccountType, nature: LedgerAccountNature): void {
  if (!isLedgerAccountTypeNature(type, nature)) invalidAccountPair(type, nature)
}

function duplicateCategory(): never {
  throw new LedgerError(
    'ledger-duplicate-category',
    409,
    'A Ledger Category with the same kind and name already exists',
  )
}

function archivedAccount(): never {
  throw new LedgerError(
    'ledger-archived-account',
    409,
    'Archived Accounts must be restored before financial fields can be changed',
  )
}

function archivedCategory(): never {
  throw new LedgerError(
    'ledger-archived-category',
    409,
    'Archived Categories must be restored before they can be changed',
  )
}

function invalidTransactionPair(): never {
  throw ledgerValidationError('Transfer accounts must be distinct', { field: 'toAccountId' })
}

function categoryKindMismatch(): never {
  throw new LedgerError(
    'ledger-category-kind-mismatch',
    409,
    'Transaction type and Category kind must match',
    { field: 'categoryId' },
  )
}

function transactionTypeImmutable(): never {
  throw new LedgerError(
    'ledger-transaction-type-immutable',
    409,
    'Transaction type cannot be changed after creation',
    { field: 'type' },
  )
}

function transactionDeleted(): never {
  throw new LedgerError(
    'ledger-transaction-deleted',
    409,
    'Deleted Transactions are terminal and cannot be changed',
  )
}

function adjustmentImmutable(): never {
  throw new LedgerError(
    'ledger-adjustment-immutable',
    409,
    'Adjustment financial semantics cannot be changed; create a new Adjustment instead',
  )
}

function invalidTransactionPatchField(field: string): never {
  throw ledgerValidationError(`Field ${field} is not applicable to this Transaction type`, { field })
}

function toSettingsDto(settings: LedgerSettings): LedgerSettingsDto {
  return {
    baseCurrency: settings.baseCurrency,
    currencyExponent: currencyExponentFor(settings.baseCurrency),
    timezone: settings.timezone,
    hasCreatedAccount: settings.hasCreatedAccount,
    version: settings.version,
    createdAt: settings.createdAt,
    updatedAt: settings.updatedAt,
    accountIcons: settings.accountIcons,
  }
}

function toCategoryDto(category: LedgerCategory): LedgerCategoryDto {
  return {
    id: category.id,
    kind: category.kind,
    name: category.name,
    normalizedName: category.normalizedName,
    ...(category.systemKey ? { systemKey: category.systemKey } : {}),
    ...(category.isDefault || category.systemKey ? { protected: true } : {}),
    ...(category.icon && category.icon !== 'wallet' ? { icon: category.icon } : {}),
    archivedAt: category.archivedAt,
    version: category.version,
    createdAt: category.createdAt,
    updatedAt: category.updatedAt,
  }
}

function toTransactionDto(transaction: LedgerTransaction): LedgerTransactionDto {
  const base = {
    id: transaction.id,
    ...(transaction.groupId ? { groupId: transaction.groupId } : {}),
    amountMinor: transaction.amountMinor,
    occurredAt: transaction.occurredAt,
    location: transaction.location,
    note: transaction.note,
    deletedAt: transaction.deletedAt,
    version: transaction.version,
    createdAt: transaction.createdAt,
    updatedAt: transaction.updatedAt,
  }

  switch (transaction.type) {
    case 'income':
      return {
        ...base,
        type: 'income',
        accountId: transaction.accountId,
        categoryId: transaction.categoryId,
        payee: transaction.payee,
      }
    case 'expense':
      return {
        ...base,
        type: 'expense',
        accountId: transaction.accountId,
        categoryId: transaction.categoryId,
        payee: transaction.payee,
      }
    case 'transfer':
      return {
        ...base,
        type: 'transfer',
        transferKind: transaction.transferKind,
        ...(transaction.feeMode ? { feeMode: transaction.feeMode as LedgerTransferFeeMode } : {}),
        fromAccountId: transaction.fromAccountId,
        toAccountId: transaction.toAccountId,
        payee: transaction.payee,
      }
    case 'adjustment':
      return {
        ...base,
        type: 'adjustment',
        accountId: transaction.accountId,
        adjustmentCalculatedBalanceMinor: transaction.adjustmentCalculatedBalanceMinor,
        adjustmentTargetBalanceMinor: transaction.adjustmentTargetBalanceMinor,
      }
  }
}

function toAdjustmentDto(transaction: AdjustmentTransaction): LedgerAdjustmentTransactionDto {
  const dto = toTransactionDto(transaction)
  if (dto.type !== 'adjustment') {
    throw new Error('Ledger Adjustment DTO conversion received a non-adjustment transaction')
  }
  return dto
}

export function createLedgerService(
  db: DatabaseT,
  repository: LedgerRepository = createLedgerRepository(db),
  dependencies: LedgerServiceDependencies = {},
): LedgerService {
  const now = dependencies.now ?? Date.now
  const createId = dependencies.createId ?? randomUUID

  function requireSettings(): LedgerSettings {
    const settings = repository.getSettings()
    if (settings === null) notFound('Ledger Settings')
    return settings
  }

  function toAccountDto(account: LedgerAccount): LedgerAccountDto {
    return {
      id: account.id,
      name: account.name,
      type: account.type,
      nature: account.nature,
      ...(account.icon && account.icon !== 'wallet' ? { icon: account.icon } : {}),
      openingBalanceMinor: account.openingBalanceMinor,
      openingDate: account.openingDate,
      currency: account.currency,
      currencyExponent: currencyExponentFor(account.currency),
      note: account.note,
      ...(account.cardNumber ? { cardNumber: account.cardNumber } : {}),
      archivedAt: account.archivedAt,
      version: account.version,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      currentBalanceMinor: deriveCurrentBalance(
        account,
        repository.listActiveTransactionsForAccount(account.id),
      ),
    }
  }

  function requireAccount(id: string): LedgerAccount {
    const account = repository.getAccount(id)
    if (account === null) notFound('Ledger Account')
    return account
  }

  function requireActiveAccount(id: string): LedgerAccount {
    const account = requireAccount(id)
    if (account.archivedAt !== null) archivedAccount()
    return account
  }

  function requireCategory(id: string): LedgerCategory {
    const category = repository.getCategory(id)
    if (category === null) notFound('Ledger Category')
    return category
  }

  function assertTransactionCurrency(
    settings: LedgerSettings,
    account: LedgerAccount,
  ): void {
    if (account.currency !== settings.baseCurrency) {
      throw new LedgerError(
        'ledger-currency-mismatch',
        409,
        'Transaction Account currency must match the Ledger base currency',
        { field: 'accountId' },
      )
    }
  }

  function assertTransactionTime(
    settings: LedgerSettings,
    accounts: readonly LedgerAccount[],
    occurredAt: number,
    nowMs: number,
  ): void {
    validateOccurredAt(occurredAt, nowMs)
    for (const account of accounts) {
      if (occurredAt < openingBoundaryMs(account.openingDate, settings.timezone)) {
        throw new LedgerError(
          'ledger-opening-date-conflict',
          409,
          'Transaction occurredAt cannot precede an Account opening boundary',
          { field: 'occurredAt', accountId: account.id },
        )
      }
    }
  }

  function assertCategoryForTransaction(
    category: LedgerCategory,
    type: 'income' | 'expense',
  ): void {
    if (category.kind !== type) categoryKindMismatch()
  }

  function requireSystemCategory(systemKey: 'interest' | 'fee'): LedgerCategory {
    const category = repository.findCategoryBySystemKey(systemKey)
    if (category === null || category.archivedAt !== null) {
      throw ledgerValidationError('Required Ledger system category is unavailable', {
        field: 'systemKey',
        systemKey,
      })
    }
    return category
  }

  function companionPayee(
    transferKind: LedgerTransferKind,
    fromAccountName: string,
    toAccountName: string,
    transferPayee: string,
  ): string {
    if (transferKind === 'repayment') return `${toAccountName}还款利息`
    if (transferKind === 'withdrawal') return `${fromAccountName}提现手续费`
    return transferPayee
  }

  function assertTransferKindAccounts(
    kind: LedgerTransferKind,
    fromAccount: LedgerAccount,
    toAccount: LedgerAccount,
  ): void {
    const valid = kind === 'general'
      || (kind === 'repayment' && fromAccount.nature === 'asset' && toAccount.nature === 'liability')
      || (kind === 'withdrawal' && fromAccount.nature === 'asset' && toAccount.nature === 'asset')
    if (!valid) {
      throw ledgerValidationError('Transfer kind does not match the selected Account natures', {
        field: 'transferKind',
        transferKind: kind,
        fromAccountNature: fromAccount.nature,
        toAccountNature: toAccount.nature,
      })
    }
  }

  function transactionAccountIds(transaction: LedgerTransaction): readonly string[] {
    switch (transaction.type) {
      case 'income':
      case 'expense':
      case 'adjustment':
        return [transaction.accountId]
      case 'transfer':
        return [transaction.fromAccountId, transaction.toAccountId]
    }
  }

  function transactionAccounts(transaction: LedgerTransaction): LedgerAccount[] {
    return transactionAccountIds(transaction).map(requireAccount)
  }

  function assertTransactionAccountsNotArchived(transaction: LedgerTransaction): void {
    if (transactionAccounts(transaction).some((account) => account.archivedAt !== null)) {
      archivedAccount()
    }
  }

  function assertArchivedPatchWhitelist(
    transaction: LedgerTransaction,
    rawRecord: MutationRecord | null,
  ): void {
    if (!transactionAccounts(transaction).some((account) => account.archivedAt !== null)) return
    if (rawRecord === null) archivedAccount()

    const allowed = transaction.type === 'income' || transaction.type === 'expense'
      ? new Set(['expectedVersion', 'location', 'note', 'payee'])
      : new Set(['expectedVersion', 'location', 'note'])
    if (Object.keys(rawRecord).some((key) => !allowed.has(key))) archivedAccount()
  }

  function assertCandidateAccountsNotArchived(
    transaction: LedgerTransaction,
    rawRecord: MutationRecord | null,
  ): void {
    if (rawRecord === null) return
    const fields: readonly string[] = transaction.type === 'transfer'
      ? ['fromAccountId', 'toAccountId']
      : ['accountId']
    for (const field of fields) {
      if (!hasOwn(rawRecord, field) || typeof rawRecord[field] !== 'string') continue
      const candidate = repository.getAccount(rawRecord[field])
      if (candidate !== null && candidate.archivedAt !== null) archivedAccount()
    }
  }

  function assertPatchFields(
    transaction: LedgerTransaction,
    patch: LedgerTransactionPatchRequest,
  ): void {
    const inapplicable = transaction.type === 'income' || transaction.type === 'expense'
      ? ['transferKind', 'fromAccountId', 'toAccountId', 'feeMinor', 'feeMode', 'adjustmentCalculatedBalanceMinor', 'adjustmentTargetBalanceMinor']
      : transaction.type === 'transfer'
        ? ['accountId', 'categoryId', 'adjustmentCalculatedBalanceMinor', 'adjustmentTargetBalanceMinor']
        : ['transferKind', 'amountMinor', 'accountId', 'fromAccountId', 'toAccountId', 'categoryId', 'occurredAt', 'payee',
          'feeMinor', 'feeMode', 'adjustmentCalculatedBalanceMinor', 'adjustmentTargetBalanceMinor']

    for (const field of inapplicable) {
      if (hasOwn(patch, field)) {
        if (transaction.type === 'adjustment') adjustmentImmutable()
        invalidTransactionPatchField(field)
      }
    }
  }

  function assertCandidateCategory(
    categoryId: string,
    type: 'income' | 'expense',
  ): LedgerCategory {
    const category = requireCategory(categoryId)
    if (category.archivedAt !== null) archivedCategory()
    assertCategoryForTransaction(category, type)
    return category
  }

  function checkSettingsLock(settings: LedgerSettings, value: unknown): void {
    if (!settings.hasCreatedAccount) return
    const record = asMutationRecord(value)
    if (record === null) return

    if (hasOwn(record, 'timezone') && record.timezone !== settings.timezone) {
      throw new LedgerError(
        'ledger-timezone-locked',
        409,
        'Ledger timezone is locked after the first Account is created',
        { field: 'timezone' },
      )
    }

    if (hasOwn(record, 'baseCurrency')) {
      let sameCurrency = false
      if (typeof record.baseCurrency === 'string') {
        try {
          sameCurrency = normalizeLedgerCurrencyCode(record.baseCurrency) === settings.baseCurrency
        } catch {
          sameCurrency = false
        }
      }
      if (!sameCurrency) {
        throw new LedgerError(
          'ledger-base-currency-locked',
          409,
          'Ledger base currency is locked after the first Account is created',
          { field: 'baseCurrency' },
        )
      }
    }
  }

  function patchSettings(value: unknown): LedgerSettingsDto {
    return runLedgerWrite(db, () => {
      const settings = requireSettings()
      checkSettingsLock(settings, value)

      // Compare the expected version before the full payload parser so a
      // valid stale command cannot be masked by an unrelated payload error.
      const rawRecord = asMutationRecord(value)
      if (rawRecord !== null) {
        const expectedVersion = parseExpectedVersion(rawRecord)
        assertExpectedVersion(settings.version, expectedVersion)
      }
      const patch = parseSettingsPatchRequest(value)
      assertExpectedVersion(settings.version, patch.expectedVersion)

      const updated: LedgerSettings = {
        ...settings,
        ...(patch.baseCurrency === undefined ? {} : { baseCurrency: patch.baseCurrency }),
        ...(patch.timezone === undefined ? {} : { timezone: patch.timezone }),
        ...(patch.accountIcons === undefined ? {} : { accountIcons: patch.accountIcons }),
        version: nextVersion(settings.version),
        updatedAt: generatedTimestamp(now),
      }
      if (repository.updateSettings({ settings: updated, expectedVersion: settings.version }) !== 1) {
        versionConflict()
      }
      return toSettingsDto(updated)
    })
  }

  function createSettings(
    request: LedgerSettingsCreateRequest,
    idempotencyKey: string,
  ): LedgerReplayResult {
    return executeIdempotentLedgerCreate(db, repository, {
      operationScope: LEDGER_IDEMPOTENCY_OPERATION_SCOPES.settings,
      idempotencyKey,
      request,
      mutation: (): LedgerIdempotentResult => {
        if (repository.getSettings() !== null) {
          throw new LedgerError(
            'ledger-settings-already-initialized',
            409,
            'Ledger Settings are already initialized',
          )
        }
        const timestamp = generatedTimestamp(now)
        const settings: LedgerSettings = {
          baseCurrency: request.baseCurrency,
          timezone: request.timezone,
          hasCreatedAccount: false,
          version: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          accountIcons: {
            defaultIcon: 'wallet',
            availableIcons: LEDGER_DEFAULT_ACCOUNT_ICONS,
            customIcons: {},
            customIconNames: LEDGER_BUILTIN_ACCOUNT_ICON_NAMES,
          },
        }
        repository.insertSettings(settings)
        seedDefaultLedgerCategories(repository, {
          now: () => generatedTimestamp(now),
          createId: () => generatedId(createId),
        })
        return {
          resultStatus: 'committed',
          responseStatus: 201,
          responseBody: toSettingsDto(settings),
          resultType: 'settings',
          resultId: 'ledger-settings',
        }
      },
    })
  }

  function listAccounts(includeArchived: boolean): LedgerAccountDto[] {
    requireSettings()
    return repository
      .listAccounts({ includeArchived })
      .map(toAccountDto)
  }

  function getAccount(id: string): LedgerAccountDto {
    requireSettings()
    const account = repository.getAccount(id)
    if (account === null) notFound('Ledger Account')
    return toAccountDto(account)
  }

  function createAccount(
    request: LedgerAccountCreateRequest,
    idempotencyKey: string,
  ): LedgerReplayResult {
    return executeIdempotentLedgerCreate(db, repository, {
      operationScope: LEDGER_IDEMPOTENCY_OPERATION_SCOPES.accounts,
      idempotencyKey,
      request,
      mutation: (): LedgerIdempotentResult => {
        const settings = requireSettings()
        assertAccountPair(request.type, request.nature)
        if (request.currency !== settings.baseCurrency) {
          throw new LedgerError(
            'ledger-currency-mismatch',
            409,
            'Account currency must match the Ledger base currency',
            { field: 'currency' },
          )
        }

        const timestamp = generatedTimestamp(now)
        const account: LedgerAccount = {
          id: generatedId(createId),
          name: request.name,
          type: request.type,
          nature: request.nature,
          icon: request.icon ?? 'wallet',
          openingBalanceMinor: request.openingBalanceMinor,
          openingDate: request.openingDate,
          currency: request.currency,
          note: request.note,
          cardNumber: request.cardNumber ?? '',
          archivedAt: null,
          version: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        }
        repository.insertAccount(account)

        if (!settings.hasCreatedAccount) {
          const markedSettings: LedgerSettings = {
            ...settings,
            hasCreatedAccount: true,
          }
          if (repository.updateSettings({
            settings: markedSettings,
            expectedVersion: settings.version,
          }) !== 1) {
            versionConflict()
          }
        }

        return {
          resultStatus: 'committed',
          responseStatus: 201,
          responseBody: toAccountDto(account),
          resultType: 'account',
          resultId: account.id,
        }
      },
    })
  }

  function patchAccount(id: string, value: unknown): LedgerAccountDto {
    return runLedgerWrite(db, () => {
      requireSettings()
      const account = repository.getAccount(id)
      if (account === null) notFound('Ledger Account')

      const rawRecord = asMutationRecord(value)
      if (account.archivedAt !== null && rawRecord !== null) {
        const allowed = new Set(['expectedVersion', 'name', 'note'])
        if (Object.keys(rawRecord).some((key) => !allowed.has(key))) archivedAccount()
      }

      if (rawRecord !== null) {
        const expectedVersion = parseExpectedVersion(rawRecord)
        assertExpectedVersion(account.version, expectedVersion)
      }
      const patch = parseAccountPatchRequest(value)
      assertExpectedVersion(account.version, patch.expectedVersion)

      const hasHistory = repository.hasAccountHistory(id)
      const financialFields: readonly (keyof LedgerAccountPatchRequest)[] = [
        'type',
        'nature',
        'openingBalanceMinor',
        'openingDate',
      ]
      if (hasHistory && financialFields.some((field) => hasOwn(patch, field))) {
        throw ledgerValidationError(
          'Account financial interpretation fields cannot be changed after transaction history exists',
        )
      }

      const type = patch.type ?? account.type
      const nature = patch.nature ?? account.nature
      assertAccountPair(type, nature)
      const updated: LedgerAccount = {
        ...account,
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.note === undefined ? {} : { note: patch.note }),
        ...(patch.cardNumber === undefined ? {} : { cardNumber: patch.cardNumber }),
        ...(patch.icon === undefined ? {} : { icon: patch.icon }),
        type,
        nature,
        ...(patch.openingBalanceMinor === undefined
          ? {}
          : { openingBalanceMinor: patch.openingBalanceMinor }),
        ...(patch.openingDate === undefined ? {} : { openingDate: patch.openingDate }),
        version: nextVersion(account.version),
        updatedAt: generatedTimestamp(now),
      }
      if (repository.updateAccount({ account: updated, expectedVersion: account.version }) !== 1) {
        versionConflict()
      }
      return toAccountDto(updated)
    })
  }

  function deleteAccount(id: string, value: unknown): LedgerDeletedResponse {
    return runLedgerWrite(db, () => {
      requireSettings()
      const account = repository.getAccount(id)
      if (account === null) notFound('Ledger Account')
      const expectedVersion = parseExpectedVersionCommand(value)
      assertExpectedVersion(account.version, expectedVersion)
      if (repository.hasAccountHistory(id)) {
        throw new LedgerError(
          'ledger-account-has-history',
          409,
          'Ledger Account cannot be physically deleted after transaction history exists',
        )
      }
      if (repository.deleteAccount(id) !== 1) versionConflict()
      return { deleted: true, id }
    })
  }

  function archiveAccount(id: string, value: unknown): LedgerAccountDto {
    return runLedgerWrite(db, () => {
      requireSettings()
      const account = repository.getAccount(id)
      if (account === null) notFound('Ledger Account')
      if (account.archivedAt !== null) archivedAccount()
      const expectedVersion = parseExpectedVersionCommand(value)
      assertExpectedVersion(account.version, expectedVersion)

      const currentBalanceMinor = deriveCurrentBalance(
        account,
        repository.listActiveTransactionsForAccount(id),
      )
      if (currentBalanceMinor !== 0) {
        throw new LedgerError(
          'ledger-account-nonzero-balance',
          409,
          'Ledger Account must have a zero current balance before archiving',
          { currentBalanceMinor },
        )
      }

      const timestamp = generatedTimestamp(now)
      const updated: LedgerAccount = {
        ...account,
        archivedAt: timestamp,
        version: nextVersion(account.version),
        updatedAt: timestamp,
      }
      if (repository.updateAccount({ account: updated, expectedVersion: account.version }) !== 1) {
        versionConflict()
      }
      return toAccountDto(updated)
    })
  }

  function restoreAccount(id: string, value: unknown): LedgerAccountDto {
    return runLedgerWrite(db, () => {
      requireSettings()
      const account = repository.getAccount(id)
      if (account === null) notFound('Ledger Account')
      const expectedVersion = parseExpectedVersionCommand(value)
      assertExpectedVersion(account.version, expectedVersion)
      if (account.archivedAt === null) return toAccountDto(account)

      const updated: LedgerAccount = {
        ...account,
        archivedAt: null,
        version: nextVersion(account.version),
        updatedAt: generatedTimestamp(now),
      }
      if (repository.updateAccount({ account: updated, expectedVersion: account.version }) !== 1) {
        versionConflict()
      }
      return toAccountDto(updated)
    })
  }

  function requireUserTransaction(id: string): LedgerTransaction {
    const transaction = repository.getTransaction(id)
    if (
      transaction === null
      || (transaction.type === 'expense' && transaction.groupId !== undefined)
    ) {
      notFound('Ledger Transaction')
    }
    return transaction
  }

  function getTransaction(id: string): LedgerTransactionDto {
    requireSettings()
    const transaction = requireUserTransaction(id)
    return toTransactionDto(transaction)
  }

  function createTransaction(
    request: LedgerTransactionCreateRequest,
    idempotencyKey: string,
  ): LedgerReplayResult {
    if (request.type === 'adjustment') {
      throw ledgerValidationError(
        'Adjustment creation must use the Account Adjustment endpoint',
        { field: 'type' },
      )
    }

    return executeIdempotentLedgerCreate(db, repository, {
      operationScope: LEDGER_IDEMPOTENCY_OPERATION_SCOPES.transactions,
      idempotencyKey,
      request,
      mutation: (): LedgerIdempotentResult => {
        const settings = requireSettings()
        const timestamp = generatedTimestamp(now)

        switch (request.type) {
          case 'income': {
            const account = requireActiveAccount(request.accountId)
            const category = assertCandidateCategory(request.categoryId, 'income')
            assertTransactionCurrency(settings, account)
            assertTransactionTime(settings, [account], request.occurredAt, timestamp)

            const transaction: IncomeTransaction = {
              id: generatedId(createId),
              type: 'income',
              amountMinor: request.amountMinor,
              accountId: account.id,
              categoryId: category.id,
              occurredAt: request.occurredAt,
              location: request.location ?? '',
              payee: request.payee,
              note: request.note,
              deletedAt: null,
              version: 1,
              createdAt: timestamp,
              updatedAt: timestamp,
            }
            repository.insertTransaction(transaction)
            return {
              resultStatus: 'committed',
              responseStatus: 201,
              responseBody: toTransactionDto(transaction),
              resultType: 'transaction',
              resultId: transaction.id,
            }
          }

          case 'expense': {
            const account = requireActiveAccount(request.accountId)
            const category = assertCandidateCategory(request.categoryId, 'expense')
            assertTransactionCurrency(settings, account)
            assertTransactionTime(settings, [account], request.occurredAt, timestamp)

            const transaction: ExpenseTransaction = {
              id: generatedId(createId),
              type: 'expense',
              amountMinor: request.amountMinor,
              accountId: account.id,
              categoryId: category.id,
              occurredAt: request.occurredAt,
              location: request.location ?? '',
              payee: request.payee,
              note: request.note,
              deletedAt: null,
              version: 1,
              createdAt: timestamp,
              updatedAt: timestamp,
            }
            repository.insertTransaction(transaction)
            return {
              resultStatus: 'committed',
              responseStatus: 201,
              responseBody: toTransactionDto(transaction),
              resultType: 'transaction',
              resultId: transaction.id,
            }
          }

          case 'transfer': {
            if (request.fromAccountId === request.toAccountId) invalidTransactionPair()
            const fromAccount = requireActiveAccount(request.fromAccountId)
            const toAccount = requireActiveAccount(request.toAccountId)
            const transferKind = request.transferKind ?? 'general'
            assertTransferKindAccounts(transferKind, fromAccount, toAccount)
            assertTransactionCurrency(settings, fromAccount)
            assertTransactionCurrency(settings, toAccount)
            assertTransactionTime(
              settings,
              [fromAccount, toAccount],
              request.occurredAt,
              timestamp,
            )

            const feeMinor = request.feeMinor ?? 0
            assertNonNegativeSafeInteger(feeMinor, 'feeMinor')
            if (feeMinor === 0 && request.feeMode !== undefined) {
              throw ledgerValidationError('feeMode requires a positive feeMinor', {
                field: 'feeMinor',
              })
            }
            if (feeMinor > 0 && transferKind === 'general') {
              throw ledgerValidationError('A fee can only be attached to a repayment or withdrawal', {
                field: 'transferKind',
              })
            }
            const feeCategory = feeMinor > 0
              ? requireSystemCategory(transferKind === 'repayment' ? 'interest' : 'fee')
              : null
            let transferAmountMinor = request.amountMinor
            let feeMode: LedgerTransferFeeMode | undefined
            if (feeMinor > 0 && transferKind === 'repayment') {
              if (request.feeMode !== undefined) {
                throw ledgerValidationError('Repayment fees do not support a feeMode', {
                  field: 'feeMode',
                })
              }
            } else if (feeMinor > 0 && transferKind === 'withdrawal') {
              feeMode = request.feeMode ?? 'extra'
              if (feeMode === 'deducted') {
                transferAmountMinor = checkedSubMinor(request.amountMinor, feeMinor)
                assertPositiveMinor(transferAmountMinor, 'amountMinor after fee')
              }
            }
            const groupId = feeMinor > 0 ? generatedId(createId) : undefined

            const transaction: TransferTransaction = {
              id: generatedId(createId),
              type: 'transfer',
              transferKind,
              ...(groupId ? { groupId } : {}),
              ...(feeMode ? { feeMode } : {}),
              amountMinor: transferAmountMinor,
              fromAccountId: fromAccount.id,
              toAccountId: toAccount.id,
              occurredAt: request.occurredAt,
              location: request.location ?? '',
              payee: request.payee,
              note: request.note,
              deletedAt: null,
              version: 1,
              createdAt: timestamp,
              updatedAt: timestamp,
            }
            repository.insertTransaction(transaction)
            if (feeMinor > 0 && feeCategory && groupId) {
              const fee: ExpenseTransaction = {
                id: generatedId(createId),
                type: 'expense',
                groupId,
                amountMinor: feeMinor,
                accountId: fromAccount.id,
                categoryId: feeCategory.id,
                occurredAt: request.occurredAt,
                location: request.location ?? '',
                payee: companionPayee(transferKind, fromAccount.name, toAccount.name, request.payee),
                note: request.note,
                deletedAt: null,
                version: 1,
                createdAt: timestamp,
                updatedAt: timestamp,
              }
              repository.insertTransaction(fee)
            }
            return {
              resultStatus: 'committed',
              responseStatus: 201,
              responseBody: toTransactionDto(transaction),
              resultType: 'transaction',
              resultId: transaction.id,
            }
          }
        }
      },
    })
  }

  function patchTransaction(id: string, value: unknown): LedgerTransactionDto {
    return runLedgerWrite(db, () => {
      const settings = requireSettings()
      const transaction = requireUserTransaction(id)

      const rawRecord = asMutationRecord(value)
      if (transaction.deletedAt !== null) transactionDeleted()
      assertArchivedPatchWhitelist(transaction, rawRecord)
      assertCandidateAccountsNotArchived(transaction, rawRecord)

      if (rawRecord !== null) {
        const expectedVersion = parseExpectedVersion(rawRecord)
        assertExpectedVersion(transaction.version, expectedVersion)
      }

      const patch = parseTransactionPatchRequest(value)
      assertExpectedVersion(transaction.version, patch.expectedVersion)
      if (hasOwn(patch, 'type') && patch.type !== transaction.type) transactionTypeImmutable()
      if (transaction.type === 'adjustment' && hasOwn(patch, 'type')) adjustmentImmutable()
      assertPatchFields(transaction, patch)

      const timestamp = generatedTimestamp(now)

      switch (transaction.type) {
        case 'income': {
          const accountId = patch.accountId ?? transaction.accountId
          const categoryId = patch.categoryId ?? transaction.categoryId
          const account = hasOwn(patch, 'accountId')
            ? requireActiveAccount(accountId)
            : requireAccount(accountId)
          const category = hasOwn(patch, 'categoryId')
            ? assertCandidateCategory(categoryId, 'income')
            : requireCategory(categoryId)
          assertCategoryForTransaction(category, 'income')
          assertTransactionCurrency(settings, account)
          const occurredAt = patch.occurredAt ?? transaction.occurredAt
          assertTransactionTime(settings, [account], occurredAt, timestamp)

          const updated: IncomeTransaction = {
            ...transaction,
            amountMinor: patch.amountMinor ?? transaction.amountMinor,
            accountId: account.id,
            categoryId: category.id,
            occurredAt,
            location: patch.location ?? transaction.location,
            payee: patch.payee ?? transaction.payee,
            note: patch.note ?? transaction.note,
            version: nextVersion(transaction.version),
            updatedAt: timestamp,
          }
          if (repository.updateTransaction({
            transaction: updated,
            expectedVersion: transaction.version,
          }) !== 1) versionConflict()
          return toTransactionDto(updated)
        }

        case 'expense': {
          const accountId = patch.accountId ?? transaction.accountId
          const categoryId = patch.categoryId ?? transaction.categoryId
          const account = hasOwn(patch, 'accountId')
            ? requireActiveAccount(accountId)
            : requireAccount(accountId)
          const category = hasOwn(patch, 'categoryId')
            ? assertCandidateCategory(categoryId, 'expense')
            : requireCategory(categoryId)
          assertCategoryForTransaction(category, 'expense')
          assertTransactionCurrency(settings, account)
          const occurredAt = patch.occurredAt ?? transaction.occurredAt
          assertTransactionTime(settings, [account], occurredAt, timestamp)

          const updated: ExpenseTransaction = {
            ...transaction,
            amountMinor: patch.amountMinor ?? transaction.amountMinor,
            accountId: account.id,
            categoryId: category.id,
            occurredAt,
            location: patch.location ?? transaction.location,
            payee: patch.payee ?? transaction.payee,
            note: patch.note ?? transaction.note,
            version: nextVersion(transaction.version),
            updatedAt: timestamp,
          }
          if (repository.updateTransaction({
            transaction: updated,
            expectedVersion: transaction.version,
          }) !== 1) versionConflict()
          return toTransactionDto(updated)
        }

        case 'transfer': {
          const fromAccountId = patch.fromAccountId ?? transaction.fromAccountId
          const toAccountId = patch.toAccountId ?? transaction.toAccountId
          if (fromAccountId === toAccountId) invalidTransactionPair()
          const fromAccount = hasOwn(patch, 'fromAccountId')
            ? requireActiveAccount(fromAccountId)
            : requireAccount(fromAccountId)
          const toAccount = hasOwn(patch, 'toAccountId')
            ? requireActiveAccount(toAccountId)
            : requireAccount(toAccountId)
          const transferKind = patch.transferKind ?? transaction.transferKind
          assertTransferKindAccounts(transferKind, fromAccount, toAccount)
          assertTransactionCurrency(settings, fromAccount)
          assertTransactionCurrency(settings, toAccount)
          const occurredAt = patch.occurredAt ?? transaction.occurredAt
          assertTransactionTime(settings, [fromAccount, toAccount], occurredAt, timestamp)

          const groupTransactions = transaction.groupId
            ? repository.listTransactionsByGroupId(transaction.groupId, true)
            : []
          const activeGroupExpenses = groupTransactions.filter(
            (item): item is ExpenseTransaction => item.type === 'expense' && item.deletedAt === null,
          )
          const hasDeletedGroupExpense = groupTransactions.some(
            (item) => item.type === 'expense' && item.deletedAt !== null,
          )
          if (
            transaction.groupId !== undefined
            && (activeGroupExpenses.length !== 1 || hasDeletedGroupExpense)
          ) {
            throw ledgerValidationError(
              'Grouped transfer must have exactly one active companion expense',
              { field: 'groupId' },
            )
          }
          const existingFee = activeGroupExpenses[0]
          const hasFeePatch = hasOwn(patch, 'feeMinor')
            || hasOwn(patch, 'feeMode')
          if (hasOwn(patch, 'feeMinor')) {
            assertNonNegativeSafeInteger(patch.feeMinor, 'feeMinor')
          }
          if (
            hasFeePatch
            && !hasOwn(patch, 'feeMinor')
            && existingFee === undefined
          ) {
            throw ledgerValidationError(
              'feeMinor is required when adding a transfer companion expense',
              { field: 'feeMinor' },
            )
          }

          const feeMinor = hasOwn(patch, 'feeMinor')
            ? patch.feeMinor ?? 0
            : existingFee?.amountMinor ?? 0
          if (
            feeMinor === 0
            && hasOwn(patch, 'feeMode')
          ) {
            throw ledgerValidationError('feeMode requires a positive feeMinor', {
              field: 'feeMinor',
            })
          }
          if (feeMinor > 0 && transferKind === 'general') {
            throw ledgerValidationError('A fee can only be attached to a repayment or withdrawal', {
              field: 'transferKind',
            })
          }

          let feeCategory: LedgerCategory | null = null
          if (feeMinor > 0) {
            feeCategory = requireSystemCategory(transferKind === 'repayment' ? 'interest' : 'fee')
          }

          let feeMode: LedgerTransferFeeMode | undefined
          if (feeMinor > 0 && transferKind === 'repayment') {
            if (hasOwn(patch, 'feeMode')) {
              throw ledgerValidationError('Repayment fees do not support a feeMode', {
                field: 'feeMode',
              })
            }
          } else if (feeMinor > 0 && transferKind === 'withdrawal') {
            feeMode = patch.feeMode ?? transaction.feeMode ?? 'extra'
            if (feeMode !== 'extra' && feeMode !== 'deducted') {
              throw ledgerValidationError('feeMode must be extra or deducted', { field: 'feeMode' })
            }
          }

          const requestedAmountMinor = hasOwn(patch, 'amountMinor')
            ? patch.amountMinor!
            : transaction.transferKind === 'withdrawal'
              && transaction.feeMode === 'deducted'
              && existingFee !== undefined
              ? checkedAddMinor(transaction.amountMinor, existingFee.amountMinor)
              : transaction.amountMinor
          let transferAmountMinor = requestedAmountMinor
          if (feeMinor > 0 && transferKind === 'withdrawal' && feeMode === 'deducted') {
            transferAmountMinor = checkedSubMinor(requestedAmountMinor, feeMinor)
            assertPositiveMinor(transferAmountMinor, 'amountMinor after fee')
          }

          const nextGroupId = feeMinor > 0
            ? transaction.groupId ?? generatedId(createId)
            : undefined
          const updated: TransferTransaction = {
            ...transaction,
            transferKind,
            groupId: nextGroupId,
            feeMode,
            amountMinor: transferAmountMinor,
            fromAccountId: fromAccount.id,
            toAccountId: toAccount.id,
            occurredAt,
            location: patch.location ?? transaction.location,
            payee: patch.payee ?? transaction.payee,
            note: patch.note ?? transaction.note,
            version: nextVersion(transaction.version),
            updatedAt: timestamp,
          }
          const companionIdentityChanged = transferKind !== transaction.transferKind
            || fromAccount.id !== transaction.fromAccountId
            || toAccount.id !== transaction.toAccountId
          if (repository.updateTransaction({
            transaction: updated,
            expectedVersion: transaction.version,
          }) !== 1) versionConflict()

          if (feeMinor > 0 && feeCategory && nextGroupId) {
            const updatedFee: ExpenseTransaction = existingFee
              ? {
                  ...existingFee,
                  groupId: nextGroupId,
                  amountMinor: feeMinor,
                  accountId: fromAccount.id,
                  categoryId: feeCategory.id,
                  occurredAt,
                  location: updated.location,
                  payee: companionIdentityChanged
                    ? companionPayee(transferKind, fromAccount.name, toAccount.name, updated.payee)
                    : existingFee.payee,
                  note: updated.note,
                  version: nextVersion(existingFee.version),
                  updatedAt: timestamp,
                }
              : {
                  id: generatedId(createId),
                  type: 'expense',
                  groupId: nextGroupId,
                  amountMinor: feeMinor,
                  accountId: fromAccount.id,
                  categoryId: feeCategory.id,
                  occurredAt,
                  location: updated.location,
                  payee: companionPayee(transferKind, fromAccount.name, toAccount.name, updated.payee),
                  note: updated.note,
                  deletedAt: null,
                  version: 1,
                  createdAt: timestamp,
                  updatedAt: timestamp,
                }
            if (existingFee) {
              if (repository.updateTransaction({
                transaction: updatedFee,
                expectedVersion: existingFee.version,
              }) !== 1) versionConflict()
            } else {
              repository.insertTransaction(updatedFee)
            }
          } else if (existingFee) {
            const deletedFee: ExpenseTransaction = {
              ...existingFee,
              deletedAt: timestamp,
              version: nextVersion(existingFee.version),
              updatedAt: timestamp,
            }
            if (repository.softDeleteTransaction({
              id: existingFee.id,
              deletedAt: timestamp,
              version: deletedFee.version,
              updatedAt: timestamp,
              expectedVersion: existingFee.version,
            }) !== 1) versionConflict()
          }

          return toTransactionDto(updated)
        }

        case 'adjustment': {
          const account = requireAccount(transaction.accountId)
          assertTransactionCurrency(settings, account)
          assertTransactionTime(settings, [account], transaction.occurredAt, timestamp)

          const updated: AdjustmentTransaction = {
            ...transaction,
            location: patch.location ?? transaction.location,
            note: patch.note ?? transaction.note,
            version: nextVersion(transaction.version),
            updatedAt: timestamp,
          }
          if (repository.updateTransaction({
            transaction: updated,
            expectedVersion: transaction.version,
          }) !== 1) versionConflict()
          return toTransactionDto(updated)
        }
      }
    })
  }

  function deleteTransaction(id: string, value: unknown): LedgerTransactionDto {
    return runLedgerWrite(db, () => {
      requireSettings()
      const transaction = requireUserTransaction(id)

      if (transaction.deletedAt !== null) {
        parseExpectedVersionCommand(value)
        return toTransactionDto(transaction)
      }

      const groupTransactions = transaction.groupId
        ? repository.listTransactionsByGroupId(transaction.groupId, true)
        : [transaction]
      const deleted = groupTransactions.find((item) => item.id === transaction.id)
      if (!deleted) notFound('Ledger Transaction')
      for (const item of groupTransactions) {
        if (item.deletedAt === null) assertTransactionAccountsNotArchived(item)
      }

      const expectedVersion = parseExpectedVersionCommand(value)
      assertExpectedVersion(transaction.version, expectedVersion)

      const timestamp = generatedTimestamp(now)

      let returnDto: LedgerTransaction | null = null
      for (const item of groupTransactions) {
        if (item.deletedAt !== null) continue
        const deletedItem: LedgerTransaction = {
          ...item,
          deletedAt: timestamp,
          version: nextVersion(item.version),
          updatedAt: timestamp,
        }
        if (repository.softDeleteTransaction({
          id: item.id,
          deletedAt: timestamp,
          version: deletedItem.version,
          updatedAt: timestamp,
          expectedVersion: item.id === transaction.id ? transaction.version : item.version,
        }) !== 1) versionConflict()
        if (item.id === transaction.id) {
          returnDto = deletedItem
        }
      }
      return toTransactionDto(returnDto ?? deleted)
    })
  }

  function adjustAccount(
    id: string,
    request: LedgerAdjustmentEndpointRequest,
    idempotencyKey: string,
  ): LedgerReplayResult {
    return executeIdempotentLedgerCreate(db, repository, {
      operationScope: ledgerAccountAdjustmentOperationScope(id),
      idempotencyKey,
      request,
      mutation: (): LedgerIdempotentResult => {
        const settings = requireSettings()
        const account = requireActiveAccount(id)
        assertTransactionCurrency(settings, account)
        const timestamp = generatedTimestamp(now)
        assertTransactionTime(settings, [account], request.occurredAt, timestamp)

        const actualCalculatedBalance = deriveCurrentBalance(
          account,
          repository.listActiveTransactionsForAccount(account.id),
        )
        if (actualCalculatedBalance !== request.expectedCalculatedBalanceMinor) {
          throw new LedgerError(
            'ledger-balance-conflict',
            409,
            'Adjustment expectedCalculatedBalanceMinor is stale',
            {
              expectedCalculatedBalanceMinor: request.expectedCalculatedBalanceMinor,
              actualCalculatedBalanceMinor: actualCalculatedBalance,
            },
          )
        }

        const delta = checkedSubMinor(request.targetBalanceMinor, actualCalculatedBalance)
        if (delta === 0) {
          return {
            resultStatus: 'no-op',
            responseStatus: 200,
            responseBody: {
              adjustment: null,
              account: toAccountDto(account),
              noOp: true,
            },
          }
        }

        const adjustment: AdjustmentTransaction = {
          id: generatedId(createId),
          type: 'adjustment',
          amountMinor: delta,
          accountId: account.id,
          adjustmentCalculatedBalanceMinor: actualCalculatedBalance,
          adjustmentTargetBalanceMinor: request.targetBalanceMinor,
          occurredAt: request.occurredAt,
          location: '',
          note: request.note,
          deletedAt: null,
          version: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        }
        repository.insertTransaction(adjustment)

        const responseBody: LedgerAdjustmentAppliedDto = {
          adjustment: toAdjustmentDto(adjustment),
          account: toAccountDto(account),
          noOp: false,
        }
        return {
          resultStatus: 'committed',
          responseStatus: 201,
          responseBody,
          resultType: 'transaction',
          resultId: adjustment.id,
        }
      },
    })
  }

  function listCategories(
    kind: LedgerCategoryKind | undefined,
    includeArchived: boolean,
  ): LedgerCategoryDto[] {
    requireSettings()
    return repository
      .listCategories({ includeArchived })
      .filter((category) => kind === undefined || category.kind === kind)
      .map(toCategoryDto)
  }

  function createCategory(
    request: LedgerCategoryCreateRequest,
    idempotencyKey: string,
  ): LedgerReplayResult {
    return executeIdempotentLedgerCreate(db, repository, {
      operationScope: LEDGER_IDEMPOTENCY_OPERATION_SCOPES.categories,
      idempotencyKey,
      request,
      mutation: (): LedgerIdempotentResult => {
        requireSettings()
        const normalizedName = normalizeLedgerCategoryName(request.name)
        if (repository.findCategoryByIdentity(request.kind, normalizedName) !== null) {
          duplicateCategory()
        }
        const timestamp = generatedTimestamp(now)
        const category: LedgerCategory = {
          id: generatedId(createId),
          kind: request.kind,
          name: request.name,
          normalizedName,
          ...(request.icon && request.icon !== 'wallet' ? { icon: request.icon } : {}),
          isDefault: false,
          archivedAt: null,
          version: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        }
        repository.insertCategory(category)
        return {
          resultStatus: 'committed',
          responseStatus: 201,
          responseBody: toCategoryDto(category),
          resultType: 'category',
          resultId: category.id,
        }
      },
    })
  }

  function patchCategory(id: string, value: unknown): LedgerCategoryDto {
    return runLedgerWrite(db, () => {
      requireSettings()
      const category = repository.getCategory(id)
      if (category === null) notFound('Ledger Category')
      if (category.archivedAt !== null) archivedCategory()

      const rawRecord = asMutationRecord(value)
      if (rawRecord !== null) {
        const expectedVersion = parseExpectedVersion(rawRecord)
        assertExpectedVersion(category.version, expectedVersion)
      }
      const patch = parseCategoryPatchRequest(value)
      assertExpectedVersion(category.version, patch.expectedVersion)

      if ((category.isDefault || category.systemKey) && (hasOwn(patch, 'name') || hasOwn(patch, 'kind'))) {
        throw ledgerValidationError('Default categories cannot be renamed or moved to another kind', {
          field: category.systemKey ? 'systemKey' : 'isDefault',
          ...(category.systemKey ? { systemKey: category.systemKey } : {}),
        })
      }

      const hasHistory = repository.hasCategoryHistory(id)
      if (hasHistory && hasOwn(patch, 'kind')) {
        throw ledgerValidationError('Category kind cannot be changed after transaction history exists', {
          field: 'kind',
        })
      }

      const kind = patch.kind ?? category.kind
      const name = patch.name ?? category.name
      const normalizedName = normalizeLedgerCategoryName(name)
      const existing = repository.findCategoryByIdentity(kind, normalizedName)
      if (existing !== null && existing.id !== category.id) duplicateCategory()

      const updated: LedgerCategory = {
        ...category,
        kind,
        name,
        normalizedName,
        ...(patch.icon === undefined ? {} : patch.icon === 'wallet' ? { icon: undefined } : { icon: patch.icon }),
        version: nextVersion(category.version),
        updatedAt: generatedTimestamp(now),
      }
      if (repository.updateCategory({ category: updated, expectedVersion: category.version }) !== 1) {
        versionConflict()
      }
      return toCategoryDto(updated)
    })
  }

  function deleteCategory(id: string, value: unknown): LedgerDeletedResponse {
    return runLedgerWrite(db, () => {
      requireSettings()
      const category = repository.getCategory(id)
      if (category === null) notFound('Ledger Category')
      if (category.isDefault || category.systemKey) {
        throw ledgerValidationError('Default categories cannot be deleted', {
          field: category.systemKey ? 'systemKey' : 'isDefault',
          ...(category.systemKey ? { systemKey: category.systemKey } : {}),
        })
      }
      const expectedVersion = parseExpectedVersionCommand(value)
      assertExpectedVersion(category.version, expectedVersion)
      if (repository.hasCategoryHistory(id)) {
        throw new LedgerError(
          'ledger-category-has-history',
          409,
          'Ledger Category cannot be physically deleted after transaction history exists',
        )
      }
      if (repository.deleteCategory(id) !== 1) versionConflict()
      return { deleted: true, id }
    })
  }

  function archiveCategory(id: string, value: unknown): LedgerCategoryDto {
    return runLedgerWrite(db, () => {
      requireSettings()
      const category = repository.getCategory(id)
      if (category === null) notFound('Ledger Category')
      if (category.isDefault || category.systemKey) {
        throw ledgerValidationError('Default categories cannot be moved to the recycle bin', {
          field: category.systemKey ? 'systemKey' : 'isDefault',
          ...(category.systemKey ? { systemKey: category.systemKey } : {}),
        })
      }
      if (category.archivedAt !== null) archivedCategory()
      const expectedVersion = parseExpectedVersionCommand(value)
      assertExpectedVersion(category.version, expectedVersion)
      if (repository.hasCategoryHistory(id)) {
        throw new LedgerError(
          'ledger-category-has-history',
          409,
          'Ledger Category cannot be moved to the recycle bin after transaction history exists',
        )
      }

      const timestamp = generatedTimestamp(now)
      const updated: LedgerCategory = {
        ...category,
        archivedAt: timestamp,
        version: nextVersion(category.version),
        updatedAt: timestamp,
      }
      if (repository.updateCategory({ category: updated, expectedVersion: category.version }) !== 1) {
        versionConflict()
      }
      return toCategoryDto(updated)
    })
  }

  function restoreCategory(id: string, value: unknown): LedgerCategoryDto {
    return runLedgerWrite(db, () => {
      requireSettings()
      const category = repository.getCategory(id)
      if (category === null) notFound('Ledger Category')
      const expectedVersion = parseExpectedVersionCommand(value)
      assertExpectedVersion(category.version, expectedVersion)
      if (category.archivedAt === null) return toCategoryDto(category)

      const updated: LedgerCategory = {
        ...category,
        archivedAt: null,
        version: nextVersion(category.version),
        updatedAt: generatedTimestamp(now),
      }
      if (repository.updateCategory({ category: updated, expectedVersion: category.version }) !== 1) {
        versionConflict()
      }
      return toCategoryDto(updated)
    })
  }

  return {
    getSettings(): LedgerSettingsDto {
      return toSettingsDto(requireSettings())
    },
    createSettings,
    patchSettings,
    listAccounts,
    getAccount,
    createAccount,
    patchAccount,
    deleteAccount,
    archiveAccount,
    restoreAccount,
    listCategories,
    createCategory,
    patchCategory,
    deleteCategory,
    archiveCategory,
    restoreCategory,
    getTransaction,
    createTransaction,
    patchTransaction,
    deleteTransaction,
    adjustAccount,
  }
}

export type {
  LedgerAccountPatchRequest,
  LedgerCategoryPatchRequest,
  LedgerSettingsPatchRequest,
}
