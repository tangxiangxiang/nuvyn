import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import app from '../index.js'
import { __setDbForTesting, applyMigrations } from '../db.js'
import {
  closeAuthTestContext,
  createAuthenticatedTestContext,
  type AuthenticatedTestContext,
} from './helpers/auth.js'
import { calendarMonthRanges } from '../ledger/time.js'
import { DEFAULT_LEDGER_CATEGORIES_V2 } from '../ledger/defaultCategories.js'

const db = new Database(':memory:')
let auth: AuthenticatedTestContext

beforeAll(() => {
  applyMigrations(db)
  auth = createAuthenticatedTestContext({ db })
})

afterAll(() => {
  closeAuthTestContext(auth)
  db.close()
})

beforeEach(() => {
  db.exec(`
    DELETE FROM ledger_idempotency;
    DELETE FROM ledger_transactions;
    DELETE FROM ledger_categories;
    DELETE FROM ledger_accounts;
    DELETE FROM ledger_settings;
  `)
  __setDbForTesting(db)
})

async function request(
  path: string,
  options: {
    method?: string
    body?: unknown
    cookie?: string
    contentType?: string
    idempotencyKey?: string
  } = {},
): Promise<Response> {
  const headers = new Headers()
  if (options.cookie !== undefined) headers.set('Cookie', options.cookie)
  if (options.idempotencyKey !== undefined) headers.set('Idempotency-Key', options.idempotencyKey)
  const body = options.body === undefined ? undefined : JSON.stringify(options.body)
  if (body !== undefined) {
    headers.set('Content-Length', String(Buffer.byteLength(body)))
    if (options.contentType !== '') headers.set('Content-Type', options.contentType ?? 'application/json')
  }
  return app.fetch(new Request(`http://localhost${path}`, {
    method: options.method ?? 'GET',
    headers,
    body,
  }))
}

async function authenticated(
  path: string,
  options: Omit<Parameters<typeof request>[1], 'cookie'> = {},
): Promise<Response> {
  return request(path, { ...options, cookie: auth.cookie })
}

async function json(response: Response): Promise<any> {
  return response.json()
}

async function initialize(): Promise<any> {
  const response = await authenticated('/api/ledger/settings', {
    method: 'POST',
    body: { baseCurrency: 'CNY', timezone: 'Asia/Shanghai' },
    idempotencyKey: 'settings-init',
  })
  expect(response.status).toBe(201)
  return json(response)
}

function accountBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Cash account',
    type: 'bank',
    nature: 'asset',
    openingBalanceMinor: 0,
    openingDate: '2026-01-01',
    currency: 'CNY',
    ...overrides,
  }
}

function categoryBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: 'expense', name: 'Custom category', ...overrides }
}

