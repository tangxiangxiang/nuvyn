import { afterEach, describe, expect, it } from 'vitest'
import type {
  ExpenseTransaction,
  IncomeTransaction,
  LedgerAccount,
  LedgerCategory,
  LedgerSettings,
  LedgerTransaction,
  TransferTransaction,
  AdjustmentTransaction,
} from '../ledger/domain.js'
import {
  createLedgerRepository,
  type LedgerRepository,
} from '../ledger/repository.js'
import { runLedgerWrite } from '../ledger/writeTransaction.js'
import { LedgerError } from '../ledger/errors.js'
import { ledgerAccountAdjustmentOperationScope } from '../ledger/idempotency.js'
import { createLedgerService } from '../ledger/service.js'
import { parseTransactionCreateRequest } from '../ledger/validation.js'
import { SQLITE_BUSY_TIMEOUT_MS } from '../db.js'
import {
  createLedgerTestDatabase,
  type LedgerTestDatabase,
} from './helpers/ledgerDb.js'
import {
  LEDGER_BUILTIN_ACCOUNT_ICON_NAMES,
  LEDGER_DEFAULT_ACCOUNT_ICONS,
} from '../../shared/ledgerProtocol.js'

const databases: LedgerTestDatabase[] = []

function freshDatabase(): LedgerTestDatabase {
  const database = createLedgerTestDatabase()
  databases.push(database)
  return database
}

afterEach(() => {
  for (const database of databases.splice(0)) database.cleanup()
})

