import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  LedgerAccountDto,
  LedgerCategoryDto,
  LedgerSettingsCreateRequest,
  LedgerTransactionDto,
  LedgerTransactionQuery,
} from '../../shared/ledgerProtocol.js'
import type { LedgerTransaction } from './domain.js'
import { createLedgerRepository, type LedgerRepository } from './repository.js'
import { createLedgerProjections, type LedgerProjections } from './projections.js'
import { createLedgerService, type LedgerService } from './service.js'
import { LedgerError } from './errors.js'
import {
  parseAccountCreateRequest,
  parseCategoryCreateRequest,
  parseSettingsCreateRequest,
  parseTransactionCreateRequest,
  parseTransactionQuery,
} from './validation.js'
import {
  createLedgerTestDatabase,
  type LedgerTestDatabase,
} from '../__tests__/helpers/ledgerDb.js'

const databases: LedgerTestDatabase[] = []
const TEST_NOW = Date.parse('2026-09-02T04:00:00.000Z')

interface ProjectionFixture {
  readonly database: LedgerTestDatabase
  readonly repository: LedgerRepository
  readonly service: LedgerService
  readonly projections: LedgerProjections
  readonly clock: { value: number }
}

function freshFixture(
  timezone = 'Asia/Shanghai',
  now = TEST_NOW,
): ProjectionFixture {
  const database = createLedgerTestDatabase()
  databases.push(database)
  const repository = createLedgerRepository(database.db)
  const clock = { value: now }
  let nextId = 0
  const createId = () => `projection-test-${String(++nextId).padStart(4, '0')}`
  const service = createLedgerService(database.db, repository, {
    createId,
    now: () => clock.value,
  })
  const projections = createLedgerProjections(repository, { now: () => clock.value })
  const settings: LedgerSettingsCreateRequest = parseSettingsCreateRequest({
    baseCurrency: 'CNY',
    timezone,
  })
  service.createSettings(settings, 'projection-settings')
  return { database, repository, service, projections, clock }
}

afterEach(() => {
  for (const database of databases.splice(0)) database.cleanup()
})

function account(
  fixture: ProjectionFixture,
  key: string,
  overrides: Record<string, unknown> = {},
): LedgerAccountDto {
  const result = fixture.service.createAccount(parseAccountCreateRequest({
    name: 'Projection account',
    type: 'bank',
    nature: 'asset',
    openingBalanceMinor: 0,
    openingDate: '2026-01-01',
    currency: 'CNY',
    ...overrides,
  }), key)
  expect(result.responseStatus).toBe(201)
  return JSON.parse(result.responseBodyJson) as LedgerAccountDto
}

function category(
  fixture: ProjectionFixture,
  key: string,
  overrides: Record<string, unknown> = {},
): LedgerCategoryDto {
  const result = fixture.service.createCategory(parseCategoryCreateRequest({
    kind: 'expense',
    name: `Projection category ${key}`,
    ...overrides,
  }), key)
  expect(result.responseStatus).toBe(201)
  return JSON.parse(result.responseBodyJson) as LedgerCategoryDto
}

function transaction(
  fixture: ProjectionFixture,
  key: string,
  value: Record<string, unknown>,
): LedgerTransactionDto {
  const result = fixture.service.createTransaction(parseTransactionCreateRequest({
    occurredAt: TEST_NOW,
    ...value,
  }), key)
  expect(result.responseStatus).toBe(201)
  return JSON.parse(result.responseBodyJson) as LedgerTransactionDto
}

function adjustment(
  fixture: ProjectionFixture,
  key: string,
  accountId: string,
  targetBalanceMinor: number,
  expectedCalculatedBalanceMinor: number,
): LedgerTransactionDto | null {
  const result = fixture.service.adjustAccount(accountId, {
    targetBalanceMinor,
    expectedCalculatedBalanceMinor,
    occurredAt: TEST_NOW,
    note: 'projection adjustment',
  }, key)
  const body = JSON.parse(result.responseBodyJson) as {
    adjustment: LedgerTransactionDto | null
  }
  return body.adjustment
}

function query(overrides: Record<string, unknown> = {}): LedgerTransactionQuery {
  return parseTransactionQuery(overrides)
}

function firstCategory(
  fixture: ProjectionFixture,
  kind: 'income' | 'expense',
): LedgerCategoryDto {
  const found = fixture.repository.listCategories({ includeArchived: true })
    .find((candidate) => candidate.kind === kind)
  if (!found) throw new Error(`missing seeded ${kind} category`)
  return {
    ...found,
    archivedAt: found.archivedAt,
    version: found.version,
    createdAt: found.createdAt,
    updatedAt: found.updatedAt,
  }
}

function expectLedgerCode(callback: () => unknown, code: LedgerError['code']): void {
  try {
    callback()
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerError)
    expect((error as LedgerError).code).toBe(code)
    return
  }
  throw new Error(`Expected LedgerError ${code}`)
}

function insertValidTransaction(
  repository: LedgerRepository,
  transactionValue: LedgerTransaction,
): void {
  repository.insertTransaction(transactionValue)
}

