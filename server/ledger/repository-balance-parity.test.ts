import { afterEach, describe, expect, it } from 'vitest'
import type {
  AdjustmentTransaction,
  ExpenseTransaction,
  IncomeTransaction,
  LedgerAccount,
  LedgerCategory,
  LedgerTransaction,
  TransferTransaction,
} from './domain.js'
import { transactionEffectForAccount, deriveCurrentBalance } from './balance.js'
import { createLedgerRepository, type LedgerRepository } from './repository.js'
import { checkedAddMinor } from './money.js'
import {
  createLedgerTestDatabase,
  type LedgerTestDatabase,
} from '../__tests__/helpers/ledgerDb.js'

const databases: LedgerTestDatabase[] = []

interface Fixture {
  readonly database: LedgerTestDatabase
  readonly repository: LedgerRepository
  readonly incomeCategory: LedgerCategory
  readonly expenseCategory: LedgerCategory
}

function freshFixture(): Fixture {
  const database = createLedgerTestDatabase()
  databases.push(database)
  const repository = createLedgerRepository(database.db)
  const incomeCategory = category('income', 'parity-income-category')
  const expenseCategory = category('expense', 'parity-expense-category')
  repository.insertCategory(incomeCategory)
  repository.insertCategory(expenseCategory)
  return { database, repository, incomeCategory, expenseCategory }
}

afterEach(() => {
  for (const database of databases.splice(0)) database.cleanup()
})

function category(kind: LedgerCategory['kind'], id: string): LedgerCategory {
  return {
    id,
    kind,
    name: id,
    normalizedName: id,
    icon: 'wallet',
    isDefault: false,
    sortOrder: 100,
    archivedAt: null,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  }
}

function account(
  id: string,
  nature: LedgerAccount['nature'],
  openingBalanceMinor = 0,
): LedgerAccount {
  return {
    id,
    name: id,
    type: nature === 'asset' ? 'bank' : 'loan',
    nature,
    openingBalanceMinor,
    openingDate: '2026-01-01',
    currency: 'CNY',
    note: '',
    archivedAt: null,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  }
}

function addAccounts(fixture: Fixture, ...accountsToAdd: LedgerAccount[]): void {
  for (const accountToAdd of accountsToAdd) fixture.repository.insertAccount(accountToAdd)
}

function commonTransaction(
  id: string,
  occurredAt: number,
  createdAt = occurredAt,
  deletedAt: number | null = null,
): Pick<LedgerTransaction, 'id' | 'occurredAt' | 'createdAt' | 'updatedAt' | 'location' | 'note' | 'deletedAt' | 'version'> {
  return {
    id,
    occurredAt,
    createdAt,
    updatedAt: createdAt,
    location: '',
    note: '',
    deletedAt,
    version: 1,
  }
}

function income(
  fixture: Fixture,
  id: string,
  accountId: string,
  amountMinor: number,
  occurredAt: number,
  createdAt = occurredAt,
  deletedAt: number | null = null,
): IncomeTransaction {
  return {
    ...commonTransaction(id, occurredAt, createdAt, deletedAt),
    type: 'income',
    amountMinor,
    accountId,
    categoryId: fixture.incomeCategory.id,
    payee: '',
  }
}

function expense(
  fixture: Fixture,
  id: string,
  accountId: string,
  amountMinor: number,
  occurredAt: number,
  createdAt = occurredAt,
  deletedAt: number | null = null,
  groupId?: string,
): ExpenseTransaction {
  return {
    ...commonTransaction(id, occurredAt, createdAt, deletedAt),
    ...(groupId === undefined ? {} : { groupId }),
    type: 'expense',
    amountMinor,
    accountId,
    categoryId: fixture.expenseCategory.id,
    payee: '',
  }
}

function transfer(
  id: string,
  fromAccountId: string,
  toAccountId: string,
  amountMinor: number,
  occurredAt: number,
  createdAt = occurredAt,
  transferKind: TransferTransaction['transferKind'] = 'general',
  groupId?: string,
  feeMode?: TransferTransaction['feeMode'],
  deletedAt: number | null = null,
): TransferTransaction {
  return {
    ...commonTransaction(id, occurredAt, createdAt, deletedAt),
    ...(groupId === undefined ? {} : { groupId }),
    ...(feeMode === undefined ? {} : { feeMode }),
    type: 'transfer',
    transferKind,
    amountMinor,
    fromAccountId,
    toAccountId,
    payee: '',
  }
}