describe('Ledger API owner boundary and Settings', () => {
  it('rejects anonymous Ledger reads before domain work', async () => {
    const response = await request('/api/ledger/settings')
    expect(response.status).toBe(401)
    expect(await json(response)).toMatchObject({ code: 'auth-session-required' })
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('fails closed before explicit Settings initialization', async () => {
    const settings = await authenticated('/api/ledger/settings')
    const accounts = await authenticated('/api/ledger/accounts')
    const categories = await authenticated('/api/ledger/categories')
    expect(settings.status).toBe(404)
    expect(accounts.status).toBe(404)
    expect(categories.status).toBe(404)
    expect(await json(settings)).toMatchObject({ code: 'ledger-not-found' })
    expect(await json(accounts)).toMatchObject({ code: 'ledger-not-found' })
    expect(await json(categories)).toMatchObject({ code: 'ledger-not-found' })
  })

  it('initializes Settings with the default category catalog and replays the original snapshot', async () => {
    const first = await authenticated('/api/ledger/settings', {
      method: 'POST',
      body: { baseCurrency: 'CNY', timezone: 'Asia/Shanghai' },
      idempotencyKey: 'settings-replay',
    })
    const firstText = await first.text()
    expect(first.status).toBe(201)
    expect(first.headers.get('cache-control')).toBe('no-store')
    expect(first.headers.get('content-type')).toMatch(/application\/json/)
    expect(JSON.parse(firstText)).toMatchObject({ hasCreatedAccount: false })

    const categories = await authenticated('/api/ledger/categories')
    expect(categories.status).toBe(200)
    expect(await json(categories)).toHaveLength(DEFAULT_LEDGER_CATEGORIES_V2.length)

    const replay = await authenticated('/api/ledger/settings', {
      method: 'POST',
      body: { baseCurrency: 'CNY', timezone: 'Asia/Shanghai' },
      idempotencyKey: 'settings-replay',
    })
    expect(replay.status).toBe(201)
    expect(await replay.text()).toBe(firstText)
  })

  it('uses Idempotency-Key replay and centralizes malformed JSON errors', async () => {
    const headers = new Headers({
      Cookie: auth.cookie,
      'Content-Type': 'application/json',
      'Content-Length': '9',
      'Idempotency-Key': 'settings-key',
    })
    const first = await app.fetch(new Request('http://localhost/api/ledger/settings', {
      method: 'POST',
      headers,
      body: JSON.stringify({ baseCurrency: 'CNY', timezone: 'Asia/Shanghai' }),
    }))
    expect(first.status).toBe(201)
    const firstText = await first.text()

    const replay = await authenticated('/api/ledger/settings', {
      method: 'POST',
      body: { baseCurrency: 'CNY', timezone: 'Asia/Shanghai' },
      idempotencyKey: 'settings-key',
    })
    expect(replay.status).toBe(201)
    expect(await replay.text()).toBe(firstText)

    const malformed = await app.fetch(new Request('http://localhost/api/ledger/settings', {
      method: 'POST',
      headers: new Headers({
        Cookie: auth.cookie,
        'Content-Type': 'application/json',
        'Content-Length': '8',
        'Idempotency-Key': 'malformed',
      }),
      body: '{broken',
    }))
    expect(malformed.status).toBe(400)
    const malformedBody = await json(malformed)
    expect(malformedBody).toEqual(expect.objectContaining({
      code: 'ledger-validation-failed',
    }))
    expect(malformedBody).not.toHaveProperty('stack')
    expect(JSON.stringify(malformedBody)).not.toMatch(/SQL|database|\.sqlite/i)
  })

  it('maps an unexpected Ledger failure to an opaque no-store response', async () => {
    await initialize()
    const accountResponse = await authenticated('/api/ledger/accounts', {
      method: 'POST',
      body: accountBody(),
      idempotencyKey: 'internal-error-account',
    })
    const account = await json(accountResponse)
    const categoryResponse = await authenticated('/api/ledger/categories', {
      method: 'POST',
      body: { kind: 'expense', name: 'Internal error sentinel' },
      idempotencyKey: 'internal-error-category',
    })
    const category = await json(categoryResponse)
    const transactionResponse = await authenticated('/api/ledger/transactions', {
      method: 'POST',
      body: {
        type: 'expense',
        amountMinor: 1,
        accountId: account.id,
        categoryId: category.id,
        occurredAt: Date.now() - 1_000,
      },
      idempotencyKey: 'internal-error-transaction',
    })
    expect(transactionResponse.status).toBe(201)

    // Corrupt only the test DB's semantic Category relation. The read-side
    // invariant must fail closed without exposing persistence internals.
    db.prepare('UPDATE ledger_categories SET kind = ? WHERE id = ?').run('income', category.id)
    const response = await authenticated('/api/ledger/overview?scope=all')

    expect(response.status).toBe(500)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await json(response)
    expect(body).toEqual({ error: 'Ledger operation failed.', code: 'ledger-internal-error' })
    expect(JSON.stringify(body)).not.toMatch(/stack|SQL|database|\.sqlite|Idempotency-Key|Internal error sentinel/i)
  })

  it('patches Settings before the first Account and locks both fields afterwards', async () => {
    await initialize()
    const patched = await authenticated('/api/ledger/settings', {
      method: 'PATCH',
      body: { expectedVersion: 1, timezone: 'UTC', baseCurrency: 'USD' },
    })
    expect(patched.status).toBe(200)
    expect(await json(patched)).toMatchObject({ timezone: 'UTC', baseCurrency: 'USD', version: 2 })

    const account = await authenticated('/api/ledger/accounts', {
      method: 'POST',
      body: accountBody({ currency: 'USD' }),
      idempotencyKey: 'account-freeze',
    })
    expect(account.status).toBe(201)
    expect((await json(await authenticated('/api/ledger/settings'))).hasCreatedAccount).toBe(true)

    const timezone = await authenticated('/api/ledger/settings', {
      method: 'PATCH',
      body: { expectedVersion: 1, timezone: 'Asia/Shanghai' },
    })
    const currency = await authenticated('/api/ledger/settings', {
      method: 'PATCH',
      body: { expectedVersion: 1, baseCurrency: 'CNY' },
    })
    expect(timezone.status).toBe(409)
    expect(currency.status).toBe(409)
    expect(await json(timezone)).toMatchObject({ code: 'ledger-timezone-locked' })
    expect(await json(currency)).toMatchObject({ code: 'ledger-base-currency-locked' })
  })
})

describe('Ledger Account API', () => {
  it('creates Accounts with currentBalanceMinor, allows duplicate names, and hides archived rows by default', async () => {
    await initialize()
    const first = await authenticated('/api/ledger/accounts', {
      method: 'POST',
      body: accountBody({ openingBalanceMinor: 100, name: 'Same name' }),
      idempotencyKey: 'account-one',
    })
    expect(first.status).toBe(201)
    const firstBody = await json(first)
    expect(firstBody).toMatchObject({ currentBalanceMinor: 100, name: 'Same name', version: 1 })

    const second = await authenticated('/api/ledger/accounts', {
      method: 'POST',
      body: accountBody({ name: 'Same name' }),
      idempotencyKey: 'account-two',
    })
    expect(second.status).toBe(201)
    const secondBody = await json(second)
    expect(secondBody.id).not.toBe(firstBody.id)

    const list = await authenticated('/api/ledger/accounts')
    expect(await json(list)).toHaveLength(2)

    const nonzeroArchive = await authenticated(`/api/ledger/accounts/${firstBody.id}/archive`, {
      method: 'POST',
      body: { expectedVersion: 1 },
    })
    expect(nonzeroArchive.status).toBe(409)
    expect(await json(nonzeroArchive)).toMatchObject({ code: 'ledger-account-nonzero-balance' })

    const archive = await authenticated(`/api/ledger/accounts/${secondBody.id}/archive`, {
      method: 'POST',
      body: { expectedVersion: 1 },
    })
    expect(archive.status).toBe(200)
    const archived = await json(archive)
    expect(archived.currentBalanceMinor).toBe(0)

    expect(await json(await authenticated('/api/ledger/accounts'))).toHaveLength(1)
    expect(await json(await authenticated('/api/ledger/accounts?includeArchived=true'))).toHaveLength(2)

    const archivedPatch = await authenticated(`/api/ledger/accounts/${secondBody.id}`, {
      method: 'PATCH',
      body: { expectedVersion: archived.version, openingBalanceMinor: 1 },
    })
    expect(archivedPatch.status).toBe(409)
    expect(await json(archivedPatch)).toMatchObject({ code: 'ledger-archived-account' })

    const renamed = await authenticated(`/api/ledger/accounts/${secondBody.id}`, {
      method: 'PATCH',
      body: { expectedVersion: archived.version, name: 'Restorable account' },
    })
    expect(renamed.status).toBe(200)
    const renamedBody = await json(renamed)
    const restored = await authenticated(`/api/ledger/accounts/${secondBody.id}/restore`, {
      method: 'POST',
      body: { expectedVersion: renamedBody.version },
    })
    expect(restored.status).toBe(200)
    const restoredBody = await json(restored)
    expect(restoredBody).toMatchObject({ archivedAt: null, version: renamedBody.version + 1 })

    const noOpRestore = await authenticated(`/api/ledger/accounts/${secondBody.id}/restore`, {
      method: 'POST',
      body: { expectedVersion: restoredBody.version },
    })
    expect(noOpRestore.status).toBe(200)
    expect((await json(noOpRestore)).version).toBe(restoredBody.version)
  })

  it('returns canonical conflicts and physically deletes only no-history Accounts', async () => {
    await initialize()
    const account = await authenticated('/api/ledger/accounts', {
      method: 'POST',
      body: accountBody(),
      idempotencyKey: 'account-delete',
    })
    const accountBodyResponse = await json(account)
    const stale = await authenticated(`/api/ledger/accounts/${accountBodyResponse.id}/archive`, {
      method: 'POST',
      body: { expectedVersion: 99 },
    })
    expect(stale.status).toBe(409)
    expect(await json(stale)).toMatchObject({ code: 'ledger-version-conflict' })

    const deleted = await authenticated(`/api/ledger/accounts/${accountBodyResponse.id}`, {
      method: 'DELETE',
      body: { expectedVersion: 1 },
    })
    expect(deleted.status).toBe(200)
    expect(await json(deleted)).toEqual({ deleted: true, id: accountBodyResponse.id })

    const missing = await authenticated(`/api/ledger/accounts/${accountBodyResponse.id}`)
    expect(missing.status).toBe(404)
    expect(await json(missing)).toMatchObject({ code: 'ledger-not-found' })
    expect((db.prepare('SELECT has_created_account FROM ledger_settings').get() as { has_created_account: number }).has_created_account)
      .toBe(1)
  })
})

describe('Ledger Category API', () => {
  it('enforces normalized identity, archive/restore, kind filter, and physical delete history', async () => {
    await initialize()
    const created = await authenticated('/api/ledger/categories', {
      method: 'POST',
      body: categoryBody({ name: '  Foo  ' }),
      idempotencyKey: 'category-foo',
    })
    expect(created.status).toBe(201)
    const category = await json(created)
    expect(category.normalizedName).toBe('foo')

    const duplicate = await authenticated('/api/ledger/categories', {
      method: 'POST',
      body: categoryBody({ name: 'FOO' }),
      idempotencyKey: 'category-duplicate',
    })
    expect(duplicate.status).toBe(409)
    expect(await json(duplicate)).toMatchObject({ code: 'ledger-duplicate-category' })

    const income = await authenticated('/api/ledger/categories', {
      method: 'POST',
      body: categoryBody({ kind: 'income', name: 'FOO' }),
      idempotencyKey: 'category-income',
    })
    expect(income.status).toBe(201)
    expect((await json(income)).kind).toBe('income')

    const archived = await authenticated(`/api/ledger/categories/${category.id}/archive`, {
      method: 'POST',
      body: { expectedVersion: 1 },
    })
    expect(archived.status).toBe(200)
    const archivedBody = await json(archived)

    const archivedDuplicate = await authenticated('/api/ledger/categories', {
      method: 'POST',
      body: categoryBody({ name: 'foo' }),
      idempotencyKey: 'category-archived-duplicate',
    })
    expect(archivedDuplicate.status).toBe(409)

    const archivedPatch = await authenticated(`/api/ledger/categories/${category.id}`, {
      method: 'PATCH',
      body: { expectedVersion: archivedBody.version, name: 'changed' },
    })
    expect(archivedPatch.status).toBe(409)
    expect(await json(archivedPatch)).toMatchObject({ code: 'ledger-archived-category' })

    const restored = await authenticated(`/api/ledger/categories/${category.id}/restore`, {
      method: 'POST',
      body: { expectedVersion: archivedBody.version },
    })
    expect(restored.status).toBe(200)
    expect((await json(restored)).version).toBe(3)

    const expenses = await authenticated('/api/ledger/categories?kind=expense')
    const incomes = await authenticated('/api/ledger/categories?kind=income')
    expect((await json(expenses)).every((item: any) => item.kind === 'expense')).toBe(true)
    expect((await json(incomes)).every((item: any) => item.kind === 'income')).toBe(true)

    const deleted = await authenticated(`/api/ledger/categories/${category.id}`, {
      method: 'DELETE',
      body: { expectedVersion: 3 },
    })
    expect(deleted.status).toBe(200)
  })

  it('creates an Adjustment through the dedicated Account endpoint', async () => {
    await initialize()
    const account = await authenticated('/api/ledger/accounts', {
      method: 'POST',
      body: accountBody(),
      idempotencyKey: 'account-adjust-boundary',
    })
    const accountValue = await json(account)
    const response = await authenticated(`/api/ledger/accounts/${accountValue.id}/adjust`, {
      method: 'POST',
      body: {
        targetBalanceMinor: 1,
        expectedCalculatedBalanceMinor: 0,
        occurredAt: Date.now(),
      },
      idempotencyKey: 'account-adjust-boundary',
    })
    expect(response.status).toBe(201)
    expect(await json(response)).toMatchObject({
      noOp: false,
      adjustment: {
        type: 'adjustment',
        amountMinor: 1,
        accountId: accountValue.id,
      },
      account: { currentBalanceMinor: 1 },
    })
  })
})

describe('Ledger Transaction and Adjustment API', () => {
  it('creates, replays, reads, patches, and terminally deletes a Transaction', async () => {
    await initialize()
    const accountResponse = await authenticated('/api/ledger/accounts', {
      method: 'POST',
      body: accountBody({ name: 'Transaction account' }),
      idempotencyKey: 'transaction-account',
    })
    const account = await json(accountResponse)
    const categories = await authenticated('/api/ledger/categories?kind=expense')
    const expenseCategory = (await json(categories))[0]
    const requestBody = {
      type: 'expense',
      amountMinor: 250,
      accountId: account.id,
      categoryId: expenseCategory.id,
      occurredAt: Date.now(),
      location: '上海市静安区',
      payee: 'Market',
      note: 'Initial purchase',
    }

    const first = await authenticated('/api/ledger/transactions', {
      method: 'POST',
      body: requestBody,
      idempotencyKey: 'transaction-replay',
    })
    const firstText = await first.text()
    expect(first.status).toBe(201)
    expect(first.headers.get('cache-control')).toBe('no-store')

    const replay = await authenticated('/api/ledger/transactions', {
      method: 'POST',
      body: requestBody,
      idempotencyKey: 'transaction-replay',
    })
    expect(replay.status).toBe(201)
    expect(await replay.text()).toBe(firstText)

    const created = JSON.parse(firstText)
    expect(created.location).toBe('上海市静安区')
    const point = await authenticated(`/api/ledger/transactions/${created.id}`)
    expect(point.status).toBe(200)
    expect(await json(point)).toEqual(created)

    const patched = await authenticated(`/api/ledger/transactions/${created.id}`, {
      method: 'PATCH',
      body: { expectedVersion: 1, amountMinor: 300, location: '上海市徐汇区', note: 'Updated purchase' },
    })
    expect(patched.status).toBe(200)
    expect(await json(patched)).toMatchObject({ amountMinor: 300, location: '上海市徐汇区', note: 'Updated purchase', version: 2 })

    const typeChange = await authenticated(`/api/ledger/transactions/${created.id}`, {
      method: 'PATCH',
      body: { expectedVersion: 2, type: 'income' },
    })
    expect(typeChange.status).toBe(409)
    expect(await json(typeChange)).toMatchObject({ code: 'ledger-transaction-type-immutable' })

    const deleted = await authenticated(`/api/ledger/transactions/${created.id}`, {
      method: 'DELETE',
      body: { expectedVersion: 2 },
    })
    const deletedText = await deleted.text()
    expect(deleted.status).toBe(200)
    expect(JSON.parse(deletedText)).toMatchObject({ id: created.id, version: 3 })
    expect(JSON.parse(deletedText).deletedAt).not.toBeNull()

    const deletedPatch = await authenticated(`/api/ledger/transactions/${created.id}`, {
      method: 'PATCH',
      body: { expectedVersion: 3, note: 'must not change' },
    })
    expect(deletedPatch.status).toBe(409)
    expect(await json(deletedPatch)).toMatchObject({ code: 'ledger-transaction-deleted' })

    const repeatedDelete = await authenticated(`/api/ledger/transactions/${created.id}`, {
      method: 'DELETE',
      body: { expectedVersion: 1 },
    })
    expect(repeatedDelete.status).toBe(200)
    expect(await repeatedDelete.text()).toBe(deletedText)

    const listBoundary = await authenticated('/api/ledger/transactions')
    expect(listBoundary.status).toBe(200)
    expect(await json(listBoundary)).toMatchObject({
      transactions: [],
      page: { nextCursor: null },
    })
  })

  it('uses one-row Transfer effects and exposes Adjustment no-op/conflict responses', async () => {
    await initialize()
    const assetResponse = await authenticated('/api/ledger/accounts', {
      method: 'POST',
      body: accountBody({ name: 'Bank', openingBalanceMinor: 100 }),
      idempotencyKey: 'transfer-asset',
    })
    const liabilityResponse = await authenticated('/api/ledger/accounts', {
      method: 'POST',
      body: accountBody({
        name: 'Card',
        type: 'credit_card',
        nature: 'liability',
      }),
      idempotencyKey: 'transfer-liability',
    })
    const asset = await json(assetResponse)
    const liability = await json(liabilityResponse)

    const transfer = await authenticated('/api/ledger/transactions', {
      method: 'POST',
      body: {
        type: 'transfer',
        amountMinor: 50,
        fromAccountId: asset.id,
        toAccountId: liability.id,
        occurredAt: Date.now(),
        note: 'Repayment',
      },
      idempotencyKey: 'transfer-api',
    })
    expect(transfer.status).toBe(201)
    expect(await json(transfer)).toMatchObject({
      type: 'transfer',
      fromAccountId: asset.id,
      toAccountId: liability.id,
    })

    expect(await json(await authenticated(`/api/ledger/accounts/${asset.id}`)))
      .toMatchObject({ currentBalanceMinor: 50 })
    expect(await json(await authenticated(`/api/ledger/accounts/${liability.id}`)))
      .toMatchObject({ currentBalanceMinor: -50 })

    const noOpOccurredAt = Date.now()
    const noOpRequest = {
      targetBalanceMinor: 50,
      expectedCalculatedBalanceMinor: 50,
      occurredAt: noOpOccurredAt,
      note: 'already reconciled',
    }
    const noOp = await authenticated(`/api/ledger/accounts/${asset.id}/adjust`, {
      method: 'POST',
      body: noOpRequest,
      idempotencyKey: 'adjustment-api-no-op',
    })
    const noOpText = await noOp.text()
    expect(noOp.status).toBe(200)
    expect(JSON.parse(noOpText)).toMatchObject({ adjustment: null, noOp: true })

    const applied = await authenticated(`/api/ledger/accounts/${liability.id}/adjust`, {
      method: 'POST',
      body: {
        targetBalanceMinor: -40,
        expectedCalculatedBalanceMinor: -50,
        occurredAt: Date.now(),
        note: 'card reconciliation',
      },
      idempotencyKey: 'adjustment-api-applied',
    })
    expect(applied.status).toBe(201)
    expect(await json(applied)).toMatchObject({
      noOp: false,
      adjustment: { type: 'adjustment', amountMinor: 10, accountId: liability.id },
      account: { currentBalanceMinor: -40 },
    })

    const stale = await authenticated(`/api/ledger/accounts/${liability.id}/adjust`, {
      method: 'POST',
      body: {
        targetBalanceMinor: -30,
        expectedCalculatedBalanceMinor: -50,
        occurredAt: Date.now(),
        note: 'stale attempt',
      },
      idempotencyKey: 'adjustment-api-stale',
    })
    expect(stale.status).toBe(409)
    expect(await json(stale)).toMatchObject({ code: 'ledger-balance-conflict' })

    const noOpReplay = await authenticated(`/api/ledger/accounts/${asset.id}/adjust`, {
      method: 'POST',
      body: noOpRequest,
      idempotencyKey: 'adjustment-api-no-op',
    })
    expect(noOpReplay.status).toBe(200)
    expect(await noOpReplay.text()).toBe(noOpText)
  })

  it('rejects generic Adjustment requests and preserves canonical cross-row errors', async () => {
    await initialize()
    const accountResponse = await authenticated('/api/ledger/accounts', {
      method: 'POST',
      body: accountBody(),
      idempotencyKey: 'transaction-validation-account',
    })
    const account = await json(accountResponse)
    const expenseCategories = await authenticated('/api/ledger/categories?kind=expense')
    const incomeCategories = await authenticated('/api/ledger/categories?kind=income')
    const expenseCategory = (await json(expenseCategories))[0]
    const incomeCategory = (await json(incomeCategories))[0]

    const genericAdjustment = await authenticated('/api/ledger/transactions', {
      method: 'POST',
      body: {
        type: 'adjustment',
        accountId: account.id,
        targetBalanceMinor: 1,
        expectedCalculatedBalanceMinor: 0,
        occurredAt: Date.now(),
      },
      idempotencyKey: 'generic-adjustment-api',
    })
    expect(genericAdjustment.status).toBe(400)
    expect(await json(genericAdjustment)).toMatchObject({ code: 'ledger-validation-failed' })

    const wrongKind = await authenticated('/api/ledger/transactions', {
      method: 'POST',
      body: {
        type: 'expense',
        amountMinor: 1,
        accountId: account.id,
        categoryId: incomeCategory.id,
        occurredAt: Date.now(),
      },
      idempotencyKey: 'wrong-category-kind-api',
    })
    expect(wrongKind.status).toBe(409)
    expect(await json(wrongKind)).toMatchObject({ code: 'ledger-category-kind-mismatch' })

    const missingTransactionKey = await authenticated('/api/ledger/transactions', {
      method: 'POST',
      body: {
        type: 'expense',
        amountMinor: 1,
        accountId: account.id,
        categoryId: expenseCategory.id,
        occurredAt: Date.now(),
      },
    })
    expect(missingTransactionKey.status).toBe(400)
    expect(await json(missingTransactionKey)).toMatchObject({ code: 'ledger-validation-failed' })

    const missingAdjustmentKey = await authenticated(`/api/ledger/accounts/${account.id}/adjust`, {
      method: 'POST',
      body: {
        targetBalanceMinor: 0,
        expectedCalculatedBalanceMinor: 0,
        occurredAt: Date.now(),
      },
    })
    expect(missingAdjustmentKey.status).toBe(400)
    expect(await json(missingAdjustmentKey)).toMatchObject({ code: 'ledger-validation-failed' })

    const valid = await authenticated('/api/ledger/transactions', {
      method: 'POST',
      body: {
        type: 'expense',
        amountMinor: 1,
        accountId: account.id,
        categoryId: expenseCategory.id,
        occurredAt: Date.now(),
      },
      idempotencyKey: 'valid-after-error-api',
    })
    expect(valid.status).toBe(201)
  })
})

describe('Ledger query and projection API', () => {
  it('serves filtered paged transaction lists and Account Detail projections', async () => {
    await initialize()
    const bankResponse = await authenticated('/api/ledger/accounts', {
      method: 'POST',
      body: accountBody({ name: 'Projection bank', openingBalanceMinor: 100 }),
      idempotencyKey: 'projection-bank',
    })
    const cardResponse = await authenticated('/api/ledger/accounts', {
      method: 'POST',
      body: accountBody({ name: 'Projection card', type: 'credit_card', nature: 'liability' }),
      idempotencyKey: 'projection-card',
    })
    const bank = await json(bankResponse)
    const card = await json(cardResponse)
    const categories = await json(await authenticated('/api/ledger/categories?includeArchived=true'))
    const expenseCategory = categories.find((candidate: any) => candidate.kind === 'expense')
    const incomeCategory = categories.find((candidate: any) => candidate.kind === 'income')
    const current = Date.now() - 1_000
    const old = Date.parse('2026-01-15T03:00:00.000Z')

    const expense = await json(await authenticated('/api/ledger/transactions', {
      method: 'POST',
      body: {
        type: 'expense', amountMinor: 10, accountId: bank.id, categoryId: expenseCategory.id,
        occurredAt: current, payee: '100%', note: 'literal _ note',
      },
      idempotencyKey: 'projection-expense',
    }))
    const transfer = await json(await authenticated('/api/ledger/transactions', {
      method: 'POST',
      body: {
        type: 'transfer', amountMinor: 20, fromAccountId: bank.id, toAccountId: card.id,
        occurredAt: current + 1, note: 'repayment',
      },
      idempotencyKey: 'projection-transfer',
    }))
    const income = await json(await authenticated('/api/ledger/transactions', {
      method: 'POST',
      body: {
        type: 'income', amountMinor: 100, accountId: bank.id, categoryId: incomeCategory.id,
        occurredAt: old, payee: 'Old income',
      },
      idempotencyKey: 'projection-income',
    }))
    const adjustment = await json(await authenticated(`/api/ledger/accounts/${card.id}/adjust`, {
      method: 'POST',
      body: {
        targetBalanceMinor: -15,
        expectedCalculatedBalanceMinor: -20,
        occurredAt: current + 2,
        note: 'reconcile',
      },
      idempotencyKey: 'projection-adjustment',
    }))

    const firstPage = await authenticated('/api/ledger/transactions?limit=2')
    expect(firstPage.status).toBe(200)
    expect(firstPage.headers.get('cache-control')).toBe('no-store')
    const firstBody = await json(firstPage)
    expect(firstBody.transactions).toHaveLength(2)
    expect(firstBody.page).toMatchObject({
      nextCursor: expect.any(String),
      total: 4,
      incomeMinor: 100,
      expenseMinor: 10,
    })
    const secondPage = await authenticated(
      `/api/ledger/transactions?limit=2&cursor=${encodeURIComponent(firstBody.page.nextCursor)}`,
    )
    const secondBody = await json(secondPage)
    expect(secondPage.status).toBe(200)
    expect(new Set([
      ...firstBody.transactions.map((row: any) => row.id),
      ...secondBody.transactions.map((row: any) => row.id),
    ]).size).toBe(4)
    const offsetBody = await json(await authenticated('/api/ledger/transactions?limit=2&offset=2'))
    expect(offsetBody.transactions.map((row: any) => row.id))
      .toEqual(secondBody.transactions.map((row: any) => row.id))
    expect(offsetBody.page.total).toBe(4)

    const accountPage = await authenticated(`/api/ledger/accounts/${card.id}/transactions?limit=1`)
    expect(accountPage.status).toBe(200)
    expect(await json(accountPage)).toMatchObject({
      account: { id: card.id, currentBalanceMinor: -15 },
      movement: { balanceIncreaseMinor: 0, balanceDecreaseMinor: 20 },
      transactions: [expect.objectContaining({ id: adjustment.adjustment.id })],
      transactionBalances: [{ transactionId: adjustment.adjustment.id, balanceMinor: -15 }],
      page: { nextCursor: expect.any(String) },
    })

    const accountTrend = await authenticated(`/api/ledger/accounts/${bank.id}/balance-trend?range=7`)
    expect(accountTrend.status).toBe(200)
    const accountTrendBody = await json(accountTrend)
    expect(accountTrendBody).toMatchObject({
      range: 7,
      points: expect.arrayContaining([
        expect.objectContaining({ date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }),
      ]),
    })
    expect(accountTrendBody.points).toHaveLength(7)

    const invalidAccountTrend = await authenticated(`/api/ledger/accounts/${bank.id}/balance-trend?range=8`)
    expect(invalidAccountTrend.status).toBe(400)
    expect(await json(invalidAccountTrend)).toMatchObject({ code: 'ledger-validation-failed' })

    const accountFilter = await authenticated(`/api/ledger/transactions?accountId=${encodeURIComponent(card.id)}`)
    expect((await json(accountFilter)).transactions.map((row: any) => row.id)).toEqual([
      adjustment.adjustment.id,
      transfer.id,
    ])
    const categoryFilter = await authenticated(
      `/api/ledger/transactions?categoryId=${encodeURIComponent(expenseCategory.id)}`,
    )
    expect((await json(categoryFilter)).transactions.map((row: any) => row.id)).toEqual([expense.id])

    const literalSearch = await authenticated('/api/ledger/transactions?search=100%25')
    expect((await json(literalSearch)).transactions.map((row: any) => row.id)).toEqual([expense.id])
    const malformedCursor = await authenticated('/api/ledger/transactions?cursor=broken')
    expect(malformedCursor.status).toBe(400)
    expect(await json(malformedCursor)).toMatchObject({ code: 'ledger-validation-failed' })
    expect(income.type).toBe('income')
  })

  it('serves live Overview and custom calendar-month trend projections', async () => {
    await initialize()
    const accountResponse = await authenticated('/api/ledger/accounts', {
      method: 'POST',
      body: accountBody({ name: 'Overview account', openingBalanceMinor: 100 }),
      idempotencyKey: 'overview-account',
    })
    const account = await json(accountResponse)
    const categories = await json(await authenticated('/api/ledger/categories'))
    const expenseCategory = categories.find((candidate: any) => candidate.kind === 'expense')
    const incomeCategory = categories.find((candidate: any) => candidate.kind === 'income')
    const current = Date.now() - 1_000
    await authenticated('/api/ledger/transactions', {
      method: 'POST',
      body: {
        type: 'income', amountMinor: 100, accountId: account.id, categoryId: incomeCategory.id,
        occurredAt: Date.parse('2026-01-15T03:00:00.000Z'),
      },
      idempotencyKey: 'overview-old-income',
    })
    const expense = await authenticated('/api/ledger/transactions', {
      method: 'POST',
      body: {
        type: 'expense', amountMinor: 25, accountId: account.id, categoryId: expenseCategory.id,
        occurredAt: current,
      },
      idempotencyKey: 'overview-current-expense',
    })
    expect(expense.status).toBe(201)

    const all = await json(await authenticated('/api/ledger/overview?scope=all'))
    const today = await json(await authenticated('/api/ledger/overview?scope=today'))
    const historical = await json(await authenticated('/api/ledger/overview?scope=month&anchorDate=2026-08-20'))
    expect(all).toMatchObject({
      currency: 'CNY',
      currencyExponent: 2,
      assetTotalMinor: 175,
      liabilityTotalMinor: 0,
      netWorthMinor: 175,
      cashflow: { incomeMinor: 100, expenseMinor: 25, balanceMinor: 75 },
    })
    expect(today.cashflow).toEqual({ incomeMinor: 0, expenseMinor: 25, balanceMinor: -25 })
    expect(historical.context).toMatchObject({
      anchorDate: '2026-08-20',
      scope: 'month',
      isToday: false,
    })
    expect(historical.cashflow).toEqual({ incomeMinor: 0, expenseMinor: 0, balanceMinor: 0 })
    for (const key of [
      'currency', 'currencyExponent', 'assetTotalMinor', 'liabilityTotalMinor', 'netWorthMinor',
      'accounts', 'periods', 'trend', 'recentTransactions',
    ]) {
      expect(today[key]).toEqual(all[key])
    }
    expect(all.periods.map((period: any) => period.period)).toEqual(['today', 'week', 'month', 'year'])
    expect(all.recentTransactions).toHaveLength(2)

    const invalidAnchor = await authenticated('/api/ledger/overview?scope=month&anchorDate=2026-02-30')
    expect(invalidAnchor.status).toBe(400)
    expect(await json(invalidAnchor)).toMatchObject({
      code: 'ledger-validation-failed',
      details: { field: 'anchorDate' },
    })
    const futureAnchor = await authenticated('/api/ledger/overview?scope=month&anchorDate=2999-01-01')
    expect(futureAnchor.status).toBe(400)
    expect(await json(futureAnchor)).toMatchObject({
      code: 'ledger-validation-failed',
      details: { field: 'anchorDate' },
    })

    const trend = await authenticated('/api/ledger/trend?months=3')
    expect(trend.status).toBe(200)
    expect((await json(trend)).map((point: any) => point.month)).toEqual(
      calendarMonthRanges(3, current, 'Asia/Shanghai').map((range) => range.month),
    )
    const invalidMonths = await authenticated('/api/ledger/trend?months=0')
    expect(invalidMonths.status).toBe(400)
    expect(await json(invalidMonths)).toMatchObject({ code: 'ledger-validation-failed' })
  })
})