describe('Ledger transaction query projections', () => {
  it('applies active/type/account/category/date filters and includes Adjustment in type=all', () => {
    const fixture = freshFixture()
    const asset = account(fixture, 'account-a')
    const other = account(fixture, 'account-b', { name: 'Other account' })
    const expenseCategory = firstCategory(fixture, 'expense')
    const incomeCategory = firstCategory(fixture, 'income')

    const income = transaction(fixture, 'income', {
      type: 'income', amountMinor: 100, accountId: asset.id, categoryId: incomeCategory.id,
      occurredAt: TEST_NOW - 3_000, payee: 'Salary',
    })
    const expense = transaction(fixture, 'expense', {
      type: 'expense', amountMinor: 25, accountId: asset.id, categoryId: expenseCategory.id,
      occurredAt: TEST_NOW - 2_000, payee: 'Coffee',
    })
    const transfer = transaction(fixture, 'transfer', {
      type: 'transfer', amountMinor: 10, fromAccountId: asset.id, toAccountId: other.id,
      occurredAt: TEST_NOW - 1_000,
    })
    const adjustmentRow = adjustment(fixture, 'adjustment', asset.id, 66, 65)
    expect(adjustmentRow).not.toBeNull()

    const all = fixture.projections.listTransactions(query())
    expect(all.transactions.map((row) => row.id)).toEqual([
      adjustmentRow!.id,
      transfer.id,
      expense.id,
      income.id,
    ])
    expect(all.transactions.map((row) => row.type)).toEqual([
      'adjustment', 'transfer', 'expense', 'income',
    ])
    expect(all.page).toMatchObject({
      total: 4,
      incomeMinor: 100,
      expenseMinor: 25,
    })

    expect(fixture.projections.listTransactions(query({ type: 'income' })).transactions)
      .toEqual([income])
    expect(fixture.projections.listTransactions(query({ type: 'expense' })).transactions)
      .toEqual([expense])
    expect(fixture.projections.listTransactions(query({ type: 'transfer' })).transactions)
      .toEqual([transfer])
    expect(fixture.projections.listTransactions(query({ accountId: other.id }))
      .transactions.map((row) => row.id)).toEqual([transfer.id])
    expect(fixture.projections.listTransactions(query({ categoryId: expenseCategory.id }))
      .transactions.map((row) => row.id)).toEqual([expense.id])
    expect(fixture.projections.listTransactions(query({
      from: String(TEST_NOW - 2_000),
      to: String(TEST_NOW + 1),
    })).transactions.map((row) => row.id)).toEqual([
      adjustmentRow!.id, transfer.id, expense.id,
    ])
  })

  it('uses literal search matching and excludes deleted rows by default', () => {
    const fixture = freshFixture()
    const asset = account(fixture, 'search-account')
    const expenseCategory = firstCategory(fixture, 'expense')
    const percent = transaction(fixture, 'percent', {
      type: 'expense', amountMinor: 1, accountId: asset.id, categoryId: expenseCategory.id,
      payee: '100%', occurredAt: TEST_NOW - 3_000,
    })
    const underscore = transaction(fixture, 'underscore', {
      type: 'expense', amountMinor: 1, accountId: asset.id, categoryId: expenseCategory.id,
      payee: 'a_b', occurredAt: TEST_NOW - 2_000,
    })
    const slash = transaction(fixture, 'slash', {
      type: 'expense', amountMinor: 1, accountId: asset.id, categoryId: expenseCategory.id,
      note: 'c\\d', occurredAt: TEST_NOW - 1_000,
    })

    expect(fixture.projections.listTransactions(query({ search: ' 100% ' })).transactions)
      .toEqual([percent])
    expect(fixture.projections.listTransactions(query({ search: 'a_b' })).transactions)
      .toEqual([underscore])
    expect(fixture.projections.listTransactions(query({ search: 'c\\d' })).transactions)
      .toEqual([slash])
    expect(fixture.projections.listTransactions(query({ search: 'Projection account' })).transactions)
      .toEqual([slash, underscore, percent])
    expect(fixture.projections.listTransactions(query({ search: '   ' })).transactions)
      .toHaveLength(3)

    fixture.service.deleteTransaction(percent.id, { expectedVersion: 1 })
    expect(fixture.projections.listTransactions(query({ search: '100%' })).transactions)
      .toHaveLength(0)
    expect(fixture.projections.listTransactions(query({ search: '100%', includeDeleted: 'true' })).transactions)
      .toHaveLength(1)
  })

  it('searches transfers by source and destination account names', () => {
    const fixture = freshFixture()
    const source = account(fixture, 'transfer-search-source', { name: '微信零钱' })
    const destination = account(fixture, 'transfer-search-destination', { name: '招商银行储蓄卡' })
    const transfer = transaction(fixture, 'transfer-search', {
      type: 'transfer', amountMinor: 100, fromAccountId: source.id, toAccountId: destination.id,
    })

    expect(fixture.projections.listTransactions(query({ search: '微信' })).transactions)
      .toEqual([transfer])
    expect(fixture.projections.listTransactions(query({ search: '招商' })).transactions)
      .toEqual([transfer])
  })

  it('keeps the three-field keyset order continuous across pages', () => {
    const fixture = freshFixture()
    const asset = account(fixture, 'cursor-account')
    const expenseCategory = firstCategory(fixture, 'expense')
    const rows: LedgerTransaction[] = [
      {
        id: 'cursor-a', type: 'expense', amountMinor: 1, accountId: asset.id,
        categoryId: expenseCategory.id, occurredAt: TEST_NOW, payee: '', note: '',
        deletedAt: null, version: 1, createdAt: TEST_NOW, updatedAt: TEST_NOW,
      },
      {
        id: 'cursor-b', type: 'expense', amountMinor: 2, accountId: asset.id,
        categoryId: expenseCategory.id, occurredAt: TEST_NOW, payee: '', note: '',
        deletedAt: null, version: 1, createdAt: TEST_NOW, updatedAt: TEST_NOW,
      },
      {
        id: 'cursor-c', type: 'expense', amountMinor: 3, accountId: asset.id,
        categoryId: expenseCategory.id, occurredAt: TEST_NOW, payee: '', note: '',
        deletedAt: null, version: 1, createdAt: TEST_NOW, updatedAt: TEST_NOW,
      },
    ]
    rows.forEach((row) => insertValidTransaction(fixture.repository, row))

    const full = fixture.projections.listTransactions(query({ limit: '200' }))
    expect(full.transactions.map((row) => row.id)).toEqual(['cursor-c', 'cursor-b', 'cursor-a'])

    const pageIds: string[] = []
    let cursor: string | undefined
    for (;;) {
      const page = fixture.projections.listTransactions(query({
        limit: '1',
        ...(cursor === undefined ? {} : { cursor }),
      }))
      pageIds.push(...page.transactions.map((row) => row.id))
      if (page.page.nextCursor === null) break
      cursor = page.page.nextCursor
    }
    expect(pageIds).toEqual(full.transactions.map((row) => row.id))
    expect(new Set(pageIds).size).toBe(pageIds.length)

    const offsetPage = fixture.projections.listTransactions(query({ limit: '1', offset: '1' }))
    expect(offsetPage.transactions.map((row) => row.id)).toEqual(['cursor-b'])
    expect(offsetPage.page).toMatchObject({ total: 3, incomeMinor: 0, expenseMinor: 6 })

    expectLedgerCode(
      () => fixture.projections.listTransactions(query({ cursor: 'not-a-cursor' })),
      'ledger-validation-failed',
    )
  })
})

