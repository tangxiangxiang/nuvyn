// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authFetch } from '../../../lib/auth-session'
import {
  createLedgerTransaction,
  getLedgerAccountBalanceTrend,
  getLedgerAccountTransactions,
  getLedgerOverview,
  getLedgerSettings,
  listLedgerTransactions,
} from '../api'
import { LedgerApiError } from '../ledgerErrors'

vi.mock('../../../lib/auth-session', () => ({
  authFetch: vi.fn(),
}))

const mockedAuthFetch = vi.mocked(authFetch)

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function rawResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const expensePayload = {
  type: 'expense' as const,
  amountMinor: 3800,
  accountId: 'account-1',
  categoryId: 'category-1',
  occurredAt: 1_700_000_000_000,
  payee: '',
  note: '',
}

describe('Ledger frontend API boundary', () => {
  beforeEach(() => mockedAuthFetch.mockReset())

  it('builds the canonical read path and validates Settings lifecycle projection', async () => {
    mockedAuthFetch.mockResolvedValue(response({
      baseCurrency: 'CNY',
      currencyExponent: 2,
      timezone: 'Asia/Shanghai',
      hasCreatedAccount: false,
      version: 1,
      createdAt: 1,
      updatedAt: 1,
    }))

    await expect(getLedgerSettings()).resolves.toMatchObject({ hasCreatedAccount: false })
    expect(mockedAuthFetch).toHaveBeenCalledWith('/api/ledger/settings', {})
  })

  it('encodes query parameters and sends a stable idempotency key', async () => {
    mockedAuthFetch.mockResolvedValue(response({ id: 'tx-1', type: 'expense' }))
    await createLedgerTransaction({
      type: 'expense',
      amountMinor: 3800,
      accountId: 'account 1',
      categoryId: 'category-1',
      occurredAt: 1_700_000_000_000,
      payee: '',
      note: '',
    }, 'key-a')
    const [, init] = mockedAuthFetch.mock.calls[0]!
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('key-a')

    mockedAuthFetch.mockResolvedValue(response({ transactions: [], page: { nextCursor: null } }))
    await listLedgerTransactions({ type: 'expense', accountId: 'account 1', limit: 10, offset: 20 })
    expect(mockedAuthFetch.mock.calls.at(-1)?.[0]).toContain('type=expense')
    expect(mockedAuthFetch.mock.calls.at(-1)?.[0]).toContain('accountId=account+1')
    expect(mockedAuthFetch.mock.calls.at(-1)?.[0]).toContain('offset=20')
  })

  it('requests and validates the account balance trend projection', async () => {
    mockedAuthFetch.mockResolvedValue(response({
      range: 7,
      points: [{ date: '2026-09-06', timestamp: 1_700_000_000_000, balanceMinor: 12_300 }],
    }))

    await expect(getLedgerAccountBalanceTrend('account 1', 7)).resolves.toMatchObject({ range: 7 })
    expect(mockedAuthFetch).toHaveBeenCalledWith(
      '/api/ledger/accounts/account%201/balance-trend?range=7',
      {},
    )

    mockedAuthFetch.mockResolvedValue(response({ range: 7, points: [{ date: 'not-a-date' }] }))
    await expect(getLedgerAccountBalanceTrend('account-1', 7)).rejects.toMatchObject({
      code: 'ledger-malformed-response',
    })
  })

  it('validates server-projected running balances for Account Detail', async () => {
    mockedAuthFetch.mockResolvedValue(response({
      account: {},
      movement: {},
      transactions: [],
      transactionBalances: [{ transactionId: 'tx-1', balanceMinor: 12_300 }],
      page: { nextCursor: null },
    }))

    await expect(getLedgerAccountTransactions('account 1', { limit: 5 })).resolves.toMatchObject({
      transactionBalances: [{ transactionId: 'tx-1', balanceMinor: 12_300 }],
    })
    expect(mockedAuthFetch).toHaveBeenCalledWith(
      '/api/ledger/accounts/account%201/transactions?limit=5',
      {},
    )

    mockedAuthFetch.mockResolvedValue(response({
      account: {},
      movement: {},
      transactions: [],
      transactionBalances: [{ transactionId: 'tx-1', balanceMinor: 12.3 }],
      page: { nextCursor: null },
    }))
    await expect(getLedgerAccountTransactions('account-1')).rejects.toMatchObject({
      code: 'ledger-malformed-response',
    })
  })

  it('normalizes auth, 503, and malformed responses without treating 503 as uncertain', async () => {
    mockedAuthFetch.mockResolvedValue(response({ error: 'expired', code: 'auth-session-required' }, 401))
    await expect(getLedgerSettings()).rejects.toMatchObject({ code: 'auth-session-required', kind: 'auth' })

    mockedAuthFetch.mockResolvedValue(response({ error: 'busy', code: 'ledger-write-busy' }, 503))
    const busy = await getLedgerSettings().catch((error: unknown) => error)
    expect(busy).toBeInstanceOf(LedgerApiError)
    expect(busy).toMatchObject({
      code: 'ledger-write-busy',
      kind: 'temporary',
      transportOutcomeUnknown: false,
      requiresIdempotentReplay: false,
    })

    mockedAuthFetch.mockResolvedValue(response({ hasCreatedAccount: false }))
    await expect(getLedgerSettings()).rejects.toMatchObject({ code: 'ledger-malformed-response' })
  })

  it('always serializes scope and omits only anchorDate for canonical today', async () => {
    mockedAuthFetch.mockResolvedValue(response({
      context: {
        anchorDate: '2026-09-05',
        todayDate: '2026-09-05',
        isToday: true,
        scope: 'month',
      },
    }))

    await getLedgerOverview({ scope: 'month', anchorDate: undefined })
    const todayUrl = new URL(String(mockedAuthFetch.mock.calls.at(-1)?.[0]), 'http://localhost')
    expect(todayUrl.pathname).toBe('/api/ledger/overview')
    expect(todayUrl.searchParams.get('scope')).toBe('month')
    expect(todayUrl.searchParams.has('anchorDate')).toBe(false)

    mockedAuthFetch.mockResolvedValue(response({
      context: {
        anchorDate: '2026-08-20',
        todayDate: '2026-09-05',
        isToday: false,
        scope: 'month',
      },
    }))
    await getLedgerOverview({ scope: 'month', anchorDate: '2026-08-20' })
    const historicalUrl = new URL(String(mockedAuthFetch.mock.calls.at(-1)?.[0]), 'http://localhost')
    expect(historicalUrl.searchParams.get('scope')).toBe('month')
    expect(historicalUrl.searchParams.get('anchorDate')).toBe('2026-08-20')
  })

  it('fails closed when Overview context is missing or malformed', async () => {
    for (const context of [
      undefined,
      { anchorDate: '2026-09-05', todayDate: '2026-09-05', isToday: true },
      { anchorDate: '2026-09-05', todayDate: '2026-09-05', isToday: 'true', scope: 'month' },
      { anchorDate: '2026-09-05', todayDate: '2026-09-05', isToday: true, scope: 'quarter' },
    ]) {
      mockedAuthFetch.mockResolvedValueOnce(response({ context }))
      await expect(getLedgerOverview({ scope: 'month', anchorDate: undefined }))
        .rejects.toMatchObject({ code: 'ledger-malformed-response' })
    }
  })

  it('retains replay classification when a successful create body is unreadable or malformed', async () => {
    mockedAuthFetch.mockResolvedValueOnce(rawResponse('{broken', 201))
    const unreadable = await createLedgerTransaction(expensePayload, 'key-success-body-lost').catch((error: unknown) => error)
    expect(unreadable).toBeInstanceOf(LedgerApiError)
    expect(unreadable).toMatchObject({
      status: 201,
      code: 'ledger-malformed-response',
      transportOutcomeUnknown: false,
      requiresIdempotentReplay: true,
    })

    mockedAuthFetch.mockResolvedValueOnce(response({ id: 'missing-required-transaction-fields' }, 201))
    const malformed = await createLedgerTransaction(expensePayload, 'key-success-body-malformed').catch((error: unknown) => error)
    expect(malformed).toBeInstanceOf(LedgerApiError)
    expect(malformed).toMatchObject({
      status: 201,
      code: 'ledger-malformed-response',
      transportOutcomeUnknown: false,
      requiresIdempotentReplay: true,
    })
  })
})
