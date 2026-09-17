import { afterEach, describe, expect, it } from 'vitest'
import type {
  LedgerAccountDto,
  LedgerAccountCreateRequest,
  LedgerCategoryDto,
  LedgerCategoryCreateRequest,
  LedgerSettingsCreateRequest,
  LedgerTransactionCreateRequest,
} from '../../shared/ledgerProtocol.js'
import { LEDGER_BUILTIN_CATEGORY_ICONS } from '../../shared/ledgerProtocol.js'
import { DEFAULT_LEDGER_CATEGORIES_V2 } from './defaultCategories.js'
import { LedgerError } from './errors.js'
import { createLedgerRepository, type LedgerRepository } from './repository.js'
import { createLedgerService, type LedgerService } from './service.js'
import {
  parseAccountCreateRequest,
  parseCategoryCreateRequest,
  parseSettingsCreateRequest,
  parseTransactionCreateRequest,
} from './validation.js'
import {
  createLedgerTestDatabase,
  type LedgerTestDatabase,
} from '../__tests__/helpers/ledgerDb.js'

const databases: LedgerTestDatabase[] = []
const TEST_NOW = Date.parse('2026-01-01T00:00:00.000Z')

const EXPECTED_DEFAULT_LEDGER_CATEGORIES_V2 = LEDGER_BUILTIN_CATEGORY_ICONS.map(({ kind, name, id: icon, sortOrder, systemKey }) => ({ kind, name, icon, sortOrder, ...(systemKey ? { systemKey } : {}) }))

function freshService(): {
  database: LedgerTestDatabase
  repository: LedgerRepository
  service: LedgerService
} {
  const database = createLedgerTestDatabase()
  databases.push(database)
  const repository = createLedgerRepository(database.db)
  let nextId = 0
  const service = createLedgerService(database.db, repository, {
    createId: () => `ledger-test-${++nextId}`,
    now: () => TEST_NOW,
  })
  return { database, repository, service }
}

afterEach(() => {
  for (const database of databases.splice(0)) database.cleanup()
})

function expectLedgerError(callback: () => unknown, code: LedgerError['code']): LedgerError {
  try {
    callback()
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerError)
    expect((error as LedgerError).code).toBe(code)
    return error as LedgerError
  }
  throw new Error(`Expected LedgerError ${code}`)
}

function settingsRequest(overrides: Partial<LedgerSettingsCreateRequest> = {}) {
  return parseSettingsCreateRequest({
    baseCurrency: 'CNY',
    timezone: 'Asia/Shanghai',
    ...overrides,
  })
}

function initialize(service: LedgerService): void {
  const result = service.createSettings(settingsRequest(), 'settings-init')
  expect(result.responseStatus).toBe(201)
}

function accountRequest(
  overrides: Partial<LedgerAccountCreateRequest> = {},
) {
  return parseAccountCreateRequest({
    name: 'Test account',
    type: 'bank',
    nature: 'asset',
    openingBalanceMinor: 0,
    openingDate: '2026-01-01',
    currency: 'CNY',
    ...overrides,
  })
}

function categoryRequest(
  overrides: Partial<LedgerCategoryCreateRequest> = {},
) {
  return parseCategoryCreateRequest({
    kind: 'expense',
    name: 'Custom category',
    ...overrides,
  })
}

function createAccount(
  service: LedgerService,
  key: string,
  overrides: Parameters<typeof accountRequest>[0] = {},
): LedgerAccountDto {
  const result = service.createAccount(accountRequest(overrides), key)
  expect(result.responseStatus).toBe(201)
  return JSON.parse(result.responseBodyJson) as LedgerAccountDto
}

function createCategory(
  service: LedgerService,
  key: string,
  overrides: Parameters<typeof categoryRequest>[0] = {},
): LedgerCategoryDto {
  const result = service.createCategory(categoryRequest(overrides), key)
  expect(result.responseStatus).toBe(201)
  return JSON.parse(result.responseBodyJson) as LedgerCategoryDto
}

function transactionRequest(value: Record<string, unknown>): LedgerTransactionCreateRequest {
  return parseTransactionCreateRequest({
    occurredAt: TEST_NOW,
    payee: '',
    ...value,
  })
}

function transactionFromResult(result: ReturnType<LedgerService['createTransaction']>) {
  expect(result.responseStatus).toBe(201)
  return JSON.parse(result.responseBodyJson) as {
    id: string
    type: string
    amountMinor: number
    payee?: string
    version: number
    deletedAt: number | null
    accountId?: string
    fromAccountId?: string
    toAccountId?: string
    groupId?: string
    transferKind?: string
    feeMode?: string
  }
}