describe('Ledger Account Detail projections', () => {
  it('keeps offset and cursor page balances anchored to complete account history', () => {
    const fixture = freshFixture()
    const asset = account(fixture, 'paged-balance', { openingBalanceMinor: 1_000 })
    const expenseCategory = firstCategory(fixture, 'expense')
    const incomeCategory = firstCategory(fixture, 'income')
    const oldest = transaction(fixture, 'paged-income', {
      type: 'income', amountMinor: 200, accountId: asset.id, categoryId: incomeCategory.id,
      occurredAt: TEST_NOW - 3_000,
    })
    const middle = transaction(fixture, 'paged-expense-middle', {
      type: 'expense', amountMinor: 50, accountId: asset.id, categoryId: expenseCategory.id,
      occurredAt: TEST_NOW - 2_000,
    })
    transaction(fixture, 'paged-expense-latest', {
      type: 'expense', amountMinor: 100, accountId: asset.id, categoryId: expenseCategory.id,
      occurredAt: TEST_NOW - 1_000,
    })

    const firstPage = fixture.projections.getAccountTransactions(asset.id, query({ limit: '1' }))
    const cursorPage = fixture.projections.getAccountTransactions(asset.id, query({
      limit: '1', cursor: firstPage.page.nextCursor!,
    }))
    const offsetPage = fixture.projections.getAccountTransactions(asset.id, query({ limit: '1', offset: '1' }))
    const thirdPage = fixture.projections.getAccountTransactions(asset.id, query({ limit: '1', offset: '2' }))

    expect(cursorPage.transactionBalances).toEqual([{ transactionId: middle.id, balanceMinor: 1_150 }])
    expect(offsetPage.transactionBalances).toEqual([{ transactionId: middle.id, balanceMinor: 1_150 }])
    expect(thirdPage.transactionBalances).toEqual([{ transactionId: oldest.id, balanceMinor: 1_200 }])
  })

  it('includes hidden transactions in every filtered row balance', () => {
    const fixture = freshFixture()
    const asset = account(fixture, 'filtered-balance', { openingBalanceMinor: 1_000 })
    const food = category(fixture, 'food', { name: 'Food' })
    const transport = category(fixture, 'transport', { name: 'Transport' })
    const incomeCategory = firstCategory(fixture, 'income')
    const olderExpense = transaction(fixture, 'filtered-older-expense', {
      type: 'expense', amountMinor: 50, accountId: asset.id, categoryId: food.id,
      occurredAt: TEST_NOW - 3_000, payee: 'Apple Store',
    })
    transaction(fixture, 'filtered-hidden-income', {
      type: 'income', amountMinor: 200, accountId: asset.id, categoryId: incomeCategory.id,
      occurredAt: TEST_NOW - 2_000, payee: 'Salary',
    })
    const latestExpense = transaction(fixture, 'filtered-latest-expense', {
      type: 'expense', amountMinor: 20, accountId: asset.id, categoryId: transport.id,
      occurredAt: TEST_NOW - 1_000, payee: 'Apple Store',
    })

    const expected = [
      { transactionId: latestExpense.id, balanceMinor: 1_130 },
      { transactionId: olderExpense.id, balanceMinor: 950 },
    ]
    expect(fixture.projections.getAccountTransactions(asset.id, query({ type: 'expense' })).transactionBalances)
      .toEqual(expected)
    expect(fixture.projections.getAccountTransactions(asset.id, query({ search: 'Apple' })).transactionBalances)
      .toEqual(expected)
    expect(fixture.projections.getAccountTransactions(asset.id, query({ categoryId: food.id })).transactionBalances)
      .toEqual([expected[1]])
    expect(fixture.projections.getAccountTransactions(asset.id, query({
      type: 'expense', from: String(TEST_NOW - 4_000), to: String(TEST_NOW),
    })).transactionBalances).toEqual(expected)
  })

  it('uses createdAt and id tie breakers for every returned balance', () => {
    const fixture = freshFixture()
    const asset = account(fixture, 'tie-balance', { openingBalanceMinor: 1_000 })
    const expenseCategory = firstCategory(fixture, 'expense')
    const incomeCategory = firstCategory(fixture, 'income')
    const rows: LedgerTransaction[] = [
      {
        id: 'tie-a', type: 'income', amountMinor: 100, accountId: asset.id,
        categoryId: incomeCategory.id, occurredAt: TEST_NOW, payee: '', note: '',
        deletedAt: null, version: 1, createdAt: TEST_NOW, updatedAt: TEST_NOW,
      },
      {
        id: 'tie-b', type: 'expense', amountMinor: 20, accountId: asset.id,
        categoryId: expenseCategory.id, occurredAt: TEST_NOW, payee: '', note: '',
        deletedAt: null, version: 1, createdAt: TEST_NOW, updatedAt: TEST_NOW,
      },
      {
        id: 'tie-c', type: 'income', amountMinor: 50, accountId: asset.id,
        categoryId: incomeCategory.id, occurredAt: TEST_NOW, payee: '', note: '',
        deletedAt: null, version: 1, createdAt: TEST_NOW, updatedAt: TEST_NOW,
      },
    ]
    rows.forEach((row) => insertValidTransaction(fixture.repository, row))

    const detail = fixture.projections.getAccountTransactions(asset.id, query())
    expect(detail.transactionBalances).toEqual([
      { transactionId: 'tie-c', balanceMinor: 1_130 },
      { transactionId: 'tie-b', balanceMinor: 1_080 },
      { transactionId: 'tie-a', balanceMinor: 1_100 },
    ])
  })

  it('projects Ledger-local balance trend points and page running balances', () => {
    const now = Date.parse('2024-03-11T12:00:00.000Z')
    const fixture = freshFixture('America/Los_Angeles', now)
    const asset = account(fixture, 'trend-asset', {
      openingBalanceMinor: 1_000,
      openingDate: '2024-01-01',
    })
    const expenseCategory = firstCategory(fixture, 'expense')
    const incomeCategory = firstCategory(fixture, 'income')
    const expense = transaction(fixture, 'trend-expense', {
      type: 'expense', amountMinor: 100, accountId: asset.id, categoryId: expenseCategory.id,
      occurredAt: Date.parse('2024-03-09T16:00:00.000Z'),
    })
    const income = transaction(fixture, 'trend-income', {
      type: 'income', amountMinor: 250, accountId: asset.id, categoryId: incomeCategory.id,
      occurredAt: Date.parse('2024-03-10T19:00:00.000Z'),
    })

    const detail = fixture.projections.getAccountTransactions(asset.id, query({ limit: '1' }))
    expect(detail.transactions.map((row) => row.id)).toEqual([income.id])
    expect(detail.transactionBalances).toEqual([{ transactionId: income.id, balanceMinor: 1_150 }])

    expect(fixture.projections.getAccountBalanceTrend(asset.id, 7)).toEqual({
      range: 7,
      points: [
        { date: '2024-03-05', timestamp: Date.parse('2024-03-06T08:00:00.000Z'), balanceMinor: 1_000 },
        { date: '2024-03-06', timestamp: Date.parse('2024-03-07T08:00:00.000Z'), balanceMinor: 1_000 },
        { date: '2024-03-07', timestamp: Date.parse('2024-03-08T08:00:00.000Z'), balanceMinor: 1_000 },
        { date: '2024-03-08', timestamp: Date.parse('2024-03-09T08:00:00.000Z'), balanceMinor: 1_000 },
        { date: '2024-03-09', timestamp: Date.parse('2024-03-10T08:00:00.000Z'), balanceMinor: 900 },
        { date: '2024-03-10', timestamp: Date.parse('2024-03-11T07:00:00.000Z'), balanceMinor: 1_150 },
        { date: '2024-03-11', timestamp: now, balanceMinor: 1_150 },
      ],
    })
  })

  it('uses Ledger-local day-end balances for historical trend points', () => {
    const now = Date.parse('2026-09-12T12:00:00.000Z')
    const fixture = freshFixture('Asia/Shanghai', now)
    const asset = account(fixture, 'day-end-asset', {
      openingBalanceMinor: 1_000,
      openingDate: '2026-01-01',
    })
    const expenseCategory = firstCategory(fixture, 'expense')
    const incomeCategory = firstCategory(fixture, 'income')

    transaction(fixture, 'day-end-noon', {
      type: 'expense', amountMinor: 100, accountId: asset.id, categoryId: expenseCategory.id,
      occurredAt: Date.parse('2026-09-10T12:00:00.000+08:00'),
    })
    transaction(fixture, 'day-end-last-minute', {
      type: 'expense', amountMinor: 50, accountId: asset.id, categoryId: expenseCategory.id,
      occurredAt: Date.parse('2026-09-10T23:59:00.000+08:00'),
    })
    transaction(fixture, 'day-start-midnight', {
      type: 'income', amountMinor: 25, accountId: asset.id, categoryId: incomeCategory.id,
      occurredAt: Date.parse('2026-09-11T00:00:00.000+08:00'),
    })

    const trend = fixture.projections.getAccountBalanceTrend(asset.id, 7)
    const balances = new Map(trend.points.map((point) => [point.date, point]))
    expect(balances.get('2026-09-09')?.balanceMinor).toBe(1_000)
    expect(balances.get('2026-09-10')?.balanceMinor).toBe(850)
    expect(balances.get('2026-09-11')?.balanceMinor).toBe(875)
    expect(balances.get('2026-09-12')?.balanceMinor).toBe(875)
    expect(balances.get('2026-09-10')?.timestamp).toBe(
      Date.parse('2026-09-11T00:00:00.000+08:00'),
    )
    expect(balances.get('2026-09-11')?.timestamp).toBe(
      Date.parse('2026-09-12T00:00:00.000+08:00'),
    )
    const detail = fixture.projections.getAccountTransactions(asset.id, query({ limit: '5' }))
    expect(balances.get('2026-09-12')?.balanceMinor).toBe(detail.account.currentBalanceMinor)
  })

  it('keeps trend dates and day-end balances correct across Los Angeles DST', () => {
    const now = Date.parse('2026-03-10T18:00:00.000Z')
    const fixture = freshFixture('America/Los_Angeles', now)
    const asset = account(fixture, 'dst-trend-asset', {
      openingBalanceMinor: 1_000,
      openingDate: '2026-01-01',
    })
    const expenseCategory = firstCategory(fixture, 'expense')
    const incomeCategory = firstCategory(fixture, 'income')

    transaction(fixture, 'dst-expense', {
      type: 'expense', amountMinor: 100, accountId: asset.id, categoryId: expenseCategory.id,
      occurredAt: Date.parse('2026-03-08T12:00:00.000-08:00'),
    })
    transaction(fixture, 'dst-income', {
      type: 'income', amountMinor: 50, accountId: asset.id, categoryId: incomeCategory.id,
      occurredAt: Date.parse('2026-03-09T12:00:00.000-07:00'),
    })

    const trend = fixture.projections.getAccountBalanceTrend(asset.id, 7)
    expect(trend.points.map((point) => point.date)).toEqual([
      '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07',
      '2026-03-08', '2026-03-09', '2026-03-10',
    ])
    const balances = new Map(trend.points.map((point) => [point.date, point]))
    expect(balances.get('2026-03-08')?.balanceMinor).toBe(900)
    expect(balances.get('2026-03-09')?.balanceMinor).toBe(950)
    expect(balances.get('2026-03-10')?.balanceMinor).toBe(950)
    expect(balances.get('2026-03-08')?.timestamp).toBe(
      Date.parse('2026-03-09T00:00:00.000-07:00'),
    )
  })

  it('uses bounded account queries instead of replaying full account history', () => {
    const fixture = freshFixture()
    const asset = account(fixture, 'bounded-account')
    const fullHistorySpy = vi.spyOn(fixture.repository, 'listActiveTransactionsForAccount')
    const rangeSpy = vi.spyOn(fixture.repository, 'listActiveTransactionsForAccountInRange')
    const balanceBeforeSpy = vi.spyOn(fixture.repository, 'getAccountBalanceBefore')
    const balancesAtPositionsSpy = vi.spyOn(fixture.repository, 'getAccountBalancesAtPositions')
    const querySpy = vi.spyOn(fixture.repository, 'queryTransactions')
    const summarySpy = vi.spyOn(fixture.repository, 'summarizeTransactions')

    fixture.projections.getAccountTransactions(asset.id, query({ limit: '5' }))
    fixture.projections.getAccountBalanceTrend(asset.id, 30)

    expect(fullHistorySpy).not.toHaveBeenCalled()
    expect(summarySpy).not.toHaveBeenCalled()
    expect(querySpy).toHaveBeenCalledWith(expect.objectContaining({
      accountId: asset.id,
      limit: 5,
    }))
    expect(rangeSpy).toHaveBeenCalledTimes(2)
    expect(balanceBeforeSpy).toHaveBeenCalledTimes(2)
    expect(balancesAtPositionsSpy).toHaveBeenCalledTimes(1)
    expect(rangeSpy.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      from: expect.any(Number),
      to: expect.any(Number),
    }))
  })

  it('reverse-projects recent balances for asset and liability accounts', () => {
    const fixture = freshFixture()
    const asset = account(fixture, 'recent-balance-asset', { openingBalanceMinor: 1_000 })
    const card = account(fixture, 'recent-balance-card', {
      name: 'Recent balance card', type: 'credit_card', nature: 'liability', openingBalanceMinor: 200,
    })
    const destination = account(fixture, 'recent-balance-destination', { name: 'Recent balance destination' })
    const expenseCategory = firstCategory(fixture, 'expense')
    const incomeCategory = firstCategory(fixture, 'income')

    const assetIncome = transaction(fixture, 'recent-balance-asset-income', {
      type: 'income', amountMinor: 100, accountId: asset.id, categoryId: incomeCategory.id,
      occurredAt: TEST_NOW - 5_000,
    })
    const assetExpense = transaction(fixture, 'recent-balance-asset-expense', {
      type: 'expense', amountMinor: 40, accountId: asset.id, categoryId: expenseCategory.id,
      occurredAt: TEST_NOW - 4_000,
    })
    const assetTransfer = transaction(fixture, 'recent-balance-asset-transfer', {
      type: 'transfer', amountMinor: 30, fromAccountId: asset.id, toAccountId: destination.id,
      occurredAt: TEST_NOW - 3_000,
    })
    const assetAdjustment = adjustment(fixture, 'recent-balance-asset-adjustment', asset.id, 1_050, 1_030)
    expect(assetAdjustment).not.toBeNull()

    const cardExpense = transaction(fixture, 'recent-balance-card-expense', {
      type: 'expense', amountMinor: 50, accountId: card.id, categoryId: expenseCategory.id,
      occurredAt: TEST_NOW - 5_000,
    })
    const cardIncome = transaction(fixture, 'recent-balance-card-income', {
      type: 'income', amountMinor: 20, accountId: card.id, categoryId: incomeCategory.id,
      occurredAt: TEST_NOW - 4_000,
    })
    const cardTransfer = transaction(fixture, 'recent-balance-card-transfer', {
      type: 'transfer', amountMinor: 30, fromAccountId: card.id, toAccountId: destination.id,
      occurredAt: TEST_NOW - 3_000,
    })

    const assetDetail = fixture.projections.getAccountTransactions(asset.id, query({ limit: '5' }))
    expect(assetDetail.account.currentBalanceMinor).toBe(1_050)
    expect(new Map(assetDetail.transactionBalances.map((entry) => [entry.transactionId, entry.balanceMinor]))).toEqual(new Map([
      [assetAdjustment!.id, 1_050],
      [assetTransfer.id, 1_030],
      [assetExpense.id, 1_060],
      [assetIncome.id, 1_100],
    ]))

    const cardDetail = fixture.projections.getAccountTransactions(card.id, query({ limit: '5' }))
    expect(cardDetail.account.currentBalanceMinor).toBe(260)
    expect(new Map(cardDetail.transactionBalances.map((entry) => [entry.transactionId, entry.balanceMinor]))).toEqual(new Map([
      [cardTransfer.id, 260],
      [cardIncome.id, 230],
      [cardExpense.id, 250],
    ]))
  })

  it('computes complete current-month movement independently of page limit', () => {
    const fixture = freshFixture()
    const asset = account(fixture, 'movement-asset')
    const other = account(fixture, 'movement-other', { name: 'Movement other' })
    const expenseCategory = firstCategory(fixture, 'expense')
    const incomeCategory = firstCategory(fixture, 'income')

    transaction(fixture, 'movement-income', {
      type: 'income', amountMinor: 100, accountId: asset.id, categoryId: incomeCategory.id,
      occurredAt: TEST_NOW - 5_000,
    })
    transaction(fixture, 'movement-expense', {
      type: 'expense', amountMinor: 20, accountId: asset.id, categoryId: expenseCategory.id,
      occurredAt: TEST_NOW - 4_000,
    })
    transaction(fixture, 'movement-transfer', {
      type: 'transfer', amountMinor: 30, fromAccountId: asset.id, toAccountId: other.id,
      occurredAt: TEST_NOW - 3_000,
    })
    transaction(fixture, 'outside-month', {
      type: 'expense', amountMinor: 999, accountId: asset.id, categoryId: expenseCategory.id,
      occurredAt: Date.parse('2026-08-31T15:59:59.999Z'),
    })
    const deleted = transaction(fixture, 'movement-deleted', {
      type: 'expense', amountMinor: 500, accountId: asset.id, categoryId: expenseCategory.id,
      occurredAt: TEST_NOW - 1_000,
    })
    fixture.service.deleteTransaction(deleted.id, { expectedVersion: 1 })
    adjustment(fixture, 'movement-adjustment', asset.id, -929, -949)

    const detail = fixture.projections.getAccountTransactions(asset.id, query({ limit: '1' }))
    expect(detail.transactions).toHaveLength(1)
    expect(detail.transactions[0]?.type).toBe('adjustment')
    expect(detail.account.currentBalanceMinor).toBe(-929)
    expect(detail.movement).toEqual({ balanceIncreaseMinor: 100, balanceDecreaseMinor: 50 })
  })

  it('uses natural-balance wording-neutral movement fields for liabilities', () => {
    const fixture = freshFixture()
    const card = account(fixture, 'movement-card', {
      name: 'Card', type: 'credit_card', nature: 'liability',
    })
    const otherCard = account(fixture, 'movement-card-other', {
      name: 'Other card', type: 'credit_card', nature: 'liability',
    })
    const expenseCategory = firstCategory(fixture, 'expense')
    const incomeCategory = firstCategory(fixture, 'income')

    transaction(fixture, 'liability-expense', {
      type: 'expense', amountMinor: 20, accountId: card.id, categoryId: expenseCategory.id,
      occurredAt: TEST_NOW - 4_000,
    })
    transaction(fixture, 'liability-income', {
      type: 'income', amountMinor: 10, accountId: card.id, categoryId: incomeCategory.id,
      occurredAt: TEST_NOW - 3_000,
    })
    transaction(fixture, 'liability-outgoing', {
      type: 'transfer', amountMinor: 30, fromAccountId: card.id, toAccountId: otherCard.id,
      occurredAt: TEST_NOW - 2_000,
    })
    transaction(fixture, 'liability-incoming', {
      type: 'transfer', amountMinor: 5, fromAccountId: otherCard.id, toAccountId: card.id,
      occurredAt: TEST_NOW - 1_000,
    })

    expect(fixture.projections.getAccountTransactions(card.id, query()).movement).toEqual({
      balanceIncreaseMinor: 50,
      balanceDecreaseMinor: 15,
    })
  })
})