function account(
  id: string,
  nature: LedgerAccount['nature'] = 'asset',
  overrides: Partial<LedgerAccount> = {},
): LedgerAccount {
  return {
    id,
    name: `Account ${id}`,
    type: nature === 'asset' ? 'bank' : 'loan',
    nature,
    openingBalanceMinor: 0,
    openingDate: '2026-01-01',
    currency: 'CNY',
    note: '',
    archivedAt: null,
    version: 1,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

function category(
  id: string,
  kind: LedgerCategory['kind'] = 'expense',
  overrides: Partial<LedgerCategory> = {},
): LedgerCategory {
  const name = `Category ${id}`
  return {
    id,
    kind,
    name,
    normalizedName: name.toLowerCase(),
    sortOrder: 1000,
    archivedAt: null,
    version: 1,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

function settings(overrides: Partial<LedgerSettings> = {}): LedgerSettings {
  return {
    baseCurrency: 'CNY',
    timezone: 'Asia/Shanghai',
    hasCreatedAccount: false,
    version: 1,
    createdAt: 1_000,
    updatedAt: 1_000,
    accountIcons: {
      defaultIcon: 'wallet',
      availableIcons: LEDGER_DEFAULT_ACCOUNT_ICONS,
      archivedIcons: [],
      customIcons: {},
      customIconNames: LEDGER_BUILTIN_ACCOUNT_ICON_NAMES,
    },
    ...overrides,
  }
}

function income(
  id: string,
  accountId: string,
  categoryId: string,
  overrides: Partial<IncomeTransaction> = {},
): IncomeTransaction {
  return {
    id,
    type: 'income',
    amountMinor: 100,
    accountId,
    categoryId,
    occurredAt: 2_000,
    location: '',
    payee: '',
    note: '',
    deletedAt: null,
    version: 1,
    createdAt: 2_000,
    updatedAt: 2_000,
    ...overrides,
  }
}

function expense(
  id: string,
  accountId: string,
  categoryId: string,
  overrides: Partial<ExpenseTransaction> = {},
): ExpenseTransaction {
  return {
    id,
    type: 'expense',
    amountMinor: 100,
    accountId,
    categoryId,
    occurredAt: 2_000,
    location: '',
    payee: '',
    note: '',
    deletedAt: null,
    version: 1,
    createdAt: 2_000,
    updatedAt: 2_000,
    ...overrides,
  }
}

function transfer(
  id: string,
  fromAccountId: string,
  toAccountId: string,
  overrides: Partial<TransferTransaction> = {},
): TransferTransaction {
  return {
    id,
    type: 'transfer',
    transferKind: 'general',
    amountMinor: 100,
    fromAccountId,
    toAccountId,
    occurredAt: 2_000,
    location: '',
    payee: '',
    note: '',
    deletedAt: null,
    version: 1,
    createdAt: 2_000,
    updatedAt: 2_000,
    ...overrides,
  }
}

function adjustment(
  id: string,
  accountId: string,
  calculated: number,
  target: number,
  overrides: Partial<AdjustmentTransaction> = {},
): AdjustmentTransaction {
  return {
    id,
    type: 'adjustment',
    amountMinor: target - calculated,
    accountId,
    adjustmentCalculatedBalanceMinor: calculated,
    adjustmentTargetBalanceMinor: target,
    occurredAt: 2_000,
    location: '',
    note: '',
    deletedAt: null,
    version: 1,
    createdAt: 2_000,
    updatedAt: 2_000,
    ...overrides,
  }
}

function expectLedgerErrorCode(callback: () => unknown, code: LedgerError['code']): LedgerError {
  try {
    callback()
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerError)
    expect((error as LedgerError).code).toBe(code)
    return error as LedgerError
  }
  throw new Error(`Expected LedgerError ${code}`)
}

function seedAccountGraph(repository: LedgerRepository): void {
  repository.insertAccount(account('account-a'))
  repository.insertAccount(account('account-b'))
  repository.insertAccount(account('account-c'))
  repository.insertCategory(category('expense-category'))
  repository.insertCategory(category('income-category', 'income'))
}

describe('Ledger repository persistence boundary', () => {
  it('uses prepared persistence primitives and maps rows through the domain boundary', () => {
    const database = freshDatabase()
    const repository = createLedgerRepository(database.db)
    const storedSettings = settings()
    const storedAccount = account('account-a', 'asset', { openingBalanceMinor: 500 })
    const storedCategory = category('expense-category')
    const storedTransaction = expense('expense-1', storedAccount.id, storedCategory.id)

    expect(repository.getSettings()).toBeNull()
    repository.insertSettings(storedSettings)
    repository.insertAccount(storedAccount)
    repository.insertCategory(storedCategory)
    repository.insertTransaction(storedTransaction)

    expect(repository.getSettings()).toEqual(storedSettings)
    expect(repository.getAccount(storedAccount.id)).toEqual(storedAccount)
    expect(repository.getCategory(storedCategory.id)).toEqual(storedCategory)
    expect(repository.getTransaction(storedTransaction.id)).toEqual(storedTransaction)
    expect(repository.listAccounts()).toEqual([storedAccount])
    expect(repository.listCategories()).toEqual([storedCategory])
  })

  it('returns optimistic-update changes without assigning version-conflict meaning', () => {
    const database = freshDatabase()
    const repository = createLedgerRepository(database.db)
    const original = account('account-a')
    repository.insertAccount(original)

    const updated = {
      ...original,
      name: 'Renamed account',
      version: 2,
      updatedAt: 2_000,
    }
    expect(repository.updateAccount({ account: updated, expectedVersion: 1 })).toBe(1)
    expect(repository.getAccount(original.id)).toEqual(updated)
    expect(repository.updateAccount({ account: { ...updated, version: 3 }, expectedVersion: 1 })).toBe(0)
  })

  it('keeps active account listing separate from archived rows', () => {
    const database = freshDatabase()
    const repository = createLedgerRepository(database.db)
    repository.insertAccount(account('active'))
    repository.insertAccount(account('archived', 'asset', { archivedAt: 2_000 }))
    repository.insertCategory(category('active-category'))
    repository.insertCategory(category('archived-category', 'expense', { archivedAt: 2_000 }))

    expect(repository.listAccounts({ includeArchived: false }).map((value) => value.id)).toEqual(['active'])
    expect(repository.listCategories({ includeArchived: false }).map((value) => value.id)).toEqual(['active-category'])
  })
})

describe('Ledger history predicates', () => {
  it('matches Account history through account, from, and to columns', () => {
    const database = freshDatabase()
    const repository = createLedgerRepository(database.db)
    seedAccountGraph(repository)
    repository.insertTransaction(income('income-history', 'account-a', 'income-category'))
    repository.insertTransaction(transfer('outgoing-history', 'account-a', 'account-b'))
    repository.insertTransaction(transfer('incoming-history', 'account-c', 'account-a'))

    expect(repository.hasAccountHistory('account-a')).toBe(true)
    expect(repository.hasAccountHistory('account-b')).toBe(true)
    expect(repository.hasAccountHistory('account-c')).toBe(true)
  })

  it('counts soft-deleted Account and Category references as history', () => {
    const database = freshDatabase()
    const repository = createLedgerRepository(database.db)
    repository.insertAccount(account('deleted-account'))
    repository.insertCategory(category('deleted-category'))
    repository.insertTransaction(expense('deleted-history', 'deleted-account', 'deleted-category', {
      deletedAt: 9_000,
    }))

    expect(repository.hasAccountHistory('deleted-account')).toBe(true)
    expect(repository.hasCategoryHistory('deleted-category')).toBe(true)
    expect(repository.hasAccountHistory('unrelated-account')).toBe(false)
    expect(repository.hasCategoryHistory('unrelated-category')).toBe(false)
  })
})

describe('Ledger active Account transaction retrieval', () => {
  it('matches all Account reference columns, excludes deleted rows, and returns domain transactions', () => {
    const database = freshDatabase()
    const repository = createLedgerRepository(database.db)
    seedAccountGraph(repository)
    const activeIncome = income('active-income', 'account-a', 'income-category', {
      occurredAt: 4_000,
      createdAt: 4_000,
      updatedAt: 4_000,
    })
    const activeExpense = expense('active-expense', 'account-a', 'expense-category', {
      occurredAt: 3_000,
      createdAt: 3_000,
      updatedAt: 3_000,
    })
    const outgoing = transfer('active-outgoing', 'account-a', 'account-b', {
      occurredAt: 2_000,
      createdAt: 2_000,
      updatedAt: 2_000,
    })
    const incoming = transfer('active-incoming', 'account-c', 'account-a', {
      occurredAt: 1_000,
      createdAt: 1_000,
      updatedAt: 1_000,
    })
    const activeAdjustment = adjustment('active-adjustment', 'account-a', 100, 150, {
      occurredAt: 500,
      createdAt: 500,
      updatedAt: 500,
    })
    const deleted = expense('deleted-expense', 'account-a', 'expense-category', {
      deletedAt: 9_000,
      occurredAt: 9_000,
      createdAt: 9_000,
      updatedAt: 9_000,
    })
    const unrelated = expense('unrelated-expense', 'account-b', 'expense-category')

    for (const transaction of [
      activeIncome,
      activeExpense,
      outgoing,
      incoming,
      activeAdjustment,
      deleted,
      unrelated,
    ]) repository.insertTransaction(transaction)

    const rows = repository.listActiveTransactionsForAccount('account-a')
    expect(rows.map((transaction) => transaction.id)).toEqual([
      activeIncome.id,
      activeExpense.id,
      outgoing.id,
      incoming.id,
      activeAdjustment.id,
    ])
    expect(rows).toEqual(expect.arrayContaining([
      activeIncome,
      activeExpense,
      outgoing,
      incoming,
      activeAdjustment,
    ]))
    expect(rows.some((transaction) => transaction.id === deleted.id)).toBe(false)
    expect(rows.some((transaction) => transaction.id === unrelated.id)).toBe(false)
    expect(rows.every((transaction) => !('account_id' in transaction))).toBe(true)
  })
})

describe('Ledger write transaction infrastructure', () => {
  it('uses an explicit production timeout and maps finite two-connection busy exhaustion', () => {
    const database = freshDatabase()
    const connectionB = database.openConnection({ timeout: 25 })
    const repositoryA = createLedgerRepository(database.db)
    const repositoryB = createLedgerRepository(connectionB)
    let callbackRan = false
    let busyError: LedgerError | undefined

    expect(SQLITE_BUSY_TIMEOUT_MS).toBe(5_000)
    runLedgerWrite(database.db, () => {
      repositoryA.insertAccount(account('lock-holder'))

      busyError = expectLedgerErrorCode(() => runLedgerWrite(connectionB, () => {
        callbackRan = true
        repositoryB.insertCategory(category('must-not-commit'))
      }), 'ledger-write-busy')
    })

    expect(busyError?.status).toBe(503)
    expect(callbackRan).toBe(false)
    expect(repositoryA.getAccount('lock-holder')).not.toBeNull()
    expect(repositoryB.getCategory('must-not-commit')).toBeNull()
  })

  it('rolls back all repository writes when the callback throws', () => {
    const database = freshDatabase()
    const repository = createLedgerRepository(database.db)

    expect(() => runLedgerWrite(database.db, () => {
      repository.insertAccount(account('rollback-account'))
      repository.insertCategory(category('rollback-category'))
      repository.insertTransaction(expense('rollback-transaction', 'rollback-account', 'rollback-category'))
      throw new Error('force rollback')
    })).toThrow('force rollback')

    expect(repository.getAccount('rollback-account')).toBeNull()
    expect(repository.getCategory('rollback-category')).toBeNull()
    expect(repository.getTransaction('rollback-transaction')).toBeNull()
  })

  it('reuses an ambient transaction for nested writes and rolls them back together', () => {
    const database = freshDatabase()
    const repository = createLedgerRepository(database.db)

    expect(() => runLedgerWrite(database.db, () => {
      repository.insertAccount(account('outer-account'))
      runLedgerWrite(database.db, () => {
        repository.insertCategory(category('inner-category'))
      })
      throw new Error('force nested rollback')
    })).toThrow('force nested rollback')

    expect(repository.getAccount('outer-account')).toBeNull()
    expect(repository.getCategory('inner-category')).toBeNull()
  })

  it('rejects an escaped async callback before invocation and prevents delayed mutation', async () => {
    const database = freshDatabase()
    const repository = createLedgerRepository(database.db)
    let callbackExecuted = false
    const escapedCallback = (async () => {
      callbackExecuted = true
      repository.insertAccount(account('async-before-await'))
      await Promise.resolve()
      repository.insertCategory(category('async-after-await'))
    }) as unknown as () => unknown

    expect(() => runLedgerWrite(database.db, escapedCallback)).toThrow(TypeError)
    expect(callbackExecuted).toBe(false)

    await Promise.resolve()
    expect(repository.getAccount('async-before-await')).toBeNull()
    expect(repository.getCategory('async-after-await')).toBeNull()
  })

  it('rejects a synchronous thenable callback and rolls back synchronous writes', () => {
    const database = freshDatabase()
    const repository = createLedgerRepository(database.db)
    let callbackExecuted = false
    const escapedCallback = (() => {
      callbackExecuted = true
      repository.insertAccount(account('thenable-account'))
      return Promise.resolve()
    }) as unknown as () => unknown

    expect(() => runLedgerWrite(database.db, escapedCallback)).toThrow(TypeError)
    expect(callbackExecuted).toBe(true)
    expect(repository.getAccount('thenable-account')).toBeNull()
  })

  it('does not misclassify non-busy SQLite errors', () => {
    const database = freshDatabase()
    const repository = createLedgerRepository(database.db)
    repository.insertAccount(account('duplicate-account'))

    let error: unknown
    try {
      runLedgerWrite(database.db, () => repository.insertAccount(account('duplicate-account')))
    } catch (caught) {
      error = caught
    }

    expect(error).not.toBeInstanceOf(LedgerError)
  })

  it('serializes Account archive balance reads against a competing committed write', () => {
    const database = freshDatabase()
    const connectionB = database.openConnection({ timeout: 25 })
    const repositoryA = createLedgerRepository(database.db)
    const repositoryB = createLedgerRepository(connectionB)
    const serviceB = createLedgerService(connectionB, repositoryB)
    const archivedCandidate = account('archive-race-account')
    repositoryA.insertSettings(settings())
    repositoryA.insertAccount(archivedCandidate)
    repositoryA.insertCategory(category('archive-race-category'))

    let busyError: LedgerError | undefined
    runLedgerWrite(database.db, () => {
      repositoryA.insertTransaction(expense(
        'archive-race-expense',
        archivedCandidate.id,
        'archive-race-category',
        { amountMinor: 1 },
      ))
      busyError = expectLedgerErrorCode(
        () => serviceB.archiveAccount(archivedCandidate.id, { expectedVersion: 1 }),
        'ledger-write-busy',
      )
    })

    expect(busyError?.status).toBe(503)
    expect(repositoryB.getAccount(archivedCandidate.id)?.archivedAt).toBeNull()

    expectLedgerErrorCode(
      () => serviceB.archiveAccount(archivedCandidate.id, { expectedVersion: 1 }),
      'ledger-account-nonzero-balance',
    )
    expect(repositoryB.getAccount(archivedCandidate.id)?.archivedAt).toBeNull()
  })

  it('allows only one two-connection Adjustment to accept the same stale balance', () => {
    const database = freshDatabase()
    const connectionB = database.openConnection()
    const repositoryA = createLedgerRepository(database.db)
    const repositoryB = createLedgerRepository(connectionB)
    const accountValue = account('adjustment-race-account')
    repositoryA.insertSettings(settings())
    repositoryA.insertAccount(accountValue)
    const serviceA = createLedgerService(database.db, repositoryA)
    const serviceB = createLedgerService(connectionB, repositoryB)
    const occurredAt = Date.now()

    const first = serviceA.adjustAccount(accountValue.id, {
      targetBalanceMinor: 100,
      expectedCalculatedBalanceMinor: 0,
      occurredAt,
      note: 'first client',
    }, 'adjustment-race-a')
    expect(first.responseStatus).toBe(201)

    expectLedgerErrorCode(
      () => serviceB.adjustAccount(accountValue.id, {
        targetBalanceMinor: 200,
        expectedCalculatedBalanceMinor: 0,
        occurredAt,
        note: 'stale second client',
      }, 'adjustment-race-b'),
      'ledger-balance-conflict',
    )

    expect(repositoryA.listActiveTransactionsForAccount(accountValue.id)).toHaveLength(1)
    expect(serviceB.getAccount(accountValue.id).currentBalanceMinor).toBe(100)
    expect(repositoryB.getIdempotencyRecord(
      ledgerAccountAdjustmentOperationScope(accountValue.id),
      'adjustment-race-b',
    )).toBeNull()
  })

  it('keeps the archived zero-balance invariant when archive wins another connection', () => {
    const database = freshDatabase()
    const connectionB = database.openConnection()
    const repositoryA = createLedgerRepository(database.db)
    const repositoryB = createLedgerRepository(connectionB)
    const accountValue = account('archive-wins-account')
    const categoryValue = category('archive-wins-category')
    repositoryA.insertSettings(settings())
    repositoryA.insertAccount(accountValue)
    repositoryA.insertCategory(categoryValue)
    const serviceA = createLedgerService(database.db, repositoryA)
    const serviceB = createLedgerService(connectionB, repositoryB)

    expect(serviceA.archiveAccount(accountValue.id, { expectedVersion: 1 }).archivedAt)
      .not.toBeNull()
    expectLedgerErrorCode(
      () => serviceB.createTransaction(parseTransactionCreateRequest({
        type: 'expense',
        amountMinor: 1,
        accountId: accountValue.id,
        categoryId: categoryValue.id,
        occurredAt: Date.now(),
      }), 'archive-wins-transaction'),
      'ledger-archived-account',
    )

    expect(serviceB.getAccount(accountValue.id)).toMatchObject({
      archivedAt: expect.any(Number),
      currentBalanceMinor: 0,
    })
    expect(repositoryB.getIdempotencyRecord(
      'POST:/api/ledger/transactions',
      'archive-wins-transaction',
    )).toBeNull()
  })
})