function adjustment(
  id: string,
  accountId: string,
  calculated: number,
  target: number,
  occurredAt: number,
  createdAt = occurredAt,
  deletedAt: number | null = null,
): AdjustmentTransaction {
  return {
    ...commonTransaction(id, occurredAt, createdAt, deletedAt),
    type: 'adjustment',
    amountMinor: target - calculated,
    accountId,
    adjustmentCalculatedBalanceMinor: calculated,
    adjustmentTargetBalanceMinor: target,
  }
}

function insertAll(repository: LedgerRepository, transactions: readonly LedgerTransaction[]): void {
  for (const transaction of transactions) repository.insertTransaction(transaction)
}

interface Position {
  readonly occurredAt: number
  readonly createdAt: number
  readonly id: string
}

function position(transaction: LedgerTransaction): Position {
  return {
    occurredAt: transaction.occurredAt,
    createdAt: transaction.createdAt,
    id: transaction.id,
  }
}

function comparePositions(left: Position, right: Position): number {
  if (left.occurredAt !== right.occurredAt) return left.occurredAt - right.occurredAt
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

function tsBalanceAtPosition(
  accountToCheck: LedgerAccount,
  transactions: readonly LedgerTransaction[],
  target: Position,
): number {
  const ordered = [...transactions].sort((left, right) => comparePositions(position(left), position(right)))
  return ordered
    .filter((transaction) => transaction.deletedAt === null)
    .filter((transaction) => comparePositions(position(transaction), target) <= 0)
    .reduce(
      (balance, transaction) => checkedAddMinor(
        balance,
        transactionEffectForAccount(transaction, accountToCheck),
      ),
      accountToCheck.openingBalanceMinor,
    )
}

function tsBalanceBefore(
  accountToCheck: LedgerAccount,
  transactions: readonly LedgerTransaction[],
  before: number,
): number {
  return transactions
    .filter((transaction) => transaction.deletedAt === null && transaction.occurredAt < before)
    .reduce(
      (balance, transaction) => checkedAddMinor(
        balance,
        transactionEffectForAccount(transaction, accountToCheck),
      ),
      accountToCheck.openingBalanceMinor,
    )
}

function expectPositionParity(
  fixture: Fixture,
  accountToCheck: LedgerAccount,
  transactions: readonly LedgerTransaction[],
  target: LedgerTransaction,
): void {
  const targetPosition = position(target)
  const tsBalance = tsBalanceAtPosition(accountToCheck, transactions, targetPosition)
  const sqlBalance = fixture.repository.getAccountBalanceAtPosition(accountToCheck, targetPosition)
  expect(sqlBalance).toBe(tsBalance)
}

describe('Ledger repository natural-balance parity', () => {
  it('matches domain effects for asset income and expense', () => {
    const fixture = freshFixture()
    const asset = account('asset', 'asset', 1_000)
    addAccounts(fixture, asset)
    const transactions = [
      income(fixture, 'income', asset.id, 200, 1_000),
      expense(fixture, 'expense', asset.id, 50, 2_000),
    ]
    insertAll(fixture.repository, transactions)

    for (const transaction of transactions) expectPositionParity(fixture, asset, transactions, transaction)
    expect(deriveCurrentBalance(asset, transactions)).toBe(1_150)
    expect(fixture.repository.getAccountBalanceAtPosition(asset, position(transactions[1]!))).toBe(1_150)
  })

  it('matches domain effects for liability income and expense', () => {
    const fixture = freshFixture()
    const liability = account('liability', 'liability', 1_000)
    addAccounts(fixture, liability)
    const transactions = [
      income(fixture, 'income', liability.id, 200, 1_000),
      expense(fixture, 'expense', liability.id, 200, 2_000),
    ]
    insertAll(fixture.repository, transactions)

    for (const transaction of transactions) expectPositionParity(fixture, liability, transactions, transaction)
    expect(deriveCurrentBalance(liability, transactions)).toBe(1_000)
  })

  it.each([
    ['asset → asset', 'asset', 'asset', -100, 100],
    ['asset → liability', 'asset', 'liability', -100, -100],
    ['liability → asset', 'liability', 'asset', 100, 100],
    ['liability → liability', 'liability', 'liability', 100, -100],
  ] as const)('matches the %s general transfer nature combination', (
    _label,
    fromNature,
    toNature,
    expectedFromEffect,
    expectedToEffect,
  ) => {
    const fixture = freshFixture()
    const from = account('from', fromNature, 1_000)
    const to = account('to', toNature, 5_000)
    const unrelated = account('unrelated', 'asset', 300)
    addAccounts(fixture, from, to, unrelated)
    const transaction = transfer('transfer', from.id, to.id, 100, 1_000)
    insertAll(fixture.repository, [transaction])

    expect(transactionEffectForAccount(transaction, from)).toBe(expectedFromEffect)
    expect(transactionEffectForAccount(transaction, to)).toBe(expectedToEffect)
    expectPositionParity(fixture, from, [transaction], transaction)
    expectPositionParity(fixture, to, [transaction], transaction)
    expectPositionParity(fixture, unrelated, [transaction], transaction)
  })

  it('matches repayment principal and interest companion effects', () => {
    const fixture = freshFixture()
    const source = account('source', 'asset', 1_000)
    const destination = account('destination', 'liability', 5_000)
    addAccounts(fixture, source, destination)
    const principal = transfer(
      'repayment-principal', source.id, destination.id, 100, 1_000,
      1_000, 'repayment', 'repayment-group',
    )
    const interest = expense(
      fixture, 'repayment-interest', source.id, 2, 1_000, 1_001,
      null, 'repayment-group',
    )
    const transactions = [principal, interest]
    insertAll(fixture.repository, transactions)

    expectPositionParity(fixture, source, transactions, principal)
    expectPositionParity(fixture, source, transactions, interest)
    expectPositionParity(fixture, destination, transactions, principal)
    expectPositionParity(fixture, destination, transactions, interest)
    expect(tsBalanceAtPosition(source, transactions, position(interest))).toBe(898)
    expect(tsBalanceAtPosition(destination, transactions, position(interest))).toBe(4_900)
  })

  it('matches withdrawal extra persisted rows', () => {
    const fixture = freshFixture()
    const source = account('source', 'asset', 1_000)
    const destination = account('destination', 'asset', 500)
    addAccounts(fixture, source, destination)
    const withdrawal = transfer(
      'withdrawal-transfer', source.id, destination.id, 100, 1_000,
      1_000, 'withdrawal', 'withdrawal-extra-group', 'extra',
    )
    const fee = expense(
      fixture, 'withdrawal-fee', source.id, 2, 1_000, 1_001,
      null, 'withdrawal-extra-group',
    )
    const transactions = [withdrawal, fee]
    insertAll(fixture.repository, transactions)

    expectPositionParity(fixture, source, transactions, fee)
    expectPositionParity(fixture, destination, transactions, withdrawal)
    expect(tsBalanceAtPosition(source, transactions, position(fee))).toBe(898)
    expect(tsBalanceAtPosition(destination, transactions, position(withdrawal))).toBe(600)
  })

  it('matches withdrawal deducted persisted rows', () => {
    const fixture = freshFixture()
    const source = account('source', 'asset', 1_000)
    const destination = account('destination', 'asset', 500)
    addAccounts(fixture, source, destination)
    const withdrawal = transfer(
      'withdrawal-transfer', source.id, destination.id, 98, 1_000,
      1_000, 'withdrawal', 'withdrawal-deducted-group', 'deducted',
    )
    const fee = expense(
      fixture, 'withdrawal-fee', source.id, 2, 1_000, 1_001,
      null, 'withdrawal-deducted-group',
    )
    const transactions = [withdrawal, fee]
    insertAll(fixture.repository, transactions)

    expectPositionParity(fixture, source, transactions, fee)
    expectPositionParity(fixture, destination, transactions, withdrawal)
    expect(tsBalanceAtPosition(source, transactions, position(fee))).toBe(900)
    expect(tsBalanceAtPosition(destination, transactions, position(withdrawal))).toBe(598)
  })

  it('matches positive and negative adjustments for both account natures', () => {
    const fixture = freshFixture()
    const asset = account('asset', 'asset', 1_000)
    const liability = account('liability', 'liability', 5_000)
    addAccounts(fixture, asset, liability)
    const transactions = [
      adjustment('asset-positive', asset.id, 1_000, 1_200, 1_000),
      adjustment('asset-negative', asset.id, 1_200, 1_100, 2_000),
      adjustment('liability-positive', liability.id, 5_000, 5_200, 3_000),
      adjustment('liability-negative', liability.id, 5_200, 5_100, 4_000),
    ]
    insertAll(fixture.repository, transactions)

    for (const transaction of transactions) {
      const targetAccount = transaction.accountId === asset.id ? asset : liability
      expectPositionParity(fixture, targetAccount, transactions, transaction)
    }
    expect(tsBalanceAtPosition(asset, transactions, position(transactions[1]!))).toBe(1_100)
    expect(tsBalanceAtPosition(liability, transactions, position(transactions[3]!))).toBe(5_100)
  })

  it('excludes soft-deleted rows on both sides', () => {
    const fixture = freshFixture()
    const asset = account('asset', 'asset', 1_000)
    const other = account('other', 'asset', 0)
    addAccounts(fixture, asset, other)
    const transactions = [
      income(fixture, 'active-income', asset.id, 100, 1_000),
      income(fixture, 'deleted-income', asset.id, 500, 2_000, 2_000, 9_999),
      transfer('active-transfer', asset.id, other.id, 50, 3_000),
      transfer('deleted-transfer', asset.id, other.id, 400, 4_000, 4_000, 'general', undefined, undefined, 9_999),
      expense(fixture, 'active-expense', asset.id, 25, 5_000),
    ]
    insertAll(fixture.repository, transactions)

    expect(transactionEffectForAccount(transactions[1]!, asset)).toBe(0)
    expect(transactionEffectForAccount(transactions[3]!, asset)).toBe(0)
    for (const transaction of transactions) expectPositionParity(fixture, asset, transactions, transaction)
    expect(tsBalanceAtPosition(asset, transactions, position(transactions[4]!))).toBe(1_025)
  })

  it('matches running balances at every position in a mixed transaction sequence', () => {
    const fixture = freshFixture()
    const source = account('source', 'asset', 1_000)
    const destination = account('destination', 'asset', 200)
    const external = account('external', 'asset', 0)
    addAccounts(fixture, source, destination, external)
    const transactions = [
      income(fixture, 'mixed-income', source.id, 500, 1_000),
      expense(fixture, 'mixed-expense', source.id, 100, 2_000),
      transfer('mixed-out', source.id, external.id, 200, 3_000),
      transfer('mixed-in', external.id, source.id, 50, 4_000),
      transfer('mixed-withdrawal', source.id, destination.id, 98, 5_000, 5_000, 'withdrawal', 'mixed-withdrawal-group', 'deducted'),
      expense(fixture, 'mixed-fee', source.id, 2, 5_000, 5_001, null, 'mixed-withdrawal-group'),
      adjustment('mixed-adjustment', source.id, 1_150, 1_180, 6_000),
    ]
    insertAll(fixture.repository, transactions)

    for (const transaction of transactions) expectPositionParity(fixture, source, transactions, transaction)
    expect(tsBalanceAtPosition(source, transactions, position(transactions[6]!))).toBe(1_180)
  })

  it('matches occurredAt, createdAt, and id tie ordering', () => {
    const fixture = freshFixture()
    const asset = account('asset', 'asset', 1_000)
    addAccounts(fixture, asset)
    const transactions = [
      income(fixture, 'tie-a', asset.id, 10, 1_000, 2_000),
      expense(fixture, 'tie-b', asset.id, 3, 1_000, 2_000),
      income(fixture, 'tie-c', asset.id, 7, 1_000, 2_001),
    ]
    insertAll(fixture.repository, transactions)

    for (const transaction of transactions) expectPositionParity(fixture, asset, transactions, transaction)
    expect(tsBalanceAtPosition(asset, transactions, position(transactions[0]!))).toBe(1_010)
    expect(tsBalanceAtPosition(asset, transactions, position(transactions[1]!))).toBe(1_007)
    expect(tsBalanceAtPosition(asset, transactions, position(transactions[2]!))).toBe(1_014)
  })

  it('matches exclusive balance-before boundaries', () => {
    const fixture = freshFixture()
    const asset = account('asset', 'asset', 1_000)
    addAccounts(fixture, asset)
    const transactions = [
      income(fixture, 'before-999', asset.id, 100, 999),
      income(fixture, 'at-1000', asset.id, 200, 1_000),
    ]
    insertAll(fixture.repository, transactions)

    const tsBalance = tsBalanceBefore(asset, transactions, 1_000)
    const sqlBalance = fixture.repository.getAccountBalanceBefore(asset, 1_000)
    expect(sqlBalance).toBe(tsBalance)
    expect(sqlBalance).toBe(1_100)
  })

  it('matches batched balances for multiple positions', () => {
    const fixture = freshFixture()
    const asset = account('asset', 'asset', 1_000)
    addAccounts(fixture, asset)
    const transactions = [
      income(fixture, 'batch-1', asset.id, 100, 1_000),
      expense(fixture, 'batch-2', asset.id, 25, 2_000),
      income(fixture, 'batch-3', asset.id, 200, 3_000),
      expense(fixture, 'batch-4', asset.id, 50, 4_000),
      income(fixture, 'batch-5', asset.id, 75, 5_000),
    ]
    insertAll(fixture.repository, transactions)

    const selected = [transactions[0]!, transactions[2]!, transactions[4]!]
    const balances = fixture.repository.getAccountBalancesAtPositions(
      asset,
      selected.map(position),
    )
    expect(balances.size).toBe(selected.length)
    for (const transaction of selected) {
      expect(balances.get(transaction.id)).toBe(
        tsBalanceAtPosition(asset, transactions, position(transaction)),
      )
    }
  })
})