describe('Ledger Overview and trend projections', () => {
  it('derives current balances, checked totals, net worth, and excludes Transfer from cashflow', () => {
    const fixture = freshFixture()
    const bank = account(fixture, 'overview-bank', { openingBalanceMinor: 1_000 })
    const card = account(fixture, 'overview-card', {
      name: 'Credit card', type: 'credit_card', nature: 'liability', openingBalanceMinor: 200,
    })
    const expenseCategory = firstCategory(fixture, 'expense')
    const incomeCategory = firstCategory(fixture, 'income')
    transaction(fixture, 'overview-income', {
      type: 'income', amountMinor: 100, accountId: bank.id, categoryId: incomeCategory.id,
      occurredAt: TEST_NOW - 5_000,
    })
    transaction(fixture, 'overview-bank-expense', {
      type: 'expense', amountMinor: 40, accountId: bank.id, categoryId: expenseCategory.id,
      occurredAt: TEST_NOW - 4_000,
    })
    transaction(fixture, 'overview-card-expense', {
      type: 'expense', amountMinor: 50, accountId: card.id, categoryId: expenseCategory.id,
      occurredAt: TEST_NOW - 3_000,
    })
    transaction(fixture, 'overview-repayment', {
      type: 'transfer', amountMinor: 30, fromAccountId: bank.id, toAccountId: card.id,
      occurredAt: TEST_NOW - 2_000,
    })

    const overview = fixture.projections.getOverview({ scope: 'all', anchorDate: undefined })
    expect(overview.currency).toBe('CNY')
    expect(overview.currencyExponent).toBe(2)
    expect(overview.assetTotalMinor).toBe(1_030)
    expect(overview.liabilityTotalMinor).toBe(220)
    expect(overview.netWorthMinor).toBe(810)
    expect(overview.cashflow).toEqual({ incomeMinor: 100, expenseMinor: 90, balanceMinor: 10 })
    expect(overview.categoryBreakdown.expense).toEqual(expect.arrayContaining([
      expect.objectContaining({ categoryId: expenseCategory.id, amountMinor: 90 }),
    ]))
    expect(overview.periods.map((period) => period.period)).toEqual(['today', 'week', 'month', 'year'])
    expect(overview.recentTransactions).toHaveLength(4)
  })

  it('keeps scope-independent fields fixed while periodizing only cashflow and categories', () => {
    const fixture = freshFixture()
    const asset = account(fixture, 'scope-account')
    const expenseCategory = firstCategory(fixture, 'expense')
    const incomeCategory = firstCategory(fixture, 'income')
    transaction(fixture, 'scope-current-expense', {
      type: 'expense', amountMinor: 10, accountId: asset.id, categoryId: expenseCategory.id,
      occurredAt: TEST_NOW - 1_000,
    })
    transaction(fixture, 'scope-old-income', {
      type: 'income', amountMinor: 100, accountId: asset.id, categoryId: incomeCategory.id,
      occurredAt: Date.parse('2026-01-15T00:00:00.000Z'),
    })

    const today = fixture.projections.getOverview({ scope: 'today', anchorDate: undefined })
    const month = fixture.projections.getOverview({ scope: 'month', anchorDate: undefined })
    const all = fixture.projections.getOverview({ scope: 'all', anchorDate: undefined })
    for (const candidate of [today, month]) {
      expect(candidate.assetTotalMinor).toBe(all.assetTotalMinor)
      expect(candidate.liabilityTotalMinor).toBe(all.liabilityTotalMinor)
      expect(candidate.netWorthMinor).toBe(all.netWorthMinor)
      expect(candidate.accounts).toEqual(all.accounts)
      expect(candidate.periods).toEqual(all.periods)
      expect(candidate.trend).toEqual(all.trend)
      expect(candidate.recentTransactions).toEqual(all.recentTransactions)
    }
    expect(today.cashflow).toEqual({ incomeMinor: 0, expenseMinor: 10, balanceMinor: -10 })
    expect(month.cashflow).toEqual(today.cashflow)
    expect(all.cashflow).toEqual({ incomeMinor: 100, expenseMinor: 10, balanceMinor: 90 })
  })

  it('anchors complete natural periods while keeping the Current Snapshot on NOW semantics', () => {
    const fixture = freshFixture()
    const asset = account(fixture, 'anchored-account', { openingBalanceMinor: 1_000 })
    const expenseCategory = firstCategory(fixture, 'expense')
    const incomeCategory = firstCategory(fixture, 'income')
    const atShanghaiNoon = (date: string): number => Date.parse(`${date}T12:00:00+08:00`)

    transaction(fixture, 'anchored-aug-start', {
      type: 'expense', amountMinor: 10, accountId: asset.id, categoryId: expenseCategory.id,
      occurredAt: atShanghaiNoon('2026-08-01'),
    })
    transaction(fixture, 'anchored-aug-anchor', {
      type: 'expense', amountMinor: 5, accountId: asset.id, categoryId: expenseCategory.id,
      occurredAt: atShanghaiNoon('2026-08-20'),
    })
    transaction(fixture, 'anchored-aug-after-anchor', {
      type: 'expense', amountMinor: 40, accountId: asset.id, categoryId: expenseCategory.id,
      occurredAt: atShanghaiNoon('2026-08-25'),
    })
    transaction(fixture, 'anchored-september', {
      type: 'expense', amountMinor: 50, accountId: asset.id, categoryId: expenseCategory.id,
      occurredAt: atShanghaiNoon('2026-09-01'),
    })
    transaction(fixture, 'anchored-income', {
      type: 'income', amountMinor: 100, accountId: asset.id, categoryId: incomeCategory.id,
      occurredAt: atShanghaiNoon('2026-08-21'),
    })

    const overview = fixture.projections.getOverview({
      scope: 'month',
      anchorDate: '2026-08-20',
    })
    expect(overview.context).toEqual({
      anchorDate: '2026-08-20',
      todayDate: '2026-09-02',
      isToday: false,
      scope: 'month',
    })
    expect(overview.cashflow).toEqual({ incomeMinor: 100, expenseMinor: 55, balanceMinor: 45 })
    expect(overview.categoryBreakdown.expense).toEqual(expect.arrayContaining([
      expect.objectContaining({ categoryId: expenseCategory.id, amountMinor: 55 }),
    ]))
    expect(overview.periods.find((period) => period.period === 'today')).toMatchObject({
      incomeMinor: 0, expenseMinor: 5, balanceMinor: -5,
    })
    expect(overview.periods.find((period) => period.period === 'week')).toMatchObject({
      incomeMinor: 100, expenseMinor: 5, balanceMinor: 95,
    })
    expect(overview.periods.find((period) => period.period === 'month')).toMatchObject({
      incomeMinor: 100, expenseMinor: 55, balanceMinor: 45,
    })
    expect(overview.periods.find((period) => period.period === 'year')).toMatchObject({
      incomeMinor: 100, expenseMinor: 105, balanceMinor: -5,
    })
    expect(overview.trend.at(-1)).toMatchObject({ month: '2026-08', incomeMinor: 100, expenseMinor: 55 })

    // The September transaction remains part of the current balance even
    // though it is outside the historical August period analysis.
    expect(overview.assetTotalMinor).toBe(995)
    expect(overview.accounts[0]?.currentBalanceMinor).toBe(995)
    expect(overview.recentTransactions.every((row) => row.occurredAt < atShanghaiNoon('2026-08-21'))).toBe(true)

    const all = fixture.projections.getOverview({
      scope: 'all',
      anchorDate: '2026-08-20',
    })
    expect(all.cashflow).toEqual({ incomeMinor: 0, expenseMinor: 15, balanceMinor: -15 })
    expect(all.context.scope).toBe('all')
  })

  it('returns an independent five-row Recent Transactions cutoff with canonical ordering', () => {
    const fixture = freshFixture()
    const asset = account(fixture, 'anchored-recent-account')
    const expenseCategory = firstCategory(fixture, 'expense')
    const atShanghaiNoon = (date: string): number => Date.parse(`${date}T12:00:00+08:00`)

    const ids: string[] = []
    for (let index = 0; index < 6; index += 1) {
      const row = transaction(fixture, `anchored-recent-${index}`, {
        type: 'expense', amountMinor: index + 1, accountId: asset.id, categoryId: expenseCategory.id,
        occurredAt: atShanghaiNoon(`2026-08-${String(14 + index).padStart(2, '0')}`),
      })
      ids.push(row.id)
    }
    const afterAnchor = transaction(fixture, 'anchored-recent-after', {
      type: 'expense', amountMinor: 99, accountId: asset.id, categoryId: expenseCategory.id,
      occurredAt: atShanghaiNoon('2026-08-21'),
    })
    const deleted = fixture.repository.getTransaction(ids[0]!)!
    fixture.service.deleteTransaction(deleted.id, { expectedVersion: deleted.version })

    const overview = fixture.projections.getOverview({
      scope: 'today',
      anchorDate: '2026-08-20',
    })
    expect(overview.recentTransactions).toHaveLength(5)
    expect(overview.recentTransactions.map((row) => row.id)).toEqual(ids.slice(1).reverse())
    expect(overview.recentTransactions.map((row) => row.id)).not.toContain(afterAnchor.id)
    expect(overview.recentTransactions.every((row) => row.deletedAt === null)).toBe(true)
  })

  it('keeps archived Category identity and current name in historical breakdowns', () => {
    const fixture = freshFixture()
    const asset = account(fixture, 'archived-category-account')
    const archivedCategory = category(fixture, 'archived-category')
    transaction(fixture, 'archived-category-expense', {
      type: 'expense', amountMinor: 12, accountId: asset.id, categoryId: archivedCategory.id,
      occurredAt: TEST_NOW - 1_000,
    })
    // Simulate a legacy archived row so projections continue to cover
    // historical data even though the service now rejects archiving a used
    // category.
    fixture.database.db.prepare(`
      UPDATE ledger_categories
      SET archived_at = ?, version = 2, updated_at = ?
      WHERE id = ?
    `).run(TEST_NOW, TEST_NOW, archivedCategory.id)

    const overview = fixture.projections.getOverview({ scope: 'all', anchorDate: undefined })
    expect(overview.categoryBreakdown.expense).toEqual(expect.arrayContaining([
      expect.objectContaining({
        categoryId: archivedCategory.id,
        name: archivedCategory.name,
        amountMinor: 12,
      }),
    ]))
  })

  it('updates live projections after Adjustment and soft delete without adding cashflow', () => {
    const fixture = freshFixture()
    const asset = account(fixture, 'live-account')
    const expenseCategory = firstCategory(fixture, 'expense')
    const expense = transaction(fixture, 'live-expense', {
      type: 'expense', amountMinor: 25, accountId: asset.id, categoryId: expenseCategory.id,
      occurredAt: TEST_NOW - 1_000,
    })
    const before = fixture.projections.getOverview({ scope: 'all', anchorDate: undefined })
    const adjustmentRow = adjustment(fixture, 'live-adjustment', asset.id, 10, -25)
    expect(adjustmentRow).not.toBeNull()
    const adjusted = fixture.projections.getOverview({ scope: 'all', anchorDate: undefined })
    expect(adjusted.accounts[0].currentBalanceMinor).toBe(10)
    expect(adjusted.cashflow).toEqual(before.cashflow)
    expect(adjusted.categoryBreakdown).toEqual(before.categoryBreakdown)
    expect(adjusted.trend).toEqual(before.trend)

    fixture.service.deleteTransaction(expense.id, { expectedVersion: 1 })
    const deleted = fixture.projections.getOverview({ scope: 'all', anchorDate: undefined })
    expect(deleted.accounts[0].currentBalanceMinor).toBe(35)
    expect(deleted.cashflow).toEqual({ incomeMinor: 0, expenseMinor: 0, balanceMinor: 0 })
    expect(deleted.recentTransactions.map((row) => row.id)).toEqual([adjustmentRow!.id])
  })

  it('preserves Transfer net worth and separates credit-card repayment from expense', () => {
    const fixture = freshFixture()
    const bank = account(fixture, 'net-worth-bank', { openingBalanceMinor: 100 })
    const card = account(fixture, 'net-worth-card', {
      name: 'Net worth card', type: 'credit_card', nature: 'liability', openingBalanceMinor: 100,
    })
    const expenseCategory = firstCategory(fixture, 'expense')
    const before = fixture.projections.getOverview({ scope: 'all', anchorDate: undefined })
    transaction(fixture, 'card-expense', {
      type: 'expense', amountMinor: 20, accountId: card.id, categoryId: expenseCategory.id,
      occurredAt: TEST_NOW - 2_000,
    })
    const afterExpense = fixture.projections.getOverview({ scope: 'all', anchorDate: undefined })
    expect(afterExpense.netWorthMinor).toBe(before.netWorthMinor - 20)
    const beforeTransfer = afterExpense.netWorthMinor
    transaction(fixture, 'card-repayment', {
      type: 'transfer', amountMinor: 30, fromAccountId: bank.id, toAccountId: card.id,
      occurredAt: TEST_NOW - 1_000,
    })
    const afterTransfer = fixture.projections.getOverview({ scope: 'all', anchorDate: undefined })
    expect(afterTransfer.netWorthMinor).toBe(beforeTransfer)
    expect(afterTransfer.cashflow).toEqual({ incomeMinor: 0, expenseMinor: 20, balanceMinor: -20 })
  })

  it('projects a grouped transfer as one row while retaining the charge in expense totals', () => {
    const fixture = freshFixture()
    const bank = account(fixture, 'grouped-bank', { openingBalanceMinor: 10_000 })
    const loan = account(fixture, 'grouped-loan', {
      type: 'loan',
      nature: 'liability',
    })
    const feeCategory = fixture.service.listCategories('expense', false).find((item) => item.systemKey === 'interest')!
    const repayment = transaction(fixture, 'grouped-repayment', {
      type: 'transfer',
      transferKind: 'repayment',
      amountMinor: 5_000,
      feeMinor: 300,
      fromAccountId: bank.id,
      toAccountId: loan.id,
    })
    const legacyRepaymentFee = fixture.repository.listTransactionsByGroupId(repayment.groupId!).find((item) => item.type === 'expense')!
    expect(legacyRepaymentFee.payee).toBe(`${loan.name}还款利息`)

    const page = fixture.projections.listTransactions(query())
    expect(page.transactions).toHaveLength(2)
    expect(page.transactions.find((row) => row.id === repayment.id)).toMatchObject({
      id: repayment.id,
      type: 'transfer',
      amountMinor: 5_000,
      groupId: repayment.groupId,
      bundle: { chargeMinor: 300, totalMinor: 5_300 },
    })
    expect(page.page).toMatchObject({ total: 2, incomeMinor: 0, expenseMinor: 300 })

    const grouped = fixture.projections.listTransactions(query({ groupId: repayment.groupId }))
    expect(grouped.transactions.map((row) => row.type).sort()).toEqual(['expense', 'transfer'])
    expect(grouped.page.total).toBe(2)

    const feeRows = fixture.projections.listTransactions(query({ categoryId: feeCategory.id }))
    expect(feeRows.transactions).toHaveLength(1)
    expect(feeRows.transactions[0]).toMatchObject({
      type: 'expense',
      amountMinor: 300,
      categoryId: feeCategory.id,
      groupId: repayment.groupId,
      payee: `${loan.name}还款利息`,
    })
    expect(feeRows.page.total).toBe(1)

    const expenseRows = fixture.projections.listTransactions(query({ type: 'expense' }))
    expect(expenseRows.transactions).toHaveLength(1)
    expect(expenseRows.transactions[0]).toMatchObject({
      type: 'expense',
      amountMinor: 300,
      categoryId: feeCategory.id,
      groupId: repayment.groupId,
    })
    expect(expenseRows.page.total).toBe(1)

    const accountRows = fixture.projections.listTransactions(query({ accountId: bank.id }))
    expect(accountRows.transactions.map((row) => row.id)).toEqual(expect.arrayContaining([repayment.id]))
    expect(accountRows.transactions).toHaveLength(2)
    expect(accountRows.page.total).toBe(2)

    const bankDetail = fixture.projections.getAccountTransactions(bank.id, query({ limit: '5' }))
    expect(bankDetail.account.currentBalanceMinor).toBe(4_700)
    const bankDetailBalances = new Map(
      bankDetail.transactionBalances.map((entry) => [entry.transactionId, entry.balanceMinor]),
    )
    const repaymentFee = bankDetail.transactions.find((row) => row.type === 'expense')
    expect(bankDetailBalances.get(repayment.id)).toBe(5_000)
    expect(repaymentFee === undefined ? undefined : bankDetailBalances.get(repaymentFee.id)).toBe(4_700)

    const withdrawalDestination = account(fixture, 'grouped-wallet', { type: 'wallet' })
    const withdrawal = transaction(fixture, 'grouped-withdrawal', {
      // Keep the withdrawal on the same fixture while giving it a valid asset destination.
      // The grouped query must still expose both accounting rows.
      type: 'transfer',
      transferKind: 'withdrawal',
      amountMinor: 2_000,
      feeMinor: 50,
      fromAccountId: bank.id,
      toAccountId: withdrawalDestination.id,
    })
    const legacyWithdrawalFee = fixture.repository.listTransactionsByGroupId(withdrawal.groupId!).find((item) => item.type === 'expense')!
    expect(legacyWithdrawalFee.payee).toBe(`${bank.name}提现手续费`)
    const withdrawalGroup = fixture.projections.listTransactions(query({ groupId: withdrawal.groupId }))
    expect(withdrawalGroup.transactions.map((row) => row.type).sort()).toEqual(['expense', 'transfer'])
    expect(withdrawalGroup.page.total).toBe(2)
    const withdrawalFeeCategory = fixture.service.listCategories('expense', false).find((item) => item.systemKey === 'fee')!
    const withdrawalFeeRows = fixture.projections.listTransactions(query({ categoryId: withdrawalFeeCategory.id }))
    expect(withdrawalFeeRows.transactions).toHaveLength(1)
    expect(withdrawalFeeRows.transactions[0]).toMatchObject({
      type: 'expense',
      amountMinor: 50,
      categoryId: withdrawalFeeCategory.id,
      groupId: withdrawal.groupId,
      payee: `${bank.name}提现手续费`,
    })
    expect(withdrawalFeeRows.page.total).toBe(1)
    expect(fixture.projections.listTransactions(query({ search: '提现手续费' })).transactions.map((row) => row.id))
      .toEqual([legacyWithdrawalFee.id])
  })

  it('returns fixed recent five active records and calendar-month trend points', () => {
    const fixture = freshFixture()
    const asset = account(fixture, 'recent-account')
    const expenseCategory = firstCategory(fixture, 'expense')
    for (let index = 0; index < 6; index += 1) {
      transaction(fixture, `recent-${index}`, {
        type: 'expense', amountMinor: index + 1, accountId: asset.id, categoryId: expenseCategory.id,
        occurredAt: TEST_NOW - (index + 1) * 1_000,
      })
      fixture.clock.value += 1
    }
    const newest = fixture.repository.listActiveTransactions()[0]
    fixture.service.deleteTransaction(newest.id, { expectedVersion: 1 })
    adjustment(fixture, 'recent-adjustment', asset.id, -22, -20)

    const overview = fixture.projections.getOverview({ scope: 'all', anchorDate: undefined })
    expect(overview.recentTransactions).toHaveLength(5)
    expect(overview.recentTransactions.every((row) => row.deletedAt === null)).toBe(true)
    expect(overview.recentTransactions.some((row) => row.type === 'adjustment')).toBe(true)
    expect(overview.trend.map((point) => point.month)).toEqual([
      '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03',
      '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09',
    ])
    expect(fixture.projections.getTrend(3).map((point) => point.month)).toEqual([
      '2026-07', '2026-08', '2026-09',
    ])
  })

  it('rejects an unsafe aggregate even when every persisted amount is safe', () => {
    const fixture = freshFixture()
    const first = account(fixture, 'overflow-first')
    const second = account(fixture, 'overflow-second', { name: 'Overflow second' })
    const incomeCategory = firstCategory(fixture, 'income')
    const amountMinor = 5_000_000_000_000_000
    const base = {
      type: 'income' as const,
      categoryId: incomeCategory.id,
      occurredAt: TEST_NOW - 1_000,
      payee: '',
      note: '',
      deletedAt: null,
      version: 1,
      createdAt: TEST_NOW,
      updatedAt: TEST_NOW,
    }
    insertValidTransaction(fixture.repository, {
      ...base,
      id: 'overflow-first-transaction',
      amountMinor,
      accountId: first.id,
    })
    insertValidTransaction(fixture.repository, {
      ...base,
      id: 'overflow-second-transaction',
      amountMinor,
      accountId: second.id,
    })

    expectLedgerCode(
      () => fixture.projections.getOverview({ scope: 'all', anchorDate: undefined }),
      'ledger-money-overflow',
    )
  })

  it('rejects uninitialized reads and malformed trend counts', () => {
    const database = createLedgerTestDatabase()
    databases.push(database)
    const repository = createLedgerRepository(database.db)
    const projections = createLedgerProjections(repository, { now: () => TEST_NOW })
    expectLedgerCode(() => projections.getOverview({ scope: 'all', anchorDate: undefined }), 'ledger-not-found')
    expectLedgerCode(() => projections.getTrend(0), 'ledger-not-found')

    const fixture = freshFixture()
    expectLedgerCode(() => parseTransactionQuery({ from: String(TEST_NOW), to: String(TEST_NOW) }), 'ledger-validation-failed')
    expectLedgerCode(() => fixture.projections.getTrend(0), 'ledger-validation-failed')
  })
})