describe('Ledger Settings and default Category service', () => {
  it('initializes Settings and seeds the exact ordered v2 catalog once', () => {
    const { service } = freshService()

    initialize(service)

    expect(DEFAULT_LEDGER_CATEGORIES_V2).toEqual(EXPECTED_DEFAULT_LEDGER_CATEGORIES_V2)
    const categories = service.listCategories(undefined, true)
    expect(categories).toHaveLength(DEFAULT_LEDGER_CATEGORIES_V2.length)
    expect(new Set(categories.map((category) => `${category.kind}:${category.name}`))).toEqual(
      new Set(DEFAULT_LEDGER_CATEGORIES_V2.map((category) => `${category.kind}:${category.name}`)),
    )
    expect(categories.every((category) => category.protected)).toBe(true)
    expect(service.getSettings()).toMatchObject({
      baseCurrency: 'CNY',
      currencyExponent: 2,
      timezone: 'Asia/Shanghai',
      version: 1,
    })
  })

  it('preserves an existing archived seed identity and never auto-unarchives it', () => {
    const { database, repository, service } = freshService()
    database.db.prepare(`
      INSERT INTO ledger_categories (
        id, kind, name, normalized_name, archived_at, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('existing-food', 'expense', '餐饮', '餐饮', 1_700_000_000_100, 7, 1_700_000_000_000, 1_700_000_000_000)

    initialize(service)

    const preserved = repository.getCategory('existing-food')
    expect(preserved).toMatchObject({
      id: 'existing-food',
      name: '餐饮',
      normalizedName: '餐饮',
      archivedAt: 1_700_000_000_100,
      version: 7,
    })
    expect(service.listCategories(undefined, true)).toHaveLength(DEFAULT_LEDGER_CATEGORIES_V2.length)
  })

  it('protects every built-in category from lifecycle changes', () => {
    const { service } = freshService()
    initialize(service)

    for (const category of service.listCategories(undefined, true)) {
      expect(category.protected).toBe(true)
      expectLedgerError(
        () => service.patchCategory(category.id, { expectedVersion: category.version, name: `${category.name} 修改` }),
        'ledger-validation-failed',
      )
      expectLedgerError(
        () => service.archiveCategory(category.id, { expectedVersion: category.version }),
        'ledger-validation-failed',
      )
      expectLedgerError(
        () => service.deleteCategory(category.id, { expectedVersion: category.version }),
        'ledger-validation-failed',
      )
    }
  })

  it('replays the original Settings snapshot and rejects a new identity after initialization', () => {
    const { service } = freshService()
    initialize(service)
    const first = service.createSettings(settingsRequest(), 'settings-init')
    expect(first.replayed).toBe(true)
    expect(first.responseStatus).toBe(201)

    expectLedgerError(
      () => service.createSettings(settingsRequest({ timezone: 'UTC' }), 'another-settings-key'),
      'ledger-settings-already-initialized',
    )
    expectLedgerError(
      () => service.createSettings(settingsRequest({ timezone: 'UTC' }), 'settings-init'),
      'ledger-idempotency-conflict',
    )
  })

  it('rolls back Settings, seed Categories, and the replay row as one mutation', () => {
    const database = createLedgerTestDatabase()
    databases.push(database)
    const repository = createLedgerRepository(database.db)
    let generatedIds = 0
    const failingService = createLedgerService(database.db, repository, {
      now: () => 1_700_000_000_000,
      createId: () => {
        generatedIds += 1
        if (generatedIds === 5) throw new Error('seed failure')
        return `failing-${generatedIds}`
      },
    })

    expect(() => failingService.createSettings(settingsRequest(), 'atomic-settings')).toThrow('seed failure')
    expect(repository.getSettings()).toBeNull()
    expect(repository.listCategories({ includeArchived: true })).toEqual([])
    expect(database.db.prepare('SELECT COUNT(*) AS count FROM ledger_idempotency').get()).toEqual({ count: 0 })

    let retryId = 0
    const retryService = createLedgerService(database.db, repository, {
      now: () => 1_700_000_000_100,
      createId: () => `retry-${++retryId}`,
    })
    expect(retryService.createSettings(settingsRequest(), 'atomic-settings').responseStatus).toBe(201)
    expect(repository.getSettings()).not.toBeNull()
    expect(repository.listCategories({ includeArchived: true })).toHaveLength(DEFAULT_LEDGER_CATEGORIES_V2.length)
    expect(database.db.prepare('SELECT COUNT(*) AS count FROM ledger_idempotency').get()).toEqual({ count: 1 })
  })

  it('keeps Settings mutable before the first Account and locks both fields afterwards', () => {
    const { service } = freshService()
    initialize(service)

    const beforeAccount = service.patchSettings({
      expectedVersion: 1,
      timezone: 'UTC',
      baseCurrency: 'USD',
    })
    expect(beforeAccount).toMatchObject({
      timezone: 'UTC',
      baseCurrency: 'USD',
      currencyExponent: 2,
      version: 2,
    })

    const account = createAccount(service, 'account-freeze', { currency: 'USD' })
    expect(account.currentBalanceMinor).toBe(0)
    expect(service.getSettings().version).toBe(2)

    expectLedgerError(
      () => service.patchSettings({ expectedVersion: 1, timezone: 'Asia/Shanghai' }),
      'ledger-timezone-locked',
    )
    expectLedgerError(
      () => service.patchSettings({ expectedVersion: 1, baseCurrency: 'CNY' }),
      'ledger-base-currency-locked',
    )

    service.deleteAccount(account.id, { expectedVersion: account.version })
    expect(service.getSettings().version).toBe(2)
    expectLedgerError(
      () => service.patchSettings({ expectedVersion: 2, timezone: 'Asia/Shanghai' }),
      'ledger-timezone-locked',
    )
    expectLedgerError(
      () => service.patchSettings({ expectedVersion: 2, baseCurrency: 'CNY' }),
      'ledger-base-currency-locked',
    )
  })
})

describe('Ledger Account service lifecycle', () => {
  it('keeps optional card numbers consistent across account reads and patches', () => {
    const { service } = freshService()
    initialize(service)

    for (const type of ['cash', 'wallet', 'bank'] as const) {
      const created = createAccount(service, `account-without-card-${type}`, { type })
      expect(created.cardNumber).toBeUndefined()
      expect(service.listAccounts(false).find((account) => account.id === created.id)?.cardNumber).toBeUndefined()
      expect(service.listAccounts(true).find((account) => account.id === created.id)?.cardNumber).toBeUndefined()
      expect(service.getAccount(created.id).cardNumber).toBeUndefined()
    }

    const withCard = createAccount(service, 'account-with-card', { cardNumber: '6222021234567890' })
    expect(service.listAccounts(false).find((account) => account.id === withCard.id)?.cardNumber).toBe('6222021234567890')
    expect(service.listAccounts(true).find((account) => account.id === withCard.id)?.cardNumber).toBe('6222021234567890')
    expect(service.getAccount(withCard.id).cardNumber).toBe('6222021234567890')

    const renamed = service.patchAccount(withCard.id, {
      expectedVersion: withCard.version,
      name: 'Renamed card account',
    })
    expect(renamed.cardNumber).toBe('6222021234567890')
  })

  it('uses the balance engine for projections and enforces the account PATCH matrix', () => {
    const { repository, service } = freshService()
    initialize(service)
    const account = createAccount(service, 'account-matrix')

    const changed = service.patchAccount(account.id, {
      expectedVersion: account.version,
      openingBalanceMinor: 100,
    })
    expect(changed).toMatchObject({ version: 2, openingBalanceMinor: 100, currentBalanceMinor: 100 })

    expectLedgerError(
      () => service.archiveAccount(account.id, { expectedVersion: changed.version }),
      'ledger-account-nonzero-balance',
    )

    const expenseCategory = service.listCategories('expense', false)[0]!
    repository.insertTransaction({
      id: 'account-history',
      type: 'expense',
      amountMinor: 100,
      accountId: account.id,
      categoryId: expenseCategory.id,
      occurredAt: 1_700_000_001_000,
      payee: '',
      note: '',
      deletedAt: 1_700_000_002_000,
      version: 1,
      createdAt: 1_700_000_001_000,
      updatedAt: 1_700_000_002_000,
    })

    expectLedgerError(
      () => service.patchAccount(account.id, {
        expectedVersion: changed.version,
        openingBalanceMinor: 0,
      }),
      'ledger-validation-failed',
    )
    const renamed = service.patchAccount(account.id, {
      expectedVersion: changed.version,
      name: 'Renamed account',
    })
    expect(renamed).toMatchObject({ name: 'Renamed account', version: 3 })

    const archived = createAccount(service, 'account-archive')
    const archivedVersion = service.archiveAccount(archived.id, { expectedVersion: archived.version })
    expect(archivedVersion).toMatchObject({ archivedAt: expect.any(Number), currentBalanceMinor: 0, version: 2 })
    expect(service.listAccounts(false).some((value) => value.id === archived.id)).toBe(false)
    expect(service.listAccounts(true).some((value) => value.id === archived.id)).toBe(true)

    const archivedRename = service.patchAccount(archived.id, {
      expectedVersion: archivedVersion.version,
      name: 'Archived renamed',
    })
    expect(archivedRename.name).toBe('Archived renamed')
    for (const field of ['openingBalanceMinor', 'openingDate', 'nature', 'type', 'currency']) {
      expectLedgerError(
        () => service.patchAccount(archived.id, {
          expectedVersion: archivedRename.version,
          [field]: field === 'openingBalanceMinor' ? 1
            : field === 'openingDate' ? '2026-02-01'
              : field === 'nature' ? 'liability'
                : field === 'type' ? 'other'
                  : 'USD',
        }),
        'ledger-archived-account',
      )
    }

    const restored = service.restoreAccount(archived.id, { expectedVersion: archivedRename.version })
    expect(restored).toMatchObject({ archivedAt: null, version: archivedRename.version + 1 })
    const activeRestore = service.restoreAccount(archived.id, { expectedVersion: restored.version })
    expect(activeRestore.version).toBe(restored.version)
  })

  it('requires zero natural balance for both asset and liability archive', () => {
    const { service } = freshService()
    initialize(service)
    const asset = createAccount(service, 'zero-asset')
    const liability = createAccount(service, 'zero-liability', {
      type: 'credit_card',
      nature: 'liability',
    })
    expect(service.archiveAccount(asset.id, { expectedVersion: asset.version }).archivedAt).not.toBeNull()
    expect(service.archiveAccount(liability.id, { expectedVersion: liability.version }).archivedAt).not.toBeNull()
  })

  it('checks version before balance and history, and never unfreezes Settings on delete', () => {
    const { repository, service } = freshService()
    initialize(service)
    const nonZero = createAccount(service, 'nonzero', { openingBalanceMinor: 1 })
    expectLedgerError(
      () => service.archiveAccount(nonZero.id, { expectedVersion: 99 }),
      'ledger-version-conflict',
    )
    const category = service.listCategories('expense', false)[0]!
    repository.insertTransaction({
      id: 'delete-history',
      type: 'expense',
      amountMinor: 1,
      accountId: nonZero.id,
      categoryId: category.id,
      occurredAt: 1_700_000_001_000,
      payee: '',
      note: '',
      deletedAt: null,
      version: 1,
      createdAt: 1_700_000_001_000,
      updatedAt: 1_700_000_001_000,
    })
    expectLedgerError(
      () => service.deleteAccount(nonZero.id, { expectedVersion: nonZero.version }),
      'ledger-account-has-history',
    )
    expect(service.getSettings().version).toBe(1)
  })

  it('replays an Account snapshot after the Account is physically deleted', () => {
    const { service } = freshService()
    initialize(service)
    const request = accountRequest({ name: 'Replay account' })
    const first = service.createAccount(request, 'account-replay')
    const snapshot = first.responseBodyJson
    const account = JSON.parse(snapshot) as LedgerAccountDto
    service.deleteAccount(account.id, { expectedVersion: account.version })

    const replay = service.createAccount(request, 'account-replay')
    expect(replay.replayed).toBe(true)
    expect(replay.responseStatus).toBe(201)
    expect(replay.responseBodyJson).toBe(snapshot)
    expect(() => service.getAccount(account.id)).toThrow(LedgerError)
  })
})

describe('Ledger Transaction and Adjustment service lifecycle', () => {
  it.each([
    { type: 'income' as const, nature: 'asset' as const, expected: 100 },
    { type: 'income' as const, nature: 'liability' as const, expected: -100 },
    { type: 'expense' as const, nature: 'asset' as const, expected: -100 },
    { type: 'expense' as const, nature: 'liability' as const, expected: 100 },
  ])('applies $type to a $nature Account through the service', ({ type, nature, expected }) => {
    const { service } = freshService()
    initialize(service)
    const account = createAccount(service, `${type}-${nature}`, {
      type: nature === 'asset' ? 'bank' : 'credit_card',
      nature,
    })
    const category = service.listCategories(type, false)[0]!
    const result = service.createTransaction(transactionRequest({
      type,
      amountMinor: 100,
      accountId: account.id,
      categoryId: category.id,
    }), `${type}-${nature}-transaction`)

    expect(transactionFromResult(result)).toMatchObject({ type, amountMinor: 100, version: 1 })
    expect(service.getAccount(account.id).currentBalanceMinor).toBe(expected)
  })

  it.each([
    { fromNature: 'asset' as const, toNature: 'asset' as const },
    { fromNature: 'asset' as const, toNature: 'liability' as const },
    { fromNature: 'liability' as const, toNature: 'asset' as const },
    { fromNature: 'liability' as const, toNature: 'liability' as const },
  ])('preserves net worth for $fromNature to $toNature Transfer', ({ fromNature, toNature }) => {
    const { service } = freshService()
    initialize(service)
    const from = createAccount(service, `from-${fromNature}`, {
      type: fromNature === 'asset' ? 'bank' : 'loan',
      nature: fromNature,
      openingBalanceMinor: 100,
    })
    const to = createAccount(service, `to-${toNature}`, {
      type: toNature === 'asset' ? 'wallet' : 'credit_card',
      nature: toNature,
      openingBalanceMinor: 50,
    })
    const before = (fromNature === 'asset' ? from.currentBalanceMinor : -from.currentBalanceMinor)
      + (toNature === 'asset' ? to.currentBalanceMinor : -to.currentBalanceMinor)
    const result = service.createTransaction(transactionRequest({
      type: 'transfer',
      amountMinor: 10,
      fromAccountId: from.id,
      toAccountId: to.id,
    }), `transfer-${fromNature}-${toNature}`)
    const transfer = transactionFromResult(result)

    expect(transfer).toMatchObject({ type: 'transfer', fromAccountId: from.id, toAccountId: to.id })
    const fromAfter = service.getAccount(from.id).currentBalanceMinor
    const toAfter = service.getAccount(to.id).currentBalanceMinor
    const after = (fromNature === 'asset' ? fromAfter : -fromAfter)
      + (toNature === 'asset' ? toAfter : -toAfter)
    expect(after).toBe(before)
  })

  it('enforces Transfer kind Account natures on create and patch', () => {
    const { service } = freshService()
    initialize(service)
    const bank = createAccount(service, 'transfer-kind-bank')
    const wallet = createAccount(service, 'transfer-kind-wallet', { type: 'wallet' })
    const card = createAccount(service, 'transfer-kind-card', {
      type: 'credit_card',
      nature: 'liability',
    })

    const repayment = transactionFromResult(service.createTransaction(transactionRequest({
      type: 'transfer',
      transferKind: 'repayment',
      amountMinor: 10,
      fromAccountId: bank.id,
      toAccountId: card.id,
    }), 'valid-repayment'))
    expect(repayment).toMatchObject({ type: 'transfer', transferKind: 'repayment' })

    const withdrawal = transactionFromResult(service.createTransaction(transactionRequest({
      type: 'transfer',
      transferKind: 'withdrawal',
      amountMinor: 10,
      fromAccountId: bank.id,
      toAccountId: wallet.id,
    }), 'valid-withdrawal'))
    expect(withdrawal).toMatchObject({ type: 'transfer', transferKind: 'withdrawal' })

    expectLedgerError(() => service.createTransaction(transactionRequest({
      type: 'transfer',
      transferKind: 'repayment',
      amountMinor: 10,
      fromAccountId: bank.id,
      toAccountId: wallet.id,
    }), 'invalid-repayment'), 'ledger-validation-failed')

    expectLedgerError(() => service.patchTransaction(withdrawal.id, {
      expectedVersion: withdrawal.version,
      transferKind: 'repayment',
    }), 'ledger-validation-failed')
  })

  it('persists payees for general transfers, repayments, and withdrawals', () => {
    const { service } = freshService()
    initialize(service)
    const bank = createAccount(service, 'payee-bank')
    const wallet = createAccount(service, 'payee-wallet', { type: 'wallet' })
    const card = createAccount(service, 'payee-card', {
      type: 'credit_card',
      nature: 'liability',
    })

    const general = transactionFromResult(service.createTransaction(transactionRequest({
      type: 'transfer',
      transferKind: 'general',
      amountMinor: 10,
      fromAccountId: bank.id,
      toAccountId: wallet.id,
      payee: '朋友转账',
    }), 'transfer-payee'))
    const repayment = transactionFromResult(service.createTransaction(transactionRequest({
      type: 'transfer',
      transferKind: 'repayment',
      amountMinor: 10,
      fromAccountId: bank.id,
      toAccountId: card.id,
      payee: '招商银行还款',
    }), 'repayment-payee'))
    const withdrawal = transactionFromResult(service.createTransaction(transactionRequest({
      type: 'transfer',
      transferKind: 'withdrawal',
      amountMinor: 10,
      fromAccountId: bank.id,
      toAccountId: wallet.id,
      payee: '微信提现吗',
    }), 'withdrawal-payee'))

    expect(service.getTransaction(general.id)).toMatchObject({ type: 'transfer', payee: '朋友转账' })
    expect(service.getTransaction(repayment.id)).toMatchObject({ type: 'transfer', payee: '招商银行还款' })
    expect(service.getTransaction(withdrawal.id)).toMatchObject({ type: 'transfer', payee: '微信提现吗' })
  })

  it('keeps transfer charges as a grouped expense and edits or deletes the bundle atomically', () => {
    const { repository, service } = freshService()
    initialize(service)
    const bank = createAccount(service, 'bundle-bank', {
      name: '招商银行储蓄卡',
      openingBalanceMinor: 10_000,
    })
    const wallet = createAccount(service, 'bundle-wallet', {
      name: '微信零钱',
      type: 'wallet',
      openingBalanceMinor: 10_000,
    })
    const loan = createAccount(service, 'bundle-loan', {
      name: '花呗',
      type: 'loan',
      nature: 'liability',
    })
    const interestCategory = service.listCategories('expense', false).find((category) => category.systemKey === 'interest')!

    const repayment = transactionFromResult(service.createTransaction(transactionRequest({
      type: 'transfer',
      transferKind: 'repayment',
      amountMinor: 5_000,
      feeMinor: 300,
      fromAccountId: bank.id,
      toAccountId: loan.id,
    }), 'repayment-bundle'))
    expect(repayment).toMatchObject({
      type: 'transfer',
      transferKind: 'repayment',
      amountMinor: 5_000,
      groupId: expect.any(String),
    })
    const groupId = repayment.groupId!
    expect(repository.listTransactionsByGroupId(groupId).map((item) => item.type).sort()).toEqual(['expense', 'transfer'])
    expect(repository.listTransactionsByGroupId(groupId).find((item) => item.type === 'expense')).toMatchObject({
      amountMinor: 300,
      accountId: bank.id,
      categoryId: interestCategory.id,
      payee: '花呗还款利息',
    })
    expect(service.getAccount(bank.id).currentBalanceMinor).toBe(4_700)
    expect(service.getAccount(loan.id).currentBalanceMinor).toBe(-5_000)

    service.patchAccount(loan.id, {
      expectedVersion: loan.version,
      name: '花呗账单',
    })
    const patched = service.patchTransaction(repayment.id, {
      expectedVersion: repayment.version,
      amountMinor: 5_500,
      feeMinor: 400,
      note: 'updated repayment',
    })
    expect(patched).toMatchObject({ amountMinor: 5_500, groupId, version: 2 })
    expect(repository.listTransactionsByGroupId(groupId).find((item) => item.type === 'expense')).toMatchObject({
      amountMinor: 400,
      categoryId: interestCategory.id,
      payee: '花呗还款利息',
      note: 'updated repayment',
    })
    expect(service.getAccount(bank.id).currentBalanceMinor).toBe(4_100)
    expect(service.getAccount(loan.id).currentBalanceMinor).toBe(-5_500)

    const cleared = service.patchTransaction(repayment.id, {
      expectedVersion: patched.version,
      feeMinor: 0,
    })
    expect(cleared.groupId).toBeUndefined()
    expect(repository.listTransactionsByGroupId(groupId, true).find((item) => item.type === 'expense')).toMatchObject({
      deletedAt: expect.any(Number),
    })
    expect(service.getAccount(bank.id).currentBalanceMinor).toBe(4_500)

    const withdrawal = transactionFromResult(service.createTransaction(transactionRequest({
      type: 'transfer',
      transferKind: 'withdrawal',
      amountMinor: 2_000,
      feeMinor: 50,
      fromAccountId: wallet.id,
      toAccountId: bank.id,
      payee: '微信提现吗',
    }), 'withdrawal-bundle'))
    const withdrawalFee = repository.listTransactionsByGroupId(withdrawal.groupId!).find((item) => item.type === 'expense')!
    expect(withdrawalFee.payee).toBe('微信零钱提现手续费')
    service.patchAccount(wallet.id, {
      expectedVersion: wallet.version,
      name: '微信钱包',
    })
    const patchedWithdrawal = service.patchTransaction(withdrawal.id, {
      expectedVersion: withdrawal.version,
      payee: '支付宝提现',
    })
    const patchedWithdrawalFee = repository.listTransactionsByGroupId(patchedWithdrawal.groupId!).find((item) => item.type === 'expense')!
    expect(patchedWithdrawalFee.payee).toBe('微信零钱提现手续费')

    const replacementSource = createAccount(service, 'bundle-replacement-source', {
      name: '支付宝余额',
      type: 'wallet',
      openingBalanceMinor: 10_000,
    })
    const movedWithdrawal = service.patchTransaction(patchedWithdrawal.id, {
      expectedVersion: patchedWithdrawal.version,
      fromAccountId: replacementSource.id,
    })
    const movedWithdrawalFee = repository.listTransactionsByGroupId(movedWithdrawal.groupId!).find((item) => item.type === 'expense')!
    expect(movedWithdrawal).toMatchObject({ fromAccountId: replacementSource.id })
    expect(movedWithdrawalFee).toMatchObject({
      accountId: replacementSource.id,
      payee: '支付宝余额提现手续费',
    })
    expectLedgerError(() => service.getTransaction(withdrawalFee.id), 'ledger-not-found')
    service.deleteTransaction(movedWithdrawal.id, { expectedVersion: movedWithdrawal.version })
    expect(repository.getTransaction(withdrawal.id)?.deletedAt).not.toBeNull()
    expect(repository.getTransaction(withdrawalFee.id)?.deletedAt).not.toBeNull()
    expect(service.getAccount(wallet.id).currentBalanceMinor).toBe(10_000)
    expect(service.getAccount(replacementSource.id).currentBalanceMinor).toBe(10_000)
    expect(service.getAccount(bank.id).currentBalanceMinor).toBe(4_500)
  })

  it('refreshes a repayment companion payee when its destination account changes', () => {
    const { repository, service } = freshService()
    initialize(service)
    const source = createAccount(service, 'repayment-identity-source', {
      name: '招商银行储蓄卡',
      openingBalanceMinor: 10_000,
    })
    const originalDestination = createAccount(service, 'repayment-identity-original-destination', {
      name: '花呗账单',
      type: 'loan',
      nature: 'liability',
    })
    const replacementDestination = createAccount(service, 'repayment-identity-replacement-destination', {
      name: '京东白条',
      type: 'loan',
      nature: 'liability',
    })

    const repayment = transactionFromResult(service.createTransaction(transactionRequest({
      type: 'transfer',
      transferKind: 'repayment',
      amountMinor: 5_000,
      feeMinor: 300,
      fromAccountId: source.id,
      toAccountId: originalDestination.id,
    }), 'repayment-destination-identity-change'))
    const originalFee = repository.listTransactionsByGroupId(repayment.groupId!).find((item) => item.type === 'expense')!
    expect(originalFee.payee).toBe('花呗账单还款利息')

    const patched = service.patchTransaction(repayment.id, {
      expectedVersion: repayment.version,
      toAccountId: replacementDestination.id,
    })
    const patchedFee = repository.listTransactionsByGroupId(patched.groupId!).find((item) => item.type === 'expense')!

    expect(patched).toMatchObject({ toAccountId: replacementDestination.id })
    expect(patchedFee).toMatchObject({
      id: originalFee.id,
      accountId: source.id,
      payee: '京东白条还款利息',
    })
  })

  it('refreshes a companion payee when a transfer changes from repayment to withdrawal', () => {
    const { repository, service } = freshService()
    initialize(service)
    const source = createAccount(service, 'transfer-kind-identity-source', {
      name: '招商银行储蓄卡',
      openingBalanceMinor: 10_000,
    })
    const repaymentDestination = createAccount(service, 'transfer-kind-identity-repayment-destination', {
      name: '花呗账单',
      type: 'loan',
      nature: 'liability',
    })
    const withdrawalDestination = createAccount(service, 'transfer-kind-identity-withdrawal-destination', {
      name: '微信零钱',
      type: 'wallet',
    })

    const repayment = transactionFromResult(service.createTransaction(transactionRequest({
      type: 'transfer',
      transferKind: 'repayment',
      amountMinor: 5_000,
      feeMinor: 300,
      fromAccountId: source.id,
      toAccountId: repaymentDestination.id,
    }), 'transfer-kind-identity-change'))
    const originalFee = repository.listTransactionsByGroupId(repayment.groupId!).find((item) => item.type === 'expense')!
    expect(originalFee.payee).toBe('花呗账单还款利息')

    const patched = service.patchTransaction(repayment.id, {
      expectedVersion: repayment.version,
      transferKind: 'withdrawal',
      toAccountId: withdrawalDestination.id,
    })
    const patchedFee = repository.listTransactionsByGroupId(patched.groupId!).find((item) => item.type === 'expense')!

    expect(patched).toMatchObject({
      transferKind: 'withdrawal',
      toAccountId: withdrawalDestination.id,
      feeMode: 'extra',
    })
    expect(patchedFee).toMatchObject({
      id: originalFee.id,
      accountId: source.id,
      payee: '招商银行储蓄卡提现手续费',
    })
  })

  it('applies withdrawal fees as either an extra debit or a deducted receipt', () => {
    const { repository, service } = freshService()
    initialize(service)
    const source = createAccount(service, 'withdrawal-source', { type: 'wallet', openingBalanceMinor: 10_000 })
    const destination = createAccount(service, 'withdrawal-destination', { openingBalanceMinor: 0 })

    const extra = transactionFromResult(service.createTransaction(transactionRequest({
      type: 'transfer',
      transferKind: 'withdrawal',
      amountMinor: 2_000,
      feeMinor: 50,
      feeMode: 'extra',
      fromAccountId: source.id,
      toAccountId: destination.id,
    }), 'withdrawal-extra'))
    expect(extra).toMatchObject({ amountMinor: 2_000, feeMode: 'extra' })
    expect(service.getAccount(source.id).currentBalanceMinor).toBe(7_950)
    expect(service.getAccount(destination.id).currentBalanceMinor).toBe(2_000)

    const deducted = transactionFromResult(service.createTransaction(transactionRequest({
      type: 'transfer',
      transferKind: 'withdrawal',
      amountMinor: 1_000,
      feeMinor: 25,
      feeMode: 'deducted',
      fromAccountId: source.id,
      toAccountId: destination.id,
    }), 'withdrawal-deducted'))
    expect(deducted).toMatchObject({ amountMinor: 975, feeMode: 'deducted' })
    expect(service.getAccount(source.id).currentBalanceMinor).toBe(6_950)
    expect(service.getAccount(destination.id).currentBalanceMinor).toBe(2_975)
    expect(repository.listTransactionsByGroupId(deducted.groupId!).find((item) => item.type === 'expense')).toMatchObject({ amountMinor: 25 })
  })

  it('rejects generic Adjustment creation and validates current-state references and time boundaries', () => {
    const { service } = freshService()
    initialize(service)
    const account = createAccount(service, 'future-account', { openingDate: '2026-02-01' })
    const expenseCategory = service.listCategories('expense', false)[0]!

    expectLedgerError(
      () => service.createTransaction(transactionRequest({
        type: 'adjustment',
        accountId: account.id,
        targetBalanceMinor: 1,
        expectedCalculatedBalanceMinor: 0,
      }), 'generic-adjustment'),
      'ledger-validation-failed',
    )
    expectLedgerError(
      () => service.createTransaction(transactionRequest({
        type: 'expense',
        amountMinor: 1,
        accountId: account.id,
        categoryId: expenseCategory.id,
      }), 'opening-conflict'),
      'ledger-opening-date-conflict',
    )
    expectLedgerError(
      () => service.createTransaction(transactionRequest({
        type: 'expense',
        amountMinor: 1,
        accountId: account.id,
        categoryId: expenseCategory.id,
        occurredAt: TEST_NOW + 60_001,
      }), 'future-conflict'),
      'ledger-validation-failed',
    )

    const archived = createAccount(service, 'archived-for-transaction')
    service.archiveAccount(archived.id, { expectedVersion: archived.version })
    expectLedgerError(
      () => service.createTransaction(transactionRequest({
        type: 'expense',
        amountMinor: 1,
        accountId: archived.id,
        categoryId: expenseCategory.id,
      }), 'archived-account-create'),
      'ledger-archived-account',
    )
  })

  it('atomically patches a transaction across Accounts and Categories and enforces type/field rules', () => {
    const { service } = freshService()
    initialize(service)
    const first = createAccount(service, 'patch-first')
    const second = createAccount(service, 'patch-second')
    const firstCategory = createCategory(service, 'patch-category-first', { name: 'Patch first' })
    const secondCategory = createCategory(service, 'patch-category-second', { name: 'Patch second' })
    const created = transactionFromResult(service.createTransaction(transactionRequest({
      type: 'expense',
      amountMinor: 100,
      accountId: first.id,
      categoryId: firstCategory.id,
    }), 'patch-transaction'))

    const patched = service.patchTransaction(created.id, {
      expectedVersion: created.version,
      amountMinor: 150,
      accountId: second.id,
      categoryId: secondCategory.id,
      note: 'moved',
    })
    expect(patched).toMatchObject({
      id: created.id,
      amountMinor: 150,
      accountId: second.id,
      categoryId: secondCategory.id,
      note: 'moved',
      version: 2,
    })
    expect(service.getAccount(first.id).currentBalanceMinor).toBe(0)
    expect(service.getAccount(second.id).currentBalanceMinor).toBe(-150)

    expectLedgerError(
      () => service.patchTransaction(created.id, { expectedVersion: 2, type: 'income' }),
      'ledger-transaction-type-immutable',
    )
    expectLedgerError(
      () => service.patchTransaction(created.id, { expectedVersion: 2, fromAccountId: first.id }),
      'ledger-validation-failed',
    )

    const archivedCategory = createCategory(service, 'archived-patch-category', { name: 'Archived patch' })
    service.archiveCategory(archivedCategory.id, { expectedVersion: archivedCategory.version })
    expectLedgerError(
      () => service.patchTransaction(created.id, {
        expectedVersion: 2,
        categoryId: archivedCategory.id,
      }),
      'ledger-archived-category',
    )
  })

  it('distinguishes missing and archived candidate Accounts before PATCH version checks', () => {
    const { service } = freshService()
    initialize(service)
    const account = createAccount(service, 'patch-candidate-source')
    const category = service.listCategories('expense', false)[0]!
    const transaction = transactionFromResult(service.createTransaction(transactionRequest({
      type: 'expense',
      amountMinor: 1,
      accountId: account.id,
      categoryId: category.id,
    }), 'patch-candidate-transaction'))
    const archived = createAccount(service, 'patch-candidate-archived')
    service.archiveAccount(archived.id, { expectedVersion: archived.version })

    expectLedgerError(
      () => service.patchTransaction(transaction.id, {
        expectedVersion: transaction.version,
        accountId: 'missing-account',
      }),
      'ledger-not-found',
    )
    expectLedgerError(
      () => service.patchTransaction(transaction.id, {
        expectedVersion: 99,
        accountId: 'missing-account',
      }),
      'ledger-version-conflict',
    )
    expectLedgerError(
      () => service.patchTransaction(transaction.id, {
        expectedVersion: 99,
        accountId: archived.id,
      }),
      'ledger-archived-account',
    )
  })

  it('applies the same missing-versus-archived candidate contract to Transfer PATCH', () => {
    const { service } = freshService()
    initialize(service)
    const from = createAccount(service, 'transfer-candidate-from', { openingBalanceMinor: 100 })
    const to = createAccount(service, 'transfer-candidate-to', { openingBalanceMinor: -100 })
    const transfer = transactionFromResult(service.createTransaction(transactionRequest({
      type: 'transfer',
      amountMinor: 100,
      fromAccountId: from.id,
      toAccountId: to.id,
    }), 'transfer-candidate-transaction'))
    const archived = createAccount(service, 'transfer-candidate-archived')
    service.archiveAccount(archived.id, { expectedVersion: archived.version })

    expectLedgerError(
      () => service.patchTransaction(transfer.id, {
        expectedVersion: transfer.version,
        toAccountId: 'missing-account',
      }),
      'ledger-not-found',
    )
    expectLedgerError(
      () => service.patchTransaction(transfer.id, {
        expectedVersion: 99,
        toAccountId: 'missing-account',
      }),
      'ledger-version-conflict',
    )
    expectLedgerError(
      () => service.patchTransaction(transfer.id, {
        expectedVersion: 99,
        toAccountId: archived.id,
      }),
      'ledger-archived-account',
    )
  })

  it('allows only text edits on transactions that reference an archived Account', () => {
    const { service } = freshService()
    initialize(service)
    const account = createAccount(service, 'archived-history-account')
    const expenseCategory = service.listCategories('expense', false)[0]!
    const incomeCategory = service.listCategories('income', false)[0]!
    const expense = transactionFromResult(service.createTransaction(transactionRequest({
      type: 'expense',
      amountMinor: 100,
      accountId: account.id,
      categoryId: expenseCategory.id,
    }), 'archived-expense'))
    transactionFromResult(service.createTransaction(transactionRequest({
      type: 'income',
      amountMinor: 100,
      accountId: account.id,
      categoryId: incomeCategory.id,
    }), 'archived-income'))
    expect(service.getAccount(account.id).currentBalanceMinor).toBe(0)
    service.archiveAccount(account.id, { expectedVersion: account.version })

    expectLedgerError(
      () => service.patchTransaction(expense.id, { expectedVersion: 99, amountMinor: 1 }),
      'ledger-archived-account',
    )
    expectLedgerError(
      () => service.deleteTransaction(expense.id, { expectedVersion: 99 }),
      'ledger-archived-account',
    )
    const renamed = service.patchTransaction(expense.id, {
      expectedVersion: expense.version,
      note: 'historical note',
      payee: 'historical payee',
    })
    expect(renamed).toMatchObject({ version: 2, note: 'historical note', payee: 'historical payee' })
  })

  it.each([
    { fromNature: 'asset' as const, toNature: 'asset' as const },
    { fromNature: 'asset' as const, toNature: 'liability' as const },
    { fromNature: 'liability' as const, toNature: 'asset' as const },
    { fromNature: 'liability' as const, toNature: 'liability' as const },
  ])('keeps archived Transfer references safe for $fromNature to $toNature', ({ fromNature, toNature }) => {
    const { service } = freshService()
    initialize(service)
    const from = createAccount(service, `archived-transfer-from-${fromNature}`, {
      type: fromNature === 'asset' ? 'bank' : 'loan',
      nature: fromNature,
      openingBalanceMinor: fromNature === 'asset' ? 100 : -100,
    })
    const to = createAccount(service, `archived-transfer-to-${toNature}`, {
      type: toNature === 'asset' ? 'wallet' : 'credit_card',
      nature: toNature,
      openingBalanceMinor: toNature === 'asset' ? -100 : 100,
    })
    const transfer = transactionFromResult(service.createTransaction(transactionRequest({
      type: 'transfer',
      amountMinor: 100,
      fromAccountId: from.id,
      toAccountId: to.id,
    }), `archived-transfer-${fromNature}-${toNature}`))
    expect(service.getAccount(from.id).currentBalanceMinor).toBe(0)
    expect(service.getAccount(to.id).currentBalanceMinor).toBe(0)

    service.archiveAccount(from.id, { expectedVersion: from.version })
    service.archiveAccount(to.id, { expectedVersion: to.version })
    const notePatch = service.patchTransaction(transfer.id, {
      expectedVersion: transfer.version,
      note: 'archived transfer note',
    })
    expect(notePatch).toMatchObject({ version: 2, note: 'archived transfer note' })
    expectLedgerError(
      () => service.deleteTransaction(transfer.id, { expectedVersion: notePatch.version }),
      'ledger-archived-account',
    )
  })

  it('soft deletes every transaction type and makes deletion terminal and balance-neutral', () => {
    const { repository, service } = freshService()
    initialize(service)
    const account = createAccount(service, 'delete-account')
    const other = createAccount(service, 'delete-other')
    const expenseCategory = service.listCategories('expense', false)[0]!
    const incomeCategory = service.listCategories('income', false)[0]!
    const income = transactionFromResult(service.createTransaction(transactionRequest({
      type: 'income', amountMinor: 100, accountId: account.id, categoryId: incomeCategory.id,
    }), 'delete-income'))
    const expense = transactionFromResult(service.createTransaction(transactionRequest({
      type: 'expense', amountMinor: 20, accountId: account.id, categoryId: expenseCategory.id,
    }), 'delete-expense'))
    const transfer = transactionFromResult(service.createTransaction(transactionRequest({
      type: 'transfer', amountMinor: 30, fromAccountId: account.id, toAccountId: other.id,
    }), 'delete-transfer'))
    const adjustmentResult = service.adjustAccount(account.id, {
      targetBalanceMinor: 60,
      expectedCalculatedBalanceMinor: 50,
      occurredAt: TEST_NOW,
      note: 'delete adjustment',
    }, 'delete-adjustment')
    expect(adjustmentResult.responseStatus).toBe(201)
    const adjustment = (JSON.parse(adjustmentResult.responseBodyJson) as {
      adjustment: { id: string; version: number }
    }).adjustment

    for (const transaction of [income, expense, transfer, adjustment]) {
      const deleted = service.deleteTransaction(transaction.id, { expectedVersion: 1 })
      expect(deleted).toMatchObject({ id: transaction.id, version: 2 })
      expect(deleted.deletedAt).not.toBeNull()
      expectLedgerError(
        () => service.patchTransaction(transaction.id, null),
        'ledger-transaction-deleted',
      )
      expectLedgerError(
        () => service.patchTransaction(transaction.id, { expectedVersion: 2, note: 'blocked' }),
        'ledger-transaction-deleted',
      )
    }

    expect(service.getAccount(account.id).currentBalanceMinor).toBe(0)
    expect(service.getAccount(other.id).currentBalanceMinor).toBe(0)
    expect(repository.hasAccountHistory(account.id)).toBe(true)
    expect(repository.getTransaction(adjustment.id)?.deletedAt).not.toBeNull()
    const repeated = service.deleteTransaction(income.id, { expectedVersion: 1 })
    expect(repeated).toMatchObject({ id: income.id, version: 2 })
  })

  it('keeps terminal DELETE idempotent after the referenced Account is archived', () => {
    const { repository, service } = freshService()
    initialize(service)
    const account = createAccount(service, 'terminal-delete-account')
    const category = service.listCategories('expense', false)[0]!
    const expense = transactionFromResult(service.createTransaction(transactionRequest({
      type: 'expense',
      amountMinor: 100,
      accountId: account.id,
      categoryId: category.id,
    }), 'terminal-delete-expense'))

    expect(service.getAccount(account.id).currentBalanceMinor).toBe(-100)
    const deleted = service.deleteTransaction(expense.id, { expectedVersion: 1 })
    expect(service.getAccount(account.id).currentBalanceMinor).toBe(0)
    const deletedRow = repository.getTransaction(expense.id)
    expect(deletedRow).not.toBeNull()
    const archived = service.archiveAccount(account.id, { expectedVersion: account.version })
    expect(archived).toMatchObject({ archivedAt: expect.any(Number), currentBalanceMinor: 0 })

    const beforeRetry = repository.getTransaction(expense.id)
    expect(beforeRetry).toEqual(deletedRow)

    for (const expectedVersion of [1, 2, 999]) {
      expect(service.deleteTransaction(expense.id, { expectedVersion })).toEqual(deleted)
    }

    for (const command of [
      {},
      { expectedVersion: 0 },
      { expectedVersion: -1 },
      { expectedVersion: 1.5 },
      { expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
      { expectedVersion: '1' },
    ]) {
      expectLedgerError(
        () => service.deleteTransaction(expense.id, command),
        'ledger-validation-failed',
      )
    }

    expect(repository.getTransaction(expense.id)).toEqual(beforeRetry)
    expect(service.getAccount(account.id)).toMatchObject({
      archivedAt: expect.any(Number),
      currentBalanceMinor: 0,
    })
    expect(repository.hasAccountHistory(account.id)).toBe(true)
  })

  it('replays immutable create snapshots and applies Adjustment no-op/concurrency semantics', () => {
    const { service } = freshService()
    initialize(service)
    const account = createAccount(service, 'adjustment-account')
    const expenseCategory = service.listCategories('expense', false)[0]!
    const noOpRequest = {
      targetBalanceMinor: 0,
      expectedCalculatedBalanceMinor: 0,
      occurredAt: TEST_NOW,
      note: 'already reconciled',
    }
    const noOp = service.adjustAccount(account.id, noOpRequest, 'adjustment-no-op')
    expect(noOp.responseStatus).toBe(200)
    expect(JSON.parse(noOp.responseBodyJson)).toMatchObject({ adjustment: null, noOp: true, account: { currentBalanceMinor: 0 } })

    const income = transactionFromResult(service.createTransaction(transactionRequest({
      type: 'income', amountMinor: 10, accountId: account.id, categoryId: service.listCategories('income', false)[0]!.id,
    }), 'adjustment-balance-change'))
    expect(income.amountMinor).toBe(10)
    const replayNoOp = service.adjustAccount(account.id, noOpRequest, 'adjustment-no-op')
    expect(replayNoOp.replayed).toBe(true)
    expect(replayNoOp.responseBodyJson).toBe(noOp.responseBodyJson)

    const mismatchKey = 'adjustment-retry-after-conflict'
    expectLedgerError(
      () => service.adjustAccount(account.id, {
        targetBalanceMinor: 20,
        expectedCalculatedBalanceMinor: 0,
        occurredAt: TEST_NOW,
        note: '',
      }, mismatchKey),
      'ledger-balance-conflict',
    )
    const adjusted = service.adjustAccount(account.id, {
      targetBalanceMinor: 20,
      expectedCalculatedBalanceMinor: 10,
      occurredAt: TEST_NOW,
      note: 'reconciled',
    }, mismatchKey)
    expect(adjusted.responseStatus).toBe(201)
    const adjustedReplay = service.adjustAccount(account.id, {
      targetBalanceMinor: 20,
      expectedCalculatedBalanceMinor: 10,
      occurredAt: TEST_NOW,
      note: 'reconciled',
    }, mismatchKey)
    expect(adjustedReplay.replayed).toBe(true)
    expect(adjustedReplay.responseBodyJson).toBe(adjusted.responseBodyJson)
    const adjustment = JSON.parse(adjusted.responseBodyJson) as { adjustment: { id: string; version: number } }
    expect(adjustment.adjustment.version).toBe(1)

    const notePatch = service.patchTransaction(adjustment.adjustment.id, {
      expectedVersion: 1,
      note: 'corrected note',
    })
    expect(notePatch.version).toBe(2)
    expectLedgerError(
      () => service.patchTransaction(adjustment.adjustment.id, {
        expectedVersion: 2,
        adjustmentTargetBalanceMinor: 21,
      }),
      'ledger-adjustment-immutable',
    )
    const deleted = service.deleteTransaction(adjustment.adjustment.id, { expectedVersion: 2 })
    expect(deleted.deletedAt).not.toBeNull()
    expect(service.getAccount(account.id).currentBalanceMinor).toBe(10)

    expectLedgerError(
      () => service.adjustAccount(account.id, {
        targetBalanceMinor: 11,
        expectedCalculatedBalanceMinor: 10,
        occurredAt: TEST_NOW,
        note: 'different payload',
      }, mismatchKey),
      'ledger-idempotency-conflict',
    )

    const createdResult = service.createTransaction(transactionRequest({
      type: 'expense', amountMinor: 3, accountId: account.id, categoryId: expenseCategory.id,
    }), 'transaction-replay')
    const created = transactionFromResult(createdResult)
    const snapshot = createdResult.responseBodyJson
    service.patchTransaction(created.id, { expectedVersion: 1, note: 'changed after create' })
    const replay = service.createTransaction(transactionRequest({
      type: 'expense', amountMinor: 3, accountId: account.id, categoryId: expenseCategory.id,
    }), 'transaction-replay')
    expect(replay.replayed).toBe(true)
    expect(replay.responseBodyJson).toBe(snapshot)
  })

  it('rejects Adjustment delta subtraction overflow without consuming the request key', () => {
    const { service } = freshService()
    initialize(service)
    const account = createAccount(service, 'adjustment-overflow', {
      openingBalanceMinor: -Number.MAX_SAFE_INTEGER,
    })
    const request = {
      targetBalanceMinor: Number.MAX_SAFE_INTEGER,
      expectedCalculatedBalanceMinor: -Number.MAX_SAFE_INTEGER,
      occurredAt: TEST_NOW,
      note: 'overflow',
    }
    expectLedgerError(
      () => service.adjustAccount(account.id, request, 'adjustment-overflow-key'),
      'ledger-money-overflow',
    )
    const row = service.getAccount(account.id)
    expect(row.currentBalanceMinor).toBe(-Number.MAX_SAFE_INTEGER)
  })
})

describe('Ledger Category service lifecycle', () => {
  it('uses normalized identity for create/rename/kind changes, including archived rows', () => {
    const { service } = freshService()
    initialize(service)

    const category = createCategory(service, 'custom-category', { name: '  Foo  ' })
    expect(category.normalizedName).toBe('foo')
    expectLedgerError(
      () => createCategory(service, 'duplicate-category', { name: 'FOO' }),
      'ledger-duplicate-category',
    )
    const oppositeKind = createCategory(service, 'opposite-kind', { kind: 'income', name: 'FOO' })
    expect(oppositeKind.kind).toBe('income')

    const renamed = service.patchCategory(category.id, {
      expectedVersion: category.version,
      name: 'Bar',
    })
    expect(renamed).toMatchObject({ id: category.id, name: 'Bar', normalizedName: 'bar', version: 2 })
    const archived = service.archiveCategory(renamed.id, { expectedVersion: renamed.version })
    expect(archived.normalizedName).toBe('bar')
    expectLedgerError(
      () => createCategory(service, 'archived-duplicate', { name: ' BAR ' }),
      'ledger-duplicate-category',
    )
    expectLedgerError(
      () => service.patchCategory(category.id, { expectedVersion: archived.version, name: 'Other' }),
      'ledger-archived-category',
    )
    const restored = service.restoreCategory(category.id, { expectedVersion: archived.version })
    expect(restored).toMatchObject({ id: category.id, archivedAt: null, version: 4 })
    expect(service.restoreCategory(category.id, { expectedVersion: restored.version }).version)
      .toBe(restored.version)
    expect(service.deleteCategory(oppositeKind.id, { expectedVersion: oppositeKind.version })).toEqual({
      deleted: true,
      id: oppositeKind.id,
    })
  })

  it('freezes kind after any history and counts soft-deleted history for physical delete', () => {
    const { repository, service } = freshService()
    initialize(service)
    const account = createAccount(service, 'category-history-account')
    const category = createCategory(service, 'category-history', { name: 'Historical' })
    repository.insertTransaction({
      id: 'category-history-transaction',
      type: 'expense',
      amountMinor: 1,
      accountId: account.id,
      categoryId: category.id,
      occurredAt: 1_700_000_001_000,
      payee: '',
      note: '',
      deletedAt: 1_700_000_002_000,
      version: 1,
      createdAt: 1_700_000_001_000,
      updatedAt: 1_700_000_002_000,
    })

    expectLedgerError(
      () => service.patchCategory(category.id, { expectedVersion: category.version, kind: 'income' }),
      'ledger-validation-failed',
    )
    const renamed = service.patchCategory(category.id, {
      expectedVersion: category.version,
      name: 'Renamed historical',
    })
    expect(renamed.normalizedName).toBe('renamed historical')
    expectLedgerError(
      () => service.deleteCategory(category.id, { expectedVersion: renamed.version }),
      'ledger-category-has-history',
    )
  })

  it('does not move a category with history to the recycle bin', () => {
    const { repository, service } = freshService()
    initialize(service)
    const account = createAccount(service, 'recycle-bin-history-account')
    const category = createCategory(service, 'recycle-bin-history-category', { name: 'Used category' })
    repository.insertTransaction({
      id: 'recycle-bin-history-transaction',
      type: 'expense',
      amountMinor: 1,
      accountId: account.id,
      categoryId: category.id,
      occurredAt: 1_700_000_001_000,
      payee: '',
      note: '',
      deletedAt: null,
      version: 1,
      createdAt: 1_700_000_001_000,
      updatedAt: 1_700_000_001_000,
    })

    expectLedgerError(
      () => service.archiveCategory(category.id, { expectedVersion: category.version }),
      'ledger-category-has-history',
    )
    expect(repository.getCategory(category.id)?.archivedAt).toBeNull()
  })

  it('replays the original Category snapshot after later lifecycle changes', () => {
    const { service } = freshService()
    initialize(service)
    const request = categoryRequest({ name: 'Replay category' })
    const first = service.createCategory(request, 'category-replay')
    const category = JSON.parse(first.responseBodyJson) as LedgerCategoryDto
    service.archiveCategory(category.id, { expectedVersion: category.version })
    const replay = service.createCategory(request, 'category-replay')
    expect(replay.replayed).toBe(true)
    expect(replay.responseBodyJson).toBe(first.responseBodyJson)
  })
})

describe('Ledger service error priority', () => {
  it('applies lifecycle/version gates before lower-priority checks', () => {
    const { service } = freshService()
    initialize(service)
    const account = createAccount(service, 'priority-account', { openingBalanceMinor: 10 })
    expectLedgerError(
      () => service.archiveAccount(account.id, { expectedVersion: 99 }),
      'ledger-version-conflict',
    )

    const zero = createAccount(service, 'priority-archived')
    const archivedAccount = service.archiveAccount(zero.id, { expectedVersion: zero.version })
    expectLedgerError(
      () => service.patchAccount(zero.id, { expectedVersion: 99, openingBalanceMinor: 1 }),
      'ledger-archived-account',
    )
    expect(archivedAccount.currentBalanceMinor).toBe(0)

    expectLedgerError(
      () => service.patchAccount('missing-account', null),
      'ledger-not-found',
    )
    expectLedgerError(
      () => service.patchCategory('missing-category', { malformed: true }),
      'ledger-not-found',
    )
  })

  it('returns the canonical pair and currency errors for Account creation', () => {
    const { service } = freshService()
    initialize(service)
    expectLedgerError(
      () => service.createAccount(accountRequest({ type: 'credit_card', nature: 'asset' }), 'bad-pair'),
      'ledger-invalid-account-pair',
    )
    expectLedgerError(
      () => service.createAccount(accountRequest({ currency: 'USD' }), 'bad-currency'),
      'ledger-currency-mismatch',
    )
  })
})
