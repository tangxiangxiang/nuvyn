import { afterEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../db.js'
import type { LedgerAccount } from '../ledger/domain.js'
import type {
  LedgerAccountDto,
  LedgerCategoryDto,
  LedgerTransactionDto,
} from '../../shared/ledgerProtocol.js'
import {
  executeIdempotentLedgerCreate,
  fingerprintLedgerMutation,
  LEDGER_IDEMPOTENCY_OPERATION_SCOPES,
} from '../ledger/idempotency.js'
import { createLedgerRepository } from '../ledger/repository.js'
import { createLedgerProjections } from '../ledger/projections.js'
import { createLedgerService } from '../ledger/service.js'
import {
  createLedgerTestDatabase,
  type LedgerTestDatabase,
} from './helpers/ledgerDb.js'
import {
  parseAccountCreateRequest,
  parseCategoryCreateRequest,
  parseSettingsCreateRequest,
  parseTransactionCreateRequest,
} from '../ledger/validation.js'

const databases: LedgerTestDatabase[] = []

function freshDatabase(): LedgerTestDatabase {
  const database = createLedgerTestDatabase()
  databases.push(database)
  return database
}

afterEach(() => {
  for (const database of databases.splice(0)) database.cleanup()
})

function account(id: string): LedgerAccount {
  return {
    id,
    name: 'Persistent account',
    type: 'bank',
    nature: 'asset',
    openingBalanceMinor: 0,
    openingDate: '2026-01-01',
    currency: 'CNY',
    note: '',
    archivedAt: null,
    version: 1,
    createdAt: 1_000,
    updatedAt: 1_000,
  }
}

describe('Ledger persistent idempotency replay', () => {
  it('reopens the same SQLite file and replays one immutable response snapshot', () => {
    const database = freshDatabase()
    const repositoryA = createLedgerRepository(database.db)
    const storedAccount = account('reopen-account')
    const request = parseAccountCreateRequest({
      name: storedAccount.name,
      type: storedAccount.type,
      nature: storedAccount.nature,
      openingBalanceMinor: storedAccount.openingBalanceMinor,
      openingDate: storedAccount.openingDate,
      currency: storedAccount.currency,
    })
    const operationScope = LEDGER_IDEMPOTENCY_OPERATION_SCOPES.accounts
    const idempotencyKey = 'reopen-key'
    const responseBody: LedgerAccountDto = {
      ...storedAccount,
      currencyExponent: 2,
      currentBalanceMinor: 0,
    }

    const first = executeIdempotentLedgerCreate(database.db, repositoryA, {
      operationScope,
      idempotencyKey,
      request,
      createdAt: 1_234,
      mutation: () => {
        repositoryA.insertAccount(storedAccount)
        return {
          resultStatus: 'committed' as const,
          responseStatus: 201 as const,
          responseBody,
          resultType: 'account',
          resultId: storedAccount.id,
        }
      },
    })
    const firstRecord = repositoryA.getIdempotencyRecord(operationScope, idempotencyKey)
    expect(firstRecord).not.toBeNull()
    expect(firstRecord?.requestFingerprint).toBe(fingerprintLedgerMutation(request))
    expect(firstRecord?.responseBodyJson).toBe(first.responseBodyJson)
    expect(repositoryA.listAccounts()).toHaveLength(1)

    database.close()
    const reopened = database.openConnection()
    applyMigrations(reopened)
    const repositoryB = createLedgerRepository(reopened)
    let callbackCount = 0

    const replay = executeIdempotentLedgerCreate(reopened, repositoryB, {
      operationScope,
      idempotencyKey,
      request,
      mutation: () => {
        callbackCount += 1
        throw new Error('reopen replay must not execute mutation')
      },
    })
    const reopenedRecord = repositoryB.getIdempotencyRecord(operationScope, idempotencyKey)
    const counts = reopened.prepare(`
      SELECT
        (SELECT COUNT(*) FROM ledger_accounts) AS account_count,
        (SELECT COUNT(*) FROM ledger_idempotency) AS idempotency_count
    `).get() as { account_count: number; idempotency_count: number }

    expect(replay.replayed).toBe(true)
    expect(replay.responseStatus).toBe(first.responseStatus)
    expect(replay.responseBodyJson).toBe(first.responseBodyJson)
    expect(reopenedRecord).toEqual(firstRecord)
    expect(callbackCount).toBe(0)
    expect(repositoryB.listAccounts()).toHaveLength(1)
    expect(counts).toEqual({ account_count: 1, idempotency_count: 1 })

    database.close()
  })

  it('reopens real Service and Projections from SQLite without duplicating state', () => {
    const database = freshDatabase()
    const repositoryA = createLedgerRepository(database.db)
    const reopenNow = Date.parse('2026-09-04T03:00:00.000Z')
    let nextId = 0
    const serviceA = createLedgerService(database.db, repositoryA, {
      now: () => reopenNow,
      createId: () => `reopen-service-${++nextId}`,
    })
    const projectionsA = createLedgerProjections(repositoryA, { now: () => reopenNow })

    const settingsRequest = parseSettingsCreateRequest({
      baseCurrency: 'CNY',
      timezone: 'Asia/Shanghai',
    })
    expect(serviceA.createSettings(settingsRequest, 'reopen-service-settings').responseStatus).toBe(201)

    const accountRequest = parseAccountCreateRequest({
      name: 'Reopened account',
      type: 'bank',
      nature: 'asset',
      openingBalanceMinor: 500,
      openingDate: '2026-01-01',
      currency: 'CNY',
    })
    const accountResult = serviceA.createAccount(accountRequest, 'reopen-service-account')
    expect(accountResult.responseStatus).toBe(201)
    const account = JSON.parse(accountResult.responseBodyJson) as LedgerAccountDto

    const categoryRequest = parseCategoryCreateRequest({
      kind: 'expense',
      name: 'Reopen category',
    })
    const categoryResult = serviceA.createCategory(categoryRequest, 'reopen-service-category')
    expect(categoryResult.responseStatus).toBe(201)
    const category = JSON.parse(categoryResult.responseBodyJson) as LedgerCategoryDto

    const transactionRequest = parseTransactionCreateRequest({
      type: 'expense',
      amountMinor: 125,
      accountId: account.id,
      categoryId: category.id,
      occurredAt: reopenNow,
      note: 'reopen transaction',
    })
    const transactionResult = serviceA.createTransaction(
      transactionRequest,
      'reopen-service-transaction',
    )
    expect(transactionResult.responseStatus).toBe(201)
    const transaction = JSON.parse(transactionResult.responseBodyJson) as LedgerTransactionDto

    expect(projectionsA.getOverview({ scope: 'all', anchorDate: undefined })).toMatchObject({
      assetTotalMinor: 375,
      liabilityTotalMinor: 0,
      netWorthMinor: 375,
      cashflow: { incomeMinor: 0, expenseMinor: 125, repaymentMinor: 0, balanceMinor: -125 },
    })

    database.close()
    const reopened = database.openConnection()
    applyMigrations(reopened)
    applyMigrations(reopened)
    const repositoryB = createLedgerRepository(reopened)
    const serviceB = createLedgerService(reopened, repositoryB, {
      now: () => reopenNow,
      createId: () => {
        throw new Error('replay must not generate another Ledger ID')
      },
    })
    const projectionsB = createLedgerProjections(repositoryB, { now: () => reopenNow })

    expect((reopened.prepare('SELECT version FROM schema_version').get() as { version: number }).version)
      .toBe(34)
    expect(serviceB.getSettings()).toMatchObject({
      baseCurrency: 'CNY',
      currencyExponent: 2,
      timezone: 'Asia/Shanghai',
      version: 1,
    })
    expect(serviceB.getAccount(account.id)).toMatchObject({
      id: account.id,
      name: account.name,
      currentBalanceMinor: 375,
    })
    expect(serviceB.listCategories(undefined, false).find((value) => value.id === category.id))
      .toEqual(category)
    expect(serviceB.getTransaction(transaction.id)).toEqual(transaction)
    expect(projectionsB.getOverview({ scope: 'all', anchorDate: undefined })).toMatchObject({
      assetTotalMinor: 375,
      liabilityTotalMinor: 0,
      netWorthMinor: 375,
      cashflow: { incomeMinor: 0, expenseMinor: 125, repaymentMinor: 0, balanceMinor: -125 },
    })

    const replay = serviceB.createTransaction(transactionRequest, 'reopen-service-transaction')
    expect(replay).toEqual({
      responseStatus: transactionResult.responseStatus,
      responseBodyJson: transactionResult.responseBodyJson,
      replayed: true,
    })
    expect(repositoryB.listActiveTransactions()).toHaveLength(1)

    const counts = reopened.prepare(`
      SELECT
        (SELECT COUNT(*) FROM ledger_settings) AS settings_count,
        (SELECT COUNT(*) FROM ledger_accounts) AS account_count,
        (SELECT COUNT(*) FROM ledger_categories) AS category_count,
        (SELECT COUNT(*) FROM ledger_transactions) AS transaction_count,
        (SELECT COUNT(*) FROM ledger_idempotency) AS idempotency_count
    `).get() as {
      settings_count: number
      account_count: number
      category_count: number
      transaction_count: number
      idempotency_count: number
    }
    expect(counts).toEqual({
      settings_count: 1,
      account_count: 1,
      category_count: 24,
      transaction_count: 1,
      idempotency_count: 4,
    })

    database.close()
  })
})
