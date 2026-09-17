import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import app from '../index.js'
import { __setDbForTesting, applyMigrations } from '../db.js'
import {
  closeAuthTestContext,
  createAuthenticatedTestContext,
  type AuthenticatedTestContext,
} from './helpers/auth.js'

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

function request(
  path: string,
  options: {
    method?: string
    body?: unknown
    cookie?: string
    contentType?: string
    origin?: string
    idempotencyKey?: string
  } = {},
): Promise<Response> {
  const headers = new Headers()
  if (options.cookie !== undefined) headers.set('Cookie', options.cookie)
  if (options.origin !== undefined) headers.set('Origin', options.origin)
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

describe('Ledger API auth inheritance', () => {
  it('rejects anonymous reads and mutations through the existing owner boundary', async () => {
    const read = await request('/api/ledger/settings')
    const transactionRead = await request('/api/ledger/transactions')
    const accountTransactionRead = await request('/api/ledger/accounts/account/transactions')
    const overviewRead = await request('/api/ledger/overview')
    const trendRead = await request('/api/ledger/trend')
    const mutation = await request('/api/ledger/settings', {
      method: 'POST',
      body: { baseCurrency: 'CNY', timezone: 'UTC' },
      idempotencyKey: 'anonymous-settings',
    })
    const transactionMutation = await request('/api/ledger/transactions', {
      method: 'POST',
      body: {
        type: 'transfer',
        amountMinor: 1,
        fromAccountId: 'anonymous-from',
        toAccountId: 'anonymous-to',
        occurredAt: Date.now(),
      },
      idempotencyKey: 'anonymous-transaction',
    })
    const adjustmentMutation = await request('/api/ledger/accounts/anonymous-account/adjust', {
      method: 'POST',
      body: {
        targetBalanceMinor: 1,
        expectedCalculatedBalanceMinor: 0,
        occurredAt: Date.now(),
      },
      idempotencyKey: 'anonymous-adjustment',
    })
    expect(read.status).toBe(401)
    expect(transactionRead.status).toBe(401)
    expect(accountTransactionRead.status).toBe(401)
    expect(overviewRead.status).toBe(401)
    expect(trendRead.status).toBe(401)
    expect(mutation.status).toBe(401)
    expect(transactionMutation.status).toBe(401)
    expect(adjustmentMutation.status).toBe(401)
    expect(await read.json()).toMatchObject({ code: 'auth-session-required' })
    expect(await transactionRead.json()).toMatchObject({ code: 'auth-session-required' })
    expect(await accountTransactionRead.json()).toMatchObject({ code: 'auth-session-required' })
    expect(await overviewRead.json()).toMatchObject({ code: 'auth-session-required' })
    expect(await trendRead.json()).toMatchObject({ code: 'auth-session-required' })
    expect(await mutation.json()).toMatchObject({ code: 'auth-session-required' })
    expect(await transactionMutation.json()).toMatchObject({ code: 'auth-session-required' })
    expect(await adjustmentMutation.json()).toMatchObject({ code: 'auth-session-required' })
  })

  it('allows the owner while preserving existing CSRF and JSON content-type checks', async () => {
    const uninitialized = await request('/api/ledger/settings', { cookie: auth.cookie })
    expect(uninitialized.status).toBe(404)

    const crossOrigin = await request('/api/ledger/settings', {
      method: 'POST',
      cookie: auth.cookie,
      origin: 'http://evil.example',
      body: { baseCurrency: 'CNY', timezone: 'UTC' },
      idempotencyKey: 'cross-origin',
    })
    expect(crossOrigin.status).toBe(403)
    expect(await crossOrigin.json()).toMatchObject({ code: 'csrf-origin-mismatch' })

    const missingContentType = await request('/api/ledger/settings', {
      method: 'POST',
      cookie: auth.cookie,
      contentType: '',
      body: { baseCurrency: 'CNY', timezone: 'UTC' },
      idempotencyKey: 'missing-content-type',
    })
    expect(missingContentType.status).toBe(415)
    expect(await missingContentType.json()).toMatchObject({ code: 'invalid-content-type' })

    const allowed = await request('/api/ledger/settings', {
      method: 'POST',
      cookie: auth.cookie,
      body: { baseCurrency: 'CNY', timezone: 'UTC' },
      idempotencyKey: 'owner-settings',
    })
    expect(allowed.status).toBe(201)
    expect(allowed.headers.get('cache-control')).toBe('no-store')
  })
})
